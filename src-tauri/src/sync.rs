use crate::vault;
use crate::AppState;
use notify::{recommended_watcher, Event, EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static WATCHER: OnceLock<notify::RecommendedWatcher> = OnceLock::new();

/// 监听 <vault>/Obsi_StickeyNoy/*.md，外部（Obsidian）改动实时同步
pub fn start_watcher(app: AppHandle, vault: PathBuf) -> notify::Result<()> {
    let dir = vault::note_dir(&vault);
    if !dir.exists() {
        return Ok(());
    }
    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(ev) = res else {
            return;
        };
        let Some(path) = ev.paths.first() else {
            return;
        };
        // 只处理 .md（跳过原子写的 .tmp 中间态）
        if path.extension().map(|e| e != "md").unwrap_or(true) {
            return;
        }
        match ev.kind {
            EventKind::Create(_) => handle_file(&app, path),
            EventKind::Modify(_) => handle_file(&app, path),
            EventKind::Remove(_) => handle_remove(&app, path),
            _ => {}
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    let _ = WATCHER.set(watcher);
    Ok(())
}

fn handle_file(app: &AppHandle, path: &Path) {
    let Some(doc) = vault::load_note(path) else {
        return;
    };
    let state = app.state::<AppState>();
    let is_new = {
        let mut notes = state.notes.lock().unwrap();
        match notes.get(&doc.meta.id) {
            Some(old) => {
                // 我们自己刚写入的内容，跳过（防回环）
                if old.content == doc.content && old.meta.updated == doc.meta.updated {
                    return;
                }
                notes.insert(doc.meta.id.clone(), doc.clone());
                false
            }
            None => {
                notes.insert(doc.meta.id.clone(), doc.clone());
                true
            }
        }
    };
    crate::log_msg(&format!(
        "watcher: {} {} ({})",
        if is_new { "new" } else { "update" },
        doc.meta.id,
        path.display()
    ));
    if is_new {
        // 一律投递到主线程创建窗口（本线程是 notify 线程，直接创建会死锁）
        crate::create_note_window(app, &doc);
    } else if let Some(win) = state.windows.lock().unwrap().get(&doc.meta.id) {
        let geo = crate::grid_geometry(app, &state, &doc.meta.monitor);
        let _ = crate::windows::apply_meta(win, &doc, &geo);
    }
    let _ = app.emit(
        "note_external_change",
        serde_json::json!({
            "id": doc.meta.id,
            "content": doc.content,
            "updated": doc.meta.updated,
        }),
    );
}

fn handle_remove(app: &AppHandle, path: &Path) {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let id = name.trim_start_matches("note-").trim_end_matches(".md");
    crate::log_msg(&format!("watcher: removed {}", id));
    let state = app.state::<AppState>();
    {
        let mut notes = state.notes.lock().unwrap();
        notes.remove(id);
    }
    let removed = state.windows.lock().unwrap().remove(id);
    if let Some(win) = removed {
        let _ = win.destroy();
    }
}
