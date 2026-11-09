//! Tauri commands. Everything returns `Result<T, String>`; writes emit
//! `vault-changed` so the UI reloads.

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::error::Result;
use crate::index::Hit;
use crate::settings::Settings;
use crate::state::AppState;
use crate::store::{Colors, Graph, Moved, SampleFile, Store, SyncReport};
use crate::vault::Item;
use crate::{gitsync, watch};

type Cmd<T> = std::result::Result<T, String>;

fn run<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> Result<T>) -> Cmd<T> {
    state.with_store(f).map_err(|e| e.to_string())
}

fn changed(app: &AppHandle, kind: &str) {
    let _ = app.emit("vault-changed", serde_json::json!({ "kind": kind }));
}

#[tauri::command]
pub async fn get_graph(state: State<'_, AppState>) -> Cmd<Graph> {
    run(&state, |s| {
        s.sync()?;
        s.graph()
    })
}

#[tauri::command]
pub async fn get_item(state: State<'_, AppState>, id: String) -> Cmd<Option<Item>> {
    run(&state, |s| s.get(&id))
}

/// `input`: `{ title?, body?, folder?, tags?, ...properties }`
#[tauri::command]
pub async fn create_item(app: AppHandle, state: State<'_, AppState>, input: Map<String, Value>) -> Cmd<Item> {
    let item = run(&state, |s| s.create(input))?;
    changed(&app, "items");
    Ok(item)
}

/// `patch`: `{ title?, body?, tags?, property: value | null }`. Returns the
/// item; its id is its new path if the title changed.
#[tauri::command]
pub async fn update_item(app: AppHandle, state: State<'_, AppState>, id: String, patch: Map<String, Value>) -> Cmd<Item> {
    let item = run(&state, |s| s.update(&id, patch))?;
    changed(&app, "items");
    Ok(item)
}

