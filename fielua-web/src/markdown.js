// A reply's Markdown as the iPhone app draws it: chunks parsed on their
// own (mdsource.js), so a growing reply only parses its last chunk again
// and the chunks above it are never touched; markdown-it with raw HTML off;
// every chunk's HTML cleaned by DOMPurify before it reaches the page; math
// drawn by KaTeX (loaded the first time it is needed). New text arrives in
// the flower's gold and settles into ink.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { chunks, referenceDefinitions, repairStreaming, prepare, restoreCode, FLANK, MATH_OPEN } from "./mdsource.js";
import { detectedLanguage, displayName, escapeHTML, highlightHTML, normalizedHint } from "./highlight.js";

/** As the app: long code shows 40 lines until opened, past 60; long tables 20 rows, past 30. */
export const CODE_LINES_SHOWN = 40;
export const CODE_LINES_COLLAPSED = 60;
export const TABLE_ROWS_SHOWN = 20;
export const TABLE_ROWS_COLLAPSED = 30;
const FADE_MS = 700;

/** Only web and mail addresses are links (the app's MarkdownLinkPolicy). */
export function isAllowedLink(href) {
  return /^(https?:\/\/|mailto:)/i.test(String(href).trim());
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
// `main.py` is a file name, not a link to Paraguay.
md.linkify.set({ fuzzyLink: false, fuzzyIP: false });
// Every link is parsed; the policy decides below whether it stays one.
md.validateLink = () => true;

const infoWord = (info) => (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

md.core.ruler.push("fl_tidy", (state) => {
  const math = state.env.math ?? [];
  const tokens = state.tokens;
  let lastMath = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level === 0 && t.nesting !== -1 && t.type !== "inline") {
      const kind = t.type === "heading_open" ? `h ${t.tag}` : t.type === "hr" ? "hr" : "";
      t.attrJoin("class", kind ? `fl-block ${kind}` : "fl-block");
    }
    if (t.type === "fence" && infoWord(t.info) === "math") lastMath = i;
    if (t.type === "code_block") t.content = restoreCode(t.content, math);
    if (t.type === "th_open" || t.type === "td_open") {
      const style = t.attrGet("style");
      if (style) {
        t.attrs = t.attrs.filter(([name]) => name !== "style");
        const align = /text-align:(left|center|right)/.exec(style);
        if (align) t.attrJoin("class", `al-${align[1]}`);
      }
    }
    if (t.type === "inline" && t.children) t.children = tidyInline(t.children, math, state);
  }
  if (lastMath >= 0 && state.env.closedMath) tokens[lastMath].meta = { pending: true };
});

/** Math placeholders become math, hair spaces go, and a link the policy refuses keeps only its text. */
function tidyInline(children, math, state) {
  const out = [];
  const links = [];
  const text = (content) => {
    const token = new state.Token("text", "", 0);
    token.content = content;
    return token;
  };
  for (const child of children) {
    if (child.type === "text") {
      const content = child.content.includes(FLANK) ? child.content.split(FLANK).join("") : child.content;
      if (!content.includes(MATH_OPEN)) {
        child.content = content;
        if (content) out.push(child);
        continue;
      }
      const pattern = /(\d+)/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(content))) {
        if (match.index > last) out.push(text(content.slice(last, match.index)));
        const item = math[Number(match[1])];
        if (item) {
          const token = new state.Token("fl_math", "", 0);
          token.meta = item;
          out.push(token);
        } else {
          out.push(text(match[0]));
        }
        last = pattern.lastIndex;
      }
      if (last < content.length) out.push(text(content.slice(last)));
      continue;
    }
    if (child.type === "link_open") {
      const allowed = isAllowedLink(child.attrGet("href") ?? "");
      links.push(allowed);
      if (allowed) out.push(child);
      continue;
    }
    if (child.type === "link_close") {
      if (links.pop() !== false) out.push(child);
      continue;
    }
    if (child.type === "image") {
      child.meta = { alt: restoreCode(child.content ?? "", math).split(FLANK).join("") };
    }
    out.push(child);
  }
  return out;
}

const rules = md.renderer.rules;

rules.fl_math = (tokens, i) => {
  const item = tokens[i].meta;
  return `<span class="fl-math${item.display ? " display" : ""}" data-tex="${escapeHTML(item.latex)}">${escapeHTML(item.raw)}</span>`;
};

