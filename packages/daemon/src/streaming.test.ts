import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";

/**
 * The per-thread streaming switch, and the item ids on both sides of it.
 *
 * The message order here is the order a real CLI sends, measured against the
 * SDK: one `message_start` per API message, then, for every content block, a
 * `content_block_start`, an `assistant` message holding that one block, and a
 * `content_block_stop`. Every `assistant` message of a message carries the
 * same `message.id` and a `content` array of length one, so the index inside
 * that array is always 0.
 *
 * `start()` is never called, so nothing here spawns the Claude subprocess.
 * `handle` is private to everything but this test, which has to reach it to
 * feed the messages a real session receives.
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

const ev = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: "message_start", message: { id } });
const blockStart = (index: number, block: unknown) => ev({ type: "content_block_start", index, content_block: block });
const textStart = (index: number) => blockStart(index, { type: "text", text: "" });
const delta = (index: number, text: string) => ev({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => ev({ type: "content_block_stop", index });
/** One `assistant` message, which is how the CLI reports one finished block. */
const said = (id: string, block: unknown) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: "opus", content: [block] } });
const text = (t: string) => ({ type: "text", text: t });
const thought = (t: string) => ({ type: "thinking", thinking: t });

/** Narrow one timeline row to the assistant row it has to be. */
function say(item: TimelineItem | undefined): { id: string; text: string; streaming: boolean } {
  assert.ok(item, "expected a timeline item");
  assert.equal(item.kind, "assistant");
  const a = item as Extract<TimelineItem, { kind: "assistant" }>;
  return { id: a.id, text: a.text, streaming: a.streaming };
}

test("streaming off: the partial messages change nothing, and the reply lands once, whole", () => {
  const h = harness(false);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel"), delta(0, "lo")]) h.feed(m);
  assert.equal(h.sent.length, 0, "no item may reach the timeline before the assistant message");

  h.feed(said("msg_1", text("Hello")));
  h.feed(blockStop(0));
  assert.equal(h.sent.length, 1);
  const only = say(h.sent[0]);
  assert.equal(only.id, "msg_1:0", "the id is the block's place in the API message");
  assert.equal(only.text, "Hello");
  assert.equal(only.streaming, false);
});

test("streaming on: one id grows with the whole text each time, and the assistant message reconciles that id", () => {
  const h = harness(true);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel"), delta(0, "lo")]) h.feed(m);

  assert.deepEqual(h.sent.map((i) => say(i).text), ["", "Hel", "Hello"], "each re-send carries the whole text, not a delta");
  assert.deepEqual([...new Set(h.sent.map((i) => i.id))], ["msg_1:0"], "the growing reply keeps one id");

  h.feed(said("msg_1", text("Hello")));
  h.feed(blockStop(0));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0"], "the assistant message reconciles the streamed row rather than adding one");
  const final = say(h.items()[0]);
  assert.equal(final.text, "Hello");
  assert.equal(final.streaming, false, "no row is left with a cursor on it");
});

test("streaming on: a thinking block ahead of the text does not put the reply on a second row", () => {
  // The CLI reports each block in its own `assistant` message, so the index
  // inside `content` is 0 for the text as well as for the thinking before it.
  // An id taken from that index did not match the id the stream had already
  // given the text, so the reply was painted twice — once growing, once whole.
  const h = harness(true);
  h.feed(start("msg_1"));
  h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  h.feed(said("msg_1", thought("hmm")));
  h.feed(blockStop(0));
  h.feed(textStart(1));
  h.feed(delta(1, "Hello"));
  h.feed(said("msg_1", text("Hello")));
  h.feed(blockStop(1));

  const rows = h.items();
  assert.deepEqual(rows.map((i) => `${i.kind}@${i.id}`), ["thinking@msg_1:0", "assistant@msg_1:1"], "one row for the thinking, one for the reply");
  assert.equal(say(rows[1]).text, "Hello");
  assert.equal(say(rows[1]).streaming, false, "and no row left with a cursor on it");
});

