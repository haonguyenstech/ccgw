#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod gateway;
mod settings;
mod native;
mod skills;
mod sync;
mod syncflow;

use settings::Config;
use std::{sync::{Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tokio::sync::oneshot;

pub(crate) struct RuntimeState {
    pub(crate) config: Config,
    pub(crate) shutdown: Option<oneshot::Sender<()>>,
    pub(crate) running: bool,
    pub(crate) last_error: Option<String>,
    pub(crate) generation: u64,
    pub(crate) activity: gateway::SharedActivity,
    pub(crate) started_at: Option<u64>,
}

struct AppState(Arc<Mutex<RuntimeState>>);

/// Runs blocking work (process spawns, waits, dialogs) off the main/UI thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct Status {
    running: bool,
    url: String,
    host: String,
    port: u16,
    api_key: String,
    autostart: bool,
    claude_path: String,
    claude_executable: String,
    config_file: String,
    claude_found: bool,
    claude_version: Option<String>,
    desktop_mode: String,
    started_at: Option<u64>,
    last_error: Option<String>,
    version: &'static str,
    activity: gateway::ActivitySnapshot,
}

#[tauri::command]
async fn status(state: tauri::State<'_, AppState>) -> Result<Status, String> {
    let shared = state.0.clone();
    blocking(move || {
        let (config, running, last_error, started_at, activity) = {
            let inner = shared.lock().unwrap();
            let activity = inner.activity.lock().unwrap().snapshot();
            (inner.config.clone(), inner.running, inner.last_error.clone(), inner.started_at, activity)
        };
        let claude_version = gateway::claude_version(&config.claude_path);
        Ok(Status {
            running,
            url: format!("http://{}:{}", config.host, config.port),
            host: config.host.clone(),
            port: config.port,
            api_key: config.api_key.clone(),
            autostart: config.autostart,
            claude_executable: gateway::claude_executable(&config.claude_path),
            claude_path: config.claude_path,
            config_file: settings::config_path().display().to_string(),
            claude_found: claude_version.is_some(),
            claude_version,
            desktop_mode: settings::desktop_mode(),
            started_at,
            last_error,
            version: env!("CARGO_PKG_VERSION"),
            activity,
        })
    }).await
}

#[tauri::command]
async fn desktop_status() -> Result<native::DesktopStatus, String> {
    blocking(|| Ok(native::desktop_status())).await
}

#[tauri::command]
async fn start_gateway(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let shared = state.0.clone();
    blocking(move || start_gateway_inner(&shared)).await
}

pub(crate) fn start_gateway_inner(shared: &Arc<Mutex<RuntimeState>>) -> Result<(), String> {
    let mut inner = shared.lock().unwrap();
    if inner.running { return Ok(()); }
    if !gateway::claude_available(&inner.config.claude_path) {
        let error = "Không tìm thấy Claude Code CLI. Cài đặt và đăng nhập bằng lệnh `claude`, hoặc chỉ đường dẫn trong Cài đặt.".to_string();
        inner.last_error = Some(error.clone());
        return Err(error);
    }
    let address = format!("{}:{}", inner.config.host, inner.config.port);
    let listener = match std::net::TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(e) => {
            let error = format!("Không mở được {address}: {e}. Cổng có thể đang bị ứng dụng khác dùng; đổi cổng trong Cài đặt.");
            inner.last_error = Some(error.clone());
            return Err(error);
        }
    };
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (tx, rx) = oneshot::channel();
    inner.generation += 1;
    let generation = inner.generation;
    let config = inner.config.clone();
    let activity = inner.activity.clone();
    let shared = shared.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let result = runtime.block_on(gateway::run(listener, config, activity, rx));
        let mut current = shared.lock().unwrap();
        if current.generation == generation {
            current.running = false;
            current.shutdown = None;
            current.started_at = None;
            if let Err(e) = result { current.last_error = Some(e); }
        }
    });
    inner.shutdown = Some(tx);
    inner.running = true;
    inner.started_at = Some(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    inner.last_error = None;
    Ok(())
}

#[tauri::command]
fn stop_gateway(state: tauri::State<'_, AppState>) {
    stop_gateway_inner(&state.0);
}

pub(crate) fn stop_gateway_inner(shared: &Arc<Mutex<RuntimeState>>) {
    let mut inner = shared.lock().unwrap();
    if let Some(tx) = inner.shutdown.take() { let _ = tx.send(()); }
    inner.running = false;
    inner.started_at = None;
}

/// Stops and starts the gateway, waiting briefly for the old listener to release the port.
pub(crate) fn restart_gateway_inner(shared: &Arc<Mutex<RuntimeState>>) -> Result<(), String> {
    stop_gateway_inner(shared);
    let mut last = Ok(());
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        last = start_gateway_inner(shared);
        if last.is_ok() { break; }
    }
    last
}

