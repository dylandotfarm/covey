import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { BuildInfo, MachineInfo, Project, Run, RunIssue, RunMember, RunMemberPatch, RunMemberState, RunTask, Thread, TimelineItem, SavedMachine, ShellEvent, ThreadEvent, ThreadSnapshot, PermissionMode, TurnDiff, ProjectGit, MachineUpdate, MachineSource, MachineSettings, ThreadCommands, PathEntry, UsageGroupBy, UsageReport, UsageTotals } from "@covey/protocol";
import { isFinalMemberState } from "@covey/protocol";
import { MachineClient, type ClientOptions, type ConnState } from "./client.js";
import { DEFAULT_BRIEF, allocatePorts, allocateResources, memberSlug, placeTasks, renderBrief, withIssueTitles, type PlacementMachine } from "./run.js";
import { loadConfig, saveConfig, type TuiConfig } from "./config.js";
import { keepTagged, type TaggedAttachment } from "./attachments.js";
import { ViewCache } from "./viewCache.js";
import { Frames, type FrameOptions } from "./frames.js";

/**
 * How many timeline items a thread opens with when the reader means it. Big
 * enough that scrolling back through a turn or two needs no round trip.
 */
export const FULL_PAGE = 300;
/** A page of scrollback, once the reader has hit the top of what is loaded. */
export const OLDER_PAGE = 200;
/**
 * A preview's first page, in items, for a transcript pane `height` lines tall.
 * An item is at least one line, so a page of `height` items always fills the
 * pane; in practice items run several lines each and it fills it many times
 * over. When it does not — a run of one-line items — App notices the short
 * layout and asks for another page.
 */
export function previewPage(height: number) { return Math.max(10, Math.min(FULL_PAGE, height)); }

export interface MachineState {
  key: string;
  saved: SavedMachine;
  conn: ConnState;
  error: string | null;
  info: MachineInfo | null;
  projects: Map<string, Project>;
  threads: Map<string, Thread>;
  /**
   * The runs this daemon stores. A run's members may be threads on other
   * machines; this is only where the record lives, because a run outlives the
   * client that started it.
   */
  runs: Map<string, Run>;
  /** The update in flight on that machine, or the last one it reported. */
  update: MachineUpdate | null;
  /** We asked the daemon to restart, so the drop that follows is expected. */
  restarting: boolean;
}

export interface ThreadView {
  machine: string;
  threadId: string;
  thread: Thread | null;
  items: Map<string, TimelineItem>;
  loading: boolean;
  error: string | null;
  /** Older items exist before the earliest loaded one. */
  hasMore: boolean;
  loadingOlder: boolean;
  /**
   * The thread seq these items are synced to: the snapshot's seq, then the seq
   * of the last event applied. A revisit resubscribes from it, so the daemon
   * sends only what changed. Zero until the first snapshot lands.
   */
  seq: number;
  /**
   * The `/` menu the daemon reported for this thread. `null` means the daemon
   * does not know yet — the thread has never run a session — which the menu
   * says rather than showing an empty list.
   */
  commands: ThreadCommands;
  /**
   * Directories read for the `@` menu, keyed by their path relative to the
   * thread's working directory (`""` is that directory). One request per
   * directory, not per keystroke: the filtering happens here.
   */
  dirs: Map<string, DirListing>;
}

export interface DirListing {
  entries: PathEntry[];
  loading: boolean;
  /** The directory holds more names than the daemon was willing to send. */
  truncated: boolean;
  error: string | null;
}

export type Focus = "sidebar" | "composer";

export type Overlay =
  | { kind: "help" }
  | { kind: "palette" }
  | {
      kind: "pick";
      title: string;
      options: PickOption[];
      /** `checked` is the state of `toggle`, if the pick has one. */
      onPick: (id: string, checked: boolean) => void;
      filter?: boolean;
      /** Label for a checkbox row under the list, flipped with tab. */
      toggle?: string;
      /**
       * A pick of many: space marks a row, enter hands the marked ids to
       * `onMany`, and `onPick` is not called. `marked` starts as given, so a
       * pick can open with the usual answer already chosen.
       */
      many?: { marked: Set<string>; onMany: (ids: string[]) => void };
      /**
       * Where esc goes. Without it esc closes everything, which throws the
       * reader out of the run panel they opened the pick from.
       */
      onCancel?: () => void;
    }
  /** `onCancel` lets esc go back where the input came from instead of closing
   *  everything — the folder prompt returns to the directory it was opened on. */
  | { kind: "input"; title: string; placeholder?: string; initial?: string; onSubmit: (v: string) => void; onCancel?: () => void }
  /** Live progress of `machine.update`; closing it leaves the update running. */
  | { kind: "update"; machine: string }
  /** Token and estimated-cost totals, asked of every connected machine. */
  | {
      kind: "usage";
      /** Index into `USAGE_WINDOWS`. */
      window: number;
      groupBy: UsageGroupBy;
      loading: boolean;
      reports: UsageReport[];
      /** Machines that could not answer, with the reason. */
      errors: { machine: string; message: string }[];
    }
  /**
   * A run and its members: task, thread, machine, branch, pull request, state.
   * `machine` is the machine that *stores* the run, not where its members work.
   */
  | {
      kind: "run";
      machine: string;
      runId: string;
      /** Members the operator has marked, for "send to these". */
      marked: Set<string>;
      /** What the run is doing right now — dispatching, reading pull requests. */
      busy: string | null;
    };

export interface PickOption { id: string; label: string; hint?: string; }

export interface Notice { text: string; tone: "info" | "error" | "success"; at: number; }

export interface AppState {
  machines: Map<string, MachineState>;
  order: string[]; // machine keys in display order
  selected: { machine: string; threadId: string } | null;
  view: ThreadView | null;
  focus: Focus;
  sidebarCollapsed: boolean;
  expanded: Record<string, boolean>; // project key `${machine}:${projectId}` → expanded
  expandedItems: Set<string>;
  /** ctrl+o: show every tool call, overriding the per-turn folds. */
  toolsExpanded: boolean;
  overlay: Overlay | null;
  notice: Notice | null;
  scrollFromBottom: number; // lines scrolled up from bottom (0 = follow)
  drafts: Map<string, string>;
  /** Files dropped into the composer, per thread, pending the next send. */
  pendingAttachments: Map<string, TaggedAttachment[]>;
  tick: number;
  /** Diff panel replacing the transcript. */
  diffView: { threadId: string; loading: boolean; diff: TurnDiff | null; scroll: number } | null;
  /** Threads that changed state while not on screen: `${machine}:${threadId}` → reason. */
  attention: Map<string, "approval" | "done" | "error">;
  /** Mouse text selection, scoped to one pane. */
  selection: Selection | null;
  /**
   * Set when the user asked to relaunch this client. The app unmounts and
   * `runTui` hands the request back to the CLI, which does the work — a
   * process cannot rebuild and re-exec itself from inside its own event loop.
   */
  relaunch: RelaunchRequest | null;
  /** The build this client runs, to compare with each machine's. */
  clientBuild: BuildInfo | null;
  /** A build newer than the one this client loaded now sits on disk. */
  clientStale: boolean;
}

export interface RelaunchRequest {
  /** Pull and rebuild the client's checkout before coming back. */
  update: boolean;
  /** Also restart the local daemon, which ends the turns it is running. */
  restartDaemon: boolean;
}

/** How often the client asks whether a newer build has landed on disk. */
const BUILD_POLL_MS = 30_000;

/** How often the spinner turns, while there is anything to turn. */
const SPIN_MS = 700;

/**
 * How often an otherwise idle client re-renders anyway.
 *
 * The sidebar and the summaries date every thread with `relTime`, which reads
 * `Date.now()` at render time, so a client that never renders shows the time a
 * thread was last spoken to frozen at whatever it read when the last event
 * arrived: a turn that finished a minute ago still says "now", and there is no
 * heartbeat on the machine socket to disturb it. `relTime` is minutes below an
 * hour, so this only has to be finer than a minute — three renders a minute
 * rather than eighty-six, and none of the 700 ms ones an idle client used to
 * pay for.
 */
const CLOCK_MS = 20_000;

export interface StoreOptions {
  /** The checkout this client runs from, as worked out by the CLI. */
  source?: MachineSource | null;
  /** The build this client runs, so the sidebar can flag a machine behind it. */
  build?: BuildInfo | null;
  /**
   * Newest mtime of the files this client was loaded from, in milliseconds.
   * Polled rather than read once: a client goes stale while it runs. Somebody
   * rebuilds in another terminal, this process keeps the code it loaded, and
   * every keybinding stays at the old behaviour with nothing to show for it.
   */
  watchBuild?: () => number;
  /** How often to ask. Only a test needs to move it. */
  buildPollMs?: number;
  /** False when nothing can relaunch us (the TUI was not started by the CLI). */
  canRelaunch?: boolean;
  /** Carried over from the process we were relaunched from. */
  notice?: { text: string; tone: Notice["tone"] };
  /** Passed to every MachineClient. Only a test moves the retry backoff. */
  client?: ClientOptions;
  /** How often the screen may go out. Only a test moves the frame budget. */
  frames?: FrameOptions;
  /** How often an idle client refreshes its relative times. Only a test moves it. */
  clockMs?: number;
}

/**
 * A selection anchored to *line indices*, not screen rows, so scrolling during
 * or after a drag does not move it. `pane` is what makes the selection
 * context-sensitive: a drag that starts in the transcript can never extend into
 * the sidebar.
 */
export interface Selection {
  pane: "transcript" | "diff";
  anchor: { line: number; col: number };
  head: { line: number; col: number };
  dragging: boolean;
}

/** Normalised [start, end] of a selection, in reading order. */
/**
 * Is this thread doing something a reader would watch?
 *
 * One predicate, because two places need the same answer and a disagreement
 * between them is invisible: `Store.animating` decides whether the spinner
 * ticks at all, and the components decide whether to draw something that
 * spins. A thread the first calls still and the second draws moving is a
 * spinner frozen mid-turn, which reads exactly like an agent that has died.
 *
 * `status` and `latestTurn.state` are separate facts and this takes both.
 * A daemon that has a turn running says so on the turn before the session
 * settles into `running`, and `noticeRunProgress` already treats the two as
 * independent; leaning on either alone leaves a gap where the screen moves and
 * the clock behind it does not.
 */
export function threadIsBusy(t: Thread): boolean {
  if (t.pendingApprovals > 0) return true;
  if (t.latestTurn?.state === "running") return true;
  return t.status === "running" || t.status === "starting" || t.status === "waiting";
}

export function selectionBounds(s: Selection): { from: { line: number; col: number }; to: { line: number; col: number } } {
  const { anchor, head } = s;
  const backwards = head.line < anchor.line || (head.line === anchor.line && head.col < anchor.col);
  return backwards ? { from: head, to: anchor } : { from: anchor, to: head };
}

/** True when the selection covers no characters at all. */
export function selectionIsEmpty(s: Selection): boolean {
  const { from, to } = selectionBounds(s);
  return from.line === to.line && from.col === to.col;
}

type Listener = () => void;

/**
 * How long a call that may clone a repository gets: the daemon's own budget
 * for a clone, plus a little for the answer to cross the network.
 */
