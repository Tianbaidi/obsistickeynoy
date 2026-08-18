import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";

interface NoteMeta {
  id: string;
  type: string;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: string;
  pinned: boolean;
  monitor: string;
  created: string;
  updated: string;
}
interface NoteDoc {
  meta: NoteMeta;
  content: string;
}

const appWindow = getCurrentWindow();
// 窗口 label = "note_<id>"，后端 state 的 key 是原始 id（<id>）——剥掉前缀
const id = appWindow.label.replace(/^note_/, "");
const richEditorEl = document.getElementById("rich-editor") as HTMLDivElement;
const todoEl = document.getElementById("todo-view") as HTMLDivElement;
const preview = document.getElementById("note-preview") as HTMLDivElement;
const titleEl = document.getElementById("note-title") as HTMLSpanElement;
const labelEl = document.getElementById("note-label") as HTMLSpanElement;
const nameEl = document.getElementById("note-name") as HTMLSpanElement;
const progressEl = document.getElementById("todo-progress") as HTMLSpanElement;
const titlebar = document.getElementById("titlebar") as HTMLElement;
const handle = document.getElementById("resize-handle") as HTMLElement;
const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement;
const richBtn = document.getElementById("rich-btn") as HTMLButtonElement;
const linkBtn = document.getElementById("link-btn") as HTMLButtonElement;
const linkPanel = document.getElementById("link-panel") as HTMLDivElement;
const linkNotes = document.getElementById("link-notes") as HTMLDivElement;

let doc: NoteDoc | null = null;
let saveTimer: number | undefined;
let mode: "rich" | "todo" | "preview" = "rich";
let previewRendering = false;
// 库路径（config_get 拿到）：预览渲染 ![[图片]] 时拼绝对路径
let vaultPath: string | null = null;

// ---- 错误上报到主进程日志（app.log），便于定位 ----
function log(msg: string) {
  invoke("frontend_log", { msg }).catch(() => {});
}
window.addEventListener("error", (e) => log("JS error: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("JS rejection: " + String(e.reason)));

function apply() {
  if (!doc) return;
  const color = doc.meta.color;
  const pinned = doc.meta.pinned;
  document.body.dataset.color = color;
  pinBtn.classList.toggle("active", pinned);
  const pinLabel = document.querySelector(".ctx-pin-label");
  if (pinLabel) pinLabel.textContent = pinned ? "取消置顶" : "置顶";
  document.querySelectorAll<HTMLElement>(".swatch").forEach((s) => {
    s.classList.toggle("active", s.dataset.color === color);
  });
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 800);
}

// ---- 便笺命名：标题栏标签 + 可点击命名区（存入 frontmatter title，Obsidian 可见）----
function renderTitle() {
  if (!doc) return;
  labelEl.textContent = doc.meta.type === "todo" ? "TODO" : "便笺";
  const t = doc.meta.title?.trim() ?? "";
  nameEl.textContent = t || "＋ 标题";
  nameEl.classList.toggle("empty", !t);
  nameEl.title = t ? "点击修改标题" : "点击命名";
}

function startTitleEdit() {
  const input = document.createElement("input");
  input.className = "note-name-input";
  input.value = doc?.meta.title ?? "";
  input.spellcheck = false;
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const close = (commit: boolean) => {
    if (closed) return;
    closed = true;
    const v = input.value.trim();
    if (commit && doc && v !== (doc.meta.title ?? "")) {
      doc.meta.title = v;
      invoke("note_set_title", { id, title: v }).catch((err) => log("set title failed: " + err));
    }
    renderTitle();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    }
  });
  input.addEventListener("blur", () => close(true));
}

nameEl.addEventListener("pointerdown", (e) => e.stopPropagation()); // 不让标题栏拖拽吞掉点击
nameEl.addEventListener("click", (e) => {
  e.stopPropagation();
  startTitleEdit();
});

async function save() {
  if (!doc) return;
  try {
    await invoke("note_save", { id, content: doc.content });
  } catch (e) {
    log("save failed: " + e);
  }
}

// ---- 透明度（v2.1.4 分板块）：底色/内容区/标题栏独立可调 ----
function clampA(v: number, min = 0.0, max = 0.95) {
  return String(Math.max(min, Math.min(max, v)));
}
function applyAlpha(a: { note: number; content?: number | null; title?: number | null }) {
  const note = Math.max(0.05, Math.min(0.95, a.note));
  // 未单独设置时保持旧行为：内容区只比底色略不透明
  const content = a.content ?? Math.min(note + 0.06, 0.8);
  const title = a.title ?? Math.min(note + 0.04, 0.45);
  const root = document.documentElement.style;
  root.setProperty("--note-alpha", clampA(note, 0.05, 0.95));
  root.setProperty("--content-alpha", clampA(content));
  root.setProperty("--title-alpha", clampA(title));
}

