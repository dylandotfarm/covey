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
  KNOWN_MODELS, modelIsCurrent, modelLabel, modelVersion, threadIsBusy,
  type GitHubAction, type GitHubItem, type GitHubPullRequest, type MachineAccess, type MachineInfo, type MachineSettings, type MachineUpdate, type ModelChoice, type PermissionMode, type Project, type ShellEvent, type ShellSnapshot, type SlashCommandInfo, type Thread, type ThreadEvent,
  type ThreadSnapshot, type TimelineItem, type WebAddress, isImageMime, type Attachment,
} from "@covey/protocol";
import { keepTagged, projectPool, type ConnState, type TaggedAttachment } from "@covey/client";

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
  /**
   * The token this machine's addresses need, when they need one. The socket
   * takes it at the dial; `/file` and `/media` take it on the URL, because an
   * `<img>` carries no header (#135).
   */
  token?: string;
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
  /**
   * The files waiting to go with a draft, per `machine:thread` (#135).
   *
   * Each carries the tag that stands for it in the draft, and the tag is the
   * only record: delete the word and the file does not go. The same rule the
   * TUI keeps, in the same code — `@covey/client` holds it.
   */
  attachments: Map<string, TaggedAttachment[]>;
  /**
   * What the composer says while it is busy with files: reading them, or
   * sending them. A phone on a mobile link takes seconds over 4 MB, and a
   * composer that looks idle meanwhile is a composer the reader taps again.
   */
  attaching: string | null;
  /** The token and the other addresses of the primary daemon, once asked for. */
  access: MachineAccess | null;
  /** The settings panel is open over the list. */
  showAddresses: boolean;
  /** A project group the reader is picking a machine for, to start a thread. */
  choosing: string | null;
  /** The settings sheet over the page, or null when none is open. */
  sheet: SheetState | null;
}

export function emptyState(): State {
  return { machines: new Map(), folded: new Set(), view: null, item: null, drafts: new Map(), attachments: new Map(), attaching: null, access: null, showAddresses: false, choosing: null, sheet: null };
}

