//! `settings.json` in the app config dir (Linux: ~/.config/dev.pavvy.brain/).
//! It can hold secrets (API keys, GitHub token), so it is written with 0600
//! permissions and never logged.

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
    pub ai: AiSettings,
    pub embed: EmbedSettings,
    pub github: GithubSettings,
    pub shortcuts: Shortcuts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct AiSettings {
    /// "" (off) | "llama" | "groq" | "custom" — all OpenAI-compatible.
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct EmbedSettings {
    /// OpenAI-compatible embeddings endpoint (local llama.cpp server); "" = off.
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct GithubSettings {
    pub token: String,
    pub auto_sync: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Shortcuts {
    pub capture: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Shortcuts { capture: "CommandOrControl+Shift+Space".into() }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            vault: String::new(),
            theme: "dark".into(),
            ai: AiSettings::default(),
            embed: EmbedSettings::default(),
            github: GithubSettings { token: String::new(), auto_sync: true },
            shortcuts: Shortcuts::default(),
        }
    }
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_atomic(file, &(serde_json::to_string_pretty(self)? + "\n"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
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

    /// Copy safe to hand to the UI: secrets are replaced by a marker so they
    /// never travel back unless the user types a new one.
    pub fn redacted(&self) -> Settings {
        let mut s = self.clone();
        for secret in [&mut s.ai.api_key, &mut s.github.token] {
            if !secret.is_empty() {
                *secret = SECRET_MARK.into();
            }
        }
        s
    }

    /// Merges settings from the UI; a secret still equal to the marker keeps its old value.
    pub fn merged(&self, mut incoming: Settings) -> Settings {
        if incoming.ai.api_key == SECRET_MARK {
            incoming.ai.api_key = self.ai.api_key.clone();
        }
        if incoming.github.token == SECRET_MARK {
            incoming.github.token = self.github.token.clone();
        }
        incoming
    }
}

pub const SECRET_MARK: &str = "__saved__";

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
    fn secrets_are_redacted_and_kept() {
        let mut s = Settings::default();
        s.ai.api_key = "sk-real".into();
        let r = s.redacted();
        assert_eq!(r.ai.api_key, SECRET_MARK);
        assert_eq!(r.github.token, "", "empty stays empty");
        let m = s.merged(r);
        assert_eq!(m.ai.api_key, "sk-real");
    }

    #[test]
    fn file_round_trip_and_permissions() {
        let dir = std::env::temp_dir().join(format!("brain-settings-{}", crate::vault::new_id()));
        let f = dir.join("settings.json");
        let s = Settings { vault: "~/Notes".into(), ..Default::default() };
        s.save(&f).unwrap();
        assert_eq!(Settings::load(&f), s);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(s.vault_dir(Path::new("/home/p")), PathBuf::from("/home/p/Notes"));
        assert_eq!(Settings::load(&dir.join("missing.json")), Settings::default());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