rules.fence = (tokens, i, options, env) => {
  const token = tokens[i];
  const cls = token.attrGet("class") ?? "fl-block";
  if (infoWord(token.info) === "math") {
    const tex = token.content.replace(/\n$/, "");
    return `<div class="${cls} fl-math display${token.meta?.pending ? " pending" : ""}" data-tex="${escapeHTML(tex)}">${escapeHTML(tex)}</div>`;
  }
  return codeBlock(token.content, token.info, cls, env);
};

rules.code_block = (tokens, i, options, env) => codeBlock(tokens[i].content, "", tokens[i].attrGet("class") ?? "fl-block", env);

function codeBlock(content, info, cls, env) {
  const code = content.endsWith("\n") ? content.slice(0, -1) : content;
  const hint = normalizedHint(info);
  const language = hint ?? (env.live ? null : detectedLanguage(code));
  const name = displayName(language) ?? language ?? "コード";
  const count = code.split("\n").length;
  const collapsible = !env.live && count > CODE_LINES_COLLAPSED;
  return `<div class="${cls} fl-code${collapsible ? " collapsed" : ""}">`
    + `<div class="fl-code-head"><span class="fl-code-lang">${escapeHTML(name)}</span>`
    + `<button type="button" class="fl-copy" data-copy="code">コピー</button></div>`
    + `<pre><code>${highlightHTML(code, language)}</code></pre>`
    + (collapsible ? `<button type="button" class="fl-more" data-more="code" data-rest="${count - CODE_LINES_SHOWN}">残り${count - CODE_LINES_SHOWN}行を表示</button>` : "")
    + `</div>`;
}

rules.table_open = (tokens, i, options, env) => {
  let rows = 0;
  let inBody = false;
  for (let k = i + 1; k < tokens.length && tokens[k].type !== "table_close"; k++) {
    if (tokens[k].type === "tbody_open") inBody = true;
    if (inBody && tokens[k].type === "tr_open") rows++;
  }
  const collapsible = !env.live && rows > TABLE_ROWS_COLLAPSED;
  env.tableRest = collapsible ? rows - TABLE_ROWS_SHOWN : 0;
  const cls = tokens[i].attrGet("class") ?? "fl-block";
  return `<div class="${cls} fl-table${collapsible ? " collapsed" : ""}"><div class="fl-table-scroll"><table>`;
};
rules.table_close = (tokens, i, options, env) => {
  const rest = env.tableRest ?? 0;
  env.tableRest = 0;
  return `</table></div><div class="fl-table-tools">`
    + (rest ? `<button type="button" class="fl-copy fl-rows" data-more="table" data-rest="${rest}">残り${rest}行を表示</button>` : "")
    + `<button type="button" class="fl-copy" data-copy="table">表をコピー</button>`
    + `<button type="button" class="fl-copy" data-copy="tsv">タブ区切りでコピー</button></div></div>`;
};

rules.image = (tokens, i) => {
  const token = tokens[i];
  const src = token.attrGet("src") ?? "";
  const label = `画像：${token.meta?.alt || "説明なし"}`;
  // Pictures from elsewhere are never loaded here; the address opens in a new tab instead.
  return isAllowedLink(src)
    ? `<a class="fl-image-link" href="${escapeHTML(src)}">${escapeHTML(label)}</a>`
    : `<span class="fl-image-link">${escapeHTML(label)}</span>`;
};

