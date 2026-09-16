import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem, Thread } from "@covey/protocol";
import { layoutTranscript, toolGroupKey } from "./components/Transcript.js";
import { lineText } from "./lines.js";
import type { ThreadView } from "./store.js";

let seq = 0;
const base = (kind: string, turnId: string | null, extra: Record<string, unknown> = {}) =>
  ({ id: `${kind}-${++seq}`, threadId: "t", turnId, seq, createdAt: "", updatedAt: "", kind, ...extra }) as TimelineItem;
const user = (turnId: string, text: string) => base("user", turnId, { text, attachments: [] });
const say = (turnId: string, text: string) => base("assistant", turnId, { text, streaming: false, model: null });
const tool = (turnId: string, summary: string, extra: Record<string, unknown> = {}) =>
  base("tool", turnId, { toolUseId: `u${seq}`, toolName: "Bash", input: {}, summary, status: "completed", output: null, isError: false, parentToolUseId: null, durationMs: 5, ...extra });

function view(items: TimelineItem[], latestTurn: string | null): ThreadView {
  const thread = { latestTurn: latestTurn ? { turnId: latestTurn, state: "completed", startedAt: "", completedAt: "" } : null } as Thread;
  return { machine: "m", threadId: "t", thread, items: new Map(items.map((i) => [i.id, i])), loading: false, error: null, hasMore: false, loadingOlder: false };
}

const text = (l: ReturnType<typeof layoutTranscript>) => l.lines.map(lineText).join("\n");

test("an older turn's tool calls fold into one >_ row, keeping what was said between them", () => {
  const items = [
    user("a", "do it"), say("a", "looking"), tool("a", "ls"), say("a", "now editing"), tool("a", "sed"), tool("a", "cat"), say("a", "done"),
    user("b", "thanks"), say("b", "sure"),
  ];
  const out = text(layoutTranscript(view(items, "b"), 80, new Set()));
  assert.match(out, />_ 3 tool calls/);
  assert.doesNotMatch(out, /\bls\b/, "the calls themselves are folded away");
  assert.match(out, /now editing/, "but the prose around them is not");
});

test("the newest turn keeps its tool calls in full — that is the part being read", () => {
  const items = [user("a", "go"), tool("a", "ls"), tool("a", "cat"), say("a", "done")];
  const out = text(layoutTranscript(view(items, "a"), 80, new Set()));
  assert.doesNotMatch(out, />_/);
  assert.match(out, /ls/);
});

test("a lone tool call is left alone: folding it would hide more than it saves", () => {
  const items = [user("a", "go"), tool("a", "ls"), say("a", "done"), user("b", "ok")];
  const out = text(layoutTranscript(view(items, "b"), 80, new Set()));
  assert.doesNotMatch(out, />_/);
  assert.match(out, /ls/);
});

test("unfolding a group puts the calls back where they were, under an open header", () => {
  const items = [user("a", "go"), tool("a", "first-call"), say("a", "mid"), tool("a", "second-call"), say("a", "done"), user("b", "ok")];
  const out = text(layoutTranscript(view(items, "b"), 80, new Set([toolGroupKey("a")])));
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at(">_ 2 tool calls") >= 0 && at(">_ 2 tool calls") < at("first-call"), "the header stays where the first call was");
  assert.ok(at("first-call") < at("mid"), "and the calls sit among the prose, not bunched under it");
  assert.ok(at("mid") < at("second-call"));
});

test("ctrl+o overrides every fold at once", () => {
  const items = [user("a", "go"), tool("a", "ls"), tool("a", "cat"), say("a", "done"), user("b", "ok")];
  const out = text(layoutTranscript(view(items, "b"), 80, new Set(), undefined, true));
  assert.doesNotMatch(out, />_/);
  assert.match(out, /ls/);
  assert.match(out, /cat/);
});

test("every foldable row is a click target, at the line it starts on", () => {
  const items = [user("a", "go"), tool("a", "ls"), tool("a", "cat"), say("a", "done"), user("b", "ok"), base("thinking", "b", { text: "hmm", streaming: false })];
  const layout = layoutTranscript(view(items, "b"), 80, new Set());
  const groupLine = [...layout.toggles].find(([, id]) => id === toolGroupKey("a"));
  assert.ok(groupLine, "the >_ row toggles its group");
  assert.match(lineText(layout.lines[groupLine![0]]!), />_ 2 tool calls/);
  assert.ok([...layout.toggles.values()].some((id) => id.startsWith("thinking-")), "a thought folds too");
});

test("a failed call is called out on the folded row, so nothing hides a problem", () => {
  const items = [user("a", "go"), tool("a", "ls"), tool("a", "boom", { status: "error", isError: true }), user("b", "ok")];
  assert.match(text(layoutTranscript(view(items, "b"), 80, new Set())), />_ 2 tool calls\s+1 failed/);
});

test("a call still running in the background is counted on the folded row", () => {
  const items = [user("a", "go"), tool("a", "ls"), tool("a", "npm test", { background: { taskId: "k", state: "running", summary: null } }), user("b", "ok")];
  assert.match(text(layoutTranscript(view(items, "b"), 80, new Set())), /1 in the background/);
});
