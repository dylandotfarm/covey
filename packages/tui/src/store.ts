import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { BuildInfo, MachineInfo, Project, Thread, TimelineItem, SavedMachine, ShellEvent, ThreadEvent, ThreadSnapshot, PermissionMode, TurnDiff, Attachment, ProjectGit, WorkspaceMode, MachineUpdate, MachineSource, MachineSettings } from "@covey/protocol";
import { MachineClient, type ConnState } from "./client.js";
import { loadConfig, saveConfig, type TuiConfig } from "./config.js";
import { ViewCache } from "./viewCache.js";

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
    }
  /** `onCancel` lets esc go back where the input came from instead of closing
   *  everything — the folder prompt returns to the directory it was opened on. */
  | { kind: "input"; title: string; placeholder?: string; initial?: string; onSubmit: (v: string) => void; onCancel?: () => void }
  /** Live progress of `machine.update`; closing it leaves the update running. */
  | { kind: "update"; machine: string }
  | { kind: "browse"; machine: string; path: string; entries: DirEntry[]; onPick: (path: string) => void; loading?: boolean };

export interface DirEntry { name: string; isDir: boolean; isRepo: boolean }

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
  pendingAttachments: Map<string, Attachment[]>;
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

  constructor(machines: SavedMachine[], opts: StoreOptions = {}) {
    this.config = loadConfig();
    this.clientSource = opts.source ?? null;
    this.canRelaunch = opts.canRelaunch ?? false;
    this.state = {
      machines: new Map(), order: [], selected: null, view: null, focus: "sidebar",
      sidebarCollapsed: this.config.prefs.sidebarCollapsed ?? false,
      expanded: this.config.prefs.expanded ?? {}, expandedItems: new Set(),
      toolsExpanded: this.config.prefs.toolsExpanded ?? false, overlay: null, notice: null,
      scrollFromBottom: 0, drafts: new Map(), pendingAttachments: new Map(), tick: 0, diffView: null, attention: new Map(),
      selection: null, relaunch: null,
      clientBuild: opts.build ?? null, clientStale: false,
    };
    for (const m of machines) this.addMachine(m, false);
    setInterval(() => this.set({ tick: this.state.tick + 1 }), 700).unref();
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
    for (const l of this.listeners) l();
  }
  private touch() { this.set({}); }

  // ---- machines ------------------------------------------------------------

  addMachine(saved: SavedMachine, persist = true) {
    if (this.clients.has(saved.url)) return;
    const ms: MachineState = { key: saved.url, saved, conn: "connecting", error: null, info: null, projects: new Map(), threads: new Map(), update: null, restarting: false };
    this.state.machines.set(saved.url, ms);
    this.state.order.push(saved.url);
    const client = new MachineClient(saved, {
      state: (s, err) => {
        ms.conn = s; ms.error = err ?? null; ms.info = client.info;
        // A cached seq only means something to the daemon it was read from.
        if (s !== "connected") this.viewCache.dropMachine(ms.key);
        // A restarting daemon cannot report its own success — it is gone by
        // then. Reconnecting is the success, so say so here.
        if (s === "connected" && ms.restarting) {
          ms.restarting = false;
          const at = ms.update?.state === "restarting" ? ms.update.toCommit : null;
          if (ms.update?.state === "restarting") ms.update = { ...ms.update, state: "succeeded", finishedAt: new Date().toISOString() };
          this.notify(`${ms.info?.name ?? ms.saved.name} is back up${at ? ` on ${at}` : ""}`, "success");
        }
        this.touch();
      },
      shellSnapshot: (snap) => {
        ms.info = snap.machine;
        ms.projects = new Map(snap.projects.map((p) => [p.id, p]));
        ms.threads = new Map(snap.threads.map((t) => [t.id, t]));
        if (saved.machineId !== snap.machine.machineId) { saved.machineId = snap.machine.machineId; this.persist(); }
        this.touch();
      },
      shellEvent: (ev) => this.applyShell(ms, ev),
      shellSynchronized: () => this.touch(),
      threadEvent: (threadId, ev) => this.applyThread(saved.url, threadId, ev),
      threadSynchronized: () => this.touch(),
      machineUpdate: (update) => {
        const prev = ms.update;
        ms.update = update;
        if (update.state === "restarting") ms.restarting = true;
        this.noticeUpdate(ms, prev, update);
        this.touch();
      },
    });
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
        break;
      }
      case "thread.removed": ms.threads.delete(ev.threadId); break;
    }
    this.touch();
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
    }
    // A resent snapshot carries each item's own seq, which is older than the
    // subscription's, so take the highest and never go backwards.
    v.seq = Math.max(v.seq, ev.seq);
    this.set({ view: { ...v } });
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
    this.viewCache.put(v.machine, v.threadId, { thread: v.thread, items: v.items, hasMore: v.hasMore, seq: v.seq });
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
      };
      this.set({ selected: sel, view, scrollFromBottom: 0, diffView: null });
      client?.resumeThread(sel.threadId, cached.seq);
      return;
    }

    const view: ThreadView = { machine: sel.machine, threadId: sel.threadId, thread: ms?.threads.get(sel.threadId) ?? null, items: new Map(), loading: true, error: null, hasMore: false, loadingOlder: false, seq: 0 };
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
  addAttachments(threadId: string, atts: Attachment[]) {
    if (atts.length === 0) return;
    this.state.pendingAttachments.set(threadId, [...this.attachments(threadId), ...atts]);
    this.touch();
  }
  removeLastAttachment(threadId: string) {
    const cur = this.attachments(threadId);
    if (cur.length === 0) return false;
    this.state.pendingAttachments.set(threadId, cur.slice(0, -1));
    this.touch();
    return true;
  }
  clearAttachments(threadId: string) {
    if (this.state.pendingAttachments.delete(threadId)) this.touch();
  }

  // ---- selection -----------------------------------------------------------

  beginSelection(pane: Selection["pane"], line: number, col: number) {
    this.set({ selection: { pane, anchor: { line, col }, head: { line, col }, dragging: true } });
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

  notify(text: string, tone: Notice["tone"] = "info") {
    this.set({ notice: { text, tone, at: Date.now() } });
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), tone === "error" ? 8000 : 4000);
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

  // ---- actions -------------------------------------------------------------

  async createThread(machine: string, projectId: string, opts: { workspaceMode?: WorkspaceMode } = {}) {
    const client = this.clients.get(machine);
    if (!client) return;
    const threadId = randomUUID();
    const sessionId = randomUUID();
    try {
      // A machine-wide default is the daemon's to apply: sending the client's
      // last-used mode here would silently override what the control panel says.
      const machineMode = this.state.machines.get(machine)?.info?.settings?.defaultPermissionMode ?? null;
      const mode = machineMode ? undefined : this.defaultPermissionMode;
      await client.command({ type: "thread.create", projectId, threadId, sessionId, ...(mode ? { permissionMode: mode } : {}), ...opts });
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

  /** Remember (or forget, with null) where new threads in a project run. */
  async setProjectWorkspaceMode(machine: string, projectId: string, mode: WorkspaceMode | null) {
    await this.threadCommand({ type: "project.update", projectId, defaultWorkspaceMode: mode }, machine);
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
      this.notify(`${who}: restarting the daemon…`);
    } catch (e: any) {
      // The daemon may drop the socket before the reply lands; that is the
      // restart happening, not a failure.
      if (e.message === "disconnected") { if (ms) ms.restarting = true; this.notify(`${who}: restarting the daemon…`); }
      else this.notify(this.machineError(machine, e), "error");
    }
  }

  async sendTurn(text: string) {
    const v = this.state.view;
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    const attachments = this.attachments(v.threadId);
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

  async respondQuestion(answer: string) {
    const v = this.state.view; const it = this.pendingRequest();
    const client = v && this.clients.get(v.machine);
    if (!v || !client || !it || it.kind !== "question") return;
    await client.command({ type: "question.respond", threadId: v.threadId, requestId: it.requestId, answer }).catch((e) => this.notify(e.message, "error"));
  }

  async threadCommand(cmd: Parameters<MachineClient["command"]>[0], machine?: string) {
    const key = machine ?? this.state.selected?.machine;
    const client = key && this.clients.get(key);
    if (!client) return;
    await client.command(cmd).catch((e) => this.notify(e.message, "error"));
  }

  /** Move the selected thread to another machine + project. */
  async moveThread(from: { machine: string; threadId: string }, to: { machine: string; projectId?: string; workspaceRoot?: string }) {
    const src = this.clients.get(from.machine); const dst = this.clients.get(to.machine);
    const dstInfo = this.state.machines.get(to.machine)?.info;
    if (!src || !dst || !dstInfo) { this.notify("both machines must be connected", "error"); return; }
    try {
      this.notify("exporting thread…");
      const exp = await src.rpc("thread.export", { threadId: from.threadId });
      this.notify(`importing on ${dstInfo.name}…`);
      const r = await dst.rpc("thread.import", { export: exp, projectId: to.projectId, workspaceRoot: to.workspaceRoot });
      await src.rpc("thread.markMoved", { threadId: from.threadId, machineId: dstInfo.machineId, newThreadId: r.threadId });
      this.notify(`moved to ${dstInfo.name}`, "success");
      await this.select({ machine: to.machine, threadId: r.threadId });
    } catch (e: any) { this.notify(`move failed: ${e.message}`, "error"); }
  }

  async browse(machine: string, path: string, onPick: (p: string) => void) {
    const client = this.clients.get(machine);
    if (!client) return;
    this.setOverlay({ kind: "browse", machine, path, entries: [], onPick, loading: true });
    try {
      const r = await client.rpc("fs.listDir", { path });
      this.setOverlay({ kind: "browse", machine, path: r.path, entries: r.entries, onPick });
    } catch (e: any) { this.notify(e.message, "error"); this.setOverlay(null); }
  }

  /**
   * Make a folder while browsing, so a project can be started somewhere that
   * does not exist yet. On success the browser steps *into* the new folder —
   * the place the project would go — rather than picking it, so nested folders
   * can be made in turn. A refused name leaves the overlay where it was, so the
   * error is read without losing the directory that was being browsed.
   */
  async mkdir(machine: string, parent: string, name: string, onPick: (p: string) => void) {
    const client = this.clients.get(machine);
    if (!client) return;
    try {
      const r = await client.rpc("fs.mkdir", { path: parent, name });
      await this.browse(machine, r.path, onPick);
      this.notify(`created ${r.path}`, "success");
    } catch (e: any) { this.notify(e.message, "error"); }
  }

  shutdown() {
    this.stopWatchingBuild();
    if (this.noticeTimer) { clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    for (const c of this.clients.values()) c.stop();
  }
}

// ---- derived helpers --------------------------------------------------------

/**
 * A row in the directory browser. `..` and "new folder" are rows like any
 * other, so the cursor, the painter and the key handler count one list — the
 * same reason the sidebar builds its lines in a single place.
 */
export type BrowseRow =
  | { kind: "up" }
  | { kind: "dir"; name: string; isRepo: boolean }
  /** `name` is the filter text when that could name a folder, else "" — then
   *  choosing the row asks for a name instead of creating one. */
  | { kind: "new"; name: string };

/**
 * The browser's rows for a listing and a filter. "New folder" comes last so
 * that typing to narrow and pressing enter still opens a directory; it is only
 * what the cursor starts on once the filter matches nothing.
 */
export function browseRows(entries: DirEntry[], filter: string): BrowseRow[] {
  const f = filter.trim().toLowerCase();
  const rows: BrowseRow[] = [];
  if (!f || "..".includes(f)) rows.push({ kind: "up" });
  for (const e of entries) if (!f || e.name.toLowerCase().includes(f)) rows.push({ kind: "dir", name: e.name, isRepo: e.isRepo });
  rows.push({ kind: "new", name: isFolderName(filter.trim()) ? filter.trim() : "" });
  return rows;
}

/** Mirrors the daemon's rule for `fs.mkdir`, so the row only offers to create
 *  what the daemon would accept. The daemon still checks; this is for the UI. */
export function isFolderName(s: string): boolean {
  return s.length > 0 && !s.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === "..");
}

/** The parent of a browsed directory, or the directory itself at the root. */
export function parentPath(path: string): string {
  return path.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/";
}

/**
 * The "where should this thread run?" choices for a repo. Always the same three
 * rows in the same order (so the answer can be remembered without ambiguity),
 * minus the default-branch row when the repo has no default branch to fork.
 */
export function workspaceOptions(git: ProjectGit): PickOption[] {
  const head = git.currentBranch ? ` (${git.currentBranch})` : "";
  const opts: PickOption[] = [];
  if (git.defaultBranch) opts.push({ id: "worktree-default", label: `Worktree from ${git.defaultBranch}`, hint: "clean start" });
  opts.push({ id: "worktree-head", label: `Worktree from HEAD${head}`, hint: "branch off what is checked out" });
  opts.push({ id: "checkout", label: `This checkout${head}`, hint: "shared with other threads" });
  return opts;
}

/** Short label for a remembered workspace mode, for menus. */
export function workspaceModeLabel(mode: WorkspaceMode | null | undefined): string {
  switch (mode) {
    case "worktree-default": return "worktree from the default branch";
    case "worktree-head": return "worktree from HEAD";
    case "checkout": return "the project checkout";
    default: return "ask every time";
  }
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
  kind: "machine" | "project" | "thread" | "empty" | "archived";
  machine: string;
  projectId?: string;
  thread?: Thread;
  project?: Project;
  /** Set on the archived folder and on every thread row inside it. */
  archived?: boolean;
  /** How many threads the archived folder holds. */
  count?: number;
  depth: number;
}

/** `expanded` key for a project's archived folder. Furled unless toggled. */
export function archiveKey(machine: string, projectId: string): string { return `${machine}:${projectId}:archived`; }

export function sidebarRows(s: AppState): SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const key of s.order) {
    const m = s.machines.get(key)!;
    rows.push({ key: `m:${key}`, kind: "machine", machine: key, depth: 0 });
    const projects = [...m.projects.values()].sort((a, b) => a.title.localeCompare(b.title));
    if (projects.length === 0 && m.conn === "connected") rows.push({ key: `e:${key}`, kind: "empty", machine: key, depth: 1 });
    for (const p of projects) {
      const pk = `${key}:${p.id}`;
      rows.push({ key: `p:${pk}`, kind: "project", machine: key, projectId: p.id, project: p, depth: 1 });
      if (!(s.expanded[pk] ?? true)) continue;
      const threads = liveThreads(m, p.id).sort(byRecency);
      for (const t of threads) rows.push({ key: `t:${key}:${t.id}`, kind: "thread", machine: key, projectId: p.id, thread: t, depth: 2 });
      // The project's own archived folder, below its live threads and inside
      // its fold: the old threads of this project, most recently archived
      // first. Moved threads are tombstones, not archive — they stay hidden.
      const archived = [...m.threads.values()]
        .filter((t) => t.projectId === p.id && t.archivedAt && !t.movedTo)
        .sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
      if (archived.length === 0) continue;
      const ak = archiveKey(key, p.id);
      rows.push({ key: `a:${ak}`, kind: "archived", machine: key, projectId: p.id, archived: true, count: archived.length, depth: 2 });
      if (!(s.expanded[ak] ?? false)) continue;
      for (const t of archived) rows.push({ key: `t:${key}:${t.id}`, kind: "thread", machine: key, projectId: p.id, thread: t, archived: true, depth: 3 });
    }
  }
  return rows;
}
