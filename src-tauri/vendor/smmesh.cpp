// smmesh.cpp -- extern "C" shim over the SMLib kernel (NVIDIA usd-brep,
// Apache-2.0) used by SceneLab's exact-geometry service (P3).
//
// Responsibilities:
//   1. Create exact BRep primitives in SceneLab's contract frame (Y-up;
//      box/sphere/torus centered at their `center`; cylinder/cone with the
//      base circle on the center and axis +y). SMLib itself is Z-up, so every
//      input is mapped C->S on the way in and every extracted datum is mapped
//      S->C on the way out. The transforms are exact sign/permutation flips,
//      so no accuracy is ever lost.
//   2. Exact BRep booleans (union / difference / intersection).
//   3. Tessellation with per-face analytic provenance: for each SmPolyFace
//      the parent SmFace's SmSurface is queried for its dynamic type and
//      canonical parameters (plane / cylinder / cone / sphere / torus).
//   4. BRep-level exact volume (forwarded from SM_API).
//
// Build (MSVC, /MD is REQUIRED: SMLib.dll/SM_API.dll use ucrtbase malloc/free
// as their shared allocator, and shim-side frees must hit the same heap):
//   cl /nologo /MD /O2 /EHsc /W3 /std:c++17 /DUNICODE /D_UNICODE /LD smmesh.cpp
//      -I<sm-lib>/include/SM_API -I<sm-lib>/include/SMLib
//      /link /LIBPATH:<sm-lib>/lib SMLib.lib SM_API.lib
// (/DUNICODE matches SMLib's TCHAR == wchar_t; a narrow build links against
//  PEBD-mangled exports that do not exist -> LNK2019.)
//
// FFI / exception convention ( EVERY export below follows it ):
//   - C++ exceptions must never unwind out of an extern "C" export into the
//     Rust frame (undefined behavior). Each body is wrapped in try/catch(...);
//     on exception, pointer-returning exports answer nullptr, int-returning
//     exports answer the reserved code -99, and the void teardown exports
//     swallow (best effort -- there is nothing else to do while releasing).
//   - Reserved negative codes: -1..-4  caller/argument errors (per export),
//     -99 unexpected C++ exception. Positive values are raw SM status codes.
//     0 always means success.
//
// Memory protocol (verified in the FFI spike, mirrored here):
//   - SmBrep / SmPolyBrep objects live on the process-wide ucrt heap shared
//     with SMLib.dll. Teardown = call the class destructor through the DLL
//     export, then ucrt free() the block. Both happen inside this shim
//     (compiled /MD -> free() == ucrtbase!free); Rust never frees SMLib
//     memory itself.
//   - Flat buffers returned by smmesh_extract are malloc'd by this shim and
//     must be released with smmesh_free_buffer.
//   - Booleans follow SM_API semantics: on success operand B is deleted by
//     the kernel and A becomes the result; on failure both remain allocated
//     (A possibly modified) and the caller must free both.

#include <SmApiTypes.h>
#include <SmApiGeneral.h>      // SmApiCreateContext
#include <SmApiPrimitives.h>   // SmApiCreateBox / Sphere / Cone / Cylinder / Torus
#include <SmApiBrep.h>         // SmApiTessellate / SmApiBooleanUnion/...
#include <SmApiQueries.h>      // SmApiBrepComputeVolume
#include <SmApiPolygons.h>     // SmApiPolyBrepComputeVolume
#include <SmPoly.h>            // SmPolyBrep / SmPolyFace / SmPolyVertex / SmPolyLoop / SmPolyEdge
#include <SmFace.h>            // SmFace::GetSurface
#include <SmSurface.h>         // SmSurface::GetType (SM_COMMON)
#include <SmSurfTypes.h>       // SmPlane_TYPE .. SmTorus_TYPE
#include <SmPlane.h>
#include <SmCylinder.h>
#include <SmCone.h>
#include <SmSphere.h>
#include <SmTorus.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

// ---------------------------------------------------------------- helpers --

// Coordinate frames:
//   S = SMLib frame, Z-up        C = SceneLab contract frame, Y-up
//   C->S : (x, y, z) -> (x, -z,  y)
//   S->C : (x, y, z) -> (x,  z, -y)
// (rotation about +x by 90 degrees; a point on contract +y maps to S +z and
//  back, and the map is its own inverse up to the sign convention above --
//  verified by round-tripping in the acceptance tests.)
static inline void c2s_point(double& x, double& y, double& z) { double t = y; y = -z; z = t; }
static inline void s2c_point(double& x, double& y, double& z) { double t = y; y = z; z = -t; }

