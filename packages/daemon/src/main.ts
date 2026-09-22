import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PROTOCOL_VERSION, type MachineInfo } from "@covey/protocol";
import { readModels } from "./models.js";
import { dataDir, loadDaemonConfig, machineSettings, platformInfo, projectsDir, type DaemonConfig } from "./config.js";
import { Db } from "./db.js";
import { Engine, EngineError } from "./engine.js";
import { startServer } from "./server.js";
import { buildInfo, buildLabel } from "./build.js";
import { tailscaleSelf } from "./tailscale.js";
import { Updater } from "./update.js";
import { clearPidFile, writePidFile } from "./pidfile.js";
import { machineResources } from "./resources.js";
import { webAddresses } from "./addresses.js";
import { sourceRoot } from "./update.js";
import { coveyPlugin } from "./plugin.js";
import { credentialExpiry, refreshCredentials } from "./auth.js";

export interface RunDaemonOptions {
  port?: number;
  bind?: string; // loopback | tailnet | all | <ip>
  name?: string;
  log?: (m: string) => void;
}

export interface DaemonHandle {
  close(): void;
  config: DaemonConfig;
  host: string;
  /** The same log the daemon writes its own lines with. */
  log: (m: string) => void;
}

export async function runDaemon(opts: RunDaemonOptions = {}): Promise<DaemonHandle> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[coveyd] ${m}\n`));
  const config = loadDaemonConfig({ port: opts.port, bind: opts.bind, name: opts.name });
  const ts = await tailscaleSelf();
  const hostFor = (bind: string): string => {
    switch (bind) {
      case "loopback": return "127.0.0.1";
      case "all": return "0.0.0.0";
      case "tailnet": return ts?.ips.find((ip) => ip.includes(".")) ?? "127.0.0.1";
      default: return bind;
    }
  };
  const host = hostFor(config.bind);
  if (config.bind === "tailnet" && !ts) log("tailscale not running; binding to loopback only");

  // The build, not the package version: "0.0.1" never moves, so it could not
  // tell a client that this machine runs older code than the client does.
  const build = await buildInfo();
  const machine: MachineInfo = {
    machineId: config.machineId, name: config.name, ...platformInfo(),
    daemonVersion: buildLabel(build), build, protocolVersion: PROTOCOL_VERSION,
    claudeCodeVersion: detectClaudeVersion(),
    tailnetName: ts?.dnsName, tailnetIps: ts?.ips,
    capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
    settings: machineSettings(config),
    projectsDir: projectsDir(),
    webAddresses: webAddresses({ port: config.port, bind: config.bind, tailnetName: ts?.dnsName, tailnetIps: ts?.ips }),
  };
  const db = new Db(join(dataDir()));
  // The `/covey` skill goes to every session as a plugin from this checkout.
  // A personal skill in ~/.claude/skills would not do: a resumed session reads
  // a temporary config directory the SDK builds, which has no skills in it.
  const plugin = coveyPlugin(sourceRoot());
  log(plugin ? `plugin: ${plugin} (the /covey skill)` : "plugin: none, this daemon does not run from a checkout with plugin/");
  const updater = new Updater(config.machineId, log);
  /** The listeners now open. `bind` moves them; `close` ends them. */
  let listeners: { close(): void; port: number }[] = [];
  const listen = async (bind: string, engine: Engine) => {
    const h = hostFor(bind);
    const opened: { close(): void; port: number }[] = [];
    opened.push(await startServer({ config, engine, updater, host: h, log }));
    // Also listen on loopback so the local TUI never needs credentials. A
    // wildcard listener already covers it, and a second bind would fail.
    if (h !== "127.0.0.1" && h !== "0.0.0.0") {
      try { opened.push(await startServer({ config: { ...config }, engine, updater, host: "127.0.0.1", log })); }
      catch (e: any) { log(`loopback listener unavailable: ${e.message}`); }
    }
    return { host: h, opened };
  };
  const engine = new Engine(db, machine, {
    log,
    // Which models this machine offers. Read from the Claude Code installed
    // here, so a machine on a newer Claude Code offers newer models without a
    // covey release, and a fleet where the installs differ says so per machine.
    readModels,
    // The real store: when its token runs out, and how Claude Code refreshes it.
    credentialExpiry,
    refreshCredentials,
    ...(plugin ? { plugins: [plugin] } : {}),
    // Move the listeners while the daemon runs. The old ones close first: on
    // Linux a wildcard bind fails while a listener on one address holds the
    // port. A socket already open stays open — an upgraded connection is no
    // longer the http server's to close — so the client that asked keeps its
    // answer. If the new bind fails, the old addresses come back.
    rebind: async (bind) => {
      const was = machine.settings.bind ?? config.bind;
      for (const l of listeners) l.close();
      listeners = [];
      try {
        listeners = (await listen(bind, engine)).opened;
      } catch (e: any) {
        listeners = (await listen(was, engine)).opened;
        throw new EngineError("bind", `cannot listen on ${bind}: ${e.message}`);
      }
      machine.webAddresses = webAddresses({ port: config.port, bind, tailnetName: ts?.dnsName, tailnetIps: ts?.ips });
    },
  });
  const first = await listen(config.bind, engine);
  listeners = first.opened;
  const server = first.opened[0]!;
  log(`listening on ws://${first.host}:${server.port}  machine=${config.name} id=${config.machineId.slice(0, 8)}  build=${machine.daemonVersion}${ts ? `  tailnet=${ts.dnsName}` : ""}`);
  // Which models this machine's Claude Code offers. The read starts a Claude
  // Code process, so it happens behind the listener and reaches clients as a
  // `machine.updated` push.
  void engine.refreshModels()
    .then(() => log(machine.models ? `models: ${machine.models.map((m) => m.id).join(" ")}` : "models: claude code did not say; using the built-in list"))
    .catch((e) => log(`could not read the model list: ${e.message}`));
  // What this machine is made of, and which tools *this process* can run. It
  // is read here rather than over ssh because an agent inherits this
  // environment and not a login shell's — see `resources.ts`. Running a program
  // per tool takes a moment, so it happens behind the listener and reaches
  // clients as a `machine.updated` push.
  void machineResources()
    .then((r) => { engine.setResources(r); log(`resources: ${r.cpuCount} cores, ${Math.round(r.totalMemoryBytes / 1e9)} GB, up to ${r.concurrency} run members, tools ${r.tools.map((t) => t.name).join(" ") || "none"}`); })
    .catch((e) => log(`could not read machine resources: ${e.message}`));

  // The pid file lets `covey stop --port N` name one daemon. Write it only
  // after the listener binds, so a failed start leaves no false record.
  const pidFile = writePidFile(server.port);
  log(`pid ${process.pid}  pid file ${pidFile}`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    engine.shutdown();
    for (const l of listeners) l.close();
    clearPidFile(server.port, process.pid);
  };
  return { close, config, host, log };
}

