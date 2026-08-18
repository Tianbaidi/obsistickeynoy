# 桌面便笺应用设计文档（Sticky Notes Widget）

> 版本：v0.1 草案 ｜ 日期：2025-XX-XX ｜ 状态：设计中（窗口模型、技术栈已确认）
>
> 一句话定位：**一个独立的桌面便笺应用**，便笺以 Markdown 文件存放在 Obsidian 库中，
> 桌面位置受"网格系统"约束（美观、对齐），并与 Obsidian 双向可见。

---

## 1. 产品定位与目标

| 项目 | 内容 |
|---|---|
| 产品形态 | 独立桌面应用（非 Obsidian 插件），常驻托盘的"便笺小组件" |
| 数据存储 | 一个 Obsidian 库（用户指定目录），便笺 = 一个个 Markdown 文件 |
| 核心交互 | 便笺以独立小窗口贴在桌面上，拖拽时自动吸附网格，可置顶、可换色 |
| 与 Obsidian 的关系 | 同一份文件：Obsidian 里可查看/编辑/全文搜索/双链；应用里实时同步 |
| 演进目标 | 从"便笺"逐步长成功能丰富的便笺应用（checklist、提醒、搜索、标签、双链…） |
| 性能取向 | **内存优先**：极致性能优化；存储空间不作约束（可用磁盘换内存） |

**非目标（v1 明确不做）**：玻璃/毛玻璃背景（远期用 window-vibrancy 实现，见 §7.1）、多人实时协同、移动端。

---

## 2. 核心概念

- **库（Vault）**：用户指定的 Obsidian 仓库目录，是唯一数据源（source of truth）。
- **便笺（Note）**：一个 Markdown 文件 + 一个对应的桌面小窗口。文件是"内容"，窗口是"展示"。
- **网格系统（Grid）**：把显示器工作区划分为等宽等高的单元格，便笺的**位置和大小都用网格坐标表达**，而非像素。这是本应用"美观约束"的根基。

---

## 3. 技术选型

### 3.1 决策：Tauri v2（Rust 后端）—— 内存优先

**选型依据（已确认）**：窗口模型为"每便笺独立小窗口"，此时内存是决定体验的指标：

| 维度 | Tauri v2 | Electron |
|---|---|---|
| 多窗口内存 | Windows 上共用系统 WebView2 进程树，便笺越多**亚线性增长** | 每个窗口一个独立 Chromium 渲染进程（约 50–150MB/个），20 条便笺即 1GB+ |
| 基础占用 | 约 20MB 级（无内置 Chromium） | 200MB+ |
| 独立窗口/置顶/无边框/定位 | ✅ 全部支持（`set_position`/`set_size`/`set_always_on_top`） | ✅ |
| 文件监听 | Rust `notify` crate（省内存、更稳） | chokidar（Node 进程） |
| 开发成本 | 需少量 Rust 胶水 | 纯 TS |

**结论**：默认选 **Tauri v2**。仅当 Rust 开发成本不可接受时才退回 Electron（数据层与网格算法与框架无关，迁移成本可控）。

### 3.2 关键依赖

| 侧 | 依赖 |
|---|---|
| Rust（src-tauri） | `tauri` v2、`serde` / `serde_yaml`（frontmatter）、`notify`（文件监听）、`tauri-plugin-autostart`（开机自启） |
| 前端（webview） | `@tauri-apps/api`；渲染层用**原生 TS + 极简 DOM**，不引入 React/Vue（见 §3.3） |
| 打包 | `tauri-bundler`（NSIS/MSI、portable） |

### 3.3 内存预算与优化策略（验收必须达标）

**目标预算（Windows）**：

| 场景 | 目标 |
|---|---|
| 空闲（仅托盘，无便笺窗口） | < 40MB |
| 1 条便笺 | < 90MB |
| 20 条便笺 | < 350MB |
| 50 条便笺 | < 800MB |

**策略（按优先级）**：

1. **共享进程树**：所有便笺窗口共用 WebView2 进程（Tauri 默认），避免 Electron 每窗口一个 Chromium。
2. **轻量渲染层**：便笺窗口 = 原生 TS + textarea + 少量 DOM，不打包大库；Markdown 预览与富文本编辑器均**按需懒加载**（见 §7.2）。
3. **懒加载 + 休眠**：启动只创建可见便笺的窗口；被折叠/隐藏的便笺**销毁窗口、仅留元数据**（文件在磁盘上，随时可重建）——"存储压力无所谓"正好用磁盘换内存。
4. **解析放 Rust 主进程**：frontmatter 解析、文件监听、网格计算全在 Rust；webview 只做渲染，不加载解析库。
5. **v0.1 附内存基准测试**：用 `process.memoryInfo()` / 任务管理器记录上述 4 个场景的实测值。

> 兜底方案（Plan B，不进 v1）：若仍不达标，改用一个透明"虚拟桌面"大窗口承载所有便笺卡片（单 webview），牺牲独立窗口形态换极低内存。

---

## 4. 总体架构

```
┌────────────────────────── Rust 主进程 (src-tauri) ─────────────────┐
│  生命周期 / 托盘 / 开机自启                                          │
│  vault.rs    库路径解析、网格配置读写                                │
│  sync.rs     notify 监听库目录、原子写、冲突处理                     │
│  windows.rs  便笺窗口创建/移动/吸附/置顶/层级/休眠                   │
│  grid.rs     网格几何计算、吸附算法、多显示器处理                    │
└───────────────▲──────────────────────────▲────────────────────────┘
        Tauri Command (invoke)       notify 文件事件
┌───────────────┴──────────────────────────┴────────────────────────┐
│ 渲染进程 A：便笺窗口 1        渲染进程 B：便笺窗口 2       设置窗口   │
│  (textarea 编辑 + 工具栏 + 拖拽/缩放手柄)                            │
└─────────────────────────────────────────────────────────────────────┘
                            │ 读写
                 ┌──────────▼──────────┐
                 │  Obsidian 库目录      │  ← 用户也在 Obsidian 里打开它
                 │  Obsi_StickeyNoy/*.md │
                 └─────────────────────┘
```

