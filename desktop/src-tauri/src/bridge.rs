//! Conversation sessions with Desktop's client tools bridged into Claude Code.
//!
//! Port of ccgw's `server.mjs`:
//!  - One long-lived Claude Code process per Desktop conversation (stream-json in
//!    and out), so a follow-up costs one prompt write instead of a replay.
//!  - Desktop's tools are offered to that process as an MCP server ("desktop")
//!    served by this gateway at `/mcp/<token>`. When the model calls one, the CLI
//!    blocks inside our `tools/call`; the HTTP response to Desktop ends with a
//!    `tool_use` stop, and the next request's `tool_result` unblocks the CLI.
//!  - Raw CLI stream events are merged into one Messages-API response; the CLI's
//!    own tool blocks are hidden.
use crate::gateway::{self, SharedActivity, Tracker};
use crate::settings::Config;
use axum::{body::Body, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, convert::Infallible, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::Command, sync::{mpsc, oneshot}};

const TOOL_PREFIX: &str = "mcp__desktop__";
const TOOL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_SESSIONS: usize = 8;
const KEEP_MEDIA: usize = 8;
const KEEP_MEDIA_BYTES: usize = 16 * 1024 * 1024;

fn debug() -> bool { std::env::var_os("CCGW_DEBUG").is_some() }

pub fn sha(s: &str) -> String { hex::encode(Sha256::digest(s.as_bytes()))[..16].to_string() }

// ---------------------------------------------------------------- request shaping

fn blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => vec![json!({"type": "text", "text": s})],
        Value::Array(a) => a.clone(),
        _ => vec![],
    }
}

/// Claude Code clients put a billing/version header in the first system block; the
/// CLI adds its own, so forwarding theirs makes the API judge the client's version.
pub fn system_text(system: &Value) -> String {
    let raw = match system {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|b| b["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    };
    raw.lines().filter(|l| !l.starts_with("x-anthropic-billing-header:")).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// Folds mid-conversation `role: "system"` messages (Cowork sends them) into the
/// adjacent user turn, flagged so they do not change the fingerprint.
pub fn normalize(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        if m["role"] == "system" {
            let text = blocks(&m["content"]).iter().map(|b| b["text"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join("\n");
            let block = json!({"type": "text", "text": format!("<system-reminder>\n{text}\n</system-reminder>"), "_sys": true});
            match out.last_mut() {
                Some(prev) if prev["role"] == "user" => { let mut b = blocks(&prev["content"]); b.push(block); prev["content"] = Value::Array(b); }
                _ => out.push(json!({"role": "user", "content": [block]})),
            }
        } else {
            let mut m = m.clone();
            m["content"] = Value::Array(blocks(&m["content"]));
            out.push(m);
        }
    }
    out
}

/// A conversation fingerprint that survives cosmetic changes when a client echoes history.
pub fn fingerprint(messages: &[Value]) -> String {
    let norm: Vec<String> = messages.iter().map(|m| {
        let parts: Vec<String> = blocks(&m["content"]).iter().filter(|b| b["_sys"] != true).filter_map(|b| match b["type"].as_str()? {
            "text" => Some(format!("t:{}", b["text"].as_str().unwrap_or("").trim())),
            "tool_use" => Some(format!("u:{}", b["id"].as_str().unwrap_or(""))),
            "tool_result" => Some(format!("r:{}", b["tool_use_id"].as_str().unwrap_or(""))),
            t @ ("image" | "document") => Some(t.to_string()),
            _ => None,
        }).collect();
        format!("{}|{}", m["role"].as_str().unwrap_or(""), parts.join("\u{1}"))
    }).collect();
    sha(&norm.join("\u{2}"))
}

/// Quoted content must not be able to close a turn and open one that reads as the user's.
fn defang(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        let body = tail.strip_prefix('/').unwrap_or(tail);
        let hit = ["user", "assistant", "conversation_history"].iter().any(|tag| {
            body.len() > tag.len() && body[..tag.len()].eq_ignore_ascii_case(tag) && matches!(body.as_bytes()[tag.len()], b'>' | b' ' | b'\n' | b'\t')
        });
        out.push(if hit { '‹' } else { '<' });
        rest = tail;
    }
    out.push_str(rest);
    out
}

pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|b| if b["type"] == "text" { b["text"].as_str().unwrap_or("").to_string() } else { format!("[{}]", b["type"].as_str().unwrap_or("?")) }).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Earlier turns as prompt blocks: text plus the most recent images/documents.
fn transcript(messages: &[Value]) -> Vec<Value> {
    enum Part { Text(String), Media(usize) }
    let mut media: Vec<Value> = Vec::new();
    let mut turns: Vec<(String, Vec<Part>)> = Vec::new();
    for m in messages {
        let mut parts = Vec::new();
        for b in blocks(&m["content"]) {
            match b["type"].as_str().unwrap_or("") {
                "text" => parts.push(Part::Text(defang(b["text"].as_str().unwrap_or("")))),
                "tool_use" => parts.push(Part::Text(format!("[called tool {} with {}]", b["name"].as_str().unwrap_or("?"), defang(&b["input"].to_string())))),
                "tool_result" => {
                    let text: String = tool_result_text(&b["content"]).chars().take(20_000).collect();
                    parts.push(Part::Text(format!("[tool result: {}]", defang(&text))));
                    for c in b["content"].as_array().cloned().unwrap_or_default() {
                        if c["type"] == "image" { media.push(c); parts.push(Part::Media(media.len() - 1)); }
                    }
                }
                "image" | "document" => { media.push(b.clone()); parts.push(Part::Media(media.len() - 1)); }
                _ => {}
            }
        }
        turns.push((m["role"].as_str().unwrap_or("user").to_string(), parts));
    }
    let mut keep = HashSet::new();
    let mut bytes = 0;
    for (i, b) in media.iter().enumerate().rev() {
        let size = b["source"]["data"].as_str().map(str::len).unwrap_or(0);
        if keep.len() >= KEEP_MEDIA || bytes + size > KEEP_MEDIA_BYTES { break; }
        keep.insert(i);
        bytes += size;
    }
    let mut out: Vec<Value> = Vec::new();
    let text = |out: &mut Vec<Value>, t: &str| {
        if let Some(last) = out.last_mut().filter(|l| l["type"] == "text") {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), t);
            last["text"] = json!(joined);
        } else { out.push(json!({"type": "text", "text": t})); }
    };
    for (role, parts) in turns {
        if parts.is_empty() { continue; }
        text(&mut out, &format!("<{role}>\n"));
        for p in parts {
            match p {
                Part::Text(t) => text(&mut out, &format!("{t}\n")),
                Part::Media(i) if keep.contains(&i) => out.push(json!({"type": media[i]["type"], "source": media[i]["source"]})),
                Part::Media(i) => text(&mut out, &format!("[{}]\n", media[i]["type"].as_str().unwrap_or("media"))),
            }
        }
        text(&mut out, &format!("</{role}>\n\n"));
    }
    out
}

