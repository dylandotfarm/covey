import { createServer, type IncomingMessage } from "node:http";
import { readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, KNOWN_MODELS, type RpcRequest, type RpcResponse, type PushMessage, type WireFromDaemon } from "@covey/protocol";
import { Engine, EngineError } from "./engine.js";
import { isLoopback, isTailnetIp, whois, tailscaleSelf } from "./tailscale.js";
import { sourceInfo, scheduleRestart, type Updater } from "./update.js";
import type { DaemonConfig } from "./config.js";

const STARTED_AT = new Date().toISOString();

export interface ServerOptions {
  config: DaemonConfig;
  engine: Engine;
  /** Shared with every listener, so one update streams to all of them. */
  updater: Updater;
  host: string;
  log: (msg: string) => void;
}

/**
 * Authentication policy:
 *  1. loopback connections are always accepted (same machine);
 *  2. a matching `?token=` (or Authorization: Bearer) is accepted from anywhere;
 *  3. a tailnet peer is accepted if `tailscale whois` says it belongs to the
 *     same tailnet user as this daemon — zero-config for a personal tailnet.
 */
async function authenticate(req: IncomingMessage, cfg: DaemonConfig, selfUserId: number | null): Promise<{ ok: true; via: string } | { ok: false; reason: string }> {
  const ip = req.socket.remoteAddress ?? "";
  if (isLoopback(ip)) return { ok: true, via: "loopback" };
  const url = new URL(req.url ?? "/", "http://x");
  const token = url.searchParams.get("token") ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token && token === cfg.token) return { ok: true, via: "token" };
  if (isTailnetIp(ip)) {
    const peer = await whois(ip);
    if (peer && selfUserId !== null && peer.userId === selfUserId) return { ok: true, via: `tailnet:${peer.loginName}` };
    return { ok: false, reason: peer ? `tailnet user ${peer.loginName} is not the daemon owner` : "unknown tailnet peer" };
  }
  return { ok: false, reason: "no credentials" };
}

