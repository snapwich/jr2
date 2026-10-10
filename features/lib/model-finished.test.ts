// What a @model claim workflow means by "finished" (ADR-0066), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FINISHED, type RunEnd } from "./model-finished.ts";

const body = (outcome: string, status = "done"): RunEnd => ({
  status,
  value: "done",
  context: { output: { outcome } },
});
const root = (value: string, status = "done"): RunEnd => ({ status, value, context: {} });

test("a trial that took the other task final finished: the claim's measure, not this, counts the miss", () => {
  for (const [workflow, finals] of [
    ["answered", ["reported", "shipped"]],
    ["allowed-after-route", ["filed", "shipped"]],
    ["unknown-outcome", ["checked", "announced"]],
  ] as const) {
    for (const outcome of finals) assert.equal(FINISHED[workflow]!(body(outcome)), true, `${workflow}: ${outcome}`);
  }
  assert.equal(FINISHED["continue-after-signed-push"]!(body("finished")), true);
  assert.equal(FINISHED.wake!(root("held")), true);
  assert.equal(FINISHED["chain-answer"]!(root("released")), true);
});

test("a fault, a lost Workspace or an unsettled run never finished", () => {
  for (const workflow of ["answered", "allowed-after-route", "unknown-outcome"]) {
    assert.equal(FINISHED[workflow]!(body("faulted")), false, `${workflow}: faulted`);
    assert.equal(FINISHED[workflow]!(body("lost")), false, `${workflow}: lost`);
  }
  assert.equal(FINISHED.answered!(body("reported", "running")), false);
  assert.equal(FINISHED["continue-after-signed-push"]!(body("faulted")), false);
  assert.equal(FINISHED.obedience!(root("faulted")), false);
});
