/**
 * Clickable paths and URLs in the transcript.
 *
 * The gesture is cmd+click on a Mac and ctrl+click elsewhere, the one Claude
 * Code teaches, and a plain click never opens anything — it selects text, and
 * a link the reader only meant to point at must not reach the browser.
 *
 * Two routes carry that gesture, because no single one covers every terminal:
 *
 * 1. An OSC 8 hyperlink. The terminal does the hit test and the open, the
 *    pointer changes shape, and no mouse plumbing is involved. This is the
 *    route cmd+click takes: macOS terminals keep cmd for themselves and hand
 *    the app nothing, which is why `parseMouse` can never see that click. The
 *    URI never enters `Span.text`, so `width()` in `lines.ts` keeps counting
 *    printable columns only. Ink measures with `string-width`, which also
 *    skips the sequence, and `slice-ansi` reopens the link after a wrap.
 * 2. alt+click and ctrl+click on the same span, for a terminal that knows no
 *    OSC 8. SGR mouse reports carry a bit for alt (8) and one for ctrl (16),
 *    so `parseMouse` already decodes them. There is no bit for cmd, and shift
 *    is reserved: terminals bypass mouse reporting while it is held, which is
 *    the escape hatch for native selection.
 *
 * So covey cannot open a link on cmd+click itself. What it does instead is
 * name the gesture: `openGesture` writes it in the reader's own words, and a
 * plain click on a link says it rather than opening or staying silent.
 *
 * A path in the transcript is a path on the *daemon's* host, and the file
 * manager runs on the *client's* host. So a file link is drawn only when the
 * thread's machine is the loopback one. A URL is safe from any machine.
 */
import type { Span } from "./lines.js";

export interface LinkContext {
  /**
   * True when the thread's machine is this machine. A path from a remote
   * daemon means nothing to the local file manager, so it is left as text.
   */
  localFiles: boolean;
  /** Home directory of the thread's machine, to expand a leading `~`. */
  homeDir?: string;
  /**
   * The repository on GitHub, `https://github.com/owner/repo`, so that a
   * `#N` in the transcript links to its issue or pull request (#108).
   * Absent, a `#N` stays text.
   */
  repoUrl?: string;
}

