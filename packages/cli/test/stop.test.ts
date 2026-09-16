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
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "src", "index.ts");
const run = promisify(execFile);

/** Two ports well away from 3790 and away from the throwaway port agents use. */
const PORT_KEEP = 3840 + Math.floor(Math.random() * 20);
const PORT_STOP = PORT_KEEP + 20;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function startDaemon(port: number, home: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--import", "tsx", cliEntry, "daemon", "--bind", "loopback", "--port", String(port)],
    { env: { ...process.env, COVEY_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  proc.stderr!.on("data", (d) => { log += d.toString(); });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon on ${port} did not start:\n${log}`);
}

/** Run the CLI the way a person would. Never throws on a non-zero exit. */
async function covey(home: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, ["--import", "tsx", cliEntry, ...args], { env: { ...process.env, COVEY_HOME: home } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

test("covey stop --port stops that one daemon and leaves the other running", async () => {
  const homeKeep = mkdtempSync(join(tmpdir(), "covey-keep-"));
  const homeStop = mkdtempSync(join(tmpdir(), "covey-stop-"));
  let keep: ChildProcess | undefined, victim: ChildProcess | undefined;
  try {
    [keep, victim] = await Promise.all([startDaemon(PORT_KEEP, homeKeep), startDaemon(PORT_STOP, homeStop)]);
    assert.ok(alive(keep.pid!) && alive(victim.pid!), "both daemons are up");

    const { code, out } = await covey(homeStop, "stop", "--port", String(PORT_STOP));

    assert.equal(code, 0, `covey stop --port ${PORT_STOP} should succeed. Output:\n${out}`);
    assert.match(out, new RegExp(`stopping daemon pid ${victim.pid} on port ${PORT_STOP}`),
      `covey stop must name the one pid it signals. Output:\n${out}`);

    for (let i = 0; i < 40 && alive(victim.pid!); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(victim.pid!), false, `the daemon on ${PORT_STOP} should have stopped`);

    // The heart of the defect: the other daemon runs the same program, and it
    // must be untouched. `pkill -f "index.js daemon"` would have taken both.
    assert.equal(alive(keep.pid!), true,
      `the daemon on ${PORT_KEEP} must survive: stopping one daemon by port must never reach another`);
    assert.equal((await fetch(`http://127.0.0.1:${PORT_KEEP}/health`)).ok, true,
      `the daemon on ${PORT_KEEP} must still answer`);
    assert.equal(existsSync(join(homeKeep, `daemon-${PORT_KEEP}.pid`)), true,
      "and must keep its own pid file");
  } finally {
    for (const p of [keep, victim]) if (p?.pid && alive(p.pid)) p.kill("SIGKILL");
    for (const d of [homeKeep, homeStop]) rmSync(d, { recursive: true, force: true });
  }
});

test("covey stop reports a port with no daemon instead of hunting for one", async () => {
  const home = mkdtempSync(join(tmpdir(), "covey-none-"));
  try {
    const { code, out } = await covey(home, "stop", "--port", String(PORT_STOP));
    assert.equal(code, 0, `a port with nothing on it is not an error. Output:\n${out}`);
    assert.match(out, new RegExp(`no daemon on port ${PORT_STOP}`), out);
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
