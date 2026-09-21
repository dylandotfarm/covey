#!/usr/bin/env node
/**
 * One machine, one command: install the dependencies, build the workspace, and
 * put a `covey` launcher on your PATH, and link the `/covey` skill into
 * ~/.claude/skills so an agent inside a covey thread knows the loop. After
 * this, `covey` in any terminal opens the TUI and starts the local daemon.
 *
 *   node scripts/setup.mjs [--bin-dir DIR] [--add-to-path] [--skip-build] [--force]
 *
 *   --bin-dir DIR   where to write the launcher (default: a directory of yours
 *                   that is already on PATH, else ~/.local/bin)
 *   --add-to-path   append the PATH line to your shell's startup file
 *   --skip-build    only write the launcher; do not install or build
 *   --force         replace a `covey` that another tool put in the bin dir
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const windows = process.platform === "win32";
const home = homedir();

const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  ${m}`);
function die(message, hint) {
  console.error(`\ncovey setup: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

console.log("covey setup");

// --- 1. the tools we build with ---------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) die(`covey needs Node 22 or newer; this is ${process.version}.`, "  Install Node 22+, then run this again.");
ok(`node ${process.version}`);

const pinnedPnpm = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager ?? "pnpm@12";
const pnpm = windows ? "pnpm.cmd" : "pnpm";
let pnpmVersion = null;
try {
  pnpmVersion = execFileSync(pnpm, ["--version"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  if (!has("--skip-build")) die("covey builds with pnpm, which is not on your PATH.", `  Install it once:  npm install -g ${pinnedPnpm}`);
}
if (pnpmVersion) ok(`pnpm ${pnpmVersion}`);

// --- 2. dependencies and build ----------------------------------------------
if (has("--skip-build")) {
  info("skipped the install and the build (--skip-build)");
} else {
  step("pnpm install", pnpm, ["install", "--frozen-lockfile"]);
  step("pnpm run build", pnpm, ["run", "build"]);
}

function step(label, cmd, args) {
  info(`${label}…`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
  } catch {
    die(`\`${label}\` failed. Fix the error above, then run this again.`);
  }
}

// --- 3. the launcher --------------------------------------------------------
const binDir = resolve(flag("--bin-dir") ?? process.env.COVEY_BIN_DIR ?? defaultBinDir());
mkdirSync(binDir, { recursive: true });
const target = join(root, "bin", "covey");
const dest = join(binDir, windows ? "covey.cmd" : "covey");

if (existsSync(dest) || isLink(dest)) {
  if (!windows && isLink(dest) && resolveLink(dest) === target) ok(`${tilde(dest)} already points here`);
  else if (has("--force") || ownedByUs(dest)) rmSync(dest);
  else die(`${tilde(dest)} exists and is not covey's.`, "  Pass --force to replace it, or --bin-dir DIR to install elsewhere.");
}
if (!existsSync(dest)) {
  if (windows) writeFileSync(dest, windowsShim(), "utf8");
  else symlinkSync(target, dest);
  ok(`${tilde(dest)} → ${tilde(windows ? root : target)}`);
}
if (!windows) chmodSync(target, 0o755);

// --- 4. the /covey skill ------------------------------------------------------
// The skill tells an agent inside a covey thread how to take an issue to a
// merged pull request with `covey issue …` and `covey pr …`. Claude Code reads
// skills from ~/.claude/skills/<name>/SKILL.md, so the directory is linked
// there, back to this checkout, the way the launcher is: a pull updates both.
const skillSrc = join(root, "skills", "covey");
const skillDir = join(home, ".claude", "skills");
const skillDest = join(skillDir, "covey");
mkdirSync(skillDir, { recursive: true });
if (isLink(skillDest) && resolveLink(skillDest) === skillSrc) ok(`${tilde(skillDest)} already points here`);
else if (isLink(skillDest) && resolveLink(skillDest).endsWith(join("skills", "covey")) && !existsSync(resolveLink(skillDest))) { rmSync(skillDest); linkSkill(); }
else if (isLink(skillDest) || existsSync(skillDest)) {
  if (has("--force")) { rmSync(skillDest, { recursive: true }); linkSkill(); }
  else info(`note: ${tilde(skillDest)} exists and is not this checkout's; pass --force to replace it, so /covey reads the skill here`);
} else linkSkill();
function linkSkill() {
  if (windows) { info(`copy ${tilde(skillSrc)} to ${tilde(skillDest)} by hand: Windows symlinks need a privilege this script does not ask for`); return; }
  symlinkSync(skillSrc, skillDest, "dir");
  ok(`${tilde(skillDest)} → ${tilde(skillSrc)}  (the /covey skill)`);
}

// --- 5. PATH ----------------------------------------------------------------
if (onPath(binDir)) {
  const other = shadowingCovey(binDir);
  if (other) info(`note: ${tilde(other)} comes first on your PATH and will run instead`);
  console.log(`\nDone. Run \`covey\`.`);
} else if (has("--add-to-path")) {
  const file = addToPath(binDir);
  console.log(`\nDone. Added ${tilde(binDir)} to your PATH in ${tilde(file)}.`);
  console.log(`Open a new terminal (or \`source ${tilde(file)}\`), then run \`covey\`.`);
} else {
  console.log(`\nDone, but ${tilde(binDir)} is not on your PATH yet.`);
  console.log(`Add it with:  node scripts/setup.mjs --add-to-path --skip-build`);
  console.log(`Or by hand:   ${pathLine(binDir)}`);
}

/** A directory of the user's that is already on PATH beats one that is not. */
function defaultBinDir() {
  if (windows) return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "covey", "bin");
  const candidates = [process.env.PNPM_HOME, join(home, ".local", "bin"), join(home, "bin")].filter(Boolean);
  return candidates.find((d) => onPath(d) && existsSync(d)) ?? join(home, ".local", "bin");
}

