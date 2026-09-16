import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionItem, TimelineItem } from "@covey/protocol";
import { renderItem, lineText, type QuestionUi } from "./lines.js";
import { currentAsk, takeAnswer } from "./question.js";

const OPTS = [{ label: "Postgres", description: "a server" }, { label: "SQLite", description: "a file" }];

function item(extra: Partial<QuestionItem>): QuestionItem {
  return {
    id: "req:1", threadId: "t", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "question", requestId: "r1", questions: [], answers: [], status: "pending", ...extra,
  } as QuestionItem;
}

const paint = (it: TimelineItem, question?: QuestionUi) =>
  renderItem(it, { width: 80, expanded: new Set(), question }).map(lineText).join("\n");

test("one question paints its options, the free-text row and no counter", () => {
  const out = paint(item({ questions: [{ question: "Which database?", options: OPTS }] }), { cursor: 1, answered: [] });
  assert.match(out, /\? Which database\?/);
  assert.match(out, /1\. Postgres — a server/);
  assert.match(out, /❯ 2\. SQLite/);
  assert.match(out, /type your own answer/);
  assert.doesNotMatch(out, /\bof 1\b/, "a lone question is not counted");
});

test("a question with no options offers free text only", () => {
  const out = paint(item({ questions: [{ question: "Which port?", options: null }] }), { cursor: 0, answered: [] });
  assert.match(out, /❯ type an answer/);
  assert.doesNotMatch(out, /press a number/);
});

test("a four-question call shows one question at a time, counted", () => {
  const qs = [
    { question: "Which database?", options: OPTS },
    { question: "Which cache?", options: OPTS },
    { question: "Which port?", options: null },
    { question: "Which log level?", options: null },
  ];
  const out = paint(item({ questions: qs }), { cursor: 0, answered: [] });
  assert.match(out, /\? Which database\? \(1 of 4\)/);
  assert.doesNotMatch(out, /Which cache\?/, "questions ahead of the current one stay hidden");
  assert.doesNotMatch(out, /Which port\?/);
});

test("answering advances to the next question and keeps the answer above it", () => {
  const qs = [
    { question: "Which database?", options: OPTS },
    { question: "Which cache?", options: OPTS },
  ];
  const out = paint(item({ questions: qs }), { cursor: 0, answered: ["SQLite"] });
  assert.match(out, /\? Which database\? \(1 of 2\)\n {4}→ SQLite/);
  assert.match(out, /\? Which cache\? \(2 of 2\)/);
  assert.match(out, /❯ 1\. Postgres/, "the cursor sits on the second question now");
  // The options of an answered question are not repeated; its answer says it all.
  assert.equal(out.match(/1\. Postgres/g)?.length, 1);
});

test("a settled call shows every question with its answer", () => {
  const done = item({
    questions: [{ question: "One?", options: OPTS }, { question: "Two?", options: OPTS }],
    answers: ["Postgres", "SQLite"],
    status: "answered",
  });
  const out = paint(done);
  assert.match(out, /\? One\? \(1 of 2\)\n {4}→ Postgres/);
  assert.match(out, /\? Two\? \(2 of 2\)\n {4}→ SQLite/);
  assert.doesNotMatch(out, /type your own answer/);
});

test("an expired call still shows what was asked", () => {
  const out = paint(item({
    questions: [{ question: "One?", options: OPTS }, { question: "Two?", options: OPTS }],
    status: "expired",
  }));
  assert.match(out, /\? One\?/);
  assert.match(out, /\? Two\?/);
});

test("a question stored before the list reads through the old fields", () => {
  const legacy = {
    id: "req:1", threadId: "t", turnId: null, seq: 1, createdAt: "", updatedAt: "",
    kind: "question", requestId: "r1", prompt: "Which database?", options: OPTS,
    answer: "SQLite", status: "answered",
  } as unknown as TimelineItem;
  const out = paint(legacy);
  assert.match(out, /\? Which database\?/);
  assert.match(out, /1\. Postgres — a server/);
  assert.match(out, /→ SQLite/);
});

/**
 * Regression, the client's stepping: every answer used to go straight out as
 * the whole response, so a call with more than one question was answered by
 * the first choice the user made and the rest were never asked.
 */
test("a three-question call sends nothing until the last question is answered", () => {
  const it = item({ questions: [
    { question: "Which database?", options: OPTS },
    { question: "Which cache?", options: OPTS },
    { question: "Which log level?", options: null },
  ] });

  const one = takeAnswer(it, [], "SQLite");
  assert.equal(one.send, null, "the first of three answers is not the response");
  assert.deepEqual(one.answered, ["SQLite"]);

  const two = takeAnswer(it, one.answered, "Postgres");
  assert.equal(two.send, null, "the second of three answers is not the response either");

  const three = takeAnswer(it, two.answered, "debug");
  assert.deepEqual(three.send, ["SQLite", "Postgres", "debug"], "the last answer sends the whole set");
});

test("a lone question still sends on its only answer", () => {
  const it = item({ questions: [{ question: "Which database?", options: OPTS }] });
  assert.deepEqual(takeAnswer(it, [], "SQLite").send, ["SQLite"]);
});

/**
 * Regression, the client's stepping: the options offered used to come from the
 * first question every time, so questions two to four could not be answered.
 */
test("the cursor walks on to the next question's own options", () => {
  const it = item({ questions: [
    { question: "Which database?", options: OPTS },
    { question: "Which cache?", options: [{ label: "Redis" }, { label: "Memcached" }] },
  ] });
  assert.equal(currentAsk(it, [])?.question, "Which database?");
  assert.deepEqual(currentAsk(it, ["SQLite"])?.options?.map((o) => o.label), ["Redis", "Memcached"]);
  assert.equal(currentAsk(it, ["SQLite", "Redis"]), null, "nothing is left to ask");
});