async function initAlpha() {
  log("initAlpha: enter");
  try {
    const cfg = await invoke<{ vaultPath?: string; noteAlpha?: number; contentAlpha?: number | null; titleAlpha?: number | null }>(
      "config_get"
    );
    vaultPath = cfg.vaultPath ?? null;
    log("initAlpha: config got, note=" + cfg.noteAlpha + " vault=" + (vaultPath ?? "null"));
    applyAlpha({
      note: cfg.noteAlpha ?? 0.2,
      content: cfg.contentAlpha,
      title: cfg.titleAlpha,
    });
  } catch (e) {
    log("initAlpha: error " + e);
  }
  log("initAlpha: done");
}
listen<{ noteAlpha: number; contentAlpha?: number | null; titleAlpha?: number | null }>("config_updated", (e) => {
  if (typeof e.payload.noteAlpha === "number") {
    applyAlpha({ note: e.payload.noteAlpha, content: e.payload.contentAlpha, title: e.payload.titleAlpha });
  }
});

// ---- 三模式：源码 markdown ⇄ 富文本 Milkdown ⇄ 预览 ----
async function renderPreview() {
  if (!doc || previewRendering) return;
  previewRendering = true;
  try {
    const { renderMarkdown } = await import("../lib/markdown-render");
    preview.innerHTML = await renderMarkdown(doc.content, { vaultPath: vaultPath ?? undefined });
    preview.dataset.colorMode = doc.meta.color;
    log("preview rendered, len=" + preview.innerHTML.length);
  } catch (e) {
    log("preview render failed: " + e);
    preview.innerHTML = "<p style='color:#a00'>渲染失败</p>";
  } finally {
    previewRendering = false;
  }
}

// 挂载富文本（带自愈：首次创建偶发空白 → 销毁重建一次）
function mountRichEditor(attempt: number) {
  const initial = doc?.content ?? "";
  import("../lib/rich-editor")
    .then(({ createRichEditor, setupTaskListToggle }) => {
      setupTaskListToggle(richEditorEl);
      return createRichEditor(richEditorEl, initial, (md) => {
        if (doc && md !== doc.content) {
          doc.content = md;
          scheduleSave();
        }
      });
    })
    .then(() => {
      if (!richEditorEl.querySelector(".ProseMirror") && attempt < 2) {
        log("rich: blank, remount attempt " + attempt);
        import("../lib/rich-editor")
          .then(({ destroyRichEditor }) => destroyRichEditor())
          .then(() => mountRichEditor(attempt + 1))
          .catch((e) => log("rich: remount chain failed " + e));
      } else {
        log("rich editor created" + (attempt > 0 ? " (remounted)" : ""));
      }
    })
    .catch((e) => log("rich editor failed: " + e));
}

function setMode(m: "rich" | "todo" | "preview") {
  // rich/todo 分支总是执行（幂等）；其余模式相同才跳过
  if (m === mode && m !== "rich" && m !== "todo") return;
  // 离开富文本 → 销毁编辑器
  if (mode === "rich" && doc && m !== "rich") {
    import("../lib/rich-editor").then(({ destroyRichEditor }) => destroyRichEditor()).catch(() => {});
  }
  mode = m;
  richEditorEl.classList.toggle("hidden", m !== "rich");
  todoEl.classList.toggle("hidden", m !== "todo");
  preview.classList.toggle("hidden", m !== "preview");
  // 单按钮轮替：编辑模式显示 👁（点击预览），预览模式显示 ✏️（点击回编辑）
  if (m === "preview") {
    richBtn.textContent = "✏️";
    richBtn.title = "返回编辑";
  } else {
    richBtn.textContent = "👁";
    richBtn.title = "预览";
  }
  richBtn.classList.toggle("active", m === "rich" || m === "todo");
  if (m === "rich") {
    mountRichEditor(0);
  } else if (m === "todo") {
    renderTodoView();
  } else {
    renderPreview();
  }
}

