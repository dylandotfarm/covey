#!/usr/bin/env node
import "./require-node.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openSync, mkdirSync, statSync } from "node:fs";
import { DEFAULT_PORT } from "@covey/protocol";
import { runTui, loadConfig, saveConfig, localMachine, type RelaunchRequest } from "@covey/tui";
import { runDaemon, installStopHandlers, dataDir, loadDaemonConfig, Updater, sourceInfo, readPidFile, clearPidFile, pidFilePath, isAlive } from "@covey/daemon";

const argv = process.argv.slice(2);
// A leading flag belongs to `tui`, except for help: `covey --help` has to
// print the usage, not open the TUI.
const help = ["-h", "--help", "help"];
const cmd = argv[0] && (!argv[0].startsWith("-") || help.includes(argv[0])) ? argv[0] : "tui";
const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const has = (f: string) => argv.includes(f);

async function main() {
  switch (cmd) {
    case "tui":
    case "open": {
      const cfg = loadConfig();
      const local = localMachine();
      if (!has("--no-local")) {
        if (!(await healthy(localPort()))) await spawnDaemon();
        else await warnIfStale(here());
      }
      const machines = has("--no-local") ? cfg.machines : [local, ...cfg.machines.filter((m) => m.url !== local.url)];
      // The TUI cannot rebuild the code it is running from, so it asks us to:
      // it quits with a relaunch request and we do the work out here, with a
      // plain terminal to report into.
      const { relaunch } = await runTui({
        machines,
        source: await sourceInfo(here()).catch(() => null),
        canRelaunch: true,
        notice: takeNotice(),
      });
      if (relaunch) return relaunchSelf(await applyRelaunch(relaunch));
      process.exit(0);
    }
    case "update": {
      const result = await update();
      if (result.ok && !has("--no-local")) await restartLocalDaemon();
      process.exit(result.ok ? 0 : 1);
    }
    case "daemon": {
      const port = flag("--port") ? portFlag() : process.env.COVEY_PORT ? localPort() : undefined;
      const d = await runDaemon({ port, bind: flag("--bind"), name: flag("--name") });
      installStopHandlers(d);
      return;
    }
    case "machines": {
      const cfg = loadConfig();
      const sub = argv[1];
      if (sub === "add") {
        const url = argv[2]; const name = flag("--name") ?? (url ? new URL(url).hostname : "machine"); const token = flag("--token");
        if (!url) return usage();
        cfg.machines = cfg.machines.filter((m) => m.url !== url);
        cfg.machines.push({ name, url, token });
        saveConfig(cfg); console.log(`added ${name} → ${url}`); return;
      }
      if (sub === "rm") { cfg.machines = cfg.machines.filter((m) => m.url !== argv[2] && m.name !== argv[2]); saveConfig(cfg); console.log("removed"); return; }
      for (const m of cfg.machines) console.log(`${m.name.padEnd(16)} ${m.url}${m.token ? "  (token)" : ""}`);
      if (cfg.machines.length === 0) console.log("no remote machines. add one: covey machines add ws://host:3790 --name host");
      return;
    }
    case "info": {
      const c = loadDaemonConfig();
      console.log(`machine id : ${c.machineId}\nname       : ${c.name}\nport       : ${c.port}\nbind       : ${c.bind}\ntoken      : ${c.token}\ndata dir   : ${dataDir()}`);
      console.log(`\nFrom another machine on your tailnet (auto-authenticated, same tailscale user):\n  covey machines add ws://<this-machine>.<tailnet>.ts.net:${c.port} --name ${c.name}\nOutside tailscale, add --token ${c.token}`);
      return;
    }
    case "restart":
      process.exit((await restartLocalDaemon()) ? 0 : 1);
    case "stop":
      process.exit((await stopDaemon(flag("--port") ? portFlag() : localPort())) ? 0 : 1);
    case "-h": case "--help": case "help": return usage();
    default: return usage(1);
  }
}

