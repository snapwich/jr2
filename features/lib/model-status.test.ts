import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyIn } from "./model-status.ts";

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
