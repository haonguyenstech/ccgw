use crate::settings::{self, Config};
use axum::{body::Body, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::VecDeque, convert::Infallible, path::PathBuf, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use subtle::ConstantTimeEq;
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, sync::{mpsc, oneshot}};

/// Upper bound for one request; the CLI child is killed when it is exceeded.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const RECENT_LIMIT: usize = 60;
pub const DEFAULT_SYSTEM: &str = "You are Claude, an AI assistant made by Anthropic.";

pub const MODELS: &[(&str, &str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5", "opus"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", "sonnet"),
    ("claude-haiku-5-5", "Claude Haiku 5.5", "haiku"),
    ("claude-fable-5-1", "Claude Fable 5.1", ""),
];

// ---------- activity log shared with the UI ----------

#[derive(Clone, Serialize)]
pub struct RequestLog {
    pub at: u64,
    pub model: String,
    pub stream: bool,
    pub status: u16,
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub error: Option<String>,
}

#[derive(Clone, Default, Serialize)]
pub struct ActivitySnapshot {
    pub total: u64,
    pub failed: u64,
    pub active: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub recent: Vec<RequestLog>,
    pub rate_limit: Option<Value>,
}

#[derive(Default)]
pub struct Activity { snapshot: ActivitySnapshot, recent: VecDeque<RequestLog> }
pub type SharedActivity = Arc<Mutex<Activity>>;

impl Activity {
    pub(crate) fn set_rate_limit(&mut self, info: Value) { self.snapshot.rate_limit = Some(info); }
    pub fn snapshot(&self) -> ActivitySnapshot {
        let mut s = self.snapshot.clone();
        s.recent = self.recent.iter().rev().cloned().collect();
        s
    }
    fn record(&mut self, log: RequestLog) {
        self.snapshot.total += 1;
        if log.status >= 400 { self.snapshot.failed += 1; }
        self.snapshot.input_tokens += log.input_tokens;
        self.snapshot.output_tokens += log.output_tokens;
        self.recent.push_back(log);
        while self.recent.len() > RECENT_LIMIT { self.recent.pop_front(); }
    }
}

/// Counts a request as active until it is recorded (or dropped on client disconnect).
pub(crate) struct Tracker { activity: SharedActivity, model: String, stream: bool, started: Instant, start_wall: u64, done: bool, input: u64, output: u64 }

impl Tracker {
    pub(crate) fn new(activity: &SharedActivity, model: &str, stream: bool) -> Self {
        activity.lock().unwrap().snapshot.active += 1;
        Tracker { activity: activity.clone(), model: model.into(), stream, started: Instant::now(), start_wall: now_secs(), done: false, input: 0, output: 0 }
    }
    pub(crate) fn usage(&mut self, usage: &Value) {
        let input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].iter().map(|k| usage[*k].as_u64().unwrap_or(0)).sum::<u64>();
        if input > 0 { self.input = input; }
        if let Some(out) = usage["output_tokens"].as_u64() { if out > 0 { self.output = out; } }
    }
    pub(crate) fn finish(&mut self, status: u16, error: Option<String>) {
        if self.done { return; }
        self.done = true;
        let mut a = self.activity.lock().unwrap();
        a.snapshot.active = a.snapshot.active.saturating_sub(1);
        a.record(RequestLog { at: self.start_wall, model: self.model.clone(), stream: self.stream, status, duration_ms: self.started.elapsed().as_millis() as u64, input_tokens: self.input, output_tokens: self.output, error: error.map(|e| e.chars().take(300).collect()) });
    }
}

impl Drop for Tracker {
    fn drop(&mut self) { self.finish(499, Some("Client đã ngắt kết nối".into())); }
}

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

// ---------- Claude Code discovery ----------

pub fn claude_executable(path: &str) -> String {
    if !path.is_empty() { return path.into(); }
    crate::platform::claude_candidates().into_iter().find(|p| p.is_file()).map(|p| p.display().to_string()).unwrap_or_else(|| "claude".into())
}

