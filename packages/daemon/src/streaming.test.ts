import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineItem, ToolCallItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";

/**
 * Which timeline row each block of a reply lands on.
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

function harness(): Harness {
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
      threadId: "thread-01-abcdef", sessionId: "sess-1", cwd: "/tmp", model: "opus",
      permissionMode: "default", permissionModeExplicit: false, resume: false, sessionStore: store,
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
  return { sent, rows, feed: async (msg) => { push(msg); await settle(); } };
}

const ev = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: "message_start", message: { id } });
const blockStart = (index: number, block: unknown) => ev({ type: "content_block_start", index, content_block: block });
const blockStop = (index: number) => ev({ type: "content_block_stop", index });
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
  await h.feed(said("msg_1", thought("hmm")));
  await h.feed(said("msg_1", text("Hello")));
  assert.deepEqual(shape(h), ["thinking@msg_1:0", "assistant@msg_1:1"]);
});
