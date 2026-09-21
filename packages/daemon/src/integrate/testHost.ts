/**
 * A `GhHost` that starts no process.
 *
 * Every test in this directory uses it, and so does the watch test in the
 * engine. Nothing here reaches GitHub, nothing here merges, and nothing here
 * opens a pull request anywhere but in memory, so `pnpm test` cannot change
 * the state of a repository however a test is written.
 *
 * The options are read at call time, not copied, so a test can change a pull
 * request between two polls and the fake answers with the new facts.
 */
import type { BaseHead, GitHubIssue, GitHubPullRequest, RunMemberRef, RunMemberState } from "@covey/protocol";
import type { OwnerPlan } from "./attach.js";
import { summariseCheck } from "./checks.js";
import { UploadRefused, type AttachmentUpload, type BranchCommit, type CommentEntry, type GhHost, type IssueFacts, type ItemKind, type PullRequestFacts, type ReviewEvent } from "./gh.js";

export interface FakeHostOptions {
  prs?: Record<string, PullRequestFacts | null>;
  base?: BaseHead | null;
  revLists?: Record<string, BranchCommit[]>;
  /** Line comments by pull request number. */
  lineComments?: Record<number, CommentEntry[]>;
  /** Issues by number. A number not here reads as one `gh` cannot see. */
  issues?: Record<number, IssueFacts>;
  /** Give the fake a merge method. Left out, the fake cannot merge at all. */
  canMerge?: boolean;
  /** Give the fake a create method. Left out, the fake cannot open a pull request. */
  canCreate?: boolean;
  /** Give the fake an upload method. Left out, the fake cannot attach a file. */
  canAttach?: boolean;
  /** Give the fake a comment method. Left out, the fake cannot comment. */
  canComment?: boolean;
  /** Give the fake a review method. Left out, the fake cannot review. */
  canReview?: boolean;
  /** Give the fake close and reopen methods. Left out, the fake cannot close. */
  canClose?: boolean;
  /** The login the fake acts as. `tester` unless a test says. */
  viewer?: string | null;
  /** The body and the author an issue item shows, by number. Optional colour on `issues`. */
  issueBodies?: Record<number, { body?: string; author?: string }>;
  /** The owner's plan, as `repository()` answers it. Free unless a test says. */
  plan?: OwnerPlan;
  /** What GitHub answers to an upload, when a test wants one refused. */
  uploadFail?: { status: number; body: string } | null;
  /** What a poll throws, when a test wants `gh` to fail. */
  fail?: Error | null;
  /** What a merge throws, when a test wants GitHub to refuse one. */
  mergeFail?: Error | null;
}

