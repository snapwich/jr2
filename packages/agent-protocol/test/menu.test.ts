import { test } from "node:test";
import assert from "node:assert/strict";
import { assertInMenu, DEFAULT_CODER_MENU } from "../src/menu.ts";

test("assertInMenu passes for an on-menu pick", () => {
  assert.doesNotThrow(() => assertInMenu(DEFAULT_CODER_MENU, "request_review"));
});

test("assertInMenu throws for an off-menu pick", () => {
  assert.throws(() => assertInMenu(DEFAULT_CODER_MENU, "check_inbox"), /not in the menu/);
});

test("the default coder menu excludes the poll tool", () => {
  assert.equal(DEFAULT_CODER_MENU.includes("check_inbox" as never), false);
  assert.deepEqual([...DEFAULT_CODER_MENU], ["request_review", "request_approval", "report_blocked", "done"]);
});
