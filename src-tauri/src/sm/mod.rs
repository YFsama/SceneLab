// SceneLab exact-geometry service (P3): Rust side of the SMLib bridge.
//
// Runtime topology (all loading happens lazily on the first sm_* call, never
// at process start):
//
//   src-tauri/sm-lib/SMLib.dll      the kernel (NVIDIA usd-brep, Apache-2.0)
//   src-tauri/sm-lib/SM_API.dll     C++ convenience layer over the kernel
//   src-tauri/sm-lib/smmesh.dll     our extern "C" shim (vendor/smmesh.cpp,
//                                   compiled by build.rs when cl.exe is found)
//
// Loading order SMLib -> SM_API -> smmesh with absolute paths and
// LOAD_WITH_ALTERED_SEARCH_PATH (verified in the FFI spike) so each DLL's
// dependencies resolve next to itself instead of next to the .exe. The
// SMLib engine is single-threaded: one process-wide engine lives behind a
// Mutex and every kernel call goes through it.
//
// Degradation contract: with no DLLs (fetch script not run, other OS, or
// SM_LIB_DIR pointing elsewhere) nothing panics -- sm_status answers
// { available: false, error } and every operation returns an { ok: false }
// envelope. cargo build/test stay green in that mode (the golden tests
// auto-skip with a note).
//
// Wire shapes mirror src/lib/geometry/smClient.ts 1:1 (camelCase).

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Wire types (serde) -- the IPC contract
// ---------------------------------------------------------------------------

/// Mirrors SmStatus in smClient.ts.
#[derive(Debug, Serialize, Clone)]
pub struct SmStatusWire {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `{ x, y, z }` -- the object form the frontend's Vec3 uses for FaceSource.
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
pub struct Vec3Wire {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3Wire {
    fn new(v: [f64; 3]) -> Self {
        Self {
            x: v[0],
            y: v[1],
            z: v[2],
        }
    }
}

/// Analytic face provenance -- same kinds, same field names as FaceSource in
/// src/lib/geometry/types.ts. `cone.axis` points from the apex INTO the band.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FaceSourceWire {
    #[serde(rename_all = "camelCase")]
    Plane { point: Vec3Wire, normal: Vec3Wire },
    #[serde(rename_all = "camelCase")]
    Cylinder {
        origin: Vec3Wire,
        axis: Vec3Wire,
        radius: f64,
    },
    #[serde(rename_all = "camelCase")]
    Cone {
        apex: Vec3Wire,
        axis: Vec3Wire,
        half_angle: f64,
    },
    #[serde(rename_all = "camelCase")]
    Sphere { center: Vec3Wire, radius: f64 },
    #[serde(rename_all = "camelCase")]
    Torus {
        center: Vec3Wire,
        axis: Vec3Wire,
        major_radius: f64,
        minor_radius: f64,
    },
}

#[derive(Debug, Serialize, Clone)]
pub struct SmFaceWire {
    /// Index ring into the shared vertex table (outer loop, kernel order).
    pub vertices: Vec<i32>,
    /// Newell normal of the ring (normalized). [0,0,0] when degenerate -- the
    /// frontend then re-derives or drops the face.
    pub normal: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FaceSourceWire>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SmBodyWire {
    pub vertices: Vec<[f64; 3]>,
    pub faces: Vec<SmFaceWire>,
}

/// Operation result envelope. Kernel/parameter errors resolve with
/// ok:false (the frontend classifies those as reason 'backend'); only a
/// transport-level failure would reject, which never happens here.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<SmBodyWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brep_volume_mm3: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SmResultWire {
    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            body: None,
            brep_volume_mm3: None,
            error: Some(message.into()),
        }
    }

    fn ok(body: SmBodyWire, volume: f64) -> Self {
        Self {
            ok: true,
            body: Some(body),
            brep_volume_mm3: Some(volume),
            error: None,
        }
    }
}

// ---- requests --------------------------------------------------------------

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SmKind {
    Box,
    Cylinder,
    Sphere,
    Cone,
    Torus,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SmOp {
    Union,
    Difference,
    Intersect,
}

/// Mirrors SmTessellation in smClient.ts; 0.0/absent = kernel default.
#[derive(Debug, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmTessellationReq {
    chord_tolerance_mm: Option<f64>,
    angle_tolerance_deg: Option<f64>,
    max_edge_length_mm: Option<f64>,
}

impl SmTessellationReq {
    fn triple(&self) -> (f64, f64, f64) {
        (
            self.chord_tolerance_mm.unwrap_or(0.0),
            self.angle_tolerance_deg.unwrap_or(0.0),
            self.max_edge_length_mm.unwrap_or(0.0),
        )
    }
}

/// Kind-specific dims, mirroring the documented keys of SmPrimitiveParams in
/// smClient.ts, plus the optional `center` anchor every kind accepts
/// (box/sphere/torus: symmetric center; cylinder/cone: base circle center;
/// absent = origin). Unknown keys are ignored, matching the TS Record type.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmParamsReq {
    size: Option<Vec<f64>>,
    radius: Option<f64>,
    height: Option<f64>,
    bottom_radius: Option<f64>,
    top_radius: Option<f64>,
    major_radius: Option<f64>,
    minor_radius: Option<f64>,
    center: Option<Vec<f64>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SmPrimitiveReq {
    pub kind: SmKind,
    pub params: SmParamsReq,
    pub tessellation: Option<SmTessellationReq>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SmBooleanReq {
    pub a: SmPrimitiveReq,
    pub b: SmPrimitiveReq,
    pub op: SmOp,
    pub tessellation: Option<SmTessellationReq>,
}

// ---------------------------------------------------------------------------
// FFI surface of smmesh.dll (see vendor/smmesh.cpp for the authoritative ABI)
// ---------------------------------------------------------------------------

type FnInit = unsafe extern "C" fn() -> c_int;
type FnVersion = unsafe extern "C" fn() -> *const c_char;
type FnBox = unsafe extern "C" fn(f64, f64, f64, f64, f64, f64) -> *mut c_void;
type FnCylinder = unsafe extern "C" fn(f64, f64, f64, f64, f64) -> *mut c_void;
type FnSphere = unsafe extern "C" fn(f64, f64, f64, f64) -> *mut c_void;
type FnCone = unsafe extern "C" fn(f64, f64, f64, f64, f64, f64) -> *mut c_void;
type FnTorus = unsafe extern "C" fn(f64, f64, f64, f64, f64) -> *mut c_void;
type FnBoolean = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int) -> c_int;
type FnTessellate = unsafe extern "C" fn(*mut c_void, f64, f64, f64) -> *mut c_void;
type FnFaceCount = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnExtract = unsafe extern "C" fn(
    *mut c_void,
    *mut *mut f64,
    *mut c_int,
    *mut *mut c_int,
    *mut c_int,
    *mut c_int,
) -> c_int;
type FnFaceSurface = unsafe extern "C" fn(*mut c_void, c_int, *mut c_int, *mut f64) -> c_int;
type FnBrepVolume = unsafe extern "C" fn(*mut c_void, f64, *mut f64) -> c_int;
type FnFreeBuffer = unsafe extern "C" fn(*mut c_void);
type FnFreePoly = unsafe extern "C" fn(*mut c_void);
type FnFreeBrep = unsafe extern "C" fn(*mut c_void);

/// Loaded DLL trio + resolved shim entry points. The `Library` handles are
/// kept alive for the process lifetime; the raw fn pointers therefore stay
/// valid (they are only ever reached through this struct).
///
/// Field order is deliberate: Rust drops fields in declaration order, so the
/// libraries are declared FIRST as `_shim, _sm_api, _sm_lib` -- the exact
/// REVERSE of the load order in `load()` -- making the (theoretical) drop
/// order unload the dependents before their dependencies. The engine lives
/// behind a process-wide static and is never actually dropped.
struct SmEngine {
    _shim: libloading::Library,
    _sm_api: libloading::Library,
    _sm_lib: libloading::Library,
    version: FnVersion,
    create_box: FnBox,
    create_cylinder: FnCylinder,
    create_sphere: FnSphere,
    create_cone: FnCone,
    create_torus: FnTorus,
    boolean: FnBoolean,
    tessellate: FnTessellate,
    face_count: FnFaceCount,
    extract: FnExtract,
    face_surface: FnFaceSurface,
    brep_volume: FnBrepVolume,
    free_buffer: FnFreeBuffer,
    free_poly: FnFreePoly,
    free_brep: FnFreeBrep,
}

