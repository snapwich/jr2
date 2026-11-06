// The `mcp-then-pick` claim's reading (ADR-0079, ADR-0066), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readMcpThenPick } from "./model-mcp.ts";

const MENU = new Set(["ship", "hold"]);
const CALL = "orders/lookup_order";
const NUDGE = { prompt: "Your previous turn ended, and the workflow is still waiting for your pick." };

test("the MCP call, then a pick, is the measure; the pick is kept for the note", () => {
  const r = readMcpThenPick([{ call: CALL }, { call: "ship" }], CALL, MENU);
  assert.deepEqual([r.measured, r.pick], [true, "ship"]);
  // A second MCP call, or a restated Turn part, between them changes nothing.
  const twice = readMcpThenPick(
    [{ call: CALL }, { prompt: "<jr2-turn>" }, { call: CALL }, { call: "hold" }],
    CALL,
    MENU,
  );
  assert.deepEqual([twice.measured, twice.pick], [true, "hold"]);
});

test("a pick before the MCP call, a stop after it, and no call at all are misses", () => {
  assert.equal(readMcpThenPick([{ call: "ship" }, { call: CALL }], CALL, MENU).measured, false);
  const stopped = readMcpThenPick([{ call: CALL }, NUDGE, { call: "ship" }], CALL, MENU);
  assert.equal(stopped.measured, false);
  assert.match(stopped.why, /stopped after the MCP call/);
  assert.equal(readMcpThenPick([{ call: CALL }], CALL, MENU).measured, false);
  assert.equal(readMcpThenPick([], CALL, MENU).measured, false);
  // A nudge before the MCP call is not the stop the claim measures; the order still is.
  assert.equal(readMcpThenPick([NUDGE, { call: CALL }, { call: "ship" }], CALL, MENU).measured, true);
});
