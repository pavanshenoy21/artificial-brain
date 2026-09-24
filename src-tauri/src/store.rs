//! Storage: the vault folder of markdown files is the source of truth,
//! SQLite (`brain.db`) is an index over it that can be rebuilt at any time.
//!
//! Vault layout (Obsidian can open it as-is):
//!   notes/<Title>.md, links/…, skills/…, hackathons/…, projects/…
//!   .trash/            deleted files end up here, never hard-deleted
//!
//! Each file has YAML frontmatter (id, type, lobe, tags, type-specific
//! fields, created, updated) and a markdown body. [[Wikilinks]] in the body
//! become explicit links in the graph. Files dropped in by hand (or edited in
//! Obsidian) are picked up on the next `sync`.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::markdown as md;

pub const TYPES: [&str; 5] = ["note", "link", "skill", "hackathon", "project"];
const SCHEMA_VERSION: i32 = 1;


#[derive(Debug)]
pub struct Error(pub String);
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
macro_rules! from_err {
    ($($t:ty),*) => {$(impl From<$t> for Error { fn from(e: $t) -> Self { Error(e.to_string()) } })*};
}
from_err!(std::io::Error, rusqlite::Error, serde_json::Error);
fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error(msg.into()))
}

/// A node as the frontend sees it: flat object, type-specific fields inline.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub lobe: Option<String>,
    pub title: String,
    pub tags: Vec<String>,
    pub body: String,
    /// Path relative to the vault, with forward slashes.
    pub path: String,
    pub created: Option<String>,
    pub updated: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub source: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct SyncReport {
    pub scanned: usize,
    pub updated: usize,
    pub removed: usize,
}

pub struct Store {
    vault: PathBuf,
    db: Connection,
}

impl Store {
    pub fn open(vault: impl Into<PathBuf>, db_path: &Path) -> Result<Self> {
        let vault = vault.into();
        fs::create_dir_all(&vault)?;
        if let Some(dir) = db_path.parent() {
            fs::create_dir_all(dir)?;
        }
        let db = Connection::open(db_path)?;
        let store = Store { vault, db };
        store.migrate()?;
        Ok(store)
    }

    pub fn vault(&self) -> &Path {
        &self.vault
    }

