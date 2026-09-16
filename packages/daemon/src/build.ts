/**
 * Which build a process runs, and whether a newer one sits on disk.
 *
 * Two different questions share this file, because they share the same facts:
 *
 *  - Across machines: is that daemon older than this client? The client and the
 *    daemon keep their own clocks, so only the commit date of `HEAD` can order
 *    the two builds. `buildInfo` collects it.
 *  - On one machine: did somebody rebuild while this process ran? A process
 *    keeps its code in memory, so a rebuild changes nothing until it restarts.
 *    `newestBuildMtime` watches the files the process was loaded from.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "@covey/protocol";
import { git, sourceRoot } from "./update.js";

/** How deep to walk a build directory. `dist/components/*.js` is the deepest we ship. */
const MAX_DEPTH = 4;

/** What counts as code: compiled output, and the sources tsx runs directly. */
const CODE = /\.(js|cjs|mjs|ts|tsx)$/;

/**
 * The build a checkout currently holds. `from` picks the checkout, the same way
 * `sourceInfo` does: the CLI passes its own directory so that "the client's
 * build" is the one the client was launched from.
 */
export async function buildInfo(from?: string): Promise<BuildInfo> {
  const builtAt = isoMtime(newestBuildMtime(buildDirs(from)));
  const root = sourceRoot(from);
  if (!root) return { commit: null, committedAt: null, branch: null, dirty: false, builtAt };
  const [commit, committedAt, branch, status] = await Promise.all([
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["log", "-1", "--pretty=%cI"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain"]),
  ]);
  return {
    commit,
    committedAt,
    branch: branch === "HEAD" ? null : branch,
    dirty: !!status,
    builtAt,
  };
}

/**
 * A short name for a build, for a status line: the commit, and a mark when the
 * checkout is dirty. This is what `MachineInfo.daemonVersion` carries — the
 * package version said nothing, because it never moves.
 */
export function buildLabel(b: BuildInfo): string {
  if (!b.commit) return b.builtAt ? `built ${b.builtAt.slice(0, 10)}` : "unknown";
  return `${b.commit}${b.dirty ? "-dirty" : ""}`;
}

/**
 * Every directory the running code can come out of.
 *
 * `tsc -b` only rewrites the packages that changed, so one file is not enough:
 * a new keybinding rewrites `packages/tui/dist` and leaves
 * `packages/cli/dist/index.js` at its old mtime. So from `packages/cli/dist`
 * this returns the `dist` directory of every package beside it. Run from source
 * under tsx the leaf is `src`, and the same walk finds every `src` instead.
 */
export function buildDirs(from = dirname(fileURLToPath(import.meta.url))): string[] {
  const leaf = basename(from); // dist, or src under tsx
  const packages = dirname(dirname(from));
  if (basename(packages) !== "packages") return [from];
  let names: string[];
  try { names = readdirSync(packages); } catch { return [from]; }
  const dirs = names.map((n) => join(packages, n, leaf)).filter(isDir);
  return dirs.length > 0 ? dirs : [from];
}

/**
 * Newest mtime, in milliseconds, of the code files under `dirs`. 0 when there
 * are none — an unknown build never counts as newer than anything.
 */
export function newestBuildMtime(dirs: string[]): number {
  let newest = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (CODE.test(name)) newest = Math.max(newest, st.mtimeMs);
    }
  };
  for (const d of dirs) walk(d, 1);
  return newest;
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isoMtime(ms: number): string | null {
  return ms > 0 ? new Date(ms).toISOString() : null;
}
