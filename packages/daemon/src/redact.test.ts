/**
 * Taking a secret value back out of what a session said — issue #126.
 *
 * The environment keeps the value out of the conversation until something
 * prints it. These hold the rules of what happens then: which values are
 * looked for, what a match becomes, and what the walk must not touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_REDACTED_LENGTH, redactDeep, redactor } from "./redact.js";

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
