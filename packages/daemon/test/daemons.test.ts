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
 *  - a process that never opens the port is stopped when the budget runs out.
 *    This is the original defect: 10s allowed against a 13-16s boot, and the
 *    process abandoned alive.
 *  - a daemon nobody stopped cannot hold the test process open. This is the
 *    673-second hang itself, and the one thing `--test-timeout` cannot turn
 *    into a failure, because by then no test is running.
 *
 * Two warnings from writing them.
 *
 * The "does not stay behind" test first asserted against the port-collision
 * case, and it passed with the fix reverted: a daemon that dies on EADDRINUSE is
 * already dead, so there was nothing to leave behind and the test proved
 * nothing. If you change one of these, revert the fix and watch it fail before
 * you believe it.
 *
 * Then its replacement gave a *real* daemon a 1s budget, and expected the start
 * to time out. That passed on the Pi, where a boot takes 13-16s, and failed on
 * an idle CI runner, where the daemon came up inside the second. A test whose
 * result depends on how fast the machine is is not a test — it is #53 again,
 * wearing the other hat. Nothing here may race the machine: make the outcome
 * arrive by construction.
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

test("a daemon that dies at birth is reported at once, not at the end of the budget", async () => {
  // Two runs of the suite at once used to pick the same port out of a window
  // fifty wide. The loser exits on EADDRINUSE, and the run that started it then
  // spent the whole budget polling a port belonging to a process already dead.
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
  try {
    const failure = await startDaemon({ name: "collides", port, startBudgetMs: 120_000 }).then(
      (d) => { void d.stop(); throw new Error(`the port was taken; the daemon must not have started (port ${d.port})`); },
      (e: Error) => e,
    );
    // Not merely "did not start", which a budget running out would also give.
    // The point is that it noticed the process die instead of polling a dead
    // port for the whole 120 seconds.
    assert.match(failure.message, /did not start: it exited while starting/,
      `a daemon that died at birth must be reported as such, not as a budget that ran out. Got:\n${failure.message}`);
  } finally {
    await new Promise<void>((res) => squatter.close(() => res()));
  }
});

test("a process that never opens the port is stopped when the budget runs out", async () => {
  // The original defect: `startDaemon` allowed 10s against a boot that takes
  // 13-16s here, so it threw while the process was alive and on its way up, and
  // walked away from it.
  //
  // What is under test is that failure path, not the daemon. So this spawns
  // something that will *never* open the port. The budget then runs out on an
  // idle CI runner exactly as it does on a loaded Pi — by construction, not
  // because the test managed to be faster than the machine. An earlier version
  // gave a real daemon a 1s budget and passed here while failing on CI, where
  // the daemon came up inside the second: a test that only passes on slow
  // hardware, which is the same defect as #53 wearing the other hat.
  const failure = await startDaemon({
    name: "never-listens",
    startBudgetMs: 2000,
    argv: ["-e", "setTimeout(() => {}, 600_000)"],
  }).then(
    (d) => { void d.stop(); throw new Error(`a process that never listens must not count as started (port ${d.port})`); },
    (e: Error) => e,
  );
  assert.match(failure.message, /did not start/, failure.message);
  assert.match(failure.message, /it never answered in 2s/,
    `the budget must be what ran out, not the process dying early. Got:\n${failure.message}`);

  // The start never returned anything, so the message is the only handle on
  // that process the caller has left — which is why it names the pid.
  const pid = Number(/\(pid (\d+)\)/.exec(failure.message)?.[1]);
  assert.ok(Number.isInteger(pid), `the failure must name the pid it abandoned. Got:\n${failure.message}`);
  assert.equal(alive(pid), false,
    `a process abandoned at the end of its start budget must still be stopped. pid ${pid} is still running. Failure was:\n${failure.message}`);
});

test("a daemon nobody stopped cannot hold the test process open", async () => {
  // This is the 673-second hang in #53, in one process. The runner had finished
  // every test; it could not *exit*, because a daemon it had started was alive
  // and a child's stdio pipes are ref'd handles in its parent's event loop.
  // Here the child starts a daemon and then does nothing at all. If the daemon
  // holds it open, it never exits and this test fails on its bound.
  const dir = tempDir("covey-orphan-");
  // .mts, because a bare .ts in a directory with no package.json is CJS to
  // tsx, and the top-level await below would not compile.
  const script = join(dir, "orphan.mts");
  writeFileSync(script, [
    `import { startDaemon } from ${JSON.stringify(pathToFileURL(helper).href)};`,
    `const d = await startDaemon({ name: "orphan" });`,
    `console.log(JSON.stringify({ pid: d.proc.pid, port: d.port }));`,
    `// and now nothing: the only thing left in this process's event loop is a`,
    `// daemon it never stopped. It has to exit anyway.`,
    ``,
  ].join("\n"));

  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  try {
    assert.ok(await waitForExit(child, BOOT_BUDGET_MS),
      `a process holding nothing but an unstopped daemon must still exit. It did not, within ${BOOT_BUDGET_MS / 1000}s. Output:\n${out}`);

    const { pid } = JSON.parse(out.split("\n").find((l) => l.startsWith("{")) ?? "{}") as { pid?: number };
    assert.ok(pid, `the child should have reported the daemon it started. Output:\n${out}`);
    // And the daemon goes with it: `process.on("exit")` is the last resort for
    // the exits no `after` hook sees.
    for (let i = 0; i < 100 && alive(pid!); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid!), false, `the daemon (pid ${pid}) must not outlive the process that started it. Output:\n${out}`);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freePort hands out a port nothing is listening on, and a different one each time", async () => {
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set(ports).size, ports.length, "two daemons must never be sent to the same port");
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }),
      `nothing should be listening on ${port}`);
  }
});