function usage(code = 0) {
  console.log(`covey — multi-agent TUI for Claude Code

  covey                      open the TUI (starts a local daemon if needed)
  covey --no-local           open the TUI without the local machine
  covey daemon [--bind tailnet|loopback|all|<ip>] [--port N] [--name NAME]
                             run the per-machine daemon in the foreground
  covey machines             list saved remote machines
  covey machines add <ws-url> [--name NAME] [--token TOKEN]
  covey machines rm <name|url>
  covey restart              stop the local daemon and start it again, so a new
                             build takes effect (ends any turns it is running)
  covey stop [--port N]      stop one daemon by port, and leave it stopped. Use
                             this to clean up a throwaway instance; never a
                             pattern, which matches every daemon on the machine
  covey update               pull, rebuild and restart the local daemon. Inside the
                             TUI, ctrl+k → "Update covey" does this and relaunches
  covey info                 show this machine's daemon id, port, token, and pairing hint

One machine, from a fresh clone: \`pnpm run setup\` builds covey and puts this
command on your PATH. Run it again after you move the checkout.`);
  process.exit(code);
}

const here = () => dirname(fileURLToPath(import.meta.url));

/** The local daemon's port. COVEY_PORT lets a second covey run side by side. */
function localPort(): number {
  const n = Number(process.env.COVEY_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** The port in `--port`. A bad value stops the command; it never falls back to
 *  the default port, because that is a different daemon. */
function portFlag(): number {
  const n = Number(flag("--port"));
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`covey: --port needs a number from 1 to 65535, not ${JSON.stringify(flag("--port"))}`);
    process.exit(2);
  }
  return n;
}

/** Pull, install if the lockfile moved, and rebuild the checkout we run from. */
async function update(): Promise<{ ok: boolean; text: string }> {
  const updater = new Updater("client", () => {}, here());
  // Steps run in order, so reporting each one the first time it leaves
  // "pending" prints the log in the order the work actually happened.
  const reported = new Set<string>();
  updater.on((u) => {
    for (const s of u.steps) {
      if (reported.has(s.name) || s.status === "pending") continue;
      if (s.status === "running") { reported.add(s.name); console.log(`covey: ${s.label}…`); }
      else if (s.status === "skipped") { reported.add(s.name); console.log(`covey: ${s.label} skipped${s.note ? ` (${s.note})` : ""}`); }
    }
  });
  console.log("covey: updating");
  const u = await updater.runToCompletion({ restart: false });
  for (const s of u.steps) {
    if (s.status === "failed") console.error(`covey: ${s.label} failed${s.note ? ` (${s.note})` : ""}\n${s.output.trim()}`);
  }
  if (u.state === "failed") { console.error(`covey: update failed — ${u.error}`); return { ok: false, text: `update failed: ${u.error}` }; }
  const moved = u.fromCommit !== u.toCommit;
  const text = moved ? `updated ${u.fromCommit} → ${u.toCommit}` : `already up to date (${u.toCommit ?? "?"}), rebuilt`;
  console.log(`covey: ${text}`);
  return { ok: true, text };
}

/**
 * Stop the daemon on one port, and signal that one pid only.
 *
 * Every daemon runs the same program, so a pattern such as `pkill -f
 * "index.js daemon"` matches all of them. A session once killed the daemon
 * that hosted it that way. The pid comes from `/health` on the port, or from
 * the pid file the daemon wrote for that port. Both name one process.
 *
 * Returns true when nothing listens on the port any more.
 */
async function stopDaemon(port: number): Promise<boolean> {
  const h = await health(port);
  const rec = readPidFile(port);
  const pid = h?.pid ?? (rec && isAlive(rec.pid) ? rec.pid : undefined);
  if (!h && !pid) {
    // The pid file outlived the process it named. Take it away.
    if (rec) clearPidFile(port, rec.pid);
    console.log(`covey: no daemon on port ${port}`);
    return true;
  }
  if (!pid) {
    // A daemon that predates both the pid in /health and the pid file.
    console.error(`the daemon on port ${port} does not report its pid, and it wrote no pid file.`);
    console.error("stop that one process by hand, then run covey again:");
    console.error(`  kill $(lsof -ti :${port})`);
    return false;
  }
  if (h?.pid && rec && rec.pid !== h.pid && isAlive(rec.pid)) {
    // Two instances, one port. The port is still the address the user named,
    // so go on — but say which daemon is about to stop.
    console.error(`covey: warning — port ${port} belongs to pid ${h.pid}, but ${pidFilePath(port)} names pid ${rec.pid}.`);
    console.error("covey: another covey instance holds this port. covey stops the one on the port.");
  }
  const who = h ? ` — machine "${h.name}" (${h.machineId.slice(0, 8)})` : "";
  console.log(`covey: stopping daemon pid ${pid} on port ${port}${who}${h?.startedAt ? `, up since ${h.startedAt}` : ""}`);
  console.log("covey: this ends any turns it is running, including sessions hosted by it");
  try { process.kill(pid, "SIGTERM"); } catch (e: any) { console.error(`could not signal pid ${pid}: ${e.message}`); return false; }
  for (let i = 0; i < 40; i++) { if (!isAlive(pid) && !(await health(port))) break; await new Promise((r) => setTimeout(r, 250)); }
  if (isAlive(pid) || (await health(port))) {
    console.error(`covey: daemon pid ${pid} did not stop. Stop that one process: kill -9 ${pid}`);
    return false;
  }
  clearPidFile(port, pid);
  console.log(`covey: daemon stopped (pid ${pid})`);
  return true;
}

