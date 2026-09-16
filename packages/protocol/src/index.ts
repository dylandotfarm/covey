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
  /** Short commit of the build the daemon runs, e.g. `b9a8b01` or `b9a8b01-dirty`. */
  daemonVersion: string;
  /**
   * The build in full, so a client can tell whether this machine runs older
   * code than it does. Optional: a daemon built before this field omits it,
   * and the client says "unknown" rather than guessing.
   */
  build?: BuildInfo;
  protocolVersion: number;
  claudeCodeVersion?: string;
  /** Tailscale MagicDNS name, if the daemon is on a tailnet. */
  tailnetName?: string;
  tailnetIps?: string[];
  capabilities: MachineCapabilities;
  /**
   * What the machine is made of and which tools the daemon can run, so a run
   * can place work on it. Absent on a daemon built before runs existed.
   */
  resources?: MachineResources;
  /** Machine-wide defaults, changed from the TUI's machine control panel. */
  settings: MachineSettings;
}

/**
 * Which build a process runs.
 *
 * `committedAt` is the ordering key on purpose. The client and the daemon are
 * on different machines with different clocks, so a local mtime cannot say
 * which of two builds is older. The commit date comes from the git history,
 * which both machines agree on.
 *
 * `builtAt` is a local mtime. It orders nothing across machines; it says when
 * this checkout last compiled, which only has a meaning on its own machine.
 */
export interface BuildInfo {
  /** Short commit of `HEAD`, or null when the process does not run from a checkout. */
  commit: string | null;
  /** Commit date of `HEAD`, ISO 8601. The only field that crosses machines. */
  committedAt: string | null;
  branch: string | null;
  /** True when the checkout has uncommitted changes, so the commit does not describe the code. */
  dirty: boolean;
  /** Newest mtime of the compiled files, ISO 8601. Local to one machine. */
  builtAt: string | null;
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
  /**
   * Incremental text for new threads on this machine. `null` means off, the
   * same as `false`; it is nullable so the field matches the two beside it.
   */
  defaultStreaming: boolean | null;
}

export interface MachineCapabilities {
  claude: boolean;
  worktrees: boolean;
  moveThreads: boolean;
  /** Future: "codex", "acp" ... */
  providers: ProviderName[];
}

export type ProviderName = "claude";

/**
 * What a machine is made of, and what the daemon can run on it.
 *
 * Read in the daemon, never over `ssh`. The daemon starts from a login shell
 * (often through `nvm`), and a non-interactive `ssh` session does not, so the
 * two resolve different `PATH`s. An agent inherits the daemon's, so the
 * daemon's is the only answer a run can place work with.
 *
 * Optional on `MachineInfo`: a daemon built before this existed omits it, and
 * a run says "unknown" rather than guessing.
 */
export interface MachineResources {
  /** Logical cores. */
  cpuCount: number;
  totalMemoryBytes: number;
  /**
   * How many run members this machine should take at once, from its cores and
   * its memory. See `concurrencyLimit`.
   */
  concurrency: number;
  /** Where a member's throwaway `COVEY_HOME` goes on this machine. */
  tmpDir: string;
  /** The `PATH` the daemon resolved the tools with, for when one is missing. */
  path: string;
  /**
   * The tools the daemon found, in the order it looked. The first entry for a
   * name is the one the `PATH` resolves to; a later entry with the same name is
   * another copy somewhere else, which is how the run of 2026-09-16 found the
   * one machine with an old `/usr/bin/node` to reproduce against.
   */
  tools: MachineTool[];
  /** When the daemon read all this. */
  readAt: string;
}

/** One program the daemon can run. */
export interface MachineTool {
  /** `gh`, `pnpm`, `tmux`, `node` … */
  name: string;
  /** Absolute path, as the daemon resolved it. */
  path: string;
  /** First word of `--version`, or null when it would not say. */
  version: string | null;
}

/** The tool names a daemon probes. A run places work by these names. */
export const PROBED_TOOLS = ["git", "gh", "node", "pnpm", "npm", "tmux", "docker", "rg"] as const;

