import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapSpans, markdownToLines, renderItem, truncate, width, selectedText, highlightLine, colToIndex, lineText } from "./lines.js";

const text = (l: { text: string }[]) => l.map((s) => s.text).join("");

test("wrapSpans wraps at word boundaries", () => {
  const lines = wrapSpans([{ text: "the quick brown fox jumps over the lazy dog" }], 10);
  assert.deepEqual(lines.map(text), ["the quick", "brown fox", "jumps over", "the lazy", "dog"]);
});

test("wrapSpans hard-breaks tokens longer than the width", () => {
  const lines = wrapSpans([{ text: "abcdefghijklmnop" }], 5);
  assert.deepEqual(lines.map(text), ["abcde", "fghij", "klmno", "p"]);
});

test("markdownToLines handles fences, bullets and inline code", () => {
  const lines = markdownToLines("# Title\n\n- one `x`\n- two\n\n```js\nconst a = 1;\n```", 40);
  const texts = lines.map(text);
  assert.equal(texts[0], "Title");
  assert.ok(texts.some((t) => t.startsWith("• one x")));
  assert.ok(texts.some((t) => t.trim() === "js"));
  assert.ok(texts.some((t) => t.startsWith("const a = 1;")));
});

test("markdownToLines renders a link's label, not its raw source", () => {
  // Before link support `inline()` had no case for `[text](url)`, so the whole
  // markdown form reached the screen as characters.
  assert.equal(markdownToLines("read [the notes](https://example.com/n) today", 60).map(text).join(""), "read the notes today");
});

test("a backgrounded tool row says the work is still going, not that it is done", () => {
  const item = { id: "t", threadId: "x", turnId: null, seq: 1, createdAt: "", updatedAt: "", kind: "tool", toolUseId: "u", toolName: "Bash", input: {}, summary: "npm test", status: "completed", output: "running in the background", isError: false, parentToolUseId: null, durationMs: 4 } as const;
  const running = renderItem({ ...item, background: { taskId: "k", state: "running", summary: null } }, { width: 80, expanded: new Set() });
  assert.match(lineText(running[0]!), /npm test\s+in the background/);
  const done = renderItem({ ...item, background: { taskId: "k", state: "completed", summary: 'Background command "npm test" completed' } }, { width: 80, expanded: new Set() });
  assert.match(lineText(done[0]!), /npm test\s+background · done$/, "a clean finish does not repeat itself");
  const failed = renderItem({ ...item, background: { taskId: "k", state: "failed", summary: "exit 1" } }, { width: 80, expanded: new Set() });
  assert.match(lineText(failed[0]!), /background · failed\s+exit 1/, "a failure says what went wrong");
});

test("renderItem tool row is a single line when collapsed", () => {
  const lines = renderItem({ id: "t", threadId: "x", turnId: null, seq: 1, createdAt: "", updatedAt: "", kind: "tool", toolUseId: "u", toolName: "Read", input: {}, summary: "Read a.ts", status: "completed", output: "many\nlines", isError: false, parentToolUseId: null, durationMs: 12 }, { width: 80, expanded: new Set() });
  assert.equal(lines.length, 1);
  assert.match(text(lines[0]!), /✓ Read a\.ts/);
});

test("truncate and width", () => {
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.equal(width("日本"), 4);
});

const L = (s: string) => [{ text: s }];

test("selectedText takes a partial first and last line", () => {
  const lines = [L("first line"), L("second line"), L("third line")];
  assert.equal(selectedText(lines, { line: 0, col: 6 }, { line: 2, col: 5 }), "line\nsecond line\nthird");
});

test("selectedText within a single line", () => {
  assert.equal(selectedText([L("hello world")], { line: 0, col: 6 }, { line: 0, col: 11 }), "world");
});

test("selectedText drops the padding used to draw message blocks", () => {
  const padded = [[{ text: "  hi" }, { text: "        ", bg: "#222" }]];
  assert.equal(selectedText(padded, { line: 0, col: 0 }, { line: 0, col: 12 }), "  hi");
});

