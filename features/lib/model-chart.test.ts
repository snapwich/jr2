// The chart-refusal reading (ADR-0066, ADR-0070), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readChartRefusal } from "./model-chart.ts";
import type { Answered } from "./model-said.ts";

const door = (answer: string): Answered => ({ call: "run_chart", input: "{}", answer });
const grammar: Answered = { call: "run_chart", input: "{}", answer: "invalid input", error: true };
const refusedAnswer = '{"outcome":"refused","report":["states.a.invoke.src: \\"linter\\" is not a lent actor"]}';

test("refused, then the next pick admitted: measured", () => {
  const r = readChartRefusal(["refused", "admitted"], [door(refusedAnswer), { call: "run_chart", input: "{}" }]);
  assert.equal(r.measured, true);
  assert.equal(r.void, undefined);
});

test("no setup: a first Chart that admitted, and no Chart at the door, are both void", () => {
  for (const outcomes of [["admitted"], [], ["errored"]]) {
    const r = readChartRefusal(outcomes, []);
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", /^void: /, JSON.stringify(outcomes));
  }
});

test("a grammar refusal BEFORE the door's refusal is not the measured pick", () => {
  const r = readChartRefusal(["refused", "admitted"], [grammar, door(refusedAnswer), door("{}")]);
  assert.equal(r.measured, true);
});

test("a grammar refusal AFTER the door's refusal is the measured pick, and a miss", () => {
  const r = readChartRefusal(["refused", "admitted"], [door(refusedAnswer), grammar, door("{}")]);
  assert.equal(r.measured, false);
  assert.equal(r.void, undefined);
});

test("an admitted Chart whose body failed is an admission", () => {
  const r = readChartRefusal(["refused", "errored"], [door(refusedAnswer), door("")]);
  assert.equal(r.measured, true);
});

test("refused twice: a miss", () => {
  assert.equal(readChartRefusal(["refused", "refused"], [door(refusedAnswer), door(refusedAnswer)]).measured, false);
});