/** TODO 视图：纯交互编辑（打勾/行内编辑/规划面板/添加/删除） */
let pendingNewEdit = -1; // 添加任务后要自动进入行内编辑的行号
function renderTodoView() {
  if (!doc) return;
  import("../lib/todo-view")
    .then((mod) => {
      const tasks = mod.parseTasks(doc!.content);
      const { startEdit } = mod.renderTodo(todoEl, tasks, {
        onToggle: (i) => {
          if (!doc) return;
          doc.content = mod.toggleTaskInContent(doc.content, i);
          renderTodoView();
          scheduleSave();
        },
        onEdit: (i, newText) => {
          if (!doc) return;
          doc.content = mod.editTaskTextInContent(doc.content, i, newText);
          renderTodoView();
          scheduleSave();
        },
        onPlan: (i, anchor) => {
          import("../lib/todo-planner").then(({ openPlanner }) => {
            openPlanner({
              anchor,
              current: tasks[i],
              onSave: (meta) => {
                if (!doc) return;
                doc.content = mod.setTaskMetaInContent(doc.content, i, meta);
                renderTodoView();
                scheduleSave();
              },
              onDelete: () => {
                if (!doc) return;
                doc.content = mod.removeTaskFromContent(doc.content, i);
                renderTodoView();
                scheduleSave();
              },
            });
          });
        },
        onAdd: () => {
          if (!doc) return;
          doc.content = mod.addTaskToContent(doc.content, "新任务");
          pendingNewEdit = tasks.length; // 新增行索引 = 当前任务数
          renderTodoView();
          scheduleSave();
        },
        onDelete: (i) => {
          if (!doc) return;
          doc.content = mod.removeTaskFromContent(doc.content, i);
          renderTodoView();
          scheduleSave();
        },
        onCancel: () => renderTodoView(),
      });
      if (pendingNewEdit >= 0) {
        startEdit(pendingNewEdit);
        pendingNewEdit = -1;
      }
      const [d, t] = mod.taskProgress(tasks);
      if (t > 0) {
        progressEl.textContent = `${d}/${t}`;
        progressEl.classList.remove("hidden");
      }
    })
    .catch((e) => log("todo view failed: " + e));
}

// 单按钮轮替：编辑 ⇄ 预览（TODO 便笺按钮已隐藏，此处守卫兜底）
richBtn.addEventListener("click", () => {
  if (doc?.meta.type === "todo") return;
  setMode(mode === "preview" ? "rich" : "preview");
});

// ---- 拖拽（原生拖拽 + moved 事件松手吸附 + 实时磁吸）----
titlebar.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  appWindow
    .startDragging()
    .then(() => log("startDragging ok"))
    .catch((err) => log("startDragging failed: " + err));
});