/** The web URL of a project's repository, from its normalised remote, or undefined when it is not on GitHub. */
export function repoUrlOf(identity: string | null | undefined): string | undefined {
  if (!identity) return undefined;
  const m = /^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(identity);
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

/**
 * The link for `#N`: the issues route, which GitHub answers with the pull
 * request when the number is one. Five digits at most, so a hex colour such
 * as `#123456` stays text.
 */
export function refUri(hit: string, ctx: LinkContext): string | null {
  const m = /^#(\d{1,5})$/.exec(hit);
  return m && ctx.repoUrl ? `${ctx.repoUrl}/issues/${m[1]}` : null;
}

/**
 * A web URL, an absolute path, or a `#N` reference.
 *
 * The URL branch comes first so that the path inside `https://host/a/b` never
 * matches on its own, and the `#issuecomment-1` in one never reads as a
 * reference. The path branch allows a leading `~`; the callers below reject
 * a bare one-segment match such as the `/or` in `and/or`.
 */
const TARGET = /https?:\/\/[^\s<>"'`()[\]{}]+|~?(?:\/[A-Za-z0-9._+@%~-]+)+\/?|#\d{1,5}(?![\w-])/g;

/** Trailing punctuation belongs to the sentence, not to the target. */
const TRAILING = /[.,;:!?'"`)\]}>]+$/;

/** A character that means the match is the tail of a longer word or path. */
const PREFIX = /[A-Za-z0-9_~./:@%+-]/;

export interface Target {
  /** Character offsets into the text that was scanned. */
  start: number;
  end: number;
  /** What the terminal should open. */
  uri: string;
}

/** Find every URL and every absolute path in one piece of text. */
export function findTargets(text: string, ctx: LinkContext): Target[] {
  const out: Target[] = [];
  TARGET.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TARGET.exec(text))) {
    let hit = m[0];
    const start = m.index;
    const before = start > 0 ? text[start - 1]! : "";
    if (before && PREFIX.test(before)) continue;
    hit = hit.replace(TRAILING, "");
    if (!hit) continue;
    const uri = targetUri(hit, ctx);
    if (!uri) continue;
    out.push({ start, end: start + hit.length, uri });
  }
  return out;
}

/** The URI for one matched piece of text, or null when it is not a target. */
export function targetUri(hit: string, ctx: LinkContext): string | null {
  if (/^https?:\/\//.test(hit)) return safeUri(hit);
  if (hit.startsWith("#")) return refUri(hit, ctx);
  if (!ctx.localFiles) return null;
  let path = hit;
  if (path.startsWith("~")) {
    if (!ctx.homeDir) return null;
    path = ctx.homeDir.replace(/\/$/, "") + path.slice(1);
  } else if (!path.startsWith("/")) return null;
  // A single segment is prose more often than a path: `/or`, `/me`, `/tmp`
  // read the same way, and a wrong link is worse than no link.
  else if (path.split("/").filter(Boolean).length < 2) return null;
  return safeUri("file://" + path.split("/").map(encodeURIComponent).join("/"));
}

/**
 * Take the escape characters out of a URI.
 *
 * The transcript carries text the agent wrote, so an ESC or a BEL in it could
 * otherwise end the OSC 8 sequence early and write raw bytes to the terminal.
 */
export function safeUri(uri: string): string {
  return uri.replace(/[\u0000-\u001f\u007f]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/**
 * Attach a link to every URL and every absolute path in a span array, before
 * the wrap splits it.
 *
 * Order matters: a path that is wrapped over two rows arrives here whole, and
 * `wrapSpans` copies the `link` field into each piece it cuts, so both rows
 * point at the same file. Scanning after the wrap would link half a path.
 */
export function linkSpans(spans: Span[], ctx: LinkContext | undefined): Span[] {
  if (!ctx) return spans;
  let changed = false;
  const out: Span[] = [];
  for (const sp of spans) {
    // A link set by the caller is the better one: a tool row takes its target
    // from the tool input, which is not truncated.
    if (sp.link || !sp.text) { out.push(sp); continue; }
    const hits = findTargets(sp.text, ctx);
    if (hits.length === 0) { out.push(sp); continue; }
    changed = true;
    let at = 0;
    for (const h of hits) {
      if (h.start > at) out.push({ ...sp, text: sp.text.slice(at, h.start) });
      out.push({ ...sp, text: sp.text.slice(h.start, h.end), link: h.uri });
      at = h.end;
    }
    if (at < sp.text.length) out.push({ ...sp, text: sp.text.slice(at) });
  }
  return changed ? out : spans;
}

/** Keys in a tool input that hold a path, in the order we prefer them. */
const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath"];

/**
 * The link for a tool row, read from the tool input rather than from the
 * summary.
 *
 * `summariseTool` puts the path through `short(s, 80)`, which cuts it with an
 * ellipsis, so a link built from the summary text would point at nothing. The
 * whole input already travels over the protocol on `ToolCallItem.input`.
 */
export function toolLink(input: unknown, ctx: LinkContext | undefined): string | undefined {
  if (!ctx || !input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  if (typeof i.url === "string" && /^https?:\/\//.test(i.url)) return safeUri(i.url);
  for (const k of PATH_KEYS) {
    const v = i[k];
    if (typeof v !== "string" || !v) continue;
    const uri = targetUri(v, ctx);
    if (uri) return uri;
  }
  return undefined;
}

/**
 * How the client's host opens a target. Kept apart from the spawn so the
 * choice can be tested without opening anything.
 */
export function openCommand(uri: string, platform: string): { cmd: string; args: string[] } {
  const isFile = uri.startsWith("file://");
  const path = isFile ? decodeURIComponent(uri.slice("file://".length)) : uri;
  switch (platform) {
    // `-R` reveals the file in the Finder instead of opening it in whatever
    // application owns the extension. That is what the issue asks for, and it
    // is also the safer of the two: it never runs the file.
    case "darwin": return { cmd: "open", args: isFile ? ["-R", path] : [uri] };
    case "win32": return { cmd: "explorer", args: isFile ? ["/select," + path.replace(/\//g, "\\")] : [uri] };
    default: return { cmd: "xdg-open", args: [isFile ? dirOf(path) : uri] };
  }
}

/** The directory holding a file, because `xdg-open` has no reveal. */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

// ---------------------------------------------------------------------------
// OSC 8
// ---------------------------------------------------------------------------

const ESC = "\u001b";
const OPEN = ESC + "]8;;";
const ST = ESC + "\\";

/**
 * Wrap text in an OSC 8 hyperlink.
 *
 * Verified against ink 7.1.1: `string-width` and `widest-line` both report the
 * printable width only, so the sequence costs no columns in the layout.
 */
export function osc8(uri: string, text: string): string {
  return OPEN + safeUri(uri) + ST + text + OPEN + ST;
}

/**
 * False when hyperlinks are turned off. A terminal that does not know OSC 8
 * drops it, but the escape hatch costs one line and keeps the alt+click route
 * available on its own.
 */
export function hyperlinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.COVEY_NO_HYPERLINKS;
}

/**
 * What the reader holds to open a link, in the words of their own machine.
 *
 * With OSC 8 the terminal owns the gesture, so covey must name the one that
 * terminal answers to: cmd+click on macOS, ctrl+click on the VTE, kitty and
 * WezTerm terminals of a Linux desktop. covey also opens a ctrl+click itself,
 * so on Linux the one word is true whichever route runs.
 *
 * Without OSC 8 only covey's own route is left, and that route has no cmd bit
 * to read. Then the gesture is alt+click, which every terminal forwards.
 */
export function openGesture(platform: string, hyperlinks: boolean = hyperlinksEnabled()): string {
  if (!hyperlinks) return "alt+click";
  return platform === "darwin" ? "cmd+click" : "ctrl+click";
}

// ---------------------------------------------------------------------------
// The word under a double-click
// ---------------------------------------------------------------------------

/**
 * What a double-click takes, as an offset pair into the text it scanned.
 *
 * A "word" here includes a path, because a path is what a reader most often
 * wants off a transcript: `packages/tui/src/lines.ts:439` has to come off
 * whole, and a boundary that stops at `/` or `.` gives the one piece nobody
 * asked for.
 *
 * `findTargets` above cannot do this job on its own. It wants a leading `/`,
 * and the path a reader points at is usually relative; `targetUri` also
 * refuses every path when `localFiles` is false, which is every thread on a
 * remote machine. So the boundary is its own rule, and a link is only the
 * first of the three cases it covers.
 */
export interface WordRange {
  start: number;
  end: number;
}

/** A URL, found first so that its `//`, `?` and `&` never cut it up. */
const URL_RUN = /https?:\/\/[^\s<>"'`]+/g;

/**
 * The characters a path or an identifier is made of. `:` is absent on purpose:
 * it ends a word in `note:` and in `https:` alike, so a `file:line` reference
 * is put back by hand below rather than folded in here.
 */
const WORD_CHAR = /[A-Za-z0-9_~./@%+\-#]/;

/** A `:line` or `:line:column` reference, which belongs to the path before it. */
const LOCATION = /^:\d+(?::\d+)?/;

/** How many `name:` hops to walk back over, enough for `file:line:column`. */
const LOCATION_HOPS = 2;

/** Find the word, path or URL that covers one character index. */
export function wordAt(text: string, index: number): WordRange {
  if (index < 0 || index >= text.length) return { start: text.length, end: text.length };

  URL_RUN.lastIndex = 0;
  for (const m of text.matchAll(URL_RUN)) {
    const hit = m[0].replace(TRAILING, "");
    if (hit && index >= m.index && index < m.index + hit.length) return { start: m.index, end: m.index + hit.length };
  }

  const ch = text[index]!;
  // Whitespace and punctuation take the run of their own kind. Neither is
  // worth copying, but selecting nothing looks like a click that missed.
  if (/\s/.test(ch)) return run(text, index, (c) => /\s/.test(c));
  if (!WORD_CHAR.test(ch)) return run(text, index, (c) => !/\s/.test(c) && !WORD_CHAR.test(c));

  let { start, end } = run(text, index, (c) => WORD_CHAR.test(c));

  // `lines.ts:439` is one thing to a reader. Take the suffix when the click
  // was on the path, and the path when the click was on the number.
  const loc = LOCATION.exec(text.slice(end));
  if (loc) end += loc[0].length;
  for (let hop = 0; hop < LOCATION_HOPS; hop++) {
    if (start < 2 || text[start - 1] !== ":" || !WORD_CHAR.test(text[start - 2]!)) break;
    let s = start - 1;
    while (s > 0 && WORD_CHAR.test(text[s - 1]!)) s--;
    start = s;
  }

  // Trailing punctuation belongs to the sentence. Never trim back past the
  // character that was clicked: a click on the `.` of `…ts.` asked for it.
  const tail = TRAILING.exec(text.slice(start, end));
  if (tail) end = Math.max(index + 1, end - tail[0].length);
  return { start, end };
}

/** Grow an index into the longest run of characters `ok` accepts. */
function run(text: string, index: number, ok: (c: string) => boolean): WordRange {
  let start = index;
  let end = index + 1;
  while (start > 0 && ok(text[start - 1]!)) start--;
  while (end < text.length && ok(text[end]!)) end++;
  return { start, end };
}
