// The fake provider's preflight check (`features/steps/fake-provider.ts`), pinned without a
// cluster. It knows `jr2 up`'s provider preflight by its one tool and its prompt. A black-box tier
// cannot import them from `@jr2/harness`, so this pins the copy against the source: a change there
// that this copy misses parks the preflight as a Turn, and every @kind scenario fails at its converge.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isPreflight, PREFLIGHT_PROMPT, PREFLIGHT_TOOL } from "../steps/fake-provider.ts";

test("the preflight's tool and prompt are the ones the Harness's provider preflight sends", () => {
  const provider = readFileSync(new URL("../../packages/harness/src/provider.ts", import.meta.url), "utf8");
  const checkTool = /const CHECK_TOOL: Tool = \{\s*name: "([^"]*)"/.exec(provider);
  assert.ok(checkTool, "provider.ts still names its check tool in CHECK_TOOL");
  assert.equal(checkTool[1], PREFLIGHT_TOOL);
  const prompt = /content: \[\{ type: "text", text: "([^"]*)" \}\]/.exec(provider);
  assert.ok(prompt, "provider.ts still sends the preflight's prompt as one text part");
  assert.equal(prompt[1], PREFLIGHT_PROMPT);
  assert.equal(provider.split(JSON.stringify(PREFLIGHT_PROMPT)).length - 1, 1, "provider.ts sends one prompt");
});

test("a request with the ping tool alone and its prompt is the preflight; a Turn is not", () => {
  assert.equal(isPreflight([PREFLIGHT_TOOL], `{"content":"${PREFLIGHT_PROMPT}"}`), true);
  assert.equal(isPreflight([PREFLIGHT_TOOL, "mcp__jr2__done"], PREFLIGHT_PROMPT), false);
  assert.equal(isPreflight(["mcp__jr2__done"], PREFLIGHT_PROMPT), false);
  assert.equal(isPreflight([PREFLIGHT_TOOL], "Do the task."), false);
});
