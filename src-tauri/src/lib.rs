use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

mod desktop_grid;
mod grid;
mod sync;
mod vault;
mod windows;

pub const NOTE_FOLDER: &str = "Obsi_StickeyNoy";

// ---------- 数据类型 ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteMeta {
    pub id: String,
    /// "note"（普通）| "todo"（任务清单）
    #[serde(rename = "type", default = "default_note_type")]
    pub note_type: String,
    /// 便笺标题（可选；空则不写入 frontmatter，Obsidian 里看历史直观）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub z: i64,
    pub color: String,
    pub pinned: bool,
    pub monitor: String,
    pub created: String,
    pub updated: String,
}

fn default_note_type() -> String {
    "note".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteDoc {
    pub meta: NoteMeta,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub vault_path: Option<PathBuf>,
    /// 便笺卡片底色透明度（0.05~0.95，设置界面可调）
    #[serde(default = "default_note_alpha")]
    pub note_alpha: f64,
    /// 内容区（富文本/预览/TODO 列表）透明度；None = 跟随底色 +0.06（独立可调）
    #[serde(default)]
    pub content_alpha: Option<f64>,
    /// 标题栏透明度；None = 跟随底色 +0.04（独立可调）
    #[serde(default)]
    pub title_alpha: Option<f64>,
    /// 桌面小组件（日历/时钟）开关与状态
    #[serde(default)]
    pub widgets: WidgetsConfig,
}

/// 小组件配置：日历（3×3 图标）/ 时钟（3×2 图标）各自独立
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct WidgetsConfig {
    #[serde(default)]
    pub calendar: WidgetState,
    #[serde(default)]
    pub clock: WidgetState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WidgetState {
    #[serde(default)]
    pub enabled: bool,
    /// 上次拖动后的位置（逻辑像素）；None = 默认右上角
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    /// 样式（背景色/透明度/字体色/纯数字无背景）
    #[serde(default)]
    pub style: WidgetStyle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")] // ⚠️ 前端传 bgAlpha/noBg，必须 camelCase 否则被 serde 丢弃
pub struct WidgetStyle {
    /// 背景色 "#RRGGBB"；None = 默认白
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    /// 背景透明度 0.0~1.0；None = 默认 0.8
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_alpha: Option<f64>,
    /// 数字/文字颜色 "#RRGGBB"；None = 默认深灰
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    /// 仅数字：关闭背景（透过数字看壁纸）
    #[serde(default)]
    pub no_bg: bool,
    /// 数字字体："square"（方正 Bahnschrift，默认）| "round"（圆润）| "mono"（等宽）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
}

impl Default for WidgetStyle {
    fn default() -> Self {
        Self {
            bg: None,
            bg_alpha: None,
            fg: None,
            no_bg: false,
            font: None,
        }
    }
}

impl Default for WidgetState {
    fn default() -> Self {
        Self {
            enabled: false,
            x: None,
            y: None,
            style: WidgetStyle::default(),
        }
    }
}

/// 便笺摘要（日历组件取任务日期用）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub note_type: String,
    pub content: String,
}

/// 三个板块透明度一次下发（设置界面滑块，实时广播）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaConfig {
    pub note_alpha: f64,
    pub content_alpha: Option<f64>,
    pub title_alpha: Option<f64>,
}

fn default_note_alpha() -> f64 {
    0.2
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vault_path: None,
            note_alpha: 0.2,
            content_alpha: None,
            title_alpha: None,
            widgets: WidgetsConfig::default(),
        }
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub grid: Mutex<grid::GridState>,
    pub notes: Mutex<HashMap<String, NoteDoc>>,
    pub windows: Mutex<HashMap<String, WebviewWindow>>,
}

// ---------- 工具 ----------

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

fn app_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("obsistickeynoy"))
}

fn load_app_config(app: &AppHandle) -> AppConfig {
    let f = app_config_path(app).join("config.json");
    if let Ok(s) = std::fs::read_to_string(&f) {
        // 容忍 UTF-8 BOM（某些编辑器/脚本写入）
        let s = s.trim_start_matches('\u{feff}');
        if let Ok(c) = serde_json::from_str::<AppConfig>(s) {
            return c;
        }
    }
    AppConfig::default()
}

fn save_app_config(app: &AppHandle, cfg: &AppConfig) {
    let dir = app_config_path(app);
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(dir.join("config.json"), s);
    }
}

/// 显示器工作区（逻辑像素）+ scale: (x, y, w, h, scale)
fn work_area_logical(mon: &tauri::Monitor) -> (f64, f64, f64, f64, f64) {
    let area = mon.work_area();
    let scale = mon.scale_factor();
    if scale <= 0.0 {
        return (0.0, 0.0, 1920.0, 1080.0, 1.0);
    }
    (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
        scale,
    )
}

