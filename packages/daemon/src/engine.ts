import { randomUUID } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { existsSync, statSync, rmSync, readdirSync } from "node:fs";
import type {
  Command, CommandEnvelope, Project, Run, RunMember, Thread, TimelineItem, ToolCallItem, ShellEvent, ThreadEvent,
  ShellSnapshot, ThreadSnapshot, MachineInfo, MachineResources, ThreadExport, PermissionMode, ShellEventBody, ThreadEventBody,
  ThreadOrigin,
} from "@covey/protocol";
import { isUserClient } from "@covey/protocol";
import { Db } from "./db.js";
import { ClaudeSession, type SessionSink, type QueryFactory } from "./claude.js";
import { makeSessionStore } from "./sessionStore.js";
import { normaliseRemote, projectSlug, remoteUrl, currentBranch, createWorktree, removeWorktree, restoreWorktree, isGitRepo, gitInfo, defaultBranchRef, cleanStartBase, cleanStartNote, cloneBare, fetchBranch, worktreePath, captureCheckpoint, diffCheckpoints, patchBetween, deleteCheckpointRefs, restoreTree, type CleanStart } from "./git.js";
import { materialiseAttachments, attachmentsDir } from "./attachments.js";
import { resolveDefaultPermissionMode, saveMachineSettings, defaultLiveSessionLimit, DEFAULT_SESSION_IDLE_MINUTES, projectsDir } from "./config.js";
import { generateTitle, fallbackTitle } from "./title.js";
import { isAuthFailure, credentialStamp } from "./auth.js";
import type { Attachment, TurnDiff, ProjectGit, SlashCommandInfo, PathEntry, TurnUsage, UsageGroupBy, UsageQuery, UsageReport, RunIssue, RunPullRequest, AuditFinding, GateVerdict, MemberDiff, MergeParty, QueueEntryWire, QueuePosition, RegressionEvidence, RunMemberRef, RunMemberState, PullRequestWatch, WatchState, MergePolicy, MergeMethod } from "@covey/protocol";
import { readIssues, pullRequestFor } from "./gh.js";
import { realGhHost, type GhHost, type RealHostOptions } from "./integrate/gh.js";
import { gateMember } from "./integrate/gate.js";
import { buildQueue } from "./integrate/queue.js";
import { findingFor } from "./integrate/audit.js";
import { mergeMember } from "./integrate/merge.js";
import { news, emptyCursor, describeNews, asksForWork, endsWatch, mergeReadiness, pollDelayMs, WATCH_MAX_MS, DEFAULT_MAX_ROUNDS, type WatchEvent } from "./integrate/news.js";

export class EngineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** A placed member, before anything has been dispatched to it. */
function newMember(init: import("@covey/protocol").RunMemberInit, now: string): RunMember {
  return {
    id: init.id,
    task: init.task,
    machineId: init.machineId,
    projectId: init.projectId,
    threadId: null,
    branch: null,
    worktreePath: null,
    pullRequest: null,
    state: "planned",
    note: init.note ?? null,
    resources: init.resources,
    brief: null,
    dispatchedAt: null,
    updatedAt: now,
    review: null,
  };
}

type ShellListener = (ev: ShellEvent) => void;
type ThreadListener = (threadId: string, ev: ThreadEvent) => void;

/** How often the daemon looks for sessions nobody needs. */
const SWEEP_INTERVAL_MS = 30_000;

/** How often the daemon looks for a pull request watch that is due a poll. */
const WATCH_TICK_MS = 15_000;

export interface EngineOptions {
  /** How a session reaches the SDK. A test hands in a stand-in, so nothing
   *  spawns a Claude subprocess. */
  spawn?: QueryFactory;
  /** How the engine reaches `gh` and `git` for a run and for a watch. A test
   *  hands in a fake, so nothing reaches GitHub and nothing opens a pull
   *  request. */
  ghHost?: (options: RealHostOptions) => GhHost;
  /** The clock the idle sweep reads, in milliseconds. A test moves it by hand. */
  now?: () => number;
  /** Where the daemon writes its own lines. */
  log?: (m: string) => void;
  /** The fingerprint of the credential store. A test hands in a stand-in, so
   *  a rotation is a variable rather than a login. */
  credentialStamp?: () => Promise<string | null>;
}

/**
 * The daemon's brain. Owns the db, live sessions, sequencing and fan-out.
 * Commands mutate projections + append events in one transaction, then
 * listeners are notified (never before commit).
 */
export class Engine {
  private sessions = new Map<string, ClaudeSession>();
  /** When each live session was last of use, in milliseconds. The idle sweep
   *  and the live-session budget both read it. */
  private touchedAt = new Map<string, number>();
  /** Threads whose session this daemon released while they were idle, so the
   *  turn that starts one again can say where the wait comes from. Memory
   *  only: after a restart nothing here was released, it simply never ran. */
  private released = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Turns waiting behind a running one, per thread. */
  private queues = new Map<string, { turnId: string; text: string; attachments: Attachment[] }[]>();
  private shellListeners = new Set<ShellListener>();
  private threadListeners = new Set<ThreadListener>();
  /** Per-item throttle for streaming upserts. */
  private streamTimers = new Map<string, { latest: TimelineItem; timer: NodeJS.Timeout }>();
  /** Title queries in flight, so a requeue cannot start a second and a
   *  shutdown can cancel the one already running. */
  private titling = new Map<string, AbortController>();
  /**
   * Threads whose last turn died on the credentials. `scheduled` holds the one
   * restart this daemon sends, so a second failure cannot make a thread talk
   * to itself; `spent` says that restart has gone and the next failure is the
   * user's to fix; `told` says the thread has been given the command that
   * fixes it. A turn that completes clears the entry.
   */
  private authRetry = new Map<string, "scheduled" | "spent" | "told">();
  /** The restarts waiting on their tick, so a shutdown can drop them. */
  private retryTimers = new Map<string, NodeJS.Timeout>();
  /** What the credential store looked like when we last read it. */
  private credStamp: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /** Threads whose watch is being polled right now, so a slow `gh` is not
   *  asked twice. */
  private polling = new Set<string>();
  private sessionStore;

