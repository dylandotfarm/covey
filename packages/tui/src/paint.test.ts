/**
 * What ink actually paints.
 *
 * Every other test here works on the `Line` arrays. This one renders the real
 * `Transcript` into a captured stream, because the whole OSC 8 route rests on
 * a claim about ink that only a render can settle: that the escape sequence
 * reaches the terminal *and* costs no columns while it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, Box } from "ink";
import { Writable } from "node:stream";
import type { TimelineItem } from "@covey/protocol";
import { Transcript, layoutTranscript } from "./components/Transcript.js";
import type { ThreadView } from "./store.js";
import type { LinkContext } from "./links.js";

const ESC = "\u001b";
const local: LinkContext = { localFiles: true, homeDir: "/Users/d" };

const OSC8 = new RegExp(ESC + "\\]8;;([^" + ESC + "\\u0007]*)(?:" + ESC + "\\\\|\\u0007)", "g");
const CSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

/** Every hyperlink target in a frame, in the order the terminal would see them. */
function targets(frame: string): string[] {
  return [...new Set([...frame.matchAll(OSC8)].map((m) => m[1]!).filter(Boolean))];
}

/** What a terminal would show: the escapes gone, the printable columns left. */
function painted(frame: string): string[] {
  return frame.replace(OSC8, "").replace(CSI, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l !== "");
}

/** Render a transcript of one assistant message and return the frame. */
async function paint(text: string, width: number, links?: LinkContext): Promise<string> {
  const item = { id: "a", threadId: "t", turnId: "T1", seq: 1, createdAt: "", updatedAt: "", kind: "assistant", text, streaming: false } as TimelineItem;
  const view = {
    machine: "ws://127.0.0.1:3790", threadId: "t", thread: null,
    items: new Map([["a", item]]), loading: false, error: null, hasMore: false, loadingOlder: false,
  } as unknown as ThreadView;
  const layout = layoutTranscript(view, width - 2, new Set(), 0, true, links);

  let out = "";
  const stdout = new Writable({ write(c, _e, cb) { out += String(c); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = width;
  stdout.rows = 12;
  (stdout as { isTTY?: boolean }).isTTY = true;

  const app = render(
    React.createElement(Box, { flexDirection: "column", width },
      React.createElement(Transcript, { view, layout, height: 10, scrollFromBottom: 0, width, selection: null })),
    { stdout, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 120));
  app.unmount();
  return out;
}

test("ink paints the OSC 8 sequence into the frame", async () => {
  // Without it the terminal is never asked to make anything clickable, and the
  // link field is decoration that nothing reads.
  const frame = await paint("edit /Users/d/a.ts", 40, local);
  assert.deepEqual(targets(frame), ["file:///Users/d/a.ts"]);
});

test("ink gives the OSC 8 sequence no width: the painted columns do not move", async () => {
  // The claim the whole route rests on. If ink counted the escape, every
  // linked line would wrap early and the text after a link would shift.
  const text = "edit /Users/d/a.ts and /Users/d/b.ts then stop";
  const linked = await paint(text, 40, local);
  const plain = await paint(text, 40);
  assert.deepEqual(painted(linked), painted(plain), "the same columns either way");
  assert.deepEqual(targets(plain), [], "the plain run really has none");
  assert.equal(targets(linked).length, 2, "the linked run really has two whole links");
});

test("a link the wrap cuts over two rows is still whole in the frame", async () => {
  const path = "/Users/d/projects/covey/packages/tui/src/lines.ts";
  const frame = await paint(path, 30, local);
  assert.deepEqual(targets(frame), ["file://" + path]);
  assert.equal(painted(frame).join("").replace(/\s/g, ""), path, "no character of the path is lost");
});
