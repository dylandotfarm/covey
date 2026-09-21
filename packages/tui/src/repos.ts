import type { RepoInfo } from "@covey/protocol";
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
