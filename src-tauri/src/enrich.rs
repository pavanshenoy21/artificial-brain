//! What happens to an item after it's saved: summary (links), embedding and
//! tag/lobe suggestions. Each step is optional and degrades cleanly when no
//! AI provider / embedding server is configured.

use tauri::AppHandle;

use crate::capture::Page;
use crate::error::{err, Result};

/// LLM summary of a fetched page; Err when no AI provider is configured
/// (the caller then falls back to the page description).
pub async fn summarize(_app: &AppHandle, _page: &Page) -> Result<String> {
    err("AI off")
}

/// Embeds the item (if embeddings are configured). `_extra` is text that
/// isn't in the file, e.g. the fetched page for a link.
pub async fn after_save(_app: &AppHandle, _id: &str, _extra: Option<&str>) {}
