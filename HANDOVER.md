# ObsiStickeyNoy — 开发交接文档（Handover）

> 用途：开新对话继续开发时，把这份文档 + DESIGN.md 一起喂给新 AI，即可完整接手。
> 最后更新：2026-08-18（v0.2.0 已发布：人性化双链 + 图片嵌入渲染）

---

## 1. 项目是什么

**Windows 桌面便笺应用**（独立应用，非 Obsidian 插件），数据以 Markdown 文件存于 Obsidian 库，桌面窗口对齐桌面图标网格。

- 技术栈：**Tauri v2.11.5 + Rust + WebView2**（Win11 24H2，150%+100% 双屏），原生 TS + Vite 多页面
- 每个便笺 = 一个透明小窗口（共用 WebView2 进程树，内存优先）
- 数据 = Markdown：`Obsi_StickeyNoy/note-<id>.md`，frontmatter 存 `x/y/w/h/z/color/pinned/monitor/created/updated/type/title`
- 网格：格坐标存储，auto-desktop 模式用注册表 IconSize + SPI_GETICONMETRICS（物理 pitch / scale → 逻辑）

## 2. 环境与路径

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\yyzzc\obsi-stickey-noy\` |
| Obsidian 库 | `D:\Obsidian vault\Stickey\Stickey_background\`（便笺目录 `Obsi_StickeyNoy/`） |
| 应用配置 | `C:\Users\yyzzc\AppData\Roaming\com.obsistickeynoy.app\config.json`（vaultPath、noteAlpha/contentAlpha/titleAlpha、widgets） |
| 日志 | 同目录 `app.log` |
| GitHub | https://github.com/Tianbaidi/obsistickeynoy （public，MIT License，v0.1.0 已发布） |
| gh CLI | `C:\Program Files\GitHub CLI\gh.exe`（**不在 PATH**，用全路径调用） |
| 双显示器 | **主屏 = 右侧 2560×1600 @150%**；副屏 = 左侧 2560×1440 @100% |

## 3. 构建与运行

```bash
# 前端构建（tsc + vite 多页面）
npm run build

# 开发运行：debug 版依赖 vite dev server（见 §6 铁律 2）
npm run dev            # 终端 1：起 vite（localhost:1420）
# 终端 2：运行 src-tauri/target/debug/obsistickeynoy.exe

# 正式版（推荐日常用）：内嵌资源、无控制台窗口、不依赖 dev server
cargo build --release  # src-tauri/ 下
# 运行 src-tauri/target/release/obsistickeynoy.exe

# 打包 NSIS 安装程序（含 beforeBuildCommand）
npx tauri build        # 产物：src-tauri/target/release/bundle/nsis/ObsiStickeyNoy_<ver>_x64-setup.exe
```

**重要**：`cargo build` 后若前端有改动，必须 `touch src-tauri/src/lib.rs` 再 cargo（Tauri 的 `generate_context!` 在编译期嵌入 dist，cargo 不追踪 dist 变化）。

## 4. 代码结构

```
src-tauri/src/
├─ lib.rs             # 入口 + 全部 Commands + AppConfig/NoteMeta/WidgetState
├─ windows.rs         # 便笺窗口创建（铁律注释在此）
├─ grid.rs            # GridGeometry、snap、cell↔px 换算
├─ desktop_grid.rs    # 注册表/SPI 读图标 pitch
├─ vault.rs           # 便笺文件读写、frontmatter 序列化、Trash
└─ sync.rs            # notify 文件监听 → 创建/更新窗口
src/
├─ note-window/       # 便笺窗口（三模式：rich/todo/preview）
├─ settings/          # 设置窗口（库路径、透明度三滑块、组件开关+样式）
├─ calendar-window/   # 日历组件（3×3 主屏图标，Pixel 风格）
├─ clock-window/      # 时钟组件（3×2 主屏图标，At a Glance 风格）
└─ lib/
   ├─ rich-editor.ts     # Milkdown 富文本（懒加载）
   ├─ markdown-render.ts # 预览渲染（katex/mermaid 懒加载）
   ├─ todo-view.ts       # TODO 交互列表 + markdown 助手函数
   └─ todo-planner.ts    # 规划面板（🛫开始/📅结束/优先级）
