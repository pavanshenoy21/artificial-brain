//! What happens to an item after it's saved: summary (links), embedding and
//! tag/lobe suggestions. Each step is optional and degrades cleanly when no
//! AI provider / embedding server is configured.

use tauri::{AppHandle, Manager};

use crate::ai::{self, ChatOpts};
use crate::capture::Page;
use crate::error::{err, Result};
use crate::state::AppState;

const SUMMARY_PROMPT: &str = "You summarise web pages for a personal knowledge base. \
Write 2-3 plain sentences saying what the page is and why it's useful. \
Use only facts stated in the page text. Never add facts, opinions or links. \
No preamble, no markdown, no bullet points.";

/// LLM summary of a fetched page; Err when no AI provider is configured
/// (the caller then falls back to the page description).
pub async fn summarize(app: &AppHandle, page: &Page) -> Result<String> {
    let ai = app.state::<AppState>().settings().ai;
    if !ai.enabled() {
        return err("AI off");
    }
    if page.text.trim().is_empty() && page.description.is_none() {
        return err("nothing to summarise");
    }
    let text: String = page.text.chars().take(6000).collect();
    let user = format!(
        "Title: {}\nDescription: {}\n\nPage text:\n{}",
        page.title,
        page.description.clone().unwrap_or_default(),
        text
    );
    let out = ai::chat(&ai, &[("system", SUMMARY_PROMPT), ("user", &user)], ChatOpts { max_tokens: 220, temperature: 0.1 }).await?;
    if out.is_empty() {
        return err("empty summary");
    }
    Ok(out)
}

/// Queues the item for embedding (no-op when embeddings are off).
pub async fn after_save(app: &AppHandle, id: &str) {
    crate::embed::schedule(app, vec![id.to_string()]);
}
