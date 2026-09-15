import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseTool } from "./toolSummary.js";

test("summariseTool", () => {
  assert.equal(summariseTool("Read", { file_path: "/a/b.ts" }), "Read /a/b.ts");
  assert.equal(summariseTool("Bash", { command: "ls", description: "List files" }), "List files");
  assert.equal(summariseTool("Bash", { command: "ls -la" }), "$ ls -la");
  assert.equal(summariseTool("mcp__t3__preview_open", {}), "t3: preview_open");
});