/// 主显示器工作区（逻辑像素）+ scale；失败回退默认
fn monitor_work_area_logical(app: &AppHandle) -> (f64, f64, f64, f64, f64) {
    let default = (0.0, 0.0, 1920.0, 1080.0, 1.0);
    let Ok(Some(mon)) = app.primary_monitor() else {
        return default;
    };
    work_area_logical(&mon)
}

/// 显示器标识（B5 多显示器）：优先用设备名，缺省回退 "primary"
fn monitor_name(mon: &tauri::Monitor) -> String {
    mon.name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "primary".to_string())
}

fn monitor_names(app: &AppHandle) -> Vec<String> {
    match app.available_monitors() {
        Ok(ms) => ms.iter().map(monitor_name).collect(),
        Err(_) => vec!["primary".to_string()],
    }
}

/// 按显示器名取工作区（逻辑像素 + scale）；找不到则回退主显示器
fn work_area_for_name(app: &AppHandle, name: &str) -> (f64, f64, f64, f64, f64) {
    if name != "primary" {
        if let Ok(ms) = app.available_monitors() {
            for m in &ms {
                if monitor_name(m) == name {
                    return work_area_logical(m);
                }
            }
        }
    }
    monitor_work_area_logical(app)
}

/// 逻辑坐标 (x,y) 落在哪个显示器（用逻辑工作区包含性判定，不受 DPI 影响）。
/// 不用 tauri 的 monitor_from_point：其返回的 Monitor.name() 常为 None。
fn monitor_name_at(app: &AppHandle, x: f64, y: f64) -> String {
    if let Ok(ms) = app.available_monitors() {
        for m in &ms {
            let (wx, wy, ww, wh, _) = work_area_logical(m);
            if x >= wx && x < wx + ww && y >= wy && y < wy + wh {
                return monitor_name(m);
            }
        }
    }
    log_msg(&format!("monitor_name_at fallback primary at ({:.0},{:.0})", x, y));
    "primary".to_string()
}

pub(crate) fn grid_geometry(
    app: &AppHandle,
    state: &AppState,
    monitor: &str,
) -> grid::GridGeometry {
    let g = state.grid.lock().unwrap();
    let work = work_area_for_name(app, monitor);
    grid::geometry_for(&g.config, g.desktop.as_ref(), work)
}

/// 全部窗口按各自 monitor 的网格重排（显示器布局变化 / grid_resync 时调用）
pub(crate) fn resync_all_windows(app: &AppHandle) {
    let state = app.state::<AppState>();
    let notes = state.notes.lock().unwrap().clone();
    for (id, doc) in &notes {
        let geo = grid_geometry(app, &state, &doc.meta.monitor);
        if let Some(win) = state.windows.lock().unwrap().get(id) {
            let _ = windows::apply_meta(win, doc, &geo);
        }
    }
    log_msg("resync_all_windows done");
}

/// 每 5s 检查显示器布局是否变化，变化则重排所有窗口
fn start_monitor_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = monitor_names(&app);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let now = monitor_names(&app);
            if now != last {
                log_msg(&format!("monitor layout changed: {:?}", now));
                last = now;
                let app2 = app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    resync_all_windows(&app2);
                });
            }
        }
    });
}

// ---------- 日志 ----------

static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

pub(crate) fn init_log(app: &AppHandle) {
    let dir = app_config_path(app);
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let _ = LOG.set(Mutex::new(f));
    }
}

pub(crate) fn log_msg(msg: &str) {
    if let Some(f) = LOG.get() {
        let line = format!("{} {}\n", chrono::Local::now().format("%H:%M:%S%.3f"), msg);
        if let Ok(mut g) = f.lock() {
            let _ = g.write_all(line.as_bytes());
        }
    }
}

/// 所有窗口创建统一走这里：投递到主线程 + 按 label 去重。
/// ⚠️ 不要在其他线程直接调用 windows::create —— notify 线程/命令线程创建 WebView2
/// 窗口会与主线程的创建撞车导致死锁（用户点"新建"后整个应用卡死，根因即此）。
pub(crate) fn create_note_window(app: &AppHandle, doc: &NoteDoc) {
    let app = app.clone();
    let doc = doc.clone();
    let _ = app.clone().run_on_main_thread(move || {
        log_msg(&format!("create_note_window: closure start {}", doc.meta.id));
        let label = windows::label(&doc.meta.id);
        // 去重以 tauri 窗口注册表为准：win.destroy() 后 get_webview_window 返回 None，
        // 而 state.windows 可能残留旧句柄导致误判"已存在"而跳过重建
        if app.get_webview_window(&label).is_some() {
            log_msg(&format!("create_note_window skip (exists): {}", doc.meta.id));
            return;
        }
        let state = app.state::<AppState>();
        let geo = grid_geometry(&app, &state, &doc.meta.monitor);
        log_msg(&format!("create_note_window: creating window {}", doc.meta.id));
        match windows::create(&app, &doc, &geo) {
            Ok(win) => {
                log_msg(&format!("window created: {}", doc.meta.id));
                state.windows.lock().unwrap().insert(doc.meta.id.clone(), win);
                log_msg(&format!("window registered: {}", doc.meta.id));
            }
            Err(e) => {
                log_msg(&format!("window create FAILED {}: {}", doc.meta.id, e));
            }
        }
    });
}

