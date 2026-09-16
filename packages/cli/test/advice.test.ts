/**
 * Regression test for the advice in issue #8.
 *
 * The CLI used to print the defect as a suggestion. `restartLocalDaemon` told
 * the user to run `pkill -f 'covey.*daemon'`. In a checkout under a path that
 * contains the program name, that pattern matches every daemon on the machine,
 * not the one the user means. A session followed advice of that shape and
 * killed the daemon that hosted it.
 *
 * The rule this guards: covey may tell a person to stop one process, never to
 * match a set of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

/**
 * The lines of the CLI that can reach a terminal. The comments that explain
 * the defect name `pkill` on purpose, so they are not offenders.
 */
function printableLines(): string[] {
  return readFileSync(cliSrc, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

test("the CLI never tells anyone to kill daemons by pattern", () => {
  const offenders = printableLines().filter((l) => /\b(pkill|killall)\b/.test(l));
  assert.deepEqual(offenders, [],
    "covey must not suggest pkill or killall: a pattern matches every daemon on the machine, " +
    `including the one hosting the session. Found:\n${offenders.join("\n")}`);
});

test("the advice that replaced it names one process", () => {
  const src = readFileSync(cliSrc, "utf8");
  assert.match(src, /kill \$\(lsof -ti :\$\{port\}\)/,
    "the fallback advice should resolve the port to one pid before it kills anything");
  assert.match(src, /covey stop/, "the CLI should offer `covey stop` as the safe way out");
});
