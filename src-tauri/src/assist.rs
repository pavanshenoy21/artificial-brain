//! On-demand AI actions: Polish, Summarize, Fill form, and tag/lobe
//! suggestions. Nothing is written here except by `ai_apply`, which keeps the
//! original in `.brain/history/` first. Prompts forbid adding facts.

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::ai::{self, ChatOpts};
use crate::error::{err, Result};
use crate::state::AppState;

type Cmd<T> = std::result::Result<T, String>;

const RULES: &str = "Rules: never add facts, names, numbers, links or opinions that are not in the input. \
Keep every [[wikilink]], URL, code block and markdown structure exactly as written. \
Reply with the result only: no preamble, no explanation, no surrounding quotes or code fences.";

pub fn polish_prompt() -> String {
    format!("You edit notes in a personal knowledge base. Fix grammar, spelling and clarity, and tighten wordy sentences, \
             but keep the author's meaning, voice, language and level of detail. {RULES}")
}

pub fn summarize_prompt() -> String {
    format!("You summarise notes in a personal knowledge base in 1-3 plain sentences. \
             Only restate what the text says. {RULES}")
}

pub fn fill_prompt(kind: &str, fields: &[(&str, &str)]) -> String {
    let list = fields.iter().map(|(k, hint)| format!("- {k}: {hint}")).collect::<Vec<_>>().join("\n");
    format!(
        "You turn messy notes into form fields for a {kind}. Fields:\n{list}\n\
         Reply with one JSON object using only these keys. Use a value only if the text states it; \
         otherwise leave the key out. Never guess or invent values. Lists are JSON arrays of strings. \
         Reply with the JSON only."
    )
}

/// Fields the model may fill, per type (key, hint).
pub fn form_fields(kind: &str) -> Vec<(&'static str, &'static str)> {
    match kind {
        "skill" => vec![("level", "one of beginner, intermediate, advanced"), ("since", "year or year-month, e.g. 2025-08")],
        "hackathon" => vec![
            ("date", "YYYY-MM-DD"), ("location", "place"), ("role", "e.g. Participant, Organizer, Mentor"),
            ("team", "list of names"), ("built", "what was built, one or two sentences"), ("stack", "list of technologies"),
            ("result", "e.g. Winner, Finalist"), ("repo", "repository URL"),
        ],
        "project" => vec![("status", "one of idea, active, paused, shipped, archived"), ("role", "the author's role"), ("stack", "list of technologies")],
        "link" => vec![("summary", "1-3 sentences on what the page is")],
        _ => vec![],
    }
}

/// Strips ``` fences / quotes some models wrap answers in.
pub fn unwrap_answer(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```markdown")).or_else(|| t.strip_prefix("```md")).or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    t.to_string()
}

/// Parses the fill-form answer, keeping only known keys with sane values.
pub fn parse_fill(answer: &str, kind: &str) -> Result<Map<String, Value>> {
    let text = unwrap_answer(answer);
    let start = text.find('{').ok_or("the model didn't return JSON")?;
    let end = text.rfind('}').ok_or("the model didn't return JSON")?;
    let v: Value = serde_json::from_str(&text[start..=end]).map_err(|e| format!("bad JSON from the model: {e}"))?;
    let allowed: Vec<&str> = form_fields(kind).iter().map(|(k, _)| *k).collect();
    let mut out = Map::new();
    for (k, v) in v.as_object().cloned().unwrap_or_default() {
        if !allowed.contains(&k.as_str()) {
            continue;
        }
        let v = match v {
            Value::String(s) if s.trim().is_empty() => continue,
            Value::String(s) => Value::String(s.trim().to_string()),
            Value::Array(a) => {
                let list: Vec<Value> = a.into_iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).map(Value::from).collect();
                if list.is_empty() {
                    continue;
                }
                Value::Array(list)
            }
            Value::Number(n) => Value::String(n.to_string()),
            _ => continue,
        };
        out.insert(k, v);
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Suggestion {
    pub tags: Vec<String>,
    pub lobe: Option<String>,
}

/// Keeps only tags that already exist (max 3, not already on the item) and a lobe that exists.
pub fn clean_suggestion(answer: &str, existing_tags: &[String], have: &[String], lobes: &[String]) -> Suggestion {
    let text = unwrap_answer(answer);
    let v: Value = text.find('{').and_then(|a| text.rfind('}').map(|b| &text[a..=b])).and_then(|j| serde_json::from_str(j).ok()).unwrap_or(Value::Null);
    let norm = |s: &str| s.trim().trim_start_matches('#').to_lowercase();
    let mut tags = Vec::new();
    for t in v.get("tags").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(t) = t.as_str() else { continue };
        if let Some(real) = existing_tags.iter().find(|e| norm(e) == norm(t)) {
            if !have.contains(real) && !tags.contains(real) {
                tags.push(real.clone());
            }
        }
        if tags.len() == 3 {
            break;
        }
    }
    let lobe = v.get("lobe").and_then(Value::as_str).and_then(|l| lobes.iter().find(|x| norm(x) == norm(l)).cloned());
    Suggestion { tags, lobe }
}

// ---------------------------------------------------------------- commands

