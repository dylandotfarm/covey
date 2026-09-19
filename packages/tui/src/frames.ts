import { performance } from "node:perf_hooks";

/**
 * When the client is allowed to repaint.
 *
 * A paint is the most expensive thing covey's one thread does. Ink lays the
 * whole tree out with yoga, builds the frame character by character and diffs
 * it against the last one; on a small machine that is 30–45 ms of a screen the
 * size of a terminal. Everything else the thread owes — above all reading the
 * keys somebody is typing — waits behind it. So a paint per event from a
 * daemon is a policy that trades the reader's keyboard for a smoother spinner,
 * and covey used to make that trade once per streamed token, per thread, per
 * machine.
 *
 * The rule here is the opposite one:
 *
 *   - What the person did paints at once. A keystroke never waits for a frame
 *     that was already owed to a daemon: `now()` paints the newest state, which
 *     the daemon's change is already part of, and drops that frame. It can drop
 *     it safely because it notifies synchronously — the render that follows
 *     reads the same state the frame would have.
 *   - What a machine said paints on a frame boundary, however many machines
 *     said it. Eight agents streaming eight replies is one paint, not eight.
 *   - The boundary moves out when the loop is running late. The timer that
 *     paces the frames is also the probe: how late it fires is how long a
 *     keystroke arriving beside it would have waited, whether the delay came
 *     from covey's own painting or from the rest of the machine. Painting is
 *     what covey can give up, so it gives it up in proportion — a frame every
 *     `FRAME_MS + late` ms. Under load that settles at a small share of the
 *     loop and leaves the rest for input.
 *
 * `late` is measured, never assumed, and every frame takes a fresh reading —
 * including a frame `now()` drops that was already due, because a frame nobody
 * ran past its due time is the clearest reading there is. A machine that gets
 * quiet is back at `FRAME_MS` on the next one. The reading is one frame stale
 * after an idle spell — the last frame's lateness paces the first frame after
 * it — which costs one interval and then corrects itself.
 *
 * The clock is `performance.now()`, not `Date.now()`. It is the wall clock that
 * jumps: an NTP step, a VM restored from a snapshot, a laptop waking with a
 * corrected time. A wall clock that went backwards would put `paintedAt` in the
 * future and arm the next frame for the size of the step, and since `soon()`
 * does nothing while a frame is armed, the screen would stop for minutes with
 * nothing the reader could do about it. The wait is clamped to the interval as
 * well, so the bound holds locally whatever clock is handed in.
 */

/**
 * The shortest gap between two frames a machine asked for. This is Ink's own
 * ceiling, to the millisecond: `maxFps` defaults to 30 and Ink throttles on
 * `Math.ceil(1000 / maxFps)`, which is 34, not the 33⅓ that 30 fps sounds like.
 * Asking for frames any faster only queues paints Ink throttles away, at the
 * price of the React render in front of each one — so the number has to be the
 * one Ink really uses. `inkOptions` leaves `maxFps` at its default; move one
 * and move the other.
 */
export const FRAME_MS = 34;

/**
 * The longest gap, however late the loop runs. The screen may fall behind the
 * daemons; it may not look frozen. Half a second is slow enough to cost almost
 * nothing on a machine in trouble and quick enough that a reader watching a
 * reply arrive still reads it arriving.
 */
export const MAX_FRAME_MS = 500;

