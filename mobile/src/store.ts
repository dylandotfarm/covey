/**
 * What the app knows, and how a daemon's events change it (issue #168).
 *
 * This is `packages/web/src/main.ts` with the navigation taken out. The state,
 * the fold and every rule about them are `@covey/web`'s `State` — the same
 * object the page keeps, applied by the same functions — because the fold is the
 * part that must not be written twice. What differs is where the reader is:
 *
 *  - the page reads `location.hash` and the app asks React Navigation, so this
 *    file holds no routing at all. A screen says "show me this thread" and the
 *    navigator decides what back means;
 *  - the page has an origin to dial before it runs a line. The app has none, so
 *    it starts from the machines a person added (`machines.ts`) and learns the
 *    rest from `machine.access`, exactly as the page does.
 *
 * The paint discipline is the page's, and it matters more here. A daemon in the
 * middle of a turn re-sends an item every few tens of milliseconds, and a phone
 * has one thread for the paint and the keyboard. So nothing notifies React per
 * event: `schedule()` coalesces every change into one notify per frame, and
 * `useSyncExternalStore` hands that to the components.
 *
 * The composer is the one thing deliberately outside all of this. A draft lives
 * in the component while it is being typed and is written back without a notify,
 * because a re-render per keystroke is what the frame budget cannot afford —
 * the same reason `setDraft` on the page repaints only when a chip appears or
 * goes.
 */
import { AppState } from "react-native";
import { applyDrop, coveyCommand, MachineClient, uuid, type TaggedAttachment } from "@covey/client";
import {
  APP_CLIENT, asLod, DEFAULT_LOD, type ApprovalItem, type FleetMember, type GitHubAction, type Lod, type QuestionItem,
} from "@covey/protocol";
import {
  addMachine, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, composerKey, emptyState,
  openView, pendingAttachments, pendingBytes, primaryMachine, sendableAttachments, setPendingAttachments,
  syncAttachments, type MachineSlot, type SheetTarget, type State,
} from "@covey/web";
import { attachingLabel, readPicked, sendingLabel, type PickedFile } from "@covey/web/attach";
import { forgetMachine, readLod, readMachines, readShowHidden, readToken, saveLod, saveMachine, saveShowHidden, type SavedMachine } from "./machines";
import { shrinkOnDevice } from "./attach";
import { primeUpdateToken } from "./ota";
import { sheetCommand } from "./sheet";

/** How long a notice stays on screen before it goes, in milliseconds. */
const NOTICE_MS = 4000;

class Store {
  readonly state: State = emptyState();
  private readonly clients = new Map<string, MachineClient>();
  private readonly listeners = new Set<() => void>();
  /** Bumped once per frame that changed something. `useSyncExternalStore` reads it. */
  private version = 0;
  private frame: ReturnType<typeof requestAnimationFrame> | null = null;
  /** The machines a person added, so the settings screen can list and forget them. */
  saved: SavedMachine[] = [];
  /** What went wrong, for a line at the top of the screen. */
  notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the saved machines have been read, so a first launch can say so. */
  loaded = false;