**进程职责划分**：

- **主进程**：唯一持有文件系统与窗口控制权。网格吸附必须在主进程做（因为窗口位置只有主进程能改）。
- **渲染进程（每便笺一个窗口）**：只负责编辑 UI、上报拖拽结束位置、展示同步来的内容。
- **preload**：通过 `contextBridge` 暴露白名单 API，渲染进程拿不到 Node 权限（安全基线，§10）。

### 4.1 Tauri Command 设计（渲染层通过 `invoke` 调用 Rust 命令）

| 方向 | Command | 载荷 | 说明 |
|---|---|---|---|
| R→M | `note_save` | `{ id, meta, content }` | 保存便笺（原子写，主进程更新 `updated`） |
| R→M | `note_drag_end` | `{ id, x, y }` | 拖拽结束，主进程吸附后 `set_position` |
| R→M | `note_resize` | `{ id, wCells, hCells }` | 按网格单元格步进缩放 |
| R→M | `note_set_pinned` | `{ id, pinned }` | 置顶切换 → `set_always_on_top` |
| R→M | `note_delete` | `{ id }` | 移入库的 `.trash/`（遵循 Obsidian 回收站语义） |
| R→M | `note_close` | `{ id }` | 关闭窗口（不删文件） |
| R→M | `note_move` | `{ id, x, y }` | 拖拽中逐帧 `set_position`（不落盘） |
| R→M | `note_get` | `{ id }` | 窗口加载后拉取 frontmatter + 正文 |
| R→M | `note_new` | `{ color? }` | 新建便笺：分配格点 + 写文件 + 建窗口 |
| R→M | `note_show` | `{ id }` | 显示/聚焦便笺窗口（预览里点击 wikilink 跳转用；无窗口则从磁盘重建） |
| R→M | `vault_import_file` | `{ source }` | 双链导入：把硬盘任意文件复制进库内 `Obsi_StickeyNoy/assets/`（已在库内不复制），返回 `{ fileName, isImage }` |
| M→R | `note_external_change` | `{ content, updated }` | Obsidian 侧改文件后推送（event） |
| R→M | `grid_get_config` / `grid_get_geometry` | — | 渲染层画辅助线、计算手柄步进 |
| R→M | `grid_resync` | — | 手动重新读取桌面图标网格（托盘/设置触发） |

---

## 5. 数据模型

### 5.1 库内目录结构

```
<vault>/
├─ Obsi_StickeyNoy/             # 便笺目录（已确认命名）
│  ├─ note-<id>.md              # 每个便笺一个文件
│  ├─ note-<id>.md
│  ├─ assets/                   # 双链导入的附件（v2.2：图片/文件复制到这里，Obsidian 按文件名解析）
│  │  └─ <文件名>               #   已在库内的文件不复制，直接引用原文件名
│  └─ grid.json                 # 网格配置（应用私有，Obsidian 忽略或可见均可）
└─ .obsidian/                   # （用户的 Obsidian 配置，本应用不碰）
```

### 5.2 便笺文件格式

```markdown
---
id: "n_ab12cd34"
x: 4            # 网格列（左上角）
y: 2            # 网格行（左上角）
w: 3            # 占列数（宽）
h: 2            # 占行数（高）
z: 5            # 层级（越大越靠上）
color: yellow   # yellow | pink | green | blue | purple | gray
pinned: true    # 是否置顶（始终显示在最上层）
monitor: "0"    # 所在显示器（display.id 字符串，多显示器时）
created: "2025-05-01T10:00:00+08:00"
updated: "2025-05-01T10:05:00+08:00"
---
便笺正文（Markdown）…
```

**字段设计要点**：

- 位置一律用**网格坐标**（`x/y/w/h`），不存像素 → 换显示器、改网格参数、跨设备都不乱。
- `id` 用于窗口 ↔ 文件的稳定映射（重命名/移动文件不丢窗口状态）。
- `updated` 由主进程写入，是双向同步冲突判定的依据（§8）。
- 正文就是标准 Markdown：天然获得 Obsidian 的搜索、双链、标签能力。

### 5.3 网格配置 `Obsi_StickeyNoy/grid.json`

```json
{
  "version": 1,
  "source": "auto-desktop",   // auto-desktop = 同步桌面图标网格 | manual = 自定义参数
  "cellWidth": 180,           // 仅 manual 模式使用
  "cellHeight": 160,
  "gap": 12,
  "margin": 16
}
```

- 放在库里而非应用配置里 → 同一库在多台设备上网格一致。
- `cellWidth/cellHeight`：单元格尺寸；`gap`：单元格间距；`margin`：距显示器工作区边缘的留白。
- `source: auto-desktop` 时，以上几何参数被桌面图标网格覆盖（§6.8），manual 参数始终保留作为兜底。

### 5.4 应用级配置（本地配置，不占库）

```ts
{
  vaultPath: string,          // 库路径（首次启动让用户选择）
  autoLaunch: boolean,        // 开机自启
  showTray: boolean,
  rememberWindows: boolean,   // 退出时记住窗口状态
}
```

---

## 6. 网格系统设计

### 6.1 几何换算公式

```
像素 = 网格坐标 × (单元格 + 间距) + 留白

x_px = margin + col * (cellWidth  + gap)
y_px = margin + row * (cellHeight + gap)
w_px = w * cellWidth  + (w - 1) * gap
h_px = h * cellHeight + (h - 1) * gap
```

### 6.2 吸附算法（拖拽结束时执行，主进程）

