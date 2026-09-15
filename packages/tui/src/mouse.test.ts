import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMouse, isMouseInput, copyToClipboard } from "./mouse.js";

// Ink strips exactly one leading ESC before handing the sequence to useInput,
// so the common case has no ESC on the first event but does on the rest.

test("parses a left press", () => {
  assert.deepEqual(parseMouse("[<0;10;5M"), [
    { kind: "press", button: 0, col: 10, row: 5, shift: false, alt: false, ctrl: false },
  ]);
});

test("parses drag motion and release", () => {
  assert.equal(parseMouse("[<32;12;7M")[0]!.kind, "drag");
  assert.equal(parseMouse("[<0;12;7m")[0]!.kind, "release");
});

test("parses wheel direction", () => {
  assert.equal(parseMouse("[<64;1;1M")[0]!.wheel, "up");
  assert.equal(parseMouse("[<65;1;1M")[0]!.wheel, "down");
  assert.equal(parseMouse("[<64;1;1M")[0]!.kind, "wheel");
});

test("parses a batch of motion events from one chunk", () => {
  const evs = parseMouse("[<32;10;5M\x1b[<32;11;5M\x1b[<32;12;6M");
  assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((e) => [e.col, e.row]), [[10, 5], [11, 5], [12, 6]]);
});

test("decodes modifier bits", () => {
  const [e] = parseMouse("[<4;3;3M"); // shift
  assert.equal(e!.shift, true);
});

test("ordinary typing is not mistaken for a mouse report", () => {
  assert.deepEqual(parseMouse("hello"), []);
  assert.deepEqual(parseMouse(""), []);
  assert.equal(isMouseInput("hello"), false);
  assert.equal(isMouseInput("[<0;10;5M"), true);
  assert.equal(isMouseInput("[<0;10;5M\x1b[<0;11;5M"), true);
});

test("OSC 52 emits bare base64, including inside tmux", () => {
  const writes: string[] = [];
  const fake = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
  const prev = process.env.TMUX;
  const expected = `\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`;

  delete process.env.TMUX;
  copyToClipboard("hi", fake);
  assert.equal(writes[0], expected);

  // tmux forwards a bare OSC 52 itself; wrapping it in passthrough would need
  // allow-passthrough, off by default since tmux 3.3.
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  copyToClipboard("hi", fake);
  assert.equal(writes[1], expected);

  if (prev === undefined) delete process.env.TMUX; else process.env.TMUX = prev;
});
