/**
 * Markdown-lite, parsed into blocks this client can paint (issue #168).
 *
 * The TUI paints markdown as lines, the web client writes HTML, and this writes
 * React Native views. `packages/client/src/markdown.ts` says why that is right
 * and where the line is: *what counts as* a table is shared, because a reply
 * read as a table on one client and as prose on another is a bug the reader
 * cannot explain, and the layout stays with the client that does it.
 *
 * So `tableAt` is imported and the rest is here. The subset is exactly the web
 * client's — fences, headers, bullets, numbered lists, tables, inline code,
 * bold, links, images, a bare media URL, and a `#N` that opens an issue — and
 * `markdown.test.ts` checks this parser against that one so the two cannot
 * drift apart quietly.
 *
 * There is no escaping here, and there must never be: a React Native `<Text>`
 * takes a string, not markup, so a reply cannot put views on the screen. That
 * is the one thing this file gets for free that `markdownToHtml` has to work
 * for.
 */
import { tableAt, type Table } from "@covey/client";
import { REF, mediaKind } from "@covey/web";

/** A run of text inside a paragraph, a heading, a list item or a cell. */
export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  /** Bold may hold a link, because the page's rules let it — see `PATTERNS`. */
  | { kind: "bold"; spans: Span[] }
  | { kind: "link"; spans: Span[]; url: string }
  /** `#12`, which opens the issue or the pull request (#108). */
  | { kind: "ref"; text: string; number: number }
  | { kind: "image"; url: string; alt: string };

/** One block of a reply. */
export type Block =
  | { kind: "para"; lines: Span[][] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "table"; table: Table }
  /** A URL alone on a line that names a picture or a video (#110). */
  | { kind: "media"; media: "image" | "video"; url: string };

