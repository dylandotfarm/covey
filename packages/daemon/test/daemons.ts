/**
 * Starting a daemon for a test, and — the part that decides whether a gate run
 * ends — taking it down again whatever happened in between.
 *
 * Issue #53. A run of `daemon.test.ts` on a loaded four-core Pi sat for 673
 * seconds. Nothing was waiting for anything: the inspector showed an empty
 * `process._getActiveRequests()`, no timers, and `Debugger.pause` never fired,
 * so no JS was pending. Every test had already failed and `after()` had already
 * thrown. The process could not *exit*, because two daemons it had started were
 * still alive and a child's stdio pipes are ref'd handles in its parent's event
 * loop. Killing only those two, by pid, let it exit instantly.
 *
 * So a test timeout does not cover this. Node's `--test-timeout` bounds a test
 * or a hook; it does not bound a process that lingers after the last test is
 * over. Measured with `--test-timeout=30000` against the unfixed suite: the
 * file-level entry ran for 238916ms before an outer `timeout(1)` killed it.
 * The bound has to be here, in the teardown. The rules:
 *
 *  - a daemon is registered before the first `await`, so a failure while it is
 *    still starting leaves something that knows how to stop it. `Promise.all`
 *    over two starts used to drop the handle of the one that worked when the
 *    other threw;
 *  - its stdio and its process handle are unref'd, so a daemon that escapes
 *    anyway can never again turn a failed test file into a process that never
 *    exits;
 *  - `stopAll` isolates each stop from the others. One throw skipping the rest
 *    is precisely what left five daemons listening;
 *  - `process.on("exit")` reaps whatever is left, which covers what no hook
 *    can: an uncaught exception, a test cancelled by `--test-timeout`, Ctrl-C;
 *  - every wait has a bound. A teardown that can hang is not a teardown.
 *
 * `packages/cli/test/stop.test.ts` imports this too. The daemon package owns
 * how a daemon is started and stopped, so it owns this as well.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

/**
 * How long a daemon gets to answer `/health` before we call it a failure.
 *
 * The old budget was 10s, and that budget was itself the race: sixteen boots
 * measured on this project's four-core Pi at load average 19 took 13.3s to
 * 16.1s, median 14.7s, just to get `tsx` up and the port open. Every one of
 * them would have been called a failure. A budget has to sit far enough above a
 * slow boot that a slow boot is never mistaken for a broken one — 60s is about
 * four times the slowest measured — and the margin costs nothing on a healthy
 * machine, because it is a deadline and not a delay.
 */
const START_BUDGET_MS = 60_000;

/** How long a daemon gets to die after a signal, before the next signal. */
const STOP_BUDGET_MS = 15_000;

export interface TestDaemon {
  proc: ChildProcess;
  /** Its `COVEY_HOME`. Removed by `stop`. */
  home: string;
  port: number;
  /** Everything it has written to stdout and stderr so far. */
  log(): string;
  /** Stop it and take its data dir away. Bounded, and safe to call twice. */
  stop(): Promise<void>;
}

/** Daemons this process started and has not yet stopped. */
const live = new Set<TestDaemon>();

/** A throwaway directory, with every symlink already resolved. macOS makes
 *  /var a link to /private/var, and git reports the resolved path, so a raw
 *  mkdtemp path never compares equal to the one the daemon sends back. */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * A port nothing is listening on, taken by binding to 0 and letting go again.
 *
 * Both suites used to pick a random number from a window twenty or fifty wide.
 * Two runs at once — which is what a gate run on a shared machine is — could
 * pick the same one, and the daemon that lost exited on EADDRINUSE while the
 * run that started it waited out its whole budget for a corpse.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const exited = (proc: ChildProcess) => proc.exitCode !== null || proc.signalCode !== null;

/**
 * Resolve when `proc` has exited, or when `ms` is up — never later. Returns
 * whether it actually exited.
 *
 * `exit` fires once and is not replayed, so `await new Promise((res) =>
 * proc.once("exit", res))` — which both suites used — waits for ever on a
 * process that has already gone. That is the shape of hang a port collision
 * produces: the daemon dies at birth on EADDRINUSE, and the test then waits to
 * be told about an exit it already missed.
 */
export function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (exited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (value: boolean) => { clearTimeout(timer); proc.off("exit", onExit); resolve(value); };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(exited(proc)), ms);
    proc.once("exit", onExit);
  });
}

/**
 * Start a daemon on a throwaway data dir and wait for it to answer `/health`.
 *
 * With no `port`, it takes a free one — which is what a test should do unless
 * it has a reason to name the number.
 */