const CLONE_WAIT_MS = 10 * 60_000 + 10_000;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private clients = new Map<string, MachineClient>();
  /** Threads the reader has already opened, ready to paint again. */
  private viewCache = new ViewCache();
  private config: TuiConfig;
  private noticeTimer: NodeJS.Timeout | null = null;

  /** The checkout this client runs from; null when it is not a git checkout. */
  readonly clientSource: MachineSource | null;
  readonly canRelaunch: boolean;
  private buildTimer: NodeJS.Timeout | null = null;
  private clientOpts: ClientOptions;
  /** Drives `state.tick`, which animates the spinner and dates the rows. */
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly clockMs: number;
  /** When the tick last fired, so an idle client can fire it rarely. */
  private lastTick = Date.now();
  /**
   * What decides when the screen may go out. A change the reader made paints
   * at once; a change a machine sent waits for a frame, so a turn streaming
   * through eight agents costs one paint rather than eight. See `frames.ts`.
   */
  private frames: Frames;

  constructor(machines: SavedMachine[], opts: StoreOptions = {}) {
    this.config = loadConfig();
    this.clientSource = opts.source ?? null;
    this.canRelaunch = opts.canRelaunch ?? false;
    this.clientOpts = opts.client ?? {};
    this.state = {
      machines: new Map(), order: [], selected: null, view: null, focus: "sidebar",
      sidebarCollapsed: this.config.prefs.sidebarCollapsed ?? false,
      expanded: this.config.prefs.expanded ?? {}, expandedItems: new Set(),
      toolsExpanded: this.config.prefs.toolsExpanded ?? false, overlay: null, notice: null,
      scrollFromBottom: 0, drafts: new Map(), pendingAttachments: new Map(), tick: 0, diffView: null, attention: new Map(),
      selection: null, relaunch: null,
      clientBuild: opts.build ?? null, clientStale: false,
    };
    this.pendingProjects = this.config.prefs.pendingProjects ?? [];
    this.frames = new Frames(() => { for (const l of this.listeners) l(); }, opts.frames);
    this.clockMs = opts.clockMs ?? CLOCK_MS;
    for (const m of machines) this.addMachine(m, false);
    // The spinner turns at `SPIN_MS` while there is anything to turn, and at
    // `CLOCK_MS` when there is not — slowly, because a tick is a repaint of the
    // whole screen, and quickly enough that the relative times stay true. See
    // `animating` and `CLOCK_MS`.
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      if (!this.animating() && now - this.lastTick < this.clockMs) return;
      this.lastTick = now;
      this.setFromMachine({ tick: this.state.tick + 1 });
    }, SPIN_MS);
    this.tickTimer.unref();
    if (opts.watchBuild) this.watchOwnBuild(opts.watchBuild, opts.buildPollMs ?? BUILD_POLL_MS);
    if (opts.notice) this.notify(opts.notice.text, opts.notice.tone);
  }

  /**
   * Watch the files this client was loaded from. A file with a later mtime than
   * the one we started with means the build on disk is not the build we run —
   * and nothing else in the process can tell, because the code is in memory.
   * One report is enough, so the timer stops on the first.
   */
  private watchOwnBuild(read: () => number, every: number) {
    const at = read();
    if (at <= 0) return;
    this.buildTimer = setInterval(() => {
      if (read() <= at) return;
      this.stopWatchingBuild();
      this.set({ clientStale: true });
      this.notify("a newer build is on disk — this client still runs the old one. ctrl+k → \"Update covey\"", "error");
    }, every);
    this.buildTimer.unref();
  }

  private stopWatchingBuild() {
    if (this.buildTimer) { clearInterval(this.buildTimer); this.buildTimer = null; }
  }

  /** Quit in a way the CLI reads as "come back", optionally rebuilt first. */
  requestRelaunch(req: RelaunchRequest) {
    if (!this.canRelaunch) { this.notify("this client cannot relaunch itself — start it with `covey`", "error"); return; }
    this.notify(req.update ? "updating and relaunching…" : "relaunching…");
    this.set({ relaunch: req });
  }

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.frames.now();
  }
  private touch() { this.set({}); }

  /**
   * The same, for a change that arrived from a daemon rather than from the
   * hands at the keyboard. It lands in the state immediately — anything that
   * renders after this sees it — but the screen waits for a frame, so a flood
   * of timeline events cannot spend the loop the typist needs.
   */
  private setFromMachine(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.frames.soon();
  }
  private touchFromMachine() { this.setFromMachine({}); }

  /**
   * Ink painted — for a frame this asked for, or for a keystroke or a resize it
   * did not. Either way the next frame is measured from here. `index.tsx` wires
   * Ink's `onRender` to it.
   */
  painted = () => { this.frames.painted(); };

  /**
   * Is anything on the screen moving? Only three things animate, and all three
   * are driven by `tick`: the dot beside a busy thread (`statusColor`), the
   * activity row under a running turn (`activityLine`), and the spinner on an
   * update's running step (`StepRow`). With none of them there, a tick is a
   * repaint of a screen identical to the one already up — which an idle client
   * used to pay for every 700 ms, for as long as it was left open.
   *
   * `threadIsBusy` is shared with the components rather than restated here,
   * because the two halves have to mean the same thing: a thread this calls
   * still and a component draws moving is a spinner that never advances, and a
   * reader cannot tell that from an agent that has died.
   */
  private animating(): boolean {
    for (const ms of this.state.machines.values()) {
      if (ms.update?.steps.some((st) => st.status === "running")) return true;
      for (const t of ms.threads.values()) if (threadIsBusy(t)) return true;
    }
    return false;
  }

  // ---- machines ------------------------------------------------------------

  addMachine(saved: SavedMachine, persist = true) {
    if (this.clients.has(saved.url)) return;
    const ms: MachineState = { key: saved.url, saved, conn: "connecting", error: null, info: null, projects: new Map(), threads: new Map(), runs: new Map(), update: null, restarting: false };
    this.state.machines.set(saved.url, ms);
    this.state.order.push(saved.url);
    // Everything a machine reports goes through `touchFromMachine`, and
    // nothing else does. That is the line the frame budget is drawn on: a
    // daemon can talk as fast as it likes and the screen still goes out at a
    // frame rate, while a key the reader pressed still paints on the spot.
    // An update's step output streams the same way a reply does, which is why
    // `machineUpdate` is on this side of it too.
    const client = new MachineClient(saved, {
      state: (s, err) => {
        // A machine that is off reports the same state over and over. Painting
        // the whole sidebar for a row that did not change is what made a dead
        // machine cost the same as a busy one (issue #68).
        const changed = ms.conn !== s || ms.error !== (err ?? null) || ms.info !== client.info;
        ms.conn = s; ms.error = err ?? null; ms.info = client.info;
        // A cached seq only means something to the daemon it was read from.
        if (s !== "connected") this.viewCache.dropMachine(ms.key);
        // A restarting daemon cannot report its own success — it is gone by
        // then. Reconnecting is the success, so say so here.
        if (s === "connected") void this.drainPending(ms.key);
        if (s === "connected" && ms.restarting) {
          ms.restarting = false;
          const at = ms.update?.state === "restarting" ? ms.update.toCommit : null;
          if (ms.update?.state === "restarting") ms.update = { ...ms.update, state: "succeeded", finishedAt: new Date().toISOString() };
          this.notify(`${ms.info?.name ?? ms.saved.name} is back up${at ? ` on ${at}` : ""}`, "success");
        }
        if (changed) this.touchFromMachine();
      },
      shellSnapshot: (snap) => {
        ms.info = snap.machine;
        ms.projects = new Map(snap.projects.map((p) => [p.id, p]));
        ms.threads = new Map(snap.threads.map((t) => [t.id, t]));
        ms.runs = new Map((snap.runs ?? []).map((r) => [r.id, r]));
        if (saved.machineId !== snap.machine.machineId) { saved.machineId = snap.machine.machineId; this.persist(); }
        this.touchFromMachine();
      },
      shellEvent: (ev) => this.applyShell(ms, ev),
      shellSynchronized: () => this.touchFromMachine(),
      threadEvent: (threadId, ev) => this.applyThread(saved.url, threadId, ev),
      threadSynchronized: () => this.touchFromMachine(),
      machineUpdate: (update) => {
        const prev = ms.update;
        ms.update = update;
        // The drop that follows is the update working, so the client has to be
        // told before it happens — otherwise it gives up on the daemon it was
        // asked to restart, and the reconnect that reports success never comes.
        if (update.state === "restarting") { ms.restarting = true; client.expectRestart(); }
        this.noticeUpdate(ms, prev, update);
        this.touchFromMachine();
      },
    }, this.clientOpts);
    this.clients.set(saved.url, client);
    client.start();
    if (persist) { this.config.machines.push(saved); this.persist(); }
    this.touch();
  }

  removeMachine(key: string) {
    this.clients.get(key)?.stop();
    this.clients.delete(key);
    this.state.machines.delete(key);
    this.state.order = this.state.order.filter((k) => k !== key);
    this.config.machines = this.config.machines.filter((m) => m.url !== key);
    this.persist();
    if (this.state.selected?.machine === key) this.select(null);
    this.viewCache.dropMachine(key);
    this.touch();
  }

  client(key: string): MachineClient | undefined { return this.clients.get(key); }

  /**
   * Dial a machine the client has given up on, and give it a fresh budget.
   *
   * This is the whole answer to "a machine that comes back on its own": there
   * is no heartbeat. A probe slow enough to be cheap is also slow enough that
   * the reader who wants the machine now presses this instead, and a state that
   * keeps probing in the background is not the honest "we have stopped trying"
   * that the offline row promises. One key, and the count starts again.
   */
  retryMachine(key: string) {
    const ms = this.state.machines.get(key);
    const client = this.clients.get(key);
    if (!ms || !client) return;
    const who = ms.info?.name ?? ms.saved.name;
    if (ms.conn === "connected") { this.notify(`${who} is already connected`); return; }
    // A dial in flight is left alone by `retry`, so do not promise a new one.
    if (ms.conn === "connecting") { this.notify(`${who}: already trying…`); return; }
    client.retry();
    this.notify(`${who}: trying again…`);
  }

  private applyShell(ms: MachineState, ev: ShellEvent) {
    switch (ev.kind) {
      case "machine.updated": ms.info = ev.machine; break;
      case "project.upserted": ms.projects.set(ev.project.id, ev.project); break;
      case "project.removed": ms.projects.delete(ev.projectId); break;
      case "thread.upserted": {
        const prev = ms.threads.get(ev.thread.id);
        ms.threads.set(ev.thread.id, ev.thread);
        const v = this.state.view;
        if (v && v.machine === ms.key && v.threadId === ev.thread.id) v.thread = ev.thread;
        else if (prev) this.noticeTransition(ms, prev, ev.thread);
        this.noticeRunProgress(ms, ev.thread);
        break;
      }
      case "thread.removed": ms.threads.delete(ev.threadId); break;
      // A run arrives whole, the way a timeline item does, so there is no
      // partial state to reconcile after a reconnect.
      case "run.upserted": ms.runs.set(ev.run.id, ev.run); break;
      case "run.removed": ms.runs.delete(ev.runId); break;
    }
    this.touchFromMachine();
  }

  /** Bell + notice when a background thread needs you or finishes. */
  private noticeTransition(ms: MachineState, prev: Thread, next: Thread) {
    const key = `${ms.key}:${next.id}`;
    const nowWaiting = (next.pendingApprovals > 0 || next.status === "waiting") && !(prev.pendingApprovals > 0 || prev.status === "waiting");
    const nowDone = prev.latestTurn?.state === "running" && next.latestTurn?.state === "completed";
    const nowError = prev.latestTurn?.state === "running" && next.latestTurn?.state === "error";
    if (!nowWaiting && !nowDone && !nowError) return;
    this.state.attention.set(key, nowWaiting ? "approval" : nowError ? "error" : "done");
    if (!this.config.prefs.quiet) process.stdout.write("\x07");
    const who = `${next.title.slice(0, 40)} @${ms.info?.name ?? ms.saved.name}`;
    this.notify(nowWaiting ? `needs approval: ${who}` : nowError ? `failed: ${who}` : `done: ${who}`, nowWaiting ? "info" : nowError ? "error" : "success");
  }

  /** A running update is worth a line even when its panel is closed. */
  private noticeUpdate(ms: MachineState, prev: MachineUpdate | null, next: MachineUpdate) {
    const who = ms.info?.name ?? ms.saved.name;
    if (next.state === "failed" && prev?.state !== "failed") { this.notify(`update failed on ${who}: ${next.error ?? "see the panel"}`, "error"); return; }
    if (next.state === "succeeded" && prev?.state !== "succeeded") { this.notify(`${who} updated${next.toCommit ? ` to ${next.toCommit}` : ""}`, "success"); return; }
    // "restarting" is the last thing a daemon can say about itself; the
    // matching "back up" notice comes from the reconnect.
    if (next.state === "restarting" && prev?.state !== "restarting") { this.notify(`${who}: restarting the daemon…`); return; }
    const running = next.steps.find((s) => s.status === "running");
    const before = prev?.steps.find((s) => s.status === "running");
    if (running && running.name !== before?.name) this.notify(`${who}: ${running.label}…`);
  }

  private applyThread(machine: string, threadId: string, ev: ThreadEvent) {
    const v = this.state.view;
    if (process.env.COVEY_EVLOG) { try { appendFileSync(process.env.COVEY_EVLOG, JSON.stringify({ t: Date.now(), ev: ev.kind, seq: ev.seq, item: (ev as any).item?.kind, viewThread: v?.threadId?.slice(0, 8), evThread: threadId.slice(0, 8), items: v?.items.size, loading: v?.loading }) + "\n"); } catch { /* ignore */ } }
    if (!v || v.machine !== machine || v.threadId !== threadId) return;
    switch (ev.kind) {
      case "item.upserted": v.items.set(ev.item.id, ev.item); break;
      case "item.removed": v.items.delete(ev.itemId); break;
      case "thread.updated": v.thread = ev.thread; break;
      // The SDK replaces its command list rather than patching it, so we do too.
      case "commands.updated": v.commands = ev.commands; break;
    }
    // A resent snapshot carries each item's own seq, which is older than the
    // subscription's, so take the highest and never go backwards.
    v.seq = Math.max(v.seq, ev.seq);
    this.setFromMachine({ view: { ...v } });
  }

  // ---- selection -----------------------------------------------------------

  private selectGen = 0;

  /**
   * Keep the view the reader leaves, so that coming back needs no snapshot.
   * A half-loaded or failed view is not kept: its items are a fragment and its
   * seq says nothing about where they came from.
   */
  private cacheCurrentView() {
    const v = this.state.view;
    if (!v || v.loading || v.error || v.seq === 0) return;
    this.viewCache.put(v.machine, v.threadId, { thread: v.thread, items: v.items, hasMore: v.hasMore, seq: v.seq, commands: v.commands });
  }

  /**
   * Open a thread. `limit` is how many of the newest items to fetch: a preview
   * asks for about a screen's worth, because that is all it can paint, and the
   * rest arrives through loadOlder() when the reader scrolls back or opens the
   * thread for real. The cost is not the bytes so much as the layout — every
   * loaded item is rendered to lines on every frame, whether or not it is on
   * screen — so a page that fits the pane is several times cheaper per row.
   */
  async select(sel: { machine: string; threadId: string } | null, limit = FULL_PAGE) {
    const gen = ++this.selectGen;
    const prev = this.state.selected;
    this.cacheCurrentView();
    // Not awaited: releasing the old machine's subscription is bookkeeping, and
    // the new thread's snapshot does not wait on it.
    if (prev && prev.machine !== sel?.machine) void this.clients.get(prev.machine)?.unwatchThread();
    if (!sel) { this.set({ selected: null, view: null }); return; }
    const client = this.clients.get(sel.machine);
    const ms = this.state.machines.get(sel.machine);
    this.state.attention.delete(`${sel.machine}:${sel.threadId}`);
    this.config.prefs.lastSelected = sel; this.persist();

    const cached = this.viewCache.take(sel.machine, sel.threadId);
    if (cached) {
      // Paint first, reconcile after. The subscription replays every event
      // after the seq these items were cached at, so nothing here is trusted;
      // it is only early. `limit` does not apply — the reader gets the page
      // they had, and App tops it up through loadOlder() if it is short of the
      // pane.
      const view: ThreadView = {
        machine: sel.machine, threadId: sel.threadId, thread: ms?.threads.get(sel.threadId) ?? cached.thread,
        items: cached.items, loading: false, error: null, hasMore: cached.hasMore, loadingOlder: false, seq: cached.seq,
        // The menu comes back with the items; the directories are read again,
        // because a file may have appeared since the reader was last here.
        commands: cached.commands, dirs: new Map(),
      };
      this.set({ selected: sel, view, scrollFromBottom: 0, diffView: null });
      client?.resumeThread(sel.threadId, cached.seq);
      return;
    }

    const view: ThreadView = { machine: sel.machine, threadId: sel.threadId, thread: ms?.threads.get(sel.threadId) ?? null, items: new Map(), loading: true, error: null, hasMore: false, loadingOlder: false, seq: 0, commands: null, dirs: new Map() };
    this.set({ selected: sel, view, scrollFromBottom: 0, diffView: null });
    try {
      const snap: ThreadSnapshot | undefined = await client?.watchThread(sel.threadId, limit);
      if (gen !== this.selectGen || this.state.selected?.threadId !== sel.threadId) return;
      if (process.env.COVEY_EVLOG) { try { appendFileSync(process.env.COVEY_EVLOG, JSON.stringify({ t: Date.now(), snapshot: sel.threadId.slice(0, 8), seq: snap?.seq, items: snap?.items.length, liveItems: view.items.size }) + "\n"); } catch { /* ignore */ } }
      if (snap) {
        view.thread = snap.thread;
        // Merge rather than replace: live events may already have landed in
        // view.items while the snapshot was in flight. Upserts are idempotent.
        const merged = new Map(snap.items.map((i) => [i.id, i]));
        for (const [id, it] of view.items) if (!merged.has(id) || (merged.get(id)!.updatedAt < it.updatedAt)) merged.set(id, it);
        view.items = merged;
        view.hasMore = snap.hasMore;
        view.commands = snap.commands;
        // Events that landed while the snapshot was in flight already carried
        // the view past the snapshot's seq, so keep the higher of the two.
        view.seq = Math.max(view.seq, snap.seq);
      }
      view.loading = false;
      this.set({ view: { ...view } });
    } catch (e: any) {
      view.loading = false; view.error = e.message;
      this.set({ view: { ...view } });
    }
  }

  // ---- ui ------------------------------------------------------------------

  setFocus(f: Focus) { this.set({ focus: f }); }
  toggleSidebar() { this.set({ sidebarCollapsed: !this.state.sidebarCollapsed }); this.config.prefs.sidebarCollapsed = this.state.sidebarCollapsed; this.persist(); }
  setOverlay(o: Overlay | null) { this.set({ overlay: o }); }
  // `defaultOpen` is what the row shows before the user has ever touched it:
  // projects start open, the archived folder starts furled.
  toggleExpanded(key: string, defaultOpen = true) { this.state.expanded[key] = !(this.state.expanded[key] ?? defaultOpen); this.config.prefs.expanded = this.state.expanded; this.persist(); this.touch(); }
  isExpanded(key: string, defaultOpen = true) { return this.state.expanded[key] ?? defaultOpen; }
  toggleItem(id: string) { const s = new Set(this.state.expandedItems); s.has(id) ? s.delete(id) : s.add(id); this.set({ expandedItems: s }); }
  /**
   * Unfold every tool call at once, or fold them all back. Sticky across
   * restarts: whether you read transcripts with the machinery showing is a
   * preference, not a per-thread decision.
   */
  toggleAllTools() {
    const next = !this.state.toolsExpanded;
    this.set({ toolsExpanded: next });
    this.config.prefs.toolsExpanded = next;
    this.persist();
    this.notify(next ? "showing every tool call" : "tool calls folded into >_ rows");
  }
  setScroll(n: number) { this.set({ scrollFromBottom: Math.max(0, n) }); }
  setDraft(threadId: string, text: string) { this.state.drafts.set(threadId, text); }
  draft(threadId: string) { return this.state.drafts.get(threadId) ?? ""; }

  attachments(threadId: string) { return this.state.pendingAttachments.get(threadId) ?? []; }
  setAttachments(threadId: string, atts: TaggedAttachment[]) {
    if (atts.length === 0) this.state.pendingAttachments.delete(threadId);
    else this.state.pendingAttachments.set(threadId, atts);
    this.touch();
  }
  /**
   * Drop the attachments whose tag the user deleted from the draft. The tag is
   * the only record of the file in the text, so no tag means no attachment.
   */
  syncAttachments(threadId: string, text: string) {
    const cur = this.attachments(threadId);
    if (cur.length === 0) return cur;
    const kept = keepTagged(text, cur);
    if (kept.length === cur.length) return cur;
    if (kept.length === 0) this.state.pendingAttachments.delete(threadId);
    else this.state.pendingAttachments.set(threadId, kept);
    this.touch();
    return kept;
  }
  clearAttachments(threadId: string) {
    if (this.state.pendingAttachments.delete(threadId)) this.touch();
  }

  // ---- selection -----------------------------------------------------------

  beginSelection(pane: Selection["pane"], line: number, col: number) {
    this.set({ selection: { pane, anchor: { line, col }, head: { line, col }, dragging: true } });
  }
  /** Put a finished selection down in one go, the way a double or triple click
   *  makes one. `dragging` is false, so pointer motion after it leaves it
   *  alone: the user asked for a word, not for the start of a drag. */
  setSelection(pane: Selection["pane"], anchor: Selection["anchor"], head: Selection["head"]) {
    this.set({ selection: { pane, anchor, head, dragging: false } });
  }
  extendSelection(line: number, col: number) {
    const s = this.state.selection;
    if (!s || !s.dragging) return;
    this.set({ selection: { ...s, head: { line, col } } });
  }
  /** Finish a drag. Returns false if it was really just a click. */
  endSelection(): boolean {
    const s = this.state.selection;
    if (!s) return false;
    if (selectionIsEmpty(s)) { this.set({ selection: null }); return false; }
    this.set({ selection: { ...s, dragging: false } });
    return true;
  }
  clearSelection() {
    if (this.state.selection) this.set({ selection: null });
  }

  /**
   * A line at the foot of the screen.
   *
   * Frame-paced, even though a reader's own action raises some of these. Most
   * of them come from a machine — `noticeTransition` fires when any of eight
   * agents wants an approval or finishes, `noticeUpdate` on every step of an
   * update — and those arrive one websocket frame at a time, so an immediate
   * paint each would be eight full renders back to back at exactly the moment
   * the budget exists to protect. A notice a reader's own keypress raised rides
   * out on that keypress's own paint, or lands within a frame; either way it is
   * under the threshold at which anybody could tell.
   */
  notify(text: string, tone: Notice["tone"] = "info") {
    this.setFromMachine({ notice: { text, tone, at: Date.now() } });
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.setFromMachine({ notice: null }), tone === "error" ? 8000 : 4000);
  }

  private persist() { try { saveConfig(this.config); } catch { /* ignore */ } }

  /** Undefined until the user picks one, so new threads inherit the mode from
   *  the user's own Claude settings instead of covey forcing "default". */
  get defaultPermissionMode(): PermissionMode | undefined { return this.config.prefs.defaultPermissionMode; }

  /**
   * Change a thread's permission mode and remember it as the default for new
   * threads — otherwise you end up re-selecting bypass on every new thread.
   * If an approval is already waiting, a switch to a mode that would not have
   * asked resolves it, so you are not stuck on a prompt you just opted out of.
   */
  async setPermissionMode(threadId: string, mode: PermissionMode) {
    await this.threadCommand({ type: "thread.setPermissionMode", threadId, mode });
    this.config.prefs.defaultPermissionMode = mode;
    this.persist();
    if (mode === "bypassPermissions" || mode === "acceptEdits") {
      const p = this.pendingRequest();
      if (p?.kind === "approval") await this.respondApproval("allow");
    }
    this.notify(
      mode === "bypassPermissions" ? "bypass permissions — tools now run without asking" : `permission mode: ${mode}`,
      mode === "bypassPermissions" ? "error" : "info",
    );
  }

  /**
   * Turn incremental text on or off for one thread. The daemon applies it to
   * the live session at once, so a turn already in flight changes with it.
   */
  async setStreaming(threadId: string, streaming: boolean) {
    await this.threadCommand({ type: "thread.setStreaming", threadId, streaming });
    this.notify(streaming ? "streaming on — text arrives token by token" : "streaming off — each reply lands whole");
  }

  // ---- actions -------------------------------------------------------------

  /**
   * Clone a repository on a machine and record it as a project there. A
   * machine that is not connected gets the request later: it goes on the
   * pending list in the client's config, and `drainPending` sends it when
   * the machine next answers. That is what lets an offline machine join a
   * pool now.
   */
  async createProject(machine: string, url: string, title?: string): Promise<void> {
    const m = this.state.machines.get(machine);
    const name = m?.info?.name ?? m?.saved.name ?? machine;
    if (m?.conn !== "connected") {
      this.pendingProjects.push({ machine, url, ...(title ? { title } : {}) });
      this.config.prefs.pendingProjects = this.pendingProjects;
      this.persist();
      this.notify(`${name} is not connected; it clones ${url} when it next answers`);
      return;
    }
    this.notify(`clone of ${url} started on ${name}…`);
    const err = await this.threadCommand({ type: "project.create", url, ...(title ? { title } : {}) }, machine, CLONE_WAIT_MS);
    if (err === null) this.notify(`project added on ${name}`, "success");
  }

  /** Clone a repository on every machine given: the pool of a new project. */
  async createProjectOn(machines: string[], url: string, title?: string): Promise<void> {
    await Promise.all(machines.map((mk) => this.createProject(mk, url, title)));
  }

  /** What a machine that was offline still owes: clones it was asked for. */
  private pendingProjects: { machine: string; url: string; title?: string }[] = [];

  /** Send a machine the clones it was asked for while it was away. */
  private async drainPending(machine: string): Promise<void> {
    const mine = this.pendingProjects.filter((p) => p.machine === machine);
    if (mine.length === 0) return;
    this.pendingProjects = this.pendingProjects.filter((p) => p.machine !== machine);
    this.config.prefs.pendingProjects = this.pendingProjects;
    this.persist();
    for (const p of mine) {
      const client = this.clients.get(machine);
      if (!client) continue;
      try {
        await client.command({ type: "project.create", url: p.url, ...(p.title ? { title: p.title } : {}) }, CLONE_WAIT_MS);
        this.notify(`${this.state.machines.get(machine)?.info?.name ?? machine} cloned ${p.url}`, "success");
      } catch (e: any) {
        // A project that is already there is the request done. Anything
        // else is kept, so the next connection tries again.
        if (e?.code === "exists" || /already has/.test(String(e?.message))) continue;
        this.pendingProjects.push(p);
        this.config.prefs.pendingProjects = this.pendingProjects;
        this.persist();
        this.notify(`${this.state.machines.get(machine)?.info?.name ?? machine} could not clone ${p.url}: ${e?.message ?? e}`, "error");
      }
    }
  }

  /** The machines a repository is still to be cloned on, by machine key. */
  pendingFor(url: string): string[] {
    return this.pendingProjects.filter((p) => p.url === url).map((p) => p.machine);
  }

  /** Take a machine out of a project's pool: the project and its threads go from that machine. */
  async removeFromPool(machine: string, projectId: string): Promise<void> {
    await this.threadCommand({ type: "project.delete", projectId }, machine);
  }

  async createThread(machine: string, projectId: string) {
    const client = this.clients.get(machine);
    if (!client) return;
    const threadId = randomUUID();
    const sessionId = randomUUID();
    try {
      // A machine-wide default is the daemon's to apply: sending the client's
      // last-used mode here would silently override what the control panel says.
      const machineMode = this.state.machines.get(machine)?.info?.settings?.defaultPermissionMode ?? null;
      const mode = machineMode ? undefined : this.defaultPermissionMode;
      await client.command({ type: "thread.create", projectId, threadId, sessionId, ...(mode ? { permissionMode: mode } : {}) });
      await this.select({ machine, threadId });
      this.setFocus("composer");
      // The snapshot fetched by select() is authoritative about where the
      // daemon actually put the thread.
      const branch = this.state.view?.thread?.worktreePath ? this.state.view.thread.branch : null;
      if (branch) this.notify(`worktree on ${branch}`, "success");
    } catch (e: any) { this.notify(e.message, "error"); }
  }

  /** Live branch state for the new-thread prompt. Null when it cannot be read. */
  async projectGit(machine: string, projectId: string): Promise<ProjectGit | null> {
    const client = this.clients.get(machine);
    if (!client) return null;
    try { return await client.rpc("project.git", { projectId }); }
    catch (e: any) { this.notify(e.message, "error"); return null; }
  }

  // ---- machine control panel ------------------------------------------------

  /** Machine-wide defaults for new threads. Persisted by the daemon. */
  async setMachineDefaults(machine: string, patch: Partial<MachineSettings>) {
    await this.threadCommand({ type: "machine.settings", ...patch }, machine);
  }

  /** What the daemon is running (checkout, branch, commit). Null if unreachable. */
  async machineSource(machine: string): Promise<MachineSource | null> {
    const client = this.clients.get(machine);
    if (!client) return null;
    try { return await client.rpc("machine.source", {}); }
    catch (e: any) { this.notify(this.machineError(machine, e), "error"); return null; }
  }

  /**
   * A daemon older than this TUI simply does not know these methods. Saying so
   * beats "unknown method machine.source", which reads like a bug.
   */
  private machineError(machine: string, e: any): string {
    const who = this.state.machines.get(machine)?.info?.name ?? machine;
    return e?.code === "unknown_method"
      ? `${who} runs an older daemon — run \`covey restart\` there first`
      : e?.message ?? String(e);
  }

  /**
   * Ask every connected machine what its turns cost inside a window. The TUI
   * cannot read a database on another machine, so each one answers for itself
   * and the overlay adds the answers up.
   *
   * The client owns the clock: it sends absolute instants, so machines in
   * different time zones still answer about the same period.
   */
  async loadUsage(window: number, groupBy: UsageGroupBy) {
    const { since, until } = usageWindow(window);
    const keys = this.state.order.filter((k) => this.state.machines.get(k)?.conn === "connected");
    this.setOverlay({ kind: "usage", window, groupBy, loading: true, reports: [], errors: [] });
    const answers = await Promise.all(keys.map(async (k) => {
      const client = this.clients.get(k);
      if (!client) return { machine: k, message: "not connected" };
      try { return await client.rpc("usage.report", { since, until, groupBy }); }
      catch (e: any) { return { machine: k, message: this.machineError(k, e) }; }
    }));
    // A window or grouping changed while the answers were in flight; that
    // request owns the overlay now.
    const ov = this.state.overlay;
    if (ov?.kind !== "usage" || ov.window !== window || ov.groupBy !== groupBy) return;
    this.setOverlay({
      kind: "usage", window, groupBy, loading: false,
      reports: answers.filter((a): a is UsageReport => "total" in a),
      errors: answers.filter((a): a is { machine: string; message: string } => "message" in a),
    });
  }

  /** Pull, rebuild and restart that machine's daemon. Progress arrives as pushes. */
  async updateMachine(machine: string) {
    const client = this.clients.get(machine);
    const ms = this.state.machines.get(machine);
    if (!client || !ms) return;
    try {
      ms.update = await client.rpc("machine.update", {});
      this.setOverlay({ kind: "update", machine });
    } catch (e: any) { this.notify(this.machineError(machine, e), "error"); }
  }

  /** Restart the daemon without updating. The client reconnects on its own. */
  async restartMachine(machine: string) {
    const client = this.clients.get(machine);
    if (!client) return;
    const ms = this.state.machines.get(machine);
    const who = ms?.info?.name ?? machine;
    try {
      await client.rpc("machine.restart", {});
      if (ms) ms.restarting = true;
      client.expectRestart();
      this.notify(`${who}: restarting the daemon…`);
    } catch (e: any) {
      // The daemon may drop the socket before the reply lands; that is the
      // restart happening, not a failure.
      if (e.message === "disconnected") { if (ms) ms.restarting = true; client.expectRestart(); this.notify(`${who}: restarting the daemon…`); }
      else this.notify(this.machineError(machine, e), "error");
    }
  }

  async sendTurn(text: string) {
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    // The tag in the text is the file. Whatever lost its tag does not go.
    const kept = this.syncAttachments(v.threadId, text);
    const attachments = kept.map(({ tag: _tag, ...a }) => a);
    try {
      await client.command({ type: "turn.send", threadId: v.threadId, turnId: randomUUID(), text, ...(attachments.length ? { attachments } : {}) });
      this.clearAttachments(v.threadId);
      this.set({ scrollFromBottom: 0 });
    } catch (e: any) { this.notify(e.message, "error"); }
  }

  async interrupt() {
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    await client.command({ type: "turn.interrupt", threadId: v.threadId }).catch((e) => this.notify(e.message, "error"));
  }

  /**
   * Stop waiting on the tool calls in flight — ctrl+b. They keep running and
   * report back later; the turn gets on with the rest of its work now.
   */
  async background(toolUseId?: string) {
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    const running = [...v.items.values()].filter((i) => i.kind === "tool" && i.status === "running" && !i.background);
    if (running.length === 0) { this.notify("no tool call is running", "error"); return; }
    try {
      await client.command({ type: "turn.background", threadId: v.threadId, ...(toolUseId ? { toolUseId } : {}) });
      this.notify(running.length === 1 ? `backgrounded ${(running[0] as any).summary}` : `backgrounded ${running.length} tool calls`, "success");
    } catch (e: any) {
      this.notify(e?.code === "unknown_method" || e?.code === "unsupported" ? `cannot background here: ${e.message}` : e.message, "error");
    }
  }

  /**
   * Fetch the page of items before the earliest loaded one. Scrolling back asks
   * for a full page; topping a short preview up to fill the pane asks for a
   * small one, so the common case stays cheap.
   */
  async loadOlder(limit = OLDER_PAGE) {
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client || !v.hasMore || v.loadingOlder) return;
    const minSeq = Math.min(...[...v.items.values()].map((i) => i.seq));
    v.loadingOlder = true; this.set({ view: { ...v } });
    try {
      const snap = await client.rpc("thread.snapshot", { threadId: v.threadId, limit, beforeSeq: minSeq });
      if (this.state.view?.threadId !== v.threadId) return;
      for (const it of snap.items) if (!v.items.has(it.id)) v.items.set(it.id, it);
      v.hasMore = snap.hasMore;
    } catch (e: any) { this.notify(e.message, "error"); }
    v.loadingOlder = false;
    this.set({ view: { ...v } });
  }

  async toggleDiff(turnId?: string) {
    if (this.state.diffView) { this.set({ diffView: null }); return; }
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    this.set({ diffView: { threadId: v.threadId, loading: true, diff: null, scroll: 0 } });
    try {
      const diff = await client.rpc("turn.diff", { threadId: v.threadId, turnId });
      const cur = this.state.diffView as AppState["diffView"];
      if (cur?.threadId === v.threadId) this.set({ diffView: { threadId: v.threadId, loading: false, diff, scroll: 0 } });
    } catch (e: any) { this.notify(e.message, "error"); this.set({ diffView: null }); }
  }
  setDiffScroll(n: number) { if (this.state.diffView) this.set({ diffView: { ...this.state.diffView, scroll: Math.max(0, n) } }); }

  async cancelQueued(turnId: string) {
    const v = this.state.view;
    if (!v) return;
    await this.threadCommand({ type: "turn.cancelQueued", threadId: v.threadId, turnId });
  }

  pendingRequest(): TimelineItem | null {
    const v = this.state.view;
    if (!v) return null;
    for (const it of [...v.items.values()].sort((a, b) => a.seq - b.seq)) {
      if ((it.kind === "approval" || it.kind === "question") && it.status === "pending") return it;
    }
    return null;
  }

  async respondApproval(behavior: "allow" | "deny", always = false) {
    const v = this.state.view; const it = this.pendingRequest();
    const client = v && this.clients.get(v.machine);
    if (!v || !client || !it || it.kind !== "approval") return;
    await client.command({ type: "approval.respond", threadId: v.threadId, requestId: it.requestId, behavior, ...(always ? { updatedPermissions: it.suggestions } : {}) }).catch((e) => this.notify(e.message, "error"));
  }

  /** One answer for each question on the pending item, in order. */
  async respondQuestion(answers: string[]) {
    const v = this.state.view; const it = this.pendingRequest();
    const client = v && this.clients.get(v.machine);
    if (!v || !client || !it || it.kind !== "question") return;
    // `answer` carries the first one as well, so a daemon that predates the
    // list still answers a single question.
    await client.command({ type: "question.respond", threadId: v.threadId, requestId: it.requestId, answer: answers[0] ?? "", answers }).catch((e) => this.notify(e.message, "error"));
  }

  /**
   * Send a command about a thread. The refusal is put on the notice line and
   * also returned, because a caller that says "done" afterwards must first
   * know that the command went through. Null means it did.
   */
  async threadCommand(cmd: Parameters<MachineClient["command"]>[0], machine?: string, timeoutMs?: number): Promise<string | null> {
    const key = machine ?? this.state.selected?.machine;
    const client = key && this.clients.get(key);
    if (!client) return "no machine";
    try {
      await client.command(cmd, timeoutMs);
      return null;
    } catch (e: any) {
      const msg = e?.message ?? "the machine refused the command";
      this.notify(msg, "error");
      return msg;
    }
  }

  /**
   * Rewind a thread to before a turn: the files, the conversation and the
   * transcript. The daemon refuses while the thread is busy ("interrupt the
   * running turn first"), and that refusal is an ordinary answer — it is
   * already on the notice line. Thus only a command that went through says
   * "reverted". Both routes to a rewind, `ctrl+k` and `esc` `esc`, come here.
   */
  async revertTurn(threadId: string, turnId: string): Promise<boolean> {
    const err = await this.threadCommand({ type: "turn.revert", threadId, turnId });
    if (err) return false;
    this.notify("reverted", "success");
    return true;
  }

  /** Move the selected thread to another machine + project. */
  async moveThread(from: { machine: string; threadId: string }, to: { machine: string; projectId?: string; url?: string }) {
    const src = this.clients.get(from.machine); const dst = this.clients.get(to.machine);
    const dstInfo = this.state.machines.get(to.machine)?.info;
    if (!src || !dst || !dstInfo) { this.notify("both machines must be connected", "error"); return; }
    try {
      this.notify("exporting thread…");
      const exp = await src.rpc("thread.export", { threadId: from.threadId });
      this.notify(`importing on ${dstInfo.name}…`);
      // An import may clone first, and a clone gets the daemon's ten minutes.
      const r = await dst.rpc("thread.import", { export: exp, projectId: to.projectId, url: to.url }, CLONE_WAIT_MS);
      await src.rpc("thread.markMoved", { threadId: from.threadId, machineId: dstInfo.machineId, newThreadId: r.threadId });
      this.notify(`moved to ${dstInfo.name}`, "success");
      await this.select({ machine: to.machine, threadId: r.threadId });
    } catch (e: any) { this.notify(`move failed: ${e.message}`, "error"); }
  }

  /**
   * Read one directory under the open thread for the `@` menu, once. The
   * listing is kept for as long as the thread is open: a mention is typed in
   * seconds, and a request per keystroke over a tailnet is not worth the
   * newer answer.
   */
  async loadDir(dir: string) {
    const v = this.state.view;
    if (!v || v.dirs.has(dir)) return;
    const client = this.clients.get(v.machine);
    if (!client) return;
    const threadId = v.threadId;
    v.dirs.set(dir, { entries: [], loading: true, truncated: false, error: null });
    this.touch();
    const put = (l: DirListing) => {
      const cur = this.state.view;
      if (!cur || cur.threadId !== threadId) return;
      cur.dirs.set(dir, l);
      this.set({ view: { ...cur } });
    };
    try {
      const r = await client.rpc("thread.listDir", { threadId, dir });
      put({ entries: r.entries, loading: false, truncated: r.truncated, error: null });
    } catch (e: any) {
      put({ entries: [], loading: false, truncated: false, error: e.message });
    }
  }

  // ---- runs ----------------------------------------------------------------

  /** The run record, from the machine whose daemon stores it. */
  run(machine: string, runId: string): Run | null {
    return this.state.machines.get(machine)?.runs.get(runId) ?? null;
  }

  /** The member under an id, and the machine key its thread lives on. */
  member(machine: string, runId: string, memberId: string): RunMember | null {
    return this.run(machine, runId)?.members.find((m) => m.id === memberId) ?? null;
  }

  /** The client key for a machine id, across every machine this client holds. */
  machineKeyOf(machineId: string): string | null {
    for (const k of this.state.order) if (this.state.machines.get(k)?.info?.machineId === machineId) return k;
    return null;
  }

  /** A machine's name, for a run row that names a machine it may not be on. */
  machineNameOf(machineId: string): string {
    const k = this.machineKeyOf(machineId);
    return (k && this.state.machines.get(k)?.info?.name) || machineId.slice(0, 8);
  }

  /**
   * The machines a run may put work on: connected, with a checkout of the same
   * repository, and reporting what they are made of.
   *
   * A machine whose daemon predates `resources` is still offered — it just
   * counts as one core and one member at a time, because guessing bigger is
   * how a Pi ends up with ten agents on it.
   */
  placementMachines(repositoryIdentity: string | null): PlacementMachine[] {
    const out: PlacementMachine[] = [];
    for (const key of this.state.order) {
      const m = this.state.machines.get(key);
      if (!m || m.conn !== "connected" || !m.info) continue;
      const project = [...m.projects.values()].find((p) =>
        repositoryIdentity ? p.repositoryIdentity === repositoryIdentity : false);
      if (!project) continue;
      const r = m.info.resources;
      out.push({
        key,
        machineId: m.info.machineId,
        name: m.info.name,
        os: m.info.os,
        arch: m.info.arch,
        tools: [...new Set((r?.tools ?? []).map((t) => t.name))],
        cpuCount: r?.cpuCount ?? 1,
        concurrency: r?.concurrency ?? 1,
        tmpDir: r?.tmpDir ?? "/tmp",
        projectId: project.id,
      });
    }
    return out;
  }

  /** Read the issues a task list names, with `gh` in that machine's checkout. */
  async runIssues(machine: string, projectId: string, numbers: number[]): Promise<{ issues: RunIssue[]; error: string | null }> {
    const client = this.clients.get(machine);
    if (!client) return { issues: [], error: "not connected" };
    try { return await client.rpc("run.issues", { projectId, numbers }); }
    catch (e: any) { return { issues: [], error: this.machineError(machine, e) }; }
  }

  /**
   * Start a run: place every task, give every member its own port and
   * directories, and write the record on this machine's daemon.
   *
   * Nothing is dispatched here. The operator reads the placement and may move a
   * member before any agent starts, because placement that cannot be overridden
   * will be wrong on the first run that matters.
   */
  async createRun(o: {
    machine: string;
    name: string;
    goal: string;
    tasks: RunTask[];
    repositoryIdentity: string | null;
    briefTemplate?: string;
    /** The run's id. Supplied only by a test that needs a known one. */
    runId?: string;
  }): Promise<string | null> {
    const client = this.clients.get(o.machine);
    if (!client) { this.notify("start a run from a connected machine", "error"); return null; }
    const machines = this.placementMachines(o.repositoryIdentity);
    if (machines.length === 0) { this.notify("no connected machine has a checkout of this project", "error"); return null; }
    const runId = o.runId ?? randomUUID();
    // Placed against what every other run's live members already hold, the same
    // way `addTasks` is. A machine's concurrency limit is the machine's, not
    // each run's: two runs started in a row would otherwise both fill the Mac
    // to its limit and put twice the limit on it.
    const placed = placeTasks(o.tasks, machines, this.membersPerMachine());
    const byId = new Map(machines.map((m) => [m.machineId, m]));
    const ports = allocatePorts(runId, placed.length, this.portsInUse());
    const members = placed.map((p, i) => {
      // A task no machine can take still gets a member, on the fastest machine,
      // so the operator sees it and decides. Dropping it silently is how a task
      // goes missing from a run of twenty.
      const target = (p.machineId && byId.get(p.machineId)) || machines[0]!;
      return {
        id: randomUUID(),
        task: p.task,
        machineId: target.machineId,
        projectId: target.projectId,
        resources: allocateResources(runId, ports[i]!, target.tmpDir, memberSlug(p.task, i)),
        // A member the rule could not place says so on its own row. Moving it
        // is the operator's call, and they cannot make it without the reason.
        note: p.machineId === null ? `not placed by the rule: ${p.reason} — move it or change the task` : null,
      };
    });
    try {
      await client.command({
        type: "run.create",
        run: {
          runId,
          name: o.name,
          goal: o.goal,
          briefTemplate: o.briefTemplate ?? DEFAULT_BRIEF,
          members,
        },
      });
      this.setOverlay({ kind: "run", machine: o.machine, runId, marked: new Set(), busy: null });
      return runId;
    } catch (e: any) { this.notify(e.message, "error"); return null; }
  }

  /**
   * The ports the members of every run this client can see are still using.
   *
   * Two runs whose ids hash close together would otherwise hand the same port
   * to two agents — which is issue #8 happening again, one level up. A member
   * that is merged or withdrawn has given its port back.
   */
  private portsInUse(): Set<number> {
    const ports = new Set<number>();
    for (const key of this.state.order) {
      for (const run of this.state.machines.get(key)?.runs.values() ?? []) {
        for (const m of run.members) if (!isFinalMemberState(m.state)) ports.add(m.resources.port);
      }
    }
    return ports;
  }

  /**
   * How many live members every machine already carries, across every run this
   * client can see. Placement starts from this rather than from zero.
   */
  private membersPerMachine(): Map<string, number> {
    const load = new Map<string, number>();
    for (const key of this.state.order) {
      for (const run of this.state.machines.get(key)?.runs.values() ?? []) {
        for (const m of run.members) if (!isFinalMemberState(m.state)) load.set(m.machineId, (load.get(m.machineId) ?? 0) + 1);
      }
    }
    return load;
  }

  /** Change one member's row. Everything about a run is one of these. */
  async patchMember(machine: string, runId: string, memberId: string, patch: RunMemberPatch): Promise<string | null> {
    return this.threadCommand({ type: "run.member.patch", runId, memberId, patch }, machine);
  }

  /** Move a member to another machine. Refused once its thread exists. */
  async moveMember(machine: string, runId: string, memberId: string, toMachineId: string) {
    const m = this.member(machine, runId, memberId);
    if (!m) return;
    if (m.threadId) { this.notify("this member already has a thread — withdraw it instead of moving it", "error"); return; }
    const run = this.run(machine, runId);
    const to = this.placementMachines(this.runRepository(machine, runId)).find((x) => x.machineId === toMachineId);
    if (!to || !run) { this.notify("that machine has no checkout of this project", "error"); return; }
    const index = run.members.findIndex((x) => x.id === memberId);
    await this.patchMember(machine, runId, memberId, {
      machineId: to.machineId,
      projectId: to.projectId,
      // The port is the member's and goes with it. The directories are rebuilt,
      // because they are named for the machine they will be used on and `/tmp`
      // is not `/tmp` everywhere.
      resources: allocateResources(runId, m.resources.port, to.tmpDir, memberSlug(m.task, index)),
    });
    this.notify(`${m.task.key} → ${to.name}`, "success");
  }

  /** The repository a run's members work in, from the project of its first member. */
  private runRepository(machine: string, runId: string): string | null {
    const run = this.run(machine, runId);
    for (const m of run?.members ?? []) {
      const key = this.machineKeyOf(m.machineId);
      const p = key && m.projectId ? this.state.machines.get(key)?.projects.get(m.projectId) : null;
      if (p) return p.repositoryIdentity;
    }
    return null;
  }

  /**
   * Start every member that has not started. One thread each, in its own
   * worktree, with a brief that names its own resources.
   *
   * Serialised on purpose: fifteen `git worktree add` calls at once on one
   * machine is a lot of disk, and a failure part way through should leave a run
   * the operator can read rather than fifteen half-made threads.
   */
  async dispatchRun(machine: string, runId: string) {
    const run = this.run(machine, runId);
    if (!run) return;
    const todo = run.members.filter((m) => m.state === "planned" && !m.threadId);
    if (todo.length === 0) { this.notify("every member is already dispatched", "error"); return; }
    let done = 0;
    for (const m of todo) {
      this.setRunBusy(machine, runId, `dispatching ${m.task.key} (${done + 1}/${todo.length})…`);
      const err = await this.dispatchMember(machine, runId, m.id);
      if (err) {
        await this.patchMember(machine, runId, m.id, { state: "blocked", note: `dispatch failed: ${err}` });
        this.notify(`${m.task.key}: ${err}`, "error");
      } else done++;
    }
    this.setRunBusy(machine, runId, null);
    this.notify(`dispatched ${done} of ${todo.length}`, done === todo.length ? "success" : "error");
  }

  /** Start one member. Returns the reason it could not, or null. */
  async dispatchMember(machine: string, runId: string, memberId: string): Promise<string | null> {
    const run = this.run(machine, runId);
    const m = run?.members.find((x) => x.id === memberId);
    if (!run || !m) return "no such member";
    if (m.threadId) return null;
    const key = this.machineKeyOf(m.machineId);
    const client = key ? this.clients.get(key) : null;
    if (!client || !m.projectId) return `${this.machineNameOf(m.machineId)} is not connected`;
    const threadId = randomUUID();
    try {
      await client.command({
        type: "thread.create",
        projectId: m.projectId,
        threadId,
        sessionId: randomUUID(),
        title: m.task.title,
        // Said outright, because the client name cannot say it: this connection
        // is the TUI, the one client a person types into, but nobody typed this
        // thread. No parent — a member is grouped under its run row already,
        // and a thread must not be painted in two groups at once.
        origin: { by: "agent" },
      });
      // Write the thread onto the member the moment it exists, before the brief
      // is even composed. A failure after this point leaves a thread and a
      // worktree on that machine, and a run that did not record them is the
      // defect of 2026-09-16 from the other end: work nobody knew was there,
      // found later by `git rev-list`. It also stops a second dispatch making a
      // second worktree for the same task.
      await this.patchMember(machine, runId, memberId, { threadId });
      // Read the thread back rather than waiting for the shell push: the branch
      // the daemon minted goes into the brief, and the brief is the next thing
      // sent. One round trip, and the agent's first message names its branch.
      const snap = await client.rpc("thread.snapshot", { threadId, limit: 1 });
      const brief = renderBrief(run.briefTemplate, {
        runName: run.name,
        goal: run.goal,
        task: m.task,
        machineName: this.machineNameOf(m.machineId),
        branch: snap.thread.branch ?? "",
        resources: m.resources,
        position: run.members.indexOf(m) + 1,
        total: run.members.length,
      });
      await client.command({ type: "turn.send", threadId, turnId: randomUUID(), text: brief });
      await this.patchMember(machine, runId, memberId, {
        threadId,
        branch: snap.thread.branch,
        worktreePath: snap.thread.worktreePath,
        brief,
        state: "dispatched",
        dispatchedAt: new Date().toISOString(),
        note: null,
      });
      return null;
    } catch (e: any) {
      return e?.message ?? String(e);
    }
  }

  /**
   * Add tasks to a run in flight.
   *
   * Scope changes in the middle: on the day this came from, one task was
   * cancelled outright and another was added, and the run had to absorb both
   * without being torn down. A new task is placed by the same rule as the
   * others and gets resources nobody else in the run has.
   */
  async addTasks(machine: string, runId: string, tasks: RunTask[]) {
    const run = this.run(machine, runId);
    if (!run) return;
    const machines = this.placementMachines(this.runRepository(machine, runId));
    if (machines.length === 0) { this.notify("no connected machine has a checkout of this project", "error"); return; }
    // Placed against what the machines already carry, so a task added to a run
    // in flight lands where there is room and not on top of the full machine.
    const placed = placeTasks(tasks, machines, this.membersPerMachine());
    // The new members clear every port this run already holds, as well as every
    // other run's — an added task must not take the port of a member at work.
    const taken = this.portsInUse();
    for (const m of run.members) taken.add(m.resources.port);
    const ports = allocatePorts(runId, tasks.length, taken);
    for (let i = 0; i < tasks.length; i++) {
      const index = run.members.length + i;
      const target = machines.find((x) => x.machineId === placed[i]!.machineId) ?? machines[0]!;
      const err = await this.threadCommand({
        type: "run.member.add",
        runId,
        member: {
          id: randomUUID(),
          task: tasks[i]!,
          machineId: target.machineId,
          projectId: target.projectId,
          resources: allocateResources(runId, ports[i]!, target.tmpDir, memberSlug(tasks[i]!, index)),
        },
      }, machine);
      if (err) return;
    }
    this.notify(`added ${tasks.length} task${tasks.length === 1 ? "" : "s"} — press d to dispatch`, "success");
  }

  /**
   * Send the same message to several members at once.
   *
   * The operator of 2026-09-16 sent the same correction to fifteen threads four
   * separate times, each one a hand-written loop over thread ids. This is the
   * single largest manual cost in a run and the cheapest thing to build.
   */
  async sendToRun(machine: string, runId: string, memberIds: string[], text: string) {
    const run = this.run(machine, runId);
    if (!run) return;
    const targets = run.members.filter((m) => memberIds.includes(m.id) && m.threadId);
    if (targets.length === 0) { this.notify("none of those members has a thread yet", "error"); return; }
    let sent = 0;
    const failed: string[] = [];
    for (const m of targets) {
      const key = this.machineKeyOf(m.machineId);
      const client = key ? this.clients.get(key) : null;
      if (!client) { failed.push(m.task.key); continue; }
      try {
        await client.command({ type: "turn.send", threadId: m.threadId!, turnId: randomUUID(), text });
        sent++;
      } catch { failed.push(m.task.key); }
    }
    this.notify(
      failed.length === 0 ? `sent to ${sent} member${sent === 1 ? "" : "s"}` : `sent to ${sent}; ${failed.join(" ")} did not take it`,
      failed.length === 0 ? "success" : "error",
    );
  }

  /**
   * Read each member's pull request, from the machine that holds its branch.
   *
   * This is the one field of a run that does not stream over an existing
   * subscription. Identity and state only: whether a change *may merge*, and in
   * what order, is issue #45 and attaches to `member.review`.
   */
  async refreshPullRequests(machine: string, runId: string) {
    const run = this.run(machine, runId);
    if (!run) return;
    this.setRunBusy(machine, runId, "reading pull requests…");
    const errors: string[] = [];
    for (const m of run.members) {
      if (!m.threadId || !m.branch) continue;
      const key = this.machineKeyOf(m.machineId);
      const client = key ? this.clients.get(key) : null;
      if (!client) continue;
      try {
        const pr = await client.rpc("run.pullRequest", { threadId: m.threadId });
        const state = nextStateForPr(m.state, pr);
        if (pr?.url !== m.pullRequest?.url || pr?.state !== m.pullRequest?.state || state !== m.state)
          await this.patchMember(machine, runId, m.id, { pullRequest: pr, state });
      } catch (e: any) { errors.push(`${m.task.key}: ${e.message}`); }
    }
    this.setRunBusy(machine, runId, null);
    if (errors.length) this.notify(errors[0]!, "error");
  }

  /** Put a line on the run panel while it works. */
  private setRunBusy(machine: string, runId: string, busy: string | null) {
    const ov = this.state.overlay;
    if (ov?.kind === "run" && ov.machine === machine && ov.runId === runId) this.setOverlay({ ...ov, busy });
  }

  /**
   * A member whose thread has started work is working.
   *
   * Only a client sees both the run record and the threads on every machine, so
   * this is where the two meet. It moves a member forward once and never back:
   * a thread that goes idle between turns has not stopped being the member's.
   */
  private noticeRunProgress(ms: MachineState, thread: Thread) {
    const machineId = ms.info?.machineId;
    if (!machineId) return;
    const busy = thread.status === "running" || thread.status === "starting" || thread.latestTurn?.state === "running";
    if (!busy) return;
    for (const key of this.state.order) {
      const holder = this.state.machines.get(key);
      if (!holder || holder.conn !== "connected") continue;
      for (const run of holder.runs.values()) {
        const m = run.members.find((x) => x.threadId === thread.id && x.machineId === machineId);
        if (!m || m.state !== "dispatched") continue;
        const mark = `${run.id}:${m.id}`;
        if (this.advancing.has(mark)) continue;
        this.advancing.add(mark);
        void this.patchMember(key, run.id, m.id, { state: "working" }).finally(() => this.advancing.delete(mark));
      }
    }
  }

  /** Members being moved to `working`, so one thread event is not sent twice. */
  private advancing = new Set<string>();

  shutdown() {
    this.frames.stop();
    this.stopWatchingBuild();
    if (this.noticeTimer) { clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const c of this.clients.values()) c.stop();
  }
}