// SAFETY: the engine owns its DLLs and raw pointers to their code; nothing
// in it is thread-affine (the kernel is serialized by the surrounding Mutex,
// not by thread identity). Moving it between threads is therefore sound.
unsafe impl Send for SmEngine {}

/// Absolute-path library load that lets each DLL's own dependencies resolve
/// next to the DLL instead of next to the executable.
fn load_library(path: &Path) -> Result<libloading::Library, String> {
    // SAFETY: loading a DLL and running its initialization is inherently
    // unsafe; these are the trusted, vendored NVIDIA binaries plus our shim.
    unsafe {
        #[cfg(windows)]
        {
            use libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH;
            let os_lib = libloading::os::windows::Library::load_with_flags(
                path,
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )
            .map_err(|e| format!("failed to load {}: {e}", path.display()))?;
            Ok(libloading::Library::from(os_lib))
        }
        #[cfg(not(windows))]
        {
            libloading::Library::new(path)
                .map_err(|e| format!("failed to load {}: {e}", path.display()))
        }
    }
}

/// Resolve a symbol and freeze it to a 'static fn pointer. Sound because the
/// owning Library outlives the engine (and the engine is never dropped).
fn sym<T: Copy>(lib: &libloading::Library, name: &[u8]) -> Result<T, String> {
    let mut full = name.to_vec();
    full.push(0);
    // The deref copies the fn pointer out of the borrow-tied Symbol; the
    // pointed-to code stays valid as long as `lib` (i.e. forever here).
    unsafe {
        let s: libloading::Symbol<'_, T> = lib.get(full.as_slice()).map_err(|e| e.to_string())?;
        Ok(*s)
    }
}

impl SmEngine {
    /// Load SMLib.dll -> SM_API.dll -> smmesh.dll (spike-verified order) from
    /// `lib_dir`, resolve every entry point and initialize the kernel context.
    fn load(lib_dir: &Path) -> Result<Self, String> {
        let sm_lib = first_existing(&[
            &lib_dir.join("lib").join("SMLib.dll"),
            &lib_dir.join("SMLib.dll"),
        ])
        .ok_or_else(|| format!("SMLib.dll not found under {}", lib_dir.display()))?;
        let sm_api = first_existing(&[
            &lib_dir.join("lib").join("SM_API.dll"),
            &lib_dir.join("SM_API.dll"),
        ])
        .ok_or_else(|| format!("SM_API.dll not found under {}", lib_dir.display()))?;
        let shim_path = first_existing(&[
            &lib_dir.join("lib").join("smmesh.dll"),
            &lib_dir.join("smmesh.dll"),
        ])
        .ok_or_else(|| {
            format!(
                "smmesh.dll not found under {} (build.rs mode was not 'compiled'; \
                 run scripts/fetch-sm-lib.ps1 and rebuild with MSVC available)",
                lib_dir.display()
            )
        })?;

        // Order matters: each dependent DLL must already be loaded so the
        // loader's altered search path is only a fallback, not a requirement.
        let sm_lib = load_library(&sm_lib)?;
        let sm_api = load_library(&sm_api)?;
        let shim = load_library(&shim_path)?;

        let engine = SmEngine {
            version: sym::<FnVersion>(&shim, b"smmesh_version")?,
            create_box: sym::<FnBox>(&shim, b"smmesh_box")?,
            create_cylinder: sym::<FnCylinder>(&shim, b"smmesh_cylinder")?,
            create_sphere: sym::<FnSphere>(&shim, b"smmesh_sphere")?,
            create_cone: sym::<FnCone>(&shim, b"smmesh_cone")?,
            create_torus: sym::<FnTorus>(&shim, b"smmesh_torus")?,
            boolean: sym::<FnBoolean>(&shim, b"smmesh_boolean")?,
            tessellate: sym::<FnTessellate>(&shim, b"smmesh_tessellate")?,
            face_count: sym::<FnFaceCount>(&shim, b"smmesh_face_count")?,
            extract: sym::<FnExtract>(&shim, b"smmesh_extract")?,
            face_surface: sym::<FnFaceSurface>(&shim, b"smmesh_face_surface")?,
            brep_volume: sym::<FnBrepVolume>(&shim, b"smmesh_brep_volume")?,
            free_buffer: sym::<FnFreeBuffer>(&shim, b"smmesh_free_buffer")?,
            free_poly: sym::<FnFreePoly>(&shim, b"smmesh_free_poly")?,
            free_brep: sym::<FnFreeBrep>(&shim, b"smmesh_free_brep")?,
            _sm_lib: sm_lib,
            _sm_api: sm_api,
            _shim: shim,
        };

        // Kernel context creation; returns 0. Serialized by the caller's lock.
        let init = engine_sm_init(&engine._shim)?;
        unsafe { init() };
        Ok(engine)
    }
}

/// Resolve smmesh_init like every other symbol -- a missing export must
/// surface as a clean Err (cached by with_engine), never panic and poison
/// the engine Mutex.
fn engine_sm_init(shim: &libloading::Library) -> Result<FnInit, String> {
    sym::<FnInit>(shim, b"smmesh_init")
}

fn first_existing(paths: &[&PathBuf]) -> Option<PathBuf> {
    paths.iter().copied().find(|p| p.is_file()).cloned()
}

// ---------------------------------------------------------------------------
// Process-wide engine state
// ---------------------------------------------------------------------------

enum SmState {
    Uninit,
    Ready(SmEngine),
    Failed(String),
}

static SM: OnceLock<Mutex<SmState>> = OnceLock::new();

fn sm_state() -> &'static Mutex<SmState> {
    SM.get_or_init(|| Mutex::new(SmState::Uninit))
}

/// sm-lib directory: runtime SM_LIB_DIR override, else the build-time default
/// injected by build.rs (crate-local src-tauri/sm-lib).
pub fn sm_lib_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SM_LIB_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    PathBuf::from(env!("SM_LIB_DIR_DEFAULT"))
}

/// Run `f` with the engine, initializing (and caching) it on first use.
/// Initialization failures are cached too: one probe per session, mirroring
/// the frontend's status caching.
fn with_engine<T>(f: impl FnOnce(&SmEngine) -> Result<T, String>) -> Result<T, String> {
    let mut guard = sm_state().lock().map_err(|_| "sm engine mutex poisoned")?;
    match &mut *guard {
        SmState::Ready(engine) => f(engine),
        SmState::Failed(err) => Err(err.clone()),
        SmState::Uninit => match SmEngine::load(&sm_lib_dir()) {
            Ok(engine) => {
                let result = f(&engine);
                *guard = SmState::Ready(engine);
                result
            }
            Err(err) => {
                *guard = SmState::Failed(err.clone());
                Err(err)
            }
        },
    }
}

// ---------------------------------------------------------------------------
// Geometry pipeline helpers (all contract-frame)
// ---------------------------------------------------------------------------

