// SceneLab build script: tauri_build + optional compilation of the SMLib
// C++ shim (vendor/smmesh.cpp) into sm-lib/smmesh.dll.
//
// Never fails the build when the NVIDIA binaries or the MSVC compiler are
// absent: the sm service then reports available:false at runtime and every
// other build product (and `cargo test`'s pure-logic tests) keeps working.
//
// Modes, recorded for the Rust side via cargo:rustc-env=SM_BUILD_MODE:
//   compiled  - sm-lib package present and cl.exe found: vendor/smmesh.cpp is
//               compiled (/MD /std:c++17 /DUNICODE) into sm-lib/smmesh.dll.
//   prebuilt  - no compiler, but sm-lib/smmesh.dll already exists: used as is.
//   disabled  - neither: the app builds fine, sm_* commands degrade at runtime.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    tauri_build::build();
    build_smmesh();
}

fn build_smmesh() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("vendor/smmesh.cpp").display()
    );
    println!("cargo:rerun-if-env-changed=SM_LIB_DIR");

    // Resolve the sm-lib directory: env override first, default next.
    let lib_dir = env::var("SM_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("sm-lib"));

    println!("cargo:rustc-env=SM_LIB_DIR_DEFAULT={}", lib_dir.display());

    let has_kernel =
        lib_dir.join("lib").join("SMLib.dll").is_file() || lib_dir.join("SMLib.dll").is_file();
    let prebuilt_shim = lib_dir.join("smmesh.dll");

    if !has_kernel {
        // No NVIDIA package fetched: build everything else normally.
        println!("cargo:rustc-env=SM_BUILD_MODE=disabled");
        println!(
            "cargo:warning=SMLib package not found under {} -- sm service will be disabled at runtime. Run scripts/fetch-sm-lib.ps1 to enable.",
            lib_dir.display()
        );
        return;
    }

    let shim_dst = prebuilt_shim.clone();
    if let Some(vcvars) = find_vcvars64() {
        // A compile attempt invalidates any previously built dll: delete it
        // first so a broken edit can never silently fall through to the
        // "prebuilt" branch below and keep serving the stale binary.
        let _ = std::fs::remove_file(&shim_dst);
        match compile_shim(&manifest_dir, &lib_dir, &vcvars, &shim_dst) {
            Ok(()) => {
                println!("cargo:rustc-env=SM_BUILD_MODE=compiled");
                return;
            }
            Err(e) => println!("cargo:warning=smmesh.cpp compilation failed: {e}"),
        }
    } else {
        println!("cargo:warning=MSVC cl.exe not found (vswhere) -- skipping smmesh compile");
    }

    if shim_dst.is_file() {
        println!("cargo:rustc-env=SM_BUILD_MODE=prebuilt");
    } else {
        println!("cargo:rustc-env=SM_BUILD_MODE=disabled");
        println!(
            "cargo:warning={} is missing and could not be built -- sm service will be disabled at runtime.",
            shim_dst.display()
        );
    }
}

/// Locate vcvars64.bat through vswhere (VS 2017+ layout, incl. BuildTools).
fn find_vcvars64() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe",
        r"C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe",
    ];
    let vswhere = candidates.iter().map(Path::new).find(|p| p.is_file())?;

    let out = Command::new(vswhere)
        .args([
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let install = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if install.is_empty() {
        return None;
    }
    let vcvars = Path::new(&install).join(r"VC\Auxiliary\Build\vcvars64.bat");
    vcvars.is_file().then_some(vcvars)
}

/// Compile vendor/smmesh.cpp with cl.exe (inside a vcvars environment) and
/// place the resulting smmesh.dll in the sm-lib directory, next to the
/// SMLib/SM_API binaries it loads.
fn compile_shim(
    manifest_dir: &Path,
    lib_dir: &Path,
    vcvars: &Path,
    dst: &Path,
) -> Result<(), String> {
    let src = manifest_dir.join("vendor").join("smmesh.cpp");
    let inc_api = lib_dir.join("include").join("SM_API");
    let inc_sml = lib_dir.join("include").join("SMLib");
    let lib_path = lib_dir.join("lib");
    for p in [&inc_api, &inc_sml] {
        if !p.is_dir() {
            return Err(format!("missing include dir {}", p.display()));
        }
    }
    if !lib_path.join("SMLib.lib").is_file() {
        return Err(format!(
            "missing {} -- malformed sm-lib package",
            lib_path.join("SMLib.lib").display()
        ));
    }

    // cl.exe artifacts (.obj/.exp/.lib) go to a temp dir; only the dll is kept.
    let tmp = dst.parent().unwrap().join(".smmesh-build");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    // Build a small batch file instead of passing the command through
    // Command::args quoting: Rust would escape the inner quotes (\"), which
    // cmd /C does not understand, silently breaking the call. The .bat is
    // quoted once by the shell itself. Paths inside use forward slashes: a
    // trailing backslash before a closing quote (e.g. /Fo"dir\") would
    // escape the quote -- cl accepts / in all positions.
    let fw = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let bat = tmp.join("build_smmesh.bat");
    let mut line = String::new();
    line.push_str("@echo off\r\n");
    line.push_str(&format!("call \"{}\" >nul\r\n", vcvars.display()));
    line.push_str("cl /nologo /MD /O2 /EHsc /W3 /std:c++17 /DUNICODE /D_UNICODE /LD");
    line.push_str(&format!(" \"{}\"", src.display()));
    line.push_str(&format!(" /I\"{}\" /I\"{}\"", fw(&inc_api), fw(&inc_sml)));
    line.push_str(&format!(" /Fo\"{}/\" /Fe\"{}\"", fw(&tmp), fw(dst)));
    line.push_str(&format!(
        " /link /LIBPATH:\"{}\" SMLib.lib SM_API.lib",
        fw(&lib_path)
    ));
    line.push_str("\r\n");
    std::fs::write(&bat, line).map_err(|e| format!("failed to write {}: {e}", bat.display()))?;

    let out = Command::new("cmd")
        .arg("/C")
        .arg(&bat)
        .current_dir(&tmp)
        .output()
        .map_err(|e| format!("failed to spawn cmd: {e}"))?;
    let _ = std::fs::remove_file(&bat);
    if !out.status.success() {
        // cargo:warning swallows newlines -- flatten the log.
        let log = format!(
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .replace("\r\n", " | ")
        .replace('\n', " | ");
        return Err(format!(
            "cl.exe exited with {:?}: {}",
            out.status.code(),
            log
        ));
    }
    if !dst.is_file() {
        return Err(format!(
            "cl.exe reported success but {} is missing",
            dst.display()
        ));
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}
