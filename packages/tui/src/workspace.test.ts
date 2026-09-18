import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectGit } from "@covey/protocol";
import { workspaceOptions, workspaceModeLabel, permissionModeLabel, isLoopbackUrl } from "./store.js";

// `defaultBranch` is the ref a clean start really gets, which since #76 is the
// remote's, not the local copy of it.
const git = (over: Partial<ProjectGit> = {}): ProjectGit =>
  ({ isRepo: true, root: "/repo", currentBranch: "feature", defaultBranch: "origin/main", hasCommits: true, ...over });

test("workspaceOptions offers worktree-from-default, worktree-from-HEAD, and the checkout", () => {
  const opts = workspaceOptions(git());
  assert.deepEqual(opts.map((o) => o.id), ["worktree-default", "worktree-head", "checkout"]);
  assert.equal(opts[0]!.label, "Worktree from origin/main", "the row names the ref the worktree gets");
  assert.equal(opts[0]!.hint, "clean start, fetched first");
  assert.match(opts[1]!.label, /HEAD \(feature\)/);
  assert.match(opts[2]!.label, /\(feature\)/);
});

test("a repo with no remote still names its own default branch", () => {
  assert.equal(workspaceOptions(git({ defaultBranch: "main" }))[0]!.label, "Worktree from main");
});

test("workspaceOptions drops the default-branch row when there is nothing to branch from", () => {
  assert.deepEqual(workspaceOptions(git({ defaultBranch: null })).map((o) => o.id), ["worktree-head", "checkout"]);
});

test("workspaceOptions names no branch when HEAD is detached", () => {
  const opts = workspaceOptions(git({ currentBranch: null }));
  assert.equal(opts[1]!.label, "Worktree from HEAD");
  assert.equal(opts[2]!.label, "This checkout");
});

test("workspaceModeLabel reads as a sentence, and unset means asking", () => {
  assert.equal(workspaceModeLabel(null), "ask every time");
  assert.equal(workspaceModeLabel(undefined), "ask every time");
  assert.equal(workspaceModeLabel("worktree-default"), "worktree from the remote's default branch");
});

test("permissionModeLabel names the modes the way the machine panel offers them", () => {
  assert.equal(permissionModeLabel("default"), "manual");
  assert.equal(permissionModeLabel("acceptEdits"), "auto");
  assert.equal(permissionModeLabel("bypassPermissions"), "bypass");
  assert.equal(permissionModeLabel(null), "from Claude settings");
});

test("isLoopbackUrl decides whether a daemon shares this machine", () => {
  assert.ok(isLoopbackUrl("ws://127.0.0.1:3790"));
  assert.ok(isLoopbackUrl("ws://localhost:3790"));
  assert.ok(isLoopbackUrl("ws://[::1]:3790"));
  assert.ok(!isLoopbackUrl("ws://pi.tail.ts.net:3790"));
  assert.ok(!isLoopbackUrl("not a url"));
});
