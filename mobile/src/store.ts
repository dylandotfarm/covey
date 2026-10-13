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
  APP_CLIENT, asLod, DEFAULT_LOD, type ApprovalItem, type GitHubAction, type Lod, type MachineInfo,
  type PeerMachine, type QuestionItem, type Thread,
} from "@covey/protocol";
import {
  addMachine, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, composerKey, emptyState,
  openView, pendingAttachments, pendingBytes, primaryMachine, sendableAttachments, setPendingAttachments,
  syncAttachments, type MachineSlot, type SheetTarget, type State, type View,
} from "@covey/web";
import { attachingLabel, readPicked, sendingLabel, type PickedFile } from "@covey/web/attach";
import { forgetMachine, readLod, readMachines, readNotifyWanted, readShowHidden, readTalk, readToken, saveLod, saveMachine, saveNotifyWanted, saveShowHidden, saveTalk, type SavedMachine } from "./machines";
import { asTalk, DEFAULT_TALK, type TalkMode } from "./talk";
import { shrinkOnDevice } from "./attach";
import { primeUpdateToken } from "./ota";
import { sheetCommand } from "./sheet";
import { noteFor, noteId } from "./notes";
import { askNotes, dismissNote, notesAvailable, notesGranted, postNote, startNotes } from "./notify";
import { holdLinkService, releaseLinkService } from "../modules/covey-link";

/** How long a notice stays on screen before it goes, in milliseconds. */
const NOTICE_MS = 4000;

/**
 * How long the app waits for a thread the daemon is making.
 *
 * `thread.create` fetches and adds a worktree, which on a large repository over
 * a slow link outlasts the client's own one-minute default. Here a timeout
 * costs more than a notice: `whenMade` opens its gate when the create settles,
 * so a wait that gives up early puts the subscription back in front of the
 * worktree, which is the failure this gate exists to prevent. The TUI gives a
 * call that may clone ten minutes; this is that budget, and the daemon's.
 */
const CREATE_WAIT_MS = 10 * 60_000 + 10_000;

