// TODO 规划弹出面板：设置计划开始(⏳)/结束(📅) 日期 + 优先级；可删除任务
// 对应手绘原型：点"选择"→ 跳出 date/time 面板（上面计划开始、下面计划结束）
import type { TodoTask } from "./todo-view";

export interface PlanMeta {
  due?: string;
  scheduled?: string;
  priority?: string;
}

const PRIOS = ["⏫", "🔺", "🔼", "🔽"];

let popup: HTMLDivElement | null = null;

export function closePlanner(): void {
  if (popup) {
    popup.remove();
    popup = null;
  }
}

export function openPlanner(opts: {
  anchor: HTMLElement;
  current: TodoTask;
  onSave: (m: PlanMeta) => void;
  onDelete: () => void;
}): void {
  const card = opts.anchor.closest(".note-card") as HTMLElement | null;
  if (!card) return;
  closePlanner();

  popup = document.createElement("div");
  popup.className = "todo-planner";
  popup.innerHTML = `
    <div class="tp-head"><span>任务规划</span><button class="tp-close" title="关闭">×</button></div>
    <div class="tp-row"><label>开始 🛫</label><input type="date" class="tp-sched"></div>
    <div class="tp-row"><label>结束 📅</label><input type="date" class="tp-due"></div>
    <div class="tp-row"><label>优先级</label><div class="tp-prios"></div></div>
    <div class="tp-hint">上面是计划开始，下面是计划结束 · 更多规划方式后续加</div>
    <div class="tp-foot">
      <button class="tp-del">删除任务</button>
      <span class="tp-spacer"></span>
      <button class="tp-cancel">取消</button>
      <button class="tp-ok">完成</button>
    </div>`;
  card.appendChild(popup);

  const sched = popup.querySelector<HTMLInputElement>(".tp-sched")!;
  const due = popup.querySelector<HTMLInputElement>(".tp-due")!;
  sched.value = opts.current.scheduled ?? "";
  due.value = opts.current.due ?? "";

  // 优先级按钮组
  const prioBox = popup.querySelector<HTMLElement>(".tp-prios")!;
  const noneBtn = document.createElement("button");
  noneBtn.textContent = "无";
  noneBtn.dataset.p = "";
  prioBox.appendChild(noneBtn);
  for (const p of PRIOS) {
    const b = document.createElement("button");
    b.textContent = p;
    b.dataset.p = p;
    prioBox.appendChild(b);
  }
  const setActive = (btn: HTMLButtonElement) => {
    prioBox.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
  };
  const currentP = opts.current.priority ?? "";
  prioBox.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    if ((b.dataset.p ?? "") === currentP) b.classList.add("active");
    b.addEventListener("click", () => setActive(b));
  });

  // 定位：锚点右侧，越界换左侧/上移，始终在卡片内
  const ar = opts.anchor.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const pw = 236;
  let left = ar.right - cr.left + 8;
  if (left + pw > cr.width - 8) left = ar.left - cr.left - pw - 8;
  let top = ar.top - cr.top;
  popup.style.left = Math.max(8, left) + "px";
  popup.style.top = Math.max(8, top) + "px";
  const ph = popup.offsetHeight;
  if (top + ph > cr.height - 8) popup.style.top = Math.max(8, cr.height - ph - 8) + "px";

  const ok = () => {
    const active = prioBox.querySelector<HTMLButtonElement>("button.active");
    const meta: PlanMeta = {
      scheduled: sched.value || undefined,
      due: due.value || undefined,
      priority: active && active.dataset.p ? active.dataset.p : undefined,
    };
    closePlanner();
    opts.onSave(meta);
  };
  popup.querySelector(".tp-close")!.addEventListener("click", closePlanner);
  popup.querySelector(".tp-cancel")!.addEventListener("click", closePlanner);
  popup.querySelector(".tp-del")!.addEventListener("click", () => {
    closePlanner();
    opts.onDelete();
  });
  popup.querySelector(".tp-ok")!.addEventListener("click", ok);
  // Enter 快速完成
  popup.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ok();
    }
  });

  // 点击面板外部关闭（等本次点击事件冒泡结束后再挂）
  setTimeout(() => {
    document.addEventListener("mousedown", function outside(e) {
      if (popup && !popup.contains(e.target as Node)) {
        document.removeEventListener("mousedown", outside);
        closePlanner();
      }
    });
  }, 0);
}