fn with_history(messages: &[Value], note: &str, content: Vec<Value>) -> Vec<Value> {
    let mut out = vec![json!({"type": "text", "text": "<conversation_history>\n"})];
    out.extend(transcript(messages));
    out.push(json!({"type": "text", "text": format!("</conversation_history>\n\n{note}")}));
    out.extend(content);
    out
}

/// Text/image/document blocks for the CLI prompt channel.
fn cli_user_content(content: &[Value]) -> Vec<Value> {
    content.iter().filter(|b| matches!(b["type"].as_str(), Some("text" | "image" | "document"))).map(|b| {
        let mut b = b.clone();
        if let Some(o) = b.as_object_mut() { for k in ["cache_control", "citations", "_sys"] { o.remove(k); } }
        b
    }).collect()
}

/// Messages-API tool_result content -> MCP CallToolResult.
pub fn to_mcp_result(block: &Value) -> Value {
    let mut content = Vec::new();
    for b in blocks(&block["content"]) {
        if b["type"] == "text" { content.push(json!({"type": "text", "text": b["text"]})); }
        else if b["type"] == "image" && b["source"]["type"] == "base64" { content.push(json!({"type": "image", "data": b["source"]["data"], "mimeType": b["source"]["media_type"]})); }
        else { content.push(json!({"type": "text", "text": b.to_string()})); }
    }
    if content.is_empty() { content.push(json!({"type": "text", "text": ""})); }
    json!({"content": content, "isError": block["is_error"] == true})
}

/// Client-defined tools are bridged; server tools (web search…) map to CLI built-ins.
pub fn split_tools(tools: &Value) -> (Vec<Value>, Vec<String>) {
    let mut client = Vec::new();
    let mut server = Vec::new();
    for t in tools.as_array().cloned().unwrap_or_default() {
        if !t["input_schema"].is_null() && (t["type"].is_null() || t["type"] == "custom") { client.push(t); }
        else { server.push(t["type"].as_str().or(t["name"].as_str()).unwrap_or("").to_string()); }
    }
    (client, server)
}

fn builtins_for(server: &[String]) -> Vec<&'static str> {
    let mut out = Vec::new();
    if server.iter().any(|t| t.contains("web_search")) { out.push("WebSearch"); }
    if server.iter().any(|t| t.contains("web_fetch")) { out.push("WebFetch"); }
    out
}

/// MCP tool definitions plus exposed-name → Desktop-name aliases (names stay within 64 chars).
fn mcp_tools(client: &[Value]) -> (Vec<Value>, HashMap<String, String>) {
    let mut alias = HashMap::new();
    let tools = client.iter().map(|t| {
        let name = t["name"].as_str().unwrap_or("tool");
        let exposed = if name.len() + TOOL_PREFIX.len() <= 64 { name.to_string() } else { format!("{}_{}", &name[..40.min(name.len())], &sha(name)[..8]) };
        alias.insert(exposed.clone(), name.to_string());
        json!({"name": exposed, "description": t["description"].as_str().unwrap_or(""), "inputSchema": t["input_schema"]})
    }).collect();
    (tools, alias)
}