    fn migrate(&self) -> Result<()> {
        let version: i32 = self.db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            // It's only an index; on any schema change just rebuild it.
            self.db.execute_batch(
                "DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS node_tags; DROP TABLE IF EXISTS nodes;",
            )?;
        }
        self.db.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS nodes (
               id      TEXT PRIMARY KEY,
               path    TEXT NOT NULL UNIQUE,
               type    TEXT NOT NULL,
               lobe    TEXT,
               title   TEXT NOT NULL,
               tags    TEXT NOT NULL,   -- JSON array
               fields  TEXT NOT NULL,   -- JSON object of type-specific fields
               body    TEXT NOT NULL,
               created TEXT,
               updated TEXT,
               mtime   INTEGER NOT NULL,
               size    INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS node_tags (
               node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
               tag     TEXT NOT NULL,
               PRIMARY KEY (node_id, tag)
             );
             CREATE INDEX IF NOT EXISTS node_tags_tag ON node_tags(tag);
             CREATE TABLE IF NOT EXISTS links (
               source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
               target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
               kind   TEXT NOT NULL,
               PRIMARY KEY (source, target, kind)
             );
             PRAGMA user_version = {SCHEMA_VERSION};"
        ))?;
        Ok(())
    }

    // ------------------------------------------------------------ sync

    /// Brings the index in line with the files on disk. Unchanged files
    /// (same mtime + size) are skipped, so this is cheap to call often.
    pub fn sync(&mut self) -> Result<SyncReport> {
        let mut files = Vec::new();
        collect_md(&self.vault, &self.vault, &mut files)?;

        let known: HashMap<String, (i64, i64)> = {
            let mut stmt = self.db.prepare("SELECT path, mtime, size FROM nodes")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
            rows.collect::<rusqlite::Result<_>>()?
        };

        let mut report = SyncReport { scanned: files.len(), ..Default::default() };
        let seen: HashSet<String> = files.iter().map(|f| rel_path(&self.vault, f)).collect();

        let tx = self.db.transaction()?;
        for path in known.keys().filter(|p| !seen.contains(*p)) {
            tx.execute("DELETE FROM nodes WHERE path = ?1", [path])?;
            report.removed += 1;
        }
        for file in &files {
            let rel = rel_path(&self.vault, file);
            let stamp = file_stamp(file)?;
            if known.get(&rel) == Some(&stamp) {
                continue;
            }
            let node = read_node(&self.vault, file)?;
            index_node(&tx, node, stamp)?;
            report.updated += 1;
        }
        if report.updated + report.removed > 0 {
            rebuild_links(&tx)?;
        }
        tx.commit()?;
        Ok(report)
    }

    // ------------------------------------------------------------ reads

    pub fn graph(&self) -> Result<Graph> {
        let mut stmt = self.db.prepare(&format!("{SELECT_NODE} ORDER BY path"))?;
        let nodes = stmt.query_map([], row_to_node)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = self.db.prepare("SELECT source, target, kind FROM links ORDER BY source, target")?;
        let links = stmt
            .query_map([], |r| Ok(Link { source: r.get(0)?, target: r.get(1)?, kind: r.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Graph { nodes, links })
    }

    pub fn get(&self, id: &str) -> Result<Option<Node>> {
        Ok(self
            .db
            .query_row(&format!("{SELECT_NODE} WHERE id = ?1"), [id], row_to_node)
            .optional()?)
    }

    /// Every tag in use with its count, most used first.
    pub fn tags(&self) -> Result<Vec<(String, i64)>> {
        let mut stmt = self
            .db
            .prepare("SELECT tag, COUNT(*) AS n FROM node_tags GROUP BY tag ORDER BY n DESC, tag")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ------------------------------------------------------------ writes

    /// Creates a node from a flat object: `{ type, title, lobe?, tags?, body?, ...fields }`.
    pub fn create(&mut self, input: Map<String, Value>) -> Result<Node> {
        let now = now();
        let mut node = Node {
            id: new_id(),
            kind: "note".into(),
            lobe: None,
            title: String::new(),
            tags: vec![],
            body: String::new(),
            path: String::new(),
            created: Some(now.clone()),
            updated: Some(now),
            fields: Map::new(),
        };
        apply_patch(&mut node, input)?;
        if node.title.trim().is_empty() {
            return err("title is required");
        }
        let file = self.unique_path(type_dir(&node.kind), &md::file_stem_for(&node.title), None);
        node.path = rel_path(&self.vault, &file);
        write_node_file(&file, &node)?;
        self.reindex(&[file], &[])?;
        self.get(&node.id)?.ok_or_else(|| Error("node vanished after create".into()))
    }

    /// Applies a partial update. Keys set to `null` remove that field.
    /// Re-reads the file first so edits made outside the app aren't lost.
    /// A title change renames the file and rewrites [[links]] pointing at it.
    pub fn update(&mut self, id: &str, patch: Map<String, Value>) -> Result<Node> {
        let old_file = self.file_of(id)?;
        let mut node = read_node(&self.vault, &old_file)?;
        node.id = id.to_string();
        let old_title = node.title.clone();
        let old_stem = stem_of(&old_file);
        apply_patch(&mut node, patch)?;
        if node.title.trim().is_empty() {
            return err("title can't be empty");
        }
        node.updated = Some(now());

        let new_stem = md::file_stem_for(&node.title);
        let renamed = node.title != old_title && new_stem != old_stem;
        let file = if renamed {
            let dir = old_file.parent().unwrap_or(&self.vault).to_path_buf();
            self.unique_path_in(&dir, &new_stem, Some(&old_file))
        } else {
            old_file.clone()
        };
        node.path = rel_path(&self.vault, &file);
        write_node_file(&file, &node)?;
        let mut touched = vec![file.clone()];
        let mut removed = vec![];
        if file != old_file {
            fs::remove_file(&old_file)?;
            removed.push(rel_path(&self.vault, &old_file));
            touched.extend(self.rewrite_backlinks(&old_stem, &stem_of(&file), &old_title)?);
        }
        self.reindex(&touched, &removed)?;
        self.get(id)?.ok_or_else(|| Error("node vanished after update".into()))
    }

    /// Moves the file into `.trash/` and drops it from the index.
    pub fn delete(&mut self, id: &str) -> Result<()> {
        let file = self.file_of(id)?;
        let trash = self.vault.join(".trash");
        fs::create_dir_all(&trash)?;
        let dest = self.unique_path_in(&trash, &stem_of(&file), None);
        fs::rename(&file, &dest)?;
        self.db.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
        rebuild_links(&self.db)?;
        Ok(())
    }

    /// Bulk import of `{ nodes, links }` (the old graph.json / sample shape).
    /// Explicit links are written into the source note as [[wikilinks]] so
    /// they survive as plain markdown. Returns how many nodes were created.
    pub fn import(&mut self, nodes: Vec<Map<String, Value>>, links: Vec<Link>) -> Result<usize> {
        let mut new_ids: HashMap<String, String> = HashMap::new();
        let mut stems: HashMap<String, String> = HashMap::new();
        for mut input in nodes {
            let old_id = input.remove("id").and_then(|v| v.as_str().map(str::to_string));
            let node = self.create(input)?;
            if let Some(old) = old_id {
                stems.insert(node.id.clone(), node.path.rsplit('/').next().unwrap_or("").trim_end_matches(".md").to_string());
                new_ids.insert(old, node.id);
            }
        }
        let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
        for l in links.iter().filter(|l| l.kind == "explicit") {
            if let (Some(s), Some(t)) = (new_ids.get(&l.source), new_ids.get(&l.target)) {
                outgoing.entry(s.clone()).or_default().push(stems[t].clone());
            }
        }
        let mut touched = vec![];
        for (id, targets) in outgoing {
            let file = self.file_of(&id)?;
            let mut node = read_node(&self.vault, &file)?;
            let related = targets.iter().map(|t| format!("[[{t}]]")).collect::<Vec<_>>().join(", ");
            node.body = if node.body.trim().is_empty() {
                format!("Related: {related}")
            } else {
                format!("{}\n\nRelated: {related}", node.body.trim_end())
            };
            write_node_file(&file, &node)?;
            touched.push(file);
        }
        self.reindex(&touched, &[])?;
        Ok(new_ids.len())
    }

    // ------------------------------------------------------------ helpers

    /// Re-reads files the store just wrote (instead of trusting mtimes,
    /// which can be too coarse to notice a quick rewrite).
    fn reindex(&mut self, files: &[PathBuf], removed_paths: &[String]) -> Result<()> {
        let tx = self.db.transaction()?;
        for p in removed_paths {
            tx.execute("DELETE FROM nodes WHERE path = ?1", [p])?;
        }
        for file in files {
            let node = read_node(&self.vault, file)?;
            index_node(&tx, node, file_stamp(file)?)?;
        }
        rebuild_links(&tx)?;
        tx.commit()?;
        Ok(())
    }

    fn file_of(&self, id: &str) -> Result<PathBuf> {
        let path: Option<String> = self
            .db
            .query_row("SELECT path FROM nodes WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        match path {
            Some(p) if self.vault.join(&p).is_file() => Ok(self.vault.join(p)),
            Some(p) => err(format!("file for {id} is missing: {p}")),
            None => err(format!("no node with id {id}")),
        }
    }

    fn unique_path(&self, dir: &str, stem: &str, current: Option<&Path>) -> PathBuf {
        self.unique_path_in(&self.vault.join(dir), stem, current)
    }

    fn unique_path_in(&self, dir: &Path, stem: &str, current: Option<&Path>) -> PathBuf {
        let mut candidate = dir.join(format!("{stem}.md"));
        let mut n = 2;
        while candidate.exists() && Some(candidate.as_path()) != current {
            candidate = dir.join(format!("{stem} {n}.md"));
            n += 1;
        }
        candidate
    }

    /// After a rename, point [[Old]] (by file name or old title) at the new file name.
    /// Returns the files that changed.
    fn rewrite_backlinks(&self, old_stem: &str, new_stem: &str, old_title: &str) -> Result<Vec<PathBuf>> {
        let mut changed = Vec::new();
        let mut files = Vec::new();
        collect_md(&self.vault, &self.vault, &mut files)?;
        for file in files {
            let text = fs::read_to_string(&file)?;
            let mut out = md::rename_wikilinks(&text, old_stem, new_stem);
            if old_title != old_stem {
                out = md::rename_wikilinks(&out, old_title, new_stem);
            }
            if out != text {
                write_atomic(&file, &out)?;
                changed.push(file);
            }
        }
        Ok(changed)
    }
}

// ---------------------------------------------------------------- file <-> node

fn read_node(vault: &Path, file: &Path) -> Result<Node> {
    let text = fs::read_to_string(file)?;
    let (fm, body) = md::split_frontmatter(&text);
    let mut front = fm.map(md::parse_frontmatter).unwrap_or_default();
    let rel = rel_path(vault, file);

    let str_of = |front: &mut Map<String, Value>, k: &str| match front.remove(k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    let id = str_of(&mut front, "id").unwrap_or_else(|| rel.clone());
    let kind = str_of(&mut front, "type")
        .filter(|t| TYPES.contains(&t.as_str()))
        .unwrap_or_else(|| type_from_dir(&rel).to_string());
    let lobe = str_of(&mut front, "lobe");
    let title = str_of(&mut front, "title").unwrap_or_else(|| stem_of(file));
    let tags = md::normalize_tags(front.get("tags"));
    front.remove("tags");
    let created = str_of(&mut front, "created");
    let updated = str_of(&mut front, "updated");

    Ok(Node {
        id,
        kind,
        lobe,
        title,
        tags,
        body: body.trim_start_matches(['\n', '\r']).trim_end().to_string(),
        path: rel,
        created,
        updated,
        fields: front,
    })
}

fn write_node_file(file: &Path, node: &Node) -> Result<()> {
    let mut front = Map::new();
    front.insert("id".into(), node.id.clone().into());
    front.insert("type".into(), node.kind.clone().into());
    if let Some(l) = &node.lobe {
        front.insert("lobe".into(), l.clone().into());
    }
    // The file name is the title (Obsidian-style); only store it when
    // the file name had to lose characters.
    if md::file_stem_for(&node.title) != node.title || stem_of(file) != node.title {
        front.insert("title".into(), node.title.clone().into());
    }
    front.insert("tags".into(), node.tags.clone().into());
    for (k, v) in &node.fields {
        front.insert(k.clone(), v.clone());
    }
    if let Some(c) = &node.created {
        front.insert("created".into(), c.clone().into());
    }
    if let Some(u) = &node.updated {
        front.insert("updated".into(), u.clone().into());
    }
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    write_atomic(file, &md::render(&front, &node.body))
}

fn apply_patch(node: &mut Node, patch: Map<String, Value>) -> Result<()> {
    for (k, v) in patch {
        match k.as_str() {
            "type" => {
                let t = v.as_str().unwrap_or_default();
                if !TYPES.contains(&t) {
                    return err(format!("unknown type {t:?}, expected one of {TYPES:?}"));
                }
                node.kind = t.to_string();
            }
            "lobe" => node.lobe = v.as_str().filter(|s| !s.is_empty()).map(str::to_string),
            "title" => node.title = v.as_str().unwrap_or_default().trim().to_string(),
            "tags" => node.tags = md::normalize_tags(Some(&v)),
            "body" => node.body = v.as_str().unwrap_or_default().trim_end().to_string(),
            // managed by the store
            "id" | "path" | "created" | "updated" => {}
            _ if v.is_null() => {
                node.fields.remove(&k);
            }
            _ => {
                node.fields.insert(k, v);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- index

const SELECT_NODE: &str =
    "SELECT id, type, lobe, title, tags, body, path, created, updated, fields FROM nodes";

fn row_to_node(r: &rusqlite::Row) -> rusqlite::Result<Node> {
    let tags: String = r.get(4)?;
    let fields: String = r.get(9)?;
    Ok(Node {
        id: r.get(0)?,
        kind: r.get(1)?,
        lobe: r.get(2)?,
        title: r.get(3)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        body: r.get(5)?,
        path: r.get(6)?,
        created: r.get(7)?,
        updated: r.get(8)?,
        fields: serde_json::from_str(&fields).unwrap_or_default(),
    })
}

fn index_node(db: &Connection, mut node: Node, (mtime, size): (i64, i64)) -> Result<()> {
    // Two files claiming the same id (e.g. a copied file): the second one
    // falls back to its path as id instead of clobbering the first.
    let owner: Option<String> = db
        .query_row("SELECT path FROM nodes WHERE id = ?1", [&node.id], |r| r.get(0))
        .optional()?;
    if matches!(&owner, Some(p) if *p != node.path) {
        node.id = node.path.clone();
    }
    db.execute("DELETE FROM nodes WHERE path = ?1", [&node.path])?;
    db.execute(
        "INSERT INTO nodes (id, path, type, lobe, title, tags, fields, body, created, updated, mtime, size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            node.id,
            node.path,
            node.kind,
            node.lobe,
            node.title,
            serde_json::to_string(&node.tags)?,
            serde_json::to_string(&node.fields)?,
            node.body,
            node.created,
            node.updated,
            mtime,
            size
        ],
    )?;
    for t in &node.tags {
        db.execute("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?1, ?2)", params![node.id, t])?;
    }
    Ok(())
}

/// Recomputes explicit links from [[wikilinks]] in every body. Targets are
/// matched case-insensitively by file name, vault-relative path or title.
fn rebuild_links(db: &Connection) -> Result<()> {
    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = db.prepare("SELECT id, path, title, body FROM nodes")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut lookup: HashMap<String, String> = HashMap::new();
    // titles first so file names / paths win on a clash
    for (id, _, title, _) in &rows {
        lookup.insert(title.to_lowercase(), id.clone());
    }
    for (id, path, _, _) in &rows {
        let no_ext = path.trim_end_matches(".md");
        lookup.insert(no_ext.to_lowercase(), id.clone());
        lookup.insert(no_ext.rsplit('/').next().unwrap_or(no_ext).to_lowercase(), id.clone());
    }
    db.execute("DELETE FROM links WHERE kind = 'explicit'", [])?;
    let mut stmt = db.prepare("INSERT OR IGNORE INTO links (source, target, kind) VALUES (?1, ?2, 'explicit')")?;
    for (id, _, _, body) in &rows {
        for target in md::wikilinks(body) {
            let key = target.trim_end_matches(".md").to_lowercase();
            if let Some(t) = lookup.get(&key) {
                if t != id {
                    stmt.execute(params![id, t])?;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- fs utils

fn collect_md(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue; // .trash, .obsidian, .git, …
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_md(root, &path, out)?;
        } else if ft.is_file() && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
            out.push(path);
        }
    }
    Ok(())
}

fn rel_path(vault: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(vault).unwrap_or(file);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn stem_of(file: &Path) -> String {
    file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn file_stamp(file: &Path) -> Result<(i64, i64)> {
    let meta = fs::metadata(file)?;
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    Ok((mtime, meta.len() as i64))
}

fn write_atomic(file: &Path, contents: &str) -> Result<()> {
    let tmp = file.with_extension("md.tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

fn type_dir(kind: &str) -> &'static str {
    match kind {
        "link" => "links",
        "skill" => "skills",
        "hackathon" => "hackathons",
        "project" => "projects",
        _ => "notes",
    }
}

fn type_from_dir(rel: &str) -> &'static str {
    match rel.split('/').next().unwrap_or("").to_lowercase().as_str() {
        "links" => "link",
        "skills" => "skill",
        "hackathons" => "hackathon",
        "projects" => "project",
        _ => "note",
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (Tmp, Store) {
        let dir = std::env::temp_dir().join(format!("brain-test-{}", new_id()));
        let store = Store::open(dir.join("vault"), &dir.join("brain.db")).unwrap();
        (Tmp(dir), store)
    }
    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn create_writes_markdown_and_indexes() {
        let (_t, mut s) = setup();
        let n = s
            .create(obj(json!({ "type": "skill", "title": "HTML / CSS", "lobe": "web", "tags": ["#web"], "level": "Beginner" })))
            .unwrap();
        assert_eq!(n.path, "skills/HTML CSS.md");
        assert_eq!(n.tags, vec!["web"]);
        assert_eq!(n.fields["level"], json!("Beginner"));
        let text = fs::read_to_string(s.vault().join(&n.path)).unwrap();
        assert!(text.contains("title: HTML / CSS"));
        assert!(text.contains("level: Beginner"));
        assert_eq!(s.tags().unwrap(), vec![("web".to_string(), 1)]);
        assert!(s.create(obj(json!({ "type": "nope", "title": "x" }))).is_err());
        assert!(s.create(obj(json!({ "title": "  " }))).is_err());
    }

    #[test]
    fn wikilinks_become_links_and_follow_renames() {
        let (_t, mut s) = setup();
        let a = s.create(obj(json!({ "title": "Alpha", "body": "See [[Beta]]" }))).unwrap();
        let b = s.create(obj(json!({ "title": "Beta" }))).unwrap();
        let g = s.graph().unwrap();
        assert_eq!(g.links, vec![Link { source: a.id.clone(), target: b.id.clone(), kind: "explicit".into() }]);

        let b2 = s.update(&b.id, obj(json!({ "title": "Gamma", "level": null }))).unwrap();
        assert_eq!(b2.path, "notes/Gamma.md");
        assert!(!s.vault().join("notes/Beta.md").exists());
        assert_eq!(s.get(&a.id).unwrap().unwrap().body, "See [[Gamma]]");
        assert_eq!(s.graph().unwrap().links.len(), 1);

        s.delete(&b.id).unwrap();
        assert!(s.vault().join(".trash/Gamma.md").exists());
        assert!(s.graph().unwrap().links.is_empty());
        assert!(s.get(&b.id).unwrap().is_none());
    }

    #[test]
    fn sync_picks_up_external_files() {
        let (_t, mut s) = setup();
        fs::create_dir_all(s.vault().join("links")).unwrap();
        fs::write(s.vault().join("links/Arch Wiki.md"), "---\nurl: https://wiki.archlinux.org\ntags: linux, docs\n---\nGreat docs. [[Missing]]").unwrap();
        fs::write(s.vault().join("Loose.md"), "no frontmatter, links to [[arch wiki]]").unwrap();
        let r = s.sync().unwrap();
        assert_eq!(r, SyncReport { scanned: 2, updated: 2, removed: 0 });
        let g = s.graph().unwrap();
        let arch = g.nodes.iter().find(|n| n.title == "Arch Wiki").unwrap();
        assert_eq!(arch.kind, "link");
        assert_eq!(arch.id, "links/Arch Wiki.md");
        assert_eq!(arch.tags, vec!["linux", "docs"]);
        assert_eq!(g.links.len(), 1);

        assert_eq!(s.sync().unwrap().updated, 0, "unchanged files are skipped");
        fs::remove_file(s.vault().join("Loose.md")).unwrap();
        assert_eq!(s.sync().unwrap().removed, 1);
        assert!(s.graph().unwrap().links.is_empty());
    }

    #[test]
    fn update_keeps_external_edits_and_unknown_fields() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "Note", "body": "v1" }))).unwrap();
        let file = s.vault().join(&n.path);
        let text = fs::read_to_string(&file).unwrap().replace("v1", "edited in obsidian");
        let text = text.replacen("---\n", "---\naliases: [n]\n", 1);
        fs::write(&file, text).unwrap();
        let n2 = s.update(&n.id, obj(json!({ "tags": ["x"] }))).unwrap();
        assert_eq!(n2.body, "edited in obsidian");
        assert_eq!(n2.fields["aliases"], json!(["n"]));
        assert_eq!(n2.created, n.created);
    }

    #[test]
    fn duplicate_ids_dont_clobber() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "Orig" }))).unwrap();
        fs::copy(s.vault().join(&n.path), s.vault().join("notes/Copy.md")).unwrap();
        s.sync().unwrap();
        let g = s.graph().unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert!(g.nodes.iter().any(|x| x.id == n.id && x.path == "notes/Orig.md"));
    }

    #[test]
    fn import_writes_links_as_wikilinks() {
        let (_t, mut s) = setup();
        let nodes = vec![
            obj(json!({ "id": "a", "type": "note", "title": "A: first", "body": "x" })),
            obj(json!({ "id": "b", "type": "skill", "title": "B", "level": "Beginner" })),
        ];
        let links = vec![
            Link { source: "a".into(), target: "b".into(), kind: "explicit".into() },
            Link { source: "b".into(), target: "a".into(), kind: "similar".into() },
        ];
        assert_eq!(s.import(nodes, links).unwrap(), 2);
        let g = s.graph().unwrap();
        let a = g.nodes.iter().find(|n| n.title == "A: first").unwrap();
        assert_eq!(a.body, "x\n\nRelated: [[B]]");
        assert_eq!(g.links.len(), 1);
    }
}
