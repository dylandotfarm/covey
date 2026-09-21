/**
 * Markdown-lite to HTML: fences, headers, bullets, numbered lists, inline
 * code, bold, and links. The same subset the TUI paints. Everything is
 * escaped first, so a reply cannot put markup on the page.
 */
import { REF, mediaKind } from "./state.js";

/**
 * How the page loads a piece of media. The renderer hands in a mapper that
 * routes a GitHub attachment through the daemon (#110); the default leaves
 * every URL as it is, which is what the tests see.
 */
export interface MarkdownOptions {
  media?: (url: string) => string;
}

/** An inline image, sized by the style sheet, that opens full size on a tap. */
function image(url: string, alt: string, o: MarkdownOptions): string {
  return `<img class="media" src="${o.media?.(url) ?? url}" alt="${alt}" data-full="${url}" loading="lazy">`;
}

/** An inline video with its own controls, which include full screen. */
function video(url: string, o: MarkdownOptions): string {
  return `<video class="media" src="${o.media?.(url) ?? url}" controls playsinline preload="metadata"></video>`;
}

/** A safe `src`: escaped, and only http(s). Anything else stays text. */
const SRC = /^https?:\/\/[^\s<>"']+$/;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function inline(s: string, o: MarkdownOptions = {}): string {
  let out = "";
  // Code spans are taken first, so nothing inside one is read as markup.
  const parts = s.split(/(`[^`]*`)/);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) { out += `<code>${escapeHtml(part.slice(1, -1))}</code>`; continue; }
    // An `<img>` tag is what GitHub's own form writes for a dropped image.
    // It is read before the escape, and only its `src` and `alt` survive.
    const tags: string[] = [];
    const held = part.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (tag, src: string) => {
      if (!SRC.test(src)) return tag;
      const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "";
      tags.push(image(escapeHtml(src), escapeHtml(alt), o));
      return `\u0000${tags.length - 1}\u0000`;
    });
    let t = escapeHtml(held);
    t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => image(url, alt, o));
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // A `#N` opens the issue or the pull request in the page (#108). The
    // renderer catches the click; the anchor carries only the number.
    t = t.replace(REF, (_, pre, n) => `${pre}<a class="ref" href="#" data-number="${n}">#${n}</a>`);
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => tags[Number(i)]!);
    out += t;
  }
  return out;
}

export function markdownToHtml(text: string, o: MarkdownOptions = {}): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map((l) => inline(l, o)).join("<br>")}</p>`); para = []; } };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushPara(); closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++; // the closing fence, or the end
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    if (header) {
      flushPara(); closeList();
      const level = Math.min(header[1]!.length, 3);
      out.push(`<h${level}>${inline(header[2]!, o)}</h${level}>`);
      i++; continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet ?? numbered)![1]!, o)}</li>`);
      i++; continue;
    }
    if (line.trim() === "") { flushPara(); closeList(); i++; continue; }
    // A URL alone on a line is media when it is a video or an image: the way
    // GitHub's form puts a video in, and the way covey does (#110).
    const bare = /^\s*(https?:\/\/[^\s<>"']+)\s*$/.exec(line);
    const kind = bare && SRC.test(bare[1]!) ? mediaKind(bare[1]!) : null;
    if (kind) {
      flushPara(); closeList();
      const url = escapeHtml(bare![1]!);
      out.push(`<p class="media-p">${kind === "video" ? video(url, o) : image(url, "", o)}</p>`);
      i++; continue;
    }
    closeList();
    para.push(line);
    i++;
  }
  flushPara(); closeList();
  return out.join("");
}
