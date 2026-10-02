/**
 * `covey issue …` and `covey pr …`: the loop of issue #94 from a shell.
 *
 * An agent inside a covey thread runs these. The thread comes from
 * `COVEY_THREAD_ID`, which the daemon puts in every session it starts, and
 * the daemon is the local one on `COVEY_PORT`, else the default port. The
 * connection is loopback, which the daemon accepts without a token.
 *
 * The daemon does the work: it pushes the branch, opens the pull request,
 * records the number and watches it. This file only asks. `parseLoopArgs` is
 * pure, so a test can prove what each spelling asks for without a daemon.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DEFAULT_PORT, PROTOCOL_VERSION, reviewStanding, type MergeMethod, type MergePolicy, type PullRequestAttachment, type ReviewerRecord, type Thread } from "@covey/protocol";

/** What one invocation asks the daemon for. */
export type LoopRequest =
  | { kind: "issue.take"; issue: number | null }
  | { kind: "pr.open"; title: string; body: string; draft: boolean; merge: MergePolicy; mergeMethod: MergeMethod; maxRounds?: number; attachments: PullRequestAttachment[]; reviews?: number }
  | { kind: "pr.comment"; body: string; attachments: PullRequestAttachment[] }
  | { kind: "pr.watch"; number: number | null; merge: MergePolicy; mergeMethod: MergeMethod; maxRounds?: number }
  | { kind: "pr.policy"; merge: MergePolicy; mergeMethod?: MergeMethod }
  | { kind: "pr.review"; count?: number }
  | { kind: "pr.status" }
  /** From a review thread: the verdict that ends or holds the review. */
  | { kind: "review.decide"; verdict: "approve" | "changes"; body: string; attachments: PullRequestAttachment[] }
  | { kind: "review.status" };

/** The name this command gives at `hello`. A program, so its threads are an agent's. */
export const LOOP_CLIENT = "covey-cli";

export const LOOP_USAGE = `  covey issue take <n>       record the issue this thread owns (refused when another thread holds it)
  covey issue drop           clear it
  covey pr open --title "…" [--body "…" | --body-file F] [--draft] [--auto] [--squash|--rebase] [--rounds N] [--attach F]... [--reviews N | --no-review]
                             push this thread's branch, open the pull request, and watch it.
                             --auto: covey merges when the checks pass and the review signs
                             off; else a person merges
                             --attach F: put a video or an image on the pull request, rendered
                             inline (mp4, mov, webm, png, jpg, jpeg, gif, webp, svg). Repeatable.
                             The URL goes where the body says {{attach:NAME}}, else at the end
                             --reviews N: start N automated reviewers. One by default
                             --no-review: start none, and require none
  covey pr comment [--body "…" | --body-file F] [--attach F]...
                             comment on this thread's pull request, with media the same way
  covey pr review [N]        start N more automated reviewers (one by default) on this
                             thread's pull request
  covey pr watch <n> [--auto] [--squash|--rebase] [--rounds N]
                             watch a pull request opened by hand
  covey pr watch --stop      stop the watch
  covey pr policy auto|manual [--squash|--rebase]
                             change who merges, on a watch that runs
  covey pr status            the issue, the pull request, the watch and the review of this thread

Inside a review thread, which covey starts when a pull request is opened:

  covey review changes --body "…" | --body-file F   [--attach F]...
                             ask the author for changes, and hold the merge until you sign off
  covey review approve [--body "…" | --body-file F] [--attach F]...
                             sign off. Covey archives this thread
  covey review status        the pull request this thread reviews, and where every reviewer is

Covey adds the tagline that says a machine wrote the comment, to every comment a
review thread leaves. Do not write it yourself.

These run inside a covey thread, where COVEY_THREAD_ID is set; --thread <id> names one.`;

/**
 * Read `covey issue …` or `covey pr …`. An error is a sentence for the shell,
 * never a throw: the caller prints it and exits 2.
 */
