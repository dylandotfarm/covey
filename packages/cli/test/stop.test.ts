/**
 * Regression test for the main cause in issue #8.
 *
 * Every daemon runs `node <dir>/index.js daemon`, so `pkill -f "index.js
 * daemon"` matches all of them. A session ran a pattern of that shape to clean
 * up a throwaway daemon and stopped the daemon that hosted it instead.
 *
 * `covey stop --port N` is the answer: a port names one daemon. This test
 * starts two daemons, stops one by port, and requires the other to survive.
 * Before the fix there was no `stop` command at all, so the CLI fell through
 * to the usage text and neither daemon stopped.
 *
 * Starting and stopping the daemons is `packages/daemon/test/daemons.ts`'s job
 * (issue #53): it is the module that guarantees a daemon started for a test
 * comes down again even when the test between throws.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort, startDaemon, stopAll, waitForExit } from "../../daemon/test/daemons.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "src", "index.ts");
const run = promisify(execFile);

/** Booting the CLI under tsx is the slow part — it pulls in Ink and React —
 *  and on this project's four-core Pi at load average 25 a whole `covey stop`
 *  against an empty port measured 30.9s. This is ~5x that: a bound the machine
 *  cannot trip, only a CLI that has genuinely stopped answering. */
const CLI_BUDGET_MS = 150_000;
/** A daemon that has been signalled must be gone this long after, or the stop
 *  path is broken rather than the machine being slow. */
const EXIT_BUDGET_MS = 30_000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Run the CLI the way a person would. Never throws on a non-zero exit, and
 *  never waits for ever: `covey stop` polls a pid, and a poll that cannot end
 *  is the defect in #53. */
async function covey(home: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, ["--import", "tsx", cliEntry, ...args], { env: { ...process.env, COVEY_HOME: home }, timeout: CLI_BUDGET_MS });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e: any) {
    if (e.killed) return { code: e.code ?? 1, out: `${(e.stdout ?? "") + (e.stderr ?? "")}\ncovey ${args.join(" ")} was still running after ${CLI_BUDGET_MS / 1000}s and was killed` };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// Whatever any test did, no daemon this file started is left listening.
after(stopAll);

test("covey stop --port stops that one daemon and leaves the other running", async () => {
  const homeKeep = mkdtempSync(join(tmpdir(), "covey-keep-"));
  const homeStop = mkdtempSync(join(tmpdir(), "covey-stop-"));
  // If either start throws, the other daemon is still registered and `after`
  // takes it down. Two runs at once cannot collide on a port they were handed.
  const [keep, victim] = await Promise.all([
    startDaemon({ home: homeKeep }),
    startDaemon({ home: homeStop }),
  ]);
  assert.ok(alive(keep.proc.pid!) && alive(victim.proc.pid!), "both daemons are up");

  const { code, out } = await covey(homeStop, "stop", "--port", String(victim.port));

  assert.equal(code, 0, `covey stop --port ${victim.port} should succeed. Output:\n${out}`);
  assert.match(out, new RegExp(`stopping daemon pid ${victim.proc.pid} on port ${victim.port}`),
    `covey stop must name the one pid it signals. Output:\n${out}`);

  assert.ok(await waitForExit(victim.proc, EXIT_BUDGET_MS),
    `the daemon on ${victim.port} should have stopped within ${EXIT_BUDGET_MS / 1000}s. Output:\n${out}`);

  // The heart of the defect: the other daemon runs the same program, and it
  // must be untouched. `pkill -f "index.js daemon"` would have taken both.
  assert.equal(alive(keep.proc.pid!), true,
    `the daemon on ${keep.port} must survive: stopping one daemon by port must never reach another`);
  assert.equal((await fetch(`http://127.0.0.1:${keep.port}/health`)).ok, true,
    `the daemon on ${keep.port} must still answer`);
  assert.equal(existsSync(join(homeKeep, `daemon-${keep.port}.pid`)), true,
    "and must keep its own pid file");
});

test("covey stop reports a port with no daemon instead of hunting for one", async () => {
  const home = mkdtempSync(join(tmpdir(), "covey-none-"));
  const port = await freePort();
  try {
    const { code, out } = await covey(home, "stop", "--port", String(port));
    assert.equal(code, 0, `a port with nothing on it is not an error. Output:\n${out}`);
    assert.match(out, new RegExp(`no daemon on port ${port}`), out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("covey stop refuses a --port it cannot read, rather than falling back to 3790", async () => {
  const home = mkdtempSync(join(tmpdir(), "covey-badport-"));
  try {
    // Falling back to the default here would aim the signal at the real daemon.
    const { code, out } = await covey(home, "stop", "--port", "banana");
    assert.equal(code, 2, `a bad port must stop the command. Output:\n${out}`);
    assert.match(out, /--port needs a number/, out);
    assert.doesNotMatch(out, /stopping daemon/, "it must not signal anything");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
