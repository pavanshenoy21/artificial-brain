//! Obsidian canvas files (`*.canvas`, JSON Canvas 1.0).
//!
//! ```json
//! { "nodes": [ { "id", "type": "text"|"file"|"link"|"group", "x", "y", "width", "height",
//!                "color"?, "text"? | "file"?, "subpath"? | "url"? | "label"? } ],
//!   "edges": [ { "id", "fromNode", "fromSide"?, "toNode", "toSide"?, "toEnd"?, "label"?, "color"? } ] }
//! ```
//! A canvas is indexed as an item of type `canvas`: its body is the text of
//! its cards plus a `[[path]]` per file card, so search, backlinks and the
//! graph see what's on it. The JSON itself is only ever changed as JSON, and
//! keys the app doesn't know about are kept.

use serde_json::{Map, Value};

use crate::error::{err, Result};
use crate::markdown as md;
use crate::vault::Item;

pub const EXT: &str = "canvas";
pub const DIR: &str = "canvases";

pub fn is_canvas(path: &std::path::Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(EXT))
}


/// A canvas file as an item. Broken JSON still gives an item (empty body,
/// `error` field) so the file shows up and can be fixed or deleted.
pub fn parse_item(text: &str, rel: &str, stem: &str) -> Item {
    let mut fields = Map::new();
    let body = match serde_json::from_str::<Value>(text) {
        Ok(v) => {
            fields.insert("cards".into(), nodes(&v).len().into());
            searchable_text(&v)
        }
        Err(e) => {
            fields.insert("error".into(), format!("not valid canvas JSON: {e}").into());
            String::new()
        }
    };
    Item {
        id: rel.to_string(),
        kind: "canvas".into(),
        lobe: None,
        title: stem.to_string(),
        tags: vec![],
        inline_tags: md::inline_tags(&body),
        body,
        path: rel.to_string(),
        created: None,
        updated: None,
        fields,
    }
}

fn nodes(v: &Value) -> &[Value] {
    v.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Text cards, group labels, link URLs and a `[[path]]` for every file card.
pub fn searchable_text(v: &Value) -> String {
    let mut parts = Vec::new();
    for n in nodes(v) {
        let s = |k: &str| n.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let part = match n.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => s("text"),
            "file" if !s("file").is_empty() => format!("[[{}]]", s("file")),
            "link" => s("url"),
            "group" => s("label"),
            _ => String::new(),
        };
        if !part.is_empty() {
            parts.push(part);
        }
    }
    parts.join("\n\n")
}

/// Checks the shape before anything is written: `nodes` and `edges` arrays,
/// every node with a string id and a type, every edge between known nodes.
pub fn validate(v: &Value) -> Result<()> {
    let Some(obj) = v.as_object() else { return err("a canvas must be a JSON object") };
    let nodes = match obj.get("nodes") {
        None => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return err("canvas `nodes` must be a list"),
    };
    let mut ids = std::collections::HashSet::new();
    for n in nodes {
        let id = n.get("id").and_then(Value::as_str);
        let ty = n.get("type").and_then(Value::as_str);
        match (id, ty) {
            (Some(id), Some(_)) if ids.insert(id) => {}
            (Some(id), Some(_)) => return err(format!("duplicate canvas node id {id:?}")),
            _ => return err("every canvas node needs an id and a type"),
        }
    }
    match obj.get("edges") {
        None => {}
        Some(Value::Array(edges)) => {
            for e in edges {
                let ends = (e.get("fromNode").and_then(Value::as_str), e.get("toNode").and_then(Value::as_str));
                match ends {
                    (Some(a), Some(b)) if ids.contains(a) && ids.contains(b) => {}
                    _ => return err("every canvas edge needs fromNode and toNode on this canvas"),
                }
            }
        }
        Some(_) => return err("canvas `edges` must be a list"),
    }
    Ok(())
}

/// JSON the way Obsidian writes it (tab-indented), so saving a canvas the
/// app didn't change gives no diff.
pub fn render(v: &Value) -> Result<String> {
    use serde::Serialize;
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    v.serialize(&mut ser)?;
    Ok(String::from_utf8(buf).unwrap_or_default())
}

pub fn empty() -> Value {
    serde_json::json!({ "nodes": [], "edges": [] })
}