DESIGN.md             # 完整设计文档（含所有踩坑）
HANDOVER.md           # 本文档
```

## 5. 已交付功能（v2.1）

- **便笺**：拖拽（实时磁吸 8px + 松手吸附网格）、按格缩放、置顶、换色（右键菜单）、命名（标题栏点击，存 frontmatter `title`）、富文本 Milkdown ⇄ 预览（单按钮轮替，✏️/👁 合并）
- **TODO 便笺**（`type: todo`）：纯交互（无 markdown 编辑、隐藏 ✏️/👁）——点文字行内编辑、复选框打勾、日期 chip（白底）弹规划面板（🛫 计划开始 / 📅 计划结束 / 🔺⏫🔼🔽 优先级）、＋添加（自动进入编辑）、悬停 × 删除；任务文字自动换行
- **双链连接（v2.2，人性化）**：每张便笺**左下角 🔗 按钮** → 弹出链接面板——① 列出当前所有便笺（标题或 `note-<id>`），点击插入 `[[note-<id>|标题]]`；② "选择其他文件…" 弹系统文件选择器（可访问硬盘任意文件），选中后**复制进库内 `Obsi_StickeyNoy/assets/`**（已在库内则不复制），图片插入 `![[文件名]]`、其他文件插入 `[[文件名]]`；Obsidian 里按文件名全库解析可见
- **图片嵌入渲染（v2.2）**：预览（👁）里 `![[图片]]` 渲染为 `<img>`，**随便笺宽度自动缩放**（`max-width:100%`，便笺拉大/缩小图片跟着变），点击图片放大到原始尺寸（再点还原）；支持 `![[img|300]]` 指定宽度；assets 里找不到自动回退库根目录
- **wikilink 跳转（v2.2）**：预览里点击 `[[note-<id>|标题]]` 会**显示/聚焦目标便笺窗口**（`note_show` 命令）；富文本编辑器里 `[[...]]`/`![[...]]` 以源码文本显示（与公式同策略：编辑器源码、预览渲染）
- **桌面组件**：日历（3×3 图标，月历 + 任务日期打点 + 点击切"大字日期"形态）、时钟（3×2 图标，Pixel At a Glance）；设置里可配：背景色/背景透明度/字体色/数字字体（方正 Bahnschrift/圆润/等宽）/仅数字无背景；组件间斥力
- **透明度**：三个独立滑块（便笺底色 / 内容区 / 标题栏），`config_set_alphas` 实时广播
- **回收站**：删除移入 `Trash/`（**不带点前缀**，Obsidian 可见，可看 tag/双链/连线）；启动自动迁移旧 `.trash`
- **托盘**：新建便笺/新建 TODO/显示全部/设置/退出；单实例；开机自启
- **发布**：NSIS 安装包 + GitHub Actions（推 `v*` 标签自动构建 Release 草稿）

## 6. 铁律与踩坑（必读！）

1. **窗口创建铁律**：只允许在 setup 或事件回调（`run_on_main_thread` 投递）里 `build()` 窗口，**绝不在 Command 内 build()**——否则孤儿 WebView2 进程占单例锁导致新建窗口卡死。窗口创建统一走 `windows.rs` / `ensure_settings_window` / `ensure_widget_window`。
2. **debug 版依赖 devUrl**：`tauri.conf.json` 有 `devUrl: http://localhost:1420`，debug 构建的窗口一律加载 vite dev 服务器，**dev 服务器一停 → 全部窗口"无法访问此页面"白屏**（曾误判为代理/WebView2 问题）。日常用 **release 版**（Cargo.toml 已显式开启 tauri 的 `custom-protocol` feature → 内嵌资源，不依赖服务器）。
3. **强杀产生孤儿 WebView2**：`Stop-Process -Force` 会残留 `msedgewebview2.exe`，积累后所有窗口打不开。恢复：杀应用 + 杀全部无窗口的 msedgewebview2 + 重启；必要时删 `%LOCALAPPDATA%\com.obsistickeynoy.app\EBWebView`。**退出务必走托盘/设置（app.exit）**。
4. **serde camelCase**：`WidgetStyle` 字段是 `bg_alpha/no_bg`，前端传 `bgAlpha/noBg` —— 结构体必须 `#[serde(rename_all = "camelCase")]`，否则透明度/仅数字开关被静默丢弃。
5. **组件尺寸 = 主显示器网格，固定**：`widget_logical_size` 一律用 `grid_geometry(..., "primary")`（用户要求固定大小，不随所在屏变；曾按保存位置所在屏算导致跨屏/启动 1.5× 放大）。窗口尺寸用**逻辑尺寸**（`set_size(Physical)` 在 release 下会被 DPI 再换算放大）；不设 min/max 锁（跨屏时和系统较劲导致跳动）。
6. **测量窗口必须 DPI-aware**：`SetProcessDpiAwarenessContext(-4)` 后再 `GetWindowRect`，否则返回 ÷1.5 的虚拟化值（曾误判"截断/变大"）。**PrintWindow 截图不可靠，判断界面问题用 CopyFromScreen 真实像素**。
7. **代理环境变量残留**：用户系统里有 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7897`（Clash 端口）。Clash 关着时 npm/git/gh 全部连接失败——临时 `$env:HTTP_PROXY=""` 等清空，或让用户开 Clash。npm 走 npmmirror（用户 .npmrc）。
8. **PowerShell 写文件带 BOM**：`Set-Content -Encoding UTF8` 可能写 BOM（tauri.conf.json 曾因此解析失败）——用 write 工具或 `utf8NoBOM`；PowerShell 的 `-replace` 里 `` `n `` 是字面量不是换行（CSS 曾写入字面反引号）。
9. **每个窗口页面的 `.hidden` 类要各自定义**（不同页面 CSS 不共享）。
10. **`.gitignore` 不要写裸 `*.png`**（会排除 `src-tauri/icons/tray.png`，CI 编译失败——`include_bytes!` 找不到文件）。
11. **Milkdown 序列化会转义 wikilink**：remark-stringify 把 `[[a_b]]` 写成 `\[\[a\_b]]`（`[` 和内部 `_`/`*` 都被转义），存盘后 **Obsidian 不认**、无法当双链。修复：`rich-editor.ts` 的 `markdownUpdated` 回调里对 `\[\[(.*?)]]` 区间做**定向反转义**（`\\([^a-zA-Z0-9])` → `$1`），只还原 wikilink 区域、不影响其他文本；已用 remark 实测全场景 round-trip 通过。**新功能只要涉及"编辑器内插入特殊符号文本"，都要检查落盘后的字节**（Obsidian 侧打开看）。

