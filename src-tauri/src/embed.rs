//! Embeddings: one vector per item (from the local llama.cpp server), kept in
//! the index. Used for "similar" links in the graph and semantic search.
//! A background worker embeds new/changed items in batches; unchanged items
//! are skipped by hashing the embedded text.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::ai;
use crate::error::Result;
use crate::index::Link;
use crate::state::AppState;
use crate::vault::Item;

const BATCH: usize = 16;
const MAX_CHARS: usize = 4000;
/// Neighbours kept per item before filtering out explicit links.
const CANDIDATES: usize = 8;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct EmbedStatus {
    /// "off" | "idle" | "working" | "error"
    pub state: String,
    pub done: usize,
    pub total: usize,
    pub message: String,
}

/// id -> nearest neighbours (id, cosine), best first.
type Neighbours = HashMap<String, Vec<(String, f32)>>;

#[derive(Default)]
pub struct EmbedState {
    queue: Mutex<Vec<String>>,
    running: AtomicBool,
    status: Mutex<EmbedStatus>,
    /// (signature of stored vectors, id -> nearest neighbours)
    cache: Mutex<Option<(u64, Neighbours)>>,
}

// ---------------------------------------------------------------- pure helpers

/// The text that represents an item: title, tags, summary-ish fields, body.
pub fn item_text(item: &Item) -> String {
    let mut parts = vec![item.title.clone()];
    let tags = item.all_tags();
    if !tags.is_empty() {
        parts.push(tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    for k in ["summary", "description", "built", "role", "level", "site"] {
        if let Some(Value::String(s)) = item.fields.get(k) {
            parts.push(s.clone());
        }
    }
    for k in ["stack", "languages", "topics"] {
        if let Some(Value::Array(a)) = item.fields.get(k) {
            parts.push(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
        }
    }
    parts.push(item.body.clone());
    let text = parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n");
    text.chars().take(MAX_CHARS).collect()
}

/// FNV-1a 64-bit, hex. Enough to notice that an item's text changed.
pub fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

/// Cosine similarity of two normalised vectors.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Top `limit` items by similarity to `q` (normalised), best first.
pub fn rank(q: &[f32], vecs: &[(String, Vec<f32>)], limit: usize) -> Vec<(String, f32)> {
    let mut scored: Vec<(String, f32)> = vecs.iter().filter(|(_, v)| v.len() == q.len()).map(|(id, v)| (id.clone(), dot(q, v))).collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored.truncate(limit);
    scored
}

/// Nearest neighbours of every item (brute force, fine at personal scale).
pub fn neighbours(vecs: &[(String, Vec<f32>)], keep: usize) -> Neighbours {
    let mut out: Neighbours = HashMap::new();
    for (i, (a, va)) in vecs.iter().enumerate() {
        for (b, vb) in &vecs[i + 1..] {
            if va.len() != vb.len() {
                continue;
            }
            let s = dot(va, vb);
            out.entry(a.clone()).or_default().push((b.clone(), s));
            out.entry(b.clone()).or_default().push((a.clone(), s));
        }
    }
    for list in out.values_mut() {
        list.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
        list.truncate(keep);
    }
    out
}

/// "Similar" links: each item's top_k neighbours above min_score that aren't
/// already linked explicitly (either direction). Undirected, deduplicated.
pub fn similar_links(nb: &Neighbours, explicit: &[Link], top_k: usize, min_score: f32) -> Vec<Link> {
    let linked: HashSet<(&str, &str)> = explicit
        .iter()
        .flat_map(|l| [(l.source.as_str(), l.target.as_str()), (l.target.as_str(), l.source.as_str())])
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut ids: Vec<&String> = nb.keys().collect();
    ids.sort();
    for a in ids {
        for (b, _) in nb[a].iter().filter(|(b, s)| *s >= min_score && !linked.contains(&(a.as_str(), b.as_str()))).take(top_k) {
            let key = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
            if seen.insert(key) {
                out.push(Link { source: a.clone(), target: b.clone(), kind: "similar".into() });
            }
        }
    }
    out
}

// ---------------------------------------------------------------- app side

fn set_status<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut EmbedStatus)) {
    let es = app.state::<EmbedState>();
    let snapshot = {
        let Ok(mut st) = es.status.lock() else { return };
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("embed-status", snapshot);
}

/// Queue items for embedding (debounced; a worker drains the queue).
pub fn schedule<R: Runtime>(app: &AppHandle<R>, ids: Vec<String>) {
    let settings = app.state::<AppState>().settings();
    if !settings.embed.enabled() || ids.is_empty() {
        return;
    }
    let es = app.state::<EmbedState>();
    if let Ok(mut q) = es.queue.lock() {
        for id in ids {
            if !q.contains(&id) {
                q.push(id);
            }
        }
    }
    if !es.running.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(worker(app));
    }
}

/// Queue every item whose embedding is missing or stale.
pub fn backfill<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let cfg = state.settings().embed;
    if !cfg.enabled() {
        set_status(app, |s| *s = EmbedStatus { state: "off".into(), ..Default::default() });
        return;
    }
    let stale = state.with_store(|s| {
        let hashes = s.index.embedding_hashes(&cfg.key())?;
        Ok(s.index.items()?.into_iter().filter(|i| hashes.get(&i.id) != Some(&hash(&item_text(i)))).map(|i| i.id).collect::<Vec<_>>())
    });
    match stale {
        Ok(ids) if ids.is_empty() => set_status(app, |s| {
            s.state = "idle".into();
            s.message.clear();
        }),
        Ok(ids) => schedule(app, ids),
        Err(_) => {}
    }
}