export async function startServer(o: ServerOptions): Promise<{ close(): void; port: number }> {
  const self = await tailscaleSelf();
  const selfUserId = self?.userId ?? null;
  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      // pid and startedAt let the CLI replace a daemon that is running older
      // code than the build on disk — otherwise a long-lived daemon silently
      // serves stale behaviour forever, since the CLI reuses any healthy one.
      // `sessions` says how many Claude subprocesses this daemon owns, and the
      // two limits that govern that number. A process list with more `claude`
      // processes than `sessions.live` holds something this daemon did not start.
      res.end(JSON.stringify({ ok: true, machineId: o.config.machineId, name: o.config.name, pid: process.pid, startedAt: STARTED_AT, sessions: o.engine.sessionCensus() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  http.on("upgrade", async (req, socket, head) => {
    const auth = await authenticate(req, o.config, selfUserId);
    if (!auth.ok) {
      o.log(`rejected ${req.socket.remoteAddress}: ${auth.reason}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      o.log(`client connected from ${req.socket.remoteAddress} via ${auth.via}`);
      handleConnection(ws, o);
    });
  });

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(o.config.port, o.host, () => res());
  });
  return { close: () => { wss.close(); http.close(); }, port: o.config.port };
}

function handleConnection(ws: WebSocket, o: ServerOptions) {
  const { engine } = o;
  const send = (m: WireFromDaemon) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const subs = new Map<string, () => void>();
  let subCounter = 0;

  const rpc = async (req: RpcRequest): Promise<RpcResponse> => {
    try {
      const result = await handle(req);
      return { id: req.id, ok: true, result } as RpcResponse;
    } catch (e: any) {
      const code = e instanceof EngineError ? e.code : "internal";
      return { id: req.id, ok: false, error: { code, message: e?.message ?? String(e) } };
    }
  };

  const handle = async (req: RpcRequest): Promise<unknown> => {
    const p: any = req.params ?? {};
    switch (req.method) {
      case "hello":
        if (p.protocolVersion !== PROTOCOL_VERSION) throw new EngineError("protocol", `daemon speaks v${PROTOCOL_VERSION}, client v${p.protocolVersion}`);
        return engine.machine;
      case "shell.snapshot":
        return engine.shellSnapshot();
      case "shell.subscribe": {
        const id = `s${++subCounter}`;
        const after = typeof p.afterSeq === "number" ? p.afterSeq : engine.db.shellSeq();
        const un = engine.onShell((ev) => send({ push: "shell", subscriptionId: id, event: ev }));
        subs.set(id, un);
        // replay then synchronize (after the response so the client has the id)
        queueMicrotask(() => {
          for (const ev of engine.db.shellEventsAfter(after)) send({ push: "shell", subscriptionId: id, event: ev });
          send({ push: "shell.synchronized", subscriptionId: id });
        });
        return { subscriptionId: id };
      }
      case "thread.snapshot":
        return engine.threadSnapshot(p.threadId, p.limit, p.beforeSeq);
      case "thread.subscribe": {
        const id = `t${++subCounter}`;
        const threadId = String(p.threadId);
        const after = typeof p.afterSeq === "number" ? p.afterSeq : engine.db.threadSeq(threadId);
        const un = engine.onThread((tid, ev) => { if (tid === threadId) send({ push: "thread", subscriptionId: id, threadId, event: ev }); });
        subs.set(id, un);
        queueMicrotask(() => {
          const replay = engine.db.threadEventsAfter(threadId, after);
          if (replay === null) {
            // gap too big: resend a snapshot as upserts
            const snap = engine.threadSnapshot(threadId);
            for (const item of snap.items) send({ push: "thread", subscriptionId: id, threadId, event: { seq: item.seq, kind: "item.upserted", item } });
            send({ push: "thread", subscriptionId: id, threadId, event: { seq: snap.seq, kind: "thread.updated", thread: snap.thread } });
          } else {
            for (const ev of replay) send({ push: "thread", subscriptionId: id, threadId, event: ev });
          }
          send({ push: "thread.synchronized", subscriptionId: id, threadId });
        });
        return { subscriptionId: id };
      }
      case "unsubscribe":
        subs.get(p.subscriptionId)?.();
        subs.delete(p.subscriptionId);
        return null;
      case "command": {
        const seq = await engine.dispatch(p);
        return { commandId: p.commandId, ok: true, seq };
      }
      case "thread.export":
        return engine.exportThread(p.threadId);
      case "thread.import":
        return engine.importThread(p.export, { projectId: p.projectId, workspaceRoot: p.workspaceRoot });
      case "thread.markMoved":
        engine.markMoved(p.threadId, p.machineId, p.newThreadId);
        return null;
      case "fs.listDir": {
        const path = resolve(p.path?.replace(/^~/, homedir()) || homedir());
        if (!existsSync(path)) throw new EngineError("bad_path", `${path} does not exist`);
        const entries = readdirSync(path, { withFileTypes: true })
          .filter((d) => !d.name.startsWith(".") || d.name === ".git")
          .map((d) => ({ name: d.name, isDir: d.isDirectory(), isRepo: d.isDirectory() && existsSync(join(path, d.name, ".git")) }))
          .filter((d) => d.isDir)
          .sort((a, b) => a.name.localeCompare(b.name));
        return { path, entries };
      }
      case "fs.mkdir": {
        const parent = resolve(p.path?.replace(/^~/, homedir()) || homedir());
        if (!existsSync(parent)) throw new EngineError("bad_path", `${parent} does not exist`);
        const name: string = String(p.name ?? "").trim().replace(/[\\/]+$/, "");
        // The client picks the parent by browsing; the name is free text, so it
        // is the only part that has to be checked. Anything that could climb
        // out of the directory on screen is refused rather than normalised.
        if (!name) throw new EngineError("bad_name", "name a folder to create");
        if (isAbsolute(name) || name.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === ".."))
          throw new EngineError("bad_name", `${p.name} is not a folder name`);
        const target = resolve(parent, name);
        if (target !== parent && !target.startsWith(parent + sep)) throw new EngineError("bad_name", `${p.name} is not a folder name`);
        try {
          mkdirSync(target, { recursive: true });
        } catch (e: any) {
          throw new EngineError("mkdir_failed", `could not create ${target}: ${e.code ?? e.message}`);
        }
        return { path: target };
      }
      case "models.list":
        return KNOWN_MODELS;
      case "thread.listDir":
        return engine.listThreadDir(p.threadId, String(p.dir ?? ""));
      case "project.git":
        return engine.projectGit(p.projectId);
      case "turn.diff":
        return engine.turnDiff(p.threadId, p.turnId);
      case "usage.report":
        return engine.usageReport({ since: p.since, until: p.until, groupBy: p.groupBy });
      case "machine.source":
        return sourceInfo();
      case "machine.update":
        return o.updater.start({ restart: p.restart });
      case "run.issues":
        return engine.runIssues(String(p.projectId), Array.isArray(p.numbers) ? p.numbers.map(Number) : []);
      case "run.pullRequest":
        return engine.runPullRequest(String(p.threadId));
      case "run.gate":
        return engine.runGate(String(p.threadId), String(p.label ?? ""), p.state, p.evidence ?? null);
      case "run.memberDiff":
        return engine.runMemberDiff(String(p.threadId));
      case "run.queue":
        return engine.runQueue(Array.isArray(p.entries) ? p.entries : []);
      case "run.merge":
        return engine.runMerge({
          threadId: String(p.threadId),
          label: String(p.label ?? ""),
          state: p.state,
          evidence: p.evidence ?? null,
          actor: p.actor,
          method: p.method,
          queue: p.queue,
        });
      case "run.audit":
        return engine.runAudit(String(p.threadId), String(p.label ?? ""));
      case "machine.restart": {
        const pid = process.pid;
        scheduleRestart(o.log);
        return { pid };
      }
      default:
        throw new EngineError("unknown_method", `unknown method ${(req as any).method}`);
    }
  };

  // Update progress needs no subscription: there is at most one update per
  // machine and it concerns every client connected to it.
  const unUpdate = o.updater.on((update) => send({ push: "machine.update", update }));

  ws.on("message", async (data) => {
    let req: RpcRequest;
    try { req = JSON.parse(data.toString()); } catch { return; }
    send(await rpc(req));
  });
  ws.on("close", () => { unUpdate(); for (const un of subs.values()) un(); subs.clear(); });
  ws.on("error", () => {});
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20_000);
  ws.on("close", () => clearInterval(ping));
}

export type { PushMessage };
