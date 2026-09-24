//! Quick capture: a small always-on-top window (global shortcut, or
//! `brain --capture` for GNOME Wayland) and the background link pipeline:
//! fetch → title + main text → summary → embed → tag/lobe suggestions.
//! A failure never loses the capture: the URL and title stay, status=failed.

use std::time::Duration;

use scraper::{ElementRef, Html, Selector};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::error::{err, Result};
use crate::state::AppState;
use crate::vault::{self, Item};

pub const WINDOW: &str = "capture";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT: usize = 20_000;

// ---------------------------------------------------------------- window

/// Shows the capture window, creating it on first use.
pub fn show_window(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        w.show()?;
        w.set_focus()?;
        let _ = w.emit("capture-shown", ());
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("capture.html".into()))
        .title("Quick capture")
        .inner_size(480.0, 120.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build()?;
    w.set_focus()?;
    Ok(())
}

#[tauri::command]
pub async fn open_capture(app: AppHandle) -> std::result::Result<(), String> {
    show_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_capture(app: AppHandle) -> std::result::Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- capture command

#[derive(Serialize)]
pub struct Captured {
    item: Item,
    /// true when the URL was already saved (nothing new created)
    existing: bool,
}

/// Saves a pasted URL as a link item right away (status pending) and starts
/// the pipeline in the background. Text that isn't a URL becomes a note.
#[tauri::command]
pub async fn capture(app: AppHandle, state: State<'_, AppState>, text: String) -> std::result::Result<Captured, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to save".into());
    }
    let Some(url) = normalize_url(&text) else {
        // plain text: a note in the Inbox (no tags), title = first line
        let (title, body) = split_title(&text);
        let item = state
            .with_store(|s| s.create(obj(json!({ "type": "note", "title": title, "body": body }))))
            .map_err(|e| e.to_string())?;
        let _ = app.emit("vault-changed", json!({ "kind": "items" }));
        return Ok(Captured { item, existing: false });
    };

    let existing = state
        .with_store(|s| Ok(s.index.items()?.into_iter().find(|i| i.fields.get("url").and_then(Value::as_str) == Some(url.as_str()))))
        .map_err(|e| e.to_string())?;
    if let Some(item) = existing {
        return Ok(Captured { item, existing: true });
    }

    let site = host_of(&url);
    let item = state
        .with_store(|s| {
            s.create(obj(json!({
                "type": "link", "title": placeholder_title(&url), "url": url, "site": site, "status": "pending",
            })))
        })
        .map_err(|e| e.to_string())?;
    let _ = app.emit("vault-changed", json!({ "kind": "items" }));
    spawn_pipeline(app.clone(), item.id.clone());
    Ok(Captured { item, existing: false })
}

/// Runs the link pipeline again (e.g. after a failure, or once AI is set up).
#[tauri::command]
pub async fn refetch_link(app: AppHandle, state: State<'_, AppState>, id: String) -> std::result::Result<(), String> {
    state
        .with_store(|s| s.update(&id, obj(json!({ "status": "pending", "error": null }))))
        .map_err(|e| e.to_string())?;
    let _ = app.emit("vault-changed", json!({ "kind": "items" }));
    spawn_pipeline(app, id);
    Ok(())
}

fn spawn_pipeline(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        let result = run_pipeline(&app, &id).await;
        let state = app.state::<AppState>();
        if let Err(e) = result {
            let _ = state.with_store(|s| s.update(&id, obj(json!({ "status": "failed", "error": e.to_string() }))));
        }
        let _ = app.emit("vault-changed", json!({ "kind": "items" }));
        let _ = app.emit("capture-done", json!({ "id": id }));
    });
}

async fn run_pipeline(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let url = state
        .with_store(|s| s.get(id))?
        .and_then(|i| i.fields.get("url").and_then(Value::as_str).map(str::to_string))
        .ok_or("link has no url")?;

    progress(app, id, "fetching");
    let html = fetch(&url).await?;
    let page = extract(&html, &url);

    // Only replace the title if the user hasn't renamed the item meanwhile.
    let current = state.with_store(|s| s.get(id))?.ok_or("item was deleted")?;
    let mut patch = Map::new();
    if current.title == placeholder_title(&url) && !page.title.is_empty() {
        patch.insert("title".into(), page.title.clone().into());
    }
    if let Some(site) = &page.site {
        patch.insert("site".into(), site.clone().into());
    }
    patch.insert("fetched".into(), vault::now().into());

    progress(app, id, "summarising");
    let summary = crate::enrich::summarize(app, &page).await.unwrap_or_else(|_| fallback_summary(&page));
    if !summary.is_empty() {
        patch.insert("summary".into(), summary.into());
    }
    patch.insert("status".into(), "ok".into());
    patch.insert("error".into(), Value::Null);
    state.with_store(|s| s.update(id, patch))?;
    let _ = app.emit("vault-changed", json!({ "kind": "items" }));

    progress(app, id, "embedding");
    crate::enrich::after_save(app, id, Some(&page.text)).await;
    Ok(())
}

