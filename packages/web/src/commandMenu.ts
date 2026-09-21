/**
 * The `/` popover on the phone.
 *
 * The composer is a `textarea`, so the draft lives in the DOM and not in
 * `State`; the popover is a property of that draft. This file holds the part
 * node can test: what the popover shows for a draft, and how the highlighted
 * row moves. `render.ts` paints it and reads the keys.
 *
 * Which names match is the client's `commandMenu`, so the phone and the TUI
 * rank the same list the same way.
 */
import { commandMenu, commandToken } from "@covey/client";
import type { SlashCommandInfo, ThreadCommands } from "@covey/protocol";

export interface CommandMenu {
  /** The name the draft is part way through; `""` for a bare slash. */
  token: string;
  /** Best match first. */
  commands: SlashCommandInfo[];
  /** One line to show in place of an empty list, saying why it is empty. */
  empty: string;
}

/**
 * The popover for `draft`, or `null` when the draft is not a command name.
 *
 * `commands` is `null` while the thread has never run a session: the SDK has
 * not been asked yet, and the popover says so rather than "no match".
 */
export function commandMenuFor(draft: string, commands: ThreadCommands): CommandMenu | null {
  const token = commandToken(draft);
  if (token === null) return null;
  return {
    token,
    commands: commandMenu(commands, [], token),
    empty: commands === null ? "the commands arrive when this thread starts its first turn" : "no command matches",
  };
}

/** The highlighted row after a step of `delta`, held inside the list. */
export function stepRow(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}
