import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { DEFAULT_FLEET, cleanFleet, isDefaultFleet } from "@covey/client";
import type { MachineSettings, PeerMachine, PermissionMode } from "@covey/protocol";

/** Cross-platform app data dir: XDG on Linux, ~/Library/Application Support on
 *  macOS, %APPDATA% on Windows. Override with COVEY_HOME. */
export function dataDir(): string {
  if (process.env.COVEY_HOME) return process.env.COVEY_HOME;
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return adoptOldDir(join(home, "Library", "Application Support", "covey"));
    case "win32":
      return adoptOldDir(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "covey"));
    default:
      return adoptOldDir(join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "covey"));
  }
}

/**
 * Where this daemon keeps the repositories it clones, one directory per
 * project: `<projectsDir>/<owner>/<repo>/repo.git` is the bare clone and each
 * thread's worktree sits beside it.
 *
 * Under `COVEY_HOME` when that is set, so a throwaway daemon on another port
 * clones into its own directory and never into the real one. Otherwise
 * `~/.covey/projects`: a path the user can find and read, on every platform.
 * Override with `COVEY_PROJECTS`.
 */
export function projectsDir(): string {
  if (process.env.COVEY_PROJECTS) return process.env.COVEY_PROJECTS;
  if (process.env.COVEY_HOME) return join(process.env.COVEY_HOME, "projects");
  return join(homedir(), ".covey", "projects");
}

/** Take over the directory that the previous name of this program used. This
 *  runs one time. After the move, the old directory does not exist. If the move
 *  fails, the old directory stays in use, so a machine keeps its id and token. */
function adoptOldDir(dir: string): string {
  if (existsSync(dir)) return dir;
  const old = dir.replace(/covey$/, "matui");
  if (old === dir || !existsSync(old)) return dir;
  try {
    renameSync(old, dir);
    return dir;
  } catch {
    return old;
  }
}

export interface DaemonConfig {
  machineId: string;
  name: string;
  /** Shared token accepted as an alternative to tailscale identity. */
  token: string;
  port: number;
  /** "loopback" | "tailnet" | "all" | explicit ip */
  bind: string;
  createdAt: string;
  /** Machine-wide default model for new threads; null = no opinion. */
  defaultModel: string | null;
  /** Machine-wide default permission mode for new threads; null = no opinion. */
  defaultPermissionMode: PermissionMode | null;
  /** Machine-wide default for incremental text on new threads; null = off. */
  defaultStreaming: boolean | null;
  /** Minutes a thread may idle before its session is released; 0 = never, null = default. */
  sessionIdleMinutes: number | null;
  /** Sessions kept live at one time; null = a limit derived from memory. */
  maxLiveSessions: number | null;
  /** Whether this daemon serves the web client; null = off. */
  webEnabled?: boolean | null;
  /** Archive a thread when its pull request merges; null = the default, which is on. */
  archiveOnMerge?: boolean | null;
  /** Which fleet this machine belongs to; null = the default fleet. */
  fleet?: string | null;
  /** The machines the web client dials besides this one. The TUI sets it. */
  peers?: PeerMachine[];
}

/**
 * The default idle limit, in minutes.
 *
 * A session costs about 250 MB, and `defaultLiveSessionLimit` is what bounds
 * that cost: the budget releases the least recently used session as soon as
 * the machine holds more than it allows. So the idle limit never guards the
 * memory ceiling. It only gives memory back *under* the ceiling, and it asks
 * a price for it that the budget does not.
 *
 * The price is the credentials. A session covey starts fresh reads the real
 * credential store and refreshes the token for itself, the way a Claude Code
 * terminal does. A session covey resumes cannot: the SDK hands a resume a copy
 * of the store with the refresh token taken out, so the token it starts with
 * is the last one it will ever hold, and it dies at that token's expiry. Every
 * idle release therefore turns a session that would have lived into one that
 * has a deadline (`EXPIRY_MARGIN_MS` in `engine.ts` holds the other half).
 *
 * Two hours, because that is what the threads do. Measured over three days on
 * one machine: of the 31 idle releases whose thread spoke again, 25 spoke
 * again within two hours, and the 6 that did not came back after three hours
 * or more. A limit of two hours therefore keeps the session for the pause a
 * person takes — a build, a review, a meeting — and still releases the thread
 * that was left for the day.
 */
export const DEFAULT_SESSION_IDLE_MINUTES = 120;

