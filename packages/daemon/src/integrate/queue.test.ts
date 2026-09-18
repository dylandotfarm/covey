import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemberDiff, RunMemberState } from "@covey/protocol";
import { baseBrokenBrief, buildQueue, diffSize, fileOverlap, mergeOrder, type QueueEntry } from "./queue.js";
import { member } from "./testHost.js";

function entry(branch: string, additions: number, deletions: number, files: string[], over: Partial<MemberDiff> = {}, label?: string, state: RunMemberState = "review"): QueueEntry {
  return {
    member: member({ branch, label: label ?? branch, state }),
    diff: { branch, additions, deletions, files, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", ...over },
  };
}

test("the largest diff merges first, so the cheapest change pays the re-merge tax", () => {
  // The real pair from the run: the operator took the green +1213 ahead of the
  // pending +1222 and gained nothing, while costing the larger one a full round.
  const order = mergeOrder([entry("small", 1213, 0, []), entry("large", 1222, 0, [])]);
  assert.deepEqual(order.map((e) => e.member.branch), ["large", "small"]);
});

test("a 235 line change re-merges three times rather than a 1222 line one once", () => {
  const order = mergeOrder([
    entry("a", 200, 35, []), entry("b", 1222, 0, []), entry("c", 400, 10, []),
  ]);
  assert.deepEqual(order.map((e) => e.member.branch), ["b", "c", "a"]);
  assert.equal(diffSize(order[2]!.diff), 235);
});

test("deletions count: a change is what it touches, not what it adds", () => {
  const order = mergeOrder([entry("adds", 100, 0, []), entry("removes", 10, 300, [])]);
  assert.deepEqual(order.map((e) => e.member.branch), ["removes", "adds"]);
});

test("ties break on the branch name, so a member never reads two different positions", () => {
  const a = mergeOrder([entry("zeta", 100, 0, []), entry("alpha", 100, 0, [])]);
  const b = mergeOrder([entry("alpha", 100, 0, []), entry("zeta", 100, 0, [])]);
  assert.deepEqual(a.map((e) => e.member.branch), ["alpha", "zeta"]);
  assert.deepEqual(b.map((e) => e.member.branch), ["alpha", "zeta"]);
});

test("overlap is the sorted intersection of the two file lists", () => {
  const a = entry("a", 1, 1, ["z.ts", "a.ts", "m.ts"]).diff;
  const b = entry("b", 1, 1, ["m.ts", "a.ts", "q.ts"]).diff;
  assert.deepEqual(fileOverlap(a, b), ["a.ts", "m.ts"]);
  assert.deepEqual(fileOverlap(a, entry("c", 1, 1, ["q.ts"]).diff), []);
});

test("the queue names what lands before a member, and in which file", () => {
  const composer = "packages/tui/src/components/Composer.tsx";
  const queue = buildQueue([
    entry("issue-11-attachment-inline-tags", 200, 35, [composer, "packages/tui/src/lines.ts"], {}, "#11 attachment tags"),
    entry("issue-9-composer-prefixes", 900, 322, [composer, "packages/tui/src/tagPrefix.ts"], {}, "#9 composer prefixes"),
  ]);
  assert.deepEqual(queue.map((q) => q.position), [1, 2]);
  assert.equal(queue[0]!.branch, "issue-9-composer-prefixes", "1222 lines goes first");
  assert.equal(queue[0]!.meets.length, 0);
  assert.deepEqual(queue[1]!.meets, [{
    branch: "issue-9-composer-prefixes",
    label: "#9 composer prefixes",
    files: [composer],
  }]);
  assert.match(queue[1]!.brief, /You are 2 of 2/);
  assert.match(queue[1]!.brief, /#9 composer prefixes/);
  assert.match(queue[1]!.brief, /Composer\.tsx/);
  assert.ok(!queue[1]!.brief.includes("lines.ts"), "only the shared file is named, not the whole branch");
});

test("every brief says that overlap is a hint, and that one party merges", () => {
  for (const q of buildQueue([entry("a", 10, 0, ["x.ts"]), entry("b", 5, 0, ["x.ts"])])) {
    assert.match(q.brief, /a hint, not the answer/);
    assert.match(q.brief, /Do not merge your own pull request — one party merges/);
  }
});

test("the first member is told nothing lands before it", () => {
  const queue = buildQueue([entry("a", 10, 0, ["x.ts"]), entry("b", 5, 0, ["x.ts"])]);
  assert.match(queue[0]!.brief, /Nothing lands before you/);
});

test("a member that shares no file is told so, rather than left to guess", () => {
  const queue = buildQueue([entry("a", 10, 0, ["x.ts"]), entry("b", 5, 0, ["y.ts"])]);
  assert.match(queue[1]!.brief, /1 change lands before yours, and it touches no file you touch/);
});

test("a withdrawn or merged member is not in the queue", () => {
  const queue = buildQueue([
    entry("open", 10, 0, ["x.ts"]),
    entry("gone", 900, 0, ["x.ts"], {}, "#15 rebind esc", "withdrawn"),
    entry("landed", 800, 0, ["x.ts"], {}, "#20 wheel", "merged"),
  ]);
  assert.deepEqual(queue.map((q) => q.branch), ["open"]);
  assert.equal(queue[0]!.total, 1);
});

test("a brief counts the files it does not list, rather than running to a page", () => {
  const many = Array.from({ length: 9 }, (_, i) => `packages/tui/src/f${i}.ts`);
  const queue = buildQueue([entry("big", 900, 0, many), entry("small", 10, 0, many)]);
  assert.match(queue[1]!.brief, /and 3 more/);
  assert.equal(queue[1]!.meets[0]!.files.length, 9, "the record keeps them all; only the text is bounded");
});

test("the base-broken brief names one owner and tells the rest to leave the file alone", () => {
  const text = baseBrokenBrief("`tsc -b --noEmit` is invalid with composite project references", "#7", ["package.json"]);
  assert.match(text, /#7 repairs it/);
  assert.match(text, /Leave `package\.json` alone/);
  assert.match(text, /fifteen agents that each fix the same line/);
});