static SmTessellationParams make_params(double chordTol, double angTolDeg, double maxEdge)
{
    // 0.0 in an argument means "use the shared SMLib default" (same defaults
    // the Python bindings use -> comparable outputs).
    SmTessellationParams p;
    if (chordTol  > 0.0) p.dChordHeightTol     = chordTol;
    if (angTolDeg > 0.0) { p.dCurveAngleTolDeg   = angTolDeg;
                            p.dSurfaceAngleTolDeg = angTolDeg; }
    if (maxEdge   > 0.0) p.dMaxEdgeLength      = maxEdge;
    return p;
}

// Walk the outer loop of a face, returning vertex pointers in face order.
// Mirrors SmPyLib/src/SmPyPolyBrep.cpp extract_mesh_arrays().
static bool face_vertices(SmPolyFace* pf, SmTArray<SmPolyVertex*>& out)
{
    SmPolyLoop* loop = pf->GetOuterPolyLoop();
    if (!loop) return false;
    SmTArray<SmPolyEdge*> edges;
    loop->GetPolyEdges(edges);
    const ULONG n = edges.GetSize();
    if (n == 0) return false;
    out.SetSize(n);
    for (ULONG i = 0; i < n; ++i)
        out[i] = edges[i]->GetStartPolyVertex();
    return true;
}

// ------------------------------------------------------------------- init --

extern "C" __declspec(dllexport)
int smmesh_init(void)
{
    try {
        SmApiCreateContext();  // returns void; the engine is single-threaded,
        return 0;              // callers serialize all smmesh_* calls
    } catch (...) { return -99; }
}

extern "C" __declspec(dllexport)
const char* smmesh_version(void)
{
    try {
        return "smmesh 1.0 (SMLib / usd-brep v1.0.0)";
    } catch (...) { return ""; }
}

// ---------------------------------------------- primitives (contract frame) --
// All parameters below are in SceneLab contract coordinates (Y-up). Each
// creator takes an explicit center (contract frame): box/sphere/torus center
// it symmetrically; cylinder/cone place the base circle at the center (axis
// still +y, top at center.y + height). (cx,cy,cz) = (0,0,0) reproduces the
// original origin-anchored placement.

extern "C" __declspec(dllexport)
void* smmesh_box(double sx, double sy, double sz, double cx, double cy, double cz)
{
    try {
        // Contract: centered at (cx, cy, cz), extents (sx, sy, sz) along (x, y, z).
        // SMLib box grows +X/+Y/+Z from its origin corner, so we must pass the
        // image box's MIN corner in S -- not c2s() of the contract min corner
        // (which flips z and is therefore the max corner in S-y). With
        // C->S : (x, y, z) -> (x, -z, y), the image of the contract box spans
        //   S_x in [cx-sx/2, cx+sx/2], S_y in [-(cz+sz/2), -(cz-sz/2)],
        //   S_z in [cy-sy/2, cy+sy/2]
        // and the min corner is (cx-sx/2, -(cz+sz/2), cy-sy/2). Extents in S
        // are (sx, sz, sy).
        SmVector3d origin(cx - 0.5 * sx, -(cz + 0.5 * sz), cy - 0.5 * sy);
        SmBrep* b = nullptr;
        SmApiStatus st = SmApiCreateBox(origin, sx, sz, sy, b); // S: X=sx Y=sz Z=sy
        return (st == SM_SUCCESS && b) ? (void*)b : nullptr;
    } catch (...) { return nullptr; }
}

extern "C" __declspec(dllexport)
void* smmesh_cylinder(double radius, double height, double cx, double cy, double cz)
{
    try {
        // Contract: base circle centered at (cx, cy, cz), axis +y, top at cy+height.
        // S frame: base at c2s(center), axis +z.
        double bx = cx, by = cy, bz = cz;
        c2s_point(bx, by, bz);
        SmBrep* b = nullptr;
        SmApiStatus st = SmApiCreateCylinder(SmVector3d(bx, by, bz), radius, height, b);
        return (st == SM_SUCCESS && b) ? (void*)b : nullptr;
    } catch (...) { return nullptr; }
}

