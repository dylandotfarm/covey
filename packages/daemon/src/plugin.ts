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
