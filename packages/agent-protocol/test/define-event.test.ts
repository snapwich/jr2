// defineEvent is a pure factory (ADR-0011): no registry, no side effects — two same-named defs
// from "different workflows" coexist as independent values. Scoping lives in the manifest
// (`eventMap`), which is where duplicates and non-defs are rejected, named for the workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineEvent, eventMap, isEventDef, type EventFrom } from "../src/define-event.ts";

test("returns frozen pure data with ack default", () => {
  const approve = defineEvent({ name: "approve", input: z.object({}) });
  assert.equal(approve.name, "approve");
  assert.equal(approve.semantics, "ack");
  assert.ok(Object.isFrozen(approve));
});

test("no registry: same name twice yields two independent defs", () => {
  const a = defineEvent({ name: "approve", input: z.object({}) });
  const b = defineEvent({ name: "approve", input: z.object({ notes: z.string() }) });
  assert.notEqual(a, b);
  assert.ok(b.input.safeParse({ notes: "x" }).success);
  assert.ok(!b.input.safeParse({}).success);
});

test("rejects names outside the MCP/xstate-safe charset (dots stay j2's namespaces)", () => {
  assert.throws(() => defineEvent({ name: "agent.fault", input: z.object({}) }), /invalid name/);
  assert.throws(() => defineEvent({ name: "not a name!", input: z.object({}) }), /invalid name/);
  assert.throws(() => defineEvent({ name: "", input: z.object({}) }), /invalid name/);
});

test("deferred requires an output schema (the held result IS the output)", () => {
  assert.throws(
    () => defineEvent({ name: "request_approval", semantics: "deferred", input: z.object({ action: z.string() }) }),
    /deferred but has no output/,
  );
  const ok = defineEvent({
    name: "request_approval",
    semantics: "deferred",
    input: z.object({ action: z.string() }),
    output: z.object({ decision: z.string() }),
  });
  assert.equal(ok.semantics, "deferred");
});

test("eventMap resolves a manifest and rejects duplicates + non-defs, naming the Machine", () => {
  const approve = defineEvent({ name: "approve", input: z.object({}) });
  const resume = defineEvent({ name: "resume", input: z.object({}) });
  const map = eventMap("coding", [approve, resume]);
  assert.equal(map.get("approve"), approve);
  assert.equal(map.size, 2);

  const dupe = defineEvent({ name: "approve", input: z.object({ notes: z.string() }) });
  assert.throws(() => eventMap("coding", [approve, dupe]), /machine "coding": duplicate event "approve"/);
  assert.throws(() => eventMap("coding", [{ name: "approve" }]), /not a defineEvent\(\) def/);
  assert.ok(isEventDef(approve));
  assert.ok(!isEventDef({ name: "approve" }));
});

test("EventFrom derives the Machine event type and distributes over unions", () => {
  const approve = defineEvent({ name: "approve", input: z.object({}) });
  const requestChanges = defineEvent({ name: "request_changes", input: z.object({ notes: z.string() }) });

  // Compile-time contract: `{ type: name } & input`, distributing over def unions.
  type Union = EventFrom<typeof approve | typeof requestChanges>;
  const a: Union = { type: "approve" };
  const b: Union = { type: "request_changes", notes: "tighten tests" };
  // @ts-expect-error — notes is required for request_changes
  const bad: Union = { type: "request_changes" };
  // @ts-expect-error — not in the union
  const unknown: Union = { type: "reject" };
  assert.ok(a && b && bad && unknown);
});
