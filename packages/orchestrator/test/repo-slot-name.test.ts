// A Repo Slot name cannot start with `.`, because `/work/.jr2/` is reserved for jr2 (ADR-0075). A
// dot inside a name is legal. The attach's own check is in the Harness's attach.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { customize } from "../src/customize.ts";
import { open, sandboxPartsOf } from "../src/parts.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";

const APP = "https://example.test/app.git";
const body = () =>
  jr2Setup().createMachine({
    id: "b",
    on: { "workspace.lost": ".done" },
    initial: "done",
    states: { done: { type: "final" } },
  });
const RESERVED = (key: string) =>
  new RegExp(`Repo Slot key "\\${key}" is not a directory name — .*\`/work/\\.jr2/\` is reserved for jr2.*ADR-0075`);

test("workspace() refuses a slot that starts with a dot, and names the reserved folder", () => {
  for (const key of [".jr2", ".hidden"]) {
    assert.throws(() => workspace(body(), { repos: { [key]: APP } }), RESERVED(key));
  }
});

test("customize() refuses a slot that starts with a dot, and keeps a dot inside a name", () => {
  const stock = workspace(body(), { repos: open });
  assert.throws(() => customize(stock, { repos: { ".jr2": APP } }), RESERVED(".jr2"));
  assert.deepEqual(Object.keys(sandboxPartsOf(customize(stock, { repos: { "v2.x": APP } })).repos), ["v2.x"]);
});

test("workspace() keeps a dot inside a slot name", () => {
  const w = workspace(body(), { repos: { "v2.x": APP } });
  assert.deepEqual(Object.keys(sandboxPartsOf(w).repos), ["v2.x"]);
});
