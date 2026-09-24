use std::fs;
use tauri::Manager;

/// Returns the user's graph as a JSON string if `graph.json` exists in the
/// app data dir (Linux: ~/.local/share/dev.pavvy.brain/graph.json).
/// The frontend falls back to bundled sample data when this returns None.
#[tauri::command]
fn load_graph(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("graph.json");
    if !file.exists() {
        return Ok(None);
    }
    fs::read_to_string(&file).map(Some).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_graph])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