export function parseLoopArgs(argv: string[]): { request: LoopRequest } | { error: string } {
  const [cmd, sub, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const has = (name: string) => rest.includes(name);
  const method = (): MergeMethod => (has("--squash") ? "squash" : has("--rebase") ? "rebase" : "merge");
  const rounds = (): { maxRounds?: number } | { error: string } => {
    const v = flag("--rounds");
    if (v === undefined) return {};
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? { maxRounds: n } : { error: `--rounds needs a whole number above zero, not ${v}` };
  };
  const number = (v: string | undefined, what: string): number | { error: string } => {
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n > 0 ? n : { error: `${what} needs a number, for example ${what} 94` };
  };

  if (cmd === "issue") {
    if (sub === "take") {
      const n = number(rest[0], "covey issue take");
      return typeof n === "number" ? { request: { kind: "issue.take", issue: n } } : n;
    }
    if (sub === "drop") return { request: { kind: "issue.take", issue: null } };
    return { error: "covey issue takes `take <n>` or `drop`" };
  }
  if (cmd !== "pr" && cmd !== "review") return { error: `covey does not know ${cmd ?? ""} ${sub ?? ""}`.trim() };

  // `--body-file` wins over `--body`; a long body needs no quoting that way.
  const body = (): string | { error: string } => {
    const file = flag("--body-file");
    if (!file) return flag("--body") ?? "";
    try { return readFileSync(file, "utf8"); } catch (e: any) { return { error: `could not read --body-file ${file}: ${e?.message ?? e}` }; }
  };
  // Every `--attach F`, in the order given. The path is made absolute here,
  // because the daemon reads it and the daemon's cwd is not this shell's.
  const attachments = (): PullRequestAttachment[] | { error: string } => {
    const out: PullRequestAttachment[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== "--attach") continue;
      const path = rest[i + 1];
      if (!path || path.startsWith("--")) return { error: "--attach needs a path to a video or an image" };
      out.push({ name: basename(path), path: resolve(path) });
    }
    return out;
  };

  // How many reviewers the pull request asks for. One unless the caller says:
  // the change nobody reads is the case the review exists to end, so
  // `--no-review` is a thing to say rather than a default to leave alone.
  const reviews = (): { reviews?: number } | { error: string } => {
    const v = flag("--reviews");
    if (has("--no-review")) {
      if (v !== undefined) return { error: "--no-review and --reviews ask for opposite things; pass one of them" };
      return { reviews: 0 };
    }
    if (v === undefined) return {};
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? { reviews: n } : { error: `--reviews needs a whole number, not ${v}; --no-review asks for none` };
  };

  if (cmd === "review") {
    if (sub === "status") return { request: { kind: "review.status" } };
    if (sub !== "approve" && sub !== "changes") return { error: "covey review takes `approve`, `changes` or `status`" };
    const b = body();
    if (typeof b !== "string") return b;
    const a = attachments();
    if (!Array.isArray(a)) return a;
    if (sub === "changes" && !b.trim()) return { error: "covey review changes needs --body or --body-file: say what to change and where" };
    return { request: { kind: "review.decide", verdict: sub === "approve" ? "approve" : "changes", body: b, attachments: a } };
  }

  if (sub === "open") {
    const title = flag("--title")?.trim();
    if (!title) return { error: "covey pr open needs --title" };
    const b = body();
    if (typeof b !== "string") return b;
    const r = rounds();
    if ("error" in r) return r;
    const a = attachments();
    if (!Array.isArray(a)) return a;
    const v = reviews();
    if ("error" in v) return v;
    return { request: { kind: "pr.open", title, body: b, draft: has("--draft"), merge: has("--auto") ? "auto" : "manual", mergeMethod: method(), ...r, attachments: a, ...v } };
  }
  if (sub === "review") {
    if (rest[0] === undefined) return { request: { kind: "pr.review" } };
    const n = number(rest[0], "covey pr review");
    return typeof n === "number" ? { request: { kind: "pr.review", count: n } } : n;
  }
  if (sub === "comment") {
    const b = body();
    if (typeof b !== "string") return b;
    const a = attachments();
    if (!Array.isArray(a)) return a;
    if (!b.trim() && a.length === 0) return { error: "covey pr comment needs --body, --body-file or --attach" };
    return { request: { kind: "pr.comment", body: b, attachments: a } };
  }
  if (sub === "watch") {
    if (has("--stop")) return { request: { kind: "pr.watch", number: null, merge: "manual", mergeMethod: "merge" } };
    const n = number(rest[0], "covey pr watch");
    if (typeof n !== "number") return n;
    const r = rounds();
    if ("error" in r) return r;
    return { request: { kind: "pr.watch", number: n, merge: has("--auto") ? "auto" : "manual", mergeMethod: method(), ...r } };
  }
  if (sub === "policy") {
    const merge = rest[0];
    if (merge !== "auto" && merge !== "manual") return { error: "covey pr policy takes `auto` or `manual`" };
    return { request: { kind: "pr.policy", merge, ...(has("--squash") || has("--rebase") ? { mergeMethod: method() } : {}) } };
  }
  if (sub === "status") return { request: { kind: "pr.status" } };
  return { error: "covey pr takes `open`, `comment`, `review`, `watch`, `policy` or `status`" };
}

