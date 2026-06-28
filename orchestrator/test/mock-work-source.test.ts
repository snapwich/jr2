// Unit tests for the in-memory Work Source — the three properties the real
// adapter (#6) must replicate: atomic claim/lease, dependency-gated ready-set,
// and a ready-set that mutates mid-run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryWorkSource } from "../src/coding/testing/mock-work-source.ts";

test("atomic claim: two workers never grab the same feature", () => {
  const ws = new InMemoryWorkSource([{ id: "A" }, { id: "B" }]);
  const first = ws.claimNextFeature("w1");
  const second = ws.claimNextFeature("w2");

  assert.ok(first && second);
  assert.notEqual(first.feature.id, second.feature.id, "distinct features");
  assert.notEqual(first.lease.leaseId, second.lease.leaseId, "distinct leases");
  assert.equal(first.lease.holder, "w1");
  assert.equal(ws.claimNextFeature("w3"), null, "nothing left to claim");
});

test("ready-set is dependency-gated and dependency-ordered", () => {
  const ws = new InMemoryWorkSource([{ id: "A" }, { id: "B", dependsOn: ["A"] }, { id: "C" }]);
  // B is blocked by A → ready-set is [A, C] in insertion order.
  assert.deepEqual(
    ws.ready().map((f) => f.id),
    ["A", "C"],
  );

  ws.claimNextFeature("w"); // claims A
  ws.claimNextFeature("w"); // claims C
  assert.equal(ws.claimNextFeature("w"), null, "B still blocked while A not done");

  ws.updateStatus("A", "done");
  const b = ws.claimNextFeature("w");
  assert.equal(b?.feature.id, "B", "B unblocked once A is done");
});

test("tasks are handed out in order and never re-leased, then drained", () => {
  // The port hands out the next OPEN task in order; the Machine enforces one
  // in-flight task at a time (it only re-queries after closing the prior one).
  const ws = new InMemoryWorkSource([{ id: "F", tasks: ["t0", "t1"] }]);
  assert.equal(ws.claimNextTask("F", "w")?.task.id, "t0");
  assert.equal(ws.claimNextTask("F", "w")?.task.id, "t1");
  assert.equal(ws.claimNextTask("F", "w"), null, "both leased, none re-handed");
  ws.updateStatus("t0", "done");
  ws.updateStatus("t1", "done");
  assert.equal(ws.claimNextTask("F", "w"), null, "feature drained");
});

test("mutation: an added feature appears in the next ready() query", () => {
  const ws = new InMemoryWorkSource([{ id: "A" }]);
  ws.claimNextFeature("w");
  ws.updateStatus("A", "done");
  assert.deepEqual(ws.ready(), [], "drained");

  let fired = 0;
  ws.onReady(() => fired++);
  ws.addFeature({ id: "B" }); // mid-run injection
  assert.deepEqual(
    ws.ready().map((f) => f.id),
    ["B"],
  );
  assert.ok(fired > 0, "onReady fired for the injected work");
});

test("reopen makes a finished feature claimable again", () => {
  const ws = new InMemoryWorkSource([{ id: "A", tasks: ["t0"] }]);
  ws.claimNextFeature("w");
  ws.updateStatus("t0", "done");
  ws.updateStatus("A", "done");
  assert.ok(ws.allFeaturesDone());

  ws.reopen("A");
  assert.equal(ws.statusOf("A"), "open");
  assert.equal(ws.claimNextFeature("w")?.feature.id, "A", "reopened feature re-claimable");
  assert.equal(ws.claimNextTask("A", "w")?.task.id, "t0", "its task reopened too");
});
