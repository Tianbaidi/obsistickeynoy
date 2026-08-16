// TODO 便笺视图：纯交互编辑（不需要 markdown 源码编辑）
// 打勾 = 点复选框；改文字 = 点任务文字行内编辑；规划 = 点 🗓 / 日期chip；删除 = 悬停 ×；添加 = 底部 ＋

export interface TodoTask {
  done: boolean;
  text: string;
  due?: string; // YYYY-MM-DD（计划结束）
  scheduled?: string; // YYYY-MM-DD（计划开始）
  priority?: string; // 🔺 ⏫ 🔼 🔽
}

export interface TodoHandlers {
  onToggle: (i: number) => void;
  onEdit: (i: number, newText: string) => void;
  onPlan: (i: number, anchor: HTMLElement) => void;
  onAdd: () => void;
  onDelete: (i: number) => void;
  onCancel: () => void; // 取消行内编辑 → 重渲染恢复
}

interface TaskParts {
  prefix: string;
  done: boolean;
  text: string;
  due?: string;
  scheduled?: string;
  priority?: string;
}

const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/u;
// 计划开始：新写法 🛫；兼容旧文件里的 ⏳（重建时统一写成 🛫）
const SCHED_RE = /[⏳🛫]\s*(\d{4}-\d{2}-\d{2})/u;
// 注意：字符类里的 🔺🔼🔽 都是星面 emoji（代理对），必须加 u 标志按码点匹配，
// 否则 \ud83d 高位代理会误匹配到任意 emoji（如 📅）的一半 → 重建行时残留半个 emoji
const PRIO_RE = /[🔺⏫🔼🔽]/u;

// 清理孤立代理项（防御：文件里若有历史损坏内容，编辑时顺带洗净）
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE_RE, "");
}

/** 解析单行任务，返回结构或 null */
export function parseTaskLine(line: string): TaskParts | null {
  const m = line.match(TASK_RE);
  if (!m) return null;
  const rest = m[3];
  const due = rest.match(DUE_RE)?.[1];
  const scheduled = rest.match(SCHED_RE)?.[1];
  const priority = rest.match(PRIO_RE)?.[0];
  const text = stripLoneSurrogates(
    rest
      .replace(DUE_RE, "")
      .replace(SCHED_RE, "")
      .replace(PRIO_RE, "")
      .replace(/\s+/g, " ")
      .trim()
  );
  return { prefix: m[1], done: m[2].toLowerCase() === "x", text, due, scheduled, priority };
}

/** 由结构重建任务行 markdown */
export function buildTaskLine(p: TaskParts): string {
  const tokens: string[] = [];
  // 顺序：🛫 开始在前，📅 结束在后（起飞 = 开始，视觉与数据都按时间先后）
  if (p.scheduled) tokens.push(`🛫 ${p.scheduled}`);
  if (p.due) tokens.push(`📅 ${p.due}`);
  if (p.priority) tokens.push(stripLoneSurrogates(p.priority));
  return stripLoneSurrogates(
    `${p.prefix}[${p.done ? "x" : " "}] ${p.text}${tokens.length ? " " + tokens.join(" ") : ""}`
  );
}

/** 解析内容中的任务列表 */
export function parseTasks(content: string): TodoTask[] {
  const tasks: TodoTask[] = [];
  for (const line of content.split("\n")) {
    const p = parseTaskLine(line);
    if (!p) continue;
    tasks.push({ done: p.done, text: p.text, due: p.due, scheduled: p.scheduled, priority: p.priority });
  }
  return tasks;
}

/** 对第 index 条任务行做变换（其余行原样保留） */
function mapTaskLine(content: string, index: number, fn: (p: TaskParts) => TaskParts): string {
  let i = 0;
  return content
    .split("\n")
    .map((line) => {
      const p = parseTaskLine(line);
      if (!p) return line;
      if (i === index) {
        i++;
        return buildTaskLine(fn(p));
      }
      i++;
      return line;
    })
    .join("\n");
}

/** 翻转第 index 条任务的勾选 */
export function toggleTaskInContent(content: string, index: number): string {
  return mapTaskLine(content, index, (p) => ({ ...p, done: !p.done }));
}

/** 修改第 index 条任务的文字（保留日期/优先级元数据） */
export function editTaskTextInContent(content: string, index: number, newText: string): string {
  return mapTaskLine(content, index, (p) => ({ ...p, text: newText }));
}