/// Moves the file to `<vault>/.trash`.
#[tauri::command]
pub async fn delete_item(app: AppHandle, state: State<'_, AppState>, id: String) -> Cmd<()> {
    run(&state, |s| s.delete(&id))?;
    changed(&app, "items");
    Ok(())
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Cmd<Vec<(String, i64)>> {
    run(&state, |s| s.tags())
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> Cmd<Vec<Hit>> {
    run(&state, |s| s.search(&query, limit.unwrap_or(20)))
}

#[tauri::command]
pub async fn import_sample(app: AppHandle, state: State<'_, AppState>, files: Vec<SampleFile>) -> Cmd<usize> {
    let n = run(&state, |s| s.import(files))?;
    changed(&app, "items");
    Ok(n)
}

#[tauri::command]
pub async fn rebuild_index(app: AppHandle, state: State<'_, AppState>) -> Cmd<SyncReport> {
    let r = run(&state, |s| s.rebuild())?;
    changed(&app, "items");
    Ok(r)
}

#[derive(Serialize)]
pub struct VaultInfo {
    path: String,
    items: usize,
    error: Option<String>,
}

#[tauri::command]
pub async fn vault_info(state: State<'_, AppState>) -> Cmd<VaultInfo> {
    let error = state.open_error.lock().ok().and_then(|e| e.clone());
    let path = state.settings().vault_dir(&state.home).to_string_lossy().into_owned();
    let items = state.with_store(|s| Ok(s.index.items()?.len())).unwrap_or(0);
    Ok(VaultInfo { path, items, error })
}

/// Opens (or creates) a vault folder and remembers it in settings.
#[tauri::command]
pub async fn open_vault(app: AppHandle, state: State<'_, AppState>, path: String) -> Cmd<VaultInfo> {
    let mut settings = state.settings();
    settings.vault = path;
    settings.save(&state.settings_file).map_err(|e| e.to_string())?;
    *state.settings.lock().map_err(|_| "settings lock poisoned")? = settings;
    open_store(&app, &state);
    changed(&app, "vault");
    vault_info(state).await
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Cmd<Settings> {
    Ok(state.settings())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Cmd<Settings> {
    let old = state.settings();
    settings.save(&state.settings_file).map_err(|e| e.to_string())?;
    *state.settings.lock().map_err(|_| "settings lock poisoned")? = settings.clone();
    if old.vault_dir(&state.home) != settings.vault_dir(&state.home) {
        open_store(&app, &state);
        changed(&app, "vault");
    }
    Ok(settings)
}

/// (Re)opens the store for the vault in settings and restarts the watcher.
/// Failure is kept in `open_error` so the UI can show it.
pub fn open_store(app: &AppHandle, state: &AppState) {
    let dir = state.settings().vault_dir(&state.home);
    if let Ok(mut w) = state.watcher.lock() {
        *w = None; // stop watching the old vault first
    }
    let opened = Store::open(&dir, &state.db_file);
    let (store, error) = match opened {
        Ok(s) => (Some(s), None),
        Err(e) => (None, Some(format!("Couldn't open vault {}: {e}", dir.display()))),
    };
    if let Ok(mut g) = state.store.lock() {
        *g = store;
    }
    if let Ok(mut g) = state.open_error.lock() {
        *g = error;
    }
    if let Ok(mut w) = state.watcher.lock() {
        *w = watch::start(app, &dir);
    }
    // images on canvases are shown straight from the vault (asset protocol)
    use tauri::Manager;
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
        eprintln!("asset scope: {e}");
    }
}

// ---------------------------------------------------------------- canvases

#[tauri::command]
pub async fn create_canvas(app: AppHandle, state: State<'_, AppState>, title: String, folder: Option<String>) -> Cmd<Item> {
    let item = run(&state, |s| s.create_canvas(&title, folder.as_deref()))?;
    changed(&app, "items");
    Ok(item)
}

/// The canvas JSON (JSON Canvas 1.0, as Obsidian writes it).
#[tauri::command]
pub async fn get_canvas(state: State<'_, AppState>, id: String) -> Cmd<Value> {
    run(&state, |s| s.get_canvas(&id))
}

#[tauri::command]
pub async fn save_canvas(app: AppHandle, state: State<'_, AppState>, id: String, data: Value) -> Cmd<Item> {
    let item = run(&state, |s| s.save_canvas(&id, data))?;
    changed(&app, "canvas");
    Ok(item)
}

// ---------------------------------------------------------------- folders (file explorer)

#[tauri::command]
pub async fn create_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Cmd<String> {
    let p = run(&state, |s| s.create_folder(&path))?;
    changed(&app, "folders");
    Ok(p)
}

/// Returns [old path, new path] for every file that moved.
#[tauri::command]
pub async fn rename_folder(app: AppHandle, state: State<'_, AppState>, from: String, to: String) -> Cmd<Moved> {
    let moved = run(&state, |s| s.rename_folder(&from, &to))?;
    changed(&app, "folders");
    Ok(moved)
}

#[tauri::command]
pub async fn delete_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Cmd<()> {
    run(&state, |s| s.delete_folder(&path))?;
    changed(&app, "folders");
    Ok(())
}

#[tauri::command]
pub async fn move_item(app: AppHandle, state: State<'_, AppState>, id: String, folder: String) -> Cmd<Moved> {
    let moved = run(&state, |s| s.move_item(&id, &folder))?;
    changed(&app, "items");
    Ok(moved)
}

/// Sets a folder's colour (`#rrggbb`), or clears it with `null`.
#[tauri::command]
pub async fn set_folder_color(app: AppHandle, state: State<'_, AppState>, folder: String, color: Option<String>) -> Cmd<Colors> {
    let c = run(&state, |s| s.set_color(&folder, color.as_deref()))?;
    changed(&app, "colors");
    Ok(c)
}

// ---------------------------------------------------------------- git backup

#[derive(Serialize)]
pub struct GitStatus {
    enabled: bool,
    repo: gitsync::RepoInfo,
    last: Option<gitsync::Backup>,
}

/// The vault's git setup and how the last backup went.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Cmd<GitStatus> {
    let settings = state.settings();
    let vault = settings.vault_dir(&state.home);
    let repo = tauri::async_runtime::spawn_blocking(move || gitsync::repo_info(&vault)).await.map_err(|e| e.to_string())?;
    Ok(GitStatus { enabled: settings.git_backup, repo, last: gitsync::load_last(&state.backup_file) })
}

/// Commit and push now (the same thing that runs when the app closes).
#[tauri::command]
pub async fn git_backup_now(state: State<'_, AppState>) -> Cmd<gitsync::Backup> {
    let vault = state.settings().vault_dir(&state.home);
    let result = tauri::async_runtime::spawn_blocking(move || gitsync::backup(&vault)).await.map_err(|e| e.to_string())?;
    gitsync::save_last(&state.backup_file, &result);
    Ok(result)
}