fn progress(app: &AppHandle, id: &str, stage: &str) {
    let _ = app.emit("capture-progress", json!({ "id": id, "stage": stage }));
}

async fn fetch(url: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) ArtificialBrain/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(url).send().await.map_err(|e| format!("fetch failed: {e}"))?;
    if !res.status().is_success() {
        return err(format!("fetch failed: HTTP {}", res.status()));
    }
    let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if !ctype.is_empty() && !ctype.contains("html") && !ctype.contains("xml") && !ctype.contains("text/plain") {
        return err(format!("not a web page ({ctype})"));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_BYTES {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ---------------------------------------------------------------- extraction

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub site: Option<String>,
    pub description: Option<String>,
    /// Main readable text (paragraphs, headings, list items), capped.
    pub text: String,
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

fn meta(doc: &Html, keys: &[&str]) -> Option<String> {
    for k in keys {
        for attr in ["property", "name"] {
            let s = sel(&format!(r#"meta[{attr}="{k}"]"#));
            if let Some(v) = doc.select(&s).next().and_then(|e| e.value().attr("content")) {
                let v = clean(v);
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Title, site name, description and the main text of an HTML page.
pub fn extract(html: &str, url: &str) -> Page {
    let doc = Html::parse_document(html);
    let title = meta(&doc, &["og:title", "twitter:title"])
        .or_else(|| doc.select(&sel("title")).next().map(|t| clean(&t.text().collect::<String>())))
        .or_else(|| doc.select(&sel("h1")).next().map(|t| clean(&t.text().collect::<String>())))
        .unwrap_or_default();
    let site = meta(&doc, &["og:site_name", "application-name"]);
    let description = meta(&doc, &["og:description", "description", "twitter:description"]);

    // Prefer <article>, then <main>, then <body>; skip page chrome.
    let root = ["article", "main", "[role=main]", "body"]
        .iter()
        .find_map(|s| doc.select(&sel(s)).next());
    let mut parts: Vec<String> = Vec::new();
    let mut len = 0;
    if let Some(root) = root {
        let blocks = sel("p, h1, h2, h3, h4, li, pre, blockquote");
        for el in root.select(&blocks) {
            if in_chrome(el) {
                continue;
            }
            let t = clean(&el.text().collect::<String>());
            if t.chars().count() < 25 && !el.value().name().starts_with('h') {
                continue; // menu items, buttons, captions
            }
            len += t.len();
            parts.push(t);
            if len > MAX_TEXT {
                break;
            }
        }
    }
    let mut text = parts.join("\n\n");
    if text.len() > MAX_TEXT {
        let cut = (0..=MAX_TEXT).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0);
        text.truncate(cut);
    }
    Page { url: url.to_string(), title: truncate(&title, 200), site, description, text }
}

fn in_chrome(el: ElementRef) -> bool {
    el.ancestors().filter_map(ElementRef::wrap).any(|a| {
        let n = a.value().name();
        matches!(n, "nav" | "footer" | "header" | "aside" | "script" | "style" | "noscript" | "form")
            || a.value().attr("role").is_some_and(|r| r == "navigation")
    })
}

/// Without AI: the page's own description, else its first two sentences.
pub fn fallback_summary(page: &Page) -> String {
    if let Some(d) = &page.description {
        return truncate(d, 400);
    }
    let first: String = page.text.split("\n\n").next().unwrap_or("").to_string();
    let mut out = String::new();
    for (i, s) in first.split_inclusive(['.', '!', '?']).enumerate() {
        out.push_str(s);
        if i == 1 || out.len() > 280 {
            break;
        }
    }
    truncate(out.trim(), 400)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max - 1).collect();
    t.push('…');
    t
}

// ---------------------------------------------------------------- helpers

/// "example.com/x" → "https://example.com/x"; returns None for non-URL text.
pub fn normalize_url(text: &str) -> Option<String> {
    if text.contains(char::is_whitespace) {
        return None;
    }
    let candidate = if text.starts_with("http://") || text.starts_with("https://") {
        text.to_string()
    } else if text.contains('.') && !text.starts_with('.') && !text.contains("://") {
        format!("https://{text}")
    } else {
        return None;
    };
    let u = url::Url::parse(&candidate).ok()?;
    let host = u.host_str()?;
    if !(host.contains('.') || host == "localhost") {
        return None;
    }
    Some(u.to_string())
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_default()
}

/// Title used until the page is fetched: host + path, e.g. "example.com/docs/intro".
pub fn placeholder_title(url: &str) -> String {
    let Ok(u) = url::Url::parse(url) else { return url.to_string() };
    let host = u.host_str().unwrap_or("").trim_start_matches("www.");
    let path = u.path().trim_end_matches('/');
    truncate(&format!("{host}{path}"), 120)
}

fn split_title(text: &str) -> (String, String) {
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("").trim();
    let rest: String = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if first.chars().count() <= 80 {
        (first.to_string(), rest)
    } else {
        (truncate(first, 60), text.to_string())
    }
}

pub fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!doctype html><html><head>
        <title>Fallback title | Site</title>
        <meta property="og:title" content="  JWT   none-alg bypass ">
        <meta property="og:site_name" content="Example Blog">
        <meta name="description" content="How alg=none broke token checks.">
        </head><body>
        <nav><p>Home · About · A long navigation paragraph that should be skipped entirely</p></nav>
        <article><h1>JWT none-alg bypass</h1>
          <p>The server accepted alg=none. That meant anyone could forge a token. Fix it by pinning the algorithm.</p>
          <p>short</p>
          <aside><p>Related posts: a sidebar paragraph that should not be part of the text</p></aside>
          <script>var x = "not text at all, long enough to count";</script>
        </article>
        <footer><p>Copyright notice that is long enough to be a paragraph</p></footer>
        </body></html>"#;

    #[test]
    fn extracts_title_site_description_and_article_text() {
        let p = extract(PAGE, "https://example.com/jwt");
        assert_eq!(p.title, "JWT none-alg bypass");
        assert_eq!(p.site.as_deref(), Some("Example Blog"));
        assert_eq!(p.description.as_deref(), Some("How alg=none broke token checks."));
        assert!(p.text.starts_with("JWT none-alg bypass\n\nThe server accepted"));
        assert!(!p.text.contains("navigation") && !p.text.contains("sidebar") && !p.text.contains("Copyright") && !p.text.contains("short"));
    }

    #[test]
    fn title_falls_back_to_title_tag_then_h1() {
        assert_eq!(extract("<title> A  page </title>", "u").title, "A page");
        assert_eq!(extract("<body><h1>Heading</h1></body>", "u").title, "Heading");
        assert_eq!(extract("", "u").title, "");
    }

    #[test]
    fn fallback_summary_prefers_description_then_sentences() {
        let p = extract(PAGE, "u");
        assert_eq!(fallback_summary(&p), "How alg=none broke token checks.");
        let mut p2 = p.clone();
        p2.description = None;
        p2.text = "One. Two! Three? Four.".into();
        assert_eq!(fallback_summary(&p2), "One. Two!");
    }

    #[test]
    fn urls() {
        assert_eq!(normalize_url("https://x.dev/a").as_deref(), Some("https://x.dev/a"));
        assert_eq!(normalize_url("gtfobins.github.io").as_deref(), Some("https://gtfobins.github.io/"));
        assert_eq!(normalize_url("http://localhost:1420/x").as_deref(), Some("http://localhost:1420/x"));
        assert_eq!(normalize_url("just some words"), None);
        assert_eq!(normalize_url("note.md"), Some("https://note.md/".into()), "ambiguous, but a valid host");
        assert_eq!(normalize_url("ftp://x.dev"), None);
        assert_eq!(normalize_url("hello"), None);
        assert_eq!(placeholder_title("https://www.example.com/docs/intro/"), "example.com/docs/intro");
        assert_eq!(host_of("https://www.example.com/x"), "example.com");
    }

    #[test]
    fn plain_text_becomes_title_and_body() {
        assert_eq!(split_title("Idea\nmore text"), ("Idea".into(), "more text".into()));
        let long = "x".repeat(100);
        let (t, b) = split_title(&long);
        assert!(t.ends_with('…') && b == long);
    }
}
