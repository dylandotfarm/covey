#!/usr/bin/env node
/**
 * Dependency age policy for the Rust client, beside `pkg-age.mjs` for npm.
 *
 * Every crate version in `desktop/Cargo.lock` must have been published at least
 * MIN_DAYS ago. The rule is the same as the npm one and the reason is the same:
 * a supply-chain attack is caught within days of publication, so a week of
 * distance is most of the protection for none of the cost.
 *
 * Cargo enforces this at resolution with `registry.global-min-publish-age` and
 * `resolver.incompatible-publish-age`, set in `desktop/.cargo/config.toml` —
 * but that pair only became stable in Rust 1.100. Until the toolchain everybody
 * runs is that new, cargo prints "ignoring ... without -Zmin-publish-age" and
 * resolves whatever it likes. So on today's stable this script is not a double
 * check; it is the only check. Treat it that way.
 *
 *   node scripts/crate-age.mjs check    [--days 7]  audit desktop/Cargo.lock
 *   node scripts/crate-age.mjs refresh             re-read publish dates, rewrite the cache
 *   node scripts/crate-age.mjs pin      [--days 7] print the `cargo update` lines that fix it
 *   node scripts/crate-age.mjs cutoff   [--days 7] print the ISO cutoff date
 *
 * `check` fails closed: a crate it could not read counts as a violation, never
 * as a pass.
 */
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The crates the age rule does not cover, and why.
 *
 * Empty, and it should stay that way. The npm list has one entry with an
 * argument behind it (the Agent SDK carries the Claude Code every session
 * runs). Nothing in the Rust client is on that footing: it is a window, and a
 * window can wait a week. A waiver is never silent — every run prints what it
 * let through and how young it was.
 */
const EXEMPT = new Set([]);

/** The only source this repo accepts a crate from. */
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

/** crates.io asks every client to say who it is and how to reach them. */
const USER_AGENT = "covey dependency-age check (https://github.com/dylandotfarm/covey)";

/**
 * Publish dates this repo has already looked up, `name@version` to ISO date.
 *
 * When a version was published never changes, so this is a cache that cannot go
 * stale — and it is why a normal CI run makes no network requests at all.
 * Asking crates.io for four hundred versions on every push met its rate limit
 * and turned clean crates into "lookup failed" violations, which is a red build
 * with nothing wrong behind it.
 *
 * It is committed, so a reviewer sees new crates and their publish dates in the
 * diff beside the lockfile change that brought them in. `refresh` rewrites it.
 * A version missing from it is looked up and, if that fails, is a violation —
 * a stale cache slows the check down; it never weakens it.
 */
const CACHE = new URL("../desktop/crate-publish-times.json", import.meta.url);

/** How many requests are in flight at once. crates.io's limit is close. */
const CONCURRENCY = 3;

const args = process.argv.slice(2);
const mode = args[0] ?? "check";
const days =
  Number(args[args.indexOf("--days") + 1] || 0) || Number(process.env.COVEY_CRATE_MIN_DAYS || 7);
const cutoff = new Date(Date.now() - days * 86_400_000);

