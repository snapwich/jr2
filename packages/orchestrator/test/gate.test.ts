// Gate tests (ADR-0011): a gate is an addressable resource on a run — created when a state
// invokes the `gate` actor, listed with schemas + meta for discovery, destroyed when the state
// exits. Delivery is validated against the vocabulary of the MACHINE THAT INVOKED the gate
// (ADR-0049) and lands on that invoking state via the registration closure; gate ids are
// run-scoped mechanically (two runs, one id, no collision).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { EventValidationError, UnknownAddressError } from "../src/registration.ts";
import {
  collidingGatesTemplate,
  derivedFanoutDef,
  gatedDef,
  gatedOverreachTemplate,
  mkStore,
  sameNameDef,
  twinGatesTemplate,
  waitFor,
} from "./_fixtures.ts";

test("a gated state registers a discoverable gate; delivery transitions; exit destroys it", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const { runId } = await host.start("gated");

  // Discovery: the open gate carries accepted names, their JSON-Schema inputs, and meta.
  const gates = host.gates(runId);
  assert.equal(gates.length, 1);
  assert.equal(gates[0]?.gate, "F-1");
  // The AUTHORED id names the gate for callers; `path` still says where it lives — the invoking
  // state's actor path, which an id like "F-1" erases (what the Console's pin resolves).
  assert.deepEqual(gates[0]?.path, ["review"]);
  assert.deepEqual(gates[0]?.meta, { prUrl: "https://forge/pr/1" });
  const names = gates[0]?.accepts.map((a) => a.name).sort();
  assert.deepEqual(names, ["approve", "request_changes"]);
  const changes = gates[0]?.accepts.find((a) => a.name === "request_changes");
  assert.equal(changes?.description, "Ask for changes before approving.");
  assert.deepEqual((changes?.input as { required?: string[] }).required, ["notes"]);

  // Delivery lands on the invoking state; the validated payload rides the event.
  host.sendToGate(runId, "F-1", { type: "request_changes", notes: "tighten the tests" });
  await waitFor(() => host.status(runId)?.value === "changes");
  assert.equal((host.status(runId)?.context as { notes?: string }).notes, "tighten the tests");

  // Leaving the state destroyed the gate — the run is alive but holds no surface.
  assert.equal(host.status(runId)?.status, "active");
  assert.deepEqual(host.gates(runId), []);
  assert.throws(() => host.sendToGate(runId, "F-1", { type: "approve" }), UnknownAddressError);
});

test("delivery is validated: unaccepted names and bad payloads are rejected, gate stays open", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const { runId } = await host.start("gated");

  assert.throws(
    () => host.sendToGate(runId, "F-1", { type: "merge" }),
    (err: Error) => err instanceof EventValidationError && /accepts: approve, request_changes/.test(err.message),
  );
  assert.throws(() => host.sendToGate(runId, "F-1", { type: "request_changes" }), EventValidationError); // notes required
  assert.throws(() => host.sendToGate(runId, "F-1", {}), /must carry a string "type"/);

  // Nothing moved; the gate survived the rejected deliveries.
  assert.equal(host.status(runId)?.value, "review");
  assert.equal(host.gates(runId).length, 1);
});

test("gate ids are run-scoped: two runs hold the same id; delivery reaches only its run", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const a = await host.start("gated");
  const b = await host.start("gated");
  assert.equal(host.gates(a.runId).length, 1);
  assert.equal(host.gates(b.runId).length, 1);

  host.sendToGate(a.runId, "F-1", { type: "approve" });
  await waitFor(() => host.status(a.runId)?.value === "approved");

  // B is untouched and its gate (same id!) is still open and deliverable.
  assert.equal(host.status(b.runId)?.value, "review");
  assert.equal(host.gates(b.runId).length, 1);
  host.sendToGate(b.runId, "F-1", { type: "approve" });
  await waitFor(() => host.status(b.runId)?.value === "approved");
});

test("an unknown gate 404s with the run's open gates named", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const { runId } = await host.start("gated");
  assert.throws(
    () => host.sendToGate(runId, "F-99", { type: "approve" }),
    (err: Error) => err instanceof UnknownAddressError && /no open gate "F-99".*open: F-1/.test(err.message),
  );
});

// ---- Derived ids (ADR-0011): the id is the gate's own actor path. -----------------

