//! The sync / handoff / read-sync actions behind the "Đồng bộ" page (port of
//! `sync()`, `handoff()` and `skill()` in ccgw's bin/ccgw.mjs).
use crate::{gateway, native, settings, sync::*};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::Duration};
use tokio::io::AsyncWriteExt;

type R<T> = Result<T, String>;

fn state_file() -> PathBuf { settings::config_path().with_file_name("sync.json") }

/// Sync state: which claude.ai chats/projects became which gateway sessions/spaces,
/// what was handed off. On first use it continues from the Node ccgw's record.
fn load_state() -> Value {
    let file = state_file();
    if !file.exists() && std::env::var_os("CCGW_RUST_HOME").is_none() {
        if let Some(legacy) = dirs::home_dir().map(|h| h.join(".ccgw/sync.json")).filter(|p| p.exists()) { let _ = fs::copy(legacy, &file); }
    }
    let mut s = read_json(&file, json!({}));
    for k in ["conversations", "projects"] { if !s[k].is_object() { s[k] = json!({}); } }
    s
}
fn save_state(s: &Value) -> R<()> { write_json(&state_file(), s) }

fn desktop3p() -> PathBuf { settings::desktop_dir() }
fn plural(n: usize, word: &str) -> String { format!("{n} {word}") }

#[derive(Serialize)]
pub struct LocalState { pub last_sync: Option<String>, pub last_handoff: Option<String>, pub read_sync: Option<String> }

/// What the page can show without signing in to claude.ai.
pub fn local_state() -> LocalState {
    let s = load_state();
    let get = |k: &str| s[k].as_str().map(String::from);
    LocalState { last_sync: get("lastSync"), last_handoff: get("lastHandoff"), read_sync: get("readSyncAdded") }
}

// ---------------------------------------------------------------- sync: claude.ai → gateway

struct Remote { convs: Vec<Value>, projects: Vec<Value>, tasks: Vec<Value>, tasks_error: Option<String> }

/// Chats, projects and Cowork tasks (in the chat shape, with the raw task under "task").
async fn fetch_remote(api: &ClaudeAi) -> R<Remote> {
    let (convs, projects, tasks) = tokio::join!(api.conversations(), api.projects(), api.cowork_sessions());
    let (tasks, tasks_error) = match tasks { Ok(t) => (t, None), Err(e) => (vec![], Some(e.message)) };
    let tasks = tasks.into_iter().map(|t| json!({"uuid": t["id"], "name": t["title"].as_str().unwrap_or("Cowork task"), "created_at": t["created_at"],
        "updated_at": t["updated_at"].as_str().or(t["created_at"].as_str()), "project_uuid": t["chat_project_id"].as_str().and_then(|p| tagged_uuid("claude_proj", p)), "task": t})).collect();
    Ok(Remote { convs: convs?, projects: projects?, tasks, tasks_error })
}

#[derive(Serialize)]
pub struct SyncGroup { pub id: String, pub name: String, pub chats: usize, pub tasks: usize, pub fresh: usize }

#[derive(Serialize)]
pub struct SyncPlan { pub groups: Vec<SyncGroup>, pub skills: Vec<String>, pub new_skills: usize, pub last_sync: Option<String>, pub notice: Option<String> }

fn in_group<'a>(list: &'a [Value], projects: &[Value], id: &str) -> Vec<&'a Value> {
    list.iter().filter(|c| if id == OUTSIDE {
        c["project_uuid"].as_str().is_none_or(|p| !projects.iter().any(|x| x["uuid"] == p))
    } else { c["project_uuid"] == id }).collect()
}

async fn account_skills(api: &ClaudeAi, store: &Store) -> Vec<Value> {
    let list = match api.skills().await {
        Ok(s) => s,
        Err(_) => official_skills(&official_dir()).into_iter().map(|(n, d)| json!({"name": n, "dir": d.display().to_string()})).collect(),
    };
    list.into_iter().filter(|s| s["name"].as_str().is_some_and(|n| !store.builtin.contains(n))).collect()
}

pub async fn sync_plan() -> R<SyncPlan> {
    let api = ClaudeAi::official().await?;
    let store = gateway_store(&desktop3p())?;
    let remote = fetch_remote(&api).await?;
    let state = load_state();
    let fresh = |list: &[&Value]| list.iter().filter(|c| state["conversations"][c["uuid"].as_str().unwrap_or("")]["updatedAt"] != c["updated_at"]).count();
    let mut groups: Vec<SyncGroup> = remote.projects.iter().map(|p| {
        let id = p["uuid"].as_str().unwrap_or("");
        let (c, t) = (in_group(&remote.convs, &remote.projects, id), in_group(&remote.tasks, &remote.projects, id));
        SyncGroup { id: id.into(), name: p["name"].as_str().unwrap_or("Project").into(), chats: c.len(), tasks: t.len(), fresh: fresh(&c) + fresh(&t) }
    }).collect();
    let (c, t) = (in_group(&remote.convs, &remote.projects, OUTSIDE), in_group(&remote.tasks, &remote.projects, OUTSIDE));
    groups.push(SyncGroup { id: OUTSIDE.into(), name: "Chats ngoài project".into(), chats: c.len(), tasks: t.len(), fresh: fresh(&c) + fresh(&t) });
    let skills = account_skills(&api, &store).await;
    let have = installed_skills(&store);
    let names: Vec<String> = skills.iter().filter_map(|s| s["name"].as_str().map(String::from)).collect();
    let new_skills = names.iter().filter(|n| !have.contains(*n)).count();
    Ok(SyncPlan { groups, skills: names, new_skills, last_sync: state["lastSync"].as_str().map(String::from), notice: remote.tasks_error.map(|e| format!("Không đọc được Cowork task: {e}")) })
}

