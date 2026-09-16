/**
 * What covey does with `NODE_ENV`, and what it undoes.
 *
 * `index.ts` sets `NODE_ENV=production` before it imports anything, for React
 * alone: React picks its development or its production copy when its module
 * body runs, and the development reconciler calls `performance.measure()` once
 * per commit — entries node keeps for the life of the process. That grew the
 * client to 4.2 GB in a working day (issue #61).
 *
 * Nothing else covey runs wants it. The daemon paints no React, and a value
 * covey invented reaches the Claude sessions the daemon spawns and every
 * command those sessions run — `npm install` under `NODE_ENV=production`
 * installs without the devDependencies, and says nothing. So covey keeps the
 * setting for the process that paints the TUI, and for as long as it paints,
 * and hands it back everywhere else.
 *
 * `index.ts` passes the flag through the environment because nothing else
 * crosses a dynamic import. This module takes it away as it loads, which is
 * before `main.ts` runs a command, so no child ever sees it.
 */

/** True when `index.ts` invented `NODE_ENV`, rather than the user asking for one. */
export const coveySetNodeEnv = process.env.COVEY_SET_NODE_ENV === "1";
delete process.env.COVEY_SET_NODE_ENV;

/** Give `NODE_ENV` back, once React has no further use for it. Idempotent. */
export function releaseNodeEnv(): void {
  if (coveySetNodeEnv) delete process.env.NODE_ENV;
}

/** The environment for a process covey starts: never covey's own `NODE_ENV`. */
export function childEnv(): NodeJS.ProcessEnv {
  if (!coveySetNodeEnv) return process.env;
  const { NODE_ENV: _covey, ...rest } = process.env;
  return rest;
}
