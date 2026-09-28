/**
 * One choice on a settings sheet, as the command it stands for (issue #168).
 *
 * `@covey/web`'s `state.ts` decides what a sheet *says* — its rows, its choices,
 * which one is ticked — and both clients read that. What it does not decide is
 * the command, because a command is the one thing a client must say for itself.
 * The page's own mapping is in its `main.ts`; this is the same mapping, and the
 * two have to stay in step.
 *
 * Its own file, with no React Native in it, so node can test it. That is the
 * whole reason it is not in `store.ts`.
 */
import type { Command, PermissionMode } from "@covey/protocol";
import { budgetValue } from "@covey/client";
import type { SheetTarget } from "@covey/web";

/**
 * The command one choice on a sheet stands for, or null when the page names no
 * setting. Kept beside the store rather than in `@covey/web` because it is a
 * command, and a command is the one thing a client must say for itself.
 */
export function sheetCommand(target: SheetTarget, page: string, id: string): Command | null {
  if (target.kind === "thread") {
    const threadId = target.threadId;
    switch (page) {
      case "model": return { type: "thread.setModel", threadId, model: id || null };
      case "mode": return { type: "thread.setPermissionMode", threadId, mode: id as PermissionMode };
      case "streaming": return { type: "thread.setStreaming", threadId, streaming: id === "on" };
      default: return null;
    }
  }
  switch (page) {
    case "model": return { type: "machine.settings", defaultModel: id || null };
    case "mode": return { type: "machine.settings", defaultPermissionMode: (id || null) as PermissionMode | null };
    case "streaming": return { type: "machine.settings", defaultStreaming: id === "on" };
    case "web": return { type: "machine.settings", webEnabled: id === "on" };
    case "live": return { type: "machine.settings", maxLiveSessions: budgetValue(id) };
    case "idle": return { type: "machine.settings", sessionIdleMinutes: budgetValue(id) };
    default: return null;
  }
}
