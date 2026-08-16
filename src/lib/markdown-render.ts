// Markdown 渲染器（C1）：markdown-it + Obsidian 风格扩展。
// 全部按需懒加载：首次打开预览时才 import 重型依赖（katex/mermaid），
// 符合内存优先策略（主包保持轻量）。
import "katex/dist/katex.min.css"; // ⚠️ 必须：否则 katex MathML 源码注解会原样显示

type MarkdownItInstance = InstanceType<typeof import("markdown-it").default>;

// 渲染内容为 HTML（异步：按需加载依赖）
export async function renderMarkdown(src: string): Promise<string> {
  const md = await createParser();
  let html = md.render(src);
  html = renderCallouts(html);
  html = await renderMath(html);
  html = await renderMermaid(html);
  return html;
}

async function createParser(): Promise<MarkdownItInstance> {
  const { default: MarkdownItCtor } = await import("markdown-it");
  const md = new MarkdownItCtor({
    html: false, // 不渲染原始 HTML（安全）
    linkify: true,
    breaks: false,
  });

  // ---- wikilink [[...]] → 占位 span（暂不导航）----
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const srcStr = state.src;
    const pos = state.pos;
    if (srcStr.charCodeAt(pos) !== 0x5b /* [ */) return false;
    const end = srcStr.indexOf("]]", pos + 2);
    if (end === -1) return false;
    const target = srcStr.slice(pos + 2, end);
    if (!target || target.includes("|")) {
      // 有别名的 [[目标|别名]] 暂时整体占位
    }
    if (silent) return true;
    const token = state.push("wikilink", "span", 0);
    token.attrs = [["class", "wikilink"]];
    token.content = target.split("|")[0];
    state.pos = end + 2;
    return true;
  });

  // 渲染 wikilink token
  const renderWikilink = (tokens: any[], idx: number) => {
    const t = tokens[idx];
    return `<span class="wikilink" title="内部链接（跳转后续版本）">[[${t.content}]]</span>`;
  };
  md.renderer.rules["wikilink"] = renderWikilink;

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