fn classify_error(msg: &str) -> (StatusCode, &'static str) {
    let m = msg.to_lowercase();
    if m.contains("rate limit") || m.contains("rate_limit") || m.contains("usage limit") || m.contains("429") { (StatusCode::TOO_MANY_REQUESTS, "rate_limit_error") }
    else if m.contains("overloaded") || m.contains("529") { (StatusCode::from_u16(529).unwrap(), "overloaded_error") }
    else if m.contains("invalid_request") || m.contains(" 400") { (StatusCode::BAD_REQUEST, "invalid_request_error") }
    else { (StatusCode::BAD_GATEWAY, "api_error") }
}

// ---------------------------------------------------------------- response sink

enum Out { Sse(String), Json(StatusCode, Value) }

const USAGE_KEYS: [&str; 4] = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/// Turns the CLI's stream events into one Messages-API response for Desktop.
struct Sink {
    out: mpsc::UnboundedSender<Out>,
    stream: bool,
    model: String,
    started: bool,
    done: bool,
    index_map: HashMap<u64, usize>,
    content: Vec<Value>,
    json_parts: Vec<String>,
    usage: Map<String, Value>,
    prior_output: u64,
    bridged: Vec<String>,
    stop_event: Option<Value>,
    msg_id: Option<String>,
    got_result: bool,
    stale_result: bool,
    /// History up to this request, for the fingerprint once the reply is complete.
    messages: Vec<Value>,
    tracker: Tracker,
}

enum SinkEnd { Running, Finished, Aborted }

impl Sink {
    fn send(&mut self, event: &str, data: Value) -> bool {
        if !self.stream { return true; }
        self.out.send(Out::Sse(format!("event: {event}\ndata: {data}\n\n"))).is_ok()
    }
    fn add_usage(&mut self, u: &Value, fresh: bool) {
        if !u.is_object() { return; }
        if fresh { self.prior_output += self.usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0); }
        for k in USAGE_KEYS {
            if let Some(n) = u[k].as_u64() { self.usage.insert(k.into(), json!(n)); }
            else if fresh { self.usage.insert(k.into(), json!(0)); }
        }
    }
    fn total_usage(&self) -> Value {
        let mut u = Value::Object(self.usage.clone());
        u["output_tokens"] = json!(self.prior_output + self.usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0));
        u
    }
}

// ---------------------------------------------------------------- sessions

struct Inner {
    tools: Vec<Value>,
    alias: HashMap<String, String>,
    pending: HashMap<String, oneshot::Sender<Value>>,
    results: HashMap<String, Value>,
    handed: HashSet<String>,
    sink: Option<Sink>,
    busy: bool,
    dead: bool,
    last_used: Instant,
    fp: Option<String>,
    fp_len: usize,
    awaiting_result: bool,
}

pub struct Session {
    token: String,
    key: String,
    stdin: mpsc::UnboundedSender<String>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    inner: Mutex<Inner>,
}

impl Session {
    fn push_prompt(&self, content: Vec<Value>) {
        let msg = json!({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": null, "session_id": ""});
        let _ = self.stdin.send(msg.to_string());
    }
    fn deliver(&self, id: &str, result: Value) {
        let mut inner = self.inner.lock().unwrap();
        inner.handed.remove(id);
        if let Some(tx) = inner.pending.remove(id) { let _ = tx.send(result); } else { inner.results.insert(id.into(), result); }
    }
    fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.dead = true;
        for (_, tx) in inner.pending.drain() { let _ = tx.send(cancelled()); }
        if let Some(mut sink) = inner.sink.take() { fail(&mut sink, "Claude Code session ended"); }
        drop(inner);
        if let Some(k) = self.kill.lock().unwrap().take() { let _ = k.send(()); }
    }
}

fn cancelled() -> Value { json!({"content": [{"type": "text", "text": "cancelled"}], "isError": true}) }

/// Ends a sink with an error: a real HTTP status when nothing was sent yet.
fn fail(sink: &mut Sink, msg: &str) {
    if sink.done { return; }
    sink.done = true;
    let (status, kind) = classify_error(msg);
    let body = json!({"type": "error", "error": {"type": kind, "message": msg}});
    if sink.stream && sink.started { let _ = sink.out.send(Out::Sse(format!("event: error\ndata: {body}\n\n"))); }
    else { let _ = sink.out.send(Out::Json(status, body)); }
    sink.tracker.finish(status.as_u16(), Some(msg.to_string()));
}

fn finish(inner: &mut Inner, mut sink: Sink) {
    if sink.done { return; }
    sink.done = true;
    let e = sink.stop_event.clone().unwrap_or_else(|| json!({"delta": {"stop_reason": "end_turn", "stop_sequence": null}}));
    let stop = e["delta"]["stop_reason"].clone();
    let usage = sink.total_usage();
    sink.send("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": e["delta"]["stop_sequence"]}, "usage": usage}));
    sink.send("message_stop", json!({"type": "message_stop"}));
    let content: Vec<Value> = sink.content.iter().zip(sink.json_parts.iter()).map(|(c, j)| {
        let mut c = c.clone();
        if c["type"] == "tool_use" { c["input"] = serde_json::from_str(if j.is_empty() { "{}" } else { j }).unwrap_or_else(|_| json!({})); }
        c
    }).collect();
    if !sink.stream {
        let id = sink.msg_id.clone().unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4().simple()));
        let _ = sink.out.send(Out::Json(StatusCode::OK, json!({"id": id, "type": "message", "role": "assistant", "model": sink.model, "content": content, "stop_reason": stop, "stop_sequence": e["delta"]["stop_sequence"], "usage": usage})));
    }
    sink.tracker.usage(&usage);
    sink.tracker.finish(200, None);
    inner.busy = false;
    inner.last_used = Instant::now();
    if stop != "tool_use" && !sink.got_result { inner.awaiting_result = true; }
    let mut history = std::mem::take(&mut sink.messages);
    history.push(json!({"role": "assistant", "content": content}));
    inner.fp = Some(fingerprint(&history));
    inner.fp_len = history.len();
}

