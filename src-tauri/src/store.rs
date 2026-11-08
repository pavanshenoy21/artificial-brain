//! The storage service: vault (files, source of truth) + index (SQLite cache).
//! Every write goes to a file first, then the index is updated from that file.
//!
//! Identity is the vault-relative path, as in Obsidian. Anything that moves a
//! file (rename, move, folder rename) returns the new path(s) so the UI can
//! follow, and rewrites links that pointed at the old place.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::canvas;
use crate::error::{err, Error, Result};
use crate::index::{self, Hit, Index, Link};
use crate::markdown as md;
use crate::vault::{self, file_stamp, stem_of, Item, Vault};

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<Item>,
    /// Every folder, empty ones too (the file explorer shows them).
    pub folders: Vec<String>,
    pub links: Vec<Link>,
    /// Colours picked for lobes (top-level folders) and folders.
    pub colors: Colors,
}

/// `.brain/colors.json`: folder path -> colour (`#rrggbb`). A top-level folder's
/// colour is its lobe's label colour; a subfolder's colour is used for every
/// note in it. Folders without an entry get one from the palette in the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Colors {
    pub folders: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct SyncReport {
    pub scanned: usize,
    pub updated: usize,
    pub removed: usize,
}

impl SyncReport {
    pub fn changed(&self) -> bool {
        self.updated + self.removed > 0
    }
}

/// A file for "Import sample data".
#[derive(Debug, Deserialize)]
pub struct SampleFile {
    pub path: String,
    pub content: String,
}

/// (old path, new path) of every file a call moved.
pub type Moved = Vec<(String, String)>;

pub struct Store {
    pub vault: Vault,
    pub index: Index,
}

impl Store {
    pub fn open(vault_dir: impl Into<PathBuf>, db_path: &Path) -> Result<Self> {
        let mut store = Store { vault: Vault::open(vault_dir)?, index: Index::open(db_path)? };
        // The index may belong to a different vault (vault switched): start clean.
        let root = store.vault.root().to_string_lossy().into_owned();
        if store.index.meta("vault")?.as_deref() != Some(root.as_str()) {
            store.index.clear()?;
            store.index.set_meta("vault", &root)?;
        }
        store.sync()?;
        Ok(store)
    }

    // ------------------------------------------------------------ sync

    /// Brings the index in line with the files. Unchanged files (same mtime +
    /// size) are skipped, so this is cheap to call often (the watcher does).
    pub fn sync(&mut self) -> Result<SyncReport> {
        let files = self.vault.files()?;
        let known = self.index.stamps()?;
        let seen: HashSet<String> = files.iter().map(|f| self.vault.rel(f)).collect();
        let mut report = SyncReport { scanned: files.len(), ..Default::default() };

        let mut changed = Vec::new();
        for file in &files {
            let stamp = file_stamp(file)?;
            if known.get(&self.vault.rel(file)) != Some(&stamp) {
                changed.push((file.clone(), stamp));
            }
        }
        let tx = self.index.begin()?;
        for path in known.keys().filter(|p| !seen.contains(*p)) {
            index::remove_path(&tx, path)?;
            report.removed += 1;
        }
        for (file, stamp) in changed {
            // unreadable files (permissions, bad UTF-8) are skipped, not fatal
            match self.vault.read(&file) {
                Ok(item) => {
                    index::upsert(&tx, item, stamp)?;
                    report.updated += 1;
                }
                Err(e) => eprintln!("skipping {}: {e}", file.display()),
            }
        }
        if report.changed() {
            index::rebuild_links(&tx)?;
        }
        tx.commit()?;
        Ok(report)
    }

    /// Drops the whole index and rebuilds it from the files.
    pub fn rebuild(&mut self) -> Result<SyncReport> {
        self.index.clear()?;
        self.sync()
    }

    // ------------------------------------------------------------ reads