## 7. 已知遗留 / 下一步候选

- 用户提出的方向（未做）：tag 主题支持与筛选、折叠窄条、到期提醒（系统通知）、Dataview 统计模板（Obsidian 侧）、本地 HTTP API + Obsidian 插件适配
- 双链：✅ 已实现插入引用 `[[...]]`、图片嵌入 `![[...]]` 渲染（随便笺缩放）、预览点击跳转便笺；未做：富文本编辑器内 wikilink 的所见即所得渲染（现为源码文本，与公式同策略）、反链面板（谁链接了我）
- 组件 100% 屏上物理尺寸较小（混合 DPI 固有，用户已接受"主屏固定大小"）
- 正式版打包：`npx tauri build`（首次需 Clash 开着的网络下载 NSIS）

## 8. 最近一次会话状态（截至交接）

- 应用以 **release 版**运行中（`src-tauri/target/release/obsistickeynoy.exe`，无 dev server）
- **GitHub v0.2.0 已发布**（2026-08-18，推 `v0.2.0` 标签触发 Actions 构建 NSIS）：人性化双链 + 图片嵌入渲染；`release.yml` 发布说明已含 v0.2.0 更新日志
- config.json：noteAlpha 0.51 / contentAlpha 0.32 / titleAlpha 0.0（用户调的）；widgets 两个都开启
- 测试便笺在 `Trash/` 有几个历史文件；vault 里现有 3 个便笺（1 个普通、2 个 TODO）
- **v2.2 双链已实现并 release 构建通过**（2026-08-18）：左下 🔗 链接面板、`[[note-<id>|标题]]` 互链、文件导入 `Obsi_StickeyNoy/assets/`、`![[图片]]` 嵌入渲染（随便笺缩放）、预览点击 wikilink 跳转便笺
- 新增命令：`vault_import_file` / `note_show`；Cargo.toml 加 `protocol-asset` feature；tauri.conf.json 开启 `assetProtocol`（scope 空，运行时放开当前库）；capabilities 补 `dialog:allow-open`
