/**
 * A `GhHost` that starts no process.
 *
 * Every test in this directory uses it. Nothing here reaches GitHub and
 * nothing here merges, so `pnpm test` cannot change the state of a repository
 * however a test is written.
 */
import type { BaseHead, RunMemberRef, RunMemberState } from "@covey/protocol";
import type { BranchCommit, GhHost, PullRequestFacts } from "./gh.js";

export interface FakeHostOptions {
  prs?: Record<string, PullRequestFacts | null>;
  base?: BaseHead | null;
  revLists?: Record<string, BranchCommit[]>;
  /** Give the fake a merge method. Left out, the fake cannot merge at all. */
  canMerge?: boolean;
}

export interface FakeHost extends GhHost {
  /** Every merge the code under test asked for. A test asserts on this. */
  readonly merges: { number: number; method: string }[];
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const merges: { number: number; method: string }[] = [];
  const host: FakeHost = {
    merges,
    async pullRequest(branch) {
      return options.prs?.[branch] ?? null;
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
      merges.push({ number, method });
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
    headRefName: over.headRefName ?? "branch",
    baseRefName: over.baseRefName ?? "main",
    headRefOid: over.headRefOid ?? "deadbeef",
    state: over.state ?? "OPEN",
    isDraft: over.isDraft ?? false,
    mergeable: over.mergeable ?? "MERGEABLE",
    mergeStateStatus: over.mergeStateStatus ?? "CLEAN",
    additions: over.additions ?? 10,
    deletions: over.deletions ?? 1,
    files: over.files ?? ["a.ts"],
    checks: over.checks ?? [],
  };
}