test("colToIndex accounts for double-width glyphs", () => {
  const line = [{ text: "日本ab" }];
  assert.equal(colToIndex(line, 4), 2); // two wide chars occupy 4 columns
  assert.equal(lineText(line), "日本ab");
});

test("highlightLine splits spans and applies a background to the range", () => {
  const out = highlightLine([{ text: "abcdef", color: "x" }], 2, 4, "#333");
  assert.deepEqual(out, [
    { text: "ab", color: "x" },
    { text: "cd", color: "x", bg: "#333" },
    { text: "ef", color: "x" },
  ]);
});

test("highlightLine spanning a boundary keeps both spans' styles", () => {
  const out = highlightLine([{ text: "ab", color: "x" }, { text: "cd", color: "y" }], 1, 3, "#333");
  assert.deepEqual(out.map((s) => [s.text, s.color, s.bg]), [
    ["a", "x", undefined],
    ["b", "x", "#333"],
    ["c", "y", "#333"],
    ["d", "y", undefined],
  ]);
});

const TABLE = [
  "| Batch | Issues |",
  "|---|---|",
  "| Deformers merge c759ca22 | #4, #118 |",
  "| Corner-pin survey 1aa5803a / 9582328b | #143, #144, #145, #146 |",
  "| gate-promotion | #119 |",
].join("\n");

test("markdownToLines lays a pipe table out in aligned columns", () => {
  // Before table support each row reached the screen as its own source line,
  // pipes and all, and nothing lined up.
  const texts = markdownToLines(TABLE, 80).map(text);
  assert.deepEqual(texts, [
    "Batch                                  Issues",
    "─────────────────────────────────────  ──────────────────────",
    "Deformers merge c759ca22               #4, #118",
    "Corner-pin survey 1aa5803a / 9582328b  #143, #144, #145, #146",
    "gate-promotion                         #119",
  ]);
  const head = markdownToLines(TABLE, 80)[0]!;
  assert.ok(head.filter((s) => s.text.trim()).every((s) => s.bold), "the header row is bold");
});

test("a table wider than the pane wraps a cell inside its own column", () => {
  // A source row wider than the pane used to wrap mid-row, with the tail of one
  // row on a line of its own. Now the widest column gives up width, the cell
  // wraps in it, and every line stays inside the pane.
  const lines = markdownToLines(TABLE, 40);
  const texts = lines.map(text);
  assert.ok(texts.every((t) => width(t) <= 40), `every line fits: ${JSON.stringify(texts)}`);
  assert.deepEqual(texts.slice(2), [
    "Deformers merge      #4, #118",
    "c759ca22",
    "Corner-pin survey    #143, #144, #145,",
    "1aa5803a / 9582328b  #146",
    "gate-promotion       #119",
  ]);
  assert.ok(lines.every((l) => l.wrap === undefined), "a table row is a row of its own, like a list item");
});

test("a table's rule row sets the alignment of each column", () => {
  const texts = markdownToLines("| n | name | mid |\n|--:|:--|:-:|\n| 1 | a | b |\n| 100 | bb | ccc |", 80).map(text);
  assert.equal(texts[2], "  1  a      b");
  assert.equal(texts[3], "100  bb    ccc");
});

test("a cell keeps its inline markdown and an escaped pipe", () => {
  const lines = markdownToLines("| a | b |\n|---|---|\n| **bold** | `x \\| y` |", 80);
  assert.equal(text(lines[2]!), "bold  x | y");
  assert.ok(lines[2]![0]!.bold, "bold survives in a cell");
});

test("a row with a pipe and no rule row under it is text, not a table", () => {
  const texts = markdownToLines("use a | b here\nand more", 80).map(text);
  assert.deepEqual(texts, ["use a | b here", "and more"]);
});

test("a table ends at a blank line and a short row is padded", () => {
  const texts = markdownToLines("| a | b |\n|---|---|\n| 1 |\n\nafter", 80).map(text);
  assert.deepEqual(texts, ["a  b", "─  ─", "1", "", "after"]);
});
