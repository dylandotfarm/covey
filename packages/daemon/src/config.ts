import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
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
}

const configFile = () => join(dataDir(), "daemon.json");

function readConfigFile(): Record<string, unknown> {
  const f = configFile();
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
}

/** Settings written before these fields existed simply read as "no opinion". */
export function machineSettings(cfg: Pick<DaemonConfig, "defaultModel" | "defaultPermissionMode" | "defaultStreaming">): MachineSettings {
  return {
    defaultModel: cfg.defaultModel ?? null,
    defaultPermissionMode: cfg.defaultPermissionMode ?? null,
    // The old escape becomes the seed for the new default, so a machine that
    // starts with COVEY_STREAM=1 still gives every new thread incremental text.
    defaultStreaming: cfg.defaultStreaming ?? (process.env.COVEY_STREAM === "1" ? true : null),
  };
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
