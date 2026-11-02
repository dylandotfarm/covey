/**
 * `covey threads`: the other threads of this project, wherever in the fleet
 * they run.
 *
 * A project is pooled across machines. The same repository on two machines is
 * one row in the sidebar, and so is the same local project; what the reader
 * sees as one place is, to an agent, one directory on one machine and nothing
 * else. So an agent asked what the thread on the other machine had said, found
 * nothing, and reported the project empty.
 *
 * This is the route. The CLI is a client like the terminal and the page: it
 * asks its own daemon which other machines it knows of (`machine.access`,
 * whose `peers` list the TUI keeps up to date), dials each one, and keeps the
 * projects whose pool key matches — `projectPool` in `@covey/client`, the one
 * rule every client folds a project by. Nothing new decides what two projects
 * share.
 *
 * Three rules hold it together:
 *
 *  - **One fleet.** A fleet is a real line and not a heading, so a machine
 *    that says it is in another one is left out. Each machine owns that
 *    setting, so the answer comes from the machine itself at `hello` rather
 *    than from the list.
 *  - **Read only.** This reads what other threads said and the files they
 *    wrote. It sends nothing and writes nothing, because a turn pushed into
 *    another agent's conversation is a different feature with a different
 *    blast radius.
 *  - **Name what went wrong.** A machine that would not answer is one line
 *    saying which machine and why (#132), never a project that reads as
 *    empty — which is the whole of the bug this fixes.
 *
 * `parseThreadsArgs`, `resolveThread` and every `render…` are pure, so a test
 * proves what each spelling asks for and what the agent reads back without a
 * daemon anywhere.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fleetKey, fleetOf, projectPool } from "@covey/client";
import {
  PROTOCOL_VERSION, threadIsBusy, threadIsHidden,
  type MachineInfo, type PathEntry, type PeerMachine, type Project, type Thread, type TimelineItem,
} from "@covey/protocol";
import { LOOP_CLIENT, openRpc, type Rpc } from "./loop.js";

/** What one `covey threads …` asks for. */
export type ThreadsRequest =
  | { kind: "list"; all: boolean }
  | { kind: "read"; id: string; limit: number }
  | { kind: "files"; id: string; dir: string }
  | { kind: "get"; id: string; path: string; out: string | null };

/** How many items of a conversation come back when nobody says. */
export const DEFAULT_READ_ITEMS = 60;

/**
 * How long one machine of the fleet gets to answer.
 *
 * A machine that is asleep answers nothing at all, and the socket to it hangs
 * on the tailnet until TCP gives up minutes later. An agent is waiting on this
 * command, so every machine is bounded and the slow one becomes a line in the
 * answer rather than a command that never returns.
 */
export const PEER_BUDGET_MS = 10_000;

export const THREADS_USAGE = `  covey threads [--all]      the other threads of this project, on every machine of its fleet.
                             A project is pooled across machines — the same repository, or the
                             same local project — and this is the whole of it. --all adds the
                             archived threads and covey's own automated reviewers
  covey threads read <id> [--limit N]
                             what one of those threads said. Each tool call is one line and the
                             thoughts are left out; --limit N reads N items, ${DEFAULT_READ_ITEMS} by default
  covey threads files <id> [<dir>]
                             what is in that thread's working directory
  covey threads get <id> <path> [--out F]
                             one file out of it. Text goes to the screen; --out F writes the
                             bytes to F, which is the way to fetch a picture or an archive

An id is as much of it as names one thread, the way a short commit does. These
read and never write: covey sends nothing to another thread and changes nothing
on another machine.`;

/**
 * Read `covey threads …`. An error is a sentence for the shell, never a throw.
 */