extern "C" __declspec(dllexport)
void* smmesh_sphere(double radius, double cx, double cy, double cz)
{
    try {
        double px = cx, py = cy, pz = cz;
        c2s_point(px, py, pz);
        SmBrep* b = nullptr;
        SmApiStatus st = SmApiCreateSphere(SmVector3d(px, py, pz), radius, b);
        return (st == SM_SUCCESS && b) ? (void*)b : nullptr;
    } catch (...) { return nullptr; }
}

extern "C" __declspec(dllexport)
void* smmesh_cone(double bottomRadius, double topRadius, double height,
                  double cx, double cy, double cz)
{
    try {
        // Contract: bottom circle centered at (cx, cy, cz), top at cy+height, axis +y.
        // S frame: base at c2s(center), axis +z.
        double bx = cx, by = cy, bz = cz;
        c2s_point(bx, by, bz);
        SmBrep* b = nullptr;
        SmApiStatus st = SmApiCreateCone(SmVector3d(bx, by, bz), bottomRadius, topRadius, height, b);
        return (st == SM_SUCCESS && b) ? (void*)b : nullptr;
    } catch (...) { return nullptr; }
}

extern "C" __declspec(dllexport)
void* smmesh_torus(double majorRadius, double minorRadius, double cx, double cy, double cz)
{
    try {
        // Contract: centered at (cx, cy, cz), axis +y.  S frame: axis +z.
        double px = cx, py = cy, pz = cz;
        c2s_point(px, py, pz);
        SmBrep* b = nullptr;
        SmApiStatus st = SmApiCreateTorus(SmVector3d(px, py, pz), majorRadius, minorRadius, b);
        return (st == SM_SUCCESS && b) ? (void*)b : nullptr;
    } catch (...) { return nullptr; }
}

// --------------------------------------------------------------- booleans --

// op: 0=union, 1=difference, 2=intersection.
// On success returns 0: A has become the result (in place), B was deleted by
// the kernel. On failure returns the SM status: both operands stay allocated
// and the caller must free them.
extern "C" __declspec(dllexport)
int smmesh_boolean(void* a, void* b, int op)
{
    try {
        if (!a || !b) return -1;
        SmBrep* result = nullptr;
        SmApiStatus st;
        switch (op)
        {
            case 0:  st = SmApiBooleanUnion       ((SmBrep*)a, (SmBrep*)b, result); break;
            case 1:  st = SmApiBooleanDifference ((SmBrep*)a, (SmBrep*)b, result); break;
            case 2:  st = SmApiBooleanIntersection((SmBrep*)a, (SmBrep*)b, result); break;
            default: return -2;
        }
        if (st != SM_SUCCESS) return (int)st;
        return (result == (SmBrep*)a) ? 0 : -3;   // documented aliasing sanity check
    } catch (...) { return -99; }
}

// ------------------------------------------------------------ tessellation --

extern "C" __declspec(dllexport)
void* smmesh_tessellate(void* brep, double chordTol, double angTolDeg, double maxEdge)
{
    try {
        if (!brep) return nullptr;
        SmPolyBrep* poly = nullptr;
        SmTessellationParams p = make_params(chordTol, angTolDeg, maxEdge);
        SmApiStatus st = SmApiTessellate((SmBrep*)brep, poly, p, FALSE, nullptr, nullptr);
        return (st == SM_SUCCESS && poly) ? (void*)poly : nullptr;
    } catch (...) { return nullptr; }
}

// ------------------------------------------------------------- inspection --

extern "C" __declspec(dllexport)
int smmesh_face_count(void* poly)
{
    try {
        if (!poly) return -1;
        SmTArray<SmPolyFace*> f;
        ((SmPolyBrep*)poly)->GetPolyFaces(f);
        return (int)f.GetSize();
    } catch (...) { return -99; }
}

// ------------------------------------------------------- one-shot extract --

