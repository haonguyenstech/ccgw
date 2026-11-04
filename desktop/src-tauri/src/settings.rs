use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub api_key: String,
    #[serde(default)]
    pub claude_path: String,
    /// Start the gateway when the app opens.
    #[serde(default = "yes")]
    pub autostart: bool,
}

fn yes() -> bool { true }

/// Serialises tests that change process-wide environment variables.
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn new_key() -> String {
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    format!("sk-ccgw-{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn config_path() -> PathBuf {
    if let Ok(home) = std::env::var("CCGW_RUST_HOME") { return PathBuf::from(home).join("config.json"); }
    if cfg!(test) { panic!("tests must set CCGW_RUST_HOME so they never touch the real config"); }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".ccgw-rust").join("config.json")
}

pub fn load() -> Result<Config, String> {
    let file = config_path();
    if file.exists() {
        let mut config: Config = serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(suffix) = config.api_key.strip_prefix("sk-ccgw-rust-") {
            config.api_key = format!("sk-ccgw-{suffix}");
            save(&config)?;
            sync_profile_credentials(&config)?;
        }
        return Ok(config);
    }
    let config = Config { host: "127.0.0.1".into(), port: 8799, api_key: new_key(), claude_path: String::new(), autostart: true };
    save(&config)?;
    Ok(config)
}

pub fn save(config: &Config) -> Result<(), String> {
    let path = config_path();
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    atomic_json(&path, &serde_json::to_value(config).map_err(|e| e.to_string())?)
}

pub(crate) fn read_json(path: &Path) -> Value {
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

pub(crate) fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

pub(crate) fn desktop_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CCGW_DESKTOP_DIR") { return PathBuf::from(path); }
    if cfg!(test) { panic!("tests must set CCGW_DESKTOP_DIR so they never touch the real Claude Desktop profile"); }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "macos") { home.join("Library/Application Support/Claude-3p") }
    else if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home.join("AppData/Local")).join("Claude-3p")
    } else { std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".config")).join("Claude-3p") }
}

pub fn apply_desktop_profile(config: &Config) -> Result<String, String> {
    apply_desktop_profile_at(&desktop_dir(), config)
}

/// The CCGW profile file if Desktop's library already lists it; never creates it.
pub(crate) fn existing_profile_file() -> Option<PathBuf> {
    let library = desktop_dir().join("configLibrary");
    let meta = read_json(&library.join("_meta.json"));
    let id = meta["entries"].as_array()?.iter().find(|e| e["name"] == "Claude Code (CCGW)")?["id"].as_str()?.to_string();
    Some(library.join(format!("{id}.json")))
}