export function parseThreadsArgs(argv: string[]): { request: ThreadsRequest } | { error: string } {
  // `--thread` and `--port` are the caller's, read off the whole command line,
  // so they and their values are stepped over here rather than taken.
  const rest: string[] = [];
  const flags = new Map<string, string | true>();
  const words = argv.slice(1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--thread" || w === "--port") { i++; continue; }
    if (w === "--all") { flags.set("--all", true); continue; }
    if (w === "--limit" || w === "--out") {
      const v = words[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${w} needs a value, for example ${w === "--limit" ? "--limit 100" : "--out /tmp/shot.png"}` };
      flags.set(w, v);
      continue;
    }
    if (w.startsWith("--")) return { error: `covey threads does not know ${w}` };
    rest.push(w);
  }

  const sub = rest[0];
  if (sub === undefined || sub === "list") return { request: { kind: "list", all: flags.has("--all") } };

  if (sub === "read") {
    const id = rest[1];
    if (!id) return { error: "covey threads read needs the id of a thread: run `covey threads` for the list" };
    const raw = flags.get("--limit");
    let limit = DEFAULT_READ_ITEMS;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `--limit needs a whole number above zero, not ${raw}` };
      limit = n;
    }
    return { request: { kind: "read", id, limit } };
  }
  if (sub === "files") {
    const id = rest[1];
    if (!id) return { error: "covey threads files needs the id of a thread: run `covey threads` for the list" };
    return { request: { kind: "files", id, dir: rest[2] ?? "" } };
  }
  if (sub === "get") {
    const id = rest[1];
    const path = rest[2];
    if (!id || !path) return { error: "covey threads get needs a thread and a file, for example covey threads get 4f21 notes.md" };
    const out = flags.get("--out");
    return { request: { kind: "get", id, path, out: typeof out === "string" ? resolve(out) : null } };
  }
  return { error: `covey threads does not know ${sub}` };
}

/** One thread of the pooled project, and the machine that holds it. */
export interface FleetThread {
  thread: Thread;
  /** The machine's name, as that daemon calls itself. */
  machine: string;
  /** How to dial it. Empty for the machine this command runs on. */
  url: string;
  token?: string;
  /** True for the thread this command speaks for. */
  here: boolean;
  /** Where that thread works, so `files` can say it. */
  workspace: string | null;
}

/** A machine of the fleet that would not answer, and why. */
export interface FleetMiss {
  machine: string;
  why: string;
}

export interface ThreadsOutcome {
  ok: boolean;
  lines: string[];
}

/**
 * Ask the local daemon, then every machine of the fleet it knows of. Every
 * failure is a sentence.
 */
export async function runThreads(
  request: ThreadsRequest,
  env: { threadId: string | undefined; port: number },
  connect: (url: string) => Promise<Rpc> = openRpc,
): Promise<ThreadsOutcome> {
  if (!env.threadId) return { ok: false, lines: ["this command speaks for a covey thread: run it inside one (COVEY_THREAD_ID is set there), or pass --thread <id>"] };
  const threadId = env.threadId;
  let here: Rpc;
  try {
    here = await connect(`ws://127.0.0.1:${env.port}`);
  } catch (e: any) {
    return { ok: false, lines: [`no covey daemon answers on port ${env.port}: ${e?.message ?? e}`] };
  }
  try {
    const info = (await here.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT, threadId })) as MachineInfo;
    const snap = (await here.call("shell.snapshot", {})) as { projects: Project[]; threads: Thread[] };
    const mine = snap.threads.find((t) => t.id === threadId);
    if (!mine) return { ok: false, lines: [`${threadId} is not a thread on this machine; pass --thread with an id this daemon holds`] };
    const project = snap.projects.find((p) => p.id === mine.projectId);
    if (!project) return { ok: false, lines: ["this thread's project is not on this machine"] };

    const pool = projectPool(project);
    const fleet = fleetOf(info.settings?.fleet);
    const found: FleetThread[] = threadsOf(snap, project, info.name, "", threadId, undefined);
    const misses: FleetMiss[] = [];

    // A project with no pool key is on this machine and nowhere else: nothing
    // says it is the same as any other, so there is no fleet to ask.
    if (pool) {
      const access = (await here.call("machine.access", {})) as { peers?: PeerMachine[]; fleet?: PeerMachine[] };
      const peers = access.peers ?? access.fleet ?? [];
      const seen = new Set([info.machineId]);
      const answers = await Promise.all(peers.map((peer) => askPeer(peer, pool, fleet, connect)));
      for (const a of answers) {
        if ("why" in a) { misses.push(a); continue; }
        if (seen.has(a.machineId)) continue; // the same machine under a second address
        seen.add(a.machineId);
        found.push(...a.threads);
      }
      // Not a failure of a machine, but the same kind of news: the answer is
      // short for a reason the reader can act on, and silence here would read
      // as a project that is on this machine alone.
      if (peers.length === 0) misses.push({ machine: "the rest of the fleet", why: "this machine has not been told of any other. Open the covey TUI with both machines added; that is what hands each daemon the list" });
    }

    if (request.kind === "list") return { ok: true, lines: renderList(project, fleet, found, misses, request.all) };

    // Every other spelling names one thread. The id is resolved against what
    // the whole fleet answered — including the archived and the hidden, which
    // the list leaves out: a reader who names an id means that thread.
    const picked = resolveThread(found, request.id);
    if ("error" in picked) return { ok: false, lines: [picked.error, ...missLines(misses)] };
    const on = <T>(work: (rpc: Rpc) => Promise<T>) => onThatMachine(picked.thread, here, connect, work);
    const id = picked.thread.thread.id;
    switch (request.kind) {
      case "read": {
        const got = await on((rpc) => rpc.call("thread.snapshot", { threadId: id, limit: request.limit }) as Promise<{ items: TimelineItem[]; hasMore: boolean }>);
        return { ok: true, lines: [...renderRead(picked.thread, got.items, got.hasMore), ...missLines(misses)] };
      }
      case "files": {
        const got = await on((rpc) => rpc.call("thread.listDir", { threadId: id, dir: request.dir }) as Promise<{ dir: string; entries: PathEntry[]; truncated: boolean }>);
        return { ok: true, lines: [...renderFiles(picked.thread, request.dir, got.entries, got.truncated), ...missLines(misses)] };
      }
      case "get": {
        const got = await on((rpc) => rpc.call("thread.readFile", { threadId: id, path: request.path }) as Promise<{ path: string; bytes: string; size: number; truncated: boolean }>);
        return { ok: true, lines: [...renderGet(picked.thread, got, request.out, (f, b) => writeFileSync(f, b)), ...missLines(misses)] };
      }
    }
  } catch (e: any) {
    return { ok: false, lines: [String(e?.message ?? e)] };
  } finally {
    here.close();
  }
}

