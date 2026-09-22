/**
 * What the page knows, and how a daemon's events change it.
 *
 * This file has no DOM in it, so node can test it. The fold is the same one
 * the TUI store does: a project, a thread and a timeline item each arrive
 * whole under a stable id, and the newest copy replaces the old one. There is
 * no delta channel, and that is what makes a reconnect free — the subscription
 * replays what the phone slept through, and the replay folds in exactly as a
 * live event would.
 *
 * The page dials more than one daemon. The one that served the page is the
 * primary; it names the others in `machine.access`. Each daemon has a slot,
 * and a thread on screen is named by its machine and its id.
 */
import {
  threadIsBusy,
  type GitHubAction, type GitHubItem, type GitHubPullRequest, type MachineAccess, type MachineInfo, type MachineUpdate, type Project, type ShellEvent, type ShellSnapshot, type SlashCommandInfo, type Thread, type ThreadEvent,
  type ThreadSnapshot, type TimelineItem, type WebAddress,
} from "@covey/protocol";
import type { ConnState } from "@covey/client";

export interface MachineSlot {
  /** The `ws://` URL the page dials. */
  key: string;
  name: string;
  conn: ConnState;
  connError: string | null;
  info: MachineInfo | null;
  projects: Map<string, Project>;
  threads: Map<string, Thread>;
  /** The daemon that served the page. Its fleet list names the others. */
  primary: boolean;
  /** The update in flight on that machine, or the last one it reported. */
  update: MachineUpdate | null;
}

export interface View {
  machine: string;
  threadId: string;
  thread: Thread | null;
  items: Map<string, TimelineItem>;
  /** The highest event seq folded in, so a resubscribe starts after it. */
  seq: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  commands: SlashCommandInfo[] | null;
}

/**
 * An issue or a pull request on screen (#108), over the thread or the list
 * it was opened from. The daemon of `machine` reads it with `gh` in the
 * project's checkout, and every act goes back to that daemon.
 */
export interface ItemView {
  machine: string;
  projectId: string;
  number: number;
  item: GitHubItem | null;
  loading: boolean;
  error: string | null;
  /** An act is in flight, so the buttons wait. */
  busy: boolean;
  /** The text in the comment box, kept across paints. */
  draft: string;
}

export interface State {
  machines: Map<string, MachineSlot>;
  /** Project groups the reader folded shut, by group key. */
  folded: Set<string>;
  /** The thread on screen, or null for the list. */
  view: View | null;
  /** The issue or the pull request on screen, over the thread or the list. */
  item: ItemView | null;
  /** Draft text per `machine:thread`, kept while the reader browses. */
  drafts: Map<string, string>;
  /** The token and the other addresses of the primary daemon, once asked for. */
  access: MachineAccess | null;
  /** The settings panel is open over the list. */
  showAddresses: boolean;
  /** A project group the reader is picking a machine for, to start a thread. */
  choosing: string | null;
}

export function emptyState(): State {
  return { machines: new Map(), folded: new Set(), view: null, item: null, drafts: new Map(), access: null, showAddresses: false, choosing: null };
}

export function addMachine(s: State, key: string, name: string, primary = false): MachineSlot {
  const slot: MachineSlot = { key, name, conn: "connecting", connError: null, info: null, projects: new Map(), threads: new Map(), primary, update: null };
  s.machines.set(key, slot);
  return slot;
}

export function primaryMachine(s: State): MachineSlot | undefined {
  for (const m of s.machines.values()) if (m.primary) return m;
  return undefined;
}

export function applyShellSnapshot(m: MachineSlot, snap: ShellSnapshot): void {
  m.info = snap.machine;
  m.name = snap.machine.name;
  m.projects = new Map(snap.projects.map((p) => [p.id, p]));
  m.threads = new Map(snap.threads.map((t) => [t.id, t]));
}