export interface FrameOptions {
  frameMs?: number;
  maxFrameMs?: number;
  /**
   * Swappable so a test can drive a clock instead of waiting on one. The
   * handle is opaque: whatever `setTimer` returns is what `clearTimer` is
   * given back.
   */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Frames {
  private readonly frameMs: number;
  private readonly maxFrameMs: number;
  private readonly now_: () => number;
  private readonly setTimer: NonNullable<FrameOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<FrameOptions["clearTimer"]>;

  private timer: unknown = null;
  /** When the pending frame was due, so its lateness can be read off. */
  private dueAt = 0;
  /** When the screen last went out. */
  private paintedAt = 0;
  /** How late the last frame ran — the budget is spent against this. */
  private lateMs = 0;
  /** Latched by `stop`. A client on its way out never paints again. */
  private stopped = false;

  constructor(private readonly paint: () => void, opts: FrameOptions = {}) {
    this.frameMs = opts.frameMs ?? FRAME_MS;
    this.maxFrameMs = opts.maxFrameMs ?? MAX_FRAME_MS;
    this.now_ = opts.now ?? (() => performance.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.paintedAt = this.now_();
  }

  /** The gap the next machine-driven frame has to wait out. */
  get intervalMs(): number {
    return Math.min(this.maxFrameMs, this.frameMs + this.lateMs);
  }

  /** What the last frame's lateness measured, for a test or a diagnostic. */
  get lagMs(): number { return this.lateMs; }

  /** Whether a frame is armed and has not fired. */
  get pending(): boolean { return this.timer !== null; }

  /**
   * Something the person did. Paint it now, and drop any frame a machine was
   * owed: the state that frame would have shown is in this one, because this
   * notifies synchronously and the render that follows reads the same state.
   */
  now(): void {
    if (this.stopped) return;
    this.readLateness();
    this.cancel();
    this.paintedAt = this.now_();
    this.paint();
  }

  /** Something a machine said. Paint it at the next boundary. */
  soon(): void {
    if (this.stopped || this.timer !== null) return;
    this.arm(Math.max(0, this.paintedAt + this.intervalMs - this.now_()));
  }

  /**
   * The screen went out for some other reason — React repainted for a
   * keystroke, a resize, anything Ink noticed. The next frame is measured from
   * here, so a frame and a keystroke's paint do not stack up back to back:
   * a frame already armed is pushed out to a full interval from this paint.
   *
   * Pushed out, never dropped, however much it looks like this paint has
   * already covered it. Ink throttles its writes with a trailing edge, so the
   * frame that just reached the terminal can be an older commit than the state
   * the pending frame was armed for — and nothing else is coming to draw that
   * state. At the end of a reply that is its last words missing until the
   * reader happens to press a key. Deferring is safe where dropping is not,
   * because the frame still runs inside an interval; and while a reader types
   * fast enough to keep pushing it, every one of those renders reads the store
   * afresh, so the machine's changes are reaching the screen anyway.
   *
   * `frames.test.ts` holds this, and it is the only thing that does — an
   * end-to-end case for it was written and thrown away, because a round of
   * daemon traffic is several events and any one of them re-arms the frame the
   * paint before it dropped. It passed whether or not this cancelled, which
   * makes it worse than nothing.
   */
  painted(): void {
    if (this.stopped) return;
    const armed = this.timer !== null;
    if (armed) { this.readLateness(); this.cancel(); }
    this.paintedAt = this.now_();
    if (armed) this.arm(this.intervalMs);
  }

  /** Give up any pending frame, for good. The client is going away. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  /**
   * Arm the one frame. `wait` is clamped to the interval: the bound the budget
   * promises has to hold here, not only in `intervalMs`, or a clock that moved
   * under us arms a frame minutes out and `soon()` will not arm another.
   */
  private arm(wait: number): void {
    const w = Math.min(this.intervalMs, Math.max(0, wait));
    this.dueAt = this.now_() + w;
    const t = this.setTimer(() => {
      // How late the timer ran is how long a keystroke arriving beside it
      // would have waited. Read it before anything else, then paint.
      this.lateMs = Math.max(0, this.now_() - this.dueAt);
      this.timer = null;
      this.paintedAt = this.now_();
      this.paint();
    }, w);
    // A frame is never the last thing holding covey open; Ink's hold on stdin
    // is. An unref'd timer cannot keep a client alive that has nothing to show.
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /**
   * A frame that is armed and already past its due time has measured the loop
   * for us, whoever is about to take it away. Without this a reader typing
   * steadily — every keystroke's paint pushing the frame out, every `set`
   * dropping it — could hold a stale lateness, and with it a stale interval,
   * long after the machine went quiet.
   */
  private readLateness(): void {
    if (this.timer === null) return;
    const late = this.now_() - this.dueAt;
    if (late > 0) this.lateMs = late;
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