/// Returns the CLI version, cached for 30 s so the UI can poll cheaply.
pub fn claude_version(path: &str) -> Option<String> {
    static CACHE: Mutex<Option<(String, Instant, Option<String>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap();
    if let Some((p, at, v)) = cache.as_ref() {
        if p == path && at.elapsed() < Duration::from_secs(30) { return v.clone(); }
    }
    let version = crate::platform::command(claude_executable(path)).arg("--version").stderr(Stdio::null()).output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    *cache = Some((path.into(), Instant::now(), version.clone()));
    version
}

pub fn claude_available(path: &str) -> bool { claude_version(path).is_some() }

pub(crate) fn workspace() -> PathBuf {
    let dir = settings::config_path().with_file_name("workspace");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ---------- HTTP server ----------

#[derive(Clone)]
struct GatewayState { config: Arc<Config>, activity: SharedActivity, bridge: crate::bridge::SharedBridge }

pub async fn run(listener: std::net::TcpListener, config: Config, activity: SharedActivity, shutdown: oneshot::Receiver<()>) -> Result<(), String> {
    let config = Arc::new(config);
    let bridge = crate::bridge::Bridge::new(config.clone(), activity.clone());
    let state = GatewayState { config, activity, bridge: bridge.clone() };
    let evictor = { let bridge = bridge.clone(); tokio::spawn(async move {
        loop { tokio::time::sleep(Duration::from_secs(60)).await; bridge.evict(); }
    }) };
    let app = Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/models/{id}", get(model))
        .route("/v1/messages/count_tokens", post(count_tokens))
        .route("/v1/messages", post(messages))
        .route("/mcp/{token}", post(mcp).get(mcp_get).delete(mcp_delete))
        .fallback(not_found)
        .with_state(state);
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;
    let result = axum::serve(listener, app).with_graceful_shutdown({ let bridge = bridge.clone(); async move { let _ = shutdown.await; bridge.close_all(); } }).await.map_err(|e| e.to_string());
    evictor.abort();
    bridge.close_all();
    result
}

/// MCP endpoint for one session's CLI. The unguessable token in the path is the credential.
async fn mcp(State(state): State<GatewayState>, Path(token): Path<String>, Json(body): Json<Value>) -> Response {
    state.bridge.mcp(&token, body).await
}
async fn mcp_get() -> StatusCode { StatusCode::METHOD_NOT_ALLOWED }
async fn mcp_delete() -> StatusCode { StatusCode::OK }

async fn health(State(state): State<GatewayState>) -> Json<Value> {
    let active = state.activity.lock().unwrap().snapshot.active;
    Json(json!({"ok": true, "name": "ccgw-desktop", "version": env!("CARGO_PKG_VERSION"), "active": active, "sessions": state.bridge.session_count()}))
}

async fn not_found(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.config.api_key) { return unauthorized(); }
    error(StatusCode::NOT_FOUND, "not_found_error", "endpoint is not supported")
}

fn authorized(headers: &HeaderMap, key: &str) -> bool {
    let supplied = headers.get("x-api-key").or_else(|| headers.get("authorization"))
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let supplied = if supplied.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer ")) { &supplied[7..] } else { supplied };
    supplied.as_bytes().ct_eq(key.as_bytes()).into()
}

pub(crate) fn error(status: StatusCode, kind: &str, message: &str) -> Response {
    (status, Json(json!({"type": "error", "error": {"type": kind, "message": message}}))).into_response()
}
fn unauthorized() -> Response { error(StatusCode::UNAUTHORIZED, "authentication_error", "invalid api key") }

fn model_value((id, display_name, tier): &(&str, &str, &str)) -> Value {
    let mut value = json!({"type": "model", "id": id, "display_name": display_name, "created_at": "2026-01-01T00:00:00Z", "supports_1m": false, "max_input_tokens": 200000});
    if !tier.is_empty() {
        value["anthropic_family_tier"] = json!(tier);
        value["is_family_default"] = json!(true);
    }
    value
}

async fn models(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.config.api_key) { return unauthorized(); }
    Json(json!({"data": MODELS.iter().map(model_value).collect::<Vec<_>>(), "has_more": false, "first_id": MODELS[0].0, "last_id": MODELS[MODELS.len()-1].0})).into_response()
}

async fn model(State(state): State<GatewayState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.config.api_key) { return unauthorized(); }
    MODELS.iter().find(|m| m.0 == id).map(|m| Json(model_value(m)).into_response())
        .unwrap_or_else(|| error(StatusCode::NOT_FOUND, "not_found_error", "model not found"))
}