/** 设置第 index 条任务的计划（due/scheduled/priority；undefined = 清除该项） */
export function setTaskMetaInContent(
  content: string,
  index: number,
  meta: { due?: string; scheduled?: string; priority?: string }
): string {
  return mapTaskLine(content, index, (p) => ({
    ...p,
    due: meta.due,
    scheduled: meta.scheduled,
    priority: meta.priority,
  }));
}

/** 删除第 index 条任务 */
export function removeTaskFromContent(content: string, index: number): string {
  let i = 0;
  return content
    .split("\n")
    .filter((line) => {
      if (!parseTaskLine(line)) return true;
      if (i === index) {
        i++;
        return false;
      }
      i++;
      return true;
    })
    .join("\n");
}

/** 在末尾追加一条新任务 */
export function addTaskToContent(content: string, text: string): string {
  const base = content.trimEnd();
  const line = `- [ ] ${text}`;
  return base ? base + "\n" + line : line;
}

/** 完成数 / 总数 */
export function taskProgress(tasks: TodoTask[]): [number, number] {
  return [tasks.filter((t) => t.done).length, tasks.length];
}

/** 渲染交互式任务列表；返回 startEdit(i) 供外部（如新增后）触发行内编辑 */
export function renderTodo(
  el: HTMLElement,
  tasks: TodoTask[],
  handlers: TodoHandlers
): { startEdit: (i: number) => void } {
  el.innerHTML = "";
  const list = document.createElement("div");
  list.className = "todo-list";

  // ---- 行内编辑：文字 → input，Enter/失焦提交，Esc 取消 ----
  const startEdit = (i: number) => {
    const row = list.querySelectorAll<HTMLElement>(".todo-item")[i];
    if (!row) return;
    const textEl = row.querySelector<HTMLElement>(".todo-text");
    if (!textEl) return;
    const input = document.createElement("input");
    input.className = "todo-edit-input";
    input.value = textEl.textContent ?? "";
    input.spellcheck = false;
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    textEl.replaceWith(input);
    input.focus();
    input.select();
    let closed = false;
    const close = (commit: boolean) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      if (commit && v && v !== (textEl.textContent ?? "")) {
        handlers.onEdit(i, v);
      } else {
        handlers.onCancel();
      }
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
  };

  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "todo-empty";
    empty.textContent = "还没有任务 —— 点下面 ＋ 添加";
    el.appendChild(empty);
  }

  tasks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "todo-item" + (t.done ? " done" : "");

    const check = document.createElement("span");
    check.className = "todo-check";
    check.textContent = t.done ? "✓" : "";
    check.title = t.done ? "取消完成" : "标记完成";

    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = t.text;
    text.title = "点击编辑文字";

    const meta = document.createElement("span");
    meta.className = "todo-meta";
    const parts: string[] = [];
    // 起飞 = 开始时间，排前面；日历 = 结束时间
    if (t.scheduled) parts.push("🛫 " + shortDate(t.scheduled));
    if (t.due) parts.push("📅 " + shortDate(t.due));
    if (t.priority) parts.push(t.priority);
    if (t.due && !t.done && isOverdue(t.due)) {
      meta.classList.add("overdue");
      parts.push("已逾期");
    }
    if (parts.length === 0) {
      // 无计划信息：显示淡色占位 chip，同样可点开规划面板
      meta.classList.add("empty");
      meta.textContent = "＋ 日期";
    } else {
      meta.textContent = parts.join(" · ");
    }
    // 日期/优先级 chip 本身 = 规划按钮（用户要求：合并 🗓 按钮，减后排空间压力）
    meta.title = "点击设置日期/优先级";
    meta.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onPlan(i, meta);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "todo-del-btn";
    delBtn.textContent = "×";
    delBtn.title = "删除任务";

    check.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onToggle(i);
    });
    text.addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit(i);
    });
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onDelete(i);
    });

    row.append(check, text, meta, delBtn);
    list.appendChild(row);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "todo-add";
  addBtn.textContent = "＋ 添加任务";
  addBtn.addEventListener("click", () => handlers.onAdd());
  list.appendChild(addBtn);

  el.appendChild(list);
  return { startEdit };
}

function shortDate(s: string): string {
  return s.slice(5); // MM-DD
}

function isOverdue(due: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(due + "T00:00:00").getTime() < today.getTime();
}
