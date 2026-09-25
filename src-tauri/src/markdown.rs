//! Markdown file format: YAML frontmatter + body, plus [[wikilink]] parsing.
//! Kept free of I/O so it's easy to test.

use serde_json::{Map, Value};

/// Splits `---\n yaml \n---\n body` into (frontmatter, body).
/// Files without frontmatter are all body.
pub fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (None, text);
    };
    let mut pos = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            let body = &rest[pos + line.len()..];
            return (Some(&rest[..pos]), body);
        }
        pos += line.len();
    }
    // unterminated frontmatter: treat the whole thing as body
    (None, text)
}

/// Parses frontmatter YAML into a JSON object. Anything that isn't a mapping
/// (or fails to parse) yields an empty object rather than an error, so one
/// broken file never takes down the whole vault.
pub fn parse_frontmatter(yaml: &str) -> Map<String, Value> {
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return Map::new();
    };
    match yaml_to_json(value) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

fn yaml_to_json(v: serde_yaml::Value) -> Value {
    use serde_yaml::Value as Y;
    match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                n.as_f64().map(Value::from).unwrap_or(Value::Null)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(seq) => Value::Array(seq.into_iter().map(yaml_to_json).collect()),
        Y::Mapping(m) => {
            let mut out = Map::new();
            for (k, v) in m {
                let key = match k {
                    Y::String(s) => s,
                    other => serde_yaml::to_string(&other).unwrap_or_default().trim().to_string(),
                };
                out.insert(key, yaml_to_json(v));
            }
            Value::Object(out)
        }
        Y::Tagged(t) => yaml_to_json(t.value),
    }
}

/// Renders frontmatter + body back into a markdown file.
pub fn render(front: &Map<String, Value>, body: &str) -> String {
    let yaml = if front.is_empty() {
        String::new()
    } else {
        serde_yaml::to_string(front).unwrap_or_default()
    };
    let body = body.trim_start_matches(['\n', '\r']);
    let mut out = String::with_capacity(yaml.len() + body.len() + 16);
    out.push_str("---\n");
    out.push_str(&yaml);
    out.push_str("---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
        if !body.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// Tags can be written as a YAML list or as "a, b c". Leading '#' is dropped.
pub fn normalize_tags(v: Option<&Value>) -> Vec<String> {
    let raw: Vec<String> = match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|x| match x {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) => s
            .split(|c: char| c == ',' || c.is_whitespace())
            .map(str::to_string)
            .collect(),
        _ => vec![],
    };
    let mut out: Vec<String> = Vec::new();
    for t in raw {
        let t = t.trim().trim_start_matches('#').trim().to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// Obsidian-style inline #tags in the body: `#` at the start or after
/// whitespace/punctuation, then letters, digits, `_`, `-` or `/` (nested tags),
/// with at least one non-digit. Code blocks, inline code and headings
/// (`# Title`) don't count. Returned in first-seen order, deduplicated.
pub fn inline_tags(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        let mut in_code = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && !in_code {
                let prev_ok = i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '(' | ',' | ';' | '"' | '\'');
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || matches!(chars[j], '_' | '-' | '/')) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect::<String>().trim_end_matches(['/', '-']).to_string();
                if prev_ok && !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) && !out.contains(&tag) {
                    out.push(tag);
                }
                i = j.max(i + 1);
                continue;
            }
            i += 1;
        }
    }
    out
}

/// The link target of every [[wikilink]] (and ![[embed]]) in the body,
/// with `|alias`, `#heading` and `^block` parts stripped. Code is skipped.
pub fn wikilinks(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for_each_wikilink(body, |inner, _| {
        let t = link_target(inner);
        if !t.is_empty() && !out.iter().any(|x: &String| x == t) {
            out.push(t.to_string());
        }
    });
    out
}

/// Rewrites [[old]] → [[new]] (keeping any #heading / |alias suffix).
/// Matching is case-insensitive, like Obsidian's link resolution.
pub fn rename_wikilinks(body: &str, old: &str, new: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut last = 0;
    for_each_wikilink(body, |inner, range| {
        let target = link_target(inner);
        if target.to_lowercase() == old.to_lowercase() {
            // `target` is a subslice of `inner`, so its offset is exact
            let start = target.as_ptr() as usize - inner.as_ptr() as usize;
            let suffix = &inner[start + target.len()..];
            out.push_str(&body[last..range.start]);
            out.push_str(new);
            out.push_str(suffix);
            last = range.end;
        }
    });
    out.push_str(&body[last..]);
    out
}