```
输入：松手时鼠标的屏幕坐标 (mx, my)
1. 取鼠标所在显示器 d：monitor_from_point(mx, my)（失败则退回 primary）
2. 网格原点 O = d.workArea 左上角（每个显示器独立网格）
3. 相对坐标 rx = mx - O.x，ry = my - O.y
   ★ 跨缩放率显示器时，先把 (mx, my) 归一化为 d 的逻辑坐标再算（§6.4）
4. 目标格：col = round((rx - margin) / (cellWidth + gap))
            row = round((ry - margin) / (cellHeight + gap))
   均 clamp ≥ 0
5. 换算像素（逻辑坐标）：
   x = O.x + margin + col * (cellWidth + gap)
   y = O.y + margin + row * (cellHeight + gap)
6. 越界回退：若 x + w_px > O.x + workArea.width
   → col 减到能放下的最大值；窗口比工作区还大时 clamp 到 margin 处（y 方向同理）
7. set_position(Logical(x, y))；更新 frontmatter 的 x/y/monitor（防抖 300ms 落盘）
```

- **吸附时机（v1 = 松手吸附）**：拖拽过程窗口自由跟随鼠标，松手一次性吸附到最近格点——简单、行为可预期。
- **磁吸手感（v0.2）**：拖拽中距离格点 < 8px 时实时"吸住"（预览吸附），更爽滑。
- **缩放步进**：缩放手柄按 `cellWidth + gap` 步进，保证尺寸永远落在网格上；结束后更新 w/h 落盘。

### 6.3 多显示器

- 每个显示器独立网格原点（各自 workArea 左上角），`monitor` 字段记录 `display.id`（字符串）。
- 拖到另一显示器：吸附时重算归属 → 更新 `monitor` → 防抖保存。
- **热插拔兜底**：启动时记录的 `monitor` id 不存在（显示器被拔/换接口）→ 回退 primary，坐标原样保留（网格原点不同会有平移，但不丢数据）。

### 6.4 DPI / 缩放

- Tauri 按 per-monitor DPI 感知处理；`set_position` / `set_size` 一律用**逻辑坐标**，跨缩放率显示器由系统换算。
- **坑位预警**：拖拽跨越缩放率不同的显示器时，鼠标屏幕坐标须先换算成目标显示器的逻辑坐标再算格点（§6.2 步骤 3），否则落点会偏移。

### 6.5 新便笺自动放置

- 在焦点显示器（默认 primary）上从 (0,0) 逐格扫描**第一个未被占用的格点**（占用 = 已有便笺左上角在该格）；
- 占满 → 从 (0,0) 起每新建一个级联 +1 格叠放（靠 z 区分）；
- 默认尺寸 3×2 格（默认参数下约 552×332 px）。

### 6.6 网格参数修改即重排（零迁移）

- 设置里改 cellWidth/cellHeight/gap/margin → 所有便笺像素位置按新参数重算、即时重排。
- 只存格坐标、不存像素——这是数据模型的最大红利。

### 6.7 允许重叠

- 网格约束"位置对齐"，**不禁止重叠**（真实便笺可叠放）；重叠时由 z 层级 + 点击聚焦决定谁在上。

### 6.8 与桌面图标网格同步（`source: auto-desktop`）

**目标**：便笺吸附的网格 = Windows 桌面图标的网格，便笺与桌面图标**行列对齐**，桌面整体有序。

**实现（Rust 主进程，无需管理员权限，安全优先）**：

1. **注册表读取（当前唯一方案）**：`HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop` 读 `IconSpacing` / `IconVerticalSpacing`（REG_DWORD，单位 1/15 像素，负值=系统默认）→ 间距 = |值|/15；原点取主显示器工作区左上角（与屏幕对齐）。零风险。
2. **手动网格兜底**：注册表读不到（隐藏桌面图标 / 被美化工具接管）→ 退回 grid.json 的 manual 参数。

**重同步时机**：启动时、显示器设置变化（WM_DISPLAYCHANGE）、Explorer 重启后、托盘"重新同步桌面网格"菜单。

**v1 范围**：主显示器网格（注册表间距 + 屏幕对齐原点）；多显示器 / 跨 DPI 的坐标换算列为 v0.2。

**与手动模式的关系**：grid.json `source` 字段切换；auto 模式下便笺仍存**格坐标**（相对网格原点），切回 manual 只是换一套几何参数，数据零迁移。

**已知边界**：任务栏在左侧/顶部时需用工作区校正原点；注册表法拿不到图标实际原点，网格起点与图标有少量偏移（间距一致，观感仍整齐）；Fences 等接管桌面的工具可能使间距不准 → 手动网格兜底。

---

## 7. 窗口与交互设计

### 7.1 窗口形态（v1 已定）

| 项 | 决策 | 说明 |
|---|---|---|
| 边框 | `decorations: false`（无边框） | 便笺纸片观感 |
| 透明 | **透明窗口**（`transparent: true`） | 已确认：便笺不需要最大化（透明窗口不能最大化——无所谓）；原生阴影缺失用 CSS 自绘；单窗口面积小，合成开销可忽略 |
| 圆角/阴影 | CSS `border-radius: 10px` + `filter: drop-shadow()` | 透明窗口里阴影照常渲染到桌面上（自绘阴影） |
| 窗口尺寸 | 由格坐标换算（w×h 格） | 新建默认 3×2 格，最小 1×1 格 |
| 系统缩放 | `resizable: false`（OS 级） | 缩放全走自绘手柄 + 网格步进，尺寸永远在网格上（顺带规避透明窗口缩放的闪烁问题） |
| 任务栏 | `set_skip_taskbar(true)` | 不出现在任务栏，由托盘统一管理（更像"小组件"） |
| 聚焦 | 点击即聚焦、提到便笺群最上层 | 初始顺序由 z 决定 |
| 置顶 | `set_always_on_top(pinned)` | 跟随 frontmatter `pinned`，托盘可全局切换 |

**玻璃 / 毛玻璃效果（v2.1 结论：半透明纸片，非真模糊）**