const PURIFY = {
  RETURN_DOM_FRAGMENT: true,
  ALLOWED_TAGS: ["a", "p", "br", "strong", "em", "del", "s", "code", "pre", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "button"],
  ALLOWED_ATTR: ["href", "class", "title", "start", "type", "data-tex", "data-copy", "data-more", "data-rest"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // Addresses: web and mail only. The attributes below hold no address, so they skip that check.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ADD_URI_SAFE_ATTR: ["type", "start", "data-tex", "data-copy", "data-more", "data-rest"],
};

/** One chunk as nodes, cleaned. `live` is the chunk still being written. */
export function renderChunk(chunk, definitions, live) {
  let text = chunk;
  let closedMath = false;
  if (live) ({ text, closedMath } = repairStreaming(chunk));
  if (!text.trim()) return [];
  const { text: prepared, math } = prepare(definitions ? `${text}\n\n${definitions}` : text);
  const html = md.render(prepared, { math, live, closedMath });
  // Cleaned in an inert document, then brought into this one.
  const fragment = document.importNode(DOMPurify.sanitize(html, PURIFY), true);
  for (const link of fragment.querySelectorAll("a[href]")) {
    if (!isAllowedLink(link.getAttribute("href"))) { link.removeAttribute("href"); continue; }
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
  }
  for (const element of fragment.querySelectorAll(".fl-math[data-tex]")) renderMath(element);
  return Array.from(fragment.childNodes).filter((node) => node.nodeType === 1);
}

// MARK: Math

let katex = null;
let katexLoading = null;
const mathCache = new Map();

/** KaTeX, loaded once; replies drawn before it arrives get their math as soon as it does. */
export function loadMath() {
  if (katex || katexLoading) return katexLoading ?? Promise.resolve();
  katexLoading = import("katex").then((module) => {
    katex = module.default ?? module;
    for (const element of document.querySelectorAll(".fl-math[data-tex]:not(.drawn):not(.failed):not(.pending)")) renderMath(element);
  }).catch(() => { katexLoading = null; });
  return katexLoading;
}

function renderMath(element) {
  if (element.classList.contains("pending")) return;
  if (!katex) { loadMath(); return; }
  const tex = element.getAttribute("data-tex") ?? "";
  const display = element.classList.contains("display");
  const key = (display ? "D" : "I") + tex;
  let drawn = mathCache.get(key);
  if (drawn === undefined) {
    const holder = document.createElement("span");
    try {
      // trust off: no \href, \url or \htmlClass; sizes and macros bounded.
      katex.render(tex, holder, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, maxSize: 30, maxExpand: 500, output: "htmlAndMathml" });
      drawn = holder;
    } catch {
      drawn = null;
    }
    if (mathCache.size > 600) mathCache.delete(mathCache.keys().next().value);
    mathCache.set(key, drawn);
  }
  if (!drawn) { element.classList.add("failed"); return; }
  element.replaceChildren(...Array.from(drawn.cloneNode(true).childNodes));
  element.classList.add("drawn");
}

// MARK: A reply

const STRUCTURAL = new Set(["TABLE", "THEAD", "TBODY", "TR", "UL", "OL", "BLOCKQUOTE", "DIV"]);

/** Text that fades: everything but the code header, the table's buttons and math (which fades whole). */
function fadingTextNodes(nodes) {
  const found = [];
  for (const root of nodes) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          return node.matches(".fl-code-head, .fl-table-tools, .fl-more, .fl-math") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        // The line breaks between rows and items are no text, and a span there would count as a row.
        if (STRUCTURAL.has(node.parentNode?.nodeName) && !node.data.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node);
  }
  return found;
}

function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  const code = a.charCodeAt(i - 1);
  if (i > 0 && code >= 0xD800 && code <= 0xDBFF) i--;
  return i;
}

function wrapFresh(node, time, now) {
  const span = document.createElement("span");
  span.className = "fl-new";
  const age = Math.max(0, now - time);
  if (age > 0) span.style.animationDelay = `-${Math.round(age)}ms`;
  node.replaceWith(span);
  span.append(node);
}

/** Text that came in the last moment, in spans whose fade carries on from where it was. */
function applyFade(nodes, fresh, now) {
  if (!fresh.length) return;
  const segments = [...fresh].sort((a, b) => b.start - a.start);
  let offset = 0;
  for (const node of fadingTextNodes(nodes)) {
    const length = node.data.length;
    let current = node;
    for (const segment of segments) {
      const a = Math.max(segment.start, offset) - offset;
      const b = Math.min(segment.end, offset + length) - offset;
      if (a >= b) continue;
      if (b < current.data.length) current.splitText(b);
      const middle = a > 0 ? current.splitText(a) : current;
      wrapFresh(middle, segment.time, now);
      if (a === 0) break;
    }
    offset += length;
  }
}

function mathKeys(nodes) {
  const keys = new Set();
  for (const root of nodes) {
    const list = root.matches?.(".fl-math") ? [root] : root.querySelectorAll(".fl-math");
    for (const element of list) keys.add(element.getAttribute("data-tex"));
  }
  return keys;
}

/**
 * The reply in its element, kept in step with its text: unchanged chunks
 * stay as they are (no flicker, nothing jumps), a changed chunk is drawn
 * again in its place.
 */
export class ReplyView {
  constructor(root) {
    this.root = root;
    this.parts = [];
  }

