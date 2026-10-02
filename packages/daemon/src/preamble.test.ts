/**
 * The note every session reads about covey (`COVEY_PREAMBLE`).
 *
 * The plugin alone only offers the skill; the model chose, turn by turn,
 * whether to read it, and a thread that opened with "fix this bug" pushed with
 * `git` and opened with `gh` instead. These cases hold the three things that
 * make the note work: it reaches the SDK as an append to Claude Code's own
 * prompt, it travels with the plugin and never without it, and it stays a
 * pointer to the skill rather than a copy of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, Query, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { MachineInfo, Project, Thread } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";
import { COVEY_PREAMBLE } from "./plugin.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";

const SINK: SessionSink = {
  now: () => "2026-01-01T00:00:00Z",
  upsertItem: () => {}, getItemByToolUse: () => null,
  onStatus: () => {}, onTurnComplete: () => {}, onSessionInit: () => {}, onModelUsed: () => {},
  onCommands: () => {},
};

const STORE = { append: () => {}, load: () => null, listSessions: () => [] } as unknown as SessionStore;

const QUERY = {
  async *[Symbol.asyncIterator]() {},
  supportedCommands: async () => [],
  interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
  backgroundTasks: async () => true,
} as unknown as Query;

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

// ---- the SDK option -------------------------------------------------------

/**
 * The note rides on Claude Code's own system prompt rather than on the first
 * user message, because the system prompt is the one text a session reads
 * before its first turn, on a resume as well as on a start.
 */
test("the note reaches the SDK as an append to Claude Code's own prompt", () => {
  const start = (systemPromptAppend?: string) => {
    let options: any = null;
    new ClaudeSession(
      {
        threadId: "t-1", sessionId: "s1", projectId: "p-1", cwd: "/tmp", model: null,
        permissionMode: "default", permissionModeExplicit: false, streaming: false,
        resume: false, sessionStore: STORE, ...(systemPromptAppend ? { systemPromptAppend } : {}),
      },
      SINK,
      (args) => { options = args.options; return QUERY; },
    ).start();
    return options.systemPrompt;
  };
  assert.deepEqual(start("follow the skill"), { type: "preset", preset: "claude_code", append: "follow the skill" });
  // No note, no key: the preset alone is what a session had before this, and
  // an `append: undefined` would be a different prompt to the SDK.
  assert.deepEqual(start(), { type: "preset", preset: "claude_code" });
});

// ---- the note and the skill travel together -------------------------------

const MACHINE: MachineInfo = {
  machineId: "m1", name: "test", os: "linux", arch: "arm64", homeDir: "/tmp", daemonVersion: "0",
  protocolVersion: 1, capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
  settings: { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null },
};

/** An engine whose one session is a stand-in, so nothing starts Claude. */
function setup(plugins?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "covey-preamble-"));
  const db = new Db(dir);
  db.putProject({
    id: "p1", title: "p", workspaceRoot: dir, repositoryIdentity: null,
    defaultModel: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Project);
  db.putThread({
    id: "t1", projectId: "p1", title: "t1", provider: "claude", sessionId: "sess-t1", model: null,
    permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
    pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
    pinnedAt: null, movedTo: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as Thread);
  const seen: Options[] = [];
  const engine = new Engine(db, MACHINE, {
    spawn: ({ options }) => { seen.push(options); return QUERY; },
    ...(plugins ? { plugins } : {}),
  });
  return {
    seen,
    async send() {
      await engine.dispatch({ commandId: randomUUID(), type: "turn.send", threadId: "t1", turnId: randomUUID(), text: "hello" });
      await settle();
    },
    cleanup() { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a session that gets the skill gets the note with it", async (t) => {
  const s = setup(["/srv/covey/plugin"]);
  t.after(s.cleanup);
  await s.send();
  assert.equal(s.seen.length, 1);
  assert.deepEqual(s.seen[0]!.plugins, [{ type: "local", path: "/srv/covey/plugin" }]);
  assert.deepEqual(s.seen[0]!.systemPrompt, { type: "preset", preset: "claude_code", append: COVEY_PREAMBLE });
});

/**
 * A daemon that does not run from a checkout has no `plugin/` to hand over. A
 * note that told such a session to load a skill it cannot load would be worse
 * than no note at all, so the two go together or neither goes.
 */
test("a session that gets no skill gets no note either", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.send();
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0]!.plugins, undefined);
  assert.deepEqual(s.seen[0]!.systemPrompt, { type: "preset", preset: "claude_code" });
});

// ---- what the note says ---------------------------------------------------

/**
 * Every word of the note rides on every turn of every thread, and the loop it
 * points at costs nothing until the model loads the skill. So the note names
 * the skill and the command and stops. The budget is the point of the case: a
 * note that grew into a second copy of the loop would drift from the first.
 */
test("the note points at the skill, and stays short enough to ride on every turn", () => {
  assert.match(COVEY_PREAMBLE, /covey:covey/, "the note never names the skill the session must load");
  assert.match(COVEY_PREAMBLE, /`covey` command/, "the note never names the command the skill is driven with");
  assert.ok(COVEY_PREAMBLE.length < 1200, `the note is ${COVEY_PREAMBLE.length} characters; keep it a pointer to the skill`);
});

/**
 * Two acts a person cannot take back. They sit in the note rather than only in
 * the skill, because a session reads the note before it decides whether to read
 * the skill, and a warning belongs before the step it applies to.
 */
test("the note holds the two rules that a reader cannot undo", () => {
  assert.match(COVEY_PREAMBLE, /Never push to the base branch/);
  assert.match(COVEY_PREAMBLE, /Never merge a pull request yourself/);
});
