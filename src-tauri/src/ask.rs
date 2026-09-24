//! Ask: questions answered from the vault (RAG). Retrieval = embeddings when
//! available, else full-text (any word); then 1-hop wikilink neighbours of the
//! best hits. The model must cite [[Title]]s and say when the notes don't cover it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::ai::{self, ChatOpts};
use crate::embed::{self, item_text};
use crate::error::Result;
use crate::markdown as md;
use crate::state::AppState;
use crate::vault::Item;

const TOP_K: usize = 6;
const EXPAND_FROM: usize = 3;
const MAX_ITEMS: usize = 10;
const ITEM_CHARS: usize = 1200;

#[derive(Debug, Deserialize)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Source {
    pub id: String,
    pub title: String,
    /// "match" (retrieved) or "neighbour" (linked from a match)
    pub why: String,
}

#[derive(Debug, Serialize)]
pub struct Answer {
    /// None when AI is off: the UI then shows the sources only.
    pub answer: Option<String>,
    pub sources: Vec<Source>,
    /// Ids of items the answer cites with [[...]].
    pub cited: Vec<String>,
    pub retrieval: String,
}

pub fn system_prompt() -> &'static str {
    "You answer questions using only the user's notes shown below. \
     Cite every note you use inline as [[Exact Title]] (the title after '###'). \
     If the notes don't contain the answer, say that plainly instead of guessing; never add facts from elsewhere. \
     Be brief and concrete. Plain markdown, no headings."
}

pub fn build_context(items: &[Item]) -> String {
    items
        .iter()
        .map(|i| {
            let text: String = item_text(i).chars().take(ITEM_CHARS).collect();
            format!("### {} ({})\n{}", i.title, i.kind, text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// [[links]] in the answer that point at context items (by title, case-insensitive).
pub fn citations(answer: &str, items: &[Item]) -> Vec<String> {
    let by_title: HashMap<String, &str> = items.iter().map(|i| (i.title.to_lowercase(), i.id.as_str())).collect();
    let by_stem: HashMap<String, &str> = items
        .iter()
        .map(|i| (i.path.rsplit('/').next().unwrap_or("").trim_end_matches(".md").to_lowercase(), i.id.as_str()))
        .collect();
    let mut out = Vec::new();
    for t in md::wikilinks(answer) {
        let k = t.to_lowercase();
        if let Some(id) = by_title.get(&k).or_else(|| by_stem.get(&k)) {
            if !out.iter().any(|x: &String| x == id) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// Retrieval: ranked ids, then linked neighbours of the best few.
fn retrieve<R: tauri::Runtime>(app: &AppHandle<R>, ranked: Vec<String>) -> Result<(Vec<Item>, Vec<Source>)> {
    let state = app.state::<AppState>();
    state.with_store(|s| {
        let links = s.index.links()?;
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
        for l in &links {
            adj.entry(l.source.as_str()).or_default().push(l.target.as_str());
            adj.entry(l.target.as_str()).or_default().push(l.source.as_str());
        }
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        let mut sources = Vec::new();
        let mut push = |id: &str, why: &str, items: &mut Vec<Item>, sources: &mut Vec<Source>| -> Result<()> {
            if items.len() >= MAX_ITEMS || !seen.insert(id.to_string()) {
                return Ok(());
            }
            if let Some(it) = s.get(id)? {
                sources.push(Source { id: it.id.clone(), title: it.title.clone(), why: why.into() });
                items.push(it);
            }
            Ok(())
        };
        for id in ranked.iter().take(TOP_K) {
            push(id, "match", &mut items, &mut sources)?;
        }
        for id in ranked.iter().take(EXPAND_FROM) {
            for nb in adj.get(id.as_str()).cloned().unwrap_or_default() {
                push(nb, "neighbour", &mut items, &mut sources)?;
            }
        }
        Ok((items, sources))
    })
}

#[tauri::command]
pub async fn ask(app: AppHandle, question: String, history: Option<Vec<Turn>>) -> std::result::Result<Answer, String> {
    answer(&app, question, history.unwrap_or_default()).await
}

pub async fn answer<R: tauri::Runtime>(app: &AppHandle<R>, question: String, history: Vec<Turn>) -> std::result::Result<Answer, String> {
    let state = app.state::<AppState>();
    let q = question.trim().to_string();
    if q.is_empty() {
        return Err("Ask something first".into());
    }
    let settings = state.settings();

    // 1. rank: embeddings if we have them, else full-text (any word)
    let mut retrieval = "full-text".to_string();
    let mut ranked: Vec<String> = Vec::new();
    if settings.embed.enabled() {
        if let Ok(v) = ai::embed(&settings.embed, &[q.clone()]).await {
            let qv = embed::normalize(v.into_iter().next().unwrap_or_default());
            let vecs = state.with_store(|s| s.index.embeddings(&settings.embed.key())).unwrap_or_default();
            ranked = embed::rank(&qv, &vecs, TOP_K).into_iter().filter(|(_, s)| *s > 0.2).map(|(id, _)| id).collect();
            if !ranked.is_empty() {
                retrieval = "embeddings".into();
            }
        }
    }
    if ranked.is_empty() {
        ranked = state.with_store(|s| s.index.search_any(&q, TOP_K)).map_err(|e| e.to_string())?.into_iter().map(|h| h.id).collect();
    }
    let (items, sources) = retrieve(app, ranked).map_err(|e| e.to_string())?;

    // 2. answer (or just the sources when AI is off)
    if !settings.ai.enabled() {
        return Ok(Answer { answer: None, sources, cited: vec![], retrieval });
    }
    let context = if items.is_empty() { "(no matching notes)".to_string() } else { build_context(&items) };
    let system = format!("{}\n\nNotes:\n\n{context}", system_prompt());
    let mut msgs: Vec<(&str, &str)> = vec![("system", system.as_str())];
    for t in history.iter().rev().take(6).rev() {
        let role = if t.role == "assistant" { "assistant" } else { "user" };
        msgs.push((role, t.content.as_str()));
    }
    msgs.push(("user", q.as_str()));
    let answer = ai::chat(&settings.ai, &msgs, ChatOpts { max_tokens: 700, temperature: 0.2 }).await.map_err(|e| e.to_string())?;
    let cited = citations(&answer, &items);
    Ok(Answer { answer: Some(answer), sources, cited, retrieval })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::parse_item;

    fn item(id: &str, title: &str, body: &str) -> Item {
        let mut i = parse_item(&format!("---\nid: {id}\ntitle: '{title}'\n---\n{body}"), &format!("notes/{title}.md"), title);
        i.path = format!("notes/{}.md", md::file_stem_for(title));
        i
    }

    #[test]
    fn citations_resolve_to_context_items_only() {
        let items = vec![item("a", "Writeup: JWT", "x"), item("b", "Docker", "y")];
        let c = citations("Pin the alg ([[Writeup: JWT]]), see [[docker|containers]] and [[Unknown]]. Also [[Writeup JWT]].", &items);
        assert_eq!(c, vec!["a", "b"]);
    }

    #[test]
    fn context_lists_titles_and_truncates() {
        let long = "word ".repeat(1000);
        let ctx = build_context(&[item("a", "A", &long), item("b", "B", "short")]);
        assert!(ctx.starts_with("### A (note)\n"));
        assert!(ctx.contains("\n\n### B (note)\nB\nshort"));
        assert!(ctx.len() < 1400 + 40);
        assert!(system_prompt().contains("never add facts"));
    }
}
