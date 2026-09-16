import { questionAnswers, questionAsks, type TimelineItem, type ToolCallItem } from "@covey/protocol";
import { linkSpans, targetUri, toolLink, type LinkContext } from "./links.js";
import { T } from "./theme.js";

/**
 * Pure rendering of timeline items into styled lines. Doing this outside React
 * gives us exact line counts, so the transcript can be scrolled and
 * virtualised (only visible lines become <Text> nodes).
 */
export interface Span {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  /**
   * What a click on this span opens, as a URI. Held apart from `text` on
   * purpose: an OSC 8 escape inside `text` would be counted as printable
   * columns by `width()` below, and the wrap would be wrong.
   */
  link?: string;
}
export type Line = Span[];

export function width(s: string): number {
  // cheap approximation: count code points, wide CJK/emoji as 2
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += cp > 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return w;
}

/**
 * Word-wrap a single paragraph of spans to `w` columns.
 *
 * `links` turns on link detection, which runs *before* the wrap: a path that
 * crosses a row boundary is scanned whole here, and each piece the wrap cuts
 * keeps the `link` field, so both rows open the same file.
 */
export function wrapSpans(spans: Span[], w: number, links?: LinkContext): Line[] {
  if (links) spans = linkSpans(spans, links);
  const lines: Line[] = [];
  let cur: Line = [];
  let curW = 0;
  const push = (sp: Span) => { cur.push(sp); curW += width(sp.text); };
  const flush = () => {
    while (cur.length && /^\s+$/.test(cur[cur.length - 1]!.text)) cur.pop();
    lines.push(cur); cur = []; curW = 0;
  };
  for (const sp of spans) {
    const tokens = sp.text.split(/(\s+)/).filter((t) => t.length > 0);
    for (const tok of tokens) {
      const tw = width(tok);
      if (curW + tw <= w) { push({ ...sp, text: tok }); continue; }
      if (/^\s+$/.test(tok)) { flush(); continue; }
      if (tw > w) {
        // hard-break a very long token
        let rest = tok;
        while (width(rest) > 0) {
          const room = w - curW;
          if (room <= 0) flush();
          let take = "";
          for (const ch of rest) { if (width(take + ch) > (w - curW)) break; take += ch; }
          push({ ...sp, text: take });
          rest = rest.slice(take.length);
          if (width(rest) > 0) flush();
        }
        continue;
      }
      flush();
      push({ ...sp, text: tok });
    }
  }
  if (cur.length || lines.length === 0) lines.push(cur);
  // trim leading whitespace spans on wrapped lines
  return lines.map((l, i) => (i === 0 ? l : trimLeading(l)));
}

function trimLeading(l: Line): Line {
  const out = [...l];
  while (out.length && /^\s+$/.test(out[0]!.text)) out.shift();
  return out;
}

/** Minimal markdown: fences, headers, bullets, inline code, bold, links. */
export function markdownToLines(text: string, w: number, base: Partial<Span> = {}, links?: LinkContext): Line[] {
  const out: Line[] = [];
  const src = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceLang = "";
  for (const raw of src) {
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceLang = fence[1] ?? ""; out.push([{ text: fenceLang ? ` ${fenceLang} ` : " ", color: T.subtle, bg: T.surfaceAlt }]); }
      else { inFence = false; }
      continue;
    }
    if (inFence) {
      const padded = raw.length < w ? raw + " ".repeat(Math.max(0, w - width(raw))) : raw;
      for (const l of wrapSpans([{ text: padded, color: T.code, bg: T.surface }], w, links)) out.push(l);
      continue;
    }
    if (raw.trim() === "") { out.push([]); continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(...wrapSpans(inline(h[2]!, { ...base, bold: true, color: T.text }, links), w, links)); continue; }
    const bullet = raw.match(/^(\s*)([-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1]!.length;
      const marker = bullet[2] === "-" || bullet[2] === "*" ? "•" : bullet[2]!;
      const lead = " ".repeat(indent) + marker + " ";
      const body = wrapSpans(inline(bullet[3]!, base, links), Math.max(10, w - width(lead)), links);
      body.forEach((l, i) => out.push([{ text: i === 0 ? lead : " ".repeat(width(lead)), color: T.subtle }, ...l]));
      continue;
    }
    out.push(...wrapSpans(inline(raw, base, links), w, links));
  }
  return out;
}

