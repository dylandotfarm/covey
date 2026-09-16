/**
 * @covey/protocol — shared wire types between the daemon (one per machine)
 * and the TUI client (connects to many daemons at once).
 *
 * Design rules:
 *  - Clients are command-in / event-out. Every command carries a client
 *    generated `commandId` so retries are idempotent.
 *  - Subscriptions start with a snapshot, then stream events tagged with a
 *    monotonically increasing `seq`, then emit `synchronized`. Reconnects
 *    pass `afterSeq` to get a gap-filling replay.
 *  - Shell (sidebar) and thread detail are separate subscriptions so the
 *    sidebar never pays for message bodies.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 3790;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type MachineId = string; // stable uuid minted by the daemon on first run
export type ProjectId = string;
export type ThreadId = string;
export type ItemId = string;
export type TurnId = string;

export interface MachineInfo {
  machineId: MachineId;
  name: string; // hostname or user label
  os: "linux" | "darwin" | "win32" | string;
  arch: string;
  homeDir: string;
  daemonVersion: string;
  protocolVersion: number;
  claudeCodeVersion?: string;
  /** Tailscale MagicDNS name, if the daemon is on a tailnet. */
  tailnetName?: string;
  tailnetIps?: string[];
  capabilities: MachineCapabilities;
  /** Machine-wide defaults, changed from the TUI's machine control panel. */
  settings: MachineSettings;
}

/**
 * Defaults that belong to the *machine*, not to the client: they hold no matter
 * which TUI opens a thread there, and survive a daemon restart (they live in
 * `daemon.json`). `null` means "no opinion" — fall back to the project's
 * setting, then to the user's own Claude configuration.
 */
export interface MachineSettings {
  /** Model for new threads on this machine. */
  defaultModel: string | null;
  /** Permission mode for new threads on this machine. */
  defaultPermissionMode: PermissionMode | null;
}

export interface MachineCapabilities {
  claude: boolean;
  worktrees: boolean;
  moveThreads: boolean;
  /** Future: "codex", "acp" ... */
  providers: ProviderName[];
}

export type ProviderName = "claude";

// ---------------------------------------------------------------------------
// Updating a machine (the daemon updates its own checkout, then restarts)
// ---------------------------------------------------------------------------

/** Where the daemon's own code came from, so the TUI can say what it would pull. */
export interface MachineSource {
  /** Git checkout the daemon is running out of; null when installed some other way. */
  root: string | null;
  branch: string | null;
  /** Short commit hash. */
  commit: string | null;
  subject: string | null;
  /** True when the checkout has uncommitted changes — a pull may refuse. */
  dirty: boolean;
  remote: string | null;
  /** False when there is nothing to pull from; `reason` says why. */
  canUpdate: boolean;
  reason?: string;
}

export type UpdateStepName = "pull" | "install" | "build" | "restart";

export interface UpdateStep {
  name: UpdateStepName;
  /** Human label for the TUI, e.g. "pull". */
  label: string;
  /** The command as run, for the log. */
  command: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  /** Tail of the combined stdout/stderr, bounded so progress can stream. */
  output: string;
  exitCode: number | null;
  /** Why a step was skipped, or extra colour on a failure. */
  note?: string;
}

/**
 * A run of update-and-restart. Like timeline items, the whole record is re-sent
 * on every change (no delta channel), so a client that connects mid-update sees
 * the same thing as one that watched from the start.
 */