/// Newell normal of an index ring over `points`, normalized. None when
/// degenerate (zero-length) -- the wire then carries [0,0,0] and the
/// frontend re-derives or drops the face.
fn newell_normal(ring: &[[f64; 3]]) -> Option<[f64; 3]> {
    let (mut nx, mut ny, mut nz) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..ring.len() {
        let p = ring[i];
        let q = ring[(i + 1) % ring.len()];
        nx += (p[1] - q[1]) * (p[2] + q[2]);
        ny += (p[2] - q[2]) * (p[0] + q[0]);
        nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    // is_finite first: rejects NaN and inf (a degenerate or overflowed Newell
    // sum), then the magnitude floor rejects near-zero normals.
    if !len.is_finite() || len <= 1e-12 {
        return None;
    }
    Some([nx / len, ny / len, nz / len])
}

/// Owned copy of one shim-extracted buffer (freed via smmesh_free_buffer on
/// drop -- the shim malloc'd it on the shared ucrt heap).
struct ShimSlice<T: Copy> {
    ptr: *mut T,
    len: usize,
    free: FnFreeBuffer,
}

impl<T: Copy> ShimSlice<T> {
    // SAFETY: ptr must come from a successful smmesh_extract out-parameter
    // with exactly `len` readable elements, and free must be the shim's
    // smmesh_free_buffer. The slice is only read while the engine lock is
    // held (the engine lives as long as the process).
    unsafe fn to_vec(&self) -> Vec<T> {
        if self.ptr.is_null() || self.len == 0 {
            return Vec::new();
        }
        std::slice::from_raw_parts(self.ptr, self.len).to_vec()
    }
}

impl<T: Copy> Drop for ShimSlice<T> {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            // SAFETY: the pointer was produced by the shim's malloc family
            // and is freed exactly once, through the shim itself.
            unsafe { (self.free)(self.ptr as *mut c_void) };
        }
    }
}

/// Convert one shim face-surface record into the wire FaceSource. kind 0 is
/// the shim's honest "no analytic provenance" answer -> None.
fn face_source_wire(kind: i32, p: &[f64]) -> Option<FaceSourceWire> {
    match kind {
        1 => Some(FaceSourceWire::Plane {
            point: Vec3Wire::new([p[0], p[1], p[2]]),
            normal: Vec3Wire::new([p[3], p[4], p[5]]),
        }),
        2 => Some(FaceSourceWire::Cylinder {
            origin: Vec3Wire::new([p[0], p[1], p[2]]),
            axis: Vec3Wire::new([p[3], p[4], p[5]]),
            radius: p[6],
        }),
        3 => Some(FaceSourceWire::Cone {
            apex: Vec3Wire::new([p[0], p[1], p[2]]),
            axis: Vec3Wire::new([p[3], p[4], p[5]]),
            half_angle: p[6],
        }),
        4 => Some(FaceSourceWire::Sphere {
            center: Vec3Wire::new([p[0], p[1], p[2]]),
            radius: p[3],
        }),
        5 => Some(FaceSourceWire::Torus {
            center: Vec3Wire::new([p[0], p[1], p[2]]),
            axis: Vec3Wire::new([p[3], p[4], p[5]]),
            major_radius: p[6],
            minor_radius: p[7],
        }),
        _ => None,
    }
}

fn center_of(params: &SmParamsReq) -> Result<[f64; 3], String> {
    match &params.center {
        None => Ok([0.0, 0.0, 0.0]),
        Some(c) if c.len() == 3 => {
            // Symmetric with require(): a NaN/infinite anchor must be rejected
            // here, not inside the kernel.
            if !c.iter().all(|v| v.is_finite()) {
                return Err("params.center entries must all be finite numbers".into());
            }
            Ok([c[0], c[1], c[2]])
        }
        Some(_) => Err("params.center must be a [x, y, z] triple".into()),
    }
}

fn require(value: Option<f64>, name: &str, min: f64, allow_equal: bool) -> Result<f64, String> {
    let v = value.ok_or_else(|| format!("params.{name} is required"))?;
    let ok = if allow_equal { v >= min } else { v > min };
    if !ok || !v.is_finite() {
        return Err(format!("params.{name} must be a finite number > {min}"));
    }
    Ok(v)
}

/// Build one primitive brep through the shim. Every failure leaves nothing
/// to free (the shim returns null and releases internally on failure paths).
///
/// SAFETY: `engine` must be used only while its Mutex is held (guaranteed by
/// with_engine). The returned pointer is owned by the caller and must be
/// released with engine.free_brep.
unsafe fn create_brep(engine: &SmEngine, req: &SmPrimitiveReq) -> Result<*mut c_void, String> {
    let p = &req.params;
    let c = center_of(p)?;
    let ptr = match req.kind {
        SmKind::Box => {
            let size = p.size.as_ref().ok_or("params.size is required for box")?;
            if size.len() != 3 {
                return Err("params.size must be a [x, y, z] triple".into());
            }
            let (sx, sy, sz) = (size[0], size[1], size[2]);
            if !(sx.is_finite() && sy.is_finite() && sz.is_finite()) {
                return Err("params.size entries must be finite".into());
            }
            if sx <= 0.0 || sy <= 0.0 || sz <= 0.0 {
                return Err("params.size entries must all be > 0".into());
            }
            (engine.create_box)(sx, sy, sz, c[0], c[1], c[2])
        }
        SmKind::Cylinder => {
            let r = require(p.radius, "radius", 0.0, false)?;
            let h = require(p.height, "height", 0.0, false)?;
            (engine.create_cylinder)(r, h, c[0], c[1], c[2])
        }
        SmKind::Sphere => {
            let r = require(p.radius, "radius", 0.0, false)?;
            (engine.create_sphere)(r, c[0], c[1], c[2])
        }
        SmKind::Cone => {
            let br = require(p.bottom_radius, "bottomRadius", 0.0, false)?;
            let tr = p
                .top_radius
                .ok_or("params.topRadius is required (0 = pointed tip)")?;
            if !tr.is_finite() || tr < 0.0 {
                return Err("params.topRadius must be finite and >= 0".into());
            }
            let h = require(p.height, "height", 0.0, false)?;
            (engine.create_cone)(br, tr, h, c[0], c[1], c[2])
        }
        SmKind::Torus => {
            let major = require(p.major_radius, "majorRadius", 0.0, false)?;
            let minor = require(p.minor_radius, "minorRadius", 0.0, false)?;
            (engine.create_torus)(major, minor, c[0], c[1], c[2])
        }
    };
    if ptr.is_null() {
        return Err(format!(
            "kernel failed to create {} primitive",
            kind_name(&req.kind)
        ));
    }
    Ok(ptr)
}

fn kind_name(kind: &SmKind) -> &'static str {
    match kind {
        SmKind::Box => "box",
        SmKind::Cylinder => "cylinder",
        SmKind::Sphere => "sphere",
        SmKind::Cone => "cone",
        SmKind::Torus => "torus",
    }
}

