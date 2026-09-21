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
import type { BaseHead, RunMemberRef, RunMemberState } from "@covey/protocol";
import type { BranchCommit, CommentEntry, GhHost, IssueFacts, PullRequestFacts } from "./gh.js";

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
  /** How many times each read ran, so a test can prove a poll happened or did not. */
  readonly reads: { pullRequest: number; comments: number };
  readonly options: FakeHostOptions;
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const merges: { number: number; method: string }[] = [];
  const opened: FakeHost["opened"] = [];
  const reads = { pullRequest: 0, comments: 0 };
  const failing = () => { if (options.fail) throw options.fail; };
  const host: FakeHost = {
    merges,
    opened,
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
    async revList(_base, branch) {
      return options.revLists?.[branch] ?? [];
    },
  };
  if (options.canMerge) {
    host.mergePullRequest = async (number, method) => {
      if (options.mergeFail) throw options.mergeFail;
      merges.push({ number, method });
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
