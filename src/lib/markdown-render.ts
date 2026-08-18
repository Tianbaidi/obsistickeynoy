// Markdown 渲染器（C1）：markdown-it + Obsidian 风格扩展。
// 全部按需懒加载：首次打开预览时才 import 重型依赖（katex/mermaid），
// 符合内存优先策略（主包保持轻量）。
import "katex/dist/katex.min.css"; // ⚠️ 必须：否则 katex MathML 源码注解会原样显示
import { convertFileSrc } from "@tauri-apps/api/core";

type MarkdownItInstance = InstanceType<typeof import("markdown-it").default>;

export interface RenderOptions {
  /** Obsidian 库路径：解析 ![[图片]] 嵌入时拼接绝对路径（convertFileSrc 加载） */
  vaultPath?: string;
}

// 渲染内容为 HTML（异步：按需加载依赖）
export async function renderMarkdown(src: string, opts?: RenderOptions): Promise<string> {
  const md = await createParser(opts?.vaultPath);
  let html = md.render(src);
  html = renderCallouts(html);
  html = await renderMath(html);
  html = await renderMermaid(html);
  return html;
}

// ---- 图片嵌入 ![[...]]：解析为 <img>，src 用 asset 协议指向库内文件 ----
// 支持 Obsidian 语法：![[name.png]] / ![[name.png|300]]（指定宽度 px）
function registerImageEmbed(md: MarkdownItInstance, vaultPath?: string): void {
  md.inline.ruler.before("image", "embed-image", (state, silent) => {
    const srcStr = state.src;
    const pos = state.pos;
    if (srcStr.charCodeAt(pos) !== 0x21 /* ! */) return false;
    if (srcStr.charCodeAt(pos + 1) !== 0x5b /* [ */) return false;
    if (srcStr.charCodeAt(pos + 2) !== 0x5b /* [ */) return false;
    const end = srcStr.indexOf("]]", pos + 3);
    if (end === -1) return false;
    if (silent) return true;
    const raw = srcStr.slice(pos + 3, end);
    const [namePart, sizePart] = raw.split("|");
    const name = namePart.trim();
    const token = state.push("embed-image", "span", 0);
    token.attrs = [["class", "embed-image-wrap"]];
    token.content = name;
    token.meta = { name, size: sizePart?.trim() ?? "" };
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules["embed-image"] = (tokens: any[], idx: number) => {
    const t = tokens[idx];
    const name = t.meta.name;
    const size = t.meta.size;
    const abs = resolveAssetPath(name, vaultPath);
    if (!abs) {
      return `<span class="embed-image-missing" title="找不到文件：${escapeHtml(name)}">🖼 ${escapeHtml(
        name
      )}</span>`;
    }
    const src = convertFileSrc(abs);
    const style = /^\d+$/.test(size) ? ` style="width:${parseInt(size, 10)}px"` : "";
    // data-fallback：assets 里没有时换 vault 根目录再试（onerror 在 note-window 里处理）
    return `<img class="embed-image" src="${src}" alt="${escapeHtml(name)}" loading="lazy" title="${escapeHtml(
      name
    )}" data-name="${escapeHtml(name)}" data-fallback="${escapeHtml(
      vaultPath ? convertFileSrc(`${vaultPath}\\${name}`) : ""
    )}"${style}>`;
  };
}

/** 把 ![[name]] 里的名字解析为库内绝对路径（返回 assets 优先路径；vault 根由 onerror 兜底） */
function resolveAssetPath(name: string, vaultPath?: string): string | null {
  // 已经写了绝对路径（盘符 / UNC）
  if (/^[a-zA-Z]:[\\/]|^\\\\/.test(name)) {
    return name;
  }
  if (!vaultPath) return null;
  return `${vaultPath}\\Obsi_StickeyNoy\\assets\\${name}`;
}

// ---- wikilink [[...]] → 可点击 span（预览点击跳转便笺 / 提示）----
function registerWikilink(md: MarkdownItInstance): void {
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const srcStr = state.src;
    const pos = state.pos;
    if (srcStr.charCodeAt(pos) !== 0x5b /* [ */) return false;
    if (srcStr.charCodeAt(pos + 1) !== 0x5b /* [ */) return false;
    const end = srcStr.indexOf("]]", pos + 2);
    if (end === -1) return false;
    const raw = srcStr.slice(pos + 2, end);
    if (!raw) return false;
    if (silent) return true;
    const [target, alias] = raw.split("|");
    const token = state.push("wikilink", "span", 0);
    token.attrs = [["class", "wikilink"]];
    token.content = target;
    token.meta = { target, alias };
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules["wikilink"] = (tokens: any[], idx: number) => {
    const t = tokens[idx];
    const target = t.meta.target;
    const alias = t.meta.alias;
    const base = target.split(/[\\/]/).pop() || target;
    const display = alias || base.replace(/\.md$/i, "");
    return `<span class="wikilink" data-target="${escapeHtml(target)}" title="[[${escapeHtml(
      target
    )}]]">${escapeHtml(display)}</span>`;
  };
}

async function createParser(vaultPath?: string): Promise<MarkdownItInstance> {
  const { default: MarkdownItCtor } = await import("markdown-it");
  const md = new MarkdownItCtor({
    html: false, // 不渲染原始 HTML（安全）
    linkify: true,
    breaks: false,
  });

  registerImageEmbed(md, vaultPath);
  registerWikilink(md);

  return md;
}

// ---- callouts：`> [!note] 标题` → div.callout（Obsidian 风格）----
function renderCallouts(html: string): string {
  // markdown-it 把 blockquote 渲染为 <blockquote><p>[!note] ...</p>...
  return html.replace(
    /<blockquote>\s*<p>\[!(\w+)\]([^<]*)<\/p>([\s\S]*?)<\/blockquote>/g,
    (_m, type: string, title: string, body: string) => {
      const t = type.toLowerCase();
      const safe = t.replace(/[^a-z0-9-]/g, "");
      const heading = title.trim() || t;
      return `<div class="callout callout-${safe}"><div class="callout-title">${escapeHtml(
        heading
      )}</div><div class="callout-body">${body}</div></div>`;
    }
  );
}

// ---- LaTeX：$$...$$ 块级 + $...$ 行内（用 katex 渲染）----
async function renderMath(html: string): Promise<string> {
  if (!html.includes("$")) return html;
  const katex = await import("katex");
  // 块级 $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
    try {
      return `<div class="math-block">${katex.default.renderToString(expr.trim(), {
        displayMode: true,
        throwOnError: false,
      })}</div>`;
    } catch {
      return `<div class="math-block">$$${expr}$$</div>`;
    }
  });
  // 行内 $...$（lookahead 用 Unicode 标点 \p{P}，兼容中文逗号等；u 标志必需）
  html = html.replace(/(^|[\s(>])\$([^$\n]+?)\$(?=[\s\p{P}]|$)/gu, (_m, pre: string, expr: string) => {
    try {
      return `${pre}${katex.default.renderToString(expr.trim(), {
        displayMode: false,
        throwOnError: false,
      })}`;
    } catch {
      return `${pre}$${expr}$`;
    }
  });
  return html;
}

// ---- mermaid：检测 ```mermaid 代码块，按需加载并渲染 ----
async function renderMermaid(html: string): Promise<string> {
  if (!html.includes("language-mermaid")) return html;
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, theme: "default" });
  const id = "mermaid-" + Math.random().toString(36).slice(2, 8);
  const re = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }
  if (blocks.length === 0) return html;
  try {
    const results = await Promise.all(
      blocks.map((b, i) => mermaid.render(`${id}-${i}`, b).catch(() => ""))
    );
    let out = html;
    let idx = 0;
    out = out.replace(re, () => {
      const svg = results[idx++];
      return svg ? `<div class="mermaid">${svg}</div>` : `<pre><code class="language-mermaid">(渲染失败)</code></pre>`;
    });
    return out;
  } catch {
    return html;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
