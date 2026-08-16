// 日历组件：方正数字 + 点击切换"大字日期"形态 + 可配置样式（背景色/透明度/字体色/纯数字/字体）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";

interface WidgetStyle {
  bg?: string | null;
  bgAlpha?: number | null;
  fg?: string | null;
  noBg?: boolean;
  font?: string | null;
}
interface EffectiveStyle {
  bg: string;
  bgAlpha: number;
  fg: string;
  noBg: boolean;
  font: string;
}
interface NoteSummary {
  id: string;
  title: string;
  note_type: string;
  content: string;
}

const appWindow = getCurrentWindow();
const card = document.getElementById("card") as HTMLElement;
const gridEl = document.getElementById("grid") as HTMLDivElement;
const monthLabel = document.getElementById("month-label") as HTMLSpanElement;
const bigDateEl = document.getElementById("bigdate") as HTMLDivElement;
const bigNumEl = document.getElementById("big-num") as HTMLDivElement;
const bigLabel = document.getElementById("big-label") as HTMLDivElement;

let style: EffectiveStyle = { bg: "#ffffff", bgAlpha: 0.8, fg: "#3c4043", noBg: false, font: "square" };
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let selected = new Date();
let bigMode = false;
const taskMap = new Map<string, string[]>();

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "255,255,255";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
function fontFamily(kind: string): string {
  switch (kind) {
    case "mono":
      return "'Consolas', 'Courier New', monospace";
    case "round":
      return "Roboto, system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif";
    default:
      return "'Bahnschrift', 'Segoe UI', 'Microsoft YaHei', sans-serif";
  }
}
function applyStyle() {
  card.style.background = style.noBg
    ? "transparent"
    : `rgba(${hexToRgb(style.bg)}, ${style.bgAlpha})`;
  card.style.boxShadow = style.noBg ? "none" : "";
  card.style.fontFamily = fontFamily(style.font);
  // 统一字体色：所有文字（日期数字/星期/月份/大字/角标）都走 --fg
  card.style.setProperty("--fg", style.fg);
}

// ---- 任务日期 ----
const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/u;
const SCHED_RE = /[⏳🛫]\s*(\d{4}-\d{2}-\d{2})/u;

async function loadTasks() {
  taskMap.clear();
  try {
    const notes = await invoke<NoteSummary[]>("notes_all");
    for (const n of notes) {
      if (n.note_type !== "todo") continue;
      for (const line of n.content.split("\n")) {
        if (!TASK_RE.test(line)) continue;
        const rest = line.replace(TASK_RE, "$3");
        const due = rest.match(DUE_RE)?.[1];
        const scheduled = rest.match(SCHED_RE)?.[1];
        if (scheduled) pushDate(scheduled, "start");
        if (due) pushDate(due, "end");
      }
    }
  } catch {
    /* ignore */
  }
  render();
}
function pushDate(date: string, kind: string) {
  const arr = taskMap.get(date) ?? [];
  arr.push(kind);
  taskMap.set(date, arr);
}

