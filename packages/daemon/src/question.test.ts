import { test } from "node:test";
import assert from "node:assert/strict";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { QuestionItem, TimelineItem } from "@covey/protocol";
import { ClaudeSession, type SessionParams, type SessionSink } from "./claude.js";

/**
 * `AskUserQuestion` asks one to four questions in one call. The CLI keys each
 * answer by the verbatim question text and silently drops a question it finds
 * no key for, so these cover the whole map, not only the first entry.
 *
 * The session is never started: `canUseTool` and `buildResponse` only touch the
 * pending map and the sink, so no subprocess is needed.
 */

function ask(...questions: { question: string; header?: string; options?: { label: string; description: string }[] }[]) {
  return { questions: questions.map((q) => ({ ...q, options: q.options ?? [] })) };
}

const OPTS = [{ label: "Postgres", description: "a server" }, { label: "SQLite", description: "a file" }];

/** Put a call in front of the user and hand back the item plus the answer hook. */
function open(input: Record<string, unknown>) {
  const items: TimelineItem[] = [];
  const sink = {
    upsertItem: (i: TimelineItem) => { items.push(i); },
    getItemByToolUse: () => null,
    onStatus: () => {},
    onTurnComplete: () => {},
    onSessionInit: () => {},
    onModelUsed: () => {},
    now: () => "2026-09-15T00:00:00.000Z",
  } as SessionSink;
  const s = new ClaudeSession({ threadId: "t1" } as SessionParams, sink);
  const done = (s as unknown as {
    canUseTool(n: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }): Promise<PermissionResult>;
  }).canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "u1" });
  const item = items[0] as QuestionItem;
  return {
    item,
    items,
    /** Answer the call the way the client does, and read back what the CLI gets. */
    answer(answers: string[]) {
      return settle({ answer: answers[0] ?? "", answers });
    },
    /** Answer the way a client that predates the list does: one answer, no list. */
    answerLegacy(answer: string) {
      return settle({ answer });
    },
  };

  async function settle(extra: { answer: string; answers?: string[] }) {
    const res = s.buildResponse(item.requestId, "allow", extra);
    assert.ok(res, "the request is still pending");
    s.respond(item.requestId, res);
    await done;
    return (res as { behavior: "allow"; updatedInput: Record<string, unknown> }).updatedInput;
  }
}

test("a single question keeps its shape: one ask, one answer, a freeform response", async () => {
  const call = open(ask({ question: "Which database?", header: "Database", options: OPTS }));
  assert.equal(call.item.questions.length, 1);
  assert.equal(call.item.questions[0]!.question, "Which database?");
  assert.equal(call.item.questions[0]!.header, "Database");
  assert.deepEqual(call.item.questions[0]!.options, [{ label: "Postgres", description: "a server" }, { label: "SQLite", description: "a file" }]);

  const input = await call.answer(["DuckDB"]);
  assert.deepEqual(input.answers, { "Which database?": "DuckDB" });
  // The CLI reads `response` in place of the answers map, so a typed answer to
  // a lone question still reports as "The user responded: …".
  assert.equal(input.response, "DuckDB");
});

test("picking an option on a single question sends no freeform response", async () => {
  const call = open(ask({ question: "Which database?", options: OPTS }));
  const input = await call.answer(["SQLite"]);
  assert.deepEqual(input.answers, { "Which database?": "SQLite" });
  assert.equal("response" in input, false);
});

const FOUR = ask(
  { question: "Which database?", options: OPTS },
  { question: "Which port?" },
  { question: "Which cache?", options: OPTS },
  { question: "Which log level?" },
);

/**
 * Regression, `canUseTool`: the item used to hold one prompt, made by joining
 * every question text with newlines, and the options of the first question
 * alone. Questions two to four were gone before the user ever saw them.
 */
test("the item keeps every question the tool asked, each with its own options", async () => {
  const call = open(FOUR);
  assert.deepEqual(call.item.questions.map((q) => q.question), [
    "Which database?", "Which port?", "Which cache?", "Which log level?",
  ]);
  assert.deepEqual(call.item.questions[2]!.options, [{ label: "Postgres", description: "a server" }, { label: "SQLite", description: "a file" }]);
  // A question the tool gave no choices for takes free text.
  assert.equal(call.item.questions[1]!.options, null);
  await call.answer(["SQLite", "3790", "Postgres", "debug"]);
});

/**
 * Regression, `buildResponse`: the map used to carry one entry, for the first
 * question. The CLI drops every question it finds no key for and tells the
 * agent nothing, so the other three answers were lost in silence.
 */
test("every question of a four-question call reaches the CLI", async () => {
  const call = open(FOUR);
  const input = await call.answer(["SQLite", "3790", "Postgres", "debug"]);
  assert.deepEqual(input.answers, {
    "Which database?": "SQLite",
    "Which port?": "3790",
    "Which cache?": "Postgres",
    "Which log level?": "debug",
  });
});

/**
 * Regression, `buildResponse`: a free-text answer used to set `response`
 * whatever the question count. The CLI reads `response` *instead of* the
 * answers map, so one typed answer threw away every other choice.
 */
test("a typed answer to the first of several questions sends no response", async () => {
  const call = open(ask({ question: "Which database?", options: OPTS }, { question: "Which cache?", options: OPTS }));
  const input = await call.answer(["DuckDB", "Postgres"]);
  assert.equal("response" in input, false, "`response` would hide the answers map from the CLI");
  assert.deepEqual(input.answers, { "Which database?": "DuckDB", "Which cache?": "Postgres" });
});

test("the answered item carries one answer for each question, in order", async () => {
  const call = open(ask({ question: "One?", options: OPTS }, { question: "Two?", options: OPTS }));
  await call.answer(["Postgres", "SQLite"]);
  const done = call.items[call.items.length - 1] as QuestionItem;
  assert.equal(done.status, "answered");
  assert.deepEqual(done.answers, ["Postgres", "SQLite"]);
});

test("a question left blank gets no key, rather than an empty answer", async () => {
  const call = open(ask({ question: "One?", options: OPTS }, { question: "Two?", options: OPTS }));
  const input = await call.answer(["Postgres", ""]);
  assert.deepEqual(input.answers, { "One?": "Postgres" });
});

test("the questions and any title pass through untouched, as the tool schema needs", async () => {
  const input = { title: "Before I build it", ...ask({ question: "One?", options: OPTS }), metadata: { source: "test" } };
  const call = open(input);
  const out = await call.answer(["Postgres"]);
  assert.equal(out.title, "Before I build it");
  assert.deepEqual(out.questions, input.questions);
  assert.deepEqual(out.metadata, { source: "test" });
});

test("a client that predates the list still answers a single question", async () => {
  const call = open(ask({ question: "Which database?", options: OPTS }));
  const input = await call.answerLegacy("SQLite");
  assert.deepEqual(input.answers, { "Which database?": "SQLite" });
  assert.equal("response" in input, false);
});