// ---- derived helpers --------------------------------------------------------

/**
 * Where a member stands once its pull request has been read. Tracking only:
 * a member that reached review is in review, and one whose change landed is
 * merged. Whether it *may* merge is issue #45.
 *
 * `blocked` and `withdrawn` are the operator's, so a pull request never
 * overrules them.
 */
export function nextStateForPr(state: RunMemberState, pr: { state: string } | null): RunMemberState {
  if (state === "blocked" || state === "withdrawn" || isFinalMemberState(state)) return state;
  if (!pr) return state;
  if (pr.state === "MERGED") return "merged";
  return state === "dispatched" || state === "working" ? "review" : state;
}

/** True for a machine URL that points at this very machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch { return false; }
}

/** How a permission mode reads in a menu: the name first, then what it does. */
export function permissionModeLabel(mode: PermissionMode | null | undefined): string {
  switch (mode) {
    case "default": return "manual";
    case "acceptEdits": return "auto";
    case "bypassPermissions": return "bypass";
    case "plan": return "plan";
    default: return "from Claude settings";
  }
}

/** Threads a user expects to see: no archive, no tombstones of moved threads. */
/** One machine's copy of a pooled project. */
export interface PoolMember { machine: string; projectId: string; project: Project }

/**
 * A repository as the sidebar shows it: one row, however many machines hold
 * it. Projects with the same normalised remote are one group; a project with
 * no remote is a group of its own, keyed by machine and id, so it never merges
 * with another machine's directory of the same name.
 */