/**
 * What one more live session costs the machine.
 *
 * Measured on 2026-10-02 against SDK 0.3.280, on a 32-core Ubuntu machine with
 * 31 GiB of memory: eight sessions started through the Agent SDK with covey's
 * own options — streaming input, the user, project and local settings files,
 * the covey plugin — and each process read from `/proc/<pid>/smaps_rollup`.
 * MB per session:
 *
 *     point in the test                      Rss   Pss   private
 *     started, no turn                       239   145   133
 *     after one trivial turn                 255   159   147
 *     after a turn with tools (200 KB read)  271   174   162
 *
 * The figure to build a ceiling on is `Pss` and never `Rss`. About 100 MB of
 * each process is the binary's own code pages, and every session on the
 * machine shares one copy of them; `Rss` counts that 100 MB again in every
 * process, so it reads eight sessions as most of a gigabyte more than they
 * cost. The old figure of 300 MB was the `Rss` of a session with no sibling,
 * which is the one case where the two readings agree.
 *
 * 250 MB and not 174, because a session grows with the work it does and then
 * stops. One session that read 48 files over 8 turns went from 133 MB of
 * private memory to about 190 MB and grew no further, and a session on the
 * live daemon held 249 MB after an hour of real work. So 250 MB is what a
 * session that has done a day's work costs, and the ceiling is for those.
 */
export const SESSION_MEMORY_BYTES = 250 * 1024 * 1024;

/**
 * How many sessions this machine keeps live when nobody said otherwise.
 *
 * A quarter of the machine's memory at `SESSION_MEMORY_BYTES` a session, and
 * never fewer than two — a thread and the one beside it, which is the least a
 * person can work with. Nothing bounds it from above, because the memory is
 * the bound: the old cap of eight meant every machine with more than 16 GiB of
 * memory held the same eight sessions, so the figure this function reads
 * decided nothing on exactly the machines that have memory to spend. A 31 GiB
 * workstation now holds 31 sessions, and the floor catches a board under 2 GiB,
 * which cannot afford even two.
 *
 * A quarter and not the old 15%, because the ceiling is a ceiling and not a
 * reservation. A machine seldom holds the whole count, every session over the
 * floor is one a reader opened, and the three quarters left over is what the
 * agents' own work — a build, a test run, a browser — spends.
 */
export function defaultLiveSessionLimit(mem = totalmem()): number {
  const affordable = Math.floor((mem * 0.25) / SESSION_MEMORY_BYTES);
  return Math.max(2, affordable);
}

const configFile = () => join(dataDir(), "daemon.json");

function readConfigFile(): Record<string, unknown> {
  const f = configFile();
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
}

/** Settings written before these fields existed simply read as "no opinion". */
export function machineSettings(cfg: Partial<Pick<DaemonConfig, "defaultModel" | "defaultPermissionMode" | "defaultStreaming" | "sessionIdleMinutes" | "maxLiveSessions" | "webEnabled" | "archiveOnMerge" | "fleet" | "bind">>): MachineSettings {
  return {
    defaultModel: cfg.defaultModel ?? null,
    defaultPermissionMode: cfg.defaultPermissionMode ?? null,
    // The old escape becomes the seed for the new default, so a machine that
    // starts with COVEY_STREAM=1 still gives every new thread incremental text.
    defaultStreaming: cfg.defaultStreaming ?? (process.env.COVEY_STREAM === "1" ? true : null),
    // The environment is the escape hatch for both limits: a machine can turn
    // the sweep off (`COVEY_SESSION_IDLE_MINUTES=0`) without an edit to
    // daemon.json, and the file still wins when it holds a value.
    sessionIdleMinutes: cfg.sessionIdleMinutes ?? envNumber("COVEY_SESSION_IDLE_MINUTES"),
    maxLiveSessions: cfg.maxLiveSessions ?? envNumber("COVEY_MAX_LIVE_SESSIONS"),
    // `COVEY_WEB=1` seeds a throwaway daemon that has no TUI to turn it on.
    webEnabled: cfg.webEnabled ?? (process.env.COVEY_WEB === "1" ? true : null),
    // On unless the machine says otherwise, so `null` reads as on and only a
    // written `false` turns it off. `COVEY_ARCHIVE_ON_MERGE=0` is the escape
    // for a daemon with no TUI to turn it off in.
    archiveOnMerge: cfg.archiveOnMerge ?? (process.env.COVEY_ARCHIVE_ON_MERGE === "0" ? false : null),
    // The default fleet is what a machine that names none is in, so only
    // another name is written down and `daemon.json` holds nothing for most
    // machines.
    //
    // No environment escape, unlike the settings around it. The others read
    // `cfg.x ?? process.env.X`, which means a written `null` falls back to the
    // environment — and `null` is exactly how "the default fleet" is written.
    // A machine started with one named in its environment could then never be
    // moved back, however many times a reader pressed the row that says it
    // moved. A fleet is set from the machine's control panel, like its name.
    fleet: fleetSetting(cfg.fleet),
    ...(cfg.bind ? { bind: cfg.bind } : {}),
  };
}

