/**
 * Which Claude Code this machine's sessions run, and how a reader changes it.
 *
 * Covey never runs the `claude` on the machine's PATH. The Agent SDK spawns
 * its own bundled binary unless a caller sets `pathToClaudeCodeExecutable`,
 * and SDK `0.3.N` carries Claude Code `2.1.N` — so the version every session
 * reports is the one `pnpm-lock.yaml` pins, and `claude update` in a terminal
 * moves nothing here. A reader met that as a 400 from the API: a model
 * shipped, their own Claude Code knew it, and every covey thread answered
 * `Claude Code 2.1.280 does not support this model`.
 *
 * The fix cannot be a bump in the checkout. A machine update is `git pull
 * --ff-only`, and a dependency covey edited in place leaves the checkout dirty
 * — so the next press of "update & restart" would fail with `the checkout has
 * uncommitted changes`, and one press to get a new model would break the
 * button above it. So a chosen version lives **outside the checkout**, under
 * the daemon's own data directory, as a pnpm project of its own. That is the
 * house pattern: `mobile/` is a pnpm workspace of its own and `desktop/` a
 * cargo workspace of its own, for the same reason.
 *
 * Three sources, and the first is the floor:
 *
 * - `lockfile` — what the daemon's own dependency pins. Needs no network, is
 *   on every machine, and is the **repair path**: an install covey cannot load
 *   falls back here. A reader must never be able to pick a Claude Code that
 *   leaves a machine unable to start a session, which is `mobile/`'s
 *   anti-bricking lesson in another place.
 * - `managed` — a version a reader picked, installed here.
 * - `system` — the `claude` on the PATH. This one pairs covey's own SDK
 *   JavaScript with somebody else's binary, so it is offered and labelled
 *   rather than recommended.
 *
 * Nothing in this file runs during `pnpm test` except the pure half: a test
 * must not run pnpm and must not reach the registry.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClaudeRelease, ClaudeSource } from "@covey/protocol";
import { CLAUDE_SYSTEM } from "@covey/protocol";
import { dataDir } from "./config.js";

const run = promisify(execFile);

/** How many registry versions a client is offered. The reader asked for five. */
export const RECENT_COUNT = 5;

/** Longest the install may take. A cold pnpm store makes this a 223 MB fetch. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Longest covey waits on the registry. A control panel is waiting on it. */
const REGISTRY_TIMEOUT_MS = 15_000;

/** The registry document, which is about 1.2 MB; refuse anything absurd. */
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

/**
 * The Claude Code an SDK version carries, by the convention that SDK `0.3.N`
 * ships Claude Code `2.1.N`.
 *
 * Null for anything that is not a `0.3.x`, because the convention is a fact
 * about one minor line and not a rule the SDK promises. The day it becomes
 * `0.4.0` a guess here would print a version that does not exist, so covey
 * says nothing and the reader sees the SDK number alone. For a version covey
 * has actually installed the manifest answers instead, and that answer wins.
 */
export function claudeFromSdk(sdk: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdk);
  if (!m) return null;
  return m[1] === "0" && m[2] === "3" ? `2.1.${m[3]}` : null;
}

/** An SDK version as a release row, labelled as a guess unless told otherwise. */
export function releaseFor(sdk: string, opts: { claude?: string | null; installed?: boolean; publishedAt?: string } = {}): ClaudeRelease {
  const exact = !!opts.claude;
  return {
    sdk,
    claude: opts.claude ?? claudeFromSdk(sdk) ?? sdk,
    exact,
    ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
    ...(opts.installed ? { installed: true } : {}),
  };
}

/** Newest first, by the three numbers rather than by string order: `0.3.99`
 *  must not sort above `0.3.325`. */