export interface ProjectGroup {
  /** The repository identity, or `<machine>:<project id>` for a project with none. */
  key: string;
  title: string;
  members: PoolMember[];
}

/** The fold key of a project row. The same string a project with no remote
 *  always had, so a fold survives the change to pooled rows. */
export function projectFoldKey(group: { key: string }): string { return group.key; }

/**
 * The projects of every machine, grouped by repository, in title order. The
 * machines within a group keep the sidebar's machine order, so "the first
 * machine of the pool" is a stable choice.
 */
export function projectGroups(s: AppState): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const key of s.order) {
    const m = s.machines.get(key);
    if (!m) continue;
    for (const p of m.projects.values()) {
      const gk = p.repositoryIdentity ?? `${key}:${p.id}`;
      const g = groups.get(gk) ?? { key: gk, title: p.title, members: [] };
      g.members.push({ machine: key, projectId: p.id, project: p });
      groups.set(gk, g);
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The group a project on a machine belongs to, or null when it is not there. */
export function groupOfProject(s: AppState, machine: string, projectId: string): ProjectGroup | null {
  return projectGroups(s).find((g) => g.members.some((x) => x.machine === machine && x.projectId === projectId)) ?? null;
}

export function liveThreads(m: MachineState, projectId?: string): Thread[] {
  return [...m.threads.values()].filter((t) => !t.archivedAt && !t.movedTo && (projectId === undefined || t.projectId === projectId));
}

/** Pinned first, then most recently spoken to — the sidebar's order. */
export function byRecency(a: Thread, b: Thread): number {
  return (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

export interface ThreadTally {
  total: number;
  running: number;
  /** Blocked on an approval or a question — the count that wants your attention. */
  waiting: number;
  idle: number;
  queued: number;
  /** Summed over the threads' latest turns, so it reads as "work in flight". */
  additions: number;
  deletions: number;
  files: number;
}

/**
 * What a set of threads adds up to, for the project and machine summaries.
 * A pending approval outranks the session status, the same way the sidebar dot
 * does: a thread that is technically "running" but parked on a question is
 * waiting on *you*.
 */
export function tallyThreads(threads: Iterable<Thread>): ThreadTally {
  const t: ThreadTally = { total: 0, running: 0, waiting: 0, idle: 0, queued: 0, additions: 0, deletions: 0, files: 0 };
  for (const th of threads) {
    t.total++;
    if (th.pendingApprovals > 0 || th.status === "waiting") t.waiting++;
    else if (th.status === "running" || th.status === "starting") t.running++;
    else t.idle++;
    t.queued += th.queuedTurns;
    const d = th.latestTurn?.diff;
    if (d && !d.unavailable) { t.additions += d.additions; t.deletions += d.deletions; t.files += d.files.length; }
  }
  return t;
}

export interface SidebarRow {
  key: string;
  /**
   * `project` heads a repository, pooled across every machine that has it;
   * `machines` heads the fleet, below the projects; `machine` is one row of
   * that section. The rest sit under a project.
   */
  kind: "project" | "thread" | "empty" | "archived" | "run" | "member" | "machines" | "machine";
  /**
   * The machine a row acts on. For a project row, the first machine of its
   * pool; a thread, run or member names the machine it lives on. Empty on the
   * `machines` header, which is nobody's.
   */
  machine: string;
  projectId?: string;
  thread?: Thread;
  project?: Project;
  /** Set on a project row: every machine that holds this repository. */
  pool?: PoolMember[];
  /** The project group a row belongs to (`ProjectGroup.key`): the fold key
   *  of the project, and of its archived folder. */
  groupKey?: string;
  /**
   * Set on a thread row when its project spans more than one machine, so the
   * row can say which one the thread is on.
   */
  tag?: string;
  /** Set on the archived folder and on every thread row inside it. */
  archived?: boolean;
  /** How many threads the archived folder holds. */
  count?: number;
  /** Set on a run row and on every member row inside it. */
  run?: Run;
  member?: RunMember;
  /** Set on a thread a program started, not a person (`Thread.origin.by`). */
  agent?: boolean;
  /** Set on a thread row that has threads of its own under it. */
  group?: boolean;
  /** How many of a furled group's children are not painted. */
  hidden?: number;
  depth: number;
}

/** `expanded` key for a project's archived folder. Furled unless toggled. */
/** The fold key of a project group's archived folder. */
export function archiveKey(group: string): string { return `${group}:archived`; }

/** `expanded` key for a run's members. Open unless furled. */
export function runKey(machine: string, runId: string): string { return `${machine}:run:${runId}`; }

/**
 * `expanded` key for the threads one thread started. Furled unless opened,
 * which is the point of #69: fifteen dispatched threads become one row.
 *
 * It is the same mechanism a project and an archive folder use, so a group the
 * user furled is still furled after a restart (`TuiConfig.prefs.expanded`).
 */
export function threadGroupKey(machine: string, threadId: string): string { return `${machine}:thread:${threadId}`; }

/**
 * True when a thread has stopped needing to work and started needing a person:
 * it failed, or it is blocked on an approval or an answer.
 *
 * This is the attention rule of #49. An agent's thread is quiet while it works,
 * so a furled group hides it — but never these. Nobody else is watching a
 * thread that failed, and a run in a strict permission mode deadlocks in
 * silence if the thread asking for the approval is the one that is hidden.
 */
export function needsPerson(t: Thread): boolean {
  return t.status === "error" || t.status === "waiting" || t.pendingApprovals > 0;
}

/**
 * The same rule, one level up: a member a furled run must paint anyway.
 *
 * A member is `blocked` when the operator or the tracker said so, and its
 * thread needs a person under `needsPerson`. Without this, furling a run in a
 * strict permission mode buries the approval that the whole run is waiting on —
 * the deadlock #69 already refused to allow inside a thread group.
 */
export function memberNeedsPerson(s: AppState, m: RunMember): boolean {
  if (m.state === "blocked") return true;
  if (!m.threadId) return false;
  const t = threadOnMachineId(s, m.machineId, m.threadId);
  return !!t && needsPerson(t);
}

/**
 * A run a furled thread group must paint anyway: one of its members needs a
 * person. The rule `needsPerson` states for a thread, read through the run
 * that holds it — a run furled inside a group would otherwise bury the
 * approval that the whole run waits on, two folds deep instead of one.
 */
export function runNeedsPerson(s: AppState, run: Run): boolean {
  return run.members.some((x) => memberNeedsPerson(s, x));
}

/**
 * A run with work in flight. `working` is a member whose thread is running;
 * `dispatched` is one whose thread was made and has not answered yet.
 *
 * The project row reads this beside the status of its threads. Most of the
 * time the two say the same thing, because a working member has a thread in
 * the project and that thread is running — but a member dispatched to a
 * machine this client has not heard from has no thread here to read, and a
 * fold that says nothing about it looks exactly like a fold over nothing.
 */
export function runIsBusy(run: Run): boolean {
  return run.members.some((x) => x.state === "working" || x.state === "dispatched");
}

/** The runs of one project on one machine, in the order the sidebar paints
 *  them. One pass for the three questions the project row asks. */
export function projectRuns(m: MachineState, projectId: string): Run[] {
  return [...m.runs.values()]
    .filter((r) => runProject(m, r) === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The tasks of a project's runs that are not threads yet.
 *
 * The number on a project row means the work inside it, and it has always
 * been the count of its threads because threads were all there was. A run
 * spends most of its life planned rather than dispatched, and a planned task
 * has no thread — so a project holding one thread and three runs of five read
 * "1", and a furled row hid fifteen pieces of work behind that number.
 *
 * A dispatched task is already a thread in this project and is already
 * counted; a task that merged or was withdrawn is over. Neither is counted
 * again here.
 */
export function pendingTasks(m: MachineState, projectId: string): number {
  let n = 0;
  for (const run of projectRuns(m, projectId)) {
    for (const x of run.members) if (!x.threadId && !isFinalMemberState(x.state)) n++;
  }
  return n;
}

/**
 * The project a run belongs to, or null when no single project can be named.
 *
 * A run's members carry a project each, and a project id only means anything
 * on the machine that holds the project. So a run is a project's when every
 * placed member works in that one project, on the machine holding the run.
 * Two projects, or a member dispatched to another machine, and the run has no
 * home: the caller keeps it under the machine rather than filing it somewhere
 * it does not work.
 *
 * A run with nothing placed yet has no member to read a project off, and that
 * is most of a run's life — it is planned, named and looked at long before it
 * is dispatched. The thread that asked for it answers instead, so a run does
 * not spend its planning under the machine and then jump into a furled group
 * at the moment work starts.
 */
export function runProject(m: MachineState, run: Run): string | null {
  const mine = m.info?.machineId;
  if (!mine) return null;
  let found: string | null = null;
  for (const x of run.members) {
    if (!x.projectId) continue;
    if (x.machineId !== mine) return null;
    if (found && found !== x.projectId) return null;
    found = x.projectId;
  }
  if (!found && run.parentThreadId) {
    const t = m.threads.get(run.parentThreadId);
    if (t && !t.archivedAt && !t.movedTo) found = t.projectId;
  }
  return found && m.projects.has(found) ? found : null;
}

/** A thread by machine *id* — a run's members name machines, not client keys. */
function threadOnMachineId(s: AppState, machineId: string, threadId: string): Thread | null {
  for (const k of s.order) {
    const ms = s.machines.get(k);
    if (ms?.info?.machineId === machineId) return ms.threads.get(threadId) ?? null;
  }
  return null;
}

export function sidebarRows(s: AppState): SidebarRow[] {
  const rows: SidebarRow[] = [];
  // The threads a run already speaks for, as `<machine key>:<thread id>`.
  //
  // A run's member row *is* that thread: clicking it opens the conversation.
  // Painting the thread again under its project put the same work on screen
  // twice — once as a task under the run, once as a `◇` row sorted into the
  // project by recency — and the project copy belonged to no group, so there
  // was nothing to furl it into. A member's thread lives under its run and
  // nowhere else, which is what `docs/DESIGN.md` has always said it did.
  //
  // Read from the runs this client actually holds, so the claim can only hide
  // a thread that something else is really painting: a run whose machine has
  // not answered yet claims nothing, and its threads stay in their projects.
  const keyOfMachineId = new Map<string, string>();
  for (const k of s.order) { const id = s.machines.get(k)?.info?.machineId; if (id) keyOfMachineId.set(id, k); }
  const inRun = new Set<string>();
  for (const k of s.order) {
    for (const run of s.machines.get(k)?.runs.values() ?? []) {
      for (const mem of run.members) {
        const mk = keyOfMachineId.get(mem.machineId);
        if (mem.threadId && mk) inRun.add(`${mk}:${mem.threadId}`);
      }
    }
  }
  const pushRun = (machine: string, run: Run, depth: number, projectId?: string, groupKey?: string) => {
    const open = s.expanded[runKey(machine, run.id)] ?? true;
    // Furled, a run holds its members the way a thread group holds its
    // children — and lets through the ones that need a person.
    const shown = open ? run.members : run.members.filter((x) => memberNeedsPerson(s, x));
    const at = { ...(projectId ? { projectId } : {}), ...(groupKey ? { groupKey } : {}) };
    // No `hidden` count: a run row's meta already says how many members it
    // has, which is what that count exists to tell a thread row.
    rows.push({ key: `r:${machine}:${run.id}`, kind: "run", machine, ...at, run, depth });
    for (const member of shown) {
      rows.push({ key: `rm:${machine}:${run.id}:${member.id}`, kind: "member", machine, ...at, run, member, depth: depth + 1 });
    }
  };
  // Where each run sits: `<machine>:<project id>` for a run whose project can
  // be named, and nothing for one that cannot. A run is not free-floating
  // machinery: its members work in one project, and the operator reads the
  // tree by project. So a run goes inside the project its members work in, and
  // under the thread that asked for it when there is one.
  //
  // A run whose project cannot be named — no members placed yet, members in
  // two projects, members dispatched to another machine — sits above the
  // projects. Being one level too high is a run the operator can still find;
  // being filed under a project it does not work in is a lie.
  const runsOf = new Map<string, { machine: string; run: Run }[]>();
  const homeless: { machine: string; run: Run }[] = [];
  for (const key of s.order) {
    const m = s.machines.get(key)!;
    for (const run of [...m.runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const p = runProject(m, run);
      if (!p) { homeless.push({ machine: key, run }); continue; }
      const hk = `${key}:${p}`;
      runsOf.set(hk, [...(runsOf.get(hk) ?? []), { machine: key, run }]);
    }
  }
  for (const { machine, run } of homeless) pushRun(machine, run, 0);

  const groups = projectGroups(s);
  const anyConnected = s.order.some((k) => s.machines.get(k)?.conn === "connected");
  if (groups.length === 0 && anyConnected) rows.push({ key: "e:", kind: "empty", machine: s.order.find((k) => s.machines.get(k)?.conn === "connected") ?? "", depth: 0 });
  for (const g of groups) {
    const first = g.members[0]!;
    const pooled = g.members.length > 1;
    rows.push({ key: `p:${g.key}`, kind: "project", machine: first.machine, projectId: first.projectId, project: first.project, pool: g.members, groupKey: g.key, depth: 0 });
    if (!(s.expanded[projectFoldKey(g)] ?? true)) continue;
    // Every machine's threads of this repository, in one list by recency. A
    // thread's row keeps the machine it lives on; the tag says which when the
    // pool has more than one.
    const tagOf = (machine: string) => pooled ? (s.machines.get(machine)?.info?.name ?? s.machines.get(machine)?.saved.name ?? machine) : undefined;
    const owned: { machine: string; projectId: string; t: Thread }[] = [];
    for (const x of g.members) {
      const m = s.machines.get(x.machine)!;
      for (const t of liveThreads(m, x.projectId)) if (!inRun.has(`${x.machine}:${t.id}`)) owned.push({ machine: x.machine, projectId: x.projectId, t });
    }
    owned.sort((a, b) => byRecency(a.t, b.t));
    const threads = owned.map((o) => o.t);
    const placeOf = new Map(owned.map((o) => [o.t.id, o]));
    // A thread a program started sits under the thread that started it.
    // `origin.parentThreadId` is the only record of that (#49); a parent that
    // is not in this list — archived, deleted, or on another machine — leaves
    // the child a top-level row, because a thread must never be lost behind a
    // link that leads nowhere.
    const here = new Map(threads.map((t) => [t.id, t]));
    const parentOf = (t: Thread) => {
      const id = t.origin?.parentThreadId;
      return id && id !== t.id && here.has(id) ? id : null;
    };
    const kids = new Map<string, Thread[]>();
    for (const t of threads) {
      const parent = parentOf(t);
      if (parent) kids.set(parent, [...(kids.get(parent) ?? []), t]);
    }
    // Which threads are top-level rows. A thread whose parent is here belongs
    // under it — but two threads naming each other have no parent outside the
    // pair, so neither would ever be a root and both would vanish. Claiming
    // from the roots first says which threads a root can reach; whatever is
    // left is a cycle, and its first thread becomes a root of its own.
    //
    // This is settled before anything paints, because a furled group paints
    // none of its children, and "not painted" must not be mistaken for
    // "nobody owns it".
    const claimed = new Set<string>();
    const claim = (t: Thread) => {
      if (claimed.has(t.id)) return;
      claimed.add(t.id);
      for (const c of kids.get(t.id) ?? []) claim(c);
    };
    const roots: Thread[] = [];
    for (const t of threads) if (!parentOf(t)) { roots.push(t); claim(t); }
    for (const t of threads) if (!claimed.has(t.id)) { roots.push(t); claim(t); }

    // The runs of this project, from every machine in the pool, split the way
    // its threads are: a run whose parent thread has a row here sits under
    // it, and the rest sit under the project. `here` already leaves out the
    // threads the runs themselves claim, so a run can never be filed under
    // one of its own members.
    const ownRuns = new Map<string, { machine: string; run: Run }[]>();
    const projectRunRows: { machine: string; run: Run }[] = [];
    for (const x of g.members) {
      for (const r of runsOf.get(`${x.machine}:${x.projectId}`) ?? []) {
        const parent = r.run.parentThreadId;
        if (parent && here.has(parent)) ownRuns.set(parent, [...(ownRuns.get(parent) ?? []), r]);
        else projectRunRows.push(r);
      }
    }

    // A fold must never bury the thing that needs a person. `needsPerson`
    // says it of one thread; this says it of everything a thread is holding,
    // because a group hides its children whole. A thread that is quietly
    // working, with a blocked run under it or a failed thread under that,
    // would otherwise stay inside its own parent's fold and take the
    // approval with it — the deadlock of #69, one level further out, and
    // invisible rather than merely furled.
    //
    // Each level filters by the same rule, so letting a thread through also
    // lets through the path below it to whatever raised the need.
    const wants = new Map<string, boolean>();
    const wantsPerson = (t: Thread, seen: Set<string> = new Set()): boolean => {
      const memo = wants.get(t.id);
      if (memo !== undefined) return memo;
      // A cycle answers for itself: whatever is in it is reached by the
      // walk that is already running.
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      const v = needsPerson(t)
        || (ownRuns.get(t.id) ?? []).some((r) => runNeedsPerson(s, r.run))
        || (kids.get(t.id) ?? []).some((c) => wantsPerson(c, seen));
      wants.set(t.id, v);
      return v;
    };

    const painted = new Set<string>();
    const pushThread = (t: Thread, depth: number) => {
      // A cycle reached through an unfurled group would otherwise paint for
      // ever. Whichever thread the walk reaches first keeps the row.
      if (painted.has(t.id)) return;
      painted.add(t.id);
      const at = placeOf.get(t.id)!;
      // What this thread holds: the runs it asked for, then the threads it
      // started. A run first, because it is the larger piece of work and it
      // names itself; the loose children follow it.
      const mine = ownRuns.get(t.id) ?? [];
      const children = kids.get(t.id) ?? [];
      const held = mine.length + children.length;
      const open = held > 0 && (s.expanded[threadGroupKey(at.machine, t.id)] ?? false);
      // Furled hides the children that are working. It never hides one that
      // has failed, is blocked on a person, or is holding something that is
      // — see `wantsPerson` and `runNeedsPerson`.
      const shownRuns = open ? mine : mine.filter((r) => runNeedsPerson(s, r.run));
      const shown = open ? children : children.filter((c) => wantsPerson(c));
      const tag = tagOf(at.machine);
      rows.push({
        key: `t:${at.machine}:${t.id}`, kind: "thread", machine: at.machine, projectId: at.projectId, thread: t, depth, groupKey: g.key,
        ...(tag ? { tag } : {}),
        ...(t.origin?.by === "agent" ? { agent: true } : {}),
        ...(held > 0 ? { group: true, hidden: held - shownRuns.length - shown.length } : {}),
      });
      for (const r of shownRuns) pushRun(r.machine, r.run, depth + 1, at.projectId, g.key);
      for (const c of shown) pushThread(c, depth + 1);
    };
    // A run above the threads, for the reason it always was: a run is why the
    // work under it exists, and it is what the operator watches.
    for (const r of projectRunRows) pushRun(r.machine, r.run, 1, g.members.find((x) => x.machine === r.machine)?.projectId, g.key);
    for (const t of roots) pushThread(t, 1);
    // The project's own archived folder, below its live threads and inside
    // its fold: the old threads of this project on every machine, most
    // recently archived first. Moved threads are tombstones, not archive —
    // they stay hidden.
    const archived: { machine: string; projectId: string; t: Thread }[] = [];
    for (const x of g.members) {
      const m = s.machines.get(x.machine)!;
      for (const t of m.threads.values()) if (t.projectId === x.projectId && t.archivedAt && !t.movedTo) archived.push({ machine: x.machine, projectId: x.projectId, t });
    }
    if (archived.length === 0) continue;
    archived.sort((a, b) => b.t.archivedAt!.localeCompare(a.t.archivedAt!));
    const ak = archiveKey(g.key);
    rows.push({ key: `a:${ak}`, kind: "archived", machine: first.machine, projectId: first.projectId, groupKey: g.key, archived: true, count: archived.length, depth: 1 });
    if (!(s.expanded[ak] ?? false)) continue;
    for (const x of archived) {
      const tag = tagOf(x.machine);
      rows.push({ key: `t:${x.machine}:${x.t.id}`, kind: "thread", machine: x.machine, projectId: x.projectId, groupKey: g.key, thread: x.t, archived: true, depth: 2, ...(tag ? { tag } : {}) });
    }
  }
  // The fleet, below the work. A machine row still opens the control panel,
  // and an offline one still says what to press; the section is furled by
  // default because the machines are where the work runs, not what it is.
  rows.push({ key: "machines", kind: "machines", machine: "", depth: 0 });
  if (s.expanded[MACHINES_KEY] ?? false) {
    for (const key of s.order) rows.push({ key: `m:${key}`, kind: "machine", machine: key, depth: 1 });
  }
  return rows;
}

/** The fold key of the machines section. */
export const MACHINES_KEY = "machines";

// ---------------------------------------------------------------------------
// Usage windows and totals
// ---------------------------------------------------------------------------

/**
 * The periods the usage overlay offers. A day starts at the reader's own
 * midnight, so "today" means the day they are looking at, and "last 7 days"
 * covers today and the six days before it.
 */
export const USAGE_WINDOWS: { id: string; label: string; days: number | null }[] = [
  { id: "today", label: "Today", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "all", label: "All time", days: null },
];

/** The window as absolute instants. `null` means no bound. */
export function usageWindow(index: number, now = new Date()): { since: string | null; until: string | null } {
  const w = USAGE_WINDOWS[index] ?? USAGE_WINDOWS[0]!;
  if (w.days === null) return { since: null, until: null };
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (w.days - 1));
  return { since: start.toISOString(), until: null };
}

/** Add machine answers into one figure. */
export function sumUsage(totals: UsageTotals[]): UsageTotals {
  const z: UsageTotals = { turns: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0 };
  for (const t of totals) {
    z.turns += t.turns;
    z.inputTokens += t.inputTokens;
    z.outputTokens += t.outputTokens;
    z.cacheCreationInputTokens += t.cacheCreationInputTokens;
    z.cacheReadInputTokens += t.cacheReadInputTokens;
    z.estimatedCostUsd += t.estimatedCostUsd;
  }
  return z;
}

/**
 * The rows the usage overlay paints: every machine's groups in one list,
 * biggest first, each tagged with the machine it came from. Grouping by
 * machine gives one row per machine, so the tag is dropped there.
 */
export function usageRows(reports: UsageReport[], groupBy: UsageGroupBy): { key: string; label: string; machine: string; total: UsageTotals }[] {
  // A machine row is named after its machine, and a model row is not a
  // machine's at all — both would only repeat themselves with a tag.
  const tagged = groupBy !== "machine" && groupBy !== "model";
  const rows = reports.flatMap((r) => r.groups.map((g) => ({
    key: `${r.machineId}:${g.key}`,
    label: g.label,
    machine: tagged ? r.machineName : "",
    total: g as UsageTotals,
  })));
  // One model runs on several machines, so its rows belong together.
  if (groupBy === "model") {
    const byModel = new Map<string, { key: string; label: string; machine: string; total: UsageTotals }>();
    for (const r of rows) {
      const seen = byModel.get(r.label);
      if (seen) seen.total = sumUsage([seen.total, r.total]);
      else byModel.set(r.label, { ...r, key: r.label });
    }
    return [...byModel.values()].sort((a, b) => b.total.estimatedCostUsd - a.total.estimatedCostUsd);
  }
  return rows.sort((a, b) => b.total.estimatedCostUsd - a.total.estimatedCostUsd);
}

/** Tokens, short enough for a column: 1.2M, 340k, 812. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Always with a `~`: the figure is the SDK's list-price estimate, not a bill. */
export function fmtCost(usd: number): string {
  if (usd === 0) return "~$0";
  if (usd < 0.01) return "~$0.01";
  return `~$${usd < 100 ? usd.toFixed(2) : Math.round(usd)}`;
}