#[tauri::command]
async fn rotate_key(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let shared = state.0.clone();
    blocking(move || rotate_key_inner(&shared)).await
}

/// Issues a new key, updates an existing Desktop profile and restarts a running gateway.
pub(crate) fn rotate_key_inner(shared: &Arc<Mutex<RuntimeState>>) -> Result<String, String> {
    let (key, was_running) = {
        let mut inner = shared.lock().unwrap();
        inner.config.api_key = settings::new_key();
        settings::save(&inner.config)?;
        settings::sync_profile_credentials(&inner.config)?;
        (inner.config.api_key.clone(), inner.running)
    };
    if was_running { restart_gateway_inner(shared)?; }
    Ok(key)
}

#[derive(serde::Deserialize)]
struct SettingsInput { host: String, port: u16, claude_path: String, autostart: bool }

#[tauri::command]
async fn save_settings(input: SettingsInput, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let shared = state.0.clone();
    blocking(move || save_settings_inner(&shared, input)).await
}

/// Validates and stores settings; a running gateway is restarted when the address or CLI changes.
fn save_settings_inner(shared: &Arc<Mutex<RuntimeState>>, input: SettingsInput) -> Result<String, String> {
    let host = input.host.trim().to_string();
    if host.parse::<std::net::IpAddr>().is_err() && host != "localhost" { return Err("Host phải là địa chỉ IP (ví dụ 127.0.0.1) hoặc localhost.".into()); }
    if input.port < 1024 { return Err("Chọn cổng từ 1024 đến 65535.".into()); }
    let claude_path = input.claude_path.trim().to_string();
    if !claude_path.is_empty() && gateway::claude_version(&claude_path).is_none() {
        return Err(format!("Không chạy được Claude Code tại {claude_path}."));
    }
    let (changed, was_running) = {
        let mut inner = shared.lock().unwrap();
        let changed = inner.config.host != host || inner.config.port != input.port || inner.config.claude_path != claude_path;
        inner.config.host = host;
        inner.config.port = input.port;
        inner.config.claude_path = claude_path;
        inner.config.autostart = input.autostart;
        settings::save(&inner.config)?;
        settings::sync_profile_credentials(&inner.config)?;
        (changed, inner.running)
    };
    if changed && was_running {
        restart_gateway_inner(shared)?;
        return Ok("Đã lưu và khởi động lại gateway.".into());
    }
    Ok("Đã lưu cài đặt.".into())
}

#[tauri::command]
async fn apply_desktop_profile(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = state.0.lock().unwrap().config.clone();
    blocking(move || settings::apply_desktop_profile(&config)).await
}

#[tauri::command]
async fn run_action(args: Vec<String>, state: tauri::State<'_, AppState>) -> Result<native::ActionResult, String> {
    let shared = state.0.clone();
    blocking(move || tauri::async_runtime::block_on(native::run(args, &shared))).await
}

#[tauri::command]
async fn list_mcp(state: tauri::State<'_, AppState>) -> Result<Vec<native::McpItem>, String> {
    let shared = state.0.clone();
    blocking(move || native::list_mcp(&shared)).await
}
#[tauri::command]
async fn choose_skill_folder() -> Result<String, String> { blocking(skills::choose_folder).await }
#[tauri::command]
async fn inspect_skill(path: String) -> Result<skills::SkillInfo, String> { blocking(move || skills::inspect_folder(path)).await }
#[tauri::command]
async fn install_gateway_skill(path: String) -> Result<String, String> { blocking(move || skills::install_gateway(path)).await }
#[tauri::command]
async fn list_gateway_skills() -> Result<Vec<skills::SkillInfo>, String> { blocking(|| Ok(skills::list_gateway())).await }
#[tauri::command]
async fn prepare_official_skill(path: String) -> Result<String, String> { blocking(move || skills::prepare_official(path)).await }