/// Feeds one CLI stream event into the current sink.
fn on_event(inner: &mut Inner, e: &Value) -> SinkEnd {
    let Some(sink) = inner.sink.as_mut() else { return SinkEnd::Running };
    if sink.done { return SinkEnd::Running; }
    let mut finish_now = false;
    let ok = match e["type"].as_str().unwrap_or("") {
        "message_start" => {
            sink.index_map.clear();
            sink.bridged.clear();
            sink.add_usage(&e["message"]["usage"], true);
            if !sink.started {
                sink.started = true;
                sink.msg_id = e["message"]["id"].as_str().map(String::from);
                let mut m = e["message"].clone();
                m["model"] = json!(sink.model);
                m["content"] = json!([]);
                sink.send("message_start", json!({"type": "message_start", "message": m}))
            } else { true }
        }
        "content_block_start" => {
            let b = &e["content_block"];
            let kind = b["type"].as_str().unwrap_or("");
            let out = if matches!(kind, "text" | "thinking" | "redacted_thinking") { Some(b.clone()) }
                else if kind == "tool_use" && b["name"].as_str().is_some_and(|n| n.starts_with(TOOL_PREFIX)) {
                    let exposed = &b["name"].as_str().unwrap()[TOOL_PREFIX.len()..];
                    let name = inner.alias.get(exposed).cloned().unwrap_or_else(|| exposed.to_string());
                    let id = b["id"].as_str().unwrap_or("").to_string();
                    sink.bridged.push(id.clone());
                    Some(json!({"type": "tool_use", "id": id, "name": name, "input": {}}))
                } else { None };
            match out {
                Some(out) => {
                    let idx = sink.content.len();
                    sink.index_map.insert(e["index"].as_u64().unwrap_or(0), idx);
                    sink.content.push(out.clone());
                    sink.json_parts.push(String::new());
                    sink.send("content_block_start", json!({"type": "content_block_start", "index": idx, "content_block": out}))
                }
                None => true,
            }
        }
        "content_block_delta" => match sink.index_map.get(&e["index"].as_u64().unwrap_or(u64::MAX)).copied() {
            Some(idx) => {
                let d = &e["delta"];
                let c = &mut sink.content[idx];
                let append = |c: &mut Value, key: &str, s: &str| { let v = format!("{}{}", c[key].as_str().unwrap_or(""), s); c[key] = json!(v); };
                let skip = match d["type"].as_str().unwrap_or("") {
                    "text_delta" => { append(c, "text", d["text"].as_str().unwrap_or("")); false }
                    "thinking_delta" => { append(c, "thinking", d["thinking"].as_str().unwrap_or("")); false }
                    "signature_delta" => { c["signature"] = d["signature"].clone(); false }
                    "input_json_delta" => { sink.json_parts[idx].push_str(d["partial_json"].as_str().unwrap_or("")); false }
                    "citations_delta" => true,
                    _ => false,
                };
                skip || sink.send("content_block_delta", json!({"type": "content_block_delta", "index": idx, "delta": d}))
            }
            None => true,
        },
        "content_block_stop" => match sink.index_map.get(&e["index"].as_u64().unwrap_or(u64::MAX)).copied() {
            Some(idx) => sink.send("content_block_stop", json!({"type": "content_block_stop", "index": idx})),
            None => true,
        },
        "message_delta" => {
            sink.add_usage(&e["usage"], false);
            let stop = e["delta"]["stop_reason"].as_str().unwrap_or("");
            if stop == "tool_use" && sink.bridged.is_empty() { true } // the CLI runs its own tool and continues
            else {
                sink.stop_event = Some(e.clone());
                if stop == "tool_use" { finish_now = true; }
                true
            }
        }
        "message_stop" => {
            if sink.stop_event.as_ref().is_some_and(|s| s["delta"]["stop_reason"] != "tool_use") { finish_now = true; }
            true
        }
        _ => true,
    };
    if !ok { return SinkEnd::Aborted; }
    if finish_now {
        let sink = inner.sink.take().unwrap();
        if sink.stop_event.as_ref().is_some_and(|s| s["delta"]["stop_reason"] == "tool_use") {
            for id in &sink.bridged { inner.handed.insert(id.clone()); }
        }
        finish(inner, sink);
        return SinkEnd::Finished;
    }
    SinkEnd::Running
}

