//! SQLite index over the vault (app data dir, `brain.db`). Only a cache:
//! everything here can be rebuilt from the markdown files.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::Result;
use crate::markdown as md;
use crate::vault::Item;

const SCHEMA_VERSION: i32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub source: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    pub id: String,
    /// Higher is better (negated bm25).
    pub score: f64,
    /// Body excerpt; matches are wrapped in \u{1} … \u{2} (the UI escapes, then marks).
    pub snippet: String,
}

pub struct Index {
    db: Connection,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let idx = Index { db: Connection::open(path)? };
        idx.migrate()?;
        Ok(idx)
    }

    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        let idx = Index { db: Connection::open_in_memory()? };
        idx.migrate()?;
        Ok(idx)
    }

    fn migrate(&self) -> Result<()> {
        let version: i32 = self.db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            // It's only an index: on any schema change, drop it and let sync rebuild.
            self.db.execute_batch(
                "DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS node_tags; DROP TABLE IF EXISTS nodes;
                 DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS items_fts;
                 DROP TABLE IF EXISTS items;",
            )?;
        }
        self.db.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS items (
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
             CREATE TABLE IF NOT EXISTS tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag     TEXT NOT NULL,
               PRIMARY KEY (item_id, tag)
             );
             CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
             CREATE TABLE IF NOT EXISTS links (
               src  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               dst  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               kind TEXT NOT NULL,
               PRIMARY KEY (src, dst, kind)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
               id UNINDEXED, title, tags, body, extra, tokenize = 'unicode61 remove_diacritics 2'
             );
             -- no foreign key: vectors survive a rebuild and are pruned after sync
             CREATE TABLE IF NOT EXISTS embeddings (
               item_id TEXT PRIMARY KEY,
               model   TEXT NOT NULL,
               dim     INTEGER NOT NULL,
               hash    TEXT NOT NULL,   -- hash of the embedded text, to skip unchanged items
               vector  BLOB NOT NULL    -- little-endian f32 x dim
             );
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = {SCHEMA_VERSION};"
        ))?;
        Ok(())
    }

    #[cfg(test)]
    pub fn conn(&self) -> &Connection {
        &self.db
    }

    // ------------------------------------------------------------ writes

    pub fn begin(&mut self) -> Result<rusqlite::Transaction<'_>> {
        Ok(self.db.transaction()?)
    }

    /// (mtime, size) of every indexed path.
    pub fn stamps(&self) -> Result<HashMap<String, (i64, i64)>> {
        let mut stmt = self.db.prepare("SELECT path, mtime, size FROM items")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Empties the index. Embeddings are kept unless `embeddings` is set
    /// (a rebuild keeps them; switching vaults doesn't).
    pub fn clear(&mut self, embeddings: bool) -> Result<()> {
        self.db.execute_batch("DELETE FROM items; DELETE FROM items_fts;")?;
        if embeddings {
            self.db.execute("DELETE FROM embeddings", [])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ embeddings

    pub fn set_embedding(&self, id: &str, model: &str, hash: &str, v: &[f32]) -> Result<()> {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.db.execute(
            "INSERT OR REPLACE INTO embeddings (item_id, model, dim, hash, vector) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, model, v.len() as i64, hash, bytes],
        )?;
        Ok(())
    }

    /// id -> hash of the text that was embedded, for one model.
    pub fn embedding_hashes(&self, model: &str) -> Result<HashMap<String, String>> {
        let mut stmt = self.db.prepare("SELECT item_id, hash FROM embeddings WHERE model = ?1")?;
        let rows = stmt.query_map([model], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// All vectors for one model, only for items that still exist.
    pub fn embeddings(&self, model: &str) -> Result<Vec<(String, Vec<f32>)>> {
        let mut stmt = self.db.prepare(
            "SELECT e.item_id, e.vector FROM embeddings e JOIN items i ON i.id = e.item_id WHERE e.model = ?1 ORDER BY e.item_id",
        )?;
        let rows = stmt.query_map([model], |r| {
            let id: String = r.get(0)?;
            let bytes: Vec<u8> = r.get(1)?;
            Ok((id, bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Drops vectors of items that no longer exist.
    pub fn prune_embeddings(&self) -> Result<usize> {
        Ok(self.db.execute("DELETE FROM embeddings WHERE item_id NOT IN (SELECT id FROM items)", [])?)
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", [key, value])?;
        Ok(())
    }

    // ------------------------------------------------------------ reads

    pub fn items(&self) -> Result<Vec<Item>> {
        let mut stmt = self.db.prepare(&format!("{SELECT_ITEM} ORDER BY path"))?;
        let rows = stmt.query_map([], row_to_item)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn links(&self) -> Result<Vec<Link>> {
        let mut stmt = self.db.prepare("SELECT src, dst, kind FROM links ORDER BY src, dst")?;
        let rows = stmt.query_map([], |r| Ok(Link { source: r.get(0)?, target: r.get(1)?, kind: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        Ok(self.db.query_row(&format!("{SELECT_ITEM} WHERE id = ?1"), [id], row_to_item).optional()?)
    }

    pub fn path_of(&self, id: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT path FROM items WHERE id = ?1", [id], |r| r.get(0)).optional()?)
    }

    pub fn count(&self) -> Result<i64> {
        Ok(self.db.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))?)
    }

    /// Every tag in use with its count, most used first.
    pub fn tags(&self) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.db.prepare("SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Full-text search (FTS5, bm25; title weighs most). Every word must
    /// match, as a prefix, so "jw wri" finds "Writeup: JWT".
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let Some(q) = fts_query(query) else { return Ok(vec![]) };
        self.search_fts(&q, limit)
    }

    /// Like `search`, but any word may match (for questions in Ask).
    pub fn search_any(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let Some(q) = fts_query_any(query) else { return Ok(vec![]) };
        self.search_fts(&q, limit)
    }

    fn search_fts(&self, q: &str, limit: usize) -> Result<Vec<Hit>> {
        let mut stmt = self.db.prepare(
            "SELECT id, -bm25(items_fts, 0.0, 10.0, 4.0, 1.0, 0.5) AS score,
                    snippet(items_fts, 3, char(1), char(2), '…', 14)
             FROM items_fts WHERE items_fts MATCH ?1 ORDER BY score DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, limit as i64], |r| Ok(Hit { id: r.get(0)?, score: r.get(1)?, snippet: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// Inserts or replaces one item (by path). Two files claiming the same id
/// (e.g. a copied file): the second one gets its path as id instead of
/// clobbering the first.
pub fn upsert(db: &Connection, mut item: Item, (mtime, size): (i64, i64)) -> Result<String> {
    let owner: Option<String> =
        db.query_row("SELECT path FROM items WHERE id = ?1", [&item.id], |r| r.get(0)).optional()?;
    if matches!(&owner, Some(p) if *p != item.path) {
        item.id = item.path.clone();
    }
    remove_path(db, &item.path)?;
    db.execute(
        "INSERT INTO items (id, path, type, lobe, title, tags, fields, body, created, updated, mtime, size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            item.id, item.path, item.kind, item.lobe, item.title,
            serde_json::to_string(&item.tags)?, serde_json::to_string(&item.fields)?, item.body,
            item.created, item.updated, mtime, size
        ],
    )?;
    for t in &item.tags {
        db.execute("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)", params![item.id, t])?;
    }
    db.execute(
        "INSERT INTO items_fts (id, title, tags, body, extra) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![item.id, item.title, item.tags.join(" "), item.body, extra_text(&item.fields)],
    )?;
    Ok(item.id)
}

pub fn remove_path(db: &Connection, path: &str) -> Result<()> {
    let id: Option<String> = db.query_row("SELECT id FROM items WHERE path = ?1", [path], |r| r.get(0)).optional()?;
    if let Some(id) = id {
        db.execute("DELETE FROM items_fts WHERE id = ?1", [&id])?;
        db.execute("DELETE FROM items WHERE id = ?1", [&id])?;
    }
    Ok(())
}

/// Recomputes explicit links from [[wikilinks]] in every body. Targets match
/// case-insensitively by file name, vault-relative path or title.
pub fn rebuild_links(db: &Connection) -> Result<()> {
    let rows: Vec<(String, String, String, String, String)> = {
        let mut stmt = db.prepare("SELECT id, path, title, body, fields FROM items")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let lookup = link_lookup(rows.iter().map(|(id, path, title, _, _)| (id.as_str(), path.as_str(), title.as_str())));
    db.execute("DELETE FROM links WHERE kind = 'explicit'", [])?;
    let mut stmt = db.prepare("INSERT OR IGNORE INTO links (src, dst, kind) VALUES (?1, ?2, 'explicit')")?;
    for (id, _, _, body, fields) in &rows {
        // links in the body, plus links in frontmatter values (e.g. used_in: ["[[Hackemon]]"])
        let fields: Value = serde_json::from_str(fields).unwrap_or(Value::Null);
        let mut targets = md::wikilinks(body);
        targets.extend(md::wikilinks(&extra_text_value(&fields)));
        for target in targets {
            if let Some(t) = resolve(&lookup, &target) {
                if t != id {
                    stmt.execute(params![id, t])?;
                }
            }
        }
    }
    Ok(())
}

fn extra_text_value(v: &Value) -> String {
    match v {
        Value::Object(o) => extra_text(o),
        _ => String::new(),
    }
}

/// lowercase title / file stem / path (no .md) -> id. Titles go in first so
/// file names and paths win on a clash.
pub fn link_lookup<'a>(items: impl Iterator<Item = (&'a str, &'a str, &'a str)> + Clone) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for (id, _, title) in items.clone() {
        m.insert(title.to_lowercase(), id.to_string());
    }
    for (id, path, _) in items {
        let no_ext = path.trim_end_matches(".md");
        m.insert(no_ext.to_lowercase(), id.to_string());
        m.insert(no_ext.rsplit('/').next().unwrap_or(no_ext).to_lowercase(), id.to_string());
    }
    m
}

pub fn resolve<'a>(lookup: &'a HashMap<String, String>, target: &str) -> Option<&'a String> {
    lookup.get(&target.trim_end_matches(".md").to_lowercase())
}

/// Searchable text from type-specific fields (url, summary, stack, …).
fn extra_text(fields: &Map<String, Value>) -> String {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Number(n) => out.push(n.to_string()),
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for v in fields.values() {
        walk(v, &mut out);
    }
    out.join(" ")
}

/// Looser query for questions: any word may match (OR), common words dropped.
pub fn fts_query_any(q: &str) -> Option<String> {
    const STOP: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "have", "how", "i",
        "if", "in", "is", "it", "me", "my", "of", "on", "or", "should", "that", "the", "this", "to", "was", "what", "when",
        "where", "which", "who", "why", "with", "you", "about", "any", "know", "tell",
    ];
    let words: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(|w| w.trim_matches('-').to_lowercase())
        .filter(|w| w.len() > 1 && !STOP.contains(&w.as_str()))
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" OR "))
}

/// User text -> FTS5 query: each word quoted (so punctuation can't break the
/// syntax) and prefix-matched; words are ANDed.
pub fn fts_query(q: &str) -> Option<String> {
    let words: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-' && c != '\'')
        .map(|w| w.trim_matches(|c: char| c == '-' || c == '\'').replace('"', ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

const SELECT_ITEM: &str = "SELECT id, type, lobe, title, tags, body, path, created, updated, fields FROM items";

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let tags: String = r.get(4)?;
    let fields: String = r.get(9)?;
    Ok(Item {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::parse_item;

    fn add(idx: &mut Index, path: &str, text: &str) {
        let stem = path.rsplit('/').next().unwrap().trim_end_matches(".md");
        let item = parse_item(text, path, stem);
        let tx = idx.begin().unwrap();
        upsert(&tx, item, (1, 1)).unwrap();
        rebuild_links(&tx).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn fts_query_is_safe() {
        assert_eq!(fts_query("jwt none-alg").unwrap(), "\"jwt\"* \"none-alg\"*");
        assert_eq!(fts_query("a\"b OR (c)").unwrap(), "\"a\"* \"b\"* \"OR\"* \"c\"*");
        assert!(fts_query("  ?! ").is_none());
    }

    #[test]
    fn search_any_matches_questions() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "notes/Docker.md", "---\nid: d\n---\nContainers per team");
        add(&mut idx, "notes/Other.md", "---\nid: o\n---\nNothing here");
        assert!(idx.search("how do I isolate containers", 5).unwrap().is_empty(), "AND fails on questions");
        assert_eq!(idx.search_any("how do I isolate containers?", 5).unwrap()[0].id, "d");
        assert!(fts_query_any("what is the").is_none());
    }

    #[test]
    fn search_ranks_title_first() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "notes/Writeup JWT.md", "---\nid: a\ntitle: 'Writeup: JWT none-alg bypass'\ntags: [ctf]\n---\nSigned tokens.");
        add(&mut idx, "notes/Other.md", "---\nid: b\n---\nmentions jwt once in the body");
        add(&mut idx, "links/X.md", "---\nid: c\nurl: https://jwt.io\nsummary: token debugger\n---\n");
        let hits = idx.search("jwt", 10).unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>()[0], "a");
        assert_eq!(hits.len(), 3, "matches title, body and fields");
        assert_eq!(idx.search("wri jw", 10).unwrap()[0].id, "a", "prefix + AND");
        assert!(idx.search("body", 10).unwrap()[0].snippet.contains('\u{1}'));
        assert!(idx.search("nothing-here", 10).unwrap().is_empty());
    }

    #[test]
    fn links_resolve_by_title_stem_or_path() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "notes/A.md", "---\nid: a\n---\n[[b title]] [[notes/C]] [[C.md]] [[missing]]");
        add(&mut idx, "notes/B.md", "---\nid: b\ntitle: B title\n---\n");
        add(&mut idx, "notes/C.md", "---\nid: c\n---\n[[A|alias]]");
        let links = idx.links().unwrap();
        let pairs: Vec<_> = links.iter().map(|l| (l.source.as_str(), l.target.as_str())).collect();
        assert_eq!(pairs, vec![("a", "b"), ("a", "c"), ("c", "a")]);
    }

    #[test]
    fn embeddings_round_trip_and_prune() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "notes/A.md", "---\nid: a\n---\n");
        idx.set_embedding("a", "m", "h1", &[0.5, -1.0, 2.25]).unwrap();
        idx.set_embedding("gone", "m", "h2", &[1.0, 0.0, 0.0]).unwrap();
        assert_eq!(idx.embeddings("m").unwrap(), vec![("a".to_string(), vec![0.5, -1.0, 2.25])]);
        assert_eq!(idx.embeddings("other").unwrap().len(), 0);
        assert_eq!(idx.embedding_hashes("m").unwrap().len(), 2);
        assert_eq!(idx.prune_embeddings().unwrap(), 1);
        idx.clear(false).unwrap();
        assert_eq!(idx.embedding_hashes("m").unwrap().len(), 1, "rebuild keeps vectors");
        idx.clear(true).unwrap();
        assert!(idx.embedding_hashes("m").unwrap().is_empty());
    }

    #[test]
    fn frontmatter_links_count() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "skills/Rust.md", "---\nid: s\nused_in: ['[[Brain]]', '[[Missing]]']\n---\n");
        add(&mut idx, "projects/Brain.md", "---\nid: p\n---\n");
        let links = idx.links().unwrap();
        assert_eq!(links.iter().map(|l| (l.source.as_str(), l.target.as_str())).collect::<Vec<_>>(), vec![("s", "p")]);
    }

    #[test]
    fn remove_cascades() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "notes/A.md", "---\nid: a\ntags: [x]\n---\n[[B]]");
        add(&mut idx, "notes/B.md", "---\nid: b\n---\n");
        remove_path(idx.conn(), "notes/B.md").unwrap();
        assert!(idx.links().unwrap().is_empty());
        assert!(idx.search("b", 5).unwrap().iter().all(|h| h.id != "b"));
        assert_eq!(idx.tags().unwrap(), vec![("x".to_string(), 1)]);
    }
}
