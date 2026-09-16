import { test } from "node:test";
import assert from "node:assert/strict";
import { findTargets, hyperlinksEnabled, linkSpans, openCommand, osc8, safeUri, targetUri, toolLink, type LinkContext } from "./links.js";
import { linkAt, markdownToLines, renderItem, wrapSpans, width } from "./lines.js";

const ESC = "\u001b";
const local: LinkContext = { localFiles: true, homeDir: "/Users/d" };
const remote: LinkContext = { localFiles: false, homeDir: "/home/d" };

const text = (l: { text: string }[]) => l.map((s) => s.text).join("");
/** The distinct targets on a line. The wrap splits a span per word, and each
 *  piece keeps the same `link`, so the set is what matters. */
const links = (l: { link?: string }[]) => [...new Set(l.map((s) => s.link).filter(Boolean))];

test("findTargets picks out a URL and an absolute path", () => {
  const hits = findTargets("see /Users/d/a.ts and https://example.com/x", local);
  assert.deepEqual(hits.map((h) => h.uri), ["file:///Users/d/a.ts", "https://example.com/x"]);
});

test("findTargets leaves prose that only looks like a path alone", () => {
  for (const s of ["and/or", "24/7/365", "a/b/c", "nine of /ten"]) {
    assert.deepEqual(findTargets(s, local), [], s);
  }
});

test("findTargets drops the punctuation that ends the sentence", () => {
  assert.equal(findTargets("open /Users/d/a.ts.", local)[0]!.uri, "file:///Users/d/a.ts");
  assert.equal(findTargets("(see https://example.com/x).", local)[0]!.uri, "https://example.com/x");
});

test("findTargets expands a leading ~ with the machine's home directory", () => {
  assert.equal(findTargets("~/notes/a.md", local)[0]!.uri, "file:///Users/d/notes/a.md");
});

test("a path on a remote machine is not a link, but a URL still is", () => {
  assert.deepEqual(findTargets("/srv/app/a.ts", remote), []);
  assert.deepEqual(findTargets("https://example.com/x", remote).map((h) => h.uri), ["https://example.com/x"]);
});

test("targetUri refuses a one-segment path", () => {
  assert.equal(targetUri("/tmp", local), null);
  assert.equal(targetUri("/tmp/x", local), "file:///tmp/x");
});

test("safeUri encodes the escape characters an agent could write", () => {
  assert.equal(safeUri("https://x/" + ESC + "]8;;evil"), "https://x/%1b]8;;evil");
  assert.ok(!osc8("https://x/" + ESC + "a", "t").includes(ESC + "a"));
});

// ---------------------------------------------------------------------------
// The measurement point the issue asked about
// ---------------------------------------------------------------------------

test("the OSC 8 sequence stays out of Span.text, so width() is unchanged", () => {
  const plain = wrapSpans([{ text: "open /Users/d/a.ts now" }], 40);
  const linked = wrapSpans([{ text: "open /Users/d/a.ts now" }], 40, local);
  assert.deepEqual(linked.map(text), plain.map(text));
  assert.deepEqual(links(linked[0]!), ["file:///Users/d/a.ts"]);
});

test("a link that the wrap cuts in two keeps both halves pointing at the file", () => {
  const long = "/Users/d/projects/covey/packages/tui/src/lines.ts";
  const lines = wrapSpans([{ text: long }], 20, local);
  assert.ok(lines.length > 1, "the path has to wrap for this test to mean anything");
  assert.equal(lines.map(text).join(""), long);
  for (const l of lines) {
    for (const sp of l) assert.equal(sp.link, "file://" + long, "every piece keeps the whole target");
    assert.ok(width(text(l)) <= 20);
  }
});

test("osc8 wraps the text and closes the link", () => {
  assert.equal(osc8("file:///a/b", "b"), ESC + "]8;;file:///a/b" + ESC + "\\b" + ESC + "]8;;" + ESC + "\\");
});

test("hyperlinksEnabled is an opt-out", () => {
  assert.equal(hyperlinksEnabled({}), true);
  assert.equal(hyperlinksEnabled({ COVEY_NO_HYPERLINKS: "1" }), false);
});

