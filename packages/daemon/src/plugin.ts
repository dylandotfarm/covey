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
import type { Project } from "@covey/protocol";

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
 * to read it. The description asked for the words of an issue, so a thread that
 * opened with "fix this bug" never reached for the skill: it pushed with `git`
 * and opened with `gh`, and the daemon then watched no pull request. A reader
 * had to type `/covey` to get the loop. This note is what makes the loop the
 * default, and it goes in the system prompt because that is the one text a
 * session reads before its first turn, on a resume as well as on a start. The
 * description now names the second loop too (#191), the one for work the user
 * only described, so the two say the same thing from either side.
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
 * The review line is here for the same reason as the two rules. A review thread
 * reads the note before it reads its own brief, and a reviewer that pushed a fix
 * to the branch it was asked to read would have made the change nobody reviewed.
 *
 * Change this and the skill together, as with `covey show` and the loop.
 */
export const COVEY_PREAMBLE = `This session runs inside a covey thread. The covey daemon on this machine gave the thread a git worktree on its own branch, and it can push that branch, open a pull request for it, watch the pull request, and merge it. You ask with the \`covey\` command.

Load the \`covey\` skill (\`covey:covey\`) and follow it for that work. Load it in the first turn that takes an issue, pushes a branch, opens or comments on a pull request, shows the reader a file, or reads this thread's secrets. Prefer it over \`gh\` and over a plain \`git push\`; the skill says where \`gh\` still fits.

A message that starts \`covey review:\` means this thread reviews another thread's change. Read that message and the skill's reviewer section; never commit, push or merge on that branch.

Two rules hold before you read the skill, because a person cannot take either act back:

- Never push to the base branch.
- Never merge a pull request yourself, unless the user asked you to merge on their behalf.`;

/**
 * What a thread of a **local** project is told instead.
 *
 * A local project has no repository: one directory, named by the reader, that
 * every thread of the project works in. So every sentence of
 * `COVEY_PREAMBLE` above is false there — no worktree, no branch, no pull
 * request to open and no base branch to keep off. A note that describes work
 * the session cannot do is worse than no note: the loop reads as the default,
 * and a session that believed it spent its first turn looking for a git
 * repository that is not there.
 *
 * It still names the two commands of the skill that do work here, because
 * they are the two a reader of a local thread actually wants: a picture in
 * the conversation, and the project's secrets by name.
 *
 * Keep it a pointer, as the other one is. Change this and the skill's
 * *A local project* section together.
 */
export const COVEY_LOCAL_PREAMBLE = `This session runs inside a covey thread of a **local project**: a directory on this machine that the reader named, with no git repository behind it. Every thread of the project works in that one directory, so files you write there are what the reader comes back to.

There is no branch, no pull request and no issue here. Do not look for a git repository, do not run \`covey issue\` or \`covey pr\`, and do not offer to open one; covey refuses them for this project.

Two commands of the \`covey\` skill (\`covey:covey\`) do work here, and you may load it for either: \`covey show <file>\` puts a picture or a video in this conversation, and \`covey env\` names the secrets this thread may use. Use a secret by writing \`$NAME\`, and never print its value.`;

/**
 * The note that goes with the plugin for one project: the loop for a
 * repository, and the directory for a local project.
 */
export function preambleFor(project: Pick<Project, "kind">): string {
  return project.kind === "local" ? COVEY_LOCAL_PREAMBLE : COVEY_PREAMBLE;
}
