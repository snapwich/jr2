import { test } from "node:test";
import assert from "node:assert/strict";
import { CALLBACK_TOOLS, requestApprovalTool, checkInboxTool, doneTool } from "../src/tools.ts";

test("the toolset is the expected fixed set", () => {
  assert.deepEqual(Object.keys(CALLBACK_TOOLS).sort(), [
    "check_inbox",
    "done",
    "report_blocked",
    "request_approval",
    "request_review",
  ]);
});

test("each tool's name key matches its definition", () => {
  for (const [key, tool] of Object.entries(CALLBACK_TOOLS)) {
    assert.equal(key, tool.name);
  }
});

test("request_approval accepts a valid input and rejects a malformed one", () => {
  assert.deepEqual(requestApprovalTool.input.parse({ action: "merge", reason: "tests pass" }), {
    action: "merge",
    reason: "tests pass",
  });
  // `action` is required.
  assert.equal(requestApprovalTool.input.safeParse({ reason: "no action" }).success, false);
});

test("request_approval returns a decision; it is the deferred down-channel", () => {
  assert.equal(requestApprovalTool.semantics, "deferred");
  assert.deepEqual(requestApprovalTool.output.parse({ decision: "approved" }), { decision: "approved" });
});

test("done summary is optional", () => {
  assert.equal(doneTool.input.safeParse({}).success, true);
  assert.equal(doneTool.input.safeParse({ summary: "done" }).success, true);
});

test("check_inbox is a poll returning a messages array", () => {
  assert.equal(checkInboxTool.semantics, "poll");
  assert.deepEqual(checkInboxTool.output.parse({ messages: ["steer left"] }), { messages: ["steer left"] });
  assert.equal(checkInboxTool.output.safeParse({ messages: "not-an-array" }).success, false);
});
