//! The storage service: vault (files, source of truth) + index (SQLite cache).
//! Every write goes to a file first, then the index is updated from that file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::canvas;
use crate::error::{err, Error, Result};
use crate::index::{self, Hit, Index, Link};
use crate::markdown as md;
use crate::vault::{self, file_stamp, stem_of, Item, Lobe, Vault, TYPES};

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<Item>,
    pub links: Vec<Link>,
    pub lobes: Vec<Lobe>,
    /// Embedding-based suggestions; None = UI falls back to shared tags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similar: Option<Vec<Link>>,
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
            store.index.clear(true)?;
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
        if report.removed > 0 {
            self.index.prune_embeddings()?;
        }
        Ok(report)
    }

    /// Drops the whole index and rebuilds it from the files.
    pub fn rebuild(&mut self) -> Result<SyncReport> {
        self.index.clear(false)?;
        let r = self.sync()?;
        self.index.prune_embeddings()?;
        Ok(r)
    }

    // ------------------------------------------------------------ reads

    /// Items, links and lobes. Top-level folders get a lobe automatically, and
    /// items without their own `lobe:` take their folder's lobe.
    pub fn graph(&self) -> Result<Graph> {
        let mut nodes = self.index.items()?;
        let mut folders: Vec<String> = nodes.iter().filter_map(|n| n.path.split_once('/').map(|(f, _)| f.to_string())).collect();
        folders.sort();
        folders.dedup();
        let lobes = self.vault.ensure_folder_lobes(&folders)?;
        for n in &mut nodes {
            let has_own = n.lobe.as_ref().is_some_and(|l| lobes.iter().any(|x| &x.id == l));
            if has_own {
                continue;
            }
            if let Some((top, _)) = n.path.split_once('/') {
                if let Some(l) = lobes.iter().find(|l| l.folder.as_deref() == Some(top)) {
                    n.lobe = Some(l.id.clone());
                    n.fields.insert("lobe_from".into(), "folder".into());
                }
            }
        }
        Ok(Graph { nodes, links: self.index.links()?, lobes, similar: None })
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

    pub fn lobes(&self) -> Result<Vec<Lobe>> {
        self.vault.lobes()
    }

    pub fn save_lobes(&self, lobes: &[Lobe]) -> Result<()> {
        let mut ids = HashSet::new();
        for l in lobes {
            if l.id.trim().is_empty() || l.name.trim().is_empty() {
                return err("every lobe needs an id and a name");
            }
            if !ids.insert(&l.id) {
                return err(format!("duplicate lobe id {:?}", l.id));
            }
        }
        self.vault.save_lobes(lobes)
    }

    // ------------------------------------------------------------ writes

    /// Creates an item from a flat object: `{ type, title, lobe?, tags?, body?, ...fields }`.
    pub fn create(&mut self, mut input: Map<String, Value>) -> Result<Item> {
        // optional `folder`: vault-relative folder to create the file in
        // (daily notes, "new note here" in a user folder); default: type folder
        let folder = match input.remove("folder") {
            Some(Value::String(f)) if !f.trim().is_empty() => Some(safe_folder(&f)?),
            _ => None,
        };
        let now = vault::now();
        let mut item = Item {
            id: vault::new_id(),
            kind: "note".into(),
            lobe: None,
            title: String::new(),
            tags: vec![],
            inline_tags: vec![],
            body: String::new(),
            path: String::new(),
            created: Some(now.clone()),
            updated: Some(now),
            fields: Map::new(),
        };
        apply_patch(&mut item, input)?;
        if item.title.trim().is_empty() {
            return err("title is required");
        }
        let dir = folder.map(|f| self.vault.abs(&f)).unwrap_or_else(|| self.vault.type_dir(&item.kind));
        let file = self.vault.unique_path(&dir, &md::file_stem_for(&item.title), None);
        item.path = self.vault.rel(&file);
        self.vault.write(&file, &item)?;
        self.reindex(&[file], &[])?;
        self.get(&item.id)?.ok_or_else(|| Error("item vanished after create".into()))
    }

    /// Partial update. Keys set to `null` remove that field. The file is
    /// re-read first so edits made outside the app aren't lost. A title
    /// change renames the file and rewrites [[links]] pointing at it; a type
    /// change moves it to the new type's folder.
    pub fn update(&mut self, id: &str, patch: Map<String, Value>) -> Result<Item> {
        let old_file = self.file_of(id)?;
        if canvas::is_canvas(&old_file) {
            return self.update_canvas_meta(id, &old_file, patch);
        }
        let mut item = self.vault.read(&old_file)?;
        item.id = id.to_string();
        let (old_title, old_kind, old_stem) = (item.title.clone(), item.kind.clone(), stem_of(&old_file));
        apply_patch(&mut item, patch)?;
        if item.title.trim().is_empty() {
            return err("title can't be empty");
        }
        // only notes that already track it (app-made ones) get `updated:` bumped
        if item.updated.is_some() || item.created.is_some() {
            item.updated = Some(vault::now());
        }

        let new_stem = md::file_stem_for(&item.title);
        let renamed = item.title != old_title && new_stem != old_stem;
        // A type change moves the file between the app's type folders, but never
        // out of a folder the user made (e.g. an imported Obsidian vault).
        let moved = item.kind != old_kind && old_file.parent() == Some(self.vault.type_dir(&old_kind).as_path());
        let file = if renamed || moved {
            let dir = if moved { self.vault.type_dir(&item.kind) } else { old_file.parent().unwrap_or(self.vault.root()).to_path_buf() };
            let stem = if renamed { new_stem } else { old_stem.clone() };
            self.vault.unique_path(&dir, &stem, Some(&old_file))
        } else {
            old_file.clone()
        };
        item.path = self.vault.rel(&file);
        self.vault.write(&file, &item)?;
        let mut touched = vec![file.clone()];
        let mut removed = vec![];
        if file != old_file {
            std::fs::remove_file(&old_file)?;
            removed.push(self.vault.rel(&old_file));
            if renamed {
                let (old_rel, new_rel) = (self.vault.rel(&old_file), self.vault.rel(&file));
                let new_stem = stem_of(&file);
                let mut pairs = vec![(old_stem.clone(), new_stem.clone())];
                if old_title != old_stem {
                    pairs.push((old_title.clone(), new_stem.clone()));
                }
                // path-style links: [[folder/Old]] -> [[folder/New]]
                pairs.push((old_rel.trim_end_matches(".md").to_string(), new_rel.trim_end_matches(".md").to_string()));
                touched.extend(self.rewrite_backlinks(&old_rel, &new_rel, &pairs)?);
            }
        }
        self.reindex(&touched, &removed)?;
        self.get(id)?.ok_or_else(|| Error("item vanished after update".into()))
    }

    /// Moves the file into `.trash/` and drops it from the index.
    pub fn delete(&mut self, id: &str) -> Result<()> {
        let file = self.file_of(id)?;
        self.vault.trash(&file)?;
        let rel = self.vault.rel(&file);
        self.reindex(&[], &[rel])
    }

    /// Bulk import of `{ nodes, links }` (the sample data). Explicit links are
    /// written into the source note as "Related: [[...]]" so they live on as
    /// plain markdown. Returns how many items were created.
    pub fn import(&mut self, nodes: Vec<Map<String, Value>>, links: Vec<Link>) -> Result<usize> {
        let mut new_ids: HashMap<String, String> = HashMap::new();
        let mut stems: HashMap<String, String> = HashMap::new();
        for mut input in nodes {
            let old_id = input.remove("id").and_then(|v| v.as_str().map(str::to_string));
            let item = self.create(input)?;
            if let Some(old) = old_id {
                stems.insert(item.id.clone(), stem_of(Path::new(&item.path)));
                new_ids.insert(old, item.id);
            }
        }
        let mut outgoing: Vec<(String, Vec<String>)> = Vec::new();
        for l in links.iter().filter(|l| l.kind == "explicit") {
            if let (Some(s), Some(t)) = (new_ids.get(&l.source), new_ids.get(&l.target)) {
                match outgoing.iter_mut().find(|(id, _)| id == s) {
                    Some((_, v)) => v.push(stems[t].clone()),
                    None => outgoing.push((s.clone(), vec![stems[t].clone()])),
                }
            }
        }
        let mut touched = vec![];
        for (id, targets) in outgoing {
            let file = self.file_of(&id)?;
            let mut item = self.vault.read(&file)?;
            let related = targets.iter().map(|t| format!("[[{t}]]")).collect::<Vec<_>>().join(", ");
            item.body = if item.body.trim().is_empty() {
                format!("Related: {related}")
            } else {
                format!("{}\n\nRelated: {related}", item.body.trim_end())
            };
            self.vault.write(&file, &item)?;
            touched.push(file);
        }
        self.reindex(&touched, &[])?;
        Ok(new_ids.len())
    }

    // ------------------------------------------------------------ helpers

    /// Re-reads files the store just wrote (rather than trusting mtimes,
    /// which can be too coarse to notice a quick rewrite).
    fn reindex(&mut self, files: &[PathBuf], removed_paths: &[String]) -> Result<()> {
        let items: Vec<_> = files
            .iter()
            .map(|f| Ok((self.vault.read(f)?, file_stamp(f)?)))
            .collect::<Result<_>>()?;
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
        match self.index.path_of(id)? {
            Some(p) if self.vault.abs(&p).is_file() => Ok(self.vault.abs(&p)),
            Some(p) => err(format!("file for {id} is missing: {p}")),
            None => err(format!("no item with id {id}")),
        }
    }

    /// After a rename, rewrite [[Old]] links (each `(old, new)` pair) in
    /// notes, and file cards + text-card links in canvases. Returns the files
    /// that changed.
    fn rewrite_backlinks(&self, old_rel: &str, new_rel: &str, pairs: &[(String, String)]) -> Result<Vec<PathBuf>> {
        let mut changed = Vec::new();
        for file in self.vault.files()? {
            let text = std::fs::read_to_string(&file)?;
            let out = if canvas::is_canvas(&file) {
                canvas::rewrite_for_rename(&text, old_rel, new_rel, pairs)
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

    /// A new, empty canvas in `canvases/`.
    pub fn create_canvas(&mut self, title: &str) -> Result<Item> {
        let title = title.trim();
        if title.is_empty() {
            return err("title is required");
        }
        let dir = self.vault.type_dir("canvas");
        std::fs::create_dir_all(&dir)?;
        let file = self.vault.unique_path_ext(&dir, &md::file_stem_for(title), canvas::EXT, None);
        vault::write_atomic(&file, &canvas::render(&canvas::empty())?)?;
        self.reindex(std::slice::from_ref(&file), &[])?;
        let rel = self.vault.rel(&file);
        self.index.items()?.into_iter().find(|i| i.path == rel).ok_or_else(|| Error("canvas vanished after create".into()))
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

    /// A canvas has no frontmatter: only its title (= file name) can change.
    fn update_canvas_meta(&mut self, id: &str, old_file: &Path, patch: Map<String, Value>) -> Result<Item> {
        let mut title = None;
        for (k, v) in patch {
            match k.as_str() {
                "title" => title = v.as_str().map(|s| s.trim().to_string()),
                "id" | "path" | "type" | "degree" | "lobe_from" | "inline_tags" | "cards" => {}
                _ => return err(format!("a canvas can't store {k:?}: only its name can change")),
            }
        }
        let Some(title) = title.filter(|t| t != &stem_of(old_file)) else {
            return self.get(id)?.ok_or_else(|| Error("no such canvas".into()));
        };
        if title.is_empty() {
            return err("title can't be empty");
        }
        let dir = old_file.parent().unwrap_or(self.vault.root()).to_path_buf();
        let file = self.vault.unique_path_ext(&dir, &md::file_stem_for(&title), canvas::EXT, Some(old_file));
        if file == old_file {
            return self.get(id)?.ok_or_else(|| Error("no such canvas".into()));
        }
        std::fs::rename(old_file, &file)?;
        let (old_rel, new_rel) = (self.vault.rel(old_file), self.vault.rel(&file));
        let old_name = old_file.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let new_name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let pairs = vec![(old_name, new_name), (old_rel.clone(), new_rel.clone())];
        let mut touched = vec![file.clone()];
        touched.extend(self.rewrite_backlinks(&old_rel, &new_rel, &pairs)?);
        touched.retain(|f| f.exists());
        self.reindex(&touched, &[old_rel])?;
        // a canvas's id is its path, so it changes with the name
        self.index.items()?.into_iter().find(|i| i.path == new_rel).ok_or_else(|| Error("canvas vanished after rename".into()))
    }
}

/// A vault-relative folder from the UI: no absolute paths, `..` or dot-folders.
fn safe_folder(f: &str) -> Result<String> {
    let parts: Vec<&str> = f.split(['/', '\\']).map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| p.starts_with('.') || p.contains(':')) {
        return err(format!("bad folder {f:?}"));
    }
    Ok(parts.join("/"))
}

fn apply_patch(item: &mut Item, patch: Map<String, Value>) -> Result<()> {
    for (k, v) in patch {
        match k.as_str() {
            "type" => {
                let t = v.as_str().unwrap_or_default();
                if !TYPES.contains(&t) {
                    return err(format!("unknown type {t:?}, expected one of {TYPES:?}"));
                }
                item.kind = t.to_string();
            }
            "lobe" => item.lobe = v.as_str().filter(|s| !s.is_empty()).map(str::to_string),
            "title" => item.title = v.as_str().unwrap_or_default().trim().to_string(),
            "tags" => item.tags = md::normalize_tags(Some(&v)),
            "body" => item.body = v.as_str().unwrap_or_default().trim_end().to_string(),
            // managed by the store
            "id" | "path" | "created" | "updated" | "degree" | "lobe_from" | "inline_tags" => {}
            _ if v.is_null() => {
                item.fields.remove(&k);
            }
            _ => {
                item.fields.insert(k, v);
            }
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
        let dir = std::env::temp_dir().join(format!("brain-test-{}", vault::new_id()));
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
            .create(obj(json!({ "type": "skill", "title": "HTML / CSS", "lobe": "web", "tags": ["#web"], "level": "beginner" })))
            .unwrap();
        assert_eq!(n.path, "skills/HTML CSS.md");
        assert_eq!(n.id.len(), 26, "ULID");
        assert_eq!(n.tags, vec!["web"]);
        assert_eq!(n.fields["level"], json!("beginner"));
        let text = fs::read_to_string(s.vault.abs(&n.path)).unwrap();
        assert!(text.contains("title: HTML / CSS"));
        assert_eq!(s.tags().unwrap(), vec![("web".to_string(), 1)]);
        assert_eq!(s.search("html", 5).unwrap()[0].id, n.id);
        assert!(s.create(obj(json!({ "type": "nope", "title": "x" }))).is_err());
        assert!(s.create(obj(json!({ "title": "  " }))).is_err());
    }

    #[test]
    fn wikilinks_become_links_and_follow_renames() {
        let (_t, mut s) = setup();
        let a = s.create(obj(json!({ "title": "Alpha", "body": "See [[Beta]] and [[Beta|b]]" }))).unwrap();
        let b = s.create(obj(json!({ "title": "Beta" }))).unwrap();
        let g = s.graph().unwrap();
        assert_eq!(g.links, vec![Link { source: a.id.clone(), target: b.id.clone(), kind: "explicit".into() }]);
        assert_eq!(g.lobes.len(), 6, "default lobes seeded");

        let b2 = s.update(&b.id, obj(json!({ "title": "Gamma", "level": null }))).unwrap();
        assert_eq!(b2.path, "notes/Gamma.md");
        assert!(!s.vault.abs("notes/Beta.md").exists());
        assert_eq!(s.get(&a.id).unwrap().unwrap().body, "See [[Gamma]] and [[Gamma|b]]");
        assert_eq!(s.graph().unwrap().links.len(), 1);

        let b3 = s.update(&b.id, obj(json!({ "type": "skill" }))).unwrap();
        assert_eq!(b3.path, "skills/Gamma.md", "type change moves the file");
        fs::create_dir_all(s.vault.abs("Uni/DSA")).unwrap();
        fs::write(s.vault.abs("Uni/DSA/Heaps.md"), "Binary heaps #dsa").unwrap();
        s.sync().unwrap();
        let heaps = s.update("Uni/DSA/Heaps.md", obj(json!({ "type": "skill", "title": "Heaps and PQs" }))).unwrap();
        assert_eq!(heaps.path, "Uni/DSA/Heaps and PQs.md", "user folders are kept");
        assert_eq!(heaps.inline_tags, vec!["dsa"]);
        assert!(!fs::read_to_string(s.vault.abs(&heaps.path)).unwrap().contains("- dsa"), "inline tags stay inline");

        s.delete(&b.id).unwrap();
        assert!(s.vault.abs(".trash/Gamma.md").exists());
        assert!(s.graph().unwrap().links.is_empty());
        assert!(s.get(&b.id).unwrap().is_none());
    }

    #[test]
    fn sync_picks_up_external_files() {
        let (_t, mut s) = setup();
        fs::create_dir_all(s.vault.abs("links")).unwrap();
        fs::write(s.vault.abs("links/Arch Wiki.md"), "---\nurl: https://wiki.archlinux.org\ntags: linux, docs\n---\nGreat docs. [[Missing]]").unwrap();
        fs::write(s.vault.abs("Loose.md"), "no frontmatter, links to [[arch wiki]]").unwrap();
        fs::create_dir_all(s.vault.abs(".obsidian")).unwrap();
        fs::write(s.vault.abs(".obsidian/ignored.md"), "x").unwrap();
        let r = s.sync().unwrap();
        assert_eq!(r, SyncReport { scanned: 2, updated: 2, removed: 0 });
        let g = s.graph().unwrap();
        let arch = g.nodes.iter().find(|n| n.title == "Arch Wiki").unwrap();
        assert_eq!((arch.kind.as_str(), arch.id.as_str()), ("link", "links/Arch Wiki.md"));
        assert_eq!(arch.tags, vec!["linux", "docs"]);
        assert_eq!(g.links.len(), 1);

        assert_eq!(s.sync().unwrap().updated, 0, "unchanged files are skipped");
        fs::remove_file(s.vault.abs("Loose.md")).unwrap();
        assert_eq!(s.sync().unwrap().removed, 1);
        assert!(s.graph().unwrap().links.is_empty());
    }

    #[test]
    fn rebuild_restores_everything() {
        let (_t, mut s) = setup();
        let a = s.create(obj(json!({ "title": "A", "body": "[[B]]", "tags": ["x"] }))).unwrap();
        s.create(obj(json!({ "title": "B" }))).unwrap();
        let before = s.graph().unwrap();
        s.index.conn().execute_batch("DELETE FROM links; DELETE FROM tags;").unwrap();
        let r = s.rebuild().unwrap();
        assert_eq!(r.updated, 2);
        let after = s.graph().unwrap();
        assert_eq!(before.nodes, after.nodes);
        assert_eq!(before.links, after.links);
        assert_eq!(s.search("a", 5).unwrap()[0].id, a.id);
    }

    #[test]
    fn switching_vaults_clears_the_index() {
        let (t, mut s) = setup();
        s.create(obj(json!({ "title": "Only in vault one" }))).unwrap();
        drop(s);
        let s2 = Store::open(t.0.join("vault2"), &t.0.join("brain.db")).unwrap();
        assert!(s2.graph().unwrap().nodes.is_empty());
    }

    #[test]
    fn update_keeps_external_edits_and_unknown_fields() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "Note", "body": "v1" }))).unwrap();
        let file = s.vault.abs(&n.path);
        let text = fs::read_to_string(&file).unwrap().replace("v1", "edited in obsidian");
        fs::write(&file, text.replacen("---\n", "---\naliases: [n]\n", 1)).unwrap();
        let n2 = s.update(&n.id, obj(json!({ "tags": ["x"] }))).unwrap();
        assert_eq!(n2.body, "edited in obsidian");
        assert_eq!(n2.fields["aliases"], json!(["n"]));
        assert_eq!(n2.created, n.created);
    }

    #[test]
    fn duplicate_ids_dont_clobber() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "Orig" }))).unwrap();
        fs::copy(s.vault.abs(&n.path), s.vault.abs("notes/Copy.md")).unwrap();
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
            obj(json!({ "id": "b", "type": "skill", "title": "B", "level": "beginner" })),
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

    #[test]
    fn history_keeps_originals() {
        let (_t, mut s) = setup();
        let n = s.create(obj(json!({ "title": "Draft: one", "body": "teh original" }))).unwrap();
        let orig = s.vault.read(&s.file_of(&n.id).unwrap()).unwrap();
        let f = s.vault.save_history(&orig).unwrap();
        assert!(f.starts_with(s.vault.abs(".brain/history")));
        assert!(fs::read_to_string(&f).unwrap().contains("teh original"));
        s.update(&n.id, obj(json!({ "body": "the polished" }))).unwrap();
        assert_eq!(s.sync().unwrap().scanned, 1, "history files aren't items");
    }

    #[test]
    fn folders_become_lobes() {
        let (_t, mut s) = setup();
        for (p, body) in [("Uni/DSA/Heaps.md", "x"), ("Uni/OS.md", "---\nlobe: sec\n---\n"), ("Side Projects/Brain.md", "y"), ("Loose.md", "z")] {
            let f = s.vault.abs(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, body).unwrap();
        }
        s.create(obj(json!({ "title": "In notes" }))).unwrap();
        s.sync().unwrap();
        let g = s.graph().unwrap();
        let lobe = |title: &str| g.nodes.iter().find(|n| n.title == title).unwrap().lobe.clone();
        assert_eq!(lobe("Heaps").as_deref(), Some("folder-uni"));
        assert_eq!(lobe("OS").as_deref(), Some("sec"), "frontmatter lobe wins");
        assert_eq!(lobe("Brain").as_deref(), Some("folder-side-projects"));
        assert_eq!(lobe("Loose"), None);
        assert_eq!(lobe("In notes"), None, "type folders don't become lobes");
        let folder_lobes: Vec<_> = g.lobes.iter().filter(|l| l.folder.is_some()).collect();
        assert_eq!(folder_lobes.len(), 2);
        assert_ne!(folder_lobes[0].color, folder_lobes[1].color);
        assert!(!fs::read_to_string(s.vault.abs("Uni/DSA/Heaps.md")).unwrap().contains("lobe"), "files untouched");

        // deleting a folder lobe sticks; stable on re-run
        let keep: Vec<Lobe> = g.lobes.iter().filter(|l| l.folder.as_deref() != Some("Uni")).cloned().collect();
        s.save_lobes(&keep).unwrap();
        let g2 = s.graph().unwrap();
        assert!(!g2.lobes.iter().any(|l| l.folder.as_deref() == Some("Uni")));
        assert_eq!(g2.lobes.len(), keep.len());
    }

    #[test]
    fn lobes_validate() {
        let (_t, s) = setup();
        let mut lobes = s.lobes().unwrap();
        lobes.push(Lobe { id: "sec".into(), name: "Dup".into(), color: "#000".into(), folder: None });
        assert!(s.save_lobes(&lobes).is_err());
        lobes.pop();
        lobes[0].name = "Security".into();
        s.save_lobes(&lobes).unwrap();
        assert_eq!(s.lobes().unwrap()[0].name, "Security");
    }

    #[test]
    fn canvases_are_items_linked_to_their_cards() {
        let (_t, mut s) = setup();
        let docker = s.create(obj(json!({"type": "skill", "title": "Docker"}))).unwrap();
        let c = s.create_canvas("Week plan").unwrap();
        assert_eq!((c.kind.as_str(), c.path.as_str()), ("canvas", "canvases/Week plan.canvas"));
        assert_eq!(s.get_canvas(&c.id).unwrap(), canvas::empty());

        let data = json!({
            "nodes": [
                {"id": "t", "type": "text", "text": "Ship the zebra demo, see [[Docker]]", "x": 0, "y": 0, "width": 250, "height": 60},
                {"id": "f", "type": "file", "file": docker.path, "x": 300, "y": 0, "width": 400, "height": 400}
            ],
            "edges": [{"id": "e", "fromNode": "t", "toNode": "f", "toEnd": "arrow"}],
            "x-unknown": 1
        });
        let saved = s.save_canvas(&c.id, data.clone()).unwrap();
        assert_eq!(saved.fields["cards"], 2);
        assert_eq!(s.get_canvas(&c.id).unwrap(), data);
        let text = std::fs::read_to_string(s.vault.abs(&c.path)).unwrap();
        assert!(text.contains("\n\t\"nodes\""), "tab-indented like Obsidian");
        assert!(s.graph().unwrap().links.iter().any(|l| l.source == c.id && l.target == docker.id));
        assert_eq!(s.search("zebra", 5).unwrap()[0].id, c.id);

        // a bad canvas is refused and the file is left alone
        assert!(s.save_canvas(&c.id, json!({"nodes": [{"id": "x"}]})).is_err());
        assert_eq!(s.get_canvas(&c.id).unwrap(), data);
        // notes can't be written as canvases, canvases have no frontmatter
        assert!(s.save_canvas(&docker.id, data.clone()).is_err());
        assert!(s.update(&c.id, obj(json!({"tags": ["x"]}))).is_err());
    }

    #[test]
    fn renames_keep_canvases_in_step() {
        let (_t, mut s) = setup();
        let docker = s.create(obj(json!({"type": "note", "title": "Docker"}))).unwrap();
        let c = s.create_canvas("Board").unwrap();
        let data = json!({"nodes": [
            {"id": "t", "type": "text", "text": "see [[Docker]]", "x": 0, "y": 0, "width": 1, "height": 1},
            {"id": "f", "type": "file", "file": "notes/Docker.md", "x": 0, "y": 0, "width": 1, "height": 1}
        ], "edges": []});
        s.save_canvas(&c.id, data).unwrap();
        let other = s.create(obj(json!({"title": "Index", "body": "[[Board.canvas]] and [[notes/Docker]]"}))).unwrap();

        // renaming the note updates the canvas's file card and text link,
        // and the path-style link in another note
        s.update(&docker.id, obj(json!({"title": "Containers"}))).unwrap();
        let v = s.get_canvas(&c.id).unwrap();
        assert_eq!(v["nodes"][1]["file"], "notes/Containers.md");
        assert_eq!(v["nodes"][0]["text"], "see [[Containers]]");
        assert_eq!(s.get(&other.id).unwrap().unwrap().body, "[[Board.canvas]] and [[notes/Containers]]");

        // renaming the canvas moves the file and fixes links to it; its id is its path
        let renamed = s.update(&c.id, obj(json!({"title": "Sprint board"}))).unwrap();
        assert_eq!(renamed.path, "canvases/Sprint board.canvas");
        assert_eq!(renamed.id, renamed.path);
        assert!(s.get(&c.id).unwrap().is_none());
        assert_eq!(s.get(&other.id).unwrap().unwrap().body, "[[Sprint board.canvas]] and [[notes/Containers]]");
        assert!(s.graph().unwrap().links.iter().any(|l| l.source == other.id && l.target == renamed.id));

        // delete goes to the trash with its extension
        s.delete(&renamed.id).unwrap();
        assert!(s.vault.abs(".trash/Sprint board.canvas").is_file());
    }

    #[test]
    fn obsidian_canvas_files_are_read_untouched() {
        let (_t, mut s) = setup();
        let raw = "{\n\t\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"hello\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}],\n\t\"edges\":[]\n}";
        std::fs::create_dir_all(s.vault.abs("Study")).unwrap();
        std::fs::write(s.vault.abs("Study/Exam map.canvas"), raw).unwrap();
        std::fs::write(s.vault.abs("Study/Broken.canvas"), "{ nope").unwrap();
        s.sync().unwrap();
        let g = s.graph().unwrap();
        let c = g.nodes.iter().find(|n| n.path == "Study/Exam map.canvas").unwrap();
        assert_eq!((c.kind.as_str(), c.title.as_str()), ("canvas", "Exam map"));
        assert!(c.lobe.as_deref().unwrap().starts_with("folder-"));
        assert!(g.nodes.iter().any(|n| n.path == "Study/Broken.canvas" && n.fields.contains_key("error")));
        assert!(s.get_canvas("Study/Broken.canvas").is_err());
        assert_eq!(std::fs::read_to_string(s.vault.abs("Study/Exam map.canvas")).unwrap(), raw);
    }

    #[test]
    fn create_in_a_folder_and_brain_state() {
        let (_t, mut s) = setup();
        let d = s.create(obj(json!({"title": "2026-10-08", "folder": "daily"}))).unwrap();
        assert_eq!(d.path, "daily/2026-10-08.md");
        assert!(s.create(obj(json!({"title": "x", "folder": "../out"}))).is_err());
        assert!(s.create(obj(json!({"title": "x", "folder": ".brain"}))).is_err());
        assert_eq!(s.vault.brain_state("review").unwrap(), Value::Null);
        s.vault.set_brain_state("review", &json!({"a": 1})).unwrap();
        assert_eq!(s.vault.brain_state("review").unwrap(), json!({"a": 1}));
        assert!(s.vault.brain_state("../x").is_err());
        assert!(s.vault.set_brain_state("lobes", &json!([])).is_err());
    }
}
