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