export function compareSdk(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The rows a client offers, from a registry document.
 *
 * Newest first and bounded: the registry lists 345 versions and a reader wants
 * the newest few. `installed` marks what is already on the machine, because
 * picking one of those costs no download and the row should say so.
 */
export function releasesFrom(
  doc: { versions?: Record<string, unknown>; time?: Record<string, string>; "dist-tags"?: Record<string, string> },
  opts: { installed?: string[]; count?: number } = {},
): ClaudeRelease[] {
  const installed = new Set(opts.installed ?? []);
  const count = opts.count ?? RECENT_COUNT;
  const latest = doc["dist-tags"]?.latest;
  const all = Object.keys(doc.versions ?? {}).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compareSdk);
  // `latest` is the tag the registry recommends and is not always the highest
  // version published — a newer one may be untagged. Offer the tag first and
  // then the newest, so a reader is never shown only an untagged build.
  const picked: string[] = [];
  for (const v of [latest, ...all]) {
    if (v && !picked.includes(v) && picked.length < count) picked.push(v);
  }
  return picked.sort(compareSdk).map((v) =>
    releaseFor(v, { installed: installed.has(v), ...(doc.time?.[v] ? { publishedAt: doc.time[v] } : {}) }),
  );
}

/**
 * What a setting means for this process: which SDK JavaScript to import, and
 * which binary to make it spawn.
 *
 * Pure, so the fallbacks can be tested without a filesystem. `entry` is null
 * for "the SDK the daemon depends on", which is the bare specifier and needs
 * no path. `executable` is only ever set for `system`: the bundled JavaScript
 * runs somebody else's binary through `pathToClaudeCodeExecutable`.
 *
 * Every refusal names what was asked for *and* what it got instead, so a
 * client can say both. One word for two facts is #132's lesson.
 */
export interface ClaudeChoice {
  source: ClaudeSource;
  entry: string | null;
  executable: string | null;
  requested: string | null;
  reason?: string;
}

export function chooseClaude(
  setting: string | null | undefined,
  probe: { entryFor(sdk: string): string | null; systemClaude(): { path: string; version: string } | null },
): ClaudeChoice {
  const want = setting ?? null;
  if (want === null) return { source: "lockfile", entry: null, executable: null, requested: null };
  if (want === CLAUDE_SYSTEM) {
    const sys = probe.systemClaude();
    if (sys) return { source: "system", entry: null, executable: sys.path, requested: CLAUDE_SYSTEM };
    return {
      source: "lockfile", entry: null, executable: null, requested: CLAUDE_SYSTEM,
      reason: "no `claude` on this machine's PATH",
    };
  }
  const entry = probe.entryFor(want);
  if (entry) return { source: "managed", entry, executable: null, requested: want };
  return {
    source: "lockfile", entry: null, executable: null, requested: want,
    // Named rather than folded into "not installed": a reader who picked a
    // version and got the old one has to be told which one went missing.
    reason: `Claude Code ${claudeFromSdk(want) ?? want} is not installed here`,
  };
}

// ---------------------------------------------------------------------------
// The filesystem half
// ---------------------------------------------------------------------------

/** Where covey keeps the Claude Code versions a reader picked. */
export function installRoot(): string {
  return join(dataDir(), "claude");
}

/** The directory one SDK version is installed in. */
export function installDir(sdk: string): string {
  return join(installRoot(), sdk);
}

/** The SDK JavaScript of an installed version, or null when it is not there. */
export function entryFor(sdk: string): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(sdk)) return null;
  const entry = join(installDir(sdk), "node_modules", PACKAGE, "sdk.mjs");
  return existsSync(entry) ? entry : null;
}

/** The Claude Code version an install carries, read from its own manifest. */
export function manifestVersion(dir: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "node_modules", PACKAGE, "manifest.json"), "utf8")) as { version?: string };
    return m.version ?? null;
  } catch { return null; }
}

/** The Claude Code the daemon's own dependency carries. */
export function lockfileRelease(): ClaudeRelease | null {
  try {
    const sdkDir = join(dirnameOf(import.meta.resolve(PACKAGE)));
    const claude = manifestAt(join(sdkDir, "manifest.json"));
    const sdk = packageVersionAt(join(sdkDir, "package.json"));
    if (!sdk) return null;
    return releaseFor(sdk, { claude });
  } catch { return null; }
}

