//! The vault on disk: a folder of markdown files, one per item.
//!
//! ```text
//! <vault>/notes/*.md  links/  skills/  hackathons/  projects/
//! <vault>/.brain/lobes.json   history/ (originals kept by AI actions)
//! <vault>/.trash/             deleted files end up here, never hard-deleted
//! ```
//! Each file: YAML frontmatter (id, type, title, lobe, tags, type fields,
//! created, updated) + markdown body. Files dropped in by hand or made in
//! Obsidian work too: the id falls back to the path, the type to the folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::Result;
use crate::markdown as md;

pub const TYPES: [&str; 5] = ["note", "link", "skill", "hackathon", "project"];

/// An item as the frontend sees it: a flat object, type-specific fields inline.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Item {
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
pub struct Lobe {
    pub id: String,
    pub name: String,
    pub color: String,
}

pub fn default_lobes() -> Vec<Lobe> {
    [
        ("sec", "Security & CTF", "#e06c75"),
        ("web", "Web & Apps", "#56b6c2"),
        ("ai", "AI & ML", "#a98fe0"),
        ("cp", "Competitive Programming", "#d6a64f"),
        ("sys", "Linux & Systems", "#7fb77e"),
        ("col", "College & Life", "#d98a5f"),
    ]
    .into_iter()
    .map(|(id, name, color)| Lobe { id: id.into(), name: name.into(), color: color.into() })
    .collect()
}

pub struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join(".brain"))?;
        Ok(Vault { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn rel(&self, file: &Path) -> String {
        let rel = file.strip_prefix(&self.root).unwrap_or(file);
        rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
    }

    /// Every item file (skips dot-folders like .brain, .trash, .obsidian, .git).
    pub fn files(&self) -> Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        collect_md(&self.root, &mut out)?;
        out.sort();
        Ok(out)
    }

    pub fn read(&self, file: &Path) -> Result<Item> {
        let text = fs::read_to_string(file)?;
        Ok(parse_item(&text, &self.rel(file), &stem_of(file)))
    }

    pub fn write(&self, file: &Path, item: &Item) -> Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        write_atomic(file, &render_item(item))
    }

    /// `<vault>/<type dir>/<stem>.md`, or `<stem> 2.md` … if taken. `current`
    /// is the item's own file, which doesn't count as taken.
    pub fn unique_path(&self, dir: &Path, stem: &str, current: Option<&Path>) -> PathBuf {
        let mut candidate = dir.join(format!("{stem}.md"));
        let mut n = 2;
        while candidate.exists() && Some(candidate.as_path()) != current {
            candidate = dir.join(format!("{stem} {n}.md"));
            n += 1;
        }
        candidate
    }

    pub fn type_dir(&self, kind: &str) -> PathBuf {
        self.root.join(type_dir(kind))
    }

    pub fn trash(&self, file: &Path) -> Result<PathBuf> {
        let dir = self.root.join(".trash");
        fs::create_dir_all(&dir)?;
        let dest = self.unique_path(&dir, &stem_of(file), None);
        fs::rename(file, &dest)?;
        Ok(dest)
    }

    // ------------------------------------------------------------ lobes

    fn lobes_file(&self) -> PathBuf {
        self.root.join(".brain").join("lobes.json")
    }

    /// Lobes from `.brain/lobes.json`, seeded with the defaults on first use.
    pub fn lobes(&self) -> Result<Vec<Lobe>> {
        let f = self.lobes_file();
        if !f.exists() {
            self.save_lobes(&default_lobes())?;
        }
        let text = fs::read_to_string(&f)?;
        Ok(serde_json::from_str(&text).unwrap_or_else(|_| default_lobes()))
    }

    pub fn save_lobes(&self, lobes: &[Lobe]) -> Result<()> {
        write_atomic(&self.lobes_file(), &(serde_json::to_string_pretty(lobes)? + "\n"))
    }

    /// Keeps an original before an AI action changes it (`.brain/history/`).
    #[allow(dead_code)] // used from milestone 8 (AI actions)
    pub fn save_history(&self, item: &Item) -> Result<PathBuf> {
        let dir = self.root.join(".brain").join("history");
        fs::create_dir_all(&dir)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let file = self.unique_path(&dir, &format!("{} {stamp}", md::file_stem_for(&item.title)), None);
        write_atomic(&file, &render_item(item))?;
        Ok(file)
    }
}

