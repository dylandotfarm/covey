import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * One sentence for the last thing the agent said in a turn (#172).
 *
 * `activity.ts` writes a sentence for a *chain of tool calls*; this writes one
 * for the *reply*, and the difference is who it is for. A chain's sentence
 * stands in for work a reader is skipping. This one stands in for a reply a
 * reader wants and has no room for: the cover screen of a closed foldable is a
 * few lines tall, and a paragraph of prose there says less than one sentence
 * does.
 *
 * It goes through the Agent SDK for the reason `title.ts` does — it reuses the
 * credentials Claude Code already runs on, so a subscription user needs no
 * ANTHROPIC_API_KEY — and it carries nothing but the reply: no tools, no
 * settings files, no transcript, nothing that can touch the working tree.
 *
 * **Only the final reply of a turn goes to the model.** Not every assistant
 * message: the ones in the middle of a turn are steps, and a sentence for each
 * would cost a query per message to say what the next message says better.
 */

/** Weak model for these sentences. `COVEY_DIGEST_MODEL=off` turns them off. */
const MODEL = process.env.COVEY_DIGEST_MODEL ?? "claude-sonnet-5";
const TIMEOUT_MS = 20_000;
/** Enough of a reply to say what it was about. Past this it repeats itself. */
const MAX_REPLY = 4000;
const MAX_SUMMARY = 100;
/** Longer than this is prose, not a summary, and the lead sentence is better. */
const MAX_PLAUSIBLE = 120;

const SYSTEM = [
  "You compress a coding assistant's reply into one line for a very small screen.",
  "Reply with one sentence of 6-14 words: what the assistant told the reader, or asked them.",
  "Present tense, sentence case, no trailing punctuation, no quotes, no preamble.",
  "Use short, plain words. It goes on one line of a phone's cover screen.",
  "Keep the point, not the detail — \"The tests pass; the branch is ready to merge\",",
  "not a list of what changed. If the reply asks the reader something, say what it asks.",
  "Reply with the sentence alone.",
].join(" ");

/** The text handed to the model: the reply, capped. */
export function digestPrompt(text: string): string {
  const body = text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}\n…` : text;
  // The SDK reads a prompt that starts with `/` as a slash command, which is
  // the same trap `title.ts` documents. The lead-in keeps it prose.
  return `Compress this reply into one line:\n\n${body}`;
}

/** Trim the model's answer, or null when it did not answer with a sentence. */
export function cleanDigest(raw: string): string | null {
  const line = raw.trim().split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const text = line.replace(/^["'`]|["'`]$/g, "").replace(/[.]$/, "").trim();
  if (!text) return null;
  // A chatty model wrote a paragraph. The reply's own first sentence reads
  // better than the first half of an explanation.
  if (text.length > MAX_PLAUSIBLE) return null;
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : text;
}

/**
 * A sentence for `text`, or null when the model was unavailable, too slow,
 * aborted, or chatty. Never throws: on null the item keeps no summary and a
 * client that wants a line falls back to the reply's own first sentence
 * (`replyLead` in `@covey/client`), so a small screen always says something.
 */
export async function summariseReply(text: string, cwd: string, abort = new AbortController()): Promise<string | null> {
  if (!MODEL || MODEL === "off") return null;
  if (!text.trim()) return null;
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: digestPrompt(text),
      options: {
        cwd,
        model: MODEL,
        systemPrompt: SYSTEM,
        tools: [], // one reply in, one line out — nothing to run
        settingSources: [], // no CLAUDE.md, no hooks, no project settings
        maxTurns: 1,
        abortController: abort,
        // Throwaway, as a title is: no transcript on disk, nothing in
        // `claude --resume`, and no mirror into our database.
        persistSession: false,
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") return msg.subtype === "success" ? cleanDigest(msg.result) : null;
    }
    return null;
  } catch {
    return null; // a missing sentence is never worth failing a turn over
  } finally {
    clearTimeout(timer);
  }
}