async fn chat(state: &State<'_, AppState>, system: &str, user: &str, max_tokens: u32) -> Result<String> {
    let s = state.settings();
    if !s.ai.enabled() {
        return err("No AI provider set up (Settings → AI provider).");
    }
    ai::chat(&s.ai, &[("system", system), ("user", user)], ChatOpts { max_tokens, temperature: 0.2 }).await
}

#[tauri::command]
pub async fn ai_polish(state: State<'_, AppState>, text: String) -> Cmd<String> {
    let out = chat(&state, &polish_prompt(), &text, 2000).await.map_err(|e| e.to_string())?;
    Ok(unwrap_answer(&out))
}

#[tauri::command]
pub async fn ai_summarize(state: State<'_, AppState>, text: String) -> Cmd<String> {
    let out = chat(&state, &summarize_prompt(), &text, 300).await.map_err(|e| e.to_string())?;
    Ok(unwrap_answer(&out))
}

#[tauri::command]
pub async fn ai_fill_form(state: State<'_, AppState>, kind: String, text: String) -> Cmd<Map<String, Value>> {
    let fields = form_fields(&kind);
    if fields.is_empty() {
        return Err(format!("{kind} has no form to fill"));
    }
    let out = chat(&state, &fill_prompt(&kind, &fields), &text, 600).await.map_err(|e| e.to_string())?;
    parse_fill(&out, &kind).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_suggest(state: State<'_, AppState>, id: String) -> Cmd<Suggestion> {
    let (item, tags, lobes) = state
        .with_store(|s| {
            let item = s.get(&id)?.ok_or("item not found")?;
            let tags: Vec<String> = s.tags()?.into_iter().map(|(t, _)| t).collect();
            let lobes = s.lobes()?;
            Ok((item, tags, lobes))
        })
        .map_err(|e| e.to_string())?;
    if tags.is_empty() && lobes.is_empty() {
        return Ok(Suggestion { tags: vec![], lobe: None });
    }
    let lobe_list = lobes.iter().map(|l| format!("{} ({})", l.id, l.name)).collect::<Vec<_>>().join(", ");
    let system = format!(
        "You file items in a personal knowledge base. Choose up to 3 tags ONLY from this list: {}. \
         Choose one lobe id ONLY from: {lobe_list}. If nothing fits, use an empty list / null. \
         Reply with JSON only: {{\"tags\": [...], \"lobe\": \"id\"}}",
        tags.join(", ")
    );
    let text = crate::embed::item_text(&item);
    let out = chat(&state, &system, &text, 120).await.map_err(|e| e.to_string())?;
    let lobe_ids: Vec<String> = lobes.iter().map(|l| l.id.clone()).collect();
    let mut sug = clean_suggestion(&out, &tags, &item.all_tags(), &lobe_ids);
    if item.lobe.as_ref() == sug.lobe.as_ref() {
        sug.lobe = None;
    }
    Ok(sug)
}

/// Applies an accepted AI change, keeping the original in .brain/history/.
#[tauri::command]
pub async fn ai_apply(app: AppHandle, state: State<'_, AppState>, id: String, patch: Map<String, Value>) -> Cmd<crate::vault::Item> {
    let item = state
        .with_store(|s| {
            let original = s.vault.read(&s.file_of(&id)?)?;
            s.vault.save_history(&original)?;
            s.update(&id, patch)
        })
        .map_err(|e| e.to_string())?;
    let _ = app.emit("vault-changed", json!({ "kind": "items" }));
    crate::embed::schedule(&app, vec![id]);
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_forbid_new_facts() {
        for p in [polish_prompt(), summarize_prompt(), fill_prompt("skill", &form_fields("skill"))] {
            assert!(p.to_lowercase().contains("never"), "{p}");
        }
    }

    #[test]
    fn fill_keeps_known_keys_only() {
        let answer = "```json\n{\"date\": \"2026-03-01\", \"stack\": [\"Rust\", \" \", \"Tauri\"], \"team\": [], \"built\": \"\", \"prize\": \"$1M\", \"role\": 3}\n```";
        let m = parse_fill(answer, "hackathon").unwrap();
        assert_eq!(Value::Object(m), json!({ "date": "2026-03-01", "stack": ["Rust", "Tauri"], "role": "3" }));
        assert!(parse_fill("sorry, I can't", "skill").is_err());
    }

    #[test]
    fn suggestions_only_use_existing_tags_and_lobes() {
        let existing = vec!["ctf".to_string(), "linux".into(), "web".into(), "docker".into()];
        let s = clean_suggestion(r##"{"tags": ["#CTF", "hacking", "linux", "docker", "web"], "lobe": "SEC"}"##, &existing, &["docker".into()], &["sec".into(), "web".into()]);
        assert_eq!(s, Suggestion { tags: vec!["ctf".into(), "linux".into(), "web".into()], lobe: Some("sec".into()) });
        let s = clean_suggestion("not json", &existing, &[], &[]);
        assert_eq!(s, Suggestion { tags: vec![], lobe: None });
    }

    #[test]
    fn answers_are_unwrapped() {
        assert_eq!(unwrap_answer("```markdown\nHello\n```"), "Hello");
        assert_eq!(unwrap_answer("  plain  "), "plain");
    }
}
