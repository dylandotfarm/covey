import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
export async function machineResources(): Promise<MachineResources> {
  const path = process.env.PATH ?? "";
  const cpuCount = Math.max(1, cpus().length);
  const totalMemoryBytes = totalmem();
  const tools: MachineTool[] = [];
  for (const name of PROBED_TOOLS) {
    for (const file of candidates(name, path)) {
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
 * Later entries are the same program somewhere else, which is what lets a run
 * ask for the machine with the old `node` rather than for the newest one.
 */
function candidates(name: string, path: string): string[] {
  const found: string[] = [];
  for (const dir of [...path.split(delimiter), ...EXTRA_DIRS]) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    if (found.includes(file) || !isExecutable(file)) continue;
    found.push(file);
    // Two copies is enough to say "there is another one"; a machine with
    // `nvm` has a dozen and the list is for a person to read.
    if (found.length === 2) break;
  }
  return found;
}

function isExecutable(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
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
