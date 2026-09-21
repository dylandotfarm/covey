import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, KNOWN_MODELS, type RpcRequest, type RpcResponse, type PushMessage, type WireFromDaemon, type PullRequestAttachment } from "@covey/protocol";
import { Engine, EngineError } from "./engine.js";
import { isLoopback, isTailnetIp, whois, tailscaleSelf, type TailscaleSelf } from "./tailscale.js";
import { sourceInfo, scheduleRestart, type Updater } from "./update.js";
import { readFleet, type DaemonConfig } from "./config.js";
import { listRepos, createRepo, GH_CWD } from "./repos.js";
import { listRemoteBranches } from "./git.js";
import { findWebRoots, serveWeb } from "./web.js";
import { serveMedia } from "./media.js";
import { webAddresses } from "./addresses.js";

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
  // Found once: the package graph does not move while the daemon runs.
  const webRoots = findWebRoots();
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
    // The phone's client: static files only, and the WebSocket above stays the
    // one gate. See `web.ts` for what is reachable. Read per request, because
    // the control panel turns it on and off while the daemon runs.
    if (o.engine.machine.settings.webEnabled) {
      if (serveWeb(req, res, webRoots)) return;
      // An attachment from a private repository, by the daemon's token (#110).
      // The one file route that is gated: the answer is a signed link to the
      // bytes, which only the owner may have.
      if (req.url?.startsWith("/media?") || req.url === "/media") {
        void authenticate(req, o.config, selfUserId).then((auth) => {
          if (!auth.ok) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end(`media: ${auth.reason}\n`); return; }
          return serveMedia(req, res);
        }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
        return;
      }
    }
    else if (req.url === "/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`The web client is off on ${o.config.name}. In the TUI, press enter on this machine and choose "Web server: off" to start it.\n`);
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
      handleConnection(ws, o, self);
    });
  });

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(o.config.port, o.host, () => res());
  });
  return { close: () => { wss.close(); http.close(); }, port: o.config.port };
}

function handleConnection(ws: WebSocket, o: ServerOptions, tailnet: TailscaleSelf | null) {
  const { engine } = o;
  const send = (m: WireFromDaemon) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const subs = new Map<string, () => void>();
  let subCounter = 0;
  /**
   * The name this connection gave at `hello`. It says whether a person or a
   * program creates the threads that follow, so it is kept for the life of the
   * connection instead of being read once and thrown away. Self-declared: the
   * daemon cannot check it, so nothing that must not be spoofable may rest on
   * it (`ThreadOrigin`).
   */
  let clientName = "";
  /**
   * The thread this connection said it speaks for at `hello` — an agent inside
   * a covey thread, passing on the `COVEY_THREAD_ID` the daemon gave its
   * session. Every thread and every run the connection creates is a child of
   * it, so the sidebar can put the work under the thread that asked for it.
   * Self-declared, exactly like `clientName`, and checked against the db
   * before it is used rather than trusted.
   */
  let callerThread = "";

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
        clientName = typeof p.client === "string" ? p.client : "";
        callerThread = typeof p.threadId === "string" ? p.threadId : "";
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
        const seq = await engine.dispatch(p, clientName, callerThread);
        return { commandId: p.commandId, ok: true, seq };
      }
      case "thread.export":
        return engine.exportThread(p.threadId);
      case "thread.import":
        return engine.importThread(p.export, { projectId: p.projectId, url: p.url });
      case "thread.markMoved":
        engine.markMoved(p.threadId, p.machineId, p.newThreadId);
        return null;
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
      case "machine.access":
        // Every connection here passed `authenticate`, so it may hold the
        // token: a tailnet peer is the owner, and the others already have it.
        return { token: o.config.token, addresses: webAddresses({ port: o.config.port, bind: o.config.bind, tailnetName: tailnet?.dnsName, tailnetIps: tailnet?.ips }), fleet: readFleet() };
      case "machine.update":
        return o.updater.start({ restart: p.restart });
      case "run.issues":
        return engine.runIssues(String(p.projectId), Array.isArray(p.numbers) ? p.numbers.map(Number) : []);
      case "repos.list":
        return listRepos();
      case "repos.branches":
        return listRemoteBranches(String(p.url ?? ""), GH_CWD);
      case "repos.create":
        return createRepo({ name: String(p.name ?? ""), visibility: p.visibility === "public" ? "public" : "private", description: p.description ? String(p.description) : undefined });
      case "run.pullRequest":
        return engine.runPullRequest(String(p.threadId));
      case "thread.openPullRequest":
        return engine.openPullRequest({
          threadId: String(p.threadId),
          title: String(p.title ?? ""),
          body: p.body === undefined ? undefined : String(p.body),
          draft: !!p.draft,
          maxRounds: typeof p.maxRounds === "number" ? p.maxRounds : undefined,
          merge: p.merge === "auto" ? "auto" : p.merge === "manual" ? "manual" : undefined,
          mergeMethod: p.mergeMethod,
          attachments: readAttachmentParams(p.attachments),
        });
      case "thread.commentPullRequest":
        return engine.commentPullRequest({
          threadId: String(p.threadId),
          body: p.body === undefined ? undefined : String(p.body),
          attachments: readAttachmentParams(p.attachments),
        });
      case "github.item":
        return engine.githubItem(String(p.projectId), Number(p.number));
      case "github.act":
        return engine.githubAct(String(p.projectId), Number(p.number), p.action, clientName);
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

/** The `attachments` of a pull request call, as `{ name, path }` rows and nothing else. */
function readAttachmentParams(v: unknown): PullRequestAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => ({ name: String(a?.name ?? ""), path: String(a?.path ?? "") }));
}
