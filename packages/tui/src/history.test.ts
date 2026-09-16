import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem } from "@covey/protocol";
import { sentMessages, stepHistory, type HistoryWalk } from "./history.js";
import { wrapEditorLines, caretToVisual } from "./editor.js";

const W = 12;
const lines = (draft: string) => wrapEditorLines(draft, W);

/** One press of up or down on a draft, with the wrap the composer would use. */
function press(entries: string[], walk: HistoryWalk | null, draft: string, caret: number, dir: -1 | 1) {
  return stepHistory(entries, walk, draft, caret, lines(draft), dir);
}

const userItem = (seq: number, text: string, over: Partial<Record<string, unknown>> = {}): TimelineItem => ({
  id: `u${seq}`, threadId: "t", turnId: `t${seq}`, seq, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", kind: "user", text, attachments: [], ...over,
} as unknown as TimelineItem);

test("the entries are this thread's sent messages, newest first", () => {
  const items = [userItem(1, "first"), userItem(3, "third"), userItem(2, "second")];
  assert.deepEqual(sentMessages(items), ["third", "second", "first"]);
});

test("a queued or folded message is in the walk, an empty one is not", () => {
  const items = [
    userItem(1, "sent"),
    userItem(2, "queued", { queued: true }),
    userItem(3, "folded", { folded: true }),
    userItem(4, ""), // an image on its own
    { ...userItem(5, "not a user message"), kind: "assistant" } as TimelineItem,
  ];
  assert.deepEqual(sentMessages(items), ["folded", "queued", "sent"]);
});

test("up from the middle of a wrapped draft moves the caret and does not recall", () => {
  // Three visual rows, caret on the second one.
  const draft = "aaaa bbbb cccc dddd eeee ffff";
  const rows = lines(draft);
  assert.ok(rows.length >= 3, "the draft has to wrap for this test to mean anything");
  const caret = rows[1]!.start + 1;
  assert.equal(caretToVisual(rows, caret).row, 1);
  assert.deepEqual(press(["older"], null, draft, caret, -1), { kind: "move-caret" });
});

test("up from the first visual row recalls, even with the caret past zero", () => {
  const draft = "aaaa bbbb cccc dddd eeee ffff";
  const rows = lines(draft);
  const caret = 2; // on the top row, not at its start
  assert.equal(caretToVisual(rows, caret).row, 0);
  const step = press(["newest", "older"], null, draft, caret, -1);
  assert.deepEqual(step, { kind: "recall", draft: "newest", caret: "newest".length, walk: { at: 0, kept: draft, shown: "newest" } });
});

test("up walks back one message at a time and stops at the oldest", () => {
  const entries = ["c", "b", "a"];
  let draft = "";
  let walk: HistoryWalk | null = null;
  const up = () => {
    const step = press(entries, walk, draft, draft.length, -1);
    if (step.kind === "recall") { draft = step.draft; walk = step.walk; }
    return step.kind;
  };
  assert.equal(up(), "recall"); assert.equal(draft, "c");
  assert.equal(up(), "recall"); assert.equal(draft, "b");
  assert.equal(up(), "recall"); assert.equal(draft, "a");
  // Nothing older: the caret parks, as it does at the top of any draft.
  assert.equal(up(), "move-caret"); assert.equal(draft, "a");
});

test("walking forward past the newest entry restores the kept draft exactly", () => {
  const entries = ["newest", "older"];
  const typed = "half a sentence I was still writing";
  let step = press(entries, null, typed, 0, -1);
  assert.equal(step.kind, "recall");
  let walk = step.kind === "recall" ? step.walk : null;
  let draft = step.kind === "recall" ? step.draft : "";
  assert.equal(draft, "newest");
  // Down from the last row, back past the newest entry.
  step = press(entries, walk, draft, draft.length, 1);
  assert.deepEqual(step, { kind: "recall", draft: typed, caret: typed.length, walk: null });
});

test("down does nothing when no walk is in progress", () => {
  assert.deepEqual(press(["a"], null, "my draft", "my draft".length, 1), { kind: "move-caret" });
});

test("an edit ends the walk, and the edited text is what the next walk keeps", () => {
  const entries = ["newest", "older"];
  const first = press(entries, null, "", 0, -1);
  assert.equal(first.kind, "recall");
  const walk = first.kind === "recall" ? first.walk : null;
  // The person types a character, so the draft is no longer what the walk put there.
  const edited = "newest!";
  const step = press(entries, walk, edited, edited.length, -1);
  assert.deepEqual(step, { kind: "recall", draft: "newest", caret: "newest".length, walk: { at: 0, kept: edited, shown: "newest" } });
  // …and the edit comes back on the way forward. Nothing typed is discarded.
  const back = press(entries, step.kind === "recall" ? step.walk : null, "newest", "newest".length, 1);
  assert.deepEqual(back, { kind: "recall", draft: edited, caret: edited.length, walk: null });
});

test("a thread with no sent messages leaves the arrows alone", () => {
  assert.deepEqual(press([], null, "typing", 0, -1), { kind: "move-caret" });
});
