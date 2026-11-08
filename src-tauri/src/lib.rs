mod canvas;
mod commands;
mod error;
mod index;
mod markdown;
mod settings;
mod state;
mod store;
mod vault;
mod watch;

#[cfg(test)]
mod tests_obsidian;

use std::sync::Mutex;

use tauri::Manager;

use settings::Settings;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: launching `brain` again focuses the open window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let settings_file = paths.app_config_dir()?.join("settings.json");
            let state = AppState {
                store: Mutex::new(None),
                settings: Mutex::new(Settings::load(&settings_file)),
                watcher: Mutex::new(None),
                settings_file,
                db_file: paths.app_data_dir()?.join("brain.db"),
                home: paths.home_dir()?,
                open_error: Mutex::new(None),
            };
            commands::open_store(app.handle(), &state);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_graph,
            commands::get_item,
            commands::create_item,
            commands::update_item,
            commands::delete_item,
            commands::list_tags,
            commands::search,
            commands::import_sample,
            commands::rebuild_index,
            commands::vault_info,
            commands::open_vault,
            commands::get_settings,
            commands::save_settings,
            commands::create_canvas,
            commands::get_canvas,
            commands::save_canvas,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::move_item,
            commands::set_folder_color,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
