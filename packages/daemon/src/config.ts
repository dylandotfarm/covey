import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { MachineSettings, PermissionMode } from "@covey/protocol";

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
}

/**
 * The default idle limit, in minutes.
 *
 * A session costs about 300 MB and answers about 0.3 s faster than a resumed
 * one (measured on macOS with SDK 0.3.265, on a 458 KB transcript). The prompt
 * cache expires after about five minutes, so a session that has been quiet for
 * longer than that holds memory for almost no gain. Fifteen minutes is past
 * every ordinary pause — a read, a build, a meeting — and well inside the hour
 * a forgotten thread would otherwise hold.
 */
export const DEFAULT_SESSION_IDLE_MINUTES = 15;

/** What one live session costs in resident memory. Measured: 271-363 MB. */
const SESSION_MEMORY_BYTES = 300 * 1024 * 1024;

/**
 * How many sessions this machine keeps live when nobody said otherwise.
 *
 * The daemon spends at most 15% of the machine's memory on warm sessions, and
 * never fewer than two (a thread and the one beside it) nor more than eight.
 * A small machine therefore holds fewer sessions than a large one, which is
 * what a memory limit has to mean.
 */
export function defaultLiveSessionLimit(mem = totalmem()): number {
  const affordable = Math.floor((mem * 0.15) / SESSION_MEMORY_BYTES);
  return Math.min(8, Math.max(2, affordable));
}

const configFile = () => join(dataDir(), "daemon.json");

function readConfigFile(): Record<string, unknown> {
  const f = configFile();
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
}

/** Settings written before these fields existed simply read as "no opinion". */
export function machineSettings(cfg: Partial<Pick<DaemonConfig, "defaultModel" | "defaultPermissionMode" | "defaultStreaming" | "sessionIdleMinutes" | "maxLiveSessions">>): MachineSettings {
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
