// The chart-refusal reading (ADR-0066, ADR-0070), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NOT_KNOWN, readChartRefusal, STALE } from "./model-chart.ts";
import { answersIn, ofRun, type Answered } from "./model-said.ts";

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

test("a kept log that lost the trial's own prompt voids the trial: never a miss, never a pass", () => {
  // The follow of the Instance Harness's log lost the planner's Frame, which carries the marker. What
  // the log kept of the run starts at a later prompt of the run's Chart Agent, so no planner call can
  // be placed after the trial's prompt.
  const run = "r1";
  const kept = [
    `2026-11-02T09:00:05Z [summarizer] [${run}/root/open/summarizer/0a1b2c3d] [prompt] Sum it up.`,
    `2026-11-02T09:00:06Z [summarizer] [${run}/root/open/summarizer/0a1b2c3d] [submit] {}`,
    `2026-11-02T09:00:07Z [planner] [${run}/root/planner] [prompt] <jr2-turn>`,
    `2026-11-02T09:00:08Z [planner] [${run}/root/planner] [done] {}`,
  ].join("\n");
  const answered = answersIn(ofRun(kept, run), "t9-63fa93");
  assert.equal(answered, undefined, "no call is read after another prompt");
  for (const outcomes of [
    ["refused", "admitted"],
    ["refused", "refused", "admitted"],
  ]) {
    const r = readChartRefusal(outcomes, answered);
    assert.equal(r.measured, false);
    assert.match(r.void ?? "", /^void: the trial's own prompt/, JSON.stringify(outcomes));
  }
  // Not vacuous: the same log with the trial's prompt is measured.
  const whole = [
    `2026-11-02T09:00:00Z [planner] [${run}/root/planner] [prompt] [t9-63fa93] Write a Chart.`,
    `2026-11-02T09:00:01Z [planner] [${run}/root/planner] [run_chart] {}`,
    `2026-11-02T09:00:02Z [planner] [${run}/root/planner] [run_chart answer] ${refusedAnswer}`,
    `2026-11-02T09:00:03Z [planner] [${run}/root/planner] [run_chart] {}`,
    kept,
  ].join("\n");
  const r = readChartRefusal(["refused", "admitted"], answersIn(ofRun(whole, run), "t9-63fa93"));
  assert.deepEqual([r.measured, r.void], [true, undefined]);
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
