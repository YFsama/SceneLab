// SceneLab — Tauri 2 native commands
// from /home/yfsama/vector/src-tauri/src/lib.rs (pattern reference)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
    Ok(path.to_string_lossy().to_string())
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
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
