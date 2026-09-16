import { randomUUID } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import { existsSync, statSync, rmSync, readdirSync } from "node:fs";
import type {
  Command, CommandEnvelope, Project, Thread, TimelineItem, ToolCallItem, ShellEvent, ThreadEvent,
  ShellSnapshot, ThreadSnapshot, MachineInfo, ThreadExport, PermissionMode, ShellEventBody, ThreadEventBody,
} from "@covey/protocol";
import { Db } from "./db.js";
import { ClaudeSession, type SessionSink, type QueryFactory } from "./claude.js";
import { makeSessionStore } from "./sessionStore.js";
import { repositoryIdentity, currentBranch, createWorktree, removeWorktree, restoreWorktree, isGitRepo, gitInfo, defaultBranchRef, captureCheckpoint, diffCheckpoints, patchBetween, deleteCheckpointRefs, restoreTree } from "./git.js";
import { materialiseAttachments, attachmentsDir } from "./attachments.js";
import { resolveDefaultPermissionMode, saveMachineSettings, defaultLiveSessionLimit, DEFAULT_SESSION_IDLE_MINUTES } from "./config.js";
import { generateTitle, fallbackTitle } from "./title.js";
import type { Attachment, TurnDiff, ProjectGit, WorkspaceMode, SlashCommandInfo, PathEntry, TurnUsage, UsageGroupBy, UsageQuery, UsageReport } from "@covey/protocol";

export class EngineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type ShellListener = (ev: ShellEvent) => void;
type ThreadListener = (threadId: string, ev: ThreadEvent) => void;

/** How often the daemon looks for sessions nobody needs. */
const SWEEP_INTERVAL_MS = 30_000;

