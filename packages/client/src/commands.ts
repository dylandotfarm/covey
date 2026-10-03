import type { SlashCommandInfo, ThreadCommands } from "@covey/protocol";

/**
 * The `/` prefix in a composer.
 *
 * Two lists feed the menu. The SDK owns the long one — the daemon reads it off
 * the live session and sends it down with the thread — and a client may hold
 * a short list of commands it answers itself. They are merged here, and every
 * entry says which list it came from, so the code that sends a turn can tell
 * a command it must run from one it must hand to the agent.
 *
 * Everything in this module is pure, and it runs in node and in a browser:
 * the TUI and the web client both draw their menu from it. The keys, the
 * paint and the wire all live elsewhere; this decides only what the menu
 * holds and what accepting a row does to the draft.
 */

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
 * answered with nothing, and the caller paints the two differently. A local
 * command with the same name as an SDK one hides the SDK one.
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

/** The text of a row: `/name <args>`. */
export function commandLabel(command: SlashCommandInfo): string {
  return command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`;
}

/**
 * The commands covey answers itself, in every client (#16).
 *
 * One list, here, because a command the TUI offers and the phone does not is a
 * command the reader cannot find. Each entry is a command against covey's own
 * store rather than a prompt for the agent, so `coveyCommand` below takes the
 * line out of the send path and the client runs it instead.
 *
 * A command here hides the SDK command of the same name. `/clear` is that
 * case: Claude Code has one of its own, and it empties the model's context
 * and leaves covey's transcript on the screen, which reads as a command that
 * did nothing.
 */
export const COVEY_COMMANDS: SlashCommandInfo[] = [
  { name: "clear", description: "empty this conversation and name the thread again", argumentHint: "", source: "covey" },
];

/**
 * The covey command `text` is, or `null` when the line goes to the agent.
 *
 * The name has to stand alone. Every command here takes no argument, so
 * `/clear` is the command and `/clear the deck` is a sentence that starts with
 * a slash — which the agent reads, as it reads any other prose.
 */
export function coveyCommand(text: string): SlashCommandInfo | null {
  const name = text.trim().toLowerCase();
  if (!name.startsWith("/")) return null;
  return COVEY_COMMANDS.find((c) => c.name === name.slice(1)) ?? null;
}
