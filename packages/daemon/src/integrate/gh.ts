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
 *  - `mergePullRequest` and `createPullRequest` are the only methods that
 *    change anything. They sit together at the end, so a reader can see every
 *    mutation in one place, and a host has neither unless it was built with it.
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

/** Everything the gate, the queue and the watch read about one pull request. */
export interface PullRequestFacts {
  number: number;
  url: string;
  /** The login that opened it, or null when `gh` did not say. */
  author: string | null;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft: boolean;
  mergeable: MemberDiff["mergeable"];
  mergeStateStatus: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty when no rule asks for a review. */
  reviewDecision: string;
  additions: number;
  deletions: number;
  files: string[];
  checks: RollupEntry[];
  /** Every review submitted on it, as `gh pr view --json reviews` lists them. */
  reviews: ReviewEntry[];
  /** The conversation comments, as `gh pr view --json comments` lists them. */
  comments: CommentEntry[];
}

/** One review on a pull request. */
export interface ReviewEntry {
  id: string;
  author: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  body: string;
  submittedAt: string | null;
  url: string | null;
}

/**
 * One comment on a pull request: a conversation comment, or a line comment
 * from a review. A line comment names its file and line; the other kind
 * leaves both null.
 */
export interface CommentEntry {
  id: string;
  author: string;
  body: string;
  createdAt: string | null;
  url: string | null;
  path: string | null;
  line: number | null;
}

/** What the watch reads about the issue a thread takes. */
export interface IssueFacts {
  number: number;
  title: string;
  url: string;
  state: string;
}

