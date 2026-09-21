/**
 * The page. It dials the daemon that served it, then every other machine that
 * daemon names, folds what they say into `State`, and paints on a frame
 * boundary — never per event, because a daemon in the middle of a turn
 * re-sends an item every few tens of milliseconds and the phone has one
 * thread for the paint and the keyboard.
 */
import { MachineClient, uuid } from "@covey/client";
import { WEB_CLIENT, type ApprovalItem, type FleetMember, type QuestionItem } from "@covey/protocol";
import { Renderer, type Actions } from "./render.js";
import { addMachine, applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, emptyState, openView, primaryMachine, type MachineSlot } from "./state.js";

const TOKEN_KEY = "covey.token";

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
const clients = new Map<string, MachineClient>();

/**
 * The open thread is in the URL: `#/t/<machine>/<thread>`. The browser's
 * back control, a swipe from the edge, and a reload all read the same
 * thing, and the list is the page with no hash. A route for a machine the
 * page has not dialled yet waits until that machine's snapshot arrives.
 */
type Route = { machine: string; threadId: string } | null;
const routeOf = (hash: string): Route => {
  const m = /^#\/t\/([^/]+)\/([^/]+)$/.exec(hash);
  return m ? { machine: decodeURIComponent(m[1]!), threadId: decodeURIComponent(m[2]!) } : null;
};
const hashFor = (r: NonNullable<Route>) => `#/t/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.threadId)}`;
let pendingRoute: Route = routeOf(location.hash);
/** The thread was entered from the list on this page, so back is a step back. */
let enteredFromList = false;
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
      if (pendingRoute?.machine === slot.key) { const r = pendingRoute; pendingRoute = null; showThread(r.machine, r.threadId); }
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
  dial(addMachine(state, key, m.name), m.token);
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

const actions: Actions = {
  openThread(machine, threadId) {
    const hash = hashFor({ machine, threadId });
    enteredFromList = true;
    if (location.hash === hash) showThread(machine, threadId); else location.hash = hash;
  },
  back() {
    if (!state.view) return;
    // A thread entered from the list is one step back in the history. One
    // opened by its URL has no list behind it, so the list is put there
    // instead of a step back out of the page.
    if (enteredFromList) history.back(); else location.replace(`${location.pathname}${location.search}`);
  },
  send(text) {
    const v = state.view;
    if (!v) return;
    state.drafts.delete(`${v.machine}:${v.threadId}`);
    clients.get(v.machine)?.command({ type: "turn.send", threadId: v.threadId, turnId: uuid(), text }).catch(fail);
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
  setDraft(machine, threadId, text) { state.drafts.set(`${machine}:${threadId}`, text); },
  toggleAddresses() { state.showAddresses = !state.showAddresses; schedule(); },
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
};

const viewClient = () => (state.view ? clients.get(state.view.machine) : undefined);

function fail(e: Error) {
  const p = primaryMachine(state);
  if (!p) return;
  p.connError = e.message;
  schedule();
  setTimeout(() => { if (p.connError === e.message) { p.connError = null; schedule(); } }, 4000);
}

const renderer = new Renderer(document.getElementById("app")!, actions);

// The browser's back control, a swipe from the edge, and the forward control
// all change the hash; the hash says what is on screen.
addEventListener("hashchange", () => {
  const r = routeOf(location.hash);
  if (!r) { enteredFromList = false; leaveThread(); return; }
  if (clients.has(r.machine)) showThread(r.machine, r.threadId); else pendingRoute = r;
});
// A phone that slept dropped its sockets. Each client has a budget of dials
// and may have spent it; the reader coming back is the reason to spend more.
addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") actions.retry(); });

const origin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
dial(addMachine(state, origin, location.hostname, true), readToken());
schedule();
