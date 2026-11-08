//! SQLite index over the vault (app data dir, `brain.db`). Only a cache:
//! everything here can be rebuilt from the files.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::Result;
use crate::markdown as md;
use crate::vault::Item;

const SCHEMA_VERSION: i32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub source: String,
    pub target: String,
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
                 DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS meta;",
            )?;
        }
        self.db.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS items (
               id      TEXT PRIMARY KEY,   -- vault-relative path
               type    TEXT NOT NULL,      -- note | canvas
               title   TEXT NOT NULL,      -- file name without extension
               tags    TEXT NOT NULL,      -- JSON array (frontmatter)
               inline_tags TEXT NOT NULL,  -- JSON array (#tags in the body)
               fields  TEXT NOT NULL,      -- JSON object: other properties
               body    TEXT NOT NULL,
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
               PRIMARY KEY (src, dst)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
               id UNINDEXED, title, tags, body, extra, tokenize = 'unicode61 remove_diacritics 2'
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

    pub fn begin(&mut self) -> Result<rusqlite::Transaction<'_>> {
        Ok(self.db.transaction()?)
    }

    /// (mtime, size) of every indexed path.
    pub fn stamps(&self) -> Result<HashMap<String, (i64, i64)>> {
        let mut stmt = self.db.prepare("SELECT id, mtime, size FROM items")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn clear(&mut self) -> Result<()> {
        self.db.execute_batch("DELETE FROM items; DELETE FROM items_fts;")?;
        Ok(())
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
        let mut stmt = self.db.prepare(&format!("{SELECT_ITEM} ORDER BY id"))?;
        let rows = stmt.query_map([], row_to_item)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn links(&self) -> Result<Vec<Link>> {
        let mut stmt = self.db.prepare("SELECT src, dst FROM links ORDER BY src, dst")?;
        let rows = stmt.query_map([], |r| Ok(Link { source: r.get(0)?, target: r.get(1)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        Ok(self.db.query_row(&format!("{SELECT_ITEM} WHERE id = ?1"), [id], row_to_item).optional()?)
    }

    /// Every tag in use with its count, most used first.
    pub fn tags(&self) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.db.prepare("SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Full-text search (FTS5, bm25; file name weighs most). Every word must
    /// match, as a prefix, so "jw wri" finds "Writeup JWT".
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let Some(q) = fts_query(query) else { return Ok(vec![]) };
        let mut stmt = self.db.prepare(
            "SELECT id, -bm25(items_fts, 0.0, 10.0, 4.0, 1.0, 0.5) AS score,
                    snippet(items_fts, 3, char(1), char(2), '…', 14)
             FROM items_fts WHERE items_fts MATCH ?1 ORDER BY score DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, limit as i64], |r| Ok(Hit { id: r.get(0)?, score: r.get(1)?, snippet: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// Inserts or replaces one item.
pub fn upsert(db: &Connection, item: Item, (mtime, size): (i64, i64)) -> Result<()> {
    remove_path(db, &item.id)?;
    db.execute(
        "INSERT INTO items (id, type, title, tags, inline_tags, fields, body, mtime, size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item.id, item.kind, item.title, serde_json::to_string(&item.tags)?, serde_json::to_string(&item.inline_tags)?,
            serde_json::to_string(&item.fields)?, item.body, mtime, size
        ],
    )?;
    for t in &item.all_tags() {
        db.execute("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)", params![item.id, t])?;
    }
    db.execute(
        "INSERT INTO items_fts (id, title, tags, body, extra) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![item.id, item.title, item.all_tags().join(" "), item.body, extra_text(&item.fields)],
    )?;
    Ok(())
}

pub fn remove_path(db: &Connection, path: &str) -> Result<()> {
    db.execute("DELETE FROM items_fts WHERE id = ?1", [path])?;
    db.execute("DELETE FROM items WHERE id = ?1", [path])?;
    Ok(())
}

/// Recomputes links from [[wikilinks]] in every body and in property values.
pub fn rebuild_links(db: &Connection) -> Result<()> {
    let rows: Vec<(String, String, String)> = {
        let mut stmt = db.prepare("SELECT id, body, fields FROM items")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut lookup = link_lookup(rows.iter().map(|(id, ..)| id.as_str()));
    // Obsidian `aliases:` also resolve [[links]] (a real file name wins on a clash)
    for (id, _, fields) in &rows {
        let fields: Value = serde_json::from_str(fields).unwrap_or(Value::Null);
        for alias in aliases(&fields) {
            lookup.entry(alias.to_lowercase()).or_insert_with(|| id.clone());
        }
    }
    db.execute("DELETE FROM links", [])?;
    let mut stmt = db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?1, ?2)")?;
    for (id, body, fields) in &rows {
        let fields: Value = serde_json::from_str(fields).unwrap_or(Value::Null);
        let mut targets = md::wikilinks(body);
        if let Value::Object(o) = &fields {
            targets.extend(md::wikilinks(&extra_text(o)));
        }
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

/// `aliases:` / `alias:` from frontmatter, as a YAML list or a single string.
pub fn aliases(fields: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["aliases", "alias"] {
        match fields.get(key) {
            Some(Value::String(s)) => out.extend(s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty())),
            Some(Value::Array(a)) => out.extend(a.iter().filter_map(Value::as_str).map(|x| x.trim().to_string()).filter(|x| !x.is_empty())),
            _ => {}
        }
    }
    out
}

/// lowercase file name / path (".md" dropped) -> path. Like Obsidian, when two
/// files share a name, a bare [[Name]] goes to the one nearest the vault root.
pub fn link_lookup<'a>(paths: impl Iterator<Item = &'a str>) -> HashMap<String, String> {
    let mut paths: Vec<&str> = paths.collect();
    // deepest first, so shallower paths overwrite them
    paths.sort_by(|a, b| b.matches('/').count().cmp(&a.matches('/').count()).then(b.cmp(a)));
    let mut m = HashMap::new();
    for p in paths {
        let no_ext = p.strip_suffix(".md").unwrap_or(p);
        m.insert(no_ext.to_lowercase(), p.to_string());
        m.insert(no_ext.rsplit('/').next().unwrap_or(no_ext).to_lowercase(), p.to_string());
    }
    m
}

pub fn resolve<'a>(lookup: &'a HashMap<String, String>, target: &str) -> Option<&'a String> {
    let t = target.trim();
    lookup.get(&t.strip_suffix(".md").unwrap_or(t).to_lowercase())
}

/// Searchable text from properties.
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

const SELECT_ITEM: &str = "SELECT id, type, title, tags, inline_tags, fields, body FROM items";

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let id: String = r.get(0)?;
    Ok(Item {
        path: id.clone(),
        id,
        kind: r.get(1)?,
        title: r.get(2)?,
        tags: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        inline_tags: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
        fields: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        body: r.get(6)?,
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
    fn pairs(idx: &Index) -> Vec<(String, String)> {
        idx.links().unwrap().into_iter().map(|l| (l.source, l.target)).collect()
    }

    #[test]
    fn fts_query_is_safe() {
        assert_eq!(fts_query("jwt none-alg").unwrap(), "\"jwt\"* \"none-alg\"*");
        assert_eq!(fts_query("a\"b OR (c)").unwrap(), "\"a\"* \"b\"* \"OR\"* \"c\"*");
        assert!(fts_query("  ?! ").is_none());
    }

    #[test]
    fn search_ranks_file_name_first() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "CTF/Writeup JWT.md", "---\ntags: [ctf]\n---\nSigned tokens.");
        add(&mut idx, "Other.md", "mentions jwt once in the body");
        add(&mut idx, "Links/X.md", "---\nurl: https://jwt.io\n---\n");
        let hits = idx.search("jwt", 10).unwrap();
        assert_eq!(hits[0].id, "CTF/Writeup JWT.md");
        assert_eq!(hits.len(), 3, "matches name, body and properties");
        assert_eq!(idx.search("wri jw", 10).unwrap()[0].id, "CTF/Writeup JWT.md", "prefix + AND");
        assert!(idx.search("body", 10).unwrap()[0].snippet.contains('\u{1}'));
        assert!(idx.search("nothing-here", 10).unwrap().is_empty());
    }

    #[test]
    fn links_resolve_like_obsidian() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "A.md", "[[b]] [[Deep/C]] [[C.md]] [[missing]] [[A]] [[B#Heading|x]]");
        add(&mut idx, "Folder/B.md", "---\ntitle: Something else\n---\n");
        add(&mut idx, "Deep/C.md", "[[A|alias]]");
        assert_eq!(pairs(&idx), vec![("A.md".into(), "Deep/C.md".into()), ("A.md".into(), "Folder/B.md".into()), ("Deep/C.md".into(), "A.md".into())]);
        // same name in two folders: the shallower one wins a bare [[Name]]
        add(&mut idx, "X/Y/Dup.md", "");
        add(&mut idx, "X/Dup.md", "");
        add(&mut idx, "Uses dup.md", "[[Dup]] [[X/Y/Dup]]");
        let from: Vec<String> = pairs(&idx).into_iter().filter(|(s, _)| s == "Uses dup.md").map(|(_, t)| t).collect();
        assert_eq!(from, vec!["X/Dup.md", "X/Y/Dup.md"]);
    }

    #[test]
    fn property_links_and_aliases_count() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "Rust.md", "---\nused_in: ['[[Brain]]', '[[Missing]]']\n---\n[[the brain]]");
        add(&mut idx, "Brain.md", "---\naliases: [the brain]\n---\n");
        assert_eq!(pairs(&idx), vec![("Rust.md".into(), "Brain.md".into())]);
    }

    #[test]
    fn remove_cascades() {
        let mut idx = Index::memory().unwrap();
        add(&mut idx, "A.md", "---\ntags: [x]\n---\n[[B]]");
        add(&mut idx, "B.md", "");
        remove_path(idx.conn(), "B.md").unwrap();
        assert!(idx.links().unwrap().is_empty());
        assert_eq!(idx.tags().unwrap(), vec![("x".to_string(), 1)]);
        add(&mut idx, "C.md", "---\ntags: [x]\n---\nInline #y and #x");
        assert_eq!(idx.tags().unwrap(), vec![("x".to_string(), 2), ("y".to_string(), 1)], "inline #tags count");
        assert_eq!(idx.search("y", 5).unwrap()[0].id, "C.md");
    }
}
