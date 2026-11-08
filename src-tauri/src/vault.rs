//! The vault on disk, exactly as Obsidian keeps it: a folder of markdown
//! notes (plus `.canvas` boards) in any folder structure. A note's identity is
//! its path, its title is its file name, and the app never adds anything to
//! a file that the user didn't type (no ids, no timestamps).
//!
//! `.obsidian/`, `.trash/`, `.git/` and other dot-folders are left alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::canvas;
use crate::error::{err, Result};
use crate::markdown as md;

/// A note or canvas as the frontend sees it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Item {
    /// Vault-relative path with forward slashes (also the identity).
    pub id: String,
    /// "note" (.md) or "canvas" (.canvas)
    #[serde(rename = "type")]
    pub kind: String,
    /// File name without extension.
    pub title: String,
    /// `tags:` from frontmatter.
    pub tags: Vec<String>,
    /// #tags written in the body (read-only here).
    pub inline_tags: Vec<String>,
    pub body: String,
    pub path: String,
    /// Every other frontmatter property, as written (sent to the UI as `props`,
    /// so a property called "id" or "title" can't clash with the fields above).
    #[serde(rename = "props")]
    pub fields: Map<String, Value>,
}

impl Item {
    /// Frontmatter tags plus inline #tags, deduplicated.
    pub fn all_tags(&self) -> Vec<String> {
        let mut out = self.tags.clone();
        for t in &self.inline_tags {
            if !out.contains(t) {
                out.push(t.clone());
            }
        }
        out
    }
}

pub struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
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

    /// Every note and canvas (dot-folders skipped).
    pub fn files(&self) -> Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        collect(&self.root, &mut out)?;
        out.sort();
        Ok(out)
    }

    pub fn read(&self, file: &Path) -> Result<Item> {
        let text = fs::read_to_string(file)?;
        if canvas::is_canvas(file) {
            return Ok(canvas::parse_item(&text, &self.rel(file), &stem_of(file)));
        }
        Ok(parse_item(&text, &self.rel(file), &stem_of(file)))
    }

    /// Writes a note. The frontmatter block is kept byte for byte when its
    /// properties didn't change, and CRLF files stay CRLF.
    pub fn write(&self, file: &Path, item: &Item) -> Result<()> {
        if canvas::is_canvas(file) {
            return err("a canvas is saved as JSON, not as a note");
        }
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let old = fs::read_to_string(file).ok();
        let mut text = old
            .as_deref()
            .and_then(|o| keep_frontmatter(o, item, &self.rel(file)))
            .unwrap_or_else(|| render_item(item));
        if old.as_deref().is_some_and(|o| o.contains("\r\n")) {
            text = text.replace("\r\n", "\n").replace('\n', "\r\n");
        }
        write_atomic(file, &text)
    }

    /// `<dir>/<stem>.<ext>`, or Obsidian-style `<stem> 1.<ext>`, `<stem> 2.<ext>` …
    /// if taken. `current` (the item's own file) doesn't count as taken.
    pub fn unique_path(&self, dir: &Path, stem: &str, ext: &str, current: Option<&Path>) -> PathBuf {
        let mut candidate = dir.join(format!("{stem}.{ext}"));
        let mut n = 1;
        while candidate.exists() && !same_file(&candidate, current) {
            candidate = dir.join(format!("{stem} {n}.{ext}"));
            n += 1;
        }
        candidate
    }

    /// Moves a file or folder into `<vault>/.trash/` (like Obsidian's "Move to
    /// Obsidian trash"); nothing is ever hard-deleted.
    pub fn trash(&self, path: &Path) -> Result<PathBuf> {
        let dir = self.root.join(".trash");
        fs::create_dir_all(&dir)?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if path.is_file() && !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        let mut dest = dir.join(&name);
        let mut n = 1;
        while dest.exists() {
            dest = dir.join(format!("{stem} {n}{ext}"));
            n += 1;
        }
        fs::rename(path, &dest)?;
        Ok(dest)
    }
}

/// On a case-insensitive disk "Note.md" and "note.md" are the same file.
fn same_file(a: &Path, b: Option<&Path>) -> bool {
    match b {
        Some(b) => a == b || (a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase() && a.exists()),
        None => false,
    }
}

// ---------------------------------------------------------------- format

/// Parses a markdown file. Broken YAML gives no properties but keeps the body.
pub fn parse_item(text: &str, rel: &str, stem: &str) -> Item {
    let (fm, body) = md::split_frontmatter(text);
    let mut fields = fm.map(md::parse_frontmatter).unwrap_or_default();
    let tags = md::normalize_tags(fields.get("tags"));
    fields.remove("tags");
    let body = body.trim_start_matches(['\n', '\r']).trim_end().to_string();
    let inline_tags = md::inline_tags(&body);
    Item {
        id: rel.to_string(),
        kind: "note".into(),
        title: stem.to_string(),
        tags,
        inline_tags,
        body,
        path: rel.to_string(),
        fields,
    }
}

