#!/usr/bin/env node
/**
 * The entry point. It holds no static import, and it has to stay that way.
 *
 * Node loads an ES module graph in two steps: it resolves and instantiates
 * every module in the graph, then it evaluates the module bodies in source
 * order. `node:sqlite` is a Node 22 builtin, and `@covey/daemon` imports it, so
 * an older Node stops in the first step — before a guard anywhere in the graph
 * can print anything. The user gets ERR_UNKNOWN_BUILTIN_MODULE.
 *
 * A dynamic import starts its graph only when this file calls it, so the test
 * below is the first thing the program does. `bin/covey` makes the same test in
 * shell, for a start that stops before node.
 */
const MIN_MAJOR = 22;
if (Number(process.version.slice(1).split(".")[0]) < MIN_MAJOR) {
  console.error(`covey needs Node ${MIN_MAJOR} or newer; this is ${process.version}.`);
  process.exit(1);
}
/**
 * Run the shipped build as a shipped build. React picks its development or its
 * production copy from `NODE_ENV` when the module body runs, and the
 * development copy of the reconciler calls `performance.measure()` for every
 * commit it makes — one entry per render, each carrying a detail object with
 * the props it compared. Node keeps every user-timing entry for the life of the
 * process, so the client grew by about 5 KB per event it painted and reached
 * 4.2 GB in a working day (issue #61).
 *
 * It belongs in this file because this file has no static import. `main.js`
 * imports `@covey/tui`, which imports ink and React, and a module body reads
 * `NODE_ENV` once. Node evaluates every static import before the first
 * statement here, so one static import added to this file undoes the line,
 * wherever the line sits. `clientEnv.test.ts` is what says so.
 *
 * The setting is for this process only. `nodeEnv.ts` gives it back everywhere
 * React is not the one reading it — the daemon, and every child covey starts —
 * and says there why. The flag travels in the environment because nothing else
 * crosses a dynamic import; `nodeEnv.ts` takes it away as it loads.
 */
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = "production";
  process.env.COVEY_SET_NODE_ENV = "1";
}
// No top-level await: it needs Node 14.8, and the message above is worth more
// than the two lines it saves.
import("./main.js").catch((e) => { console.error(e); process.exit(1); });