async fn count_tokens(State(state): State<GatewayState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !authorized(&headers, &state.config.api_key) { return unauthorized(); }
    let chars = body.to_string().chars().count();
    Json(json!({"input_tokens": (chars as f64 / 3.5).ceil() as usize})).into_response()
}

// ---------- request translation ----------

fn block_text(content: &Value) -> String {
    if let Some(s) = content.as_str() { return s.into(); }
    content.as_array().map(|items| items.iter().map(|item| {
        match item["type"].as_str().unwrap_or("") {
            "text" => item["text"].as_str().unwrap_or("").to_owned(),
            "tool_use" => format!("[called tool {}]", item["name"].as_str().unwrap_or("?")),
            "tool_result" => format!("[tool result: {}]", block_text(&item["content"])),
            "image" | "document" => format!("[{} omitted: this gateway only forwards text]", item["type"].as_str().unwrap_or("media")),
            _ => String::new(),
        }
    }).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn system_prompt(body: &Value) -> String {
    let s = body.get("system").map(block_text).unwrap_or_default();
    if s.trim().is_empty() { DEFAULT_SYSTEM.into() } else { s }
}

/// A single user turn is sent as-is; longer conversations become a tagged transcript.
fn prompt(body: &Value) -> Result<String, String> {
    let messages = body["messages"].as_array().ok_or("messages must be an array")?;
    if messages.last().and_then(|m| m["role"].as_str()) != Some("user") {
        return Err("last message must be a user message".into());
    }
    if messages.len() == 1 { return Ok(block_text(&messages[0]["content"])); }
    let mut out = String::from("Below is the conversation so far. Reply to the final user message as the assistant; do not repeat the tags.\n\n");
    for message in messages {
        let role = if message["role"] == "assistant" { "assistant" } else { "user" };
        out.push_str(&format!("<{role}>\n{}\n</{role}>\n\n", block_text(&message["content"])));
    }
    Ok(out)
}

pub(crate) fn cli_model(body: &Value) -> String {
    body["model"].as_str().unwrap_or(MODELS[1].0).trim_end_matches("[1m]").to_string()
}

// ---------- Claude Code process ----------

enum Ev { Event(Value), Done(Value), Failed(String) }

fn spawn_claude(config: &Config, model: &str, system: &str, prompt: String, activity: SharedActivity) -> Result<mpsc::Receiver<Ev>, String> {
    let mut child = crate::platform::tokio_command(claude_executable(&config.claude_path))
        .args(["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
               "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
               "--model", model, "--system-prompt", system])
        .current_dir(workspace())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn().map_err(|e| format!("Không chạy được Claude Code: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel(256);
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
        let mut lines = BufReader::new(stdout).lines();
        let deadline = tokio::time::sleep(REQUEST_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            let line = tokio::select! {
                line = lines.next_line() => line,
                _ = &mut deadline => { let _ = tx.send(Ev::Failed("Claude Code quá thời gian".into())).await; return; }
            };
            let Ok(Some(line)) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let sent = match v["type"].as_str() {
                Some("stream_event") if v["parent_tool_use_id"].is_null() => tx.send(Ev::Event(v["event"].clone())).await,
                Some("rate_limit_event") => { activity.lock().unwrap().snapshot.rate_limit = Some(v["rate_limit_info"].clone()); Ok(()) },
                Some("result") => { let _ = tx.send(Ev::Done(v)).await; return; },
                _ => Ok(()),
            };
            if sent.is_err() { return; } // client went away: dropping `child` kills the CLI
        }
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err).await;
        let status = child.wait().await.ok();
        let msg = if err.trim().is_empty() { format!("Claude Code dừng bất thường ({})", status.map(|s| s.to_string()).unwrap_or_default()) } else { err.trim().to_string() };
        let _ = tx.send(Ev::Failed(msg)).await;
    });
    Ok(rx)
}

/// A CLI failure as an HTTP error, with a sign-in hint when that is the cause.
fn cli_error(err: &str) -> (StatusCode, String) {
    match crate::bridge::login_hint(err) { Some(h) => (StatusCode::BAD_REQUEST, h), None => (StatusCode::BAD_GATEWAY, err.to_string()) }
}

fn result_error(result: &Value) -> Option<String> {
    (result["is_error"].as_bool() == Some(true) || result["subtype"].as_str().is_some_and(|s| s != "success"))
        .then(|| result["result"].as_str().unwrap_or("Claude Code báo lỗi").to_string())
}

fn sse(name: &str, data: &Value) -> String { format!("event: {name}\ndata: {data}\n\n") }

/// Events for a reply that arrived without partial messages.
fn synthetic_events(id: &str, model: &str, text: &str, usage: &Value) -> String {
    [
        sse("message_start", &json!({"type": "message_start", "message": {"id": id, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": usage["input_tokens"], "output_tokens": 0}}})),
        sse("content_block_start", &json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})),
        sse("content_block_delta", &json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}})),
        sse("content_block_stop", &json!({"type": "content_block_stop", "index": 0})),
        sse("message_delta", &json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": usage["output_tokens"]}})),
        sse("message_stop", &json!({"type": "message_stop"})),
    ].concat()
}

async fn messages(State(state): State<GatewayState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !authorized(&headers, &state.config.api_key) { return unauthorized(); }
    // Desktop's side requests (chat titles…) are one non-streamed turn without tools:
    // a throwaway process. Everything else keeps a conversation session.
    let one_shot = body["stream"] != true && body["tools"].as_array().is_none_or(|t| t.is_empty());
    if !one_shot { return state.bridge.messages(body).await; }
    let model = cli_model(&body);
    let stream = body["stream"].as_bool() == Some(true);
    let mut tracker = Tracker::new(&state.activity, &model, stream);
    let prompt = match prompt(&body) {
        Ok(p) => p,
        Err(e) => { tracker.finish(400, Some(e.clone())); return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e); }
    };
    let mut rx = match spawn_claude(&state.config, &model, &system_prompt(&body), prompt, state.activity.clone()) {
        Ok(rx) => rx,
        Err(e) => { tracker.finish(502, Some(e.clone())); return error(StatusCode::BAD_GATEWAY, "api_error", &e); }
    };
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());

    if !stream {
        let mut text = String::new();
        let mut stop_reason = Value::from("end_turn");
        while let Some(ev) = rx.recv().await {
            match ev {
                Ev::Event(e) => {
                    if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" { text.push_str(e["delta"]["text"].as_str().unwrap_or("")); }
                    if e["type"] == "message_start" { tracker.usage(&e["message"]["usage"]); }
                    if e["type"] == "message_delta" { tracker.usage(&e["usage"]); if !e["delta"]["stop_reason"].is_null() { stop_reason = e["delta"]["stop_reason"].clone(); } }
                },
                Ev::Done(result) => {
                    if let Some(err) = result_error(&result) { tracker.finish(502, Some(err.clone())); return { let (st, m) = cli_error(&err); error(st, if st == StatusCode::BAD_REQUEST { "invalid_request_error" } else { "api_error" }, &m) }; }
                    tracker.usage(&result["usage"]);
                    if text.is_empty() { text = result["result"].as_str().unwrap_or("").into(); }
                    let usage = json!({"input_tokens": tracker.input, "output_tokens": tracker.output});
                    tracker.finish(200, None);
                    return Json(json!({"id": id, "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": text}], "stop_reason": stop_reason, "stop_sequence": null, "usage": usage})).into_response();
                },
                Ev::Failed(err) => { tracker.finish(502, Some(err.clone())); return { let (st, m) = cli_error(&err); error(st, if st == StatusCode::BAD_REQUEST { "invalid_request_error" } else { "api_error" }, &m) }; },
            }
        }
        tracker.finish(502, Some("Claude Code không trả kết quả".into()));
        return error(StatusCode::BAD_GATEWAY, "api_error", "Claude Code không trả kết quả");
    }

    // Streaming: wait for the first event so CLI failures still map to a proper HTTP error.
    let first = match rx.recv().await {
        Some(Ev::Event(e)) => e,
        Some(Ev::Done(result)) => {
            if let Some(err) = result_error(&result) { tracker.finish(502, Some(err.clone())); return { let (st, m) = cli_error(&err); error(st, if st == StatusCode::BAD_REQUEST { "invalid_request_error" } else { "api_error" }, &m) }; }
            tracker.usage(&result["usage"]);
            let usage = json!({"input_tokens": tracker.input, "output_tokens": tracker.output});
            tracker.finish(200, None);
            return ([("content-type", "text/event-stream"), ("cache-control", "no-cache")], synthetic_events(&id, &model, result["result"].as_str().unwrap_or(""), &usage)).into_response();
        },
        Some(Ev::Failed(err)) => { tracker.finish(502, Some(err.clone())); return { let (st, m) = cli_error(&err); error(st, if st == StatusCode::BAD_REQUEST { "invalid_request_error" } else { "api_error" }, &m) }; },
        None => { tracker.finish(502, Some("Claude Code không trả kết quả".into())); return error(StatusCode::BAD_GATEWAY, "api_error", "Claude Code không trả kết quả"); },
    };
    let (out_tx, out_rx) = mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let mut next = Some(Ev::Event(first));
        let mut stopped = false;
        loop {
            let ev = match next.take() { Some(ev) => ev, None => match rx.recv().await { Some(ev) => ev, None => break } };
            match ev {
                Ev::Event(mut e) => {
                    let kind = e["type"].as_str().unwrap_or("").to_string();
                    if kind == "message_start" { tracker.usage(&e["message"]["usage"]); e["message"]["id"] = json!(id); }
                    if kind == "message_delta" { tracker.usage(&e["usage"]); }
                    if kind == "message_stop" { stopped = true; }
                    if out_tx.send(sse(&kind, &e)).await.is_err() { return; } // tracker drop logs 499
                },
                Ev::Done(result) => {
                    if let Some(err) = result_error(&result) {
                        let _ = out_tx.send(sse("error", &json!({"type": "error", "error": {"type": "api_error", "message": err}}))).await;
                        tracker.finish(502, Some(err));
                        return;
                    }
                    if !stopped { let _ = out_tx.send(sse("message_stop", &json!({"type": "message_stop"}))).await; }
                    tracker.finish(200, None);
                    return;
                },
                Ev::Failed(err) => {
                    let _ = out_tx.send(sse("error", &json!({"type": "error", "error": {"type": "api_error", "message": err}}))).await;
                    tracker.finish(502, Some(err));
                    return;
                },
            }
        }
        tracker.finish(if stopped { 200 } else { 502 }, (!stopped).then(|| "Claude Code dừng giữa chừng".to_string()));
    });
    let body = Body::from_stream(futures_util::stream::unfold(out_rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (Ok::<_, Infallible>(chunk), rx))
    }));
    ([("content-type", "text/event-stream"), ("cache-control", "no-cache")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_turn_is_sent_verbatim() {
        let body = json!({"system": "Be concise", "messages": [{"role": "user", "content": "hello"}]});
        assert_eq!(prompt(&body).unwrap(), "hello");
        assert_eq!(system_prompt(&body), "Be concise");
        assert_eq!(system_prompt(&json!({})), DEFAULT_SYSTEM);
    }

    #[test]
    fn multi_turn_becomes_a_transcript() {
        let body = json!({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": [{"type": "text", "text": "hey"}]}, {"role": "user", "content": "again"}]});
        let p = prompt(&body).unwrap();
        assert!(p.contains("<user>\nhi\n</user>") && p.contains("<assistant>\nhey\n</assistant>") && p.ends_with("<user>\nagain\n</user>\n\n"));
    }

    #[test]
    fn rejects_assistant_as_last_turn() {
        assert!(prompt(&json!({"messages": [{"role": "assistant", "content": "hi"}]})).is_err());
    }

    #[test]
    fn strips_1m_suffix_and_detects_errors() {
        assert_eq!(cli_model(&json!({"model": "claude-opus-5-5[1m]"})), "claude-opus-5-5");
        assert!(result_error(&json!({"type": "result", "subtype": "success", "is_error": false})).is_none());
        assert_eq!(result_error(&json!({"type": "result", "is_error": true, "result": "boom"})).unwrap(), "boom");
    }

    #[test]
    fn activity_keeps_recent_window() {
        let activity: SharedActivity = Default::default();
        for i in 0..(RECENT_LIMIT + 5) {
            let mut t = Tracker::new(&activity, "m", false);
            t.output = i as u64;
            t.finish(if i % 2 == 0 { 200 } else { 502 }, None);
        }
        let s = activity.lock().unwrap().snapshot();
        assert_eq!(s.total as usize, RECENT_LIMIT + 5);
        assert_eq!(s.recent.len(), RECENT_LIMIT);
        assert_eq!(s.active, 0);
        assert_eq!(s.recent[0].output_tokens as usize, RECENT_LIMIT + 4);
    }
}