export async function startDaemon(opts: {
  port?: number;
  name?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the start budget. Only `daemons.test.ts` passes this, to put a
   *  daemon in the position the original 10s budget put every daemon in: still
   *  booting when its budget ran out. */
  startBudgetMs?: number;
} = {}): Promise<TestDaemon> {
  const port = opts.port ?? (await freePort());
  const home = opts.home ?? tempDir("covey-test-");
  const args = ["--import", "tsx", daemonEntry, "--bind", "loopback", "--port", String(port)];
  if (opts.name) args.push("--name", opts.name);

  const proc = spawn(process.execPath, args, {
    env: { ...process.env, COVEY_HOME: home, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on("data", (d: Buffer) => { log += d.toString(); });
    // Data still arrives while the loop is alive; it just stops being a reason
    // for the loop to be alive. Without this a daemon we lose hold of keeps the
    // whole test file's process up for ever — issue #53's 673 seconds. A piped
    // stdio stream is a Socket, which the Readable the types promise is not.
    (stream as Socket | null)?.unref();
  }
  proc.unref();

  const daemon: TestDaemon = { proc, home, port, log: () => log, stop: () => stopDaemon(daemon) };
  // Registered before the first await, so everything below can throw freely.
  live.add(daemon);

  const budget = opts.startBudgetMs ?? START_BUDGET_MS;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    // A daemon that has already exited is never going to answer. Say so now
    // rather than spending the rest of the budget asking a dead port.
    if (exited(proc)) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok) return daemon;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const how = exited(proc) ? `it exited (code=${proc.exitCode} signal=${proc.signalCode})` : `it never answered in ${budget / 1000}s`;
  // A daemon that would not start must not also be left behind — the old code
  // threw here and walked away from the process it had spawned. Trouble
  // stopping it is not the news; why it would not start is.
  await daemon.stop().catch((e) => console.error(`covey test teardown: ${e}`));
  // The pid is in the message because it is the only handle on that process a
  // caller has left: the start never returned one.
  throw new Error(`daemon${opts.name ? ` "${opts.name}"` : ""} on port ${port} (pid ${proc.pid}) did not start: ${how}\n${log}`);
}

/**
 * Stop one daemon and take its data dir away.
 *
 * It signals the child handle rather than shelling out to `covey stop --port
 * N`. The handle is the same kind of name a port is — it points at exactly one
 * process and can never be confused with another daemon running the same
 * program — and it costs no second node boot, which on this project's Pi is
 * about eight seconds per daemon in a teardown that has to be quick and must
 * not be able to hang.
 */
async function stopDaemon(daemon: TestDaemon): Promise<void> {
  live.delete(daemon);
  try {
    if (!exited(daemon.proc)) {
      daemon.proc.kill("SIGTERM");
      if (!(await waitForExit(daemon.proc, STOP_BUDGET_MS))) {
        daemon.proc.kill("SIGKILL");
        await waitForExit(daemon.proc, STOP_BUDGET_MS);
      }
    }
  } finally {
    rmSync(daemon.home, { recursive: true, force: true });
  }
}

/**
 * Stop every daemon this process started.
 *
 * Each stop is isolated from the others. `after()` used to run its teardown as
 * one sequence, so the first throw — `a.close()` on a client whose `before()`
 * never got as far as connecting — skipped every `kill` and every `rmSync`
 * behind it, and that is why nothing came down.
 *
 * It reports a daemon that would not stop but does not throw: a teardown that
 * fails the file is a teardown that hides the failure the file was reporting.
 */
export async function stopAll(): Promise<void> {
  const results = await Promise.allSettled([...live].map((d) => d.stop()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  for (const f of failed) console.error(`covey test teardown: a daemon would not stop — ${f.reason}`);
}

/**
 * The last resort, for the exits no `after` hook sees: an uncaught exception, a
 * test cancelled by `--test-timeout`, Ctrl-C on a gate run. `exit` can only do
 * synchronous work, so this is SIGKILL and nothing else — the polite stop had
 * its chance in `stopAll`.
 */
export function reapAll(): void {
  for (const daemon of live) {
    try { daemon.proc.kill("SIGKILL"); } catch { /* already gone */ }
    try { rmSync(daemon.home, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  live.clear();
}

process.on("exit", reapAll);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // Without this, Ctrl-C on a gate run leaves every daemon it had started.
  process.once(signal, () => { reapAll(); process.exit(signal === "SIGINT" ? 130 : 143); });
}
