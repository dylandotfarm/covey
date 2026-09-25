import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, type SavedMachine } from "@covey/protocol";

export function configDir(): string {
  if (process.env.COVEY_CONFIG) return process.env.COVEY_CONFIG;
  const home = homedir();
  switch (platform()) {
    case "darwin": return adoptOldDir(join(home, "Library", "Application Support", "covey"));
    case "win32": return adoptOldDir(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "covey"));
    default: return adoptOldDir(join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "covey"));
  }
}

/** Take over the directory that the previous name of this program used. The
 *  daemon does the same move; the first of the two to start wins, and the
 *  second one finds the new directory already in place. */
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

export interface TuiConfig {
  machines: SavedMachine[];
  prefs: {
    sidebarCollapsed?: boolean;
    lastSelected?: { machine: string; threadId: string } | null;
    expanded?: Record<string, boolean>;
    /** ctrl+o: how much of a transcript is open before the reader taps (#149).
     *  A `Lod`, held as a string so a value written by a newer covey reads
     *  back as "no opinion" rather than breaking the whole config. */
    lod?: string;
    /** What `lod` replaced: two levels rather than four. Read once, by
     *  `startingLod`, and never written — a rollback must still find it. */
    toolsExpanded?: boolean;
    /** Which palette the TUI paints in. A `Theme` id, held as a string so a
     *  name written by a newer covey reads back as "the default" rather than
     *  breaking the whole config. */
    theme?: string;
    defaultPermissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
    /** Disable the terminal bell for background thread events. */
    quiet?: boolean;
    /**
     * Clones asked of machines that were not connected at the time. The
     * store sends each one when its machine next answers, and takes it off
     * the list once the machine has the project.
     */
    pendingProjects?: { machine: string; url: string; title?: string; baseBranch?: string }[];
  };
}

const file = () => join(configDir(), "config.json");

export function loadConfig(): TuiConfig {
  const f = file();
  const base: TuiConfig = { machines: [], prefs: {} };
  if (!existsSync(f)) return base;
  try { return { ...base, ...JSON.parse(readFileSync(f, "utf8")) }; } catch { return base; }
}

export function saveConfig(cfg: TuiConfig) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(cfg, null, 2) + "\n");
}

export function localMachine(): SavedMachine {
  // COVEY_PORT moves the whole local pair (daemon + this client) off the
  // default, so a throwaway instance can run beside a real one.
  const n = Number(process.env.COVEY_PORT);
  const port = Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
  return { name: "local", url: `ws://127.0.0.1:${port}` };
}
