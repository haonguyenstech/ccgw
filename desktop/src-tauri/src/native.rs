use crate::{platform, settings, start_gateway_inner, stop_gateway_inner, restart_gateway_inner, rotate_key_inner, RuntimeState};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};

#[derive(Serialize)]
pub struct ActionResult { pub ok: bool, pub command: String, pub output: String }

#[derive(Serialize)]
pub struct DesktopStatus { pub gateway_running: bool, pub official_running: bool }
#[derive(Serialize)]
pub struct McpItem { pub name: String, pub endpoint: String, pub kind: &'static str, pub enabled: bool, pub official: bool, pub ask: bool, pub preset: bool }

/// Human-readable target: the URL for remote servers, or the command line for local ones.
fn endpoint(entry: &Value) -> String {
    if let Some(url) = entry["url"].as_str() { return url.into(); }
    let Some(command) = entry["command"].as_str() else { return "MCP cục bộ".into() };
    let program = std::path::Path::new(command).file_name().and_then(|s| s.to_str()).unwrap_or(command);
    let args: Vec<&str> = entry["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    std::iter::once(program).chain(args).collect::<Vec<_>>().join(" ")
}

fn disabled_path() -> PathBuf { settings::config_path().with_file_name("disabled-mcp.json") }
fn disabled_key(official: bool) -> &'static str { if official { "official" } else { "gateway" } }
fn disabled_connectors(official: bool) -> Vec<Value> {
    settings::read_json(&disabled_path())[disabled_key(official)].as_array().cloned().unwrap_or_default()
}
fn save_disabled(official: bool, list: &[Value]) -> Result<(), String> {
    let mut value = settings::read_json(&disabled_path());
    value[disabled_key(official)] = json!(list);
    settings::atomic_json(&disabled_path(), &value)
}
pub fn list_mcp(shared: &Arc<Mutex<RuntimeState>>) -> Result<Vec<McpItem>, String> {
    let mut result = Vec::new();
    for official in [false, true] {
        let active = connectors(shared, official)?;
        let disabled = disabled_connectors(official);
        for (enabled, entries) in [(true, &active), (false, &disabled)] {
            for entry in entries {
                let Some(name) = entry["name"].as_str() else { continue };
                if !enabled && active.iter().any(|item| item["name"] == name) { continue; }
                result.push(McpItem {
                    name: name.into(), endpoint: endpoint(entry),
                    kind: if entry.get("url").is_some() { "remote" } else if entry["args"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(|s| s.starts_with("mcp-remote")))) { "bridge" } else { "local" },
                    enabled, official, ask: entry["toolPolicy"]["*"] != "allow",
                    preset: preset_url(name).is_some_and(|u| entry["url"] == u),
                });
            }
        }
    }
    Ok(result)
}

fn result(args: &[String], output: impl Into<String>) -> ActionResult {
    ActionResult { ok: true, command: args.join(" "), output: output.into() }
}
fn config(shared: &Arc<Mutex<RuntimeState>>) -> settings::Config { shared.lock().unwrap().config.clone() }
fn url(shared: &Arc<Mutex<RuntimeState>>) -> String { let c = config(shared); format!("http://{}:{}", c.host, c.port) }
fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let out = platform::command(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() { return Err(format!("{program}: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
}
pub fn desktop_status() -> DesktopStatus {
    let procs = platform::desktop_procs();
    DesktopStatus {
        gateway_running: procs.iter().any(|p| !p.official),
        official_running: procs.iter().any(|p| p.official),
    }
}
fn official_dir() -> PathBuf { platform::official_dir() }
pub(crate) fn quit_desktop(official: bool) -> Result<bool, String> {
    if platform::fake_desktop().is_some() { return Ok(false); }
    platform::quit(official)
}
pub(crate) fn open_desktop(official: bool) -> Result<(), String> {
    if platform::fake_desktop().is_some() { return Ok(()); }
    if let Some(pid) = platform::running(official).first() { platform::activate(*pid); return Ok(()); }
    if official && !platform::IS_WIN {
        // macOS: the second instance reads its mode from "<data dir>-3p".
        let dir = official_dir();
        let mode_file = PathBuf::from(format!("{}-3p", dir.display())).join("claude_desktop_config.json");
        let mut conf = settings::read_json(&mode_file);
        conf["deploymentMode"] = json!("1p");
        settings::atomic_json(&mode_file, &conf)?;
    }
    // Windows: both instances read the mode from Claude-3p, and only at startup,
    // so it says "1p" just while the official one starts.
    let flip = official && platform::IS_WIN && settings::desktop_mode() == "gateway";
    if flip { settings::set_desktop_mode("claude.ai")?; }
    let launched = platform::launch(official);
    let up = launched.is_ok() && platform::wait_for(true, official, if platform::IS_WIN { 40 } else { 15 });
    if flip { settings::set_desktop_mode("gateway")?; }
    launched?;
    if !up { return Err("Claude Desktop không khởi động được.".into()); }
    Ok(())
}
fn switch_mode(mode: &str, shared: &Arc<Mutex<RuntimeState>>) -> Result<(), String> {
    let was_running = quit_desktop(false)?;
    if mode == "gateway" { settings::apply_desktop_profile(&config(shared))?; }
    else { settings::set_desktop_mode("claude.ai")?; }
    if was_running { open_desktop(false)?; }
    Ok(())
}
fn profile_file(shared: &Arc<Mutex<RuntimeState>>) -> Result<PathBuf, String> {
    let _ = shared;
    settings::profile_file()
}
fn connectors(shared: &Arc<Mutex<RuntimeState>>, official: bool) -> Result<Vec<Value>, String> {
    if official {
        let conf = settings::read_json(&official_dir().join("claude_desktop_config.json"));
        return Ok(conf["mcpServers"].as_object().map(|o| o.iter().map(|(name, v)| { let mut entry=v.clone(); entry["name"]=json!(name); entry }).collect()).unwrap_or_default());
    }
    let _ = shared;
    // Reading must not register a profile in Desktop's library.
    let Some(p) = settings::existing_profile_file() else { return Ok(vec![]) };
    Ok(settings::read_json(&p)["managedMcpServers"].as_array().cloned().unwrap_or_default())
}
fn save_connectors(shared: &Arc<Mutex<RuntimeState>>, official: bool, list: &[Value]) -> Result<(), String> {
    let was_running = quit_desktop(official)?;
    if official {
        let path = official_dir().join("claude_desktop_config.json");
        let mut conf = settings::read_json(&path);
        let mut map = serde_json::Map::new();
        for item in list {
            let name = item["name"].as_str().ok_or("Connector thiếu tên")?;
            let mut v = item.clone();
            v.as_object_mut().unwrap().remove("name");
            map.insert(name.into(), v);
        }
        conf["mcpServers"] = Value::Object(map);
        settings::atomic_json(&path, &conf)?;
    } else {
        let p = profile_file(shared)?;
        let mut profile = settings::read_json(&p);
        profile["managedMcpServers"] = json!(list);
        settings::atomic_json(&p, &profile)?;
    }
    if was_running { open_desktop(official)?; }
    Ok(())
}
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str).filter(|v| !v.trim().is_empty())
}

/// Splits a command line, honouring single/double quotes and backslash escapes.
pub(crate) fn split_command(line: &str) -> Result<Vec<String>, String> {
    let (mut out, mut word, mut quote, mut escape, mut started) = (Vec::new(), String::new(), None::<char>, false, false);
    for c in line.trim().chars() {
        if escape { word.push(c); escape = false; started = true; continue; }
        match (quote, c) {
            // Windows paths use backslashes, so only Unix treats them as escapes.
            (_, '\\') if !platform::IS_WIN => { escape = true; started = true; }
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => { quote = Some(c); started = true; }
            (None, c) if c.is_whitespace() => { if started { out.push(std::mem::take(&mut word)); started = false; } }
            (None, c) => { word.push(c); started = true; }
        }
    }
    if quote.is_some() || escape { return Err("Lệnh có dấu nháy chưa đóng.".into()); }
    if started { out.push(word); }
    if out.is_empty() { return Err("Nhập lệnh chạy MCP.".into()); }
    Ok(out)
}

fn local_entry(name: &str, line: &str) -> Result<Value, String> {
    let mut parts = split_command(line)?;
    let program = parts.remove(0);
    platform::mcp_command(name, &program, parts)
}

fn preset_url(name: &str) -> Option<&'static str> {
    match name {
        "clickup" => Some("https://mcp.clickup.com/mcp"), "linear" => Some("https://mcp.linear.app/mcp"),
        "notion" => Some("https://mcp.notion.com/mcp"), "atlassian" => Some("https://mcp.atlassian.com/v1/mcp"),
        "sentry" => Some("https://mcp.sentry.dev/mcp"), "figma" => Some("https://mcp.figma.com/mcp"), _ => None,
    }
}
async fn register_figma_client() -> Result<Value, String> {
    let request = json!({
        "client_name": "Claude Code",
        "redirect_uris": ["http://127.0.0.1:53282/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
        "scope": "mcp:connect"
    });
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let response = client.post("https://api.figma.com/v1/oauth/mcp/register").json(&request).send().await.map_err(|e| format!("Không đăng ký được Figma OAuth: {e}"))?;
    if !response.status().is_success() { return Err(format!("Figma OAuth trả HTTP {}", response.status())); }
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    let id = body["client_id"].as_str().ok_or("Figma không trả client_id")?;
    Ok(json!({"clientId": id, "clientSecret": body["client_secret"], "authorizationServer": ["https://api.figma.com"], "callbackPort": 53282, "scope": "mcp:connect"}))
}

async fn connector_action(args: &[String], shared: &Arc<Mutex<RuntimeState>>) -> Result<String, String> {
    let official = args.iter().any(|a| a == "--official");
    let sub = args.get(1).map(String::as_str).unwrap_or("list");
    let mut list = connectors(shared, official)?;
    match sub {
        "list" => Ok(if list.is_empty() { "Chưa có connector.".into() } else { list.iter().map(|c| format!("{}  {}", c["name"].as_str().unwrap_or("?"), c["url"].as_str().or_else(|| c["command"].as_str()).unwrap_or("local"))).collect::<Vec<_>>().join("\n") }),
        "add" => {
            let name = args.get(2).ok_or("Thiếu tên connector")?.to_lowercase();
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("Tên connector chỉ dùng chữ thường, số, dấu - hoặc _.".into()); }
            let url = flag(args, "--url").map(String::from).or_else(|| preset_url(&name).map(String::from).filter(|_| flag(args, "--command").is_none()));
            let mut entry = if let Some(cmd) = flag(args, "--command") {
                local_entry(&name, cmd)?
            } else if let Some(url) = url {
                if !url.starts_with("https://") { return Err("URL phải bắt đầu bằng https://".into()); }
                if official {
                    // The claude.ai Desktop only runs local servers from its config: bridge the URL with mcp-remote.
                    if name == "figma" && flag(args, "--url").is_none() { return Err("Figma chỉ cho client trong danh sách của Figma; với cửa sổ Official hãy thêm Figma trong Settings → Connectors.".into()); }
                    platform::mcp_command(&name, "npx", vec!["-y".into(), "mcp-remote@latest".into(), url.clone()])
                        .map_err(|e| format!("Cần Node.js (npx) để nối MCP qua mạng cho cửa sổ Official. {e}"))?
                } else {
                    let mut e = json!({"name": name, "transport": "http", "url": url, "oauth": true});
                    if name == "figma" && flag(args, "--url").is_none() {
                        e["oauth"] = if let Some(previous) = list.iter().find(|c| c["name"] == "figma" && c["url"] == url.as_str()).and_then(|c| c.get("oauth")).filter(|o| o.get("clientId").is_some()) {
                            previous.clone()
                        } else { register_figma_client().await? };
                    }
                    e
                }
            } else { return Err("MCP này chưa có trong danh sách: nhập URL https://… hoặc lệnh chạy MCP.".into()) };
            if official { if let Some(o) = entry.as_object_mut() { o.remove("transport"); } }
            else if entry.get("command").is_some() { entry["transport"] = json!("stdio"); }
            if let Some(policy) = list.iter().find(|c| c["name"] == name.as_str()).and_then(|c| c.get("toolPolicy")) { if !official { entry["toolPolicy"] = policy.clone(); } }
            list.retain(|c| c["name"] != name.as_str());
            list.push(entry.clone());
            save_connectors(shared, official, &list)?;
            let mut disabled = disabled_connectors(official);
            disabled.retain(|c| c["name"] != name.as_str());
            save_disabled(official, &disabled)?;
            Ok(if entry.get("command").is_some() && entry["args"].as_array().is_some_and(|a| a.iter().any(|x| x == "mcp-remote@latest")) {
                format!("Đã thêm {name} cho cửa sổ Official (qua mcp-remote). Lần đầu dùng, trình duyệt sẽ mở để đăng nhập dịch vụ.")
            } else if entry.get("command").is_some() {
                format!("Đã thêm MCP cục bộ {name}.")
            } else {
                format!("Đã thêm {name}. Mở Claude Desktop → Settings → Connectors để kết nối.")
            })
        },
        "set-enabled" => {
            let name = args.get(2).ok_or("Thiếu tên MCP")?;
            let enabled = match args.get(3).map(String::as_str) { Some("on") => true, Some("off") => false, _ => return Err("Chọn on hoặc off".into()) };
            let mut disabled = disabled_connectors(official);
            if enabled {
                let entry = disabled.iter().find(|c| c["name"] == *name).cloned().ok_or_else(|| format!("Không tìm thấy MCP đang tắt: {name}"))?;
                list.retain(|c| c["name"] != *name);
                list.push(entry);
                save_connectors(shared, official, &list)?;
                disabled.retain(|c| c["name"] != *name);
                save_disabled(official, &disabled)?;
            } else {
                let entry = list.iter().find(|c| c["name"] == *name).cloned().ok_or_else(|| format!("Không tìm thấy MCP đang bật: {name}"))?;
                disabled.retain(|c| c["name"] != *name);
                disabled.push(entry);
                save_disabled(official, &disabled)?;
                list.retain(|c| c["name"] != *name);
                save_connectors(shared, official, &list)?;
            }
            Ok(format!("Đã {} MCP {name}.", if enabled { "bật" } else { "tắt" }))
        },
        "remove" | "rm" => {
            let name = args.get(2).ok_or("Thiếu tên connector")?;
            let mut disabled = disabled_connectors(official);
            let before = list.len() + disabled.len();
            list.retain(|c| c["name"] != *name);
            disabled.retain(|c| c["name"] != *name);
            if list.len() + disabled.len() == before { return Err(format!("Không tìm thấy MCP {name}")); }
            if connectors(shared, official)?.len() != list.len() { save_connectors(shared, official, &list)?; }
            save_disabled(official, &disabled)?;
            Ok(format!("Đã xóa MCP {name}."))
        },
        _ => Err("Action connector không hợp lệ".into()),
    }
}
fn permissions_action(args: &[String], shared: &Arc<Mutex<RuntimeState>>) -> Result<String, String> {
    let mut list = connectors(shared, false)?;
    let sub = args.get(1).map(String::as_str).unwrap_or("status");
    if sub == "status" { return Ok(if list.is_empty() { "Chưa có connector.".into() } else { list.iter().map(|c| format!("{}: {}", c["name"].as_str().unwrap_or("?"), if c["toolPolicy"]["*"] == "allow" { "bỏ qua hỏi" } else { "luôn hỏi" })).collect::<Vec<_>>().join("\n") }); }
    if sub != "bypass" && sub != "ask" { return Err("Chỉ hỗ trợ permissions ask hoặc bypass".into()); }
    let name = args.get(2).filter(|s| !s.starts_with('-'));
    if let Some(name) = name { if !list.iter().any(|c| c["name"] == *name) { return Err(format!("Không tìm thấy connector {name}")); } }
    for item in &mut list {
        if name.is_none() || name.is_some_and(|n| item["name"] == *n) {
            if sub == "bypass" { item["toolPolicy"] = json!({"*":"allow"}); }
            else { item.as_object_mut().unwrap().remove("toolPolicy"); }
        }
    }
    save_connectors(shared, false, &list)?;
    Ok(if sub == "bypass" { "Đã bỏ qua bước hỏi quyền công cụ." } else { "Đã bật bước hỏi quyền công cụ." }.into())
}
fn desktop_action(args: &[String], shared: &Arc<Mutex<RuntimeState>>) -> Result<String, String> {
    let sub = args.get(1).map(String::as_str).unwrap_or("status");
    match sub {
        "status" | "mode" => { let s = desktop_status(); Ok(format!("Gateway Desktop: {}\nOfficial Desktop: {}", if s.gateway_running {"đang mở"} else {"đã đóng"}, if s.official_running {"đang mở"} else {"đã đóng"})) },
        "official" => match args.get(2).map(String::as_str).unwrap_or("open") {
            "status" => Ok(format!("Official Desktop: {}", if desktop_status().official_running {"đang mở"} else {"đã đóng"})),
            "quit" => { Ok(if quit_desktop(true)? {"Đã đóng Official Desktop."} else {"Official Desktop đã đóng."}.into()) },
            "open" | "--sign-in" => { open_desktop(true)?; Ok("Đã mở Official Desktop. Đăng nhập trong cửa sổ nếu cần.".into()) },
            _ => Err("Action official không hợp lệ".into()),
        },
        "open" | "gateway" => { start_gateway_inner(shared)?; switch_mode("gateway", shared)?; open_desktop(false)?; Ok("Đã mở Claude Desktop ở chế độ gateway.".into()) },
        "quit" => { Ok(if quit_desktop(false)? {"Đã đóng Gateway Desktop."} else {"Gateway Desktop đã đóng."}.into()) },
        "login" => { switch_mode("claude.ai", shared)?; open_desktop(false)?; Ok("Đã chuyển sang claude.ai.".into()) },
        "toggle" => { let mode = if settings::desktop_mode() == "gateway" { "claude.ai" } else { "gateway" }; if mode == "gateway" { start_gateway_inner(shared)?; } switch_mode(mode, shared)?; open_desktop(false)?; Ok(format!("Đã chuyển sang {mode}.")) },
        "both" => { start_gateway_inner(shared)?; switch_mode("gateway", shared)?; open_desktop(false)?; open_desktop(true)?; Ok("Đã mở cả hai cửa sổ.".into()) },
        "quit-both" => { let a=quit_desktop(false)?; let b=quit_desktop(true)?; Ok(if a||b {"Đã đóng cả hai cửa sổ."} else {"Không có cửa sổ nào đang chạy."}.into()) },
        "profile" => { settings::apply_desktop_profile(&config(shared))?; Ok("Đã cập nhật profile gateway.".into()) },
        _ => Err("Action Desktop không hợp lệ".into()),
    }
}

pub async fn run(args: Vec<String>, shared: &Arc<Mutex<RuntimeState>>) -> Result<ActionResult, String> {
    if args.is_empty() || args.len() > 12 || args.iter().any(|a| a.len() > 1000 || a.contains('\0')) { return Err("Action không hợp lệ".into()); }
    let output = match args[0].as_str() {
        "start" => { start_gateway_inner(shared)?; format!("Gateway đang chạy tại {}", url(shared)) },
        "stop" => { stop_gateway_inner(shared); "Đã dừng gateway.".into() },
        "restart" => { restart_gateway_inner(shared)?; "Đã khởi động lại gateway.".into() },
        "status" => { let s=shared.lock().unwrap(); format!("Gateway: {}\nClaude Code: {}\nURL: {}:{}", if s.running {"đang chạy"} else {"đã dừng"}, if crate::gateway::claude_available(&s.config.claude_path) {"sẵn sàng"} else {"chưa tìm thấy"}, s.config.host,s.config.port) },
        "info" => { let c=config(shared); format!("URL: http://{}:{}\nAPI key: {}\nAuth: bearer",c.host,c.port,c.api_key) },
        "rotate-key" => { let key=rotate_key_inner(shared)?; format!("Đã đổi API key: {key}\nProfile Claude Desktop đã được cập nhật; mở lại cửa sổ Gateway để dùng key mới.") },
        "desktop" => desktop_action(&args,shared)?,
        "connector" => connector_action(&args,shared).await?,
        "permissions" => permissions_action(&args,shared)?,
        "credential" => {
            match args.get(1).map(String::as_str).unwrap_or("status") {
                "status" => {
                    let claude=crate::gateway::claude_executable(&config(shared).claude_path);
                    run_cmd(&claude,&["auth","status"])?
                },
                "login" => { let claude=crate::gateway::claude_executable(&config(shared).claude_path); run_cmd(&claude,&["auth","login"])? },
                _ => return Err("Ứng dụng dùng phiên đăng nhập Claude Code trực tiếp; không có auto-login riêng.".into()),
            }
        },
        "logs" => "Gateway chạy trong tiến trình ứng dụng. Lỗi sẽ hiển thị trong bảng hoạt động.".into(),
        "gmail" | "figma" | "sync" | "handoff" | "skill" | "update" => return Err(format!("{} chưa được hỗ trợ trong phiên bản này.", args[0])),
        _ => return Err("Action không hợp lệ".into()),
    };
    Ok(result(&args, output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_for_listing() -> Arc<Mutex<RuntimeState>> {
        Arc::new(Mutex::new(RuntimeState { config: settings::Config { host: "127.0.0.1".into(), port: 8799, api_key: "t".into(), claude_path: String::new(), autostart: true }, shutdown: None, running: false, last_error: None, generation: 0, activity: Default::default(), started_at: None }))
    }

    #[tokio::test]
    async fn connector_actions_work_without_changing_desktop_mode() {
        let _env = settings::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("ccgw-native-{}", uuid::Uuid::new_v4()));
        std::env::set_var("CCGW_DESKTOP_DIR", &root);
        std::env::set_var("CCGW_RUST_HOME", &root);
        settings::set_desktop_mode("claude.ai").unwrap();
        // Listing on a Desktop without a CCGW profile leaves its library alone.
        assert!(list_mcp(&shared_for_listing()).unwrap().is_empty());
        assert!(!root.join("configLibrary/_meta.json").exists());
        let shared = Arc::new(Mutex::new(RuntimeState {
            config: settings::Config { host: "127.0.0.1".into(), port: 8799, api_key: "test".into(), claude_path: String::new(), autostart: true },
            shutdown: None, running: false, last_error: None, generation: 0, activity: Default::default(), started_at: None,
        }));
        let add = vec!["connector".into(), "add".into(), "notion".into()];
        connector_action(&add, &shared).await.unwrap();
        assert_eq!(settings::desktop_mode(), "claude.ai");
        assert!(connector_action(&["connector".into(), "list".into()], &shared).await.unwrap().contains("notion"));
        connector_action(&["connector".into(), "set-enabled".into(), "notion".into(), "off".into()], &shared).await.unwrap();
        assert!(!list_mcp(&shared).unwrap().iter().find(|item| item.name == "notion").unwrap().enabled);
        connector_action(&["connector".into(), "set-enabled".into(), "notion".into(), "on".into()], &shared).await.unwrap();
        let item = list_mcp(&shared).unwrap().into_iter().find(|item| item.name == "notion").unwrap();
        assert!(item.enabled && item.ask && item.preset && item.kind == "remote");
        permissions_action(&["permissions".into(), "bypass".into(), "notion".into()], &shared).unwrap();
        assert_eq!(connectors(&shared, false).unwrap()[0]["toolPolicy"]["*"], "allow");
        assert!(!list_mcp(&shared).unwrap()[0].ask);
        permissions_action(&["permissions".into(), "ask".into(), "notion".into()], &shared).unwrap();
        assert!(list_mcp(&shared).unwrap()[0].ask);
        assert_eq!(endpoint(&json!({"command": "/opt/homebrew/bin/npx", "args": ["-y", "pkg"]})), "npx -y pkg");
        assert_eq!(split_command("node \"/a b/server.js\" --flag 'x y'").unwrap(), ["node", "/a b/server.js", "--flag", "x y"]);
        assert!(split_command("node 'oops").is_err());
        if platform::IS_WIN { assert_eq!(split_command(r"C:\Tools\mcp.exe --dir C:\data").unwrap(), [r"C:\Tools\mcp.exe", "--dir", r"C:\data"]); }
        // Official: a preset goes through mcp-remote, a command stays local; no toolPolicy there.
        if platform::resolve_program("npx").is_some() {
            connector_action(&["connector".into(), "add".into(), "linear".into(), "--official".into()], &shared).await.unwrap();
            let off = connectors(&shared, true).unwrap();
            let linear = off.iter().find(|c| c["name"] == "linear").unwrap();
            let args = linear["args"].as_array().unwrap();
            assert!(args.iter().any(|a| a == "mcp-remote@latest") && args.last().unwrap() == "https://mcp.linear.app/mcp" && linear.get("transport").is_none());
            assert_eq!(list_mcp(&shared).unwrap().iter().find(|i| i.name == "linear").unwrap().kind, "bridge");
        }
        let echo = if platform::IS_WIN { "C:\\Windows\\System32\\whoami.exe hello" } else { "/bin/echo hello" };
        connector_action(&["connector".into(), "add".into(), "mine".into(), "--command".into(), echo.into()], &shared).await.unwrap();
        let mine = connectors(&shared, false).unwrap().into_iter().find(|c| c["name"] == "mine").unwrap();
        assert_eq!((mine["transport"].as_str(), mine["args"][0].as_str()), (Some("stdio"), Some("hello")));
        connector_action(&["connector".into(), "add".into(), "custom".into(), "--url".into(), "https://example.com/mcp".into()], &shared).await.unwrap();
        assert!(connector_action(&["connector".into(), "add".into(), "bad".into(), "--url".into(), "http://x".into()], &shared).await.is_err());
        connector_action(&["connector".into(), "remove".into(), "mine".into()], &shared).await.unwrap();
        connector_action(&["connector".into(), "remove".into(), "custom".into()], &shared).await.unwrap();
        connector_action(&["connector".into(), "remove".into(), "notion".into()], &shared).await.unwrap();
        assert!(connectors(&shared, false).unwrap().is_empty());
        std::env::remove_var("CCGW_DESKTOP_DIR");
        std::env::remove_var("CCGW_RUST_HOME");
        std::fs::remove_dir_all(root).unwrap();
    }
}
