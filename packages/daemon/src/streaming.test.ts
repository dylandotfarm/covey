import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineItem, ToolCallItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";

/**
 * Which timeline row each block of a reply lands on, and the per-thread
 * switch that decides whether the partial messages reach the timeline at all.
 *
 * The message order here is the order a real CLI sends, measured against the
 * SDK: one `message_start` per API message, then, for every content block, a
 * `content_block_start`, an `assistant` message holding that one block, and a
 * `content_block_stop`. Every `assistant` message of a message carries the
 * same `message.id` and a `content` array of length one, so the index inside
 * that array is always 0 and identifies nothing.
 *
 * The session takes its query factory as an argument, so these feed it the
 * messages one at a time and watch what reaches the sink. Nothing here spawns
 * a Claude subprocess.
 */
type Harness = {
  session: ClaudeSession;
  /** Every upsert, in order. */
  sent: TimelineItem[];
  /** The last version of each row, by id, in first-seen order. */
  rows: () => TimelineItem[];
  /** Hand the session one SDK message and let it work through it. */
  feed: (msg: unknown) => Promise<void>;
};

/** A query the test feeds one message at a time, the way the CLI would. */
function fakeQuery() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const q = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield queue.shift();
      }
    },
    supportedCommands: async () => [],
    interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
    backgroundTasks: async () => true,
  } as unknown as Query;
  return { q, push: (m: unknown) => { queue.push(m); wake?.(); wake = null; } };
}

/** Let the session's message pump work through what it was just handed. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function harness(streaming: boolean): Harness {
  const sent: TimelineItem[] = [];
  const sink: SessionSink = {
    upsertItem: (item) => { sent.push(item); },
    getItemByToolUse: (id) => (sent.filter((i) => i.kind === "tool" && i.toolUseId === id).pop() as ToolCallItem) ?? null,
    onStatus: () => {}, onTurnComplete: () => {}, onSessionInit: () => {}, onModelUsed: () => {},
    onCommands: () => {},
    now: () => "2026-09-15T00:00:00.000Z",
  };
  const store = { append: () => {}, load: () => null, listSessions: () => [] } as unknown as SessionStore;
  const { q, push } = fakeQuery();
  const session = new ClaudeSession(
    {
      threadId: "thread-01-abcdef", sessionId: "sess-1", projectId: "p1", cwd: "/tmp", model: "opus",
      permissionMode: "default", permissionModeExplicit: false, streaming,
      resume: false, sessionStore: store,
    },
    sink,
    () => q,
  );
  session.start();
  const rows = () => {
    const last = new Map<string, TimelineItem>();
    for (const i of sent) last.set(i.id, i);
    return [...last.values()];
  };
  return { session, sent, rows, feed: async (msg) => { push(msg); await settle(); } };
}

const ev = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: "message_start", message: { id } });
const blockStart = (index: number, block: unknown) => ev({ type: "content_block_start", index, content_block: block });
const blockStop = (index: number) => ev({ type: "content_block_stop", index });
const textStart = (index: number) => blockStart(index, { type: "text", text: "" });
const delta = (index: number, t: string) => ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
/** One `assistant` message, which is how the CLI reports one block. */
const said = (id: string, block: unknown) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: "opus", content: [block] } });
const text = (t: string) => ({ type: "text", text: t });
const thought = (t: string) => ({ type: "thinking", thinking: t });
const shape = (h: Harness) => h.rows().map((i) => `${i.kind}@${i.id}`);

test("a sentence before a tool call is not erased by it", async () => {
  // The face of this defect that a default install hits. The model writes a
  // line about what it is about to do and calls a tool in the same API
  // message. Both blocks were given the id of block 0, so the tool row landed
  // on the sentence and the sentence left the transcript for good.
  const h = harness(false);
  await h.feed(start("msg_1"));
  await h.feed(said("msg_1", text("I'll run a simple echo command.")));
  await h.feed(said("msg_1", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }));

  assert.deepEqual(shape(h), ["assistant@msg_1:0", "tool@msg_1:1"], "the sentence keeps its row");
  const sentence = h.rows()[0]!;
  assert.equal(sentence.kind === "assistant" && sentence.text, "I'll run a simple echo command.");
});

test("a thinking block is not erased by the reply that follows it", async () => {
  // The same defect, reached the other common way: thinking at block 0 and the
  // reply at block 1 of one API message. The reply took the thinking row's id,
  // so the thought disclosure never appeared.
  const h = harness(false);
  await h.feed(start("msg_1"));
  await h.feed(said("msg_1", thought("17 sheep, all but 9 run away")));
  await h.feed(said("msg_1", text("Nine remain, then four after the sale.")));

  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_1:1"], "the thought keeps its row");
  const thinking = h.rows()[0]!;
  assert.equal(thinking.kind === "thinking" && thinking.text, "17 sheep, all but 9 run away");
});