/// Volume + tessellate + extract + per-face provenance for a live brep, then
/// release the polybrep. The brep itself stays alive (caller releases it).
///
/// SAFETY: brep must be a valid kernel object; engine under the Mutex.
unsafe fn finish_body(
    engine: &SmEngine,
    brep: *mut c_void,
    tess: Option<&SmTessellationReq>,
) -> Result<(SmBodyWire, f64), String> {
    // Exact BRep volume (rel acc matches the verified spike).
    let mut volume = 0.0f64;
    let st = (engine.brep_volume)(brep, 1.0e-7, &mut volume);
    if st != 0 {
        return Err(format!("SmApiBrepComputeVolume failed with status {st}"));
    }
    if !volume.is_finite() {
        return Err("kernel returned a non-finite volume".into());
    }

    // Tessellate (0.0 args = kernel defaults inside the shim).
    let (chord, ang, max_edge) = tess.map(|t| t.triple()).unwrap_or((0.0, 0.0, 0.0));
    let poly = (engine.tessellate)(brep, chord, ang, max_edge);
    if poly.is_null() {
        return Err("SmApiTessellate failed".into());
    }

    // Extract the flat mesh.
    let mut pts: *mut f64 = std::ptr::null_mut();
    let mut n_pts: c_int = 0;
    let mut faces: *mut c_int = std::ptr::null_mut();
    let mut face_ints: c_int = 0;
    let mut index_ints: c_int = 0;
    let st = (engine.extract)(
        poly,
        &mut pts,
        &mut n_pts,
        &mut faces,
        &mut face_ints,
        &mut index_ints,
    );
    if st != 0 {
        (engine.free_poly)(poly);
        return Err(format!("smmesh_extract failed with status {st}"));
    }

    let points_slice = ShimSlice {
        ptr: pts,
        len: n_pts.max(0) as usize * 3,
        free: engine.free_buffer,
    };
    let faces_slice = ShimSlice {
        ptr: faces,
        len: face_ints.max(0) as usize,
        free: engine.free_buffer,
    };
    let flat_points = points_slice.to_vec();
    let flat_faces = faces_slice.to_vec();

    let n_points = n_pts.max(0) as usize;
    let mut vertices: Vec<[f64; 3]> = Vec::with_capacity(n_points);
    for i in 0..n_points {
        vertices.push([
            flat_points[i * 3],
            flat_points[i * 3 + 1],
            flat_points[i * 3 + 2],
        ]);
    }

    // Parse the [count, idx...] runs. Run k corresponds to the k-th face of
    // the polybrep that has an outer loop; smmesh_face_surface indexes the
    // kernel's full face array. They align 1:1 whenever every face walked
    // (asserted in the golden tests; a skipped face would only risk a
    // best-effort tag mismatch, never bad geometry).
    let face_total = (engine.face_count)(poly).max(0) as usize;
    let mut wire_faces: Vec<SmFaceWire> = Vec::new();
    let mut pos = 0usize;
    let mut run_index = 0usize;
    while pos < flat_faces.len() {
        let n = flat_faces[pos] as usize;
        pos += 1;
        if n == 0 || pos + n > flat_faces.len() {
            break; // malformed tail -- defensive, shim always writes whole runs
        }
        let ring_idx: Vec<i32> = flat_faces[pos..pos + n].to_vec();
        pos += n;

        let ring: Vec<[f64; 3]> = ring_idx
            .iter()
            .map(|&i| {
                let i = i as usize;
                vertices.get(i).copied().unwrap_or([f64::NAN; 3])
            })
            .collect();

        let normal = newell_normal(&ring).unwrap_or([0.0, 0.0, 0.0]);

        let mut source = None;
        if run_index < face_total {
            let mut kind: c_int = 0;
            let mut params = [0.0f64; 12];
            let st =
                (engine.face_surface)(poly, run_index as c_int, &mut kind, params.as_mut_ptr());
            if st == 0 {
                source = face_source_wire(kind, &params);
            }
        }

        wire_faces.push(SmFaceWire {
            vertices: ring_idx,
            normal,
            source,
        });
        run_index += 1;
    }

    (engine.free_poly)(poly);

    if vertices.is_empty() || wire_faces.is_empty() {
        return Err("tessellation produced an empty mesh".into());
    }
    Ok((
        SmBodyWire {
            vertices,
            faces: wire_faces,
        },
        volume,
    ))
}

// ---------------------------------------------------------------------------
// Command implementations (plain functions so tests need no Tauri runtime)
// ---------------------------------------------------------------------------

pub fn status_impl() -> SmStatusWire {
    match with_engine(|engine| {
        // SAFETY: engine locked; version string is a static C string.
        unsafe {
            let cstr = (engine.version)();
            let bytes = std::ffi::CStr::from_ptr(cstr).to_bytes();
            Ok(String::from_utf8_lossy(bytes).into_owned())
        }
    }) {
        Ok(version) => SmStatusWire {
            available: true,
            version: Some(version),
            error: None,
        },
        Err(error) => SmStatusWire {
            available: false,
            version: None,
            error: Some(error),
        },
    }
}

pub fn primitive_impl(req: &SmPrimitiveReq) -> SmResultWire {
    with_engine(|engine| {
        // SAFETY: the whole closure runs under the engine Mutex.
        unsafe {
            let brep = create_brep(engine, req)?;
            let result = finish_body(engine, brep, req.tessellation.as_ref());
            (engine.free_brep)(brep);
            result
        }
    })
    .map(|(body, volume)| SmResultWire::ok(body, volume))
    .unwrap_or_else(SmResultWire::err)
}

