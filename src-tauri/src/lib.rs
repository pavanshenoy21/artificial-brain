mod ai;
mod capture;
mod commands;
mod embed;
mod enrich;
mod error;
mod github;
mod index;
mod markdown;
mod settings;
mod state;
mod store;
mod vault;
mod watch;

#[cfg(test)]
mod tests_integration;

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use settings::Settings;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second `brain` process hands its args over and exits.
        // `brain --capture` (bound to a GNOME shortcut) opens the capture window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--capture") {
                let _ = capture::show_window(app);
            } else if let Some(w) = app.get_webview_window("main") {
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
            app.manage(embed::EmbedState::default());
            let shortcut = state.settings().shortcuts.capture;
            app.manage(state);

            // Global shortcut for quick capture. Often unavailable on GNOME
            // Wayland: then `brain --capture` is the way (see TODO-PAVVY.md).
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            let _ = capture::show_window(app);
                        }
                    })
                    .build(),
            )?;
            if !shortcut.trim().is_empty() {
                if let Err(e) = app.global_shortcut().register(shortcut.as_str()) {
                    eprintln!("global shortcut {shortcut} unavailable: {e}");
                }
            }
            embed::backfill(app.handle());
            github::auto_sync(app.handle());
            if std::env::args().any(|a| a == "--capture") {
                let _ = capture::show_window(app.handle());
            }
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
            capture::capture,
            capture::refetch_link,
            capture::open_capture,
            capture::hide_capture,
            commands::test_ai,
            commands::test_embed,
            embed::semantic_search,
            embed::embed_status,
            embed::embed_all,
            github::github_sync,
            github::github_status,
            github::github_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
