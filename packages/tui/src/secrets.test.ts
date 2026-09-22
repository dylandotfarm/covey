/**
 * The secrets panel's list — issue #126.
 *
 * The panel paints names and nothing else, because names are all a client
 * ever holds: a value goes to the daemon and never comes back. What is left
 * to get right is which names a panel shows, and that is this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.COVEY_CONFIG = mkdtempSync(join(tmpdir(), "covey-tui-secrets-"));

import type { Project, Thread } from "@covey/protocol";
import { secretPanelKeys, type AppState, type MachineState, type Overlay } from "./store.js";

const PI = "ws://pi:3790", MAC = "ws://mac:3790";

const project = (id: string, secretKeys?: string[]): Project => ({
  id, title: "covey", workspaceRoot: `/repos/${id}`, repositoryIdentity: "github.com/o/r",
  defaultModel: null, createdAt: "", updatedAt: "", ...(secretKeys ? { secretKeys } : {}),
});

const thread = (id: string, secretKeys?: string[]): Thread => ({
  id, projectId: "p", title: id, provider: "claude", sessionId: id, model: null, permissionMode: "default",
  branch: null, worktreePath: null, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0,
  latestTurn: null, lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null,
  createdAt: "", updatedAt: "", ...(secretKeys ? { secretKeys } : {}),
});

function state(machines: [string, Project[], Thread[]][]): AppState {
  return {
    machines: new Map(machines.map(([key, projects, threads]) => [key, {
      key, projects: new Map(projects.map((p) => [p.id, p])), threads: new Map(threads.map((t) => [t.id, t])),
    } as unknown as MachineState])),
  } as unknown as AppState;
}

const panel = (scope: "project" | "thread", targets: { machine: string; ownerId: string }[]): Extract<Overlay, { kind: "secrets" }> =>
  ({ kind: "secrets", scope, title: "Secrets", targets });

test("a project's panel lists its names, sorted", () => {
  const s = state([[PI, [project("p", ["STRIPE_KEY", "AWS_ID"])], []]]);
  assert.deepEqual(secretPanelKeys(s, panel("project", [{ machine: PI, ownerId: "p" }])), ["AWS_ID", "STRIPE_KEY"]);
});

test("a pool whose machines have drifted shows every name, so one change puts them back together", () => {
  const s = state([
    [PI, [project("p", ["AWS_ID", "STRIPE_KEY"])], []],
    [MAC, [project("q", ["STRIPE_KEY", "SENTRY_DSN"])], []],
  ]);
  assert.deepEqual(
    secretPanelKeys(s, panel("project", [{ machine: PI, ownerId: "p" }, { machine: MAC, ownerId: "q" }])),
    ["AWS_ID", "SENTRY_DSN", "STRIPE_KEY"],
  );
});

test("a thread's panel lists the thread's own names, not the project's", () => {
  const s = state([[PI, [project("p", ["AWS_ID"])], [thread("t", ["STRIPE_KEY"])]]]);
  assert.deepEqual(secretPanelKeys(s, panel("thread", [{ machine: PI, ownerId: "t" }])), ["STRIPE_KEY"]);
});

test("nothing set, a machine that has gone, and a record from before secrets existed all read as empty", () => {
  const s = state([[PI, [project("p")], [thread("t")]]]);
  assert.deepEqual(secretPanelKeys(s, panel("project", [{ machine: PI, ownerId: "p" }])), []);
  assert.deepEqual(secretPanelKeys(s, panel("thread", [{ machine: PI, ownerId: "t" }])), []);
  assert.deepEqual(secretPanelKeys(s, panel("project", [{ machine: MAC, ownerId: "p" }])), []);
});
