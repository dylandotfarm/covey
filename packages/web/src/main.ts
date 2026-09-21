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
    shellSnapshot: (snap) => { applyShellSnapshot(slot, snap); if (slot.primary) document.title = `covey · ${snap.machine.name}`; schedule(); },
    shellEvent: (ev) => { applyShellEvent(state, slot, ev); schedule(); },
    shellSynchronized: () => schedule(),
    threadEvent: (threadId, ev) => { if (applyThreadEvent(state, slot.key, threadId, ev)) schedule(); },
    threadSynchronized: () => schedule(),
    machineUpdate: () => {},
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

const actions: Actions = {
  openThread(machine, threadId) {
    const client = clients.get(machine);
    if (!client) return;
    const v = openView(state, machine, threadId);
    history.pushState({ machine, threadId }, "");
    schedule();
    client.watchThread(threadId).then((snap) => {
      if (state.view !== v) return; // the reader moved on
      applyThreadSnapshot(v, snap);
      schedule();
    }).catch((e: Error) => { if (state.view === v) { v.loading = false; v.error = e.message; schedule(); } });
  },
  back() {
    if (!state.view) return;
    void clients.get(state.view.machine)?.unwatchThread();
    state.view = null;
    schedule();
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

// The phone's own back control leaves the thread; a thread entered by the
// history's forward control is opened again.
addEventListener("popstate", (ev) => {
  const st = ev.state as { machine?: string; threadId?: string } | null;
  if (st?.machine && st.threadId) actions.openThread(st.machine, st.threadId);
  else if (state.view) { void clients.get(state.view.machine)?.unwatchThread(); state.view = null; schedule(); }
});
// A phone that slept dropped its sockets. Each client has a budget of dials
// and may have spent it; the reader coming back is the reason to spend more.
addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") actions.retry(); });

const origin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
dial(addMachine(state, origin, location.hostname, true), readToken());
schedule();
