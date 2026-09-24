import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem, Thread } from "@covey/protocol";
import { layoutTranscript } from "./components/Transcript.js";
import { lineText } from "./lines.js";
import type { ThreadView } from "./store.js";

let seq = 0;
const base = (kind: string, turnId: string | null, extra: Record<string, unknown> = {}) =>
  ({ id: `${kind}-${++seq}`, threadId: "t", turnId, seq, createdAt: "", updatedAt: "", kind, ...extra }) as TimelineItem;
const user = (turnId: string, text: string) => base("user", turnId, { text, attachments: [] });
const say = (turnId: string, text: string) => base("assistant", turnId, { text, streaming: false, model: null });
const tool = (turnId: string, summary: string, extra: Record<string, unknown> = {}) =>
  base("tool", turnId, { toolUseId: `u${seq}`, toolName: "Bash", input: {}, summary, status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 5, ...extra });

/** Mark a run of items as one chain, the way the daemon's `persistItem` does. */
const chain = (items: TimelineItem[]) => items.map((i) => ({ ...i, groupId: items[0]!.id }) as TimelineItem);

function view(items: TimelineItem[], latestTurn: string | null): ThreadView {
  const thread = { latestTurn: latestTurn ? { turnId: latestTurn, state: "completed", startedAt: "", completedAt: "" } : null } as Thread;
  return { machine: "m", threadId: "t", thread, items: new Map(items.map((i) => [i.id, i])), loading: false, error: null, hasMore: false, loadingOlder: false, seq: items.length, commands: null, dirs: new Map() };
}

const text = (l: ReturnType<typeof layoutTranscript>) => l.lines.map(lineText).join("\n");

test("a chain of tool calls folds into one row, keeping what was said between them", () => {
  const items = [
    user("a", "do it"), say("a", "looking"),
    ...chain([tool("a", "ls"), tool("a", "sed"), tool("a", "cat")]),
    say("a", "done"),
  ];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set()));
  assert.match(out, />_ Ran 3 commands/);
  assert.doesNotMatch(out, /\bls\b/, "the calls themselves are folded away");
  assert.match(out, /looking/, "but the prose around them is not");
  assert.match(out, /done/);
});

test("the running turn folds too — that is where the noise is (#149)", () => {
  // The fold this replaced skipped the live turn, and a covey turn runs for
  // many minutes, so nothing folded until it ended.
  const items = [user("a", "go"), ...chain([tool("a", "ls"), tool("a", "cat")]), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set()));
  assert.match(out, />_ Ran 2 commands/);
  assert.doesNotMatch(out, /\bls\b/);
});

test("a lone tool call is left alone: folding it would hide more than it saves", () => {
  const items = [user("a", "go"), ...chain([tool("a", "ls")]), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set()));
  assert.doesNotMatch(out, />_ /);
  assert.match(out, /ls/);
});

test("the sentence the daemon's model wrote is what the row says", () => {
  const items = chain([tool("a", "ls"), tool("a", "cat")]);
  items[0]!.groupSummary = "Checked the build output";
  assert.match(text(layoutTranscript(view(items, "a"), 80, new Set())), />_ Checked the build output/);
});

test("unfolding a chain puts its calls back under an open header", () => {
  const items = [user("a", "go"), ...chain([tool("a", "first-call"), tool("a", "second-call")]), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set([`chain:${items[1]!.id}`])));
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at(">_ Ran 2 commands") >= 0 && at(">_ Ran 2 commands") < at("first-call"), "the header stays where the first call was");
  assert.ok(at("first-call") < at("second-call"));
});

test("steps puts every call back on a row of its own", () => {
  const items = [user("a", "go"), ...chain([tool("a", "ls"), tool("a", "cat")]), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set(), undefined, "steps"));
  assert.doesNotMatch(out, />_ Ran/);
  assert.match(out, /ls/);
  assert.match(out, /cat/);
});

test("minimal folds the middle of what the agent said, keeping the ends", () => {
  const items = [user("a", "go"), say("a", "starting"), say("a", "halfway"), say("a", "nearly"), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set(), undefined, "minimal"));
  assert.match(out, /starting/);
  assert.match(out, /done/);
  assert.doesNotMatch(out, /halfway/);
  assert.match(out, /2 more messages/);
});

test("every foldable row is a click target, at the line it starts on", () => {
  const items = [user("a", "go"), ...chain([tool("a", "ls"), tool("a", "cat")]), base("thinking", "a", { text: "hmm", streaming: false })];
  const layout = layoutTranscript(view(items, "a"), 80, new Set());
  const chainLine = [...layout.toggles].find(([, id]) => id.startsWith("chain:"));
  assert.ok(chainLine, "the >_ row toggles its chain");
  assert.match(lineText(layout.lines[chainLine![0]]!), />_ Ran 2 commands/);
  assert.ok([...layout.toggles.values()].some((id) => id.startsWith("thinking-")), "a thought outside a chain folds too");
});

test("a failed call is called out on the folded row, so nothing hides a problem", () => {
  const items = chain([tool("a", "ls"), tool("a", "boom", { status: "error", isError: true })]);
  assert.match(text(layoutTranscript(view(items, "a"), 80, new Set())), />_ Ran 2 commands.*1 failed/);
});

test("a call still running is shown under the folded row, not hidden by it", () => {
  const items = chain([tool("a", "ls"), tool("a", "npm test", { status: "running", durationMs: null })]);
  const out = text(layoutTranscript(view(items, "a"), 80, new Set()));
  assert.match(out, /1 running/);
  assert.match(out, /npm test/, "a reader watching a turn must see what it is doing now");
});

test("an attachment the text names inline needs no footer line", () => {
  const withTag = base("user", "a", { text: "why is [shot.png] red?", attachments: [{ name: "shot.png", path: "/d/1.png", mimeType: "image/png" }] });
  const out = text(layoutTranscript(view([withTag], "a"), 80, new Set()));
  assert.match(out, /why is \[shot\.png\] red\?/);
  assert.doesNotMatch(out, /⎘/, "the tag already says which file this is");
});

test("a message from before tags existed keeps its footer line", () => {
  const old = base("user", "a", { text: "look at this", attachments: [{ name: "shot.png", path: "/d/1.png", mimeType: "image/png" }] });
  const out = text(layoutTranscript(view([old], "a"), 80, new Set()));
  assert.match(out, /⎘ shot\.png/);
});

test("a dropped directory was one tag, so it needs no footer line either", () => {
  const files = [
    { name: "a.md", path: "/d/notes/a.md", mimeType: "text/markdown", dir: "notes" },
    { name: "deep/b.md", path: "/d/notes/deep/b.md", mimeType: "text/markdown", dir: "notes" },
  ];
  const named = base("user", "a", { text: "read [notes/] first", attachments: files });
  assert.doesNotMatch(text(layoutTranscript(view([named], "a"), 80, new Set())), /⎘/);

  // And when the text does not name it, the footer says the directory once —
  // not a line that spells out every file under it.
  const unnamed = base("user", "a", { text: "read this", attachments: files });
  const out = text(layoutTranscript(view([unnamed], "a"), 80, new Set()));
  assert.match(out, /⎘ notes\//);
  assert.doesNotMatch(out, /a\.md/);
});
