import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunIssue, RunPullRequest } from "@covey/protocol";
import { assertReadOnly } from "./integrate/gh.js";

const run = promisify(execFile);

/**
 * `gh`, in a checkout, as the daemon resolves it.
 *
 * A run reads its task list and its pull requests through the daemon on the
 * machine that holds the checkout, for the same reason it reads its tools
 * there: that daemon has the `PATH`, the git remote and the login. A client on
 * another machine has none of the three.
 */
export async function gh(cwd: string, args: string[], timeout = 20_000): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  // This helper reads. The guard makes that a rule rather than an intention:
  // a mutating command throws here instead of reaching the process table.
  assertReadOnly(args);
  try {
    const { stdout } = await run("gh", args, { cwd, timeout, maxBuffer: 8 << 20 });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, error: ghError(e) };
  }
}

/**
 * What went wrong with a `gh` call, in words the user can act on. One
 * mapping for every caller, so a logged-out machine reads the same in a run's
 * issue list and in the repository pick.
 */
export function ghError(e: unknown): string {
  const err = e as { code?: string; stderr?: string; message?: string };
  if (err?.code === "ENOENT") return "gh is not installed on this machine";
  const text = String(err?.stderr ?? err?.message ?? e).trim();
  if (/auth login|not logged in|authentication/i.test(text)) return "gh is not logged in on this machine: run `gh auth login` there";
  return text.split("\n").filter(Boolean)[0] ?? "gh failed";
}

/**
 * The issues a run's task list names.
 *
 * One bad number must not cost the operator the other nineteen, so a number
 * that cannot be read is left out and its reason goes in `error`. The caller
 * shows both.
 */
export async function readIssues(cwd: string, numbers: number[]): Promise<{ issues: RunIssue[]; error: string | null }> {
  const issues: RunIssue[] = [];
  const errors: string[] = [];
  // Six at a time: enough that twenty issues take one round trip's worth of
  // wall clock, few enough that the API does not start refusing.
  for (let i = 0; i < numbers.length; i += 6) {
    const batch = numbers.slice(i, i + 6);
    const answers = await Promise.all(batch.map(async (n) => ({ n, r: await gh(cwd, ["issue", "view", String(n), "--json", "number,title,url,state,labels"]) })));
    for (const { n, r } of answers) {
      if (!r.ok) { errors.push(`#${n}: ${r.error}`); continue; }
      try {
        const j = JSON.parse(r.out);
        issues.push({
          number: Number(j.number),
          title: String(j.title ?? ""),
          url: String(j.url ?? ""),
          state: String(j.state ?? ""),
          labels: Array.isArray(j.labels) ? j.labels.map((l: any) => String(l?.name ?? l)) : [],
        });
      } catch { errors.push(`#${n}: gh answered something that is not JSON`); }
    }
  }
  issues.sort((a, b) => a.number - b.number);
  return { issues, error: errors.length ? errors.join(" · ") : null };
}

/**
 * The pull request for one branch, or null when there is none.
 *
 * Identity and state only. Whether the change *may merge*, and in what order it
 * should, is issue #45; this call must not grow a `mergeable` field.
 */
export async function pullRequestFor(cwd: string, branch: string): Promise<RunPullRequest | null> {
  const r = await gh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,title,url,state,isDraft,headRefName"]);
  if (!r.ok) throw new Error(r.error);
  let list: any[];
  try { list = JSON.parse(r.out); } catch { return null; }
  const pr = Array.isArray(list) ? list[0] : null;
  if (!pr) return null;
  return {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    url: String(pr.url ?? ""),
    state: String(pr.state ?? ""),
    isDraft: !!pr.isDraft,
    headRefName: String(pr.headRefName ?? branch),
    readAt: new Date().toISOString(),
  };
}
