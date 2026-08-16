import { invoke } from "@tauri-apps/api/core";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";

const input = document.getElementById("vault-path") as HTMLInputElement;
const status = document.getElementById("status") as HTMLDivElement;

// ---- 开机自启 ----
const autostartChk = document.getElementById("autostart-chk") as HTMLInputElement;
isEnabled()
  .then((v) => (autostartChk.checked = v))
  .catch(() => {});
autostartChk.addEventListener("change", () => {
  if (autostartChk.checked) {
    enable().catch((e) => {
      status.textContent = `自启开启失败：${e}`;
      autostartChk.checked = false;
    });
  } else {
    disable().catch((e) => {
      status.textContent = `自启关闭失败：${e}`;
      autostartChk.checked = true;
    });
  }
});

async function boot() {
  try {
    const cfg = await invoke<{ vaultPath: string | null }>("config_get");
    if (cfg.vaultPath) input.value = cfg.vaultPath;
  } catch {
    /* 忽略 */
  }
}
boot();

document.getElementById("save-btn")!.addEventListener("click", async () => {
  try {
    await invoke("config_set_vault", { path: input.value });
    status.textContent = "已保存并加载 ✅";
  } catch (e) {
    status.textContent = `错误：${e}`;
  }
});

document.getElementById("resync-btn")!.addEventListener("click", async () => {
  try {
    await invoke("grid_resync");
    status.textContent = "已重新同步桌面图标网格 ✅";
  } catch (e) {
    status.textContent = `错误：${e}`;
  }
});

document.getElementById("showall-btn")!.addEventListener("click", async () => {
  try {
    await invoke("notes_show_all");
    status.textContent = "已显示全部便笺 ✅";
  } catch (e) {
    status.textContent = `错误：${e}`;
  }
});

document.getElementById("quit-btn")!.addEventListener("click", () => {
  invoke("app_quit").catch(() => {});
});

// ---- 透明度（分板块：底色/内容区/标题栏，实时广播）----
const noteSlider = document.getElementById("note-slider") as HTMLInputElement;
const noteValue = document.getElementById("note-value") as HTMLSpanElement;
const contentSlider = document.getElementById("content-slider") as HTMLInputElement;
const contentValue = document.getElementById("content-value") as HTMLSpanElement;
const titleSlider = document.getElementById("title-slider") as HTMLInputElement;
const titleValue = document.getElementById("title-value") as HTMLSpanElement;

async function pushAlphas() {
  invoke("config_set_alphas", {
    alpha: {
      noteAlpha: Number(noteSlider.value) / 100,
      contentAlpha: Number(contentSlider.value) / 100,
      titleAlpha: Number(titleSlider.value) / 100,
    },
  }).catch(() => {});
}

function bindSlider(slider: HTMLInputElement, valueEl: HTMLSpanElement) {
  slider.addEventListener("input", () => {
    valueEl.textContent = slider.value + "%";
    pushAlphas();
  });
}

invoke<{ noteAlpha?: number; contentAlpha?: number | null; titleAlpha?: number | null }>("config_get")
  .then((cfg) => {
    const note = typeof cfg.noteAlpha === "number" ? cfg.noteAlpha : 0.2;
    const content = typeof cfg.contentAlpha === "number" ? cfg.contentAlpha : Math.min(note + 0.06, 0.8);
    const title = typeof cfg.titleAlpha === "number" ? cfg.titleAlpha : Math.min(note + 0.04, 0.45);
    noteSlider.value = String(Math.round(note * 100));
    noteValue.textContent = noteSlider.value + "%";
    contentSlider.value = String(Math.round(content * 100));
    contentValue.textContent = contentSlider.value + "%";
    titleSlider.value = String(Math.round(title * 100));
    titleValue.textContent = titleSlider.value + "%";
  })
  .catch(() => {});

bindSlider(noteSlider, noteValue);
bindSlider(contentSlider, contentValue);
bindSlider(titleSlider, titleValue);

// ---- 桌面小组件开关（日历 / 时钟）----
const calChk = document.getElementById("widget-calendar-chk") as HTMLInputElement;
const clockChk = document.getElementById("widget-clock-chk") as HTMLInputElement;