// ---------------------------------------------------------------- bridge

pub struct Bridge {
    config: Arc<Config>,
    activity: SharedActivity,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

pub type SharedBridge = Arc<Bridge>;

impl Bridge {
    pub fn new(config: Arc<Config>, activity: SharedActivity) -> SharedBridge {
        Arc::new(Bridge { config, activity, sessions: Mutex::new(HashMap::new()) })
    }

    pub fn session_count(&self) -> usize { self.sessions.lock().unwrap().len() }

    fn remove(&self, token: &str) { self.sessions.lock().unwrap().remove(token); }

    /// Closes idle sessions past their TTL and keeps at most MAX_SESSIONS.
    pub fn evict(&self) {
        let list: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        let mut idle: Vec<(Instant, Arc<Session>)> = list.into_iter().filter_map(|s| {
            let inner = s.inner.lock().unwrap();
            (!inner.busy && inner.handed.is_empty() || inner.last_used.elapsed() > SESSION_TTL).then(|| (inner.last_used, s.clone()))
        }).collect();
        idle.sort_by_key(|(t, _)| *t);
        let mut count = self.session_count();
        for (t, s) in idle {
            if t.elapsed() > SESSION_TTL || count > MAX_SESSIONS {
                s.close();
                self.remove(&s.token);
                count = count.saturating_sub(1);
            }
        }
    }

    pub fn close_all(&self) {
        let list: Vec<Arc<Session>> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in list { s.close(); }
    }

