// 富文本编辑器（S4）：Milkdown（ProseMirror + remark，所见即所得，Markdown 原生序列化）。
// 懒加载：仅在用户切换到"富文本"模式时动态 import（内存优先）。
// ⚠️ 数学公式：编辑器内以 markdown 源码显示（$...$ 原文），预览（👁）里用 katex 渲染。
//    Milkdown 的 math 插件依赖 micromark-extension-math，在当前 micromark 版本组合下会吞掉内容（已实测）。
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { history } from "@milkdown/plugin-history";
import { nord } from "@milkdown/theme-nord";

let editor: Editor | null = null;

/** 创建富文本编辑器（已存在则复用）；onMarkdown 在内容变化时回调 markdown 文本 */
export async function createRichEditor(
  el: HTMLElement,
  content: string,
  onMarkdown: (md: string) => void
): Promise<Editor> {
  if (editor) return editor;
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, el);
      ctx.set(defaultValueCtx, content);
      ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
        if (md !== prev) onMarkdown(md);
      });
    })
    .config(nord)
    .use(commonmark)
    .use(gfm) // 任务列表 / 表格 / 删除线
    .use(history)
    .use(listener)
    .create();
  return editor;
}

/** 销毁编辑器（切回源码/预览模式时释放内存） */
export function destroyRichEditor(): Promise<void> {
  const e = editor;
  editor = null;
  if (!e) return Promise.resolve();
  return e.destroy().then(() => undefined).catch(() => undefined);
}

/** 任务复选框点击切换：点 checkbox 区域（li 左侧 ~22px）→ 翻转 checked → 写回 markdown */
export function setupTaskListToggle(el: HTMLElement): void {
  const elog = (m: string) => {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("frontend_log", { msg: m }).catch(() => {}));
  };
  // 捕获阶段监听：ProseMirror 会在冒泡阶段 stopPropagation，捕获阶段才能先拿到点击
  el.addEventListener(
    "click",
    (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-item-type='task']");
      if (!li) return;
      const rect = li.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      if (dx > 22) return;
      e.preventDefault();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const coords = { left: rect.left + 6, top: rect.top + rect.height / 2 };
        const pos = view.posAtCoords(coords);
        if (!pos) return;
        const resolved = view.state.doc.resolve(pos.pos);
        for (let i = resolved.depth; i >= 0; i--) {
          const node = resolved.node(i);
          if (node.type.name === "list_item" && node.attrs.checked != null) {
            const nodePos = resolved.before(i);
            view.dispatch(
              view.state.tr.setNodeMarkup(nodePos, undefined, {
                ...node.attrs,
                checked: !node.attrs.checked,
              })
            );
            return;
          }
        }
      });
    },
    true
  );
}

/** 外部变更同步：整体替换文档内容 */
export function setRichContent(md: string): void {
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    try {
      const doc = parser(md);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc));
    } catch {
      /* 解析失败保持现状 */
    }
  });
}
