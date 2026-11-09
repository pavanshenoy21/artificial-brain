//! `settings.json` in the app config dir (Linux: ~/.config/dev.pavvy.brain/):
//! which vault to open and the theme.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::vault::write_atomic;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Vault folder; empty = default (~/Brain, or $BRAIN_VAULT).
    pub vault: String,
    /// "dark" | "light"
    pub theme: String,
    /// Commit and push the vault with git when the app closes.
    pub git_backup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { vault: String::new(), theme: "dark".into(), git_backup: true }
    }
}

impl Settings {
    /// Unknown keys (from older versions) are ignored.
    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_atomic(file, &(serde_json::to_string_pretty(self)? + "\n"))
    }

    /// The vault to open: settings, then $BRAIN_VAULT, then ~/Brain.
    pub fn vault_dir(&self, home: &Path) -> PathBuf {
        if !self.vault.trim().is_empty() {
            return expand_home(self.vault.trim(), home);
        }
        if let Some(v) = std::env::var_os("BRAIN_VAULT") {
            return PathBuf::from(v);
        }
        home.join("Brain")
    }
}

fn expand_home(p: &str, home: &Path) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if p == "~" => home.to_path_buf(),
        None => PathBuf::from(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_files_still_load() {
        let s: Settings = serde_json::from_str(r#"{"vault":"~/Notes","theme":"light","ai":{"provider":"groq"},"github":{"token":"x"}}"#).unwrap();
        assert_eq!(s, Settings { vault: "~/Notes".into(), theme: "light".into(), git_backup: true });
        assert_eq!(s.vault_dir(Path::new("/home/p")), PathBuf::from("/home/p/Notes"));
        assert_eq!(Settings::default().vault_dir(Path::new("/home/p")).file_name().unwrap(), "Brain");
    }
}