/// After a file was renamed: point file cards at its new path and rewrite
/// [[links]] in text cards. Returns the new JSON text if anything changed.
pub fn rewrite_for_rename(text: &str, old_rel: &str, new_rel: &str, pairs: &[(String, String)]) -> Option<String> {
    let mut v: Value = serde_json::from_str(text).ok()?;
    let mut changed = false;
    if let Some(nodes) = v.get_mut("nodes").and_then(Value::as_array_mut) {
        for n in nodes {
            let ty = n.get("type").and_then(Value::as_str).unwrap_or("").to_string();
            if ty == "file" && n.get("file").and_then(Value::as_str) == Some(old_rel) {
                n["file"] = new_rel.into();
                changed = true;
            }
            if ty == "text" {
                if let Some(t) = n.get("text").and_then(Value::as_str) {
                    let mut out = t.to_string();
                    for (old, new) in pairs {
                        out = md::rename_wikilinks(&out, old, new);
                    }
                    if out != t {
                        n["text"] = out.into();
                        changed = true;
                    }
                }
            }
        }
    }
    if !changed {
        return None;
    }
    let mut out = render(&v).ok()?;
    if text.ends_with('\n') {
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{
	"nodes":[
		{"id":"a","type":"text","text":"Plan the **demo**. See [[Docker]] #todo","x":0,"y":0,"width":250,"height":60},
		{"id":"b","type":"file","file":"notes/Docker.md","x":300,"y":0,"width":400,"height":400,"color":"4"},
		{"id":"c","type":"link","url":"https://example.com","x":0,"y":300,"width":400,"height":300},
		{"id":"g","type":"group","label":"Week 1","x":-20,"y":-20,"width":800,"height":700,"background":"x.png"}
	],
	"edges":[{"id":"e1","fromNode":"a","fromSide":"right","toNode":"b","toSide":"left","label":"uses","x-custom":1}],
	"x-plugin":{"keep":true}
}"##;

    #[test]
    fn parses_cards_into_searchable_text() {
        let it = parse_item(SAMPLE, "Plans/Week.canvas", "Week");
        assert_eq!((it.kind.as_str(), it.title.as_str(), it.id.as_str()), ("canvas", "Week", "Plans/Week.canvas"));
        assert!(it.body.contains("Plan the **demo**"));
        assert!(it.body.contains("[[notes/Docker.md]]"));
        assert!(it.body.contains("https://example.com"));
        assert!(it.body.contains("Week 1"));
        assert_eq!(it.inline_tags, vec!["todo"]);
        assert_eq!(it.fields["cards"], 4);
    }

    #[test]
    fn broken_json_still_gives_an_item() {
        let it = parse_item("{ nope", "x.canvas", "x");
        assert!(it.body.is_empty());
        assert!(it.fields["error"].as_str().unwrap().contains("not valid"));
    }

    #[test]
    fn validate_checks_ids_and_edges() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        assert!(validate(&v).is_ok());
        assert!(validate(&empty()).is_ok());
        assert!(validate(&serde_json::json!({"nodes": [{"id": "a"}]})).is_err());
        assert!(validate(&serde_json::json!({"nodes": [{"id": "a", "type": "text"}, {"id": "a", "type": "text"}]})).is_err());
        assert!(validate(&serde_json::json!({"nodes": [], "edges": [{"fromNode": "a", "toNode": "b"}]})).is_err());
        assert!(validate(&serde_json::json!([])).is_err());
    }

    #[test]
    fn render_round_trips_and_keeps_unknown_keys() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        let text = render(&v).unwrap();
        assert!(text.starts_with("{\n\t\""));
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, v);
        assert_eq!(back["x-plugin"]["keep"], true);
        assert_eq!(back["edges"][0]["x-custom"], 1);
    }

    #[test]
    fn rename_rewrites_file_cards_and_text_links() {
        let out = rewrite_for_rename(SAMPLE, "notes/Docker.md", "notes/Containers.md", &[("Docker".into(), "Containers".into())]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["nodes"][1]["file"], "notes/Containers.md");
        assert!(v["nodes"][0]["text"].as_str().unwrap().contains("[[Containers]]"));
        assert!(rewrite_for_rename(SAMPLE, "notes/Other.md", "notes/X.md", &[("Other".into(), "X".into())]).is_none());
    }
}
