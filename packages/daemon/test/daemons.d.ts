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
import { type ChildProcess } from "node:child_process";
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
/** A throwaway directory, with every symlink already resolved. macOS makes
 *  /var a link to /private/var, and git reports the resolved path, so a raw
 *  mkdtemp path never compares equal to the one the daemon sends back. */
export declare function tempDir(prefix: string): string;
/**
 * A port nothing is listening on, taken by binding to 0 and letting go again.
 *
 * Both suites used to pick a random number from a window twenty or fifty wide.
 * Two runs at once — which is what a gate run on a shared machine is — could
 * pick the same one, and the daemon that lost exited on EADDRINUSE while the
 * run that started it waited out its whole budget for a corpse.
 */
export declare function freePort(): Promise<number>;
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
export declare function waitForExit(proc: ChildProcess, ms: number): Promise<boolean>;
/**
 * Start a daemon on a throwaway data dir and wait for it to answer `/health`.
 *
 * With no `port`, it takes a free one — which is what a test should do unless
 * it has a reason to name the number.
 */
export declare function startDaemon(opts?: {
    port?: number;
    name?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    /** Override the start budget. Only `daemons.test.ts` passes this, to reach
     *  the failure path below in a second rather than in sixty. */
    startBudgetMs?: number;
    /** Spawn this argv instead of the daemon. Only `daemons.test.ts` passes it,
     *  to put something on the other end that will never open the port — so the
     *  budget runs out by construction, on an idle CI runner exactly as on a
     *  loaded Pi, rather than by the test being faster than the machine. */
    argv?: string[];
}): Promise<TestDaemon>;
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
export declare function stopAll(): Promise<void>;
/**
 * The last resort, for the exits no `after` hook sees: an uncaught exception, a
 * test cancelled by `--test-timeout`, Ctrl-C on a gate run. `exit` can only do
 * synchronous work, so this is SIGKILL and nothing else — the polite stop had
 * its chance in `stopAll`.
 */
export declare function reapAll(): void;
//# sourceMappingURL=daemons.d.ts.map