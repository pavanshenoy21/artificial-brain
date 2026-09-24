//! GitHub sync: repos → project items, with a fine-grained read-only token.
//! GitHub-owned fields (repo, description, languages, topics, stars,
//! pushed_at) are overwritten on every sync; the title, body, status, role,
//! lobe and tags are the user's and are never touched after creation.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{err, Result};
use crate::state::AppState;
use crate::store::Store;
use crate::vault::Item;

pub const API: &str = "https://api.github.com";
const META_LAST: &str = "github.last_sync";
const README_CHARS: usize = 3000;

#[derive(Debug, Clone, PartialEq)]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    pub html_url: String,
    pub description: Option<String>,
    pub topics: Vec<String>,
    pub stars: i64,
    pub pushed_at: Option<String>,
    pub fork: bool,
    pub archived: bool,
    pub languages: Vec<String>,
    pub readme: Option<String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct SyncResult {
    pub total: usize,
    pub created: usize,
    pub updated: usize,
    pub last_sync: String,
}

// ---------------------------------------------------------------- HTTP

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("ArtificialBrain/0.1 (+https://github.com)")
        .build()
        .map_err(|e| e.to_string().into())
}

async fn get(c: &reqwest::Client, url: &str, token: &str, accept: &str) -> Result<reqwest::Response> {
    let res = c
        .get(url)
        .bearer_auth(token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| if e.is_connect() { "can't reach GitHub".to_string() } else { e.to_string() })?;
    let status = res.status();
    if status.as_u16() == 401 {
        return err("GitHub rejected the token (401). Check it in Settings.");
    }
    if status.as_u16() == 403 && res.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0") {
        return err("GitHub rate limit reached; try again later.");
    }
    Ok(res)
}

async fn get_json(c: &reqwest::Client, url: &str, token: &str) -> Result<Value> {
    let res = get(c, url, token, "application/vnd.github+json").await?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| format!("bad GitHub response: {e}"))?;
    if !status.is_success() {
        let msg = v.get("message").and_then(Value::as_str).unwrap_or("error");
        return err(format!("GitHub: HTTP {status}: {msg}"));
    }
    Ok(v)
}

/// The token's user login (for "Test token").
pub async fn whoami(api: &str, token: &str) -> Result<String> {
    let v = get_json(&client()?, &format!("{api}/user"), token).await?;
    Ok(v.get("login").and_then(Value::as_str).unwrap_or("?").to_string())
}

/// All repos the token can see, with languages and README.
pub async fn fetch_repos(api: &str, token: &str, mut progress: impl FnMut(usize, usize)) -> Result<Vec<Repo>> {
    let c = client()?;
    let mut raw = Vec::new();
    for page in 1..=20 {
        let v = get_json(&c, &format!("{api}/user/repos?per_page=100&page={page}&sort=pushed&affiliation=owner,collaborator"), token).await?;
        let arr = v.as_array().cloned().unwrap_or_default();
        let n = arr.len();
        raw.extend(arr);
        if n < 100 {
            break;
        }
    }
    let total = raw.len();
    let mut out = Vec::new();
    for (i, r) in raw.iter().enumerate() {
        let mut repo = parse_repo(r);
        // languages: {"Rust": 12345, "JavaScript": 999} → by bytes, descending
        if let Ok(v) = get_json(&c, &format!("{api}/repos/{}/languages", repo.full_name), token).await {
            let mut langs: Vec<(String, i64)> = v.as_object().map(|o| o.iter().map(|(k, n)| (k.clone(), n.as_i64().unwrap_or(0))).collect()).unwrap_or_default();
            langs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            repo.languages = langs.into_iter().map(|(k, _)| k).collect();
        }
        if let Ok(res) = get(&c, &format!("{api}/repos/{}/readme", repo.full_name), token, "application/vnd.github.raw+json").await {
            if res.status().is_success() {
                repo.readme = res.text().await.ok().map(|t| t.chars().take(README_CHARS).collect());
            }
        }
        progress(i + 1, total);
        out.push(repo);
    }
    Ok(out)
}

