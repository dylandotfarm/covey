/**
 * The one seam between the integration logic and the outside world.
 *
 * Everything above this file is pure: it takes facts and returns a verdict.
 * This file is the only place that starts a process. Tests pass a fake host,
 * so no test reaches the network and no test merges anything.
 *
 * Two rules hold here:
 *  - `read` refuses a command that can change state. The allow-list below is
 *    the whole of it, and `assertReadOnly` proves the refusal.
 *  - `mergePullRequest` is the only method that changes anything. It sits
 *    alone so a reader can see every mutation in one place.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BaseHead, MemberDiff } from "@covey/protocol";

const run = promisify(execFile);

/** Longest one `gh` or `git` call may take. GitHub is slow under load. */
const CALL_TIMEOUT_MS = 30_000;

/** The raw shape of one entry of `gh pr view --json statusCheckRollup`. */
export interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  /** CheckRun: `COMPLETED`, `IN_PROGRESS`, `QUEUED`, `WAITING`, `PENDING`. */
  status?: string;
  /** CheckRun: `SUCCESS`, `FAILURE`, `SKIPPED`, `CANCELLED`, `NEUTRAL`, ... */
  conclusion?: string;
  /** StatusContext: `SUCCESS`, `PENDING`, `FAILURE`, `ERROR`, `EXPECTED`. */
  state?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

/** Everything the gate and the queue read about one pull request. */
export interface PullRequestFacts {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft: boolean;
  mergeable: MemberDiff["mergeable"];
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  files: string[];
  checks: RollupEntry[];
}

/** One commit that a branch holds and the base branch does not. */
export interface BranchCommit {
  sha: string;
  subject: string;
}

/**
 * What the integration half asks of `gh` and `git`. Every method reads. The
 * one method that writes is named so, and a test host leaves it out.
 */
export interface GhHost {
  /** The pull request on `branch`, or null when the member opened none. */
  pullRequest(branch: string): Promise<PullRequestFacts | null>;
  /** The tip of the base branch, which the staleness test compares against. */
  baseHead(base: string): Promise<BaseHead | null>;
  /** `git rev-list origin/<base>..origin/<branch>`, newest first. */
  revList(base: string, branch: string): Promise<BranchCommit[]>;
  /** Merge a pull request. The only call that changes anything. */
  mergePullRequest?(number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
}

// ---- the read-only guard ----------------------------------------------------

/** The `gh` commands the read path may run, as `<command> <subcommand>`. */
const READ_ONLY_GH = new Set([
  "pr view",
  "pr list",
  "pr diff",
  "pr checks",
  "issue view",
  "issue list",
  "run view",
  "run list",
  "repo view",
  "repo list",
  "config get",
  "api",
]);

/**
 * Refuse any `gh` call that can change state. The read path passes every
 * argument list through here first, so a mutation cannot reach the process
 * table by mistake — a wrong subcommand throws instead.
 *
 * `gh api` needs its own test. A method other than GET, or any field flag,
 * makes the call a write however the path is spelled.
 */
export function assertReadOnly(args: string[]): void {
  const words = args.filter((a) => !a.startsWith("-"));
  const command = words[0] ?? "";
  const key = READ_ONLY_GH.has(command) ? command : `${command} ${words[1] ?? ""}`;
  if (!READ_ONLY_GH.has(key)) {
    throw new Error(`gh ${key.trim()} is not a read-only command; the read path refuses it`);
  }
  if (command !== "api") return;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") {
      const method = (args[i + 1] ?? "").toUpperCase();
      if (method !== "GET") throw new Error(`gh api --method ${method} writes; the read path refuses it`);
    }
    if (a.startsWith("--method=")) {
      const method = a.slice("--method=".length).toUpperCase();
      if (method !== "GET") throw new Error(`gh api --method ${method} writes; the read path refuses it`);
    }
    // `-f` / `-F` / `--input` make gh send a body, which turns the call into a POST.
    if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") {
      throw new Error(`gh api ${a} sends a body, which writes; the read path refuses it`);
    }
  }
}

// ---- the real host ----------------------------------------------------------

/**
 * `gh` in a checkout, with no `--repo`: the remote of the checkout is the
 * repository, exactly as it is for the agent that works there. `gh api` reads
 * the same remote through its `{owner}` and `{repo}` placeholders.
 */
async function gh(cwd: string, args: string[]): Promise<string> {
  assertReadOnly(args);
  const { stdout } = await run("gh", args, { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const PR_FIELDS = [
  "number", "headRefName", "baseRefName", "headRefOid", "state", "isDraft",
  "mergeable", "mergeStateStatus", "additions", "deletions", "files", "statusCheckRollup",
].join(",");

export interface RealHostOptions {
  /** A checkout of the repository. Every call runs there. */
  cwd: string;
  /**
   * Let this host merge. Off by default, so a host built for a report or a dry
   * run has no way to change anything.
   */
  allowMerge?: boolean;
}

export function realGhHost(options: RealHostOptions): GhHost {
  const { cwd } = options;

  // `origin/<branch>` is a local ref and goes stale, and a stale ref is exactly
  // what the audit must not read: the commits it looks for were pushed a minute
  // ago. Fetch once per host, and share the one fetch between every branch.
  let fetched: Promise<void> | null = null;
  const fetchOnce = () => (fetched ??= run("git", ["fetch", "--quiet", "origin"], { cwd, timeout: CALL_TIMEOUT_MS })
    .then(() => undefined, () => undefined));

  const host: GhHost = {
    async pullRequest(branch) {
      let out: string;
      try {
        out = await gh(cwd, ["pr", "view", branch, "--json", PR_FIELDS]);
      } catch {
        return null; // no pull request on that branch
      }
      const j = JSON.parse(out);
      return {
        number: j.number,
        headRefName: j.headRefName,
        baseRefName: j.baseRefName,
        headRefOid: j.headRefOid,
        state: j.state,
        isDraft: !!j.isDraft,
        mergeable: j.mergeable ?? "UNKNOWN",
        mergeStateStatus: j.mergeStateStatus ?? "UNKNOWN",
        additions: j.additions ?? 0,
        deletions: j.deletions ?? 0,
        files: (j.files ?? []).map((f: { path: string }) => f.path),
        checks: j.statusCheckRollup ?? [],
      };
    },

    async baseHead(base) {
      try {
        const out = await gh(cwd, ["api", `repos/{owner}/{repo}/commits/${base}`, "--jq", "{oid:.sha,committedAt:.commit.committer.date}"]);
        const j = JSON.parse(out);
        return j.oid && j.committedAt ? { oid: j.oid, committedAt: j.committedAt } : null;
      } catch {
        return null;
      }
    },

    async revList(base, branch) {
      await fetchOnce();
      try {
        const { stdout } = await run(
          "git",
          ["rev-list", "--format=%H%x09%s", "--no-commit-header", `origin/${base}..origin/${branch}`],
          { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        );
        return parseRevList(stdout);
      } catch {
        return [];
      }
    },
  };

  if (options.allowMerge) {
    host.mergePullRequest = async (number, method) => {
      // The only mutation in this half of the run. Everything above refuses
      // before it gets here; this call trusts that and does the merge.
      await run("gh", ["pr", "merge", String(number), `--${method}`], { cwd, timeout: CALL_TIMEOUT_MS });
    };
  }
  return host;
}

/** Split `<sha>\t<subject>` lines. Kept pure so a test can feed it real output. */
export function parseRevList(stdout: string): BranchCommit[] {
  const commits: BranchCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      commits.push({ sha: line.trim(), subject: "" });
      continue;
    }
    commits.push({ sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() });
  }
  return commits;
}
