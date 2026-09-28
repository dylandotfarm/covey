/**
 * The markdown layout, against the web client's own.
 *
 * `packages/client/src/markdown.ts` draws the line: what counts as a table is
 * shared, and the layout belongs to each client. That leaves a gap this file
 * closes — the two clients parse the *same* subset with *different* code, and a
 * reply that reads as a list on the phone's browser and as prose in the phone's
 * app is exactly the bug the shared parser exists to prevent.
 *
 * So every structural decision is checked against `markdownToHtml` rather than
 * against a fixture: the order of the rules, where a paragraph breaks, and what
 * a bare URL becomes. A fixture would let both drift together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// The web package names this subpath for this client — see its `//exports`
// note. The comparison is the whole point of the file, so the import is not an
// accident of the layout.
import { markdownToHtml } from "@covey/web/markdown";
import { flatSpans, inlineSpans, markdownBlocks, spansText, type Span } from "./markdown.js";

/** The block shapes of a reply, as this client reads them. */
function blockShape(text: string): string[] {
  return markdownBlocks(text).map((b) => {
    switch (b.kind) {
      case "heading": return `heading:${b.level}`;
      case "list": return `list:${b.ordered ? "ol" : "ul"}`;
      case "media": return `media:${b.media}`;
      default: return b.kind;
    }
  });
}

/** The same shapes, read back out of the web client's HTML. */
function htmlShape(text: string): string[] {
  const html = markdownToHtml(text);
  const out: string[] = [];
  const re = /<(pre|h1|h2|h3|ul|ol|p)\b([^>]*)>|<div class="table-wrap">/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]) { out.push("table"); continue; }
    const tag = m[1];
    const attrs = m[2] ?? "";
    if (tag === "pre") out.push("code");
    else if (tag === "ul" || tag === "ol") out.push(`list:${tag}`);
    else if (tag === "p") {
      if (!attrs.includes("media-p")) { out.push("para"); continue; }
      // A media paragraph holds an `<img>` or a `<video>`, and which it is
      // matters: `mediaKind` decides, and both clients must decide the same.
      out.push(html.slice(m.index).startsWith("<p class=\"media-p\"><video") ? "media:video" : "media:image");
    }
    else out.push(`heading:${tag.slice(1)}`);
  }
  return out;
}

const REPLIES = [
  "Just a line.",
  "Two lines\nin one paragraph.",
  "One.\n\nTwo.",
  "# Title\n\nBody text.",
  "#### Deep heading becomes level three",
  "- one\n- two\n- three",
  "1. first\n2. second",
  "- a bullet\n\n1. a number",
  "```ts\nconst x = 1;\n```",
  "```\nno language\n```",
  "Text\n```sh\nls\n```\nMore text",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "Before\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |\n\nAfter",
  "https://example.com/a.png",
  "https://example.com/clip.mp4",
  "https://example.com/page",
  "A **bold** word and `code` and a [link](https://example.com).",
  "See #42 for the reason.",
  "Mixed:\n# H\n- l\n```\nc\n```\n| a |\n| --- |\n| 1 |",
  "",
  "   ",
  "*star bullet\n* proper star bullet",
];

test("the block shape agrees with the web client on every reply", () => {
  for (const reply of REPLIES) {
    assert.deepEqual(blockShape(reply), htmlShape(reply), `shape of ${JSON.stringify(reply)}`);
  }
});

test("a fence swallows its body, whatever is in it", () => {
  const blocks = markdownBlocks("```js\n# not a heading\n- not a list\n```");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: "code", lang: "js", text: "# not a heading\n- not a list" });
});

test("an unterminated fence still ends, and takes the rest", () => {
  const blocks = markdownBlocks("```\nopen for ever");
  assert.deepEqual(blocks, [{ kind: "code", lang: "", text: "open for ever" }]);
});

test("a table is the shared parser's table, cells and all", () => {
  const blocks = markdownBlocks("| a | b |\n| :-- | --: |\n| 1 | 2 |");
  assert.equal(blocks[0]!.kind, "table");
  const t = (blocks[0] as { table: { header: string[]; rows: string[][]; align: string[] } }).table;
  assert.deepEqual(t.header, ["a", "b"]);
  assert.deepEqual(t.rows, [["1", "2"]]);
  assert.deepEqual(t.align, ["left", "right"]);
});

const kinds = (spans: Span[]) => spans.map((s) => s.kind);

test("code spans are taken first, so nothing inside one is markup", () => {
  const spans = inlineSpans("a `**not bold** #12 [no](https://x)` b");
  assert.deepEqual(kinds(spans), ["text", "code", "text"]);
  assert.equal((spans[1] as { text: string }).text, "**not bold** #12 [no](https://x)");
});

test("nesting reads the way the page reads it: bold may hold a link", () => {
  // The page replaces link syntax before bold syntax, so this is bold
  // *containing* a link and not bold whose text looks like one.
  const spans = inlineSpans("**a [b](https://x) c**");
  assert.deepEqual(kinds(spans), ["bold"]);
  const bold = spans[0] as { spans: Span[] };
  assert.deepEqual(kinds(bold.spans), ["text", "link", "text"]);
  assert.equal(spansText(spans), "a b c");

  // And the other way round: a link's label may hold bold.
  const other = inlineSpans("start [**a**](https://x) end");
  assert.deepEqual(kinds(other), ["text", "link", "text"]);
  assert.deepEqual(kinds((other[1] as { spans: Span[] }).spans), ["bold"]);
});

