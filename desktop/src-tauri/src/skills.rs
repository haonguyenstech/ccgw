use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, process::Command};

#[derive(Serialize)]
pub struct SkillInfo { pub name: String, pub description: String, pub path: String }

fn skills_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CCGW_SKILLS_DIR") { return PathBuf::from(path); }
    dirs::home_dir().unwrap_or_default().join(".claude/skills")
}
fn inspect(path: &Path) -> Result<SkillInfo, String> {
    if !path.is_dir() { return Err("Hãy chọn một thư mục skill.".into()); }
    let name = path.file_name().and_then(|s| s.to_str()).ok_or("Tên thư mục không hợp lệ")?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Tên thư mục skill chỉ dùng chữ, số, dấu - hoặc _.".into());
    }
    let content = fs::read_to_string(path.join("SKILL.md")).map_err(|_| "Thư mục cần có file SKILL.md.".to_string())?;
    if content.trim().is_empty() { return Err("SKILL.md đang trống.".into()); }
    let description = frontmatter_description(&content);
    Ok(SkillInfo { name: name.into(), description, path: path.to_string_lossy().into_owned() })
}
/// `description:` from the SKILL.md frontmatter, including YAML block scalars (`>` / `|`).
fn frontmatter_description(content: &str) -> String {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") { return String::new(); }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let Some(i) = body.iter().position(|l| l.starts_with("description:")) else { return String::new() };
    let value = body[i]["description:".len()..].trim();
    if value.is_empty() || value.starts_with('>') || value.starts_with('|') {
        let folded = !value.starts_with('|');
        let block: Vec<&str> = body[i + 1..].iter().take_while(|l| l.is_empty() || l.starts_with(' ') || l.starts_with('\t')).map(|l| l.trim()).collect();
        return block.join(if folded { " " } else { "\n" }).trim().to_string();
    }
    value.trim_matches('"').trim_matches('\'').to_string()
}

pub fn choose_folder() -> Result<String, String> {
    let output = Command::new("osascript").args(["-e", "POSIX path of (choose folder with prompt \"Chọn thư mục skill\")"]).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("Đã hủy chọn thư mục.".into()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    inspect(Path::new(&path))?;
    Ok(path)
}
pub fn inspect_folder(path: String) -> Result<SkillInfo, String> { inspect(Path::new(&path)) }
fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let dest = target.join(entry.file_name());
        if kind.is_symlink() { return Err("Skill chứa liên kết tượng trưng; hãy dùng thư mục chứa file thật.".into()); }
        if kind.is_dir() { copy_tree(&entry.path(), &dest)?; }
        else if kind.is_file() { fs::copy(entry.path(), dest).map_err(|e| e.to_string())?; }
    }
    Ok(())
}
pub fn install_gateway(path: String) -> Result<String, String> {
    let source = PathBuf::from(path);
    let info = inspect(&source)?;
    let root = skills_dir();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let target = root.join(&info.name);
    if target.exists() && source.canonicalize().ok() == target.canonicalize().ok() { return Ok(format!("Skill {} đã được cài.", info.name)); }
    if target.exists() { return Err(format!("Skill {} đã tồn tại. Hãy xóa hoặc đổi tên trước khi cài.", info.name)); }
    let staging = root.join(format!(".{}.{}.tmp", info.name, std::process::id()));
    if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    if let Err(error) = copy_tree(&source, &staging) { let _ = fs::remove_dir_all(&staging); return Err(error); }
    fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    Ok(format!("Đã cài {} cho Gateway.", info.name))
}
pub fn list_gateway() -> Vec<SkillInfo> {
    let Ok(entries) = fs::read_dir(skills_dir()) else { return vec![] };
    let mut result: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| inspect(&entry.path()).ok()).collect();
    result.sort_by(|a,b| a.name.cmp(&b.name));
    result
}
pub fn prepare_official(path: String) -> Result<String, String> {
    let source = PathBuf::from(path);
    let info = inspect(&source)?;
    let export_dir = crate::settings::config_path().with_file_name("skill-exports");
    fs::create_dir_all(&export_dir).map_err(|e| e.to_string())?;
    let target = export_dir.join(format!("{}.zip", info.name));
    let temp = export_dir.join(format!("{}.{}.tmp.zip", info.name, std::process::id()));
    let output = Command::new("ditto").args(["-c", "-k", "--keepParent", "--norsrc", "--noextattr"])
        .arg(&source).arg(&temp).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(format!("Không tạo được ZIP: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    let _ = Command::new("open").arg("-R").arg(&target).status();
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_and_copies_skill_assets() {
        let root = std::env::temp_dir().join(format!("ccgw-skill-{}", uuid::Uuid::new_v4()));
        let source = root.join("demo-skill");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("SKILL.md"), "---\ndescription: Demo skill\n---\nInstructions").unwrap();
        fs::write(source.join("scripts/run.sh"), "echo ready").unwrap();
        assert_eq!(inspect(&source).unwrap().description, "Demo skill");
        assert_eq!(frontmatter_description("---\nname: x\ndescription: >\n  Line one\n  line two\nother: 1\n---\nbody"), "Line one line two");
        assert_eq!(frontmatter_description("---\ndescription: \"Quoted\"\n---\n"), "Quoted");
        assert_eq!(frontmatter_description("no frontmatter\ndescription: nope"), "");
        let target = root.join("installed");
        copy_tree(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("scripts/run.sh")).unwrap(), "echo ready");
        fs::remove_dir_all(root).unwrap();
    }
}
