use crate::grid::GridConfig;
use crate::{NoteDoc, NoteMeta, NOTE_FOLDER};
use std::fs;
use std::path::{Path, PathBuf};

pub fn note_dir(vault: &Path) -> PathBuf {
    vault.join(NOTE_FOLDER)
}

/// 回收站目录：必须**不带点前缀**（Obsidian 默认忽略 . 开头的文件夹），
/// 这样删除的便笺仍出现在 Obsidian 文件系统里，可看 tag/双链/连线关系。
/// 旧版本用过 `.trash`（Obsidian 不可见），启动时迁移到 `Trash`。
pub fn trash_dir(vault: &Path) -> PathBuf {
    vault.join("Trash")
}

pub fn grid_file(vault: &Path) -> PathBuf {
    note_dir(vault).join("grid.json")
}

pub fn ensure_layout(vault: &Path) -> std::io::Result<()> {
    fs::create_dir_all(note_dir(vault))?;
    fs::create_dir_all(trash_dir(vault))?;
    // 迁移：旧 .trash 里的便笺文件挪到可见的 Trash/（Obsidian 才能看到）
    let old = vault.join(".trash");
    if old.is_dir() {
        if let Ok(rd) = fs::read_dir(&old) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x == "md").unwrap_or(false) {
                    let name = p.file_name().unwrap_or_default();
                    let dst = trash_dir(vault).join(name);
                    if !dst.exists() {
                        let _ = fs::rename(&p, &dst);
                    }
                }
            }
        }
        // 只剩非 md 文件或空目录才尝试删除（Obsidian 自己的回收站文件不动）
        let leftover: usize = fs::read_dir(&old)
            .map(|rd| rd.flatten().count())
            .unwrap_or(0);
        if leftover == 0 {
            let _ = fs::remove_dir(&old);
        }
    }
    Ok(())
}

pub fn load_grid_config(vault: &Path) -> GridConfig {
    let f = grid_file(vault);
    if let Ok(s) = fs::read_to_string(&f) {
        if let Ok(c) = serde_json::from_str::<GridConfig>(&s) {
            return c;
        }
    }
    let c = GridConfig::default();
    let _ = save_grid_config(vault, &c);
    c
}

pub fn save_grid_config(vault: &Path, c: &GridConfig) -> std::io::Result<()> {
    let s = serde_json::to_string_pretty(c).map_err(|e| std::io::Error::other(e.to_string()))?;
    fs::write(grid_file(vault), s)
}

pub fn list_note_files(vault: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(note_dir(vault)) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "md").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// 解析 "---frontmatter---\nbody"
pub fn parse_note(content: &str) -> Option<(NoteMeta, String)> {
    let rest = content.strip_prefix("---")?;
    let idx = rest.find("\n---")?;
    let yaml = &rest[..idx];
    let body = rest[idx + 4..].trim_start_matches('\n').to_string();
    let meta: NoteMeta = serde_yaml::from_str(yaml).ok()?;
    Some((meta, body))
}

pub fn serialize_note(meta: &NoteMeta, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
    format!("---\n{}---\n{}", yaml, body)
}

pub fn load_note(path: &Path) -> Option<NoteDoc> {
    let content = fs::read_to_string(path).ok()?;
    let (meta, body) = parse_note(&content)?;
    Some(NoteDoc { meta, content: body })
}

/// 写便笺文件（直接写，不用 tmp+rename）
///
/// ⚠️ 曾用 tmp+rename 原子写：Windows 上 rename 替换已存在文件会被 ReadDirectoryChangesW
/// 报告为 Remove+Create 两个事件 → 监听器销毁窗口再重建 → 便笺闪烁甚至消失。
/// 直接写只产生 Modify 事件，配合内容比对即可防回环。
pub fn write_note_file(path: &Path, content: &str) -> std::io::Result<()> {
    fs::write(path, content)
}

pub fn save_note_file(vault: &Path, doc: &NoteDoc) -> std::io::Result<()> {
    let path = note_dir(vault).join(format!("note-{}.md", doc.meta.id));
    write_note_file(&path, &serialize_note(&doc.meta, &doc.content))
}

pub fn trash_note(vault: &Path, id: &str) -> std::io::Result<()> {
    let src = note_dir(vault).join(format!("note-{}.md", id));
    let dst = trash_dir(vault).join(format!("note-{}.md", id));
    fs::rename(&src, &dst)
}