// ---------- 初始化 ----------

fn init_vault(app: &AppHandle, vault: PathBuf) {
    if vault::ensure_layout(&vault).is_err() {
        return;
    }
    let state = app.state::<AppState>();
    {
        let mut g = state.grid.lock().unwrap();
        g.config = vault::load_grid_config(&vault);
        g.desktop = desktop_grid::desktop_grid_from_registry();
        if let Some(d) = &g.desktop {
            log_msg(&format!(
                "desktop grid: pitch_phys=({:.0},{:.0}) icon={:.0}",
                d.pitch_phys_x, d.pitch_phys_y, d.icon_size
            ));
        } else {
            log_msg("desktop grid: NONE (manual fallback)");
        }
    }
    let _ = sync::start_watcher(app.clone(), vault.clone());
    start_monitor_watch(app.clone());
    log_msg(&format!("monitors: {:?}", monitor_names(app)));
    load_all_notes(app, &vault);
}

fn load_all_notes(app: &AppHandle, vault: &PathBuf) {
    let state = app.state::<AppState>();
    let mut docs: Vec<NoteDoc> = vault::list_note_files(vault)
        .iter()
        .filter_map(|p| vault::load_note(p))
        .collect();
    docs.sort_by_key(|d| d.meta.z);
    {
        let mut notes = state.notes.lock().unwrap();
        for d in &docs {
            notes.insert(d.meta.id.clone(), d.clone());
        }
    }
    log_msg(&format!("load_all_notes: {} notes", docs.len()));
    for d in &docs {
        create_note_window(app, d);
    }
}

/// 预创建设置窗口（隐藏）。⚠️ 必须只从 setup 调用——从命令里 build() WebView2 窗口实测会卡死。
fn ensure_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("settings").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("src/settings/index.html".into()),
    )
        .title("ObsiStickeyNoy 设置")
        // 禁用代理（Clash 系统代理会代理掉本地 tauri.localhost → 502 白屏）
        .additional_browser_args("--no-proxy-server")
        .inner_size(520.0, 400.0)
        .visible(false)
        .build()?;
    Ok(())
}

/// 显示设置窗口（只 show/focus，绝不在此创建窗口）
fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

// ---------- 桌面小组件（日历 3×3 图标 / 时钟 3×2 图标，固定大小）----------

/// 组件逻辑尺寸 = cols×rows × 网格逻辑步长（step = pitch_phys/scale）。
/// ⚠️ 必须用逻辑尺寸（同便笺）：set_size(Physical) 会被 Tauri 按窗口 DPI 再换算，release 下放大 ~1.5 倍。
fn widget_logical_size(app: &AppHandle, kind: &str) -> (f64, f64) {
    let (cols, rows) = match kind {
        "calendar" => (3.0, 3.0),
        _ => (3.0, 2.0),
    };
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let st = match kind {
        "clock" => &cfg.widgets.clock,
        _ => &cfg.widgets.calendar,
    };
    // 用保存位置所在显示器（无则主屏）的网格步长
    let mx = st.x.unwrap_or(0.0);
    let my = st.y.unwrap_or(0.0);
    let mon = monitor_name_at(app, mx, my);
    let g = grid_geometry(app, &state, &mon);
    (cols * g.step_x, rows * g.step_y)
}

/// 预创建小组件窗口（隐藏）。⚠️ 同设置窗口铁律：只在 setup 调用，命令里不 build。
fn ensure_widget_window(app: &AppHandle, kind: &str) -> tauri::Result<()> {
    let label = format!("widget_{}", kind);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let (url, title) = match kind {
        "calendar" => ("src/calendar-window/index.html", "日历"),
        _ => ("src/clock-window/index.html", "时钟"),
    };
    let (lw, lh) = widget_logical_size(app, kind);
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        // 禁用代理（Clash 系统代理会代理掉本地 tauri.localhost → 502 白屏）
        .additional_browser_args("--no-proxy-server")
        .inner_size(lw.max(120.0), lh.max(80.0))
        .visible(false)
        .build()?;
    log_msg(&format!("widget window created: {} ({}x{} logical)", label, lw, lh));
    Ok(())
}