invoke<{ widgets?: { calendar?: { enabled?: boolean }; clock?: { enabled?: boolean } } }>("config_get")
  .then((cfg) => {
    calChk.checked = !!cfg.widgets?.calendar?.enabled;
    clockChk.checked = !!cfg.widgets?.clock?.enabled;
  })
  .catch(() => {});

calChk.addEventListener("change", () => {
  invoke("widget_toggle", { kind: "calendar", enabled: calChk.checked }).catch((e) => {
    status.textContent = `日历组件切换失败：${e}`;
    calChk.checked = !calChk.checked;
  });
});
clockChk.addEventListener("change", () => {
  invoke("widget_toggle", { kind: "clock", enabled: clockChk.checked }).catch((e) => {
    status.textContent = `时钟组件切换失败：${e}`;
    clockChk.checked = !clockChk.checked;
  });
});

// ---- 小组件样式（背景色/透明度/字体色/字体/仅数字）----
function bindWidgetStyle(kind: "clock" | "calendar", ids: { bg: string; alpha: string; alphaV: string; fg: string; noBg: string; font: string }) {
  const bg = document.getElementById(ids.bg) as HTMLInputElement;
  const alpha = document.getElementById(ids.alpha) as HTMLInputElement;
  const alphaV = document.getElementById(ids.alphaV) as HTMLSpanElement;
  const fg = document.getElementById(ids.fg) as HTMLInputElement;
  const noBg = document.getElementById(ids.noBg) as HTMLInputElement;
  const font = document.getElementById(ids.font) as HTMLSelectElement;
  const push = () => {
    invoke("widget_style_set", {
      kind,
      style: {
        bg: bg.value,
        bgAlpha: Number(alpha.value) / 100,
        fg: fg.value,
        noBg: noBg.checked,
        font: font.value,
      },
    }).catch((e) => (status.textContent = `样式保存失败：${e}`));
  };
  bg.addEventListener("input", push);
  fg.addEventListener("input", push);
  noBg.addEventListener("change", push);
  font.addEventListener("change", push);
  alpha.addEventListener("input", () => {
    alphaV.textContent = alpha.value + "%";
    push();
  });
  return { bg, alpha, alphaV, fg, noBg, font };
}

const clockStyle = bindWidgetStyle("clock", {
  bg: "clock-bg",
  alpha: "clock-bgalpha",
  alphaV: "clock-bgalpha-v",
  fg: "clock-fg",
  noBg: "clock-nobg",
  font: "clock-font",
});
const calStyle = bindWidgetStyle("calendar", {
  bg: "cal-bg",
  alpha: "cal-bgalpha",
  alphaV: "cal-bgalpha-v",
  fg: "cal-fg",
  noBg: "cal-nobg",
  font: "cal-font",
});

interface StyleCfg {
  bg?: string | null;
  bgAlpha?: number | null;
  fg?: string | null;
  noBg?: boolean;
  font?: string | null;
}
invoke<{ widgets?: { clock?: { style?: StyleCfg }; calendar?: { style?: StyleCfg } } }>("config_get")
  .then((cfg) => {
    const apply = (el: HTMLInputElement, v: string | null | undefined, def: string) => {
      if (typeof v === "string" && v) el.value = v;
      else el.value = def;
    };
    const cs = cfg.widgets?.clock?.style;
    apply(clockStyle.bg, cs?.bg, "#ffffff");
    apply(clockStyle.fg, cs?.fg, "#1f1f1f");
    if (typeof cs?.font === "string" && cs.font) clockStyle.font.value = cs.font;
    const ca = typeof cs?.bgAlpha === "number" ? cs.bgAlpha : 0.78;
    clockStyle.alpha.value = String(Math.round(ca * 100));
    clockStyle.alphaV.textContent = clockStyle.alpha.value + "%";
    clockStyle.noBg.checked = !!cs?.noBg;
    const s2 = cfg.widgets?.calendar?.style;
    apply(calStyle.bg, s2?.bg, "#ffffff");
    apply(calStyle.fg, s2?.fg, "#3c4043");
    if (typeof s2?.font === "string" && s2.font) calStyle.font.value = s2.font;
    const ca2 = typeof s2?.bgAlpha === "number" ? s2.bgAlpha : 0.8;
    calStyle.alpha.value = String(Math.round(ca2 * 100));
    calStyle.alphaV.textContent = calStyle.alpha.value + "%";
    calStyle.noBg.checked = !!s2?.noBg;
  })
  .catch(() => {});
