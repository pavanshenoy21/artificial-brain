mod commands;
mod error;
mod index;
mod markdown;
mod settings;
mod state;
mod store;
mod vault;
mod watch;

use std::sync::Mutex;

use tauri::Manager;

use settings::Settings;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::list_lobes,
            commands::save_lobes,
            commands::vault_info,
            commands::open_vault,
            commands::get_settings,
            commands::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
