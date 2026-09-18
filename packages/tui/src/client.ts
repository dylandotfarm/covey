import WebSocket from "ws";
import {
  PROTOCOL_VERSION, USER_CLIENT, isPush, type RpcMethods, type RpcMethodName, type WireFromDaemon, type PushMessage,
  type MachineInfo, type ShellSnapshot, type ShellEvent, type ThreadEvent, type SavedMachine, type CommandEnvelope, type Command,
  type MachineUpdate,
} from "@covey/protocol";
import { randomUUID } from "node:crypto";

/**
 * What the socket is doing, as the sidebar reads it.
 *
 * `offline` is the one that is not about the socket: it means the client has
 * stopped dialling. The other four all say "a connection is on its way, or was
 * a moment ago", which is why a machine that had been off since breakfast read
 * the same as one about to answer (issue #68).
 */
export type ConnState = "connecting" | "connected" | "disconnected" | "error" | "offline";

export interface ClientEvents {
  state(state: ConnState, error?: string): void;
  shellSnapshot(snap: ShellSnapshot): void;
  shellEvent(ev: ShellEvent): void;
  shellSynchronized(): void;
  threadEvent(threadId: string, ev: ThreadEvent): void;
  threadSynchronized(threadId: string): void;
  machineUpdate(update: MachineUpdate): void;
}

const BACKOFF = [500, 1000, 2000, 4000, 8000];

/**
 * How many dials a machine gets before the client calls it offline and stops.
 *
 * Three numbers because the three cases are not the same problem:
 *
 * - `first` — the machine has never answered. The likely cause is a typo in
 *   the URL or a port nothing listens on, and the reader wants to hear that
 *   now, not in an hour.
 * - `again` — it answered before, so the address is right and something else
 *   went away: a laptop lid, a tailnet hiccup, a daemon that crashed. That
 *   earns more patience. Six dials walk the whole backoff and add up to about
 *   half a minute, or a little over a minute against a host that times its
 *   handshake out rather than refusing it.
 * - `restarting` — we asked the daemon to restart, so the drop is the request
 *   working. The reconnect is the only way `machine.update` can report success,
 *   so a cap that bit here would turn every update into a failure. Forty dials
 *   at the 8 s ceiling is about five minutes, which covers a pull, a rebuild
 *   and a restart on the slowest machine in the fleet, and still ends.
 */
export const TRIES = { first: 3, again: 6, restarting: 40 } as const;

export interface ClientOptions {
  /** Delays between dials, in milliseconds. Only a test moves it. */
  backoff?: readonly number[];
}

/**
 * One connection to one daemon. Owns reconnect (single retry owner), the
 * shell subscription with seq-based replay, and at most one thread
 * subscription at a time (the thread currently on screen).
 */
export class MachineClient {
  info: MachineInfo | null = null;
  state: ConnState = "connecting";
  private ws: WebSocket | null = null;
  private nextId = 1;
  private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  private attempt = 0;
  private closed = false;
  /** This machine has answered at least once, so its address is not the problem. */
  private everConnected = false;
  /** We asked the daemon to restart, so the drop that follows is expected. */
  private expectingRestart = false;
  /** Why the last dial failed, kept so the offline row can say more than "offline". */
  private lastError: string | null = null;
  private shellSeq = -1;
  private shellSubId: string | null = null;
  private threadSub: { threadId: string; subId: string | null; seq: number } | null = null;
  /** Bumped per watchThread, so a slow snapshot cannot take back the stream. */
  private watchGen = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly backoff: readonly number[];

  constructor(readonly saved: SavedMachine, private ev: ClientEvents, opts: ClientOptions = {}) {
    this.backoff = opts.backoff ?? BACKOFF;
  }

  get key() { return this.saved.url; }

  /** Dials since the last connection. A test counts them; nothing else reads it. */
  get attempts() { return this.attempt; }

  start() { this.connect(); }

  /**
   * Dial again now, and give the machine a fresh budget of attempts.
   *
   * This is what the reader presses on an offline row. It is also safe to call
   * at any other time: a dial already in flight is left alone, because starting
   * a second one would orphan the first, whose own `close` would then schedule
   * a third.
   */
  retry() {
    this.attempt = 0;
    this.lastError = null;
    if (this.closed || this.state === "connecting" || this.state === "connected") return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.connect();
  }