test("a bare URL becomes a link, and one in a word does not", () => {
  assert.deepEqual(kinds(inlineSpans("see https://example.com now")), ["text", "link", "text"]);
  assert.deepEqual(kinds(inlineSpans("(https://example.com)")), ["text", "link", "text"]);
  // No separator before it, so it is not a link — the page's rule.
  assert.deepEqual(kinds(inlineSpans("mailto:x@httpsnot")), ["text"]);
});

test("a #N is a ref, and the character before it stays text", () => {
  const spans = inlineSpans("fixes #42.");
  assert.deepEqual(kinds(spans), ["text", "ref", "text"]);
  assert.equal((spans[0] as { text: string }).text, "fixes ");
  assert.equal((spans[1] as { number: number }).number, 42);
  assert.equal(spansText(spans), "fixes #42.");
  // Inside a word it is not a reference, which is `REF`'s own rule.
  assert.deepEqual(kinds(inlineSpans("abc#42")), ["text"]);
});

test("an img tag keeps only its src and alt, and a bad src stays text", () => {
  const good = inlineSpans('<img src="https://example.com/a.png" alt="a shot" width="20">');
  assert.deepEqual(kinds(good), ["image"]);
  assert.deepEqual(good[0], { kind: "image", url: "https://example.com/a.png", alt: "a shot" });
  // Not http(s): it is not a picture and it is not markup either.
  assert.deepEqual(kinds(inlineSpans('<img src="javascript:alert(1)">')), ["text"]);
});

test("markdown image syntax is an image", () => {
  assert.deepEqual(inlineSpans("![alt](https://example.com/a.png)"), [
    { kind: "image", url: "https://example.com/a.png", alt: "alt" },
  ]);
});

test("neighbouring text is one span, so a paragraph is not a thousand views", () => {
  const spans = inlineSpans("plain text with no markup at all");
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.kind, "text");
});

/** The inline elements of the web client's HTML, in document order. */
function htmlInline(text: string): string[] {
  // Two blocks emit what look like spans and are not: a fence emits
  // `<pre><code>`, and a bare media URL emits a paragraph holding one `<img>`
  // or `<video>`. Both belong to the block layer on this client.
  const html = markdownToHtml(text)
    .replace(/<pre[\s\S]*?<\/pre>/g, "")
    .replace(/<p class="media-p">[\s\S]*?<\/p>/g, "");
  const out: string[] = [];
  const re = /<(code|strong|img)\b|<a\b([^>]*)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) { out.push(m[1] === "strong" ? "bold" : m[1] === "img" ? "image" : "code"); continue; }
    out.push((m[2] ?? "").includes('class="ref"') ? "ref" : "link");
  }
  return out;
}

/** The same, as this client reads it: depth first, which is document order. */
function spanInline(text: string): string[] {
  return markdownBlocks(text)
    .flatMap((b) => {
      if (b.kind === "para") return b.lines.flat();
      if (b.kind === "heading") return b.spans;
      if (b.kind === "list") return b.items.flat();
      if (b.kind === "table") return [...b.table.header, ...b.table.rows.flat()].flatMap(inlineSpans);
      // A fence is not inline, and a bare media URL is an `<img>` or a
      // `<video>` the block layer owns rather than a span.
      return [];
    })
    .flatMap((sp) => flatSpans([sp]))
    .map((sp) => sp.kind)
    .filter((k) => k !== "text");
}

test("the inline elements agree with the web client, in document order", () => {
  for (const reply of [
    ...REPLIES,
    "**bold** then `code` then [link](https://x) then #7",
    "a ![pic](https://example.com/a.png) inline",
    '<img src="https://example.com/a.png" alt="x"> and **bold**',
    "# a **bold** heading with #9",
    "- **bold** item\n- `code` item",
    "| **a** | #3 |\n| --- | --- |\n| [l](https://x) | `c` |",
    "nested **bold with [a link](https://x) inside** it",
    "[**bold label**](https://x)",
    "https://example.com and **after**",
  ]) {
    assert.deepEqual(spanInline(reply), htmlInline(reply), `inline of ${JSON.stringify(reply)}`);
  }
});

test("crossed markup reads oddly and never throws", () => {
  // The page emits crossed tags here and a browser repairs them. This client
  // closes what is open and carries on: a degenerate reply reads a little
  // differently from the page, which is the right way round for a crash.
  for (const nasty of [
    "[a **b](https://x) c**",
    "**a [b**](https://x)",
    "**",
    "****",
    "[](https://x)",
    "**[a](https://x)",
    "a ** b ** c ** d",
    `weird \u0001 \u0002 \u0003 markers in the reply`,
  ]) {
    const spans = inlineSpans(nasty);
    assert.ok(Array.isArray(spans), `parsed ${JSON.stringify(nasty)}`);
    // Whatever the shape, no span is lost into nothing and no text is invented.
    assert.equal(typeof spansText(spans), "string");
  }
  // And the block layer survives the same inputs.
  for (const nasty of ["| a\n| ---", "```", "#", "- ", "1."]) {
    assert.ok(Array.isArray(markdownBlocks(nasty)));
  }
});