/**
 * Stop this daemon on SIGINT or SIGTERM, and write one line first.
 *
 * A daemon that exits without a word looks like it vanished. The log then ends
 * in the middle of the work, with no error and no shutdown line, and the reason
 * for the stop costs hours to find. Both entry points share this handler, so
 * both report the stop the same way.
 */
export function installStopHandlers(d: DaemonHandle): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    d.log(`stopping: signal=${signal} pid=${process.pid} port=${d.config.port} at ${new Date().toISOString()}`);
    d.close();
    // Node writes to stderr asynchronously when stderr is a pipe, so an
    // immediate exit can lose the line that explains the stop. Let the write
    // leave first, and exit anyway if it does not.
    const exit = () => process.exit(0);
    if (process.stderr.writableLength === 0) return exit();
    const timer = setTimeout(exit, 250);
    process.stderr.once("drain", () => { clearTimeout(timer); exit(); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function detectClaudeVersion(): string | undefined {
  try { return execFileSync("claude", ["--version"], { timeout: 5000 }).toString().trim().split(/\s+/)[0]; } catch { return undefined; }
}

// Direct execution: `node dist/main.js [--port N] [--bind tailnet|loopback|all|ip]`
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const d = await runDaemon({ port: get("--port") ? Number(get("--port")) : undefined, bind: get("--bind"), name: get("--name") });
  installStopHandlers(d);
}