/** What `createPullRequest` needs. The branch is pushed first. */
export interface PullRequestDraft {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
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
  /** The pull request with this number, or null when there is none. */
  pullRequestByNumber(number: number): Promise<PullRequestFacts | null>;
  /** The line comments of every review on a pull request. */
  reviewComments(number: number): Promise<CommentEntry[]>;
  /** One issue, or null when `gh` cannot read it. */
  issue(number: number): Promise<IssueFacts | null>;
  /** The tip of the base branch, which the staleness test compares against. */
  baseHead(base: string): Promise<BaseHead | null>;
  /** `git rev-list origin/<base>..origin/<branch>`, newest first. */
  revList(base: string, branch: string): Promise<BranchCommit[]>;
  /** Merge a pull request. One of the two calls that change anything. */
  mergePullRequest?(number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
  /** Push a branch and open a pull request for it. The other call that changes anything. */
  createPullRequest?(draft: PullRequestDraft): Promise<{ number: number; url: string }>;
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
  "number", "url", "author", "headRefName", "baseRefName", "headRefOid", "state", "isDraft",
  "mergeable", "mergeStateStatus", "reviewDecision", "additions", "deletions", "files", "statusCheckRollup",
  "reviews", "comments",
].join(",");

/** The line comments of a pull request, one JSON row each, as the watch reads them. */
const LINE_COMMENTS_JQ = "[.[] | {id: (.id | tostring), author: (.user.login // \"\"), body: (.body // \"\"), createdAt: .created_at, url: .html_url, path: .path, line: (.line // .original_line)}]";

/** The shape `gh pr view --json` prints, as `PullRequestFacts`. Pure, so a test can feed it real output. */
export function parsePullRequest(j: any): PullRequestFacts {
  return {
    number: j.number,
    url: String(j.url ?? ""),
    author: j.author?.login ? String(j.author.login) : null,
    headRefName: j.headRefName,
    baseRefName: j.baseRefName,
    headRefOid: j.headRefOid,
    state: j.state,
    isDraft: !!j.isDraft,
    mergeable: j.mergeable ?? "UNKNOWN",
    mergeStateStatus: j.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: String(j.reviewDecision ?? ""),
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    files: (j.files ?? []).map((f: { path: string }) => f.path),
    checks: j.statusCheckRollup ?? [],
    reviews: (j.reviews ?? []).map((r: any): ReviewEntry => ({
      id: String(r.id ?? ""),
      author: String(r.author?.login ?? ""),
      state: String(r.state ?? ""),
      body: String(r.body ?? ""),
      submittedAt: r.submittedAt ?? null,
      url: r.url ?? null,
    })),
    comments: (j.comments ?? []).map((c: any): CommentEntry => ({
      id: String(c.id ?? ""),
      author: String(c.author?.login ?? ""),
      body: String(c.body ?? ""),
      createdAt: c.createdAt ?? null,
      url: c.url ?? null,
      path: null,
      line: null,
    })),
  };
}

export interface RealHostOptions {
  /** A checkout of the repository. Every call runs there. */
  cwd: string;
  /**
   * Let this host merge. Off by default, so a host built for a report or a dry
   * run has no way to change anything.
   */
  allowMerge?: boolean;
  /** Let this host push a branch and open a pull request. Off by default, as above. */
  allowCreate?: boolean;
}

export function realGhHost(options: RealHostOptions): GhHost {
  const { cwd } = options;

  // `origin/<branch>` is a local ref and goes stale, and a stale ref is exactly
  // what the audit must not read: the commits it looks for were pushed a minute
  // ago. Fetch once per host, and share the one fetch between every branch.
  let fetched: Promise<void> | null = null;
  const fetchOnce = () => (fetched ??= run("git", ["fetch", "--quiet", "origin"], { cwd, timeout: CALL_TIMEOUT_MS })
    .then(() => undefined, () => undefined));

  // `gh pr view` takes a branch name or a number. Either way, no pull request
  // is a null and not an error, because "none yet" is an ordinary answer.
  const view = async (ref: string): Promise<PullRequestFacts | null> => {
    let out: string;
    try {
      out = await gh(cwd, ["pr", "view", ref, "--json", PR_FIELDS]);
    } catch {
      return null;
    }
    return parsePullRequest(JSON.parse(out));
  };

  const host: GhHost = {
    pullRequest: (branch) => view(branch),
    pullRequestByNumber: (number) => view(String(number)),

    async reviewComments(number) {
      try {
        const out = await gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate", "--jq", LINE_COMMENTS_JQ]);
        // `--paginate` prints one array per page; the pages are concatenated.
        const rows: CommentEntry[] = [];
        for (const page of out.split("\n").filter((l) => l.trim())) rows.push(...(JSON.parse(page) as CommentEntry[]));
        return rows.map((c) => ({ ...c, line: typeof c.line === "number" ? c.line : null }));
      } catch {
        return [];
      }
    },

    async issue(number) {
      try {
        const out = await gh(cwd, ["issue", "view", String(number), "--json", "number,title,url,state"]);
        const j = JSON.parse(out);
        return { number: Number(j.number), title: String(j.title ?? ""), url: String(j.url ?? ""), state: String(j.state ?? "") };
      } catch {
        return null;
      }
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

  // ---- the writes. Nothing above this line can change a repository. -------

  if (options.allowMerge) {
    host.mergePullRequest = async (number, method) => {
      // Everything above refuses before it gets here; this call trusts that
      // and does the merge.
      await run("gh", ["pr", "merge", String(number), `--${method}`], { cwd, timeout: CALL_TIMEOUT_MS });
    };
  }
  if (options.allowCreate) {
    host.createPullRequest = async (draft) => {
      // The branch goes up first: `gh pr create` needs it on the remote, and
      // asks a question nobody can answer when it is not.
      await run("git", ["push", "--set-upstream", "origin", draft.branch], { cwd, timeout: CALL_TIMEOUT_MS });
      const args = ["pr", "create", "--head", draft.branch, "--base", draft.base, "--title", draft.title, "--body", draft.body, ...(draft.draft ? ["--draft"] : [])];
      const { stdout } = await run("gh", args, { cwd, timeout: CALL_TIMEOUT_MS });
      const url = parsePullRequestUrl(stdout);
      if (!url) throw new Error(`gh opened the pull request but did not print its URL: ${stdout.trim()}`);
      return url;
    };
  }
  return host;
}

/** The URL `gh pr create` prints, and the number in it. Pure, for the test. */
export function parsePullRequestUrl(stdout: string): { number: number; url: string } | null {
  for (const line of stdout.split("\n").reverse()) {
    const m = line.trim().match(/^(https?:\/\/\S+\/pull\/(\d+))\/?$/);
    if (m) return { number: Number(m[2]), url: m[1]! };
  }
  return null;
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
