import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { SlashCommandInfo, TimelineItem } from "@covey/protocol";
import { ClaudeSession, type SessionSink } from "./claude.js";

/**
 * What `ClaudeSession` does with the SDK's messages, without a Claude
 * subprocess. The session takes its query factory as an argument, so these
 * feed it a fixed run of messages and watch what reaches the sink.
 */

const INIT = {
  type: "system", subtype: "init", model: "claude-opus-5", claude_code_version: "2.1.0",
  permissionMode: "default", slash_commands: [], cwd: "/tmp", tools: [], mcp_servers: [],
  apiKeySource: "none", output_style: "default", skills: [], plugins: [], uuid: "u0", session_id: "s1",
};

/** A query that yields `messages` and then ends. */
function fakeQuery(messages: unknown[], commands: unknown[] = []) {
  const calls = { supportedCommands: 0 };
  const q = {
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    supportedCommands: async () => { calls.supportedCommands++; return commands; },
    interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
    backgroundTasks: async () => true,
  } as unknown as Query;
  return { q, calls };
}

interface Seen {
  items: TimelineItem[];
  commands: SlashCommandInfo[][];
}

/** Run a session over `messages` and report everything the sink was told. */
async function run(messages: unknown[], commands: unknown[] = []): Promise<Seen & { supportedCommandsCalls: number }> {
  const seen: Seen = { items: [], commands: [] };
  const sink: SessionSink = {
    now: () => "2026-01-01T00:00:00Z",
    upsertItem: (item) => { seen.items.push(item); },
    getItemByToolUse: () => null,
    onStatus: () => {}, onTurnComplete: () => {}, onSessionInit: () => {}, onModelUsed: () => {},
    onCommands: (c) => { seen.commands.push(c); },
  };
  const store = { append: () => {}, load: () => null, listSessions: () => [] } as unknown as SessionStore;
  const { q, calls } = fakeQuery(messages, commands);
  const session = new ClaudeSession(
    { threadId: "t1", sessionId: "s1", projectId: "p1", cwd: "/tmp", model: null, permissionMode: "default", permissionModeExplicit: false, streaming: false, resume: false, sessionStore: store },
    sink,
    () => q,
  );
  session.start();
  // The run of messages, then the answer to supportedCommands() behind it.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return { ...seen, supportedCommandsCalls: calls.supportedCommands };
}

/**
 * An agent inside a covey thread has no other way to learn which thread it is.
 * The daemon sees a websocket, not the process behind it, so a program that
 * creates a thread can only say "I am a child of this one" if the session told
 * it — which is what made some agent threads nest and some stand alone.
 *
 * The SDK replaces the subprocess environment with this object instead of
 * merging it, so the case also holds the spread of `process.env`: without it a
 * session starts with no PATH, no HOME and no credentials.
 */
test("the session tells the agent which thread and project it is working in", async () => {
  const sink: SessionSink = {
    now: () => "2026-01-01T00:00:00Z",
    upsertItem: () => {}, getItemByToolUse: () => null,
    onStatus: () => {}, onTurnComplete: () => {}, onSessionInit: () => {}, onModelUsed: () => {},
    onCommands: () => {},
  };
  const store = { append: () => {}, load: () => null, listSessions: () => [] } as unknown as SessionStore;
  const { q } = fakeQuery([]);
  let options: any = null;
  const session = new ClaudeSession(
    { threadId: "t-42", sessionId: "s1", projectId: "p-9", cwd: "/tmp", model: null, permissionMode: "default", permissionModeExplicit: false, streaming: false, resume: false, sessionStore: store },
    sink,
    (args) => { options = args.options; return q; },
  );
  session.start();
  assert.equal(options.env.COVEY_THREAD_ID, "t-42");
  assert.equal(options.env.COVEY_PROJECT_ID, "p-9");
  assert.equal(options.env.PATH, process.env.PATH, "and the environment it had before, which the SDK would otherwise replace");
});

test("the `/` menu is read off the session as soon as it starts", async () => {
  const r = await run([INIT], [{ name: "compact", description: "Compact the conversation", argumentHint: "" }]);
  assert.equal(r.supportedCommandsCalls, 1, "the session never asked the SDK which commands it supports");
  assert.deepEqual(r.commands, [[{ name: "compact", description: "Compact the conversation", argumentHint: "", source: "sdk" }]]);
});

test("a session with no commands still reports, so the thread stops saying it does not know", async () => {
  const r = await run([INIT], []);
  assert.deepEqual(r.commands, [[]]);
});

test("a mid-session commands_changed push replaces the menu", async () => {
  const changed = { type: "system", subtype: "commands_changed", commands: [{ name: "review", description: "Review the diff", argumentHint: "" }], uuid: "u1", session_id: "s1" };
  const r = await run([INIT, changed], [{ name: "compact", description: "", argumentHint: "" }]);
  // Deliberately not counted against the list read at start: this case has to
  // fail for the push alone, so that a failure names the push and nothing else.
  const pushed = r.commands.filter((c) => c.length === 1 && c[0]!.name === "review");
  assert.equal(pushed.length, 1, "the SDK pushed a fresh command list and the session ignored it");
});

test("a command the terminal owns is kept out of a remote client's menu", async () => {
  const withTerminal = { ...INIT, terminal_slash_commands: ["exit"] };
  const r = await run([withTerminal], [{ name: "exit", description: "", argumentHint: "" }, { name: "compact", description: "", argumentHint: "" }]);
  assert.deepEqual(r.commands[0]!.map((c) => c.name), ["compact"]);
});

test("the output of a local command reaches the transcript", async () => {
  const output = { type: "system", subtype: "local_command_output", content: "Context usage: 42%", uuid: "u1", session_id: "s1" };
  const r = await run([INIT, output]);
  const shown = r.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text);
  assert.deepEqual(shown, ["Context usage: 42%"], "a local command ran and its output went nowhere");
});