#[derive(Serialize, Default)]
pub struct SyncReport { pub added: usize, pub updated: usize, pub kept: usize, pub spaces: usize, pub skills: usize, pub failed_tasks: usize, pub restarted: bool, pub message: String }

pub async fn sync_run(picked: Vec<String>) -> R<SyncReport> {
    if picked.is_empty() { return Err("Chọn ít nhất một mục để sync.".into()); }
    let api = ClaudeAi::official().await?;
    let store = gateway_store(&desktop3p())?;
    let remote = fetch_remote(&api).await?;
    let mut state = load_state();

    // Everything is fetched first, so the gateway Desktop is closed only for the write.
    let mut spaces: Vec<(Value, Vec<Value>)> = Vec::new();
    for p in remote.projects.iter().filter(|p| picked.iter().any(|x| p["uuid"] == x.as_str())) {
        let id = p["uuid"].as_str().unwrap_or("");
        let mut full = p.clone();
        if let Ok(detail) = api.project(id).await { if let (Some(a), Some(b)) = (full.as_object_mut(), detail.as_object()) { for (k, v) in b { a.insert(k.clone(), v.clone()); } } }
        spaces.push((full, api.docs(id).await.unwrap_or_default()));
    }
    let mut chosen: Vec<&Value> = Vec::new();
    for id in &picked {
        if id == SKILLS { continue; }
        if id != OUTSIDE && !remote.projects.iter().any(|p| p["uuid"] == id.as_str()) { continue; }
        chosen.extend(in_group(&remote.convs, &remote.projects, id));
        chosen.extend(in_group(&remote.tasks, &remote.projects, id));
    }
    let changed: Vec<&Value> = chosen.into_iter().filter(|c| {
        let rec = &state["conversations"][c["uuid"].as_str().unwrap_or("")];
        !(rec.is_object() && session_exists(&store, rec) && rec["updatedAt"] == c["updated_at"])
    }).collect();
    let task_dirs = if changed.iter().any(|c| c["task"].is_object()) { official_task_folders(&official_dir()) } else { HashMap::new() };
    let mut todo: Vec<(Value, Vec<String>)> = Vec::new();
    let mut report = SyncReport::default();
    for c in &changed {
        let id = c["uuid"].as_str().unwrap_or("");
        if !c["task"].is_object() { todo.push((api.conversation(id).await?, vec![])); continue; }
        match api.cowork_events(id).await {
            Ok(events) => {
                let conv = cowork_conversation(&c["task"], &events);
                if conv["chat_messages"].as_array().is_some_and(|m| !m.is_empty()) {
                    let key = id.trim_start_matches("session_").trim_start_matches("cse_");
                    todo.push((conv, task_dirs.get(key).cloned().unwrap_or_default()));
                }
            }
            Err(_) => report.failed_tasks += 1,
        }
    }

    // Skills arrive as .skill zips, unpacked next to each other.
    let skill_tmp = std::env::temp_dir().join(format!("ccgw-skills-{}", uuid::Uuid::new_v4().simple()));
    let mut skill_dirs: Vec<(String, PathBuf)> = Vec::new();
    if picked.iter().any(|p| p == SKILLS) {
        let skills = account_skills(&api, &store).await;
        fs::create_dir_all(&skill_tmp).map_err(|e| e.to_string())?;
        for sk in &skills {
            if let Some(dir) = sk["dir"].as_str() { let _ = native_copy(Path::new(dir), &skill_tmp.join(sk["name"].as_str().unwrap_or("skill"))); }
            else if let Some(id) = sk["id"].as_str() { if let Ok(zip) = api.download_skill(id).await { let _ = unzip_skill(&zip, &skill_tmp); } }
        }
        skill_dirs = fs::read_dir(&skill_tmp).map(|r| r.filter_map(Result::ok).filter(|e| e.path().join("SKILL.md").exists())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect()).unwrap_or_default();
    }

    if todo.is_empty() && spaces.is_empty() && skill_dirs.is_empty() {
        state["lastSync"] = json!(now_iso());
        save_state(&state)?;
        let _ = fs::remove_dir_all(&skill_tmp);
        report.message = "Đã đồng bộ, không có gì mới trên claude.ai.".into();
        return Ok(report);
    }

    // Desktop rewrites its project list while running: close it for the write.
    let restart = native::quit_desktop(false).unwrap_or(false);
    report.restarted = restart;
    let write = (|| -> R<()> {
        let mut made: HashMap<String, Space> = HashMap::new();
        for (project, docs) in &spaces {
            let uuid = project["uuid"].as_str().unwrap_or("").to_string();
            let s = write_space(&store, project, docs, state["projects"][&uuid].as_str())?;
            state["projects"][&uuid] = json!(s.id);
            made.insert(uuid, s);
            report.spaces += 1;
        }
        for (conv, folders) in &todo {
            let uuid = conv["uuid"].as_str().unwrap_or("").to_string();
            let prev = state["conversations"][&uuid].clone();
            let mut sid = None;
            if prev.is_object() && session_exists(&store, &prev) {
                if session_untouched(&store, &prev) {
                    remove_session(&store, prev["session"].as_str().unwrap_or(""));
                    sid = prev["session"].as_str().map(|s| s.trim_start_matches("local_").to_string());
                    report.updated += 1;
                } else { report.kept += 1; } // continued in the gateway: copied again alongside
            } else { report.added += 1; }
            let space = conv["project_uuid"].as_str().and_then(|p| made.get(p));
            let mut rec = write_session(&store, conv, sid, space, folders)?;
            if !folders.is_empty() || conv["uuid"].as_str().is_some_and(|u| u.starts_with("session_")) { rec["kind"] = json!("cowork"); }
            state["conversations"][&uuid] = rec;
        }
        if !skill_dirs.is_empty() { install_skills(&store, &skill_dirs, env!("CARGO_PKG_VERSION"))?; report.skills = skill_dirs.len(); }
        state["lastSync"] = json!(now_iso());
        save_state(&state)
    })();
    if restart { let _ = native::open_desktop(false); }
    let _ = fs::remove_dir_all(&skill_tmp);
    write?;
    let parts: Vec<String> = [
        (report.added > 0).then(|| format!("thêm {}", plural(report.added, "chat"))),
        (report.updated > 0).then(|| format!("cập nhật {}", report.updated)),
        (report.kept > 0).then(|| format!("{} chat đã làm tiếp trong gateway được chép thêm bản mới", report.kept)),
        (report.spaces > 0).then(|| plural(report.spaces, "project")),
        (report.skills > 0).then(|| plural(report.skills, "skill")),
        (report.failed_tasks > 0).then(|| format!("{} Cowork task chưa đọc được, sync lại để thử tiếp", report.failed_tasks)),
    ].into_iter().flatten().collect();
    report.message = format!("Đã sync từ claude.ai: {}.", if parts.is_empty() { "đã làm mới project".into() } else { parts.join(", ") });
    Ok(report)
}

