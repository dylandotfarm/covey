import WebSocket from "ws";
import {
  PROTOCOL_VERSION, isPush, type RpcMethods, type RpcMethodName, type WireFromDaemon, type PushMessage,
  type MachineInfo, type ShellSnapshot, type ShellEvent, type ThreadEvent, type SavedMachine, type CommandEnvelope, type Command,
  type MachineUpdate,
} from "@covey/protocol";
import { randomUUID } from "node:crypto";

export type ConnState = "connecting" | "connected" | "disconnected" | "error";

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
 * One connection to one daemon. Owns reconnect (single retry owner), the
 * shell subscription with seq-based replay, and at most one thread
 * subscription at a time (the thread currently on screen).
 */
export class MachineClient {
  info: MachineInfo | null = null;
  state: ConnState = "connecting";
  private ws: WebSocket | null = null;
  private nextId = 1;
  private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private attempt = 0;
  private closed = false;
  private shellSeq = -1;
  private shellSubId: string | null = null;
  private threadSub: { threadId: string; subId: string | null; seq: number } | null = null;
  /** Bumped per watchThread, so a slow snapshot cannot take back the stream. */
  private watchGen = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly saved: SavedMachine, private ev: ClientEvents) {}

  get key() { return this.saved.url; }

  start() { this.connect(); }

  stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect() {
    if (this.closed) return;
    const url = new URL(this.saved.url);
    if (this.saved.token) url.searchParams.set("token", this.saved.token);
    this.setState("connecting");
    const ws = new WebSocket(url.toString(), { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on("open", async () => {
      this.attempt = 0;
      try {
        this.info = await this.rpc("hello", { protocolVersion: PROTOCOL_VERSION, client: "covey-tui" });
        this.setState("connected");
        await this.resubscribe();
      } catch (e: any) {
        this.setState("error", e.message);
        ws.close();
      }
    });
    ws.on("message", (d) => this.onMessage(JSON.parse(d.toString())));
    ws.on("close", () => this.onClose());
    ws.on("error", (e) => { this.setState("error", e.message); });
    ws.on("unexpected-response", (_req, res) => {
      this.setState("error", res.statusCode === 401 ? "unauthorized (not a tailnet peer of the owner, or bad token)" : `http ${res.statusCode}`);
    });
  }

  private onClose() {
    for (const w of this.waits.values()) w.rej(new Error("disconnected"));
    this.waits.clear();
    this.shellSubId = null;
    if (this.threadSub) this.threadSub.subId = null;
    if (this.state !== "error") this.setState("disconnected");
    if (this.closed) return;
    const delay = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]!;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: ConnState, err?: string) {
    this.state = s;
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
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waits.delete(id)) rej(new Error(`${method} timed out`)); }, 60_000);
    });
  }

  command(cmd: Command) {
    const env: CommandEnvelope = { ...cmd, commandId: randomUUID() } as CommandEnvelope;
    return this.rpc("command", env);
  }
}
