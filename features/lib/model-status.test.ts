import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bodyIn, ended, killedInTheFirstTurn } from "./model-status.ts";

test("a workspace() body's state is read off the children `jr2 status` reports, never the run's own value", () => {
  // push-follow's body, back in `coding` after a `revise`: the run's own value is the wrapper's.
  const status = {
    status: "active",
    value: { running: "body" },
    children: [
      {
        id: "body",
        value: { work: "coding" },
        children: [{ id: "coder", value: "running", children: [] }],
      },
    ],
  };
  assert.equal(/"coding"/.test(JSON.stringify(status.value)), false, "the wrapper's value holds no body state");
  assert.equal(bodyIn(status, "coding"), true);
  assert.equal(bodyIn(status, "reviewing"), false);
  assert.equal(bodyIn({ children: [] }, "coding"), false);
  assert.equal(bodyIn({}, "coding"), false, "a status with no children");
});

test("noticed's void is a live run whose body never left `starting`; a settled run is never one", () => {
  const at = (status: string, value: unknown) => ({
    status,
    children: [{ id: "body", value, children: [{ id: "coder", value: "running", children: [] }] }],
  });
  assert.equal(killedInTheFirstTurn(at("active", "starting")), true, "the kill inside the first Turn");
  // A body that went starting -> faulted (agent.fault) or -> lost (workspace.lost) settled the run.
  assert.equal(killedInTheFirstTurn(at("done", "faulted")), false, "a fault is no void");
  assert.equal(killedInTheFirstTurn(at("done", "lost")), false, "a lost Workspace is no void");
  assert.equal(killedInTheFirstTurn({ status: "done", children: [] }), false, "a settled run holds no body");
  assert.equal(killedInTheFirstTurn(at("error", "starting")), false, "an errored run is settled");
  assert.equal(killedInTheFirstTurn(at("active", "asking")), false, "the next Turn began");
});

test("a trial's note prints a faulted, lost or errored run's final output, and nothing more for the others", () => {
  const faulted = { status: "done", value: "faulted", context: { output: { outcome: "faulted", reason: "r" } } };
  assert.equal(ended(faulted), 'done/faulted {"outcome":"faulted","reason":"r"}', "a root Machine's fault");
  const lost = { status: "done", value: "done", context: { output: { outcome: "lost", reason: "gone" } } };
  assert.equal(ended(lost, lost.context.output.outcome), 'done/lost {"outcome":"lost","reason":"gone"}', "a body");
  const error = { status: "error", value: "drafting", context: {} };
  assert.equal(ended(error), 'error/drafting "drafting"', "an errored run with no output prints its value");
  const errored = { ...error, fault: 'invoked gate "x" is not in the manifest' };
  assert.equal(
    ended(errored),
    'error/drafting "drafting" fault: invoked gate "x" is not in the manifest',
    "an errored run prints its fault: the reason",
  );
  const submitted = { status: "done", value: "submitted", context: { output: { outcome: "submitted" } } };
  assert.equal(ended(submitted), "done/submitted", "a finished run prints as before");
  const other = { status: "done", value: "shipped", context: { output: { outcome: "shipped" } } };
  assert.equal(ended(other, other.context.output.outcome), "done/shipped", "the other task final prints as before");
  const live = { status: "active", value: { notes: "reviewing" }, context: {} };
  assert.equal(ended(live), 'active/{"notes":"reviewing"}', "a run still live at its deadline prints its state");
});

// The rule the failure list depends on (ADR-0066): a trial that did not finish says how its run
// ended. Read off the drivers' source, so a new note that leaves it out fails here, not in a tier
// run whose namespace is gone. A void is no exception: one kept past the bound of replacements is
// in the list. A trial counted finished is in no such list; a driver that threw names no run.
test("every note of a trial that did not finish says how its run ended", () => {
  const lines = readFileSync(new URL("../steps/model.steps.ts", import.meta.url), "utf8").split("\n");
  const missing: string[] = [];
  lines.forEach((line, i) => {
    if (!/\bnote: [`"]/.test(line)) return;
    const around = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    // A void is listed too, once it is kept past the bound of replacements, so it says how its run
    // ended as every other trial does. A finished trial's note is never in the list.
    if (/finished: true/.test(around) || /threw: /.test(line)) return;
    if (/\bended\(/.test(line) || /note: seen\b/.test(line)) return;
    missing.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(missing, [], "these notes do not say how the run ended");
});
