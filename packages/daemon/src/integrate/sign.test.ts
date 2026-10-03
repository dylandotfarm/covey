/**
 * The signature on a comment: covey writes it, the watch reads it back, and no
 * reader ever sees it.
 *
 * The case that matters is the last one. A thread that hears its own comment
 * spends a turn answering itself, and under `auto` a reviewer woken by its own
 * review never finishes. `WatchCursor.posted` missed that whenever GitHub
 * listed the comment with no URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { signComment, signedBy, unsign } from "./sign.js";

const ID = "9f0b1a2c-3d4e-5f60-7182-93a4b5c6d7e8";

test("a signed comment names its thread, and the words are untouched", () => {
  const signed = signComment("`lines.ts` line 20 drops the last row.", ID);
  assert.equal(signedBy(signed), ID);
  assert.equal(unsign(signed), "`lines.ts` line 20 drops the last row.");
  assert.match(signed, /^<!-- covey-thread: /m, "the marker starts its own line");
});

test("an unsigned comment names nobody, and unsigning it changes nothing", () => {
  assert.equal(signedBy("I pushed the fix."), null);
  assert.equal(unsign("I pushed the fix."), "I pushed the fix.");
  assert.equal(signComment("words", ""), "words", "no id, no signature");
});

test("a signature a thread was shown is not a signature it wrote", () => {
  // `describeEvent` quotes a comment with `  > `, so an agent that pastes the
  // turn it was sent into its own answer carries the other thread's marker.
  // Anchored with no leading space, that can never read as its own.
  const quoted = ["Answering this:", "  > thanks", `  > <!-- covey-thread: ${ID} -->`, "", "Done."].join("\n");
  assert.equal(signedBy(quoted), null);
  const reply = signComment(quoted, "other-thread");
  assert.equal(signedBy(reply), "other-thread", "covey's own signature is the one that counts");
});

test("the last signature wins, whatever an agent wrote above it", () => {
  // A body that already carries a marker at the start of a line — pasted, or
  // written by hand — must not be able to make a comment read as another
  // thread's. Covey appends its own last, so the last is covey's.
  const body = `<!-- covey-thread: forged -->\n\nMy change.`;
  assert.equal(signedBy(signComment(body, ID)), ID);
});

test("unsigning leaves no blank tail behind", () => {
  assert.equal(unsign(signComment("one line.", ID)), "one line.");
  assert.equal(unsign(`words\n\n<!-- covey-thread: ${ID} -->\n`), "words");
});

test("a marker in the middle of a body leaves no gap behind", () => {
  // Covey writes one at the end and nowhere else. An agent that pasted the
  // source of a comment it was answering can put one anywhere, and a blank
  // line where it stood would read as a mistake.
  const body = `First.\n\n<!-- covey-thread: ${ID} -->\n\nSecond.`;
  assert.equal(unsign(body), "First.\n\nSecond.");
  assert.equal(unsign(signComment(body, "mine")), "First.\n\nSecond.");
});