function inline(s: string, base: Partial<Span>, links?: LinkContext): Span[] {
  const spans: Span[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) spans.push({ ...base, text: s.slice(last, m.index) });
    if (m[1]) spans.push({ ...base, text: m[1].slice(1, -1), color: T.code });
    // A markdown link hides its target, so the label is coloured to say that
    // there is one. `[text](url)` used to render as its own raw source.
    else if (m[4] !== undefined) {
      const uri = links ? targetUri(m[5]!, links) : null;
      spans.push(uri ? { ...base, text: m[4], color: T.info, link: uri } : { ...base, text: m[4], color: T.info });
    }
    else spans.push({ ...base, text: m[0].slice(2, -2), bold: true, color: T.text });
    last = m.index + m[0].length;
  }
  if (last < s.length) spans.push({ ...base, text: s.slice(last) });
  return spans;
}

/**
 * How far the user has got through a pending `AskUserQuestion`. The questions
 * are stepped through one at a time, so the renderer needs both the row the
 * cursor sits on and the answers already given.
 */
export interface QuestionUi {
  /** Highlighted row of the current question; `options.length` = the free-text row. */
  cursor: number;
  /** One answer for each question already stepped past, in order. */
  answered: string[];
}

export interface RenderOpts {
  width: number;
  expanded: Set<string>;
  question?: QuestionUi;
  /** Turns paths and URLs into links. Omit it to draw plain text. */
  links?: LinkContext;
}

