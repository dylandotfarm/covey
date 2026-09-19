/**
 * The frame budget: who gets the thread when a daemon and a typist both want
 * it.
 *
 * Measured on this project's Raspberry Pi, with a two-hundred-item transcript
 * on a 120×45 terminal: one paint is 30–45 ms, and the client used to take one
 * per event a daemon sent. Eight agents streaming eight replies is about
 * 130 events a second between them, so the one thread covey has was spoken for
 * before anybody touched the keyboard — typing measured 111 ms a character,
 * and characters were being read at a rate the daemons set. Safari, in the
 * same minute, took text at the speed of a hand.
 *
 * `Frames` is the answer: what the person did paints at once, what a machine
 * said waits for a frame, and the gap between frames grows with the lateness
 * the loop actually measures. The cases below are the rules, one each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Frames, FRAME_MS, MAX_FRAME_MS } from "./frames.js";

/**
 * A clock and a timer queue a test drives by hand.
 *
 * `run` is a loop that is keeping up: time passes and anything due fires on
 * time. `stall` is a loop that is not: the clock moves while nothing runs, so
 * the timer that was due in the middle of it fires late — which is the whole
 * signal `Frames` paces itself by, and the only way to write it down without
 * a real busy machine underneath the test.
 */
function clock() {
  let now = 0;
  let id = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  const fire = () => {
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
  };
  return {
    opts: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, id: ++id }; timers.push(t); return t; },
      clearTimer: (t: any) => { timers = timers.filter((x) => x !== t); },
    },
    /** Time passes on a loop that is keeping up. */
    run(ms: number) { now += ms; fire(); },
    /** Time passes on a loop that is blocked: nothing gets to run. */
    stall(ms: number) { now += ms; },
    get at() { return now; },
  };
}

/** A `Frames` that counts its paints, and the clock it runs on. */
function frames() {
  const c = clock();
  const paints: number[] = [];
  const f = new Frames(() => paints.push(c.at), c.opts);
  return { f, c, paints };
}

test("a burst from the machines is one frame, not one frame each", () => {
  const { f, c, paints } = frames();
  // Eight agents, each re-sending its streamed reply, all inside one turn of
  // the loop. Before the budget this was eight React renders and eight paints.
  for (let i = 0; i < 50; i++) f.soon();
  assert.deepEqual(paints, [], "not one of them painted on the spot");
  c.run(FRAME_MS);
  assert.equal(paints.length, 1, "fifty events cost one frame");

  // And the next burst waits out a whole interval from that frame.
  for (let i = 0; i < 50; i++) f.soon();
  c.run(FRAME_MS - 1);
  assert.equal(paints.length, 1, "a second burst does not jump the queue it just left");
  c.run(1);
  assert.equal(paints.length, 2);
});

test("what the person did paints at once, and takes the owed frame with it", () => {
  const { f, c, paints } = frames();
  f.soon();
  assert.equal(paints.length, 0, "a daemon's change is waiting for its frame");

  // A keystroke. It must not wait for that frame — and it does not need to
  // paint twice either, because the daemon's change is in the state this paint
  // is about to draw.
  f.now();
  assert.deepEqual(paints, [0], "the keystroke painted on the spot");
  assert.equal(f.pending, false, "and the frame the daemon was owed is gone, not queued behind it");

  c.run(MAX_FRAME_MS * 2);
  assert.equal(paints.length, 1, "the dropped frame never comes back to paint a screen that is already up");
});

test("a paint Ink did for its own reasons still leaves the frame a machine was owed", () => {
  const { f, c, paints } = frames();
  f.soon();
  c.run(10);
  // A resize, or React repainting for a keystroke that only moved its own
  // state. Ink says so through `onRender` — but it throttles its writes with a
  // trailing edge, so the frame that reached the terminal can be an older
  // commit than the one this frame was armed for. Treating it as "already
  // drawn" is how the last words of a reply go missing until the reader
  // presses a key.
  f.painted();
  c.run(FRAME_MS);
  assert.equal(paints.length, 1,
    "the owed frame was dropped because something else happened to paint. Nothing else " +
    "is coming to draw that state");
});

test("but the next frame is measured from that paint, not from the one before it", () => {
  const { f, c, paints } = frames();
  c.run(100);
  f.painted();
  f.soon();
  c.run(FRAME_MS - 1);
  assert.deepEqual(paints, [], "a frame and a keystroke's paint do not stack up back to back");
  c.run(1);
  assert.equal(paints.length, 1);
});

