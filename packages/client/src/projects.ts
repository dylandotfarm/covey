import type { Project } from "@covey/protocol";

/**
 * What makes two projects one project in a sidebar: the repository they clone,
 * and the branch their threads start from.
 *
 * A project on `main` and a project on a feature branch of the same repository
 * are two projects, not one. Each holds its own threads, each branches its
 * worktrees from its own base, and each opens its pull requests against that
 * base. Folded into one row, the reader cannot tell which base the work in
 * front of them starts from, and a new thread can land on the wrong one.
 *
 * The result is null when the project has no remote. Nothing says such a
 * project is the same as any other, so the caller keys it by machine and id.
 *
 * A project with no `baseBranch` works from the remote's default branch and
 * keeps the key it always had, the repository identity alone. A fold the
 * reader made before this therefore still applies.
 */
export function projectPool(p: Pick<Project, "repositoryIdentity" | "baseBranch">): string | null {
  if (!p.repositoryIdentity) return null;
  // The daemon lowercases the identity when it normalises the remote. An older
  // row may not carry it that way, so fold the case here too. The branch keeps
  // its case: git tells `feat/A` from `feat/a`.
  const repo = p.repositoryIdentity.toLowerCase();
  return p.baseBranch ? `${repo}#${p.baseBranch}` : repo;
}