/// 显示小组件：锁定固定逻辑尺寸 + 恢复保存位置（屏幕外则默认右上角），只 show 不创建
fn show_widget(app: &AppHandle, kind: &str) {
    let label = format!("widget_{}", kind);
    let Some(win) = app.get_webview_window(&label) else {
        return;
    };
    let (lw, lh) = widget_logical_size(app, kind);
    // 锁定尺寸（min=max）：防止被改大/改小
    let sz = Size::Logical(LogicalSize::new(lw.max(120.0), lh.max(80.0)));
    let _ = win.set_size(sz);
    let _ = win.set_min_size(Some(sz));
    let _ = win.set_max_size(Some(sz));
    // 位置：保存的位置必须在某个显示器工作区内，否则回退默认右上角
    let cfg = app.state::<AppState>().config.lock().unwrap().clone();
    let st = match kind {
        "clock" => &cfg.widgets.clock,
        _ => &cfg.widgets.calendar,
    };
    let on_screen = |x: f64, y: f64| -> bool {
        app.available_monitors()
            .map(|ms| {
                ms.iter().any(|m| {
                    let (wx, wy, ww, wh, _) = work_area_logical(m);
                    x >= wx && x < wx + ww && y >= wy && y < wy + wh
                })
            })
            .unwrap_or(false)
    };
    let mut placed = false;
    if let (Some(x), Some(y)) = (st.x, st.y) {
        if on_screen(x, y) {
            let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
            placed = true;
        } else {
            log_msg(&format!("widget {} saved pos ({},{}) off-screen, reset", label, x, y));
        }
    }
    if !placed {
        if let Ok(Some(mon)) = app.primary_monitor() {
            let wa = mon.work_area();
            let scale = mon.scale_factor().max(0.1);
            let x = (wa.position.x as f64 + wa.size.width as f64) / scale - lw - 40.0;
            let y = wa.position.y as f64 / scale + 40.0;
            let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
        }
    }
    let _ = win.show();
}

/// 开关小组件：只改配置 + show/hide（窗口在 setup 已预创建）
#[tauri::command]
fn widget_toggle(app: AppHandle, kind: String, enabled: bool) -> Result<(), String> {
    let k = if kind == "clock" { "clock" } else { "calendar" };
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().unwrap().clone();
        match k {
            "clock" => cfg.widgets.clock.enabled = enabled,
            _ => cfg.widgets.calendar.enabled = enabled,
        }
        save_app_config(&app, &cfg);
        *state.config.lock().unwrap() = cfg;
    }
    if enabled {
        show_widget(&app, k);
    } else if let Some(w) = app.get_webview_window(&format!("widget_{}", k)) {
        let _ = w.hide();
    }
    log_msg(&format!("widget {} -> {}", k, enabled));
    Ok(())
}

/// 组件窗口逻辑尺寸（inner_size / scale）
fn widget_window_size(app: &AppHandle, kind: &str) -> (f64, f64) {
    if let Some(w) = app.get_webview_window(&format!("widget_{}", kind)) {
        let ph = w.inner_size().unwrap_or_default();
        let sc = w.scale_factor().unwrap_or(1.0);
        return (ph.width as f64 / sc, ph.height as f64 / sc);
    }
    (0.0, 0.0)
}

/// 组件之间斥力：若 (x,y,w,h) 与另一组件重叠，推到最近的非重叠位置（网格吸附后）
fn widget_repel(
    state: &AppState,
    geo: &grid::GridGeometry,
    kind: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> (f64, f64) {
    let other_kind = if kind == "clock" { "calendar" } else { "clock" };
    let cfg = state.config.lock().unwrap();
    let other = match other_kind {
        "clock" => &cfg.widgets.clock,
        _ => &cfg.widgets.calendar,
    };
    let (Some(ox), Some(oy)) = (other.x, other.y) else {
        return (x, y);
    };
    let (ocols, orows) = if other_kind == "clock" { (3.0, 2.0) } else { (3.0, 3.0) };
    let ow = ocols * geo.step_x;
    let oh = orows * geo.step_y;
    // 不重叠 → 不动
    if x >= ox + ow || x + w <= ox || y >= oy + oh || y + h <= oy {
        return (x, y);
    }
    // 重叠 → 四个方向推开，选离原位置最近的
    let candidates = [(ox + ow, y), (ox - w, y), (x, oy + oh), (x, oy - h)];
    candidates
        .iter()
        .map(|(cx, cy)| {
            let (sx, sy) = grid::snap(geo, *cx, *cy, w, h);
            let d = ((sx - x).powi(2) + (sy - y).powi(2)).sqrt();
            (d, sx, sy)
        })
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(_, sx, sy)| (sx, sy))
        .unwrap_or((x, y))
}