function dirnameOf(url: string): string {
  const path = url.startsWith("file:") ? new URL(url).pathname : url;
  return path.slice(0, path.lastIndexOf("/"));
}

function manifestAt(file: string): string | null {
  try { return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null; } catch { return null; }
}

function packageVersionAt(file: string): string | null {
  try { return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null; } catch { return null; }
}

/**
 * The `claude` on this machine's PATH, if there is one.
 *
 * Synchronous because `sdk.ts` decides before it imports anything, and only
 * called when the setting actually asks for it — a machine on the lockfile's
 * Claude Code must not pay for this on every start.
 */
export function systemClaude(): { path: string; version: string } | null {
  try {
    const path = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], { timeout: 5_000 })
      .toString().split(/\r?\n/)[0]?.trim();
    if (!path) return null;
    const version = execFileSync(path, ["--version"], { timeout: 5_000 }).toString().trim().split(/\s+/)[0] ?? "";
    return version ? { path, version } : null;
  } catch { return null; }
}

/** Every version covey has installed here, newest first. */
export function managedReleases(): ClaudeRelease[] {
  let names: string[] = [];
  try { names = readdirSync(installRoot()); } catch { return []; }
  return names
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n) && entryFor(n))
    .sort(compareSdk)
    .map((sdk) => releaseFor(sdk, { claude: manifestVersion(installDir(sdk)), installed: true }));
}

/**
 * Install one SDK version under the daemon's data directory.
 *
 * A pnpm project of its own, with its own `.npmrc` and its own
 * `pnpm-workspace.yaml`. Both files are load-bearing:
 *
 * - `--ignore-workspace` plus a workspace file of its own keeps pnpm from
 *   walking up and finding the repository's. pnpm *writes* to that file — it
 *   records a `minimumReleaseAgeExclude` entry per package it had to let
 *   through — and a write into the checkout is exactly the dirty tree that
 *   breaks the next `git pull --ff-only`.
 * - `minimum-release-age=0`, because this is the one package covey excuses
 *   from the seven-day rule, and for this reason: a model ships with a Claude
 *   Code and a week-old pin cannot run it. The rule still holds everywhere
 *   else, in `pnpm-workspace.yaml` and in `scripts/pkg-age.mjs`.
 *
 * Verifies before it reports success: an install whose manifest cannot be read
 * is one `sdk.ts` would fall back from on every start.
 */
export async function installSdk(sdk: string, log: (m: string) => void): Promise<{ release: ClaudeRelease; query: typeof import("@anthropic-ai/claude-agent-sdk").query }> {
  if (!/^\d+\.\d+\.\d+$/.test(sdk)) throw new Error(`${sdk} is not an Agent SDK version`);
  const dir = installDir(sdk);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: `covey-claude-${sdk.replace(/\./g, "-")}`,
    private: true,
    type: "module",
    dependencies: { [PACKAGE]: sdk },
  }, null, 2) + "\n");
  // See the note above: this file exists so pnpm never reaches the checkout's.
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "# covey installs one Claude Code here; pnpm must not look further up.\n");
  writeFileSync(join(dir, ".npmrc"), "minimum-release-age=0\n");
  log(`installing Claude Code from ${PACKAGE}@${sdk} in ${dir}`);
  await run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], {
    cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: installEnv(),
  });
  const loaded = await loadInstalled(sdk);
  log(`installed Claude Code ${loaded.release.claude} (sdk ${sdk})`);
  return loaded;
}

/**
 * Load a version that is already on disk, and hand back its `query`.
 *
 * The check that matters, and the one `sdk.ts` would otherwise make on every
 * start for ever. Both callers go through it — a fresh install and a version
 * the reader picked again — because `entryFor` tests that `sdk.mjs` exists and
 * nothing more: an interrupted `pnpm install` or a full disk leaves a
 * directory that passes and a daemon that falls back after the restart, with a
 * step record claiming the install was verified.
 *
 * Never a look for the platform package by path. pnpm keeps it beside the
 * *real* package inside `.pnpm` rather than in the top-level link, so a path
 * check reads a working install as a broken one and couples covey to a layout
 * that is not its own.
 */