/** Only `http(s)`. Anything else stays text — the same rule the page keeps. */
const SRC = /^https?:\/\/[^\s<>"']+$/;

/**
 * One line of text as spans.
 *
 * This mirrors `markdownToHtml`'s `inline`, and the mirror has to be exact: a
 * reply that reads one way in the phone's browser and another in the phone's
 * app is the bug the shared parser exists to prevent. `markdown.test.ts`
 * compares the two on every input rather than against a fixture, so the two
 * cannot drift together.
 *
 * The page applies its patterns in order to one flat string, each `replace`
 * seeing what the ones before it left. That is not a tree walk, and it is why
 * the page reads **both** of these the way they look:
 *
 *     **a [b](url) c**     bold containing a link
 *     [**a**](url)         a link whose label is bold
 *
 * A recursive descent can do one or the other, never both — whichever pattern
 * runs first takes the outside. So the patterns run in the page's order over a
 * flat string, and each one leaves *markers* around what it claimed while
 * leaving the content in place for the patterns after it. `treeOf` turns the
 * markers into spans at the end.
 */
export function inlineSpans(src: string): Span[] {
  const out: Span[] = [];
  for (const part of src.split(/(`[^`]*`)/)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push({ kind: "code", text: part.slice(1, -1) });
      continue;
    }
    out.push(...spansOf(part));
  }
  return merge(out);
}

/** A span that stands alone: its content is claimed whole and parsed no further. */
const SELF = "\u0001";
/** A span that wraps whatever the later patterns make of the text inside it. */
const OPEN = "\u0002";
const CLOSE = "\u0003";

/** What a marker stands for, before the text inside it is known. */
type Mark =
  | { kind: "code"; text: string }
  | { kind: "ref"; text: string; number: number }
  | { kind: "image"; url: string; alt: string }
  | { kind: "bold" }
  | { kind: "link"; url: string };

function spansOf(part: string): Span[] {
  const marks: Mark[] = [];
  /** Claim a whole run: nothing inside it is read again. */
  const self = (m: Mark) => `${SELF}${marks.push(m) - 1}${SELF}`;
  /** Claim a run but leave its text for the patterns that come after. */
  const wrap = (m: Mark, inner: string) => `${OPEN}${marks.push(m) - 1}${OPEN}${inner}${CLOSE}${marks.length - 1}${CLOSE}`;

  let s = part;
  // The page's order, and each line of it is one of the page's `replace` calls.
  // An `<img>` tag first: it is what GitHub's own form writes for a dropped
  // image, and only its `src` and `alt` survive.
  s = s.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (tag, url: string) =>
    SRC.test(url) ? self({ kind: "image", url, alt: /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "" }) : tag);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt: string, url: string) =>
    self({ kind: "image", url, alt }));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    wrap({ kind: "link", url }, label));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) =>
    `${pre}${wrap({ kind: "link", url }, url)}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => wrap({ kind: "bold" }, inner));
  s = s.replace(new RegExp(REF.source, REF.flags), (_m, pre: string, n: string) =>
    `${pre}${self({ kind: "ref", text: `#${n}`, number: Number(n) })}`);

  return treeOf(s, marks);
}

/**
 * The marked string as a tree.
 *
 * The page's patterns can overlap — `[a **b](url) c**` claims a link and then a
 * bold run that starts inside it and ends outside, which the page emits as
 * crossed tags and a browser quietly repairs. So this closes what is open when
 * it meets a close it did not expect, and closes anything still open at the
 * end. A degenerate reply then reads a little differently from the page and
 * never throws, which is the right way round.
 */
function treeOf(s: string, marks: Mark[]): Span[] {
  const root: Span[] = [];
  const stack: { id: number; spans: Span[] }[] = [];
  const top = () => (stack.length ? stack[stack.length - 1]!.spans : root);
  const re = new RegExp(`${SELF}(\\d+)${SELF}|${OPEN}(\\d+)${OPEN}|${CLOSE}(\\d+)${CLOSE}`, "g");
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) top().push({ kind: "text", text: s.slice(at, m.index) });
    at = m.index + m[0]!.length;
    if (m[1] !== undefined) {
      const mark = marks[Number(m[1])]!;
      // A self-closing mark is already a whole span.
      top().push(mark.kind === "bold" || mark.kind === "link" ? { kind: "text", text: "" } : mark);
      continue;
    }
    if (m[2] !== undefined) { stack.push({ id: Number(m[2]), spans: [] }); continue; }
    const id = Number(m[3]);
    // Close everything up to and including this one. A close for something that
    // was never opened is text that is gone; there is nothing to put back.
    while (stack.length) {
      const frame = stack.pop()!;
      const mark = marks[frame.id]!;
      const span: Span = mark.kind === "link" ? { kind: "link", spans: merge(frame.spans), url: mark.url } : { kind: "bold", spans: merge(frame.spans) };
      top().push(span);
      if (frame.id === id) break;
    }
  }
  if (at < s.length) top().push({ kind: "text", text: s.slice(at) });
  // Anything still open ends here.
  while (stack.length) {
    const frame = stack.pop()!;
    const mark = marks[frame.id]!;
    top().push(mark.kind === "link" ? { kind: "link", spans: merge(frame.spans), url: mark.url } : { kind: "bold", spans: merge(frame.spans) });
  }
  return root;
}

/** Join neighbouring text spans and drop the empty ones. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.kind === "text" && s.text === "") continue;
    const last = out[out.length - 1];
    if (s.kind === "text" && last?.kind === "text") last.text += s.text;
    else out.push(s);
  }
  return out;
}

/**
 * A reply as blocks.
 *
 * The same walk `markdownToHtml` does, in the same order, so the two agree on
 * every structural decision: a fence before a table, a table before a heading,
 * a heading before a list, and a bare media URL only after all of them.
 */
export function markdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Span[][] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push({ kind: "para", lines: para.map(inlineSpans) });
    para = [];
  };
  const closeList = () => { if (list) { out.push({ kind: "list", ...list }); list = null; } };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushPara(); closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++; // the closing fence, or the end of the text
      out.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      flushPara(); closeList();
      out.push({ kind: "table", table });
      i = table.end;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); closeList();
      out.push({ kind: "heading", level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, spans: inlineSpans(heading[2]!) });
      i++;
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push(inlineSpans((bullet ?? numbered)![1]!));
      i++;
      continue;
    }
    if (line.trim() === "") { flushPara(); closeList(); i++; continue; }
    const bare = /^\s*(https?:\/\/[^\s<>"']+)\s*$/.exec(line);
    const media = bare && SRC.test(bare[1]!) ? mediaKind(bare[1]!) : null;
    if (media) {
      flushPara(); closeList();
      out.push({ kind: "media", media, url: bare![1]! });
      i++;
      continue;
    }
    closeList();
    para.push(line);
    i++;
  }
  flushPara();
  closeList();
  return out;
}

/** The plain text of a run of spans, for a place that paints no style. */
export function spansText(spans: Span[]): string {
  return spans.map((s) => {
    if (s.kind === "image") return s.alt;
    if (s.kind === "bold" || s.kind === "link") return spansText(s.spans);
    return s.text;
  }).join("");
}

/**
 * Every span of a run, outermost first, in the order they were written.
 *
 * Depth first, which is document order — so this reads the same way the web
 * client's HTML does, and `markdown.test.ts` compares the two directly.
 */
export function flatSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    out.push(s);
    if (s.kind === "bold" || s.kind === "link") out.push(...flatSpans(s.spans));
  }
  return out;
}