/// 拖拽中实时磁吸 + 斥力（与便笺 note_magnet 同逻辑：8px 内吸附到图标网格）
#[tauri::command]
fn widget_magnet(app: AppHandle, kind: String, x: f64, y: f64) -> Result<(), String> {
    let k = if kind == "clock" { "clock" } else { "calendar" };
    let state = app.state::<AppState>();
    let mon_name = monitor_name_at(&app, x, y);
    let geo = grid_geometry(&app, &state, &mon_name);
    let size = widget_window_size(&app, k);
    let (nx, ny) = grid::snap(&geo, x, y, size.0, size.1);
    let dist = ((nx - x).powi(2) + (ny - y).powi(2)).sqrt();
    let (rx, ry) = widget_repel(&state, &geo, k, nx, ny, size.0, size.1);
    if dist < 8.0 || rx != nx || ry != ny {
        if let Some(win) = app.get_webview_window(&format!("widget_{}", k)) {
            let _ = win.set_position(Position::Logical(LogicalPosition::new(rx, ry)));
        }
    }
    Ok(())
}

/// 小组件拖拽结束：按落点显示器重算尺寸（跨屏 DPI/网格不同）+ 吸附 + 斥力 + 记住位置
#[tauri::command]
fn widget_move(app: AppHandle, kind: String, x: f64, y: f64) -> Result<(), String> {
    let k = if kind == "clock" { "clock" } else { "calendar" };
    let state = app.state::<AppState>();
    let mon_name = monitor_name_at(&app, x, y);
    let geo = grid_geometry(&app, &state, &mon_name);
    let size = widget_window_size(&app, k);
    let (nx, ny) = grid::snap(&geo, x, y, size.0, size.1);
    let (nx, ny) = widget_repel(&state, &geo, k, nx, ny, size.0, size.1);
    if let Some(win) = app.get_webview_window(&format!("widget_{}", k)) {
        let _ = win.set_position(Position::Logical(LogicalPosition::new(nx, ny)));
        // 跨屏修复：按落点显示器的网格重算逻辑尺寸并重新锁定
        // （双显示器 DPI 不同（如 150%/100%）时 Windows 会重算窗口，尺寸必须跟随目标屏网格）
        let (cols, rows) = if k == "clock" { (3.0, 2.0) } else { (3.0, 3.0) };
        let sz = Size::Logical(LogicalSize::new(
            (cols * geo.step_x).max(120.0),
            (rows * geo.step_y).max(80.0),
        ));
        let _ = win.set_size(sz);
        let _ = win.set_min_size(Some(sz));
        let _ = win.set_max_size(Some(sz));
    }
    let mut cfg = state.config.lock().unwrap().clone();
    match k {
        "clock" => {
            cfg.widgets.clock.x = Some(nx);
            cfg.widgets.clock.y = Some(ny);
        }
        _ => {
            cfg.widgets.calendar.x = Some(nx);
            cfg.widgets.calendar.y = Some(ny);
        }
    }
    save_app_config(&app, &cfg);
    *state.config.lock().unwrap() = cfg;
    Ok(())
}

/// 设置小组件样式（背景色/透明度/字体色/仅数字），存配置并广播给组件窗口
#[tauri::command]
fn widget_style_set(app: AppHandle, kind: String, style: WidgetStyle) -> Result<(), String> {
    let k = if kind == "clock" { "clock" } else { "calendar" };
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().unwrap().clone();
        match k {
            "clock" => cfg.widgets.clock.style = style.clone(),
            _ => cfg.widgets.calendar.style = style.clone(),
        }
        save_app_config(&app, &cfg);
        *state.config.lock().unwrap() = cfg;
    }
    let _ = app.emit(
        "widget_style_updated",
        serde_json::json!({ "kind": k, "style": style }),
    );
    log_msg(&format!("widget {} style set", k));
    Ok(())
}

/// 全部便笺摘要（日历组件解析任务日期用）
#[tauri::command]
fn notes_all(app: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let state = app.state::<AppState>();
    let notes = state.notes.lock().unwrap();
    Ok(notes
        .values()
        .map(|d| NoteSummary {
            id: d.meta.id.clone(),
            title: d.meta.title.clone(),
            note_type: d.meta.note_type.clone(),
            content: d.content.clone(),
        })
        .collect())
}

// ---------- Commands ----------

#[tauri::command]
fn note_get(app: AppHandle, id: String) -> Result<NoteDoc, String> {
    app.state::<AppState>()
        .notes
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "note not found".into())
}

#[tauri::command]
fn note_save(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let vault = cfg.vault_path.ok_or("vault not configured")?;
    let saved = {
        let mut notes = state.notes.lock().unwrap();
        let doc = notes.get_mut(&id).ok_or("note not found")?;
        doc.content = content;
        doc.meta.updated = now_rfc3339();
        doc.clone()
    };
    vault::save_note_file(&vault, &saved).map_err(|e| e.to_string())
}