/** Render one item to lines, including its trailing blank line. */
export function renderItem(item: TimelineItem, o: RenderOpts): Line[] {
  const w = Math.max(20, o.width);
  switch (item.kind) {
    case "user": {
      const inner = Math.min(w - 4, Math.max(20, Math.floor(w * 0.8)));
      const body = markdownToLines(item.text, inner, { color: T.text }, o.links);
      const lines: Line[] = body.map((l) => {
        const lw = l.reduce((a, s) => a + width(s.text), 0);
        return [{ text: "  ", bg: T.userBg }, ...l.map((s) => ({ ...s, bg: T.userBg })), { text: " ".repeat(Math.max(0, inner - lw)) + "  ", bg: T.userBg }];
      });
      if (item.attachments.length) lines.push([{ text: "  " + item.attachments.map((a) => `⎘ ${a.name}`).join("  "), color: T.subtle }]);
      // Deliberately not "will be read next": the CLI folds this in at a tool
      // boundary and does not say when, so claiming a moment would be a guess.
      if (item.folded) lines.push([{ text: "  ↳ sent into the turn already running", color: T.info, italic: true }]);
      else if (item.queued) lines.push([{ text: "  queued · will send when the current turn finishes", color: T.subtle, italic: true }]);
      lines.push([]);
      return lines;
    }
    case "assistant": {
      const lines = markdownToLines(item.text, w - 2, { color: T.text }, o.links).map((l) => [{ text: "  " }, ...l]);
      if (item.streaming) { const last = lines[lines.length - 1] ?? []; lines[lines.length - 1] = [...last, { text: "▍", color: T.accent }]; }
      lines.push([]);
      return lines;
    }
    case "thinking": {
      const open = o.expanded.has(item.id);
      const head: Line = [{ text: "  ", }, { text: open ? "▾" : "▸", color: T.subtle }, { text: item.streaming ? " thinking…" : " thought", color: T.subtle, italic: true }];
      if (!open) return [head];
      return [head, ...markdownToLines(item.text, w - 6, { color: T.subtle, italic: true }, o.links).map((l) => [{ text: "    " }, ...l])];
    }
    case "tool": {
      const bg = item.background;
      const icon = bg ? (bg.state === "running" ? "⇥" : bg.state === "failed" ? "✗" : bg.state === "stopped" ? "⊘" : "✓")
        : item.status === "running" ? "◐" : item.status === "error" ? "✗" : item.status === "denied" ? "⊘" : "✓";
      const color = bg ? (bg.state === "running" ? T.info : bg.state === "failed" ? T.danger : bg.state === "stopped" ? T.warning : T.success)
        : item.status === "running" ? T.working : item.status === "error" ? T.danger : item.status === "denied" ? T.warning : T.success;
      const open = o.expanded.has(item.id);
      // The summary is already cut to 80 characters by `summariseTool`, so a
      // link found in *that* text would point at nothing. The target comes
      // from the tool input, which travels whole on the item.
      const link = toolLink(item.input, o.links);
      const head: Line = [{ text: "  " }, { text: icon, color }, { text: " " }, { text: item.summary, color: T.muted, link }];
      // A backgrounded call has no duration worth showing until it settles —
      // the turn stopped waiting, the work did not stop.
      if (bg) head.push({ text: bg.state === "running" ? "  in the background" : bg.state === "completed" ? "  background · done" : `  background · ${bg.state}`, color: bg.state === "running" ? T.info : T.faint });
      else if (item.durationMs != null && item.status !== "running") head.push({ text: `  ${fmtMs(item.durationMs)}`, color: T.faint });
      // The CLI's task summary restates the call's own description, so on a
      // clean finish "background · done" has already said it. It earns the
      // room only when the task did not simply succeed.
      if (bg?.summary && (bg.state === "failed" || bg.state === "stopped")) head.push({ text: `  ${bg.summary}`, color: T.danger });
      const headLines = wrapSpans(head, w);
      if (!open) return headLines;
      const out = [...headLines];
      if (bg?.summary) out.push(...wrapSpans([{ text: "    background: " + bg.summary, color: T.subtle }], w, o.links));
      if (bg?.outputFile) out.push(...wrapSpans([{ text: "    output file " + bg.outputFile, color: T.faint }], w, o.links));
      const input = JSON.stringify(item.input, null, 2) ?? "";
      out.push([{ text: "    input", color: T.faint }]);
      for (const l of input.split("\n").slice(0, 40)) out.push(...wrapSpans([{ text: "    " + l, color: T.subtle }], w, o.links));
      if (item.output != null) {
        out.push([{ text: "    output", color: T.faint }]);
        const outLines = item.output.split("\n");
        for (const l of outLines.slice(0, 60)) out.push(...wrapSpans([{ text: "    " + l, color: item.isError ? T.danger : T.subtle }], w, o.links));
        if (outLines.length > 60) out.push([{ text: `    … ${outLines.length - 60} more lines`, color: T.faint }]);
      }
      out.push([]);
      return out;
    }
    case "approval": {
      const pending = item.status === "pending";
      const color = pending ? T.warning : item.status === "allowed" ? T.success : T.subtle;
      const label = pending ? "needs approval" : item.status;
      const lines = wrapSpans([{ text: "  " }, { text: "⚠", color }, { text: ` ${item.toolName}: `, color: T.text, bold: pending }, { text: item.summary, color: T.muted }, { text: `  ${label}`, color }], w);
      if (pending) {
        const detail = item.toolName === "Bash" ? String((item.input as any)?.command ?? "") : JSON.stringify(item.input);
        for (const l of detail.split("\n").slice(0, 12)) lines.push(...wrapSpans([{ text: "    " + l, color: T.code }], w, o.links));
        lines.push([{ text: "    y", color: T.accent, bold: true }, { text: " allow  ", color: T.muted }, { text: "a", color: T.accent, bold: true }, { text: " always allow  ", color: T.muted }, { text: "n", color: T.accent, bold: true }, { text: " deny", color: T.muted }]);
      }
      return lines;
    }
    case "question": {
      const pending = item.status === "pending";
      const asks = questionAsks(item);
      const cursor = o.question?.cursor ?? 0;
      // While the request is open the answers live in the client, because the
      // daemon only hears them once the whole set is sent.
      const answered = pending ? o.question?.answered ?? [] : questionAnswers(item);
      // The question being answered now. Past the end once the last answer is
      // in and the round trip to the daemon has not landed yet.
      const current = pending ? answered.length : -1;
      const lines: Line[] = [];
      asks.forEach((ask, qi) => {
        // Questions ahead of the current one stay hidden: the user cannot act
        // on them yet, and the counter already says they are coming. A settled
        // item shows the lot, answered or expired.
        if (pending && qi > current) return;
        const live = qi === current;
        const opts = ask.options ?? [];
        const count = asks.length > 1 ? ` (${qi + 1} of ${asks.length})` : "";
        lines.push(...wrapSpans([
          { text: "  " }, { text: "?", color: T.awaiting, bold: true },
          { text: " " + ask.question, color: T.text },
          ...(count ? [{ text: count, color: T.faint }] : []),
        ], w, o.links));
        // An answered question in a set keeps only its answer; repeating every
        // option it had would bury the one still being asked.
        if (live || asks.length === 1) {
          opts.forEach((op, i) => {
            const sel = live && cursor === i;
            lines.push(...wrapSpans([
              { text: sel ? "  ❯ " : "    ", color: T.accent, bold: true },
              { text: `${i + 1}. `, color: live ? T.accent : T.subtle, bold: live },
              { text: op.label, color: T.text, bg: sel ? T.selection : undefined, bold: sel },
              ...(op.description ? [{ text: ` — ${op.description}`, color: T.subtle, bg: sel ? T.selection : undefined }] : []),
            ], w));
          });
        }
        if (live) {
          // A free-text row so a custom answer is a visible choice rather than a
          // hidden affordance.
          const sel = cursor >= opts.length;
          lines.push([
            { text: sel ? "  ❯ " : "    ", color: T.accent, bold: true },
            { text: opts.length > 0 ? "type your own answer" : "type an answer", color: sel ? T.text : T.subtle, italic: true, bg: sel ? T.selection : undefined },
          ]);
          lines.push([{ text: "    ↑↓ choose · enter confirm" + (opts.length > 0 ? " · or press a number" : ""), color: T.faint }]);
        } else if (answered[qi]) lines.push([{ text: "    → " + answered[qi]!, color: T.muted }]);
      });
      lines.push([]);
      return lines;
    }
    case "note":
      return [...wrapSpans([{ text: "  ─ " + item.text, color: item.tone === "warning" ? T.warning : T.subtle, italic: true }], w, o.links), []];
    case "error":
      return [...wrapSpans([{ text: "  ✗ " + item.text, color: T.danger }], w, o.links), []];
  }
}

