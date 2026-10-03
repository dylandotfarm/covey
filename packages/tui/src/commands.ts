import type { SlashCommandInfo } from "@covey/protocol";
import { COVEY_COMMANDS, commandLabel } from "@covey/client";
import type { MenuRow } from "./composerMenu.js";

/**
 * The `/` prefix in the composer.
 *
 * The logic — which name the draft is part way through, which commands match
 * it, what accepting one does to the draft — lives in `@covey/client`
 * (`commands.ts` there), because the web client draws the same menu. This
 * module keeps what is the TUI's own: the commands covey answers itself, and
 * the shape of a row for `Composer`.
 */
export { acceptCommand, commandMenu, commandToken, coveyCommand } from "@covey/client";

/**
 * Commands covey answers itself, without the agent (#16).
 *
 * The list is `COVEY_COMMANDS` in `@covey/client`, because the phone offers
 * the same menu; `Store.sendTurn` is where one is taken out of the send path
 * and run. A local command with the same name as an SDK one hides the SDK one.
 */
export const LOCAL_COMMANDS: SlashCommandInfo[] = COVEY_COMMANDS;

/** The row to paint for a command: `/name <args>` and what it does. */
export function commandRows(commands: SlashCommandInfo[]): MenuRow[] {
  return commands.map((c) => ({ key: c.name, label: commandLabel(c), hint: c.description }));
}