fn first_free_cell(state: &AppState) -> (i64, i64) {
    let notes = state.notes.lock().unwrap();
    let occupied: std::collections::HashSet<(i64, i64)> =
        notes.values().map(|d| (d.meta.x, d.meta.y)).collect();
    for row in 0..24i64 {
        for col in 0..32i64 {
            if !occupied.contains(&(col, row)) {
                return (col, row);
            }
        }
    }
    (0, 0)
}

fn next_z(state: &AppState) -> i64 {
    let notes = state.notes.lock().unwrap();
    notes.values().map(|d| d.meta.z).max().unwrap_or(0) + 1
}

/// 新建便笺：只写文件（窗口由文件监听器创建——命令/托盘回调内直接建窗会卡死）。
/// 命令与托盘菜单共用。
pub(crate) fn create_new_note(app: &AppHandle, color: String, note_type: String) -> Result<NoteDoc, String> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let vault = cfg.vault_path.ok_or("vault not configured")?;
    let (cx, cy) = first_free_cell(&state);
    let now = now_rfc3339();
    let id = format!("n_{}", uuid::Uuid::new_v4().simple());
    let doc = NoteDoc {
        meta: NoteMeta {
            id: id.clone(),
            note_type: if note_type == "todo" { "todo".into() } else { "note".into() },
            title: String::new(),
            x: cx,
            y: cy,
            w: 3,
            h: 2,
            z: next_z(&state),
            color,
            pinned: false,
            monitor: "primary".into(),
            created: now.clone(),
            updated: now,
        },
        content: String::new(),
    };
    vault::save_note_file(&vault, &doc).map_err(|e| e.to_string())?;
    log_msg(&format!(
        "note_new: {} type={} saved at ({},{}), window created by watcher",
        id, doc.meta.note_type, cx, cy
    ));
    Ok(doc)
}

/// 显示全部便笺：重新扫描磁盘补漏 + show/重建窗口。命令与托盘菜单共用。
pub(crate) fn show_all_notes(app: &AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    if let Some(vault) = cfg.vault_path {
        for p in vault::list_note_files(&vault) {
            if let Some(doc) = vault::load_note(&p) {
                let mut notes = state.notes.lock().unwrap();
                notes.entry(doc.meta.id.clone()).or_insert(doc);
            }
        }
    }
    let notes = state.notes.lock().unwrap().clone();
    for (id, doc) in &notes {
        let has = {
            let wins = state.windows.lock().unwrap();
            match wins.get(id) {
                Some(w) => {
                    let _ = w.show();
                    true
                }
                None => false,
            }
        };
        if !has {
            create_note_window(app, doc);
        }
    }
    log_msg("show_all_notes done");
}

/// 托盘：右键菜单 新建/显示全部/设置/退出；左键单击 = 显示全部。
/// 退出走 app.exit（优雅关闭，避免孤儿 WebView2 进程）。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    let new_note = MenuItem::with_id(app, "new_note", "新建便笺", true, None::<&str>)?;
    let new_todo = MenuItem::with_id(app, "new_todo", "新建 TODO 便笺", true, None::<&str>)?;
    let show_all = MenuItem::with_id(app, "show_all", "显示全部便笺", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_note, &new_todo, &show_all, &settings, &quit])?;

    let icon = match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(i) => i,
        Err(e) => {
            log_msg(&format!("tray icon load failed: {}", e));
            return Ok(());
        }
    };

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ObsiStickeyNoy 便笺")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_all_notes(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_note" => {
                let _ = create_new_note(app, "yellow".into(), "note".into());
            }
            "new_todo" => {
                let _ = create_new_note(app, "blue".into(), "todo".into());
            }
            "show_all" => show_all_notes(app),
            "settings" => {
                let _ = open_settings(app);
            }
            "quit" => {
                log_msg("tray quit requested");
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    log_msg("tray created");
    Ok(())
}

#[tauri::command]
fn note_new(app: AppHandle, color: Option<String>, note_type: Option<String>) -> Result<NoteDoc, String> {
    log_msg("note_new: ENTER");
    create_new_note(
        &app,
        color.unwrap_or_else(|| "yellow".into()),
        note_type.unwrap_or_else(|| "note".into()),
    )
}

#[tauri::command]
fn note_delete(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let vault = cfg.vault_path.ok_or("vault not configured")?;
    vault::trash_note(&vault, &id).map_err(|e| e.to_string())?;
    state.notes.lock().unwrap().remove(&id);
    if let Some(win) = state.windows.lock().unwrap().remove(&id) {
        let _ = win.destroy();
    }
    Ok(())
}

