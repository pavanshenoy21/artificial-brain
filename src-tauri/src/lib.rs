mod markdown;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use store::{Graph, Link, Node, Store, SyncReport};
use tauri::{Manager, State};

type Brain = Mutex<Store>;
type CmdResult<T> = Result<T, String>;

fn with<T>(brain: &State<Brain>, f: impl FnOnce(&mut Store) -> store::Result<T>) -> CmdResult<T> {
    let mut s = brain.lock().map_err(|_| "store lock poisoned".to_string())?;
    f(&mut s).map_err(|e| e.to_string())
}

/// Syncs the index with the vault, then returns `{ nodes, links }`.
/// An empty vault gives an empty graph; the frontend shows sample data then.
#[tauri::command]
fn load_graph(brain: State<Brain>) -> CmdResult<Graph> {
    with(&brain, |s| {
        s.sync()?;
        s.graph()
    })
}

#[tauri::command]
fn sync_vault(brain: State<Brain>) -> CmdResult<SyncReport> {
    with(&brain, |s| s.sync())
}

#[tauri::command]
fn get_node(brain: State<Brain>, id: String) -> CmdResult<Option<Node>> {
    with(&brain, |s| s.get(&id))
}

/// `input`: `{ type, title, lobe?, tags?, body?, ...type-specific fields }`
#[tauri::command]
fn create_node(brain: State<Brain>, input: Map<String, Value>) -> CmdResult<Node> {
    with(&brain, |s| s.create(input))
}

/// `patch`: any subset of the create fields; `null` removes a field.
#[tauri::command]
fn update_node(brain: State<Brain>, id: String, patch: Map<String, Value>) -> CmdResult<Node> {
    with(&brain, |s| s.update(&id, patch))
}

/// Moves the node's file to `<vault>/.trash`.
#[tauri::command]
fn delete_node(brain: State<Brain>, id: String) -> CmdResult<()> {
    with(&brain, |s| s.delete(&id))
}

#[tauri::command]
fn list_tags(brain: State<Brain>) -> CmdResult<Vec<(String, i64)>> {
    with(&brain, |s| s.tags())
}

#[tauri::command]
fn import_graph(brain: State<Brain>, nodes: Vec<Map<String, Value>>, links: Vec<Link>) -> CmdResult<usize> {
    with(&brain, |s| s.import(nodes, links))
}

#[tauri::command]
fn vault_path(brain: State<Brain>) -> CmdResult<String> {
    with(&brain, |s| Ok(s.vault().to_string_lossy().into_owned()))
}

/// Vault: $BRAIN_VAULT if set, else <app data>/vault
/// (Linux: ~/.local/share/dev.pavvy.brain/vault). The index lives next to it
/// in <app data>/brain.db.
fn open_store(app: &tauri::AppHandle) -> Result<Store, Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    let vault = std::env::var_os("BRAIN_VAULT")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("vault"));
    Ok(Store::open(vault, &data.join("brain.db"))?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store = open_store(app.handle())?;
            app.manage(Mutex::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_graph,
            sync_vault,
            get_node,
            create_node,
            update_node,
            delete_node,
            list_tags,
            import_graph,
            vault_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
