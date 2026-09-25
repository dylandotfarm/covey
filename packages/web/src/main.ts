/**
 * The page. It dials the daemon that served it, then every other machine that
 * daemon names, folds what they say into `State`, and paints on a frame
 * boundary — never per event, because a daemon in the middle of a turn
 * re-sends an item every few tens of milliseconds and the phone has one
 * thread for the paint and the keyboard.
 */
import { applyDrop, budgetValue, MachineClient, uuid } from "@covey/client";
import { asLod, DEFAULT_LOD, WEB_CLIENT, type Lod, type ApprovalItem, type Command, type FleetMember, type PermissionMode, type QuestionItem } from "@covey/protocol";
import { Renderer, type Actions } from "./render.js";
import { addMachine, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, composerKey, emptyState, itemHash, openView, pendingAttachments, pendingBytes, primaryMachine, routeOf, sendableAttachments, setPendingAttachments, syncAttachments, threadHash, viewRowNumber, type MachineSlot, type Route, type SheetTarget } from "./state.js";
import { attachingLabel, readPicked, sendingLabel } from "./attach.js";
import { picked, shrinkInBrowser } from "./shrink.js";

const TOKEN_KEY = "covey.token";
/** Where this device keeps its level of detail (#149). */
const LOD_KEY = "covey.lod";

/**
 * The level this device reads transcripts at, from the last time it was set.
 *
 * A preference of the device rather than of the machine, so it lives here and
 * travels in no command: the phone reads a thread at `compact` while the
 * laptop that runs the same thread reads it at `full`. A value written by a
 * newer covey reads back as "no opinion", and the default stands.
 */
function readLod(): Lod {
  return asLod(localStorage.getItem(LOD_KEY)) ?? DEFAULT_LOD;
}