#[tauri::command]
fn note_close(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(win) = state.windows.lock().unwrap().get(&id) {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
fn note_move(app: AppHandle, id: String, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(win) = state.windows.lock().unwrap().get(&id) {
        let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
    }
    Ok(())
}

#[tauri::command]
fn note_drag_end(app: AppHandle, id: String, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<AppState>();
    // B5 多显示器：按落点所在显示器吸附并更新 monitor 归属
    let mon_name = monitor_name_at(&app, x, y);
    let geo = grid_geometry(&app, &state, &mon_name);
    // 当前窗口尺寸（逻辑像素）
    let size = {
        let wins = state.windows.lock().unwrap();
        match wins.get(&id) {
            Some(w) => {
                let ph = w.inner_size().unwrap_or_default();
                let sc = w.scale_factor().unwrap_or(1.0);
                (ph.width as f64 / sc, ph.height as f64 / sc)
            }
            None => (0.0, 0.0),
        }
    };
    let (nx, ny) = grid::snap(&geo, x, y, size.0, size.1);
    if let Some(win) = state.windows.lock().unwrap().get(&id) {
        let _ = win.set_position(Position::Logical(LogicalPosition::new(nx, ny)));
    }
    // 持久化格坐标 + 显示器归属
    let cfg = state.config.lock().unwrap().clone();
    if let Some(vault) = cfg.vault_path {
        let mut notes = state.notes.lock().unwrap();
        if let Some(doc) = notes.get_mut(&id) {
            let col = ((nx - geo.origin_x - geo.margin) / geo.step_x).round().max(0.0) as i64;
            let row = ((ny - geo.origin_y - geo.margin) / geo.step_y).round().max(0.0) as i64;
            doc.meta.x = col;
            doc.meta.y = row;
            doc.meta.monitor = mon_name.clone();
            doc.meta.updated = now_rfc3339();
            let saved = doc.clone();
            drop(notes);
            let _ = vault::save_note_file(&vault, &saved);
        }
    }
    Ok(())
}

#[tauri::command]
fn note_resize(app: AppHandle, id: String, width: f64, height: f64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mon_name = {
        let notes = state.notes.lock().unwrap();
        notes.get(&id).map(|d| d.meta.monitor.clone()).unwrap_or_else(|| "primary".into())
    };
    let geo = grid_geometry(&app, &state, &mon_name);
    let (cw, ch) = grid::px_to_cells_size(&geo, width, height);
    let (w, h) = grid::cells_to_px_size(&geo, cw, ch);
    if let Some(win) = state.windows.lock().unwrap().get(&id) {
        let _ = win.set_size(Size::Logical(LogicalSize::new(w, h)));
    }
    let cfg = state.config.lock().unwrap().clone();
    if let Some(vault) = cfg.vault_path {
        let mut notes = state.notes.lock().unwrap();
        if let Some(doc) = notes.get_mut(&id) {
            doc.meta.w = cw as i64;
            doc.meta.h = ch as i64;
            doc.meta.updated = now_rfc3339();
            let saved = doc.clone();
            drop(notes);
            let _ = vault::save_note_file(&vault, &saved);
        }
    }
    Ok(())
}

#[tauri::command]
fn note_set_pinned(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(win) = state.windows.lock().unwrap().get(&id) {
        let _ = win.set_always_on_top(pinned);
    }
    let cfg = state.config.lock().unwrap().clone();
    if let Some(vault) = cfg.vault_path {
        let mut notes = state.notes.lock().unwrap();
        if let Some(doc) = notes.get_mut(&id) {
            doc.meta.pinned = pinned;
            doc.meta.updated = now_rfc3339();
            let saved = doc.clone();
            drop(notes);
            let _ = vault::save_note_file(&vault, &saved);
        }
    }
    Ok(())
}

/// S1 实时磁吸：若窗口左上角距最近格点 < 8px，则吸附到格点（拖拽中的磁吸预览）
#[tauri::command]
fn note_magnet(app: AppHandle, id: String, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mon_name = monitor_name_at(&app, x, y);
    let geo = grid_geometry(&app, &state, &mon_name);
    let size = {
        let wins = state.windows.lock().unwrap();
        match wins.get(&id) {
            Some(w) => {
                let ph = w.inner_size().unwrap_or_default();
                let sc = w.scale_factor().unwrap_or(1.0);
                (ph.width as f64 / sc, ph.height as f64 / sc)
            }
            None => (0.0, 0.0),
        }
    };
    let (nx, ny) = grid::snap(&geo, x, y, size.0, size.1);
    let dist = ((nx - x).powi(2) + (ny - y).powi(2)).sqrt();
    if dist < 8.0 {
        if let Some(win) = state.windows.lock().unwrap().get(&id) {
            let _ = win.set_position(Position::Logical(LogicalPosition::new(nx, ny)));
        }
    }
    Ok(())
}

/// S2 换色：更新 frontmatter 的 color 并落盘
#[tauri::command]
fn note_set_color(app: AppHandle, id: String, color: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    if let Some(vault) = cfg.vault_path {
        let mut notes = state.notes.lock().unwrap();
        if let Some(doc) = notes.get_mut(&id) {
            doc.meta.color = color;
            doc.meta.updated = now_rfc3339();
            let saved = doc.clone();
            drop(notes);
            let _ = vault::save_note_file(&vault, &saved);
        }
    }
    Ok(())
}

/// 命名便笺：更新 frontmatter 的 title 并落盘（Obsidian 中可见）
#[tauri::command]
fn note_set_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let vault = cfg.vault_path.ok_or("vault not configured")?;
    let saved = {
        let mut notes = state.notes.lock().unwrap();
        let doc = notes.get_mut(&id).ok_or("note not found")?;
        doc.meta.title = title.trim().to_string();
        doc.meta.updated = now_rfc3339();
        doc.clone()
    };
    vault::save_note_file(&vault, &saved).map_err(|e| e.to_string())
}

#[tauri::command]
fn config_get(app: AppHandle) -> Result<AppConfig, String> {
    Ok(app.state::<AppState>().config.lock().unwrap().clone())
}

/// v2.1.4：设置界面分板块调节透明度（底色/内容区/标题栏），实时广播
#[tauri::command]
fn config_set_alphas(app: AppHandle, alpha: AlphaConfig) -> Result<(), String> {
    let a = alpha.note_alpha.clamp(0.05, 0.95);
    let ca = alpha.content_alpha.map(|x| x.clamp(0.0, 0.95));
    let ta = alpha.title_alpha.map(|x| x.clamp(0.0, 0.95));
    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().unwrap().clone();
    cfg.note_alpha = a;
    cfg.content_alpha = ca;
    cfg.title_alpha = ta;
    save_app_config(&app, &cfg);
    *state.config.lock().unwrap() = cfg;
    let _ = app.emit(
        "config_updated",
        serde_json::json!({ "noteAlpha": a, "contentAlpha": ca, "titleAlpha": ta }),
    );
    log_msg(&format!("alphas set: note={:.2} content={:?} title={:?}", a, ca, ta));
    Ok(())
}

#[tauri::command]
fn config_set_vault(app: AppHandle, path: String) -> Result<(), String> {    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("路径不是有效目录".into());
    }
    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().unwrap().clone();
    cfg.vault_path = Some(p.clone());
    save_app_config(&app, &cfg);
    *state.config.lock().unwrap() = cfg;
    init_vault(&app, p);
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.destroy();
    }
    Ok(())
}

