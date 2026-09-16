import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionMode as SdkPermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { PermissionMode, TimelineItem, ToolCallItem, ToolBackground, ApprovalItem, QuestionItem, QuestionAsk, Attachment } from "@covey/protocol";
import { summariseTool } from "./toolSummary.js";
import { attachmentBlocks } from "./attachments.js";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

/**
 * Drives one Claude Code SDK session for one thread.
 *
 * The session is a long-lived subprocess fed by a streaming input queue, so
 * multiple turns reuse the same process. Every SDK message is translated into
 * TimelineItem upserts through `sink`.
 */
export interface SessionSink {
  upsertItem(item: TimelineItem, opts?: { streaming?: boolean }): void;
  getItemByToolUse(toolUseId: string): ToolCallItem | null;
  onStatus(status: "starting" | "running" | "waiting" | "idle" | "error" | "interrupted", error?: string): void;
  onTurnComplete(info: { costUsd: number; inputTokens: number; outputTokens: number; isError: boolean; result: string; userMessageUuid: string | null }): void;
  onSessionInit(info: { model: string; claudeCodeVersion: string; permissionMode: string }): void;
  onModelUsed(model: string): void;
  now(): string;
}

export interface SessionParams {
  threadId: string;
  sessionId: string;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  /** True once the user picked a mode for this thread, rather than inheriting
   *  the default resolved from their Claude settings. */
  permissionModeExplicit: boolean;
  /** True when a transcript for this session already exists (resume). */
  resume: boolean;
  sessionStore: SessionStore;
  additionalDirectories?: string[];
}

interface Pending {
  resolve: (r: PermissionResult) => void;
  item: ApprovalItem | QuestionItem;
  /** The tool's original input. Needed verbatim for AskUserQuestion, whose
   *  `updatedInput` must still satisfy the tool's own schema. */
  input: Record<string, unknown>;
}

/** Incremental text streaming, off unless explicitly asked for. */
const STREAMING = process.env.COVEY_STREAM === "1";

export class ClaudeSession {
  private q: Query | null = null;
  private abort = new AbortController();
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private pending = new Map<string, Pending>();
  private currentTurnId: string | null = null;
  /**
   * task id → tool_use id. `task_started` is the only message that carries
   * both, and every later message about a task (backgrounded, finished) is
   * keyed by task id alone, so the mapping has to be kept here to find the
   * timeline row a notification belongs to.
   */
  private taskTools = new Map<string, string>();
  /**
   * Tasks that actually left the foreground. The CLI reports every task's
   * completion through `task_notification`, backgrounded or not, so without
   * this an ordinary tool call would be labelled as having run in the
   * background the moment it finished.
   */
  private backgrounded = new Set<string>();
  /** Streaming block state for the in-flight assistant message. */
  private blocks: { itemId: string; kind: "text" | "thinking" | "tool"; text: string; json: string; toolName?: string; toolUseId?: string }[] = [];
  private turnStartedAt = Date.now();

  constructor(private params: SessionParams, private sink: SessionSink) {}

  get running(): boolean {
    return this.q !== null && !this.closed;
  }
  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  start() {
    const opts: Options = {
      cwd: this.params.cwd,
      // Off by default: responses land whole, rather than token by token.
      // The transcript shows a live activity line instead.
      // Set COVEY_STREAM=1 to get incremental text back.
      includePartialMessages: STREAMING,
      permissionMode: toSdkMode(this.params.permissionMode),
      // Consent flag, not an override: the SDK requires it to be true *before*
      // `bypassPermissions` can be selected, and it is a start-time-only option.
      // Setting it from the initial mode would mean a live session started in
      // `default` could never be switched to bypass. Actual behaviour is
      // governed entirely by `permissionMode`, which we can change at runtime.
      allowDangerouslySkipPermissions: true,
      abortController: this.abort,
      sessionStore: this.params.sessionStore,
      sessionStoreFlush: "eager",
      canUseTool: (name, input, o) => this.canUseTool(name, input, o),
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(this.params.model ? { model: this.params.model } : {}),
      ...(this.params.additionalDirectories ? { additionalDirectories: this.params.additionalDirectories } : {}),
      ...(this.params.resume ? { resume: this.params.sessionId } : { sessionId: this.params.sessionId }),
      stderr: (d) => {
        if (process.env.COVEY_DEBUG) process.stderr.write(`[claude ${this.params.threadId.slice(0, 8)}] ${d}`);
      },
    };
    this.sink.onStatus("starting");
    this.q = query({ prompt: this.input(), options: opts });
    void this.pump();
  }

