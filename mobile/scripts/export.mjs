/**
 * Build the bundle the daemon serves over the air (issue #168).
 *
 * `expo export` writes the bundle, its assets and `metadata.json`. It does not
 * write the runtime version, and the runtime version is the whole safety of an
 * over-the-air update: it is what stops a bundle built against one set of
 * native modules from launching inside an app built against another. So this
 * script resolves it the way the app's own configuration says to, and writes it
 * beside the bundle as `covey-update.json`, which is what
 * `packages/daemon/src/updates.ts` reads.
 *
 * Run it in `mobile/`, after `pnpm run build` in the checkout above — the
 * bundle inlines `@covey/client`, `@covey/protocol` and `@covey/web` from their
 * `dist`, so a stale build there is a stale app here.
 *
 *   pnpm run export
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(app, "dist");

const run = (args) => execFileSync("npx", args, { cwd: app, stdio: ["ignore", "pipe", "inherit"] }).toString();

/**
 * The runtime version this export is for.
 *
 * `expo config` hands back the *policy* rather than the value, so the policy is
 * resolved here. Only `appVersion` is supported, and an unknown policy stops
 * the export: a guess here is a bundle that lands in an app that cannot run it,
 * and the failure would show up on the phone as a crash on launch rather than
 * as an error on the machine that built it.
 */
function runtimeVersion(config) {
  const rv = config.runtimeVersion;
  if (typeof rv === "string") return rv;
  if (rv?.policy === "appVersion") {
    if (!config.version) throw new Error("the app config sets no `version`, so the `appVersion` policy resolves to nothing");
    return config.version;
  }
  throw new Error(`unsupported runtimeVersion policy ${JSON.stringify(rv)}: covey's update route matches on an exact runtime version`);
}

console.log("reading the app config…");
const config = JSON.parse(run(["expo", "config", "--type", "public", "--json"]));
const version = runtimeVersion(config);

console.log(`exporting the android bundle for runtime ${version}…`);
process.stdout.write(run(["expo", "export", "--platform", "android"]));

mkdirSync(dist, { recursive: true });
const stamp = { runtimeVersion: version, createdAt: new Date().toISOString() };
writeFileSync(join(dist, "covey-update.json"), `${JSON.stringify(stamp, null, 2)}\n`);

console.log(`wrote ${join("dist", "covey-update.json")}: runtime ${version}, created ${stamp.createdAt}`);
console.log("the daemon on this machine now serves this bundle at /updates.");
