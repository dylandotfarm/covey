import type { SlashCommandInfo, ThreadCommands } from "@covey/protocol";

/**
 * The `/` prefix in the composer.
 *
 * Two lists feed the menu. The SDK owns the long one — the daemon reads it off
 * the live session and sends it down with the thread — and `LOCAL_COMMANDS`
 * holds the ones covey answers itself. They are merged here, and every entry
 * says which list it came from, so the code that sends a turn can tell a
 * command it must run from one it must hand to the agent.
 *
 * Everything in this module is pure. The keys, the paint and the wire all live
 * elsewhere; this decides only what the menu holds and what accepting a row
 * does to the draft.
 */

/**
 * Commands covey answers itself, without the agent.
 *
 * Empty for now. Issue #16 (`/clear`) adds the first entry here: give it a
 * `source` of `"covey"` and act on it where the composer sends a turn. A local
 * command with the same name as an SDK one hides the SDK one.
 */
export const LOCAL_COMMANDS: SlashCommandInfo[] = [];

/** How many rows of the menu paint at once. */
export const MENU_ROWS = 8;

/** A command name holds letters, digits and these; a path does not. */
const NAME_CHARS = /^[A-Za-z0-9:_-]*$/;

/**
 * The command name the draft is part way through, or `null` when the draft is
 * not one.
 *
 * A prefix counts only at the very start of the draft: a `/` in the middle of
 * a sentence is prose. The name ends at the first space, so `/diff HEAD` is a
 * command with an argument and no menu — the choice was already made. A draft
 * that starts a path, `/usr/local`, is not a command either.
 */
export function commandToken(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const token = draft.slice(1);
  if (!NAME_CHARS.test(token)) return null;
  return token;
}

/**
 * The menu for `token`, best match first.
 *
 * `sdk` is `null` while the thread has never run a session, so nobody has
 * asked the SDK what it supports. That is not the same as a session that
 * answered with nothing, and the caller paints the two differently.
 */
export function commandMenu(sdk: ThreadCommands, local: SlashCommandInfo[], token: string): SlashCommandInfo[] {
  const merged: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const c of [...local, ...(sdk ?? [])]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    merged.push(c);
  }
  const t = token.toLowerCase();
  return merged
    .map((c) => ({ c, rank: rank(c, t) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    .map((r) => r.c);
}

/** Lower is better. -1 drops the command from the menu. */
function rank(c: SlashCommandInfo, token: string): number {
  if (token === "") return 0;
  const name = c.name.toLowerCase();
  if (name === token) return 0;
  if (name.startsWith(token)) return 1;
  if ((c.aliases ?? []).some((a) => a.toLowerCase().startsWith(token))) return 2;
  if (name.includes(token)) return 3;
  return -1;
}

/**
 * The draft after the reader takes a row, and where the caret goes.
 *
 * The name is followed by a space. That both separates the arguments and
 * closes the menu, because a draft with a space in it is no longer a bare
 * command name.
 */
export function acceptCommand(command: SlashCommandInfo): { value: string; caret: number } {
  const value = `/${command.name} `;
  return { value, caret: value.length };
}

/** The row to paint for a command: `/name <args>` and what it does. */
export function commandLabel(c: SlashCommandInfo): string {
  return c.argumentHint ? `/${c.name} ${c.argumentHint}` : `/${c.name}`;
}

/** What the composer paints, and what the keys act on. */
export interface CommandMenuView {
  items: SlashCommandInfo[];
  /** Row the reader is on. Always in range while `items` is not empty. */
  index: number;
  /** False while the daemon has never had a session to ask. */
  known: boolean;
}

/**
 * Rows the menu takes on screen, including the one line it always keeps for
 * the hint or for the reason the list is empty. `App` sizes the transcript
 * from this and `Composer` paints from it, so the two never disagree.
 */
export function commandMenuHeight(m: CommandMenuView): number {
  // An empty menu is one line saying why it is empty, and no hint to give.
  if (m.items.length === 0) return 1;
  return Math.min(MENU_ROWS, m.items.length) + 1;
}

/**
 * First row of the window onto `items`, so the row under the cursor is always
 * painted. The window moves by as little as it can: the list only scrolls once
 * the cursor reaches an edge.
 */
export function menuWindowStart(count: number, index: number): number {
  if (count <= MENU_ROWS) return 0;
  return Math.max(0, Math.min(index - MENU_ROWS + 1, count - MENU_ROWS));
}
