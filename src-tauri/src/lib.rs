// SceneLab — Tauri 2 native commands
// from /home/yfsama/vector/src-tauri/src/lib.rs (pattern reference)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// How many autosave snapshots to keep before pruning the oldest.
const AUTOSAVE_KEEP: usize = 20;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectFile {
    pub version: String,
    pub name: String,
    pub feature_tree: serde_json::Value,
    pub created: String,
    pub modified: String,
}

#[tauri::command]
fn read_project(path: String) -> Result<ProjectFile, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let project: ProjectFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
fn write_project(path: String, project: ProjectFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_app_dir() -> Result<String, String> {
    let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    Ok(dir.to_string_lossy().to_string())
}

/// Native Save-as: modal save dialog + fs write, so the desktop app writes real
/// files (browsers can only download). Returns the chosen path, or None when
/// the user cancels. Doing both in Rust sidesteps the fs plugin's capability
/// scoping, which would otherwise forbid arbitrary user-chosen paths.
#[tauri::command]
fn save_project_file(
    app: tauri::AppHandle,
    json: String,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("SceneLab project", &["studio3d"])
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Dialog filter for a saved text report: follow the default name's extension
/// (`.json` → "JSON file"), falling back to plain text. Returns
/// (filter name, extensions).
fn report_filter(default_name: &str) -> (&'static str, Vec<&'static str>) {
    let ext = Path::new(default_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("json") => ("JSON file", vec!["json"]),
        Some("log") => ("Log file", vec!["log"]),
        Some("md") => ("Markdown file", vec!["md"]),
        _ => ("Text file", vec!["txt"]),
    }
}

/// Native save for error/diagnostic reports (plain text, JSON, log or
/// markdown — whatever the caller formatted). Mirrors `save_project_file`:
/// modal save dialog + fs write in Rust, so the desktop app writes real
/// files. Returns the chosen path, or None when the user cancels.
#[tauri::command]
fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (filter_name, extensions) = report_filter(&default_name);
    let picked = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(filter_name, &extensions)
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Native Open: modal pick dialog + fs read. Returns (json, file name), or
/// None when the user cancels.
#[tauri::command]
fn open_project_file(app: tauri::AppHandle) -> Result<Option<(String, String)>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("SceneLab project", &["studio3d", "json"])
        .blocking_pick_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    Ok(Some((json, name)))
}

#[tauri::command]
fn autosave_snapshot(data: String) -> Result<String, String> {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("scenelab")
        .join("autosave");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("snapshot_{}.json", chrono_now());
    let path = dir.join(&filename);
    fs::write(&path, data).map_err(|e| e.to_string())?;
    // Keep the snapshot directory bounded so autosave doesn't grow without end.
    let _ = prune_snapshots(&dir, AUTOSAVE_KEEP);
    Ok(path.to_string_lossy().to_string())
}

/// Delete the oldest `snapshot_<nanos>.json` files, keeping the newest `keep`.
fn prune_snapshots(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut snaps: Vec<(u128, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if let Some(num) = path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|n| n.strip_prefix("snapshot_"))
            .and_then(|n| n.strip_suffix(".json"))
            .and_then(|n| n.parse::<u128>().ok())
        {
            snaps.push((num, path));
        }
    }
    if snaps.len() > keep {
        snaps.sort_by_key(|(n, _)| *n);
        let remove = snaps.len() - keep;
        for (_, path) in snaps.into_iter().take(remove) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// Nanoseconds since the Unix epoch, as a string — unique enough that snapshots
/// taken in the same second no longer overwrite one another.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{t}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_project,
            write_project,
            get_app_dir,
            autosave_snapshot,
            save_project_file,
            open_project_file,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_serde_round_trip() {
        let project = ProjectFile {
            version: "1".into(),
            name: "Test Part".into(),
            feature_tree: serde_json::json!({ "features": [{ "id": "f1" }] }),
            created: "2026-01-01".into(),
            modified: "2026-01-02".into(),
        };
        let json = serde_json::to_string(&project).unwrap();
        let back: ProjectFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "Test Part");
        assert_eq!(back.feature_tree["features"][0]["id"], "f1");
    }

    #[test]
    fn write_then_read_project() {
        let path = std::env::temp_dir().join("scenelab_test_project.json");
        let p = path.to_string_lossy().to_string();
        let project = ProjectFile {
            version: "1".into(),
            name: "Saved".into(),
            feature_tree: serde_json::json!({ "a": 42 }),
            created: "c".into(),
            modified: "m".into(),
        };
        write_project(p.clone(), project).unwrap();
        let loaded = read_project(p).unwrap();
        assert_eq!(loaded.name, "Saved");
        assert_eq!(loaded.feature_tree["a"], 42);
    }

    #[test]
    fn read_missing_file_errors() {
        let result = read_project("/no/such/scenelab/file.json".into());
        assert!(result.is_err());
    }

    #[test]
    fn report_filter_follows_extension() {
        assert_eq!(
            report_filter("scenelab-report.json"),
            ("JSON file", vec!["json"])
        );
        assert_eq!(report_filter("error.log"), ("Log file", vec!["log"]));
        assert_eq!(report_filter("notes.MD"), ("Markdown file", vec!["md"]));
    }

    #[test]
    fn report_filter_defaults_to_text() {
        // No extension, or an extension we don't special-case, saves as .txt.
        assert_eq!(
            report_filter("scenelab-diagnostics"),
            ("Text file", vec!["txt"])
        );
        assert_eq!(report_filter("report.txt"), ("Text file", vec!["txt"]));
        assert_eq!(report_filter("weird.xyz"), ("Text file", vec!["txt"]));
    }

    #[test]
    fn prune_snapshots_keeps_newest() {
        let dir = std::env::temp_dir().join(format!("scenelab_prune_{}", chrono_now()));
        fs::create_dir_all(&dir).unwrap();
        // 25 snapshots numbered 0..25, plus an unrelated file that must survive.
        for n in 0..25u128 {
            fs::write(dir.join(format!("snapshot_{n}.json")), "{}").unwrap();
        }
        fs::write(dir.join("keep_me.txt"), "x").unwrap();

        prune_snapshots(&dir, 10).unwrap();

        let mut remaining: Vec<u128> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| {
                let p = e.unwrap().path();
                p.file_name()
                    .and_then(|s| s.to_str())
                    .and_then(|n| n.strip_prefix("snapshot_"))
                    .and_then(|n| n.strip_suffix(".json"))
                    .and_then(|n| n.parse::<u128>().ok())
            })
            .collect();
        remaining.sort_unstable();

        assert_eq!(remaining.len(), 10);
        assert_eq!(remaining, (15..25u128).collect::<Vec<_>>()); // newest kept
        assert!(dir.join("keep_me.txt").exists()); // non-snapshot untouched

        fs::remove_dir_all(&dir).ok();
    }
}
