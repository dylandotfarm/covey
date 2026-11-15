/**
 * What ink paints for the secrets panel — issue #126.
 *
 * `secrets.test.ts` states which names the panel lists. This states that they
 * reach the screen: the panel's note is a paragraph, and a paragraph is the
 * one thing a height-bounded box must never be handed unmeasured. `OverlayView`
 * gives its frame `height` and budgets the list at `height - 10`, and nothing
 * in that sum counts the rows the note wraps to. Add a sentence and ink wraps
 * it inside the box, paints the remainder over the footer, and the row that
 * says which keys work comes out as `· esc closeat it reads.` — with names
 * dropped off the top of the list as well.
 *
 * This is the rule the title bar already keeps in another pane (`barNotice`),
 * and it is why the note says what it says in the room it has.
 *
 * The budget itself is wrong and this does not fix it: a tall list in a short
 * pane overruns on `main` too. What these hold is the line between the two —
 * a pane the panel paints whole stays whole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { OverlayView } from "./components/Overlay.js";
import type { Overlay } from "./store.js";

/** The footer of the secrets panel: the one row that says which keys work. */
const FOOTER = "· esc close";

const KEYS = Array.from({ length: 20 }, (_, i) => `SECRET_NAME_${String(i).padStart(2, "0")}`);

const panel: Overlay = { kind: "secrets", scope: "project", title: "Secrets", targets: [{ machine: "ws://m:3790", ownerId: "p" }] };

/**
 * Render the panel at one pane and give back the last frame, with the escapes
 * taken out so a row is the text a reader sees.
 *
 * `interactive` is spelled out: ink resolves it as
 * `interactive ?? (!isInCi && stdout.isTTY)`, so on a CI runner it goes
 * non-interactive and writes no frame at all until the unmount. `CI=true pnpm
 * test` is what reproduces that.
 */
async function paint(width: number, height: number, keys: string[]): Promise<string[]> {
  const writes: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { writes.push(String(c)); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = width;
  stdout.rows = height;
  (stdout as { isTTY?: boolean }).isTTY = true;
  const app = render(
    React.createElement(OverlayView, { overlay: panel, cursor: 0, filter: "", checked: false, width, height, secretKeys: keys }),
    { stdout, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  const frames = () => writes.filter((w) => w.includes("\n") && w.includes(FOOTER));
  const deadline = Date.now() + 10_000;
  while (frames().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const frame = frames().at(-1) ?? "";
  app.unmount();
  assert.ok(frame, "ink painted no frame at all");
  return frame.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\u001B\].*?\u0007/g, "").split("\n");
}

/**
 * The panes a reader meets. Each is a pane the panel paints whole, measured
 * against the note as it stands; the first is an 80x30 terminal, which is what
 * `App.tsx` hands the overlay as `mainW` and `transcriptH`.
 */
const PANES: [number, number, number][] = [[50, 24, 8], [50, 22, 6], [46, 20, 2], [70, 24, 20], [90, 18, 8]];

for (const [width, height, count] of PANES) {
  test(`the panel's note leaves the footer alone at ${width}x${height} with ${count} names`, async () => {
    const lines = await paint(width, height, KEYS.slice(0, count));
    const foot = lines.findLastIndex((l) => l.includes(FOOTER));
    assert.ok(foot >= 0, "the footer is not on the screen at all");
    // Nothing is painted over the footer's tail. `· esc close` ends the row,
    // and what follows it is the frame's own border and blank.
    const tail = lines[foot]!.split(FOOTER)[1] ?? "";
    assert.equal(tail.replace(/[│\s]/g, ""), "", `something is painted over the footer: ${JSON.stringify(lines[foot])}`);
    // The box closes under the footer rather than over it.
    assert.ok(lines.findIndex((l) => l.includes("╰")) > foot, "the frame does not close under the footer");
    // And the whole panel fits the pane it was given.
    assert.ok(lines.filter((l) => l.trim()).length <= height, "the panel overran the rows it was given");
  });
}