// ---------------------------------------------------------------- format

/// Parses a markdown file into an item. `rel` and `stem` supply fallbacks
/// for files without frontmatter.
pub fn parse_item(text: &str, rel: &str, stem: &str) -> Item {
    let (fm, body) = md::split_frontmatter(text);
    let mut front = fm.map(md::parse_frontmatter).unwrap_or_default();

    let mut take = |k: &str| match front.remove(k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    let id = take("id").unwrap_or_else(|| rel.to_string());
    let kind = take("type")
        .filter(|t| TYPES.contains(&t.as_str()))
        .unwrap_or_else(|| type_from_dir(rel).to_string());
    let lobe = take("lobe");
    let title = take("title").unwrap_or_else(|| stem.to_string());
    let created = take("created");
    let updated = take("updated");
    let tags = md::normalize_tags(front.get("tags"));
    front.remove("tags");

    Item {
        id,
        kind,
        lobe,
        title,
        tags,
        body: body.trim_start_matches(['\n', '\r']).trim_end().to_string(),
        path: rel.to_string(),
        created,
        updated,
        fields: front,
    }
}

pub fn render_item(item: &Item) -> String {
    let mut front = Map::new();
    front.insert("id".into(), item.id.clone().into());
    front.insert("type".into(), item.kind.clone().into());
    front.insert("title".into(), item.title.clone().into());
    if let Some(l) = &item.lobe {
        front.insert("lobe".into(), l.clone().into());
    }
    front.insert("tags".into(), item.tags.clone().into());
    for (k, v) in &item.fields {
        front.insert(k.clone(), v.clone());
    }
    if let Some(c) = &item.created {
        front.insert("created".into(), c.clone().into());
    }
    if let Some(u) = &item.updated {
        front.insert("updated".into(), u.clone().into());
    }
    md::render(&front, &item.body)
}

// ---------------------------------------------------------------- fs utils

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_md(&path, out)?;
        } else if ft.is_file() && is_md(&path) {
            out.push(path);
        }
    }
    Ok(())
}

pub fn is_md(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

pub fn stem_of(file: &Path) -> String {
    file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// (mtime in ns, size) — cheap change detection for sync.
pub fn file_stamp(file: &Path) -> Result<(i64, i64)> {
    let meta = fs::metadata(file)?;
    let mtime = meta.modified()?.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0);
    Ok((mtime, meta.len() as i64))
}

pub fn write_atomic(file: &Path, contents: &str) -> Result<()> {
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

pub fn type_dir(kind: &str) -> &'static str {
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

pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn item_round_trip() {
        let mut fields = Map::new();
        fields.insert("url".into(), json!("https://x.dev"));
        fields.insert("stack".into(), json!(["Rust", "JS"]));
        let item = Item {
            id: new_id(),
            kind: "link".into(),
            lobe: Some("web".into()),
            title: "Writeup: JWT".into(),
            tags: vec!["ctf".into()],
            body: "See [[Other]]".into(),
            path: "links/Writeup JWT.md".into(),
            created: Some("2026-09-24T10:00:00+05:30".into()),
            updated: Some("2026-09-24T10:00:00+05:30".into()),
            fields,
        };
        let text = render_item(&item);
        assert!(text.starts_with("---\nid: "));
        assert_eq!(parse_item(&text, &item.path, "Writeup JWT"), item);
    }

    #[test]
    fn plain_file_falls_back() {
        let it = parse_item("just text", "skills/Rust.md", "Rust");
        assert_eq!((it.id.as_str(), it.kind.as_str(), it.title.as_str()), ("skills/Rust.md", "skill", "Rust"));
        let it = parse_item("---\ntype: wat\n---\n", "Loose.md", "Loose");
        assert_eq!(it.kind, "note");
    }

    #[test]
    fn ulids_are_unique_and_sortable() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 26);
        assert_ne!(a, b);
    }
}