function pathDirs() {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(real);
}

function onPath(dir) {
  const want = real(dir);
  return pathDirs().some((d) => (windows ? d.toLowerCase() === want.toLowerCase() : d === want));
}

/** A `covey` earlier on PATH than ours would win silently; say so instead. */
function shadowingCovey(ourDir) {
  const want = real(ourDir);
  for (const dir of pathDirs()) {
    const file = join(dir, windows ? "covey.cmd" : "covey");
    if (dir === want) return null;
    if (existsSync(file)) return file;
  }
  return null;
}

/** True for a launcher an earlier run of this script wrote, which we may replace. */
function ownedByUs(file) {
  try {
    if (!windows) return isLink(file) && resolveLink(file).endsWith(join("bin", "covey"));
    return readFileSync(file, "utf8").includes("covey launcher");
  } catch { return false; }
}

function isLink(file) {
  try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function resolveLink(file) {
  const link = readlinkSync(file);
  return resolve(dirname(file), link);
}

function real(dir) {
  try { return realpathSync(resolve(dir.replace(/^~(?=$|[/\\])/, home))); } catch { return resolve(dir); }
}

function tilde(p) {
  return p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p;
}

function pathLine(dir) {
  const shell = (process.env.SHELL ?? "").split("/").pop();
  if (windows) return `setx PATH "%PATH%;${dir}"`;
  if (shell === "fish") return `fish_add_path ${tilde(dir)}`;
  return `export PATH="${tilde(dir)}:$PATH"`;
}

/** Append the PATH line to the startup file of the shell that is running us. */
function addToPath(dir) {
  if (windows) die("--add-to-path does not work on Windows.", `  Run this instead:  ${pathLine(dir)}`);
  const shell = (process.env.SHELL ?? "").split("/").pop();
  const file =
    shell === "fish" ? join(home, ".config", "fish", "config.fish")
    : shell === "zsh" ? join(home, ".zshrc")
    : process.platform === "darwin" ? join(home, ".bash_profile")
    : join(home, ".bashrc");
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.includes(dir)) return file;
  appendFileSync(file, `${text.endsWith("\n") || text === "" ? "" : "\n"}\n# added by covey setup\n${pathLine(dir).replace("~", home)}\n`);
  return file;
}

function windowsShim() {
  return [
    "@echo off",
    "rem covey launcher, written by scripts/setup.mjs",
    "setlocal",
    `set "COVEY_ROOT=${root}"`,
    `if not exist "%COVEY_ROOT%\\packages\\cli\\dist\\index.js" (`,
    `  pushd "%COVEY_ROOT%" && call pnpm install --frozen-lockfile && call pnpm run build --force && popd`,
    ")",
    `node "%COVEY_ROOT%\\packages\\cli\\dist\\index.js" %*`,
    "",
  ].join("\r\n");
}
