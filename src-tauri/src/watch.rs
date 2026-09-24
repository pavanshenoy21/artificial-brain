//! Watches the vault for edits made outside the app (Obsidian, git, an
//! editor) and re-syncs the index, then tells the UI with `vault-changed`.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub type Watcher = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

pub fn start(app: &AppHandle, root: &Path) -> Option<Watcher> {
    let handle = app.clone();
    let vault_root = root.to_path_buf();
    let debouncer = new_debouncer(Duration::from_millis(400), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let relevant = events.iter().any(|e| {
            let rel = e.path.strip_prefix(&vault_root).unwrap_or(&e.path);
            let s = rel.to_string_lossy();
            let tmp = s.ends_with(".tmp");
            let hidden = rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
            (!hidden && !tmp) || s.ends_with("lobes.json")
        });
        if !relevant {
            return;
        }
        let state = handle.state::<AppState>();
        let changed = state.with_store(|s| s.sync()).map(|r| r.changed()).unwrap_or(false);
        let lobes = events.iter().any(|e| e.path.ends_with("lobes.json"));
        if changed || lobes {
            let _ = handle.emit("vault-changed", serde_json::json!({ "kind": "external" }));
        }
        if changed {
            crate::embed::backfill(&handle);
        }
    });
    match debouncer {
        Ok(mut d) => match d.watcher().watch(root, RecursiveMode::Recursive) {
            Ok(()) => Some(d),
            Err(e) => {
                eprintln!("file watcher unavailable: {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("file watcher unavailable: {e}");
            None
        }
    }
}