export async function loadInstalled(sdk: string): Promise<{ release: ClaudeRelease; query: typeof import("@anthropic-ai/claude-agent-sdk").query }> {
  const entry = entryFor(sdk);
  if (!entry) throw new Error(`there is no ${PACKAGE}/sdk.mjs in ${installDir(sdk)}`);
  const claude = manifestVersion(installDir(sdk));
  if (!claude) throw new Error("the install carries no readable manifest.json, so covey cannot say which Claude Code it is");
  const mod = (await import(entry)) as { query: typeof import("@anthropic-ai/claude-agent-sdk").query };
  if (typeof mod.query !== "function") throw new Error("the install exports no `query`, so covey cannot start a session with it");
  return { release: releaseFor(sdk, { claude, installed: true }), query: mod.query };
}

/**
 * What a fresh install offers, read from the install itself.
 *
 * The proof that the whole chain works — the JavaScript loads, the binary
 * extracts, and it answers — and the one figure the reader actually wanted: a
 * version is picked to get a model, so the step says which models came with
 * it. A warning and never a failure: `readModels` also answers null on a
 * machine with no credentials, and an install is not the thing wrong there.
 */
export async function verifyInstall(dir: string, q: typeof import("@anthropic-ai/claude-agent-sdk").query): Promise<string[] | null> {
  const { readModels } = await import("./models.js");
  const found = await readModels(dir, q);
  return found ? found.models.map((m) => m.label) : null;
}

/**
 * pnpm usually lives beside the node running us, which is not always on the
 * daemon's inherited PATH — it was started by a launcher, not a login shell.
 * The same reasoning as `update.ts`'s `childEnv`.
 */
function installEnv(): NodeJS.ProcessEnv {
  const nodeBin = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
  const path = process.env.PATH ?? "";
  return { ...process.env, PATH: path.split(":").includes(nodeBin) ? path : `${nodeBin}:${path}` };
}

/**
 * Throw away every installed version but the ones named.
 *
 * Each install is about 223 MB, so covey keeps the one in force and nothing
 * else. It runs at start, when no session holds any of them: pruning the
 * directory a running process imported from is a way to find out what a half
 * loaded module does.
 */
export function pruneInstalls(keep: (string | null | undefined)[], log: (m: string) => void): void {
  const kept = new Set(keep.filter((v): v is string => !!v));
  let names: string[] = [];
  try { names = readdirSync(installRoot()); } catch { return; }
  for (const n of names) {
    if (kept.has(n) || !/^\d+\.\d+\.\d+$/.test(n)) continue;
    try { rmSync(installDir(n), { recursive: true, force: true }); log(`removed the unused Claude Code install ${n}`); }
    catch (e: any) { log(`could not remove the Claude Code install ${n}: ${e?.message ?? e}`); }
  }
}

/**
 * What the registry offers.
 *
 * Read on demand and never on a timer: a control panel nobody opens must not
 * make a machine poll npm. The document is about 1.2 MB, which is why the read
 * is bounded and why the answer is cached by the caller.
 */
export async function readRegistry(): Promise<{ releases: ClaudeRelease[]; error?: string }> {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return { releases: [], error: `the npm registry answered ${res.status}` };
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_REGISTRY_BYTES) return { releases: [], error: "the npm registry answered with more than covey will read" };
    const doc = (await res.json()) as Parameters<typeof releasesFrom>[0];
    const installed = managedReleases().map((r) => r.sdk);
    return { releases: releasesFrom(doc, { installed }) };
  } catch (e: any) {
    // Say which of the things went wrong, rather than showing an empty list as
    // though npm had published nothing (#132).
    const why = e?.name === "TimeoutError" ? "the npm registry did not answer in time" : `the npm registry could not be reached: ${e?.message ?? e}`;
    return { releases: [], error: why };
  }
}
