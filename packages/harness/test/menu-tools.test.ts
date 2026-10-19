// Menu-tools tests (ADR-0013/0027): the Menu presented to pi. Asserted: the `mcp__jr2__<name>`
// name the model sees, the event as the label, the parameters as given, and a pick's prose as the
// tool's text result — and its throw as the tool's throw, so pi hands the model the error.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Menu } from "../src/menu.ts";
import { menuTools, parsedObjectArguments } from "../src/menu-tools.ts";

const parameters = { type: "object", properties: { verdict: { type: "string" } } };

test("each Menu item becomes a pi tool named mcp__jr2__<name>, whose result is the pick's prose", async () => {
  const picks: unknown[] = [];
  const menu: Menu = [
    {
      event: "note.add",
      name: "note_add",
      description: "Add a note.",
      parameters,
      pick: async (params) => {
        picks.push(params);
        return "Delivered.";
      },
    },
  ];
  const [tool, ...rest] = menuTools(menu);
  assert.deepEqual(rest, []);
  assert.equal(tool!.name, "mcp__jr2__note_add");
  assert.equal(tool!.label, "note.add");
  assert.equal(tool!.description, "Add a note.");
  assert.deepEqual(tool!.parameters, parameters);
  const result = await tool!.execute("call-1", { verdict: "x" } as never, undefined as never);
  assert.deepEqual(result.content, [{ type: "text", text: "Delivered." }]);
  assert.deepEqual(picks, [{ verdict: "x" }]);
});

test("a pick that fails makes the tool throw — pi turns it into the error the model reads", async () => {
  const [tool] = menuTools([
    {
      event: "e",
      name: "e",
      description: "",
      parameters,
      pick: async () => {
        throw new Error("this turn is over");
      },
    },
  ]);
  await assert.rejects(() => tool!.execute("call-1", {} as never, undefined as never), /this turn is over/);
});

test("a JSON text where the schema declares an object is that value, before pi validates; anything else passes through", () => {
  const params = { type: "object", properties: { chart: { type: "object" }, note: { type: "string" } } };
  const chart = { initial: "a", states: { a: { type: "final" } } };
  assert.deepEqual(parsedObjectArguments({ chart: JSON.stringify(chart), note: "{}" }, params), { chart, note: "{}" });
  assert.deepEqual(parsedObjectArguments({ chart }, params), { chart }, "an object is left as it is");
  const notJson = { chart: "{initial: a}" };
  assert.equal(parsedObjectArguments(notJson, params), notJson, "not JSON: the model's, still refused by pi");
  const list = { chart: "[1]" };
  assert.equal(parsedObjectArguments(list, params), list, "JSON but not an object: untouched");
  assert.equal(parsedObjectArguments("x", params), "x");
  // The tool carries it as pi's shim.
  const [tool] = menuTools([
    { event: "run_chart", name: "run_chart", description: "", parameters: params, pick: async () => "" },
  ]);
  assert.deepEqual(tool!.prepareArguments!({ chart: JSON.stringify(chart) }), { chart });
});
