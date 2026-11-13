/**
 * The one place covey loads the Agent SDK, and so the one place that decides
 * which Claude Code every session on this machine runs.
 *
 * Every other module imports `query` from here rather than from the package.
 * That is the whole trick: a reader's choice of Claude Code is one decision
 * taken once, at the top of the process, instead of six call sites that each
 * have to remember it.
 *
 * It decides with a **top-level await**, which makes this module's body run
 * before any importer's. Node allows it and `module: NodeNext` compiles it, so
 * the cost is nothing and what covey gets is an ordinary `import { query }`
 * everywhere else — no factory to thread through the engine and no call site
 * that can forget the executable override.
 *
 * Two rules hold here and neither is negotiable:
 *
 * - **It never throws.** An install covey cannot load falls back to the one the
 *   lockfile pins and records why. A reader must not be able to pick a Claude
 *   Code that leaves a machine unable to start a session; that is the one
 *   measure that lets a later choice repair a broken one, and `mobile/` gave up
 *   its equivalent once and had to rebuild instead.
 * - **The reason survives.** `claudeChoice` carries what was asked for as well
 *   as what is running, so the control panel names the version that went
 *   missing rather than quietly showing the old number (#132).
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { chooseClaude, entryFor, systemClaude, type ClaudeChoice } from "./claudeInstall.js";
import { claudeVersionSetting } from "./config.js";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");

/** The SDK the daemon depends on: the floor, and the repair path. */
const bundled = (): Promise<Sdk> => import("@anthropic-ai/claude-agent-sdk");

function decide(): ClaudeChoice {
  try {
    return chooseClaude(claudeVersionSetting(), { entryFor, systemClaude });
  } catch {
    // An unreadable daemon.json must not stop a machine from running Claude.
    return { source: "lockfile", entry: null, executable: null, requested: null };
  }
}

let choice = decide();
let mod: Sdk;
try {
  mod = choice.entry ? ((await import(choice.entry)) as Sdk) : await bundled();
} catch (e: any) {
  // The install is there and will not load — a half-written directory, a
  // version whose JavaScript this node cannot run. Fall back and say so.
  choice = {
    source: "lockfile", entry: null, executable: null, requested: choice.requested,
    reason: `Claude Code ${choice.requested} would not load: ${e?.message ?? e}`,
  };
  mod = await bundled();
}

/**
 * Which Claude Code this process runs. Read by `main.ts` for `MachineInfo`,
 * so a client reports the install in force and not the one on the PATH — the
 * two disagreeing is what made the engine re-read the model list on the first
 * turn after every start.
 */
export const claudeChoice: ClaudeChoice = choice;

/**
 * The SDK's `query`, with this machine's Claude Code bound to it.
 *
 * Wrapped rather than re-exported, because `system` is the bundled JavaScript
 * pointed at somebody else's binary: the option has to go on every query, and
 * a call site that forgot it would silently run the wrong Claude Code. There
 * are six callers (`claude.ts`, `models.ts`, `title.ts`, `activity.ts`,
 * `auth.ts`, `digest.ts`) and this is the only place that knows.
 */
export const query: Sdk["query"] = (args) => mod.query({
  ...args,
  options: { ...args.options, ...executableOption() },
});

/** The override, or nothing at all for the two sources that need none. */
function executableOption(): Pick<Options, "pathToClaudeCodeExecutable"> | Record<string, never> {
  return choice.executable ? { pathToClaudeCodeExecutable: choice.executable } : {};
}
