import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";

/**
 * The per-thread streaming switch, driven at the level the SDK talks to us:
 * `handle` translates one SDK message into timeline upserts, and the switch
 * decides whether the `stream_event` messages reach the timeline at all.
 *
 * `start()` is never called, so nothing here spawns the Claude subprocess.
 * `handle` is private to everything but this test, which has to reach it to
 * feed the messages a real session would receive.
 */
type Harness = {
  session: ClaudeSession;
  /** Every upsert, in order. */
  sent: TimelineItem[];
  /** The last version of each item, by id, in first-seen order. */
  items: () => TimelineItem[];
  feed: (msg: unknown) => void;
};

function harness(streaming: boolean): Harness {
  const sent: TimelineItem[] = [];
  const sink: SessionSink = {
    upsertItem: (item) => { sent.push(item); },
    getItemByToolUse: () => null,
    onStatus: () => {},
    onTurnComplete: () => {},
    onSessionInit: () => {},
    onModelUsed: () => {},
    now: () => "2026-09-15T00:00:00.000Z",
  };
  const session = new ClaudeSession(
    {
      threadId: "thread-01-abcdef", sessionId: "sess-1", cwd: "/tmp", model: "opus",
      permissionMode: "default", permissionModeExplicit: false, streaming,
      resume: false, sessionStore: {} as never,
    },
    sink,
  );
  const items = () => {
    const last = new Map<string, TimelineItem>();
    for (const i of sent) last.set(i.id, i);
    return [...last.values()];
  };
  return { session, sent, items, feed: (msg) => (session as unknown as { handle(m: unknown): void }).handle(msg) };
}

const start = { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } };
const blockStart = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
const delta = (text: string) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const blockStop = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
/** Narrow one timeline row to the assistant row it has to be. */
function say(item: TimelineItem | undefined): { id: string; text: string; streaming: boolean } {
  assert.ok(item, "expected a timeline item");
  assert.equal(item.kind, "assistant");
  const a = item as Extract<TimelineItem, { kind: "assistant" }>;
  return { id: a.id, text: a.text, streaming: a.streaming };
}

const assistant = (id: string, text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: "opus", content: [{ type: "text", text }] } });

test("streaming off: the partial messages change nothing, and the reply lands once, whole", () => {
  const h = harness(false);
  for (const m of [start, blockStart, delta("Hel"), delta("lo"), blockStop]) h.feed(m);
  assert.equal(h.sent.length, 0, "no item may reach the timeline before the assistant message");

  h.feed(assistant("msg_1", "Hello"));
  assert.equal(h.sent.length, 1);
  const only = say(h.sent[0]);
  assert.equal(only.id, "msg_1:0", "the id comes from the API message id, so a replay cannot duplicate the row");
  assert.equal(only.text, "Hello");
  assert.equal(only.streaming, false);
});

test("streaming on: one id grows with the whole text each time, and the assistant message reconciles that id", () => {
  const h = harness(true);
  for (const m of [start, blockStart, delta("Hel"), delta("lo")]) h.feed(m);

  assert.deepEqual(h.sent.map((i) => say(i).text), ["", "Hel", "Hello"], "each re-send carries the whole text, not a delta");
  const ids = new Set(h.sent.map((i) => i.id));
  assert.equal(ids.size, 1, "the growing reply keeps one id");
  const id = [...ids][0]!;

  h.feed(blockStop);
  h.feed(assistant("msg_1", "Hello"));
  assert.deepEqual(h.items().map((i) => i.id), [id], "the assistant message reconciles the streamed row rather than adding one");
  const final = say(h.items()[0]);
  assert.equal(final.text, "Hello");
  assert.equal(final.streaming, false);
});

test("the switch goes off mid-message: the open row is finished, and the assistant message does not duplicate it", () => {
  const h = harness(true);
  for (const m of [start, blockStart, delta("Hel")]) h.feed(m);
  const id = say(h.sent[0]).id;

  h.session.setStreaming(false);
  const finished = say(h.items()[0]);
  assert.equal(finished.id, id);
  assert.equal(finished.streaming, false, "no row may keep a cursor that never moves again");

  h.feed(delta("lo"));
  assert.equal(h.items().length, 1);
  assert.equal(say(h.items()[0]).text, "Hel", "the dropped deltas leave the row where it was");

  h.feed(assistant("msg_1", "Hello"));
  assert.deepEqual(h.items().map((i) => i.id), [id], "the same row, not a second one beside it");
  assert.equal(say(h.items()[0]).text, "Hello");
});

test("the switch goes on mid-message: the block already open stays whole-only", () => {
  const h = harness(false);
  for (const m of [start, blockStart, delta("Hel")]) h.feed(m);
  h.session.setStreaming(true);
  h.feed(delta("lo"));
  assert.equal(h.sent.length, 0, "a block with no streamed state cannot take a delta");

  h.feed(assistant("msg_1", "Hello"));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0"]);
});

test("a message cut off part way leaves nothing behind for the next message to land on", () => {
  const h = harness(true);
  for (const m of [start, blockStart, delta("half a sen")]) h.feed(m);
  const first = say(h.sent[0]).id;

  // The turn is interrupted here: no content_block_stop, no assistant message.
  h.session.setStreaming(false);

  // The next message still opens with message_start, because the daemon asks
  // the SDK for partial messages whether the thread wants them or not.
  h.feed(start);
  h.feed(assistant("msg_2", "a new reply"));
  const ids = h.items().map((i) => i.id);
  assert.deepEqual(ids, [first, "msg_2:0"], "the new reply gets its own row");
  assert.equal(say(h.items()[0]).text, "half a sen", "the cut-off row keeps what it had");
});
