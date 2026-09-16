/**
 * Regression test for the root `typecheck` script (found while fixing issue
 * #17, fixed in the same pull request).
 *
 * The script was `tsc -b --noEmit`. Build mode and `--noEmit` do not go
 * together when the projects are composite: a project reference is only
 * type-checked through the `.d.ts` files it emits, so tsc refuses with TS6310
 * and stops. It never reported a type error in this repo's own code, in either
 * of the two states a checkout is in — nothing built, or built and then edited.
 * One test for each state, because they look nothing alike from the outside.
 *
 * Both run the flags the root script actually carries, against a throwaway
 * two-project graph, so they say what tsc does rather than what the script
 * says. This package owns them because the CLI is what rebuilds the checkout,
 * and the root scripts are that build's front door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

/** The flags the root `typecheck` script hands to tsc, as it is written today. */
function typecheckFlags(): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.typecheck ?? "";
  const words = script.trim().split(/\s+/);
  assert.equal(words[0], "tsc", `the typecheck script is no longer a plain tsc call (${script}) — teach this test how to run it`);
  return words.slice(1);
}

/**
 * Two composite projects, one referencing the other: the smallest tree with
 * the shape this repo has. Nothing is built in it, which is the state a fresh
 * clone is in. It borrows only the ES5 library, so it costs seconds rather
 * than the tens of seconds the real graph does.
 */
function graph(body = "export const b = 2;\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "covey-typecheck-"));
  mkdirSync(join(dir, "a", "src"), { recursive: true });
  mkdirSync(join(dir, "b", "src"), { recursive: true });
  const project = (refs: string[]) => JSON.stringify({
    compilerOptions: { composite: true, declaration: true, rootDir: "src", outDir: "dist", strict: true, lib: ["ES5"], types: [] },
    include: ["src"],
    ...(refs.length > 0 ? { references: refs.map((path) => ({ path })) } : {}),
  });
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "a" }, { path: "b" }] }));
  writeFileSync(join(dir, "a", "tsconfig.json"), project([]));
  writeFileSync(join(dir, "b", "tsconfig.json"), project(["../a"]));
  writeFileSync(join(dir, "a", "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b", "src", "index.ts"), body);
  return dir;
}

function run(dir: string, flags: string[]): { status: number | null; out: string } {
  const r = spawnSync(tsc, [...flags, dir], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("the typecheck script runs at all on a checkout with nothing built", () => {
  const dir = graph();
  try {
    const r = run(dir, typecheckFlags());
    assert.equal(
      r.status, 0,
      "the typecheck script cannot run against composite project references, so it checks nothing " +
      `on a fresh clone or in CI. tsc said:\n${r.out}`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the typecheck script reports a type error on a checkout that is already built", () => {
  const dir = graph();
  try {
    const built = run(dir, ["-b"]);
    assert.equal(built.status, 0, `the throwaway graph does not build: ${built.out}`);
    // Now break it, the way an edit breaks a checkout that was building a
    // moment ago. This error has to reach whoever runs the gate.
    writeFileSync(join(dir, "b", "src", "index.ts"), 'export const b: number = "not a number";\n');
    const r = run(dir, typecheckFlags());
    assert.match(
      r.out, /TS2322|not assignable/,
      "the typecheck script did not name the type error in the tree. It said this instead:\n" +
      (r.out || `(nothing at all — it exited ${r.status} and checked nothing)`),
    );
    assert.notEqual(r.status, 0, "and it has to fail the gate, not just print");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
