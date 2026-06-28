import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpPath, MCP_PATH_PREFIX } from "../src/addressing.ts";

test("mcpPath nests the instance id under the prefix", () => {
  assert.equal(mcpPath("abc123"), `${MCP_PATH_PREFIX}/abc123`);
});

test("mcpPath encodes ids that contain path-significant characters", () => {
  assert.equal(mcpPath("feature/login#2"), "/mcp/feature%2Flogin%232");
});
