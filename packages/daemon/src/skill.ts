/**
 * Link the `/covey` skill into the user's Claude Code skills.
 *
 * Claude Code reads `~/.claude/skills/<name>/SKILL.md`, and the skill lives
 * in the checkout at `skills/covey`. The daemon links the one to the other
 * every time it starts, so the internal update — pull, build, restart — puts
 * the new skill in place on every machine of the pool, and `pnpm run setup`
 * is not the only path to it. A link, not a copy: a pull updates the skill
 * the way it updates the launcher.
 *
 * The rules are the launcher's. A link that already points here is left as
 * it is. A link of ours that points at a checkout that is gone is replaced.
 * Anything else at that path is somebody's, and is left alone with a word.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SkillLink =
  | { did: "linked" | "kept" | "replaced"; path: string; target: string }
  | { did: "left"; path: string; why: string }
  | { did: "none"; why: string };

/** `<root>/skills/covey`, the skill this checkout ships. */
export function skillSource(root: string): string {
  return join(root, "skills", "covey");
}

/**
 * Put `~/.claude/skills/covey` in place for the checkout at `root`.
 *
 * Pure in its inputs: the root and the home come from the caller, so a test
 * points both at a temporary directory and touches nothing of the user's.
 */
export function linkSkill(root: string | null, home: string): SkillLink {
  if (!root) return { did: "none", why: "this daemon does not run from a checkout" };
  const target = skillSource(root);
  if (!existsSync(join(target, "SKILL.md"))) return { did: "none", why: `${target} holds no SKILL.md` };
  const dir = join(home, ".claude", "skills");
  const path = join(dir, "covey");
  const current = linkTarget(path);
  if (current === target) return { did: "kept", path, target };
  if (current !== null) {
    // A link of ours, from a checkout that has moved or gone: replace it.
    // One that points at a live checkout elsewhere is that checkout's, and
    // a machine with two checkouts keeps the one it chose.
    if (current.endsWith(join("skills", "covey")) && !existsSync(current)) {
      rmSync(path);
      symlinkSync(target, path, "dir");
      return { did: "replaced", path, target };
    }
    return { did: "left", path, why: `it points at ${current}` };
  }
  if (existsSync(path)) return { did: "left", path, why: "it is a directory of the user's, not a link" };
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, path, "dir");
  return { did: "linked", path, target };
}

/** Where a symlink points, resolved; null when `path` is not a symlink. */
function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

/** One log line for what `linkSkill` did. */
export function describeSkillLink(r: SkillLink): string {
  switch (r.did) {
    case "linked": return `skill: linked ${r.path} → ${r.target}`;
    case "replaced": return `skill: relinked ${r.path} → ${r.target}`;
    case "kept": return `skill: ${r.path} already points here`;
    case "left": return `skill: left ${r.path} alone, ${r.why}; run pnpm run setup --force to replace it`;
    case "none": return `skill: not linked, ${r.why}`;
  }
}
