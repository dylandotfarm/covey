import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapMarkdown } from "./reflow.js";

/** The head of issue #156, as the agent wrote it: prose wrapped at about 86 columns. */
const WRAPPED = `## What happens

A turn ends while a background task still runs. The agent says what it started and
stops. Later the task completes, the CLI hands the notification to the agent, and the
agent works again — reads files, runs commands, writes prose.

covey holds no turn at that moment. \`ClaudeSession.handle\` stamps every item with
\`turnId: this.currentTurnId\` (\`packages/daemon/src/claude.ts:551\`), and \`currentTurnId\`
went to \`null\` at the earlier result.`;

test("a wrapped paragraph becomes one line, and the heading stays", () => {
  const out = unwrapMarkdown(WRAPPED).split("\n");
  assert.equal(out[0], "## What happens");
  assert.equal(out[1], "");
  assert.equal(out[2], "A turn ends while a background task still runs. The agent says what it started and stops. Later the task completes, the CLI hands the notification to the agent, and the agent works again — reads files, runs commands, writes prose.");
  assert.equal(out[3], "");
  assert.ok(out[4]?.startsWith("covey holds no turn at that moment."));
  assert.ok(out[4]?.endsWith("went to `null` at the earlier result."));
  assert.equal(out.length, 5);
});

test("a fenced block keeps every line it had", () => {
  const text = [
    "The log reads:",
    "",
    "```",
    "03:39:38  session started thread=4de61eac resume=false",
    "03:45:53  a background task starts (preflight gate run)",
    "03:46:08  turn 37c74ede completes",
    "```",
    "",
    "Nothing in the turns table holds a row for any of it.",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("a tilde fence, and a fence that holds a shorter run of backticks", () => {
  const text = [
    "~~~",
    "``",
    "a very long line of output that is well past sixty columns wide, by some way",
    "a second line of output that is also well past sixty columns wide, by some way",
    "~~~",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("a column of URLs stays a column", () => {
  const text = [
    "https://github.com/dylandotfarm/covey/actions/runs/1234567890/job/0001",
    "https://github.com/dylandotfarm/covey/actions/runs/1234567890/job/0002",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("a column of short lines stays a column", () => {
  const text = "Machines:\nbox\npi\n";
  assert.equal(unwrapMarkdown(text), text);
});

test("a wrapped list item joins, and the items stay apart", () => {
  const text = [
    "- The checks failed because the build ran out of memory while it linked the",
    "  desktop client, which takes more than the runner has.",
    "- The branch conflicts with main.",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), [
    "- The checks failed because the build ran out of memory while it linked the desktop client, which takes more than the runner has.",
    "- The branch conflicts with main.",
  ].join("\n"));
});

test("a table, a rule and a setext underline are left alone", () => {
  const text = [
    "What happens when a background task outlives the turn that started it",
    "=====================================================================",
    "",
    "| machine | threads | what the daemon reported after the turn had ended |",
    "| --- | --- | --- |",
    "| box | 52 | every item of the work carried no turn id at all, none |",
    "",
    "---",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("an explicit hard break keeps the line under it", () => {
  const text = [
    "The agent says what it started and then stops, and the turn ends there.  ",
    "Later the task completes and the CLI hands the notification to the agent.",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("an indented block is code and never joins", () => {
  const text = [
    "    const id = this.currentTurnId; // the turn this item belongs to, or none",
    "    if (id === null) return; // and here is where the work of the task lands",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("one line, and text with no wrap in it, come back as they were", () => {
  assert.equal(unwrapMarkdown("Closes #189"), "Closes #189");
  assert.equal(unwrapMarkdown(""), "");
  assert.equal(unwrapMarkdown("one\n\ntwo\n"), "one\n\ntwo\n");
});

test("a paragraph already on one line is not touched by the paragraph under it", () => {
  const text = [
    "The daemon pushes the branch itself, so the agent never runs git push for this.",
    "",
    "Closes #189",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("a line wider than the widest terminal is prose the writer wrote", () => {
  const text = [
    "A turn ends while a background task still runs, and the agent says what it started and then stops, which is where this begins to go wrong for the reader.",
    "Later the task completes.",
  ].join("\n");
  assert.equal(unwrapMarkdown(text), text);
});

test("the trailing newline of a body survives", () => {
  const text = "The agent says what it started and then stops, and the turn ends\nthere.\n";
  assert.equal(unwrapMarkdown(text), "The agent says what it started and then stops, and the turn ends there.\n");
});
