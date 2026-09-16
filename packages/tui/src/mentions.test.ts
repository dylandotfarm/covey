import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathEntry } from "@covey/protocol";
import { acceptMention, entryRows, filterEntries, mentionAt, mentionDir, mentionLeaf } from "./mentions.js";

const dir = (name: string): PathEntry => ({ name, isDir: true });
const file = (name: string): PathEntry => ({ name, isDir: false });
const ENTRIES = [dir("src"), dir("scripts"), file("README.md"), file("package.json"), file(".gitignore")];

// ---- finding the mention --------------------------------------------------

test("an @ at the start of the draft is a mention", () => {
  assert.deepEqual(mentionAt("@src", 4), { start: 0, end: 4, text: "src" });
});

test("an @ after a space is a mention too: that is the sentence people write", () => {
  assert.deepEqual(mentionAt("read @src/index.ts and say", 17), { start: 5, end: 18, text: "src/index.ts" });
});

test("an @ inside a word is prose, so an email address is left alone", () => {
  assert.equal(mentionAt("mail dylan@example.com now", 20), null);
});

test("the caret says which word is being typed", () => {
  assert.equal(mentionAt("@src @docs", 2)!.text, "src");
  assert.equal(mentionAt("@src @docs", 9)!.text, "docs");
  // Between the two words, the caret belongs to the one it touches.
  assert.equal(mentionAt("@src @docs", 4)!.text, "src");
});

test("a draft with no @ in it has no mention", () => {
  assert.equal(mentionAt("read the file", 5), null);
  assert.equal(mentionAt("", 0), null);
});

test("a bare @ is a mention of the thread's own directory", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, text: "" });
});

test("a newline ends the word, the same as a space", () => {
  assert.equal(mentionAt("@src\nmore", 8), null);
  assert.equal(mentionAt("@src\nmore", 4)!.text, "src");
});

// ---- splitting the path ---------------------------------------------------

test("the directory is everything up to the last slash, and the leaf is the rest", () => {
  assert.equal(mentionDir("src/components/App"), "src/components/");
  assert.equal(mentionLeaf("src/components/App"), "App");
  assert.equal(mentionDir("App"), "");
  assert.equal(mentionLeaf("App"), "App");
  assert.equal(mentionDir("src/"), "src/");
  assert.equal(mentionLeaf("src/"), "");
});

// ---- filtering ------------------------------------------------------------

test("nothing typed yet offers the whole directory, directories first", () => {
  assert.deepEqual(filterEntries(ENTRIES, "").map((e) => e.name), ["src", "scripts", "README.md", "package.json"]);
});

test("a name that starts with the text beats one that merely holds it", () => {
  assert.deepEqual(filterEntries([file("index.ts"), file("src-index.ts"), dir("s")], "s").map((e) => e.name), ["src-index.ts", "s", "index.ts"]);
});

test("the text is matched whatever its case", () => {
  assert.deepEqual(filterEntries(ENTRIES, "readme").map((e) => e.name), ["README.md"]);
});

test("a hidden file stays hidden until the dot is typed", () => {
  assert.deepEqual(filterEntries(ENTRIES, "gi").map((e) => e.name), []);
  assert.deepEqual(filterEntries(ENTRIES, ".g").map((e) => e.name), [".gitignore"]);
});

test("a directory of thousands offers as many as the menu can use", () => {
  const many = Array.from({ length: 4000 }, (_, i) => file(`f${i}.ts`));
  assert.equal(filterEntries(many, "f").length, 50);
});

// ---- taking a row ---------------------------------------------------------

test("taking a file closes the word with a space and leaves the rest of the sentence", () => {
  const draft = "read @sr and say what it does";
  const m = mentionAt(draft, 8)!;
  // The sentence already has a space after the word, so the caret steps over
  // it rather than a second one going in.
  assert.deepEqual(acceptMention(draft, m, file("src.ts")), { value: "read @src.ts and say what it does", caret: 13 });
});

test("taking the last word in the draft adds the space itself", () => {
  const draft = "read @sr";
  const next = acceptMention(draft, mentionAt(draft, 8)!, file("src.ts"));
  assert.deepEqual(next, { value: "read @src.ts ", caret: 13 });
  // The space closes the menu: the caret is no longer inside the word.
  assert.equal(mentionAt(next.value, next.caret), null);
});

test("taking a directory ends in a slash, so the next keystroke carries on into it", () => {
  const draft = "@sr";
  const next = acceptMention(draft, mentionAt(draft, 3)!, dir("src"));
  assert.deepEqual(next, { value: "@src/", caret: 5 });
  // And the mention is still open, on the directory just taken.
  assert.equal(mentionAt(next.value, next.caret)!.text, "src/");
});

test("a second step keeps the directory already chosen", () => {
  const draft = "@src/comp";
  assert.equal(acceptMention(draft, mentionAt(draft, 9)!, file("components")).value, "@src/components ");
});

test("a row says when it is a directory", () => {
  assert.deepEqual(entryRows([dir("src"), file("a.ts")]), [
    { key: "src", label: "src/", hint: "directory" },
    { key: "a.ts", label: "a.ts", hint: "" },
  ]);
});