  // ---- what React subscribes to ------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /**
   * One notify per frame, however many events arrived.
   *
   * Never call the listeners directly from a daemon callback. A turn sends
   * hundreds of events a second and every one of them would be a render.
   */
  schedule = (): void => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.version++;
      for (const fn of this.listeners) fn();
    });
  };

  /** Say what went wrong, where every other failure on this screen says it. */
  fail = (e: unknown): void => {
    this.notice = e instanceof Error ? e.message : String(e);
    this.schedule();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const said = this.notice;
    this.noticeTimer = setTimeout(() => {
      if (this.notice === said) { this.notice = null; this.schedule(); }
    }, NOTICE_MS);
  };

  clearNotice = (): void => { this.notice = null; this.schedule(); };

  // ---- starting up --------------------------------------------------------

  /**
   * Read what this device remembers and dial it.
   *
   * Called once, from the root component. A machine with no token is dialled
   * too: the daemon may be on this tailnet, and `whois` is credential enough.
   */
  start = async (): Promise<void> => {
    // `asLod` refuses anything it does not know, which includes the `ultra` a
    // build between #172 and this one could have stored. It falls back to the
    // default, which is what a reader of that build now wants anyway: the small
    // view is decided by the screen and is no longer a preference.
    this.state.lod = asLod(await readLod()) ?? DEFAULT_LOD;
    this.state.showHidden = await readShowHidden();
    this.saved = await readMachines();
    for (const [i, m] of this.saved.entries()) {
      const token = await readToken(m.url);
      // The first machine is the primary: it is the one asked for the fleet.
      // The page's primary is whichever served it; here it is whichever the
      // reader added first, and nothing else turns on the choice.
      this.dial(addMachine(this.state, m.url, m.name, i === 0, token), token);
    }
    this.loaded = true;
    this.schedule();
    // A phone that slept dropped its sockets, and each client has a budget of
    // dials it may have spent. The reader coming back is the reason to spend
    // more — the page watches `visibilitychange` for the same thing.
    AppState.addEventListener("change", (s) => { if (s === "active") this.retry(); });
  };

  /** Dial one machine and bind its events to its slot. */
  private dial(slot: MachineSlot, token: string | undefined): void {
    const client = new MachineClient({ name: slot.name, url: slot.key, token }, {
      state: (s, err) => {
        slot.conn = s;
        slot.connError = err ?? null;
        this.schedule();
        // Every machine a *person* added is asked for the fleet, not only the
        // first one. The page asks the daemon that served it, which by
        // definition answered; here the first machine in the list may be a
        // laptop that is shut, and asking only that one would mean a reader
        // with two machines saw the fleet of neither.
        //
        // A fleet member is not asked: it came from a fleet list already, and
        // the machines it would name are the ones this daemon just named.
        if (s === "connected" && this.saved.some((x) => x.url === slot.key)) this.askAccess(client, slot.primary);
      },
      shellSnapshot: (snap) => { applyShellSnapshot(slot, snap); this.schedule(); },
      shellEvent: (ev) => { applyShellEvent(this.state, slot, ev); this.schedule(); },
      shellSynchronized: () => this.schedule(),
      threadEvent: (threadId, ev) => { if (applyThreadEvent(this.state, slot.key, threadId, ev)) this.schedule(); },
      threadSynchronized: () => this.schedule(),
      machineUpdate: (update) => {
        slot.update = update;
        // The drop that follows is the update working: give the client the long
        // budget, so the reconnect that reports success can happen.
        if (update.state === "restarting") client.expectRestart();
        this.schedule();
      },
    }, { clientName: APP_CLIENT });
    this.clients.set(slot.key, client);
    client.start();
  }

  /**
   * A daemon's token, its other addresses, and the fleet it knows.
   *
   * Only the TUI sends a fleet list, and it sends it to one machine, so most
   * daemons answer with none. Every answer's members are dialled; `state.access`
   * — which is only the list of addresses a reader can copy — is kept from the
   * primary, or from whoever answered first if the primary never does.
   */
  private askAccess(client: MachineClient, primary: boolean): void {
    client.rpc("machine.access", {}).then((a) => {
      if (primary || !this.state.access) this.state.access = a;
      for (const m of a.fleet ?? []) this.dialMember(m);
      this.schedule();
    }).catch(() => {});
  }

  /**
   * Dial a machine the primary named, unless it is the primary or already
   * dialled. A fleet member is never saved: the TUI owns that list and a copy
   * here would go stale.
   */
  private dialMember(m: FleetMember): void {
    const primary = primaryMachine(this.state);
    if (m.machineId && primary?.info?.machineId === m.machineId) return;
    let key: string;
    try { key = new URL(m.url).toString().replace(/\/$/, ""); } catch { return; }
    if (this.state.machines.has(key)) return;
    this.dial(addMachine(this.state, key, m.name, false, m.token), m.token);
  }

  // ---- machines a person added -------------------------------------------

  /** Add a machine and dial it at once, so the reader sees it connect. */
  addMachine = async (m: SavedMachine, token: string | undefined): Promise<void> => {
    await saveMachine(m, token);
    this.saved = await readMachines();
    if (!this.state.machines.has(m.url)) {
      const first = this.state.machines.size === 0;
      this.dial(addMachine(this.state, m.url, m.name, first, token), token);
    }
    // The update route takes the same token, and the machine that serves
    // bundles may be the one just added.
    await primeUpdateToken();
    this.schedule();
  };

  /** Forget a machine, its token, and the connection to it. */
  forget = async (url: string): Promise<void> => {
    const client = this.clients.get(url);
    client?.stop();
    this.clients.delete(url);
    this.state.machines.delete(url);
    if (this.state.view?.machine === url) this.state.view = null;
    if (this.state.item?.machine === url) this.state.item = null;
    await forgetMachine(url);
    this.saved = await readMachines();
    this.schedule();
  };

  retry = (): void => {
    for (const c of this.clients.values()) if (c.state === "offline" || c.state === "error") c.retry();
    this.schedule();
  };

  client = (machine: string): MachineClient | undefined => this.clients.get(machine);

  // ---- the thread on screen ----------------------------------------------

  /** Put a thread on screen. A screen calls this when it is focused. */
  showThread = (machine: string, threadId: string): void => {
    const client = this.clients.get(machine);
    if (!client) return;
    if (this.state.view?.machine === machine && this.state.view.threadId === threadId) return;
    if (this.state.view) void this.clients.get(this.state.view.machine)?.unwatchThread();
    const v = openView(this.state, machine, threadId);
    this.schedule();
    client.watchThread(threadId).then((snap) => {
      if (this.state.view !== v) return; // the reader moved on
      applyThreadSnapshot(v, snap);
      this.schedule();
    }).catch((e: Error) => {
      if (this.state.view === v) { v.loading = false; v.error = e.message; this.schedule(); }
    });
  };

  /** Take the thread off the screen, and its subscription with it. */
  leaveThread = (): void => {
    if (!this.state.view) return;
    void this.clients.get(this.state.view.machine)?.unwatchThread();
    this.state.view = null;
    this.schedule();
  };

  /**
   * Put an issue or a pull request on screen (#108).
   *
   * The thread under it keeps its subscription: the item is a look aside, and
   * the return must cost nothing.
   */
  showItem = (machine: string, projectId: string, number: number): void => {
    const iv = this.state.item;
    if (iv && iv.machine === machine && iv.projectId === projectId && iv.number === number) return;
    this.state.item = { machine, projectId, number, item: null, loading: true, error: null, busy: false, draft: "" };
    this.schedule();
    this.loadItem();
  };

  clearItem = (): void => { this.state.item = null; this.schedule(); };

  /** Read the item on screen from its daemon. */
  loadItem = (): void => {
    const iv = this.state.item;
    const client = iv && this.clients.get(iv.machine);
    if (!iv || !client) return;
    iv.loading = true;
    this.schedule();
    client.rpc("github.item", { projectId: iv.projectId, number: iv.number }).then((item) => {
      if (this.state.item !== iv) return; // the reader moved on
      iv.item = item; iv.loading = false; iv.error = null;
      this.schedule();
    }).catch((e: Error) => {
      if (this.state.item === iv) { iv.loading = false; iv.error = e.message; this.schedule(); }
    });
  };

  actItem = (action: GitHubAction): void => {
    const iv = this.state.item;
    const client = iv && this.clients.get(iv.machine);
    if (!iv || !client || iv.busy) return;
    iv.busy = true; iv.error = null;
    this.schedule();
    client.rpc("github.act", { projectId: iv.projectId, number: iv.number, action }).then((item) => {
      if (this.state.item !== iv) return;
      iv.item = item; iv.busy = false; iv.draft = "";
      this.schedule();
    }).catch((e: Error) => {
      if (this.state.item === iv) { iv.busy = false; iv.error = e.message; this.schedule(); }
    });
  };

  setItemDraft = (text: string): void => { if (this.state.item) this.state.item.draft = text; };

  // ---- the composer ------------------------------------------------------

  draft = (machine: string, threadId: string): string => this.state.drafts.get(composerKey(machine, threadId)) ?? "";

  /**
   * Keep a draft without a render.
   *
   * No notify unless the number of chips changed: a render per keystroke is what
   * the frame budget cannot afford, and deleting the word that stands for a file
   * is what drops the file.
   */
  setDraft = (machine: string, threadId: string, text: string): void => {
    this.state.drafts.set(composerKey(machine, threadId), text);
    const before = pendingAttachments(this.state, machine, threadId).length;
    if (syncAttachments(this.state, machine, threadId, text).length !== before) this.schedule();
  };

  attachments = (machine: string, threadId: string): TaggedAttachment[] =>
    pendingAttachments(this.state, machine, threadId);

  send = (text: string): void => {
    const v = this.state.view;
    if (!v) return;
    const { machine, threadId } = v;
    // A covey command is the app's own work and never reaches the agent (#16).
    // There is no `/` menu on this screen yet, so the command is typed whole.
    const own = coveyCommand(text);
    if (own) {
      if (own.name !== "clear") { this.fail(new Error(`/${own.name} is not a command covey answers`)); return; }
      // The draft and its chips go only once the daemon has taken the command,
      // as they do in the TUI: `thread.clear` is refused under a running turn,
      // and a reader must not lose the files they picked to a refusal.
      this.clients.get(machine)?.command({ type: "thread.clear", threadId }).then(() => {
        this.state.drafts.delete(composerKey(machine, threadId));
        setPendingAttachments(this.state, machine, threadId, []);
        this.schedule();
      }).catch(this.fail);
      return;
    }
    // The tag in the text is the file. Whatever lost its tag does not go.
    const attachments = sendableAttachments(syncAttachments(this.state, machine, threadId, text));
    this.state.drafts.delete(composerKey(machine, threadId));
    setPendingAttachments(this.state, machine, threadId, []);
    const bytes = pendingBytes(attachments);
    // A phone on a mobile link takes seconds over a photograph, and the socket
    // says nothing meanwhile, so the composer holds the line until the daemon
    // acknowledges the command.
    if (bytes > 0) this.state.attaching = sendingLabel(bytes);
    this.schedule();
    this.clients.get(machine)?.command({
      type: "turn.send", threadId, turnId: uuid(), text,
      ...(attachments.length ? { attachments } : {}),
    })
      .catch(this.fail)
      .finally(() => { if (bytes > 0) { this.state.attaching = null; this.schedule(); } });
  };

  /**
   * Read the files the reader picked and put a tag for each into the draft.
   *
   * Returns the tags that are new, so the composer can put them where the caret
   * is. The reading is `readPicked`, which both clients share.
   */
  attachFiles = async (files: PickedFile[], draft: string): Promise<string[] | null> => {
    const v = this.state.view;
    if (!v) return null;
    const { machine, threadId } = v;
    const held = pendingAttachments(this.state, machine, threadId);
    this.state.attaching = attachingLabel(files);
    this.schedule();
    let read;
    try {
      read = await readPicked(files, shrinkOnDevice, pendingBytes(held));
    } finally {
      this.state.attaching = null;
      this.schedule();
    }
    // The reader may have left the thread while a photograph was scaling.
    if (this.state.view?.machine !== machine || this.state.view.threadId !== threadId) return null;
    // A file that did not attach, and one that attached but not the way the
    // reader meant, each say so where every other failure says it (#132).
    for (const w of read.warnings) this.fail(new Error(w));
    for (const f of read.failed) this.fail(new Error(f.message));
    if (read.attachments.length === 0 && read.failed.length === 0) return null;
    const drop = applyDrop(draft, draft.length, read.attachments, held, read.failed);
    setPendingAttachments(this.state, machine, threadId, drop.attachments);
    this.schedule();
    const before = new Set(held.map((a) => a.tag));
    return [...new Set(drop.attachments.map((a) => a.tag))].filter((t) => !before.has(t));
  };

  interrupt = (): void => {
    const v = this.state.view;
    if (v) this.clients.get(v.machine)?.command({ type: "turn.interrupt", threadId: v.threadId }).catch(this.fail);
  };

  respondApproval = (item: ApprovalItem, behavior: "allow" | "deny", always: boolean): void => {
    this.viewClient()?.command({
      type: "approval.respond", threadId: item.threadId, requestId: item.requestId, behavior,
      ...(always ? { updatedPermissions: item.suggestions } : {}),
    }).catch(this.fail);
  };

  respondQuestion = (item: QuestionItem, answers: string[]): void => {
    this.viewClient()?.command({
      type: "question.respond", threadId: item.threadId, requestId: item.requestId,
      answer: answers[0] ?? "", answers,
    }).catch(this.fail);
  };

  // ---- the list ----------------------------------------------------------

  newThread = (machine: string, projectId: string): string => {
    this.state.choosing = null;
    const threadId = uuid();
    this.clients.get(machine)?.command({ type: "thread.create", projectId, threadId, sessionId: uuid() })
      .catch(this.fail);
    return threadId;
  };

  chooseMachine = (rowKey: string): void => {
    this.state.choosing = this.state.choosing === rowKey ? null : rowKey;
    this.schedule();
  };

  toggleFold = (rowKey: string): void => {
    if (this.state.folded.has(rowKey)) this.state.folded.delete(rowKey);
    else this.state.folded.add(rowKey);
    this.schedule();
  };

  // ---- the transcript's detail (#149) ------------------------------------

  toggleRow = (key: string): void => {
    const next = new Set(this.state.toggledRows);
    if (next.has(key)) next.delete(key); else next.add(key);
    this.state.toggledRows = next;
    this.schedule();
  };

  /**
   * Whether this device paints the threads covey hides: its own reviewers.
   *
   * A preference of the device, like the level of detail. `projectRows` reads
   * it, so the switch takes the rows and the counts above them together.
   */
  setShowHidden = (on: boolean): void => {
    this.state.showHidden = on;
    void saveShowHidden(on);
    this.schedule();
  };

  /** The level of detail this device reads a transcript at (#149). */
  setLod = (lod: Lod): void => {
    this.state.lod = lod;
    // The taps go with it: each was an answer to the level it was made at, and
    // at the new one half of them would mean the opposite.
    this.state.toggledRows = new Set();
    void saveLod(lod);
    this.schedule();
  };

  // ---- machines and settings ---------------------------------------------

  updateMachine = (machine: string): void => {
    const slot = this.state.machines.get(machine);
    const client = this.clients.get(machine);
    if (!slot || !client) return;
    client.rpc("machine.update", { restart: true })
      .then((u) => { slot.update = u; this.schedule(); })
      .catch(this.fail);
  };

  restartMachine = (machine: string): void => {
    const client = this.clients.get(machine);
    if (!client) return;
    client.expectRestart();
    client.rpc("machine.restart", {}).catch(this.fail);
  };

  archiveThread = (machine: string, threadId: string): void => {
    this.clients.get(machine)?.command({ type: "thread.archive", threadId, archived: true }).catch(this.fail);
  };

  renameThread = (machine: string, threadId: string, title: string): void => {
    this.clients.get(machine)?.command({ type: "thread.rename", threadId, title }).catch(this.fail);
  };

  /** How many turns are running on a machine, for a warning before a restart. */
  busyThreads = (machine: string): number => {
    const slot = this.state.machines.get(machine);
    if (!slot) return 0;
    return [...slot.threads.values()].filter((t) => t.status === "running" || t.status === "starting").length;
  };

  // ---- the settings sheet ------------------------------------------------

  openSheet = (target: SheetTarget): void => { this.state.sheet = { target, page: "" }; this.schedule(); };
  closeSheet = (): void => { this.state.sheet = null; this.schedule(); };
  sheetPage = (page: string): void => { if (this.state.sheet) { this.state.sheet.page = page; this.schedule(); } };

  /**
   * One choice on a sheet, as the command it stands for.
   *
   * The same mapping `main.ts` does on the page, and the two must stay in step:
   * a model of `""` clears the setting, and the thread or the machine falls back
   * to what the user's own Claude configuration says.
   */
  sheetChoose = (target: SheetTarget, page: string, id: string): void => {
    const client = this.clients.get(target.machine);
    if (!client) return;
    const cmd = sheetCommand(target, page, id);
    if (!cmd) return;
    this.state.sheet = null;
    this.schedule();
    client.command(cmd).catch(this.fail);
  };

  private viewClient(): MachineClient | undefined {
    return this.state.view ? this.clients.get(this.state.view.machine) : undefined;
  }
}

export const store = new Store();
