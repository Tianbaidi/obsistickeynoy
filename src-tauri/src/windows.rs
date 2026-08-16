use crate::grid::{self, GridGeometry};
use crate::NoteDoc;
use tauri::{
    LogicalPosition, LogicalSize, Position, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

// ════════════════════════════════════════════════════════════════════
// 窗口创建铁律（v2 P4 架构收敛，根因见 DESIGN §13 P4）：
//   1. 所有窗口创建只经本模块（windows::create 等统一入口）；
//   2. 只允许在两类上下文创建窗口：
//        a) setup 启动阶段（如设置窗口预创建、load_all_notes）
//        b) 事件回调（notify 监听线程 → run_on_main_thread 投递到主线程）
//   3. 禁止在 Command（IPC 命令）内直接 build() 窗口。
// 背景：实测"命令内建窗卡死"的元凶是孤儿 WebView2 进程（强杀应用残留、占 WebView2
// 单例浏览器进程锁）导致新建窗口初始化阻塞；优雅退出 + 单实例 + 上述规则共同根治。
// ════════════════════════════════════════════════════════════════════

pub fn label(id: &str) -> String {
    format!("note_{}", id)
}

/// 按便笺元数据创建一个便笺窗口
pub fn create(app: &tauri::AppHandle, doc: &NoteDoc, g: &GridGeometry) -> tauri::Result<WebviewWindow> {
    let (x, y) = grid::cell_to_px(g, doc.meta.x as f64, doc.meta.y as f64);
    let (w, h) = grid::cells_to_px_size(g, doc.meta.w as f64, doc.meta.h as f64);
    let win = WebviewWindowBuilder::new(
        app,
        label(&doc.meta.id),
        WebviewUrl::App("src/note-window/index.html".into()),
    )
        .title("便笺")
        .decorations(false)
        // ⚠️ 禁用代理：Clash 系统代理会把本地 tauri.localhost 代理出去 → 502 白屏
        .additional_browser_args("--no-proxy-server")
        // 透明窗口（WS_EX_LAYERED）：WebView2 真透明 + 卡片低透明度 = 半透明纸片。
        // 注：Win11 24H2 上 DWM acrylic 与 WebView2 透明互斥（不透明窗口→webview
        // 渲染成黑色；透明窗口→DWM 后景不渲染），故采用透明显式方案。
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(doc.meta.pinned)
        .position(x, y)
        .inner_size(w.max(120.0), h.max(80.0))
        .build()?;
    Ok(win)
}
/// 把元数据（位置/尺寸/置顶）应用到已有窗口
pub fn apply_meta(win: &WebviewWindow, doc: &NoteDoc, g: &GridGeometry) -> tauri::Result<()> {
    let (x, y) = grid::cell_to_px(g, doc.meta.x as f64, doc.meta.y as f64);
    let (w, h) = grid::cells_to_px_size(g, doc.meta.w as f64, doc.meta.h as f64);
    win.set_position(Position::Logical(LogicalPosition::new(x, y)))?;
    win.set_size(Size::Logical(LogicalSize::new(w.max(120.0), h.max(80.0))))?;
    win.set_always_on_top(doc.meta.pinned)?;
    Ok(())
}