    pub fn graph(&self) -> Result<Graph> {
        Ok(Graph { nodes: self.index.items()?, folders: self.folders()?, links: self.index.links()?, colors: self.colors() })
    }

    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        self.index.get(id)
    }

    pub fn tags(&self) -> Result<Vec<(String, i64)>> {
        self.index.tags()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        self.index.search(query, limit)
    }

    // ------------------------------------------------------------ colours

    fn colors_file(&self) -> PathBuf {
        self.vault.root().join(".brain").join("colors.json")
    }

    pub fn colors(&self) -> Colors {
        std::fs::read_to_string(self.colors_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Sets (or with `None` clears) one folder's colour.
    pub fn set_color(&mut self, folder: &str, color: Option<&str>) -> Result<Colors> {
        let folder = safe_rel(folder)?;
        let mut c = self.colors();
        match color {
            Some(col) if is_hex_color(col) => {
                c.folders.insert(folder, col.to_lowercase());
            }
            Some(col) => return err(format!("not a colour: {col:?}")),
            None => {
                c.folders.remove(&folder);
            }
        }
        self.save_colors(&c)?;
        Ok(c)
    }

    fn save_colors(&self, c: &Colors) -> Result<()> {
        let f = self.colors_file();
        if let Some(dir) = f.parent() {
            std::fs::create_dir_all(dir)?;
        }
        vault::write_atomic(&f, &(serde_json::to_string_pretty(c)? + "\n"))
    }

    /// A renamed or moved folder keeps its colours (and its subfolders' colours).
    fn move_colors(&self, from: &str, to: &str) -> Result<()> {
        let mut c = self.colors();
        let moved: Vec<(String, String)> = c
            .folders
            .iter()
            .filter(|(k, _)| *k == from || k.starts_with(&format!("{from}/")))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if moved.is_empty() {
            return Ok(());
        }
        for (k, v) in moved {
            c.folders.remove(&k);
            c.folders.insert(format!("{to}{}", &k[from.len()..]), v);
        }
        self.save_colors(&c)
    }

    // ------------------------------------------------------------ notes

    /// A new note: `{ title?, body?, folder? }`. Like Obsidian, the default name
    /// is "Untitled" (then "Untitled 1", …) and the default place the vault root.
    pub fn create(&mut self, mut input: Map<String, Value>) -> Result<Item> {
        let folder = folder_arg(input.remove("folder"))?;
        let title = input.remove("title").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        let title = if title.trim().is_empty() { "Untitled".to_string() } else { title };
        let dir = folder.map(|f| self.vault.abs(&f)).unwrap_or_else(|| self.vault.root().to_path_buf());
        let file = self.vault.unique_path(&dir, &md::file_stem_for(&title), "md", None);
        let mut item = vault::parse_item("", &self.vault.rel(&file), &stem_of(&file));
        apply_patch(&mut item, input)?;
        self.vault.write(&file, &item)?;
        self.reindex(std::slice::from_ref(&file), &[])?;
        self.get(&item.id)?.ok_or_else(|| Error("note vanished after create".into()))
    }

    /// Partial update: `{ title?, body?, tags?, props?: { name: value | null } }`.
    /// The file is re-read first so edits made outside the app aren't lost.
    /// A new title renames the file (in its folder) and rewrites [[links]] to it.
    /// Returns the item (with its new path if it was renamed).
    pub fn update(&mut self, id: &str, mut patch: Map<String, Value>) -> Result<Item> {
        let old_file = self.file_of(id)?;
        let title = patch.remove("title").and_then(|v| v.as_str().map(|s| s.trim().to_string()));
        if canvas::is_canvas(&old_file) {
            if patch.keys().any(|k| !IGNORED.contains(&k.as_str())) {
                return err("a canvas has no properties; only its name can change");
            }
        } else if !patch.is_empty() {
            let mut item = self.vault.read(&old_file)?;
            apply_patch(&mut item, patch)?;
            self.vault.write(&old_file, &item)?;
            self.reindex(std::slice::from_ref(&old_file), &[])?;
        }
        match title {
            Some(t) if t.is_empty() => err("the name can't be empty"),
            Some(t) if t != stem_of(&old_file) => {
                let moved = self.rename_file(&old_file, &t)?;
                let new = moved.first().map(|(_, n)| n.clone()).unwrap_or_else(|| id.to_string());
                self.get(&new)?.ok_or_else(|| Error("note vanished after rename".into()))
            }
            _ => self.get(id)?.ok_or_else(|| Error("note vanished after update".into())),
        }
    }

    fn rename_file(&mut self, old_file: &Path, title: &str) -> Result<Moved> {
        let ext = ext_of(old_file);
        let dir = old_file.parent().unwrap_or(self.vault.root()).to_path_buf();
        let file = self.vault.unique_path(&dir, &md::file_stem_for(title), &ext, Some(old_file));
        if file == old_file {
            return Ok(vec![]);
        }
        std::fs::rename(old_file, &file)?;
        let old_rel = self.vault.rel(old_file);
        let new_rel = self.vault.rel(&file);
        // links by name ([[Old]], [[Old.canvas]]) and by path ([[Folder/Old]])
        let (old_stem, new_stem) = (stem_of(old_file), stem_of(&file));
        let mut pairs = if ext == "md" {
            vec![(old_stem, new_stem)]
        } else {
            vec![(format!("{old_stem}.{ext}"), format!("{new_stem}.{ext}"))]
        };
        let moves = vec![(old_rel, new_rel)];
        self.finish_moves(&moves, &mut pairs)?;
        Ok(moves)
    }

    /// Moves the file to `.trash/` and drops it from the index.
    pub fn delete(&mut self, id: &str) -> Result<()> {
        let file = self.file_of(id)?;
        self.vault.trash(&file)?;
        self.reindex(&[], &[id.to_string()])
    }

    /// Writes the sample vault (files that already exist are left alone).
    pub fn import(&mut self, files: Vec<SampleFile>) -> Result<usize> {
        let mut n = 0;
        for f in files {
            let rel = safe_rel(&f.path)?;
            let abs = self.vault.abs(&rel);
            if abs.exists() {
                continue;
            }
            if let Some(dir) = abs.parent() {
                std::fs::create_dir_all(dir)?;
            }
            vault::write_atomic(&abs, &f.content)?;
            n += 1;
        }
        self.sync()?;
        Ok(n)
    }

    // ------------------------------------------------------------ folders

    /// Every folder in the vault (dot-folders skipped), empty ones included.
    pub fn folders(&self) -> Result<Vec<String>> {
        fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) -> Result<()> {
            for e in std::fs::read_dir(dir)? {
                let e = e?;
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !e.file_type()?.is_dir() {
                    continue;
                }
                let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                walk(&e.path(), &r, out)?;
                out.push(r);
            }
            Ok(())
        }
        let mut out = Vec::new();
        walk(self.vault.root(), "", &mut out)?;
        out.sort();
        Ok(out)
    }

    pub fn create_folder(&mut self, path: &str) -> Result<String> {
        let rel = safe_rel(path)?;
        let dir = self.vault.abs(&rel);
        if dir.exists() {
            return err(format!("\"{rel}\" already exists"));
        }
        std::fs::create_dir_all(&dir)?;
        Ok(rel)
    }

    /// Renames or moves a folder (`to` is its new vault-relative path).
    /// Path-style [[links]], canvas cards and colours that pointed inside it follow.
    pub fn rename_folder(&mut self, from: &str, to: &str) -> Result<Moved> {
        let (from, to) = (safe_rel(from)?, safe_rel(to)?);
        let (src, dst) = (self.vault.abs(&from), self.vault.abs(&to));
        if !src.is_dir() {
            return err(format!("no folder \"{from}\""));
        }
        if from == to {
            return Ok(vec![]);
        }
        if to.starts_with(&format!("{from}/")) {
            return err("a folder can't be moved into itself");
        }
        // case-only renames ("Notes" -> "notes") are fine on case-insensitive disks
        if dst.exists() && from.to_lowercase() != to.to_lowercase() {
            return err(format!("\"{to}\" already exists"));
        }
        let inside = self.paths_under(&from)?;
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&src, &dst)?;
        self.move_colors(&from, &to)?;
        let moves: Moved = inside.into_iter().map(|p| (p.clone(), format!("{to}{}", &p[from.len()..]))).collect();
        self.finish_moves(&moves, &mut vec![])?;
        Ok(moves)
    }

    /// Moves a folder and everything in it to `.trash/` (never hard-deleted).
    pub fn delete_folder(&mut self, path: &str) -> Result<()> {
        let rel = safe_rel(path)?;
        let dir = self.vault.abs(&rel);
        if !dir.is_dir() {
            return err(format!("no folder \"{rel}\""));
        }
        let gone = self.paths_under(&rel)?;
        self.vault.trash(&dir)?;
        self.reindex(&[], &gone)
    }

    /// Moves a note or canvas into `folder` ("" = the vault root), keeping its name.
    pub fn move_item(&mut self, id: &str, folder: &str) -> Result<Moved> {
        let file = self.file_of(id)?;
        let dir = match folder_arg(Some(Value::String(folder.into())))? {
            Some(f) => self.vault.abs(&f),
            None => self.vault.root().to_path_buf(),
        };
        if file.parent() == Some(dir.as_path()) {
            return Ok(vec![]);
        }
        std::fs::create_dir_all(&dir)?;
        let dest = self.vault.unique_path(&dir, &stem_of(&file), &ext_of(&file), None);
        std::fs::rename(&file, &dest)?;
        let moves = vec![(self.vault.rel(&file), self.vault.rel(&dest))];
        // a name change ("Note 1") is also a rename for [[Note]] links
        let mut pairs = vec![];
        if stem_of(&file) != stem_of(&dest) {
            pairs.push((stem_of(&file), stem_of(&dest)));
        }
        self.finish_moves(&moves, &mut pairs)?;
        Ok(moves)
    }

    fn paths_under(&self, folder: &str) -> Result<Vec<String>> {
        let prefix = format!("{folder}/");
        Ok(self.index.items()?.into_iter().map(|i| i.id).filter(|p| p.starts_with(&prefix)).collect())
    }

    /// After files moved on disk: rewrite path-style [[links]] (plus the
    /// name pairs given) everywhere, point canvas file cards at the new
    /// paths, and reindex.
    fn finish_moves(&mut self, moves: &[(String, String)], pairs: &mut Vec<(String, String)>) -> Result<()> {
        for (o, n) in moves {
            if let (Some(a), Some(b)) = (o.strip_suffix(".md"), n.strip_suffix(".md")) {
                pairs.push((a.to_string(), b.to_string()));
            }
            pairs.push((o.clone(), n.clone()));
        }
        let mut touched: Vec<PathBuf> = moves.iter().map(|(_, n)| self.vault.abs(n)).collect();
        touched.extend(self.rewrite_links(moves, pairs)?);
        touched.sort();
        touched.dedup();
        touched.retain(|f| f.is_file());
        let removed: Vec<String> = moves.iter().map(|(o, _)| o.clone()).collect();
        self.reindex(&touched, &removed)
    }

    /// Rewrites [[old]] → [[new]] for each pair in every note, and file cards +
    /// text cards in every canvas. Returns the files that changed.
    fn rewrite_links(&self, moves: &[(String, String)], pairs: &[(String, String)]) -> Result<Vec<PathBuf>> {
        let mut changed = Vec::new();
        for file in self.vault.files()? {
            let text = std::fs::read_to_string(&file)?;
            let out = if canvas::is_canvas(&file) {
                canvas::rewrite_for_rename(&text, moves, pairs)
            } else {
                let mut out = text.clone();
                for (old, new) in pairs {
                    out = md::rename_wikilinks(&out, old, new);
                }
                (out != text).then_some(out)
            };
            if let Some(out) = out {
                vault::write_atomic(&file, &out)?;
                changed.push(file);
            }
        }
        Ok(changed)
    }

    // ------------------------------------------------------------ canvases

    /// A new, empty canvas ("Untitled.canvas" in the root by default).
    pub fn create_canvas(&mut self, title: &str, folder: Option<&str>) -> Result<Item> {
        let title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
        let dir = match folder_arg(folder.map(|f| Value::String(f.into())))? {
            Some(f) => self.vault.abs(&f),
            None => self.vault.root().to_path_buf(),
        };
        std::fs::create_dir_all(&dir)?;
        let file = self.vault.unique_path(&dir, &md::file_stem_for(title), canvas::EXT, None);
        vault::write_atomic(&file, &canvas::render(&canvas::empty())?)?;
        self.reindex(std::slice::from_ref(&file), &[])?;
        let rel = self.vault.rel(&file);
        self.get(&rel)?.ok_or_else(|| Error("canvas vanished after create".into()))
    }

    /// The canvas JSON as stored (unknown keys included).
    pub fn get_canvas(&self, id: &str) -> Result<Value> {
        let file = self.file_of(id)?;
        if !canvas::is_canvas(&file) {
            return err("not a canvas");
        }
        let text = std::fs::read_to_string(&file)?;
        serde_json::from_str(&text).map_err(|e| Error(format!("this canvas file isn't valid JSON ({e}); fix it in a text editor")))
    }

    pub fn save_canvas(&mut self, id: &str, data: Value) -> Result<Item> {
        let file = self.file_of(id)?;
        if !canvas::is_canvas(&file) {
            return err("not a canvas");
        }
        canvas::validate(&data)?;
        vault::write_atomic(&file, &canvas::render(&data)?)?;
        self.reindex(std::slice::from_ref(&file), &[])?;
        self.get(id)?.ok_or_else(|| Error("canvas vanished after save".into()))
    }

    // ------------------------------------------------------------ helpers

    /// Re-reads files the store just wrote (rather than trusting mtimes,
    /// which can be too coarse to notice a quick rewrite).
    fn reindex(&mut self, files: &[PathBuf], removed_paths: &[String]) -> Result<()> {
        let items: Vec<_> = files.iter().map(|f| Ok((self.vault.read(f)?, file_stamp(f)?))).collect::<Result<_>>()?;
        let tx = self.index.begin()?;
        for p in removed_paths {
            index::remove_path(&tx, p)?;
        }
        for (item, stamp) in items {
            index::upsert(&tx, item, stamp)?;
        }
        index::rebuild_links(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn file_of(&self, id: &str) -> Result<PathBuf> {
        let rel = safe_rel(id)?;
        let f = self.vault.abs(&rel);
        if f.is_file() {
            Ok(f)
        } else {
            err(format!("no file \"{id}\""))
        }
    }
}

/// Keys the UI may send back that aren't properties.
const IGNORED: &[&str] = &["id", "path", "type", "title", "degree", "inline_tags"];

fn ext_of(file: &Path) -> String {
    file.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "md".into())
}