export function applyShellEvent(s: State, m: MachineSlot, ev: ShellEvent): void {
  switch (ev.kind) {
    case "machine.updated": m.info = ev.machine; m.name = ev.machine.name; break;
    case "project.upserted": m.projects.set(ev.project.id, ev.project); break;
    case "project.removed": m.projects.delete(ev.projectId); break;
    case "thread.upserted":
      m.threads.set(ev.thread.id, ev.thread);
      if (s.view?.machine === m.key && s.view.threadId === ev.thread.id) s.view.thread = ev.thread;
      break;
    case "thread.removed":
      m.threads.delete(ev.threadId);
      break;
    // Runs are not on the phone yet. Their members are threads, and those
    // arrive on their own.
    case "run.upserted": case "run.removed": break;
  }
}

export function openView(s: State, machine: string, threadId: string): View {
  const v: View = { machine, threadId, thread: s.machines.get(machine)?.threads.get(threadId) ?? null, items: new Map(), seq: 0, hasMore: false, loading: true, error: null, commands: null };
  s.view = v;
  return v;
}

export function applyThreadSnapshot(v: View, snap: ThreadSnapshot): void {
  v.thread = snap.thread;
  v.items = new Map(snap.items.map((i) => [i.id, i]));
  v.seq = snap.seq;
  v.hasMore = snap.hasMore;
  v.commands = snap.commands;
  v.loading = false;
  v.error = null;
}

/** Fold one event into the open view. An event for another thread, or another machine, is dropped. */
export function applyThreadEvent(s: State, machine: string, threadId: string, ev: ThreadEvent): boolean {
  const v = s.view;
  if (!v || v.machine !== machine || v.threadId !== threadId) return false;
  switch (ev.kind) {
    case "item.upserted": v.items.set(ev.item.id, ev.item); break;
    case "item.removed": v.items.delete(ev.itemId); break;
    case "thread.updated": v.thread = ev.thread; s.machines.get(machine)?.threads.set(ev.thread.id, ev.thread); break;
    case "commands.updated": v.commands = ev.commands; break;
  }
  // A resent snapshot carries each item's own seq, older than the
  // subscription's. Take the highest and never go backwards.
  v.seq = Math.max(v.seq, ev.seq);
  return true;
}

/** The items of a view in the order they happened. */
export function orderedItems(v: View): TimelineItem[] {
  return [...v.items.values()].sort((a, b) => a.seq - b.seq);
}

export type Tone = "busy" | "waiting" | "error" | "done" | "idle";

/** One word for the dot beside a thread. `waiting` wins, because it is the
 *  one the reader can do something about. */
export function threadTone(t: Thread): Tone {
  if (t.pendingApprovals > 0 || t.status === "waiting") return "waiting";
  if (t.status === "error" || t.latestTurn?.state === "error") return "error";
  if (threadIsBusy(t)) return "busy";
  if (t.latestTurn?.state === "completed") return "done";
  return "idle";
}

/** A project on one machine. */
export interface ProjectHome {
  machine: string;
  machineName: string;
  conn: ConnState;
  project: Project;
}

export interface ThreadRef {
  machine: string;
  machineName: string;
  thread: Thread;
}

/**
 * One row of the list: a repository, wherever it is checked out. Two machines
 * that hold the same repository are one row, the way the TUI's sidebar shows
 * one project with a pool of machines. A project with no remote is its own
 * row, keyed by its machine and id, because nothing says it is the same
 * as any other.
 */
export interface ProjectRow {
  key: string;
  title: string;
  homes: ProjectHome[];
  threads: ThreadRef[];
  /** How many of its threads are at work or wait on the reader. */
  active: number;
  waiting: number;
}

export function projectKey(machine: string, p: Project): string {
  return p.repositoryIdentity ? `repo:${p.repositoryIdentity.toLowerCase()}` : `local:${machine}:${p.id}`;
}

/**
 * The list screen: every project with its live threads, newest first, pinned
 * ones at the top. Archived threads and tombstones of moved ones stay out —
 * the phone is for what is going on, not for the record. A thread whose
 * project the machine does not list is kept under a row of its own, so
 * nothing the daemon sent is silently dropped.
 */
