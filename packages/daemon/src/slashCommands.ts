import type { SlashCommandInfo } from "@covey/protocol";

/** The shape the SDK gives us, kept structural so the module stays pure. */
export interface SdkSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

/**
 * Turn the SDK's command list into the protocol's, and drop the commands a
 * remote client must not offer.
 *
 * `terminal` holds the names the session reported as `terminal_slash_commands`:
 * commands whose behaviour belongs to the terminal that runs the CLI, such as
 * `/exit` and `/statusline`. The SDK tells a client that is not that terminal
 * to hide them, and the covey TUI is on another machine as often as not. A
 * command is also hidden when one of its aliases is on that list, because the
 * two names run the same code.
 */
export function toCommandInfos(commands: SdkSlashCommand[], terminal: string[] = []): SlashCommandInfo[] {
  const hidden = new Set(terminal.map(stripSlash));
  const seen = new Set<string>();
  const out: SlashCommandInfo[] = [];
  for (const c of commands) {
    const name = stripSlash(c.name ?? "");
    if (!name || seen.has(name)) continue;
    const aliases = (c.aliases ?? []).map(stripSlash).filter((a) => a.length > 0 && a !== name);
    if (hidden.has(name) || aliases.some((a) => hidden.has(a))) continue;
    seen.add(name);
    out.push({
      name,
      description: c.description ?? "",
      argumentHint: c.argumentHint ?? "",
      ...(aliases.length > 0 ? { aliases } : {}),
      source: "sdk",
    });
  }
  return out;
}

/** `/usage` and `usage` name the same command; the protocol stores it bare. */
function stripSlash(s: string): string {
  return s.trim().replace(/^\/+/, "");
}
