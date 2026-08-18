# ObsiStickeyNoy — 桌面便笺（与 Obsidian 库同步）

独立的 Windows 桌面便笺应用（Tauri v2 + Rust + 原生 TS）：

- **数据 = Markdown 文件**：便笺存放在 Obsidian 库的 `Obsi_StickeyNoy/` 目录，frontmatter 存网格坐标等元数据，Obsidian 里可直接编辑/搜索/双链，应用实时同步
- **网格对齐桌面图标**：便笺吸附的网格 = Windows 桌面图标网格（`SPI_GETICONMETRICS` 取间距 + 注册表 IconSize，安全、不碰 Explorer）
- **多显示器**：每台显示器独立网格原点；拖拽按落点显示器吸附并记录归属；显示器布局变化自动重排
- **内存优先**：每便笺一个透明小窗口（共用 WebView2 进程树）；Markdown 渲染依赖（katex/mermaid）按需懒加载
- **v2 已交付**：托盘常驻、单实例、开机自启、跨 DPI 归一化、多显示器、网格原点精度、Markdown 预览（callout/wikilink/LaTeX/mermaid）
- **v2.1 已交付**：实时磁吸、右键菜单+换色、半透明纸片视觉、富文本 Milkdown、**便笺命名**、**TODO 便笺（纯交互编辑 + 日期/优先级规划）**、**桌面小组件（日历 3×3 / 时钟 3×2，Pixel 风格、样式可配置）**、分板块透明度、回收站进 Obsidian（`Trash/`）
- **v2.2 已交付（人性化双链）**：便笺左下角 🔗 按钮 → 弹出链接面板，**一键指向其他便笺**（`[[note-<id>|标题]]`，Obsidian 里能解析且显示友好标题）；**"选择其他文件…"** 可从硬盘任意位置选文件，复制进库内 `Obsi_StickeyNoy/assets/` 后用 `[[]]` 引用；**图片用 `![[]]` 嵌入并渲染**，随便笺宽度自动缩放（点击放大原尺寸）；预览里点击 wikilink 直接跳转到目标便笺窗口

详细设计见 [DESIGN.md](DESIGN.md)。

## 功能速览

- 便笺窗口：拖拽（实时磁吸 + 松手吸附图标网格）、按格缩放、📌置顶、👁预览/编辑、＋新建、🗑删除（进 `Trash/`，Obsidian 可见）、－隐藏
- **双链（🔗）**：每张便笺左下角 🔗 → ① 列出所有便笺，点击插入 `[[note-<id>|标题]]` 互链；② "选择其他文件…" 系统文件选择器（硬盘任意位置），选中后复制进库内 `Obsi_StickeyNoy/assets/`，图片插 `![[图片]]` 嵌入渲染、其他文件插 `[[文件名]]` 引用；预览里点击 wikilink 可跳转到目标便笺
- 便笺类型：**普通便笺**（富文本 ⇄ 预览）｜ **TODO 便笺**（纯交互：点文字改、勾选框打勾、日期 chip 弹规划面板设开始/结束/优先级、＋添加、×删除；无需写 markdown）
- 标题栏：点击"便笺/TODO"后的标题区可直接命名（存 frontmatter，Obsidian 可见）
- 桌面小组件：设置里开关 —— **日历**（月历 + 任务日期打点 + 点击切大字日期形态）｜ **时钟**（At a Glance 样式）；各自可配背景色/透明度/字体色/字体/纯数字
- 托盘（右下角）：右键菜单 新建便笺 / 新建 TODO / 显示全部 / 设置 / 退出；左键单击 = 显示全部；**退出务必走托盘或设置**（强杀会产生孤儿 WebView2 进程）
- 设置：库路径、重新同步桌面网格、显示全部、开机自启、三板块透明度（底色/内容区/标题栏）、组件样式、退出
- 双向同步：Obsidian 里编辑便笺文件 → 应用窗口实时刷新（直接写 + 内容比对防回环）

## 环境要求

- Windows 10/11（WebView2 运行时，一般系统自带）
- Rust（MSVC 工具链，需 VS Build Tools C++ 组件）
- Node.js 18+

## 开发

```bash
# 首次
npm install
node scripts/gen-icons.mjs   # 生成图标

# 方式 A：调试模式（改代码热更新）——调试版 exe 会访问 localhost:1420，必须同时跑 vite
npm run dev                                        # 终端 1：前端 dev server :1420
cargo run --manifest-path src-tauri/Cargo.toml     # 终端 2：Rust 主进程（调试版）

# 方式 B：tauri CLI 一体化（自动拉起 vite）
npm run tauri dev                                  # 需要 tauri-cli：cargo install tauri-cli --version "^2"
```