test("a loop running late paints less often, and goes back when it is not", () => {
  const { f, c, paints } = frames();
  assert.equal(f.intervalMs, FRAME_MS, "an idle machine gets the full frame rate");

  // The frame was due at 32 ms. The machine was busy — a build, another agent,
  // anything — and nothing ran for 200 ms past it. That lateness is exactly how
  // long a keystroke arriving beside it would have waited.
  f.soon();
  c.stall(FRAME_MS + 200);
  c.run(0);
  assert.equal(paints.length, 1);
  assert.equal(f.lagMs, 200, "the timer that paces the frames also measures them");
  assert.equal(f.intervalMs, FRAME_MS + 200, "so the next frame stands further back");

  // The gap is real: a daemon change now waits out the wider interval.
  f.soon();
  c.run(FRAME_MS);
  assert.equal(paints.length, 1, "it did not paint at the old rate");
  c.run(200);
  assert.equal(paints.length, 2);

  // The machine is free again, so the next frame runs on time and the client
  // is back at the full rate — the reading is never older than one frame.
  assert.equal(f.lagMs, 0, "a frame that ran on time measures no lateness");
  assert.equal(f.intervalMs, FRAME_MS);
});

test("however bad it gets, the screen is never staler than MAX_FRAME_MS", () => {
  const { f, c } = frames();
  f.soon();
  c.stall(FRAME_MS + 60_000);
  c.run(0);
  assert.equal(f.lagMs, 60_000, "a minute of lateness is a minute of lateness");
  assert.equal(f.intervalMs, MAX_FRAME_MS,
    "but the budget is capped: a machine in trouble still has a screen that moves, " +
    "or the reader cannot tell covey from a hang");
});

test("stop gives up the pending frame, and nothing arriving afterwards arms another", () => {
  const { f, c, paints } = frames();
  f.soon();
  f.stop();
  // `Store.shutdown` stops the budget first and the machine clients last, and
  // a socket's `close` lands a tick later: `MachineClient.stop` only asks. That
  // late callback reaches `touchFromMachine`, and without a latch it would arm
  // a fresh frame and notify React in the middle of teardown — on the relaunch
  // path, before the App has unmounted.
  f.soon();
  f.now();
  assert.equal(f.pending, false, "stop is a latch, not one cancellation");
  c.run(MAX_FRAME_MS * 2);
  assert.deepEqual(paints, []);
});

test("a clock that jumps backwards cannot park the screen minutes away", () => {
  // The default clock is monotonic for this reason, but a bound the budget
  // promises has to hold here too, whatever clock it is handed: NTP steps, VM
  // snapshots and laptops waking with a corrected time all move a wall clock.
  const { f, c, paints } = frames();
  c.run(10_000);
  f.soon();
  c.run(FRAME_MS);
  assert.equal(paints.length, 1, "a frame at the far end of the clock");

  c.stall(-5 * 60_000);          // five minutes backwards, between two frames
  f.soon();
  c.run(MAX_FRAME_MS);
  assert.equal(paints.length, 2,
    "the wait was computed from a `paintedAt` five minutes in the future, so the frame was " +
    "armed five minutes out — and `soon` arms nothing while one is pending, so the screen " +
    "stops until the clock catches up");
});

test("a keystroke's paint pushes the owed frame out rather than letting it land on top", () => {
  const { f, c, paints } = frames();
  f.soon();                       // a machine event: frame due at FRAME_MS
  c.run(10);
  f.painted();                    // the reader typed; Ink painted for that
  c.run(FRAME_MS - 10);           // the frame's original due time
  assert.deepEqual(paints, [],
    "the owed frame fired a few milliseconds after the keystroke's paint, which is the " +
    "stacking `painted` exists to prevent");
  c.run(10);
  assert.equal(paints.length, 1, "and it still runs, a full interval from that paint");
});

test("a frame dropped while overdue still tells the budget how late the loop is", () => {
  const { f, c } = frames();
  f.soon();
  // The loop stalls past the frame's due time, and then the reader does
  // something: `set` drops the frame and paints. That frame never ran, so
  // without reading it here the stall goes unmeasured — and the reverse case,
  // a reader typing steadily through a stall that has ended, would hold a
  // stale lateness and a stale interval with it.
  c.stall(FRAME_MS + 120);
  f.now();
  assert.equal(f.lagMs, 120, "the frame nobody ran is the clearest reading there is");
});
