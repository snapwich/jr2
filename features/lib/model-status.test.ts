import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, killedInTheFirstTurn } from "./model-status.ts";

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