/// The CCGW profile file, registering it in Desktop's library first if needed (writes).
pub(crate) fn profile_file() -> Result<PathBuf, String> {
    let library = desktop_dir().join("configLibrary");
    let meta_file = library.join("_meta.json");
    let mut meta = read_json(&meta_file);
    if !meta["entries"].is_array() { meta["entries"] = json!([]); }
    let name = "Claude Code (CCGW)";
    if let Some(id) = meta["entries"].as_array().unwrap().iter()
        .find(|entry| entry["name"] == name).and_then(|entry| entry["id"].as_str()) {
        return Ok(library.join(format!("{id}.json")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    meta["entries"].as_array_mut().unwrap().push(json!({"id": id, "name": name}));
    atomic_json(&meta_file, &meta)?;
    Ok(library.join(format!("{id}.json")))
}

/// Keeps an existing Desktop profile pointing at the current URL and key without
/// touching the deployment mode. Returns whether a profile was updated.
pub(crate) fn sync_profile_credentials(config: &Config) -> Result<bool, String> {
    let library = desktop_dir().join("configLibrary");
    let meta = read_json(&library.join("_meta.json"));
    let Some(id) = meta["entries"].as_array().and_then(|entries| entries.iter()
        .find(|entry| entry["name"] == "Claude Code (CCGW)").and_then(|entry| entry["id"].as_str())) else { return Ok(false) };
    let profile = library.join(format!("{id}.json"));
    if !profile.exists() { return Ok(false); }
    let mut value = read_json(&profile);
    value["inferenceGatewayBaseUrl"] = json!(format!("http://{}:{}", config.host, config.port));
    value["inferenceGatewayApiKey"] = json!(config.api_key);
    atomic_json(&profile, &value)?;
    Ok(true)
}

pub(crate) fn desktop_mode() -> String {
    if read_json(&desktop_dir().join("claude_desktop_config.json"))["deploymentMode"] == "3p" { "gateway" } else { "claude.ai" }.into()
}

pub(crate) fn set_desktop_mode(mode: &str) -> Result<(), String> {
    let path = desktop_dir().join("claude_desktop_config.json");
    let mut value = read_json(&path);
    value["deploymentMode"] = json!(if mode == "gateway" { "3p" } else { "1p" });
    atomic_json(&path, &value)
}

pub fn migrate_profile_label() -> Result<(), String> {
    migrate_profile_label_at(&desktop_dir())
}

fn migrate_profile_label_at(root: &Path) -> Result<(), String> {
    let meta_file = root.join("configLibrary/_meta.json");
    if !meta_file.exists() { return Ok(()); }
    let mut meta = read_json(&meta_file);
    let mut changed = false;
    if let Some(entries) = meta["entries"].as_array_mut() {
        for entry in entries {
            if entry["name"] == "Claude Code (CCGW Rust)" || entry["name"] == "Claude Code (CCGW Preview)" {
                entry["name"] = json!("Claude Code (CCGW)");
                changed = true;
            }
        }
    }
    if changed { atomic_json(&meta_file, &meta)?; }
    Ok(())
}

fn apply_desktop_profile_at(root: &Path, config: &Config) -> Result<String, String> {
    let library = root.join("configLibrary");
    let meta_file = library.join("_meta.json");
    let mut meta = read_json(&meta_file);
    if !meta.get("entries").is_some_and(Value::is_array) { meta["entries"] = json!([]); }
    let name = "Claude Code (CCGW)";
    let entry_id = meta["entries"].as_array().unwrap().iter()
        .find(|entry| entry["name"] == name)
        .and_then(|entry| entry["id"].as_str()).map(str::to_owned)
        .unwrap_or_else(|| {
            let id = uuid::Uuid::new_v4().to_string();
            meta["entries"].as_array_mut().unwrap().push(json!({"id": id, "name": name}));
            id
        });
    let profile_file = library.join(format!("{entry_id}.json"));
    let mut profile = read_json(&profile_file);
    profile["inferenceProvider"] = json!("gateway");
    profile["inferenceCredentialKind"] = json!("static");
    profile["inferenceGatewayBaseUrl"] = json!(format!("http://{}:{}", config.host, config.port));
    profile["inferenceGatewayApiKey"] = json!(config.api_key);
    profile["inferenceGatewayAuthScheme"] = json!("bearer");
    atomic_json(&profile_file, &profile)?;
    meta["appliedId"] = json!(entry_id);
    atomic_json(&meta_file, &meta)?;
    let desktop_config = root.join("claude_desktop_config.json");
    let mut desktop = read_json(&desktop_config);
    desktop["deploymentMode"] = json!("3p");
    atomic_json(&desktop_config, &desktop)?;
    Ok(profile_file.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_profile_preserves_other_settings_and_reuses_entry() {
        let root = std::env::temp_dir().join(format!("ccgw-desktop-test-{}", uuid::Uuid::new_v4()));
        let config_file = root.join("claude_desktop_config.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&config_file, r#"{"deploymentMode":"1p","mcpServers":{"keep":{}}}"#).unwrap();
        let config = Config { host: "127.0.0.1".into(), port: 8799, api_key: "test-key".into(), claude_path: String::new(), autostart: true };
        let first = apply_desktop_profile_at(&root, &config).unwrap();
        let second = apply_desktop_profile_at(&root, &config).unwrap();
        assert_eq!(first, second);
        let desktop = read_json(&config_file);
        assert_eq!(desktop["deploymentMode"], "3p");
        assert!(desktop["mcpServers"]["keep"].is_object());
        let profile = read_json(Path::new(&first));
        assert_eq!(profile["inferenceGatewayBaseUrl"], "http://127.0.0.1:8799");
        assert_eq!(profile["inferenceGatewayApiKey"], "test-key");
        let meta = read_json(&root.join("configLibrary/_meta.json"));
        assert_eq!(meta["entries"].as_array().unwrap().len(), 1);
        let meta_file = root.join("configLibrary/_meta.json");
        let mut legacy = meta;
        legacy["entries"][0]["name"] = json!("Claude Code (CCGW Rust)");
        atomic_json(&meta_file, &legacy).unwrap();
        migrate_profile_label_at(&root).unwrap();
        assert_eq!(read_json(&meta_file)["entries"][0]["name"], "Claude Code (CCGW)");
        fs::remove_dir_all(root).unwrap();
    }
}