test("streaming off: the blocks of one API message take separate rows", () => {
  // Same cause, other symptom. Every `assistant` message of a message holds a
  // single block at index 0, so an id built from that index was the same for
  // all of them: the reply landed on the thinking block's row and erased it.
  const h = harness(false);
  h.feed(start("msg_1"));
  h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  h.feed(said("msg_1", thought("hmm")));
  h.feed(textStart(1));
  h.feed(said("msg_1", text("Hello")));

  const rows = h.items();
  assert.deepEqual(rows.map((i) => `${i.kind}@${i.id}`), ["thinking@msg_1:0", "assistant@msg_1:1"], "the reply does not land on the thinking row");
  assert.equal(rows.length, 2, "nothing is overwritten");
});

test("a second API message in the same turn starts its rows over again", () => {
  const h = harness(true);
  h.feed(start("msg_1"));
  h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  h.feed(said("msg_1", thought("hmm")));
  h.feed(start("msg_2"));
  h.feed(textStart(0));
  h.feed(said("msg_2", text("done")));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0", "msg_2:0"], "each message numbers its own blocks");
});

test("a replayed assistant message names the rows it named before", () => {
  const replay = harness(false);
  for (const block of [thought("hmm"), text("Hello")]) replay.feed(said("msg_1", block));
  assert.deepEqual(replay.items().map((i) => i.id), ["msg_1:0", "msg_1:1"], "with no stream events the count still gives the place");
});

test("the switch goes off mid-message: the open row is finished, and the assistant message does not duplicate it", () => {
  const h = harness(true);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel")]) h.feed(m);

  h.session.setStreaming(false);
  const finished = say(h.items()[0]);
  assert.equal(finished.id, "msg_1:0");
  assert.equal(finished.streaming, false, "no row may keep a cursor that never moves again");

  h.feed(delta(0, "lo"));
  assert.equal(h.items().length, 1);
  assert.equal(say(h.items()[0]).text, "Hel", "the dropped deltas leave the row where it was");

  h.feed(said("msg_1", text("Hello")));
  h.feed(blockStop(0));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0"], "the same row, not a second one beside it");
  assert.equal(say(h.items()[0]).text, "Hello", "and the whole text, not the part that streamed");
});

test("the switch goes on mid-message: the block already open stays whole-only", () => {
  const h = harness(false);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel")]) h.feed(m);
  h.session.setStreaming(true);
  h.feed(delta(0, "lo"));
  assert.equal(h.sent.length, 0, "a block with no streamed state cannot take a delta");

  h.feed(said("msg_1", text("Hello")));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0"]);
});

test("the switch goes on mid-message: a block that opens after it still names its own row", () => {
  // `message_start` carries the API message id, and the id of every row in
  // that message is built from it. The reset therefore has to run whether the
  // thread streams or not: behind the switch, a thread that turned streaming
  // on part way through a message had no message id to build ids from, and
  // painted the rest of the reply on a row of its own beside the real one.
  const h = harness(false);
  h.feed(start("msg_1"));
  h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  h.feed(said("msg_1", thought("hmm")));
  h.session.setStreaming(true);
  h.feed(textStart(1));
  h.feed(delta(1, "Hello"));
  h.feed(said("msg_1", text("Hello")));

  assert.deepEqual(h.items().map((i) => `${i.kind}@${i.id}`), ["thinking@msg_1:0", "assistant@msg_1:1"], "the streamed row and the whole row are one row");
});

test("a message cut off part way leaves nothing behind for the next message to land on", () => {
  const h = harness(true);
  for (const m of [start("msg_1"), textStart(0), delta(0, "half a sen")]) h.feed(m);

  // The turn is interrupted here: no assistant message, no block stop.
  h.session.setStreaming(false);

  // The next message still opens with message_start, because the daemon asks
  // the SDK for partial messages whether the thread wants them or not.
  h.feed(start("msg_2"));
  h.feed(said("msg_2", text("a new reply")));
  assert.deepEqual(h.items().map((i) => i.id), ["msg_1:0", "msg_2:0"], "the new reply gets its own row");
  assert.equal(say(h.items()[0]).text, "half a sen", "the cut-off row keeps what it had");
});
