/**
 * Which push-to-talk button the composer paints, which one it listens to, and
 * what a key press means once it does.
 *
 * The first two answers are separate on purpose: a mode can want the keys *and*
 * the button, and a build that cannot read the keys has to keep the button
 * whatever the reader chose — a bundle over the air lands in whatever app is
 * installed.
 *
 * The third is `keyHold`, and the runs below are the ones a hand makes and a
 * browser cannot: a squeeze of the rocker, a release of a key covey never saw
 * pressed, and a release Android took away. Every one of them needs a phone to
 * meet by hand, and the last one costs the reader every later hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asTalk, DEFAULT_TALK, keyHold, talkButton, talkNote, talkWithKeys, TALK_LABEL, TALK_ORDER } from "./talk";

test("the button is the default, so no install loses its microphone", () => {
  assert.equal(DEFAULT_TALK, "button");
  assert.equal(talkButton(DEFAULT_TALK, true), true);
  assert.equal(talkWithKeys(DEFAULT_TALK, true), false);
});

test("each mode paints what it offers", () => {
  assert.equal(talkButton("button", true), true);
  assert.equal(talkWithKeys("button", true), false);

  assert.equal(talkButton("keys", true), false);
  assert.equal(talkWithKeys("keys", true), true);

  assert.equal(talkButton("both", true), true);
  assert.equal(talkWithKeys("both", true), true);
});

test("a build that cannot read the keys keeps the button, whatever is stored", () => {
  for (const mode of TALK_ORDER) {
    assert.equal(talkButton(mode, false), true, `${mode} must keep the button`);
    assert.equal(talkWithKeys(mode, false), false, `${mode} must not wait on a key`);
  }
  assert.equal(talkNote(false)?.includes("volume keys"), true);
  assert.equal(talkNote(true), null);
});

test("a stored mode this build does not know reads as the default", () => {
  assert.equal(asTalk("keys"), "keys");
  assert.equal(asTalk("both"), "both");
  assert.equal(asTalk("camera"), null);
  assert.equal(asTalk(null), null);
  assert.equal(asTalk(undefined), null);
  assert.equal(asTalk(""), null);
});

test("every mode has a row to offer", () => {
  for (const mode of TALK_ORDER) {
    assert.equal(typeof TALK_LABEL[mode].label, "string");
    assert.ok(TALK_LABEL[mode].hint.length > 0);
  }
  assert.equal(TALK_ORDER.length, Object.keys(TALK_LABEL).length);
});

/** Walk a run of key events, as the composer does, and report what happened. */
function run(events: [string, boolean][], open: () => boolean = () => true) {
  let down: string[] = [];
  const acts: string[] = [];
  for (const [key, pressed] of events) {
    const next = keyHold(down, key, pressed, open());
    down = next.down;
    if (next.act) acts.push(next.act);
  }
  return { down, acts };
}

test("one key is one hold", () => {
  assert.deepEqual(run([["volumeDown", true], ["volumeDown", false]]).acts, ["start", "stop"]);
  assert.deepEqual(run([["volumeUp", true], ["volumeUp", false]]).acts, ["start", "stop"]);
});

test("a squeeze of the rocker is still one hold", () => {
  // Both keys are offered, so a reader holding the rocker sends two of each.
  // The hold runs from the first press to the last release.
  const { acts, down } = run([
    ["volumeDown", true], ["volumeUp", true], ["volumeUp", false], ["volumeDown", false],
  ]);
  assert.deepEqual(acts, ["start", "stop"]);
  assert.deepEqual(down, []);
});

test("a release covey never saw the press of does nothing", () => {
  // The key that dismissed a permission dialog must not stop a dictation the
  // microphone button started.
  assert.deepEqual(run([["volumeDown", false]]).acts, []);
});

test("a release Android ate does not cost the reader every later hold", () => {
  // The press is seen, the release is not — the dialog had the focus — and the
  // recogniser is no longer holding. The next press starts from an empty hand
  // rather than reading as the second of a squeeze.
  let open = false;
  let down: string[] = [];
  const acts: string[] = [];
  for (const [key, pressed, held] of [
    ["volumeDown", true, false],
    // ... the release is lost here ...
    ["volumeDown", true, false],
    ["volumeDown", false, true],
  ] as [string, boolean, boolean][]) {
    open = held;
    const next = keyHold(down, key, pressed, open);
    down = next.down;
    if (next.act) acts.push(next.act);
  }
  assert.deepEqual(acts, ["start", "start", "stop"]);
  assert.deepEqual(down, []);
});

test("a hold that is running is not restarted by the other key", () => {
  const { acts } = run([["volumeDown", true], ["volumeUp", true]], () => true);
  assert.deepEqual(acts, ["start"]);
});