fn is_hex_color(c: &str) -> bool {
    let h = c.strip_prefix('#').unwrap_or("");
    (h.len() == 6 || h.len() == 3) && h.chars().all(|x| x.is_ascii_hexdigit())
}

/// A vault-relative path from the UI: no absolute paths, `..` or dot-folders.
fn safe_rel(p: &str) -> Result<String> {
    let parts: Vec<&str> = p.split(['/', '\\']).map(str::trim).filter(|x| !x.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|x| x.starts_with('.') || x.contains(':')) {
        return err(format!("bad path {p:?}"));
    }
    Ok(parts.join("/"))
}

/// Optional folder argument: missing or "" = the vault root.
fn folder_arg(v: Option<Value>) -> Result<Option<String>> {
    match v {
        Some(Value::String(f)) if !f.trim().is_empty() && f.trim() != "/" => Ok(Some(safe_rel(&f)?)),
        _ => Ok(None),
    }
}

fn apply_patch(item: &mut Item, patch: Map<String, Value>) -> Result<()> {
    for (k, v) in patch {
        match k.as_str() {
            "tags" => item.tags = md::normalize_tags(Some(&v)),
            "body" => item.body = v.as_str().unwrap_or_default().trim_end().to_string(),
            "props" => {
                let Value::Object(props) = v else { return err("props must be an object") };
                for (name, value) in props {
                    if name == "tags" {
                        item.tags = md::normalize_tags(Some(&value));
                    } else if value.is_null() {
                        item.fields.remove(&name);
                    } else {
                        item.fields.insert(name, value);
                    }
                }
            }
            k if IGNORED.contains(&k) => {}
            _ => return err(format!("unknown field {k:?} (properties go in `props`)")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    pub struct Tmp(pub PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    pub fn setup() -> (Tmp, Store) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("brain-store-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::open(dir.join("vault"), &dir.join("brain.db")).unwrap();
        (Tmp(dir), store)
    }
    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn read(s: &Store, p: &str) -> String {
        fs::read_to_string(s.vault.abs(p)).unwrap()
    }

    #[test]
    fn new_notes_are_plain_files_named_untitled() {
        let (_t, mut s) = setup();
        let a = s.create(obj(json!({}))).unwrap();
        let b = s.create(obj(json!({}))).unwrap();
        let c = s.create(obj(json!({ "title": "Exam: OS?", "body": "Hi", "folder": "Uni/Sem 3" }))).unwrap();
        assert_eq!((a.id.as_str(), b.id.as_str()), ("Untitled.md", "Untitled 1.md"));
        assert_eq!(read(&s, "Untitled.md"), "", "no frontmatter, no ids, no timestamps");
        assert_eq!(c.path, "Uni/Sem 3/Exam OS.md");
        assert_eq!(read(&s, "Uni/Sem 3/Exam OS.md"), "Hi\n");
        assert!(s.create(obj(json!({ "folder": "../out" }))).is_err());
        assert!(s.create(obj(json!({ "folder": ".obsidian" }))).is_err());
    }

    #[test]
    fn update_body_tags_properties() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "N" }))).unwrap();
        s.update(&n.id, obj(json!({ "body": "Hello #x", "tags": ["a"], "props": { "status": "draft" } }))).unwrap();
        assert_eq!(read(&s, "N.md"), "---\nstatus: draft\ntags:\n- a\n---\n\nHello #x\n");
        let it = s.update(&n.id, obj(json!({ "props": { "status": null }, "tags": [] }))).unwrap();
        assert_eq!(read(&s, "N.md"), "Hello #x\n");
        assert_eq!(it.inline_tags, vec!["x"]);
        assert_eq!(s.tags().unwrap(), vec![("x".to_string(), 1)]);
        // properties named like the app's own fields are just properties
        fs::write(s.vault.abs("Old.md"), "---\nid: 01ABC\ntitle: Something\ntype: skill\n---\nBody\n").unwrap();
        s.sync().unwrap();
        let old = s.get("Old.md").unwrap().unwrap();
        assert_eq!((old.id.as_str(), old.title.as_str(), old.kind.as_str()), ("Old.md", "Old", "note"));
        assert_eq!(serde_json::to_value(&old).unwrap()["props"]["id"], "01ABC");
        s.update("Old.md", obj(json!({ "props": { "id": null, "type": null, "title": null } }))).unwrap();
        assert_eq!(read(&s, "Old.md"), "Body\n");
        assert!(s.update("Old.md", obj(json!({ "status": "x" }))).is_err(), "properties must go in props");
    }

    #[test]
    fn rename_moves_the_file_and_rewrites_links() {
        let (_t, mut s) = setup();
        let docker = s.create(obj(json!({ "title": "Docker", "folder": "Tools" }))).unwrap();
        let a = s.create(obj(json!({ "title": "A", "body": "[[Docker]] [[Docker#Volumes|vols]] [[Tools/Docker]] [[Dockerfile]]" }))).unwrap();
        let r = s.update(&docker.id, obj(json!({ "title": "Containers" }))).unwrap();
        assert_eq!(r.id, "Tools/Containers.md");
        assert!(!s.vault.abs("Tools/Docker.md").exists());
        assert_eq!(read(&s, &a.id), "[[Containers]] [[Containers#Volumes|vols]] [[Tools/Containers]] [[Dockerfile]]\n");
        assert_eq!(s.graph().unwrap().links, vec![Link { source: "A.md".into(), target: "Tools/Containers.md".into() }]);
        // a name that's taken gets a number, like Obsidian
        s.create(obj(json!({ "title": "Taken", "folder": "Tools" }))).unwrap();
        assert_eq!(s.update(&r.id, obj(json!({ "title": "Taken" }))).unwrap().id, "Tools/Taken 1.md");
        assert!(s.update("Tools/Taken 1.md", obj(json!({ "title": "  " }))).is_err());
    }

    #[test]
    fn folders_create_rename_move_delete() {
        let (_t, mut s) = setup();
        s.create_folder("Uni/Empty").unwrap();
        assert!(s.create_folder("Uni/Empty").is_err());
        let os = s.create(obj(json!({ "title": "OS", "folder": "Uni/Sem 3" }))).unwrap();
        let board = s.create_canvas("Board", None).unwrap();
        s.save_canvas(&board.id, json!({ "nodes": [{ "id": "f", "type": "file", "file": os.path, "x": 0, "y": 0, "width": 1, "height": 1 }], "edges": [] })).unwrap();
        s.create(obj(json!({ "title": "Index", "body": "[[Uni/Sem 3/OS]] and [[OS]]" }))).unwrap();
        assert_eq!(s.graph().unwrap().folders, vec!["Uni", "Uni/Empty", "Uni/Sem 3"]);
        s.set_color("Uni/Sem 3", Some("#E06C75")).unwrap();

        let moved = s.rename_folder("Uni/Sem 3", "College/Sem 3").unwrap();
        assert_eq!(moved, vec![("Uni/Sem 3/OS.md".to_string(), "College/Sem 3/OS.md".to_string())]);
        assert_eq!(read(&s, "Index.md"), "[[College/Sem 3/OS]] and [[OS]]\n");
        assert_eq!(s.get_canvas(&board.id).unwrap()["nodes"][0]["file"], "College/Sem 3/OS.md");
        assert!(s.get("College/Sem 3/OS.md").unwrap().is_some() && s.get("Uni/Sem 3/OS.md").unwrap().is_none());
        assert_eq!(s.colors().folders.get("College/Sem 3").map(String::as_str), Some("#e06c75"), "colour follows the folder");
        assert!(s.rename_folder("College", "College/inside").is_err());
        assert!(s.rename_folder("College", "Uni").is_err(), "target exists");

        let moved = s.move_item("College/Sem 3/OS.md", "").unwrap();
        assert_eq!(moved[0].1, "OS.md");
        assert_eq!(read(&s, "Index.md"), "[[OS]] and [[OS]]\n");
        s.move_item("OS.md", "Uni/Empty").unwrap();
        assert_eq!(s.get_canvas(&board.id).unwrap()["nodes"][0]["file"], "Uni/Empty/OS.md");

        s.delete_folder("Uni").unwrap();
        assert!(s.vault.abs(".trash/Uni/Empty/OS.md").is_file());
        assert!(s.get("Uni/Empty/OS.md").unwrap().is_none());
        assert!(!s.graph().unwrap().folders.iter().any(|f| f.starts_with("Uni")));
    }

    #[test]
    fn colours_are_validated_and_cleared() {
        let (_t, mut s) = setup();
        assert!(s.set_color("Club", Some("red")).is_err());
        assert!(s.set_color("../x", Some("#fff")).is_err());
        s.set_color("Club", Some("#ABCDEF")).unwrap();
        assert_eq!(s.graph().unwrap().colors.folders["Club"], "#abcdef");
        s.set_color("Club", None).unwrap();
        assert!(s.colors().folders.is_empty());
    }

    #[test]
    fn canvases_are_items_linked_to_their_cards() {
        let (_t, mut s) = setup();
        let docker = s.create(obj(json!({ "title": "Docker" }))).unwrap();
        let c = s.create_canvas("Week plan", Some("Plans")).unwrap();
        assert_eq!((c.kind.as_str(), c.id.as_str()), ("canvas", "Plans/Week plan.canvas"));
        let data = json!({
            "nodes": [
                {"id": "t", "type": "text", "text": "Ship the zebra demo, see [[Docker]]", "x": 0, "y": 0, "width": 250, "height": 60},
                {"id": "f", "type": "file", "file": docker.path, "x": 300, "y": 0, "width": 400, "height": 400}
            ],
            "edges": [{"id": "e", "fromNode": "t", "toNode": "f"}],
            "x-unknown": 1
        });
        let saved = s.save_canvas(&c.id, data.clone()).unwrap();
        assert_eq!(saved.fields["cards"], 2);
        assert_eq!(s.get_canvas(&c.id).unwrap(), data);
        assert!(read(&s, &c.id).contains("\n\t\"nodes\""), "tab-indented like Obsidian");
        assert!(s.graph().unwrap().links.iter().any(|l| l.source == c.id && l.target == docker.id));
        assert_eq!(s.search("zebra", 5).unwrap()[0].id, c.id);
        assert!(s.save_canvas(&c.id, json!({"nodes": [{"id": "x"}]})).is_err());
        assert!(s.save_canvas(&docker.id, data.clone()).is_err());
        assert!(s.update(&c.id, obj(json!({ "tags": ["x"] }))).is_err());

        // renames: the note's card follows; links to the canvas follow its new name
        s.update(&docker.id, obj(json!({ "title": "Containers" }))).unwrap();
        assert_eq!(s.get_canvas(&c.id).unwrap()["nodes"][1]["file"], "Containers.md");
        assert_eq!(s.get_canvas(&c.id).unwrap()["nodes"][0]["text"], "Ship the zebra demo, see [[Containers]]");
        let idx = s.create(obj(json!({ "title": "Idx", "body": "[[Week plan.canvas]]" }))).unwrap();
        let r = s.update(&c.id, obj(json!({ "title": "Sprint" }))).unwrap();
        assert_eq!(r.id, "Plans/Sprint.canvas");
        assert_eq!(read(&s, &idx.id), "[[Sprint.canvas]]\n");
        s.delete(&r.id).unwrap();
        assert!(s.vault.abs(".trash/Sprint.canvas").is_file());
    }

    #[test]
    fn import_writes_files_once_and_rebuild_matches() {
        let (_t, mut s) = setup();
        let files = || vec![
            SampleFile { path: "Welcome.md".into(), content: "Hi [[Uni/OS]]".into() },
            SampleFile { path: "Uni/OS.md".into(), content: "#os".into() },
        ];
        assert_eq!(s.import(files()).unwrap(), 2);
        fs::write(s.vault.abs("Welcome.md"), "edited").unwrap();
        assert_eq!(s.import(files()).unwrap(), 0, "existing files are kept");
        assert_eq!(read(&s, "Welcome.md"), "edited");
        assert!(s.import(vec![SampleFile { path: "../x.md".into(), content: String::new() }]).is_err());
        let before = s.graph().unwrap().nodes;
        s.rebuild().unwrap();
        assert_eq!(s.graph().unwrap().nodes, before);
    }

    #[test]
    fn external_edits_are_picked_up_by_sync() {
        let (_t, mut s) = setup();
        fs::write(s.vault.abs("Outside.md"), "Made in Obsidian [[Other]]").unwrap();
        fs::write(s.vault.abs("Other.md"), "").unwrap();
        let r = s.sync().unwrap();
        assert_eq!((r.updated, r.removed), (2, 0));
        assert_eq!(s.graph().unwrap().links.len(), 1);
        fs::remove_file(s.vault.abs("Other.md")).unwrap();
        assert_eq!(s.sync().unwrap().removed, 1);
        assert!(s.graph().unwrap().links.is_empty());
    }
}