#[tauri::command]
async fn sync_state() -> Result<syncflow::LocalState, String> { blocking(|| Ok(syncflow::local_state())).await }
#[tauri::command]
async fn sync_plan() -> Result<syncflow::SyncPlan, String> { blocking(|| tauri::async_runtime::block_on(syncflow::sync_plan())).await }
#[tauri::command]
async fn sync_run(picked: Vec<String>) -> Result<syncflow::SyncReport, String> { blocking(move || tauri::async_runtime::block_on(syncflow::sync_run(picked))).await }
#[tauri::command]
async fn handoff_plan() -> Result<syncflow::HandoffPlan, String> { blocking(|| tauri::async_runtime::block_on(syncflow::handoff_plan())).await }
#[tauri::command]
async fn handoff_run(sessions: Vec<String>, skills: bool, model: String, brief: bool) -> Result<syncflow::HandoffReport, String> {
    blocking(move || tauri::async_runtime::block_on(syncflow::handoff_run(sessions, skills, model, brief))).await
}
#[derive(serde::Serialize)]
struct OfficialSkills { skills: Vec<syncflow::AccountSkill>, notice: Option<String> }
#[tauri::command]
async fn list_official_skills() -> Result<OfficialSkills, String> {
    blocking(|| tauri::async_runtime::block_on(syncflow::official_skill_list()).map(|(skills, notice)| OfficialSkills { skills, notice })).await
}
#[tauri::command]
async fn install_official_skill(path: String, overwrite: bool) -> Result<String, String> {
    blocking(move || tauri::async_runtime::block_on(syncflow::install_official_skill(path, overwrite))).await
}
#[tauri::command]
async fn add_read_sync() -> Result<String, String> { blocking(|| tauri::async_runtime::block_on(syncflow::add_read_sync())).await }
#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    blocking(move || {
        use std::io::Write;
        let mut child = std::process::Command::new("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        child.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        child.wait().map_err(|e| e.to_string())?;
        Ok(())
    }).await
}
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://claude.ai/") { return Err("Chỉ mở link claude.ai".into()); }
    blocking(move || { std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?; Ok(()) }).await
}

fn main() {
    let _ = settings::migrate_profile_label();
    let config = settings::load().expect("Cannot load CCGW Desktop configuration");
    if std::env::args().any(|arg| arg == "--headless") {
        let listener = std::net::TcpListener::bind(format!("{}:{}", config.host, config.port)).expect("Cannot bind gateway port");
        listener.set_nonblocking(true).expect("Cannot set nonblocking listener");
        println!("CCGW Desktop gateway listening on http://{}:{}", config.host, config.port);
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let (tx, rx) = oneshot::channel();
        runtime.spawn(async move { let _ = tokio::signal::ctrl_c().await; let _ = tx.send(()); });
        runtime.block_on(gateway::run(listener, config, Default::default(), rx)).expect("Gateway failed");
        return;
    }
    let autostart = config.autostart;
    let shared = Arc::new(Mutex::new(RuntimeState {
        config, shutdown: None, running: false, last_error: None, generation: 0, activity: Default::default(), started_at: None,
    }));
    if autostart {
        let shared = shared.clone();
        std::thread::spawn(move || { let _ = start_gateway_inner(&shared); });
    }
    tauri::Builder::default()
        .manage(AppState(shared))
        .invoke_handler(tauri::generate_handler![status, desktop_status, start_gateway, stop_gateway, rotate_key, save_settings, apply_desktop_profile, run_action, list_mcp, choose_skill_folder, inspect_skill, install_gateway_skill, list_gateway_skills, prepare_official_skill, sync_state, sync_plan, sync_run, handoff_plan, handoff_run, add_read_sync, list_official_skills, install_official_skill, copy_text, open_url])
        .run(tauri::generate_context!())
        .expect("error while running CCGW Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_a_new_port_moves_the_running_gateway() {
        let _env = settings::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("ccgw-main-{}", uuid::Uuid::new_v4()));
        std::env::set_var("CCGW_RUST_HOME", &root);
        std::env::set_var("CCGW_DESKTOP_DIR", root.join("desktop"));
        let config = Config { host: "127.0.0.1".into(), port: 18811, api_key: "k".into(), claude_path: String::new(), autostart: true };
        let shared = Arc::new(Mutex::new(RuntimeState { config, shutdown: None, running: false, last_error: None, generation: 0, activity: Default::default(), started_at: None }));
        if !gateway::claude_available("") { eprintln!("skipped: Claude Code not installed"); return; }
        start_gateway_inner(&shared).unwrap();
        let input = |port| SettingsInput { host: "127.0.0.1".into(), port, claude_path: String::new(), autostart: false };
        assert!(save_settings_inner(&shared, input(80)).is_err());
        assert!(save_settings_inner(&shared, SettingsInput { host: "not a host".into(), ..input(18812) }).is_err());
        assert_eq!(save_settings_inner(&shared, input(18812)).unwrap(), "Đã lưu và khởi động lại gateway.");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(std::net::TcpStream::connect("127.0.0.1:18812").is_ok());
        assert!(std::net::TcpStream::connect("127.0.0.1:18811").is_err());
        let saved = settings::load().unwrap();
        assert_eq!((saved.port, saved.autostart), (18812, false));
        assert_eq!(save_settings_inner(&shared, input(18812)).unwrap(), "Đã lưu cài đặt.");
        stop_gateway_inner(&shared);
        std::env::remove_var("CCGW_RUST_HOME");
        std::env::remove_var("CCGW_DESKTOP_DIR");
        let _ = std::fs::remove_dir_all(root);
    }
}