if (mode === "cutoff") {
  console.log(cutoff.toISOString());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The lockfile
// ---------------------------------------------------------------------------

/**
 * Read `[[package]]` blocks out of Cargo.lock.
 *
 * A small reader rather than a TOML library, for the same reason `pkg-age.mjs`
 * reads pnpm-lock.yaml by hand: this script has to run before anybody trusts
 * `node_modules`, so it may not depend on it.
 */
const lock = readFileSync(new URL("../desktop/Cargo.lock", import.meta.url), "utf8");
const wanted = new Map(); // name -> Set(version)
const violations = [];
let local = 0;
for (const block of lock.split("[[package]]").slice(1)) {
  const name = /^name = "(.+?)"$/m.exec(block)?.[1];
  const version = /^version = "(.+?)"$/m.exec(block)?.[1];
  const source = /^source = "(.+?)"$/m.exec(block)?.[1];
  if (!name || !version) continue;
  // No source is a path dependency: one of covey's own crates, which is not a
  // supply-chain question.
  if (!source) {
    local++;
    continue;
  }
  // A crate from anywhere else has not been audited by anything here. That is
  // exactly what this check exists to catch, so it fails rather than passes.
  if (source !== CRATES_IO) {
    violations.push(`${name}@${version}: from ${source}, which this policy does not audit`);
    continue;
  }
  if (!wanted.has(name)) wanted.set(name, new Set());
  wanted.get(name).add(version);
}
if (wanted.size === 0) {
  console.error("✖ no crates.io packages found in desktop/Cargo.lock");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Talking to crates.io
// ---------------------------------------------------------------------------

/**
 * When every worker may talk to crates.io again.
 *
 * A 429 means "you, the address, are going too fast" — so one worker backing
 * off while the others keep hammering is no back-off at all. This is shared,
 * and the retry loop waits on it before each attempt.
 */
let coolDownUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One crates.io document, asked for up to five times.
 *
 * A 429 is the answer that matters most here: read as a failure it fails the
 * build for no reason, and read as "no data" it would quietly pass a crate that
 * was never checked. So it is retried with the shared back-off above, it
 * honours `Retry-After`, and if it never succeeds the caller is told the lookup
 * failed rather than told an answer. The check fails closed, so it has to try
 * hard enough that only a real outage trips it.
 *
 * A dropped connection or a 5xx is a fault of the network and not of the
 * lockfile, and is retried the same way. A 404 is an answer, and comes back at
 * once.
 */
async function fetchJson(url) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = coolDownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      if (res.ok) return { ok: true, doc: await res.json() };
      if (res.status !== 429 && res.status < 500) return { ok: false, status: res.status };
      last = new Error(`crates.io answered ${res.status}`);
      const after = Number(res.headers.get("retry-after"));
      const back = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt;
      coolDownUntil = Math.max(coolDownUntil, Date.now() + Math.min(back, 60_000));
    } catch (e) {
      last = e;
      await sleep(1000 * attempt);
    }
  }
  return { ok: false, error: last };
}

/** Run `job` over `items`, a few at a time. */
async function pool(items, job) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await job(queue.shift());
    }),
  );
}

// ---------------------------------------------------------------------------
// Dating every locked version
// ---------------------------------------------------------------------------

/** Exempt versions younger than the cutoff. Reported, never fatal. */
const waived = [];
/** `name@version` -> ISO publish date, from the cache and from the network. */
const dates = new Map();
let fromCache = 0;

try {
  for (const [key, when] of Object.entries(JSON.parse(readFileSync(CACHE, "utf8")))) {
    dates.set(key, when);
  }
} catch {
  // No cache yet, or one this script cannot read. Everything is looked up.
}