class Store {
  readonly state: State = emptyState();
  private readonly clients = new Map<string, MachineClient>();
  /**
   * The threads this app has asked for and the daemon has not yet made.
   *
   * Keyed by machine and thread, as a draft is. `whenMade` is what reads it,
   * and the reason is there.
   */
  private readonly creating = new Map<string, Promise<unknown>>();
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
  /**
   * Which push-to-talk button this device holds, from the button to the volume
   * keys (`src/talk.ts`).
   *
   * Here and not on `State`: the page has no hardware keys and no composer
   * button, so this is the app's own preference and nothing in `@covey/web`
   * would ever read it.
   */
  talk: TalkMode = DEFAULT_TALK;
  /**
   * Whether this device asked to be told when a thread needs the reader.
   *
   * Here and not on `State` for the same reason `talk` is: the page cannot
   * notify anybody, so nothing in `@covey/web` would ever read it.
   */
  notify = false;
  /** False when Android is refusing to show them, which the switch must say. */
  notesAllowed = notesAvailable;
  /**
   * True while the app is the screen in front of the reader.
   *
   * A notification about the conversation they are reading is noise, and a
   * conversation left open behind a locked screen is one nobody is reading —
   * so this is half of that decision and `notes.ts` holds the rest.
   */
  private active = true;
  /**
   * The thread each conversation was in when covey last read it for news.
   *
   * Its own map, rather than `slot.threads`, because that one is written by two
   * streams: a thread's own subscription applies `thread.updated` to it as well
   * (`applyThreadEvent`). For the conversation the reader has open — the one
   * case where both streams carry the same change — whichever arrived first
   * would leave the two sides of the comparison identical, and the news would
   * be lost. That is the case that matters most, too: a thread left open behind
   * a locked screen is exactly the one a reader wants to hear about.
   */
  private readonly seen = new Map<string, Thread>();
  /**
   * The view a snapshot is in flight for, so the retry below cannot ask twice.
   */
  private watching: View | null = null;

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
    this.talk = asTalk(await readTalk()) ?? DEFAULT_TALK;
    this.notify = await readNotifyWanted();
    // The channel and the handler are made whatever the switch says, because
    // the reader may turn it on later and a channel cannot be made in the
    // moment there is something to say. The permission is only read.
    this.settleNotes(await startNotes());
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
    // Every machine this device has is now dialled, so a conversation opened
    // before any of them were can be told that its own is not among them.
    this.watchView();
    // A phone that slept dropped its sockets, and each client has a budget of
    // dials it may have spent. The reader coming back is the reason to spend
    // more — the page watches `visibilitychange` for the same thing.
    AppState.addEventListener("change", (s) => {
      this.active = s === "active";
      if (s !== "active") return;
      this.retry();
      // Read again rather than once at launch: the permission can be taken
      // away in Android's own settings while covey is in the background, and a
      // switch that still read as on would promise something nothing shows.
      if (this.notify) void notesGranted().then(this.settleNotes);
    });
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
        // A conversation opened before this machine answered — the tap that
        // launched the app, or the device's pick — is still waiting for it.
        if (s === "connected") this.watchView();
      },
      shellSnapshot: (snap) => {
        applyShellSnapshot(slot, snap);
        // Nothing in a snapshot is news. It is every thread the machine has, so
        // a first connection or a reconnect after a sleep would otherwise
        // announce an hour of history the list already shows. Seeding the
        // record is what makes that silence a rule rather than an accident.
        for (const t of snap.threads) this.seen.set(composerKey(slot.key, t.id), t);
        this.schedule();
      },
      shellEvent: (ev) => {
        applyShellEvent(this.state, slot, ev);
        if (ev.kind === "thread.upserted") this.tell(slot, ev.thread);
        if (ev.kind === "thread.removed") this.seen.delete(composerKey(slot.key, ev.threadId));
        this.schedule();
      },
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
      // A build of the app this machine serves at `/apk` (#185). Nothing
      // restarts at the end of one, so the socket is not expected to drop.
      machineAppBuild: (run) => { slot.appBuild = run; this.schedule(); },
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
      // `a.fleet` is the name this list had before fleets took the word. The
      // phone is the one client that is not in step with the daemon it dials:
      // its bundle comes over the air from one machine and the primary daemon
      // is very often another, so a new bundle meets an old daemon and must
      // not drop every machine but one.
      for (const m of a.peers ?? a.fleet ?? []) this.dialMember(m);
      this.schedule();
    }).catch(() => {});
  }

  /**
   * Dial a machine the primary named, unless it is the primary or already
   * dialled. A fleet member is never saved: the TUI owns that list and a copy
   * here would go stale.
   */
  private dialMember(m: PeerMachine): void {
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
    // The news this machine's threads were measured against goes with it, or a
    // machine added again would have an old thread to compare its first event to.
    for (const key of [...this.seen.keys()]) if (key.startsWith(`${url}:`)) this.seen.delete(key);
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

  /** What a machine said about itself, for a caller that needs a capability. */
  machineInfo = (machine: string): MachineInfo | undefined => this.state.machines.get(machine)?.info ?? undefined;

  // ---- the thread on screen ----------------------------------------------

  /**
   * Wait for a thread the daemon is still making, then name it.
   *
   * The daemon makes a worktree inside `thread.create` — a fetch and a `git
   * worktree add`, which is seconds — and the list opens the conversation the
   * moment it has an id, because a tap must not wait on a clone. So a
   * subscription and a first message can both reach the daemon before the
   * thread exists, and the answer to each is `thread <id> not found`. A view
   * keeps that error until the reader leaves the screen and comes back, which
   * is the conversation reading as empty while the daemon holds every word of
   * it. The page has no such gap: it navigates once the create is answered.
   *
   * Every command this store sends about a thread goes through here, and a
   * thread this app did not just create is in no map and waits for nothing.
   * Most of them cannot fire inside the window — an approval belongs to an item
   * and an item belongs to a thread that exists — but the conversation opens on
   * the id at once and its `⋮` sheet with it, so a rename, an archive and the
   * model picker all can. One rule is cheaper than a list of exceptions, and
   * the next call added here inherits it.
   */
  private whenMade = <T>(machine: string, threadId: string, run: () => Promise<T> | T): Promise<T> => {
    const made = this.creating.get(composerKey(machine, threadId));
    return made ? made.then(run) : Promise.resolve(run());
  };

  /**
   * Put a thread on screen. A screen calls this when it is focused.
   *
   * **The machine does not have to be there yet.** The view opens either way
   * and `watchView` subscribes it when its daemon can answer, because the
   * caller is not always a reader tapping a row that is already on screen: a
   * notification that *launched* the app navigates before `start()` has dialled
   * anything, and the device's own pick (`device/bridge.ts`) comes through the
   * same door. This used to return here with no view at all, and the screen
   * that opened then painted "Nothing here yet. Send the first message." over a
   * conversation the daemon held every word of, with no way back but to leave
   * and tap the row again.
   */
  showThread = (machine: string, threadId: string): void => {
    // Opening the conversation answers whatever covey put in the shade about
    // it, so the row goes. Before the early return below, because the reader
    // may be coming back to the thread they already had open.
    void dismissNote(noteId(machine, threadId));
    if (this.state.view?.machine === machine && this.state.view.threadId === threadId) return;
    if (this.state.view) void this.clients.get(this.state.view.machine)?.unwatchThread();
    openView(this.state, machine, threadId);
    this.schedule();
    this.watchView();
  };

  /**
   * Ask for the open conversation's transcript, if its machine can answer.
   *
   * Called when a view opens, when any machine connects, and once the saved
   * machines have been read — the three moments at which the answer can change.
   * Everything it needs is on the view, so there is no "wanted thread" to keep
   * anywhere: what the reader is looking at *is* the record.
   *
   * A view that already has its transcript asks for nothing. A reconnect
   * re-opens the subscription inside the client (`resubscribe`), so only a view
   * that was never answered — still loading, or holding the error of a machine
   * that was not there — has anything to gain here.
   */
  private watchView = (): void => {
    const v = this.state.view;
    if (!v || this.watching === v) return;
    if (!v.loading && !v.error) return;
    const client = this.clients.get(v.machine);
    if (!client) {
      // Before the saved machines are read, this is a conversation opened ahead
      // of its own dial. After, it is a machine this device does not have, and
      // the reader is owed that sentence rather than a view that spins.
      if (this.loaded) { v.loading = false; v.error = `no machine at ${v.machine} on this device`; this.schedule(); }
      return;
    }
    // A client with no socket rejects an rpc at once with "not connected", so
    // asking now would paint that as the conversation's error. The `connected`
    // callback in `dial` comes back here instead.
    if (client.state !== "connected") return;
    this.watching = v;
    v.loading = true;
    v.error = null;
    this.schedule();
    this.whenMade(v.machine, v.threadId, () => {
      // The reader may have left while the worktree was being made, and a
      // subscription nobody is reading is a transcript sent for nothing.
      if (this.state.view !== v) return null;
      return client.watchThread(v.threadId);
    }).then((snap) => {
      if (this.watching === v) this.watching = null;
      if (!snap || this.state.view !== v) return; // the reader moved on
      applyThreadSnapshot(v, snap);
      this.schedule();
    }).catch((e: Error) => {
      if (this.watching === v) this.watching = null;
      if (this.state.view === v) { v.loading = false; v.error = e.message; this.schedule(); }
    });
  };

  /** Take the thread off the screen, and its subscription with it. */
  leaveThread = (): void => {
    if (!this.state.view) return;
    void this.clients.get(this.state.view.machine)?.unwatchThread();
    if (this.watching === this.state.view) this.watching = null;
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
    // Taken once, and nothing goes without it: a draft dropped into a machine
    // this app cannot reach is a message the reader would have to write again.
    const client = this.clients.get(machine);
    if (!client) return;
    // A covey command is the app's own work and never reaches the agent (#16).
    // There is no `/` menu on this screen yet, so the command is typed whole.
    const own = coveyCommand(text);
    if (own) {
      if (own.name !== "clear") { this.fail(new Error(`/${own.name} is not a command covey answers`)); return; }
      // The draft and its chips go only once the daemon has taken the command,
      // as they do in the TUI: `thread.clear` is refused under a running turn,
      // and a reader must not lose the files they picked to a refusal.
      this.whenMade(machine, threadId, () => client.command({ type: "thread.clear", threadId })).then(() => {
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
    this.whenMade(machine, threadId, () => client.command({
      type: "turn.send", threadId, turnId: uuid(), text,
      ...(attachments.length ? { attachments } : {}),
    }))
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
    const client = v && this.clients.get(v.machine);
    if (!v || !client) return;
    void this.whenMade(v.machine, v.threadId, () => client.command({ type: "turn.interrupt", threadId: v.threadId })).catch(this.fail);
  };

  respondApproval = (item: ApprovalItem, behavior: "allow" | "deny", always: boolean): void => {
    const v = this.state.view;
    const client = this.viewClient();
    if (!v || !client) return;
    void this.whenMade(v.machine, item.threadId, () => client.command({
      type: "approval.respond", threadId: item.threadId, requestId: item.requestId, behavior,
      ...(always ? { updatedPermissions: item.suggestions } : {}),
    })).catch(this.fail);
  };

  respondQuestion = (item: QuestionItem, answers: string[]): void => {
    const v = this.state.view;
    const client = this.viewClient();
    if (!v || !client) return;
    void this.whenMade(v.machine, item.threadId, () => client.command({
      type: "question.respond", threadId: item.threadId, requestId: item.requestId,
      answer: answers[0] ?? "", answers,
    })).catch(this.fail);
  };

  // ---- the list ----------------------------------------------------------

  /**
   * Ask for a thread and hand its id back at once, for the screen to open.
   *
   * The create is recorded in `creating` while it runs, so the screen that
   * opens on this id subscribes the moment the daemon has a thread to
   * subscribe to, and not before.
   */
  newThread = (machine: string, projectId: string): string => {
    this.state.choosing = null;
    const threadId = uuid();
    const client = this.clients.get(machine);
    if (!client) return threadId;
    const key = composerKey(machine, threadId);
    // Caught here and nowhere else: this promise is a gate and must settle,
    // and a waiter reports the failure of its own command. A create that
    // failed leaves the subscription to say the thread is not there, which is
    // the error the reader needs.
    const made = client.command({ type: "thread.create", projectId, threadId, sessionId: uuid() }, CREATE_WAIT_MS)
      .catch(this.fail);
    this.creating.set(key, made);
    void made.then(() => this.creating.delete(key));
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

  /**
   * Which push-to-talk button this device holds.
   *
   * A preference of the device, like the two above. The composer reads it, and
   * takes the volume keys only while it is on screen — so the rocker changes
   * the volume everywhere else in the app whatever this says.
   */
  setTalk = (mode: TalkMode): void => {
    this.talk = mode;
    void saveTalk(mode);
    this.schedule();
  };

  /**
   * Whether this device is told when a thread needs the reader.
   *
   * A preference of the device, beside the three above, and the only one with a
   * cost outside the app: turning it on asks Android for the permission — with
   * the question in front of the reader who just asked for the feature — and
   * holds the process alive, because a socket frozen in Doze hears nothing to
   * tell anybody about.
   */
  setNotify = async (on: boolean): Promise<void> => {
    this.notify = on;
    void saveNotifyWanted(on);
    this.schedule();
    this.settleNotes(on ? await askNotes() : this.notesAllowed);
  };

  /**
   * Hold the process for the watch, or let it go, after anything that could
   * have changed either half of the answer.
   *
   * Nothing is held for notifications Android will not show: a reader who
   * refused the permission would otherwise pay a row in the shade and a process
   * that never sleeps for news that is never delivered.
   */
  private settleNotes = (allowed: boolean): void => {
    this.notesAllowed = allowed;
    if (this.notify && allowed) holdLinkService("watch");
    else releaseLinkService("watch");
    this.schedule();
  };

  /**
   * Tell the reader, when this one change is worth telling them.
   *
   * `noteFor` decides and this only carries it out, against the thread covey
   * last read rather than against the one in the machine's own map — see
   * `seen` for why those are not the same thing.
   */
  private tell(slot: MachineSlot, next: Thread): void {
    const key = composerKey(slot.key, next.id);
    const prev = this.seen.get(key);
    this.seen.set(key, next);
    // A thread covey has never read is a thread with no change to report. The
    // record is kept whatever the switch says, so turning notifications on does
    // not make the next event read as the first.
    if (!prev || !this.notify || !this.notesAllowed) return;
    const act = noteFor({
      machine: slot.key, machineName: slot.name, prev, next,
      foreground: this.active, open: this.state.view,
    });
    if (!act) return;
    if (act.act === "post") void postNote(act.note);
    else void dismissNote(act.id);
  }

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

  /**
   * Ask a machine to build the Android app from the code it holds (#185).
   *
   * The call answers as soon as the run starts — the build is tens of minutes
   * — and every step after that arrives as a `machine.appBuild` push, to this
   * client and to every other one watching the same machine.
   */
  buildApp = (machine: string): void => {
    const slot = this.state.machines.get(machine);
    const client = this.clients.get(machine);
    if (!slot || !client) return;
    client.rpc("machine.buildApp", {})
      .then((r) => { slot.appBuild = r; this.schedule(); })
      .catch(this.fail);
  };

  restartMachine = (machine: string): void => {
    const client = this.clients.get(machine);
    if (!client) return;
    client.expectRestart();
    client.rpc("machine.restart", {}).catch(this.fail);
  };

  archiveThread = (machine: string, threadId: string): void => {
    const client = this.clients.get(machine);
    if (!client) return;
    void this.whenMade(machine, threadId, () => client.command({ type: "thread.archive", threadId, archived: true })).catch(this.fail);
  };

  renameThread = (machine: string, threadId: string, title: string): void => {
    const client = this.clients.get(machine);
    if (!client) return;
    void this.whenMade(machine, threadId, () => client.command({ type: "thread.rename", threadId, title })).catch(this.fail);
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
    // The sheet of a thread opens from the conversation, which opens on the id
    // — so the model picker can be used while the worktree is still being made.
    // A machine's sheet names no thread and waits for nothing.
    const send = () => client.command(cmd);
    void (target.kind === "thread" ? this.whenMade(target.machine, target.threadId, send) : send()).catch(this.fail);
  };

  private viewClient(): MachineClient | undefined {
    return this.state.view ? this.clients.get(this.state.view.machine) : undefined;
  }
}

export const store = new Store();