pub fn boolean_impl(req: &SmBooleanReq) -> SmResultWire {
    with_engine(|engine| {
        // SAFETY: the whole closure runs under the engine Mutex. Boolean
        // semantics: success -> a is the result and b was deleted by the
        // kernel; failure -> both stay alive and we free both.
        unsafe {
            let a = create_brep(engine, &req.a)?;
            let b = match create_brep(engine, &req.b) {
                Ok(b) => b,
                Err(e) => {
                    (engine.free_brep)(a);
                    return Err(e);
                }
            };
            let op_code = match req.op {
                SmOp::Union => 0,
                SmOp::Difference => 1,
                SmOp::Intersect => 2,
            };
            let st = (engine.boolean)(a, b, op_code);
            if st != 0 {
                (engine.free_brep)(b);
                (engine.free_brep)(a);
                return Err(format!(
                    "boolean {:?} failed with kernel status {st}",
                    req.op
                ));
            }
            // b was consumed by the kernel; a is now the result.
            let result = finish_body(engine, a, req.tessellation.as_ref());
            (engine.free_brep)(a);
            result
        }
    })
    .map(|(body, volume)| SmResultWire::ok(body, volume))
    .unwrap_or_else(SmResultWire::err)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// True when the sm-lib package is complete enough to have produced a
    /// usable engine (kernel dlls + shim dll present under the active lib
    /// dir). Golden tests self-skip when this is false, so `cargo test` is
    /// green in "no DLL" mode as well.
    fn dlls_present() -> bool {
        let dir = sm_lib_dir();
        first_existing(&[&dir.join("lib").join("SMLib.dll"), &dir.join("SMLib.dll")]).is_some()
            && first_existing(&[&dir.join("lib").join("SM_API.dll"), &dir.join("SM_API.dll")])
                .is_some()
            && first_existing(&[&dir.join("lib").join("smmesh.dll"), &dir.join("smmesh.dll")])
                .is_some()
    }

    fn assert_close(actual: f64, expected: f64, rel_tol: f64, what: &str) {
        let tol = expected.abs().max(1.0) * rel_tol;
        assert!(
            (actual - expected).abs() <= tol,
            "{what}: expected {expected}, got {actual} (rel tol {rel_tol})"
        );
    }

    fn assert_vec3(v: Vec3Wire, expected: [f64; 3], what: &str) {
        for (i, e) in expected.iter().enumerate() {
            assert!(
                (v.as_array()[i] - e).abs() < 1e-9,
                "{what}[{i}]: expected {e}, got {}",
                v.as_array()[i]
            );
        }
    }

    impl Vec3Wire {
        fn as_array(&self) -> [f64; 3] {
            [self.x, self.y, self.z]
        }
    }

    fn prim(kind: SmKind, params: SmParamsReq, tess: Option<SmTessellationReq>) -> SmPrimitiveReq {
        SmPrimitiveReq {
            kind,
            params,
            tessellation: tess,
        }
    }

    fn params(pairs: &[(&str, serde_json::Value)]) -> SmParamsReq {
        let map: serde_json::Map<String, serde_json::Value> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        serde_json::from_value(serde_json::Value::Object(map)).unwrap()
    }

    /// Run a test body that exercises the kernel through the public *_impl
    /// functions, skipping (with a visible note) when the DLLs are not
    /// available in this mode. The engine is initialized up front -- NOT
    /// held: the *_impl functions take the engine lock themselves and the
    /// Mutex is not reentrant.
    fn with_kernel(f: impl FnOnce()) {
        if !dlls_present() {
            eprintln!(
                "SKIPPED (no SMLib DLLs under {}) -- golden test requires scripts/fetch-sm-lib.ps1",
                sm_lib_dir().display()
            );
            return;
        }
        with_engine(|_| Ok(())).expect("engine should initialize when dlls_present()");
        f();
    }

    // ---- pure wire-contract tests (run in every mode) -----------------------

    #[test]
    fn wire_request_parses_frontend_shape() {
        // Exact JSON the frontend sends: { req: {...} } with camelCase keys.
        let raw = r#"{
            "kind": "cylinder",
            "params": { "radius": 3, "height": 8, "center": [1, 2, 3] },
            "tessellation": { "chordToleranceMm": 0.1, "angleToleranceDeg": 15 }
        }"#;
        let req: SmPrimitiveReq = serde_json::from_str(raw).unwrap();
        assert!(matches!(req.kind, SmKind::Cylinder));
        assert_eq!(req.params.radius, Some(3.0));
        assert_eq!(req.params.height, Some(8.0));
        assert_eq!(req.params.center.as_deref(), Some(&[1.0, 2.0, 3.0][..]));
        let t = req.tessellation.unwrap();
        assert_eq!(t.chord_tolerance_mm, Some(0.1));
        assert_eq!(t.angle_tolerance_deg, Some(15.0));
        assert_eq!(t.max_edge_length_mm, None);
    }

    #[test]
    fn wire_boolean_request_parses_frontend_shape() {
        let raw = r#"{
            "a": { "kind": "box", "params": { "size": [10, 10, 10] } },
            "b": { "kind": "cylinder", "params": { "radius": 3, "height": 8 } },
            "op": "difference"
        }"#;
        let req: SmBooleanReq = serde_json::from_str(raw).unwrap();
        assert!(matches!(req.op, SmOp::Difference));
        assert!(matches!(req.a.kind, SmKind::Box));
    }

    #[test]
    fn wire_result_keys_are_camel_case() {
        let wire = SmResultWire::ok(
            SmBodyWire {
                vertices: vec![[0.0, 0.0, 0.0]],
                faces: vec![SmFaceWire {
                    vertices: vec![0, 0, 0],
                    normal: [0.0, 1.0, 0.0],
                    source: Some(FaceSourceWire::Cone {
                        apex: Vec3Wire::new([0.0, 1.0, 0.0]),
                        axis: Vec3Wire::new([0.0, -1.0, 0.0]),
                        half_angle: 0.5,
                    }),
                }],
            },
            123.5,
        );
        let json = serde_json::to_value(&wire).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["brepVolumeMm3"], 123.5);
        assert_eq!(
            json["body"]["vertices"][0],
            serde_json::json!([0.0, 0.0, 0.0])
        );
        let face = &json["body"]["faces"][0];
        assert_eq!(face["vertices"], serde_json::json!([0, 0, 0]));
        assert_eq!(face["normal"], serde_json::json!([0.0, 1.0, 0.0]));
        let src = &face["source"];
        assert_eq!(src["kind"], "cone");
        assert_eq!(src["halfAngle"], 0.5);
        assert_eq!(src["apex"]["y"], 1.0);

        let err = SmResultWire::err("boom");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"], "boom");
        assert!(json.get("body").is_none() || json["body"].is_null());
    }

    #[test]
    fn wire_all_face_source_kinds_serialized_field_names() {
        let sources = [
            FaceSourceWire::Plane {
                point: Vec3Wire::new([1.0, 2.0, 3.0]),
                normal: Vec3Wire::new([0.0, 1.0, 0.0]),
            },
            FaceSourceWire::Cylinder {
                origin: Vec3Wire::new([0.0; 3]),
                axis: Vec3Wire::new([0.0, 1.0, 0.0]),
                radius: 5.0,
            },
            FaceSourceWire::Sphere {
                center: Vec3Wire::new([0.0; 3]),
                radius: 5.0,
            },
            FaceSourceWire::Torus {
                center: Vec3Wire::new([0.0; 3]),
                axis: Vec3Wire::new([0.0, 1.0, 0.0]),
                major_radius: 5.0,
                minor_radius: 2.0,
            },
        ];
        for src in &sources {
            let json = serde_json::to_value(src).unwrap();
            let kind = json["kind"].as_str().unwrap();
            let expected_keys: &[&str] = match kind {
                "plane" => &["kind", "point", "normal"],
                "cylinder" => &["kind", "origin", "axis", "radius"],
                "sphere" => &["kind", "center", "radius"],
                "torus" => &["kind", "center", "axis", "majorRadius", "minorRadius"],
                _ => panic!("unexpected kind {kind}"),
            };
            let obj = json.as_object().unwrap();
            assert_eq!(obj.len(), expected_keys.len(), "kind {kind}");
            for k in expected_keys {
                assert!(obj.contains_key(*k), "kind {kind} missing key {k}");
            }
        }
        // plane point uses the {x,y,z} object form
        let plane = serde_json::to_value(&sources[0]).unwrap();
        assert_eq!(
            plane["point"],
            serde_json::json!({"x": 1.0, "y": 2.0, "z": 3.0})
        );
    }

    #[test]
    fn status_matches_dll_presence() {
        let st = status_impl();
        if dlls_present() {
            assert!(
                st.available,
                "DLLs present but status unavailable: {:?}",
                st.error
            );
            assert!(st.version.as_deref().unwrap_or("").starts_with("smmesh"));
        } else {
            assert!(!st.available);
            assert!(st.error.is_some());
        }
    }

    #[test]
    fn param_validation_rejects_bad_requests() {
        let cases: Vec<(SmKind, SmParamsReq, &str)> = vec![
            (
                SmKind::Box,
                params(&[("size", json!([10, 10]))]),
                "size len 2",
            ),
            (
                SmKind::Box,
                params(&[("size", json!([10, 0, 10]))]),
                "zero extent",
            ),
            (SmKind::Box, SmParamsReq::default(), "missing size"),
            (
                SmKind::Cylinder,
                params(&[("radius", json!(5))]),
                "missing height",
            ),
            (
                SmKind::Cylinder,
                params(&[("radius", json!(-5)), ("height", json!(5))]),
                "negative radius",
            ),
            (
                SmKind::Sphere,
                params(&[("radius", json!(0))]),
                "zero radius",
            ),
            (
                SmKind::Cone,
                params(&[("bottomRadius", json!(10)), ("height", json!(5))]),
                "missing topRadius",
            ),
            (
                SmKind::Cone,
                params(&[
                    ("bottomRadius", json!(10)),
                    ("topRadius", json!(-1)),
                    ("height", json!(5)),
                ]),
                "negative topRadius",
            ),
            (
                SmKind::Torus,
                params(&[("majorRadius", json!(5)), ("minorRadius", json!(0))]),
                "zero minorRadius",
            ),
            (
                SmKind::Box,
                params(&[("size", json!([10, 10, 10])), ("center", json!([1, 2]))]),
                "bad center",
            ),
        ];
        let present = dlls_present();
        for (kind, p, label) in cases {
            let wire = primitive_impl(&prim(kind, p, None));
            assert!(!wire.ok, "{label} should fail");
            let err = wire.error.unwrap_or_default();
            if present {
                // validation error text, not a load error
                assert!(
                    err.contains("params.") || err.contains("center"),
                    "{label}: unexpected error {err}"
                );
            }
        }
        // NaN center cannot arrive through JSON (serde_json rejects non-finite
        // floats) but the Rust API surface validates it defensively anyway.
        let mut nan_center = params(&[("size", json!([10, 10, 10]))]);
        nan_center.center = Some(vec![0.0, f64::NAN, 0.0]);
        let wire = primitive_impl(&prim(SmKind::Box, nan_center, None));
        assert!(!wire.ok, "NaN center should fail");
        if present {
            assert!(
                wire.error.unwrap_or_default().contains("center"),
                "NaN center error should name the field"
            );
        }
    }

    // ---- golden tests against the real kernel --------------------------------

    #[test]
    fn golden_box_volume_and_plane_tags() {
        with_kernel(|| {
            let wire = primitive_impl(&prim(
                SmKind::Box,
                params(&[("size", json!([10, 10, 10]))]),
                None,
            ));
            assert!(wire.ok, "{:?}", wire.error);
            let volume = wire.brep_volume_mm3.unwrap();
            assert_close(volume, 1000.0, 1e-6, "box volume");
            let body = wire.body.unwrap();
            // 8 corners at +-5, all six faces tagged plane, outward winding.
            assert_eq!(body.vertices.len(), 8);
            for v in &body.vertices {
                assert_eq!(v[0].abs(), 5.0);
                assert_eq!(v[1].abs(), 5.0);
                assert_eq!(v[2].abs(), 5.0);
            }
            // The kernel tessellates each side into 2 triangles (8 shared
            // vertices, 12 faces); every one keeps the plane tag.
            assert_eq!(body.faces.len(), 12);
            for f in &body.faces {
                let src = f.source.as_ref().expect("box faces carry plane tags");
                match src {
                    FaceSourceWire::Plane { point, normal } => {
                        // outward unit normal on a principal axis, point on that plane
                        let n = normal.as_array();
                        let axis = [n[0].abs(), n[1].abs(), n[2].abs()];
                        assert_eq!(axis.iter().sum::<f64>(), 1.0, "unit principal normal");
                        let p = point.as_array();
                        let d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
                        assert_close(d, 5.0, 1e-9, "plane offset |d|");
                        // Newell normal agrees with the tag (outward winding)
                        let w = f.normal;
                        assert!(
                            (w[0] * n[0] + w[1] * n[1] + w[2] * n[2] - 1.0).abs() < 1e-9,
                            "winding: newell {w:?} vs plane normal {n:?}"
                        );
                    }
                    other => panic!("expected plane tag, got {other:?}"),
                }
            }
            // specifically: a top face with normal +y and point y = 5
            let top = body.faces.iter().any(|f| {
                matches!(
                    &f.source,
                    Some(FaceSourceWire::Plane { point, normal })
                        if (normal.y - 1.0).abs() < 1e-9 && (point.y - 5.0).abs() < 1e-9
                )
            });
            assert!(top, "box must have a +y plane face at y=5");
        });
    }

    #[test]
    fn golden_cylinder_volume_and_tags() {
        with_kernel(|| {
            let wire = primitive_impl(&prim(
                SmKind::Cylinder,
                params(&[("radius", json!(5)), ("height", json!(10))]),
                None,
            ));
            assert!(wire.ok, "{:?}", wire.error);
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                250.0 * std::f64::consts::PI,
                1e-6,
                "cyl volume",
            );
            let body = wire.body.unwrap();
            // The wall is tessellated into many strips; every strip carries a
            // cylinder tag with identical analytic parameters.
            let mut walls = 0;
            let mut caps_pos = 0;
            let mut caps_neg = 0;
            for f in &body.faces {
                match f.source.as_ref().expect("cyl faces tagged") {
                    FaceSourceWire::Cylinder {
                        origin,
                        axis,
                        radius,
                    } => {
                        walls += 1;
                        // axis is exactly +y (or -y): contract placement
                        let a = axis.as_array();
                        assert!(
                            (a[0].abs() < 1e-9)
                                && (a[2].abs() < 1e-9)
                                && ((a[1] - 1.0).abs() < 1e-9 || (a[1] + 1.0).abs() < 1e-9),
                            "cyl axis {a:?}"
                        );
                        assert_close(*radius, 5.0, 1e-9, "cyl radius");
                        let o = origin.as_array();
                        assert!(
                            o[0].abs() < 1e-9 && o[2].abs() < 1e-9,
                            "origin on the y axis"
                        );
                    }
                    FaceSourceWire::Plane { normal, .. } => {
                        let n = normal.as_array();
                        if (n[1] - 1.0).abs() < 1e-9 {
                            caps_pos += 1;
                        } else if (n[1] + 1.0).abs() < 1e-9 {
                            caps_neg += 1;
                        } else {
                            panic!("cyl cap normal +-y expected, got {n:?}");
                        }
                    }
                    other => panic!("unexpected tag {other:?}"),
                }
            }
            assert!(walls >= 1, "at least one cylindrical wall strip");
            assert!(
                caps_pos >= 1 && caps_neg >= 1,
                "both y caps present (pos {caps_pos}, neg {caps_neg})"
            );
            // base on y=0, top at y=10
            let ys: Vec<f64> = body.vertices.iter().map(|v| v[1]).collect();
            assert_close(
                ys.iter().cloned().fold(f64::INFINITY, f64::min),
                0.0,
                1e-9,
                "base y",
            );
            assert_close(
                ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                10.0,
                1e-9,
                "top y",
            );
        });
    }

    #[test]
    fn golden_sphere_volume_and_tag() {
        with_kernel(|| {
            let wire = primitive_impl(&prim(SmKind::Sphere, params(&[("radius", json!(5))]), None));
            assert!(wire.ok, "{:?}", wire.error);
            let expected = 4.0 / 3.0 * 125.0 * std::f64::consts::PI;
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                expected,
                1e-6,
                "sphere volume",
            );
            let body = wire.body.unwrap();
            assert!(!body.faces.is_empty());
            for f in &body.faces {
                match f.source.as_ref().expect("sphere faces tagged") {
                    FaceSourceWire::Sphere { center, radius } => {
                        assert_vec3(*center, [0.0; 3], "sphere center");
                        assert_close(*radius, 5.0, 1e-9, "sphere radius");
                    }
                    other => panic!("unexpected tag {other:?}"),
                }
            }
            // all vertices on r=5
            for v in &body.vertices {
                let r = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                assert_close(r, 5.0, 1e-9, "vertex radius");
            }
        });
    }

    #[test]
    fn golden_fustum_cone_volume_and_tag() {
        with_kernel(|| {
            // d20 bottom -> d10 top, h15: V = pi*h/3*(R^2 + R*r + r^2) = 875*pi
            let wire = primitive_impl(&prim(
                SmKind::Cone,
                params(&[
                    ("bottomRadius", json!(10)),
                    ("topRadius", json!(5)),
                    ("height", json!(15)),
                ]),
                None,
            ));
            assert!(wire.ok, "{:?}", wire.error);
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                875.0 * std::f64::consts::PI,
                1e-6,
                "frustum volume",
            );
            let body = wire.body.unwrap();
            let mut cone_faces = 0;
            for f in &body.faces {
                if let Some(FaceSourceWire::Cone {
                    apex,
                    axis,
                    half_angle,
                }) = f.source.as_ref()
                {
                    cone_faces += 1;
                    // apex where the radius vanishes: y = h*R/(R-r) = 30
                    assert_vec3(*apex, [0.0, 30.0, 0.0], "cone apex");
                    // axis points from the apex INTO the band => -y
                    assert_vec3(*axis, [0.0, -1.0, 0.0], "cone axis");
                    assert_close(*half_angle, (5.0f64 / 15.0).atan(), 1e-9, "cone halfAngle");
                }
            }
            assert!(cone_faces >= 1, "at least one conical wall strip");
            // base circle at y=0 radius 10, top at y=15 radius 5
            let mut base_r: f64 = 0.0;
            let mut top_r: f64 = 0.0;
            for v in &body.vertices {
                let r = (v[0] * v[0] + v[2] * v[2]).sqrt();
                if v[1].abs() < 1e-9 {
                    base_r = base_r.max(r);
                }
                if (v[1] - 15.0).abs() < 1e-9 {
                    top_r = top_r.max(r);
                }
            }
            assert_close(base_r, 10.0, 1e-9, "base radius");
            assert_close(top_r, 5.0, 1e-9, "top radius");
        });
    }

    #[test]
    fn golden_pointed_cone_volume_and_tag() {
        with_kernel(|| {
            // Pointed cone (topRadius = 0): the degenerate-top boundary of the
            // cone code path. V = pi*h/3*R^2 = 500*pi; the apex IS the tip.
            let wire = primitive_impl(&prim(
                SmKind::Cone,
                params(&[
                    ("bottomRadius", json!(10)),
                    ("topRadius", json!(0)),
                    ("height", json!(15)),
                ]),
                None,
            ));
            assert!(wire.ok, "{:?}", wire.error);
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                500.0 * std::f64::consts::PI,
                1e-6,
                "pointed cone volume",
            );
            let body = wire.body.unwrap();
            let mut cone_faces = 0;
            for f in &body.faces {
                if let Some(FaceSourceWire::Cone {
                    apex,
                    axis,
                    half_angle,
                }) = f.source.as_ref()
                {
                    cone_faces += 1;
                    // tip at y = h = 15; axis points from the apex INTO the band (-y)
                    assert_vec3(*apex, [0.0, 15.0, 0.0], "pointed cone apex (= tip)");
                    assert_vec3(*axis, [0.0, -1.0, 0.0], "pointed cone axis (into band)");
                    assert_close(
                        *half_angle,
                        (10.0f64 / 15.0).atan(),
                        1e-9,
                        "pointed cone halfAngle",
                    );
                }
            }
            assert!(cone_faces >= 1, "pointed cone wall carries cone tags");
            // base circle radius 10 on y=0; solid spans y in [0, 15]
            let mut base_r = 0.0f64;
            let (mut y_min, mut y_max) = (f64::INFINITY, f64::NEG_INFINITY);
            for v in &body.vertices {
                y_min = y_min.min(v[1]);
                y_max = y_max.max(v[1]);
                if v[1].abs() < 1e-9 {
                    base_r = base_r.max((v[0] * v[0] + v[2] * v[2]).sqrt());
                }
            }
            assert_close(base_r, 10.0, 1e-9, "pointed cone base radius");
            assert_close(y_min, 0.0, 1e-9, "pointed cone y min");
            assert_close(y_max, 15.0, 1e-9, "pointed cone y max (= apex)");
        });
    }

    #[test]
    fn golden_torus_volume_and_tag() {
        with_kernel(|| {
            let wire = primitive_impl(&prim(
                SmKind::Torus,
                params(&[("majorRadius", json!(5)), ("minorRadius", json!(2))]),
                None,
            ));
            assert!(wire.ok, "{:?}", wire.error);
            let expected = 2.0 * std::f64::consts::PI.powi(2) * 5.0 * 4.0;
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                expected,
                1e-6,
                "torus volume",
            );
            let body = wire.body.unwrap();
            assert!(!body.faces.is_empty());
            for f in &body.faces {
                match f.source.as_ref().expect("torus faces tagged") {
                    FaceSourceWire::Torus {
                        center,
                        axis,
                        major_radius,
                        minor_radius,
                    } => {
                        assert_vec3(*center, [0.0; 3], "torus center");
                        // axis exactly +-y (unit, on the contract symmetry axis)
                        let a = axis.as_array();
                        assert!(
                            (a[0].abs() < 1e-9)
                                && (a[2].abs() < 1e-9)
                                && ((a[1] - 1.0).abs() < 1e-9 || (a[1] + 1.0).abs() < 1e-9),
                            "torus axis {a:?}"
                        );
                        assert_close(*major_radius, 5.0, 1e-9, "major radius");
                        assert_close(*minor_radius, 2.0, 1e-9, "minor radius");
                    }
                    other => panic!("unexpected tag {other:?}"),
                }
            }
        });
    }

    #[test]
    fn golden_box_union_offset_exact() {
        with_kernel(|| {
            let req = SmBooleanReq {
                a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                b: prim(
                    SmKind::Box,
                    params(&[("size", json!([10, 10, 10])), ("center", json!([5, 0, 0]))]),
                    None,
                ),
                op: SmOp::Union,
                tessellation: None,
            };
            let wire = boolean_impl(&req);
            assert!(wire.ok, "{:?}", wire.error);
            // 1000 + 1000 - 500 overlap = 1500 exactly (spike-verified).
            assert_close(wire.brep_volume_mm3.unwrap(), 1500.0, 1e-6, "union volume");
            let body = wire.body.unwrap();
            // The untouched outer faces survive with plane tags: x=-5 and x=10.
            let minus_x = body.faces.iter().any(|f| {
                matches!(
                    &f.source,
                    Some(FaceSourceWire::Plane { point, normal })
                        if (normal.x + 1.0).abs() < 1e-9 && (point.x + 5.0).abs() < 1e-9
                )
            });
            let plus_x = body.faces.iter().any(|f| {
                matches!(
                    &f.source,
                    Some(FaceSourceWire::Plane { point, normal })
                        if (normal.x - 1.0).abs() < 1e-9 && (point.x - 10.0).abs() < 1e-9
                )
            });
            assert!(minus_x, "union keeps the x=-5 outer face tag");
            assert!(plus_x, "union keeps the x=+10 outer face tag");
        });
    }

    #[test]
    fn golden_box_difference_cylinder() {
        with_kernel(|| {
            // 10^3 box with a r=2 through-hole along y (cylinder centered).
            let req = SmBooleanReq {
                a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                b: prim(
                    SmKind::Cylinder,
                    params(&[
                        ("radius", json!(2)),
                        ("height", json!(12)),
                        ("center", json!([0, -6, 0])),
                    ]),
                    None,
                ),
                op: SmOp::Difference,
                tessellation: None,
            };
            let wire = boolean_impl(&req);
            assert!(wire.ok, "{:?}", wire.error);
            let expected = 1000.0 - 40.0 * std::f64::consts::PI;
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                expected,
                1e-6,
                "difference volume",
            );
            let body = wire.body.unwrap();
            // Provenance finding: faces CREATED by a boolean lose their
            // analytic tag (GetOriginalFace -> null) while untouched faces
            // keep theirs -- the union test above proves plane tags survive.
            // The r=2 hole therefore shows up geometrically (radial normals)
            // and the untouched box walls keep plane tags; a surviving
            // cylinder tag is accepted but not required.
            let radial_wall = body.faces.iter().any(|f| {
                let n = f.normal;
                n[1].abs() < 1e-9 && (n[0] * n[0] + n[2] * n[2]).sqrt() > 0.99
            });
            assert!(
                radial_wall,
                "the drill hole wall is present (radial normals)"
            );
            let untouched = body.faces.iter().any(|f| {
                matches!(
                    &f.source,
                    Some(FaceSourceWire::Plane { point, normal })
                        if (normal.x - 1.0).abs() < 1e-9 && (point.x - 5.0).abs() < 1e-9
                )
            });
            assert!(untouched, "untouched +x box wall keeps its plane tag");
        });
    }

    #[test]
    fn golden_box_intersection_exact() {
        with_kernel(|| {
            let req = SmBooleanReq {
                a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                b: prim(
                    SmKind::Box,
                    params(&[("size", json!([10, 10, 10])), ("center", json!([5, 0, 0]))]),
                    None,
                ),
                op: SmOp::Intersect,
                tessellation: None,
            };
            let wire = boolean_impl(&req);
            assert!(wire.ok, "{:?}", wire.error);
            assert_close(
                wire.brep_volume_mm3.unwrap(),
                500.0,
                1e-6,
                "intersection volume",
            );
        });
    }

    #[test]
    fn golden_tessellation_params_change_vertex_count() {
        with_kernel(|| {
            let p = params(&[("radius", json!(5)), ("height", json!(10))]);
            let coarse = primitive_impl(&prim(SmKind::Cylinder, p.clone(), None));
            let fine = primitive_impl(&prim(
                SmKind::Cylinder,
                p,
                Some(SmTessellationReq {
                    chord_tolerance_mm: Some(0.1),
                    angle_tolerance_deg: Some(10.0),
                    max_edge_length_mm: None,
                }),
            ));
            assert!(coarse.ok && fine.ok);
            let n_coarse = coarse.body.unwrap().vertices.len();
            let n_fine = fine.body.unwrap().vertices.len();
            assert!(
                n_fine != n_coarse,
                "tessellation params must change the mesh ({n_coarse} vs {n_fine})"
            );
            assert!(
                n_fine > n_coarse,
                "finer tolerance should tessellate denser ({n_coarse} -> {n_fine})"
            );
        });
    }

    #[test]
    fn golden_disjoint_boolean_fails_cleanly() {
        with_kernel(|| {
            let req = SmBooleanReq {
                a: prim(
                    SmKind::Sphere,
                    params(&[("radius", json!(2)), ("center", json!([-50, 0, 0]))]),
                    None,
                ),
                b: prim(
                    SmKind::Sphere,
                    params(&[("radius", json!(2)), ("center", json!([50, 0, 0]))]),
                    None,
                ),
                op: SmOp::Intersect,
                tessellation: None,
            };
            let wire = boolean_impl(&req);
            assert!(!wire.ok, "disjoint intersection has empty result");
            assert!(wire.error.is_some());
            // The engine must still be healthy afterwards (no leaked lock/panic).
            let after = primitive_impl(&prim(
                SmKind::Box,
                params(&[("size", json!([2, 2, 2]))]),
                None,
            ));
            assert!(after.ok, "engine must survive a failed boolean");
            assert_close(
                after.brep_volume_mm3.unwrap(),
                8.0,
                1e-6,
                "post-failure box",
            );
        });
    }

    #[test]
    fn golden_dump_numbers() {
        with_kernel(|| {
            let cases: Vec<(&str, SmPrimitiveReq)> = vec![
                (
                    "pointed cone R10 h15",
                    prim(
                        SmKind::Cone,
                        params(&[
                            ("bottomRadius", json!(10)),
                            ("topRadius", json!(0)),
                            ("height", json!(15)),
                        ]),
                        None,
                    ),
                ),
                (
                    "box10",
                    prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                ),
                (
                    "cyl r5 h10",
                    prim(
                        SmKind::Cylinder,
                        params(&[("radius", json!(5)), ("height", json!(10))]),
                        None,
                    ),
                ),
                (
                    "sphere r5",
                    prim(SmKind::Sphere, params(&[("radius", json!(5))]), None),
                ),
                (
                    "frustum R10r5 h15",
                    prim(
                        SmKind::Cone,
                        params(&[
                            ("bottomRadius", json!(10)),
                            ("topRadius", json!(5)),
                            ("height", json!(15)),
                        ]),
                        None,
                    ),
                ),
                (
                    "torus R5 r2",
                    prim(
                        SmKind::Torus,
                        params(&[("majorRadius", json!(5)), ("minorRadius", json!(2))]),
                        None,
                    ),
                ),
            ];
            for (label, req) in &cases {
                let w = primitive_impl(req);
                let b = w.body.unwrap();
                eprintln!(
                    "[gold] {label}: vol={:.12} verts={} faces={}",
                    w.brep_volume_mm3.unwrap(),
                    b.vertices.len(),
                    b.faces.len()
                );
            }
            let unions = SmBooleanReq {
                a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                b: prim(
                    SmKind::Box,
                    params(&[("size", json!([10, 10, 10])), ("center", json!([5, 0, 0]))]),
                    None,
                ),
                op: SmOp::Union,
                tessellation: None,
            };
            let inter = SmBooleanReq {
                op: SmOp::Intersect,
                ..unions.clone()
            };
            let diff = SmBooleanReq {
                a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                b: prim(
                    SmKind::Cylinder,
                    params(&[
                        ("radius", json!(2)),
                        ("height", json!(12)),
                        ("center", json!([0, -6, 0])),
                    ]),
                    None,
                ),
                op: SmOp::Difference,
                tessellation: None,
            };
            for (label, req) in [
                ("union", unions),
                ("intersect", inter),
                ("difference", diff),
            ] {
                let w = boolean_impl(&req);
                eprintln!("[gold] {label}: vol={:.12}", w.brep_volume_mm3.unwrap());
            }
        });
    }

    #[test]
    #[cfg(windows)]
    fn golden_no_leak_over_500_cycles() {
        with_kernel(|| {
            // 500 x (two boxes + union + tessellate + extract + release),
            // working set must stay flat (the FFI spike proved the teardown
            // protocol; this guards it end-to-end through the service).
            let warmup = 50;
            let cycles = 500;
            let measure_from = warmup;
            let mut ws_before = 0usize;
            for i in 0..warmup + cycles {
                if i == measure_from {
                    ws_before = working_set_bytes();
                }
                let req = SmBooleanReq {
                    a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                    b: prim(
                        SmKind::Box,
                        params(&[("size", json!([10, 10, 10])), ("center", json!([5, 0, 0]))]),
                        None,
                    ),
                    op: SmOp::Union,
                    tessellation: Some(SmTessellationReq {
                        chord_tolerance_mm: Some(0.05),
                        angle_tolerance_deg: None,
                        max_edge_length_mm: None,
                    }),
                };
                let wire = boolean_impl(&req);
                assert!(wire.ok, "cycle {i} failed: {:?}", wire.error);
            }
            let ws_after = working_set_bytes();
            let delta: i64 = ws_after as i64 - ws_before as i64;
            eprintln!(
                "leak loop: {} cycles, working set {} -> {} bytes (delta {delta} B)",
                cycles, ws_before, ws_after
            );
            assert!(
                delta < 32 * 1024 * 1024,
                "working set grew {delta} B over {cycles} cycles -- leak?"
            );
        });
    }

    /// Long soak variant of golden_no_leak_over_500_cycles for leak-hunting
    /// sessions: same double-box union + tessellate + extract + release loop,
    /// but the cycle count comes from the optional SM_SOAK_CYCLES env var
    /// (default 2000; invalid or non-positive values fall back to 2000 with a
    /// note) and the budget scales with it — steady-state growth must stay
    /// under 2 KB per cycle, plus an 8 MB one-off allowance for lazy kernel
    /// allocations that land inside the measured window after the warmup.
    #[test]
    #[ignore = "long soak; env SM_SOAK_CYCLES is optional (default 2000); run with: cargo test -- --ignored"]
    #[cfg(windows)]
    fn sm_soak_long() {
        with_kernel(|| {
            let cycles: usize = match std::env::var("SM_SOAK_CYCLES") {
                Ok(raw) => match raw.trim().parse::<usize>() {
                    Ok(c) if c > 0 => c,
                    _ => {
                        eprintln!(
                            "SM_SOAK_CYCLES={raw:?} is not a positive integer -- using the default 2000"
                        );
                        2000
                    }
                },
                Err(_) => 2000,
            };
            let warmup = 50usize;
            let mut ws_before = 0usize;
            for i in 0..warmup + cycles {
                if i == warmup {
                    ws_before = working_set_bytes();
                }
                let req = SmBooleanReq {
                    a: prim(SmKind::Box, params(&[("size", json!([10, 10, 10]))]), None),
                    b: prim(
                        SmKind::Box,
                        params(&[("size", json!([10, 10, 10])), ("center", json!([5, 0, 0]))]),
                        None,
                    ),
                    op: SmOp::Union,
                    tessellation: Some(SmTessellationReq {
                        chord_tolerance_mm: Some(0.05),
                        angle_tolerance_deg: None,
                        max_edge_length_mm: None,
                    }),
                };
                let wire = boolean_impl(&req);
                assert!(wire.ok, "cycle {i} failed: {:?}", wire.error);
            }
            let ws_after = working_set_bytes();
            let delta: i64 = ws_after as i64 - ws_before as i64;
            let budget: i64 = cycles as i64 * 2 * 1024 + 8 * 1024 * 1024;
            eprintln!(
                "long soak: {cycles} cycles, working set {} -> {} bytes (delta {delta} B, budget {budget} B)",
                ws_before,
                ws_after,
            );
            assert!(
                delta < budget,
                "working set grew {delta} B over {cycles} cycles (budget {budget} B, 2 KB/cycle + 8 MB) -- leak?"
            );
        });
    }

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[cfg(windows)]
    fn working_set_bytes() -> usize {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut c_void;
            fn K32GetProcessMemoryInfo(
                process: *mut c_void,
                counters: *mut ProcessMemoryCounters,
                cb: u32,
            ) -> i32;
        }
        unsafe {
            let mut pmc = ProcessMemoryCounters {
                cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
                page_fault_count: 0,
                peak_working_set_size: 0,
                working_set_size: 0,
                quota_peak_paged_pool_usage: 0,
                quota_paged_pool_usage: 0,
                quota_peak_non_paged_pool_usage: 0,
                quota_non_paged_pool_usage: 0,
                pagefile_usage: 0,
                peak_pagefile_usage: 0,
            };
            K32GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb);
            pmc.working_set_size
        }
    }

    use serde_json::json;
}
