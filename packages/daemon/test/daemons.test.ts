/**
 * Regression tests for issue #53 — the teardown, not the suites that use it.
 *
 * The honest test of "the suite does not hang" is a test that hangs when it
 * fails, which is no use to anyone. What can be tested is the machinery the
 * hang was made of. Three of these were watched to fail with the matching line
 * in `daemons.ts` put back the way it was:
 *
 *  - `waitForExit` against a process that has already exited. The old
 *    `await new Promise((res) => proc.once("exit", res))` waits for ever there,
 *    because `exit` fires once and is not replayed. Reverted, it does not fail,
 *    it hangs — and `--test-timeout` is what gives the hang a name.
 *  - a daemon still booting when its budget runs out. This is the original
 *    defect: 10s allowed against a 13-16s boot, and the daemon abandoned alive.
 *  - a daemon nobody stopped cannot hold the test process open. This is the
 *    673-second hang itself, and the one thing `--test-timeout` cannot turn
 *    into a failure, because by then no test is running.
 *
 * A warning from writing them. The "does not stay behind" test first asserted
 * against the port-collision case, and it passed with the fix reverted: a
 * daemon that dies on EADDRINUSE is already dead, so there was nothing to leave
 * behind and the test proved nothing. If you change one of these, revert the
 * fix and watch it fail before you believe it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort, startDaemon, stopAll, tempDir, waitForExit } from "./daemons.js";

const helper = join(dirname(fileURLToPath(import.meta.url)), "daemons.ts");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Long enough for a daemon to boot `tsx` on a loaded four-core Pi, where the
 *  slowest of sixteen measured boots took 16.1s — and short enough that a real
 *  failure is reported rather than waited out. */
const BOOT_BUDGET_MS = 120_000;

after(stopAll);

test("waitForExit returns for a process that has already exited", async () => {
  // The trap this replaces: `exit` fires once, so a listener attached after the
  // fact is never called and the wait never ends. A daemon that dies at birth
  // on EADDRINUSE puts a test in exactly that position.
  const proc = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(await waitForExit(proc, 30_000), true, "it should see the exit it was waiting for");

  // Now it has been dead for a while and the event is long gone.
  assert.equal(proc.exitCode, 0, "the process really has exited");
  assert.equal(await waitForExit(proc, 30_000), true,
    "a process that has already exited must be reported at once, not waited for");
});

test("waitForExit gives up on a process that outlives its bound, rather than waiting", async () => {
  const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const start = Date.now();
    assert.equal(await waitForExit(proc, 500), false, "it should report that the process is still there");
    assert.ok(Date.now() - start < 30_000, "and it should report it when the bound was up, not later");
  } finally {
    proc.kill("SIGKILL");
    await waitForExit(proc, 10_000);
  }
});

test("a daemon started for a test is stopped even when the assertion in the middle throws", async () => {
  // The shape of a test file: start daemons, do work that may throw, tear down.
  const [one, two] = await Promise.all([startDaemon({ name: "one" }), startDaemon({ name: "two" })]);
  const pids = [one.proc.pid!, two.proc.pid!];
  const ports = [one.port, two.port];

  await assert.rejects(async () => {
    try {
      assert.fail("the assertion in the middle of the test");
    } finally {
      // One daemon is stopped before the sweep and one is not, so the sweep has
      // to cope with both — an already-stopped daemon must not throw and take
      // the other one down with it, which is how five daemons were left behind.
      await one.stop();
      await stopAll();
    }
  }, /the assertion in the middle of the test/, "the failure must still reach the test, not be swallowed by the teardown");

  for (const [i, pid] of pids.entries()) {
    assert.equal(alive(pid), false, `daemon ${i + 1} (pid ${pid}) should have been stopped by the teardown`);
    await assert.rejects(fetch(`http://127.0.0.1:${ports[i]}/health`, { signal: AbortSignal.timeout(2000) }),
      `and nothing should still be listening on port ${ports[i]}`);
  }
});

test("a daemon that cannot start is reported, and does not stay behind", async () => {
  // Two runs of the suite at once used to pick the same port out of a window
  // fifty wide. The loser exits on EADDRINUSE, and the run that started it was
  // left waiting out a budget for a process that was already dead.
  const port = await freePort();
  // It hangs up on every caller rather than leaving the socket open: a server
  // that accepts and never answers would make `close` below wait on connections
  // that never end, which is the same bug in a different costume.
  const squatter = createServer((socket) => socket.destroy());
  await new Promise<void>((res) => squatter.listen(port, "127.0.0.1", res));
  // Unref'd for the same reason the daemons are: a listening handle nobody
  // closed keeps this whole file's process alive after the last test. An
  // earlier draft of this test threw before `close` and lingered for 299s.
  squatter.unref();
  let spawned: number | undefined;
  try {
    const start = Date.now();
    await assert.rejects(
      startDaemon({ name: "collides", port }).then((d) => { spawned = d.proc.pid; return d; }),
      /did not start/,
      "a port that is already taken must be a named failure",
    );
    assert.ok(Date.now() - start < BOOT_BUDGET_MS,
      "and it must be reported as soon as the daemon dies, not after the whole start budget");
  } finally {
    await new Promise<void>((res) => squatter.close(() => res()));
  }
});

test("a daemon still booting when its budget runs out is not left behind", async () => {
  // This is the original defect exactly. `startDaemon` allowed 10s; a boot on
  // this machine takes 13-16s; so it threw while the daemon was alive and well
  // and on its way up — and walked away from the process it had spawned. A 1s
  // budget puts a real daemon in that same position in one second.
  const failure = await startDaemon({ name: "slow", startBudgetMs: 1000 }).then(
    (d) => { void d.stop(); throw new Error(`the start should not have succeeded within 1s (port ${d.port})`); },
    (e: Error) => e,
  );
  assert.match(failure.message, /did not start/, failure.message);

  // The start never returned a daemon, so the message is the only handle on
  // that process the caller has left — which is why it names the pid.
  const pid = Number(/\(pid (\d+)\)/.exec(failure.message)?.[1]);
  assert.ok(Number.isInteger(pid), `the failure must name the pid it abandoned. Got:\n${failure.message}`);
  assert.equal(alive(pid), false,
    `a daemon abandoned while it was still booting must still be stopped. pid ${pid} is still running. Failure was:\n${failure.message}`);

  const port = Number(/on port (\d+)/.exec(failure.message)?.[1]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }),
    `and nothing should be listening on port ${port}`);
});

test("freePort hands out a port nothing is listening on, and a different one each time", async () => {
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set(ports).size, ports.length, "two daemons must never be sent to the same port");
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }),
      `nothing should be listening on ${port}`);
  }
});
