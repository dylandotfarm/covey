/**
 * What the phone decides to put in the shade, and what it refuses to.
 *
 * The rule about *what is news* is `threadNews` in `@covey/client` and is
 * tested there. These are the phone's own four: the thread on screen, covey's
 * hidden reviewers, a row that has stopped being true, and the words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread } from "@covey/protocol";
import { noteFor, noteId, notifyPanel, type NoteInput } from "./notes";

const BOX = "ws://box:3790";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1", projectId: "p1", title: "Add notifications", provider: "claude", sessionId: "s1", model: null,
  permissionMode: "default", branch: null, worktreePath: null, status: "idle", lastError: null,
  pendingApprovals: 0, queuedTurns: 0, latestTurn: null, lastMessageAt: null, archivedAt: null,
  pinnedAt: null, movedTo: null, createdAt: "", updatedAt: "", ...over,
} as Thread);

const running = (over: Partial<Thread> = {}) =>
  thread({ status: "running", latestTurn: { turnId: "x", state: "running", startedAt: "", completedAt: null }, ...over });
const ended = (over: Partial<Thread> = {}) =>
  thread({ latestTurn: { turnId: "x", state: "completed", startedAt: "", completedAt: "" }, ...over });

/** A change nobody is watching: the app is open on the list. */
const change = (prev: Thread, next: Thread, over: Partial<NoteInput> = {}): NoteInput =>
  ({ machine: BOX, machineName: "box", prev, next, foreground: true, open: null, ...over });

test("a turn that ended is one row, named by the thread and the machine", () => {
  const act = noteFor(change(running(), ended()));
  assert.deepEqual(act, {
    act: "post",
    note: {
      id: `${BOX}:t1`,
      title: "Add notifications",
      body: "Done · box",
      machine: BOX,
      threadId: "t1",
    },
  });
  // One key per conversation, so the second thing a thread says replaces the
  // first rather than queueing behind it.
  assert.equal(noteId(BOX, "t1"), `${BOX}:t1`);
});

test("the words are covey's own, and say which of the two the reader owes", () => {
  assert.equal((noteFor(change(running(), running({ pendingApprovals: 1 }))) as { note: { body: string } }).note.body,
    "Needs approval · box");
  assert.equal((noteFor(change(running(), thread({ status: "waiting" }))) as { note: { body: string } }).note.body,
    "Asks you something · box");
  assert.equal((noteFor(change(running(), thread({ latestTurn: { turnId: "x", state: "error", startedAt: "", completedAt: "" } }))) as { note: { body: string } }).note.body,
    "Failed · box");
});

test("the thread the reader is looking at is never announced", () => {
  const open = { machine: BOX, threadId: "t1" };
  assert.equal(noteFor(change(running(), ended(), { open })), null);
  // Another conversation on the same screen still is: that is how a reader
  // learns about the thread they are not reading.
  assert.equal(noteFor(change(running(), ended(), { open: { machine: BOX, threadId: "other" } }))?.act, "post");
  // And a conversation left open behind a locked screen is one nobody is
  // reading, so the app being away puts the row back.
  assert.equal(noteFor(change(running(), ended(), { open, foreground: false }))?.act, "post");
});

test("covey's own reviewers are silent, unless one needs a person", () => {
  // Ten reviewers of one afternoon would be ten notifications about work the
  // reader never asked for. `threadIsHidden` is the rule, and its exception is
  // the whole safety of hiding: an approval nobody can see waits for ever.
  assert.equal(noteFor(change(running({ hidden: true }), ended({ hidden: true }))), null);
  assert.equal(noteFor(change(running({ hidden: true }), running({ hidden: true, pendingApprovals: 1 })))?.act, "post");
});

test("a row that has stopped being true comes down", () => {
  // Answered in the terminal: the question is not in front of the reader any
  // more and must not be in their shade either.
  assert.deepEqual(noteFor(change(thread({ status: "waiting" }), thread({ status: "idle" }))),
    { act: "dismiss", id: `${BOX}:t1` });
  assert.deepEqual(noteFor(change(thread({ pendingApprovals: 1 }), running())),
    { act: "dismiss", id: `${BOX}:t1` });
  // Set working again from anywhere, so "done" is stale.
  assert.deepEqual(noteFor(change(ended(), running())), { act: "dismiss", id: `${BOX}:t1` });
});

test("a thread that changed anything else leaves the shade alone", () => {
  // A running turn re-sends its thread many times a second.
  assert.equal(noteFor(change(running(), running())), null);
  assert.equal(noteFor(change(running(), running({ queuedTurns: 1 }))), null);
  assert.equal(noteFor(change(ended(), ended({ title: "renamed" }))), null);
});

test("the switch says what it costs, and what is stopping it", () => {
  // The ongoing row in the shade is the whole cost of this feature, so the
  // hint names it rather than leaving a reader to find it.
  const on = notifyPanel(true, true, true);
  assert.match(on.hint, /notification shade/);
  assert.equal(on.warn, null);
  assert.match(notifyPanel(false, true, true).hint, /only reports itself while this app is open/);

  // Two things stop it and they have different answers: one is a permission in
  // Android's settings, the other is an app too old for the bundle it is
  // running. A reader told the wrong one would go to the wrong screen.
  assert.match(notifyPanel(true, false, true).warn ?? "", /Android's settings/);
  assert.match(notifyPanel(true, true, false).warn ?? "", /Install the newer app/);
  // An old build says so whether the switch is on or off: the switch is the
  // thing that cannot work, so saying it only once it is on is too late.
  assert.match(notifyPanel(false, true, false).warn ?? "", /Install the newer app/);
});
