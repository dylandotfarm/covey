/**
 * The covey plugin: the `/covey` skill, handed to every session the daemon starts.
 *
 * It is a plugin and not a personal skill because a personal skill does not
 * reach a resumed session. The SDK resumes a session from covey's own store by
 * building a temporary config directory (`claude-resume-<id>`) and pointing
 * `CLAUDE_CONFIG_DIR` at it. That directory carries the transcript, the
 * credentials, `.claude.json` and `settings.json` — and nothing from
 * `~/.claude/skills`. Measured on 2026-09-21: a skill linked there was read
 * by a thread's first session and by none after it, so `/covey` answered
 * "Unknown command" after every restart. A plugin goes to the process as
 * `--plugin-dir`, on every start, resumed or not.
 *
 * The plugin lives in the checkout at `plugin/`, so a pull updates it and
 * the daemon has nothing to install.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** `<root>/plugin`, when the checkout at `root` holds the plugin; else null. */
export function coveyPlugin(root: string | null): string | null {
  if (!root) return null;
  const dir = join(root, "plugin");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) && existsSync(join(dir, "skills", "covey", "SKILL.md")) ? dir : null;
}

/**
 * What every session is told about covey, appended to Claude Code's own system
 * prompt (`claude.ts`, the SDK's `systemPrompt.append`).
 *
 * The plugin on its own puts the skill's name and its description in the
 * session's context and nothing more, so the model decides turn by turn whether
 * to read it. The description asks for the words of an issue, so a thread that
 * opens with "fix this bug" never reaches for the skill: it pushes with `git`
 * and opens with `gh`, and the daemon then watches no pull request. A reader had
 * to type `/covey` to get the loop. This note is what makes the loop the
 * default, and it goes in the system prompt because that is the one text a
 * session reads before its first turn, on a resume as well as on a start.
 *
 * Keep it a pointer, not a copy. The loop itself lives in
 * `plugin/skills/covey/SKILL.md`, which costs nothing until the model loads it,
 * and every word here rides on every turn of every thread. The two rules at the
 * end are the exception: an act a person cannot take back belongs where the
 * session reads it first, which is here.
 *
 * The note goes out only with the plugin (`engine.ts`). A daemon that runs from
 * no checkout hands over neither, because a note that names a skill the session
 * does not have is worse than no note.
 *
 * Change this and the skill together, as with `covey show` and the loop.
 */
export const COVEY_PREAMBLE = `This session runs inside a covey thread. The covey daemon on this machine gave the thread a git worktree on its own branch, and it can push that branch, open a pull request for it, watch the pull request, and merge it. You ask with the \`covey\` command.

Load the \`covey\` skill (\`covey:covey\`) and follow it for that work. Load it in the first turn that takes an issue, pushes a branch, opens or comments on a pull request, shows the reader a file, or reads this thread's secrets. Prefer it over \`gh\` and over a plain \`git push\`; the skill says where \`gh\` still fits.

Two rules hold before you read the skill, because a person cannot take either act back:

- Never push to the base branch.
- Never merge a pull request yourself, unless the user asked you to merge on their behalf.`;
