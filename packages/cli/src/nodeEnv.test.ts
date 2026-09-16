/**
 * The other half of `clientEnv.test.ts`. That one starts the whole client and
 * asks which copy of React it loaded. This one is about what covey hands to the
 * processes it starts.
 *
 * `index.ts` invents `NODE_ENV=production` for React (issue #61). The daemon
 * paints no React, and that value reaches the Claude sessions the daemon spawns
 * and every command those sessions run — `npm install` under
 * `NODE_ENV=production` installs without the devDependencies, and says nothing.
 * So `childEnv()` drops it, and only it: a `NODE_ENV` the user set is theirs,
 * and a child gets it.
 *
 * The module decides as it loads, from a flag the entry leaves in the
 * environment, so each case needs its own process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const module = join(dirname(fileURLToPath(import.meta.url)), "nodeEnv.ts");

interface Probed { child: string | null; own: string | null; flag: string | null }

/** Load the module in a fresh process and report what it decided. */
function probe(env: Record<string, string>): Probed {
  const dir = mkdtempSync(join(tmpdir(), "covey-node-env-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, `
    import { childEnv, releaseNodeEnv } from ${JSON.stringify(module)};
    const child = childEnv().NODE_ENV ?? null;
    releaseNodeEnv();
    process.stdout.write(JSON.stringify({
      child, own: process.env.NODE_ENV ?? null, flag: process.env.COVEY_SET_NODE_ENV ?? null,
    }));
  `);
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", file], {
      encoding: "utf8", env: { ...process.env, NODE_ENV: undefined, COVEY_SET_NODE_ENV: undefined, ...env },
    });
    assert.ok(r.stdout, `the probe printed nothing. It said:\n${r.stderr}`);
    return JSON.parse(r.stdout) as Probed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a child covey starts never inherits the NODE_ENV covey invented", () => {
  const got = probe({ NODE_ENV: "production", COVEY_SET_NODE_ENV: "1" });
  assert.equal(
    got.child, null,
    "the daemon covey spawns would run with covey's NODE_ENV, and so would every Claude session " +
    "on that daemon and every command those sessions run (issue #61)",
  );
  assert.equal(got.own, null, "and releaseNodeEnv() gives this process its environment back");
});

test("a NODE_ENV the user set is theirs, and a child gets it", () => {
  const got = probe({ NODE_ENV: "development" });
  assert.equal(got.child, "development", "covey did not set this one, so it is not covey's to drop");
  assert.equal(got.own, "development", "and it stays where the user put it");
});

test("the flag the entry left behind never reaches a child", () => {
  assert.equal(probe({ NODE_ENV: "production", COVEY_SET_NODE_ENV: "1" }).flag, null);
  assert.equal(probe({ NODE_ENV: "development" }).flag, null);
});