// ---------------------------------------------------------------------------
// Markdown and tool rows
// ---------------------------------------------------------------------------

test("markdownToLines renders a link's label, not its source", () => {
  const lines = markdownToLines("read [the notes](https://example.com/n) today", 60, {}, local);
  assert.equal(lines.map(text).join(""), "read the notes today");
  assert.deepEqual(links(lines[0]!), ["https://example.com/n"]);
});

test("without a link context the markdown link is still not raw source", () => {
  assert.equal(markdownToLines("read [the notes](https://example.com/n)", 60).map(text).join(""), "read the notes");
});

test("a tool row takes its link from the input, not from the truncated summary", () => {
  const path = "/Users/d/" + "long-directory-name/".repeat(6) + "file.ts";
  const item = {
    id: "t", threadId: "x", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "tool", toolUseId: "u", toolName: "Read", input: { file_path: path },
    summary: "Read " + path.slice(0, 79) + "…",
    status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 1,
  } as const;
  const lines = renderItem(item, { width: 200, expanded: new Set(), links: local });
  assert.ok(text(lines[0]!).includes("…"), "the summary really is truncated");
  assert.deepEqual(links(lines[0]!), ["file://" + path], "the link is the whole path");
  assert.ok(lines[0]!.some((sp) => sp.text.startsWith("Read") && sp.link), "the summary words carry it, not only the path");
});

test("a tool row on a remote machine gets no file link", () => {
  const item = {
    id: "t", threadId: "x", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "tool", toolUseId: "u", toolName: "Read", input: { file_path: "/srv/a.ts" },
    summary: "Read /srv/a.ts", status: "completed", output: null, isError: false,
    parentToolUseId: null, durationMs: 1,
  } as const;
  assert.deepEqual(links(renderItem(item, { width: 80, expanded: new Set(), links: remote })[0]!), []);
});

test("toolLink prefers a URL and falls back to the path keys", () => {
  assert.equal(toolLink({ url: "https://example.com/a" }, local), "https://example.com/a");
  assert.equal(toolLink({ notebook_path: "/Users/d/n.ipynb" }, local), "file:///Users/d/n.ipynb");
  assert.equal(toolLink({ command: "ls" }, local), undefined);
  assert.equal(toolLink({ file_path: "/Users/d/a.ts" }, undefined), undefined);
});

// ---------------------------------------------------------------------------
// The alt+click route
// ---------------------------------------------------------------------------

test("linkAt finds the link under a display column", () => {
  const line = [{ text: "日本" }, { text: "/Users/d/a.ts", link: "file:///Users/d/a.ts" }];
  assert.equal(linkAt(line, 0), undefined, "the wide glyphs are not the link");
  assert.equal(linkAt(line, 3), undefined, "still inside the second wide glyph");
  assert.equal(linkAt(line, 4), "file:///Users/d/a.ts");
  assert.equal(linkAt(line, 99), undefined, "past the end of the line");
});

test("openCommand reveals a file and opens a URL", () => {
  assert.deepEqual(openCommand("file:///Users/d/a%20b.ts", "darwin"), { cmd: "open", args: ["-R", "/Users/d/a b.ts"] });
  assert.deepEqual(openCommand("https://example.com/x", "darwin"), { cmd: "open", args: ["https://example.com/x"] });
  assert.deepEqual(openCommand("file:///srv/a.ts", "linux"), { cmd: "xdg-open", args: ["/srv"] });
  assert.deepEqual(openCommand("https://example.com/x", "linux"), { cmd: "xdg-open", args: ["https://example.com/x"] });
});

test("linkSpans keeps a link the caller already set", () => {
  const spans = [{ text: "/Users/d/a.ts", link: "file:///elsewhere/real.ts" }];
  assert.deepEqual(linkSpans(spans, local), spans);
});

test("linkSpans returns the same array when it finds nothing", () => {
  const spans = [{ text: "nothing to see here" }];
  assert.equal(linkSpans(spans, local), spans, "identity, so React.memo can skip the row");
});
