/**
 * The Node version guard has to run before the module graph loads.
 *
 * Node loads an ES module graph in two steps: it resolves and instantiates
 * every module, then it evaluates the bodies. `node:sqlite` is a Node 22
 * builtin, so on an older Node the first step fails and no guard in the graph
 * ever speaks. A static import in the entry brings the failure back, and the
 * break is invisible on a new Node, where every module resolves.
 *
 * So these tests make the same failure on any Node: a `main.js` that imports a
 * builtin module which does not exist. The loader fails on it in the resolve
 * step, exactly as it fails on `node:sqlite` under Node 18. A `--import`
 * module reports an old `process.version`, because `process.versions.node` is
 * read only — which is why the entry reads `process.version`.
 *
 * The last test is the issue's own reproduction, against a real old Node. It
 * needs a build and a second Node on the machine, so it says why it skips.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const entrySource = join(here, "..", "src", "index.ts");
const builtEntry = join(here, "..", "dist", "index.js");
const launcher = join(repo, "bin", "covey");

const OLD = "v18.19.1";
const MESSAGE = new RegExp(`covey needs Node 22 or newer; this is v\\d`);
/** What the loader says when it cannot resolve a builtin — the failure under test. */
const RESOLVE_FAILURE = /ERR_UNKNOWN_BUILTIN_MODULE/;
const STARTED = /STARTED-THE-PROGRAM/;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A copy of the real entry, beside a `main.js` the loader cannot resolve. The
 * entry holds no types on purpose, so the source runs as plain JavaScript.
 */
function stagedEntry(): { dir: string; entry: string } {
  const dir = tempDir("covey-entry-");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(dir, "main.js"), 'import "node:covey-no-such-builtin";\n');
  const entry = join(dir, "index.js");
  writeFileSync(entry, readFileSync(entrySource, "utf8"));
  return { dir, entry };
}

/** A `--import` module that makes the run report Node 18. */
function versionSpoof(dir: string): string {
  const file = join(dir, "old-node.mjs");
  writeFileSync(file, `Object.defineProperty(process, "version", { value: "${OLD}" });\n`);
  return pathToFileURL(file).href;
}

const show = (r: { stdout: string; stderr: string; status: number | null }) =>
  `exit ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

// Defect 1: the guard lived in the module graph, so the loader failed first.
test("the entry tests the version before it loads the program", () => {
  const { dir, entry } = stagedEntry();
  const r = spawnSync(process.execPath, ["--import", versionSpoof(dir), entry, "info"], { encoding: "utf8" });
  assert.doesNotMatch(r.stderr, RESOLVE_FAILURE,
    `the loader failed before the guard ran: the entry loads the program graph statically, so an old Node gets a raw trace.\n${show(r)}`);
  assert.match(r.stderr, MESSAGE, `the entry printed no version message.\n${show(r)}`);
  assert.equal(r.status, 1, `the entry did not stop on an old Node.\n${show(r)}`);
});

test("the staged program really does fail to resolve, so the test above means something", () => {
  const { entry } = stagedEntry();
  const r = spawnSync(process.execPath, [entry, "info"], { encoding: "utf8" });
  assert.match(r.stderr, RESOLVE_FAILURE,
    `the fixture no longer reproduces an unresolvable builtin, so the guard test proves nothing.\n${show(r)}`);
  assert.notEqual(r.status, 0);
});

test("the entry holds no static import", () => {
  const code = readFileSync(entrySource, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\s[^(]/m,
    "a static import in the entry loads the whole graph before the guard runs — use import() instead");
  assert.match(code, /import\(["']\.\/main\.js["']\)/, "the entry no longer starts the program");
});

// Defect 2: `bin/covey` made no version test, so it ran node whatever it was.
test("bin/covey tests the version before it starts node", () => {
  const dir = tempDir("covey-fake-node-");
  const fake = join(dir, "node");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo ${OLD}; exit 0; fi\necho STARTED-THE-PROGRAM\n`);
  chmodSync(fake, 0o755);
  const r = spawnSync("/bin/sh", [launcher, "info"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
  assert.doesNotMatch(r.stdout, STARTED,
    `bin/covey started an old node: it makes no version test, so the user gets the loader's trace.\n${show(r)}`);
  assert.match(r.stderr, MESSAGE, `bin/covey printed no version message.\n${show(r)}`);
  assert.equal(r.status, 1, `bin/covey did not stop on an old node.\n${show(r)}`);
});

test("bin/covey and the entry ask for the same Node", () => {
  const fromShell = /^min_major=(\d+)$/m.exec(readFileSync(launcher, "utf8"))?.[1];
  const fromEntry = /^const MIN_MAJOR = (\d+);$/m.exec(readFileSync(entrySource, "utf8"))?.[1];
  assert.ok(fromShell, "bin/covey no longer sets min_major");
  assert.equal(fromEntry, fromShell, "the two version tests disagree");
});

/** A node on this machine older than covey needs, if there is one. */
function oldNode(): string | null {
  const candidates = [process.env.COVEY_OLD_NODE, "/usr/bin/node", "/bin/node", "/usr/local/bin/node"];
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    const v = spawnSync(c, ["-v"], { encoding: "utf8" });
    if (v.status === 0 && Number(v.stdout.trim().slice(1).split(".")[0]) < 22) return c;
  }
  return null;
}

const old = oldNode();
const skip = !existsSync(builtEntry) ? "no build: run pnpm run build"
  : !old ? "no Node older than 22 on this machine (set COVEY_OLD_NODE)"
  : false;

// The issue's own reproduction, where the machine can run it.
test("the built CLI reports the version on a real old Node", { skip }, () => {
  const r = spawnSync(old!, [builtEntry, "info"], { encoding: "utf8" });
  assert.doesNotMatch(r.stderr, RESOLVE_FAILURE, `a real old Node still gets the loader's trace.\n${show(r)}`);
  assert.match(r.stderr, MESSAGE, `a real old Node got no version message.\n${show(r)}`);
  assert.equal(r.status, 1, `the CLI did not stop on a real old Node.\n${show(r)}`);
});
