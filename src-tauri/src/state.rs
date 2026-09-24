//! App-wide state held by Tauri: the open store, settings and the watcher.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::{err, Result};
use crate::settings::Settings;
use crate::store::Store;
use crate::watch::Watcher;

pub struct AppState {
    pub store: Mutex<Option<Store>>,
    pub settings: Mutex<Settings>,
    pub watcher: Mutex<Option<Watcher>>,
    pub settings_file: PathBuf,
    pub db_file: PathBuf,
    pub home: PathBuf,
    /// Why the vault failed to open, shown by the UI instead of crashing.
    pub open_error: Mutex<Option<String>>,
}

impl AppState {
    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut guard = self.store.lock().map_err(|_| "store lock poisoned")?;
        match guard.as_mut() {
            Some(s) => f(s),
            None => err(self.open_error.lock().ok().and_then(|e| e.clone()).unwrap_or_else(|| "no vault open".into())),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }
}