let moveTimer: number | undefined;
let lastSnapKey = "";
let lastMagnetAt = 0;
appWindow.onMoved(({ payload }) => {
  const now = Date.now();
  if (now - lastMagnetAt > 30) {
    lastMagnetAt = now;
    (async () => {
      try {
        const mon = await monitorFromPoint(payload.x, payload.y);
        const sf = mon?.scaleFactor ?? 1;
        invoke("note_magnet", { id, x: payload.x / sf, y: payload.y / sf }).catch(() => {});
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
      const x = payload.x / sf;
      const y = payload.y / sf;
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (key === lastSnapKey) return;
      lastSnapKey = key;
      log(`drag end -> ${Math.round(x)},${Math.round(y)} (sf=${sf})`);
      await invoke("note_drag_end", { id, x, y });
    } catch (e) {
      log("note_drag_end failed: " + e);
    }
  }, 200);
});

// ---- 缩放（自绘手柄，松手按网格步进）----
let resizing = false;
let rStartW = 0;
let rStartH = 0;
let rOffX = 0;
let rOffY = 0;

handle.addEventListener("pointerdown", (e) => {
  resizing = true;
  rStartW = window.innerWidth;
  rStartH = window.innerHeight;
  rOffX = e.screenX;
  rOffY = e.screenY;
  handle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

handle.addEventListener("pointerup", (e) => {
  if (!resizing) return;
  resizing = false;
  const w = Math.max(140, rStartW + (e.screenX - rOffX));
  const h = Math.max(100, rStartH + (e.screenY - rOffY));
  invoke("note_resize", { id, width: Math.round(w), height: Math.round(h) }).catch((err) =>
    log("note_resize failed: " + err)
  );
});

// ---- 工具栏 ----
pinBtn.addEventListener("click", () => {
  if (!doc) return;
  const next = !doc.meta.pinned;
  doc.meta.pinned = next;
  pinBtn.classList.toggle("active", next);
  invoke("note_set_pinned", { id, pinned: next }).catch((err) => log("pin failed: " + err));
});

document.getElementById("new-btn")!.addEventListener("click", () => {
  invoke("note_new", { note_type: "note" }).catch((err) => log("note_new failed: " + err));
});

document.getElementById("delete-btn")!.addEventListener("click", async () => {
  try {
    const ok = await confirm("删除这张便笺？文件将移入库的 Trash/ 回收站（Obsidian 中仍可见）。", {
      title: "删除便笺",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (ok) {
      await invoke("note_delete", { id });
      log("note_delete invoked");
    }
  } catch (e) {
    log("delete confirm failed: " + e);
  }
});

document.getElementById("close-btn")!.addEventListener("click", () => {
  invoke("note_close", { id }).catch(() => {});
});

// ---- 双链：左下 🔗 按钮 → 链接面板（人性化双链）----
function hideLinkPanel() {
  linkPanel.classList.add("hidden");
  linkBtn.classList.remove("active");
}

/** 把链接文本插入便笺：富文本=光标处；预览=文末；TODO=追加为任务行 */
function insertLink(text: string) {
  if (!doc) return;
  if (mode === "rich") {
    import("../lib/rich-editor")
      .then(({ insertTextAtCursor }) => insertTextAtCursor(text))
      .catch((err) => log("insertTextAtCursor failed: " + err));
  } else if (mode === "todo") {
    doc.content = doc.content.replace(/\s*$/, "") + "\n- [ ] " + text + "\n";
    renderTodoView();
    scheduleSave();
  } else {
    doc.content = (doc.content.trim() ? doc.content.replace(/\s*$/, "") + "\n\n" : "") + text + "\n";
    renderPreview();
    scheduleSave();
  }
  hideLinkPanel();
}

async function refreshLinkPanel() {
  linkNotes.innerHTML = "";
  try {
    const notes = await invoke<{ id: string; title: string; note_type: string }[]>("notes_all");
    const others = notes.filter((n) => n.id !== id);
    if (others.length === 0) {
      linkNotes.innerHTML = '<div class="lp-note-empty">没有其他便笺，可点击下方"选择其他文件"</div>';
      return;
    }
    for (const n of others) {
      const item = document.createElement("div");
      item.className = "lp-note-item";
      const tag = document.createElement("span");
      tag.className = "lp-note-type";
      tag.textContent = n.note_type === "todo" ? "TODO" : "便笺";
      const nm = document.createElement("span");
      nm.className = "lp-note-name";
      nm.textContent = n.title || `note-${n.id}`;
      nm.title = n.title || `note-${n.id}`;
      item.append(tag, nm);
      item.addEventListener("click", () => {
        const target = `note-${n.id}`;
        insertLink(n.title ? `[[${target}|${n.title}]]` : `[[${target}]]`);
      });
      linkNotes.appendChild(item);
    }
  } catch (e) {
    log("link panel refresh failed: " + e);
    linkNotes.innerHTML = '<div class="lp-note-empty">加载便笺列表失败</div>';
  }
}

linkBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const show = linkPanel.classList.contains("hidden");
  if (show) refreshLinkPanel();
  linkPanel.classList.toggle("hidden", !show);
  linkBtn.classList.toggle("active", show);
});

document.getElementById("link-file")!.addEventListener("click", async () => {
  try {
    // 硬盘上任意文件：选择后复制进库内 Obsi_StickeyNoy/assets/，Obsidian 里可见
    const picked = await open({ multiple: false, directory: false });
    if (!picked || Array.isArray(picked)) return; // 用户取消
    const res = await invoke<{ fileName: string; isImage: boolean }>("vault_import_file", {
      source: picked,
    });
    log("imported: " + res.fileName + " image=" + res.isImage);
    insertLink(res.isImage ? `![[${res.fileName}]]` : `[[${res.fileName}]]`);
  } catch (e) {
    log("import file failed: " + e);
  }
});

document.addEventListener("click", (e) => {
  if (
    !linkPanel.classList.contains("hidden") &&
    !(e.target as HTMLElement).closest("#link-panel") &&
    !(e.target as HTMLElement).closest("#link-btn")
  ) {
    hideLinkPanel();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideLinkPanel();
});

// ---- 预览交互：wikilink 点击跳转便笺；图片点击缩放；加载失败回退库根 ----
preview.addEventListener("click", (e) => {
  const wl = (e.target as HTMLElement).closest<HTMLElement>(".wikilink[data-target]");
  if (wl) {
    const target = wl.dataset.target || "";
    const m = target.match(/^note-(n_[0-9a-f]+)$/i);
    if (m) {
      invoke("note_show", { id: m[1] }).catch((err) => log("note_show failed: " + err));
    }
    return;
  }
  const img = (e.target as HTMLElement).closest<HTMLImageElement>("img.embed-image");
  if (img) img.classList.toggle("zoom");
});
// error 事件不冒泡，用捕获阶段在容器上拦截
preview.addEventListener(
  "error",
  (e) => {
    const img = e.target as HTMLImageElement;
    if (img.classList?.contains("embed-image") && img.dataset.fallback && img.src !== img.dataset.fallback) {
      img.src = img.dataset.fallback; // assets 没有 → 试 vault 根目录
    }
  },
  true
);

// ---- 右键菜单 ----
const ctxMenu = document.getElementById("ctx-menu") as HTMLDivElement;

function showCtxMenu(x: number, y: number) {
  ctxMenu.classList.remove("hidden");
  const menuW = ctxMenu.offsetWidth;
  const menuH = ctxMenu.offsetHeight;
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - menuW - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - menuH - 4)}px`;
}

function hideCtxMenu() {
  ctxMenu.classList.add("hidden");
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY);
});
document.addEventListener("click", (e) => {
  if (!ctxMenu.classList.contains("hidden") && !(e.target as HTMLElement).closest("#ctx-menu")) {
    hideCtxMenu();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideCtxMenu();
});

ctxMenu.addEventListener("click", (e) => {
  const swatch = (e.target as HTMLElement).closest<HTMLElement>(".swatch");
  if (swatch) {
    const color = swatch.dataset.color || "yellow";
    if (doc) {
      doc.meta.color = color;
      document.body.dataset.color = color;
      invoke("note_set_color", { id, color }).catch((err) => log("color failed: " + err));
    }
    hideCtxMenu();
    return;
  }
  const item = (e.target as HTMLElement).closest<HTMLElement>(".ctx-item");
  if (!item || !doc) return;
  const action = item.dataset.action;
  switch (action) {
    case "new-note":
      invoke("note_new", { note_type: "note" }).catch((err) => log("note_new failed: " + err));
      break;
    case "new-todo":
      invoke("note_new", { note_type: "todo", color: "blue" }).catch((err) => log("note_new failed: " + err));
      break;
    case "pin": {
      const next = !doc.meta.pinned;
      doc.meta.pinned = next;
      pinBtn.classList.toggle("active", next);
      invoke("note_set_pinned", { id, pinned: next }).catch((err) => log("pin failed: " + err));
      break;
    }
    case "copy": {
      navigator.clipboard
        .writeText(doc.content)
        .then(() => log("copied"))
        .catch((err) => log("copy failed: " + err));
      break;
    }
    case "hide":
      invoke("note_close", { id }).catch(() => {});
      break;
    case "delete": {
      confirm("删除这张便笺？文件将移入库的 Trash/ 回收站（Obsidian 中仍可见）。", {
        title: "删除便笺",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      })
        .then((ok) => ok && invoke("note_delete", { id }).catch((err) => log("delete failed: " + err)))
        .catch((err) => log("delete confirm failed: " + err));
      break;
    }
  }
  hideCtxMenu();
});

// ---- 外部（Obsidian）改动同步 ----
listen<{ id: string; content: string; updated: string }>("note_external_change", (e) => {
  const p = e.payload;
  if (!doc || p.id !== id) return;
  doc.content = p.content;
  doc.meta.updated = p.updated;
  if (mode === "preview") {
    renderPreview();
  } else if (mode === "todo") {
    // 行内编辑进行中不打断（避免输入框被重建）
    if (!todoEl.querySelector(".todo-edit-input")) renderTodoView();
  } else if (document.activeElement && !richEditorEl.contains(document.activeElement)) {
    // 用户不在编辑器内编辑时同步（避免光标/输入冲突）
    import("../lib/rich-editor").then(({ setRichContent }) => setRichContent(p.content)).catch(() => {});
  }
});

// ---- 启动 ----
async function boot() {
  try {
    doc = await invoke<NoteDoc>("note_get", { id });
    apply();
    renderTitle();
    log("note_get ok: " + id);
  } catch (e) {
    log("note_get failed: " + e);
  }
  await initAlpha();
  if (doc?.meta.type === "todo") {
    // TODO 便笺：纯交互视图，隐藏编辑/预览轮替按钮
    richBtn.classList.add("hidden");
    setMode("todo");
  } else {
    setMode("rich"); // 默认富文本（懒加载创建）
  }
}

boot();
