import { test } from "node:test";
import assert from "node:assert/strict";
import { menuHeight, menuWindowStart, MENU_ROWS, type MenuRow } from "./composerMenu.js";

const rows = (n: number): MenuRow[] => Array.from({ length: n }, (_, i) => ({ key: `r${i}`, label: `r${i}`, hint: "" }));

test("the menu is as tall as its rows plus the hint, and never taller than the window", () => {
  assert.equal(menuHeight({ rows: rows(3), index: 0, empty: "" }), 4);
  assert.equal(menuHeight({ rows: rows(40), index: 0, empty: "" }), MENU_ROWS + 1);
});

test("an empty menu is one line saying why", () => {
  assert.equal(menuHeight({ rows: [], index: 0, empty: "no command matches" }), 1);
});

test("the window follows the cursor, and stops at the ends of the list", () => {
  const n = 20;
  assert.equal(menuWindowStart(n, 0), 0);
  assert.equal(menuWindowStart(n, MENU_ROWS - 1), 0);
  assert.equal(menuWindowStart(n, MENU_ROWS), 1);
  assert.equal(menuWindowStart(n, n - 1), n - MENU_ROWS);
  assert.equal(menuWindowStart(3, 2), 0);
});