- **已实现**：`transparent: true` + 卡片半透明背景（rgba 0.3）→ 桌面透过便笺可见，半透明磨砂质感（实测截图确认）。
- **真模糊（acrylic）不可行**：Win11 24H2 上 DWM 系统后景（DWMWA_SYSTEMBACKDROP_TYPE）与 WebView2 透明**互斥**——不透明窗口时 WebView2 透明背景渲染成黑色（隔离测试实证）；透明（WS_EX_LAYERED）窗口时 DWM 后景不渲染。tauri 原生 `Effect::Acrylic` 与 window-vibrancy 均走旧 `SetWindowCompositionAttribute`，24H2 不渲染。真 blur 需后续研究（如原生 WebView2 合成器实验、或独立无边框层做模糊宿主）。
- 渲染顺序：DWM 后景（若有）→ WebView2 透明像素 → 卡片 rgba 叠加 → 文字。

**拖拽（v1 决策：手动拖拽）**——不用 `data-tauri-drag-region` 原生拖拽（原生拖拽期间 webview 收不到指针事件，无法做吸附）：

1. 标题栏 pointerdown：记录鼠标与窗口左上角的偏移；
2. pointermove 节流（~30fps）invoke `note_move`（逐帧 `set_position`，不落盘）；
3. pointerup 上报 `note_drag_end(mx, my)` → 主进程执行 §6.2 吸附 + 落盘。
   - 若实测逐帧 `set_position` 卡顿 → 退回"原生拖拽 + 监听窗口 Moved 事件 + 松手防抖吸附"。

**缩放（v1 决策：自绘手柄）**：右下角 16×16 手柄，pointer 事件按 `cellWidth + gap` 步进 invoke `set_size`，松手上报 `note_resize` 落盘。

### 7.2 编辑器与渲染

**v1（暂定）：纯 Markdown，`<textarea>` 编辑**
- 不用 contenteditable：中文输入法（IME）组合态、光标、选区坑多，textarea 全部规避。
- 自动保存：输入防抖 800ms 后走 `note:save`；失焦立即保存。

**关于"直接复用 Obsidian 渲染样式"的结论**