// Boxed so the worker can respawn itself (a recursive async fn can't prove it's Send).
fn worker<R: Runtime>(app: AppHandle<R>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
    tokio::time::sleep(Duration::from_millis(1200)).await; // debounce bursts of saves
    let es = app.state::<EmbedState>();
    let total = es.queue.lock().map(|q| q.len()).unwrap_or(0);
    let mut done = 0;
    let mut stored = 0;
    set_status(&app, |s| *s = EmbedStatus { state: "working".into(), done: 0, total, message: String::new() });
    loop {
        let batch: Vec<String> = match es.queue.lock() {
            Ok(mut q) => {
                let n = q.len().min(BATCH);
                q.drain(..n).collect()
            }
            Err(_) => break,
        };
        if batch.is_empty() {
            break;
        }
        match embed_batch(&app, &batch).await {
            Ok(n) => {
                stored += n;
                done += batch.len();
                let total = done + es.queue.lock().map(|q| q.len()).unwrap_or(0);
                set_status(&app, |s| {
                    s.done = done;
                    s.total = total;
                });
            }
            Err(e) => {
                if let Ok(mut q) = es.queue.lock() {
                    q.clear();
                }
                set_status(&app, |s| {
                    s.state = "error".into();
                    s.message = e.to_string();
                });
                es.running.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
    es.running.store(false, Ordering::SeqCst);
    set_status(&app, |s| {
        s.state = "idle".into();
        s.message.clear();
    });
    if stored > 0 {
        if let Ok(mut c) = es.cache.lock() {
            *c = None;
        }
        let _ = app.emit("vault-changed", json!({ "kind": "similar" }));
    }
    // something arrived after the last drain: go again
    if es.queue.lock().map(|q| !q.is_empty()).unwrap_or(false) && !es.running.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(worker(app));
    }
    })
}

/// Embeds the given ids whose text changed. Returns how many were stored.
async fn embed_batch<R: Runtime>(app: &AppHandle<R>, ids: &[String]) -> Result<usize> {
    let state = app.state::<AppState>();
    let cfg = state.settings().embed;
    let model = cfg.key();
    let todo: Vec<(String, String, String)> = state.with_store(|s| {
        let hashes = s.index.embedding_hashes(&model)?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(item) = s.get(id)? {
                let text = item_text(&item);
                let h = hash(&text);
                if hashes.get(id) != Some(&h) {
                    out.push((id.clone(), text, h));
                }
            }
        }
        Ok(out)
    })?;
    if todo.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = todo.iter().map(|(_, t, _)| t.clone()).collect();
    let vecs = ai::embed(&cfg, &texts).await?;
    state.with_store(|s| {
        for ((id, _, h), v) in todo.iter().zip(vecs) {
            s.index.set_embedding(id, &model, h, &normalize(v))?;
        }
        Ok(())
    })?;
    Ok(todo.len())
}