export function addMachine(s: State, key: string, name: string, primary = false, token?: string): MachineSlot {
  const slot: MachineSlot = { key, name, conn: "connecting", connError: null, info: null, projects: new Map(), threads: new Map(), primary, update: null, token };
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
 * One row of the list: a repository on one base branch, wherever it is checked
 * out. Two machines that hold the same repository on the same base are one
 * row, the way the TUI's sidebar shows one project with a pool of machines. A
 * project with no remote is its own row, keyed by its machine and id, because
 * nothing says it is the same as any other.
 *
 * Two projects of one repository that work from different branches are two
 * rows. They hold different work, and the reader must see which base the
 * threads in front of them start from.
 */
export interface ProjectRow {
  key: string;
  title: string;
  /** The branch its threads start from, or null for the remote's default. */
  base: string | null;
  homes: ProjectHome[];
  threads: ThreadRef[];
  /** How many of its threads are at work or wait on the reader. */
  active: number;
  waiting: number;
}

export function projectKey(machine: string, p: Project): string {
  const pool = projectPool(p);
  return pool ? `repo:${pool}` : `local:${machine}:${p.id}`;
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
  const row = (key: string, title: string, base: string | null = null) => {
    let r = rows.get(key);
    if (!r) { r = { key, title, base, homes: [], threads: [], active: 0, waiting: 0 }; rows.set(key, r); }
    return r;
  };
  for (const m of s.machines.values()) {
    for (const p of m.projects.values()) {
      const r = row(projectKey(m.key, p), p.title, p.baseBranch ?? null);
      r.homes.push({ machine: m.key, machineName: m.name, conn: m.conn, project: p });
    }
    for (const t of m.threads.values()) {
      if (t.archivedAt || t.movedTo) continue;
      const p = m.projects.get(t.projectId);
      const r = p ? row(projectKey(m.key, p), p.title, p.baseBranch ?? null) : row(`orphan:${m.key}:${t.projectId}`, "(project not listed)");
      r.threads.push({ machine: m.key, machineName: m.name, thread: t });
    }
  }
  // Two rows of one repository carry one title, so the base breaks the tie and
  // the order is the same on every paint. The row on the remote's default
  // branch sorts first.
  const out = [...rows.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.base ?? "").localeCompare(b.base ?? ""));
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
 * of the sheet (#115), where there is room to say what it is.
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

/** What the id of a sheet row that opens an item starts with; the number follows. */
export const VIEW_ROW = "view:";

/** The item a sheet row opens, or null when the row is a setting. */
export function viewRowNumber(id: string): number | null {
  if (!id.startsWith(VIEW_ROW)) return null;
  const n = Number(id.slice(VIEW_ROW.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

// ---------------------------------------------------------------------------
// The files waiting on a draft (#135)
// ---------------------------------------------------------------------------

/** The key a draft and its files are held under. One thread on one machine. */
export function composerKey(machine: string, threadId: string): string {
  return `${machine}:${threadId}`;
}

/** The files waiting to go with a thread's draft. */
export function pendingAttachments(s: State, machine: string, threadId: string): TaggedAttachment[] {
  return s.attachments.get(composerKey(machine, threadId)) ?? [];
}

export function setPendingAttachments(s: State, machine: string, threadId: string, atts: TaggedAttachment[]): void {
  const key = composerKey(machine, threadId);
  if (atts.length === 0) s.attachments.delete(key);
  else s.attachments.set(key, atts);
}

/**
 * Drop the files whose tag the reader deleted from the draft. The tag is the
 * only record of a file in the text, so no tag means no attachment.
 */
export function syncAttachments(s: State, machine: string, threadId: string, text: string): TaggedAttachment[] {
  const cur = pendingAttachments(s, machine, threadId);
  if (cur.length === 0) return cur;
  const kept = keepTagged(text, cur);
  if (kept.length !== cur.length) setPendingAttachments(s, machine, threadId, kept);
  return kept;
}

/**
 * What of a pending list goes over the wire: the files, without the tag that
 * named them in the draft, and without the chips that stand for a file that
 * never attached — those have no bytes behind them.
 */
export function sendableAttachments(atts: TaggedAttachment[]): Attachment[] {
  return atts.filter((a) => !a.failed).map(({ tag: _tag, failed: _failed, ...a }) => a);
}

/** How many bytes a list of attachments would send, base64 counted back to bytes. */
export function pendingBytes(atts: Attachment[]): number {
  return atts.reduce((n, a) => n + Math.floor(((a.data ?? "").length * 3) / 4), 0);
}

/** A machine's `ws://` key as the `http://` origin its routes answer on. */
export function httpBase(key: string): string {
  return key.replace(/^ws/, "http");
}

/**
 * Where the bytes of a file dropped on a thread are (#135).
 *
 * The daemon that holds the thread serves them, which need not be the daemon
 * that served the page, so the URL is absolute and carries that machine's own
 * token: an `<img>` sends no header.
 */
export function threadFileSrc(m: MachineSlot | undefined, threadId: string, path: string): string {
  if (!m) return "";
  const q = new URLSearchParams({ thread: threadId, path });
  if (m.token) q.set("token", m.token);
  return `${httpBase(m.key)}/file?${q.toString()}`;
}

/** What a dropped file is on the screen: a picture, a video, or a name to tap. */
export function attachmentKind(a: Attachment): "image" | "video" | "file" {
  if (a.dir) return "file";
  if (isImageMime(a.mimeType)) return "image";
  if (a.mimeType.startsWith("video/")) return "video";
  return "file";
}

/**
 * The attachments of a user message, one row each, with a dropped directory
 * folded back into the one thing the reader dropped.
 */
export function attachmentRows(atts: Attachment[]): { key: string; label: string; kind: "image" | "video" | "file"; att: Attachment }[] {
  const out: { key: string; label: string; kind: "image" | "video" | "file"; att: Attachment }[] = [];
  const dirs = new Map<string, number>();
  for (const a of atts) {
    if (a.dir) {
      dirs.set(a.dir, (dirs.get(a.dir) ?? 0) + 1);
      continue;
    }
    out.push({ key: a.path || a.name, label: a.name, kind: attachmentKind(a), att: a });
  }
  for (const [dir, n] of dirs) {
    out.push({ key: `dir:${dir}`, label: `${dir}/ (${n} file${n === 1 ? "" : "s"})`, kind: "file", att: { name: dir, path: "", mimeType: "" } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The settings sheet (#117)
// ---------------------------------------------------------------------------
//
// The phone had no way to change a setting. A conversation ran on whatever
// model its machine gave it, and the machine's own defaults were a TUI-only
// panel. Both now open the same sheet: a list of settings, and one page of
// choices per setting. This file holds what the sheet says; `render.ts` paints
// it and `main.ts` turns a choice into a command.

/** What a sheet is about: one conversation, or one machine. */
export type SheetTarget =
  | { kind: "thread"; machine: string; threadId: string }
  | { kind: "machine"; machine: string };

export interface SheetState {
  target: SheetTarget;
  /** `""` is the list of settings. Anything else is the choices of that setting. */
  page: string;
}

/** One row of the list of settings. */
export interface SheetRow {
  id: string;
  label: string;
  /** What the setting is now, at the right of the row. */
  value?: string;
  /** The row opens a page of choices. Without it the row acts at once. */
  choices?: boolean;
  tone?: "danger";
}

/** One row of a page of choices. */
export interface SheetChoice {
  id: string;
  label: string;
  hint?: string;
  /** The value in force, ticked. */
  current: boolean;
}

/**
 * The models a machine offers, as its Claude Code reports them. The built-in
 * list stands in for a daemon too old to send one, and for the moment before
 * that daemon's first read answers.
 */
export function machineModels(m: MachineSlot | null | undefined): ModelChoice[] {
  return m?.info?.models ?? KNOWN_MODELS;
}

/** The words for a permission mode, the same ones the TUI's panel uses. */
export function permissionModeLabel(mode: PermissionMode | null | undefined): string {
  switch (mode) {
    case "default": return "Manual";
    case "acceptEdits": return "Auto";
    case "bypassPermissions": return "Bypass";
    case "plan": return "Plan";
    default: return "From Claude settings";
  }
}

const MODE_ORDER: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

const MODE_HINT: Record<PermissionMode, string> = {
  default: "approve every tool",
  acceptEdits: "file edits go through, other tools ask",
  bypassPermissions: "never ask",
  plan: "plan first, change nothing",
};

/**
 * The models to choose from, the one in force ticked.
 *
 * The rows come from the machine, so a phone dialling two machines is offered
 * what each one can actually run. `inherited` says what the first row — no
 * model of its own — ends up being, which is how the reader tells one Opus
 * from the next.
 */
export function modelChoices(current: string | null | undefined, models: ModelChoice[], inherited?: string): SheetChoice[] {
  return [
    // A machine that has not said what its default resolves to leaves the row
    // saying only where the setting comes from — `modelVersion` answers "" there.
    { id: "", label: "From Claude settings", hint: inherited || "the model the machine's Claude settings pick", current: !current },
    ...models.map((k) => ({ id: k.id, label: k.label, hint: k.description ?? k.id, current: modelIsCurrent(k, current) })),
  ];
}

/**
 * The permission modes to choose from. A machine may also have no opinion, and
 * then its threads take the mode from the user's own Claude settings; a thread
 * always runs in one mode, so its page offers no such row.
 */
export function modeChoices(current: PermissionMode | null | undefined, withDefault: boolean): SheetChoice[] {
  const modes = MODE_ORDER.map((m) => ({ id: m, label: permissionModeLabel(m), hint: MODE_HINT[m], current: m === current }));
  if (!withDefault) return modes;
  return [{ id: "", label: permissionModeLabel(null), hint: "permissions.defaultMode", current: !current }, ...modes];
}

/** An on/off setting as two rows, so it reads the same way as the rest. */
export function onOffChoices(on: boolean, onHint: string, offHint: string): SheetChoice[] {
  return [
    { id: "on", label: "On", hint: onHint, current: on },
    { id: "off", label: "Off", hint: offHint, current: !on },
  ];
}

/** The thread a sheet is about, or null when it is about a machine or the thread is gone. */
export function sheetThread(s: State, sheet: SheetState): Thread | null {
  if (sheet.target.kind !== "thread") return null;
  return s.machines.get(sheet.target.machine)?.threads.get(sheet.target.threadId) ?? null;
}

/** The machine a sheet is about, whichever kind it is. */
export function sheetMachine(s: State, sheet: SheetState): MachineSlot | undefined {
  return s.machines.get(sheet.target.machine);
}

const NO_SETTINGS: MachineSettings = { defaultModel: null, defaultPermissionMode: null, defaultStreaming: null };

/**
 * What a thread with no model of its own ends up running there: the project's
 * default, else the machine's, else whatever Claude Code itself picks. It is
 * the hint under the first row of the model page, so "From Claude settings"
 * says which model that is rather than leaving the reader to guess.
 */
export function inheritedModel(s: State, sheet: SheetState): string | undefined {
  const m = sheetMachine(s, sheet);
  const t = sheetThread(s, sheet);
  const pinned = (t && m?.projects.get(t.projectId)?.defaultModel) || m?.info?.settings?.defaultModel || null;
  return pinned ? modelLabel(pinned, machineModels(m)) : modelVersion(m?.info?.claudeDefaultModel);
}

/** The settings of a sheet's machine, or empty ones while it is not connected. */
export function sheetSettings(s: State, sheet: SheetState): MachineSettings {
  return sheetMachine(s, sheet)?.info?.settings ?? NO_SETTINGS;
}

/** The settings of one conversation. */
export function threadSheetRows(t: Thread, models: ModelChoice[] = KNOWN_MODELS): SheetRow[] {
  return [
    // The chips in the list are text, so the sheet is the way to the item (#115).
    ...threadRefs(t).map((r) => ({ id: `${VIEW_ROW}${r.number}`, label: r.menuLabel })),
    { id: "model", label: "Model", value: modelLabel(t.model, models), choices: true },
    { id: "mode", label: "Permission mode", value: permissionModeLabel(t.permissionMode), choices: true },
    { id: "streaming", label: "Streaming", value: t.streaming ? "On" : "Off", choices: true },
    { id: "rename", label: "Rename conversation" },
    { id: "archive", label: "Archive conversation", tone: "danger" },
  ];
}

/**
 * The defaults of one machine. Every new thread there inherits them; a thread
 * that already runs keeps what it has.
 *
 * The web server row is left off the machine that serves this page: to turn it
 * off there is to close the page, and a row that ends the session it is tapped
 * in is a trap, not a setting.
 */
export function machineSheetRows(m: MachineSlot): SheetRow[] {
  const g = m.info?.settings ?? NO_SETTINGS;
  const rows: SheetRow[] = [
    { id: "model", label: "Default model", value: modelLabel(g.defaultModel, machineModels(m)), choices: true },
    { id: "mode", label: "Default mode", value: permissionModeLabel(g.defaultPermissionMode), choices: true },
    { id: "streaming", label: "Default streaming", value: g.defaultStreaming ? "On" : "Off", choices: true },
  ];
  if (!m.primary) rows.push({ id: "web", label: "Web server", value: g.webEnabled ? "On" : "Off", choices: true });
  return rows;
}

/** The rows of the list of settings, for whichever sheet is open. */
export function sheetRows(s: State, sheet: SheetState): SheetRow[] {
  if (sheet.target.kind === "thread") {
    const t = sheetThread(s, sheet);
    return t ? threadSheetRows(t, machineModels(sheetMachine(s, sheet))) : [];
  }
  const m = sheetMachine(s, sheet);
  return m ? machineSheetRows(m) : [];
}

/** The choices of the page a sheet is on. An unknown page has none. */
export function sheetChoices(s: State, sheet: SheetState): SheetChoice[] {
  if (sheet.target.kind === "thread") {
    const t = sheetThread(s, sheet);
    if (!t) return [];
    switch (sheet.page) {
      case "model": return modelChoices(t.model, machineModels(sheetMachine(s, sheet)), inheritedModel(s, sheet));
      case "mode": return modeChoices(t.permissionMode, false);
      case "streaming": return onOffChoices(t.streaming === true, "text arrives word by word", "each reply lands whole");
      default: return [];
    }
  }
  const m = sheetMachine(s, sheet);
  const g = sheetSettings(s, sheet);
  switch (sheet.page) {
    // Not `inheritedModel`: the row being unset here *is* the machine default,
    // so what it falls back to is Claude Code's own pick and nothing else.
    case "model": return modelChoices(g.defaultModel, machineModels(m), modelVersion(m?.info?.claudeDefaultModel));
    case "mode": return modeChoices(g.defaultPermissionMode, true);
    case "streaming": return onOffChoices(g.defaultStreaming === true, "new threads show text as it arrives", "new threads show each reply whole");
    case "web": return onOffChoices(g.webEnabled === true, "this machine serves the phone client", "this machine serves nothing");
    default: return [];
  }
}

/** What the head of the sheet says: the thing, then the setting being changed. */
export function sheetTitle(s: State, sheet: SheetState): string {
  const rows = sheetRows(s, sheet);
  const open = sheet.page ? rows.find((r) => r.id === sheet.page) : undefined;
  if (open) return open.label;
  if (sheet.target.kind === "thread") return sheetThread(s, sheet)?.title ?? "Conversation";
  return sheetMachine(s, sheet)?.name ?? "Machine";
}

/**
 * One line under the head, or `""` for none. A machine's sheet holds defaults,
 * and a default is not the setting a running thread has; the caption says so
 * where the reader is about to change one.
 */
export function sheetNote(s: State, sheet: SheetState): string {
  if (sheet.target.kind !== "machine") return "";
  const name = sheetMachine(s, sheet)?.name ?? "this machine";
  return sheet.page === "web"
    ? `Whether ${name} serves the phone client.`
    : `Every new thread on ${name} starts with this. A thread that runs keeps what it has.`;
}

/**
 * Everything on the open sheet, as one string. The renderer keeps the last one
 * and rebuilds only when it changes: a paint runs on every frame of a turn,
 * and a sheet rebuilt under a finger loses the tap.
 */
export function sheetKey(s: State, sheet: SheetState): string {
  const t = sheet.target;
  const head = [t.kind, t.machine, t.kind === "thread" ? t.threadId : "", sheet.page, sheetTitle(s, sheet), sheetNote(s, sheet)];
  const body = sheet.page
    ? sheetChoices(s, sheet).map((c) => `${c.id}:${c.current ? 1 : 0}`)
    : sheetRows(s, sheet).map((r) => `${r.id}:${r.value ?? ""}`);
  return [...head, ...body].join("|");
}
