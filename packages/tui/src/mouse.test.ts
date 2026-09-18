import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMouse, wheelDelta, isMouseInput, copyToClipboard, countClick, MULTI_CLICK_MS, MULTI_CLICK_SLOP } from "./mouse.js";

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

// 64 up, 65 down, 66 left, 67 right. The direction is the low two bits; the low
// bit alone made 66 an up and 67 a down. tmux 3.4 does give 66 and 67 to the
// application, so the terminal is not going to filter them out first.
test("parses a sideways wheel as sideways, not as up or down", () => {
  assert.equal(parseMouse("[<66;1;1M")[0]!.wheel, "left");
  assert.equal(parseMouse("[<67;1;1M")[0]!.wheel, "right");
  assert.equal(parseMouse("[<66;1;1M")[0]!.kind, "wheel");
});

test("decodes modifier bits on a wheel report", () => {
  const mods = (code: number) => {
    const [e] = parseMouse(`[<${code};1;1M`);
    return [e!.wheel, e!.shift, e!.alt, e!.ctrl];
  };
  assert.deepEqual(mods(68), ["up", true, false, false]);
  assert.deepEqual(mods(72), ["up", false, true, false]);
  assert.deepEqual(mods(80), ["up", false, false, true]);
  assert.deepEqual(mods(73), ["down", false, true, false]);
});

test("one notch is one row, a modifier is a page", () => {
  const ev = (code: number) => parseMouse(`[<${code};1;1M`)[0]!;
  assert.equal(wheelDelta(ev(64), 10), 1);
  assert.equal(wheelDelta(ev(65), 10), -1);
  assert.equal(wheelDelta(ev(72), 10), 10); // alt+up
  assert.equal(wheelDelta(ev(73), 10), -10); // alt+down
  assert.equal(wheelDelta(ev(68), 10), 10); // shift+up, where the terminal sends it
  assert.equal(wheelDelta(ev(80), 10), 10); // ctrl+up, same
  // A one-row pane still moves one row, never none.
  assert.equal(wheelDelta(ev(72), 0), 1);
});

test("a sideways notch moves nothing", () => {
  const ev = (code: number) => parseMouse(`[<${code};1;1M`)[0]!;
  assert.equal(wheelDelta(ev(66), 10), 0);
  assert.equal(wheelDelta(ev(67), 10), 0);
  assert.equal(wheelDelta(ev(74), 10), 0); // alt+left
  assert.equal(wheelDelta(parseMouse("[<0;1;1M")[0]!, 10), 0); // a press is not a notch
});

// The reported flicker. A trackpad puts a sideways notch into the middle of a
// slow vertical scroll. Reading 66 as an up threw the view back against the
// hand: this chunk used to come to -1 row instead of -3.
test("a sideways notch mixed into a vertical scroll does not reverse it", () => {
  const chunk = "[<65;40;10M\x1b[<66;40;10M\x1b[<65;40;10M\x1b[<66;40;10M\x1b[<65;40;10M";
  const evs = parseMouse(chunk);
  assert.equal(evs.length, 5);
  assert.equal(evs.reduce((n, e) => n + wheelDelta(e, 10), 0), -3);
});

// The terminal delivers a fast scroll as one chunk. The parser has to split it
// into one event a notch, or the rows the chunk is worth are lost before any
// handler sees them. That the handler then *applies* all five is a separate
// claim, and one this file cannot make: it lives in a React closure, so
// wheel.test.ts mounts App and asserts it there.
test("one chunk parses into one event a notch", () => {
  const evs = parseMouse("[<64;40;10M" + "\x1b[<64;40;10M".repeat(4));
  assert.equal(evs.length, 5);
  assert.equal(evs.every((e) => e.kind === "wheel"), true);
  assert.equal(evs.reduce((n, e) => n + wheelDelta(e, 10), 0), 5, "five notches are worth five rows");
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

// ---- click counting ---------------------------------------------------------
//
// The clock is an argument, so every case here states its own timing. Nothing
// in this block depends on how fast the machine runs it.

test("a press on its own is one click", () => {
  const [ev] = parseMouse("[<0;10;5M");
  assert.equal(countClick(null, ev!, 1_000).count, 1);
});

test("a second press soon and near counts two, a third counts three", () => {
  const [ev] = parseMouse("[<0;10;5M");
  const one = countClick(null, ev!, 1_000);
  const two = countClick(one, ev!, 1_100);
  const three = countClick(two, ev!, 1_200);
  assert.deepEqual([one.count, two.count, three.count], [1, 2, 3]);
});

test("a fourth press starts the run again, since nothing is larger than a line", () => {
  const [ev] = parseMouse("[<0;10;5M");
  let run = countClick(null, ev!, 1_000);
  for (const at of [1_100, 1_200, 1_300]) run = countClick(run, ev!, at);
  assert.equal(run.count, 1);
});

test("a press past the window is a new click, whatever it lands on", () => {
  const [ev] = parseMouse("[<0;10;5M");
  const first = countClick(null, ev!, 1_000);
  assert.equal(countClick(first, ev!, 1_000 + MULTI_CLICK_MS).count, 2, "the window is inclusive");
  assert.equal(countClick(first, ev!, 1_000 + MULTI_CLICK_MS + 1).count, 1);
});

test("a press the slop allows still counts, one further away does not", () => {
  const first = countClick(null, parseMouse("[<0;10;5M")[0]!, 1_000);
  const near = parseMouse(`[<0;${10 + MULTI_CLICK_SLOP};5M`)[0]!;
  const far = parseMouse(`[<0;${10 + MULTI_CLICK_SLOP + 1};5M`)[0]!;
  assert.equal(countClick(first, near, 1_050).count, 2);
  assert.equal(countClick(first, far, 1_050).count, 1);
  // A row apart is a different line, and a different word.
  const below = parseMouse("[<0;10;7M")[0]!;
  assert.equal(countClick(first, below, 1_050).count, 1);
});

test("the run remembers where it was, so the next press measures from there", () => {
  const first = countClick(null, parseMouse("[<0;10;5M")[0]!, 1_000);
  const second = countClick(first, parseMouse("[<0;11;5M")[0]!, 1_050);
  assert.deepEqual([second.col, second.row, second.at], [11, 5, 1_050]);
  // Column 12 is two from the first press but one from the second.
  assert.equal(countClick(second, parseMouse("[<0;12;5M")[0]!, 1_100).count, 3);
});