export interface FakeHost extends GhHost {
  /** Every merge the code under test asked for. A test asserts on this. */
  readonly merges: { number: number; method: string }[];
  /** Every pull request the code under test opened. */
  readonly opened: { branch: string; base: string; title: string; body: string; draft: boolean }[];
  /** Every file the code under test uploaded, without its bytes, with their count. */
  readonly uploads: { name: string; contentType: string; size: number; url: string }[];
  /** Every comment the code under test left, on a pull request or an issue. */
  readonly comments: { number: number; body: string; kind?: ItemKind }[];
  /** Every review the code under test submitted. */
  readonly reviews: { number: number; event: ReviewEvent; body: string }[];
  /** Every close and reopen the code under test asked for. */
  readonly stateChanges: { number: number; kind: ItemKind; to: "closed" | "open" }[];
  /** How many times each read ran, so a test can prove a poll happened or did not. */
  readonly reads: { pullRequest: number; comments: number };
  readonly options: FakeHostOptions;
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const merges: { number: number; method: string }[] = [];
  const opened: FakeHost["opened"] = [];
  const uploads: FakeHost["uploads"] = [];
  const comments: FakeHost["comments"] = [];
  const reviews: FakeHost["reviews"] = [];
  const stateChanges: FakeHost["stateChanges"] = [];
  const reads = { pullRequest: 0, comments: 0 };
  const failing = () => { if (options.fail) throw options.fail; };
  const READ_AT = "2026-09-21T12:00:00Z";
  const byNumber = (number: number) => Object.values(options.prs ?? {}).find((p) => p?.number === number) ?? null;
  const host: FakeHost = {
    merges,
    opened,
    uploads,
    comments,
    reviews,
    stateChanges,
    reads,
    options,
    async pullRequest(branch) {
      failing();
      reads.pullRequest++;
      return options.prs?.[branch] ?? null;
    },
    async pullRequestByNumber(number) {
      failing();
      reads.pullRequest++;
      return Object.values(options.prs ?? {}).find((p) => p?.number === number) ?? null;
    },
    async reviewComments(number) {
      failing();
      reads.comments++;
      return options.lineComments?.[number] ?? [];
    },
    async issue(number) {
      return options.issues?.[number] ?? null;
    },
    async baseHead() {
      return options.base ?? null;
    },
    async repository() {
      return { id: 1, plan: options.plan ?? "free" };
    },
    async revList(_base, branch) {
      return options.revLists?.[branch] ?? [];
    },
    async itemKind(number) {
      failing();
      if (byNumber(number)) return "pull";
      if (options.issues?.[number]) return "issue";
      return null;
    },
    async issueItem(number) {
      const i = options.issues?.[number];
      if (!i) return null;
      const colour = options.issueBodies?.[number] ?? {};
      return {
        kind: "issue", number: i.number, title: i.title, url: i.url, state: i.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
        author: colour.author ?? "someone", body: colour.body ?? "", createdAt: READ_AT, closedAt: null, labels: [],
        comments: comments.filter((c) => c.number === number && c.kind === "issue").map((c) => ({ author: options.viewer ?? "tester", body: c.body, createdAt: READ_AT, url: null })),
        viewer: options.viewer === undefined ? "tester" : options.viewer, readAt: READ_AT,
      } satisfies GitHubIssue;
    },
    async pullRequestItem(number) {
      const p = byNumber(number);
      if (!p) return null;
      const state = p.state === "MERGED" ? "MERGED" : p.state === "CLOSED" ? "CLOSED" : "OPEN";
      return {
        kind: "pull", number: p.number, title: `PR ${p.number}`, url: p.url, state, author: p.author, body: "", createdAt: READ_AT,
        closedAt: null, labels: [], comments: p.comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt, url: c.url })),
        viewer: options.viewer === undefined ? "tester" : options.viewer, readAt: READ_AT,
        isDraft: p.isDraft, headRefName: p.headRefName, baseRefName: p.baseRefName, mergeable: p.mergeable, reviewDecision: p.reviewDecision,
        additions: p.additions, deletions: p.deletions, files: p.files, checks: p.checks.map(summariseCheck),
        reviews: p.reviews.map((r) => ({ author: r.author, state: r.state, body: r.body, submittedAt: r.submittedAt, url: r.url })),
        mergedAt: state === "MERGED" ? READ_AT : null,
      } satisfies GitHubPullRequest;
    },
  };
  if (options.canMerge) {
    host.mergePullRequest = async (number, method) => {
      if (options.mergeFail) throw options.mergeFail;
      merges.push({ number, method });
    };
  }
  if (options.canAttach) {
    host.uploadAttachment = async (file: AttachmentUpload) => {
      if (options.uploadFail) throw new UploadRefused(options.uploadFail.status, options.uploadFail.body);
      const url = `https://github.com/user-attachments/assets/${uploads.length + 1}-${file.name}`;
      uploads.push({ name: file.name, contentType: file.contentType, size: file.bytes.byteLength, url });
      return { url };
    };
  }
  if (options.canComment) {
    host.commentPullRequest = async (number, body) => {
      comments.push({ number, body, kind: "pull" });
      // The comment joins the facts, so the read that follows shows it.
      byNumber(number)?.comments.push({ id: String(comments.length), author: options.viewer ?? "tester", body, createdAt: READ_AT, url: null, path: null, line: null });
      return { url: `https://github.com/o/r/pull/${number}#issuecomment-${comments.length}` };
    };
    host.commentIssue = async (number, body) => {
      comments.push({ number, body, kind: "issue" });
      return { url: `https://github.com/o/r/issues/${number}#issuecomment-${comments.length}` };
    };
  }
  if (options.canReview) {
    host.reviewPullRequest = async (number, event, body) => {
      reviews.push({ number, event, body });
      const state = event === "approve" ? "APPROVED" : event === "request_changes" ? "CHANGES_REQUESTED" : "COMMENTED";
      const p = byNumber(number);
      if (p) {
        p.reviews.push({ id: String(reviews.length), author: options.viewer ?? "tester", state, body, submittedAt: READ_AT, url: null });
        if (event !== "comment") p.reviewDecision = state;
      }
    };
  }
  if (options.canClose) {
    host.closeItem = async (number, kind) => {
      stateChanges.push({ number, kind, to: "closed" });
      const p = byNumber(number);
      if (p) p.state = "CLOSED";
      const i = options.issues?.[number];
      if (i) i.state = "CLOSED";
    };
    host.reopenItem = async (number, kind) => {
      stateChanges.push({ number, kind, to: "open" });
      const p = byNumber(number);
      if (p) p.state = "OPEN";
      const i = options.issues?.[number];
      if (i) i.state = "OPEN";
    };
  }
  if (options.canCreate) {
    host.createPullRequest = async (draft) => {
      opened.push({ ...draft });
      // The new pull request joins the facts, so the poll that follows finds
      // it — exactly as GitHub would answer once `gh pr create` returns.
      const number = 100 + opened.length;
      options.prs ??= {};
      options.prs[draft.branch] = pr({ number, headRefName: draft.branch, baseRefName: draft.base, isDraft: draft.draft, checks: [] });
      return { number, url: options.prs[draft.branch]!.url };
    };
  }
  return host;
}

export function member(over: Partial<RunMemberRef> & { branch: string }): RunMemberRef {
  return {
    memberId: over.memberId ?? over.branch,
    label: over.label ?? `#0 ${over.branch}`,
    threadId: over.threadId ?? "t-1",
    machineId: over.machineId ?? "m-1",
    branch: over.branch,
    pullRequest: over.pullRequest ?? 1,
    turnRunning: over.turnRunning ?? false,
    state: over.state ?? "review",
  };
}

export function pr(over: Partial<PullRequestFacts> & { number: number }): PullRequestFacts {
  return {
    number: over.number,
    url: over.url ?? `https://github.com/o/r/pull/${over.number}`,
    author: over.author ?? "agent",
    headRefName: over.headRefName ?? "branch",
    baseRefName: over.baseRefName ?? "main",
    headRefOid: over.headRefOid ?? "deadbeef",
    state: over.state ?? "OPEN",
    isDraft: over.isDraft ?? false,
    mergeable: over.mergeable ?? "MERGEABLE",
    mergeStateStatus: over.mergeStateStatus ?? "CLEAN",
    reviewDecision: over.reviewDecision ?? "",
    additions: over.additions ?? 10,
    deletions: over.deletions ?? 1,
    files: over.files ?? ["a.ts"],
    checks: over.checks ?? [],
    reviews: over.reviews ?? [],
    comments: over.comments ?? [],
  };
}

export type { RunMemberState };