#[tauri::command]
fn grid_get_config(app: AppHandle) -> Result<grid::GridConfig, String> {
    Ok(app.state::<AppState>().grid.lock().unwrap().config.clone())
}

#[tauri::command]
fn grid_resync(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut g = state.grid.lock().unwrap();
        g.desktop = desktop_grid::desktop_grid_from_registry();
    }
    resync_all_windows(&app);
    Ok(())
}

#[tauri::command]
fn notes_show_all(app: AppHandle) -> Result<(), String> {
    show_all_notes(&app);
    Ok(())
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    log_msg("app_quit requested");
    app.exit(0);
}

#[tauri::command]
fn open_settings_cmd(app: AppHandle) -> Result<(), String> {
    open_settings(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn frontend_log(msg: String) {
    log_msg(&format!("[web] {}", msg));
}

// ---------- 入口 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_msg("second instance detected, focusing existing");
            show_all_notes(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(AppConfig::default()),
            grid: Mutex::new(grid::GridState::default()),
            notes: Mutex::new(HashMap::new()),
            windows: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            note_get,
            note_save,
            note_new,
            note_delete,
            note_close,
            note_move,
            note_drag_end,
            note_resize,
            note_set_pinned,
            note_magnet,
            note_set_color,
            note_set_title,
            config_get,
            config_set_vault,
            config_set_alphas,
            grid_get_config,
            grid_resync,
            notes_show_all,
            widget_toggle,
            widget_move,
            widget_magnet,
            widget_style_set,
            notes_all,
            app_quit,
            open_settings_cmd,
            frontend_log
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            init_log(&handle);
            log_msg("=== app start ===");
            let state = app.state::<AppState>();
            let cfg = load_app_config(&handle);
            *state.config.lock().unwrap() = cfg.clone();
            match &cfg.vault_path {
                Some(v) if v.exists() => {
                    init_vault(&handle, v.clone());
                    // 预创建隐藏的设置窗口（避免从命令里创建导致卡死）
                    let _ = ensure_settings_window(&handle);
                    // 预创建小组件窗口（隐藏）；设置里开启才显示
                    let _ = ensure_widget_window(&handle, "calendar");
                    let _ = ensure_widget_window(&handle, "clock");
                    if cfg.widgets.calendar.enabled {
                        show_widget(&handle, "calendar");
                    }
                    if cfg.widgets.clock.enabled {
                        show_widget(&handle, "clock");
                    }
                }
                _ => {
                    let _ = open_settings(&handle);
                }
            }
            let _ = setup_tray(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
