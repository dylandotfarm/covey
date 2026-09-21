/**
 * The page. It dials the daemon that served it, folds what the daemon says
 * into `State`, and paints on a frame boundary — never per event, because a
 * daemon in the middle of a turn re-sends an item every few tens of
 * milliseconds and the phone has one thread for the paint and the keyboard.
 */
import { MachineClient, uuid } from "@covey/client";
import { WEB_CLIENT, type ApprovalItem, type QuestionItem } from "@covey/protocol";
import { Renderer, type Actions } from "./render.js";
import { applyShellEvent, applyShellSnapshot, applyThreadEvent, applyThreadSnapshot, emptyState, openView } from "./state.js";

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
let frame = 0;
const paint = () => { frame = 0; renderer.paint(state); };
/** One paint per frame, however many events arrived. */
const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const client = new MachineClient({ name: location.host, url: wsUrl, token: readToken() }, {
  state: (s, err) => {
    state.conn = s; state.connError = err ?? null; schedule();
    // The other addresses, so a phone that came in over the tailnet can hand
    // the token to the LAN address with a tap. Asked once per connection: the
    // list changes only when the daemon restarts, and so does the connection.
    if (s === "connected") client.rpc("machine.access", {}).then((a) => { state.access = a; schedule(); }).catch(() => {});
  },
  shellSnapshot: (snap) => { applyShellSnapshot(state, snap); document.title = `covey · ${snap.machine.name}`; schedule(); },
  shellEvent: (ev) => { applyShellEvent(state, ev); schedule(); },
  shellSynchronized: () => schedule(),
  threadEvent: (threadId, ev) => { if (applyThreadEvent(state, threadId, ev)) schedule(); },
  threadSynchronized: () => schedule(),
  machineUpdate: () => {},
}, { clientName: WEB_CLIENT });

const actions: Actions = {
  openThread(threadId) {
    const v = openView(state, threadId);
    history.pushState({ threadId }, "");
    schedule();
    client.watchThread(threadId).then((snap) => {
      if (state.view !== v) return; // the reader moved on
      applyThreadSnapshot(v, snap);
      schedule();
    }).catch((e: Error) => { if (state.view === v) { v.loading = false; v.error = e.message; schedule(); } });
  },
  back() {
    if (!state.view) return;
    void client.unwatchThread();
    state.view = null;
    schedule();
  },
  send(text) {
    const v = state.view;
    if (!v) return;
    state.drafts.delete(v.threadId);
    client.command({ type: "turn.send", threadId: v.threadId, turnId: uuid(), text }).catch(fail);
  },
  interrupt() {
    if (state.view) client.command({ type: "turn.interrupt", threadId: state.view.threadId }).catch(fail);
  },
  respondApproval(item: ApprovalItem, behavior, always) {
    client.command({ type: "approval.respond", threadId: item.threadId, requestId: item.requestId, behavior, ...(always ? { updatedPermissions: item.suggestions } : {}) }).catch(fail);
  },
  respondQuestion(item: QuestionItem, answers) {
    client.command({ type: "question.respond", threadId: item.threadId, requestId: item.requestId, answer: answers[0] ?? "", answers }).catch(fail);
  },
  newThread(projectId) {
    const threadId = uuid();
    client.command({ type: "thread.create", projectId, threadId, sessionId: uuid() })
      .then(() => actions.openThread(threadId))
      .catch(fail);
  },
  toggleFold(projectId) {
    if (state.folded.has(projectId)) state.folded.delete(projectId); else state.folded.add(projectId);
    schedule();
  },
  retry() { client.retry(); schedule(); },
  toggleAddresses() { state.showAddresses = !state.showAddresses; schedule(); },
  setDraft(threadId, text) { state.drafts.set(threadId, text); },
};

function fail(e: Error) {
  state.connError = e.message;
  schedule();
  setTimeout(() => { if (state.connError === e.message) { state.connError = null; schedule(); } }, 4000);
}

const renderer = new Renderer(document.getElementById("app")!, actions);

// The phone's own back control leaves the thread; a thread entered by the
// history's forward control is opened again.
addEventListener("popstate", (ev) => {
  const id = (ev.state as { threadId?: string } | null)?.threadId;
  if (id) actions.openThread(id); else if (state.view) { void client.unwatchThread(); state.view = null; schedule(); }
});
// A phone that slept dropped the socket. The client has a budget of dials and
// may have spent it; the reader coming back is the reason to spend more.
addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && client.state === "offline") client.retry(); });

client.start();
schedule();
