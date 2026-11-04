//! Everything that differs between macOS and Windows: spawning helper
//! processes without console windows, finding Claude Code and Claude Desktop,
//! listing/starting/stopping Desktop instances, the clipboard, folder pickers
//! and zip files. Port of ccgw's `src/platform.mjs`.
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::Command, time::{Duration, Instant}};

pub const IS_WIN: bool = cfg!(windows);

/// A helper process that never flashes a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    c
}

/// Async variant of [`command`].
pub fn tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)] { c.creation_flags(0x0800_0000); }
    c
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = command(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() { return Err(format!("{program}: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
}

/// Runs a PowerShell script (Windows).
pub fn powershell(script: &str) -> Result<String, String> {
    run("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
}

fn home() -> PathBuf { dirs::home_dir().unwrap_or_default() }
fn local_app_data() -> PathBuf { std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Local")) }
fn app_data() -> PathBuf { std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming")) }
pub fn fake_desktop() -> Option<PathBuf> { std::env::var_os("CCGW_DESKTOP_DIR").map(PathBuf::from) }

// ---------------------------------------------------------------- programs

/// Where Claude Code usually lives, in order of preference.
pub fn claude_candidates() -> Vec<PathBuf> {
    if IS_WIN {
        let mut out = vec![home().join(".local/bin/claude.exe")];
        if let Ok(hits) = run("where.exe", &["claude"]) { out.extend(hits.lines().map(|l| PathBuf::from(l.trim())).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))); }
        out
    } else {
        vec![home().join(".local/bin/claude"), home().join(".claude/local/claude"), "/opt/homebrew/bin/claude".into(), "/usr/local/bin/claude".into()]
    }
}

/// Finds a program the way a login shell would (Desktop starts MCP servers with an empty PATH).
pub fn resolve_program(program: &str) -> Option<String> {
    if program.contains('/') || program.contains('\\') { return Path::new(program).is_file().then(|| program.to_string()); }
    if IS_WIN {
        let hits = run("where.exe", &[program]).ok()?;
        let list: Vec<&str> = hits.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        // Prefer a real executable; npm shims (.cmd) are handled by mcp_command.
        return list.iter().find(|l| l.to_lowercase().ends_with(".exe")).or(list.first()).map(|s| s.to_string());
    }
    let dirs = ["/opt/homebrew/bin".into(), "/usr/local/bin".into(), home().join(".local/bin").display().to_string(), home().join(".bun/bin").display().to_string(), home().join(".cargo/bin").display().to_string(), "/usr/bin".into(), "/bin".into()];
    if let Some(p) = dirs.iter().map(|d| format!("{d}/{program}")).find(|p| Path::new(p).is_file()) { return Some(p); }
    let p = run("/bin/zsh", &["-lc", &format!("command -v {program}")]).ok()?;
    p.starts_with('/').then_some(p)
}

/// An MCP stdio entry Desktop can start. On Windows Desktop cannot run npm's
/// `.cmd` shims, so `npx …` becomes `node.exe …/npx-cli.js …`; on macOS the
/// entry carries a PATH because Desktop gives MCP servers an empty one.
pub fn mcp_command(name: &str, program: &str, args: Vec<String>) -> Result<Value, String> {
    if IS_WIN {
        let lower = program.to_lowercase();
        if lower == "npx" || lower.ends_with("\\npx.cmd") || lower.ends_with("\\npx") {
            let node = resolve_program("node").ok_or("Cần Node.js (node.exe) để chạy npx. Cài Node.js rồi thử lại.")?;
            let cli = Path::new(&node).parent().unwrap_or(Path::new("")).join("node_modules/npm/bin/npx-cli.js");
            if !cli.exists() { return Err(format!("Không tìm thấy {}", cli.display())); }
            let mut a = vec![cli.display().to_string()];
            a.extend(args);
            return Ok(json!({"name": name, "command": node, "args": a}));
        }
        let exe = resolve_program(program).ok_or_else(|| format!("Không tìm thấy chương trình \"{program}\". Nhập đường dẫn đầy đủ."))?;
        return Ok(json!({"name": name, "command": exe, "args": args}));
    }
    let exe = resolve_program(program).ok_or_else(|| format!("Không tìm thấy chương trình \"{program}\". Nhập đường dẫn đầy đủ."))?;
    let dir = Path::new(&exe).parent().map(|d| d.display().to_string()).unwrap_or_default();
    Ok(json!({"name": name, "command": exe, "args": args, "env": {"PATH": format!("{dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}}))
}

// ---------------------------------------------------------------- Claude Desktop data dirs

/// The gateway (third-party mode) Desktop's data dir.
pub fn desktop3p_dir() -> PathBuf {
    if let Some(d) = fake_desktop() { return d; }
    if IS_WIN { local_app_data().join("Claude-3p") } else { home().join("Library/Application Support/Claude-3p") }
}

/// The claude.ai-mode ("Official") Desktop's data dir.
pub fn official_dir() -> PathBuf {
    if let Some(d) = fake_desktop() { return d.join("official/Claude-Official"); }
    if IS_WIN { return official_dir_candidates().into_iter().next().unwrap_or_else(|| app_data().join("Claude")); }
    home().join("Library/Application Support/Claude-Official")
}

fn mtime(p: &Path) -> u128 { std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0) }

/// Windows: MSIX builds keep %APPDATA% virtualised in the package's LocalCache,
/// newer Store builds use %LOCALAPPDATA%\Claude-Data\<family>, the exe installer
/// the real %APPDATA%\Claude. Newest sign-in first.
pub fn official_dir_candidates() -> Vec<PathBuf> {
    if !IS_WIN || fake_desktop().is_some() { return vec![official_dir()]; }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(r) = std::fs::read_dir(local_app_data().join("Claude-Data")) {
        dirs.extend(r.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("claude_")).map(|e| e.path()));
    }
    if let Ok(r) = std::fs::read_dir(local_app_data().join("Packages")) {
        if let Some(fam) = r.filter_map(Result::ok).find(|e| e.file_name().to_string_lossy().starts_with("Claude_")) { dirs.push(fam.path().join("LocalCache/Roaming/Claude")); }
    }
    dirs.push(app_data().join("Claude"));
    let mut dirs: Vec<PathBuf> = dirs.into_iter().filter(|d| d.exists()).collect();
    dirs.dedup();
    dirs.sort_by_key(|d| std::cmp::Reverse((mtime(&d.join("Network/Cookies")).max(mtime(&d.join("Cookies"))), mtime(&d.join("config.json")).max(mtime(&d.join("Local State"))))));
    dirs
}

// ---------------------------------------------------------------- Claude Desktop processes

#[derive(Clone, Debug)]
pub struct Proc { pub pid: u32, pub official: bool }

/// Main Desktop processes, tagged with whether they are the claude.ai instance.
pub fn desktop_procs() -> Vec<Proc> {
    if fake_desktop().is_some() { return vec![]; }
    if IS_WIN {
        // Desktop and Claude Code are both claude.exe: only Desktop's install
        // locations count. The main process's data dir is read off its children.
        let script = r#"$all = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match '\\AnthropicClaude\\|\\WindowsApps\\' }); foreach ($m in $all | Where-Object { $_.CommandLine -notmatch '--type=' }) { $d = ''; foreach ($k in $all | Where-Object { $_.ParentProcessId -eq $m.ProcessId -and $_.CommandLine -notmatch 'crashpad' }) { $x = [regex]::Match($k.CommandLine, '--user-data-dir=("[^"]+"|\S+)'); if ($x.Success) { $d = $x.Groups[1].Value.Trim('"'); break } }; "$($m.ProcessId)`t$d" }"#;
        let gw = desktop3p_dir().file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        return powershell(script).unwrap_or_default().lines().filter_map(|line| {
            let (pid, dir) = line.split_once('\t').unwrap_or((line, ""));
            let dir = dir.trim();
            let name = Path::new(dir).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            Some(Proc { pid: pid.trim().parse().ok()?, official: !dir.is_empty() && name != gw })
        }).collect();
    }
    let Ok(raw) = run("pgrep", &["-x", "Claude"]) else { return vec![] };
    let flag = format!("--user-data-dir={}", official_dir().display());
    raw.lines().filter_map(|s| s.trim().parse::<u32>().ok()).map(|pid| {
        let cmd = run("ps", &["-o", "command=", "-p", &pid.to_string()]).unwrap_or_default();
        Proc { pid, official: cmd.contains(&flag) }
    }).collect()
}

pub fn running(official: bool) -> Vec<u32> { desktop_procs().into_iter().filter(|p| p.official == official).map(|p| p.pid).collect() }

pub fn wait_for(desired: bool, official: bool, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if running(official).is_empty() != desired { return true; }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(if IS_WIN { 600 } else { 250 }));
    }
}

/// Brings a running instance to the front.
pub fn activate(pid: u32) {
    if IS_WIN { let _ = powershell(&format!("[void](New-Object -ComObject WScript.Shell).AppActivate({pid})")); return; }
    let script = format!("ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}); a.isNil() ? false : a.activateWithOptions($.NSApplicationActivateAllWindows)");
    let _ = run("osascript", &["-l", "JavaScript", "-e", &script]);
}

/// Quits one Desktop instance and waits for it to be gone.
pub fn quit(official: bool) -> Result<bool, String> {
    let pids = running(official);
    if pids.is_empty() { return Ok(false); }
    if IS_WIN {
        // No graceful quit for a tray app; /T takes its renderers and helpers along.
        for pid in &pids { let _ = run("taskkill.exe", &["/PID", &pid.to_string(), "/T", "/F"]); }
    } else if !official && running(true).is_empty() {
        let _ = run("osascript", &["-e", "quit app \"Claude\""]);
    } else {
        for pid in &pids { let _ = run("kill", &["-TERM", &pid.to_string()]); }
    }
    if !wait_for(false, official, 30) { return Err("Claude Desktop chưa đóng xong; hãy thử lại.".into()); }
    Ok(true)
}

/// Starts Desktop. On Windows the instance's mode (gateway vs claude.ai) comes
/// from `deploymentMode` at startup, which the caller sets.
pub fn launch(official: bool) -> Result<(), String> {
    if IS_WIN {
        let squirrel = local_app_data().join("AnthropicClaude/claude.exe");
        if squirrel.exists() { command(&squirrel).spawn().map_err(|e| e.to_string())?; return Ok(()); }
        powershell("$a = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1; if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID) } else { throw 'Claude Desktop is not installed' }")
            .map_err(|_| "Chưa cài Claude Desktop.".to_string())?;
        return Ok(());
    }
    if official {
        let dir = official_dir();
        run("open", &["-n", "-a", "Claude", "--args", &format!("--user-data-dir={}", dir.display())])?;
    } else {
        let args: &[&str] = if running(true).is_empty() { &["-a", "Claude"] } else { &["-n", "-a", "Claude"] };
        run("open", args)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- shell helpers

pub fn copy_text(text: &str) -> Result<(), String> {
    use std::io::Write;
    if IS_WIN {
        // clip.exe mangles non-ASCII text; hand PowerShell the UTF-8 bytes instead.
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        powershell(&format!("Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}')))"))?;
        return Ok(());
    }
    let mut child = command("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn open_url(url: &str) -> Result<(), String> {
    if IS_WIN { command("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).spawn().map_err(|e| e.to_string())?; }
    else { command("/usr/bin/open").arg(url).status().map_err(|e| e.to_string())?; }
    Ok(())
}

/// Shows a file in Finder / Explorer.
pub fn reveal(path: &Path) {
    if IS_WIN { let _ = command("explorer.exe").arg(format!("/select,{}", path.display())).spawn(); }
    else { let _ = command("open").arg("-R").arg(path).status(); }
}

/// A native folder picker. `Ok(None)` when cancelled.
pub fn choose_folder(prompt: &str) -> Result<Option<String>, String> {
    if IS_WIN {
        let script = format!("Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{{TopMost=$true}}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '{}'; if ($d.ShowDialog($f) -eq 'OK') {{ $d.SelectedPath }}", prompt.replace('\'', "''"));
        let out = command("powershell.exe").args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", &script]).output().map_err(|e| e.to_string())?;
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok((!p.is_empty()).then_some(p));
    }
    let out = command("osascript").args(["-e", &format!("POSIX path of (choose folder with prompt \"{}\")", prompt.replace('"', "'"))]).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Ok(None); }
    Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// Zips `parent/name` into `out` with `name/` as the top folder.
pub fn zip_dir(parent: &Path, name: &str, out: &Path) -> Result<(), String> {
    let o = if IS_WIN {
        command("tar.exe").arg("-a").arg("-cf").arg(out).arg(name).current_dir(parent).output()
    } else {
        command("/usr/bin/zip").arg("-qr").arg(out).arg(name).current_dir(parent).output()
    }.map_err(|e| e.to_string())?;
    if !o.status.success() { return Err(format!("Không tạo được ZIP: {}", String::from_utf8_lossy(&o.stderr).trim())); }
    Ok(())
}

pub fn unzip(file: &Path, into: &Path) -> Result<(), String> {
    let o = if IS_WIN { command("tar.exe").arg("-xf").arg(file).arg("-C").arg(into).output() }
        else { command("/usr/bin/unzip").arg("-qo").arg(file).arg("-d").arg(into).output() }.map_err(|e| e.to_string())?;
    if !o.status.success() { return Err(format!("Không giải nén được: {}", String::from_utf8_lossy(&o.stderr).trim())); }
    Ok(())
}