export interface EngineOptions {
  /** How a session reaches the SDK. A test hands in a stand-in, so nothing
   *  spawns a Claude subprocess. */
  spawn?: QueryFactory;
  /** The clock the idle sweep reads, in milliseconds. A test moves it by hand. */
  now?: () => number;
  /** Where the daemon writes its own lines. */
  log?: (m: string) => void;
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
    this.sweepTimer = setInterval(() => this.sweepSessions(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  onShell(l: ShellListener) { this.shellListeners.add(l); return () => this.shellListeners.delete(l); }
  onThread(l: ThreadListener) { this.threadListeners.add(l); return () => this.threadListeners.delete(l); }

  // ---- snapshots ------------------------------------------------------------

  shellSnapshot(): ShellSnapshot {
    return { seq: this.db.shellSeq(), machine: this.machine, projects: this.db.listProjects(), threads: this.db.listThreads() };
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

  async dispatch(cmd: CommandEnvelope): Promise<number> {
    const prior = this.db.receipt(cmd.commandId);
    if (prior !== null) return prior;
    const seq = await this.apply(cmd);
    this.db.putReceipt(cmd.commandId, seq);
    return seq;
  }

  private async apply(cmd: Command): Promise<number> {
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
        });
        // A lower limit applies to the sessions already live, not only to the
        // next one: the user asked for less memory now.
        this.sweepSessions();
        return this.emitShell({ kind: "machine.updated", machine: this.machine });
      }
      case "project.create": {
        const root = cmd.workspaceRoot;
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new EngineError("bad_path", `${root} is not a directory`);
        const dup = this.db.listProjects().find((p) => p.workspaceRoot === root);
        if (dup) return this.db.shellSeq();
        const p: Project = {
          id: randomUUID(), title: cmd.title ?? basename(root), workspaceRoot: root,
          repositoryIdentity: isGitRepo(root) ? await repositoryIdentity(root) : null,
          defaultModel: null, defaultWorkspaceMode: null, createdAt: now, updatedAt: now,
        };
        this.db.putProject(p);
        return this.emitShell({ kind: "project.upserted", project: p });
      }
      case "project.update": {
        const p = this.db.getProject(cmd.projectId);
        if (!p) throw new EngineError("not_found", "project not found");
        if (cmd.title !== undefined) p.title = cmd.title;
        if (cmd.defaultModel !== undefined) p.defaultModel = cmd.defaultModel;
        if (cmd.defaultWorkspaceMode !== undefined) p.defaultWorkspaceMode = cmd.defaultWorkspaceMode;
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
        let worktreePath: string | null = null;
        let branch = isGitRepo(p.workspaceRoot) ? await currentBranch(p.workspaceRoot) : null;
        // An explicit choice wins; otherwise the project's remembered default.
        const mode: WorkspaceMode = cmd.workspaceMode ?? p.defaultWorkspaceMode ?? "checkout";
        if (mode !== "checkout") {
          // A failed worktree is reported, never silently downgraded to the
          // shared checkout: the whole point of asking was isolation.
          if (!isGitRepo(p.workspaceRoot)) throw new EngineError("not_git", "project is not a git repository");
          const base = mode === "worktree-default" ? await defaultBranchRef(p.workspaceRoot) : "HEAD";
          if (!base) throw new EngineError("git", "no default branch (origin/HEAD, main or master) to branch from");
          const wt = await createWorktree(p.workspaceRoot, cmd.threadId.slice(0, 8), base);
          if ("error" in wt) throw new EngineError("git", `could not create worktree from ${base}: ${wt.error}`);
          worktreePath = wt.path; branch = wt.branch;
        }
        const machineMode = this.machine.settings.defaultPermissionMode;
        const t: Thread = {
          id: cmd.threadId, projectId: p.id, title: cmd.title ?? "New thread", titleAuto: cmd.title === undefined, provider: "claude",
          sessionId: cmd.sessionId, model: cmd.model ?? p.defaultModel ?? this.machine.settings.defaultModel,
          // The command wins, then the machine's default; only when neither has
          // an opinion do we honour the user's own settings default.
          permissionMode: cmd.permissionMode ?? machineMode ?? resolveDefaultPermissionMode(p.workspaceRoot),
          permissionModeExplicit: cmd.permissionMode !== undefined || machineMode !== null,
          streaming: cmd.streaming ?? this.machine.settings.defaultStreaming ?? false,
          branch, worktreePath, status: "idle", lastError: null, pendingApprovals: 0, queuedTurns: 0, latestTurn: null,
          lastMessageAt: null, archivedAt: null, pinnedAt: null, movedTo: null, createdAt: now, updatedAt: now,
        };
        this.db.putThread(t);
        return this.emitShell({ kind: "thread.upserted", thread: t });
      }
      case "thread.rename": return this.mutateThread(cmd.threadId, (t) => { t.title = cmd.title; t.titleAuto = false; });
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
        }
        return this.mutateThread(cmd.threadId, (x) => { x.archivedAt = cmd.archived ? now : null; });
      }
      case "thread.pin": return this.mutateThread(cmd.threadId, (t) => { t.pinnedAt = cmd.pinned ? now : null; });
      case "thread.delete": {
        const t = this.db.getThread(cmd.threadId);
        if (!t) return this.db.shellSeq();
        this.dropSession(t.id);
        this.queues.delete(t.id);
        const proj = this.db.getProject(t.projectId);
        if (proj) void deleteCheckpointRefs(this.gitCwd(t, proj), t.id);
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
      // Unreachable for a client of the same version. A newer client talking to
      // this daemon lands here, and has to hear so — falling out of the switch
      // would ack a command that never ran.
      default: throw new EngineError("unknown_command", `this daemon does not know the command ${(cmd as { type: string }).type}`);
    }
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

  /** Where a thread's git lives right now: its worktree while that exists (an
   *  archived thread's does not), else the project checkout — the same repo,
   *  sharing the same refs, so checkpoints read the same from either. */
  private gitCwd(t: Thread, p: Project): string {
    return t.worktreePath && existsSync(t.worktreePath) ? t.worktreePath : p.workspaceRoot;
  }

  /** Remove an archived thread's worktree, and record in its transcript what
   *  became of it — including the case where git kept it because of work in it. */
  private async releaseWorktree(t: Thread): Promise<void> {
    const p = this.db.getProject(t.projectId);
    if (!p || !t.worktreePath || !existsSync(t.worktreePath)) return;
    const r = await removeWorktree(p.workspaceRoot, t.worktreePath);
    const now = new Date().toISOString();
    this.persistItem({
      id: `note:${randomUUID()}`, threadId: t.id, turnId: null, seq: 0, createdAt: now, updatedAt: now, kind: "note",
      tone: "error" in r ? "warning" : "info",
      text: "error" in r
        ? `Archived, but the worktree stays: ${r.error.replace(/^fatal: /, "")}`
        : `Archived · removed the worktree ${t.worktreePath}` + (t.branch ? `, kept the branch ${t.branch}` : ""),
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
        threadId: t.id, sessionId: t.sessionId, cwd: t.worktreePath ?? p.workspaceRoot,
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

  exportThread(threadId: string): ThreadExport {
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
      project: { title: project.title, workspaceRoot: project.workspaceRoot, repositoryIdentity: project.repositoryIdentity },
      thread, items: this.db.allItems(threadId), transcripts,
    };
  }

  async importThread(exp: ThreadExport, opts: { projectId?: string; workspaceRoot?: string }): Promise<{ threadId: string; projectId: string }> {
    let project = opts.projectId ? this.db.getProject(opts.projectId) : null;
    if (!project && opts.workspaceRoot) {
      await this.apply({ type: "project.create", workspaceRoot: opts.workspaceRoot, title: exp.project.title });
      project = this.db.listProjects().find((p) => p.workspaceRoot === opts.workspaceRoot) ?? null;
    }
    if (!project && exp.project.repositoryIdentity) {
      project = this.db.listProjects().find((p) => p.repositoryIdentity === exp.project.repositoryIdentity) ?? null;
    }
    if (!project) throw new EngineError("no_project", "no destination project; pass projectId or workspaceRoot");
    const threadId = randomUUID();
    const now = new Date().toISOString();
    const t: Thread = {
      ...exp.thread, id: threadId, projectId: project.id, status: "idle", lastError: null,
      worktreePath: null, movedTo: null, pendingApprovals: 0, queuedTurns: 0, updatedAt: now,
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
    for (const tr of exp.transcripts) {
      const entries = tr.entries.map((e) => rewriteCwd(e, exp.project.workspaceRoot, project!.workspaceRoot));
      this.db.appendTranscript(threadId, t.sessionId, tr.subpath, entries);
    }
    const noteNow = new Date().toISOString();
    this.persistItem({ id: `note:${randomUUID()}`, threadId, turnId: null, seq: 0, createdAt: noteNow, updatedAt: noteNow, kind: "note", tone: "info", text: `Moved here from ${exp.sourceMachineName} (${exp.project.workspaceRoot})` });
    this.emitShell({ kind: "thread.upserted", thread: this.db.getThread(threadId)! });
    return { threadId, projectId: project.id };
  }

  markMoved(threadId: string, machineId: string, newThreadId: string): void {
    const t = this.db.getThread(threadId);
    if (!t) return;
    this.dropSession(threadId);
    t.movedTo = { machineId, threadId: newThreadId };
    t.status = "idle";
    t.archivedAt = t.archivedAt ?? new Date().toISOString();
    this.putThreadAndEmit(t);
  }

  shutdown() {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
    this.touchedAt.clear();
    this.released.clear();
    for (const a of this.titling.values()) a.abort();
    this.titling.clear();
  }
}

/** A whole number at or above `min`, or `null` for "no opinion". A client that
 *  sends nonsense gets the daemon's default rather than a broken limit. */
function clampSetting(v: number | null, min: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.max(min, Math.floor(v));
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

/** Two menus are the same when they hold the same commands in the same order. */
function sameCommands(a: SlashCommandInfo[], b: SlashCommandInfo[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i]!.name && c.description === b[i]!.description && c.argumentHint === b[i]!.argumentHint);
}