/**
 * Run `work` against the daemon that holds `t`: this one, or a second
 * connection to the machine that does.
 *
 * The second connection is opened per call and closed after it. A command of
 * this shape makes one or two of them in its whole life, and a pool would be
 * state to get wrong for no saving anybody can measure.
 */
async function onThatMachine<T>(
  t: FleetThread,
  here: Rpc,
  connect: (url: string) => Promise<Rpc>,
  work: (rpc: Rpc) => Promise<T>,
): Promise<T> {
  if (!t.url) return work(here);
  const rpc = await dial(t.url, t.token, connect);
  try {
    await rpc.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT });
    return await work(rpc);
  } catch (e: any) {
    throw new Error(olderDaemon(String(e?.message ?? e), t.machine));
  } finally {
    rpc.close();
  }
}

/**
 * A machine running covey from before this command is the one failure a reader
 * can act on, so it is named rather than passed on. "unknown method
 * thread.readFile" reads as a bug in covey; "pi runs an older covey" reads as
 * an update somebody has to run.
 */
function olderDaemon(message: string, machine: string): string {
  return /^unknown method /.test(message)
    ? `${machine} runs an older covey and does not know this yet — update it there (\`covey update\`), or press enter on that machine in the covey TUI`
    : message;
}

/** What one machine of the fleet holds of this project, or why it said nothing. */
async function askPeer(
  peer: PeerMachine,
  pool: string,
  fleet: string,
  connect: (url: string) => Promise<Rpc>,
): Promise<{ machineId: string; threads: FleetThread[] } | FleetMiss> {
  let rpc: Rpc;
  try {
    rpc = await dial(peer.url, peer.token, connect);
  } catch (e: any) {
    return { machine: peer.name, why: String(e?.message ?? e) };
  }
  try {
    const info = (await rpc.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT })) as MachineInfo;
    // The machine owns its fleet, so this is the only place the answer can
    // come from. A machine on the other side of the line is not a failure and
    // is not reported as one: the reader drew that line on purpose.
    if (fleetKey(fleetOf(info.settings?.fleet)) !== fleetKey(fleet)) return { machineId: info.machineId, threads: [] };
    const snap = (await rpc.call("shell.snapshot", {})) as { projects: Project[]; threads: Thread[] };
    const threads: FleetThread[] = [];
    for (const p of snap.projects) {
      if (projectPool(p) !== pool) continue;
      threads.push(...threadsOf(snap, p, info.name ?? peer.name, peer.url, null, peer.token));
    }
    return { machineId: info.machineId, threads };
  } catch (e: any) {
    return { machine: peer.name, why: String(e?.message ?? e) };
  } finally {
    rpc.close();
  }
}

