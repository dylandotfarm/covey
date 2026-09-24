import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread, ThreadEvent, TimelineItem } from "@covey/protocol";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

/**
 * Which activity chain a real turn's items land in (#149).
 *
 * `ChainTracker` is tested on its own in `activity.test.ts`; this drives a
 * whole turn through the engine instead, so the `groupId` under test is the
 * one that reaches the database and the wire. Nothing here starts a Claude
 * Code — the engine takes its spawn as an option — and nothing reaches a
 * model: `COVEY_ACTIVITY_MODEL` is off for this file, so the sentence a chain
 * shows is the one the client derives.
 */

process.env.COVEY_ACTIVITY_MODEL = "off";
process.env.COVEY_TITLE_MODEL = "off";

/* eslint-disable @typescript-eslint/no-unused-vars */
/** The turn the fake CLI plays back: what the agent said, and what it ran. */
type Beat = { say: string } | { call: string; name: string };

const TURN: Beat[] = [
  { say: "Let me look at the video path." },
  { call: "Read the decoder", name: "Read" },
  { call: "Grep for ffmpeg", name: "Grep" },
  { call: "Run the tests", name: "Bash" },
  { say: "The decode is fine. Now the fetch." },
  { call: "Read the fetch", name: "Read" },
  { call: "Run the tests again", name: "Bash" },
  { say: "Done." },
];

test("a turn's calls fall into chains, one for each thing the agent said", async () => {
  const h = setup();
  try {
    const items = await h.turn("t1", TURN);

    // What the agent said belongs to no chain: a reader must not lose a
    // message to a fold.
    const said = items.filter((i) => i.kind === "assistant");
    assert.equal(said.length, 3);
    assert.ok(said.every((i) => i.groupId === undefined), "prose is never folded");

    // The calls between two messages share one chain, and the chain's id is
    // the first call's id.
    const calls = items.filter((i) => i.kind === "tool");
    assert.equal(calls.length, 5);
    const first = calls.slice(0, 3);
    const second = calls.slice(3);
    assert.ok(first.every((c) => c.groupId === first[0]!.id), "the first three ran together");
    assert.ok(second.every((c) => c.groupId === second[0]!.id), "and the last two did");
    assert.notEqual(first[0]!.groupId, second[0]!.groupId, "a message between them is a break");

    // Two chains over five calls is what the clients fold into two rows:
    // eight rows of transcript become five. `@covey/client` owns that fold and
    // tests it; the daemon's job is the marking, and this is the marking.
    const chains = new Set(calls.map((c) => c.groupId));
    assert.equal(chains.size, 2);
  } finally { h.cleanup(); }
});

test("the user's own message is never folded, and breaks the chain", async () => {
  const h = setup();
  try {
    const items = await h.turn("t2", [{ call: "Read one", name: "Read" }, { call: "Read two", name: "Read" }]);
    const user = items.find((i) => i.kind === "user");
    assert.ok(user);
    assert.equal(user.groupId, undefined);
  } finally { h.cleanup(); }
});

test("a chain does not span two turns", async () => {
  const h = setup();
  try {
    const one = await h.turn("t3", [{ call: "Read one", name: "Read" }, { call: "Read two", name: "Read" }]);
    const two = await h.turn("t3", [{ call: "Read three", name: "Read" }, { call: "Read four", name: "Read" }]);
    const a = one.filter((i) => i.kind === "tool");
    const b = two.filter((i) => i.kind === "tool").filter((i) => !a.some((x) => x.id === i.id));
    assert.ok(a.length >= 2 && b.length >= 2);
    assert.notEqual(a[0]!.groupId, b[0]!.groupId);
  } finally { h.cleanup(); }
});

test("an item the daemon re-sends keeps the chain it was filed under", async () => {
  const h = setup();
  try {
    const items = await h.turn("t4", [{ call: "Read one", name: "Read" }, { call: "Read two", name: "Read" }]);
    const calls = items.filter((i) => i.kind === "tool");
    // Every version of a call the daemon sent, not only the last: a streaming
    // call is written many times and must never move between chains.
    for (const ev of h.items) {
      if (ev.kind !== "tool") continue;
      const settled = calls.find((c) => c.id === ev.id)!;
      assert.equal(ev.groupId, settled.groupId, `${ev.id} moved chain mid-stream`);
    }
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "covey-chains-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  let beats: Beat[] = [];
  const engine = new Engine(db, MACHINE(), { spawn: ({ prompt, options }) => fakeCli(prompt, options, () => beats) });
  /** Every item the daemon sent, in order, including each re-send. */
  const items: TimelineItem[] = [];
  engine.onThread((_id, e: ThreadEvent) => { if (e.kind === "item.upserted") items.push(e.item); });
  return {
    db, engine, items, dir,
    /** Send one turn and answer with the settled items of the thread. */
    async turn(threadId: string, script: Beat[]): Promise<TimelineItem[]> {
      beats = script;
      if (!db.getThread(threadId)) db.putThread(thread(threadId, dir));
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text: "go" });
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 1));
      return db.listItems(threadId, 500).items;
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const MACHINE = (): MachineInfo => ({
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, claudeCodeVersion: "1.0.0",
  capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
});

function thread(id: string, cwd: string): Thread {
  return {
    id, projectId: "p1", title: id, provider: "claude", sessionId: `sess-${id}`, model: null,
    permissionMode: "default", branch: null, worktreePath: cwd, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * A stand-in for one CLI subprocess that plays a script of messages and tool
 * calls, in the shape the real one sends: one `assistant` message per block,
 * and a `user` message carrying each tool result.
 */
function fakeCli(prompt: AsyncIterable<SDKUserMessage>, options: Options, script: () => Beat[]): Query {
  const out: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
  options.abortController?.signal.addEventListener("abort", () => { done = true; wake?.(); });
  void (async () => {
    for await (const _ of prompt) {
      push({ type: "system", subtype: "init", model: "sonnet", claude_code_version: "1.0.0", permissionMode: "default" });
      let n = 0;
      for (const beat of script()) {
        const id = `blk-${++n}-${randomUUID().slice(0, 8)}`;
        if ("say" in beat) {
          push({ type: "assistant", message: { id, model: "sonnet", content: [{ type: "text", text: beat.say }] } });
          continue;
        }
        push({ type: "assistant", message: { id, model: "sonnet", content: [{ type: "tool_use", id, name: beat.name, input: { description: beat.call } }] } });
        push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
      }
      push({ type: "result", subtype: "success", is_error: false, result: "done", modelUsage: {}, user_message_uuid: null });
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (done) return;
        if (out.length === 0) { await new Promise<void>((r) => (wake = r)); continue; }
        yield out.shift() as never;
      }
    },
    supportedCommands: async () => [],
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
  } as unknown as Query;
}
