//! The storage service: vault (files, source of truth) + index (SQLite cache).
//! Every write goes to a file first, then the index is updated from that file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{err, Error, Result};
use crate::index::{self, Hit, Index, Link};
use crate::markdown as md;
use crate::vault::{self, file_stamp, stem_of, Item, Lobe, Vault, TYPES};

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<Item>,
    pub links: Vec<Link>,
    pub lobes: Vec<Lobe>,
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
        Ok(Graph { nodes: self.index.items()?, links: self.index.links()?, lobes: self.vault.lobes()? })
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
    pub fn create(&mut self, input: Map<String, Value>) -> Result<Item> {
        let now = vault::now();
        let mut item = Item {
            id: vault::new_id(),
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
        apply_patch(&mut item, input)?;
        if item.title.trim().is_empty() {
            return err("title is required");
        }
        let file = self.vault.unique_path(&self.vault.type_dir(&item.kind), &md::file_stem_for(&item.title), None);
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
        let mut item = self.vault.read(&old_file)?;
        item.id = id.to_string();
        let (old_title, old_kind, old_stem) = (item.title.clone(), item.kind.clone(), stem_of(&old_file));
        apply_patch(&mut item, patch)?;
        if item.title.trim().is_empty() {
            return err("title can't be empty");
        }
        item.updated = Some(vault::now());

        let new_stem = md::file_stem_for(&item.title);
        let renamed = item.title != old_title && new_stem != old_stem;
        let moved = item.kind != old_kind;
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
                touched.extend(self.rewrite_backlinks(&old_stem, &stem_of(&file), &old_title)?);
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

    /// After a rename, point [[Old]] (by file name or old title) at the new
    /// file name. Returns the files that changed.
    fn rewrite_backlinks(&self, old_stem: &str, new_stem: &str, old_title: &str) -> Result<Vec<PathBuf>> {
        let mut changed = Vec::new();
        for file in self.vault.files()? {
            let text = std::fs::read_to_string(&file)?;
            let mut out = md::rename_wikilinks(&text, old_stem, new_stem);
            if old_title != old_stem {
                out = md::rename_wikilinks(&out, old_title, new_stem);
            }
            if out != text {
                vault::write_atomic(&file, &out)?;
                changed.push(file);
            }
        }
        Ok(changed)
    }
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
            "id" | "path" | "created" | "updated" | "degree" => {}
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
    fn lobes_validate() {
        let (_t, s) = setup();
        let mut lobes = s.lobes().unwrap();
        lobes.push(Lobe { id: "sec".into(), name: "Dup".into(), color: "#000".into() });
        assert!(s.save_lobes(&lobes).is_err());
        lobes.pop();
        lobes[0].name = "Security".into();
        s.save_lobes(&lobes).unwrap();
        assert_eq!(s.lobes().unwrap()[0].name, "Security");
    }
}