/** The token from `?token=` on the URL, kept for the next visit, or the kept one. */
function readToken(): string | undefined {
  const url = new URL(location.href);
  const given = url.searchParams.get("token");
  if (given) {
    localStorage.setItem(TOKEN_KEY, given);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
    return given;
  }
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

const state = emptyState();
state.lod = readLod();
const clients = new Map<string, MachineClient>();
/** Read once: the page's token, if this address needs one. The media route takes it too (#110). */
const token = readToken();

/**
 * What is on screen is in the URL: a thread, `#/t/<machine>/<thread>`, or an
 * issue or a pull request, `#/gh/<machine>/<project>/<number>`. The browser's
 * back control, a swipe from the edge, and a reload all read the same thing,
 * and the list is the page with no hash. A route for a machine the page has
 * not dialled yet waits until that machine's snapshot arrives.
 */
let pendingRoute: Route = routeOf(location.hash);
/** The thread was entered from the list on this page, so back is a step back. */
let enteredFromList = false;
/** The item was opened from this page, so back is a step back to what it was opened over. */
let enteredItem = false;
let frame = 0;
const paint = () => { frame = 0; renderer.paint(state); };
/** One paint per frame, however many events arrived. */
const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

/** Dial one machine and bind its events to its slot. */
function dial(slot: MachineSlot, token: string | undefined) {
  const client = new MachineClient({ name: slot.name, url: slot.key, token }, {
    state: (s, err) => {
      slot.conn = s; slot.connError = err ?? null; schedule();
      if (s === "connected" && slot.primary) askAccess(client);
    },
    shellSnapshot: (snap) => {
      applyShellSnapshot(slot, snap);
      if (slot.primary) document.title = `covey · ${snap.machine.name}`;
      if (pendingRoute?.machine === slot.key) { const r = pendingRoute; pendingRoute = null; applyRoute(r); }
      schedule();
    },
    shellEvent: (ev) => { applyShellEvent(state, slot, ev); schedule(); },
    shellSynchronized: () => schedule(),
    threadEvent: (threadId, ev) => { if (applyThreadEvent(state, slot.key, threadId, ev)) schedule(); },
    threadSynchronized: () => schedule(),
    machineUpdate: (update) => {
      slot.update = update;
      // The drop that follows is the update working: give the client the
      // long budget, so the reconnect that reports success can happen.
      if (update.state === "restarting") client.expectRestart();
      schedule();
    },
  }, { clientName: WEB_CLIENT });
  clients.set(slot.key, client);
  client.start();
}

/**
 * The primary daemon's token, its other addresses, and the fleet. Asked once
 * per connection: the list changes only when the TUI sends a new one, and
 * the next connection picks that up.
 */
function askAccess(client: MachineClient) {
  client.rpc("machine.access", {}).then((a) => {
    state.access = a;
    for (const m of a.fleet ?? []) dialMember(m);
    schedule();
  }).catch(() => {});
}

/** Dial a machine the primary named, unless it is the primary or already dialled. */
function dialMember(m: FleetMember) {
  const primary = primaryMachine(state);
  if (m.machineId && primary?.info?.machineId === m.machineId) return;
  let key: string;
  try { key = new URL(m.url).toString().replace(/\/$/, ""); } catch { return; }
  if (state.machines.has(key)) return;
  dial(addMachine(state, key, m.name, false, m.token), m.token);
}

/** Put a thread on screen. The URL already names it; this is what the URL means. */
function showThread(machine: string, threadId: string) {
  const client = clients.get(machine);
  if (!client) return;
  if (state.view?.machine === machine && state.view.threadId === threadId) return;
  if (state.view) void clients.get(state.view.machine)?.unwatchThread();
  const v = openView(state, machine, threadId);
  schedule();
  client.watchThread(threadId).then((snap) => {
    if (state.view !== v) return; // the reader moved on
    applyThreadSnapshot(v, snap);
    schedule();
  }).catch((e: Error) => { if (state.view === v) { v.loading = false; v.error = e.message; schedule(); } });
}

/** Take the thread off the screen. The URL no longer names one. */
function leaveThread() {
  if (!state.view) return;
  void clients.get(state.view.machine)?.unwatchThread();
  state.view = null;
  schedule();
}

/**
 * Put an issue or a pull request on screen (#108), over whatever is there.
 * The thread under it keeps its subscription: the item is a look aside, and
 * the return must cost nothing.
 */
function showItem(machine: string, projectId: string, number: number) {
  const iv = state.item;
  if (iv && iv.machine === machine && iv.projectId === projectId && iv.number === number) return;
  state.item = { machine, projectId, number, item: null, loading: true, error: null, busy: false, draft: "" };
  schedule();
  loadItem();
}

/** Read the item on screen from its daemon. */
function loadItem() {
  const iv = state.item;
  const client = iv && clients.get(iv.machine);
  if (!iv || !client) return;
  iv.loading = true;
  schedule();
  client.rpc("github.item", { projectId: iv.projectId, number: iv.number }).then((item) => {
    if (state.item !== iv) return; // the reader moved on
    iv.item = item; iv.loading = false; iv.error = null;
    schedule();
  }).catch((e: Error) => { if (state.item === iv) { iv.loading = false; iv.error = e.message; schedule(); } });
}

/** What the hash means, applied. */
function applyRoute(r: Route) {
  // The sheet belongs to the screen it was opened from. The screen is changing.
  state.sheet = null;
  if (!r) { enteredFromList = false; enteredItem = false; state.item = null; leaveThread(); schedule(); return; }
  if (!clients.has(r.machine)) { pendingRoute = r; return; }
  if (r.kind === "thread") { state.item = null; showThread(r.machine, r.threadId); schedule(); return; }
  showItem(r.machine, r.projectId, r.number);
}

const actions: Actions = {
  toggleRow(key) {
    const next = new Set(state.toggledRows);
    next.has(key) ? next.delete(key) : next.add(key);
    state.toggledRows = next;
    // No `schedule()`: the browser has already opened or shut the `<details>`,
    // and a paint here would rebuild the row under the finger that did it.
  },
  setLod(lod) {
    state.lod = lod;
    // The taps go with it: each was an answer to the level it was made at, and
    // at the new one half of them would mean the opposite.
    state.toggledRows = new Set();
    localStorage.setItem(LOD_KEY, lod);
    schedule();
  },
  openThread(machine, threadId) {
    const hash = threadHash(machine, threadId);
    enteredFromList = true;
    if (location.hash === hash) applyRoute(routeOf(hash)); else location.hash = hash;
  },
  back() {
    // An item opened from this page is one step back in the history. One
    // opened by its URL has nothing behind it, so the thread it belongs
    // over, or the list, is put there instead of a step back out of the page.
    if (state.item) {
      if (enteredItem) history.back();
      else location.replace(state.view ? threadHash(state.view.machine, state.view.threadId) : `${location.pathname}${location.search}`);
      return;
    }
    if (!state.view) return;
    // The same rule for a thread entered from the list.
    if (enteredFromList) history.back(); else location.replace(`${location.pathname}${location.search}`);
  },
  openItem(machine, projectId, number) {
    const hash = itemHash(machine, projectId, number);
    enteredItem = true;
    if (location.hash === hash) showItem(machine, projectId, number); else location.hash = hash;
  },
  refreshItem() { loadItem(); },
  actItem(action) {
    const iv = state.item;
    const client = iv && clients.get(iv.machine);
    if (!iv || !client || iv.busy) return;
    iv.busy = true; iv.error = null;
    schedule();
    client.rpc("github.act", { projectId: iv.projectId, number: iv.number, action }).then((item) => {
      if (state.item !== iv) return;
      iv.item = item; iv.busy = false; iv.draft = "";
      schedule();
    }).catch((e: Error) => { if (state.item === iv) { iv.busy = false; iv.error = e.message; schedule(); } });
  },
  setItemDraft(text) { if (state.item) state.item.draft = text; },
  send(text) {
    const v = state.view;
    if (!v) return;
    const { machine, threadId } = v;
    // The tag in the text is the file. Whatever lost its tag does not go.
    const attachments = sendableAttachments(syncAttachments(state, machine, threadId, text));
    state.drafts.delete(composerKey(machine, threadId));
    setPendingAttachments(state, machine, threadId, []);
    const bytes = pendingBytes(attachments);
    // A phone on a mobile link takes seconds over a photograph, and the socket
    // says nothing meanwhile, so the composer holds the line until the daemon
    // acknowledges the command.
    if (bytes > 0) state.attaching = sendingLabel(bytes);
    schedule();
    clients.get(machine)?.command({ type: "turn.send", threadId, turnId: uuid(), text, ...(attachments.length ? { attachments } : {}) })
      .catch(fail)
      .finally(() => { if (bytes > 0) { state.attaching = null; schedule(); } });
  },
  attachTags() {
    const v = state.view;
    return v ? [...new Set(pendingAttachments(state, v.machine, v.threadId).map((a) => a.tag))] : [];
  },
  async attachFiles(files, draft) {
    const v = state.view;
    if (!v) return null;
    const { machine, threadId } = v;
    const held = pendingAttachments(state, machine, threadId);
    state.attaching = attachingLabel(files);
    schedule();
    let read;
    try {
      read = await readPicked(files.map(picked), shrinkInBrowser, pendingBytes(held));
    } finally {
      state.attaching = null;
      schedule();
    }
    // The reader may have left the thread while a photograph was scaling.
    if (state.view?.machine !== machine || state.view.threadId !== threadId) return null;
    // A file that did not attach, and a file that attached but not the way the
    // reader meant, each say so where every other failure on this page says it.
    for (const w of read.warnings) fail(new Error(w));
    for (const f of read.failed) fail(new Error(f.message));
    if (read.attachments.length === 0 && read.failed.length === 0) return null;
    // The caret belongs to the renderer, so the tags are worked out here and
    // put into the draft there. `draft` is only what they must be unique
    // against — the text of it at the moment the reader picked.
    const drop = applyDrop(draft, draft.length, read.attachments, held, read.failed);
    setPendingAttachments(state, machine, threadId, drop.attachments);
    schedule();
    const before = new Set(held.map((a) => a.tag));
    return [...new Set(drop.attachments.map((a) => a.tag))].filter((t) => !before.has(t));
  },
  interrupt() {
    const v = state.view;
    if (v) clients.get(v.machine)?.command({ type: "turn.interrupt", threadId: v.threadId }).catch(fail);
  },
  respondApproval(item: ApprovalItem, behavior, always) {
    viewClient()?.command({ type: "approval.respond", threadId: item.threadId, requestId: item.requestId, behavior, ...(always ? { updatedPermissions: item.suggestions } : {}) }).catch(fail);
  },
  respondQuestion(item: QuestionItem, answers) {
    viewClient()?.command({ type: "question.respond", threadId: item.threadId, requestId: item.requestId, answer: answers[0] ?? "", answers }).catch(fail);
  },
  newThread(machine, projectId) {
    state.choosing = null;
    const threadId = uuid();
    clients.get(machine)?.command({ type: "thread.create", projectId, threadId, sessionId: uuid() })
      .then(() => actions.openThread(machine, threadId))
      .catch(fail);
  },
  chooseMachine(rowKey) { state.choosing = state.choosing === rowKey ? null : rowKey; schedule(); },
  toggleFold(rowKey) {
    if (state.folded.has(rowKey)) state.folded.delete(rowKey); else state.folded.add(rowKey);
    schedule();
  },
  retry() { for (const c of clients.values()) if (c.state === "offline" || c.state === "error") c.retry(); schedule(); },
  setDraft(machine, threadId, text) {
    state.drafts.set(composerKey(machine, threadId), text);
    // Deleting the chip drops the file. Only a change in the count repaints:
    // a paint per keystroke is what the frame budget cannot afford.
    const before = pendingAttachments(state, machine, threadId).length;
    if (syncAttachments(state, machine, threadId, text).length !== before) schedule();
  },
  toggleAddresses() { state.showAddresses = !state.showAddresses; state.sheet = null; schedule(); },
  updateMachine(machine) {
    const slot = state.machines.get(machine);
    const client = clients.get(machine);
    if (!slot || !client) return;
    const busy = [...slot.threads.values()].filter((t) => t.status === "running" || t.status === "starting").length;
    if (!confirm(`Update ${slot.name}: pull, rebuild and restart the daemon?${busy ? ` ${busy} running turn${busy === 1 ? "" : "s"} will be interrupted.` : ""}`)) return;
    client.rpc("machine.update", { restart: true }).then((u) => { slot.update = u; schedule(); }).catch(fail);
  },
  restartMachine(machine) {
    const slot = state.machines.get(machine);
    const client = clients.get(machine);
    if (!slot || !client) return;
    if (!confirm(`Restart the daemon on ${slot.name}? Running turns will be interrupted.`)) return;
    client.expectRestart();
    client.rpc("machine.restart", {}).catch(fail);
  },
  setBind(machine, bind) {
    clients.get(machine)?.command({ type: "machine.settings", bind }).catch(fail);
  },
  archiveThread(machine, threadId) {
    clients.get(machine)?.command({ type: "thread.archive", threadId, archived: true }).catch(fail);
  },
  openSheet(target) { state.sheet = { target, page: "" }; schedule(); },
  closeSheet() { state.sheet = null; schedule(); },
  sheetPage(page) { if (state.sheet) { state.sheet.page = page; schedule(); } },
  sheetChoose(id) {
    const sh = state.sheet;
    if (!sh) return;
    const client = clients.get(sh.target.machine);
    if (!client) return;
    const cmd = sheetCommand(sh.target, sh.page, id);
    if (!cmd) return;
    // Turning the web server off on a machine takes the phone client with it.
    if (cmd.type === "machine.settings" && cmd.webEnabled === false
      && !confirm(`Stop the web server on ${state.machines.get(sh.target.machine)?.name ?? "that machine"}? Nothing serves the phone client from there afterwards.`)) return;
    state.sheet = null;
    schedule();
    client.command(cmd).catch(fail);
  },
  sheetAct(id) {
    const sh = state.sheet;
    if (!sh || sh.target.kind !== "thread") return;
    const { machine, threadId } = sh.target;
    // A row that opens an issue or a pull request (#115). It needs no client:
    // the item screen reads the item itself.
    const number = viewRowNumber(id);
    if (number !== null) {
      const projectId = state.machines.get(machine)?.threads.get(threadId)?.projectId;
      if (!projectId) return;
      state.sheet = null;
      actions.openItem(machine, projectId, number);
      return;
    }
    const client = clients.get(machine);
    if (!client) return;
    if (id === "rename") {
      const now = state.machines.get(machine)?.threads.get(threadId)?.title ?? "";
      const title = prompt("Name this conversation", now)?.trim();
      if (!title || title === now) return;
      state.sheet = null;
      schedule();
      client.command({ type: "thread.rename", threadId, title }).catch(fail);
      return;
    }
    if (id === "archive") {
      if (!confirm("Archive this conversation? It leaves the list; the TUI brings it back.")) return;
      state.sheet = null;
      schedule();
      client.command({ type: "thread.archive", threadId, archived: true }).catch(fail);
      // Nothing is left on screen to archive, so the list comes back.
      actions.back();
    }
  },
};

/**
 * The command one choice on a sheet stands for, or null when the page names no
 * setting. A model of `""` clears the setting, and the thread or the machine
 * falls back to what the user's own Claude configuration says.
 */
function sheetCommand(target: SheetTarget, page: string, id: string): Command | null {
  if (target.kind === "thread") {
    const threadId = target.threadId;
    switch (page) {
      case "model": return { type: "thread.setModel", threadId, model: id || null };
      case "mode": return { type: "thread.setPermissionMode", threadId, mode: id as PermissionMode };
      case "streaming": return { type: "thread.setStreaming", threadId, streaming: id === "on" };
      default: return null;
    }
  }
  switch (page) {
    case "model": return { type: "machine.settings", defaultModel: id || null };
    case "mode": return { type: "machine.settings", defaultPermissionMode: (id || null) as PermissionMode | null };
    case "streaming": return { type: "machine.settings", defaultStreaming: id === "on" };
    case "web": return { type: "machine.settings", webEnabled: id === "on" };
    case "live": return { type: "machine.settings", maxLiveSessions: budgetValue(id) };
    case "idle": return { type: "machine.settings", sessionIdleMinutes: budgetValue(id) };
    default: return null;
  }
}

const viewClient = () => (state.view ? clients.get(state.view.machine) : undefined);

function fail(e: Error) {
  const p = primaryMachine(state);
  if (!p) return;
  p.connError = e.message;
  schedule();
  setTimeout(() => { if (p.connError === e.message) { p.connError = null; schedule(); } }, 4000);
}

const renderer = new Renderer(document.getElementById("app")!, actions, token);

// The browser's back control, a swipe from the edge, and the forward control
// all change the hash; the hash says what is on screen.
addEventListener("hashchange", () => applyRoute(routeOf(location.hash)));
// A phone that slept dropped its sockets. Each client has a budget of dials
// and may have spent it; the reader coming back is the reason to spend more.
addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") actions.retry(); });

const origin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
dial(addMachine(state, origin, location.hostname, true, token), token);
schedule();