export interface MachineUpdate {
  id: string;
  machineId: MachineId;
  state: "running" | "succeeded" | "failed" | "restarting";
  steps: UpdateStep[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  fromCommit: string | null;
  toCommit: string | null;
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface Project {
  id: ProjectId;
  title: string;
  /** Absolute path on the owning machine. */
  workspaceRoot: string;
  /** Normalised git remote (e.g. github.com/org/repo) used to correlate the
   *  same repository across machines. */
  repositoryIdentity: string | null;
  defaultModel: string | null;
  /**
   * Remembered answer to "where should new threads in this project run?".
   * `null` means ask on every new thread (the default for git repos).
   */
  defaultWorkspaceMode: WorkspaceMode | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a new thread does its work.
 *  - `worktree-default`: a fresh `git worktree` branched from the repo's
 *    default branch (`origin/HEAD`, else main/master) — a clean start.
 *  - `worktree-head`: a fresh worktree branched from whatever is checked out
 *    now, so work in progress carries over (committed work, not the dirty tree).
 *  - `checkout`: the project directory itself, shared with every other thread.
 */
export type WorkspaceMode = "worktree-default" | "worktree-head" | "checkout";

/** Live git facts about a project, read on demand (branches move). */
export interface ProjectGit {
  isRepo: boolean;
  /** Repo root — differs from `workspaceRoot` when the project is a subdirectory. */
  root: string | null;
  /** Branch checked out in the project directory; null when HEAD is detached. */
  currentBranch: string | null;
  /** Ref to branch from for `worktree-default` ("main", "origin/main", …). */
  defaultBranch: string | null;
  /** False in a repo with no commits yet, where worktrees cannot be created. */
  hasCommits: boolean;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting" // blocked on an approval / question
  | "interrupted"
  | "error";

export interface Thread {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  /**
   * True while the title is the daemon's, not the user's: it starts as the
   * first line of the first message and is replaced by a generated one. A
   * rename clears it, so nothing overwrites a title the user typed.
   * Absent on threads created before auto-titling existed.
   */
  titleAuto?: boolean;
  provider: ProviderName;
  /** SDK session id — minted client-side before the first turn. */
  sessionId: string;
  model: string | null;
  /**
   * The mode in force. Until the user picks one explicitly this mirrors what
   * the CLI resolved from the user's own settings (`permissions.defaultMode`),
   * rather than covey imposing a default of its own.
   */
  permissionMode: PermissionMode;
  /**
   * True once the user has chosen a mode for this thread. While false the
   * daemon omits `permissionMode` when starting the session, so the user's
   * settings apply exactly as they would in the CLI.
   */
  permissionModeExplicit?: boolean;
  branch: string | null;
  worktreePath: string | null;
  status: SessionStatus;
  lastError: string | null;
  pendingApprovals: number;
  /** Turns waiting behind the running one. */
  queuedTurns: number;
  latestTurn: LatestTurn | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  pinnedAt: string | null;
  /** Set when the thread has been moved elsewhere; kept as a tombstone. */
  movedTo: { machineId: MachineId; threadId: ThreadId } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LatestTurn {
  turnId: TurnId;
  state: "running" | "interrupted" | "completed" | "error";
  startedAt: string;
  completedAt: string | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Working-tree change summary for this turn (git repos only). */
  diff?: TurnDiffSummary;
}

export interface TurnDiffSummary {
  files: { path: string; additions: number; deletions: number; status: "A" | "M" | "D" | "R" }[];
  additions: number;
  deletions: number;
  /** Set when the diff could not be computed (e.g. not a git repo). */
  unavailable?: string;
}

export interface TurnDiff extends TurnDiffSummary {
  turnId: TurnId;
  /** Unified patch text. Empty when there are no changes. */
  patch: string;
}

/**
 * A timeline item. Everything in the transcript is an item; the item `kind`
 * decides how it renders. Streaming text updates re-send the same item id
 * with the accumulated text (no delta channel to reason about).
 */
export type TimelineItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThinkingItem
  | ToolCallItem
  | ApprovalItem
  | QuestionItem
  | SystemNoteItem
  | ErrorItem;

interface ItemBase {
  id: ItemId;
  threadId: ThreadId;
  turnId: TurnId | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserMessageItem extends ItemBase {
  kind: "user";
  text: string;
  attachments: Attachment[];
  /** True while waiting behind a running turn. */
  queued?: boolean;
  /**
   * True for a message handed straight to the turn that was already running:
   * it carries that turn's `turnId` and the agent folds it in at its next tool
   * boundary rather than after the turn ends. Cleared when the turn finishes.
   */
  folded?: boolean;
}

export interface AssistantMessageItem extends ItemBase {
  kind: "assistant";
  text: string;
  streaming: boolean;
  model: string | null;
}

export interface ThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
  streaming: boolean;
}

export interface ToolCallItem extends ItemBase {
  kind: "tool";
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Short one-line human summary, e.g. `Read src/index.ts`. */
  summary: string;
  status: "running" | "completed" | "error" | "denied";
  output: string | null;
  isError: boolean;
  parentToolUseId: string | null;
  durationMs: number | null;
  /**
   * Set once the call left the foreground. `status` goes to `completed` at that
   * moment — the agent got a "running in the background" result and carried on —
   * so this is what says the work itself is still going.
   */
  background?: ToolBackground;
}

/** A tool call the agent is no longer blocked on. */
export interface ToolBackground {
  /** The CLI's task id, for a later `task_notification`. */
  taskId: string | null;
  state: "running" | "completed" | "failed" | "stopped";
  /** One-line result, once the task settles. */
  summary: string | null;
  /** File the CLI wrote the full output to, when it says. */
  outputFile?: string | null;
}

export interface ApprovalItem extends ItemBase {
  kind: "approval";
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  summary: string;
  /** Rule suggestions from the SDK to offer "always allow". */
  suggestions: unknown[];
  status: "pending" | "allowed" | "denied" | "expired";
  decidedAt: string | null;
}

export interface QuestionItem extends ItemBase {
  kind: "question";
  requestId: string;
  prompt: string;
  options: { label: string; description?: string }[] | null;
  answer: string | null;
  status: "pending" | "answered" | "expired";
}

export interface SystemNoteItem extends ItemBase {
  kind: "note";
  tone: "info" | "warning";
  text: string;
}

export interface ErrorItem extends ItemBase {
  kind: "error";
  text: string;
}

export interface Attachment {
  name: string;
  /**
   * Absolute path. On the wire this is the path on the machine the file was
   * dropped on (the TUI's); the daemon rewrites it to its own local copy before
   * persisting, so a stored attachment always points at a file the daemon owns.
   */
  path: string;
  mimeType: string;
  /**
   * Base64 contents, carried inline so a file dropped on the TUI reaches a
   * daemon on another machine. Transport only — the daemon writes the bytes to
   * disk and strips this before the attachment is persisted on a timeline item,
   * so snapshots never replay megabytes of base64.
   */
  data?: string;
}

/** Per-attachment cap. Matches the Anthropic API's 5 MB per-image limit. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Image media types the model accepts. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export function isImageMime(m: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(m);
}

// ---------------------------------------------------------------------------
// Commands typed in the composer (the `/` prefix)
// ---------------------------------------------------------------------------

/**
 * One entry of the `/` menu.
 *
 * The SDK owns most of the list: `Query.supportedCommands()` gives it at the
 * start of a session, and the SDK pushes a whole new list when it finds more
 * skills. `source` keeps a place beside that list for covey's own commands,
 * which the client answers itself instead of sending to the agent.
 */
export interface SlashCommandInfo {
  /** Command name, without the leading slash. */
  name: string;
  description: string;
  /** Hint for the arguments, e.g. `<file>`. Empty when the command takes none. */
  argumentHint: string;
  /** Other names for the same command, e.g. `cost` for `usage`. */
  aliases?: string[];
  /** `sdk` = send the line to the agent. `covey` = the client acts on it. */
  source: "sdk" | "covey";
}

/**
 * The commands a thread knows about. `null` is "not known yet" — the thread
 * has never had a session, so nobody has asked the SDK. An empty array is
 * "the session answered, and it has no commands".
 */
export type ThreadCommands = SlashCommandInfo[] | null;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface ShellSnapshot {
  seq: number;
  machine: MachineInfo;
  projects: Project[];
  threads: Thread[];
}

export interface ThreadSnapshot {
  seq: number;
  thread: Thread;
  items: TimelineItem[];
  /** True when older items exist beyond `items[0]`. */
  hasMore: boolean;
  /**
   * The `/` menu for this thread, or `null` while it is not known yet. It
   * rides the thread subscription rather than the `Thread` record, because the
   * shell snapshot carries every thread on the machine and the sidebar must
   * not pay for a command list per thread.
   */
  commands: ThreadCommands;
}

// ---------------------------------------------------------------------------
// Commands (client → daemon). Every command has a `commandId`.
// ---------------------------------------------------------------------------

export type Command =
  | { type: "project.create"; workspaceRoot: string; title?: string }
  | {
      type: "project.update";
      projectId: ProjectId;
      title?: string;
      defaultModel?: string | null;
      /** `null` restores "ask on every new thread". */
      defaultWorkspaceMode?: WorkspaceMode | null;
    }
  | { type: "project.delete"; projectId: ProjectId }
  /** Machine-wide defaults. Omitted fields are left alone; `null` clears one. */
  | {
      type: "machine.settings";
      defaultModel?: string | null;
      defaultPermissionMode?: PermissionMode | null;
    }
  | {
      type: "thread.create";
      projectId: ProjectId;
      threadId: ThreadId;
      sessionId: string;
      title?: string;
      model?: string | null;
      permissionMode?: PermissionMode;
      /** Omitted = the project's `defaultWorkspaceMode`, else `checkout`. */
      workspaceMode?: WorkspaceMode;
    }
  | { type: "thread.rename"; threadId: ThreadId; title: string }
  | { type: "thread.archive"; threadId: ThreadId; archived: boolean }
  | { type: "thread.pin"; threadId: ThreadId; pinned: boolean }
  | { type: "thread.delete"; threadId: ThreadId }
  | { type: "thread.setPermissionMode"; threadId: ThreadId; mode: PermissionMode }
  | { type: "thread.setModel"; threadId: ThreadId; model: string | null }
  | {
      type: "turn.send";
      threadId: ThreadId;
      turnId: TurnId;
      text: string;
      attachments?: Attachment[];
    }
  | { type: "turn.interrupt"; threadId: ThreadId }
  /**
   * Move in-flight tool calls off the critical path — ctrl+b. With `toolUseId`
   * only that call moves; without it every foreground call does, which is what
   * ctrl+b does in the Claude Code CLI. The turn continues either way.
   */
  | { type: "turn.background"; threadId: ThreadId; toolUseId?: string }
  | { type: "turn.cancelQueued"; threadId: ThreadId; turnId: TurnId }
  /** Restore the working tree to its state before `turnId` and drop that turn
   *  and everything after it from the conversation. */
  | { type: "turn.revert"; threadId: ThreadId; turnId: TurnId }
  | {
      type: "approval.respond";
      threadId: ThreadId;
      requestId: string;
      behavior: "allow" | "deny";
      /** Pass the SDK suggestions back to persist an "always allow" rule. */
      updatedPermissions?: unknown[];
      message?: string;
    }
  | { type: "question.respond"; threadId: ThreadId; requestId: string; answer: string }
  | { type: "session.stop"; threadId: ThreadId };

export type CommandEnvelope = Command & { commandId: string };

export interface CommandAck {
  commandId: string;
  ok: true;
  /** Seq of the last event this command produced, for read-your-writes. */
  seq: number;
}

export interface CommandError {
  commandId: string;
  ok: false;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Events (daemon → client)
// ---------------------------------------------------------------------------

export type ShellEvent =
  | { seq: number; kind: "machine.updated"; machine: MachineInfo }
  | { seq: number; kind: "project.upserted"; project: Project }
  | { seq: number; kind: "project.removed"; projectId: ProjectId }
  | { seq: number; kind: "thread.upserted"; thread: Thread }
  | { seq: number; kind: "thread.removed"; threadId: ThreadId };

export type ThreadEvent =
  | { seq: number; kind: "item.upserted"; item: TimelineItem }
  | { seq: number; kind: "item.removed"; itemId: ItemId }
  | { seq: number; kind: "thread.updated"; thread: Thread }
  /** The whole `/` menu, every time. The SDK replaces its list rather than
   *  patching it, so this event replaces the client's copy too. */
  | { seq: number; kind: "commands.updated"; commands: SlashCommandInfo[] };

/** Distributive Omit that preserves discriminated unions. */
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type ShellEventBody = DistributiveOmit<ShellEvent, "seq">;
export type ThreadEventBody = DistributiveOmit<ThreadEvent, "seq">;

// ---------------------------------------------------------------------------
// Thread transfer (move between machines)
// ---------------------------------------------------------------------------

/**
 * Self-contained export of a thread. Produced by the source daemon, handed
 * by the client to the destination daemon. Contains everything needed to
 * `resume` the SDK session on another machine: our own timeline plus the
 * raw SDK transcript entries captured through the SessionStore mirror.
 */
export interface ThreadExport {
  version: 1;
  exportedAt: string;
  sourceMachineId: MachineId;
  sourceMachineName: string;
  project: Pick<Project, "title" | "workspaceRoot" | "repositoryIdentity">;
  thread: Thread;
  items: TimelineItem[];
  /** SDK transcript, keyed by subpath ("" = main, else subagent id). */
  transcripts: { subpath: string; entries: Record<string, unknown>[] }[];
}

// ---------------------------------------------------------------------------
// RPC framing
// ---------------------------------------------------------------------------

export interface RpcMethods {
  "hello": { params: { protocolVersion: number; client: string }; result: MachineInfo };
  "shell.snapshot": { params: Record<string, never>; result: ShellSnapshot };
  "shell.subscribe": { params: { afterSeq?: number }; result: { subscriptionId: string } };
  "thread.snapshot": {
    params: { threadId: ThreadId; limit?: number; beforeSeq?: number };
    result: ThreadSnapshot;
  };
  "thread.subscribe": {
    params: { threadId: ThreadId; afterSeq?: number };
    result: { subscriptionId: string };
  };
  "unsubscribe": { params: { subscriptionId: string }; result: null };
  "command": { params: CommandEnvelope; result: CommandAck };
  "thread.export": { params: { threadId: ThreadId }; result: ThreadExport };
  "thread.import": {
    params: { export: ThreadExport; projectId?: ProjectId; workspaceRoot?: string };
    result: { threadId: ThreadId; projectId: ProjectId };
  };
  "thread.markMoved": {
    params: { threadId: ThreadId; machineId: MachineId; newThreadId: ThreadId };
    result: null;
  };
  "fs.listDir": {
    params: { path: string };
    result: { path: string; entries: { name: string; isDir: boolean; isRepo: boolean }[] };
  };
  /**
   * Create a directory under `path`, so a project can be started somewhere that
   * does not exist yet without leaving the TUI. `name` is relative to `path`
   * and may nest ("work/newthing"); absolute paths and `..` are refused.
   * Creating a directory that is already there succeeds and returns it.
   */
  "fs.mkdir": { params: { path: string; name: string }; result: { path: string } };
  "models.list": { params: Record<string, never>; result: { id: string; label: string }[] };
  /** Live branch state, asked for when offering where a new thread should run. */
  "project.git": { params: { projectId: ProjectId }; result: ProjectGit };
  /** Full patch for a turn; `turnId` omitted = latest turn with a diff. */
  "turn.diff": { params: { threadId: ThreadId; turnId?: TurnId }; result: TurnDiff | null };
  /** What the daemon is running: checkout, branch, commit. Read on demand. */
  "machine.source": { params: Record<string, never>; result: MachineSource };
  /**
   * Pull, reinstall if the lockfile moved, rebuild, and (unless `restart` is
   * false) restart the daemon. Returns as soon as the run starts; progress
   * arrives as `machine.update` pushes. A second call while one is running
   * returns the run in flight.
   */
  "machine.update": { params: { restart?: boolean }; result: MachineUpdate };
  /** Restart the daemon without updating. `pid` is the process that will exit. */
  "machine.restart": { params: Record<string, never>; result: { pid: number } };
}

export type RpcMethodName = keyof RpcMethods;

export type RpcRequest<M extends RpcMethodName = RpcMethodName> = {
  id: number;
  method: M;
  params: RpcMethods[M]["params"];
};

export type RpcResponse<M extends RpcMethodName = RpcMethodName> =
  | { id: number; ok: true; result: RpcMethods[M]["result"] }
  | { id: number; ok: false; error: { code: string; message: string } };

export type PushMessage =
  | { push: "shell"; subscriptionId: string; event: ShellEvent }
  | { push: "shell.synchronized"; subscriptionId: string }
  | { push: "thread"; subscriptionId: string; threadId: ThreadId; event: ThreadEvent }
  | { push: "thread.synchronized"; subscriptionId: string; threadId: ThreadId }
  /** Update progress. Broadcast to every client — an update affects them all. */
  | { push: "machine.update"; update: MachineUpdate };

export type WireFromClient = RpcRequest;
export type WireFromDaemon = RpcResponse | PushMessage;

export function isPush(m: WireFromDaemon): m is PushMessage {
  return "push" in m;
}

// ---------------------------------------------------------------------------
// Client-side saved machine config (lives in the TUI's config file)
// ---------------------------------------------------------------------------

export interface SavedMachine {
  /** Label shown in the sidebar. */
  name: string;
  /** ws://host:port — host may be a tailnet ip or MagicDNS name. */
  url: string;
  /** Optional shared token for non-tailscale connections. */
  token?: string;
  /** Filled in after first successful hello. */
  machineId?: MachineId;
}

export const KNOWN_MODELS: { id: string; label: string }[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