pub fn parse_repo(v: &Value) -> Repo {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Repo {
        full_name: s("full_name").unwrap_or_default(),
        name: s("name").unwrap_or_default(),
        html_url: s("html_url").unwrap_or_default(),
        description: s("description").filter(|d| !d.trim().is_empty()),
        topics: v.get("topics").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
        stars: v.get("stargazers_count").and_then(Value::as_i64).unwrap_or(0),
        pushed_at: s("pushed_at"),
        fork: v.get("fork").and_then(Value::as_bool).unwrap_or(false),
        archived: v.get("archived").and_then(Value::as_bool).unwrap_or(false),
        languages: vec![],
        readme: None,
    }
}

// ---------------------------------------------------------------- merge

/// GitHub-owned fields, overwritten on each sync.
pub fn github_fields(r: &Repo) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("repo".into(), r.html_url.clone().into());
    m.insert("description".into(), r.description.clone().map(Value::from).unwrap_or(Value::Null));
    m.insert("languages".into(), json!(r.languages));
    m.insert("topics".into(), json!(r.topics));
    m.insert("stars".into(), r.stars.into());
    m.insert("pushed_at".into(), r.pushed_at.clone().map(Value::from).unwrap_or(Value::Null));
    m
}

fn norm_repo(s: &str) -> String {
    s.trim().trim_end_matches('/').trim_end_matches(".git").trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("github.com/").to_lowercase()
}

/// The project item already tracking this repo (by `repo:` URL or owner/name).
pub fn find_project<'a>(items: &'a [Item], r: &Repo) -> Option<&'a Item> {
    let want = [norm_repo(&r.html_url), r.full_name.to_lowercase()];
    items.iter().filter(|i| i.kind == "project").find(|i| {
        i.fields.get("repo").and_then(Value::as_str).map(norm_repo).is_some_and(|have| want.contains(&have))
    })
}

/// Creates or updates project items. Forks are skipped unless already tracked.
pub fn apply(store: &mut Store, repos: &[Repo]) -> Result<SyncResult> {
    let mut res = SyncResult { total: repos.len(), ..Default::default() };
    for r in repos {
        let items = store.index.items()?;
        match find_project(&items, r) {
            Some(existing) => {
                let patch = github_fields(r);
                let unchanged = patch.iter().all(|(k, v)| existing.fields.get(k).unwrap_or(&Value::Null) == v);
                if !unchanged {
                    store.update(&existing.id, patch)?;
                    res.updated += 1;
                }
            }
            None if r.fork => {}
            None => {
                let mut input = github_fields(r);
                input.insert("type".into(), "project".into());
                input.insert("title".into(), r.name.clone().into());
                input.insert("status".into(), if r.archived { "archived" } else { "active" }.into());
                if let Some(readme) = &r.readme {
                    // only at creation: the body belongs to the user afterwards
                    input.insert("body".into(), format!("## README (from GitHub)\n\n{}", readme.trim()).into());
                }
                store.create(input)?;
                res.created += 1;
            }
        }
    }
    res.last_sync = crate::vault::now();
    store.index.set_meta(META_LAST, &res.last_sync)?;
    Ok(res)
}

// ---------------------------------------------------------------- commands

pub async fn sync<R: Runtime>(app: &AppHandle<R>, api: &str) -> Result<SyncResult> {
    let state = app.state::<AppState>();
    let token = state.settings().github.token;
    if token.trim().is_empty() {
        return err("No GitHub token. Add one in Settings.");
    }
    let handle = app.clone();
    let repos = fetch_repos(api, &token, move |done, total| {
        let _ = handle.emit("github-progress", json!({ "done": done, "total": total }));
    })
    .await?;
    let res = state.with_store(|s| apply(s, &repos))?;
    let _ = app.emit("vault-changed", json!({ "kind": "items" }));
    crate::embed::backfill(app);
    Ok(res)
}

