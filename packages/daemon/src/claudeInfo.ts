/**
 * What this machine's Claude Code is, and what else it could be.
 *
 * Its own module because both ends need it and neither may import the other:
 * `main.ts` puts the answer on `MachineInfo`, and `server.ts` answers
 * `machine.claudeVersions` with it. It is also the one place that may import
 * both `sdk.ts` — which is what actually loaded — and `claudeInstall.ts` —
 * which is what is on disk; `claudeInstall.ts` must not import `sdk.ts` back,
 * or the cycle would close through a top-level await.
 */
import { CLAUDE_SYSTEM, type ClaudeInstall, type ClaudeRelease, type ClaudeSource } from "@covey/protocol";
import { claudeChoice } from "./sdk.js";
import { lockfileRelease, managedReleases, readRegistry, systemClaude } from "./claudeInstall.js";

/**
 * Which Claude Code this machine runs and what else it could run.
 *
 * The `SessionBudget` shape: `MachineSettings.claudeVersion` is `null` for
 * "the one the lockfile pins", no client can work out what that resolves to,
 * so the daemon resolves it and re-sends the answer. `available` is left out —
 * the registry is read on demand by `machine.claudeVersions`, because a
 * control panel nobody opens must not make a machine poll npm.
 */
export function claudeInstallInfo(opts: { probeSystem?: boolean } = {}): ClaudeInstall {
  const lockfile = lockfileRelease();
  const choice = claudeChoice;
  const managed = managedReleases();
  // Only probed where the answer is needed, which is the claim the comments
  // here and on `systemClaude` make: a machine on the lockfile's Claude Code
  // pays for no `which` and no `--version` at start. `probeSystem` is the
  // picker asking, through `machine.claudeVersions`, and a machine already
  // running the PATH's `claude` has to read it either way.
  const sys = choice.source === "system"
    ? systemClaudeQuietly()
    : opts.probeSystem ? systemClaudeQuietly() : undefined;
  const running: ClaudeRelease | null =
    choice.source === "system" ? systemRelease(sys)
    : choice.source === "managed" ? (managed.find((r) => r.sdk === choice.requested) ?? null)
    : lockfile;
  return {
    version: running?.claude ?? null,
    source: choice.source,
    sdk: choice.source === "system" ? null : running?.sdk ?? null,
    ...(choice.requested !== null && choice.source !== sourceOf(choice.requested) ? { requested: choice.requested } : {}),
    ...(choice.reason ? { reason: choice.reason } : {}),
    lockfile,
    // `undefined` is "covey did not look", which is not the same as `null`,
    // "covey looked and there is none" — a client must not paint the first as
    // a machine with no `claude`.
    ...(sys === undefined ? {} : { system: systemRelease(sys) }),
    ...(managed.length ? { managed } : {}),
  };
}

/** Which source a setting asks for, so a fallback can be told from a match. */
function sourceOf(requested: string): ClaudeSource {
  return requested === CLAUDE_SYSTEM ? "system" : "managed";
}

/**
 * The PATH's `claude` as a release row.
 *
 * `sdk` is empty on purpose: the field is the *Agent SDK* version, and this
 * install has none that covey put there. Writing the Claude Code version into
 * it would read as a fact and is not one.
 */
function systemRelease(sys: { path: string; version: string } | null | undefined): ClaudeRelease | null {
  return sys ? { sdk: "", claude: sys.version, exact: true } : null;
}

/** The PATH's `claude`, for the row that offers it. Never a reason to fail. */
function systemClaudeQuietly(): { path: string; version: string } | null {
  try { return systemClaude(); } catch { return null; }
}

/**
 * The registry answer, cached for this long.
 *
 * A control panel is opened, shut and opened again while a reader makes up
 * their mind, and the document is 1.2 MB. `refresh` is the row that says
 * "check again" and skips the cache.
 */
const REGISTRY_TTL_MS = 10 * 60_000;
let cached: { at: number; releases: ClaudeRelease[]; error?: string } | null = null;

/**
 * `machine.claudeVersions`: the install, with what the registry offers.
 *
 * Read on demand and never on a timer — a machine whose control panel nobody
 * opens must not poll npm. A read that failed says why and leaves `available`
 * absent, because an empty list reads as "npm has published nothing" (#132).
 */
export async function claudeVersions(opts: { refresh?: boolean } = {}): Promise<ClaudeInstall> {
  // The picker offers "this machine's claude", so this is the caller that
  // wants the PATH read; the start-up one does not.
  const info = claudeInstallInfo({ probeSystem: true });
  if (opts.refresh || !cached || Date.now() - cached.at > REGISTRY_TTL_MS) {
    const got = await readRegistry();
    cached = { at: Date.now(), releases: got.releases, ...(got.error ? { error: got.error } : {}) };
  }
  return {
    ...info,
    ...(cached.releases.length ? { available: cached.releases, availableAt: new Date(cached.at).toISOString() } : {}),
    ...(cached.error ? { availableError: cached.error } : {}),
  };
}
