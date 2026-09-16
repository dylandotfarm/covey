import React from "react";
import { render } from "ink";
import type { BuildInfo, MachineSource, SavedMachine } from "@covey/protocol";
import { Store, type RelaunchRequest } from "./store.js";
import { App } from "./components/App.js";
import { enableMouse, disableMouse } from "./mouse.js";

export interface RunTuiOptions {
  machines: SavedMachine[];
  /** The checkout this client runs from, so it can offer to update itself. */
  source?: MachineSource | null;
  /** The build this client runs, to compare with each machine's. */
  build?: BuildInfo | null;
  /** Reads the newest mtime of the files this client was loaded from, in ms. */
  watchBuild?: () => number;
  /** The CLI sets this when it can relaunch us after we exit. */
  canRelaunch?: boolean;
  /** A line to show on arrival, e.g. the result of the update we just did. */
  notice?: { text: string; tone: "info" | "error" | "success" };
}

export interface RunTuiResult {
  /** Present when the user asked for a relaunch; the CLI carries it out. */
  relaunch?: RelaunchRequest;
}

export async function runTui(opts: RunTuiOptions): Promise<RunTuiResult> {
  const store = new Store(opts.machines, { source: opts.source, build: opts.build, watchBuild: opts.watchBuild, canRelaunch: opts.canRelaunch, notice: opts.notice });
  // alternate screen so the TUI doesn't pollute scrollback
  process.stdout.write("\x1b[?1049h\x1b[H");
  // Take over the mouse so selection can be scoped to one pane. Shift+drag
  // still falls through to the terminal's own selection in every emulator we
  // know of, which is the escape hatch for copying across panes.
  enableMouse();
  const inst = render(<App store={store} />, {
    exitOnCtrlC: false,
    patchConsole: true,
    // Without this, terminals send a bare CR for both Enter and Shift+Enter and
    // swallow Cmd entirely, so those bindings are unreachable no matter what we
    // do in the handler. `auto` probes for support and silently stays off where
    // it isn't available (Apple Terminal, older emulators), which is why every
    // binding it enables keeps a ctrl-based fallback.
    // `reportEventTypes` is what makes modified special keys (cmd+delete,
    // alt+arrows) parse with the right modifier — without it they fall back to
    // the legacy CSI form, where Ink folds super into meta. It also turns on
    // key *release* events, which App.tsx has to drop or every key doubles.
    kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes", "reportEventTypes"] },
  });
  // Mouse reporting must be switched off even on an abnormal exit, or the
  // user's shell is left emitting escape codes on every click.
  const restore = () => { disableMouse(); process.stdout.write("\x1b[?1049l"); };
  process.on("exit", restore);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { restore(); process.exit(0); });
  }
  await inst.waitUntilExit();
  store.shutdown();
  restore();
  return { relaunch: store.getState().relaunch ?? undefined };
}

export { loadConfig, saveConfig, localMachine } from "./config.js";
export { buildSkew, buildLine, type BuildSkew } from "./build.js";
export type { RelaunchRequest } from "./store.js";
