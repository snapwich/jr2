// The chart-refusal reading (ADR-0066, ADR-0070), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NOT_KNOWN, readChartRefusal, STALE } from "./model-chart.ts";
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

test("a second pick of one model answer did not run: it is skipped, not the measured pick", () => {
  const stale: Answered = {
    call: "run_chart",
    input: "{}",
    answer: "This pick did not run: you sent it before you read the answer to `mcp__jr2__run_chart`.",
    error: true,
  };
  const r = readChartRefusal(["refused", "admitted"], [door(refusedAnswer), stale, door("{}")]);
  assert.equal(r.measured, true);
  assert.equal(r.void, undefined);
});

test("a run_chart answer that was lost (not known) at or after the door's refusal voids the trial", () => {
  const lost = door(
    "It is not known whether this pick reached the workflow: the call to `mcp__jr2__run_chart` failed before the workflow answered (x). A second call to `mcp__jr2__run_chart` can run the pick twice.",
  );
  for (const answered of [
    [lost, door("{}")],
    [door(refusedAnswer), lost],
  ]) {
    const r = readChartRefusal(["refused", "admitted"], answered);
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", /^void: /);
  }
});

test("the two answers it reads by their start are the Harness's words (menu.ts)", () => {
  // The words are the Menu's (packages/harness/src/menu.ts `stalePickResult`, `unknownPickResult`):
  // a black-box tier cannot import them, so this pins the copy against the source.
  const menu = readFileSync(new URL("../../packages/harness/src/menu.ts", import.meta.url), "utf8");
  const body = (name: string): string => {
    const start = menu.indexOf(`export function ${name}(`);
    assert.notEqual(start, -1, `menu.ts still has ${name}`);
    return menu.slice(start, menu.indexOf("\n}\n", start));
  };
  assert.ok(body("stalePickResult").includes(`return \`${STALE}\\\``), "a stale pick's answer starts with STALE");
  const unknown = body("unknownPickResult");
  assert.ok(
    unknown.includes(`const unknown = ${JSON.stringify(NOT_KNOWN)};`),
    "the unknown answer's start is NOT_KNOWN",
  );
  // Both branches of the answer start with it.
  assert.equal(unknown.split("`${unknown}: ").length - 1, 2);
});