export function projectRows(s: State): ProjectRow[] {
  const rows = new Map<string, ProjectRow>();
  const row = (key: string, title: string) => {
    let r = rows.get(key);
    if (!r) { r = { key, title, homes: [], threads: [], active: 0, waiting: 0 }; rows.set(key, r); }
    return r;
  };
  for (const m of s.machines.values()) {
    for (const p of m.projects.values()) {
      const r = row(projectKey(m.key, p), p.title);
      r.homes.push({ machine: m.key, machineName: m.name, conn: m.conn, project: p });
    }
    for (const t of m.threads.values()) {
      if (t.archivedAt || t.movedTo) continue;
      const p = m.projects.get(t.projectId);
      const r = p ? row(projectKey(m.key, p), p.title) : row(`orphan:${m.key}:${t.projectId}`, "(project not listed)");
      r.threads.push({ machine: m.key, machineName: m.name, thread: t });
    }
  }
  const out = [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
  for (const r of out) {
    r.threads.sort((a, b) => byRecency(a.thread, b.thread));
    r.active = r.threads.filter((x) => threadIsBusy(x.thread)).length;
    r.waiting = r.threads.filter((x) => threadTone(x.thread) === "waiting").length;
  }
  return out;
}

function byRecency(a: Thread, b: Thread): number {
  if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
  return (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt);
}

/** The homes of a row a new thread can go to: connected machines only. */
export function openHomes(r: ProjectRow): ProjectHome[] {
  return r.homes.filter((h) => h.conn === "connected");
}

/**
 * What the banner says. Only the primary daemon speaks here: it is the
 * page's own connection, and without it there is nothing on screen to trust.
 * A fleet machine that is down is a line on the settings page, not a banner
 * over the list — a machine that is off for the day would otherwise sit
 * over every visit.
 */
export function connectionSummary(s: State): { state: ConnState; text: string } {
  const p = primaryMachine(s);
  if (!p) return { state: "connecting", text: "connecting…" };
  if (p.conn === "connected") return { state: "connected", text: "" };
  const why = p.connError ? ` · ${p.connError}` : "";
  return { state: p.conn, text: p.conn === "offline" ? `offline${why} · tap to retry` : p.conn === "error" ? `error${why}` : "connecting…" };
}

/**
 * The link for one address. The browser keeps the token per address, so a
 * link to another address carries it; the page there stores it and drops it
 * from the URL. A tailnet address needs none: `whois` vouches for the phone.
 */
export function addressLink(a: WebAddress, token: string): string {
  return a.kind === "tailnet" ? a.url : `${a.url}?token=${token}`;
}

/** True when `url` is the address this page was opened at. */
export function isCurrentAddress(url: string, origin: string): boolean {
  return url.replace(/\/$/, "").toLowerCase() === origin.replace(/\/$/, "").toLowerCase();
}

/** One line for an update's progress: the step that runs, or how it ended. */
export function updateLabel(u: MachineUpdate | null): string {
  if (!u) return "";
  if (u.state === "failed") return `update failed: ${u.error ?? "see the daemon log"}`;
  if (u.state === "succeeded") return `updated${u.toCommit ? ` to ${u.toCommit}` : ""}`;
  if (u.state === "restarting") return "restarting…";
  const step = u.steps.find((s) => s.status === "running");
  return step ? `${step.label}…` : `update: ${u.state}`;
}

/** The words for a bind mode, the same ones the TUI's panel uses. */
export function bindLabel(bind: string | undefined): string {
  switch (bind) {
    case "tailnet": return "tailnet only";
    case "all": return "tailnet and LAN";
    case "loopback": return "this machine only";
    case undefined: return "unknown";
    default: return bind;
  }
}

/** `now`, `5m`, `3h`, `2d`: the same words the TUI's sidebar uses. */
export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const d = now - Date.parse(iso);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/** What the header says about a thread: the turn, then the session. */
export function threadStatusLabel(t: Thread): string {
  if (t.pendingApprovals > 0) return "needs approval";
  if (t.status === "waiting") return "waiting for you";
  if (t.latestTurn?.state === "running") return t.queuedTurns > 0 ? `working · ${t.queuedTurns} queued` : "working";
  if (t.status === "starting") return "starting";
  if (t.status === "error" || t.latestTurn?.state === "error") return t.lastError ? `error: ${t.lastError}` : "error";
  if (t.latestTurn?.state === "interrupted") return "interrupted";
  return "idle";
}

// ---------------------------------------------------------------------------
// The URL
// ---------------------------------------------------------------------------

/**
 * What the hash names: a thread, `#/t/<machine>/<thread>`; an issue or a pull
 * request, `#/gh/<machine>/<project>/<number>`; or the list, no hash. The
 * browser's back control, a swipe from the edge and a reload all read it.
 */
export type Route =
  | { kind: "thread"; machine: string; threadId: string }
  | { kind: "item"; machine: string; projectId: string; number: number }
  | null;

export function routeOf(hash: string): Route {
  const t = /^#\/t\/([^/]+)\/([^/]+)$/.exec(hash);
  if (t) return { kind: "thread", machine: decodeURIComponent(t[1]!), threadId: decodeURIComponent(t[2]!) };
  const i = /^#\/gh\/([^/]+)\/([^/]+)\/(\d+)$/.exec(hash);
  if (i) return { kind: "item", machine: decodeURIComponent(i[1]!), projectId: decodeURIComponent(i[2]!), number: Number(i[3]) };
  return null;
}

export function threadHash(machine: string, threadId: string): string {
  return `#/t/${encodeURIComponent(machine)}/${encodeURIComponent(threadId)}`;
}

export function itemHash(machine: string, projectId: string, number: number): string {
  return `#/gh/${encodeURIComponent(machine)}/${encodeURIComponent(projectId)}/${number}`;
}

// ---------------------------------------------------------------------------
// An issue or a pull request (#108)
// ---------------------------------------------------------------------------

/**
 * A `#N` in prose: the start of the text or a space or a bracket before it,
 * and no word character after it. Five digits at most, so a hex colour such
 * as `#123456` stays text. Global, so a caller resets `lastIndex` or uses
 * `matchAll`.
 */
export const REF = /(^|[\s([{,;:])#(\d{1,5})(?![\w-])/g;

/** The `#N` references in one piece of text, as offsets, so a renderer can split it. */
export function findRefs(text: string): { start: number; end: number; number: number }[] {
  const out: { start: number; end: number; number: number }[] = [];
  for (const m of text.matchAll(REF)) {
    const start = m.index + m[1]!.length;
    out.push({ start, end: start + 1 + m[2]!.length, number: Number(m[2]) });
  }
  return out;
}

/**
 * The issue a thread took and the pull request it opened. `label` is the chip
 * on the row, short enough to sit in one line of text. `menuLabel` is the row
 * of the sheet a hold opens (#115), where there is room to say what it is.
 */
export function threadRefs(t: Thread): ItemRef[] {
  const out: ItemRef[] = [];
  if (t.issue) out.push({ kind: "issue", number: t.issue.number, label: `#${t.issue.number}`, menuLabel: `View issue #${t.issue.number}` });
  const pull = t.pullRequest?.number ?? t.watch?.number;
  if (pull) out.push({ kind: "pull", number: pull, label: `PR #${pull}`, menuLabel: `View pull request #${pull}` });
  return out;
}

/** One reference a thread holds, as `threadRefs` reports it. */
export interface ItemRef { kind: "issue" | "pull"; number: number; label: string; menuLabel: string }

/** One word for the state of an item, as the chip on the item screen says it. */
export function itemStateLabel(item: GitHubItem): "open" | "closed" | "merged" | "draft" {
  if (item.kind === "pull") {
    if (item.state === "MERGED") return "merged";
    if (item.state === "CLOSED") return "closed";
    return item.isDraft ? "draft" : "open";
  }
  return item.state === "CLOSED" ? "closed" : "open";
}

/** What the checks add up to: the worst state wins, and no checks is nothing to say. */
export function checksLabel(item: GitHubPullRequest): { state: "success" | "failure" | "pending" | "none"; text: string } {
  const c = item.checks;
  if (c.length === 0) return { state: "none", text: "no checks" };
  const failed = c.filter((x) => x.state === "failure").length;
  const pending = c.filter((x) => x.state === "pending").length;
  const passed = c.filter((x) => x.state === "success").length;
  if (failed) return { state: "failure", text: `${failed} of ${c.length} checks failed` };
  if (pending) return { state: "pending", text: `${pending} of ${c.length} checks running` };
  return { state: "success", text: passed === c.length ? `${c.length} checks passed` : `${passed} passed, ${c.length - passed} skipped` };
}

/** The acts the item screen offers, by kind and state. A merged pull request takes a comment and nothing else. */
export function itemActions(item: GitHubItem): { action: GitHubAction; label: string; tone: "primary" | "danger" | "" ; needsBody: boolean }[] {
  const comment = { action: { kind: "comment", body: "" } as GitHubAction, label: "Comment", tone: "" as const, needsBody: true };
  if (item.kind === "pull") {
    if (item.state === "MERGED") return [comment];
    if (item.state === "CLOSED") return [comment, { action: { kind: "reopen" }, label: "Reopen", tone: "", needsBody: false }];
    return [
      { action: { kind: "review", event: "approve" }, label: "Approve", tone: "primary", needsBody: false },
      { action: { kind: "review", event: "request_changes" }, label: "Request changes", tone: "danger", needsBody: true },
      comment,
      { action: { kind: "merge", method: "merge" }, label: "Merge", tone: "primary", needsBody: false },
      { action: { kind: "close" }, label: "Close", tone: "danger", needsBody: false },
    ];
  }
  if (item.state === "CLOSED") return [comment, { action: { kind: "reopen" }, label: "Reopen", tone: "", needsBody: false }];
  return [comment, { action: { kind: "close" }, label: "Close", tone: "danger", needsBody: false }];
}

/** The live thread on `machine` that took the issue or opened the pull request, if one did. */
export function holderOf(s: State, machine: string, projectId: string, number: number): Thread | null {
  const m = s.machines.get(machine);
  if (!m) return null;
  for (const t of m.threads.values()) {
    if (t.projectId !== projectId || t.archivedAt || t.movedTo) continue;
    if (t.issue?.number === number || t.pullRequest?.number === number || t.watch?.number === number) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Media (#110)
// ---------------------------------------------------------------------------

/**
 * True when GitHub serves the URL only to the account: a user attachment, or
 * the image host GitHub rewrites one to. Those go through the daemon, which
 * holds the token; any other image loads as it is.
 */
export function isGitHubAttachment(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.hostname === "github.com") return u.pathname.startsWith("/user-attachments/assets/");
  return u.hostname === "private-user-images.githubusercontent.com" || u.hostname === "user-images.githubusercontent.com";
}

/**
 * Where the page loads a piece of media from: the daemon's media route for a
 * GitHub attachment, with the page's token when it has one, else the URL
 * itself. The route answers with the signed link GitHub gives the token.
 */
export function mediaSrc(url: string, token: string | undefined): string {
  if (!isGitHubAttachment(url)) return url;
  return `/media?url=${encodeURIComponent(url)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
}

/** What a bare URL on a line of its own is, by its extension, or by being a GitHub attachment, which is a video when it is not an image. */
export function mediaKind(url: string): "image" | "video" | null {
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm|m4v)$/.test(path)) return "video";
  // GitHub puts an image in `![]()` or `<img>`, and a video as a bare URL.
  if (isGitHubAttachment(url) && new URL(url).hostname === "github.com") return "video";
  return null;
}