/**
 * The `>_` row standing in for a turn's tool calls once the conversation has
 * moved on.
 *
 * Only the *calls* fold — whatever the agent said between them stays where it
 * was, so the turn still reads as prose with one row where the machinery used
 * to be. The row is also the handle that brings them back, so it is drawn open
 * as well as closed; open, the calls follow in their original places rather
 * than bunched underneath it.
 */
export function renderToolGroupHead(items: ToolCallItem[], open: boolean, o: RenderOpts): Line[] {
  const w = Math.max(20, o.width);
  const failed = items.filter((i) => i.status === "error" || i.background?.state === "failed").length;
  const running = items.filter((i) => i.status === "running" || i.background?.state === "running").length;
  const names: string[] = [];
  for (const i of items) if (!names.includes(i.toolName)) names.push(i.toolName);
  const head: Line = [
    { text: "  " },
    { text: open ? "▾" : "▸", color: T.subtle },
    { text: " >_ ", color: T.accent },
    { text: `${items.length} tool call${items.length === 1 ? "" : "s"}`, color: T.muted },
  ];
  if (failed > 0) head.push({ text: `  ${failed} failed`, color: T.danger });
  if (running > 0) head.push({ text: `  ${running} in the background`, color: T.info });
  const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "");
  head.push({ text: "  " + shown, color: T.faint });
  const lines = wrapSpans(head, w);
  return open ? lines : [...lines, []];
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function relTime(iso: string | null): string {
  if (!iso) return "";
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

export function truncate(s: string, n: number): string {
  if (width(s) <= n) return s;
  let out = "";
  for (const ch of s) { if (width(out + ch) > n - 1) break; out += ch; }
  return out + "…";
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The live "something is happening" row, appended while a turn runs.
 *
 * Responses arrive whole rather than token by token, so without this the
 * transcript sits still between sending and the reply landing. It reports the
 * running tool by name when there is one, so you can see what it is doing.
 */
export function activityLine(o: { tick: number; elapsedMs: number; tools: number; toolActive: boolean }): Line {
  const spin = SPINNER[o.tick % SPINNER.length]!;
  const line: Line = [
    { text: "  " },
    { text: spin, color: T.working },
    // The running tool already has its own row above; what this adds is which
    // *kind* of work is in flight, since text only lands when it is finished.
    { text: o.toolActive ? " running tool" : " writing response", color: T.muted },
  ];
  if (o.tools > 0) line.push({ text: `  ·  ${o.tools} tool${o.tools === 1 ? "" : "s"}`, color: T.faint });
  line.push({ text: `  ·  ${fmtMs(o.elapsedMs)}`, color: T.faint });
  line.push({ text: "  esc to interrupt", color: T.faint });
  return line;
}

// ---------------------------------------------------------------------------
// Selection support
// ---------------------------------------------------------------------------

/** The plain text of a rendered line, for copying. */
export function lineText(line: Line): string {
  let s = "";
  for (const sp of line) s += sp.text;
  return s;
}

/** Display column (0-based) → character index, honouring double-width glyphs. */
export function colToIndex(line: Line, col: number): number {
  let w = 0;
  let i = 0;
  for (const sp of line) {
    for (const ch of sp.text) {
      if (w >= col) return i;
      w += width(ch);
      i += ch.length;
    }
  }
  return i;
}

/**
 * The link under a display column, for alt+click.
 *
 * The same column arithmetic as `colToIndex`, because the mouse reports a
 * screen column and the wrap may have cut one link into several spans.
 */
export function linkAt(line: Line, col: number): string | undefined {
  let w = 0;
  for (const sp of line) {
    const next = w + width(sp.text);
    if (col >= w && col < next) return sp.link;
    w = next;
  }
  return undefined;
}

/** Character index → display column, the inverse of `colToIndex`. */
export function indexToCol(line: Line, index: number): number {
  let w = 0;
  let i = 0;
  for (const sp of line) {
    for (const ch of sp.text) {
      if (i >= index) return w;
      w += width(ch);
      i += ch.length;
    }
  }
  return w;
}

/** Extract the text covered by a selection, for the clipboard. */
export function selectedText(
  lines: Line[],
  from: { line: number; col: number },
  to: { line: number; col: number },
): string {
  const out: string[] = [];
  for (let i = Math.max(0, from.line); i <= to.line && i < lines.length; i++) {
    const l = lines[i]!;
    const text = lineText(l);
    const a = i === from.line ? colToIndex(l, from.col) : 0;
    const b = i === to.line ? colToIndex(l, to.col) : text.length;
    // Lines are padded with background spans to draw blocks; that padding is
    // not content, so it never belongs on the clipboard.
    out.push(text.slice(a, b).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** Paint a background over characters [from, to) of a line, splitting spans. */
export function highlightLine(line: Line, from: number, to: number, bg: string): Line {
  if (to <= from) return line;
  const out: Line = [];
  let i = 0;
  for (const sp of line) {
    const start = i;
    const end = i + sp.text.length;
    i = end;
    if (end <= from || start >= to) { out.push(sp); continue; }
    const a = Math.max(from, start) - start;
    const b = Math.min(to, end) - start;
    if (a > 0) out.push({ ...sp, text: sp.text.slice(0, a) });
    out.push({ ...sp, text: sp.text.slice(a, b), bg });
    if (b < sp.text.length) out.push({ ...sp, text: sp.text.slice(b) });
  }
  return out;
}

/** Render a unified patch to coloured lines. */
export function diffToLines(patch: string, w: number): Line[] {
  const out: Line[] = [];
  if (!patch.trim()) return [[{ text: "  no changes", color: T.subtle, italic: true }]];
  for (const raw of patch.split("\n")) {
    const line = raw.length > w ? raw.slice(0, w - 1) + "…" : raw;
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/ b\/(.+)$/);
      out.push([]);
      out.push([{ text: " " + (m?.[1] ?? raw) + " ", color: T.text, bold: true, bg: T.surfaceAlt }]);
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") || raw.startsWith("rename ")) {
      continue;
    } else if (raw.startsWith("@@")) {
      out.push([{ text: line, color: T.info }]);
    } else if (raw.startsWith("+")) {
      out.push([{ text: line.padEnd(w), color: "#b5e8b0", bg: "#173124" }]);
    } else if (raw.startsWith("-")) {
      out.push([{ text: line.padEnd(w), color: "#f2b8b5", bg: "#3a1f1f" }]);
    } else {
      out.push([{ text: line, color: T.muted }]);
    }
  }
  return out;
}