// Flat mesh extraction in contract coordinates, layout mirrors the Python
// binding's MeshArrays:
//   points : nPoints * 3 doubles            (malloc'd by shim)
//   faces  : variable-length run per face:  [vertexCount, v0, v1, ...]
//            (int32 each, malloc'd by shim)
// SEMANTICS WARNING: *outFacesIntCount is the TOTAL number of int32 words
// written to outFaces (the runs are length-prefixed, so it is NOT the number
// of faces) and always equals *outIndexCount; callers must parse the runs to
// count faces. The face count of the polybrep itself is smmesh_face_count().
// Only each face's outer loop is emitted (parity with the official Python
// binding's extract_mesh_arrays); inner loops / holes are dropped -- the
// exact geometry is carried by brepVolume and the analytic face tags.
// Returns 0 on success.
extern "C" __declspec(dllexport)
int smmesh_extract(void* poly,
                   double** outPoints, int* outPointCount,
                   int** outFaces, int* outFacesIntCount, int* outIndexCount)
{
    try {
        if (!poly || !outPoints || !outPointCount || !outFaces || !outFacesIntCount || !outIndexCount)
            return -1;
        *outPoints = nullptr; *outFaces = nullptr;
        *outPointCount = 0; *outFacesIntCount = 0; *outIndexCount = 0;

        SmPolyBrep* pb = (SmPolyBrep*)poly;
        SmTArray<SmPolyVertex*> verts;
        SmTArray<SmPolyFace*> faces;
        pb->GetPolyVertices(verts);
        pb->GetPolyFaces(faces);

        const ULONG nVerts = verts.GetSize();
        const ULONG nFaces = faces.GetSize();

        double* pts = (double*)malloc(sizeof(double) * 3 * (size_t)nVerts);
        if (!pts && nVerts) return -2;

        std::unordered_map<SmPolyVertex*, ULONG> vertIdx;
        vertIdx.reserve(nVerts);
        for (ULONG i = 0; i < nVerts; ++i)
        {
            SmPoint3d p = verts[i]->GetPoint();
            double x = p.x, y = p.y, z = p.z;
            s2c_point(x, y, z);
            pts[i * 3 + 0] = x;
            pts[i * 3 + 1] = y;
            pts[i * 3 + 2] = z;
            vertIdx[verts[i]] = i;
        }

        // first pass: total int count
        ULONG total = 0;
        for (ULONG i = 0; i < nFaces; ++i)
        {
            SmTArray<SmPolyVertex*> ring;
            if (face_vertices(faces[i], ring))
                total += ring.GetSize() + 1;
        }
        int* faceBuf = (int*)malloc(sizeof(int) * (size_t)total);
        if (!faceBuf && total) { free(pts); return -3; }

        int w = 0;
        for (ULONG i = 0; i < nFaces; ++i)
        {
            SmTArray<SmPolyVertex*> ring;
            if (!face_vertices(faces[i], ring)) continue;
            faceBuf[w++] = (int)ring.GetSize();
            for (ULONG j = 0; j < ring.GetSize(); ++j)
            {
                auto it = vertIdx.find(ring[j]);
                if (it == vertIdx.end()) { free(pts); free(faceBuf); return -4; }
                faceBuf[w++] = (int)it->second;
            }
        }

        *outPoints = pts;
        *outPointCount = (int)nVerts;
        *outFaces = faceBuf;
        *outFacesIntCount = w;    // total ints written (runs included) == *outIndexCount
        *outIndexCount = w;
        return 0;
    } catch (...) { return -99; }
}

