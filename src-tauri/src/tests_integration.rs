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

/// Chat server that answers every request with a fixed reply citing a note.
fn fake_chat(reply: &'static str) -> String {
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
                let t = String::from_utf8_lossy(&req);
                if let Some(end) = t.find("\r\n\r\n") {
                    let len = t.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if req.len() >= end + 4 + len { break; }
                }
                if n == 0 { break; }
            }
            let out = json!({ "choices": [{ "message": { "content": reply } }] }).to_string();
            let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len()).as_bytes());
        }
    });
    base
}

#[test]
fn ask_retrieves_expands_and_cites() {
    let dir = std::env::temp_dir().join(format!("brain-ask-{}", crate::vault::new_id()));
    let mut store = Store::open(dir.join("vault"), &dir.join("brain.db")).unwrap();
    store.create(obj(json!({ "title": "Per-team containers", "body": "Spawn one container per team. See [[CTFd notes]]." }))).unwrap();
    store.create(obj(json!({ "title": "CTFd notes", "body": "Run behind nginx." }))).unwrap();
    store.create(obj(json!({ "title": "Unrelated", "body": "Semester plan." }))).unwrap();
    let mut settings = Settings::default();
    settings.ai.provider = "custom".into();
    settings.ai.base_url = fake_chat("Use one container per team [[Per-team containers]], behind nginx ([[CTFd notes]]).");

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
    let h = app.handle().clone();

    let a = tauri::async_runtime::block_on(crate::ask::answer(&h, "How should I isolate team containers?".into(), vec![])).unwrap();
    assert_eq!(a.retrieval, "full-text");
    let titles: Vec<(&str, &str)> = a.sources.iter().map(|s| (s.title.as_str(), s.why.as_str())).collect();
    assert_eq!(titles, vec![("Per-team containers", "match"), ("CTFd notes", "neighbour")]);
    assert_eq!(a.cited.len(), 2);
    assert!(a.answer.unwrap().contains("[[CTFd notes]]"));

    // AI off: sources only
    h.state::<AppState>().settings.lock().unwrap().ai = Default::default();
    let a = tauri::async_runtime::block_on(crate::ask::answer(&h, "containers".into(), vec![])).unwrap();
    assert!(a.answer.is_none() && !a.sources.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

/// A vault shaped like a real Obsidian one. Opening it must not modify any
/// file, and links/tags/lobes/search must come out right.
#[test]
fn obsidian_vault_is_read_faithfully_and_left_untouched() {
    use std::collections::BTreeMap;
    use std::fs;
    let dir = std::env::temp_dir().join(format!("brain-obs-{}", crate::vault::new_id()));
    let v = dir.join("vault");
    let files: Vec<(&str, &str)> = vec![
        (".obsidian/app.json", "{}"),
        (".obsidian/workspace.json", "{\"x\":1}"),
        ("Commands/Git.md", "---\naliases: [git cheatsheet]\ntags: [cli]\ncreated: 2024-05-01\n---\n# Git\n\n`git rebase -i` #git\n\nSee [[Linux#Shell|shell basics]] and ![[diagram.png]].\n"),
        ("Commands/Linux.md", "Shell stuff #cli/linux\r\n\r\nBack to [[git cheatsheet]].\r\n"),
        ("Commands/README.md", "Commands index. [[Git]] [[Linux]]"),
        ("SIP/README.md", "SIP index, see [[Dashboard]]."),
        ("SIP/Dashboard.md", "> [!note] Callout\n> body #sip\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"),
        ("SIP/Sub/Deep note.md", "Nested three levels. #sip"),
        ("Hackerton 2.0/Idea (v2).md", "Parentheses in the name. Links [[Idea (v2)]] to itself and [[Dashboard]]."),
        ("EL SEM 3/Broken yaml.md", "---\ntags: [unclosed\ntitle: : :\n---\nBody survives #el"),
        ("EL SEM 3/Empty.md", ""),
        ("Misc/Ünïcödé 笔记.md", "Unicode title #misc"),
        ("Misc/image.png", "not markdown"),
        ("Misc/paper.pdf", "%PDF"),
        ("Loose root note.md", "No folder, no tags."),
        ("Templates/Daily.md", "{{date}} #template"),
    ];
    for (p, c) in &files {
        let f = v.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, c).unwrap();
    }
    let snapshot = || -> BTreeMap<String, (Vec<u8>, std::time::SystemTime)> {
        files.iter().map(|(p, _)| {
            let f = v.join(p);
            (p.to_string(), (fs::read(&f).unwrap(), fs::metadata(&f).unwrap().modified().unwrap()))
        }).collect()
    };
    let before = snapshot();

    let mut store = Store::open(&v, &dir.join("brain.db")).unwrap();
    let r = store.sync().unwrap();
    assert_eq!(r.updated, 0, "already indexed on open");
    let g = store.graph().unwrap();
    assert_eq!(before, snapshot(), "opening the vault changed no file");
    assert_eq!(g.nodes.len(), 12, "12 markdown files; .obsidian, png and pdf ignored");

    let node = |p: &str| g.nodes.iter().find(|n| n.path == p).unwrap_or_else(|| panic!("missing {p}"));
    let title_of = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().title.clone();
    let links_from = |p: &str| {
        let id = &node(p).id;
        let mut t: Vec<String> = g.links.iter().filter(|l| &l.source == id).map(|l| title_of(&l.target)).collect();
        t.sort();
        t
    };

    // titles, types, tags
    assert_eq!(node("Commands/Git.md").title, "Git");
    assert_eq!(node("Misc/Ünïcödé 笔记.md").title, "Ünïcödé 笔记");
    assert!(g.nodes.iter().all(|n| n.kind == "note"), "user folders are plain notes");
    assert_eq!(node("Commands/Git.md").tags, vec!["cli"]);
    assert_eq!(node("Commands/Git.md").inline_tags, vec!["git"]);
    assert_eq!(node("Commands/Linux.md").inline_tags, vec!["cli/linux"], "CRLF file");
    assert_eq!(node("EL SEM 3/Broken yaml.md").inline_tags, vec!["el"], "bad YAML doesn't lose the body");
    assert_eq!(node("Commands/Git.md").fields["aliases"], json!(["git cheatsheet"]));

    // links: heading + alias form, aliases, duplicate README names, self-links ignored
    assert_eq!(links_from("Commands/Git.md"), vec!["Linux"]);
    assert_eq!(links_from("Commands/Linux.md"), vec!["Git"], "[[alias]] resolves via aliases:");
    assert_eq!(links_from("Commands/README.md"), vec!["Git", "Linux"]);
    assert_eq!(links_from("Hackerton 2.0/Idea (v2).md"), vec!["Dashboard"]);

    // folder lobes (top level only), root note unsorted
    let lobe = |p: &str| node(p).lobe.clone().unwrap_or_default();
    assert_eq!(lobe("SIP/Sub/Deep note.md"), lobe("SIP/README.md"));
    assert!(lobe("SIP/README.md").starts_with("folder-"));
    assert_ne!(lobe("SIP/README.md"), lobe("Commands/README.md"));
    assert_eq!(lobe("Loose root note.md"), "");
    let names: Vec<&str> = g.lobes.iter().filter(|l| l.folder.is_some()).map(|l| l.name.as_str()).collect();
    for f in ["Commands", "SIP", "Hackerton 2.0", "EL SEM 3", "Misc", "Templates"] {
        assert!(names.contains(&f), "lobe for {f}");
    }

    // search: unicode, inline tags, callout text
    assert_eq!(store.search("ünïcödé", 5).unwrap()[0].id, node("Misc/Ünïcödé 笔记.md").id);
    assert_eq!(store.search("callout", 5).unwrap()[0].id, node("SIP/Dashboard.md").id);

    // rename across folders keeps the file in its folder and rewrites
    // [[Linux#Shell|shell basics]] and [[Linux]] elsewhere
    let linux = node("Commands/Linux.md").id.clone();
    let renamed = store.update(&linux, json!({ "title": "Linux shell" }).as_object().unwrap().clone()).unwrap();
    assert_eq!(renamed.path, "Commands/Linux shell.md");
    let git = fs::read_to_string(v.join("Commands/Git.md")).unwrap();
    assert!(git.contains("[[Linux shell#Shell|shell basics]]"), "{git}");
    assert!(fs::read_to_string(v.join("Commands/README.md")).unwrap().contains("[[Linux shell]]"));
    // files that don't link to it are untouched
    let after = snapshot_of(&v, &["SIP/Dashboard.md", "Misc/Ünïcödé 笔记.md", "EL SEM 3/Broken yaml.md"]);
    for (p, bytes) in after {
        assert_eq!(bytes, before[&p].0, "{p} untouched by the rename");
    }
    let _ = fs::remove_dir_all(dir);
}

fn snapshot_of(v: &std::path::Path, paths: &[&str]) -> Vec<(String, Vec<u8>)> {
    paths.iter().map(|p| (p.to_string(), std::fs::read(v.join(p)).unwrap())).collect()
}

/// Editing a note from an existing vault changes only what was edited.
#[test]
fn edits_to_obsidian_notes_are_minimal() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("brain-min-{}", crate::vault::new_id()));
    let v = dir.join("vault");
    fs::create_dir_all(v.join("Uni")).unwrap();
    fs::write(v.join("Uni/Plain.md"), "Just text #uni\n").unwrap();
    fs::write(v.join("Uni/Front.md"), "---\naliases: [f]\ncssclass: wide\n---\nBody\n").unwrap();
    fs::write(v.join("Uni/Windows.md"), "line one\r\nline two\r\n").unwrap();
    let mut s = Store::open(&v, &dir.join("brain.db")).unwrap();
    let patch = |b: &str| json!({ "body": b }).as_object().unwrap().clone();

    s.update("Uni/Plain.md", patch("Just text #uni, edited")).unwrap();
    assert_eq!(fs::read_to_string(v.join("Uni/Plain.md")).unwrap(), "Just text #uni, edited\n", "no frontmatter added");

    s.update("Uni/Front.md", patch("Body 2")).unwrap();
    assert_eq!(fs::read_to_string(v.join("Uni/Front.md")).unwrap(), "---\naliases:\n- f\ncssclass: wide\n---\n\nBody 2\n");

    s.update("Uni/Windows.md", patch("line one\nline two\nline three")).unwrap();
    assert_eq!(fs::read_to_string(v.join("Uni/Windows.md")).unwrap(), "line one\r\nline two\r\nline three\r\n", "CRLF kept");

    // tags added in the app go to frontmatter; nothing else appears
    s.update("Uni/Plain.md", json!({ "tags": ["exam"] }).as_object().unwrap().clone()).unwrap();
    assert_eq!(fs::read_to_string(v.join("Uni/Plain.md")).unwrap(), "---\ntags:\n- exam\n---\n\nJust text #uni, edited\n");

    // a rename keeps the id stable by writing it, since the path changes
    let r = s.update("Uni/Plain.md", json!({ "title": "Plain renamed" }).as_object().unwrap().clone()).unwrap();
    assert_eq!(r.id, "Uni/Plain.md");
    assert!(fs::read_to_string(v.join("Uni/Plain renamed.md")).unwrap().starts_with("---\nid: Uni/Plain.md\n"));
    let _ = fs::remove_dir_all(dir);
}
