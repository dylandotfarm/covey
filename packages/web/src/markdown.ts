/**
 * Markdown-lite to HTML: fences, headers, bullets, numbered lists, inline
 * code, bold, and links. The same subset the TUI paints. Everything is
 * escaped first, so a reply cannot put markup on the page.
 */
import { REF } from "./state.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function inline(s: string): string {
  let out = "";
  // Code spans are taken first, so nothing inside one is read as markup.
  const parts = s.split(/(`[^`]*`)/);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) { out += `<code>${escapeHtml(part.slice(1, -1))}</code>`; continue; }
    let t = escapeHtml(part);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // A `#N` opens the issue or the pull request in the page (#108). The
    // renderer catches the click; the anchor carries only the number.
    t = t.replace(REF, (_, pre, n) => `${pre}<a class="ref" href="#" data-number="${n}">#${n}</a>`);
    out += t;
  }
  return out;
}

export function markdownToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
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
      out.push(`<h${level}>${inline(header[2]!)}</h${level}>`);
      i++; continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
      i++; continue;
    }
    if (line.trim() === "") { flushPara(); closeList(); i++; continue; }
    closeList();
    para.push(line);
    i++;
  }
  flushPara(); closeList();
  return out.join("");
}