    fn spawn(self: &Arc<Self>, key: String, model: &str, system: &str, client: &[Value], builtins: &[&str]) -> Result<Arc<Session>, String> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let (tools, alias) = mcp_tools(client);
        let mut args: Vec<String> = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--permission-mode", "bypassPermissions"]
            .iter().map(|s| s.to_string()).collect();
        args.extend(["--model".into(), model.into(), "--system-prompt".into(), if system.is_empty() { gateway::DEFAULT_SYSTEM.into() } else { system.into() }]);
        args.extend(["--tools".into(), builtins.join(",")]);
        let mut allowed: Vec<String> = builtins.iter().map(|s| s.to_string()).collect();
        if !tools.is_empty() {
            let url = format!("http://{}:{}/mcp/{token}", self.config.host, self.config.port);
            args.extend(["--mcp-config".into(), json!({"mcpServers": {"desktop": {"type": "http", "url": url}}}).to_string()]);
            allowed.push("mcp__desktop".into());
        }
        if !allowed.is_empty() { args.extend(["--allowedTools".into(), allowed.join(",")]); }
        if debug() { eprintln!("[spawn] {:?}", args.iter().map(|a| a.chars().take(80).collect::<String>()).collect::<Vec<_>>()); }
        let mut child = Command::new(gateway::claude_executable(&self.config.claude_path))
            .args(&args)
            .current_dir(gateway::workspace())
            .env("MCP_TOOL_TIMEOUT", TOOL_TIMEOUT.as_millis().to_string())
            .env("CLAUDE_AGENT_SDK_CLIENT_APP", "ccgw-desktop/1.0")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn().map_err(|e| format!("Không chạy được Claude Code: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, kill_rx) = oneshot::channel();
        let session = Arc::new(Session {
            token: token.clone(), key, stdin: in_tx, kill: Mutex::new(Some(kill_tx)),
            inner: Mutex::new(Inner { tools, alias, pending: HashMap::new(), results: HashMap::new(), handed: HashSet::new(), sink: None, busy: false, dead: false, last_used: Instant::now(), fp: None, fp_len: 0, awaiting_result: false }),
        });
        tokio::spawn(async move {
            while let Some(line) = in_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() { break; }
                let _ = stdin.flush().await;
            }
        });
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        { let tail = stderr_tail.clone(); tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await { if debug() { eprintln!("[stderr] {l}"); } let mut t = tail.lock().unwrap(); t.push_str(&l); t.push('\n'); if t.len() > 4000 { let cut = t.len() - 4000; *t = t[cut..].to_string(); } }
        }); }
        let me = self.clone();
        let s = session.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            tokio::pin!(kill_rx);
            loop {
                let line = tokio::select! { l = lines.next_line() => l, _ = &mut kill_rx => break };
                let Ok(Some(line)) = line else { break };
                if debug() { eprintln!("[cli {}] {}", &s.token[..6], line.chars().take(300).collect::<String>()); }
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                let mut inner = s.inner.lock().unwrap();
                inner.last_used = Instant::now();
                match m["type"].as_str().unwrap_or("") {
                    "stream_event" if m["parent_tool_use_id"].is_null() => {
                        if let SinkEnd::Aborted = on_event(&mut inner, &m["event"]) {
                            // Desktop went away mid-reply: drop this process; the next message replays history.
                            if let Some(mut sink) = inner.sink.take() { sink.done = true; sink.tracker.finish(499, Some("Client đã ngắt kết nối".into())); }
                            drop(inner);
                            break;
                        }
                    }
                    "rate_limit_event" => { me.activity.lock().unwrap().set_rate_limit(m["rate_limit_info"].clone()); }
                    "result" => {
                        inner.awaiting_result = false;
                        if let Some(sink) = inner.sink.as_mut() {
                            if sink.stale_result { sink.stale_result = false; continue; }
                            sink.got_result = true;
                            if m["is_error"] == true || m["subtype"].as_str().is_some_and(|t| t != "success") {
                                let msg = m["errors"].as_array().map(|e| e.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")).filter(|s| !s.is_empty())
                                    .or_else(|| m["result"].as_str().map(String::from)).unwrap_or_else(|| "Claude Code báo lỗi".into());
                                let mut sink = inner.sink.take().unwrap();
                                fail(&mut sink, &msg);
                                inner.busy = false;
                            } else if sink.started {
                                let sink = inner.sink.take().unwrap();
                                finish(&mut inner, sink);
                            }
                        }
                    }
                    "assistant" if !m["error"].is_null() => {
                        let text = m["message"]["content"].as_array().map(|c| c.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                        let msg = if text.trim().is_empty() { m["error"].to_string() } else { format!("{}: {}", m["error"].as_str().unwrap_or("error"), text.trim()) };
                        if let Some(mut sink) = inner.sink.take() { fail(&mut sink, &msg); inner.busy = false; }
                    }
                    _ => {}
                }
            }
            let tail = stderr_tail.lock().unwrap().trim().to_string();
            {
                let mut inner = s.inner.lock().unwrap();
                inner.dead = true;
                for (_, tx) in inner.pending.drain() { let _ = tx.send(cancelled()); }
                if let Some(mut sink) = inner.sink.take() { fail(&mut sink, if tail.is_empty() { "Claude Code session ended" } else { &tail }); }
            }
            me.remove(&s.token);
            let _ = child.kill().await;
        });
        self.sessions.lock().unwrap().insert(token, session.clone());
        Ok(session)
    }

    /// `/mcp/<token>`: the "desktop" MCP server one session's CLI talks to.
    pub async fn mcp(self: &Arc<Self>, token: &str, body: Value) -> Response {
        let Some(session) = self.sessions.lock().unwrap().get(token).cloned() else {
            return (StatusCode::NOT_FOUND, Json(json!({"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32001, "message": "session not found"}}))).into_response();
        };
        let id = body["id"].clone();
        if debug() { eprintln!("[mcp {}] {} {}", &token[..6], body["method"], body["params"].to_string().chars().take(200).collect::<String>()); }
        if id.is_null() { return StatusCode::ACCEPTED.into_response(); } // notification
        let reply = |result: Value| Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response();
        match body["method"].as_str().unwrap_or("") {
            "initialize" => reply(json!({"protocolVersion": body["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"), "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": "desktop", "version": env!("CARGO_PKG_VERSION")}})),
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({"tools": session.inner.lock().unwrap().tools})),
            "tools/call" => {
                let call_id = body["params"]["_meta"]["claudecode/toolUseId"].as_str().map(String::from)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let rx = {
                    let mut inner = session.inner.lock().unwrap();
                    if let Some(r) = inner.results.remove(&call_id) { return reply(r); }
                    if inner.dead { return reply(cancelled()); }
                    let (tx, rx) = oneshot::channel();
                    inner.pending.insert(call_id.clone(), tx);
                    rx
                };
                match tokio::time::timeout(TOOL_TIMEOUT, rx).await {
                    Ok(Ok(result)) => reply(result),
                    _ => { session.inner.lock().unwrap().pending.remove(&call_id); reply(json!({"content": [{"type": "text", "text": "Desktop did not return a tool result in time"}], "isError": true})) }
                }
            }
            _ => Json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}})).into_response(),
        }
    }

    /// `/v1/messages` with conversation state and tools.
    pub async fn messages(self: &Arc<Self>, body: Value) -> Response {
        let messages = normalize(body["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]));
        let model = gateway::cli_model(&body);
        let stream = body["stream"] == true;
        let tracker = Tracker::new(&self.activity, &model, stream);
        let Some(last) = messages.last().filter(|m| m["role"] == "user").cloned() else {
            let mut t = tracker; t.finish(400, Some("last message must be a user message".into()));
            return gateway::error(StatusCode::BAD_REQUEST, "invalid_request_error", "last message must be a user message");
        };
        let system = system_text(&body["system"]);
        let (client, server) = split_tools(&body["tools"]);
        let builtins = builtins_for(&server);
        let key = sha(&format!("{system}\u{0}{}\u{0}{model}\u{0}{}", builtins.join(","), Value::Array(client.clone())));
        let last_blocks = blocks(&last["content"]);
        let tool_results: Vec<Value> = last_blocks.iter().filter(|b| b["type"] == "tool_result").cloned().collect();

        let all: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        let mut session: Option<Arc<Session>> = None;
        let mut resume = false;
        if !tool_results.is_empty() {
            session = all.iter().find(|s| { let i = s.inner.lock().unwrap(); !i.dead && tool_results.iter().any(|b| i.handed.contains(b["tool_use_id"].as_str().unwrap_or(""))) }).cloned();
            resume = session.is_some();
        }
        let mut delta: Vec<Value> = Vec::new();
        if session.is_none() {
            let mut best: Option<(usize, Arc<Session>)> = None;
            for s in all.iter().filter(|s| s.key == key) {
                let i = s.inner.lock().unwrap();
                if i.dead || i.busy || !i.handed.is_empty() || i.fp_len == 0 || i.fp_len >= messages.len() { continue; }
                if i.fp.as_deref() == Some(&fingerprint(&messages[..i.fp_len])) && best.as_ref().is_none_or(|(n, _)| i.fp_len > *n) { best = Some((i.fp_len, s.clone())); }
            }
            if let Some((n, s)) = best { delta = messages[n..messages.len() - 1].to_vec(); session = Some(s); }
        }
        let fresh = session.is_none();
        let session = match session {
            Some(s) => s,
            None => match self.spawn(key, &model, &system, &client, &builtins) {
                Ok(s) => s,
                Err(e) => { let mut t = tracker; t.finish(502, Some(e.clone())); return gateway::error(StatusCode::BAD_GATEWAY, "api_error", &e); }
            },
        };
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        {
            let mut inner = session.inner.lock().unwrap();
            if inner.busy { drop(inner); let mut t = tracker; t.finish(409, Some("conversation is busy".into())); return gateway::error(StatusCode::CONFLICT, "invalid_request_error", "conversation is busy"); }
            inner.busy = true;
            inner.last_used = Instant::now();
            let stale = !resume && inner.awaiting_result;
            inner.sink = Some(Sink { out: out_tx, stream, model: body["model"].as_str().unwrap_or(&model).to_string(), started: false, done: false, index_map: HashMap::new(), content: vec![], json_parts: vec![], usage: Map::new(), prior_output: 0, bridged: vec![], stop_event: None, msg_id: None, got_result: false, stale_result: stale, messages: messages.clone(), tracker });
        }
        if resume {
            for b in &tool_results {
                let id = b["tool_use_id"].as_str().unwrap_or("");
                if session.inner.lock().unwrap().handed.contains(id) { session.deliver(id, to_mcp_result(b)); }
            }
            let extra: Vec<Value> = last_blocks.iter().filter(|b| b["_sys"] != true && !(b["type"] == "text" && b["text"].as_str().unwrap_or("").trim().is_empty())).cloned().collect();
            let extra = cli_user_content(&extra);
            if !extra.is_empty() { session.push_prompt(extra); }
        } else {
            let mut content = cli_user_content(&last_blocks);
            if fresh && messages.len() > 1 { content = with_history(&messages[..messages.len() - 1], "Continue the conversation above. The user's new message follows.", content); }
            else if !delta.is_empty() { content = with_history(&delta, "These turns came after your last reply (it was cut off, so they include what the user saw of it). The user's new message follows.", content); }
            if content.is_empty() { content = if tool_results.is_empty() { vec![json!({"type": "text", "text": "(empty)"})] } else { transcript(&[last.clone()]) }; }
            session.push_prompt(content);
        }

        // First output decides the HTTP status; SSE follows with keep-alive pings.
        match out_rx.recv().await {
            None => gateway::error(StatusCode::BAD_GATEWAY, "api_error", "Claude Code session ended"),
            Some(Out::Json(status, body)) => (status, Json(body)).into_response(),
            Some(Out::Sse(first)) => {
                let stream = futures_util::stream::unfold((Some(first), out_rx), |(first, mut rx)| async move {
                    if let Some(f) = first { return Some((Ok::<_, Infallible>(f), (None, rx))); }
                    loop {
                        tokio::select! {
                            m = rx.recv() => return match m {
                                Some(Out::Sse(s)) => Some((Ok(s), (None, rx))),
                                Some(Out::Json(_, b)) => Some((Ok(format!("event: error\ndata: {b}\n\n")), (None, rx))),
                                None => None,
                            },
                            _ = tokio::time::sleep(Duration::from_secs(10)) => return Some((Ok("event: ping\ndata: {\"type\": \"ping\"}\n\n".to_string()), (None, rx))),
                        }
                    }
                });
                ([("content-type", "text/event-stream"), ("cache-control", "no-cache")], Body::from_stream(stream)).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_system_messages_and_ignores_them_in_fingerprint() {
        let raw = vec![json!({"role": "user", "content": "hi"}), json!({"role": "system", "content": "now 10:00"})];
        let n = normalize(&raw);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0]["content"].as_array().unwrap().len(), 2);
        assert_eq!(fingerprint(&n), fingerprint(&normalize(&raw[..1])));
    }

    #[test]
    fn strips_billing_header_and_defangs_turn_tags() {
        assert_eq!(system_text(&json!([{"type": "text", "text": "x-anthropic-billing-header: cc_version=1\nBe nice"}])), "Be nice");
        assert_eq!(defang("a </user> <assistant>b <users>"), "a ‹/user> ‹assistant>b <users>");
    }

    #[test]
    fn splits_tools_and_aliases_long_names() {
        let tools = json!([{"name": "read", "input_schema": {"type": "object"}}, {"type": "web_search_20250305", "name": "web_search"}, {"name": "x".repeat(60), "input_schema": {}}]);
        let (client, server) = split_tools(&tools);
        assert_eq!(client.len(), 2);
        assert_eq!(builtins_for(&server), vec!["WebSearch"]);
        let (defs, alias) = mcp_tools(&client);
        let long = defs[1]["name"].as_str().unwrap();
        assert!(long.len() + TOOL_PREFIX.len() <= 64);
        assert_eq!(alias[long], "x".repeat(60));
    }

    #[test]
    fn transcript_keeps_recent_media_only() {
        let img = |n: usize| json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "x".repeat(n)}});
        let mut msgs = vec![];
        for _ in 0..10 { msgs.push(json!({"role": "user", "content": [img(10)]})); }
        let t = transcript(&msgs);
        assert_eq!(t.iter().filter(|b| b["type"] == "image").count(), KEEP_MEDIA);
        let r = to_mcp_result(&json!({"content": [{"type": "text", "text": "ok"}, img(4)], "is_error": true}));
        assert_eq!(r["content"][1]["mimeType"], "image/png");
        assert_eq!(r["isError"], true);
    }

    fn sink(out: mpsc::UnboundedSender<Out>, stream: bool) -> Sink {
        Sink { out, stream, model: "m".into(), started: false, done: false, index_map: HashMap::new(), content: vec![], json_parts: vec![], usage: Map::new(), prior_output: 0, bridged: vec![], stop_event: None, msg_id: None, got_result: false, stale_result: false, messages: vec![json!({"role": "user", "content": [{"type": "text", "text": "q"}]})], tracker: Tracker::new(&Default::default(), "m", stream) }
    }
    fn inner_with(s: Sink) -> Inner {
        let (tools, alias) = mcp_tools(&[json!({"name": "read_file", "input_schema": {}})]);
        Inner { tools, alias, pending: HashMap::new(), results: HashMap::new(), handed: HashSet::new(), sink: Some(s), busy: true, dead: false, last_used: Instant::now(), fp: None, fp_len: 0, awaiting_result: false }
    }

    #[test]
    fn sink_ends_at_bridged_tool_use_and_hides_cli_tools() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut inner = inner_with(sink(tx, false));
        let ev = |v: Value| v;
        on_event(&mut inner, &ev(json!({"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 5, "output_tokens": 1}}})));
        on_event(&mut inner, &ev(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
        on_event(&mut inner, &ev(json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Reading"}})));
        on_event(&mut inner, &ev(json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t_internal", "name": "WebSearch"}})));
        on_event(&mut inner, &ev(json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "t1", "name": "mcp__desktop__read_file"}})));
        on_event(&mut inner, &ev(json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"/a\"}"}})));
        let end = on_event(&mut inner, &ev(json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}})));
        assert!(matches!(end, SinkEnd::Finished));
        assert!(inner.handed.contains("t1") && !inner.busy && inner.fp_len == 2);
        let Some(Out::Json(status, body)) = rx.try_recv().ok() else { panic!("no json") };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["stop_reason"], "tool_use");
        assert_eq!(body["content"].as_array().unwrap().len(), 2);
        assert_eq!(body["content"][1]["name"], "read_file");
        assert_eq!(body["content"][1]["input"]["path"], "/a");
        assert_eq!(body["usage"]["output_tokens"], 9);
    }

    #[test]
    fn sink_streams_and_reports_errors_as_status_before_output() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut s = sink(tx, true);
        fail(&mut s, "You have hit your usage limit");
        let Some(Out::Json(status, _)) = rx.try_recv().ok() else { panic!() };
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut inner = inner_with(sink(tx, true));
        on_event(&mut inner, &json!({"type": "message_start", "message": {"id": "msg_1", "usage": {}}}));
        on_event(&mut inner, &json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {}})); // CLI's own tool: keep going
        assert!(inner.sink.is_some());
        on_event(&mut inner, &json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {}}));
        on_event(&mut inner, &json!({"type": "message_stop"}));
        assert!(inner.sink.is_none() && inner.awaiting_result);
        let mut events = vec![];
        while let Ok(Out::Sse(s)) = rx.try_recv() { events.push(s.lines().next().unwrap().to_string()); }
        assert_eq!(events, ["event: message_start", "event: message_delta", "event: message_stop"]);
    }
}
