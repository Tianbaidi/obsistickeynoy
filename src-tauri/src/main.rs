#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ⚠️ 关键：Clash 等代理工具的"系统代理"会把本应用的本地页面（tauri.localhost）也代理出去，
    // WebView2 因此返回 502"无法访问此页面"（全部窗口白屏）。
    // 本应用只加载本地资源，禁用代理完全安全。必须在 WebView2 环境创建前设置。
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--no-proxy-server");
    obsistickeynoy_lib::run();
}
