//! End-to-end tests of the background pieces with Tauri's mock runtime and a
//! loopback fake embedding server (no internet).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Manager;

use crate::embed::{self, EmbedState};
use crate::settings::Settings;
use crate::state::AppState;
use crate::store::Store;

/// Embedding server: vector = [mentions ctf, mentions linux, mentions web, 0.05].
fn fake_embed_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(mut sock) = sock else { continue };
            let mut buf = vec![0u8; 1 << 20];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).unwrap_or(0);
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if req.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let text = String::from_utf8_lossy(&req).to_string();
            let body = &text[text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0)..];
            let v: Value = serde_json::from_str(body).unwrap_or(json!({ "input": [] }));
            let data: Vec<Value> = v["input"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let t = t.as_str().unwrap_or("").to_lowercase();
                    let f = |w: &str| if t.contains(w) { 1.0 } else { 0.0 };
                    json!({ "index": i, "embedding": [f("ctf"), f("linux"), f("web"), 0.05] })
                })
                .collect();
            let out = json!({ "data": data }).to_string();
            let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len()).as_bytes());
        }
    });
    base
}

fn obj(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn embedding_worker_fills_vectors_and_similar_links() {
    let dir = std::env::temp_dir().join(format!("brain-it-{}", crate::vault::new_id()));
    let mut store = Store::open(dir.join("vault"), &dir.join("brain.db")).unwrap();
    for (t, body) in [("CTF night", "ctf"), ("CTF writeup", "ctf"), ("Linux setup", "linux"), ("Web app", "web"), ("Web docs", "web")] {
        store.create(obj(json!({ "title": t, "body": body }))).unwrap();
    }
    let mut settings = Settings::default();
    settings.embed.base_url = fake_embed_server();
    settings.embed.min_score = 0.9;

    let app = tauri::test::mock_app();
    app.manage(AppState {
        store: Mutex::new(Some(store)),
        settings: Mutex::new(settings),
        watcher: Mutex::new(None),
        settings_file: dir.join("settings.json"),
        db_file: dir.join("brain.db"),
        home: dir.clone(),
        open_error: Mutex::new(None),
    });
    app.manage(EmbedState::default());
    let handle = app.handle().clone();

    embed::backfill(&handle);
    let state = handle.state::<AppState>();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let n = state.with_store(|s| Ok(s.index.embedding_hashes("default")?.len())).unwrap();
        if n == 5 || Instant::now() > deadline {
            assert_eq!(n, 5, "all items embedded");
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let explicit = state.with_store(|s| s.index.links()).unwrap();
    let links = embed::graph_similar(&handle, &explicit).expect("similar links");
    let titles = |id: &str| state.with_store(|s| Ok(s.get(id)?.unwrap().title)).unwrap();
    let mut pairs: Vec<(String, String)> = links.iter().map(|l| {
        let (a, b) = (titles(&l.source), titles(&l.target));
        if a < b { (a, b) } else { (b, a) }
    }).collect();
    pairs.sort();
    assert_eq!(pairs, vec![("CTF night".into(), "CTF writeup".into()), ("Web app".into(), "Web docs".into())]);

    // unchanged items aren't re-embedded
    let before = state.with_store(|s| s.index.embedding_hashes("default")).unwrap();
    embed::backfill(&handle);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(state.with_store(|s| s.index.embedding_hashes("default")).unwrap(), before);
    let _ = std::fs::remove_dir_all(dir);
}

/// Fake GitHub API: two pages of repos, languages and a README.
fn fake_github() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(mut sock) = sock else { continue };
            let mut buf = vec![0u8; 65536];
            let n = sock.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let authed = req.to_lowercase().contains("authorization: bearer good-token");
            let (status, body) = if !authed {
                ("401 Unauthorized", json!({ "message": "Bad credentials" }).to_string())
            } else if path.starts_with("/user/repos") && path.contains("page=1&") {
                let repos: Vec<Value> = (0..100).map(|i| json!({ "full_name": format!("p/r{i}"), "name": format!("r{i}"), "html_url": format!("https://github.com/p/r{i}"), "fork": i > 0 })).collect();
                ("200 OK", Value::Array(repos).to_string())
            } else if path.starts_with("/user/repos") && path.contains("page=2&") {
                ("200 OK", json!([{ "full_name": "p/last", "name": "last", "html_url": "https://github.com/p/last", "topics": ["t"], "stargazers_count": 5 }]).to_string())
            } else if path.ends_with("/languages") {
                ("200 OK", json!({ "JavaScript": 10, "Rust": 500 }).to_string())
            } else if path == "/repos/p/last/readme" {
                ("200 OK", "# Last repo".to_string())
            } else {
                ("404 Not Found", json!({ "message": "Not Found" }).to_string())
            };
            let _ = sock.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
        }
    });
    base
}

#[test]
fn github_fetch_paginates_and_reads_languages_and_readme() {
    let api = fake_github();
    let repos = tauri::async_runtime::block_on(crate::github::fetch_repos(&api, "good-token", |_, _| {})).unwrap();
    assert_eq!(repos.len(), 101, "two pages");
    let last = repos.iter().find(|r| r.name == "last").unwrap();
    assert_eq!(last.languages, vec!["Rust", "JavaScript"], "sorted by bytes");
    assert_eq!(last.readme.as_deref(), Some("# Last repo"));
    assert_eq!((last.stars, last.topics.clone()), (5, vec!["t".to_string()]));
    assert_eq!(repos.iter().filter(|r| !r.fork).count(), 2);
    let e = tauri::async_runtime::block_on(crate::github::whoami(&api, "bad")).unwrap_err();
    assert!(e.to_string().contains("401"));
}
