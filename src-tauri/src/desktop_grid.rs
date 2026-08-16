use crate::grid::DesktopGrid;
use std::ffi::c_void;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, ICONMETRICSW, SPI_GETICONMETRICS,
};

/// 读取桌面图标网格（安全方案：注册表 IconSize + 系统 SPI_GETICONMETRICS，
/// 不向 Explorer 发送任何窗口消息）。
///
/// ⚠️ 历史：曾用 SysListView32 + `LVM_GETITEMPOSITION`（带进程内指针）校准桌面图标位置。
/// 实测该指针消息在 **Explorer 进程上下文** 执行，指针无效 → comctl32.dll 访问违例
/// → Explorer 崩溃重启（Windows 11 26100 必现）。**已弃用**。
///
/// 取值来源（Bags\1\Desktop）：
/// - `IconSize`：图标尺寸（REG_DWORD，本机实测 48）
/// - 间距：无 IconSpacing 值 → 用 `SPI_GETICONMETRICS`（系统标准 API）取 iHorzSpacing/iVertSpacing
///
/// 网格原点偏移 = (间距 - 图标尺寸) / 2（桌面列表视图第一个图标的 padding 近似）
const BAGS_DESKTOP: &str = r"Software\Microsoft\Windows\Shell\Bags\1\Desktop";

/// 注册表 IconSize（默认 48）
fn read_icon_size() -> u32 {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(BAGS_DESKTOP) {
        if let Ok(v) = key.get_value::<u32, _>("IconSize") {
            if v >= 16 && v <= 256 {
                return v;
            }
        }
    }
    48
}

/// SPI_GETICONMETRICS 取图标网格间距（水平/垂直单元格尺寸）
fn read_icon_metrics() -> Option<(i32, i32)> {
    unsafe {
        let mut m: ICONMETRICSW = std::mem::zeroed();
        m.cbSize = std::mem::size_of::<ICONMETRICSW>() as u32;
        let ok = SystemParametersInfoW(
            SPI_GETICONMETRICS,
            m.cbSize,
            Some(&mut m as *mut ICONMETRICSW as *mut c_void),
            windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        if ok.is_ok() && m.iHorzSpacing > 0 && m.iVertSpacing > 0 {
            return Some((m.iHorzSpacing, m.iVertSpacing));
        }
    }
    None
}

/// 组装 DesktopGrid：间距（物理像素）优先 ICONMETRICS，兜底 (iconSize + 27)*scale 估算；
/// 逻辑 pitch 与原点偏移在 geometry_for 中按显示器 scale 计算。
pub fn desktop_grid_from_registry() -> Option<DesktopGrid> {
    let icon = read_icon_size() as f64;
    let (pitch_x, pitch_y) = read_icon_metrics()
        .map(|(a, b)| (a as f64, b as f64))
        .unwrap_or_else(|| {
            let p = (icon + 27.0) * 1.5; // 默认 150% 估算物理值
            (p, p)
        });
    Some(DesktopGrid {
        pitch_phys_x: pitch_x.max(16.0),
        pitch_phys_y: pitch_y.max(16.0),
        icon_size: icon,
    })
}
