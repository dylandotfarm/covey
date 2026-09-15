import { test } from "node:test";
import assert from "node:assert/strict";
import { browseRows, isFolderName, parentPath, type DirEntry } from "./store.js";

const entries: DirEntry[] = [
  { name: "code", isDir: true, isRepo: false },
  { name: "covey", isDir: true, isRepo: true },
];

test("browseRows puts .. first and new folder last", () => {
  assert.deepEqual(browseRows(entries, ""), [
    { kind: "up" },
    { kind: "dir", name: "code", isRepo: false },
    { kind: "dir", name: "covey", isRepo: true },
    { kind: "new", name: "" },
  ]);
});

test("a filter narrows the directories and names the folder it would create", () => {
  // Enter still opens the match: the new-folder row is never what the cursor
  // starts on while something matches.
  assert.deepEqual(browseRows(entries, "cov"), [
    { kind: "dir", name: "covey", isRepo: true },
    { kind: "new", name: "cov" },
  ]);
  // Nothing matches, so row 0 — where the cursor sits — creates the folder.
  assert.deepEqual(browseRows(entries, "newproj"), [{ kind: "new", name: "newproj" }]);
});

test("a filter that could not name a folder only offers to ask for one", () => {
  assert.deepEqual(browseRows([], ".."), [{ kind: "up" }, { kind: "new", name: "" }]);
  assert.deepEqual(browseRows([], "a/../b"), [{ kind: "new", name: "" }]);
});

test("isFolderName matches what the daemon accepts", () => {
  for (const ok of ["fresh", "a/b", "dot.name", "-x"]) assert.equal(isFolderName(ok), true, ok);
  for (const bad of ["", ".", "..", "/abs", "a//b", "a/./b", "a/../b"]) assert.equal(isFolderName(bad), false, bad);
});

test("parentPath climbs one level and stops at the root", () => {
  assert.equal(parentPath("/home/dylan/code"), "/home/dylan");
  assert.equal(parentPath("/home/dylan/code/"), "/home/dylan");
  assert.equal(parentPath("/home"), "/");
  assert.equal(parentPath("/"), "/");
});