/** Whether a machine can run a tool, by name. */
export function hasTool(r: MachineResources | undefined, name: string): boolean {
  return !!r?.tools.some((t) => t.name === name);
}

/**
 * How many members a machine should take at once.
 *
 * An agent spends most of its time waiting on the API, so cores are a loose
 * bound; a build is what makes two agents on one machine hurt each other, and
 * on a small machine memory binds first. The Pi of the run of 2026-09-16 — four
 * cores, 8 GB — gets four, and it took five by hand.
 */
export function concurrencyLimit(cpuCount: number, totalMemoryBytes: number): number {
  const byMemory = Math.floor(totalMemoryBytes / (1.5 * 1024 * 1024 * 1024));
  return Math.max(1, Math.min(cpuCount, byMemory));
}

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
  /**
   * True when the daemon forwards incremental text for this thread: the
   * assistant and thinking rows grow token by token instead of landing whole.
   * Absent on threads created before the switch existed, which reads as off.
   *
   * The wire contract does not change with it. A growing item is re-sent whole
   * under the same id, exactly as a finished one is; there is no delta channel.
   */
  streaming?: boolean;
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
  /** This turn's estimated cost. See `TokenCounts.estimatedCostUsd`. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Everything this turn spent, cache figures and per-model split included. */
  usage?: TurnUsage;
  /** Working-tree change summary for this turn (git repos only). */
  diff?: TurnDiffSummary;
}

// ---------------------------------------------------------------------------
// Usage (tokens and estimated cost)
// ---------------------------------------------------------------------------

/**
 * What a turn, or a set of turns, spent.
 *
 * The SDK reports cumulative counters for the whole session, so the daemon
 * differences them per turn before it stores a row. Every figure here is
 * therefore the delta for that turn alone, and the figures add up.
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the prompt cache. */
  cacheCreationInputTokens: number;
  /** Tokens read back from the prompt cache. On a long thread this dominates
   *  the input count, so a total that leaves it out is wrong. */
  cacheReadInputTokens: number;
  /**
   * The SDK's own estimate at list prices. On a subscription plan this is not
   * money charged. Always label it "estimated" in an interface.
   */
  estimatedCostUsd: number;
}

/** One model's share of a turn. */
export interface ModelCounts extends TokenCounts {
  model: string;
}

/** A turn's totals, plus the split by model — a turn can change model part
 *  way, and a subagent may run on another one. */
export interface TurnUsage extends TokenCounts {
  byModel: ModelCounts[];
}

/** One finished turn, as the daemon stores it. */
export interface TurnRecord extends TokenCounts {
  threadId: ThreadId;
  turnId: TurnId;
  projectId: ProjectId;
  startedAt: string;
  endedAt: string;
  state: "completed" | "error" | "interrupted";
  /** The model that did most of the work, for a one-line label. */
  model: string | null;
  byModel: ModelCounts[];
}

/** What a usage total is broken down by. */
export type UsageGroupBy = "thread" | "project" | "model" | "machine";

export interface UsageTotals extends TokenCounts {
  /** Turns that carried figures, not turns started. */
  turns: number;
}

export interface UsageGroup extends UsageTotals {
  /** Thread id, project id, model id, or the machine id. */
  key: string;
  label: string;
}

/**
 * One machine's answer. The TUI cannot read a database on another machine, so
 * it asks every machine the same question and adds the answers up.
 */
export interface UsageReport {
  machineId: MachineId;
  machineName: string;
  /** The window asked for, echoed back. `null` = open ended. */
  since: string | null;
  until: string | null;
  groupBy: UsageGroupBy;
  total: UsageTotals;
  groups: UsageGroup[];
}

/** Window and grouping for `usage.report`. Both bounds are ISO instants; the
 *  client owns the clock, so every machine answers about the same period. */
