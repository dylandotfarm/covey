/**
 * What the title bar gives up first (#87).
 *
 * The defect these hold out was not an overflow — every row fitted the
 * terminal. The row simply handed its columns to the wrong things: below about
 * 94 columns the title and the keybinding hint shrank into each other, and the
 * reader kept `al…  …  esc interr…rl+k commands`. So what is measured here is
 * the ranking, and the arithmetic that makes it hold: the sum of what comes
 * back never exceeds the room, whatever the room is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutTitleBar, PART_GAP, RIGHT_GAP, type BarLayout, type BarPart, type BarRight } from "./titleBar.js";
import { width } from "./lines.js";

const HINTS = ["↑↓ browse · enter open · click works too", "↑↓ browse · enter open", "enter open"];
const hint = (forms = HINTS): BarRight => ({ kind: "hint", forms });

/** A project summary's parts: the project, then the machines of its pool. */
const summary: BarPart[] = [{ text: "covey", keep: true }, { text: "1 project · 1 machine" }];
/** An open thread's parts: the title, the project, the pull request. */
const openThread: BarPart[] = [
  { text: "rework the parser so it keeps the comments", keep: true },
  { text: "covey" },
  { text: "PR #87" },
  { text: "" },
];

/** The columns a laid-out row's parts take, gaps and all. */
function partsPainted(out: BarLayout): number {
  let w = 0;
  for (const p of out.parts) if (p) w += (p.gap ? PART_GAP : 0) + width(p.text);
  return w;
}

/** The columns the layout would paint, the right-hand side with them. */
function painted(parts: BarPart[], right: BarRight, room: number): number {
  const out = layoutTitleBar(parts, right, room);
  return partsPainted(out) + (out.right ? RIGHT_GAP + width(out.right) : 0);
}

/**
 * A short name beside a list too long to paint — a project whose pool names
 * three machines, on the pane an 80-column terminal leaves beside the sidebar.
 */
const bigPool: BarPart[] = [
  { text: "ui", keep: true },
  { text: "raspberrypi-four · macbook-pro-16 · thinkpad" },
];

/** What the row reads as, for an assertion a person can check by eye. */
function row(parts: BarPart[], right: BarRight, room: number): string {
  const out = layoutTitleBar(parts, right, room);
  let s = "";
  for (const p of out.parts) if (p) s += (p.gap ? "  " : "") + p.text;
  return out.right ? `${s}  ${out.right}` : s;
}

test("everything is whole when the row is wide enough", () => {
  assert.equal(row(summary, hint(), 116), "covey  1 project · 1 machine  ↑↓ browse · enter open · click works too");
});

test("the hint steps down a form rather than being cut", () => {
  // 42 columns is the pane beside the sidebar at 80: the width the defect was
  // reported at. The longest form wants 9 + 2 + 40; the next fits.
  const at80 = row([{ text: "covey", keep: true }, { text: "pi" }], hint(), 42);
  assert.equal(at80, "covey  pi  ↑↓ browse · enter open");
  const at70 = row([{ text: "covey", keep: true }, { text: "pi" }], hint(), 32);
  assert.equal(at70, "covey  pi  enter open");
});

test("a hint is painted in one of its own forms, or not at all", () => {
  for (let room = 0; room <= 120; room++) {
    const out = layoutTitleBar(summary, hint(), room);
    assert.ok(out.right === "" || HINTS.includes(out.right),
      `at ${room} columns the hint was neither a form nor absent: ${JSON.stringify(out.right)}`);
  }
});

test("the title is never cut to make room for a hint", () => {
  for (let room = 0; room <= 160; room++) {
    const out = layoutTitleBar(openThread, hint(), room);
    if (!out.right) continue;
    assert.equal(out.parts[0]?.text, openThread[0]!.text,
      `at ${room} columns the title was cut with a hint beside it`);
  }
});

test("below every form the row is the title alone", () => {
  // The thread's title is 41 columns, so at 44 not even `enter open` can
  // stand beside it, and the hint is the thing that goes.
  const out = layoutTitleBar(openThread, hint(), 44);
  assert.equal(out.right, "");
  assert.equal(out.parts[0]?.text, "rework the parser so it keeps the comments");
  assert.equal(out.parts[1], null, "the project gave way before the title did");
});

test("a part beside the title is dropped, never shortened to an ellipsis", () => {
  for (let room = 0; room <= 160; room++) {
    const out = layoutTitleBar(openThread, hint(), room);
    for (const [i, p] of out.parts.entries()) {
      if (i === 0 || !p) continue;
      assert.equal(p.text, openThread[i]!.text,
        `at ${room} columns part ${i} was painted cut: ${JSON.stringify(p.text)}`);
    }
  }
});

