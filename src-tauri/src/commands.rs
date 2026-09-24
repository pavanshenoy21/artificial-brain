//! Tauri commands. Everything returns `Result<T, String>`; writes emit
//! `vault-changed` so every window (main, capture) reloads.

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::error::Result;
use crate::index::{Hit, Link};
use crate::settings::Settings;
use crate::state::AppState;
use crate::store::{Graph, Store, SyncReport};
use crate::vault::{Item, Lobe};
use crate::{capture, embed, watch};

type Cmd<T> = std::result::Result<T, String>;

fn run<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> Result<T>) -> Cmd<T> {
    state.with_store(f).map_err(|e| e.to_string())
}

fn changed(app: &AppHandle, kind: &str) {
    let _ = app.emit("vault-changed", serde_json::json!({ "kind": kind }));
}

#[tauri::command]
pub async fn get_graph(app: AppHandle, state: State<'_, AppState>) -> Cmd<Graph> {
    let mut g = run(&state, |s| {
        s.sync()?;
        s.graph()
    })?;
    g.similar = embed::graph_similar(&app, &g.links);
    Ok(g)
}

#[tauri::command]
pub async fn get_item(state: State<'_, AppState>, id: String) -> Cmd<Option<Item>> {
    run(&state, |s| s.get(&id))
}

/// `input`: `{ type, title, lobe?, tags?, body?, ...type-specific fields }`
#[tauri::command]
pub async fn create_item(app: AppHandle, state: State<'_, AppState>, input: Map<String, Value>) -> Cmd<Item> {
    let item = run(&state, |s| s.create(input))?;
    changed(&app, "items");
    embed::schedule(&app, vec![item.id.clone()]);
    Ok(item)
}

/// `patch`: any subset of the create fields; `null` removes a field.
#[tauri::command]
pub async fn update_item(app: AppHandle, state: State<'_, AppState>, id: String, patch: Map<String, Value>) -> Cmd<Item> {
    let item = run(&state, |s| s.update(&id, patch))?;
    changed(&app, "items");
    // a rename rewrites other files too; backfill catches everything stale
    embed::backfill(&app);
    Ok(item)
}

/// Moves the item's file to `<vault>/.trash`.
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
pub async fn import_sample(app: AppHandle, state: State<'_, AppState>, nodes: Vec<Map<String, Value>>, links: Vec<Link>) -> Cmd<usize> {
    let n = run(&state, |s| s.import(nodes, links))?;
    changed(&app, "items");
    embed::backfill(&app);
    Ok(n)
}

#[tauri::command]
pub async fn rebuild_index(app: AppHandle, state: State<'_, AppState>) -> Cmd<SyncReport> {
    let r = run(&state, |s| s.rebuild())?;
    changed(&app, "items");
    embed::backfill(&app);
    Ok(r)
}

#[tauri::command]
pub async fn list_lobes(state: State<'_, AppState>) -> Cmd<Vec<Lobe>> {
    run(&state, |s| s.lobes())
}

#[tauri::command]
pub async fn save_lobes(app: AppHandle, state: State<'_, AppState>, lobes: Vec<Lobe>) -> Cmd<()> {
    run(&state, |s| s.save_lobes(&lobes))?;
    changed(&app, "lobes");
    Ok(())
}

#[derive(Serialize)]
pub struct VaultInfo {
    path: String,
    items: i64,
    error: Option<String>,
}

#[tauri::command]
pub async fn vault_info(state: State<'_, AppState>) -> Cmd<VaultInfo> {
    let error = state.open_error.lock().ok().and_then(|e| e.clone());
    let path = state.settings().vault_dir(&state.home).to_string_lossy().into_owned();
    let items = state.with_store(|s| s.index.count()).unwrap_or(0);
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
    Ok(state.settings().redacted())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Cmd<Settings> {
    let old = state.settings();
    let new = old.merged(settings);
    new.save(&state.settings_file).map_err(|e| e.to_string())?;
    *state.settings.lock().map_err(|_| "settings lock poisoned")? = new.clone();
    if old.vault_dir(&state.home) != new.vault_dir(&state.home) {
        open_store(&app, &state);
        changed(&app, "vault");
    }
    if old.embed != new.embed {
        embed::backfill(&app);
        changed(&app, "similar");
    }
    if old.shortcuts.capture != new.shortcuts.capture {
        capture::register_shortcut(&app, &old.shortcuts.capture, &new.shortcuts.capture);
    }
    let _ = app.emit("settings-changed", new.redacted());
    Ok(new.redacted())
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
}

#[derive(Serialize)]
pub struct TestResult {
    ok: bool,
    message: String,
}

/// Tries the (possibly unsaved) AI settings with a tiny request.
#[tauri::command]
pub async fn test_ai(state: State<'_, AppState>, settings: Settings) -> Cmd<TestResult> {
    let s = state.settings().merged(settings);
    let r = crate::ai::chat(&s.ai, &[("user", "Reply with the single word: ok")], crate::ai::ChatOpts { max_tokens: 5, temperature: 0.0 }).await;
    Ok(match r {
        Ok(answer) => TestResult { ok: true, message: format!("Connected. The model replied: {}", answer.chars().take(40).collect::<String>()) },
        Err(e) => TestResult { ok: false, message: e.to_string() },
    })
}

#[tauri::command]
pub async fn test_embed(state: State<'_, AppState>, settings: Settings) -> Cmd<TestResult> {
    let s = state.settings().merged(settings);
    let r = crate::ai::embed(&s.embed, &["test".to_string()]).await;
    Ok(match r {
        Ok(v) => TestResult { ok: true, message: format!("Connected. Vectors have {} dimensions.", v.first().map(Vec::len).unwrap_or(0)) },
        Err(e) => TestResult { ok: false, message: e.to_string() },
    })
}