// ------------------------------------------------- analytic provenance tag --
//
// The heart of P3: trace PolyFace -> SmFace::GetOriginalFace() ->
// SmFace::GetSurface() and read the analytic surface's canonical parameters.
// Everything is returned in contract coordinates (S->C applied here).
//
// Kernel findings baked into this implementation:
//   - Cylinder walls are SmCone surfaces (semiAngle == 0); GetType() usually
//     reports SmCone_TYPE and GetApex() fails -- use GetCanonical + IsCylinder
//     and derive the cone apex analytically (see the branch).
//   - Faces CREATED by a boolean operation have no original face: they get
//     kind 0 (an honest null tag); untouched faces keep their provenance.
//
//   outKind:   0=none/unavailable, 1=plane, 2=cylinder, 3=cone, 4=sphere,
//              5=torus
//   outParams: 12 doubles, laid out per kind (unused slots zeroed):
//     plane    [0..2] point,   [3..5] normal
//     cylinder [0..2] origin,  [3..5] axis,    [6] radius
//     cone     [0..2] apex,    [3..5] axis (apex -> into the band),
//              [6] halfAngle in radians (>= 0)
//     sphere   [0..2] center,  [3] radius
//     torus    [0..2] center,  [3..5] axis,    [6] major, [7] minor
//
// Returns 0 on success (kind may still be 0 = honest degradation),
// negative on caller error.
extern "C" __declspec(dllexport)
int smmesh_face_surface(void* poly, int faceIndex, int* outKind, double* outParams)
{
    try {
        if (!poly || !outKind || !outParams || faceIndex < 0) return -1;
        *outKind = 0;
        for (int i = 0; i < 12; ++i) outParams[i] = 0.0;

        SmTArray<SmPolyFace*> faces;
        ((SmPolyBrep*)poly)->GetPolyFaces(faces);
        if ((ULONG)faceIndex >= faces.GetSize()) return -2;

        SmFace* face = faces[faceIndex]->GetOriginalFace();   // SmPoly.h:1161
        if (!face) return 0;   // tessellation-only / boolean-created face: no tag
        SmSurface* srf = face->GetSurface();                   // SmFace.h:652
        if (!srf) return 0;   // honest degradation

        const SM_TYPE t = srf->GetType();                      // SM_COMMON, exact match

        if (t == SmPlane_TYPE)
        {
            SmPlane* pl = (SmPlane*)srf;
            SmAxis2Placement pos;
            if (pl->GetCanonical(pos) != SM_SUCCESS) return 0;   // honest degradation
            SmPoint3d  o = pos.GetOrigin();
            SmVector3d n = pos.GetZAxis();
            double px = o.x, py = o.y, pz = o.z, nx = n.x, ny = n.y, nz = n.z;
            s2c_point(px, py, pz); s2c_point(nx, ny, nz);
            outParams[0]=px; outParams[1]=py; outParams[2]=pz;
            outParams[3]=nx; outParams[4]=ny; outParams[5]=nz;
            *outKind = 1;
            return 0;
        }
        if (t == SmCone_TYPE || t == SmCylinder_TYPE)
        {
            // NOTE: SMLib represents BOTH cones and cylinders as SmCone surfaces
            // (a cylinder is the semiAngle==0 case -- cylinder walls routinely
            // report SmCone_TYPE from GetType(), and GetApex() errors out on
            // them). Everything is therefore derived from GetCanonical -- the
            // STEP bottom-circle placement, its radius and the signed semi angle:
            //   radius(h) = botR + tan(semi) * h   =>  apex at h = -botR/tan(semi)
            SmCone* co = (SmCone*)srf;
            SmAxis2Placement pos; double botR = 0.0, semiDeg = 0.0;
            if (co->GetCanonical(pos, botR, semiDeg) != SM_SUCCESS) return 0;   // honest degradation
            SmPoint3d  o = pos.GetOrigin();     // bottom-circle center
            SmVector3d z = pos.GetZAxis();      // base -> top direction
            if (co->IsCylinder())
            {
                double ox=o.x, oy=o.y, oz=o.z, ax=z.x, ay=z.y, az=z.z;
                s2c_point(ox, oy, oz); s2c_point(ax, ay, az);
                outParams[0]=ox; outParams[1]=oy; outParams[2]=oz;
                outParams[3]=ax; outParams[4]=ay; outParams[5]=az;
                outParams[6]=botR;              // bot == top radius for a cylinder
                *outKind = 2;
                return 0;
            }
            double semi    = semiDeg * (SM_PI / 180.0);   // signed
            double tanSemi = tan(semi);
            if (fabs(tanSemi) < 1e-12) return 0;          // neither cone nor cylinder
            double hApex = -botR / tanSemi;               // apex height over base center
            SmPoint3d apexP(o.x + z.x * hApex, o.y + z.y * hApex, o.z + z.z * hApex);
            // Contract halfAngle: radial distance grows t*tan(halfAngle) at axial
            // distance t FROM THE APEX; SMLib's signed semi angle loses that
            // sign relation, so take the magnitude.
            double half = fabs(semi);
            // Contract axis: apex -> INTO the band. hApex > 0 puts the apex in
            // +axis direction from the base, so the band lies toward -axis (and
            // vice versa).
            double dir = (hApex >= 0.0) ? -1.0 : 1.0;
            double px = apexP.x, py = apexP.y, pz = apexP.z;
            double ax = z.x * dir, ay = z.y * dir, az = z.z * dir;
            s2c_point(px, py, pz); s2c_point(ax, ay, az);
            outParams[0]=px; outParams[1]=py; outParams[2]=pz;
            outParams[3]=ax; outParams[4]=ay; outParams[5]=az;
            outParams[6]=half;
            *outKind = 3;
            return 0;
        }
        if (t == SmSphere_TYPE)
        {
            SmSphere* sp = (SmSphere*)srf;
            SmAxis2Placement pos; double radius = 0.0;
            if (sp->GetCanonical(pos, radius) != SM_SUCCESS) return 0;   // honest degradation
            SmPoint3d c = pos.GetOrigin();
            double cx=c.x, cy=c.y, cz=c.z;
            s2c_point(cx, cy, cz);
            outParams[0]=cx; outParams[1]=cy; outParams[2]=cz;
            outParams[3]=radius;
            *outKind = 4;
            return 0;
        }
        if (t == SmTorus_TYPE)
        {
            SmTorus* to = (SmTorus*)srf;
            SmAxis2Placement pos; double majR = 0.0, minR = 0.0;
            if (to->GetCanonical(pos, majR, minR) != SM_SUCCESS) return 0;   // honest degradation
            SmPoint3d  c = pos.GetOrigin();
            SmVector3d a = pos.GetZAxis();
            double cx=c.x, cy=c.y, cz=c.z, ax=a.x, ay=a.y, az=a.z;
            s2c_point(cx, cy, cz); s2c_point(ax, ay, az);
            outParams[0]=cx; outParams[1]=cy; outParams[2]=cz;
            outParams[3]=ax; outParams[4]=ay; outParams[5]=az;
            outParams[6]=majR; outParams[7]=minR;
            *outKind = 5;
            return 0;
        }

        return 0;  // analytic type we do not map (e.g. NURBS) -> honest null tag
    } catch (...) { return -99; }
}

