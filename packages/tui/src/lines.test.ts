import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapSpans, markdownToLines, renderItem, elide, truncate, width, selectedText, highlightLine, colToIndex, isSystemMessage, lineText, lineWidth, activityLine } from "./lines.js";
import { T } from "./theme.js";

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

test("elide keeps both ends of a line and loses its middle", () => {
  // A notice reads "what failed: why". The repository is fifty columns the
  // reader chose two keys ago; the reason is what they can act on, so the
  // back keeps the larger share (#176).
  const notice = "could not clone github.com/dylandotfarm/hardware: no commits yet; push one first";
  const cut = elide(notice, 60);
  assert.equal(width(cut), 60, "it fills the room it was given and not a column more");
  assert.ok(cut.includes("no commits yet; push one first"), "the reason survives whole");
  assert.ok(cut.startsWith("could not clone"), "and the reader still knows what failed");
  const [front, back] = cut.split("…");
  assert.ok(notice.startsWith(front!) && notice.endsWith(back!), "nothing is invented between the ends");

  assert.equal(elide("hello world", 11), "hello world", "a line that fits is left alone");
  assert.equal(elide("hello world", 20), "hello world");
  assert.equal(width(elide("日本語のテキストはここにあります", 9)), 9, "a wide character never overruns the room");
  assert.equal(elide("anything", 2), "…", "and there is always an answer, however little room there is");
  assert.equal(elide("anything", 0), "");
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

/** A message, with whatever the case at hand needs written over the top. */
const msg = (over: Partial<{ text: string; system: boolean; queued: boolean; attachments: unknown[] }> = {}) => ({
  id: "u", threadId: "x", turnId: "t", seq: 1, createdAt: "", updatedAt: "",
  kind: "user", text: "hello", attachments: [], ...over,
} as any);

/** The columns before the first painted character, which is where a block sits. */
const indentOf = (l: { text: string }[]) => lineText(l as any).length - lineText(l as any).trimStart().length;

test("the reader's message is a block against the right edge, hugging its longest row", () => {
  const lines = renderItem(msg({ text: "yes" }), { width: 80, expanded: new Set() });
  const row = lines[0]!;
  assert.equal(lineText(row).trim(), "yes");
  // Two blanks of block padding each side of the word, and the right edge of
  // the block is the right edge of the pane.
  assert.equal(lineWidth(row), 80);
  assert.equal(indentOf(row), 80 - 3 - 4 + 2, "a three-letter message is a three-letter block, not a bar");
  // Every painted column carries the block's ground; the blanks placing it do not.
  assert.equal(row.filter((s) => s.bg).length > 0, true);
  assert.equal(row.find((s) => s.pad)!.bg, undefined, "the run that places the block is not part of it");
});

test("a long message stops at four fifths of the pane and still ends at the right edge", () => {
  const lines = renderItem(msg({ text: "word ".repeat(60).trim() }), { width: 80, expanded: new Set() });
  for (const l of lines.filter((x) => x.length)) assert.equal(lineWidth(l), 80, "every row of a block ends on the same column");
  assert.ok(indentOf(lines[0]!) > 0 && indentOf(lines[0]!) < 20, "the block is wide, and still not flush with the left edge");
});

test("a narrow pane gives the whole width to the message rather than to the margin", () => {
  const lines = renderItem(msg({ text: "a short one" }), { width: 24, expanded: new Set() });
  assert.ok(lineWidth(lines[0]!) <= 24);
  assert.ok(indentOf(lines[0]!) >= 0);
});

test("a message covey wrote keeps the left edge, says who wrote it, and takes its own ground", () => {
  const news = msg({ text: "covey watch: news on pull request #152 (https://example.com).", system: true });
  const lines = renderItem(news, { width: 80, expanded: new Set() });
  assert.equal(lineText(lines[0]!).replace("▌", "").trim(), "covey", "the block names its author on its first row");
  assert.equal(lineText(lines[0]!)[0], "▌", "a rail says whose block it is even where two near-black grounds round to one colour");
  assert.equal(lines[0]![0]!.color, T.system);
  assert.equal(lineText(lines[0]!).indexOf("covey"), 2, "and stays on the left, where the reader's message is not");
  assert.equal(lines[0]!.some((s) => s.bg === T.systemBg), true);
  assert.equal(lines[0]!.some((s) => s.bg === T.userBg), false, "covey's block is not the reader's block");
  // The reader's own message, same words, is still the reader's.
  const mine = renderItem(msg({ text: "covey watch: news on pull request #152 (https://example.com)." , system: false }), { width: 80, expanded: new Set() });
  assert.equal(lineText(mine[0]!)[0], "▌", "…which is why the prefix alone decides it for an item written before the flag");
});

test("the prefix stands in for a daemon too old to mark its own news", () => {
  const old = msg({ text: "covey watch: the checks passed." });
  delete (old as { system?: boolean }).system;
  assert.equal(isSystemMessage(old), true);
  assert.equal(isSystemMessage(msg({ text: "please watch the covey watch: prefix" })), false, "the prefix is a prefix, not a search");
  assert.equal(isSystemMessage(msg({ text: "anything", system: true })), true);
  assert.equal(isSystemMessage({ ...msg(), kind: "assistant" }), false);
});

test("a copy of a right-aligned message carries the words and not the margin", () => {
  const lines = renderItem(msg({ text: "one two three" }), { width: 60, expanded: new Set() });
  const body = lines.filter((l) => l.length);
  // A drag from the left edge of the pane to its right edge, over the row.
  assert.equal(selectedText(body, { line: 0, col: 0 }, { line: 0, col: 60 }), "one two three");
});

test("a queued message keeps its note under the block, not under the pane", () => {
  const lines = renderItem(msg({ text: "hi", queued: true }), { width: 80, expanded: new Set() });
  const note = lines.find((l) => lineText(l).includes("queued"))!;
  assert.equal(lineWidth(note), 80, "the note ends where the block ends");
  assert.ok(indentOf(note) > 20, "so it reads with the message rather than with the margin");
});

test("a file covey is showing is a row of its own, with the daemon's link on the name (#160)", () => {
  const item = {
    id: "n1", threadId: "t-1", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "note", tone: "info", text: "the composer after the fix",
    files: [{ name: "shot.png", path: "/w/.covey/threads/t-1/files/shot.png", mimeType: "image/png" }],
  } as const;
  const links = { localFiles: false, fileBase: "http://box:3790" };
  const lines = renderItem(item as any, { width: 60, expanded: new Set(), links });
  assert.match(text(lines[0]!), /the composer after the fix/);
  assert.match(text(lines[1]!), /⎘ shot\.png/);
  const name = lines[1]!.find((s) => s.text === "shot.png");
  assert.equal(name!.link, "http://box:3790/file?thread=t-1&path=%2Fw%2F.covey%2Fthreads%2Ft-1%2Ffiles%2Fshot.png");

  // No address for that machine: the name still shows, and links nowhere.
  const noLink = renderItem(item as any, { width: 60, expanded: new Set(), links: { localFiles: true } });
  assert.match(text(noLink[1]!), /⎘ shot\.png/);
  assert.equal(noLink[1]!.find((s) => s.text === "shot.png")!.link, undefined);
});

test("a shown file with no words of its own is the file alone (#160)", () => {
  const lines = renderItem({
    id: "n2", threadId: "t-1", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "note", tone: "info", text: "",
    files: [{ name: "demo.mp4", path: "/w/demo.mp4", mimeType: "video/mp4" }],
  } as any, { width: 60, expanded: new Set(), links: { localFiles: false, fileBase: "http://box:3790" } });
  assert.match(text(lines[0]!), /⎘ demo\.mp4/);
});

test("a long note is one row until the reader opens it, and the picture stays (#160)", () => {
  const item = {
    id: "n3", threadId: "t-1", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "note", tone: "info",
    text: "Round 4, eight seeds a style.\n\nH3 held 7 of 8.\n\nH5 held 2 of 8.",
    files: [{ name: "sheet.png", path: "/w/sheet.png", mimeType: "image/png" }],
  } as const;
  const links = { localFiles: false, fileBase: "http://box:3790" };

  const shut = renderItem(item as any, { width: 60, expanded: new Set(), links });
  assert.match(text(shut[0]!), /^ {2}\u25b8 \u2500 Round 4, eight seeds a style\.$/);
  assert.ok(!shut.some((l) => lineText(l).includes("H3 held")), "the rest waits for the reader");
  // The picture is what the reader came for, so it never folds.
  assert.ok(shut.some((l) => lineText(l).includes("\u2398 sheet.png")));

  const open = renderItem(item as any, { width: 60, expanded: new Set(["n3"]), links });
  assert.match(text(open[0]!), /^ {2}\u25be \u2500 Round 4/);
  assert.ok(open.some((l) => lineText(l).includes("H3 held 7 of 8")));
  assert.ok(open.some((l) => lineText(l).includes("H5 held 2 of 8")));
  assert.ok(open.some((l) => lineText(l).includes("\u2398 sheet.png")));
  // The lead is not painted twice when the row is open.
  assert.equal(open.filter((l) => lineText(l).includes("eight seeds")).length, 1);
});

test("a note never leaves a newline inside a span, so the layout counts its rows", () => {
  const lines = renderItem({
    id: "n4", threadId: "t-1", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "note", tone: "info", text: "One.\n\nTwo.\n\nThree.", files: [],
  } as any, { width: 60, expanded: new Set(["n4"]), links: { localFiles: true } });
  for (const l of lines) for (const sp of l) assert.ok(!sp.text.includes("\n"), JSON.stringify(sp.text));
});

test("a short note keeps its dash and grows no arrow", () => {
  const lines = renderItem({
    id: "n5", threadId: "t-1", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "note", tone: "info", text: "Context compacted (auto)", files: [],
  } as any, { width: 60, expanded: new Set(), links: { localFiles: true } });
  assert.equal(text(lines[0]!), "  \u2500 Context compacted (auto)");
});

// A thread at work on nothing the reader sent reads as one that lost its
// place, so the activity row names the reason (#156).
test("the activity row says when a background task woke the turn", () => {
  const plain = activityLine({ tick: 0, elapsedMs: 1000, tools: 2, toolActive: true });
  assert.ok(!lineText(plain).includes("background"));
  const woken = activityLine({ tick: 0, elapsedMs: 1000, tools: 2, toolActive: true, unprompted: true });
  assert.ok(lineText(woken).includes("a background task woke this"), lineText(woken));
  assert.ok(lineText(woken).includes("running tool"), "it still says which kind of work is in flight");
});