test("the columns a dropped part gives back are the hint's to use", () => {
  // Measured against what the parts take and not against what they want: the
  // pool is dropped here, so the row is two columns of name and the hint has
  // the rest. Measuring the want left forty-four columns blank with a hint
  // that fits four times over refused.
  assert.equal(row(bigPool, hint(), 46), "ui  ↑↓ browse · enter open · click works too");
  assert.equal(layoutTitleBar(bigPool, hint(), 46).parts[1], null, "the pool is the part that went");
  assert.equal(row(bigPool, hint(), 42), "ui  ↑↓ browse · enter open");
  // Wide enough for the pool, and the hint then takes what is over.
  assert.equal(row(bigPool, hint(), 60), "ui  raspberrypi-four · macbook-pro-16 · thinkpad  enter open");
});

test("a hint is painted whenever one fits beside the parts that are", () => {
  const shortest = HINTS.at(-1)!;
  for (const parts of [summary, openThread, bigPool]) {
    for (let room = 0; room <= 160; room++) {
      const out = layoutTitleBar(parts, hint(), room);
      if (out.right) continue;
      assert.ok(partsPainted(out) + RIGHT_GAP + width(shortest) > room,
        `at ${room} columns ${JSON.stringify(shortest)} fitted beside the parts and no hint was painted`);
    }
  }
});

test("a part with nothing to say takes no columns and no gap", () => {
  const out = layoutTitleBar([{ text: "covey", keep: true }, { text: "" }, { text: "PR #87" }], hint([]), 60);
  assert.equal(out.parts[1], null);
  assert.equal(out.parts[2]?.gap, true, "the gap belongs to the part that follows a painted one");
  assert.equal(row([{ text: "covey", keep: true }, { text: "" }, { text: "PR #87" }], hint([]), 60), "covey  PR #87");
});

test("the first part painted carries no gap, whichever part it is", () => {
  // The title dropped out: at three columns there is nothing to truncate it
  // to. What follows must not then be painted two columns in from the edge.
  const out = layoutTitleBar([{ text: "" }, { text: "PR #87" }], hint([]), 10);
  assert.equal(out.parts[1]?.gap, false);
});

/**
 * A notice is ranked the other way round (#176): it takes its room first and
 * the title gives way, because a failure is the only channel it has and the
 * row the title names is on the screen anyway.
 */
test("a notice takes its room and the title gives way", () => {
  // Cut by the caller to the two columns short of the row that the gap takes,
  // which is what App does with a loud one.
  const text = "could not clone …its yet; push one first";
  assert.equal(width(text), 40);
  const out = layoutTitleBar(openThread, { kind: "notice", text }, 42);
  assert.equal(out.right, text, "the notice is painted as it was given");
  assert.deepEqual(out.parts, [null, null, null, null], "nothing of the title was left room");
});

test("a notice wider than the row is cut here too, from the middle", () => {
  const text = "could not clone github.com/dylandotfarm/hardware: no commits yet";
  const out = layoutTitleBar(openThread, { kind: "notice", text }, 42);
  assert.equal(width(out.right), 40, "two columns short of the row, for the gap");
  const [front, back] = out.right.split("…");
  assert.ok(back !== undefined && text.startsWith(front!) && text.endsWith(back!),
    `both ends of the notice are its own: ${JSON.stringify(out.right)}`);
});

test("a notice short enough leaves the title what is over", () => {
  const out = layoutTitleBar(summary, { kind: "notice", text: "saved" }, 42);
  assert.equal(out.right, "saved");
  assert.equal(out.parts[0]?.text, "covey");
  assert.equal(out.parts[1]?.text, "1 project · 1 machine");
});

/**
 * The claim the whole module exists for. A row that asks for more than it has
 * is a row flex settles, and what flex settles depends on a cached text
 * measurement — which is why the client's mount width used to change this row
 * and no other.
 */
test("the layout never asks for more columns than the room", () => {
  const cases: [BarPart[], BarRight][] = [
    [summary, hint()],
    [openThread, hint()],
    [openThread, hint(["esc esc rewind · ↑ recall · ctrl+k", "↑ recall · ctrl+k", "ctrl+k"])],
    [[{ text: "covey — multi-agent TUI", keep: true }], hint()],
    [openThread, { kind: "notice", text: "could not clone github.com/owner/repo: no commits yet" }],
    [summary, { kind: "notice", text: "saved" }],
    [[{ text: "", keep: true }], hint()],
    [[], hint()],
  ];
  for (const [parts, right] of cases) {
    for (let room = 0; room <= 160; room++) {
      assert.ok(painted(parts, right, room) <= room,
        `${painted(parts, right, room)} columns painted into ${room}: ${JSON.stringify(row(parts, right, room))}`);
    }
  }
});

test("a room of nothing paints nothing", () => {
  const out = layoutTitleBar(openThread, hint(), 0);
  assert.equal(out.right, "");
  assert.deepEqual(out.parts, [null, null, null, null]);
});