#[tauri::command]
pub async fn github_sync(app: AppHandle) -> std::result::Result<SyncResult, String> {
    sync(&app, API).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GithubStatus {
    configured: bool,
    last_sync: Option<String>,
}

#[tauri::command]
pub async fn github_status(state: State<'_, AppState>) -> std::result::Result<GithubStatus, String> {
    let configured = !state.settings().github.token.trim().is_empty();
    let last_sync = state.with_store(|s| s.index.meta(META_LAST)).unwrap_or(None);
    Ok(GithubStatus { configured, last_sync })
}

#[tauri::command]
pub async fn github_test(state: State<'_, AppState>, settings: crate::settings::Settings) -> std::result::Result<crate::commands::TestResult, String> {
    let s = state.settings().merged(settings);
    Ok(match whoami(API, &s.github.token).await {
        Ok(login) => crate::commands::TestResult::new(true, format!("Token works: signed in as {login}.")),
        Err(e) => crate::commands::TestResult::new(false, e.to_string()),
    })
}

/// On startup: sync if enabled and the last sync is more than 24h old.
pub fn auto_sync<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let s = state.settings();
    if !s.github.auto_sync || s.github.token.trim().is_empty() {
        return;
    }
    let last = state.with_store(|st| st.index.meta(META_LAST)).ok().flatten();
    let stale = last
        .and_then(|l| chrono::DateTime::parse_from_str(&l, "%Y-%m-%dT%H:%M:%S%:z").ok())
        .is_none_or(|t| chrono::Local::now().signed_duration_since(t) > chrono::Duration::hours(24));
    if stale {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = sync(&app, API).await {
                let _ = app.emit("github-error", e.to_string());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str) -> Repo {
        Repo {
            full_name: format!("pavvy/{name}"),
            name: name.into(),
            html_url: format!("https://github.com/pavvy/{name}"),
            description: Some("A thing".into()),
            topics: vec!["ctf".into()],
            stars: 3,
            pushed_at: Some("2026-09-01T10:00:00Z".into()),
            fork: false,
            archived: false,
            languages: vec!["Rust".into()],
            readme: Some("# Hello".into()),
        }
    }

    #[test]
    fn parses_repo_json() {
        let v = json!({ "full_name": "a/b", "name": "b", "html_url": "https://github.com/a/b", "description": "",
            "topics": ["x"], "stargazers_count": 7, "pushed_at": "2026-01-01T00:00:00Z", "fork": true });
        let r = parse_repo(&v);
        assert_eq!((r.full_name.as_str(), r.stars, r.fork, r.description), ("a/b", 7, true, None));
        assert_eq!(r.topics, vec!["x"]);
    }

    #[test]
    fn repo_urls_match_loosely() {
        assert_eq!(norm_repo("https://github.com/Pavvy/Hackemon.git/"), "pavvy/hackemon");
        assert_eq!(norm_repo("github.com/pavvy/hackemon"), "pavvy/hackemon");
    }

    #[test]
    fn sync_creates_then_updates_without_touching_user_fields() {
        let dir = std::env::temp_dir().join(format!("brain-gh-{}", crate::vault::new_id()));
        let mut store = Store::open(dir.join("vault"), &dir.join("brain.db")).unwrap();
        let r = apply(&mut store, &[repo("hackemon"), Repo { fork: true, ..repo("forked") }]).unwrap();
        assert_eq!((r.created, r.updated), (1, 0), "forks are skipped");
        let item = store.index.items().unwrap().into_iter().find(|i| i.kind == "project").unwrap();
        assert_eq!(item.title, "hackemon");
        assert_eq!(item.body, "## README (from GitHub)\n\n# Hello");
        assert_eq!(item.fields["status"], json!("active"));

        // the user edits their parts
        store.update(&item.id, json!({ "title": "Hackemon", "status": "shipped", "role": "lead", "body": "my notes", "tags": ["ctf"] }).as_object().unwrap().clone()).unwrap();

        // GitHub changes
        let mut changed = repo("hackemon");
        changed.stars = 10;
        changed.description = Some("New description".into());
        changed.readme = Some("# Changed readme".into());
        let r = apply(&mut store, &[changed.clone()]).unwrap();
        assert_eq!((r.created, r.updated), (0, 1));
        let after = store.get(&item.id).unwrap().unwrap();
        assert_eq!(after.fields["stars"], json!(10));
        assert_eq!(after.fields["description"], json!("New description"));
        assert_eq!((after.title.as_str(), after.body.as_str()), ("Hackemon", "my notes"));
        assert_eq!(after.fields["status"], json!("shipped"));
        assert_eq!(after.fields["role"], json!("lead"));
        assert_eq!(after.tags, vec!["ctf"]);

        // nothing changed → no write
        assert_eq!(apply(&mut store, &[changed]).unwrap().updated, 0);
        assert!(store.index.meta(META_LAST).unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }
}