- Obsidian 的渲染器与默认主题 CSS 是**闭源**的（打包在应用内），不能直接复制进本项目（许可问题）。
- 但有成熟的开源等效方案，观感可以做到很接近：
  1. **渲染管线抄 Quartz**（MIT 开源静态站点生成器）：基于 remark 的完整 [Obsidian Compatibility](https://quartz-themes.github.io/velvet-moon/features/obsidian-compatibility) 特性集——wikilinks、callouts、embed、标签、KaTeX、mermaid，正是 Obsidian 那套"风味 Markdown"。
  2. **样式抄开源主题**：社区主题（Blue Topaz、Minimal 等）本身就是公开 CSS，可直接参考其 CSS 变量设计令牌，或按许可引入主题文件。
  3. 便笺是卡片形态小窗口，v1 只需要自己的轻量样式；完整笔记排版是"预览"功能的事，不急。

**富文本（v0.3 评估，开源候选）**

| 方案 | 说明 |
|---|---|
| **Milkdown**（MIT） | ProseMirror + remark，**Markdown 原生**：编辑结果直接序列化为 Markdown，与"frontmatter + 正文"的文件格式天然契合 → 首选 |
| **TipTap + tiptap-markdown**（MIT） | ProseMirror 系，生态最大、IME 表现好，但 Markdown 往返序列化需额外维护 |
| **CodeMirror 6**（MIT） | 与 Obsidian 编辑器同源；但"实时预览"是 Obsidian 自研覆盖层，复刻成本高，仅作纯编辑备选 |
| **Lexical**（MIT） | Meta 出品、性能好，但 Markdown 序列化能力较弱，优先级最低 |

- 内存约束：富文本编辑器**按需懒加载**（仅激活中的便笺窗口加载），不影响 §3.3 内存预算。

### 7.3 窗口管理

| 能力 | 实现 |
|---|---|
| 置顶 | `set_always_on_top(true)`，跟随 `pinned` 字段 |
| 层级 | `z` 字段排序；新建便笺默认置顶 z 递增 |
| 托盘 | 托盘菜单：新建便笺 / 显示全部 / 隐藏全部 / 设置 / 退出 |
| 开机自启 | tauri-plugin-autostart |
| 退出策略 | 关闭窗口 = 隐藏到托盘（不退出）；托盘"退出"才真正退出 |
| 删除 | 移入 `<vault>/.trash/`（Obsidian 回收站语义），Obsidian 里也能恢复 |

### 7.4 右键菜单（便笺窗口）

新建便笺 / 换颜色 / 置顶开关 / 复制内容 / 删除（移入回收站）/ 设置…

### 7.5 窗口生命周期

- **窗口注册表**（主进程内存）：`HashMap<note_id, Window>`；渲染进程只认识自己的 note id。
- **启动恢复**：读取 `Obsi_StickeyNoy/*.md` → 按 `z` 排序 → 逐条创建窗口并放置到格点。
- **懒加载 / 休眠**（内存策略 §3.3）：被隐藏（托盘"隐藏全部"、或单条折叠）的窗口**直接销毁**，仅保留文件；再次显示时按文件重建。窗口无状态，文件是唯一真相。
- **文件 ↔ 窗口映射**：以 `id` 为键；文件被外部重命名 → 读 frontmatter 的 `id` 重新绑定，不丢窗口。
- **新建**：`note_new` 命令 → 主进程生成 id、分配格点（§6.5）、原子写文件 → 创建窗口。
- **退出**：位置已随操作防抖落盘，退出前再统一 flush 一次。

---

## 8. 文件同步与冲突处理

双向可见是本应用的核心承诺，必须稳。

### 8.1 监听

- Rust `notify` 监听 `<vault>/Obsi_StickeyNoy/*.md`，200ms 防抖。
- 事件 → 动作：
  - `add` → 解析 frontmatter，若无对应窗口则创建；
  - `change` → 解析，若内容或元数据变化则推送 `note_external_change` 并更新窗口位置/大小；
  - `unlink` → 关闭对应窗口（文件已删，不弹窗）。

### 8.2 写入（v1：直接写；原子写已弃用）

```
1. 序列化 frontmatter + 正文
2. fs::write(file, content)
```

> ⚠️ 曾用 tmp+rename 原子写：Windows 上 `std::fs::rename` 替换已存在文件时，
> ReadDirectoryChangesW 会报告 **Remove + Create 两个事件** → 监听器销毁便笺窗口再重建
> → 便笺闪烁、甚至（事件顺序不利时）窗口消失。改为直接写：只产生 Modify 事件，
> 配合内容比对（§8.3）防回环。代价是失去原子性，对小型便笺文件可接受。

### 8.3 防回环

- 维护"本应用最近写入的文件 mtime 集合"；notify 事件若命中且内容一致则忽略。
- 写入前先比对磁盘上的 `updated`，若比本地新则说明 Obsidian 刚改过 → 走冲突处理。

### 8.4 冲突处理（v1 策略：last-write-wins + 备份）

```
若双方在防抖窗口内都改过：
  1. 保留本地修改为主（应用侧正在编辑，用户意图明确）
  2. 把磁盘版本备份为 note-<id>.conflict-<ts>.md（不丢数据）
  3. 继续原子写本地版本
```

- 云同步（iCloud/OneDrive）注意事项：文件可能被占锁或同步延迟，写失败时重试 3 次并提示；notify 对网络盘事件可能重复触发，靠防抖 + mtime 去重兜底。

---

## 9. 功能路线图

### ✅ v0.1 MVP（已完成，含实战修正）

- [x] 首次启动选择库路径，读取/生成网格配置
- [x] 新建 / 编辑 / 保存 / 删除便笺（每便笺一个窗口）
- [x] 拖拽吸附网格（原生 startDragging + moved 事件松手吸附）；按网格步进缩放
- [x] 网格间距同步桌面图标（注册表 IconSpacing，原点取屏幕左上角）
- [x] 置顶开关、隐藏便笺；双向同步（Obsidian ⇄ 应用，直接写 + 内容比对防回环）
- [x] 中文输入正常（textarea）；文件日志（app.log）
- [x] 实战修正：① 命令内创建 WebView2 窗口会卡死 → 便笺窗口由文件监听器创建、设置窗口启动预创建（隐藏）；② tmp+rename 会被 Windows 监听成 删除+新建 → 改直接写；③ 强杀应用产生孤儿 WebView2 进程 → 需优雅退出；④ 窗口 label 与 note id 的映射（label 前缀 note_）

### 🔴 v2 稳定性（A 档）✅ 已完成

- [x] **A1 托盘常驻**：右键菜单 新建便笺 / 显示全部 / 设置 / 退出；**退出走 app.exit**（优雅关闭，实测孤儿 WebView2 = 0）；左键单击 = 显示全部
- [x] **A2 单实例**：tauri-plugin-single-instance，二次启动聚焦已有实例（实测第二实例自动退出）
- [x] **A3 窗口创建架构**：根因 = 强杀残留的孤儿 WebView2 进程占 WebView2 单例浏览器锁（实测 23 个孤儿时新建窗口卡死）；已收敛：建窗只经统一入口、只在 setup/事件回调（铁律写入 windows.rs），去重以 tauri 窗口注册表为准
- [x] **A4 开机自启**：tauri-plugin-autostart + 设置开关（注册表 Run 键实测生效）

### 🟡 v2 桌面小组件（B 档）✅ 已完成

- [x] **B5 多显示器**：`monitor` 字段生效（设备名）；拖拽按落点显示器吸附（逻辑工作区包含性判定，不用 monitor_from_point——其 name() 常为 None）；每显示器独立网格原点；5s 轮询显示器布局变化自动重排
- [x] **B6 跨 DPI 归一化**：前端用 `monitorFromPoint` 取落点显示器 scale 换算物理→逻辑（实测 sf=1.5 正确）；后端 pitch 按显示器 scale 物理→逻辑
- [x] **B7 网格原点精度**：注册表 `IconSize`(48) + `SPI_GETICONMETRICS`(pitch 物理 113=75×1.5)；原点偏移 = (pitch−iconSize)/2；实测拖拽反推格坐标与 frontmatter 完全一致（col=8,row=1）

### 🟢 v2 内容能力（C 档，第一个）✅ 已完成

- [x] **C1 Markdown 预览**：markdown-it + callout/wikilink 自定义 + KaTeX + mermaid（全懒加载，主包轻量）；👁 编辑/预览切换；实测渲染 5696 字符无错误

### 后续（非 v2 范围）

- checklist、搜索、标签、双链、提醒
- 主题系统、模板、多库、导出、统计、AI 辅助

### ✅ v2.1 体验与视觉升级（已完成）

- [x] **滚动条美化**：细圆角半透明滚动条，富文本/预览**统一**
- [x] **实时磁吸**：拖拽中距格点 <8px 吸附预览（`note_magnet` 命令 + 前端 onMoved 节流 30ms）
- [x] **右键菜单 + 颜色选择器**：自定义 DOM 菜单（置顶/换色/复制/隐藏/删除），`note_set_color` 命令；前端 frontmatter color 实测落盘
- [x] **玻璃效果**：半透明纸片（transparent:true + 卡片 rgba 可调）；真 blur 受 Win11 24H2+WebView2 组合限制（详见 §7.1）
- [x] **富文本 Milkdown 为主**：移除源码 textarea，**富文本 = 默认编辑器**（所见即所得，markdown 序列化写回文件），👁 切换预览；懒加载
- [x] **透明度设置**：设置界面滑块（5%~95%，`config_set_note_alpha` + `config_updated` 广播实时生效）；默认 0.2；**内容区只比边框略不透明**（`--content-alpha = min(alpha+0.06, 0.8)`）保证可读与层次
- [x] **富文本增强**：接入 `preset-gfm`（任务列表复选框/表格/删除线）；任务复选框用 CSS `li[data-item-type="task"][data-checked]` 绘制；BOM 容忍（config.json 带 BOM 也能解析）
- [x] **数学公式策略（踩坑结论）**：Milkdown 的 `@milkdown/plugin-math` 在当前依赖组合（micromark-extension-math 3.1.0 + micromark 4.0.2）下**吞掉内容**（实测：`$x$` 解析后连文本都没了）——已移除。**编辑器内公式以 markdown 源码显示**（`$E=mc^2$` 原样、不转义），**预览（👁）里用自带 katex 完整渲染**（行内+块级，已实测美观）。预览正则修复：行内 `$` 的 lookahead 用 `\p{P}` Unicode 标点（中文逗号 `，` 后也能识别）。

### ✅ v2.1.5 桌面小组件（日历 3×3 图标 / 时钟 3×2 图标，Google Pixel 风格）

- [x] **架构**：与设置窗口同铁律 —— setup 预创建隐藏组件窗口（`widget_calendar` / `widget_clock`），命令只 show/hide（`widget_toggle`），**绝不在命令内 build()**；config 存 `widgets.{calendar,clock}.{enabled,x,y}`；尺寸 = 用图标网格**物理 pitch** 强制定位（`set_size(Physical)`，覆盖精确格数）
- [x] **时钟组件**（`src/clock-window/`，Pixel At a Glance 风格）：大号数字（**方正 Bahnschrift 默认**，可切圆润/等宽）+ 日期，浅色圆角卡片，整卡可拖、悬停 × 关闭；时间字号 `clamp` 视口自适应
- [x] **日历组件**（`src/calendar-window/`，Material You 风格）：完整月历（周一起始、今天 = Pixel 蓝 `#1a73e8` 圆形、选中日期蓝圈、‹ › 翻月）；**点击卡片空白/空单元格 ⇄ 切换"大字日期"形态**（大号数字 + 年月星期）；解析 TODO 任务 🛫/📅 日期打点（结束红点、多任务蓝色数量角标）；60s 轮询同步；拖拽记忆位置
- [x] **组件样式可配置（v2.1.6）**：设置界面每个组件独立调整 —— 背景色（取色器）/ 背景透明度（滑块）/ 字体色 / 数字字体（方正·圆润·等宽）/ **仅数字开关（无背景，透过数字看壁纸）**；`widget_style_set` 存配置 + `widget_style_updated` 广播实时生效
- [x] **边框线修复**：圆角外隐约一条深色线 = 卡片 `box-shadow` 在透明窗口上的边缘伪影 → 移除 box-shadow 解决（真实屏幕截图确认）
- [x] **时钟去 CSS 圆角（v2.1.7）**：`border-radius: 0` 白色填充整窗（圆角边缘在透明窗口上像勾线），圆角交给 Win11 窗口自带
- [x] **踩坑（serde camelCase）**：`WidgetStyle` 字段 `bg_alpha/no_bg` 与前端 `bgAlpha/noBg` 不一致 → serde 反序列化**静默丢弃**，透明度/仅数字开关永不生效且配置读回为空。修复：结构体加 `#[serde(rename_all = "camelCase")]`；实测红色背景+白字样式正常应用
- [x] **踩坑（devUrl 依赖 → 全部窗口"无法访问此页面"）**：debug 构建的 `WebviewUrl::App` 一律加载 `devUrl`（http://localhost:1420 vite 服务器），dev 服务器一停 → **所有窗口**（便笺/组件/设置）白屏"无法访问"。修复：**release 版 + tauri 的 `custom-protocol` feature**（Cargo.toml 显式开启）→ 内嵌资源、不依赖任何服务器；已实测无 dev 服务器时 release 正常
- [x] **踩坑（截图误判）**：PrintWindow 抓透明窗口得到 DPI 虚拟化（÷1.5）且视觉模型会误读文本（"23:45"看成本截断）→ 判断界面问题必须用**真实屏幕截图**（CopyFromScreen + DPI-aware 坐标）复核
- [x] **踩坑**：日历 `.hidden` 类未定义导致"大字日期"块一直显示在网格下方 → 补 `.hidden{display:none!important}`；组件窗口测量必须 DPI-aware（GetWindowRect 虚拟化值 ÷1.5 误导）

### ✅ v2.2 人性化双链（便笺互链 + 任意文件引用 + 图片嵌入渲染）

- [x] **左下 🔗 按钮 + 链接面板**：每张便笺左下角新增 🔗 按钮，点击弹出面板：① 列出当前全部便笺（带类型标签 TODO/便笺，标题或 `note-<id>`），点击插入 `[[note-<id>|标题]]`（Obsidian 里能正确解析且显示友好标题）；② "选择其他文件…" 走系统文件选择器，可访问**硬盘任意位置**的文件，选中后经 `vault_import_file` 命令**复制进库内 `Obsi_StickeyNoy/assets/`**（已在库内则不复制、不产生重复），重名自动加 `-1/-2` 后缀
- [x] **插入策略按便笺模式**：富文本 = 光标处插入（Milkdown `insertTextAtCursor`，listener 自动触发保存）；预览 = 文末追加；TODO 便笺 = 追加为 `- [ ] [[...]]` 任务行
- [x] **图片嵌入 `![[...]]` 渲染**（markdown-render 新增 inline 规则）：预览里渲染为 `<img>`，src 用 **asset 协议**（`convertFileSrc`）指向库内文件；**`max-width:100%` 随便笺宽度自动缩放**（便笺放大/缩小图片跟着变），点击图片切换原始尺寸（`.zoom`，超出横向滚动）；支持 Obsidian 语法 `![[img|300]]` 指定宽度；assets 缺失自动回退库根目录（img onerror）
- [x] **wikilink 别名显示 + 跳转**：`[[目标|别名]]` 预览里显示别名；点击 `[[note-<id>]]` 调 `note_show` **显示/聚焦目标便笺窗口**（窗口隐藏则 show，被销毁则从磁盘重建，重建走统一建窗入口——铁律）
- [x] **安全与配置**：`protocol-asset` feature + `assetProtocol.enable`（scope 留空，**运行时只放开当前库目录**，最小权限）；capabilities 补 `dialog:allow-open`；导入文件名清洗 `[ ] |` 字符（避免破坏 wikilink 语法）
- [x] **踩坑（编辑器内不渲染）**：富文本编辑器里 `[[...]]`/`![[...]]` 以**源码文本**显示（与数学公式同策略：编辑器源码、👁 预览渲染）——Milkdown commonmark 不支持 wikilink 节点，所见即所得渲染留作后续
- [x] **踩坑（asset 协议）**：Tauri v2 的 asset 协议默认**不启用**（`protocol-asset` 不在 default features），且 scope 需显式配置；运行时 `app.asset_protocol_scope().allow_directory(vault, true)` 放开库目录
- [x] **踩坑（Milkdown 转义 wikilink）**：remark-stringify 序列化时把 `[[a_b]]` 转义成 `\[\[a\_b]]`（开头的 `[` 及内部 `_`/`*` 强调字符），存盘后 **Obsidian 不识别为双链**（用户实测反馈）。修复：`rich-editor.ts` 的 `markdownUpdated` 回调对 `\[\[(.*?)]]` 区间做定向反转义（`\\([^a-zA-Z0-9])` → `$1`），已用 remark v11 实测全部场景（别名/图片/多链接/多行/特殊字符）round-trip 干净；历史已损坏文件在库内手工修复
- [x] **踩坑（sync 不干扰）**：`assets/` 是 `Obsi_StickeyNoy` 的子目录，notify 监听非递归 + 只处理 `.md`，导入图片不会触发便笺窗口重建

### ✅ v2.1.2 便笺类型系统（note / todo）

- [x] **frontmatter `type` 字段**（serde `rename="type"`，缺省 `note`）：托盘"新建 TODO 便笺"= `create_new_note(color=blue, type=todo)`；boot 按类型选初始模式（todo → 专用 TODO 视图）
- [x] **TODO 纯交互编辑（无 markdown 编辑）**：TODO 便笺**隐藏 ✏️/👁 按钮**，唯一视图 = 交互列表。交互：点复选框打勾、**点文字行内编辑**（Enter/失焦提交、Esc 取消、空值不提交）、**点日期 chip 弹规划面板**（chip 即按钮，无独立 🗓 按钮——用户要求合并减后排空间；无计划信息的行显示淡色"＋ 日期"占位 chip，同样可点）、悬停 × 删除、底部 ＋ 添加任务（新增行自动进入编辑）
- [x] **规划面板**（`src/lib/todo-planner.ts`，用户手绘原型）：开始 🛫 / 结束 📅 两个日期输入（原生 date picker）+ 优先级按钮（无/⏫/🔺/🔼/🔽）+ 删除任务；面板定位在卡片内（锚点右/左/上移自适应），点外部关闭，Enter 快速完成；打开时按行内已有 🛫/📅 预填
- [x] **markdown 内容助手**（`src/lib/todo-view.ts`）：`parseTaskLine/buildTaskLine` 统一解析/重建（`🛫 计划开始` 在前、`📅 到期/结束` 在后，按时间先后；旧文件 ⏳ 兼容解析、重建归一化为 🛫；优先级随行保留）；`toggleTaskInContent / editTaskTextInContent / setTaskMetaInContent / removeTaskFromContent / addTaskToContent` 全部按行号变换、**保持括号完整**；chip 样式 = **白底深字**（用户确认），逾期白底暗红字
- [x] **渲染**：单行排版（ellipsis）、任务文字**加粗**（用户原型确认）、完成 = 柔和绿 `#7bbf8a` 打勾 + 删除线、逾期 = 暗红 `#c0564f` "已逾期"；标题栏 `TODO n/m` 进度
- [x] **外部同步**：`note_external_change` 在 todo 模式重渲染视图（行内编辑进行中则跳过，避免打断输入）；复选框 toggle 链实测（合成点击 + 用户亲手）双向落盘正常
- [x] **便笺命名（v2.1.3）**：标题栏"便笺/TODO"标签后有点击命名区（`#note-name`），点一下变输入框 → Enter/失焦提交 → `note_set_title` 写入 frontmatter `title:`（空则不写），Obsidian 里看历史直观。**踩坑**：命名区在标题栏内，标题栏 pointerdown 拖拽会吞掉点击 → 命名区和输入框需 `pointerdown` stopPropagation。
- [x] **编辑/预览单按钮轮替（v2.1.4）**：普通便笺右上角 ✏️+👁 两个按钮合并为一个 —— 编辑模式显示 👁（点击进预览）、预览模式显示 ✏️（点击回编辑）；**v1 遗留的源码 textarea 模式整体移除**（富文本 WYSIWYG + 预览足够，原始 markdown 交给 Obsidian 编辑）；TODO 便笺仍隐藏该按钮
- [x] **透明度分板块（v2.1.4）**：设置界面一个全局滑块 → **三个独立滑块**（便笺底色 / 内容区 / 标题栏），`config_set_alphas` 一次下发三值实时广播；config 存 `contentAlpha/titleAlpha`（None = 跟随便笺底色 +0.06/+0.04）；标题栏新增白膜背景 `--title-alpha`（0% = 不显示）；已实测配置落盘与实时生效
- [x] **回收站进 Obsidian（v2.1.3）**：删除的便笺移入 **`Trash/`**（非 `.trash`，Obsidian 默认忽略点开头文件夹），删除后仍可在 Obsidian 中打开、看 tag/双链/连线；启动时自动把旧 `.trash/note-*.md` 迁移到 `Trash/`（Obsidian 自己的回收站文件不动）
- [x] **踩坑（任务"消失"bug）**：`toggleTaskInContent` 拼接漏了右括号 `]`（`m[3]` 是 `]` 之后的文本）→ 翻转后行变成 `- [x 文本`，`parseTasks` 匹配不到 → 该行从列表消失且损坏落盘。修复：补 `]`，并统一走 `parseTaskLine/buildTaskLine` 重建；已用合成鼠标点击实测双向翻转（勾选/取消）均正常
- [x] **踩坑（emoji 代理对残留）**：优先级字符类 `[🔺⏫🔼🔽]` **不带 `u` 标志时按码元（UTF-16 code unit）匹配**，其中 🔺🔼🔽 的高位代理 `\ud83d` 会误匹配任意星面 emoji（如 📅）的一半 → 重建任务行时把半个 emoji 当"优先级"追加到行尾。修复：相关正则统一加 `/u` 按码点匹配 + `stripLoneSurrogates` 清洗孤立代理项（防御历史损坏内容）；已用码元级诊断验证

---

## 10. 风险与注意事项

| 风险 | 等级 | 对策 |
|---|---|---|
| 透明窗口限制 | 低 | 已确认透明方案：不能最大化（本应用不需要）、无原生阴影（CSS 自绘）；个别显卡驱动对 layered 窗口合成有 bug，遇到再降级为不透明底色 |
| contenteditable 的 IME/光标问题 | 中 | v1 统一 textarea，预览渲染用只读 DOM |
| 便笺窗口数量多 → 内存增长 | 中 | Tauri 共享 WebView2 进程树 + 懒加载/休眠（§3.3），20 条预算 < 350MB；不达标走 Plan B |
| 云同步文件锁/延迟 | 中 | 原子写 + 重试 + mtime 去重；文档里提示用户 |
| 覆盖用户库文件 | 高 | 只写 `Obsi_StickeyNoy/` 目录；写前读 `updated` 比对；删除只进回收站 |
| 安全基线 | 高 | `contextIsolation: true`、`nodeIntegration: false`、不加载远程 URL |

---

## 11. 项目目录结构草案

```
sticky-notes/
├─ package.json             # 前端构建（vite）
├─ tauri.conf.json          # Tauri 配置（窗口默认、打包）
├─ src-tauri/               # Rust 主进程
│  ├─ Cargo.toml
│  ├─ src/
│  │  ├─ main.rs            # 入口：生命周期、托盘、自启
│  │  ├─ vault.rs           # 库路径、grid.json 读写
│  │  ├─ sync.rs            # notify 监听、原子写、冲突
│  │  ├─ windows.rs         # 便笺窗口创建/移动/置顶/层级/休眠
│  │  └─ grid.rs            # 网格几何、吸附、多显示器
│  └─ capabilities/         # 权限声明
└─ src/                     # 前端（webview，原生 TS）
   ├─ note-window/          # 便笺窗口 UI
   ├─ settings/             # 设置窗口
   └─ shared/
      ├─ types.ts           # NoteMeta / GridConfig（与 Rust 结构镜像）
      └─ constants.ts       # 默认网格参数、颜色表
```

---

## 12. 已确认 & 待确认

**已确认**：

1. **窗口模型**：每便笺一个独立小窗口（Windows 便笺风格）。
2. **技术栈**：**Tauri v2**，内存优先（§3.1、§3.3）。
3. **窗口透明**：透明窗口（便笺无需最大化）；玻璃效果远期用 window-vibrancy（§7.1）。
4. **拖拽手感**：v1 松手吸附，v0.2 加实时磁吸。
5. **任务栏**：隐藏图标（skip_taskbar），托盘统一管理。
6. **新便笺放置**：自动找首个空位，占满级联（默认，可随时改）。
7. **便笺目录名**：`Obsi_StickeyNoy/`。
8. **删除语义**：移入 `.trash/`（Obsidian 回收站）。
9. **网格来源**：支持与桌面图标网格同步（auto-desktop，§6.8）；主显示器 v1、多显示器 v0.2；manual 模式始终可兜底。

**待确认**：

1. **v1 内容格式**：暂定纯 Markdown（textarea）；渲染样式用开源等效方案、富文本（Milkdown/TipTap）列入 v0.3 评估（§7.2）。

---

## 13. v2 实施计划（已确认范围：A 全部 + B 5/6/7 + C 第一个）

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| P1 | **A1 托盘**：tray-icon feature；右键菜单 新建/显示全部/设置/退出；退出 = app.exit（优雅关闭）；左键单击显示全部 | ✅ 日志"tray created"；退出后进程消失、孤儿 WebView2 = 0 |
| P2 | **A2 单实例**：tauri-plugin-single-instance，二次启动聚焦已有实例 | ✅ 双开第二实例自动退出 |
| P3 | **A4 开机自启**：tauri-plugin-autostart + 设置窗口开关（capabilities 补 autostart:*） | ✅ 勾选后注册表 Run 键出现 |
| P4 | **A3 架构收敛**：根因 = 孤儿 WebView2 单例锁；建窗只经统一入口、仅 setup/事件回调；去重以窗口注册表为准 | ✅ 反复新建/开设置无卡死；铁律写入 windows.rs |
| P5 | **B6 跨 DPI**：前端 monitorFromPoint 取落点 scale；后端 pitch 物理→逻辑按显示器换算 | ✅ 实测 sf=1.5 正确归一化 |
| P6 | **B5 多显示器**：monitor 字段生效（设备名）；拖拽按落点显示器吸附；5s 布局轮询重排 | ✅ 拖后 frontmatter monitor=\\.\DISPLAY5 |
| P7 | **B7 网格原点**：注册表 IconSize + SPI_GETICONMETRICS；偏移=(pitch−iconSize)/2 | ✅ 反推格坐标与 frontmatter 完全一致 |
| P8 | **C1 Markdown 预览**：markdown-it + callout/wikilink + KaTeX + mermaid（懒加载） | ✅ 渲染 5696 字符无错误 |
| P9 | 收尾：全量回归（新建/设置/预览/退出/孤儿检查）+ README/DESIGN 更新 | ✅ 全部通过 |

**原则**：每阶段独立可运行、可验证；先构建通过再验证；踩坑结论即时回写 DESIGN。
