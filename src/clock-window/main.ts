// 时钟组件：大号数字（可换方正/圆润/等宽字体）+ 可配置样式（背景色/透明度/字体色/纯数字无背景）
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

const appWindow = getCurrentWindow();
const card = document.getElementById("card") as HTMLElement;
const timeEl = document.getElementById("time") as HTMLDivElement;
const dateEl = document.getElementById("date") as HTMLDivElement;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 默认：白底 78%、深灰字、方正字体
let style: EffectiveStyle = { bg: "#ffffff", bgAlpha: 0.78, fg: "#1f1f1f", noBg: false, font: "square" };

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
      return "'Bahnschrift', 'Segoe UI', 'Microsoft YaHei', sans-serif"; // 方正数字
  }
}

function applyStyle() {
  card.style.background = style.noBg
    ? "transparent"
    : `rgba(${hexToRgb(style.bg)}, ${style.bgAlpha})`;
  card.style.boxShadow = style.noBg ? "none" : "";
  timeEl.style.color = style.fg;
  dateEl.style.color = style.fg;
  timeEl.style.fontFamily = fontFamily(style.font);
  dateEl.style.fontFamily = fontFamily(style.font);
}

function tick() {
  const now = new Date();
  timeEl.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${WEEK[now.getDay()]}`;
}
setInterval(tick, 1000);
tick();

// ---- 样式加载与实时更新 ----
async function loadStyle() {
  try {
    const cfg = await invoke<{ widgets?: { clock?: { style?: WidgetStyle } } }>("config_get");
    const s = cfg.widgets?.clock?.style;
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
  tick();
}
listen<{ kind: string; style: WidgetStyle }>("widget_style_updated", (e) => {
  if (e.payload.kind !== "clock") return;
  const s = e.payload.style;
  if (typeof s.bg === "string") style.bg = s.bg;
  if (typeof s.bgAlpha === "number") style.bgAlpha = s.bgAlpha;
  if (typeof s.fg === "string") style.fg = s.fg;
  if (typeof s.noBg === "boolean") style.noBg = s.noBg;
  if (typeof s.font === "string") style.font = s.font;
  applyStyle();
});

document.getElementById("close-btn")!.addEventListener("click", () => {
  invoke("widget_toggle", { kind: "clock", enabled: false }).catch(() => {});
});

// ---- 整卡拖拽（实时磁吸 + 松手吸附保存）----
card.addEventListener("pointerdown", (e) => {
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
        invoke("widget_magnet", { kind: "clock", x: payload.x / sf, y: payload.y / sf }).catch(() => {});
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
      invoke("widget_move", { kind: "clock", x: payload.x / sf, y: payload.y / sf }).catch(() => {});
    } catch {
      /* ignore */
    }
  }, 200);
});

loadStyle();