async function dateVersion(name, version) {
  const got = await fetchJson(
    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (!got.ok) {
    // Never assume old enough. A crate this script could not read is a crate
    // nothing checked, and that is the whole thing it exists to stop.
    violations.push(
      `${name}@${version}: crates.io lookup failed (${got.error?.message ?? `status ${got.status}`})`,
    );
    return;
  }
  const created = got.doc.version?.created_at;
  if (!created) {
    violations.push(`${name}@${version}: no publish time in crates.io metadata`);
    return;
  }
  dates.set(`${name}@${version}`, created);
}

const locked = [];
for (const [name, versions] of wanted) for (const v of versions) locked.push([name, v]);
const total = locked.length;

// Only what the cache does not already hold. On a push that did not touch the
// lockfile that is nothing at all, and the check never leaves the machine.
const missing = locked.filter(([name, v]) => {
  if (dates.has(`${name}@${v}`)) {
    fromCache++;
    return false;
  }
  return true;
});
if (missing.length) await pool(missing, ([name, version]) => dateVersion(name, version));

if (mode === "refresh") {
  const next = {};
  for (const [name, v] of locked.sort((a, b) => a[0].localeCompare(b[0]) || cmpVersion(a[1], b[1]))) {
    const key = `${name}@${v}`;
    // Entries for versions the lockfile no longer holds are dropped, so the
    // file stays the size of the tree rather than the size of its history.
    if (dates.has(key)) next[key] = dates.get(key);
  }
  const unknown = locked.length - Object.keys(next).length;
  writeFileSync(CACHE, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `✔ wrote ${Object.keys(next).length} publish dates to desktop/crate-publish-times.json` +
      (unknown ? `; ${unknown} could not be read and were left out` : ""),
  );
  process.exit(unknown ? 1 : 0);
}

// The age rule itself, over everything the lockfile holds.
for (const [name, v] of locked) {
  const when = dates.get(`${name}@${v}`);
  if (!when) continue; // already a violation, recorded by `dateVersion`
  const published = new Date(when);
  if (published > cutoff) {
    const age = ((Date.now() - published.getTime()) / 86_400_000).toFixed(1);
    const line = `${name}@${v}: published ${age} days ago (${when})`;
    if (EXEMPT.has(name)) waived.push(line);
    else violations.push(line);
  }
}

// ---------------------------------------------------------------------------
// `pin`: the lines that move a young lockfile back
// ---------------------------------------------------------------------------

/** The part of a version cargo treats as the compatibility series: the major,
 *  or the major and the minor below 1.0, or all three below 0.1. */
function compatSeries(v) {
  const [maj = "0", min = "0", pat = "0"] = v.split("-")[0].split(".");
  if (maj !== "0") return maj;
  if (min !== "0") return `0.${min}`;
  return `0.0.${pat}`;
}

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The newest version of `name` that is old enough and compatible with
 * `version`.
 *
 * Compatible by cargo's own rule, not by "newest that is old enough": a
 * different major (or, below 1.0, a different minor) is a different package as
 * far as the resolver is concerned, so offering one would print a line that
 * cannot be run. Prereleases are skipped, and so are yanked versions.
 *
 * Answers `{ error }` when crates.io could not be asked, which the caller must
 * not confuse with "there is nothing old enough".
 */
async function newestCompliant(name, version) {
  const got = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (!got.ok) return { error: got.error?.message ?? `crates.io answered ${got.status}` };
  const series = compatSeries(version);
  const ok = (got.doc.versions ?? [])
    .filter((v) => !v.yanked && !v.num.includes("-"))
    .filter((v) => compatSeries(v.num) === series)
    .filter((v) => new Date(v.created_at) <= cutoff)
    .sort((a, b) => cmpVersion(b.num, a.num));
  return { version: ok[0]?.num ?? null };
}

if (mode === "pin") {
  const young = violations.filter((v) => v.includes("published"));
  if (young.length === 0) {
    console.log(`✔ nothing to pin; every crate version is ≥ ${days} days old`);
    process.exit(0);
  }
  console.log(`# ${young.length} crate version(s) younger than ${days} days. From desktop/:`);
  for (const line of young) {
    const nameVersion = line.split(":")[0];
    const at = nameVersion.lastIndexOf("@");
    const name = nameVersion.slice(0, at);
    const version = nameVersion.slice(at + 1);
    const to = await newestCompliant(name, version);
    if (to.error) console.log(`# ${name}@${version}: could not ask crates.io (${to.error})`);
    else if (to.version) console.log(`cargo update -p ${name}@${version} --precise ${to.version}`);
    else
      console.log(
        `# ${name}@${version}: no compatible version is ${days} days old yet — wait, or relax the requirement`,
      );
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// What to say
// ---------------------------------------------------------------------------

for (const w of waived) console.log(`! waived by policy: ${w}`);
if (violations.length) {
  console.error(
    `✖ ${violations.length} crate version(s) younger than ${days} days, or from a source this policy does not audit (cutoff ${cutoff.toISOString()}):`,
  );
  for (const v of violations) console.error("  " + v);
  console.error(
    `\nOn Rust 1.100 and newer, cargo refuses these itself — see registry.global-min-publish-age in desktop/.cargo/config.toml.` +
      `\nFor the lines that move the lock back: node scripts/crate-age.mjs pin`,
  );
  process.exit(1);
}
const note = waived.length ? `, ${waived.length} waived by policy` : "";
const asked = total - fromCache;
console.log(
  `✔ ${total - waived.length} locked crate versions are all ≥ ${days} days old (cutoff ${cutoff
    .toISOString()
    .slice(0, 10)})${note}; ${local} local crates skipped` +
    `\n  ${fromCache} dates from desktop/crate-publish-times.json, ${asked} asked of crates.io` +
    (asked ? ` — run \`node scripts/crate-age.mjs refresh\` to cache them` : ""),
);
