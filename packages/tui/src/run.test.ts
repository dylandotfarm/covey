/**
 * Regression tests for a run's task list, its placement, and the resources it
 * hands each member.
 *
 * Every case here is a defect from the run of 2026-09-16, not a wish:
 *
 *  1. All fifteen agents were given the same throwaway port, and one of them
 *     stopped a daemon another agent had started. `allocateResources` is what
 *     makes that impossible; the case below fails the moment two members can
 *     share a port, a `COVEY_HOME` or a `COVEY_CONFIG`.
 *  2. Two tasks could only be done on macOS and one only on the Pi, and the
 *     operator placed all twenty by hand. A placement that ignores a
 *     requirement is worse than no placement, because nobody re-reads it.
 *  3. The brief that told an agent its port told fifteen agents the same port.
 *     A brief is only worth having if every token in it is that member's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunTask } from "@covey/protocol";
import {
  DEFAULT_BRIEF, PLACEMENT_RULE, RUN_PORT_MAX, RUN_PORT_MIN, allocatePorts, allocateResources,
  firstUnmet, meets, memberSlug, parseRequirements, parseTaskList, placeTasks, renderBrief,
  runPortBase, withIssueTitles, type PlacementMachine,
} from "./run.js";

const MAC: PlacementMachine = {
  key: "ws://mac:3790", machineId: "mac", name: "mac", os: "darwin", arch: "arm64",
  tools: ["git", "gh", "node", "pnpm", "tmux"], cpuCount: 12, concurrency: 12,
  tmpDir: "/var/folders/xx", projectId: "p-mac",
};
const PI: PlacementMachine = {
  key: "ws://pi:3790", machineId: "pi", name: "pi", os: "linux", arch: "arm64",
  tools: ["git", "gh", "node", "pnpm"], cpuCount: 4, concurrency: 4,
  tmpDir: "/tmp", projectId: "p-pi",
};

function task(o: Partial<RunTask> & { key: string }): RunTask {
  return { title: o.key, issue: null, url: null, requires: [], ...o };
}

// ---------------------------------------------------------------------------
// The task list
// ---------------------------------------------------------------------------

test("a line of issue numbers is one task per number", () => {
  const tasks = parseTaskList("44 45 #46");
  assert.deepEqual(tasks.map((t) => t.issue), [44, 45, 46]);
  assert.deepEqual(tasks.map((t) => t.key), ["#44", "#45", "#46"]);
});

test("a line that is not only numbers is one plain task", () => {
  const tasks = parseTaskList("Fix the wheel scroll in the sidebar");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.issue, null);
  assert.equal(tasks[0]!.title, "Fix the wheel scroll in the sidebar");
});

test("`;` separates tasks, because the prompt that asks for them is one line", () => {
  const tasks = parseTaskList("Write the docs; Fix the wheel os=darwin");
  assert.deepEqual(tasks.map((t) => t.title), ["Write the docs", "Fix the wheel"]);
  assert.deepEqual(tasks[1]!.requires, [{ kind: "os", value: "darwin" }]);
});

test("requirements are read off the end of the line and `needs` means a tool", () => {
  const { rest, requires } = parseRequirements("Reproduce the crash os=darwin needs=tmux");
  assert.equal(rest, "Reproduce the crash");
  assert.deepEqual(requires, [{ kind: "os", value: "darwin" }, { kind: "tool", value: "tmux" }]);
});

test("a title with an = in it is not mistaken for a requirement", () => {
  const tasks = parseTaskList("Handle PATH=/usr/bin in the probe");
  assert.equal(tasks[0]!.title, "Handle PATH=/usr/bin in the probe");
  assert.deepEqual(tasks[0]!.requires, []);
});

test("issue titles from gh replace the placeholder and keep the requirements", () => {
  const tasks = parseTaskList("44 needs=tmux");
  const named = withIssueTitles(tasks, [{ number: 44, title: "A multi-agent run", url: "https://x/44" }]);
  assert.equal(named[0]!.title, "A multi-agent run");
  assert.equal(named[0]!.url, "https://x/44");
  assert.deepEqual(named[0]!.requires, [{ kind: "tool", value: "tmux" }]);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test("the rule is one line, so it can be shown before it runs", () => {
  assert.ok(PLACEMENT_RULE.length > 20 && !PLACEMENT_RULE.includes("\n"));
});

test("a task that needs macOS stays on the Mac even when the Mac is full", () => {
  // Two tasks of the real run could only be done on macOS: one needed
  // `pngpaste`, one needed reveal-in-Finder. The Mac has to be full first, or
  // the case passes on the size of the machine and proves nothing about the
  // requirement — which is the trap three of five agents fell into that day.
  const tasks = [
    ...Array.from({ length: 12 }, (_, i) => task({ key: `#${i}` })),
    task({ key: "#mac", requires: [{ kind: "os", value: "darwin" }] }),
  ];
  const placed = placeTasks(tasks, [PI, MAC]);
  assert.equal(placed[11]!.machineId, "mac", "the Mac took its twelve first");
  assert.equal(placed[12]!.machineId, "mac", "os=darwin must not be placed on linux, full or not");
});

test("a task that can only be done on the Pi goes to the Pi, slow though it is", () => {
  // The Pi was the only machine with an old /usr/bin/node to reproduce against.
  const tasks = [task({ key: "#1", requires: [{ kind: "os", value: "linux" }] })];
  assert.equal(placeTasks(tasks, [PI, MAC])[0]!.machineId, "pi");
});

test("a task that needs a tool goes to the machine that has it, full or not", () => {
  const tasks = [
    ...Array.from({ length: 12 }, (_, i) => task({ key: `#${i}` })),
    task({ key: "#tmux", requires: [{ kind: "tool", value: "tmux" }] }),
  ];
  assert.equal(placeTasks(tasks, [PI, MAC])[12]!.machineId, "mac");
});

test("a task nobody can take is reported, not placed somewhere that cannot do it", () => {
  const tasks = [task({ key: "#1", requires: [{ kind: "tool", value: "pngpaste" }] })];
  const [p] = placeTasks(tasks, [PI, MAC]);
  assert.equal(p!.machineId, null);
  assert.match(p!.reason, /pngpaste/);
});

test("machine=pi names one machine outright", () => {
  const tasks = [task({ key: "#1", requires: [{ kind: "machine", value: "pi" }] })];
  assert.equal(placeTasks(tasks, [PI, MAC])[0]!.machineId, "pi");
});

test("the fastest machine fills first, then the next", () => {
  const tasks = Array.from({ length: 14 }, (_, i) => task({ key: `#${i}` }));
  const placed = placeTasks(tasks, [PI, MAC]);
  // MAC takes its twelve before PI takes one.
  assert.deepEqual(placed.slice(0, 12).map((p) => p.machineId), Array(12).fill("mac"));
  assert.deepEqual(placed.slice(12).map((p) => p.machineId), ["pi", "pi"]);
});

test("a machine already carrying work is not filled again from zero", () => {
  const carrying = new Map([["mac", 12]]);
  assert.equal(placeTasks([task({ key: "#1" })], [PI, MAC], carrying)[0]!.machineId, "pi");
});

test("when every machine is full the overflow goes to the biggest", () => {
  const carrying = new Map([["mac", 12], ["pi", 4]]);
  assert.equal(placeTasks([task({ key: "#1" })], [PI, MAC], carrying)[0]!.machineId, "mac");
});

test("meets and firstUnmet agree about what a machine is missing", () => {
  assert.equal(meets(PI, { kind: "tool", value: "tmux" }), false);
  assert.deepEqual(firstUnmet(PI, task({ key: "#1", requires: [{ kind: "tool", value: "tmux" }] })), { kind: "tool", value: "tmux" });
  assert.equal(firstUnmet(MAC, task({ key: "#1", requires: [{ kind: "tool", value: "tmux" }] })), null);
});

// ---------------------------------------------------------------------------
// Resources — the defect that made issue #44 necessary
// ---------------------------------------------------------------------------

test("no two members of a run share a port, a home or a config", () => {
  const runId = "8f0d2b1e-0000-4000-8000-000000000001";
  const ports = allocatePorts(runId, 15);
  const members = ports.map((p, i) => allocateResources(runId, p, "/tmp", memberSlug(task({ key: `#${i}` }), i)));
  assert.equal(new Set(members.map((m) => m.port)).size, 15, "fifteen agents, fifteen ports");
  assert.equal(new Set(members.map((m) => m.coveyHome)).size, 15, "fifteen agents, fifteen homes");
  assert.equal(new Set(members.map((m) => m.coveyConfig)).size, 15, "fifteen agents, fifteen configs");
});

test("a member's port is never the port a real daemon listens on", () => {
  for (let run = 0; run < 50; run++) {
    for (const port of allocatePorts(`8f0d2b1e-0000-4000-8000-${String(run).padStart(12, "0")}`, 20)) {
      assert.notEqual(port, 3790, "3790 hosts the session the operator is in");
      assert.ok(port >= RUN_PORT_MIN && port <= RUN_PORT_MAX, `${port} is outside the run range`);
    }
  }
});

test("a second run does not take a port the first run's members are using", () => {
  // Two run ids that hash into the same place is a one-in-two-hundred event,
  // and it happened on the third run ever created. Hashing alone is not enough.
  const first = allocatePorts("run-a", 4);
  const clash = allocatePorts("run-b", 4, new Set(first));
  assert.equal(clash.filter((p) => first.includes(p)).length, 0);
  assert.equal(new Set(clash).size, 4);
});

test("the block a run already holds is stable when it is asked for again", () => {
  const runId = "8f0d2b1e-0000-4000-8000-000000000003";
  assert.deepEqual(allocatePorts(runId, 3), allocatePorts(runId, 3));
  assert.equal(runPortBase(runId), allocatePorts(runId, 1)[0]);
});

test("two runs do not start from the same port", () => {
  const a = runPortBase("8f0d2b1e-0000-4000-8000-00000000000a");
  const b = runPortBase("8f0d2b1e-0000-4000-8000-00000000000b");
  assert.notEqual(a, b);
});

test("a member's directories go under the tmpdir of the machine it runs on", () => {
  const mac = allocateResources("r", 3801, "/var/folders/xx", "1-i44");
  const pi = allocateResources("r", 3802, "/tmp", "2-i45");
  assert.ok(mac.coveyHome.startsWith("/var/folders/xx/"), mac.coveyHome);
  assert.ok(pi.coveyHome.startsWith("/tmp/"), pi.coveyHome);
  assert.notEqual(mac.coveyConfig, mac.coveyHome);
});

test("two tasks with the same title still get different directories", () => {
  const a = memberSlug(task({ key: "t1", title: "Fix the thing" }), 0);
  const b = memberSlug(task({ key: "t2", title: "Fix the thing" }), 1);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

function brief(index: number, template = DEFAULT_BRIEF) {
  const runId = "8f0d2b1e-0000-4000-8000-000000000004";
  const t = task({ key: `#${44 + index}`, title: `Task ${index}`, issue: 44 + index });
  return renderBrief(template, {
    runName: "covey issues",
    goal: "close the backlog",
    task: t,
    machineName: "mac",
    branch: `covey/branch${index}`,
    resources: allocateResources(runId, allocatePorts(runId, 15)[index]!, "/tmp", memberSlug(t, index)),
    position: index + 1,
    total: 15,
  });
}

test("every member's brief names that member's own port, and no other's", () => {
  const first = brief(0);
  const second = brief(1);
  const port = (s: string) => Number(/port (\d{4})/.exec(s)![1]);
  assert.notEqual(port(first), port(second), "one port in fifteen briefs is the defect this issue is about");
  assert.ok(!second.includes(String(port(first))), "a member's brief must not mention another member's port");
});

test("a brief leaves no token unsubstituted", () => {
  assert.equal(/\{\{\w+\}\}/.test(brief(0)), false, brief(0));
});

test("the brief carries the branch the daemon actually minted", () => {
  assert.match(brief(3), /covey\/branch3/);
});

test("a brief for a plain task says nothing about an issue it does not have", () => {
  // A run takes a plain line of text as well as an issue number. `gh issue
  // view .` and "Closes " are worse than saying neither.
  const plain = renderBrief(DEFAULT_BRIEF, {
    runName: "r", goal: "g", task: task({ key: "t1", title: "Reply with ok" }), machineName: "mac",
    branch: "covey/abc", resources: { port: 3841, coveyHome: "/tmp/h", coveyConfig: "/tmp/c" },
    position: 1, total: 3,
  });
  assert.equal(plain.includes("gh issue view"), false, plain.slice(0, 200));
  assert.equal(plain.includes("Closes"), false);
  assert.equal(plain.includes("gh issue comment"), false);
  assert.match(plain, /^Your task: Reply with ok/);
  // …and it still says the parts that are not about an issue.
  assert.match(plain, /port 3841/);
  assert.match(plain, /pull request against `main`/);
  assert.equal(/\n\n\n/.test(plain), false, "a dropped section must not leave a hole");
});

test("a brief for an issue task keeps every issue line", () => {
  const withIssue = brief(0);
  assert.match(withIssue, /gh issue view #44/);
  assert.match(withIssue, /gh issue comment #44/);
  assert.match(withIssue, /Closes #44/);
  assert.match(withIssue, /^Work on #44 — /);
});

test("a section is kept or dropped by whether its value is there", () => {
  const ctx = {
    runName: "r", goal: "g", machineName: "m", branch: "b",
    resources: { port: 3801, coveyHome: "/tmp/a", coveyConfig: "/tmp/b" }, position: 1, total: 1,
  };
  const tpl = "A{{#issue}} yes {{issue}}{{/issue}}{{^issue}} no {{/issue}}B";
  assert.equal(renderBrief(tpl, { ...ctx, task: task({ key: "#7", issue: 7 }) }), "A yes #7B");
  assert.equal(renderBrief(tpl, { ...ctx, task: task({ key: "t1" }) }), "A no B");
});

test("an unknown token is left alone rather than blanked", () => {
  assert.equal(renderBrief("{{task}} {{nosuch}}", {
    runName: "r", goal: "g", task: task({ key: "#1", title: "T" }), machineName: "m",
    branch: "b", resources: { port: 3801, coveyHome: "/tmp/a", coveyConfig: "/tmp/b" },
    position: 1, total: 1,
  }), "T {{nosuch}}");
});