/** A whole number from the environment, or null when it is absent or not one. */
function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Persist a change to the machine-wide defaults. Re-reads the file rather than
 * writing back the loaded config, so transient CLI overrides (`--port`) never
 * leak into `daemon.json`.
 */
export function saveMachineSettings(patch: Partial<MachineSettings>): MachineSettings {
  const cur = readConfigFile();
  const next = { ...cur, ...stripUndefined(patch) };
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return machineSettings(next as DaemonConfig);
}

/**
 * The fleet name to write down: another name as it was typed, or null for the
 * default fleet. A machine in the default fleet records nothing, so a reader
 * who never made a second fleet has an unchanged `daemon.json`.
 */
export function fleetSetting(name?: unknown): string | null {
  // `unknown`, because a daemon.json written before fleets took the word
  // holds an array of peers under this key. Anything that is not a name is
  // no name.
  const n = typeof name === "string" ? cleanFleet(name) : null;
  return !n || isDefaultFleet(n) ? null : n;
}

/** This machine's fleet, as a name rather than as a setting. */
export function fleetName(cfg: Pick<DaemonConfig, "fleet">): string {
  return fleetSetting(cfg.fleet) ?? DEFAULT_FLEET;
}

/** Keep the peer list the TUI sent, beside the settings. The whole list, every time. */
export function savePeers(peers: PeerMachine[]): PeerMachine[] {
  const cur = readConfigFile();
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cur, peers }, null, 2) + "\n", { mode: 0o600 });
  return peers;
}

/**
 * The peer list on disk, or none. Read on demand: a page asks for it seldom.
 *
 * A daemon written before fleets took the word kept this list under `fleet`,
 * which now names something else. The old key is read once more here so that
 * an update does not leave a phone dialling one machine until the TUI next
 * sends the list.
 */
export function readPeers(): PeerMachine[] {
  const cfg = readConfigFile() as { peers?: unknown; fleet?: unknown };
  const p = Array.isArray(cfg.peers) ? cfg.peers : Array.isArray(cfg.fleet) ? cfg.fleet : [];
  return p as PeerMachine[];
}

export function loadDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = configFile();
  let cfg: DaemonConfig;
  if (existsSync(file)) {
    cfg = JSON.parse(readFileSync(file, "utf8")) as DaemonConfig;
  } else {
    cfg = {
      machineId: randomUUID(),
      name: hostname().split(".")[0] ?? "machine",
      token: randomBytes(24).toString("hex"),
      port: 3790,
      bind: "tailnet",
      createdAt: new Date().toISOString(),
      defaultModel: null,
      defaultPermissionMode: null,
      defaultStreaming: null,
      sessionIdleMinutes: null,
      maxLiveSessions: null,
    };
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  }
  return { ...cfg, ...machineSettings(cfg), ...stripUndefined(overrides) };
}

/**
 * The permission mode a new thread should start in, taken from the user's own
 * Claude settings (`permissions.defaultMode`), in the CLI's precedence order.
 *
 * The Agent SDK does *not* apply `defaultMode` itself — omitting the
 * `permissionMode` option yields `default` regardless of what settings say
 * (verified against SDK 0.3.265). So if covey didn't read it, someone who has
 * configured `bypassPermissions` would still be prompted for every tool.
 */
export function resolveDefaultPermissionMode(cwd: string): "default" | "acceptEdits" | "plan" | "bypassPermissions" {
  const files = [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  let mode: string | undefined;
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const v = JSON.parse(readFileSync(f, "utf8"))?.permissions?.defaultMode;
      if (typeof v === "string") mode = v; // later files win
    } catch { /* malformed settings shouldn't break thread creation */ }
  }
  // The SDK knows modes we don't model ("dontAsk", "auto"); fall back for those.
  return mode === "acceptEdits" || mode === "plan" || mode === "bypassPermissions" ? mode : "default";
}

export function platformInfo() {
  return { os: platform(), arch: arch(), homeDir: homedir() };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