> ⚠️ 调试版（debug）exe 默认走 devUrl（http://localhost:1420），**不跑 vite 就会"拒绝连接"**。

## 构建

```bash
npm run build                                       # 前端产物 → dist/

# 独立单文件 exe（嵌入前端资源，无需 vite，直接双击/命令行运行）
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
# → src-tauri/target/release/obsistickeynoy.exe

# 安装包（NSIS/MSI）：
npm run tauri build          # 或 npx @tauri-apps/cli build
```

## 首次使用

1. 启动后出现"设置"窗口，填入 Obsidian 库路径，点"保存并加载"（也可直接点便笺上的 ⚙️）
2. 应用在库里创建 `Obsi_StickeyNoy/` 目录并生成 `grid.json`
3. 便笺窗口出现在桌面图标网格上
4. 需要常驻时：设置里勾选"开机自动启动"；退出用设置/托盘

## 目录结构

```
sticky-notes/
├─ DESIGN.md                  # 设计文档（含 v2 实施记录）
├─ src/                       # 前端（原生 TS + Vite 多页面）
│  ├─ note-window/            #   便笺窗口 UI（拖拽/缩放/双链/预览）
│  ├─ settings/               #   设置窗口（库路径/网格/透明度/组件样式）
│  ├─ calendar-window/        #   日历小组件（3×3 图标）
│  ├─ clock-window/           #   时钟小组件（3×2 图标）
│  └─ lib/
│     ├─ markdown-render.ts   #   Markdown 渲染器（懒加载 katex/mermaid/图片嵌入）
│     ├─ rich-editor.ts       #   Milkdown 富文本（懒加载，wikilink 转义修复）
│     ├─ todo-view.ts         #   TODO 交互列表 + markdown 助手
│     └─ todo-planner.ts      #   规划面板（🛫开始/📅结束/优先级）
├─ src-tauri/                 # Rust 主进程
│  ├─ src/
│  │  ├─ lib.rs               #   入口、Commands、托盘、单实例、显示器管理
│  │  ├─ vault.rs             #   库路径、frontmatter 读写
│  │  ├─ grid.rs              #   网格几何、吸附算法（多显示器）
│  │  ├─ desktop_grid.rs      #   桌面图标网格读取（ICONMETRICS + 注册表）
│  │  ├─ windows.rs           #   便笺窗口创建/应用元数据
│  │  └─ sync.rs              #   notify 文件监听、双向同步
│  └─ capabilities/           # Tauri v2 权限
└─ scripts/gen-icons.mjs      # 图标生成
```

## 便笺文件格式

```markdown
---
id: "n_ab12cd34"
x: 4            # 网格列（相对所在显示器工作区）
y: 2            # 网格行
w: 3            # 占列数
h: 2            # 占行数
z: 5            # 层级
color: yellow   # 颜色
pinned: true    # 置顶
monitor: "\\\\.\\DISPLAY5"  # 所在显示器（设备名，primary = 主显示器）
created: "2025-05-01T10:00:00+08:00"
updated: "2025-05-01T10:05:00+08:00"
---
便笺正文（Markdown）…支持 callout / wikilink / LaTeX / mermaid / 表格 / `![[图片]]` 嵌入
```

> 双链引用：`[[note-<id>]]` 或 `[[note-<id>|标题]]`（互链便笺）；`[[文件名]]`（引用库内文件）；`![[图片.png]]`（嵌入图片，随便笺宽度缩放）。图片等外部文件用 🔗 → "选择其他文件…" 导入后存放在 `Obsi_StickeyNoy/assets/`。

## v0.1 + v2 状态

- ✅ 便笺读写（frontmatter 解析/序列化）、双向同步（直接写 + 防回环）
- ✅ 网格吸附（图标间距对齐 + 原点偏移）、拖拽、按格缩放、置顶、删除进回收站
- ✅ 托盘常驻（新建/显示全部/设置/退出，优雅退出防孤儿进程）
- ✅ 单实例、开机自启
- ✅ 多显示器独立网格 + 跨 DPI 归一化 + 布局变化自动重排
- ✅ Markdown 预览（callout/wikilink/LaTeX/mermaid，懒加载）
- ✅ 人性化双链（v2.2）：🔗 链接面板、便笺互链 `[[note-<id>|标题]]`、任意文件导入引用、`![[图片]]` 嵌入渲染（随便笺缩放）、预览点击 wikilink 跳转
- ⬜ 后续：tag 主题支持与筛选、折叠窄条、到期提醒（系统通知）、Dataview 统计模板（Obsidian 侧）、反链面板、富文本编辑器内 wikilink 所见即所得渲染
