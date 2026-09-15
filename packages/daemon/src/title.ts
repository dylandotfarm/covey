import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Thread titles, written by a weak model from the user's first message.
 *
 * This goes through the Agent SDK rather than the Messages API on purpose: it
 * reuses whatever credentials Claude Code itself runs on, so a subscription
 * user needs no ANTHROPIC_API_KEY. The query carries nothing but the message
 * text — no tools, no settings files, no transcript — so it stays cheap and
 * cannot touch the working tree, and leaves nothing behind.
 */

/** Weak model used for titles, independent of the thread's own model.
 *  `COVEY_TITLE_MODEL=off` turns auto-titling off. */
const MODEL = process.env.COVEY_TITLE_MODEL ?? "claude-sonnet-5";
const TIMEOUT_MS = 20_000;
/** Enough of the message to name it; later paragraphs rarely change the subject. */
const MAX_INPUT = 2000;
const MAX_TITLE = 60;
/** Longer than this is prose, not a title — the derived one is better. */
const MAX_PLAUSIBLE = 80;

const SYSTEM = [
  "You name threads in a coding assistant.",
  "Given the user's first message, reply with a title for the thread: 3-6 words,",
  "sentence case, no trailing punctuation, no quotes, no preamble.",
  'Name the task, not the person — "Fix websocket reconnect loop", not "User wants a fix".',
  "Reply with the title alone.",
].join(" ");

/**
 * Title for `text`, or null if the model was unavailable, too slow, aborted,
 * or chatty. Never throws — the caller keeps `fallbackTitle` on null.
 */
export async function generateTitle(text: string, cwd: string, abort = new AbortController()): Promise<string | null> {
  if (!MODEL || MODEL === "off") return null;
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: text.slice(0, MAX_INPUT),
      options: {
        cwd,
        model: MODEL,
        systemPrompt: SYSTEM,
        tools: [], // one message in, one line out — nothing to run
        settingSources: [], // no CLAUDE.md, no hooks, no project settings
        maxTurns: 1,
        abortController: abort,
        // Throwaway: no transcript on disk, nothing in `claude --resume`, and
        // no mirror into our db (persistSession and sessionStore are exclusive).
        persistSession: false,
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") return msg.subtype === "success" ? cleanTitle(msg.result) : null;
    }
    return null;
  } catch {
    return null; // a missing title is never worth failing a turn over
  } finally {
    clearTimeout(timer);
  }
}

/** Strip the decoration models add around a one-line answer. */
export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const title = line
    .replace(/^(?:title|thread)\s*:\s*/i, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.length > MAX_PLAUSIBLE) return null;
  return truncate(title);
}

/** Instant title taken from the message itself, shown until the model answers. */
export function fallbackTitle(text: string): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first ? truncate(first) : "New thread";
}

function truncate(s: string): string {
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1) + "…" : s;
}
