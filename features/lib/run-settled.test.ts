// When a run is settled (ADR-0073), pinned without a cluster.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isSettled } from "./run-settled.ts";

test("each Run status that is not live is settled, `failed` and `cancelled` too", () => {
  for (const status of ["done", "failed", "error", "cancelled", "lost", "drifted"])
    assert.equal(isSettled(status), true, status);
});

test("a live run is not settled, and nor is a status that was not read", () => {
  assert.equal(isSettled("active"), false);
  assert.equal(isSettled("live"), false);
  assert.equal(isSettled(undefined), false);
});