  /**
   * The daemon is about to go away because we asked it to. Until it answers
   * again, the drop is the request working, so the cap becomes the long one —
   * see `TRIES.restarting`.
   */
  expectRestart() {
    this.expectingRestart = true;
    this.attempt = 0;
    // A restart asked for after the client already gave up has to start dialling
    // again; nothing else will.
    if (this.state === "offline") this.retry();
  }

  stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect() {
    if (this.closed) return;
    // Counted here rather than where the retry is scheduled, so the number is
    // "dials made" and the cap reads as the number of dials it is.
    this.attempt++;
    const url = new URL(this.saved.url);
    if (this.saved.token) url.searchParams.set("token", this.saved.token);
    this.setState("connecting");
    const ws = new WebSocket(url.toString(), { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on("open", async () => {
      this.attempt = 0;
      this.everConnected = true;
      this.expectingRestart = false;
      this.lastError = null;
      try {
        this.info = await this.rpc("hello", { protocolVersion: PROTOCOL_VERSION, client: USER_CLIENT });
        this.setState("connected");
        await this.resubscribe();
      } catch (e: any) {
        this.setState("error", e.message);
        ws.close();
      }
    });
    ws.on("message", (d) => this.onMessage(JSON.parse(d.toString())));
    ws.on("close", () => { if (ws === this.ws) this.onClose(); });
    ws.on("error", (e) => { this.setState("error", e.message); });
    ws.on("unexpected-response", (_req, res) => {
      this.setState("error", res.statusCode === 401 ? "unauthorized (not a tailnet peer of the owner, or bad token)" : `http ${res.statusCode}`);
    });
  }

  private onClose() {
    for (const w of this.waits.values()) { clearTimeout(w.timer); w.rej(new Error("disconnected")); }
    this.waits.clear();
    this.shellSubId = null;
    if (this.threadSub) this.threadSub.subId = null;
    if (this.closed) { if (this.state !== "error") this.setState("disconnected"); return; }
    // The budget depends on what kind of silence this is. A daemon we asked to
    // restart gets the long one; a machine that has answered before gets more
    // than one that never has.
    const budget = this.expectingRestart ? TRIES.restarting : this.everConnected ? TRIES.again : TRIES.first;
    // "offline" replaces "disconnected" rather than following it: one drop is
    // one thing to say, and saying both would paint the row twice.
    if (this.attempt >= budget) { this.giveUp(budget); return; }
    if (this.state !== "error") this.setState("disconnected");
    const delay = this.backoff[Math.min(this.attempt - 1, this.backoff.length - 1)]!;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Stop dialling and say so.
   *
   * The reason carries the last error rather than flattening it: a host that is
   * off and a token the daemon refuses both end here, and they are not the same
   * problem. Nothing restarts this but `retry` or `expectRestart` — see the
   * pull request for issue #68 for why there is no heartbeat.
   */
  private giveUp(budget: number) {
    const why = this.lastError && !isSilence(this.lastError) ? this.lastError : `no answer after ${budget} tries`;
    this.setState("offline", why);
  }

  private setState(s: ConnState, err?: string) {
    this.state = s;
    if (err) this.lastError = err;
    this.ev.state(s, err);
  }

  private async resubscribe() {
    if (this.shellSeq < 0) {
      const snap = await this.rpc("shell.snapshot", {});
      this.shellSeq = snap.seq;
      this.ev.shellSnapshot(snap);
    }
    const { subscriptionId } = await this.rpc("shell.subscribe", { afterSeq: this.shellSeq });
    this.shellSubId = subscriptionId;
    if (this.threadSub) await this.openThreadSub(this.threadSub.threadId, this.threadSub.seq);
  }

  private async openThreadSub(threadId: string, afterSeq: number) {
    const { subscriptionId } = await this.rpc("thread.subscribe", { threadId, afterSeq });
    if (this.threadSub?.threadId === threadId) this.threadSub.subId = subscriptionId;
    else await this.rpc("unsubscribe", { subscriptionId }).catch(() => {});
  }

  /**
   * Watch a thread: returns the snapshot, then streams events via ev.threadEvent.
   *
   * Only the snapshot is on the critical path. Dropping the previous
   * subscription and opening the new one are the daemon's business, so they run
   * behind the first paint rather than costing two more round trips before it —
   * which is what browsing the sidebar over a tailnet was paying per row. The
   * new subscription carries `afterSeq = snap.seq`, so nothing that happens
   * while it is opening is lost; it is replayed.
   */
  async watchThread(threadId: string, limit = 300) {
    const gen = ++this.watchGen;
    void this.unwatchThread();
    const snap = await this.rpc("thread.snapshot", { threadId, limit });
    // Snapshots raced: a later watch already owns the subscription. Hand the
    // snapshot back anyway — the store decides whether it is still wanted — but
    // do not steal the stream from under it.
    if (gen !== this.watchGen) return snap;
    this.threadSub = { threadId, subId: null, seq: snap.seq };
    if (this.state === "connected") void this.openThreadSub(threadId, snap.seq).catch(() => {});
    return snap;
  }

  /**
   * Watch a thread the caller already holds items for, from the seq it holds
   * them at. No snapshot: `thread.subscribe` replays the events after that seq,
   * and the daemon resends a snapshot as upserts when the gap is too large to
   * replay. So a revisit costs nothing on the path to the first paint — which
   * over a tailnet is the whole cost, because there the round trip is the bill.
   */
  resumeThread(threadId: string, afterSeq: number) {
    this.watchGen++; // a snapshot still in flight must not take the stream back
    void this.unwatchThread();
    this.threadSub = { threadId, subId: null, seq: afterSeq };
    if (this.state === "connected") void this.openThreadSub(threadId, afterSeq).catch(() => {});
  }

  async unwatchThread() {
    const sub = this.threadSub;
    this.threadSub = null;
    if (sub?.subId && this.state === "connected") await this.rpc("unsubscribe", { subscriptionId: sub.subId }).catch(() => {});
  }

  private onMessage(m: WireFromDaemon) {
    if (isPush(m)) return this.onPush(m);
    const w = this.waits.get(m.id);
    if (!w) return;
    this.waits.delete(m.id);
    // The deadline has been met, so it stops being one. Left running, every
    // call held a timer for a minute after it was answered — which is a minute
    // of process the event loop cannot end.
    clearTimeout(w.timer);
    if (m.ok) w.res(m.result); else w.rej(Object.assign(new Error(m.error.message), { code: m.error.code }));
  }

  private onPush(m: PushMessage) {
    switch (m.push) {
      case "shell":
        if (m.event.seq <= this.shellSeq) return; // replay overlap
        this.shellSeq = m.event.seq;
        this.ev.shellEvent(m.event);
        return;
      case "shell.synchronized":
        this.ev.shellSynchronized();
        return;
      case "thread":
        if (!this.threadSub || this.threadSub.threadId !== m.threadId) return;
        if (m.event.seq <= this.threadSub.seq && m.event.kind !== "item.upserted") return;
        this.threadSub.seq = Math.max(this.threadSub.seq, m.event.seq);
        this.ev.threadEvent(m.threadId, m.event);
        return;
      case "thread.synchronized":
        this.ev.threadSynchronized(m.threadId);
        return;
      case "machine.update":
        this.ev.machineUpdate(m.update);
        return;
    }
  }

  rpc<M extends RpcMethodName>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    return new Promise((res, rej) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error("not connected"));
      const id = this.nextId++;
      const timer = setTimeout(() => { if (this.waits.delete(id)) rej(new Error(`${method} timed out`)); }, 60_000);
      this.waits.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  command(cmd: Command) {
    const env: CommandEnvelope = { ...cmd, commandId: randomUUID() } as CommandEnvelope;
    return this.rpc("command", env);
  }
}

/**
 * True when the error only means "nobody answered" — which the attempt count
 * already says, and better. Anything else is a machine that is there and said
 * no, and the reader needs the words.
 */
function isSilence(message: string): boolean {
  return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|handshake has timed out|socket hang up/i.test(message);
}