  private async *input(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      yield this.queue.shift()!;
    }
  }

  sendTurn(turnId: string, text: string, attachments: Attachment[] = []) {
    this.currentTurnId = turnId;
    this.turnStartedAt = Date.now();
    this.enqueue(text, attachments);
    this.sink.onStatus("running");
    this.wake?.();
  }

  /**
   * Add a message to the turn already in flight rather than to a new one.
   *
   * The CLI takes queued user messages off its input stream between tool
   * rounds and folds them into the running turn, so a message typed while the
   * agent works reaches it at the next boundary instead of waiting for the
   * whole turn to end. There is nothing to do here but push it and leave the
   * turn's own bookkeeping — `currentTurnId`, the start time — alone: the
   * result the turn eventually reports covers both messages.
   */
  foldIntoTurn(text: string, attachments: Attachment[] = []) {
    this.enqueue(text, attachments);
    this.wake?.();
  }

  private enqueue(text: string, attachments: Attachment[]) {
    // Images go in as real image blocks (and first — the API prefers images
    // ahead of the text that refers to them); everything else is referenced by
    // path so the agent can open it itself.
    const { blocks, noteLines } = attachmentBlocks(attachments);
    const parts: any[] = [...blocks];
    const body = noteLines.length ? `${text}\n\n${noteLines.join("\n")}` : text;
    parts.push({ type: "text", text: body });
    this.queue.push({
      type: "user",
      message: { role: "user", content: parts },
      parent_tool_use_id: null,
      session_id: this.params.sessionId,
      origin: { kind: "human" },
    } as SDKUserMessage);
  }

  /**
   * Hand in-flight tool calls off to the background — what ctrl+b does in the
   * CLI. Each blocking call answers straight away with "running in the
   * background" so the turn moves on, and the work reports back later through
   * `task_notification`.
   *
   * @returns false only when `toolUseId` named nothing that was running.
   * @throws when the session has no live query, or the CLI has background
   *   tasks switched off.
   */
  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    if (!this.q) throw new Error("no live session");
    return (await this.q.backgroundTasks(toolUseId)) !== false;
  }

  async interrupt() {
    try {
      await this.q?.interrupt();
    } catch {
      /* ignore */
    }
    this.failPending("interrupted");
    this.sink.onStatus("interrupted");
  }

  async setPermissionMode(mode: PermissionMode) {
    this.params.permissionMode = mode;
    this.params.permissionModeExplicit = true;
    await this.q?.setPermissionMode(toSdkMode(mode)).catch(() => {});
  }
  async setModel(model: string | null) {
    this.params.model = model;
    await this.q?.setModel(model ?? undefined).catch(() => {});
  }

  stop() {
    this.closed = true;
    this.failPending("stopped");
    this.abort.abort();
    this.wake?.();
    this.q = null;
  }

  respond(requestId: string, result: PermissionResult): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(result);
    return true;
  }

  private failPending(reason: string) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: "deny", message: reason });
      this.pending.delete(id);
    }
  }

  // ------------------------------------------------------------------------

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    o: { signal: AbortSignal; suggestions?: unknown[]; toolUseID: string; description?: string; decisionReason?: string },
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const now = this.sink.now();
    const base = { id: `req:${requestId}`, threadId: this.params.threadId, turnId: this.currentTurnId, seq: 0, createdAt: now, updatedAt: now };
    let item: ApprovalItem | QuestionItem;
    if (toolName === "AskUserQuestion") {
      item = {
        ...base,
        kind: "question",
        requestId,
        questions: asksOf(input),
        answers: [],
        status: "pending",
      };
    } else {
      item = {
        ...base,
        kind: "approval",
        requestId,
        toolUseId: o.toolUseID,
        toolName,
        input,
        summary: o.description ?? summariseTool(toolName, input),
        suggestions: o.suggestions ?? [],
        status: "pending",
        decidedAt: null,
      };
    }
    this.sink.upsertItem(item);
    this.sink.onStatus("waiting");
    const result = await new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, item, input });
      o.signal.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          this.sink.upsertItem({ ...item, status: "expired", updatedAt: this.sink.now() } as TimelineItem);
          resolve({ behavior: "deny", message: "aborted" });
        }
      });
    });
    const decidedAt = this.sink.now();
    if (item.kind === "question") {
      // Read the answers back off the map that went to the CLI, so the
      // transcript shows exactly what the agent was told.
      const given = result.behavior === "allow" ? ((result.updatedInput as any)?.answers as Record<string, string> | undefined) ?? {} : {};
      const answers = item.questions.map((q) => given[q.question] ?? "");
      this.sink.upsertItem({ ...item, status: result.behavior === "allow" ? "answered" : "expired", answers, updatedAt: decidedAt });
    } else {
      this.sink.upsertItem({ ...item, status: result.behavior === "allow" ? "allowed" : "denied", decidedAt, updatedAt: decidedAt });
    }
    if (this.q) this.sink.onStatus("running");
    return result;
  }

  /** Build the PermissionResult for an approval/question response. */
  buildResponse(requestId: string, behavior: "allow" | "deny", extra: { updatedPermissions?: unknown[]; message?: string; answer?: string; answers?: string[] }): PermissionResult | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    if (behavior === "deny") return { behavior: "deny", message: extra.message ?? "User denied", interrupt: false };
    if (p.item.kind === "question") {
      // `updatedInput` is validated against AskUserQuestionInput, which requires
      // at least one question — so the original input has to be passed through
      // rather than rebuilt.
      const questions = Array.isArray(p.input.questions) ? (p.input.questions as any[]) : [];
      // The question text is the key the CLI reads the answer by. It drops any
      // question it finds no key for, and never tells the agent it did, so
      // every question the user answered needs an entry here.
      const given = extra.answers ?? (extra.answer !== undefined ? [extra.answer] : []);
      const answers: Record<string, string> = {};
      questions.forEach((q: any, i: number) => {
        if (q?.question && given[i]) answers[q.question] = given[i]!;
      });
      // A freeform answer is reported separately from a structured choice, but
      // only for a lone question: the CLI prefers `response` over the whole
      // answers map, so on a multi-question ask it would hide every choice.
      const lone = questions.length === 1 ? given[0] : undefined;
      const chosen = (questions[0]?.options ?? []).some((op: any) => op?.label === lone);
      return {
        behavior: "allow",
        updatedInput: { ...p.input, answers, ...(lone && !chosen ? { response: lone } : {}) },
      };
    }
    return { behavior: "allow", updatedPermissions: (extra.updatedPermissions as any) ?? undefined };
  }

  pendingItem(requestId: string): ApprovalItem | QuestionItem | null {
    return this.pending.get(requestId)?.item ?? null;
  }

  // ------------------------------------------------------------------------

  private async pump() {
    try {
      for await (const msg of this.q!) {
        if (this.closed) break;
        this.handle(msg);
      }
      if (!this.closed) this.sink.onStatus("idle");
    } catch (e: any) {
      if (this.closed || this.abort.signal.aborted) return;
      this.sink.onStatus("error", e?.message ?? String(e));
      const now = this.sink.now();
      this.sink.upsertItem({ id: `err:${randomUUID()}`, threadId: this.params.threadId, turnId: this.currentTurnId, seq: 0, createdAt: now, updatedAt: now, kind: "error", text: e?.message ?? String(e) });
    } finally {
      this.q = null;
      this.closed = true;
    }
  }

  private newItemId() {
    return `${this.params.threadId.slice(0, 8)}:${randomUUID()}`;
  }

  /** A task has left the foreground: remember it, and say so on its row. */
  private goneToBackground(taskId: string) {
    this.backgrounded.add(taskId);
    this.markBackground(taskId, { state: "running", summary: null });
  }

  /**
   * Record a background task's state on the tool row that started it.
   * Returns false when the task has no row here, so the caller can fall back
   * to a plain note.
   */
  private markBackground(taskId: string, bg: Omit<ToolBackground, "taskId">): boolean {
    const toolUseId = this.taskTools.get(taskId);
    if (!toolUseId) return false;
    const item = this.sink.getItemByToolUse(toolUseId);
    if (!item) return false;
    const now = this.sink.now();
    this.sink.upsertItem({
      ...item,
      // The turn stopped waiting on this call, so the row is no longer
      // "running" — `background.state` is what tracks the work itself.
      status: bg.state === "failed" ? "error" : item.status === "running" ? "completed" : item.status,
      isError: bg.state === "failed" ? true : item.isError,
      background: { taskId, state: bg.state, summary: bg.summary, ...(bg.outputFile ? { outputFile: bg.outputFile } : {}) },
      updatedAt: now,
    });
    return true;
  }

  private handle(msg: SDKMessage) {
    const now = this.sink.now();
    const base = { threadId: this.params.threadId, turnId: this.currentTurnId, seq: 0, createdAt: now, updatedAt: now };
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          this.sink.onSessionInit({ model: msg.model, claudeCodeVersion: msg.claude_code_version, permissionMode: msg.permissionMode });
        } else if (msg.subtype === "compact_boundary") {
          this.sink.upsertItem({ ...base, id: this.newItemId(), kind: "note", tone: "info", text: `Context compacted (${msg.compact_metadata.trigger})` });
        } else if (msg.subtype === "task_started") {
          // The one message carrying both ids; later ones name the task only.
          if (msg.tool_use_id) this.taskTools.set(msg.task_id, msg.tool_use_id);
          // Tools the *model* chose to run in the background (Bash with
          // run_in_background, async subagents) start out there.
          if (msg.is_backgrounded) this.goneToBackground(msg.task_id);
        } else if (msg.subtype === "task_updated") {
          // A foreground call moving to the background — what ctrl+b does.
          if (msg.patch.is_backgrounded) this.goneToBackground(msg.task_id);
        } else if (msg.subtype === "task_notification") {
          if (msg.tool_use_id) this.taskTools.set(msg.task_id, msg.tool_use_id);
          // Every task reports here, foreground ones included; those already
          // answered through their own tool_result and have nothing to add.
          const wasBackgrounded = this.backgrounded.delete(msg.task_id);
          const settled = wasBackgrounded && this.markBackground(msg.task_id, {
            state: msg.status === "completed" ? "completed" : msg.status === "failed" ? "failed" : "stopped",
            summary: msg.summary || null,
            outputFile: msg.output_file || null,
          });
          // The task is over either way, so the id mapping goes with it.
          this.taskTools.delete(msg.task_id);
          // A backgrounded task whose tool call we never saw (started before a
          // reconnect, say) still deserves a line rather than silence — but
          // only if it is real work, not housekeeping.
          if (wasBackgrounded && !settled && !msg.ambient && !msg.skip_transcript) {
            this.sink.upsertItem({ ...base, id: this.newItemId(), kind: "note", tone: msg.status === "failed" ? "warning" : "info", text: `Background task ${msg.status}: ${msg.summary}` });
          }
        }
        return;
      }
      case "stream_event": {
        if (msg.parent_tool_use_id) return; // subagent internals: skip
        const ev = msg.event as any;
        switch (ev.type) {
          case "message_start":
            this.blocks = [];
            return;
          case "content_block_start": {
            const cb = ev.content_block;
            const itemId = this.newItemId();
            if (cb.type === "text") {
              this.blocks[ev.index] = { itemId, kind: "text", text: cb.text ?? "", json: "" };
              this.sink.upsertItem({ ...base, id: itemId, kind: "assistant", text: cb.text ?? "", streaming: true, model: this.params.model }, { streaming: true });
            } else if (cb.type === "thinking") {
              this.blocks[ev.index] = { itemId, kind: "thinking", text: cb.thinking ?? "", json: "" };
              this.sink.upsertItem({ ...base, id: itemId, kind: "thinking", text: "", streaming: true }, { streaming: true });
            } else if (cb.type === "tool_use") {
              this.blocks[ev.index] = { itemId, kind: "tool", text: "", json: "", toolName: cb.name, toolUseId: cb.id };
              this.sink.upsertItem({ ...base, id: itemId, kind: "tool", toolUseId: cb.id, toolName: cb.name, input: {}, summary: summariseTool(cb.name, {}), status: "running", output: null, isError: false, parentToolUseId: null, durationMs: null }, { streaming: true });
            }
            return;
          }
          case "content_block_delta": {
            const b = this.blocks[ev.index];
            if (!b) return;
            const d = ev.delta;
            if (d.type === "text_delta" && b.kind === "text") {
              b.text += d.text;
              this.sink.upsertItem({ ...base, id: b.itemId, kind: "assistant", text: b.text, streaming: true, model: this.params.model }, { streaming: true });
            } else if (d.type === "thinking_delta" && b.kind === "thinking") {
              b.text += d.thinking;
              this.sink.upsertItem({ ...base, id: b.itemId, kind: "thinking", text: b.text, streaming: true }, { streaming: true });
            } else if (d.type === "input_json_delta" && b.kind === "tool") {
              b.json += d.partial_json;
            }
            return;
          }
          case "content_block_stop": {
            const b = this.blocks[ev.index];
            if (!b) return;
            if (b.kind === "text") {
              this.sink.upsertItem({ ...base, id: b.itemId, kind: "assistant", text: b.text, streaming: false, model: this.params.model });
            } else if (b.kind === "thinking") {
              this.sink.upsertItem({ ...base, id: b.itemId, kind: "thinking", text: b.text, streaming: false });
            } else if (b.kind === "tool") {
              let input: unknown = {};
              try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _raw: b.json }; }
              this.sink.upsertItem({ ...base, id: b.itemId, kind: "tool", toolUseId: b.toolUseId!, toolName: b.toolName!, input, summary: summariseTool(b.toolName!, input), status: "running", output: null, isError: false, parentToolUseId: null, durationMs: null });
            }
            return;
          }
          default:
            return;
        }
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        // Authoritative reconciliation of the streamed blocks (covers the case
        // where partial events were dropped, e.g. on resume replay).
        const content = (msg.message.content ?? []) as any[];
        // Derive ids from the API message id where possible: with streaming off
        // there is no earlier item to reconcile against, and a replayed
        // assistant message would otherwise mint duplicates.
        const blockId = (idx: number) => (msg.message.id ? `${msg.message.id}:${idx}` : this.newItemId());
        content.forEach((cb, idx) => {
          const b = this.blocks[idx];
          if (cb.type === "text") {
            const id = b?.kind === "text" ? b.itemId : blockId(idx);
            this.sink.upsertItem({ ...base, id, kind: "assistant", text: cb.text, streaming: false, model: msg.message.model ?? this.params.model });
          } else if (cb.type === "thinking") {
            const id = b?.kind === "thinking" ? b.itemId : blockId(idx);
            this.sink.upsertItem({ ...base, id, kind: "thinking", text: cb.thinking ?? "", streaming: false });
          } else if (cb.type === "tool_use") {
            const existing = this.sink.getItemByToolUse(cb.id);
            const id = existing?.id ?? (b?.kind === "tool" ? b.itemId : blockId(idx));
            this.sink.upsertItem({ ...base, ...(existing ?? {}), id, kind: "tool", toolUseId: cb.id, toolName: cb.name, input: cb.input, summary: summariseTool(cb.name, cb.input), status: existing?.status ?? "running", output: existing?.output ?? null, isError: existing?.isError ?? false, parentToolUseId: null, durationMs: existing?.durationMs ?? null, updatedAt: now });
          }
        });
        if (msg.message.model) this.sink.onModelUsed(msg.message.model);
        this.blocks = [];
        return;
      }
      case "user": {
        // tool results come back as user messages
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const cb of content as any[]) {
          if (cb.type !== "tool_result") continue;
          const item = this.sink.getItemByToolUse(cb.tool_use_id);
          if (!item) continue;
          const text = Array.isArray(cb.content)
            ? cb.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
            : String(cb.content ?? "");
          this.sink.upsertItem({ ...item, status: cb.is_error ? "error" : item.status === "denied" ? "denied" : "completed", output: text.length > 20_000 ? text.slice(0, 20_000) + "\n…(truncated)" : text, isError: !!cb.is_error, durationMs: Date.now() - Date.parse(item.createdAt), updatedAt: now });
        }
        return;
      }
      case "result": {
        const r: any = msg;
        this.sink.onTurnComplete({
          costUsd: r.total_cost_usd ?? 0,
          inputTokens: r.usage?.input_tokens ?? 0,
          outputTokens: r.usage?.output_tokens ?? 0,
          isError: !!r.is_error,
          result: r.result ?? "",
          userMessageUuid: r.user_message_uuid ?? r.user_message_uuids?.[0] ?? null,
        });
        if (r.is_error && r.result) {
          this.sink.upsertItem({ ...base, id: this.newItemId(), kind: "error", text: String(r.result) });
        }
        this.currentTurnId = null;
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Read the questions out of an `AskUserQuestion` input. The tool accepts one to
 * four, and a question with no choices takes free text.
 */
function asksOf(input: Record<string, unknown>): QuestionAsk[] {
  const qs = Array.isArray(input.questions) ? (input.questions as any[]) : [];
  return qs.map((q: any) => ({
    question: String(q?.question ?? ""),
    ...(q?.header ? { header: String(q.header) } : {}),
    options: Array.isArray(q?.options) && q.options.length > 0
      ? q.options.map((op: any) => ({ label: String(op?.label ?? ""), ...(op?.description ? { description: String(op.description) } : {}) }))
      : null,
  }));
}

function toSdkMode(m: PermissionMode): SdkPermissionMode {
  return m as SdkPermissionMode;
}
