/**
 * Taking a secret value back out of what a session said — issue #126.
 *
 * The environment keeps the value out of the conversation until something
 * prints it. These hold the rules of what happens then: which values are
 * looked for, what a match becomes, and what the walk must not touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepFilePaths, MIN_REDACTED_LENGTH, redactDeep, redactor, unredactor } from "./redact.js";

test("a value becomes its own name, wherever it stands", () => {
  const r = redactor({ STRIPE_KEY: "sk_live_0123456789" })!;
  assert.equal(r("curl -H 'Authorization: Bearer sk_live_0123456789'"), "curl -H 'Authorization: Bearer [secret STRIPE_KEY]'");
  // Twice in one line is twice replaced: `split`/`join`, not a single pass.
  assert.equal(r("sk_live_0123456789 sk_live_0123456789"), "[secret STRIPE_KEY] [secret STRIPE_KEY]");
  assert.equal(r("nothing to see"), "nothing to see");
});

test("a thread with no secret gets no redactor at all, and pays nothing", () => {
  assert.equal(redactor({}), null);
});

test("a value too short to tell from ordinary prose is left alone", () => {
  // `abc` in a transcript is a word, a variable, three letters of a path. To
  // replace every one of them would cost the reader more than it protects.
  assert.equal(redactor({ SHORT: "abc" }), null);
  const only = "x".repeat(MIN_REDACTED_LENGTH - 1);
  assert.equal(redactor({ SHORT: only }), null);
  const enough = "x".repeat(MIN_REDACTED_LENGTH);
  assert.equal(redactor({ LONG: enough })!(enough), "[secret LONG]");
});

test("the longest value goes first, so a value that contains another is replaced whole", () => {
  const r = redactor({ SHORT_TOKEN: "abcdefgh", LONG_TOKEN: "abcdefgh-ijklmnop" })!;
  assert.equal(r("abcdefgh-ijklmnop"), "[secret LONG_TOKEN]");
  assert.equal(r("abcdefgh"), "[secret SHORT_TOKEN]");
});

test("every string in an item is redacted, and its bookkeeping is not", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  const item = {
    id: "tool:1", threadId: "t1", kind: "tool", createdAt: "2026-01-01T00:00:00Z",
    input: { command: "echo sk_live_0123456789", env: ["A=sk_live_0123456789"] },
    output: "sk_live_0123456789\n",
  };
  const out = redactDeep(item, r);
  assert.equal(out.output, "[secret TOKEN]\n");
  assert.equal(out.input.command, "echo [secret TOKEN]");
  assert.deepEqual(out.input.env, ["A=[secret TOKEN]"]);
  // The id, the thread and the time are covey's own and are never rewritten.
  assert.equal(out.id, "tool:1");
  assert.equal(out.threadId, "t1");
  assert.equal(out.createdAt, "2026-01-01T00:00:00Z");
});

test("an item that holds no secret comes back as the same object", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  const item = { id: "a", text: "an ordinary reply", parts: [{ text: "and another" }] };
  assert.equal(redactDeep(item, r), item, "no new object for the common case");
});

test("numbers, nulls and booleans pass through untouched", () => {
  const r = redactor({ TOKEN: "sk_live_0123456789" })!;
  assert.deepEqual(redactDeep({ n: 1, b: true, z: null }, r), { n: 1, b: true, z: null });
});

// ---- the files covey stored itself ----------------------------------------

/** The thread's own file store, which is where a path covey kept must be. */
const STORE = "/p/github.com/dylandotfarm/app/t1/.covey/threads/t1/files";
const held = (path: string) => path.startsWith(STORE + "/");

test("a file covey stored keeps the path covey gave it", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "note:1", threadId: "t1", kind: "note", text: "the sidebar after the fix",
    files: [{ name: "shot.png", path: `${STORE}/shot.png`, mimeType: "image/png" }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  // The path names a file in the thread's own store, and the `/file` route
  // refuses everything else — so a path rewritten here is a picture nobody can
  // open. The directory is already in the `projects` table as it stands.
  assert.equal(out.files[0]!.path, raw.files[0]!.path);
  assert.equal(out.files[0]!.name, "shot.png");
  assert.equal(out.text, "the sidebar after the fix");
});

test("the words around a kept path are redacted all the same", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "user:1", threadId: "t1", kind: "user", text: "here is dylandotfarm",
    attachments: [{ name: "a.png", path: `${STORE}/a.png` }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  assert.equal(out.text, "here is [secret OWNER]");
  assert.equal(out.attachments[0]!.path, raw.attachments[0]!.path);
});

test("an attachment covey left where it was keeps the marker", () => {
  // An attachment sent with no inline bytes keeps the path it came with
  // (`materialiseAttachments`), and that path is anywhere on the machine. The
  // route refuses it whatever it is spelled with, so keeping the value would
  // write one down for no picture at all.
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = {
    id: "user:2", threadId: "t1", kind: "user", text: "look at this",
    attachments: [{ name: "notes.txt", path: "/home/dylandotfarm/notes.txt" }],
  };
  const out = keepFilePaths(redactDeep(raw, r), raw, held);
  assert.equal(out.attachments[0]!.path, "/home/[secret OWNER]/notes.txt");
});

test("an item with no files of its own is the object redaction made", () => {
  const r = redactor({ OWNER: "dylandotfarm" })!;
  const raw = { id: "a", text: "ordinary" };
  const red = redactDeep(raw, r);
  assert.equal(keepFilePaths(red, raw, held), red);
  assert.equal(keepFilePaths("a string" as unknown, "a string" as unknown, held), "a string");
});

// ---- putting a value back into a path -------------------------------------

test("a path covey redacted is spelled back from the thread's own secrets", () => {
  const back = unredactor({ OWNER: "dylandotfarm", SHORT: "abc" })!;
  assert.equal(back("/p/github.com/[secret OWNER]/app/files/shot.png"), "/p/github.com/dylandotfarm/app/files/shot.png");
  // A name this thread does not hold stays as it is, and so does a value too
  // short for `redactor` to have replaced.
  assert.equal(back("/p/[secret GONE]/x.png"), "/p/[secret GONE]/x.png");
  assert.equal(back("/p/[secret SHORT]/x.png"), "/p/[secret SHORT]/x.png");
  assert.equal(back("/p/app/files/shot.png"), "/p/app/files/shot.png");
  assert.equal(unredactor({}), null);
});

test("the values go back in one pass, so a value holding a marker is not read again", () => {
  const back = unredactor({ A: "[secret B]x", B: "0123456789" })!;
  assert.equal(back("/p/[secret A]/f.png"), "/p/[secret B]x/f.png");
});