// ------------------------------------------------------------------ volume --
// Both volume probes normalize the kernel status to the shim-wide convention
// (0 = success; SM_SUCCESS is 1000 in SMLib's SmMessages.h).

// Exact BRep-level volume (integrated on the exact geometry, independent of
// any tessellation). relAcc: relative accuracy request, e.g. 1e-7.
extern "C" __declspec(dllexport)
int smmesh_brep_volume(void* brep, double relAcc, double* outVol)
{
    try {
        if (!brep || !outVol) return -1;
        SmApiStatus st = SmApiBrepComputeVolume((const SmBrep*)brep, relAcc, *outVol);
        return (st == SM_SUCCESS) ? 0 : (int)st;
    } catch (...) { return -99; }
}

// Volume of the tessellated body (for mesh-quality diagnostics only).
extern "C" __declspec(dllexport)
int smmesh_poly_volume(void* poly, double* outVol)
{
    try {
        if (!poly || !outVol) return -1;
        SmApiStatus st = SmApiPolyBrepComputeVolume((SmPolyBrep*)poly, *outVol);
        return (st == SM_SUCCESS) ? 0 : (int)st;
    } catch (...) { return -99; }
}

// ------------------------------------------------------------- teardown ----
// Best effort by design: an exception during release is swallowed -- there is
// no meaningful error channel on a void teardown, and the process is about to
// drop these objects anyway.

extern "C" __declspec(dllexport)
void smmesh_free_buffer(void* p)
{
    try {
        free(p);  // shim malloc'd buffers; /MD -> ucrtbase free
    } catch (...) {}
}

extern "C" __declspec(dllexport)
void smmesh_free_poly(void* poly)
{
    try {
        if (!poly) return;
        SmPolyBrep* pb = (SmPolyBrep*)poly;
        pb->~SmPolyBrep();  // calls SMLib.dll's exported dtor (??1SmPolyBrep@@UEAA@XZ)
        free(pb);           // ucrtbase free: verified cross-module protocol
    } catch (...) {}
}

extern "C" __declspec(dllexport)
void smmesh_free_brep(void* brep)
{
    try {
        if (!brep) return;
        SmBrep* b = (SmBrep*)brep;
        b->~SmBrep();       // calls SMLib.dll's exported dtor (??1SmBrep@@UEAA@XZ)
        free(b);
    } catch (...) {}
}