/** Stop the local daemon and start a fresh one from the build on disk. */
async function restartLocalDaemon(): Promise<boolean> {
  const port = localPort();
  if (!(await stopDaemon(port))) return false;
  await spawnDaemon();
  const fresh = await health(port);
  console.log(fresh ? `covey: daemon restarted (pid ${fresh.pid})` : "covey: daemon did not come back; see the log");
  return !!fresh;
}

/** Do what the TUI asked for on its way out, and report it on the way back in. */
async function applyRelaunch(req: RelaunchRequest): Promise<Notice> {
  let notice: Notice = { text: "relaunched", tone: "info" };
  if (req.update) {
    const r = await update();
    notice = { text: r.text, tone: r.ok ? "success" : "error" };
    if (!r.ok) req = { ...req, restartDaemon: false };
  }
  if (req.restartDaemon && !has("--no-local")) {
    const ok = await restartLocalDaemon();
    if (!ok) notice = { text: `${notice.text} — the daemon did not restart`, tone: "error" };
  }
  return notice;
}

/**
 * Start again from the build that now exists on disk. `process.execve` replaces
 * this process outright, which is exactly what we want — same pid, same
 * terminal, no supervisor left behind. Where it does not exist (older Node,
 * Windows) we spawn a child on the same stdio and wait for it, so the shell
 * still sees one foreground process.
 */
function relaunchSelf(notice: Notice): void {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const env = { ...process.env, COVEY_NOTICE: notice.text, COVEY_NOTICE_TONE: notice.tone };
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* not raw */ } }
  const execve = (process as unknown as { execve?: (file: string, argv: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (typeof execve === "function") {
    try { execve.call(process, process.execPath, [process.execPath, ...args], env); } catch (e: any) { console.error(`covey: exec failed (${e.message}); starting a child instead`); }
  }
  const child = spawn(process.execPath, args, { stdio: "inherit", env, cwd: process.cwd() });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

interface Notice { text: string; tone: "info" | "error" | "success" }

/** The line handed over by the process that relaunched us, if any. */
function takeNotice(): Notice | undefined {
  const text = process.env.COVEY_NOTICE;
  if (!text) return undefined;
  const tone = process.env.COVEY_NOTICE_TONE;
  // Consume it, so a daemon or Claude session we spawn does not inherit it.
  delete process.env.COVEY_NOTICE;
  delete process.env.COVEY_NOTICE_TONE;
  return { text, tone: tone === "error" || tone === "success" ? tone : "info" };
}

interface Health { machineId: string; name: string; pid: number; startedAt?: string }

async function health(port: number): Promise<Health | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch { return null; }
}

async function healthy(port: number): Promise<boolean> {
  return (await health(port)) !== null;
}

/**
 * The CLI reuses a healthy daemon, so one started before the current build
 * keeps serving old behaviour with no outward sign. Say so rather than letting
 * it be debugged the hard way.
 */
async function warnIfStale(dir: string) {
  try {
    const h = await health(localPort());
    if (!h?.startedAt) return;
    const built = statSync(join(dir, "index.js")).mtimeMs;
    if (built > Date.parse(h.startedAt)) {
      console.error(`covey: the local daemon (pid ${h.pid}) started before the current build — ctrl+k → \"Update covey\", or run \`covey restart\``);
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch { /* advisory only */ }
}

async function spawnDaemon() {
  const logDir = join(dataDir(), "logs"); mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, "daemon.log"), "a");
  const port = localPort();
  // Always pass --port, even for the default. The port then shows in `ps` and
  // in the command line that `pkill -f` reads, so two daemons never look the
  // same. `covey stop --port N` remains the safe way to stop one of them.
  const args = [join(here(), "index.js"), "daemon", "--port", String(port)];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await healthy(port)) return; await new Promise((r) => setTimeout(r, 250)); }
  console.error(`local daemon did not start; see ${join(logDir, "daemon.log")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
