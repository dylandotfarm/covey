/**
 * Regression test for issue #61: the client grew by about 5 KB for every event
 * it painted, reached 4.2 GB in a working day, and died with SIGABRT.
 *
 * React picks its development or its production copy from `NODE_ENV` when its
 * module body runs. The development copy of the reconciler calls
 * `performance.measure()` once per commit, and node keeps every user-timing
 * entry for the life of the process, so one entry per render is a leak with no
 * ceiling. `packages/tui/src/render.leak.test.ts` covers that mechanism.
 *
 * This is the half that holds the fix in place. The fix is one line in
 * `index.ts`, and it is the kind of line somebody moves: `main.js` imports
 * `@covey/tui`, which imports ink and React, and a module body reads `NODE_ENV`
 * once, so the line only works where it is. A test that read the source would
 * pass with the line moved below the import. This one starts the entry the way
 * a user does and asks the process which copy of React it ended up with.
 *
 * `covey info` is the cheapest command that loads the whole graph: it prints
 * this machine's daemon settings and exits, and it touches no socket.
 *
 * The setting is for React and for this process. The tests at the end are the
 * other side of that: `nodeEnv.ts` hands `NODE_ENV` back once React has read
 * it, so the daemon — and through it every Claude session and every command
 * those sessions run — is left with the environment the user has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const entry = join(repoRoot, "packages", "cli", "src", "index.ts");

/**
 * Loaded before the entry, it reports at exit which copy of React the process
 * settled on. It has to compare the exports rather than look for a file name:
 * node's CommonJS lexer loads both copies to read their export lists, so both
 * are in the require cache whatever `NODE_ENV` says. Only one of them is what
 * `require("react")` returns, and that one is the one that runs.
 */
const PROBE = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.on("exit", () => {
  const find = (s) => Object.keys(require.cache).find((k) => k.endsWith(s));
  const copy = (index, dev, prod) => {
    const taken = require.cache[find(index)]?.exports;
    if (taken === undefined) return "not loaded";
    if (taken === require.cache[find(prod)]?.exports) return "production";
    if (taken === require.cache[find(dev)]?.exports) return "development";
    return "unknown";
  };
  process.stderr.write("PROBE " + JSON.stringify({
    env: process.env.NODE_ENV ?? null,
    flag: process.env.COVEY_SET_NODE_ENV ?? null,
    react: copy("react/index.js", "cjs/react.development.js", "cjs/react.production.js"),
    reconciler: copy(
      "react-reconciler/index.js",
      "cjs/react-reconciler.development.js",
      "cjs/react-reconciler.production.js",
    ),
  }) + "\\n");
});
`;

interface Probed { env: string | null; flag: string | null; react: string; reconciler: string }

/** Run `covey info` on its own data directory and read the probe's line. */
function runClient(env: Record<string, string> = {}): Probed {
  const dir = mkdtempSync(join(tmpdir(), "covey-client-env-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, PROBE);
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", probe, entry, "info"],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: { ...process.env, COVEY_HOME: dir, COVEY_CONFIG: join(dir, "config"), ...env },
      },
    );
    const line = (r.stderr ?? "").split("\n").find((l) => l.startsWith("PROBE "));
    assert.ok(line, `the client did not start, so nothing was measured. It said:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(line.slice("PROBE ".length)) as Probed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the client runs React's production build", () => {
  const got = runClient();
  assert.equal(
    got.reconciler, "production",
    "the client loaded React's development reconciler, which calls performance.measure() on every " +
    "commit. Node keeps every user-timing entry, so the client then grows once per event it paints " +
    "and never gives it back — 22.8 MB a minute, and SIGABRT at about 4 GB (issue #61). The line that " +
    "sets NODE_ENV has to stay in packages/cli/src/index.ts, above every import",
  );
  assert.equal(got.react, "production", "and the same for React itself");
});

test("a command that paints no TUI is left with the environment the user has", () => {
  const got = runClient();
  assert.equal(
    got.env, null,
    "covey invented NODE_ENV for React and kept it. The daemon runs no React, and this value " +
    "reaches the Claude sessions it spawns and every command those sessions run — npm install " +
    "under NODE_ENV=production installs without the devDependencies, and says nothing. " +
    "nodeEnv.ts has to give it back once React has read it",
  );
  assert.equal(got.flag, null, "and the flag that carried the decision is gone too");
});

test("an environment that already names NODE_ENV is left alone", () => {
  const got = runClient({ NODE_ENV: "development" });
  assert.equal(got.env, "development", "somebody who asks for the development build gets it");
  assert.equal(got.reconciler, "development");
});
