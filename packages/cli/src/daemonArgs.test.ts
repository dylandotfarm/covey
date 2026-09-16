import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PORT } from "@covey/protocol";
import { daemonArgs } from "./daemonArgs.js";

// Regression test for the first cause in issue #8. The CLI used to leave
// `--port` out for the default port, so a daemon on 3790 and a daemon started
// with no port showed the same command line. Every daemon then looked alike to
// `pkill -f`, and a session killed the daemon that hosted it.

test("the default port is in the command line, so two daemons never look alike", () => {
  const args = daemonArgs("/opt/covey/dist", DEFAULT_PORT);
  assert.ok(args.includes("--port"),
    `a daemon on the default port must carry --port in its command line, got: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("--port") + 1], String(DEFAULT_PORT));
});

test("a throwaway port and the default port give different command lines", () => {
  const real = daemonArgs("/opt/covey/dist", DEFAULT_PORT).join(" ");
  const throwaway = daemonArgs("/opt/covey/dist", 3808).join(" ");
  assert.notEqual(real, throwaway, "one pattern must not be able to match both daemons");
  // The pattern from the incident report. It still matches both, because both
  // run the same program — which is why `covey stop --port N` exists. What the
  // port buys is that `ps` tells them apart, and a narrower pattern can too.
  assert.ok(throwaway.includes("--port 3808"));
  assert.ok(!throwaway.includes(`--port ${DEFAULT_PORT}`),
    "a pattern ending in the throwaway port must not reach the default port");
});

test("the arguments name the built entry point, in order", () => {
  assert.deepEqual(daemonArgs("/opt/covey/dist", 3808),
    ["/opt/covey/dist/index.js", "daemon", "--port", "3808"]);
});
