//! A vault shaped like a real Obsidian one: opening it must not modify any
//! file, and links/tags/search must come out right.

use std::collections::BTreeMap;
use std::fs;

use serde_json::json;

use crate::store::Store;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("brain-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

#[test]
fn obsidian_vault_is_read_faithfully_and_left_untouched() {
    let dir = tmp("obs");
    let v = dir.join("vault");
    let files: Vec<(&str, &str)> = vec![
        (".obsidian/app.json", "{}"),
        ("Coding Club/CTF/Writeup.md", "---\naliases: [jwt writeup]\ntags: [ctf]\n---\n# JWT\n\n`none` alg #web\n\nSee [[Linux#Shell|shell basics]] and ![[diagram.png]].\n"),
        ("Coding Club/CTF/Linux.md", "Shell stuff #cli/linux\r\n\r\nBack to [[jwt writeup]].\r\n"),
        ("Coding Club/Hackathons/README.md", "Index. [[Writeup]] [[Linux]]"),
        ("Coding Club/Overview.md", "> [!note] Callout\n> body"),
        ("SIP/README.md", "SIP index, see [[Dashboard]]."),
        ("SIP/Dashboard.md", "| a | b |\n|---|---|\n| 1 | 2 |\n"),
        ("EL SEM 3/Broken yaml.md", "---\ntags: [unclosed\ntitle: : :\n---\nBody survives #el"),
        ("EL SEM 3/Empty.md", ""),
        ("Misc/Ünïcödé 笔记.md", "Unicode title #misc"),
        ("Misc/image.png", "not markdown"),
        ("Loose root note.md", "No folder."),
        ("Board.canvas", "{\"nodes\":[{\"id\":\"a\",\"type\":\"file\",\"file\":\"SIP/README.md\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}],\"edges\":[]}"),
    ];
    for (p, c) in &files {
        let f = v.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, c).unwrap();
    }
    let snapshot = || -> BTreeMap<String, Vec<u8>> { files.iter().map(|(p, _)| (p.to_string(), fs::read(v.join(p)).unwrap())).collect() };
    let before = snapshot();

    let mut store = Store::open(&v, &dir.join("brain.db")).unwrap();
    assert_eq!(store.sync().unwrap().updated, 0, "already indexed on open");
    let g = store.graph().unwrap();
    assert_eq!(before, snapshot(), "opening the vault changed no file");
    assert_eq!(g.nodes.len(), 11, "10 notes + 1 canvas; .obsidian and png ignored");
    assert_eq!(g.folders, vec!["Coding Club", "Coding Club/CTF", "Coding Club/Hackathons", "EL SEM 3", "Misc", "SIP"]);

    let node = |p: &str| g.nodes.iter().find(|n| n.path == p).unwrap_or_else(|| panic!("missing {p}"));
    let links_from = |p: &str| {
        let mut t: Vec<String> = g.links.iter().filter(|l| l.source == p).map(|l| l.target.clone()).collect();
        t.sort();
        t
    };
    assert_eq!(node("Misc/Ünïcödé 笔记.md").title, "Ünïcödé 笔记");
    assert_eq!(node("Coding Club/CTF/Writeup.md").tags, vec!["ctf"]);
    assert_eq!(node("Coding Club/CTF/Writeup.md").inline_tags, vec!["web"]);
    assert_eq!(node("Coding Club/CTF/Linux.md").inline_tags, vec!["cli/linux"], "CRLF file");
    assert_eq!(node("EL SEM 3/Broken yaml.md").inline_tags, vec!["el"], "bad YAML doesn't lose the body");
    assert_eq!(node("Board.canvas").kind, "canvas");

    assert_eq!(links_from("Coding Club/CTF/Writeup.md"), vec!["Coding Club/CTF/Linux.md"]);
    assert_eq!(links_from("Coding Club/CTF/Linux.md"), vec!["Coding Club/CTF/Writeup.md"], "[[alias]] resolves");
    assert_eq!(links_from("Coding Club/Hackathons/README.md"), vec!["Coding Club/CTF/Linux.md", "Coding Club/CTF/Writeup.md"]);
    assert_eq!(links_from("Board.canvas"), vec!["SIP/README.md"]);

    assert_eq!(store.search("ünïcödé", 5).unwrap()[0].id, "Misc/Ünïcödé 笔记.md");
    assert_eq!(store.search("callout", 5).unwrap()[0].id, "Coding Club/Overview.md");

    // rename keeps the file in its folder and rewrites [[Linux#Shell|shell basics]]
    let r = store.update("Coding Club/CTF/Linux.md", json!({ "title": "Linux shell" }).as_object().unwrap().clone()).unwrap();
    assert_eq!(r.id, "Coding Club/CTF/Linux shell.md");
    let w = fs::read_to_string(v.join("Coding Club/CTF/Writeup.md")).unwrap();
    assert!(w.contains("[[Linux shell#Shell|shell basics]]"), "{w}");
    assert!(w.starts_with("---\naliases: [jwt writeup]\ntags: [ctf]\n---\n"), "frontmatter bytes kept: {w}");
    let renamed = fs::read_to_string(v.join("Coding Club/CTF/Linux shell.md")).unwrap();
    assert!(!renamed.contains("id:"), "no id written on rename");
    for p in ["SIP/Dashboard.md", "Misc/Ünïcödé 笔记.md", "EL SEM 3/Broken yaml.md", "Board.canvas"] {
        assert_eq!(fs::read(v.join(p)).unwrap(), before[p], "{p} untouched by the rename");
    }
    let _ = fs::remove_dir_all(dir);
}