test("fan-out: derived gate ids are distinct per child, and delivery targets exactly one", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(derivedFanoutDef());
  const { runId } = await host.start("fanout");

  // Two children, one body machine, ZERO authored ids: spawn id + invoke id + state key.
  await waitFor(() => host.gates(runId).length === 2);
  assert.deepEqual(
    host
      .gates(runId)
      .map((g) => g.gate)
      .sort(),
    ["F-1.body.coding", "F-2.body.coding"],
  );
  // `path` carries the same segments UNJOINED — the derived id spells it, but a caller must not
  // have to parse dots out of a string an author may also mint.
  assert.deepEqual(
    host
      .gates(runId)
      .map((g) => g.path)
      .sort(),
    [
      ["F-1", "body", "coding"],
      ["F-2", "body", "coding"],
    ],
  );

  // Delivery moves ONE child; the sibling's gate (same code, same state) is untouched.
  host.sendToGate(runId, "F-1.body.coding", { type: "approve" });
  await waitFor(() => host.gates(runId).length === 1);
  assert.equal(host.gates(runId)[0]?.gate, "F-2.body.coding");
});

test("a derived id is deterministic: stop() then restore lists the same gates", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(derivedFanoutDef());
  const { runId } = await host.start("fanout");
  await waitFor(() => host.gates(runId).length === 2);
  let stored: string | undefined;
  await waitFor(() => {
    void store.load(runId).then((s) => (stored = s?.status));
    return stored === "live";
  });
  await host.stop(runId);

  // The id is recomputed at (re)start from the actor path — pure structure, so the restored
  // run advertises the SAME addresses a webhook or inbox card captured before the park.
  const second = new RunHost({ store });
  second.register(derivedFanoutDef());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  assert.deepEqual(
    second
      .gates(runId)
      .map((g) => g.gate)
      .sort(),
    ["F-1.body.coding", "F-2.body.coding"],
  );
});

test("two LIVE gates under one AUTHORED id stay an authored bug: loud at invoke", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "colliding", machine: collidingGatesTemplate, provide: () => ({}) });
  const { runId } = await host.start("colliding");
  assert.equal(host.status(runId), undefined);
  const status = await host.read(runId);
  assert.equal(status?.status, "error");
  assert.match(status?.fault ?? "", /already live/);
});

test("two unnamed gates in one state: the walk suffixes the ordinal, ids stay distinct", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "twin", machine: twinGatesTemplate, provide: () => ({}) });
  const { runId } = await host.start("twin");
  await waitFor(() => host.gates(runId).length === 2);
  assert.deepEqual(
    host
      .gates(runId)
      .map((g) => g.gate)
      .sort(),
    ["review.0", "review.1"],
  );
});

test("an accepts name outside the INVOKING MACHINE's vocabulary fails at invoke time, naming both", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef({ machine: gatedOverreachTemplate })); // defs missing request_changes

  // The gate actor throws on start → the run errors immediately (xstate reports invoke errors
  // to the observer, not out of start). The fault names the MACHINE that invoked the gate and
  // its declared set (ADR-0011/0049: names are per-Machine, so the Machine is the address that
  // means anything), is readable through the store, and no zombie stays in the live registry.
  const { runId } = await host.start("gated");
  assert.equal(host.status(runId), undefined);
  const status = await host.read(runId);
  assert.equal(status?.status, "error");
  assert.match(status?.fault ?? "", /machine "gated" does not declare event "request_changes" \(declared: approve\)/);
});

// ---- Per-Machine names (ADR-0011, ADR-0049) --------------------------------------------------

test("two nested Machines' same-named, different-schema events both deliver in one run", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(sameNameDef());
  const { runId } = await host.start("same-name");
  await waitFor(() => host.gates(runId).length === 2);

  // Both gates advertise "approve" — and each advertises ITS OWN schema, because each resolved
  // against the Machine that invoked it. Nothing merged, so nothing collided.
  const byId = new Map(host.gates(runId).map((g) => [g.gate, g]));
  const outer = byId.get("own.waiting");
  const inner = byId.get("inner.waiting");
  assert.deepEqual(
    outer?.accepts.map((a) => a.name),
    ["approve"],
  );
  assert.deepEqual((outer?.accepts[0]?.input as { required?: string[] }).required, ["note"]);
  assert.deepEqual((inner?.accepts[0]?.input as { required?: string[] }).required, ["score"]);

  // Each gate validates against its own def: the sibling's payload is rejected at both ends.
  assert.throws(() => host.sendToGate(runId, "own.waiting", { type: "approve", score: 7 }), EventValidationError);
  assert.throws(() => host.sendToGate(runId, "inner.waiting", { type: "approve", note: "ok" }), EventValidationError);

  // And each delivers into its OWN Machine, with the payload its schema parsed.
  host.sendToGate(runId, "own.waiting", { type: "approve", note: "looks good" });
  host.sendToGate(runId, "inner.waiting", { type: "approve", score: 7 });
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual(final?.context, { note: "looks good", innerScore: 7 });
});