/** The threads of one project on one machine, in the shape this command reads. */
function threadsOf(
  snap: { threads: Thread[] },
  project: Project,
  machine: string,
  url: string,
  hereId: string | null,
  token: string | undefined,
): FleetThread[] {
  return snap.threads
    .filter((t) => t.projectId === project.id && !t.movedTo)
    .map((t) => ({
      thread: t,
      machine,
      url,
      ...(token ? { token } : {}),
      here: t.id === hereId,
      workspace: t.worktreePath ?? project.workspaceRoot ?? null,
    }));
}

/**
 * Dial one machine, and give up on it inside the budget.
 *
 * A socket that is still opening when the budget runs out is closed as soon as
 * it opens, rather than left: this command dials every machine of the fleet at
 * once, and one asleep machine must not keep the process alive after the
 * answer has been printed.
 */
async function dial(url: string, token: string | undefined, connect: (url: string) => Promise<Rpc>): Promise<Rpc> {
  const full = token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url;
  let late = false;
  const opening = connect(full);
  opening.then((rpc) => { if (late) rpc.close(); }, () => { /* the race already reported it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { late = true; reject(new Error(`no answer in ${PEER_BUDGET_MS / 1000}s`)); }, PEER_BUDGET_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([opening, budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The thread an id names, the way a short commit names a commit.
 *
 * An exact id wins outright, so a full id is never ambiguous. Below that a
 * prefix has to name one thread: two candidates are an error that lists both,
 * because picking either would be covey guessing which conversation the reader
 * meant.
 */
export function resolveThread(threads: FleetThread[], id: string): { thread: FleetThread } | { error: string } {
  const want = id.toLowerCase();
  const exact = threads.find((t) => t.thread.id.toLowerCase() === want);
  if (exact) return { thread: exact };
  const hits = threads.filter((t) => t.thread.id.toLowerCase().startsWith(want));
  if (hits.length === 1) return { thread: hits[0]! };
  if (hits.length === 0) return { error: `no thread of this project starts with ${id}. Run \`covey threads\` for the list; --all adds the archived ones` };
  return { error: `${id} names ${hits.length} threads of this project — ${hits.map((t) => `${short(t.thread.id)} on ${t.machine}`).join(", ")}. Give more of the id` };
}

/** The list, as the agent reads it. */
export function renderList(project: Project, fleet: string, threads: FleetThread[], misses: FleetMiss[], all: boolean): string[] {
  const shown = threads
    .filter((t) => all || (!t.thread.archivedAt && !threadIsHidden(t.thread)))
    .sort((a, b) => (b.thread.lastMessageAt ?? "").localeCompare(a.thread.lastMessageAt ?? ""));
  const kindWord = project.kind === "local" ? "a local project" : "a repository project";
  const head = `${project.title} — ${kindWord} in fleet ${fleet}`;
  if (shown.length === 0) {
    return [head, all ? "no threads at all" : "no live threads. --all adds the archived ones and covey's own automated reviewers", ...missLines(misses)];
  }
  const rows = shown.map((t) => [
    short(t.thread.id),
    t.machine,
    state(t.thread),
    ago(t.thread.lastMessageAt),
    `${t.thread.title}${t.here ? "  (this thread)" : ""}`,
  ]);
  const width = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  return [
    head,
    ...rows.map((r) => `  ${r.slice(0, 4).map((cell, c) => cell.padEnd(width[c]!)).join("  ")}  ${r[4]}`),
    `read one with \`covey threads read ${short(shown[0]!.thread.id)}\`, its files with \`covey threads files ${short(shown[0]!.thread.id)}\``,
    ...missLines(misses),
  ];
}

/**
 * One conversation, as prose.
 *
 * A tool call is one line and a thought is not shown at all. What a reader of
 * another thread wants is what it *said* — the rest is how it got there, and
 * sixty tool calls of someone else's work read as noise around the one
 * sentence that was the question.
 */
export function renderRead(t: FleetThread, items: TimelineItem[], hasMore: boolean): string[] {
  const lines = [`thread ${short(t.thread.id)} on ${t.machine} — ${t.thread.title} (${state(t.thread)}, ${ago(t.thread.lastMessageAt)})`];
  if (hasMore) lines.push("… older items are not shown; --limit reads more");
  for (const i of items) {
    if (i.kind === "user") lines.push(block(i.system ? "covey" : "user", i.text));
    else if (i.kind === "assistant") lines.push(block("agent", i.text));
    else if (i.kind === "tool") lines.push(`  tool: ${i.summary || i.toolName}`);
    else if (i.kind === "note") lines.push(block(i.tone === "warning" ? "note (warning)" : "note", i.text));
    else if (i.kind === "error") lines.push(block("error", i.text));
    else if (i.kind === "question") lines.push(block("question", i.questions.map((q, n) => `${q.question}${i.answers[n] ? ` → ${i.answers[n]}` : " → unanswered"}`).join("\n")));
    else if (i.kind === "approval") lines.push(`  approval (${i.status}): ${i.summary || i.toolName}`);
  }
  if (items.length === 0) lines.push("this thread has said nothing yet");
  return lines;
}

/** One speaker's turn: a labelled first line, and the rest indented under it. */
function block(who: string, text: string): string {
  const [first = "", ...more] = text.split("\n");
  return [`${who}: ${first}`, ...more.map((l) => `  ${l}`)].join("\n");
}

/** What is in one directory of a thread's work. */
export function renderFiles(t: FleetThread, dir: string, entries: PathEntry[], truncated: boolean): string[] {
  const where = [t.workspace, dir].filter(Boolean).join("/");
  const head = `${where || t.workspace || "the thread's directory"} on ${t.machine}`;
  if (entries.length === 0) return [head, "nothing here"];
  return [
    head,
    ...entries.map((e) => `  ${e.name}${e.isDir ? "/" : ""}`),
    ...(truncated ? ["… and more; name a directory to see inside it"] : []),
    `read one with \`covey threads get ${short(t.thread.id)} ${dir ? `${dir}/` : ""}<name>\``,
  ];
}

/**
 * One file, on the screen or on this machine's disk.
 *
 * Text goes to the screen because that is what the agent asked the question
 * for. Bytes that are not text are never printed — a PNG down a terminal is
 * thousands of tokens of nothing — so that case says what to pass instead,
 * which is #132's rule: name the one thing that went wrong.
 */
export function renderGet(
  t: FleetThread,
  got: { path: string; bytes: string; size: number; truncated: boolean },
  out: string | null,
  write: (file: string, bytes: Buffer) => void,
): string[] {
  const bytes = Buffer.from(got.bytes, "base64");
  const cut = got.truncated ? [`… ${bytes.length} of ${got.size} bytes; the rest is past the cap`] : [];
  if (out) {
    write(out, bytes);
    return [`${got.path} from thread ${short(t.thread.id)} on ${t.machine} → ${out} (${bytes.length} bytes)`, ...cut];
  }
  if (bytes.includes(0)) {
    return [`${got.path} on ${t.machine} is ${got.size} bytes and is not text. Write it here with \`covey threads get ${short(t.thread.id)} ${got.path} --out <file>\``];
  }
  return [`${got.path} from thread ${short(t.thread.id)} on ${t.machine} (${got.size} bytes):`, bytes.toString("utf8"), ...cut];
}

/** The machines that said nothing, and why. One line each, never swallowed. */
function missLines(misses: FleetMiss[]): string[] {
  return misses.map((m) => `could not read ${m.machine}: ${m.why}`);
}

/** One word for what a thread is doing. */
function state(t: Thread): string {
  if (t.archivedAt) return "archived";
  if (t.pendingApprovals > 0) return "approving";
  if (threadIsBusy(t)) return "busy";
  if (t.lastError) return "failed";
  return "idle";
}

/** The first eight characters of an id, as every other covey surface prints one. */
function short(id: string): string {
  return id.slice(0, 8);
}

/** How long ago, in the fewest words that say it. */
export function ago(at: string | null, now = Date.now()): string {
  if (!at) return "never";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