export interface UsageQuery {
  /** Inclusive lower bound on the turn's end time. */
  since?: string | null;
  /** Exclusive upper bound. */
  until?: string | null;
  groupBy?: UsageGroupBy;
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

/** One question inside an `AskUserQuestion` call. */
export interface QuestionAsk {
  /**
   * The question text, verbatim. The CLI keys the answer by this exact string
   * and drops a question it finds no key for, so never reword it.
   */
  question: string;
  /** Short chip label the tool supplies, e.g. "Auth method". */
  header?: string;
  /** Null when the tool offered no choices, so the answer is free text. */
  options: { label: string; description?: string }[] | null;
}

/**
 * An `AskUserQuestion` call. The tool asks one to four questions at a time and
 * the CLI expects an answer for each one, so this holds a list even though one
 * question is the common case.
 */
export interface QuestionItem extends ItemBase {
  kind: "question";
  requestId: string;
  /** One to four questions, in the order the tool asked them. */
  questions: QuestionAsk[];
  /** One answer for each question, in the same order. Empty until answered. */
  answers: string[];
  status: "pending" | "answered" | "expired";
}

/** The shape a daemon wrote before covey handled more than one question. */
interface LegacyQuestionItem {
  prompt?: string;
  options?: { label: string; description?: string }[] | null;
  answer?: string | null;
}

/**
 * The questions on an item. Items live in the database as JSON and replay
 * verbatim, so a transcript written before the list existed still reads.
 */
export function questionAsks(item: QuestionItem): QuestionAsk[] {
  if (Array.isArray(item.questions)) return item.questions;
  const old = item as LegacyQuestionItem;
  return [{ question: old.prompt ?? "", options: old.options ?? null }];
}

/** The answers on an item, from either shape. See `questionAsks`. */
export function questionAnswers(item: QuestionItem): string[] {
  if (Array.isArray(item.answers)) return item.answers;
  const old = item as LegacyQuestionItem;
  return old.answer ? [old.answer] : [];
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

/** One candidate for the `@` menu: a name in a directory under the thread. */
export interface PathEntry {
  name: string;
  isDir: boolean;
}

/**
 * The commands a thread knows about. `null` is "not known yet" — the thread
 * has never had a session, so nobody has asked the SDK. An empty array is
 * "the session answered, and it has no commands".
 */
export type ThreadCommands = SlashCommandInfo[] | null;

// ---------------------------------------------------------------------------
// Runs: one request from the operator, many threads, one goal
// ---------------------------------------------------------------------------

/**
 * A **run** is a named group of threads with one goal — one task each, across
 * as many machines as the operator lets it use. Call it a run: it has a
 * beginning, an end and a result.
 *
 * Where it lives: the run record belongs to the daemon the operator started it
 * from, because a run outlives a client restart. The members' threads belong to
 * whichever daemon runs them. Only a client holds connections to every machine,
 * so the client is the party that dispatches and that keeps the record honest;
 * the daemon is the durable store and the fan-out point for the sidebar.
 */
export interface Run {
  id: string;
  /** The machine whose daemon stores this run. */
  machineId: MachineId;
  /** What the operator called it, e.g. "covey issues". */
  name: string;
  /** The one goal, in the operator's words. */
  goal: string;
  /**
   * The brief every member gets, before substitution. See `BRIEF_TOKENS`: a
   * member's own task, branch, port and directories are written into it, which
   * is the whole reason a run exists rather than a loop over `turn.send`.
   */
  briefTemplate: string;
  /**
   * Where a member's thread works. `checkout` is refused: parallel agents in
   * one working tree is the defect, not the feature.
   */
  workspaceMode: WorkspaceMode;
  members: RunMember[];
  /** Set when the operator closes the run; the record stays. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One task, one thread, one machine. */
export interface RunMember {
  /** Stable for the life of the run. */
  id: string;
  task: RunTask;
  /** Where the work goes. The operator may change it until dispatch. */
  machineId: MachineId;
  /** The project on that machine the thread is made in. */
  projectId: ProjectId | null;
  /** The thread doing the work, once dispatch made one. */
  threadId: ThreadId | null;
  branch: string | null;
  worktreePath: string | null;
  pullRequest: RunPullRequest | null;
  state: RunMemberState;
  /** Why it is blocked, or what it is waiting for. Free text, operator's words. */
  note: string | null;
  /** This member's own port and directories. Nobody else in the run gets them. */
  resources: MemberResources;
  /** The brief as it was sent, after substitution. Null until dispatch. */
  brief: string | null;
  dispatchedAt: string | null;
  updatedAt: string;
  /**
   * Gates, the conflict queue and the merge order — issue #45. This is the
   * named place that half attaches to. Dispatch and tracking carry it and
   * never read it, so the two halves land separately.
   */
  review?: RunMemberReview | null;
}

/**
 * Per-member review state: what the gate decided, the evidence the member
 * recorded, where it sits in the merge queue, and what the audit found on its
 * branch after a merge. #44 carries this through the store and the wire and
 * never reads it. See "Integration of a run" at the end of this file.
 */
export interface RunMemberReview {
  /** The gate, as it was last read. It goes stale when the base head moves. */
  gate: GateVerdict | null;
  /** The record that the member's test fails without its fix. */
  evidence: RegressionEvidence | null;
  /** This member's place in the merge queue, and the brief it was sent. */
  queue: QueuePosition | null;
  /** Set when the audit finds commits on a merged branch that the base lacks. */
  audit: AuditFinding | null;
  /** When the run last read the gate, ISO 8601. */
  checkedAt: string | null;
}

/**
 * `dispatched → working → review → merged`, plus `blocked` and `withdrawn`.
 *
 * `blocked` is not an error. Three members of the run of 2026-09-16 were
 * legitimately blocked on another member's work.
 *
 * `withdrawn` is an ordinary outcome beside `merged`: a task cancelled after
 * the agent built it still produced the reasoning that the replacement issue
 * was written from.
 */
export type RunMemberState =
  | "planned"
  | "dispatched"
  | "working"
  | "review"
  | "merged"
  | "blocked"
  | "withdrawn";

/** A member's state in the operator's words. */
export function runMemberStateLabel(s: RunMemberState): string {
  return s === "review" ? "in review" : s;
}

/** A member nobody is waiting on any more. */
export function isFinalMemberState(s: RunMemberState): boolean {
  return s === "merged" || s === "withdrawn";
}

/**
 * One task in a run.
 *
 * A GitHub issue is the source worth building for: the issue is a durable place
 * for the agent to report, and `Closes #N` closes the loop when the change
 * lands. A plain line of text works too, and is worth less.
 */
export interface RunTask {
  /** Stable key inside the run: `#44`, or `t3` for a plain line. */
  key: string;
  title: string;
  /** The issue number, when the task came from GitHub. */
  issue: number | null;
  url: string | null;
  /** What a machine must have for this task. Placement obeys every one. */
  requires: TaskRequirement[];
}

/**
 * A requirement a machine has to meet: `os=darwin`, `arch=arm64`,
 * `needs=tmux`, `machine=pi`. Two tasks of the run of 2026-09-16 could only be
 * done on macOS and one only on the Pi, so this is not decoration.
 */
export interface TaskRequirement {
  kind: "os" | "arch" | "tool" | "machine";
  value: string;
}

/**
 * The port and directories one member owns, and nobody else in the run does.
 *
 * This is the defect that made issue #44 necessary. The brief of
 * 2026-09-16 gave all fifteen agents the same throwaway port; one of them ran
 * `covey stop --port 3799` and stopped a daemon another agent had started.
 * Bookkeeping is what a program is for.
 */
export interface MemberResources {
  /** A port for a throwaway daemon. Never the machine's real one. */
  port: number;
  coveyHome: string;
  coveyConfig: string;
}

/**
 * The pull request a member's branch has, if any. Identity and state only:
 * whether it *may merge*, and in what order, is issue #45.
 */
export interface RunPullRequest {
  number: number;
  title: string;
  url: string;
  /** `OPEN`, `MERGED` or `CLOSED`, as `gh` reports it. */
  state: string;
  isDraft: boolean;
  headRefName: string;
  /** When the daemon read it. */
  readAt: string;
}

/**
 * What a brief template may say. Every token is replaced per member, so the
 * brief an agent reads names its own port, its own directories and its own
 * branch — and no other member's.
 */
export const BRIEF_TOKENS: { token: string; means: string }[] = [
  { token: "{{run}}", means: "the run's name" },
  { token: "{{goal}}", means: "the run's goal" },
  { token: "{{task}}", means: "this member's task title" },
  { token: "{{issue}}", means: "`#44`, or empty for a plain task" },
  { token: "{{url}}", means: "the issue's URL, or empty" },
  { token: "{{machine}}", means: "the machine this member runs on" },
  { token: "{{branch}}", means: "the branch the worktree was made on" },
  { token: "{{port}}", means: "this member's own port" },
  { token: "{{home}}", means: "this member's own COVEY_HOME" },
  { token: "{{config}}", means: "this member's own COVEY_CONFIG" },
  { token: "{{member}}", means: "`3 of 15`" },
];

/** What a run adds up to, for the sidebar row and the run panel header. */
export interface RunTally {
  total: number;
  planned: number;
  dispatched: number;
  working: number;
  review: number;
  merged: number;
  blocked: number;
  withdrawn: number;
  /** Machines the members are spread over. */
  machines: number;
}

export function tallyRun(run: Run): RunTally {
  const t: RunTally = { total: 0, planned: 0, dispatched: 0, working: 0, review: 0, merged: 0, blocked: 0, withdrawn: 0, machines: 0 };
  const machines = new Set<string>();
  for (const m of run.members) {
    t.total++;
    t[m.state]++;
    machines.add(m.machineId);
  }
  t.machines = machines.size;
  return t;
}

/**
 * Where the run is as a whole. Derived, never stored: a stored copy would go
 * out of step with the members it describes, and the members are the truth.
 */
export function runState(run: Run): "planning" | "running" | "finished" | "closed" {
  if (run.closedAt) return "closed";
  if (run.members.every((m) => m.state === "planned")) return "planning";
  return run.members.every((m) => isFinalMemberState(m.state)) ? "finished" : "running";
}

/** What `run.create` carries. The daemon adds the timestamps and nothing else. */
export interface RunInit {
  runId: string;
  name: string;
  goal: string;
  briefTemplate: string;
  workspaceMode: WorkspaceMode;
  members: RunMemberInit[];
}

/** A member as the client places it, before any thread exists. */
export interface RunMemberInit {
  id: string;
  task: RunTask;
  machineId: MachineId;
  projectId: ProjectId | null;
  resources: MemberResources;
}

/**
 * What one member's row may be changed to. The client owns dispatch and
 * tracking and patches the first group; issue #45 owns `review`.
 */
export type RunMemberPatch = Partial<
  Pick<
    RunMember,
    | "machineId" | "projectId" | "threadId" | "branch" | "worktreePath"
    | "pullRequest" | "state" | "note" | "resources" | "brief" | "dispatchedAt"
    | "review"
  >
>;

/** One GitHub issue, as `gh` reports it for a run's task list. */
export interface RunIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface ShellSnapshot {
  seq: number;
  machine: MachineInfo;
  projects: Project[];
  threads: Thread[];
  /**
   * The runs this daemon stores. A run's members may live on other machines;
   * this machine is only where the record is kept. Absent from a daemon built
   * before runs existed, so read it as an empty list.
   */
  runs?: Run[];
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
      defaultStreaming?: boolean | null;
    }
  | {
      type: "thread.create";
      projectId: ProjectId;
      threadId: ThreadId;
      sessionId: string;
      title?: string;
      model?: string | null;
      permissionMode?: PermissionMode;
      /** Omitted = the machine's `defaultStreaming`, else off. */
      streaming?: boolean;
      /** Omitted = the project's `defaultWorkspaceMode`, else `checkout`. */
      workspaceMode?: WorkspaceMode;
    }
  | { type: "thread.rename"; threadId: ThreadId; title: string }
  | { type: "thread.archive"; threadId: ThreadId; archived: boolean }
  | { type: "thread.pin"; threadId: ThreadId; pinned: boolean }
  | { type: "thread.delete"; threadId: ThreadId }
  | { type: "thread.setPermissionMode"; threadId: ThreadId; mode: PermissionMode }
  | { type: "thread.setModel"; threadId: ThreadId; model: string | null }
  /**
   * Turn incremental text on or off for one thread. It applies to the live
   * session at once, mid-turn included, because the daemon always asks the SDK
   * for partial messages and decides here whether to forward them.
   */
  | { type: "thread.setStreaming"; threadId: ThreadId; streaming: boolean }
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
  | {
      type: "question.respond";
      threadId: ThreadId;
      requestId: string;
      /** The first answer. A daemon that predates `answers` reads only this. */
      answer: string;
      /** One answer for each question on the item, in order. */
      answers?: string[];
    }
  | { type: "session.stop"; threadId: ThreadId }
  /**
   * Start a run. The client has already placed the members and allocated their
   * resources; this writes the record, which is what makes the run survive the
   * client. Creating a run that is already here is a no-op, so a retry is safe.
   */
  | { type: "run.create"; run: RunInit }
  /** Omitted fields are left alone. `closedAt: null` reopens a closed run. */
  | {
      type: "run.update";
      runId: string;
      name?: string;
      goal?: string;
      briefTemplate?: string;
      closedAt?: string | null;
    }
  /** Add a task to a run in flight, without tearing the run down. */
  | { type: "run.member.add"; runId: string; member: RunMemberInit }
  | { type: "run.member.patch"; runId: string; memberId: string; patch: RunMemberPatch }
  /** Drop a member that was never dispatched. A dispatched one is `withdrawn`. */
  | { type: "run.member.remove"; runId: string; memberId: string }
  | { type: "run.delete"; runId: string };

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
  | { seq: number; kind: "thread.removed"; threadId: ThreadId }
  /** The whole run, every time — the same rule timeline items follow, so a
   *  client that reconnects mid-run sees what one that watched throughout does. */
  | { seq: number; kind: "run.upserted"; run: Run }
  | { seq: number; kind: "run.removed"; runId: string };

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
  /**
   * One directory under a thread's working directory, for the `@` menu. The
   * candidates are on the daemon's machine, so the client cannot read them
   * itself. `dir` is relative to that working directory and may not leave it;
   * `""` is the working directory itself. A directory that is not there
   * answers with no entries rather than an error, because the reader is part
   * way through typing its name.
   */
  "thread.listDir": {
    params: { threadId: ThreadId; dir: string };
    result: { dir: string; entries: PathEntry[]; truncated: boolean };
  };
  /** Live branch state, asked for when offering where a new thread should run. */
  "project.git": { params: { projectId: ProjectId }; result: ProjectGit };
  /** Full patch for a turn; `turnId` omitted = latest turn with a diff. */
  "turn.diff": { params: { threadId: ThreadId; turnId?: TurnId }; result: TurnDiff | null };
  /**
   * Token and estimated-cost totals for turns that ended inside a window.
   * Every machine answers for the turns it ran, so the TUI asks them all.
   */
  "usage.report": { params: UsageQuery; result: UsageReport };
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
  /**
   * Read issues for a run's task list, with `gh` in the project's checkout.
   * `error` says why the list is short — no `gh`, no login, no such issue —
   * rather than failing the whole call, because one bad number must not cost
   * the operator the other nineteen.
   */
  "run.issues": {
    params: { projectId: ProjectId; numbers: number[] };
    result: { issues: RunIssue[]; error: string | null };
  };
  /**
   * The pull request for a member's branch, read with `gh` on the machine that
   * holds the branch. Identity and state only — whether it *may merge*, and in
   * what order, is issue #45.
   */
  "run.pullRequest": { params: { threadId: ThreadId }; result: RunPullRequest | null };
  /**
   * The gate for one member, read on the machine that holds its branch.
   *
   * The daemon reads `turnRunning` from the thread itself, so a client cannot
   * say the member is idle and merge under a running turn. The caller passes
   * the evidence, which lives in the run record on the operator's daemon.
   */
  "run.gate": {
    params: { threadId: ThreadId; label: string; state: RunMemberState; evidence: RegressionEvidence | null };
    result: GateVerdict;
  };
  /** The size and the files of a member's branch, which the merge queue orders on. */
  "run.memberDiff": { params: { threadId: ThreadId }; result: MemberDiff | null };
  /**
   * The merge order for a whole run: serial, largest diff first, with the brief
   * for each member. Pure, and answered by the daemon that stores the run, so
   * there is one implementation of the order and not one per client.
   */
  "run.queue": { params: { entries: QueueEntryWire[] }; result: QueuePosition[] };
  /**
   * Merge one member. The gate is read fresh here, not taken from an older
   * verdict, and the audit runs straight after. `merged: false` comes back with
   * the refusals, which the operator forwards to the member unchanged.
   *
   * One party merges: a caller without `integrator` is refused whatever the
   * gate says.
   */
  "run.merge": {
    params: {
      threadId: ThreadId;
      label: string;
      state: RunMemberState;
      evidence: RegressionEvidence | null;
      actor: MergeParty;
      method?: "merge" | "squash" | "rebase";
      /** The queue, so a merge out of order is refused rather than taken. */
      queue?: QueuePosition[];
    };
    result: { merged: boolean; verdict: GateVerdict; audit: AuditFinding[] };
  };
  /**
   * `git rev-list origin/<base>..origin/<branch>` for one merged member.
   *
   * One line of shell that would have caught a real loss: a member pushed 211
   * lines to a branch whose pull request had already merged, and nothing saw it.
   */
  "run.audit": { params: { threadId: ThreadId; label: string }; result: AuditFinding | null };
}

/** One member's entry in the merge queue, as it crosses the wire. */
export interface QueueEntryWire {
  member: RunMemberRef;
  diff: MemberDiff;
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

// ---------------------------------------------------------------------------
// Integration of a run: gates, the conflict queue, and the audit
// ---------------------------------------------------------------------------
//
// A run dispatches work (#44); these types describe what happens when the work
// comes back. The rules come from a real run of fifteen agents on 2026-09-16:
//
//  - A green check is not the gate. A check is green against the base it ran
//    on, and that base moves. A pending check and a stale check are both a
//    refusal.
//  - A test that exists is not the gate. The gate is the evidence that the
//    member reverted the fix and watched the test fail.
//  - File overlap is a hint about a conflict. It is never the answer.
//  - One party merges. A member never gets push rights to the base branch.

/**
 * The little of a run member that the gate, the queue and the audit read.
 *
 * It is a view of `RunMember`, not a second model: `memberRef` in the daemon
 * builds one. The only field that is not on `RunMember` is `turnRunning`,
 * which belongs to the member's thread rather than to the member.
 */
export interface RunMemberRef {
  /** `RunMember.id`. */
  memberId: string;
  /** Short human label, e.g. `#20 wheel scroll`. It goes in the queue brief. */
  label: string;
  threadId: ThreadId | null;
  machineId: MachineId | null;
  /** The branch the member pushes to. The gate and the audit both key on it. */
  branch: string;
  /** The pull request number, or null before the member opens one. */
  pullRequest: number | null;
  /**
   * True while the member's thread runs a turn. A run owns the map from thread
   * to branch, so it can answer this; the integration half only reads it.
   */
  turnRunning: boolean;
  state: RunMemberState;
}

/** One check on a pull request, flattened from `gh pr view --json statusCheckRollup`. */
export interface CheckSummary {
  name: string;
  /** The workflow that owns the check, e.g. `ci`. Null for a status context. */
  workflow: string | null;
  state: CheckState;
  /**
   * When the check started, ISO 8601. The staleness test reads this field: a
   * check that started before the current base head landed did not include it.
   */
  startedAt: string | null;
  url: string | null;
}

/** `neutral` covers a skipped or cancelled check: it neither passes nor fails. */
export type CheckState = "success" | "failure" | "pending" | "neutral";

/**
 * The state of the checks as a gate reads them.
 *  - `passing`  — every check succeeded, and each one ran against the current base head.
 *  - `pending`  — a check has not finished. This is a refusal, not a pass.
 *  - `failing`  — a check failed.
 *  - `stale`    — every check succeeded, but against a base that has since moved.
 *  - `absent`   — no check proved anything.
 */
export type CiState = "passing" | "pending" | "failing" | "stale" | "absent";

/** The commit at the tip of the base branch, and when it landed there. */
export interface BaseHead {
  oid: string;
  /** ISO 8601. A check that started before this time did not test this commit. */
  committedAt: string;
}

/**
 * The evidence that a member's test bites. A machine cannot judge a test, so
 * the member records what it did: it reverted the fix, ran the test, and kept
 * the failure verbatim. The failure text is the whole value of this record.
 */
export interface RegressionEvidence {
  /** What the member reverted, e.g. `the guard in sidebar.ts:112`. */
  reverted: string;
  /** The test that failed once the fix was gone. */
  test: string;
  /** The failure, copied from the test run. Empty text proves nothing. */
  failure: string;
  recordedAt: string;
  /** The thread that recorded it, so a reader can trace it back. */
  recordedBy?: string;
}

export type GateRefusalCode =
  | "ci-failing"
  | "ci-pending"
  | "ci-stale"
  | "ci-absent"
  | "merge-conflict"
  | "pr-draft"
  | "pr-missing"
  | "turn-running"
  | "no-evidence"
  | "evidence-proves-nothing"
  | "withdrawn"
  | "not-the-merge-party";

export interface GateRefusal {
  code: GateRefusalCode;
  /** One sentence for the operator, with the fact that caused the refusal. */
  message: string;
}

/** What the gate decides about one member. `ok` is true only with no refusals. */
export interface GateVerdict {
  memberId: string;
  branch: string;
  ok: boolean;
  ci: CiState;
  checks: CheckSummary[];
  /** Every reason to refuse, not the first one. The operator fixes them together. */
  refusals: GateRefusal[];
  evidence: RegressionEvidence | null;
}

/** The size and reach of one member's change, for the conflict queue. */
export interface MemberDiff {
  branch: string;
  additions: number;
  deletions: number;
  /** Every path the branch touches, as `gh pr view --json files` reports it. */
  files: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** `CLEAN`, `BEHIND`, `DIRTY`, `UNSTABLE`, `BLOCKED`, `DRAFT`, `UNKNOWN`. */
  mergeStateStatus: string;
}

/** A member that lands earlier and touches a file this member also touches. */
export interface QueueCollision {
  branch: string;
  label: string;
  files: string[];
}

/** One member's place in the merge queue, and the brief the run sends it. */
export interface QueuePosition {
  memberId: string;
  branch: string;
  label: string;
  /** 1 is the first merge. Largest diff first. */
  position: number;
  total: number;
  /** additions + deletions, the cost of a re-merge. */
  size: number;
  /** Members ahead of this one that share a file with it. A hint, not the answer. */
  meets: QueueCollision[];
  /** The message to send to the member. It names the files and the caution. */
  brief: string;
}

/** A merged member whose branch still holds commits that the base branch lacks. */
export interface AuditFinding {
  memberId: string;
  branch: string;
  /** The commits that `origin/<base>..origin/<branch>` reports. */
  commits: { sha: string; subject: string }[];
  message: string;
}

/**
 * Who may merge. One party merges and the members never do, so a merge takes a
 * party with `integrator` set. Fifteen agents with push rights to one branch is
 * a worse problem than the one a run solves.
 */
export interface MergeParty {
  id: string;
  integrator: boolean;
}