fn front_of(item: &Item) -> Map<String, Value> {
    let mut front = item.fields.clone();
    if !item.tags.is_empty() {
        front.insert("tags".into(), item.tags.clone().into());
    }
    front
}

/// The file text for an item: frontmatter only when there are properties.
pub fn render_item(item: &Item) -> String {
    md::render(&front_of(item), &item.body)
}

/// Reuses the existing frontmatter block verbatim when the properties are
/// the same as before (only the body was edited). Also keeps a block that
/// failed to parse instead of dropping it.
fn keep_frontmatter(old: &str, item: &Item, rel: &str) -> Option<String> {
    let (fm, old_body) = md::split_frontmatter(old);
    fm?;
    let before = parse_item(old, rel, &item.title);
    if (&before.tags, &before.fields) != (&item.tags, &item.fields) {
        return None;
    }
    let head = &old[..old.len() - old_body.len()];
    let rest = old_body.trim_start_matches(['\n', '\r']);
    let gap = &old_body[..old_body.len() - rest.len()];
    let mut out = String::with_capacity(old.len() + item.body.len());
    out.push_str(head);
    if !item.body.is_empty() {
        out.push_str(gap);
        out.push_str(&item.body);
        out.push('\n');
    }
    Some(out)
}

// ---------------------------------------------------------------- fs utils

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect(&path, out)?;
        } else if ft.is_file() && (is_md(&path) || canvas::is_canvas(&path)) {
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

/// (mtime in ns, size): cheap change detection for sync.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn tmp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("brain-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn parse_takes_title_from_the_file_name() {
        let it = parse_item("---\ntitle: Other\ntags: a, b\nlobe: x\n---\nBody #inline\n", "Uni/OS.md", "OS");
        assert_eq!((it.id.as_str(), it.title.as_str(), it.kind.as_str()), ("Uni/OS.md", "OS", "note"));
        assert_eq!(it.tags, vec!["a", "b"]);
        assert_eq!(it.inline_tags, vec!["inline"]);
        assert_eq!(it.fields["title"], "Other", "frontmatter title is just a property");
        assert_eq!(it.fields["lobe"], "x");
        assert_eq!(it.body, "Body #inline");
    }

    #[test]
    fn writes_keep_frontmatter_bytes_and_line_endings() {
        let d = tmp_dir("vault");
        let v = Vault::open(&d).unwrap();
        let f = v.abs("a.md");
        let raw = "---\ntags: a, b\n# a comment\nweird:   spacing\n---\n\nBody\n";
        fs::write(&f, raw).unwrap();
        let mut it = v.read(&f).unwrap();
        it.body = "Body 2".into();
        v.write(&f, &it).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "---\ntags: a, b\n# a comment\nweird:   spacing\n---\n\nBody 2\n");

        // broken YAML is kept as-is when only the body changes
        fs::write(&f, "---\ntags: [unclosed\n---\nOld\n").unwrap();
        let mut it = v.read(&f).unwrap();
        it.body = "New".into();
        v.write(&f, &it).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "---\ntags: [unclosed\n---\nNew\n");

        // a property change re-renders the block
        let mut it = v.read(&f).unwrap();
        it.fields.insert("status".into(), json!("done"));
        v.write(&f, &it).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "---\nstatus: done\n---\n\nNew\n");

        fs::write(&f, "one\r\ntwo\r\n").unwrap();
        let mut it = v.read(&f).unwrap();
        it.body = "one\ntwo\nthree".into();
        v.write(&f, &it).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "one\r\ntwo\r\nthree\r\n");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn unique_names_and_trash_like_obsidian() {
        let d = tmp_dir("names");
        let v = Vault::open(&d).unwrap();
        assert_eq!(v.unique_path(&d, "Untitled", "md", None), d.join("Untitled.md"));
        fs::write(d.join("Untitled.md"), "").unwrap();
        assert_eq!(v.unique_path(&d, "Untitled", "md", None), d.join("Untitled 1.md"));
        assert_eq!(v.unique_path(&d, "Untitled", "md", Some(&d.join("Untitled.md"))), d.join("Untitled.md"));
        let t = v.trash(&d.join("Untitled.md")).unwrap();
        assert_eq!(t, d.join(".trash/Untitled.md"));
        fs::write(d.join("Untitled.md"), "").unwrap();
        assert_eq!(v.trash(&d.join("Untitled.md")).unwrap(), d.join(".trash/Untitled 1.md"));
        fs::create_dir_all(d.join("Folder/Sub")).unwrap();
        assert_eq!(v.trash(&d.join("Folder")).unwrap(), d.join(".trash/Folder"));
        let _ = fs::remove_dir_all(d);
    }
}
