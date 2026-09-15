#!/usr/bin/env node
/**
 * Dependency age policy: every package in pnpm-lock.yaml must have been
 * published at least MIN_DAYS ago. pnpm enforces this at resolution time via
 * `minimumReleaseAge` in pnpm-workspace.yaml; this script is the independent
 * check CI runs against whatever lockfile was committed.
 *
 *   node scripts/pkg-age.mjs check   [--days 7]   audit the lockfile (exit 1 on violation)
 *   node scripts/pkg-age.mjs cutoff  [--days 7]   print the ISO cutoff date
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0] ?? "check";
const days = Number(args[args.indexOf("--days") + 1] || 0) || Number(process.env.COVEY_PKG_MIN_DAYS || 7);
const cutoff = new Date(Date.now() - days * 86_400_000);

if (mode === "cutoff") { console.log(cutoff.toISOString()); process.exit(0); }

// Minimal pnpm-lock.yaml (v9) reader: entries under `packages:` look like
//   '@scope/name@1.2.3':   or   name@1.2.3(peer@x):
// There can be several `packages:` sections (pnpm 12 records its own binary
// under packageManagerDependencies), so read all of them.
const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const sections = lock.split(/^packages:\s*$/m).slice(1).map((part) => part.split(/^\S/m)[0] ?? "");
const wanted = new Map(); // name → Set(version)
for (const line of sections.join("\n").split("\n")) {
  const m = line.match(/^  '?([^'\s:]+?)'?:\s*$/);
  if (!m) continue;
  const key = m[1].replace(/\(.*$/, "");
  const at = key.lastIndexOf("@");
  if (at <= 0) continue;
  const name = key.slice(0, at), version = key.slice(at + 1);
  if (!/^\d/.test(version)) continue;
  if (!wanted.has(name)) wanted.set(name, new Set());
  wanted.get(name).add(version);
}
if (wanted.size === 0) { console.error("✖ no packages found in pnpm-lock.yaml"); process.exit(1); }

const registry = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";
const names = [...wanted.keys()];
const violations = [];
let checked = 0;
async function worker() {
  while (names.length) {
    const name = names.shift();
    const res = await fetch(`${registry}/${name.replace("/", "%2F")}`, { headers: { accept: "application/json" } });
    if (!res.ok) { violations.push(`${name}: registry lookup failed (${res.status})`); continue; }
    const doc = await res.json();
    for (const version of wanted.get(name)) {
      checked++;
      const t = doc.time?.[version];
      if (!t) { violations.push(`${name}@${version}: no publish time in registry metadata`); continue; }
      const published = new Date(t);
      if (published > cutoff) {
        const age = ((Date.now() - published.getTime()) / 86_400_000).toFixed(1);
        violations.push(`${name}@${version}: published ${age} days ago (${t})`);
      }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

if (violations.length) {
  console.error(`✖ ${violations.length} package version(s) younger than ${days} days (cutoff ${cutoff.toISOString()}):`);
  for (const v of violations) console.error("  " + v);
  console.error(`\npnpm should have refused these (minimumReleaseAge in pnpm-workspace.yaml). Re-run: pnpm run deps:refresh`);
  process.exit(1);
}
console.log(`✔ ${checked} locked package versions are all ≥ ${days} days old (cutoff ${cutoff.toISOString().slice(0, 10)})`);
