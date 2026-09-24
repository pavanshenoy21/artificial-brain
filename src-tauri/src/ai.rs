//! OpenAI-compatible HTTP client for chat completions and embeddings.
//! Works with a local llama.cpp server (`llama-server`) and Groq alike.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{err, Result};
use crate::settings::{AiSettings, EmbedSettings};

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("http client")
    })
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), path)
}

async fn post(url: &str, key: &str, body: Value) -> Result<Value> {
    let mut req = client().post(url).json(&body);
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }
    let res = req.send().await.map_err(|e| {
        if e.is_connect() { format!("can't reach {url}") } else if e.is_timeout() { "request timed out".into() } else { e.to_string() }
    })?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // surface the provider's message, never the request (it may hold the key)
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return err(format!("HTTP {status}: {msg}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad response: {e}").into())
}

#[derive(Clone, Copy)]
pub struct ChatOpts {
    pub max_tokens: u32,
    pub temperature: f32,
}

impl Default for ChatOpts {
    fn default() -> Self {
        ChatOpts { max_tokens: 800, temperature: 0.2 }
    }
}

/// One chat completion; `messages` = [(role, content)].
pub async fn chat(ai: &AiSettings, messages: &[(&str, &str)], opts: ChatOpts) -> Result<String> {
    if !ai.enabled() {
        return err("AI off");
    }
    let mut body = json!({
        "messages": messages.iter().map(|(r, c)| json!({ "role": r, "content": c })).collect::<Vec<_>>(),
        "max_tokens": opts.max_tokens,
        "temperature": opts.temperature,
        "stream": false,
    });
    if !ai.model.trim().is_empty() {
        body["model"] = ai.model.trim().into();
    }
    let v = post(&endpoint(&ai.base_url, "chat/completions"), &ai.api_key, body).await?;
    let text = v.pointer("/choices/0/message/content").and_then(Value::as_str).ok_or("no answer in response")?;
    Ok(strip_think(text).trim().to_string())
}

/// Some local reasoning models prefix answers with <think>…</think>.
fn strip_think(s: &str) -> &str {
    match (s.find("<think>"), s.find("</think>")) {
        (Some(a), Some(b)) if a < b => &s[b + "</think>".len()..],
        _ => s,
    }
}

/// Embeds a batch of texts; one vector per input, in order.
pub async fn embed(cfg: &EmbedSettings, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    if !cfg.enabled() {
        return err("embeddings off");
    }
    let mut body = json!({ "input": texts });
    if !cfg.model.trim().is_empty() {
        body["model"] = cfg.model.trim().into();
    }
    let v = post(&endpoint(&cfg.base_url, "embeddings"), "", body).await?;
    let data = v.get("data").and_then(Value::as_array).ok_or("no data in response")?;
    let mut out: Vec<(usize, Vec<f32>)> = data
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let idx = d.get("index").and_then(Value::as_u64).map(|x| x as usize).unwrap_or(i);
            let vec = d
                .get("embedding")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_f64).map(|x| x as f32).collect())
                .unwrap_or_default();
            (idx, vec)
        })
        .collect();
    out.sort_by_key(|(i, _)| *i);
    if out.len() != texts.len() || out.iter().any(|(_, v)| v.is_empty()) {
        return err("embedding server returned the wrong number of vectors");
    }
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn think_blocks_are_stripped() {
        assert_eq!(strip_think("<think>hmm</think>\nAnswer"), "\nAnswer");
        assert_eq!(strip_think("Answer"), "Answer");
    }

    /// Serves one canned HTTP response on 127.0.0.1 and returns (base_url, request text).
    fn fake_server(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let h = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let mut req = String::new();
            // read headers + body (small requests; stop once Content-Length is satisfied)
            loop {
                let n = sock.read(&mut buf).unwrap();
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(end) = req.find("\r\n\r\n") {
                    let len = req.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if req.len() >= end + 4 + len { break; }
                }
                if n == 0 { break; }
            }
            sock.write_all(reply.as_bytes()).unwrap();
            req
        });
        (base, h)
    }

    #[test]
    fn chat_parses_openai_shape_and_sends_key() {
        let (base, h) = fake_server("200 OK", r#"{"choices":[{"message":{"content":"<think>x</think> ok "}}]}"#);
        let ai = AiSettings { provider: "custom".into(), base_url: base, model: "m1".into(), api_key: "sk-test".into() };
        let out = tauri::async_runtime::block_on(chat(&ai, &[("user", "hi")], ChatOpts::default())).unwrap();
        assert_eq!(out, "ok");
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /v1/chat/completions"));
        assert!(req.to_lowercase().contains("authorization: bearer sk-test"));
        assert!(req.contains(r#""model":"m1""#));
    }

    #[test]
    fn errors_surface_the_provider_message() {
        let (base, h) = fake_server("401 Unauthorized", r#"{"error":{"message":"Invalid API Key"}}"#);
        let ai = AiSettings { provider: "groq".into(), base_url: base, model: String::new(), api_key: "bad".into() };
        let e = tauri::async_runtime::block_on(chat(&ai, &[("user", "hi")], ChatOpts::default())).unwrap_err();
        assert!(e.to_string().contains("Invalid API Key") && e.to_string().contains("401"));
        h.join().unwrap();
        let off = AiSettings::default();
        assert!(tauri::async_runtime::block_on(chat(&off, &[], ChatOpts::default())).is_err());
    }

    #[test]
    fn embed_keeps_input_order() {
        let (base, h) = fake_server("200 OK", r#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#);
        let cfg = EmbedSettings { base_url: base, ..Default::default() };
        let v = tauri::async_runtime::block_on(embed(&cfg, &["a".into(), "b".into()])).unwrap();
        assert_eq!(v, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        assert!(h.join().unwrap().starts_with("POST /v1/embeddings"));
    }

    #[test]
    fn endpoints_join_cleanly() {
        assert_eq!(endpoint("http://127.0.0.1:8080/v1/", "embeddings"), "http://127.0.0.1:8080/v1/embeddings");
        assert_eq!(endpoint(" https://api.groq.com/openai/v1 ", "chat/completions"), "https://api.groq.com/openai/v1/chat/completions");
    }
}
