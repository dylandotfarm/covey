import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PROTOCOL_VERSION, type MachineInfo } from "@covey/protocol";
import { dataDir, loadDaemonConfig, machineSettings, platformInfo, type DaemonConfig } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";
import { tailscaleSelf } from "./tailscale.js";
import { Updater } from "./update.js";

export interface RunDaemonOptions {
  port?: number;
  bind?: string; // loopback | tailnet | all | <ip>
  name?: string;
  log?: (m: string) => void;
}

export async function runDaemon(opts: RunDaemonOptions = {}): Promise<{ close(): void; config: DaemonConfig; host: string }> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[coveyd] ${m}\n`));
  const config = loadDaemonConfig({ port: opts.port, bind: opts.bind, name: opts.name });
  const ts = await tailscaleSelf();
  let host: string;
  switch (config.bind) {
    case "loopback": host = "127.0.0.1"; break;
    case "all": host = "0.0.0.0"; break;
    case "tailnet": host = ts?.ips.find((ip) => ip.includes(".")) ?? "127.0.0.1"; break;
    default: host = config.bind;
  }
  if (config.bind === "tailnet" && !ts) log("tailscale not running; binding to loopback only");

  const machine: MachineInfo = {
    machineId: config.machineId, name: config.name, ...platformInfo(),
    daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION,
    claudeCodeVersion: detectClaudeVersion(),
    tailnetName: ts?.dnsName, tailnetIps: ts?.ips,
    capabilities: { claude: true, worktrees: true, moveThreads: true, providers: ["claude"] },
    settings: machineSettings(config),
  };
  const db = new Db(join(dataDir()));
  const engine = new Engine(db, machine);
  const updater = new Updater(config.machineId, log);
  const server = await startServer({ config, engine, updater, host, log });
  log(`listening on ws://${host}:${server.port}  machine=${config.name} id=${config.machineId.slice(0, 8)}${ts ? `  tailnet=${ts.dnsName}` : ""}`);
  if (host !== "127.0.0.1") {
    // also listen on loopback so the local TUI never needs credentials
    try {
      await startServer({ config: { ...config }, engine, updater, host: "127.0.0.1", log });
    } catch (e: any) { log(`loopback listener unavailable: ${e.message}`); }
  }
  const close = () => { engine.shutdown(); server.close(); };
  return { close, config, host };
}

function detectClaudeVersion(): string | undefined {
  try { return execFileSync("claude", ["--version"], { timeout: 5000 }).toString().trim().split(/\s+/)[0]; } catch { return undefined; }
}

// Direct execution: `node dist/main.js [--port N] [--bind tailnet|loopback|all|ip]`
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const d = await runDaemon({ port: get("--port") ? Number(get("--port")) : undefined, bind: get("--bind"), name: get("--name") });
  const stop = () => { d.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