fn link_target(inner: &str) -> &str {
    let end = inner.find(['|', '#', '^']).unwrap_or(inner.len());
    inner[..end].trim()
}

/// Calls `f(inner_text, byte_range_of_inner)` for each [[...]] outside of
/// fenced code blocks and inline code spans.
fn for_each_wikilink(body: &str, mut f: impl FnMut(&str, std::ops::Range<usize>)) {
    let mut in_fence = false;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let bytes = line.as_bytes();
        let mut i = 0;
        let mut in_code = false;
        while i < bytes.len() {
            if bytes[i] == b'`' {
                in_code = !in_code;
                i += 1;
                continue;
            }
            if !in_code && bytes[i] == b'[' && bytes.get(i + 1) == Some(&b'[') {
                if let Some(rel) = line[i + 2..].find("]]") {
                    let s = i + 2;
                    let e = s + rel;
                    let inner = &line[s..e];
                    if !inner.contains('\n') && !inner.contains('[') {
                        f(inner, line_start + s..line_start + e);
                    }
                    i = e + 2;
                    continue;
                }
            }
            i += 1;
        }
    }
}

/// Turns a title into a safe, Obsidian-linkable file stem.
pub fn file_stem_for(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut stem = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if stem.chars().count() > 120 {
        stem = stem.chars().take(120).collect::<String>().trim_end().to_string();
    }
    if stem.is_empty() {
        "Untitled".into()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_frontmatter() {
        let (fm, body) = split_frontmatter("---\nid: a\ntags: [x]\n---\n\nHello\n");
        assert_eq!(fm, Some("id: a\ntags: [x]\n"));
        assert_eq!(body, "\nHello\n");
        assert_eq!(split_frontmatter("Just text"), (None, "Just text"));
        assert_eq!(split_frontmatter("---\nnever closed"), (None, "---\nnever closed"));
    }

    #[test]
    fn frontmatter_round_trip() {
        let mut m = Map::new();
        m.insert("id".into(), json!("abc"));
        m.insert("title".into(), json!("Writeup: JWT"));
        m.insert("tags".into(), json!(["ctf", "jwt"]));
        let text = render(&m, "Body [[Other]]");
        let (fm, body) = split_frontmatter(&text);
        assert_eq!(parse_frontmatter(fm.unwrap()), m);
        assert_eq!(body.trim(), "Body [[Other]]");
    }

    #[test]
    fn bad_yaml_is_empty() {
        assert!(parse_frontmatter(": : [").is_empty());
        assert!(parse_frontmatter("- just a list").is_empty());
    }

    #[test]
    fn tags() {
        assert_eq!(normalize_tags(Some(&json!(["#a", "b", "a"]))), vec!["a", "b"]);
        assert_eq!(normalize_tags(Some(&json!("a, #b c"))), vec!["a", "b", "c"]);
        assert!(normalize_tags(None).is_empty());
    }

    #[test]
    fn finds_inline_tags() {
        let body = "# Heading\nIdeas #ctf and #web-sec, (#nested/tag) #2024 #a1\nurl.com/page#frag `#code` a#b\n```\n#fenced\n```\n#ctf again #ends-";
        assert_eq!(inline_tags(body), vec!["ctf", "web-sec", "nested/tag", "a1", "ends"]);
    }

    #[test]
    fn finds_wikilinks() {
        let body = "See [[Foo]] and [[Bar|the bar]], ![[Baz#Part]].\n`[[Nope]]`\n```\n[[AlsoNope]]\n```\n[[Foo]]";
        assert_eq!(wikilinks(body), vec!["Foo", "Bar", "Baz"]);
    }

    #[test]
    fn renames_wikilinks() {
        let body = "[[old note]] and [[Old Note|alias]] and [[Old Note#h]] but not [[Other]]";
        assert_eq!(
            rename_wikilinks(body, "Old Note", "New"),
            "[[New]] and [[New|alias]] and [[New#h]] but not [[Other]]"
        );
    }

    #[test]
    fn stems() {
        assert_eq!(file_stem_for("Writeup: JWT none-alg bypass"), "Writeup JWT none-alg bypass");
        assert_eq!(file_stem_for("HTML / CSS / JavaScript"), "HTML CSS JavaScript");
        assert_eq!(file_stem_for("  ..  "), "Untitled");
    }
}
