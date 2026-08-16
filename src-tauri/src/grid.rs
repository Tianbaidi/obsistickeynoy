use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GridConfig {
    pub version: u32,
    /// "auto-desktop" = 同步桌面图标网格 | "manual" = 自定义参数
    pub source: String,
    pub cell_width: f64,
    pub cell_height: f64,
    pub gap: f64,
    pub margin: f64,
}

impl Default for GridConfig {
    fn default() -> Self {
        Self {
            version: 1,
            source: "auto-desktop".into(),
            cell_width: 180.0,
            cell_height: 160.0,
            gap: 12.0,
            margin: 16.0,
        }
    }
}

/// 桌面图标网格（从 SysListView32 校准或注册表推算）
#[derive(Clone, Debug)]
pub struct DesktopGrid {
    /// 图标网格间距（**物理像素**，来自 SPI_GETICONMETRICS；逻辑值按显示器 scale 换算）
    pub pitch_phys_x: f64,
    pub pitch_phys_y: f64,
    /// 图标尺寸（逻辑像素，注册表 IconSize，默认 48）
    pub icon_size: f64,
}

#[derive(Clone, Debug)]
pub struct GridState {
    pub config: GridConfig,
    pub desktop: Option<DesktopGrid>,
}

impl Default for GridState {
    fn default() -> Self {
        Self {
            config: GridConfig::default(),
            desktop: None,
        }
    }
}

/// 解析后的几何参数（逻辑像素坐标系）
#[derive(Clone, Debug)]
#[allow(dead_code)] // work_x/work_y 留给多显示器（v0.2）使用
pub struct GridGeometry {
    pub origin_x: f64,
    pub origin_y: f64,
    pub step_x: f64,
    pub step_y: f64,
    pub cell_w: f64,
    pub cell_h: f64,
    pub margin: f64,
    pub work_x: f64,
    pub work_y: f64,
    pub work_w: f64,
    pub work_h: f64,
}

pub fn geometry_for(
    config: &GridConfig,
    desktop: Option<&DesktopGrid>,
    work: (f64, f64, f64, f64, f64),
) -> GridGeometry {
    let (wx, wy, ww, wh, scale) = work;
    match (config.source.as_str(), desktop) {
        // auto-desktop：物理 pitch → 按显示器 scale 转逻辑；原点 = 工作区左上角 + 图标 padding
        ("auto-desktop", Some(d)) => {
            let sc = if scale > 0.0 { scale } else { 1.0 };
            let pitch_x = (d.pitch_phys_x / sc).max(16.0);
            let pitch_y = (d.pitch_phys_y / sc).max(16.0);
            let off_x = ((pitch_x - d.icon_size) / 2.0).max(0.0);
            let off_y = ((pitch_y - d.icon_size) / 2.0).max(0.0);
            GridGeometry {
                origin_x: wx + off_x,
                origin_y: wy + off_y,
                step_x: pitch_x,
                step_y: pitch_y,
                cell_w: pitch_x,
                cell_h: pitch_y,
                margin: 0.0,
                work_x: wx,
                work_y: wy,
                work_w: ww,
                work_h: wh,
            }
        }
        _ => GridGeometry {
            origin_x: wx,
            origin_y: wy,
            step_x: config.cell_width + config.gap,
            step_y: config.cell_height + config.gap,
            cell_w: config.cell_width,
            cell_h: config.cell_height,
            margin: config.margin,
            work_x: wx,
            work_y: wy,
            work_w: ww,
            work_h: wh,
        },
    }
}

/// 格坐标 → 左上角像素（逻辑坐标）
pub fn cell_to_px(g: &GridGeometry, col: f64, row: f64) -> (f64, f64) {
    (
        g.origin_x + g.margin + col * g.step_x,
        g.origin_y + g.margin + row * g.step_y,
    )
}

/// 格宽高 → 像素宽高
pub fn cells_to_px_size(g: &GridGeometry, w: f64, h: f64) -> (f64, f64) {
    let gw = g.step_x - g.cell_w; // gap
    let gh = g.step_y - g.cell_h;
    (
        w * g.cell_w + (w - 1.0) * gw,
        h * g.cell_h + (h - 1.0) * gh,
    )
}

/// 像素宽高 → 格宽高（四舍五入到最近格）
pub fn px_to_cells_size(g: &GridGeometry, w: f64, h: f64) -> (f64, f64) {
    let gw = g.step_x - g.cell_w;
    let gh = g.step_y - g.cell_h;
    (
        ((w + gw) / g.step_x).round().max(1.0),
        ((h + gh) / g.step_y).round().max(1.0),
    )
}

/// 吸附：把窗口左上角 (x, y) 吸附到最近格点，并限制在工作区内
pub fn snap(g: &GridGeometry, x: f64, y: f64, w_px: f64, h_px: f64) -> (f64, f64) {
    let rx = x - g.origin_x;
    let ry = y - g.origin_y;
    let mut col = ((rx - g.margin) / g.step_x).round().max(0.0);
    let mut row = ((ry - g.margin) / g.step_y).round().max(0.0);

    let max_col = ((g.work_w - g.margin - w_px) / g.step_x).floor();
    let max_row = ((g.work_h - g.margin - h_px) / g.step_y).floor();
    if max_col >= 0.0 {
        col = col.min(max_col);
    }
    if max_row >= 0.0 {
        row = row.min(max_row);
    }

    (
        g.origin_x + g.margin + col * g.step_x,
        g.origin_y + g.margin + row * g.step_y,
    )
}
