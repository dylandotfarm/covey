/**
 * Which push-to-talk button the composer paints, and which one it listens to.
 *
 * The two answers are separate on purpose: a mode can want the keys *and* the
 * button, and a build that cannot read the keys has to keep the button whatever
 * the reader chose — a bundle over the air lands in whatever app is installed.
 * That last rule is the one worth a test, because the only way to meet it by
 * hand is to install an old APK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asTalk, DEFAULT_TALK, talkButton, talkNote, talkWithKeys, TALK_LABEL, TALK_ORDER } from "./talk";

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