  /** `live`: the reply is still being written; `animate`: new text fades in. */
  update(source, { live = false, animate = false } = {}) {
    const definitions = referenceDefinitions(source);
    const list = chunks(source);
    const now = performance.now();
    for (let i = 0; i < list.length; i++) {
      const isLive = live && i === list.length - 1;
      const key = (isLive ? "L" : "F") + list[i];
      const old = this.parts[i];
      if (old && old.key === key) continue;
      const nodes = renderChunk(list[i], definitions, isLive);
      const drawing = nodes.map((node) => node.outerHTML).join("");
      if (old && old.drawing === drawing) {
        // Finished as it was shown: the nodes on the page stay, and so do their fades.
        old.key = key;
        continue;
      }
      const text = fadingTextNodes(nodes).map((node) => node.data).join("");
      let fresh = [];
      const maths = mathKeys(nodes);
      if (animate) {
        const prefix = old ? commonPrefix(old.text, text) : 0;
        fresh = (old?.fresh ?? [])
          .filter((segment) => now - segment.time < FADE_MS && segment.start < prefix)
          .map((segment) => ({ ...segment, end: Math.min(segment.end, prefix) }));
        if (text.length > prefix) fresh.push({ start: prefix, end: text.length, time: now });
        applyFade(nodes, fresh, now);
        for (const root of nodes) {
          const found = root.matches(".fl-math") ? [root] : root.querySelectorAll(".fl-math");
          for (const element of found) if (!old?.maths.has(element.getAttribute("data-tex"))) element.classList.add("fl-new");
        }
      }
      const anchor = old?.nodes[0] ?? this.anchorAfter(i);
      for (const node of nodes) this.root.insertBefore(node, anchor ?? null);
      for (const node of old?.nodes ?? []) node.remove();
      this.parts[i] = { key, drawing, nodes, text, fresh, maths };
    }
    for (const part of this.parts.splice(list.length)) for (const node of part.nodes) node.remove();
  }

  anchorAfter(index) {
    for (let j = index + 1; j < this.parts.length; j++) if (this.parts[j]?.nodes.length) return this.parts[j].nodes[0];
    return null;
  }
}

// MARK: Copying and opening

function tableRows(table) {
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => cell.textContent.trim()));
}

export function tableMarkdown(table) {
  const rows = tableRows(table);
  if (!rows.length) return "";
  const head = table.tHead?.rows[0];
  const aligns = head ? Array.from(head.cells).map((cell) =>
    cell.classList.contains("al-center") ? ":---:" : cell.classList.contains("al-right") ? "---:" : cell.classList.contains("al-left") ? ":---" : "---") : rows[0].map(() => "---");
  const line = (cells) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  return [line(rows[0]), `| ${aligns.join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

export function tableTSV(table) {
  return tableRows(table).map((cells) => cells.map((cell) => cell.replace(/[\t\n]/g, " ")).join("\t")).join("\n");
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/** A button says `text` for a moment, then its own words again. It keeps its width meanwhile, so what stands beside it stays put. */
export function flash(button, text) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  const say = (words) => {
    button.textContent = words;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) button.animate?.([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  };
  if (!button.style.minWidth) button.style.minWidth = `${button.offsetWidth}px`;
  say(text);
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => { say(original); button.style.minWidth = ""; }, 1600));
}

/** The buttons inside replies: copy code or a table, show the rest of long code or a long table. */
export function attachReplyActions(container) {
  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-copy], button[data-more]");
    if (!button || !container.contains(button)) return;
    const copy = button.getAttribute("data-copy");
    if (copy === "code") {
      const code = button.closest(".fl-code")?.querySelector("pre code")?.textContent ?? "";
      flash(button, (await copyText(code)) ? "コピーしました" : "コピーできません");
      return;
    }
    if (copy === "table" || copy === "tsv") {
      const table = button.closest(".fl-table")?.querySelector("table");
      if (!table) return;
      flash(button, (await copyText(copy === "table" ? tableMarkdown(table) : tableTSV(table))) ? "コピーしました" : "コピーできません");
      return;
    }
    const more = button.getAttribute("data-more");
    const block = button.closest(more === "code" ? ".fl-code" : ".fl-table");
    if (!block) return;
    // Folded again from its end: the button stays under the finger (Safari would leave the reader far below).
    const scroller = block.closest(".scroller");
    const before = button.getBoundingClientRect().top;
    const collapsed = block.classList.toggle("collapsed");
    if (collapsed && scroller) scroller.scrollTop += button.getBoundingClientRect().top - before;
    const rest = button.getAttribute("data-rest");
    button.textContent = collapsed ? `残り${rest}行を表示` : more === "code" ? "折りたたむ" : "表を折りたたむ";
  });
}
