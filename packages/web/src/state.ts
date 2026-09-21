/**
 * What the page knows, and how a daemon's events change it.
 *
 * This file has no DOM in it, so node can test it. The fold is the same one
 * the TUI store does: a project, a thread, a run and a timeline item each
 * arrive whole under a stable id, and the newest copy replaces the old one.
 * There is no delta channel, and that is what makes a reconnect free — the
 * subscription replays what the phone slept through, and the replay folds in
 * exactly as a live event would.
 */
import {
  threadIsBusy,
  type MachineAccess, type MachineInfo, type Project, type ShellEvent, type ShellSnapshot, type SlashCommandInfo, type Thread, type ThreadEvent,
  type ThreadSnapshot, type TimelineItem, type WebAddress,
} from "@covey/protocol";
import type { ConnState } from "@covey/client";

export interface View {
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

export interface State {
  conn: ConnState;
  connError: string | null;
  info: MachineInfo | null;
  projects: Map<string, Project>;
  threads: Map<string, Thread>;
  /** Projects the reader folded shut, by id. */
  folded: Set<string>;
  /** The thread on screen, or null for the list. */
  view: View | null;
  /** Draft text per thread, kept while the reader browses. */
  drafts: Map<string, string>;
  /** The token and the other addresses of this daemon, once asked for. */
  access: MachineAccess | null;
  /** The addresses panel is open over the list. */
  showAddresses: boolean;
}

export function emptyState(): State {
  return { conn: "connecting", connError: null, info: null, projects: new Map(), threads: new Map(), folded: new Set(), view: null, drafts: new Map(), access: null, showAddresses: false };
}

export function applyShellSnapshot(s: State, snap: ShellSnapshot): void {
  s.info = snap.machine;
  s.projects = new Map(snap.projects.map((p) => [p.id, p]));
  s.threads = new Map(snap.threads.map((t) => [t.id, t]));
}

export function applyShellEvent(s: State, ev: ShellEvent): void {
  switch (ev.kind) {
    case "machine.updated": s.info = ev.machine; break;
    case "project.upserted": s.projects.set(ev.project.id, ev.project); break;
    case "project.removed": s.projects.delete(ev.projectId); break;
    case "thread.upserted":
      s.threads.set(ev.thread.id, ev.thread);
      if (s.view?.threadId === ev.thread.id) s.view.thread = ev.thread;
      break;
    case "thread.removed":
      s.threads.delete(ev.threadId);
      break;
    // Runs are not on the phone yet. Their members are threads, and those
    // arrive on their own.
    case "run.upserted": case "run.removed": break;
  }
}

export function openView(s: State, threadId: string): View {
  const v: View = { threadId, thread: s.threads.get(threadId) ?? null, items: new Map(), seq: 0, hasMore: false, loading: true, error: null, commands: null };
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

/** Fold one event into the open view. An event for another thread is dropped. */
export function applyThreadEvent(s: State, threadId: string, ev: ThreadEvent): boolean {
  const v = s.view;
  if (!v || v.threadId !== threadId) return false;
  switch (ev.kind) {
    case "item.upserted": v.items.set(ev.item.id, ev.item); break;
    case "item.removed": v.items.delete(ev.itemId); break;
    case "thread.updated": v.thread = ev.thread; s.threads.set(ev.thread.id, ev.thread); break;
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

export interface ProjectRow {
  project: Project;
  threads: Thread[];
  /** How many of its threads are at work or wait on the reader. */
  active: number;
  waiting: number;
}

/**
 * The list screen: every project with its live threads, newest first, pinned
 * ones at the top. Archived threads and tombstones of moved ones stay out —
 * the phone is for what is going on, not for the record.
 */
export function projectRows(s: State): ProjectRow[] {
  const byProject = new Map<string, Thread[]>();
  for (const t of s.threads.values()) {
    if (t.archivedAt || t.movedTo) continue;
    const list = byProject.get(t.projectId) ?? [];
    list.push(t);
    byProject.set(t.projectId, list);
  }
  const rows: ProjectRow[] = [];
  for (const project of [...s.projects.values()].sort((a, b) => a.title.localeCompare(b.title))) {
    const threads = (byProject.get(project.id) ?? []).sort(byRecency);
    rows.push({
      project,
      threads,
      active: threads.filter(threadIsBusy).length,
      waiting: threads.filter((t) => threadTone(t) === "waiting").length,
    });
  }
  return rows;
}

function byRecency(a: Thread, b: Thread): number {
  if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
  return (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt);
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
