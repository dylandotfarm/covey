import { test } from "node:test";
import assert from "node:assert/strict";
import { tableAt, tableCells } from "./markdown.js";

test("a table is a header, a rule with the header's columns, and the rows under it", () => {
  const src = ["| a | b |", "| --- | ---: |", "| 1 | 2 |", "", "after"];
  assert.deepEqual(tableAt(src, 0), { header: ["a", "b"], rows: [["1", "2"]], align: ["left", "right"], end: 3 });
  // The rule says where the table is: without one there is no table.
  assert.equal(tableAt(["| a | b |", "plain"], 0), null);
  assert.equal(tableAt(["| a | b |", "| --- |"], 0), null, "the rule must have the header's columns");
  assert.equal(tableAt(["a b", "--- | ---"], 0), null, "the header must hold a pipe");
});

test("a row keeps the header's columns, however many cells it has", () => {
  const t = tableAt(["| a | b |", "| - | - |", "| 1 |", "| 1 | 2 | 3 |"], 0)!;
  assert.deepEqual(t.rows, [["1", ""], ["1", "2"]]);
  assert.equal(t.end, 4);
});

test("the rule row gives each column its alignment", () => {
  assert.deepEqual(tableAt(["| a | b | c | d |", "| --- | :-- | :-: | --: |"], 0)!.align,
    ["left", "left", "center", "right"]);
});

test("a border pipe is not a cell, and an escaped pipe stays in one", () => {
  assert.deepEqual(tableCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(tableCells("a | b"), ["a", "b"]);
  assert.deepEqual(tableCells("| x \\| y | z |"), ["x | y", "z"]);
  assert.deepEqual(tableCells("| | note |"), ["", "note"]);
});
