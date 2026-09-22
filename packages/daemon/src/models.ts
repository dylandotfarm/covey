import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelChoice } from "@covey/protocol";

/**
 * The models a machine offers, read from the Claude Code installed on it.
 *
 * A hard-coded list goes stale the day a model ships, and it goes stale
 * differently on every machine: one daemon runs a Claude Code from last week
 * and another runs today's. So covey asks the install. The answer is the same
 * list Claude Code's own `/model` shows — the account's plan is already
 * accounted for — and a machine on a newer Claude Code offers newer models
 * with no covey release.
 *
 * The read costs one Claude Code process for about a third of a second. It
 * runs no turn and spends no tokens: the SDK answers `supportedModels` from
 * the handshake, so a prompt stream that never yields is enough to get the
 * list and abort.
 */

/** What the read found. `claudeDefault` is the row Claude Code calls "Default". */
export interface ClaudeModels {
  models: ModelChoice[];
  claudeDefault?: ModelChoice;
}

/** Longer than this and something is wrong with the install; keep the fallback. */
const TIMEOUT_MS = 20_000;

/** One row as the SDK reports it. Narrower than the SDK's type on purpose —
 *  this is every field covey reads, and the rest may change under us. */
export interface SdkModelInfo {
  value?: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
}

/**
 * Ask this machine's Claude Code for its models, or null if it will not say.
 *
 * Never throws: a machine with no credentials, no `claude` on the PATH, or a
 * Claude Code too old to answer keeps the fallback list rather than losing its
 * model picker.
 */
export async function readModels(cwd = process.cwd()): Promise<ClaudeModels | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: neverSends(),
      options: {
        cwd,
        tools: [], // nothing runs: the handshake carries the answer
        settingSources: [], // no CLAUDE.md, no hooks, no project settings
        persistSession: false, // leaves nothing in `claude --resume`
        abortController: abort,
        stderr: (d) => {
          if (process.env.COVEY_DEBUG) process.stderr.write(`[models] ${d}`);
        },
      },
    });
    const infos = (await q.supportedModels()) as SdkModelInfo[];
    return toChoices(infos);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // The process holds the list; covey wanted the list and nothing else.
    abort.abort();
  }
}

/**
 * A prompt stream that never yields, so the session starts and no turn runs.
 *
 * The SDK needs a prompt to build a query. A string prompt would send a turn
 * the moment the process is up; this generator parks instead, and the abort in
 * `readModels` ends it.
 */
async function* neverSends(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
}

/**
 * The SDK's rows as covey's rows. Pure, so a test can hold a real answer from
 * `supportedModels` and check what the picker would show.
 *
 * Claude Code's "Default" row becomes the id `""`, which is what covey stores
 * for a thread or a machine with no model set. Keeping it in the list beside
 * covey's own "no model set" row would offer the same thing twice.
 */
export function toChoices(infos: SdkModelInfo[]): ClaudeModels | null {
  const models: ModelChoice[] = [];
  let claudeDefault: ModelChoice | undefined;
  for (const i of infos) {
    if (!i.value || !i.displayName) continue;
    const row: ModelChoice = {
      id: i.value === "default" ? "" : i.value,
      label: i.displayName,
      ...(i.resolvedModel ? { resolved: i.resolvedModel } : {}),
      ...(i.description ? { description: i.description } : {}),
    };
    if (row.id === "") claudeDefault = row;
    else models.push(row);
  }
  // An answer with no model in it tells a client nothing it can pick from.
  return models.length === 0 ? null : { models, ...(claudeDefault ? { claudeDefault } : {}) };
}