// ---- 渲染 ----
function render() {
  monthLabel.textContent = `${viewYear}年${viewMonth + 1}月`;
  if (bigMode) {
    renderBigDate();
    return;
  }
  gridEl.innerHTML = "";
  gridEl.classList.remove("hidden");
  bigDateEl.classList.add("hidden");
  const first = new Date(viewYear, viewMonth, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayStr = dateStr(new Date());
  const selStr = dateStr(selected);
  for (let i = 0; i < offset; i++) {
    gridEl.appendChild(emptyCell());
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cell";
    if (ds === todayStr) cell.classList.add("today");
    if (ds === selStr) cell.classList.add("selected");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(d);
    cell.appendChild(num);
    const tasks = taskMap.get(ds);
    if (tasks && tasks.length > 0) {
      const dots = document.createElement("div");
      dots.className = "dots";
      const dot = document.createElement("span");
      dot.className = "dot";
      if (tasks.some((k) => k === "end")) dot.classList.add("due");
      dots.appendChild(dot);
      if (tasks.length > 1) {
        const more = document.createElement("span");
        more.className = "count";
        more.textContent = String(tasks.length);
        dots.appendChild(more);
      }
      cell.appendChild(dots);
    }
    cell.addEventListener("click", () => {
      selected = new Date(viewYear, viewMonth, d);
      render();
    });
    gridEl.appendChild(cell);
  }
}

function emptyCell() {
  const c = document.createElement("div");
  c.className = "cell empty";
  return c;
}

function renderBigDate() {
  gridEl.classList.add("hidden");
  bigDateEl.classList.remove("hidden");
  bigNumEl.textContent = String(selected.getDate());
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  bigLabel.textContent = `${selected.getFullYear()}年${selected.getMonth() + 1}月 周${WEEK[selected.getDay()]}`;
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- 交互 ----
document.getElementById("prev-btn")!.addEventListener("click", (e) => {
  e.stopPropagation();
  viewMonth--;
  if (viewMonth < 0) {
    viewMonth = 11;
    viewYear--;
  }
  render();
});
document.getElementById("next-btn")!.addEventListener("click", (e) => {
  e.stopPropagation();
  viewMonth++;
  if (viewMonth > 11) {
    viewMonth = 0;
    viewYear++;
  }
  render();
});
document.getElementById("close-btn")!.addEventListener("click", () => {
  invoke("widget_toggle", { kind: "calendar", enabled: false }).catch(() => {});
});
// 点击卡片主体（非按钮/真实日期格）→ 切换 月历 ⇄ 大字日期（空单元格也可点）
card.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  const cell = (e.target as HTMLElement).closest(".cell");
  if (cell && !cell.classList.contains("empty")) return;
  bigMode = !bigMode;
  render();
});

// ---- 拖拽（实时磁吸 + 松手吸附保存）----
const titlebar = document.getElementById("titlebar") as HTMLElement;
titlebar.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  appWindow.startDragging().catch(() => {});
});
let moveTimer: number | undefined;
let lastMagnetAt = 0;
appWindow.onMoved(({ payload }) => {
  const now = Date.now();
  if (now - lastMagnetAt > 30) {
    lastMagnetAt = now;
    (async () => {
      try {
        const mon = await monitorFromPoint(payload.x, payload.y);
        const sf = mon?.scaleFactor ?? 1;
        invoke("widget_magnet", { kind: "calendar", x: payload.x / sf, y: payload.y / sf }).catch(() => {});
      } catch {
        /* ignore */
      }
    })();
  }
  window.clearTimeout(moveTimer);
  moveTimer = window.setTimeout(async () => {
    try {
      const mon = await monitorFromPoint(payload.x, payload.y);
      const sf = mon?.scaleFactor ?? 1;
      invoke("widget_move", { kind: "calendar", x: payload.x / sf, y: payload.y / sf }).catch(() => {});
    } catch {
      /* ignore */
    }
  }, 200);
});

// ---- 样式 ----
async function loadStyle() {
  try {
    const cfg = await invoke<{ widgets?: { calendar?: { style?: WidgetStyle } } }>("config_get");
    const s = cfg.widgets?.calendar?.style;
    if (s) {
      if (typeof s.bg === "string") style.bg = s.bg;
      if (typeof s.bgAlpha === "number") style.bgAlpha = s.bgAlpha;
      if (typeof s.fg === "string") style.fg = s.fg;
      if (typeof s.noBg === "boolean") style.noBg = s.noBg;
      if (typeof s.font === "string") style.font = s.font;
    }
  } catch {
    /* ignore */
  }
  applyStyle();
  render();
}
listen<{ kind: string; style: WidgetStyle }>("widget_style_updated", (e) => {
  if (e.payload.kind !== "calendar") return;
  const s = e.payload.style;
  if (typeof s.bg === "string") style.bg = s.bg;
  if (typeof s.bgAlpha === "number") style.bgAlpha = s.bgAlpha;
  if (typeof s.fg === "string") style.fg = s.fg;
  if (typeof s.noBg === "boolean") style.noBg = s.noBg;
  if (typeof s.font === "string") style.font = s.font;
  applyStyle();
  render();
});

window.addEventListener("resize", render);
loadTasks();
setInterval(loadTasks, 60_000);
