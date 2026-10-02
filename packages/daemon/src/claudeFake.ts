/**
 * Test support: a Claude Code that answers every message with "ok".
 *
 * A test about the watch, the review or any other turn the daemon sends itself
 * needs a session that completes, and starting a real one costs a subprocess of
 * about 250 MB and a credential. This stands in for the whole CLI: it reads the
 * prompt stream, answers each message with one assistant block and one result,
 * and can be held so a turn stays running while a test looks at the row.
 *
 * It lives beside the daemon, as `integrate/testHost.ts` does, because more
 * than one test file needs it and two copies of a fake drift.
 */
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFactory } from "./claude.js";

/** The handle a test holds: hold the answers back, then let them through. */
export interface FakeCli {
  /** While true, a turn sent to this CLI stays running. */
  held: boolean;
  /** Let every held turn answer. Set to `held = false` first. */
  release(): void;
}

export function fakeCli(): FakeCli {
  return { held: false, release: () => {} };
}

/** A `QueryFactory` that answers "ok" to every message, unless `cli.held`. */
export function autoReply(cli: FakeCli): QueryFactory {
  return ({ prompt, options }) => {
    const out: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (m: unknown) => { out.push(m); wake?.(); wake = null; };
    options.abortController?.signal.addEventListener("abort", () => { done = true; wake?.(); });
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) {
        while (cli.held) await new Promise<void>((r) => { const prior = cli.release; cli.release = () => { prior(); r(); }; });
        push({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${crypto.randomUUID()}`, model: "opus", content: [{ type: "text", text: "ok" }] } });
        push({ type: "result", subtype: "success", is_error: false, result: "ok", modelUsage: {}, user_message_uuid: null });
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (done) return;
          if (out.length === 0) { await new Promise<void>((r) => (wake = r)); continue; }
          yield out.shift() as never;
        }
      },
      supportedCommands: async () => [],
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      backgroundTasks: async () => true,
    } as unknown as Query;
  };
}

/** Let the engine's queued microtasks and the session's pump run. */
export const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