  constructor(readonly db: Db, readonly machine: MachineInfo, private opts: EngineOptions = {}) {
    this.sessionStore = makeSessionStore(db);
    // Anything that was running when we last exited is now idle.
    for (const t of db.listThreads()) {
      const queued = db.flaggedUserItems(t.id, "queued");
      if (queued.length) this.queues.set(t.id, queued.map((i) => ({ turnId: i.turnId!, text: (i as any).text, attachments: (i as any).attachments ?? [] })));
      // A message folded into a turn that no longer exists was never read. It
      // keeps its place in the transcript, but nothing is coming for it.
      for (const i of db.flaggedUserItems(t.id, "folded")) { delete (i as any).folded; db.putItem(i); }
      const latestTurn = t.latestTurn?.state === "running" ? { ...t.latestTurn, state: "interrupted" as const, completedAt: new Date().toISOString() } : t.latestTurn;
      if (t.status !== "idle" && t.status !== "error" || latestTurn !== t.latestTurn) this.db.putThread({ ...t, status: "idle", latestTurn, queuedTurns: queued.length });
    }
    // `unref` so the sweep never holds the process open: a daemon with no work
    // left must still exit, and a test must not wait on this timer.
    this.sweepTimer = setInterval(() => { this.sweepSessions(); void this.checkCredentials(); }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    // The watches live in the thread rows, so a restart resumes every one of
    // them from its cursor: the tick reads the rows, and nothing is re-armed.
    this.watchTimer = setInterval(() => { void this.pollWatches(); }, WATCH_TICK_MS);
    this.watchTimer.unref?.();
  }

  /** Where this daemon keeps its clones: what the machine reports, else the default. */
  get projectsDir(): string { return this.machine.projectsDir ?? projectsDir(); }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  onShell(l: ShellListener) { this.shellListeners.add(l); return () => this.shellListeners.delete(l); }
  onThread(l: ThreadListener) { this.threadListeners.add(l); return () => this.threadListeners.delete(l); }

  // ---- snapshots ------------------------------------------------------------

  shellSnapshot(): ShellSnapshot {
    return { seq: this.db.shellSeq(), machine: this.machine, projects: this.db.listProjects(), threads: this.db.listThreads(), runs: this.db.listRuns() };
  }

  /**
   * Publish what the daemon read about its own machine. The probe runs a
   * program per tool, so it happens after the listener binds rather than
   * before it; this is how the answer reaches clients that are already here.
   */
  setResources(resources: MachineResources) {
    this.machine.resources = resources;
    this.emitShell({ kind: "machine.updated", machine: this.machine });
  }

  threadSnapshot(threadId: string, limit = 200, beforeSeq?: number): ThreadSnapshot {
    const thread = this.db.getThread(threadId);
    if (!thread) throw new EngineError("not_found", `thread ${threadId} not found`);
    const { items, hasMore } = this.db.listItems(threadId, limit, beforeSeq);
    // include any throttled-but-unflushed streaming state
    for (const [, s] of this.streamTimers) {
      if (s.latest.threadId !== threadId) continue;
      const idx = items.findIndex((i) => i.id === s.latest.id);
      if (idx >= 0) items[idx] = s.latest; else items.push(s.latest);
    }
    return { seq: this.db.threadSeq(threadId), thread, items, hasMore, commands: this.db.threadCommands(threadId) };
  }

  // ---- emit helpers ---------------------------------------------------------

  private emitShell(ev: ShellEventBody): number {
    const full = this.db.appendShellEvent(ev);
    queueMicrotask(() => { for (const l of this.shellListeners) l(full); });
    return full.seq;
  }

  private emitThread(threadId: string, ev: ThreadEventBody): number {
    const seq = this.db.nextThreadSeq(threadId);
    const full = { ...ev, seq } as ThreadEvent;
    this.db.appendThreadEvent(threadId, full);
    queueMicrotask(() => { for (const l of this.threadListeners) l(threadId, full); });
    return seq;
  }

  private putThreadAndEmit(t: Thread): number {
    t.updatedAt = new Date().toISOString();
    this.db.putThread(t);
    this.emitThread(t.id, { kind: "thread.updated", thread: t });
    return this.emitShell({ kind: "thread.upserted", thread: t });
  }

  private persistItem(item: TimelineItem): number {
    const existing = this.db.getItem(item.id);
    const seq = existing ? existing.seq : this.db.nextThreadSeq(item.threadId);
    const stored = { ...item, seq, createdAt: existing?.createdAt ?? item.createdAt };
    this.db.putItem(stored);
    return this.emitThread(item.threadId, { kind: "item.upserted", item: stored });
  }

  private upsertItem(item: TimelineItem, opts?: { streaming?: boolean }) {
    const key = item.id;
    const pending = this.streamTimers.get(key);
    if (opts?.streaming) {
      if (pending) { pending.latest = item; return; }
      const timer = setTimeout(() => {
        const p = this.streamTimers.get(key);
        this.streamTimers.delete(key);
        if (p) this.persistItem(p.latest);
      }, 60);
      this.streamTimers.set(key, { latest: item, timer });
      return;
    }
    if (pending) { clearTimeout(pending.timer); this.streamTimers.delete(key); }
    this.persistItem(item);
  }

  // ---- commands -------------------------------------------------------------

  /**
   * `client` is the name the calling connection gave at `hello`. The server
   * keeps it for the life of the connection and hands it back here, because it
   * is what says whether a person or a program asked for a thread. It is
   * self-declared and unverifiable — a hint for a reader, never a permission.
   *
   * `caller` is the thread that connection said it runs inside, and the same
   * rules apply to it. A thread or a run it creates becomes a child of that
   * thread, which is how the sidebar puts an agent's work under the thread
   * that asked for it.
   */
  async dispatch(cmd: CommandEnvelope, client = "", caller = ""): Promise<number> {
    const prior = this.db.receipt(cmd.commandId);
    if (prior !== null) return prior;
    const seq = await this.apply(cmd, client, caller);
    this.db.putReceipt(cmd.commandId, seq);
    return seq;
  }

  private async apply(cmd: Command, client = "", caller = ""): Promise<number> {
    const now = new Date().toISOString();
    // Any command about a thread is use of that thread, so the idle clock for
    // its session starts again here — before the command runs, because some of
    // them (`session.stop`, `thread.delete`) end the session instead.
    const about = (cmd as { threadId?: string }).threadId;
    if (about) this.touch(about);
    switch (cmd.type) {
      case "machine.settings": {
        // Mutated in place: `machine` is the same object the server hands to
        // every `hello`, so a client connecting next sees the new defaults.
        this.machine.settings = saveMachineSettings({
          ...(cmd.defaultModel !== undefined ? { defaultModel: cmd.defaultModel } : {}),
          ...(cmd.defaultPermissionMode !== undefined ? { defaultPermissionMode: cmd.defaultPermissionMode } : {}),
          ...(cmd.defaultStreaming !== undefined ? { defaultStreaming: cmd.defaultStreaming } : {}),
          ...(cmd.sessionIdleMinutes !== undefined ? { sessionIdleMinutes: clampSetting(cmd.sessionIdleMinutes, 0) } : {}),
          ...(cmd.maxLiveSessions !== undefined ? { maxLiveSessions: clampSetting(cmd.maxLiveSessions, 1) } : {}),
          ...(cmd.webEnabled !== undefined ? { webEnabled: cmd.webEnabled === true ? true : null } : {}),
        });
        // A lower limit applies to the sessions already live, not only to the
        // next one: the user asked for less memory now.
        this.sweepSessions();
        return this.emitShell({ kind: "machine.updated", machine: this.machine });
      }
      case "project.create": {
        const url = cmd.url.trim();
        if (!url) throw new EngineError("bad_url", "a repository URL is needed");
        const identity = normaliseRemote(url);
        // One clone per repository. A `checkout` row of the same repository
        // from before projects were clones does not count: the clone goes in
        // beside it, the sidebar shows the two as one project, and new threads
        // prefer the clone. The old row keeps its threads until the reader
        // removes it.
        const dup = this.db.listProjects().find((p) => p.repositoryIdentity === identity && p.kind === "clone");
        if (dup) throw new EngineError("exists", `this machine already has ${dup.title} for ${identity}`);
        const root = join(this.projectsDir, projectSlug(identity), "repo.git");
        const cloned = await this.cloneOnce(url, root);
        if ("error" in cloned) throw new EngineError("git", `could not clone ${url}: ${cloned.error}`);
        // Two creates for one repository may have waited on the same clone.
        const raced = this.db.listProjects().find((p) => p.repositoryIdentity === identity && p.kind === "clone");
        if (raced) return this.db.shellSeq();
        const p: Project = {
          id: randomUUID(), title: cmd.title ?? basename(identity), workspaceRoot: root,
          repositoryIdentity: identity, kind: "clone", remoteUrl: url,
          defaultModel: null, createdAt: now, updatedAt: now,
        };
        this.db.putProject(p);
        return this.emitShell({ kind: "project.upserted", project: p });
      }
      case "project.update": {
        const p = this.db.getProject(cmd.projectId);
        if (!p) throw new EngineError("not_found", "project not found");
        if (cmd.title !== undefined) p.title = cmd.title;
        if (cmd.defaultModel !== undefined) p.defaultModel = cmd.defaultModel;
        p.updatedAt = now;
        this.db.putProject(p);
        return this.emitShell({ kind: "project.upserted", project: p });
      }
      case "project.delete": {
        for (const t of this.db.listThreads().filter((t) => t.projectId === cmd.projectId)) {
          await this.apply({ type: "thread.delete", threadId: t.id });
        }
        this.db.deleteProject(cmd.projectId);
        return this.emitShell({ kind: "project.removed", projectId: cmd.projectId });
      }
      case "thread.create": {
        const p = this.db.getProject(cmd.projectId);
        if (!p) throw new EngineError("not_found", "project not found");
        if (this.db.getThread(cmd.threadId)) return this.db.shellSeq();
        // A taken issue is refused here, before a worktree exists for a thread
        // that will not be made.
        if (cmd.issue !== undefined) this.assertIssueFree(p.id, cmd.issue, cmd.threadId);
        // Every thread in a repository gets its own worktree, branched from the
        // remote's default branch after a fetch. There is no other place to
        // work: a clone is bare, and parallel threads in one checkout change
        // the same files. A `checkout` project that is not a repository is
        // the one exception, and the thread works in the directory itself.
        const tree = await this.newWorktree(p, cmd.threadId.slice(0, 8), null);
        const { worktreePath, branch, cleanStart } = tree;
        const machineMode = this.machine.settings.defaultPermissionMode;
        // The command's parent wins over the connection's, and both are checked
        // against this database: a link to a thread nobody can paint loses the
        // child, and `run.create` has never taken one on trust either.
        const origin = threadOrigin(cmd.origin, client, this.knownThread(cmd.origin?.parentThreadId ?? caller, cmd.threadId));
        const t: Thread = {
          id: cmd.threadId, projectId: p.id, title: cmd.title ?? "New thread", titleAuto: cmd.title === undefined, provider: "claude",
          ...(origin ? { origin } : {}),
          sessionId: cmd.sessionId, model: cmd.model ?? p.defaultModel ?? this.machine.settings.defaultModel,
          // The command wins, then the machine's default; only when neither has
          // an opinion do we honour the user's own settings default.
          permissionMode: cmd.permissionMode ?? machineMode ?? resolveDefaultPermissionMode(worktreePath ?? p.workspaceRoot),
          permissionModeExplicit: cmd.permissionMode !== undefined || machineMode !== null,
          streaming: cmd.streaming ?? this.machine.settings.defaultStreaming ?? false,
          branch, worktreePath, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0, latestTurn: null,
          lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null, createdAt: now, updatedAt: now,
        };
        this.db.putThread(t);
        if (cleanStart) this.note(t.id, ...cleanStartNote(cleanStart));
        if (cmd.issue !== undefined) await this.takeIssue(t, cmd.issue, p);
        return this.emitShell({ kind: "thread.upserted", thread: this.db.getThread(t.id) ?? t });
      }
      case "thread.rename": return this.mutateThread(cmd.threadId, (t) => { t.title = cmd.title; t.titleAuto = false; });
      case "thread.takeIssue": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        const p = this.db.getProject(t.projectId);
        if (!p) throw new EngineError("not_found", "project not found");
        await this.takeIssue(t, cmd.issue, p);
        return this.putThreadAndEmit(this.db.getThread(t.id) ?? t);
      }
      case "thread.watch": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        if (t.movedTo) throw new EngineError("moved", "thread has been moved to another machine");
        if (cmd.number === null) {
          if (t.watch?.state === "watching") this.endWatch(t, "dropped", "The watch was stopped by request.");
          return this.putThreadAndEmit(t);
        }
        const p = this.db.getProject(t.projectId);
        if (!p) throw new EngineError("not_found", "project not found");
        const host = this.hostFor({ cwd: t.worktreePath ?? p.workspaceRoot });
        const facts = await host.pullRequestByNumber(cmd.number);
        if (!facts) throw new EngineError("not_found", `pull request #${cmd.number} was not found; gh may be logged out, or the number is wrong`);
        t.pullRequest = { number: facts.number, url: facts.url, branch: facts.headRefName, base: facts.baseRefName, openedAt: now };
        this.startWatch(t, facts.number, { maxRounds: cmd.maxRounds, merge: cmd.merge, mergeMethod: cmd.mergeMethod });
        return this.putThreadAndEmit(t);
      }
      case "thread.setMerge": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        if (!t.watch || t.watch.state !== "watching") throw new EngineError("no_watch", "this thread has no pull request under watch");
        if (cmd.merge !== "auto" && cmd.merge !== "manual") throw new EngineError("bad_policy", `${cmd.merge} is not a merge policy; use auto or manual`);
        t.watch = { ...t.watch, merge: cmd.merge, mergeMethod: mergeMethodOf(cmd.mergeMethod, t.watch.mergeMethod) };
        this.note(t.id, "info", cmd.merge === "auto"
          ? `Merge policy set to auto: covey merges pull request #${t.watch.number} (${t.watch.mergeMethod}) once the checks pass against the current base and no review asks for changes.`
          : `Merge policy set to manual: a person merges pull request #${t.watch.number}.`);
        return this.putThreadAndEmit(t);
      }
      case "thread.archive": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        // Archiving is "I am done here", so the thread hands its worktree back
        // rather than leaving a checkout behind for every thread ever finished.
        // The branch keeps the commits, and the next turn (writing to a thread
        // un-archives it) puts the worktree back at the same path.
        if (cmd.archived) {
          if (t.latestTurn?.state === "running") throw new EngineError("busy", "interrupt the running turn before archiving");
          this.dropSession(t.id);
          await this.releaseWorktree(t);
          // A watch on an archived thread would wake it with a turn, and
          // "I am done here" says otherwise. The record stays for the reader.
          const fresh = this.db.getThread(t.id);
          if (fresh?.watch?.state === "watching") { this.endWatch(fresh, "dropped", "The thread was archived, so the watch stopped."); this.db.putThread(fresh); }
        }
        return this.mutateThread(cmd.threadId, (x) => { x.archivedAt = cmd.archived ? now : null; });
      }
      case "thread.pin": return this.mutateThread(cmd.threadId, (t) => { t.pinnedAt = cmd.pinned ? now : null; });
      case "thread.delete": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) return this.db.shellSeq();
        this.dropSession(t.id);
        this.queues.delete(t.id);
        this.forgetAuthFailure(t.id);
        const proj = this.db.getProject(t.projectId);
        if (proj) void deleteCheckpointRefs(this.gitCwd(t, proj), t.id);
        // The worktree goes with the thread; the branch stays, as it does on
        // archive. A worktree with unsaved work is kept, and nobody is told,
        // because the transcript that would carry the note is deleted below.
        if (proj && t.worktreePath && existsSync(t.worktreePath)) await removeWorktree(proj.workspaceRoot, t.worktreePath);
        rmSync(attachmentsDir(t.id), { recursive: true, force: true });
        this.db.deleteThread(t.id);
        this.db.deleteTranscript(t.sessionId);
        return this.emitShell({ kind: "thread.removed", threadId: t.id });
      }
      case "thread.setPermissionMode": {
        await this.sessions.get(cmd.threadId)?.setPermissionMode(cmd.mode);
        return this.mutateThread(cmd.threadId, (t) => { t.permissionMode = cmd.mode; t.permissionModeExplicit = true; });
      }
      case "thread.setModel": {
        await this.sessions.get(cmd.threadId)?.setModel(cmd.model);
        return this.mutateThread(cmd.threadId, (t) => { t.model = cmd.model; });
      }
      case "thread.setStreaming": {
        // No restart, and no wait for the turn to end: the session already
        // receives the partial messages and only decides whether to pass them
        // on, so the next token of the turn in flight goes the new way.
        this.sessions.get(cmd.threadId)?.setStreaming(cmd.streaming);
        return this.mutateThread(cmd.threadId, (t) => { t.streaming = cmd.streaming; });
      }
      case "turn.send": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        if (t.movedTo) throw new EngineError("moved", "thread has been moved to another machine");
        // Writing to an archived thread is how you un-archive it: the sidebar's
        // archived folder is "threads I am done with", and this says otherwise.
        if (t.archivedAt) { t.archivedAt = null; this.putThreadAndEmit(t); }
        const running = t.latestTurn?.state === "running";
        // Write any inline bytes to disk and strip them, so the persisted item
        // (and every snapshot that replays it) stays small.
        let attachments: Attachment[];
        try {
          attachments = materialiseAttachments(t.id, cmd.attachments ?? []);
        } catch (e: any) {
          throw new EngineError("attachment", e?.message ?? String(e));
        }
        // A message typed while the agent works goes *into* that turn rather
        // than behind it: the CLI folds queued input in at the next tool
        // boundary, so a correction lands in seconds instead of after however
        // long the turn has left to run. That only works while the session it
        // belongs to is the one actually in flight; anything else still queues.
        const live = this.sessions.get(t.id);
        const fold = running && !!live?.running && live.activeTurnId === t.latestTurn!.turnId;
        const userItem: TimelineItem = {
          id: `u:${cmd.turnId}`, threadId: t.id,
          // A folded message is part of the turn that reads it — one turn, one
          // checkpoint, one diff — so it carries that turn's id, not its own.
          turnId: fold ? t.latestTurn!.turnId : cmd.turnId,
          seq: 0, createdAt: now, updatedAt: now,
          kind: "user", text: cmd.text, attachments,
          ...(fold ? { folded: true } : running ? { queued: true } : {}),
        };
        this.persistItem(userItem);
        if (fold) {
          live!.foldIntoTurn(cmd.text, attachments);
          return this.mutateThread(t.id, (x) => { x.lastMessageAt = now; });
        }
        if (running) {
          const q = this.queues.get(t.id) ?? [];
          q.push({ turnId: cmd.turnId, text: cmd.text, attachments });
          this.queues.set(t.id, q);
          return this.mutateThread(t.id, (x) => { x.queuedTurns = q.length; });
        }
        return this.startTurn(t.id, cmd.turnId, cmd.text, attachments);
      }
      case "turn.revert": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) throw new EngineError("not_found", "thread not found");
        if (t.latestTurn?.state === "running") throw new EngineError("busy", "interrupt the running turn first");
        if ((this.queues.get(t.id)?.length ?? 0) > 0) throw new EngineError("busy", "cancel queued messages first");
        const cp = this.db.getCheckpoint(t.id, cmd.turnId);
        if (!cp) throw new EngineError("not_found", "no checkpoint for that turn");
        const userItem = this.db.getItem(`u:${cmd.turnId}`);
        if (!userItem) throw new EngineError("not_found", "turn's user message not found");
        // 1. files
        let touched: string[] | null = null;
        if (cp.beforeTree) {
          touched = await restoreTree(cp.cwd, cp.beforeTree);
          if (touched === null) throw new EngineError("git", "could not restore working tree");
        }
        // 2. conversation: drop the live process and truncate the transcript
        this.dropSession(t.id);
        let dropped = 0;
        if (cp.userMessageUuid) dropped = this.db.truncateTranscriptAt(t.id, t.sessionId, cp.userMessageUuid);
        else {
          // turn never completed (interrupted/error): fall back to the timestamp of the user item
          dropped = this.truncateTranscriptByTime(t.id, t.sessionId, userItem.createdAt);
        }
        // If nothing conversational is left, the thread starts over with a
        // fresh session id: resuming an empty transcript is an error in the CLI.
        let freshSession: string | null = null;
        if (!this.db.transcriptHasMessages(t.id, t.sessionId)) {
          this.db.deleteTranscript(t.sessionId);
          freshSession = randomUUID();
        }
        // 3. timeline + later checkpoints
        const removed = this.db.deleteItemsFrom(t.id, userItem.seq);
        for (const id of removed) this.emitThread(t.id, { kind: "item.removed", itemId: id });
        for (const later of this.db.checkpointsAfter(t.id, cp.at)) this.db.deleteCheckpoint(t.id, later.turnId);
        const summary = `Reverted to before "${fallbackTitle((userItem as any).text)}"` +
          (touched ? ` · ${touched.length} file${touched.length === 1 ? "" : "s"} restored` : " · no git snapshot, files untouched") +
          ` · ${dropped} transcript entries dropped`;
        this.persistItem({ id: `note:${randomUUID()}`, threadId: t.id, turnId: null, seq: 0, createdAt: now, updatedAt: now, kind: "note", tone: "warning", text: summary });
        return this.mutateThread(t.id, (x) => { x.latestTurn = null; x.status = "idle"; x.lastError = null; x.pendingApprovals = 0; if (freshSession) x.sessionId = freshSession; });
      }
      case "turn.cancelQueued": {
        const q = this.queues.get(cmd.threadId) ?? [];
        const idx = q.findIndex((x) => x.turnId === cmd.turnId);
        if (idx < 0) throw new EngineError("not_found", "turn is not queued");
        q.splice(idx, 1);
        this.db.deleteItem(`u:${cmd.turnId}`);
        this.emitThread(cmd.threadId, { kind: "item.removed", itemId: `u:${cmd.turnId}` });
        return this.mutateThread(cmd.threadId, (x) => { x.queuedTurns = q.length; });
      }
      case "turn.background": {
        const s = this.sessions.get(cmd.threadId);
        if (!s?.running) throw new EngineError("no_session", "nothing is running on this thread");
        let moved: boolean;
        try {
          moved = await s.backgroundTasks(cmd.toolUseId);
        } catch (e: any) {
          // The CLI refuses when background tasks are switched off for the
          // session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
          throw new EngineError("unsupported", e?.message ?? String(e));
        }
        if (!moved) throw new EngineError("not_found", "that tool call is not running");
        return this.db.shellSeq();
      }
      case "turn.interrupt": {
        const t0 = this.db.getThread(cmd.threadId);
        const wasRunning = t0?.latestTurn?.state === "running" ? t0.latestTurn.turnId : null;
        await this.sessions.get(cmd.threadId)?.interrupt();
        const seq = this.mutateThread(cmd.threadId, (t) => {
          if (t.latestTurn?.state === "running") { t.latestTurn.state = "interrupted"; t.latestTurn.completedAt = now; }
          t.status = "interrupted";
        });
        if (wasRunning) void this.finishTurn(cmd.threadId, wasRunning);
        return seq;
      }
      case "approval.respond":
      case "question.respond": {
        const s = this.sessions.get(cmd.threadId);
        if (!s) throw new EngineError("no_session", "no live session for thread");
        const pending = s.pendingItem(cmd.requestId);
        if (!pending) throw new EngineError("not_found", "request no longer pending");
        const res = cmd.type === "approval.respond"
          ? s.buildResponse(cmd.requestId, cmd.behavior, { updatedPermissions: cmd.updatedPermissions, message: cmd.message })
          : s.buildResponse(cmd.requestId, "allow", { answer: cmd.answer, answers: cmd.answers });
        if (!res) throw new EngineError("not_found", "request no longer pending");
        s.respond(cmd.requestId, res);
        return this.db.shellSeq();
      }
      case "session.stop": {
        this.dropSession(cmd.threadId);
        return this.mutateThread(cmd.threadId, (t) => { t.status = "idle"; });
      }
      // ---- runs -------------------------------------------------------------
      // The run record lives here because a run outlives the client that
      // started it. The client stays the party that dispatches: only it holds
      // a connection to every machine the members run on.
      case "run.create": {
        const existing = this.db.getRun(cmd.run.runId);
        // A retried create must not throw away a run that has been dispatched.
        if (existing) return this.emitShell({ kind: "run.upserted", run: existing });
        // The run's parent, by the same rule a thread's parent follows: the
        // command wins, then the thread the connection speaks for.
        const parent = this.knownThread(cmd.run.parentThreadId ?? caller);
        const run: Run = {
          id: cmd.run.runId,
          machineId: this.machine.machineId,
          name: cmd.run.name,
          ...(parent ? { parentThreadId: parent } : {}),
          goal: cmd.run.goal,
          briefTemplate: cmd.run.briefTemplate,
          members: cmd.run.members.map((m) => newMember(m, now)),
          closedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.db.putRun(run);
        return this.emitShell({ kind: "run.upserted", run });
      }
      case "run.update": {
        const run = this.requireRun(cmd.runId);
        if (cmd.name !== undefined) run.name = cmd.name;
        if (cmd.goal !== undefined) run.goal = cmd.goal;
        if (cmd.briefTemplate !== undefined) run.briefTemplate = cmd.briefTemplate;
        if (cmd.closedAt !== undefined) run.closedAt = cmd.closedAt;
        return this.saveRun(run, now);
      }
      case "run.member.add": {
        const run = this.requireRun(cmd.runId);
        // Scope changes in the middle of a run: one task was cancelled and
        // another added on the day this issue came from. Adding is an ordinary
        // edit, so adding a member that is already here changes nothing.
        if (run.members.some((m) => m.id === cmd.member.id)) return this.emitShell({ kind: "run.upserted", run });
        run.members.push(newMember(cmd.member, now));
        return this.saveRun(run, now);
      }
      case "run.member.patch": {
        const run = this.requireRun(cmd.runId);
        const at = run.members.findIndex((m) => m.id === cmd.memberId);
        if (at < 0) throw new EngineError("not_found", `run ${cmd.runId} has no member ${cmd.memberId}`);
        // `review` is issue #45's field. It is merged like any other and never
        // read here, which is what lets the two halves land separately.
        run.members[at] = { ...run.members[at]!, ...cmd.patch, updatedAt: now };
        return this.saveRun(run, now);
      }
      case "run.member.remove": {
        const run = this.requireRun(cmd.runId);
        const m = run.members.find((x) => x.id === cmd.memberId);
        if (m && m.threadId) throw new EngineError("dispatched", "a dispatched member is withdrawn, not removed — its thread did the work");
        run.members = run.members.filter((x) => x.id !== cmd.memberId);
        return this.saveRun(run, now);
      }
      case "run.delete": {
        this.db.deleteRun(cmd.runId);
        return this.emitShell({ kind: "run.removed", runId: cmd.runId });
      }
      // Unreachable for a client of the same version. A newer client talking to
      // this daemon lands here, and has to hear so — falling out of the switch
      // would ack a command that never ran.
      default: throw new EngineError("unknown_command", `this daemon does not know the command ${(cmd as { type: string }).type}`);
    }
  }

  /**
   * A parent id this daemon can stand behind: a thread it holds, and never the
   * thread that is being created. Everything else — an empty string, a thread
   * on another machine, an id a client invented — becomes `undefined`, so a
   * child is never linked to a parent nobody can paint.
   */
  private knownThread(id: string | undefined, self?: string): string | undefined {
    if (!id || id === self) return undefined;
    return this.db.getThread(id) ? id : undefined;
  }

  private requireRun(runId: string): Run {
    const run = this.db.getRun(runId);
    if (!run) throw new EngineError("not_found", `run ${runId} not found`);
    return run;
  }

  /** Store the run and send it whole, the way a timeline item is sent whole. */
  private saveRun(run: Run, now: string): number {
    run.updatedAt = now;
    this.db.putRun(run);
    return this.emitShell({ kind: "run.upserted", run });
  }

  /**
   * The issues a run's task list names, read with `gh` in the project's
   * checkout — here, where `gh` has the remote and the login.
   */
  async runIssues(projectId: string, numbers: number[]): Promise<{ issues: RunIssue[]; error: string | null }> {
    const p = this.db.getProject(projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    return readIssues(p.workspaceRoot, numbers.slice(0, 100));
  }

  /**
   * The pull request for a member's branch. The branch is on this machine, so
   * this daemon is the one that can see it.
   */
  async runPullRequest(threadId: string): Promise<RunPullRequest | null> {
    const t = this.db.getThread(threadId);
    if (!t) throw new EngineError("not_found", `thread ${threadId} not found`);
    if (!t.branch) return null;
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    try {
      return await pullRequestFor(t.worktreePath ?? p.workspaceRoot, t.branch);
    } catch (e: any) {
      throw new EngineError("gh", e?.message ?? String(e));
    }
  }

  // ---- integrating a run: gates, the queue, the audit, and the one merge ----
  //
  // Every call here is about a branch on *this* machine, so this daemon is the
  // one that can answer. The run record lives on the operator's daemon; these
  // read facts and hand them back.

  /**
   * The member, and a `gh` host in its checkout.
   *
   * `turnRunning` comes from the thread, never from the caller. A client that
   * asked to merge under a running turn would be believed otherwise, and that
   * is the mistake that hid 211 lines of work in the run of 2026-09-16.
   */
  private async memberContext(threadId: string, label: string, state: RunMemberState, allowMerge: boolean): Promise<{ ref: RunMemberRef; host: GhHost; base: string }> {
    const t = this.db.getThread(threadId);
    if (!t) throw new EngineError("not_found", `thread ${threadId} not found`);
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    if (!t.branch) throw new EngineError("no_branch", `thread ${threadId} is not on a branch`);
    const cwd = t.worktreePath ?? p.workspaceRoot;
    const ref: RunMemberRef = {
      memberId: threadId,
      label,
      threadId,
      machineId: this.machine.machineId,
      branch: t.branch,
      pullRequest: null,
      turnRunning: t.status === "running" || t.status === "starting" || (t.latestTurn?.state === "running"),
      state,
    };
    const base = await this.baseBranch(cwd);
    return { ref, host: this.hostFor({ cwd, allowMerge }), base };
  }

  /** The base is the ref a worktree branches from, with the remote stripped:
   *  `origin/main` and `main` name the same branch to `git rev-list`. */
  private async baseBranch(cwd: string): Promise<string> {
    return ((await defaultBranchRef(cwd)) ?? "main").replace(/^origin\//, "");
  }

  /** `gh` and `git` in a checkout: the real pair, or the fake a test handed in. */
  private hostFor(options: RealHostOptions): GhHost {
    return (this.opts.ghHost ?? realGhHost)(options);
  }

  // ---- the loop: an issue, a pull request, and the answer (#94) -----------
  //
  // A thread takes an issue, opens a pull request through the daemon that
  // holds its branch, and the daemon watches the pull request. Each answer
  // GitHub gives — a checks verdict, a review, a comment, a merge — reaches
  // the thread as a turn, which resumes a session the engine released. The
  // record of all three lives on the thread row, so it survives a restart
  // and travels with a move.

  /**
   * Record the issue a thread owns, with its title when `gh` can read it.
   * Two agents must not take one issue: another live thread of the same
   * project on this machine that holds the number is a refusal. Two machines
   * cannot see each other, so the claim is per machine; see DESIGN.md.
   */
  private async takeIssue(t: Thread, issue: number | null, p: Project): Promise<void> {
    if (issue === null) { t.issue = null; this.db.putThread(t); return; }
    this.assertIssueFree(t.projectId, issue, t.id);
    const facts = await this.hostFor({ cwd: t.worktreePath ?? p.workspaceRoot }).issue(issue);
    t.issue = { number: issue, title: facts?.title ?? null, url: facts?.url ?? null, takenAt: new Date().toISOString() };
    this.db.putThread(t);
    this.note(t.id, "info", `Took issue #${issue}${facts?.title ? ` (${facts.title})` : ""}.`);
  }

  /** Refuse an issue number that is not one, or that another live thread of the project holds. */
  private assertIssueFree(projectId: string, issue: number, self: string): void {
    if (!Number.isInteger(issue) || issue <= 0) throw new EngineError("bad_issue", `${issue} is not an issue number`);
    const holder = this.db.listThreads().find((x) => x.id !== self && x.projectId === projectId && !x.archivedAt && !x.movedTo && x.issue?.number === issue);
    if (holder) throw new EngineError("taken", `issue #${issue} is held by thread ${holder.id} (${holder.title})`);
  }

  /**
   * Open a pull request for a thread's branch, record it, and start the watch.
   * The daemon does it because the daemon has the branch, the `gh` login and
   * the `PATH`; the agent only has to ask.
   */
  async openPullRequest(params: { threadId: string; title: string; body?: string; draft?: boolean; maxRounds?: number; merge?: MergePolicy; mergeMethod?: MergeMethod }): Promise<{ number: number; url: string }> {
    const t = this.db.getThread(params.threadId);
    if (!t) throw new EngineError("not_found", `thread ${params.threadId} not found`);
    if (t.movedTo) throw new EngineError("moved", "thread has been moved to another machine");
    if (!t.branch) throw new EngineError("no_branch", `thread ${params.threadId} is not on a branch`);
    if (t.pullRequest && t.watch?.state === "watching") throw new EngineError("exists", `this thread already has pull request #${t.pullRequest.number}; covey is watching it`);
    const title = params.title.trim();
    if (!title) throw new EngineError("bad_title", "a pull request needs a title");
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    const cwd = t.worktreePath ?? p.workspaceRoot;
    const host = this.hostFor({ cwd, allowCreate: true });
    if (!host.createPullRequest) throw new EngineError("unsupported", "this host cannot open a pull request");
    const base = await this.baseBranch(cwd);
    let body = (params.body ?? "").trim();
    // The issue is the durable place to report, and `Closes #N` closes the
    // loop when the change lands. A body that names the issue is left alone.
    if (t.issue && !new RegExp(`#${t.issue.number}\\b`).test(body)) body = body ? `${body}\n\nCloses #${t.issue.number}` : `Closes #${t.issue.number}`;
    let opened: { number: number; url: string };
    try {
      opened = await host.createPullRequest({ branch: t.branch, base, title, body, draft: !!params.draft });
    } catch (e: any) {
      throw new EngineError("gh", `could not open the pull request: ${(e?.stderr ?? e?.message ?? String(e)).toString().trim().split("\n")[0]}`);
    }
    // Read the row again: the create took a while, and the thread may have moved on.
    const fresh = this.db.getThread(t.id) ?? t;
    fresh.pullRequest = { number: opened.number, url: opened.url, branch: t.branch, base, openedAt: new Date().toISOString() };
    this.startWatch(fresh, opened.number, { maxRounds: params.maxRounds, merge: params.merge, mergeMethod: params.mergeMethod });
    this.putThreadAndEmit(fresh);
    return opened;
  }

  /** Begin, or begin again, the watch on a pull request. A note says so. */
  private startWatch(t: Thread, number: number, o: { maxRounds?: number; merge?: MergePolicy; mergeMethod?: MergeMethod }): void {
    const now = new Date(this.now()).toISOString();
    const rounds = o.maxRounds !== undefined && Number.isFinite(o.maxRounds) ? Math.max(1, Math.floor(o.maxRounds)) : DEFAULT_MAX_ROUNDS;
    // Manual unless said otherwise: green is not an acceptance, and a merge
    // is the one act in the loop that a person cannot take back.
    const merge: MergePolicy = o.merge === "auto" ? "auto" : "manual";
    const mergeMethod = mergeMethodOf(o.mergeMethod, "merge");
    t.watch = {
      number, state: "watching", reason: null, merge, mergeMethod, rounds: 0, maxRounds: rounds, quiet: 0,
      cursor: emptyCursor(), startedAt: now, polledAt: null, endedAt: null, error: null,
    };
    const who = merge === "auto"
      ? `Merge policy: auto. Covey merges (${mergeMethod}) once the checks pass against the current base and no review asks for changes, never under a running turn.`
      : "Merge policy: manual. A person merges, or switches this thread to auto.";
    this.note(t.id, "info", `Watching pull request #${number}${t.pullRequest?.url ? ` (${t.pullRequest.url})` : ""}. Each checks verdict, review, comment and merge arrives here as a turn. ${who} The watch sends at most ${rounds} turn${rounds === 1 ? "" : "s"} that ask for more work, then hands the thread to a person.`);
  }

  /** End a watch, with the reason in the row and in the transcript. The caller stores the row. */
  private endWatch(t: Thread, state: Exclude<WatchState, "watching">, reason: string): void {
    if (!t.watch) return;
    t.watch = { ...t.watch, state, reason, endedAt: new Date(this.now()).toISOString() };
    const word = state === "blocked" ? "warning" : "info";
    this.note(t.id, word, `${state === "blocked" ? "Blocked" : "Stopped watching"} pull request #${t.watch.number}: ${reason}`);
    this.opts.log?.(`watch ended thread=${t.id.slice(0, 8)} pr=#${t.watch.number} state=${state}`);
  }

  /**
   * Poll every watch that is due. The tick calls this; a test calls it by
   * hand and moves the clock between calls.
   *
   * @returns the threads it polled.
   */
  async pollWatches(): Promise<string[]> {
    const now = this.now();
    const due: Thread[] = [];
    for (const t of this.db.listThreads()) {
      const w = t.watch;
      if (!w || w.state !== "watching" || t.movedTo || t.archivedAt) continue;
      if (this.polling.has(t.id)) continue;
      const wait = w.polledAt === null ? 0 : pollDelayMs(w.quiet);
      if (w.polledAt !== null && now - Date.parse(w.polledAt) < wait) continue;
      due.push(t);
    }
    await Promise.all(due.map((t) => this.pollWatch(t)));
    return due.map((t) => t.id);
  }

  /** One poll: read the pull request, work out the news, deliver it once. */
  private async pollWatch(t: Thread): Promise<void> {
    const w = t.watch!;
    const p = this.db.getProject(t.projectId);
    if (!p) return;
    this.polling.add(t.id);
    try {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      if (nowMs - Date.parse(w.startedAt) >= WATCH_MAX_MS) {
        const hours = Math.round(WATCH_MAX_MS / 3_600_000);
        this.endWatch(t, "blocked", `The watch ran for ${hours} hours without a merge or a close. A person has to look at the pull request.`);
        this.putThreadAndEmit(t);
        return;
      }
      const host = this.hostFor({ cwd: t.worktreePath ?? p.workspaceRoot });
      let facts: Awaited<ReturnType<GhHost["pullRequestByNumber"]>>;
      let lineComments: Awaited<ReturnType<GhHost["reviewComments"]>>;
      try {
        facts = await host.pullRequestByNumber(w.number);
        lineComments = facts ? await host.reviewComments(w.number) : [];
      } catch (e: any) {
        this.recordPoll(t.id, w.number, (x) => { x.error = String(e?.message ?? e); x.quiet++; }, nowIso);
        return;
      }
      if (!facts) {
        this.recordPoll(t.id, w.number, (x) => { x.error = `pull request #${w.number} could not be read; gh may be logged out on this machine`; x.quiet++; }, nowIso);
        return;
      }
      // The read took a while. The watch may have ended, or been replaced,
      // while it ran, and a stale answer must not be delivered on top.
      const fresh = this.db.getThread(t.id);
      const live = fresh?.watch;
      if (!fresh || !live || live.state !== "watching" || live.number !== w.number) return;
      // The base head is read only under `auto`, where staleness stands
      // between the thread and its merge. Under `manual` it is the person's
      // question, and one `gh` call fewer per poll.
      const base = live.merge === "auto" && facts.state === "OPEN" ? await host.baseHead(facts.baseRefName).catch(() => null) : null;
      const { events, cursor } = news(facts, lineComments, live.cursor, nowIso, { merge: live.merge, base });
      live.cursor = cursor;
      live.polledAt = nowIso;
      live.error = null;
      live.quiet = events.length ? 0 : live.quiet + 1;

      // The merge, under `auto`. Nothing in this batch may ask for work, the
      // pull request must be ready by every fact GitHub reports, and the
      // thread must be idle: #45 established that a merge under a running
      // turn hides the commits it is about to push. One try per head, so a
      // refusal is not a loop.
      if (live.merge === "auto" && facts.state === "OPEN" && !events.some(asksForWork) && cursor.mergeTried !== facts.headRefOid) {
        const ready = mergeReadiness(facts, base);
        const running = fresh.latestTurn?.state === "running" || fresh.status === "running" || fresh.status === "starting";
        if (ready.ready && !running) {
          const merger = this.hostFor({ cwd: t.worktreePath ?? p.workspaceRoot, allowMerge: true });
          try {
            await merger.mergePullRequest!(live.number, live.mergeMethod);
            events.push({ kind: "merged", by: "covey", method: live.mergeMethod } satisfies WatchEvent);
            this.opts.log?.(`watch merged thread=${fresh.id.slice(0, 8)} pr=#${live.number} method=${live.mergeMethod}`);
          } catch (e: any) {
            live.cursor = { ...live.cursor, mergeTried: facts.headRefOid };
            events.push({ kind: "mergeFailed", error: String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0] ?? "gh failed" } satisfies WatchEvent);
          }
        } else if (ready.ready && running) {
          this.opts.log?.(`watch holds the merge thread=${fresh.id.slice(0, 8)} pr=#${live.number}: a turn is running`);
        }
      }
      if (events.length === 0) { this.db.putThread(fresh); return; }

      const work = events.some(asksForWork);
      const end = events.find(endsWatch);
      if (work && live.rounds >= live.maxRounds) {
        // The budget is spent. The news goes in the transcript for the
        // reader, and the thread stops here rather than working for ever.
        const text = describeNews(facts, events, { branch: fresh.pullRequest?.branch ?? fresh.branch ?? "", rounds: live.rounds, maxRounds: live.maxRounds, merge: live.merge });
        this.note(fresh.id, "warning", text);
        this.endWatch(fresh, "blocked", `The watch sent ${live.maxRounds} turn${live.maxRounds === 1 ? "" : "s"} that asked for more work, and the pull request still needs work. A person has to look at it.`);
        this.putThreadAndEmit(fresh);
        return;
      }
      if (work) live.rounds++;
      const text = describeNews(facts, events, { branch: fresh.pullRequest?.branch ?? fresh.branch ?? "", rounds: live.rounds, maxRounds: live.maxRounds, merge: live.merge });
      if (end) this.endWatch(fresh, end.kind, end.kind === "closed" ? "The pull request was closed without a merge." : end.by === "covey" ? `Covey merged the pull request (${end.method}) under the auto policy.` : "The pull request was merged.");
      this.putThreadAndEmit(fresh);
      this.opts.log?.(`watch news thread=${fresh.id.slice(0, 8)} pr=#${w.number} events=${events.map((e) => e.kind).join(",")} rounds=${live.rounds}/${live.maxRounds}`);
      // A turn, not a note: a note is read by a person, and a turn resumes a
      // session the engine released. This is the whole reason the watch exists.
      await this.dispatch({ commandId: randomUUID(), type: "turn.send", threadId: fresh.id, turnId: randomUUID(), text })
        .catch((e: any) => this.note(fresh.id, "warning", `Could not deliver the news on pull request #${w.number} as a turn: ${e?.message ?? String(e)}`));
    } finally {
      this.polling.delete(t.id);
    }
  }

  /** Store what a poll found out about itself, on the row as it is now. */
  private recordPoll(threadId: string, number: number, fn: (w: PullRequestWatch) => void, nowIso: string): void {
    const fresh = this.db.getThread(threadId);
    if (!fresh?.watch || fresh.watch.state !== "watching" || fresh.watch.number !== number) return;
    fn(fresh.watch);
    fresh.watch.polledAt = nowIso;
    this.putThreadAndEmit(fresh);
  }

  /** The gate for one member: CI, staleness, conflicts, the turn, the evidence. */
  async runGate(threadId: string, label: string, state: RunMemberState, evidence: RegressionEvidence | null): Promise<GateVerdict> {
    const { ref, host, base } = await this.memberContext(threadId, label, state, false);
    const [pr, head] = await Promise.all([host.pullRequest(ref.branch), host.baseHead(base)]);
    return gateMember({ member: ref, pr, base: head, evidence });
  }

  /** The size and the files of a member's branch, which the merge order reads. */
  async runMemberDiff(threadId: string): Promise<MemberDiff | null> {
    const { ref, host } = await this.memberContext(threadId, "", "review", false);
    const pr = await host.pullRequest(ref.branch);
    if (!pr) return null;
    return {
      branch: ref.branch,
      additions: pr.additions,
      deletions: pr.deletions,
      files: pr.files,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    };
  }

  /** The merge order for a whole run. Pure, and one implementation for every client. */
  runQueue(entries: QueueEntryWire[]): QueuePosition[] {
    return buildQueue(entries);
  }

  /** Merge one member. The gate is read fresh here and the audit runs after. */
  async runMerge(params: {
    threadId: string; label: string; state: RunMemberState;
    evidence: RegressionEvidence | null; actor: MergeParty;
    method?: "merge" | "squash" | "rebase"; queue?: QueuePosition[];
  }): Promise<{ merged: boolean; verdict: GateVerdict; audit: AuditFinding[] }> {
    const { ref, host, base } = await this.memberContext(params.threadId, params.label, params.state, true);
    const result = await mergeMember(host, {
      member: ref, base, evidence: params.evidence, actor: params.actor,
      method: params.method, queue: params.queue,
    });
    return result.merged
      ? { merged: true, verdict: result.verdict, audit: result.audit }
      : { merged: false, verdict: result.verdict, audit: [] };
  }

  /** What a merged member's branch still holds that the base branch does not. */
  async runAudit(threadId: string, label: string): Promise<AuditFinding | null> {
    const { ref, host, base } = await this.memberContext(threadId, label, "merged", false);
    return findingFor(ref, base, await host.revList(base, ref.branch));
  }

  private async startTurn(threadId: string, turnId: string, text: string, attachments: Attachment[]): Promise<number> {
    const t = this.db.getThread(threadId)!;
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    await this.reviveWorktree(t, p);
    const cwd = t.worktreePath ?? p.workspaceRoot;
    const session = this.ensureSession(t);
    const now = new Date().toISOString();
    // snapshot the working tree before the agent touches it
    const before = await captureCheckpoint(cwd, `${threadId}/${turnId}/before`).catch(() => null);
    this.db.putCheckpoint({ threadId, turnId, beforeTree: before, afterTree: null, cwd });
    session.sendTurn(turnId, text, attachments);
    const fresh = this.db.getThread(threadId)!;
    const firstMessage = fresh.lastMessageAt === null;
    fresh.latestTurn = { turnId, state: "running", startedAt: now, completedAt: null };
    fresh.lastMessageAt = now;
    fresh.status = "running";
    // A thread is named by its first message only — later turns must not
    // rename it. The first line stands in at once; a weak model improves on it
    // a few seconds later.
    const nameIt = titleIsAuto(fresh) && (firstMessage || fresh.title === "New thread");
    if (nameIt) { fresh.title = fallbackTitle(text); fresh.titleAuto = true; }
    const seq = this.putThreadAndEmit(fresh);
    if (nameIt) void this.autoTitle(threadId, text, cwd);
    return seq;
  }

  /**
   * Replace an auto title with one a weak model wrote for the first message.
   * Runs beside the turn: the thread already shows the derived title, so a
   * slow or failed query costs nothing but the improvement.
   */
  private async autoTitle(threadId: string, text: string, cwd: string) {
    if (this.titling.has(threadId)) return;
    const abort = new AbortController();
    this.titling.set(threadId, abort);
    try {
      const title = await generateTitle(text, cwd, abort);
      const t = this.db.getThread(threadId);
      // The user may have renamed the thread while the model was thinking.
      if (!title || !t || !titleIsAuto(t)) return;
      t.title = title;
      this.putThreadAndEmit(t);
    } catch {
      /* the derived title stands */
    } finally {
      this.titling.delete(threadId);
    }
  }

  /** After a turn ends: compute its diff, then start the next queued turn. */
  private async finishTurn(threadId: string, turnId: string) {
    const cp = this.db.getCheckpoint(threadId, turnId);
    if (cp?.beforeTree) {
      const after = await captureCheckpoint(cp.cwd, `${threadId}/${turnId}/after`).catch(() => null);
      this.db.putCheckpoint({ threadId, turnId, beforeTree: cp.beforeTree, afterTree: after, cwd: cp.cwd });
      const summary = after ? await diffCheckpoints(cp.cwd, cp.beforeTree, after) : null;
      const t = this.db.getThread(threadId);
      if (t?.latestTurn?.turnId === turnId) {
        t.latestTurn.diff = summary ?? { files: [], additions: 0, deletions: 0, unavailable: "could not snapshot working tree" };
        this.putThreadAndEmit(t);
      }
    }
    // Messages folded into this turn have been read by now; the marker that
    // says "the agent has not seen this yet" has to go with the turn.
    for (const i of this.db.flaggedUserItems(threadId, "folded")) {
      if (i.turnId !== turnId) continue;
      delete (i as any).folded;
      this.persistItem(i);
    }
    const q = this.queues.get(threadId);
    const next = q?.shift();
    if (!next) return;
    const item = this.db.getItem(`u:${next.turnId}`);
    if (item && item.kind === "user") { delete item.queued; this.persistItem(item); }
    const t = this.db.getThread(threadId);
    if (t) { t.queuedTurns = q!.length; this.db.putThread(t); }
    await this.startTurn(threadId, next.turnId, next.text, next.attachments).catch((e) => {
      const now = new Date().toISOString();
      this.persistItem({ id: `err:${randomUUID()}`, threadId, turnId: next.turnId, seq: 0, createdAt: now, updatedAt: now, kind: "error", text: `queued turn failed: ${e.message}` });
    });
  }

  /**
   * Keep the finished turn. One row per turn is what makes "how much did last
   * week cost" answerable at all — the thread itself holds only the latest
   * turn, and the next turn overwrites it.
   *
   * A turn the user interrupted is kept too: it still spent tokens.
   */
  private recordTurn(t: Thread, usage: TurnUsage) {
    const turn = t.latestTurn!;
    const state = turn.state === "running" ? "completed" : turn.state;
    this.db.putTurn({
      threadId: t.id,
      turnId: turn.turnId,
      projectId: t.projectId,
      startedAt: turn.startedAt,
      endedAt: turn.completedAt ?? new Date().toISOString(),
      state,
      // The model that did most of the work. `byModel` keeps the rest, so a
      // turn that changed model, or ran a subagent elsewhere, can be re-priced.
      model: usage.byModel[0]?.model ?? t.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      byModel: usage.byModel,
    });
  }

  /**
   * Totals for the turns this machine ran inside a window. The client owns the
   * clock and sends absolute instants, so several machines asked the same
   * question answer about the same period.
   */
  usageReport(q: UsageQuery): UsageReport {
    const since = q.since ?? null;
    const until = q.until ?? null;
    const groupBy: UsageGroupBy = q.groupBy ?? "thread";
    const total = this.db.usageTotals(since, until);
    const groups = groupBy === "machine"
      // One database holds one machine's turns, so the machine's own total is
      // the whole answer.
      ? [{ key: this.machine.machineId, label: this.machine.name, ...total }]
      : this.db.usageGroups(groupBy, since, until);
    return { machineId: this.machine.machineId, machineName: this.machine.name, since, until, groupBy, total, groups };
  }

  /** Drop transcript entries at or after an ISO timestamp (fallback when no uuid is known). */
  private truncateTranscriptByTime(projectKey: string, sessionId: string, iso: string): number {
    const rows = this.db.loadTranscript(projectKey, sessionId, "") ?? [];
    const first = rows.find((e) => typeof e.timestamp === "string" && (e.timestamp as string) >= iso && typeof e.uuid === "string");
    if (!first) return 0;
    return this.db.truncateTranscriptAt(projectKey, sessionId, first.uuid as string);
  }

  async projectGit(projectId: string): Promise<ProjectGit> {
    const p = this.db.getProject(projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    return gitInfo(p.workspaceRoot);
  }

  async turnDiff(threadId: string, turnId?: string): Promise<TurnDiff | null> {
    const cp = this.db.getCheckpoint(threadId, turnId);
    if (!cp?.beforeTree || !cp.afterTree) return null;
    // The checkpoint trees live in the repo, which outlives the worktree they
    // were taken in — so an archived thread's diffs still read, from the project.
    let cwd = cp.cwd;
    if (!existsSync(cwd)) {
      const t = this.db.getThread(threadId);
      const p = t && this.db.getProject(t.projectId);
      if (!p) return null;
      cwd = p.workspaceRoot;
    }
    const [summary, patch] = await Promise.all([diffCheckpoints(cwd, cp.beforeTree, cp.afterTree), patchBetween(cwd, cp.beforeTree, cp.afterTree)]);
    if (!summary) return null;
    return { turnId: cp.turnId, ...summary, patch: patch ?? "" };
  }

  /**
   * One directory under a thread's working directory, for the `@` menu.
   *
   * The whole directory comes back, not the matches for what is typed so far:
   * the client filters as the reader types, so a word costs one request rather
   * than one per keystroke. Nothing outside the working directory is offered —
   * a mention names the thread's own files.
   */
  listThreadDir(threadId: string, dir: string, limit = 500): { dir: string; entries: PathEntry[]; truncated: boolean } {
    const t = this.db.getThread(threadId);
    if (!t) throw new EngineError("not_found", "thread not found");
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    const root = this.gitCwd(t, p);
    // An archived thread in a clone has no directory: its worktree is gone and
    // the project is a bare repository, whose insides are nobody's files.
    if (existsSync(join(root, "HEAD")) && !existsSync(join(root, ".git"))) return { dir, entries: [], truncated: false };
    const target = resolve(root, dir || ".");
    if (target !== root && !target.startsWith(root + sep)) throw new EngineError("bad_path", `${dir} is outside the thread's directory`);
    // Half a directory name is not an error; it is what typing looks like.
    if (!existsSync(target) || !statSync(target).isDirectory()) return { dir, entries: [], truncated: false };
    const all = readdirSync(target, { withFileTypes: true })
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { dir, entries: all.slice(0, limit), truncated: all.length > limit };
  }

  private mutateThread(threadId: string, fn: (t: Thread) => void): number {
    const t = this.db.getThread(threadId);
    if (!t) throw new EngineError("not_found", "thread not found");
    fn(t);
    return this.putThreadAndEmit(t);
  }

  // ---- worktrees ------------------------------------------------------------

  /** Clones in flight, by bare repository path. Two creates for one repository
   *  that arrive together wait on one clone. */
  private clones = new Map<string, Promise<{ ok: true } | { error: string }>>();

  private cloneOnce(url: string, root: string): Promise<{ ok: true } | { error: string }> {
    let p = this.clones.get(root);
    if (!p) {
      p = cloneBare(url, root).finally(() => this.clones.delete(root));
      this.clones.set(root, p);
    }
    return p;
  }

  /**
   * A worktree for a new thread in `p`, named by the thread's prefix.
   *
   * `carry` names a branch the thread had elsewhere. When `origin` has it the
   * worktree opens on that branch, so a moved thread keeps its commits; when
   * it does not, the thread starts from the default branch like any other, and
   * `carried` says which happened. Only a `covey/` branch is carried: a thread
   * from before worktrees names the checkout's own branch, and `main` is not
   * a branch to check out beside a clone.
   *
   * A `checkout` that is not a git repository, or one with nothing to branch
   * from, has no worktree to give: the thread works in the directory, as
   * every thread there did before projects were clones. A clone without its
   * repository is an error, because a bare repository is nowhere to work.
   */
  private async newWorktree(p: Project, name: string, carry: string | null): Promise<{ worktreePath: string | null; branch: string | null; cleanStart: CleanStart | null; carried: boolean }> {
    const inPlace = async () => ({ worktreePath: null, branch: isGitRepo(p.workspaceRoot) ? await currentBranch(p.workspaceRoot) : null, cleanStart: null, carried: false });
    if (!isGitRepo(p.workspaceRoot)) {
      if (p.kind === "clone") throw new EngineError("git", `${p.workspaceRoot} is not a repository; the bare clone was deleted`);
      return inPlace();
    }
    const path = worktreePath(p, name);
    if (carry?.startsWith("covey/") && (await fetchBranch(p.workspaceRoot, carry))) {
      const wt = await createWorktree(p.workspaceRoot, name, `origin/${carry}`, path, carry);
      if ("error" in wt) throw new EngineError("git", `could not create worktree from origin/${carry}: ${wt.error}`);
      return { worktreePath: wt.path, branch: wt.branch, cleanStart: null, carried: true };
    }
    const cleanStart = await cleanStartBase(p.workspaceRoot);
    if (!cleanStart) {
      if (p.kind === "clone") throw new EngineError("git", "no default branch (origin/HEAD, main or master) to branch from");
      return inPlace();
    }
    // A failed worktree is reported, never silently downgraded to the shared
    // checkout: the whole point of a worktree is isolation.
    const wt = await createWorktree(p.workspaceRoot, name, cleanStart.ref, path);
    if ("error" in wt) throw new EngineError("git", `could not create worktree from ${cleanStart.ref}: ${wt.error}`);
    return { worktreePath: wt.path, branch: wt.branch, cleanStart, carried: false };
  }

  /** Where a thread's git lives right now: its worktree while that exists (an
   *  archived thread's does not), else the project checkout — the same repo,
   *  sharing the same refs, so checkpoints read the same from either. */
  private gitCwd(t: Thread, p: Project): string {
    return t.worktreePath && existsSync(t.worktreePath) ? t.worktreePath : p.workspaceRoot;
  }

  /** Remove an archived thread's worktree, and record in its transcript what
   *  became of it — including the case where git kept it because of work in it. */
  private async releaseWorktree(t: Thread, did: "Archived" | "Moved" = "Archived"): Promise<void> {
    const p = this.db.getProject(t.projectId);
    if (!p || !t.worktreePath || !existsSync(t.worktreePath)) return;
    const r = await removeWorktree(p.workspaceRoot, t.worktreePath);
    const now = new Date().toISOString();
    this.persistItem({
      id: `note:${randomUUID()}`, threadId: t.id, turnId: null, seq: 0, createdAt: now, updatedAt: now, kind: "note",
      tone: "error" in r ? "warning" : "info",
      text: "error" in r
        ? `${did}, but the worktree stays: ${r.error.replace(/^fatal: /, "")}`
        : `${did} · removed the worktree ${t.worktreePath}` + (t.branch ? `, kept the branch ${t.branch}` : ""),
    });
  }

  /** Writing to an archived thread brings its worktree back at the same path,
   *  on the branch it had, so the turn runs where every earlier one did. */
  private async reviveWorktree(t: Thread, p: Project): Promise<void> {
    if (!t.worktreePath || existsSync(t.worktreePath)) return;
    if (!t.branch) throw new EngineError("git", `worktree ${t.worktreePath} is gone, and the thread has no branch to restore it from`);
    const r = await restoreWorktree(p.workspaceRoot, t.worktreePath, t.branch);
    if ("error" in r) throw new EngineError("git", `could not restore worktree ${t.worktreePath} from ${t.branch}: ${r.error}`);
    this.persistItem({
      id: `note:${randomUUID()}`, threadId: t.id, turnId: null, seq: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      kind: "note", tone: "info", text: `Restored the worktree ${t.worktreePath} from ${t.branch}`,
    });
  }

  // ---- sessions -------------------------------------------------------------

  private ensureSession(t: Thread): ClaudeSession {
    const live = this.sessions.get(t.id);
    if (live?.running) { this.touch(t.id); return live; }
    // A session that stopped answering still owns a subprocess until somebody
    // aborts it. Replacing it without that leaves a process no map names.
    if (live) this.dropSession(t.id);
    const p = this.db.getProject(t.projectId);
    if (!p) throw new EngineError("not_found", "project not found");
    const hasTranscript = this.db.loadTranscript(t.id, t.sessionId, "") !== null;
    // Say where the wait comes from before the wait starts, so a slow first
    // turn reads as a resume rather than as a thread that hangs.
    if (this.released.delete(t.id) && hasTranscript) {
      this.note(t.id, "info", "Resumed this thread's Claude session from its transcript. The session was released while the thread was idle, so this first reply is slower.");
    }
    // Fixed projectKey (= thread id) so the transcript key is cwd independent.
    const store = makeSessionStore(this.db);
    const storeForThread = {
      append: (key: any, entries: any) => store.append({ ...key, projectKey: t.id }, entries),
      load: (key: any) => store.load({ ...key, projectKey: t.id }),
      listSessions: (_: string) => store.listSessions!(t.id),
    };
    const session = new ClaudeSession(
      {
        threadId: t.id, sessionId: t.sessionId, projectId: p.id, cwd: t.worktreePath ?? p.workspaceRoot,
        model: t.model, permissionMode: t.permissionMode, permissionModeExplicit: t.permissionModeExplicit ?? false,
        streaming: t.streaming ?? false,
        resume: hasTranscript, sessionStore: storeForThread,
      },
      this.sinkFor(t.id),
      // `undefined` selects the SDK's own `query`, which is what a daemon uses.
      this.opts.spawn,
    );
    this.sessions.set(t.id, session);
    this.touch(t.id);
    session.start();
    this.opts.log?.(`session started thread=${t.id.slice(0, 8)} resume=${hasTranscript} live=${this.sessions.size}/${this.liveSessionLimit()}`);
    // The new session is the most recent, so the budget never takes the one
    // the user is about to talk to.
    this.enforceBudget();
    return session;
  }

  // ---- releasing an idle session -------------------------------------------

  /**
   * How many Claude sessions this daemon holds, and what it allows.
   *
   * `/health` reports both, so "how many session processes should this machine
   * have" has an answer to compare a process list against.
   */
  sessionCensus(): { live: number; limit: number; idleMinutes: number } {
    return { live: this.sessions.size, limit: this.liveSessionLimit(), idleMinutes: this.idleLimitMinutes() };
  }

  /** This session is of use right now; the idle sweep counts from here. */
  private touch(threadId: string) {
    if (this.sessions.has(threadId)) this.touchedAt.set(threadId, this.now());
  }

  /** Stop a session and forget it. The abort kills the subprocess. */
  private dropSession(threadId: string) {
    this.sessions.get(threadId)?.stop();
    this.sessions.delete(threadId);
    this.touchedAt.delete(threadId);
    this.released.delete(threadId);
  }

  /** Minutes of idleness this machine allows; `0` keeps sessions for ever. */
  private idleLimitMinutes(): number {
    const v = this.machine.settings.sessionIdleMinutes;
    return v === null || v === undefined ? DEFAULT_SESSION_IDLE_MINUTES : Math.max(0, Math.floor(v));
  }

  /** How many sessions this machine keeps live at one time. */
  private liveSessionLimit(): number {
    const v = this.machine.settings.maxLiveSessions;
    return v === null || v === undefined ? defaultLiveSessionLimit() : Math.max(1, Math.floor(v));
  }

  /**
   * Whether the session owes anybody anything. A thread that waits on an
   * approval or a question is idle by status and must not be reaped: the user
   * reads the request, and the answer needs the same process.
   */
  private sessionBusy(threadId: string): boolean {
    const s = this.sessions.get(threadId);
    if (!s) return false;
    if (s.busy) return true;
    // A queued turn needs no rule of its own: it starts the moment the running
    // one ends, and the running one holds the session. (A queue left over from
    // a daemon restart drains only when the user writes again, so a rule on the
    // queue alone would pin such a thread's session for ever.)
    const t = this.db.getThread(threadId);
    if (!t) return false;
    return t.latestTurn?.state === "running" || t.pendingApprovals > 0
      || t.status === "running" || t.status === "starting" || t.status === "waiting";
  }

  /**
   * Stop the sessions nobody needs, and say so in the threads that lose one.
   *
   * Two rules, in order: a session idle beyond the machine's limit goes, and
   * then, while more sessions are live than the budget allows, the least
   * recently used ones go. A busy session never goes, under either rule — the
   * budget is a target, not a promise, because a machine may have more turns
   * in flight than its memory would like.
   *
   * @returns the threads whose session it released.
   */
  sweepSessions(): string[] {
    const released: string[] = [];
    const limit = this.idleLimitMinutes();
    if (limit > 0) {
      const now = this.now();
      for (const threadId of [...this.sessions.keys()]) {
        const idleMs = now - (this.touchedAt.get(threadId) ?? now);
        if (idleMs < limit * 60_000) continue;
        if (this.sessionBusy(threadId)) continue;
        const minutes = Math.round(idleMs / 60_000);
        this.release(threadId, `idle for ${minutes} minute${minutes === 1 ? "" : "s"}`,
          `Released this thread's Claude session after ${minutes} minute${minutes === 1 ? "" : "s"} idle, to give its memory back to the machine.`);
        released.push(threadId);
      }
    }
    return [...released, ...this.enforceBudget()];
  }

  /** Release the least recently used sessions until the budget is met. */
  private enforceBudget(): string[] {
    const max = this.liveSessionLimit();
    let over = this.sessions.size - max;
    if (over <= 0) return [];
    const released: string[] = [];
    const oldestFirst = [...this.sessions.keys()]
      .filter((id) => !this.sessionBusy(id))
      .sort((a, b) => (this.touchedAt.get(a) ?? 0) - (this.touchedAt.get(b) ?? 0));
    for (const threadId of oldestFirst) {
      if (over <= 0) break;
      this.release(threadId, `over the limit of ${max} live sessions`,
        `Released this thread's Claude session: this machine keeps ${max} session${max === 1 ? "" : "s"} live, and other threads worked more recently.`);
      released.push(threadId);
      over--;
    }
    return released;
  }

  /** Stop one session, write the reason in its thread, and log it. */
  private release(threadId: string, why: string, text: string) {
    this.dropSession(threadId);
    this.released.add(threadId);
    this.note(threadId, "info", `${text} The next message starts a new process and resumes the transcript, so nothing is lost — that first reply takes a second or so longer.`);
    this.opts.log?.(`session released thread=${threadId.slice(0, 8)} reason=${why} live=${this.sessions.size}/${this.liveSessionLimit()}`);
  }

  // ---- credentials ----------------------------------------------------------

  /**
   * Look for a token rotation, and stop the sessions it left holding a dead
   * token — before a user types into one of them.
   *
   * This runs on the sweep timer. The first read only records: a daemon that
   * has just started has no stale session to cycle. A store this daemon cannot
   * read gives `null`, and then the watch does nothing at all; `onAuthFailure`
   * is what catches the fault on a machine like that.
   *
   * @returns the threads whose session it stopped.
   */
  async checkCredentials(): Promise<string[]> {
    const stamp = await (this.opts.credentialStamp ?? credentialStamp)().catch(() => null);
    if (!stamp) return [];
    const seen = this.credStamp;
    this.credStamp = stamp;
    if (seen === null || seen === stamp) return [];
    const cycled = this.cycleSessions(null, "Your Claude credentials changed while this session was live, so the token it holds no longer works.");
    if (cycled.length) this.opts.log?.(`credentials rotated: cycled ${cycled.length} session${cycled.length === 1 ? "" : "s"}`);
    return cycled;
  }

  /**
   * Stop every session that is free to go, because what they hold is what just
   * failed. A busy session stays: it owes somebody an answer, and to kill a
   * turn in flight costs more than the failure it saves. If that turn's token
   * is dead the turn fails on its own, and lands in `onAuthFailure`.
   */
  private cycleSessions(except: string | null, why: string): string[] {
    const cycled: string[] = [];
    for (const threadId of [...this.sessions.keys()]) {
      if (threadId === except || this.sessionBusy(threadId)) continue;
      this.release(threadId, "credentials changed", why);
      cycled.push(threadId);
    }
    return cycled;
  }

  /**
   * A turn died on the credentials rather than on the work.
   *
   * The dead token lives in the subprocess memory and nothing can replace it
   * there: an SDK session has no terminal for `/login`, so every later message
   * to that process fails the same way — which is what a thread looks like
   * when a `ping` answers `401 OAuth access token has been revoked`. So the
   * process goes, and the next one reads whatever the store holds now. Its
   * siblings hold the same token, so they go too.
   *
   * Then the work restarts itself, once. A second restart would be a thread
   * that talks to itself while the credentials stay broken, so the second
   * failure is a note that names the command which fixes it.
   */
  private onAuthFailure(threadId: string, turnId: string | null, error: string) {
    const state = this.authRetry.get(threadId);
    // One failure reaches this twice — the turn's result and the session's
    // status both carry it — and the user needs to read it once.
    if (state === "scheduled" || state === "told") return;
    this.dropSession(threadId);
    const cycled = this.cycleSessions(threadId, "Another thread's session could not authenticate, and this one holds the same credentials.");
    this.opts.log?.(`auth failure thread=${threadId.slice(0, 8)} restart=${state !== "spent"} cycled=${cycled.length} error=${error.slice(0, 120)}`);
    if (state === "spent") {
      this.authRetry.set(threadId, "told");
      this.note(threadId, "warning", `This thread could not authenticate twice in a row: ${error} Covey stopped the session and stops here. Run "claude auth login" in a terminal on this machine, then send a message.`);
      return;
    }
    if ((this.queues.get(threadId)?.length ?? 0) > 0) {
      this.note(threadId, "warning", `This thread's session could not authenticate: ${error} Covey stopped it. The next message in the queue starts a new session, which reads your credentials again.`);
      return;
    }
    this.note(threadId, "warning", `This thread's session could not authenticate: ${error} Covey stopped it and starts a new one, which reads your credentials again.`);
    this.authRetry.set(threadId, "scheduled");
    const timer = setTimeout(() => {
      this.retryTimers.delete(threadId);
      this.authRetry.set(threadId, "spent");
      void this.restartWork(threadId, turnId);
    }, 0);
    timer.unref?.();
    this.retryTimers.set(threadId, timer);
  }

  /** A thread that is gone restarts nothing. */
  private forgetAuthFailure(threadId: string) {
    const timer = this.retryTimers.get(threadId);
    if (timer) { clearTimeout(timer); this.retryTimers.delete(threadId); }
    this.authRetry.delete(threadId);
  }

  /** Send the failed work to a new session, unless the thread found other work
   *  in the meantime. */
  private async restartWork(threadId: string, turnId: string | null) {
    const t = this.db.getThread(threadId);
    if (!t || t.movedTo || t.latestTurn?.state === "running") return;
    if ((this.queues.get(threadId)?.length ?? 0) > 0) return;
    const text = this.restartText(threadId, turnId);
    if (!text) return;
    await this.dispatch({ commandId: randomUUID(), type: "turn.send", threadId, turnId: randomUUID(), text })
      .catch((e: any) => this.note(threadId, "warning", `Could not start a new session after the authentication error: ${e?.message ?? String(e)}`));
  }

  /**
   * What to say to the new session. A turn that had already written something
   * carries on, because the transcript holds that work and the model can read
   * it. A turn that died before its first word is sent again instead: "go on"
   * means nothing to a model that never started.
   */
  private restartText(threadId: string, turnId: string | null): string | null {
    if (!turnId) return null;
    const started = this.db.sql.prepare(
      "SELECT 1 FROM items WHERE thread_id = ? AND json_extract(json,'$.turnId') = ? AND json_extract(json,'$.kind') IN ('assistant','thinking','tool') LIMIT 1",
    ).get(threadId, turnId);
    if (started) return "Your last session could not authenticate and stopped part way through that turn. This is a new session on the same transcript. Go on from the point where it stopped.";
    const item = this.db.getItem(`u:${turnId}`);
    // Text alone: the CLI already mirrored the attachments of that message
    // into the transcript, and the new session reads them from there.
    return item && item.kind === "user" ? item.text : null;
  }

  /** One line in a thread's timeline, from the daemon rather than the model. */
  private note(threadId: string, tone: "info" | "warning", text: string) {
    const now = new Date().toISOString();
    this.persistItem({ id: `note:${randomUUID()}`, threadId, turnId: null, seq: 0, createdAt: now, updatedAt: now, kind: "note", tone, text });
  }

  private sinkFor(threadId: string): SessionSink {
    return {
      now: () => new Date().toISOString(),
      upsertItem: (item, opts) => {
        // Work is use: a turn that runs for an hour keeps its own session, and
        // the idle clock starts from the last line the agent wrote.
        this.touch(threadId);
        this.upsertItem(item, opts);
        if (item.kind === "approval" || item.kind === "question") this.recountPending(threadId);
      },
      getItemByToolUse: (toolUseId) => {
        for (const [, s] of this.streamTimers) if (s.latest.kind === "tool" && s.latest.toolUseId === toolUseId) return s.latest as ToolCallItem;
        const r: any = this.db.sql.prepare(
          "SELECT json FROM items WHERE thread_id = ? AND json_extract(json,'$.toolUseId') = ? AND json_extract(json,'$.kind') = 'tool'",
        ).get(threadId, toolUseId);
        return r ? (JSON.parse(r.json) as ToolCallItem) : null;
      },
      onStatus: (status, error) => {
        const t = this.db.getThread(threadId);
        if (!t) return;
        t.status = status;
        t.lastError = error ?? null;
        const wasRunning = t.latestTurn?.state === "running";
        if (status === "error" && wasRunning) { t.latestTurn!.state = "error"; t.latestTurn!.completedAt = new Date().toISOString(); }
        this.putThreadAndEmit(t);
        if (status === "error" && wasRunning && t.latestTurn) void this.finishTurn(threadId, t.latestTurn.turnId);
        if (status === "error" && isAuthFailure(error)) this.onAuthFailure(threadId, t.latestTurn?.turnId ?? null, error!);
      },
      onTurnComplete: (info) => {
        const t = this.db.getThread(threadId);
        if (!t) return;
        if (t.latestTurn && t.latestTurn.state === "running") {
          t.latestTurn.state = info.isError ? "error" : "completed";
          t.latestTurn.completedAt = new Date().toISOString();
        }
        if (t.latestTurn) {
          // These are this turn's own figures, not the session's running total.
          t.latestTurn.usage = info.usage;
          t.latestTurn.costUsd = info.usage.estimatedCostUsd;
          t.latestTurn.inputTokens = info.usage.inputTokens;
          t.latestTurn.outputTokens = info.usage.outputTokens;
          this.recordTurn(t, info.usage);
        }
        t.status = "idle";
        t.lastMessageAt = new Date().toISOString();
        this.putThreadAndEmit(t);
        if (t.latestTurn) {
          if (info.userMessageUuid) { const cp = this.db.getCheckpoint(threadId, t.latestTurn.turnId); if (cp) this.db.putCheckpoint({ ...cp, threadId, userMessageUuid: info.userMessageUuid }); }
          void this.finishTurn(threadId, t.latestTurn.turnId);
        }
        // A turn that answered is a session that authenticated, so the one
        // restart this thread is allowed comes back for the next rotation.
        if (info.isError && isAuthFailure(info.result)) this.onAuthFailure(threadId, t.latestTurn?.turnId ?? null, info.result);
        else if (!info.isError) this.forgetAuthFailure(threadId);
      },
      onSessionInit: (info) => {
        const t = this.db.getThread(threadId);
        if (t && !t.model) { t.model = info.model; this.putThreadAndEmit(t); }
      },
      onModelUsed: () => {},
      onCommands: (commands) => this.setThreadCommands(threadId, commands),
    };
  }

  /**
   * Replace the thread's `/` menu and tell the clients watching it. An
   * unchanged list is dropped here, because the SDK re-sends the whole list
   * on every session start and a thread event costs a seq.
   *
   * The list is stored, so a thread that has run before still has a menu after
   * the daemon restarts. A thread that has never run keeps `null` — "not known
   * yet" — until a session answers for it.
   */
  setThreadCommands(threadId: string, commands: SlashCommandInfo[]) {
    const before = this.db.threadCommands(threadId);
    if (before && sameCommands(before, commands)) return;
    this.db.putThreadCommands(threadId, commands);
    this.emitThread(threadId, { kind: "commands.updated", commands });
  }

  private recountPending(threadId: string) {
    const r: any = this.db.sql.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE thread_id = ? AND json_extract(json,'$.status') = 'pending' AND json_extract(json,'$.kind') IN ('approval','question')",
    ).get(threadId);
    const t = this.db.getThread(threadId);
    if (t && t.pendingApprovals !== Number(r.n)) { t.pendingApprovals = Number(r.n); this.putThreadAndEmit(t); }
  }

  // ---- move between machines ----------------------------------------------

  async exportThread(threadId: string): Promise<ThreadExport> {
    const thread = this.db.getThread(threadId);
    if (!thread) throw new EngineError("not_found", "thread not found");
    if (thread.latestTurn?.state === "running") throw new EngineError("busy", "interrupt the running turn before moving");
    const project = this.db.getProject(thread.projectId)!;
    // flush any throttled streaming items first
    for (const [k, s] of this.streamTimers) if (s.latest.threadId === threadId) { clearTimeout(s.timer); this.streamTimers.delete(k); this.persistItem(s.latest); }
    const transcripts = this.db.transcriptSubpaths(thread.sessionId)
      .map(({ projectKey, subpath }) => ({ subpath, entries: this.db.loadTranscript(projectKey, thread.sessionId, subpath) ?? [] }));
    return {
      version: 1, exportedAt: new Date().toISOString(),
      sourceMachineId: this.machine.machineId, sourceMachineName: this.machine.name,
      project: {
        title: project.title, workspaceRoot: project.workspaceRoot, repositoryIdentity: project.repositoryIdentity,
        remoteUrl: project.remoteUrl ?? (isGitRepo(project.workspaceRoot) ? await remoteUrl(project.workspaceRoot) : null),
      },
      thread, items: this.db.allItems(threadId), transcripts,
    };
  }

  async importThread(exp: ThreadExport, opts: { projectId?: string; url?: string }): Promise<{ threadId: string; projectId: string }> {
    let project = opts.projectId ? this.db.getProject(opts.projectId) : null;
    if (!project && exp.project.repositoryIdentity) {
      project = this.db.listProjects().find((p) => p.repositoryIdentity === exp.project.repositoryIdentity) ?? null;
    }
    if (!project) {
      const url = opts.url ?? exp.project.remoteUrl;
      if (!url) throw new EngineError("no_project", "no project here for this repository, and no URL to clone it from");
      await this.apply({ type: "project.create", url, title: exp.project.title });
      project = this.db.listProjects().find((p) => p.repositoryIdentity === normaliseRemote(url)) ?? null;
    }
    if (!project) throw new EngineError("no_project", "no destination project; pass projectId or url");
    const threadId = randomUUID();
    const now = new Date().toISOString();
    // The thread's own worktree, here. Its branch comes along when the source
    // pushed it; otherwise the thread starts from the default branch and is
    // told so, because the work on that branch is still on the other machine.
    const tree = await this.newWorktree(project, threadId.slice(0, 8), exp.thread.branch);
    const t: Thread = {
      ...exp.thread, id: threadId, projectId: project.id, status: "idle", lastError: null,
      worktreePath: tree.worktreePath, branch: tree.branch, movedTo: null, pendingApprovals: 0, queuedTurns: 0, updatedAt: now,
      latestTurn: exp.thread.latestTurn && exp.thread.latestTurn.state === "running" ? { ...exp.thread.latestTurn, state: "interrupted" } : exp.thread.latestTurn,
    };
    this.db.transaction(() => {
      this.db.putThread(t);
      for (const item of exp.items) {
        const seq = this.db.nextThreadSeq(threadId);
        const moved: TimelineItem = { ...item, threadId, seq };
        if ((moved.kind === "approval" || moved.kind === "question") && moved.status === "pending") (moved as any).status = "expired";
        this.db.putItem(moved);
      }
    });
    // The transcript names the directory the session ran in: the thread's old
    // worktree, or the project directory for a thread from before worktrees.
    const from = exp.thread.worktreePath ?? exp.project.workspaceRoot;
    const to = t.worktreePath ?? project.workspaceRoot;
    for (const tr of exp.transcripts) {
      this.db.appendTranscript(threadId, t.sessionId, tr.subpath, tr.entries.map((e) => rewriteCwd(e, from, to)));
    }
    const noteNow = new Date().toISOString();
    let where = "";
    if (t.worktreePath && tree.carried) where = ` The thread works in a worktree on ${t.branch}, fetched from origin.`;
    else if (t.worktreePath) {
      where = ` The thread works in a new worktree on ${t.branch}.`;
      if (exp.thread.branch) where += ` The branch ${exp.thread.branch} is not on origin, so its commits are still on ${exp.sourceMachineName}.`;
    }
    this.persistItem({ id: `note:${randomUUID()}`, threadId, turnId: null, seq: 0, createdAt: noteNow, updatedAt: noteNow, kind: "note", tone: "info", text: `Moved here from ${exp.sourceMachineName} (${from}).${where}` });
    if (tree.cleanStart) this.note(threadId, ...cleanStartNote(tree.cleanStart));
    this.emitShell({ kind: "thread.upserted", thread: this.db.getThread(threadId)! });
    return { threadId, projectId: project.id };
  }

  markMoved(threadId: string, machineId: string, newThreadId: string): void {
    const t = this.db.getThread(threadId);
    if (!t) return;
    this.dropSession(threadId);
    // The export carried the watch whole, so the other machine's daemon
    // polls it from the same cursor. This one must not poll it too.
    if (t.watch?.state === "watching") this.endWatch(t, "dropped", "The thread was moved to another machine, which watches from here on.");
    t.movedTo = { machineId, threadId: newThreadId };
    t.status = "idle";
    t.archivedAt = t.archivedAt ?? new Date().toISOString();
    this.putThreadAndEmit(t);
    // The work lives on the other machine now. The worktree here is given
    // back, the branch stays, and a thread that comes back gets a new one.
    void this.releaseWorktree(t, "Moved");
  }

  shutdown() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
    this.touchedAt.clear();
    this.released.clear();
    for (const a of this.titling.values()) a.abort();
    this.titling.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.authRetry.clear();
  }
}