fn native_copy(from: &Path, to: &Path) -> R<()> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in fs::read_dir(from).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        if e.path().is_dir() { native_copy(&e.path(), &to.join(e.file_name()))?; } else { fs::copy(e.path(), to.join(e.file_name())).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

// ---------------------------------------------------------------- handoff: gateway → claude.ai

fn same_name(a: &str, b: &str) -> bool {
    let norm = |x: &str| x.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    norm(a) == norm(b)
}

fn instructions_of(space: &Value) -> String {
    space["folders"].as_array().cloned().unwrap_or_default().iter()
        .find_map(|f| f["path"].as_str().and_then(|p| fs::read_to_string(Path::new(p).join("Project instructions.md")).ok())).unwrap_or_default()
}

/// Where a gateway chat goes on claude.ai: an existing project id, or a project to find or create by key/name.
#[derive(Clone)]
enum Target { Id(String, String), Key { key: String, name: String, instructions: String } }
impl Target { fn name(&self) -> &str { match self { Target::Id(_, n) | Target::Key { name: n, .. } => n } } }

struct Item { s: GSession, from: Option<(String, Value)>, conv: Option<Value>, target: Target, pending: bool }

fn handoff_items(store: &Store, state: &Value, remote_projects: &[Value], convs: &HashMap<String, Value>) -> Vec<Item> {
    let copied: HashMap<String, (String, Value)> = state["conversations"].as_object().cloned().unwrap_or_default().into_iter()
        .filter_map(|(conv, rec)| Some((rec["session"].as_str()?.to_string(), (conv, rec)))).collect();
    let spaces = gateway_spaces(store);
    let origin: HashMap<String, String> = state["projects"].as_object().cloned().unwrap_or_default().into_iter().filter_map(|(remote, space)| Some((space.as_str()?.to_string(), remote))).collect();
    let remote_name = |id: &str| remote_projects.iter().find(|p| p["uuid"] == id).and_then(|p| p["name"].as_str()).map(String::from);
    let done = &state["handoff"];
    gateway_sessions(store).into_iter().filter_map(|s| {
        let from = copied.get(&s.session).cloned();
        if from.as_ref().is_some_and(|(_, rec)| session_untouched(store, rec)) { return None; } // claude.ai already has it all
        let conv = from.as_ref().and_then(|(c, _)| convs.get(c)).cloned();
        let sp = s.space_id.as_ref().and_then(|id| spaces.iter().find(|x| x["id"] == id.as_str()));
        let target = match conv.as_ref().and_then(|c| c["project_uuid"].as_str()).and_then(|p| remote_name(p).map(|n| (p.to_string(), n))) {
            Some((id, name)) => Target::Id(id, name),
            None => match sp {
                Some(sp) => {
                    let key = sp["id"].as_str().unwrap_or("").to_string();
                    let name = origin.get(&key).and_then(|r| remote_name(r)).or_else(|| state["toOfficial"]["projects"][&key].as_str().and_then(remote_name)).unwrap_or_else(|| sp["name"].as_str().unwrap_or("Project").into());
                    Target::Key { key, name, instructions: instructions_of(sp) }
                }
                None => Target::Key { key: OUTSIDE.into(), name: state["toOfficial"]["projects"][OUTSIDE].as_str().and_then(remote_name).unwrap_or_else(|| GATEWAY_CHATS.into()), instructions: String::new() },
            },
        };
        let pending = done[&s.session]["size"].as_u64() != Some(s.size);
        Some(Item { s, from, conv, target, pending })
    }).collect()
}

#[derive(Serialize)]
pub struct HandoffEntry { pub session: String, pub title: String, pub continued: bool, pub target: String, pub new_project: bool, pub pending: bool, pub last_activity_at: i64 }

#[derive(Serialize)]
pub struct HandoffPlan { pub items: Vec<HandoffEntry>, pub skills: Vec<String>, pub last_handoff: Option<String>, pub read_sync: Option<String> }

pub async fn handoff_plan() -> R<HandoffPlan> {
    let store = gateway_store(&desktop3p())?;
    let api = ClaudeAi::official().await?;
    let (projects, convs) = tokio::join!(api.projects(), api.conversations());
    let (projects, convs) = (projects?, convs?);
    let convs: HashMap<String, Value> = convs.into_iter().filter_map(|c| Some((c["uuid"].as_str()?.to_string(), c))).collect();
    let state = load_state();
    let out_skills: Vec<String> = state["toOfficial"]["skills"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).collect();
    let items = handoff_items(&store, &state, &projects, &convs).into_iter().map(|it| HandoffEntry {
        new_project: matches!(&it.target, Target::Key { name, .. } if !projects.iter().any(|p| same_name(p["name"].as_str().unwrap_or(""), name))),
        session: it.s.session.clone(), title: it.s.title.clone(), continued: it.from.is_some(), target: it.target.name().into(), pending: it.pending, last_activity_at: it.s.last_activity_at,
    }).collect();
    Ok(HandoffPlan {
        items, skills: gateway_user_skills(&store).into_iter().map(|s| s.0).filter(|n| !out_skills.contains(n)).collect(),
        last_handoff: state["lastHandoff"].as_str().map(String::from), read_sync: state["readSyncAdded"].as_str().map(String::from),
    })
}

/// The handoff note, by the same Claude Code login: no tools, no settings, its own system prompt, a fixed empty dir.
async fn write_brief(system: &str, user: &str, model: &str) -> R<String> {
    let dir = settings::config_path().with_file_name("handoff");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let claude = std::env::var("CCGW_HANDOFF_CLAUDE").unwrap_or_else(|_| gateway::claude_executable(&settings::load().map(|c| c.claude_path).unwrap_or_default()));
    let mut child = crate::platform::tokio_command(claude)
        .args(["-p", "--model", model, "--output-format", "text", "--system-prompt", system, "--tools=", "--setting-sources=", "--strict-mcp-config", "--no-session-persistence"])
        .env_remove("CLAUDECODE").current_dir(&dir)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .kill_on_drop(true).spawn().map_err(|e| format!("Không chạy được Claude Code: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let user = user.to_string();
    tokio::spawn(async move { let _ = stdin.write_all(user.as_bytes()).await; });
    let out = tokio::time::timeout(Duration::from_secs(300), child.wait_with_output()).await
        .map_err(|_| "Claude Code viết ghi chú quá 5 phút".to_string())?.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || text.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().last().map(String::from).filter(|s| !s.is_empty()).unwrap_or(if text.is_empty() { format!("claude thoát với mã {}", out.status) } else { text }));
    }
    Ok(text)
}

#[derive(Serialize)]
pub struct HandoffResult { pub title: String, pub project_id: String, pub project_name: String, pub doc_name: String, pub brief: bool, pub starter: String }

#[derive(Serialize, Default)]
pub struct HandoffReport { pub results: Vec<HandoffResult>, pub skills_added: usize, pub errors: Vec<String>, pub read_sync: bool }

pub async fn handoff_run(sessions: Vec<String>, skills: bool, model: String, brief: bool) -> R<HandoffReport> {
    if sessions.is_empty() && !skills { return Err("Chọn ít nhất một chat hoặc skills để hand off.".into()); }
    let model = if model.trim().is_empty() { "sonnet".to_string() } else { model };
    let store = gateway_store(&desktop3p())?;
    let api = ClaudeAi::official().await?;
    let (projects, convs) = tokio::join!(api.projects(), api.conversations());
    let (mut projects, convs) = (projects?, convs?);
    let convs: HashMap<String, Value> = convs.into_iter().filter_map(|c| Some((c["uuid"].as_str()?.to_string(), c))).collect();
    let mut state = load_state();
    for k in ["handoff"] { if !state[k].is_object() { state[k] = json!({}); } }
    if !state["toOfficial"].is_object() { state["toOfficial"] = json!({"projects": {}, "chats": {}, "skills": []}); }
    if !state["toOfficial"]["projects"].is_object() { state["toOfficial"]["projects"] = json!({}); }
    if !state["toOfficial"]["skills"].is_array() { state["toOfficial"]["skills"] = json!([]); }
    let items = handoff_items(&store, &state, &projects, &convs);
    let mut report = HandoffReport { read_sync: state["readSyncAdded"].is_string(), ..Default::default() };
    let origin: HashMap<String, String> = state["projects"].as_object().cloned().unwrap_or_default().into_iter().filter_map(|(r, s)| Some((s.as_str()?.to_string(), r))).collect();

    let mut notes: Vec<String> = Vec::new();
    for it in items.into_iter().filter(|it| sessions.contains(&it.s.session)) {
        let s = &it.s;
        let step = async {
            // Copies made before leaf records end at their last claude.ai answer, plus an unanswered question.
            let last_human = match &it.from { Some((conv, rec)) if rec["leaf"].is_null() => api.conversation(conv).await.ok().and_then(|c| unanswered_question(&c)), _ => None };
            let turns = read_turns(s);
            let (before, after) = if it.from.is_some() || turns.iter().any(|x| x.claude_ai) { continued_turns(&turns, it.from.as_ref().map(|f| &f.1), last_human.as_deref()) } else { (vec![], turns.clone()) };
            if after.is_empty() { notes.push(format!("{}: không có gì mới sau phần từ claude.ai, bỏ qua", s.title)); return Ok::<Option<HandoffResult>, String>(None); }
            let facts = handoff_facts(s, &after);
            let note = if brief {
                let (sys, user) = brief_prompt(&s.title, &before, &after, &facts);
                match write_brief(&sys, &user, &model).await { Ok(n) => Some(n), Err(e) => { notes.push(format!("Không viết được ghi chú cho \"{}\": {e} (vẫn gửi transcript)", s.title)); None } }
            } else { None };
            let project = match &it.target {
                Target::Id(id, _) => id.clone(),
                Target::Key { key, name, instructions } => {
                    let exists = |id: &str| projects.iter().any(|p| p["uuid"] == id);
                    if let Some(id) = origin.get(key).filter(|id| exists(id)) { id.clone() }
                    else if let Some(id) = state["toOfficial"]["projects"][key].as_str().filter(|id| exists(id)) { id.to_string() }
                    else if let Some(p) = projects.iter().find(|p| same_name(p["name"].as_str().unwrap_or(""), name)) {
                        let id = p["uuid"].as_str().unwrap_or("").to_string();
                        state["toOfficial"]["projects"][key] = json!(id);
                        id
                    } else {
                        let p = api.create_project(name, "From the gateway Claude Desktop (Claude Code), copied by CCGW Desktop.").await.map_err(String::from)?;
                        let id = p["uuid"].as_str().unwrap_or("").to_string();
                        if !instructions.is_empty() { let _ = api.set_instructions(&id, instructions).await; }
                        state["toOfficial"]["projects"][key] = json!(id);
                        projects.push(p);
                        id
                    }
                }
            };
            let name = handoff_doc_name(s);
            // The new note goes in before old ones go, so a failed upload leaves the last note in place.
            let doc = api.add_doc(&project, &name, &handoff_doc(s, it.conv.as_ref(), &after, &facts, note.as_deref(), &model)).await.map_err(String::from)?;
            let doc_id = doc["uuid"].as_str().unwrap_or("").to_string();
            let tag = format!("({}).md", &s.session[6..14.min(s.session.len())]);
            let mut stale: Vec<(String, String)> = api.docs(&project).await.unwrap_or_default().iter()
                .filter(|d| d["uuid"] != doc_id.as_str() && d["file_name"].as_str().is_some_and(|f| f.starts_with("Handoff - ") && f.ends_with(&tag)))
                .filter_map(|d| Some((project.clone(), d["uuid"].as_str()?.to_string()))).collect();
            let prev = &state["handoff"][&s.session];
            if let (Some(pd), Some(pp)) = (prev["doc"].as_str(), prev["project"].as_str()) { if pd != doc_id && !stale.iter().any(|(_, d)| d == pd) { stale.push((pp.into(), pd.into())); } }
            for (pid, id) in stale { let _ = api.delete_doc(&pid, &id).await; }
            state["handoff"][&s.session] = json!({"project": project, "doc": doc_id, "size": s.size, "at": now_iso()});
            save_state(&state)?;
            let vi = looks_vietnamese(&turns);
            let starter = if vi { format!("Đọc file \"{name}\" trong knowledge của project này (phần mình đã làm tiếp bên Claude Code), rồi làm tiếp từ bước tiếp theo ghi trong đó.") }
                else { format!("Read \"{name}\" in this project's knowledge (what I did in Claude Code after this project's chat), then carry on from the next step it names.") };
            let project_name = projects.iter().find(|p| p["uuid"] == project.as_str()).and_then(|p| p["name"].as_str()).unwrap_or(it.target.name()).to_string();
            Ok(Some(HandoffResult { title: s.title.clone(), project_id: project, project_name, doc_name: name, brief: note.is_some(), starter }))
        };
        match step.await {
            Ok(Some(r)) => report.results.push(r),
            Ok(None) => {}
            Err(e) => report.errors.push(format!("{}: {e}", s.title)),
        }
        report.errors.append(&mut notes);
    }

    if skills {
        let done: Vec<String> = state["toOfficial"]["skills"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).collect();
        for (name, dir) in gateway_user_skills(&store).into_iter().filter(|s| !done.contains(&s.0)) {
            match zip_skill(&dir, &name) {
                Ok(zip) => match api.upload_skill(&name, zip, false).await {
                    Ok(r) => { state["toOfficial"]["skills"].as_array_mut().unwrap().push(json!(name)); if r == "added" { report.skills_added += 1; } else { report.errors.push(format!("Skill \"{name}\" đã có trên tài khoản, giữ nguyên.")); } }
                    Err(e) => report.errors.push(format!("Skill {name}: {}", e.message)),
                },
                Err(e) => report.errors.push(format!("Skill {name}: {e}")),
            }
        }
    }
    if !report.results.is_empty() || skills { state["lastHandoff"] = json!(now_iso()); }
    save_state(&state)?;
    Ok(report)
}

// ---------------------------------------------------------------- skills on the claude.ai account (Official)

#[derive(Serialize)]
pub struct AccountSkill { pub name: String, pub description: String, pub source: String }

/// The account's skills; the official Desktop's local copy when claude.ai cannot be read.
pub async fn official_skill_list() -> R<(Vec<AccountSkill>, Option<String>)> {
    let remote = match ClaudeAi::official().await { Ok(api) => api.skills().await.map_err(|e| e.message), Err(e) => Err(e) };
    match remote {
        Ok(list) => {
            let mut out: Vec<AccountSkill> = list.into_iter().filter_map(|s| Some(AccountSkill {
                name: s["name"].as_str()?.to_string(),
                description: s["description"].as_str().unwrap_or("").to_string(),
                source: match s["creator_type"].as_str() { Some("user") => "Bạn tạo", Some(_) => "Có sẵn", None => "" }.into(),
            })).collect();
            out.sort_by(|a, b| a.name.cmp(&b.name));
            Ok((out, None))
        }
        Err(e) => {
            let local = official_skills(&official_dir());
            if local.is_empty() { return Err(e); }
            let mut out: Vec<AccountSkill> = local.into_iter().map(|(name, dir)| AccountSkill {
                description: crate::skills::inspect_folder(dir.display().to_string()).map(|i| i.description).unwrap_or_default(), name, source: "Bản trên máy".into(),
            }).collect();
            out.sort_by(|a, b| a.name.cmp(&b.name));
            Ok((out, Some(format!("Không đọc được claude.ai ({e}); đang hiện bản Desktop lưu trên máy."))))
        }
    }
}

/// Uploads a skill folder to the claude.ai account. "exists" when a skill of that name is there and `overwrite` is off.
pub async fn install_official_skill(path: String, overwrite: bool) -> R<String> {
    let info = crate::skills::inspect_folder(path.clone())?;
    let zip = zip_skill(Path::new(&path), &info.name)?;
    let api = ClaudeAi::official().await?;
    match api.upload_skill(&info.name, zip, overwrite).await.map_err(String::from)? {
        "exists" => Ok("exists".into()),
        _ => Ok(format!("Đã cài {} lên tài khoản claude.ai. Cửa sổ Official nhận skill sau khi tải lại (mở lại cửa sổ nếu chưa thấy).", info.name)),
    }
}

// ---------------------------------------------------------------- read-sync skill

/// Uploads the bundled read-sync skill to the claude.ai account (replacing an older copy).
pub async fn add_read_sync() -> R<String> {
    let api = ClaudeAi::official().await?;
    let dir = std::env::temp_dir().join(format!("ccgw-read-sync-{}", uuid::Uuid::new_v4().simple())).join("read-sync");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("SKILL.md"), READ_SYNC_SKILL).map_err(|e| e.to_string())?;
    let zip = zip_skill(&dir, "read-sync");
    let _ = fs::remove_dir_all(dir.parent().unwrap());
    api.upload_skill("read-sync", zip?, true).await.map_err(String::from)?;
    let mut state = load_state();
    state["readSyncAdded"] = json!(now_iso());
    save_state(&state)?;
    Ok("Đã thêm skill read-sync vào tài khoản claude.ai. Trong project đã nhận handoff, mở chat mới và gõ: read sync".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, http::{Method, Uri}, response::IntoResponse};
    use std::sync::{Arc, Mutex};

    type Calls = Arc<Mutex<Vec<(String, String, String)>>>;

    /// A claude.ai stand-in: the endpoints sync, handoff and skill upload use.
    async fn mock(calls: Calls, skill_zip: Vec<u8>) -> String {
        let docs: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![json!({"uuid": "d1", "file_name": "notes.md", "content": "Bring a jacket"})]));
        let app = axum::Router::new().fallback(move |method: Method, uri: Uri, body: Bytes| {
            let calls = calls.clone();
            let docs = docs.clone();
            let skill_zip = skill_zip.clone();
            async move {
                let path = uri.path().to_string();
                let q = uri.query().unwrap_or("").to_string();
                calls.lock().unwrap().push((method.to_string(), format!("{path}?{q}"), String::from_utf8_lossy(&body).chars().take(4000).collect()));
                let o = "/api/organizations/org1";
                let v = match (method.as_str(), path.as_str()) {
                    ("GET", p) if p == format!("{o}/chat_conversations") => json!([
                        {"uuid": "c1", "name": "Plan trip", "project_uuid": "p1", "updated_at": "2026-10-01T11:00:00Z"},
                        {"uuid": "c2", "name": "Loose chat", "project_uuid": null, "updated_at": "2026-10-02T11:00:00Z"}]),
                    ("GET", p) if p.starts_with(&format!("{o}/chat_conversations/")) => {
                        let id = p.rsplit('/').next().unwrap();
                        json!({"uuid": id, "name": if id == "c1" { "Plan trip" } else { "Loose chat" }, "project_uuid": if id == "c1" { json!("p1") } else { Value::Null },
                            "created_at": "2026-10-01T10:00:00Z", "updated_at": if id == "c1" { "2026-10-01T11:00:00Z" } else { "2026-10-02T11:00:00Z" }, "current_leaf_message_uuid": format!("{id}-m2"), "chat_messages": [
                            {"uuid": format!("{id}-m1"), "sender": "human", "created_at": "2026-10-01T10:00:00Z", "content": [{"type": "text", "text": "Đi Đà Lạt 3 ngày?"}], "parent_message_uuid": null},
                            {"uuid": format!("{id}-m2"), "sender": "assistant", "created_at": "2026-10-01T10:00:05Z", "content": [{"type": "text", "text": "Ngày 1: chợ đêm"}], "parent_message_uuid": format!("{id}-m1")}]})
                    }
                    ("GET", "/v1/code/sessions") => json!({"data": [{"id": "session_01task", "title": "Cloud task", "tags": ["cowork-remote"], "created_at": "2026-10-03T00:00:00Z", "updated_at": "2026-10-03T01:00:00Z"}]}),
                    ("GET", "/v1/code/sessions/session_01task/events") => json!({"data": [
                        {"payload": {"type": "user", "uuid": "tu1", "message": {"content": "summarise /notes"}}, "created_at": "2026-10-03T00:00:00Z"},
                        {"payload": {"type": "assistant", "uuid": "ta1", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/notes"}}, {"type": "text", "text": "Done"}]}}, "created_at": "2026-10-03T00:00:09Z"}]}),
                    ("GET", p) if p == format!("{o}/projects") => json!([{"uuid": "p1", "name": "Travel"}]),
                    ("GET", p) if p == format!("{o}/projects/p1") => json!({"uuid": "p1", "name": "Travel", "prompt_template": "Be practical"}),
                    ("GET", p) if p == format!("{o}/projects/p1/docs") => json!(docs.lock().unwrap().clone()),
                    ("POST", p) if p == format!("{o}/projects/p1/docs") => {
                        let b: Value = serde_json::from_slice(&body).unwrap();
                        let id = format!("d{}", docs.lock().unwrap().len() + 1);
                        docs.lock().unwrap().push(json!({"uuid": id, "file_name": b["file_name"], "content": b["content"]}));
                        json!({"uuid": id})
                    }
                    ("DELETE", p) if p.starts_with(&format!("{o}/projects/p1/docs/")) => { let id = p.rsplit('/').next().unwrap().to_string(); docs.lock().unwrap().retain(|d| d["uuid"] != id.as_str()); Value::Null }
                    ("GET", p) if p == format!("{o}/skills/list-skills") => json!({"skills": [{"id": "sk1", "name": "mine"}, {"id": "sk2", "name": "docx"}]}),
                    ("GET", p) if p == format!("{o}/skills/download-dot-skill-file") => return skill_zip.into_response(),
                    ("POST", p) if p == format!("{o}/skills/upload-skill") => json!({"ok": true}),
                    _ => return (axum::http::StatusCode::NOT_FOUND, axum::Json(json!({"error": {"message": format!("no mock for {method} {path}")}}))).into_response(),
                };
                axum::Json(v).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        url
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_then_continue_then_hand_off_then_read_sync() {
        let _env = settings::TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("ccgw-flow-{}", uuid::Uuid::new_v4()));
        let desk = root.join("desk");
        let account = "11111111-2222-3333-4444-555555555555";
        fs::create_dir_all(desk.join("local-agent-mode-sessions/skills-plugin").join(GATEWAY_ORG).join(account).join("skills/docx")).unwrap();
        fs::create_dir_all(desk.join("local-agent-mode-sessions").join(&account[..8]).join(&GATEWAY_ORG[..8])).unwrap();
        fs::write(desk.join("claude_desktop_config.json"), json!({"coworkUserFilesPath": root.join("files").display().to_string()}).to_string()).unwrap();
        std::env::set_var("CCGW_RUST_HOME", root.join("home"));
        std::env::set_var("CCGW_DESKTOP_DIR", &desk);
        std::env::set_var("CCGW_SAFE_STORAGE_PASSWORD", "pw");
        // The official Desktop's cookie jar, sealed like Electron does.
        let official = desk.join("official/Claude-Official/Network");
        fs::create_dir_all(&official).unwrap();
        let seal = |s: &str| { let mut p = vec![7u8; 32]; p.extend(s.as_bytes()); encrypt(&p, &official).unwrap() };
        let db = rusqlite::Connection::open(official.join("Cookies")).unwrap();
        db.execute_batch("create table cookies(host_key text, name text, encrypted_value blob);").unwrap();
        for (n, v) in [("sessionKey", "sk-ant-sid-test"), ("lastActiveOrg", "org1")] { db.execute("insert into cookies values('.claude.ai', ?1, ?2)", rusqlite::params![n, seal(v)]).unwrap(); }
        drop(db);
        // A fake `claude` for the handoff note.
        #[cfg(unix)] let fake = {
            let f = root.join("claude.sh");
            fs::write(&f, "#!/bin/sh\ncat > /dev/null\nprintf '### Mục tiêu\\nĐi Đà Lạt 4 ngày\\n'\n").unwrap();
            use std::os::unix::fs::PermissionsExt; fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
            f
        };
        #[cfg(windows)] let fake = {
            let f = root.join("claude.cmd");
            fs::write(&f, "@echo off\r\nmore > nul\r\necho ### Muc tieu\r\necho Đi Đà Lạt 4 ngày\r\n").unwrap();
            f
        };
        std::env::set_var("CCGW_HANDOFF_CLAUDE", &fake);
        let skill_src = root.join("skillsrc/mine");
        fs::create_dir_all(&skill_src).unwrap();
        fs::write(skill_src.join("SKILL.md"), "---\nname: mine\n---\n").unwrap();
        let calls: Calls = Default::default();
        std::env::set_var("CCGW_CLAUDE_AI_URL", mock(calls.clone(), zip_skill(&skill_src, "mine").unwrap()).await);
        std::env::set_var("CCGW_CLAUDE_AI_URL_SET", "1");

        // 1. plan: one project chat, one loose chat + a cloud task, one skill the gateway lacks
        let plan = sync_plan().await.unwrap();
        let travel = plan.groups.iter().find(|g| g.id == "p1").unwrap();
        assert_eq!((travel.chats, travel.fresh), (1, 1));
        let outside = plan.groups.iter().find(|g| g.id == OUTSIDE).unwrap();
        assert_eq!((outside.chats, outside.tasks), (1, 1));
        assert_eq!(plan.skills, vec!["mine"]);

        // 2. sync everything, then again: nothing new
        let r = sync_run(vec!["p1".into(), OUTSIDE.into(), SKILLS.into()]).await.unwrap();
        assert_eq!((r.added, r.spaces, r.skills, r.failed_tasks), (3, 1, 1, 0), "{}", r.message);
        let store = gateway_store(&desk).unwrap();
        assert_eq!(gateway_sessions(&store).len(), 3);
        assert!(installed_skills(&store).contains("mine"));
        let r = sync_run(vec![OUTSIDE.into()]).await.unwrap();
        assert_eq!(r.added + r.updated, 0, "{}", r.message);

        // 3. nothing continued yet: nothing to hand off
        assert!(handoff_plan().await.unwrap().items.is_empty());

        // 4. continue "Plan trip" in the gateway
        let state = load_state();
        let rec = state["conversations"]["c1"].clone();
        let s = gateway_sessions(&store).into_iter().find(|s| s.session == rec["session"].as_str().unwrap()).unwrap();
        let tf = s.dir.join(".claude/projects/session").join(format!("{}.jsonl", s.cli));
        let mut t = fs::read_to_string(&tf).unwrap();
        t.push_str(&json!({"type": "user", "uuid": "u9", "timestamp": "2026-10-04T09:00:00Z", "message": {"role": "user", "content": "Thêm ngày 4"}}).to_string());
        t.push_str("\n");
        t.push_str(&json!({"type": "assistant", "uuid": "a9", "timestamp": "2026-10-04T09:00:09Z", "message": {"id": "msg_x", "content": [{"type": "text", "text": "Ngày 4: hồ Tuyền Lâm"}]}}).to_string());
        fs::write(&tf, t).unwrap();
        fs::OpenOptions::new().append(true).open(s.dir.join("audit.jsonl")).map(|mut f| { use std::io::Write; writeln!(f, "{{}}").unwrap(); }).unwrap();

        // 5. it is offered for handoff, to its own claude.ai project
        let plan = handoff_plan().await.unwrap();
        assert_eq!(plan.items.len(), 1);
        let item = &plan.items[0];
        assert!(item.continued && item.pending && !item.new_project && item.target == "Travel");

        // 6. hand off: the note goes into the project's knowledge; a second handoff replaces it
        // Windows cannot hand a multi-line system prompt to a .cmd stand-in for claude.
        let brief = cfg!(unix);
        let r = handoff_run(vec![item.session.clone()], false, "sonnet".into(), brief).await.unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.results.len(), 1);
        assert!(r.results[0].brief == brief && r.results[0].starter.starts_with("Đọc file \"Handoff - Plan trip"));
        let posted = calls.lock().unwrap().iter().filter(|c| c.0 == "POST" && c.1.contains("/projects/p1/docs")).count();
        assert_eq!(posted, 1);
        let body = calls.lock().unwrap().iter().rev().find(|c| c.0 == "POST" && c.1.contains("/docs")).unwrap().2.clone();
        assert!((!brief || body.contains("Đi Đà Lạt 4 ngày")) && body.contains("Thêm ngày 4") && !body.contains("Ngày 1: chợ đêm\\n\\n## You"));
        fs::OpenOptions::new().append(true).open(s.dir.join("audit.jsonl")).map(|mut f| { use std::io::Write; writeln!(f, "{{}}").unwrap(); }).unwrap();
        handoff_run(vec![item.session.clone()], false, "sonnet".into(), false).await.unwrap();
        assert!(calls.lock().unwrap().iter().any(|c| c.0 == "DELETE"));
        assert!(load_state()["lastHandoff"].is_string());

        // 7. read-sync goes to the account (overwrite), and is remembered
        let msg = add_read_sync().await.unwrap();
        assert!(msg.contains("read sync"));
        assert!(calls.lock().unwrap().iter().any(|c| c.0 == "POST" && c.1.contains("upload-skill?overwrite=true&check_skill_name=read-sync")));
        assert!(handoff_plan().await.unwrap().read_sync.is_some());

        // 8. Official skills: list from the account, upload a folder
        let (list, notice) = official_skill_list().await.unwrap();
        assert!(notice.is_none());
        assert_eq!(list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["docx", "mine"]);
        let msg = install_official_skill(skill_src.display().to_string(), false).await.unwrap();
        assert!(msg.starts_with("Đã cài mine"), "{msg}");
        assert!(calls.lock().unwrap().iter().any(|c| c.0 == "POST" && c.1.contains("upload-skill?overwrite=false&check_skill_name=mine")));

        for k in ["CCGW_RUST_HOME", "CCGW_DESKTOP_DIR", "CCGW_SAFE_STORAGE_PASSWORD", "CCGW_HANDOFF_CLAUDE", "CCGW_CLAUDE_AI_URL", "CCGW_CLAUDE_AI_URL_SET"] { std::env::remove_var(k); }
        let _ = fs::remove_dir_all(root);
    }
}
