import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { PROBED_TOOLS, concurrencyLimit, type MachineResources, type MachineTool } from "@covey/protocol";

const run = promisify(execFile);

/**
 * Other places a second copy of a program hides. The run of 2026-09-16 needed
 * the one machine with an old `/usr/bin/node` (v18.19.1) to reproduce a defect
 * against, and `node` on that machine's `PATH` was a much newer one under
 * `nvm`. A tool list that reports only what the `PATH` resolves cannot answer
 * "which machine can run the old one".
 */
const EXTRA_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin", "/snap/bin"];

/**
 * What this machine is made of and which tools this daemon can run.
 *
 * Read here, in the daemon, and never over `ssh`. The daemon is started from a
 * login shell — on the Pi of the run of 2026-09-16, through `nvm` — and a
 * non-interactive `ssh` session is not, so the two resolve different `PATH`s.
 * An agent inherits the daemon's environment, so the daemon's answer is the
 * only one a run can place work with. An `ssh` probe said that machine had no
 * `pnpm`; it had `pnpm`, and the operator nearly installed a second one.
 */
/**
 * Where to look. The daemon passes nothing: its own environment is the answer,
 * and that is the point. A test names the directories so it does not depend on
 * what happens to be installed on the machine it runs on.
 */
export interface ProbeOptions {
  path?: string;
  extraDirs?: string[];
}

export async function machineResources(o: ProbeOptions = {}): Promise<MachineResources> {
  const path = o.path ?? process.env.PATH ?? "";
  const extraDirs = o.extraDirs ?? EXTRA_DIRS;
  const cpuCount = Math.max(1, cpus().length);
  const totalMemoryBytes = totalmem();
  const tools: MachineTool[] = [];
  for (const name of PROBED_TOOLS) {
    for (const file of candidates(name, path, extraDirs)) {
      tools.push({ name, path: file, version: await toolVersion(file) });
    }
  }
  return {
    cpuCount,
    totalMemoryBytes,
    concurrency: concurrencyLimit(cpuCount, totalMemoryBytes),
    tmpDir: tmpdir(),
    path,
    tools,
    readAt: new Date().toISOString(),
  };
}

/**
 * Every copy of `name` worth reporting, the one the `PATH` resolves first.
 *
 * A name the `PATH` does not resolve is reported not at all, even when a copy
 * sits in `/usr/bin`: a run places work by asking "can an agent on that machine
 * type `pnpm`", and an agent inherits the `PATH`, not this list. `EXTRA_DIRS`
 * is only searched for a *second* copy of a name the `PATH` already has, which
 * is how the machine with the old `/usr/bin/node` answers for itself.
 */
function candidates(name: string, path: string, extraDirs: string[]): string[] {
  const onPath = path.split(delimiter).map((dir) => resolveIn(dir, name)).find(Boolean);
  if (!onPath) return [];
  const other = extraDirs.map((dir) => resolveIn(dir, name)).find((f) => f && f !== onPath);
  // Two copies is enough to say "there is another one"; a machine with `nvm`
  // has a dozen and the list is for a person to read.
  return other ? [onPath, other] : [onPath];
}

function resolveIn(dir: string, name: string): string | null {
  if (!dir || !isAbsolute(dir)) return null;
  const file = join(dir, name);
  return isExecutable(file) ? file : null;
}

function isExecutable(file: string): boolean {
  try {
    // The execute bit, not only the name. A file the daemon cannot run is a
    // tool an agent cannot type, and placement that believes otherwise sends
    // an `os=darwin needs=gh` task to a machine that cannot do it.
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first version-looking word of `<tool> --version`. A tool that will not
 * say reports null rather than holding up the probe: the name and the path are
 * what placement needs, and the version is colour.
 */
async function toolVersion(file: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(file, ["--version"], { timeout: 3000, maxBuffer: 1 << 20 });
    const text = (stdout || stderr).trim().split("\n")[0] ?? "";
    const word = text.split(/\s+/).find((w) => /\d+\.\d+/.test(w));
    return word ? word.replace(/^v/, "") : text.slice(0, 40) || null;
  } catch {
    return null;
  }
}