test("a reply behind a thinking block is one row, not two", async () => {
  // The face of it that shows when the partial messages are switched on. The
  // reply already had a row from the stream; the `assistant` message did not
  // recognise that row and painted the reply a second time, leaving the first
  // copy growing for good.
  const h = harness(false);
  await h.feed(start("msg_1"));
  await h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  await h.feed(said("msg_1", thought("hmm")));
  await h.feed(blockStop(0));
  await h.feed(blockStart(1, { type: "text", text: "" }));
  await h.feed(delta(1, "Hello"));
  await h.feed(said("msg_1", text("Hello")));
  await h.feed(blockStop(1));

  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_1:1"], "one row for the thought, one for the reply");
  const reply = h.rows()[1]!;
  assert.equal(reply.kind === "assistant" && reply.streaming, false, "and no row left with a cursor on it");
});

test("each API message of a turn numbers its own blocks", async () => {
  const h = harness(false);
  await h.feed(start("msg_1"));
  await h.feed(said("msg_1", thought("hmm")));
  await h.feed(start("msg_2"));
  await h.feed(said("msg_2", text("done")));
  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_2:0"], "a new message starts its rows over again");
});

test("a replayed assistant message names the rows it named before", async () => {
  // Resume replays the messages with no stream events behind them. Counting
  // the blocks gives the same places, so a replay writes the same rows rather
  // than a second set beside them.
  const h = harness(false);
  await h.feed(said("msg_1", thought("hmm")));
  await h.feed(said("msg_1", text("Hello")));
  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_1:1"]);
});


// ---------------------------------------------------------------------------
// The per-thread switch
// ---------------------------------------------------------------------------

/** Narrow one row to the assistant row it has to be. */
function say(item: TimelineItem | undefined): { id: string; text: string; streaming: boolean } {
  assert.ok(item, "expected a timeline item");
  assert.equal(item.kind, "assistant");
  const a = item as Extract<TimelineItem, { kind: "assistant" }>;
  return { id: a.id, text: a.text, streaming: a.streaming };
}

test("streaming off: the partial messages change nothing, and the reply lands once, whole", async () => {
  const h = harness(false);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel"), delta(0, "lo")]) await h.feed(m);
  assert.equal(h.sent.length, 0, "no item may reach the timeline before the assistant message");

  await h.feed(said("msg_1", text("Hello")));
  await h.feed(blockStop(0));
  assert.equal(h.sent.length, 1);
  const only = say(h.sent[0]);
  assert.equal(only.id, "msg_1:0");
  assert.equal(only.text, "Hello");
  assert.equal(only.streaming, false);
});

test("streaming on: one id grows with the whole text each time", async () => {
  const h = harness(true);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel"), delta(0, "lo")]) await h.feed(m);

  assert.deepEqual(h.sent.map((i) => say(i).text), ["", "Hel", "Hello"], "each re-send carries the whole text, not a delta");
  assert.deepEqual([...new Set(h.sent.map((i) => i.id))], ["msg_1:0"], "the growing reply keeps one id");

  await h.feed(said("msg_1", text("Hello")));
  await h.feed(blockStop(0));
  assert.deepEqual(shape(h), ["assistant@msg_1:0"], "the assistant message reconciles that row rather than adding one");
  assert.equal(say(h.rows()[0]).streaming, false, "no row is left with a cursor on it");
});

test("the switch goes off mid-message: the open row is finished, and is not duplicated", async () => {
  const h = harness(true);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel")]) await h.feed(m);

  h.session.setStreaming(false);
  const finished = say(h.rows()[0]);
  assert.equal(finished.id, "msg_1:0");
  assert.equal(finished.streaming, false, "no row may keep a cursor that never moves again");

  await h.feed(delta(0, "lo"));
  assert.equal(h.rows().length, 1);
  assert.equal(say(h.rows()[0]).text, "Hel", "the dropped deltas leave the row where it was");

  await h.feed(said("msg_1", text("Hello")));
  await h.feed(blockStop(0));
  assert.deepEqual(shape(h), ["assistant@msg_1:0"], "the same row, not a second one beside it");
  assert.equal(say(h.rows()[0]).text, "Hello", "and the whole text, not the part that streamed");
});

test("the switch goes on mid-message: the block already open stays whole-only", async () => {
  const h = harness(false);
  for (const m of [start("msg_1"), textStart(0), delta(0, "Hel")]) await h.feed(m);
  h.session.setStreaming(true);
  await h.feed(delta(0, "lo"));
  assert.equal(h.sent.length, 0, "a block with no streamed state cannot take a delta");

  await h.feed(said("msg_1", text("Hello")));
  assert.deepEqual(shape(h), ["assistant@msg_1:0"]);
});

test("the switch goes on mid-message: a block that opens after it still names its own row", async () => {
  // `message_start` carries the API message id, and the id of every row in
  // that message is built from it. The reset therefore has to run whether the
  // thread streams or not: behind the switch, a thread that turned streaming
  // on part way through a message had no message id to build ids from, and
  // painted the rest of the reply on a row of its own beside the real one.
  const h = harness(false);
  await h.feed(start("msg_1"));
  await h.feed(blockStart(0, { type: "thinking", thinking: "" }));
  await h.feed(said("msg_1", thought("hmm")));
  h.session.setStreaming(true);
  await h.feed(textStart(1));
  await h.feed(delta(1, "Hello"));
  await h.feed(said("msg_1", text("Hello")));

  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_1:1"], "the streamed row and the whole row are one row");
});