/** A whole number at or above `min`, or `null` for "no opinion". A client that
 *  sends nonsense gets the daemon's default rather than a broken limit. */
function clampSetting(v: number | null, min: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.max(min, Math.floor(v));
}

/**
 * What to record about who asked for a thread.
 *
 * The command wins. A caller that knows better than its own client name says
 * so — the TUI dispatches a run member over the same connection a person
 * types into, and that thread is machinery all the same.
 *
 * Otherwise the name the connection gave at `hello` decides: the TUI is the
 * client a person types into, so every other name is a program. That name is
 * self-declared and the daemon cannot check it, which makes this a hint for a
 * reader and never a permission. A connection that named nothing gets no
 * origin at all, so it behaves exactly as it did before this field existed.
 *
 * `parent` is the thread this one belongs under, already checked against the
 * database by the caller — the id the command named, or else the thread the
 * connection said it runs inside at `hello`. The `hello` half is the only way
 * an agent can put its own children under itself: nothing else on the wire
 * knows which thread a program speaks for. Whatever `explicit` says about a
 * parent is ignored here, because it is what the caller resolved.
 */
export function threadOrigin(explicit: ThreadOrigin | undefined, client: string, parent = ""): ThreadOrigin | undefined {
  const from = parent ? { parentThreadId: parent } : {};
  if (explicit) {
    const { parentThreadId: _asked, ...rest } = explicit;
    const name = rest.client ?? client;
    // `parent` is the answer to what the command asked for, not a second
    // opinion beside it: the caller resolved the id the command named against
    // the threads this daemon holds, and an id that named nothing is gone.
    return { ...rest, ...(name ? { client: name } : {}), ...from };
  }
  if (!client && !parent) return undefined;
  // A connection that named a parent thread is a program by that fact alone:
  // the one client a person types into never names one.
  return { by: isUserClient(client) ? "user" : "agent", ...(client ? { client } : {}), ...from };
}

/** Whether covey still owns this thread's title. Threads from before
 *  `titleAuto` existed are read through the sentinel it replaced. */
function titleIsAuto(t: Thread): boolean {
  return t.titleAuto ?? t.title === "New thread";
}

/** Rewrite the session's recorded cwd so the SDK resumes against the new path. */
function rewriteCwd(entry: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  if (from === to) return entry;
  const e = { ...entry };
  if (e.cwd === from) e.cwd = to;
  return e;
}

export type { PermissionMode };

/** A merge method a client named, or the fallback. Nonsense is the fallback. */
function mergeMethodOf(v: unknown, fallback: MergeMethod): MergeMethod {
  return v === "merge" || v === "squash" || v === "rebase" ? v : fallback;
}

/** Two menus are the same when they hold the same commands in the same order. */
function sameCommands(a: SlashCommandInfo[], b: SlashCommandInfo[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i]!.name && c.description === b[i]!.description && c.argumentHint === b[i]!.argumentHint);
}