export interface LoopEnv {
  /** The thread this command speaks for. `COVEY_THREAD_ID`, or `--thread`. */
  threadId: string | undefined;
  /** The daemon's port. `COVEY_PORT`, or `--port`, else the default. */
  port: number;
}

/** What the shell gets: lines to print, and the exit code. */
export interface LoopOutcome {
  ok: boolean;
  lines: string[];
}

/** One request and one answer over one socket. */
export interface Rpc {
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

/**
 * Ask the local daemon. Every failure is a sentence, so the agent that ran
 * this reads why in its tool output and nothing in its transcript is a stack.
 */
export async function runLoop(request: LoopRequest, env: LoopEnv, connect: (url: string) => Promise<Rpc> = openRpc): Promise<LoopOutcome> {
  if (!env.threadId) return { ok: false, lines: ["this command speaks for a covey thread: run it inside one (COVEY_THREAD_ID is set there), or pass --thread <id>"] };
  const threadId = env.threadId;
  let rpc: Rpc;
  try {
    rpc = await connect(`ws://127.0.0.1:${env.port}`);
  } catch (e: any) {
    return { ok: false, lines: [`no covey daemon answers on port ${env.port}: ${e?.message ?? e}`] };
  }
  try {
    await rpc.call("hello", { protocolVersion: PROTOCOL_VERSION, client: LOOP_CLIENT, threadId });
    const command = (cmd: Record<string, unknown>) => rpc.call("command", { commandId: crypto.randomUUID(), threadId, ...cmd });
    const status = async (): Promise<string[]> => {
      const snap = (await rpc.call("thread.snapshot", { threadId, limit: 1 })) as { thread: Thread };
      return describeThread(snap.thread);
    };
    switch (request.kind) {
      case "issue.take":
        await command({ type: "thread.takeIssue", issue: request.issue });
        return { ok: true, lines: request.issue === null ? ["this thread holds no issue now"] : [`this thread holds issue #${request.issue}`] };
      case "pr.open": {
        const r = (await rpc.call("thread.openPullRequest", {
          threadId, title: request.title, body: request.body, draft: request.draft,
          merge: request.merge, mergeMethod: request.mergeMethod, maxRounds: request.maxRounds,
          ...(request.attachments.length ? { attachments: request.attachments } : {}),
          ...(request.reviews === undefined ? {} : { reviews: request.reviews }),
        })) as { number: number; url: string; reviewers?: string[] };
        return { ok: true, lines: [
          `opened pull request #${r.number} ${r.url}`,
          ...attachedLine(request.attachments),
          ...reviewersLine(r.reviewers, request.reviews),
          ...policyLine(request.merge, request.mergeMethod, (r.reviewers ?? []).length),
        ] };
      }
      case "pr.review": {
        const r = (await rpc.call("thread.requestReview", {
          threadId, ...(request.count === undefined ? {} : { count: request.count }),
        })) as { number: number; reviewers: string[]; required: number };
        return { ok: true, lines: [
          `started ${r.reviewers.length} automated review${r.reviewers.length === 1 ? "" : "s"} of pull request #${r.number}`,
          `pull request #${r.number} now needs ${r.required} sign-off${r.required === 1 ? "" : "s"} before covey calls it ready. Each reviewer comments on the pull request; covey sends you what it says. Do not read the review yourself and do not comment for it`,
        ] };
      }
      case "review.decide": {
        const r = (await rpc.call("thread.reviewDecide", {
          threadId, verdict: request.verdict, body: request.body,
          ...(request.attachments.length ? { attachments: request.attachments } : {}),
        })) as { number: number; url: string; signedOff: number; required: number };
        const tagged = `the comment carries the tagline that says a machine wrote it`;
        return { ok: true, lines: request.verdict === "approve"
          ? [`signed off on pull request #${r.number} ${r.url}`, ...attachedLine(request.attachments),
             `${r.signedOff} of ${r.required} automated reviews have signed off; ${tagged}`,
             "this review thread is archived. There is nothing more to do: stop the turn"]
          : [`asked for changes on pull request #${r.number} ${r.url}`, ...attachedLine(request.attachments),
             `${tagged}. Covey holds the merge until you sign off, and sends you a turn when the author pushes. Stop the turn now`] };
      }
      case "review.status": {
        const snap = (await rpc.call("thread.snapshot", { threadId, limit: 1 })) as { thread: Thread };
        return { ok: true, lines: describeReview(snap.thread) };
      }
      case "pr.comment": {
        const r = (await rpc.call("thread.commentPullRequest", {
          threadId, body: request.body,
          ...(request.attachments.length ? { attachments: request.attachments } : {}),
        })) as { number: number; url: string };
        return { ok: true, lines: [`commented on pull request #${r.number}${r.url ? ` ${r.url}` : ""}`, ...attachedLine(request.attachments)] };
      }
      case "pr.watch":
        await command({ type: "thread.watch", number: request.number, merge: request.merge, mergeMethod: request.mergeMethod, maxRounds: request.maxRounds });
        return { ok: true, lines: request.number === null ? ["the watch is stopped"] : [`watching pull request #${request.number}`, ...policyLine(request.merge, request.mergeMethod)] };
      case "pr.policy":
        await command({ type: "thread.setMerge", merge: request.merge, mergeMethod: request.mergeMethod });
        return { ok: true, lines: policyLine(request.merge, request.mergeMethod ?? "merge") };
      case "pr.status":
        return { ok: true, lines: await status() };
    }
  } catch (e: any) {
    return { ok: false, lines: [String(e?.message ?? e)] };
  } finally {
    rpc.close();
  }
}

function attachedLine(attachments: PullRequestAttachment[]): string[] {
  return attachments.length ? [`attached ${attachments.map((a) => a.name).join(", ")}; each renders inline on GitHub`] : [];
}

/**
 * What the agent is told about the reviewers that started, or did not.
 *
 * A daemon that answered with no `reviewers` at all is one older than the
 * automated review, and it says nothing rather than "none started": the two
 * are different facts, and only one of them asks the reader to go and look.
 */
function reviewersLine(reviewers: string[] | undefined, asked: number | undefined): string[] {
  if (reviewers === undefined) return [];
  if (asked === 0) return ["no automated review: --no-review was passed, so covey requires no sign-off"];
  if (reviewers.length === 0) return ["no automated review started; see the notes in this thread for why. covey requires no sign-off"];
  return [`started ${reviewers.length} automated review${reviewers.length === 1 ? "" : "s"}: each is a thread of its own that reads the change and comments on the pull request. covey sends you what it says, and will not call the pull request ready until it signs off. do not review your own change, and do not answer for the reviewer`];
}

function policyLine(merge: MergePolicy, method: MergeMethod, reviewers = 0): string[] {
  const gate = reviewers > 0 ? " and the automated review signs off" : "";
  return [merge === "auto"
    ? `merge policy: auto. covey merges (${method}) once the checks pass against the current base${gate} and no review asks for changes. covey sends each checks verdict, review and comment to this thread as a message; do not poll`
    : "merge policy: manual. a person merges, or runs `covey pr policy auto`. covey sends each checks verdict, review and comment to this thread as a message; do not poll"];
}

/** The loop's state on one thread, in lines the agent can read. Pure. */
export function describeThread(t: Thread): string[] {
  const lines: string[] = [];
  lines.push(t.issue ? `issue: #${t.issue.number}${t.issue.title ? ` ${t.issue.title}` : ""}${t.issue.url ? ` ${t.issue.url}` : ""}` : "issue: none taken");
  lines.push(t.branch ? `branch: ${t.branch}` : "branch: none");
  lines.push(t.pullRequest ? `pull request: #${t.pullRequest.number} ${t.pullRequest.url} into ${t.pullRequest.base}` : "pull request: none opened through covey");
  const w = t.watch;
  if (!w) lines.push("watch: none");
  else {
    lines.push(`watch: ${w.state}${w.reason ? ` (${w.reason})` : ""}`);
    lines.push(`merge policy: ${w.merge} (${w.mergeMethod}); rounds used: ${w.rounds} of ${w.maxRounds}`);
    if (w.readiness) lines.push(w.readiness.ready ? "ready to merge: yes" : `ready to merge: no (${w.readiness.why})`);
    if (w.error) lines.push(`last poll error: ${w.error}`);
  }
  lines.push(...reviewLines(t));
  return lines;
}

/**
 * The automated review of this thread's pull request, in lines.
 *
 * The counting is `reviewStanding` in `@covey/protocol`, which the merge gate
 * reads too: a status that disagreed with the gate would be worse than none.
 */
export function reviewLines(t: Thread): string[] {
  const review = t.watch?.review;
  if (!review || review.required <= 0) return ["review: none required"];
  const s = reviewStanding(review);
  const parts = [`${s.signedOff} of ${s.required} signed off`];
  if (s.asking) parts.push(`${s.asking} asking for changes`);
  if (s.waiting) parts.push(`${s.waiting} reviewing`);
  if (s.dropped) parts.push(`${s.dropped} dropped`);
  return [`review: ${parts.join(", ")}`, ...review.reviewers.map(reviewerLine)];
}

function reviewerLine(r: ReviewerRecord): string {
  const word = r.state === "signedOff" ? "signed off" : r.state === "changesRequested" ? "asks for changes" : r.state === "dropped" ? "dropped" : "reviewing";
  return `  reviewer ${r.index} (thread ${r.threadId.slice(0, 8)}): ${word}${r.note ? ` — ${r.note}` : ""}`;
}

/** What a review thread is for, and where every reviewer of the set stands. */
export function describeReview(t: Thread): string[] {
  const r = t.reviewOf;
  if (!r) return ["this thread reviews no pull request: `covey review` runs inside a review thread, which covey starts when a pull request is opened"];
  const lines = [
    `reviewing: pull request #${r.number} ${r.url}`,
    `branch: ${r.branch} into ${r.base}`,
    `you are reviewer ${r.index} of ${r.of}; the change was written by thread ${r.authorThreadId}`,
  ];
  const w = t.watch;
  lines.push(w ? `watch: ${w.state}${w.reason ? ` (${w.reason})` : ""}; pushes read: ${w.rounds} of ${w.maxRounds}` : "watch: none");
  lines.push("say `covey review approve` or `covey review changes --body \"…\"` when you have read the change");
  return lines;
}

/**
 * The socket. Node 22 has `WebSocket` built in, so this needs no package —
 * which matters, because this runs in every agent's shell.
 */
export async function openRpc(url: string): Promise<Rpc> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("connection refused"));
  });
  let id = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (typeof m.id !== "number") return; // a push, which this command never subscribes to
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m.result);
    else w.reject(new Error(m.error?.message ?? "the daemon refused"));
  };
  ws.onclose = () => { for (const w of waiting.values()) w.reject(new Error("the daemon closed the connection")); waiting.clear(); };
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => ws.close(),
  };
}
