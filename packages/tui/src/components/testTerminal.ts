/**
 * Test support: a terminal that is not a terminal.
 *
 * Some defects live in App and nowhere else — the sidebar cursor of #17, the
 * lost paste of #128 — because App holds the state they are about. A unit test
 * of the helper beside them passes with the defect put back, so it protects
 * nothing. These mount App on a fake tty and type into it.
 */
import { EventEmitter } from "node:events";

/** Ink writes frames here instead of to a tty. */
export class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  frames: string[] = [];
  write(s: string) { this.frames.push(s); return true; }
  get lastFrame() { return this.frames.at(-1) ?? ""; }
}

/**
 * Ink reads keys from here. It drives stdin the way node streams do — a
 * `readable` event, then `read()` until it returns null — so `type` queues the
 * keystroke and rings the bell.
 *
 * One call to `type` is one chunk, which is what makes a paste a paste: a real
 * terminal hands the whole of it to Ink at once, and Ink hands the whole of it
 * to `useInput`.
 */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return this.queue.shift() ?? null; }
  ref() { return this; }
  unref() { return this; }
  type(s: string) { this.queue.push(s); this.emit("readable"); }
}

export const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the thing an assertion is about, rather than for a fixed spell.
 *
 * What these cases claim is *what* App did, never how long covey took — and a
 * fixed wait measures the runner. On this project's Pi, with the rest of the
 * suite painting Ink trees on the other cores, a keystroke and the render it
 * causes can take longer than any number short enough to keep the file quick,
 * and the case then fails a long way from anything it covers. Waiting on the
 * condition is both quicker and honest: it returns as soon as the state is
 * there, and the timeout only bounds a case that is genuinely broken. A case
 * that asserts nothing *happened* still has to wait a spell — there is no
 * condition to watch for that.
 */
export async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await settle(20);
}
