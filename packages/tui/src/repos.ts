import type { RepoInfo, RemoteBranches } from "@covey/protocol";
import type { PickOption } from "./store.js";
import { relTime } from "./lines.js";

/**
 * The rows of the repository pick: newest push first, as `gh` lists them,
 * with what a reader picks by beside the name. The description is the label's
 * tail, so a word of it typed into the filter finds the repository too.
 */
export function repoOptions(repos: RepoInfo[]): PickOption[] {
  return repos.map((r) => ({
    id: r.cloneUrl,
    label: r.description ? `${r.nameWithOwner}  ${r.description}` : r.nameWithOwner,
    hint: `${r.isPrivate ? "private" : "public"}${r.pushedAt ? ` · ${relTime(r.pushedAt)}` : ""}`,
  }));
}

/** The id of the row that keeps the remote's default branch as the base. */
export const DEFAULT_BASE = "\0default";

/**
 * The rows of the base-branch pick for a new project: the remote's default
 * branch first, as the row that leaves the base unset, then every other
 * branch by name. A `covey/` branch is a thread's, and there are many; they
 * sit last, marked, so a feature branch is found before them and a thread's
 * branch can still be built on. `current` marks the base the project has now.
 */
export function branchOptions(r: RemoteBranches, current?: string | null): PickOption[] {
  const def = r.defaultBranch;
  const rows: PickOption[] = [{
    id: DEFAULT_BASE,
    label: def ?? "the default branch",
    hint: `default${!current ? " · current" : ""}`,
  }];
  const rest = r.branches.filter((b) => b !== def);
  const own = rest.filter((b) => !b.startsWith("covey/"));
  const threads = rest.filter((b) => b.startsWith("covey/"));
  for (const b of own) rows.push({ id: b, label: b, hint: b === current ? "current" : "" });
  for (const b of threads) rows.push({ id: b, label: b, hint: b === current ? "thread branch · current" : "thread branch" });
  return rows;
}