/// Similar links for the graph, or None when embeddings are off / empty
/// (the UI then falls back to shared tags).
pub fn graph_similar<R: Runtime>(app: &AppHandle<R>, explicit: &[Link]) -> Option<Vec<Link>> {
    let state = app.state::<AppState>();
    let cfg = state.settings().embed;
    if !cfg.enabled() {
        return None;
    }
    let vecs = state.with_store(|s| s.index.embeddings(&cfg.key())).ok()?;
    if vecs.len() < 2 {
        return None;
    }
    let sig = hash(&vecs.iter().map(|(id, v)| format!("{id}:{}", v.first().copied().unwrap_or(0.0))).collect::<String>());
    let sig = u64::from_str_radix(&sig, 16).unwrap_or(0);
    let es = app.state::<EmbedState>();
    let mut cache = es.cache.lock().ok()?;
    if cache.as_ref().map(|(s, _)| *s) != Some(sig) {
        *cache = Some((sig, neighbours(&vecs, CANDIDATES)));
    }
    let nb = &cache.as_ref()?.1;
    Some(similar_links(nb, explicit, cfg.top_k.max(1), cfg.min_score))
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct SemanticHit {
    id: String,
    score: f32,
}

/// Embeds the query and ranks items by cosine similarity.
#[tauri::command]
pub async fn semantic_search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> std::result::Result<Vec<SemanticHit>, String> {
    let cfg = state.settings().embed;
    if !cfg.enabled() || query.trim().is_empty() {
        return Ok(vec![]);
    }
    let q = ai::embed(&cfg, &[query]).await.map_err(|e| e.to_string())?;
    let q = normalize(q.into_iter().next().unwrap_or_default());
    let vecs = state.with_store(|s| s.index.embeddings(&cfg.key())).map_err(|e| e.to_string())?;
    Ok(rank(&q, &vecs, limit.unwrap_or(20)).into_iter().map(|(id, score)| SemanticHit { id, score }).collect())
}

#[tauri::command]
pub async fn embed_status(app: AppHandle, state: State<'_, EmbedState>) -> std::result::Result<EmbedStatus, String> {
    let st = state.status.lock().map(|s| s.clone()).unwrap_or_default();
    if st.state.is_empty() {
        let on = app.state::<AppState>().settings().embed.enabled();
        return Ok(EmbedStatus { state: if on { "idle" } else { "off" }.into(), ..Default::default() });
    }
    Ok(st)
}

#[tauri::command]
pub async fn embed_all(app: AppHandle) -> std::result::Result<(), String> {
    backfill(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(x: &[f32]) -> Vec<f32> {
        normalize(x.to_vec())
    }

    #[test]
    fn cosine_ranking() {
        let vecs = vec![("a".to_string(), v(&[1.0, 0.0])), ("b".to_string(), v(&[0.7, 0.7])), ("c".to_string(), v(&[0.0, 1.0]))];
        let r = rank(&v(&[1.0, 0.1]), &vecs, 2);
        assert_eq!(r.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert!((dot(&v(&[3.0, 4.0]), &v(&[3.0, 4.0])) - 1.0).abs() < 1e-6);
        assert!(rank(&v(&[1.0, 0.0, 0.0]), &vecs, 5).is_empty(), "dimension mismatch is skipped");
    }

    #[test]
    fn similar_links_skip_explicit_and_weak_pairs() {
        let vecs = vec![
            ("a".to_string(), v(&[1.0, 0.0, 0.0])),
            ("b".to_string(), v(&[0.9, 0.1, 0.0])),
            ("c".to_string(), v(&[0.8, 0.2, 0.0])),
            ("d".to_string(), v(&[0.0, 0.0, 1.0])),
        ];
        let nb = neighbours(&vecs, 8);
        let explicit = vec![Link { source: "b".into(), target: "a".into(), kind: "explicit".into() }];
        let links = similar_links(&nb, &explicit, 3, 0.5);
        let pairs: Vec<_> = links.iter().map(|l| (l.source.as_str(), l.target.as_str())).collect();
        assert_eq!(pairs, vec![("a", "c"), ("b", "c")], "a-b already linked, d too far");
        assert!(links.iter().all(|l| l.kind == "similar"));
    }

    #[test]
    fn item_text_and_hash() {
        let mut fields = serde_json::Map::new();
        fields.insert("summary".into(), json!("A summary"));
        fields.insert("stack".into(), json!(["Rust", "JS"]));
        let item = Item {
            id: "x".into(), kind: "link".into(), lobe: None, title: "Title".into(), tags: vec!["t".into()], inline_tags: vec![],
            body: "Body".into(), path: "links/Title.md".into(), created: None, updated: None, fields,
        };
        assert_eq!(item_text(&item), "Title\n#t\nA summary\nRust, JS\nBody");
        assert_eq!(hash("abc"), hash("abc"));
        assert_ne!(hash("abc"), hash("abd"));
        assert_eq!(hash(""), "cbf29ce484222325");
    }
}
