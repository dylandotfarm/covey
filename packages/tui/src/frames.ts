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
 * `late` is measured, never assumed, and it is recomputed on every frame, so a
 * machine that gets quiet is back at `FRAME_MS` on the next one. The reading is
 * one frame stale after an idle spell — the last frame's lateness paces the
 * first frame after it — which costs one interval and then corrects itself.
 */

/**
 * The shortest gap between two frames a machine asked for: about 30 a second,
 * which is also Ink's own ceiling (`maxFps`). Asking for more would only queue
 * paints that Ink throttles away, at the price of the React render in front of
 * each one.
 */
export const FRAME_MS = 32;

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

  constructor(private readonly paint: () => void, opts: FrameOptions = {}) {
    this.frameMs = opts.frameMs ?? FRAME_MS;
    this.maxFrameMs = opts.maxFrameMs ?? MAX_FRAME_MS;
    this.now_ = opts.now ?? (() => Date.now());
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
   * owed: the state that frame would have shown is in this one.
   */
  now(): void {
    this.cancel();
    this.paintedAt = this.now_();
    this.paint();
  }

  /** Something a machine said. Paint it at the next boundary. */
  soon(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.paintedAt + this.intervalMs - this.now_());
    this.dueAt = this.now_() + wait;
    const t = this.setTimer(() => {
      // How late the timer ran is how long a keystroke arriving beside it
      // would have waited. Read it before anything else, then paint.
      this.lateMs = Math.max(0, this.now_() - this.dueAt);
      this.timer = null;
      this.paintedAt = this.now_();
      this.paint();
    }, wait);
    // A frame is never the last thing holding covey open; Ink's hold on stdin
    // is. An unref'd timer cannot keep a client alive that has nothing to show.
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /**
   * The screen went out for some other reason — React repainted for a
   * keystroke, a resize, anything Ink noticed. The next frame is measured from
   * here, so a frame and a keystroke's paint do not stack up back to back.
   *
   * What this must *not* do is cancel the frame a machine is owed, however
   * much it looks like that paint has already covered it. Ink throttles its
   * writes with a trailing edge, so the frame that just reached the terminal
   * can be an older commit than the state the pending frame was armed for —
   * and nothing else is coming to draw that state. At the end of a reply that
   * is its last words missing until the reader happens to press a key.
   */
  painted(): void {
    this.paintedAt = this.now_();
  }

  /** Give up any pending frame. The client is going away. */
  stop(): void { this.cancel(); }

  private cancel(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
