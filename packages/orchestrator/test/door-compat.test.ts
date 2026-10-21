// A dispatch's slot schema against its callee's door (ADR-0071): compatibility in one direction,
// within ADR-0070's JSON Schema subset, and "not compared" outside it — never a guess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { doorCompat } from "../src/door-compat.ts";
import { doorSchemaFaults, PAYLOAD_KEYWORDS } from "../src/chart.ts";

const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input" });
/** A slot's schema as dispatch-effect.ts draws it: what the driver sends after its parse. */
const sends = (s: z.ZodType) => z.toJSONSchema(s, { io: "output", unrepresentable: "any" });

const door = json(
  z.object({
    ticket: z.string(),
    priority: z.enum(["low", "high"]),
    tags: z.array(z.string()).optional(),
    note: z.string().default(""),
  }),
);

test("a slot that sends what the door requires, and nothing it lacks, is compatible", () => {
  assert.deepEqual(doorCompat(json(z.object({ ticket: z.string(), priority: z.enum(["low", "high"]) })), door), {
    ok: true,
  });
  // A narrower slot is still compatible: one direction, not equality.
  assert.deepEqual(
    doorCompat(json(z.object({ ticket: z.string(), priority: z.literal("high"), note: z.string() })), door),
    { ok: true },
  );
});

test("a required field the slot lacks is a fault naming it", () => {
  const r = doorCompat(json(z.object({ ticket: z.string() })), door);
  assert.equal(r.ok, false);
  assert.deepEqual((r as { faults: string[] }).faults, [
    `the door requires "priority", which the slot's input schema does not have`,
  ]);
});

test("a type mismatch is a fault naming the field and both types", () => {
  const r = doorCompat(json(z.object({ ticket: z.number(), priority: z.enum(["low"]) })), door);
  assert.deepEqual((r as { faults: string[] }).faults, [`"ticket": the slot sends number, and the door takes string`]);
  // An integer is a number: a slot may narrow it.
  const n = json(z.object({ count: z.number() }));
  assert.deepEqual(doorCompat(json(z.object({ count: z.number().int() })), n), { ok: true });
});

test("an enum on the door must contain the slot's values", () => {
  const r = doorCompat(json(z.object({ ticket: z.string(), priority: z.enum(["low", "urgent"]) })), door);
  assert.equal(r.ok, false);
  assert.match(
    (r as { faults: string[] }).faults[0]!,
    /^"priority": the slot may send "urgent", which the door does not take/,
  );
  // A slot with no enum of its own may send a value the door refuses: one direction.
  assert.deepEqual(
    (doorCompat(json(z.object({ ticket: z.string(), priority: z.string() })), door) as { faults: string[] }).faults,
    [`"priority": the door takes only "low", "high", and the slot's input schema does not narrow to them`],
  );
});

test("a slot field the door lacks is a fault: a plain door strips it silently, a strict one refuses it", () => {
  const slot = json(z.object({ ticket: z.string(), priority: z.enum(["low"]), extra: z.string() }));
  assert.deepEqual((doorCompat(slot, door) as { faults: string[] }).faults, [
    `the slot's field "extra" is not in the door, which strips it silently`,
  ]);
  const strict = json(z.strictObject({ ticket: z.string(), priority: z.enum(["low", "high"]) }));
  assert.deepEqual((doorCompat(slot, strict) as { faults: string[] }).faults, [
    `the slot's field "extra" is not in the door, which refuses it`,
  ]);
  const loose = json(z.looseObject({ ticket: z.string(), priority: z.enum(["low", "high"]) }));
  assert.deepEqual(doorCompat(slot, loose), { ok: true }, "a door that keeps any field keeps it");
});

test("nested properties are compared one direction, by the same rules", () => {
  const nested = json(z.object({ repo: z.object({ url: z.string(), branch: z.string() }) }));
  assert.deepEqual(doorCompat(json(z.object({ repo: z.object({ url: z.string(), branch: z.string() }) })), nested), {
    ok: true,
  });
  assert.deepEqual(
    (
      doorCompat(json(z.object({ repo: z.object({ url: z.string(), sha: z.string() }) })), nested) as {
        faults: string[];
      }
    ).faults,
    [
      `the door requires "repo.branch", which the slot's input schema does not have`,
      `the slot's field "repo.sha" is not in the door, which strips it silently`,
    ],
  );
});

test("`items` are compared as the field's own schema", () => {
  const list = json(z.object({ ids: z.array(z.number()) }));
  assert.deepEqual(doorCompat(json(z.object({ ids: z.array(z.number().int()) })), list), { ok: true });
  assert.deepEqual((doorCompat(json(z.object({ ids: z.array(z.string()) })), list) as { faults: string[] }).faults, [
    `"ids[]": the slot sends string, and the door takes number`,
  ]);
});

test("a keyword outside the subset is not compared, naming it, on either side", () => {
  const either = json(z.object({ ticket: z.union([z.string(), z.number()]) }));
  const r = doorCompat(json(z.object({ ticket: z.string() })), either);
  assert.equal(r.ok, "not-compared");
  assert.match(
    (r as { why: string }).why,
    /^the door is outside the subset jr2 compares — properties\.ticket\.anyOf: "anyOf"/,
  );
  const oneOf = { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } };
  const s = doorCompat(oneOf, door);
  assert.equal(s.ok, "not-compared");
  assert.match((s as { why: string }).why, /^the slot's input schema .* "oneOf"/);
  // A `default` is an annotation, and is compared past: `note` above is defaulted.
  assert.equal(doorCompat(json(z.object({ ticket: z.string(), priority: z.enum(["low"]) })), door).ok, true);
});

test("a permissive door (null: it declares no input) takes any slot", () => {
  assert.deepEqual(doorCompat(json(z.object({ anything: z.string() })), null), { ok: true });
});

test("doorSchemaFaults is the payload rule without the Chart's own: a field named `type` is a door's to have", () => {
  assert.deepEqual(doorSchemaFaults(json(z.object({ type: z.string() }))), []);
  assert.ok(PAYLOAD_KEYWORDS.has("enum") && !PAYLOAD_KEYWORDS.has("oneOf"));
  assert.match(doorSchemaFaults({ type: "object", $ref: "#/x" })[0]!.message, /"\$ref" is outside/);
});

test("a field the door requires is one the slot always sends: optional in the slot is a fault, defaulted is not", () => {
  const needs = json(z.object({ ticket: z.string() }));
  assert.deepEqual(
    (doorCompat(sends(z.object({ ticket: z.string().optional() })), needs) as { faults: string[] }).faults,
    [`the door requires "ticket", which the slot's input schema leaves optional`],
  );
  // The driver sends the slot's parse, so a default fills the field before the door sees it.
  assert.deepEqual(doorCompat(sends(z.object({ ticket: z.string().default("PROJ-1") })), needs), { ok: true });
  const nested = json(z.object({ repo: z.object({ url: z.string() }) }));
  assert.deepEqual(
    (doorCompat(sends(z.object({ repo: z.object({ url: z.string().optional() }) })), nested) as { faults: string[] })
      .faults,
    [`the door requires "repo.url", which the slot's input schema leaves optional`],
  );
});

test("a door field that takes any value takes every slot field under it", () => {
  for (const any of [z.unknown(), z.any()]) {
    const open = json(z.object({ payload: any }));
    assert.deepEqual(doorCompat(sends(z.object({ payload: z.object({ a: z.string() }) })), open), { ok: true });
    assert.deepEqual(doorCompat(sends(z.object({ payload: z.array(z.number()) })), open), { ok: true });
  }
});

test("a catchall door keeps an extra slot field whose value fits, and names one that does not", () => {
  const catchall = json(z.object({ a: z.string() }).catchall(z.number()));
  assert.deepEqual(doorCompat(sends(z.object({ a: z.string(), b: z.number() })), catchall), { ok: true });
  assert.deepEqual(
    (doorCompat(sends(z.object({ a: z.string(), b: z.string() })), catchall) as { faults: string[] }).faults,
    [`"b": the slot sends string, and the door takes number`],
  );
});

test("the bounds, one direction: the slot's range lies inside the door's", () => {
  const min3 = json(z.object({ ticket: z.string().min(3) }));
  assert.deepEqual((doorCompat(sends(z.object({ ticket: z.string() })), min3) as { faults: string[] }).faults, [
    `"ticket": the door takes minLength 3, and the slot's input schema sets no such bound`,
  ]);
  assert.deepEqual((doorCompat(sends(z.object({ ticket: z.string().min(2) })), min3) as { faults: string[] }).faults, [
    `"ticket": the door takes minLength 3, and the slot's input schema allows minLength 2`,
  ]);
  assert.deepEqual(doorCompat(sends(z.object({ ticket: z.string().min(4).max(9) })), min3), { ok: true });

  const max5 = json(z.object({ n: z.number().max(5) }));
  assert.equal(doorCompat(sends(z.object({ n: z.number() })), max5).ok, false);
  assert.deepEqual(
    doorCompat(sends(z.object({ n: z.number().lt(5) })), max5),
    { ok: true },
    "below 5 is inside at most 5",
  );
  const below5 = json(z.object({ n: z.number().lt(5) }));
  assert.equal(doorCompat(sends(z.object({ n: z.number().max(5) })), below5).ok, false, "5 itself is outside");
  assert.deepEqual(doorCompat(sends(z.object({ n: z.number().max(4) })), below5), { ok: true });

  const one = json(z.object({ ids: z.array(z.string()).max(1) }));
  assert.equal(doorCompat(sends(z.object({ ids: z.array(z.string()) })), one).ok, false);
  assert.deepEqual(doorCompat(sends(z.object({ ids: z.array(z.string()).length(1) })), one), { ok: true });
});

test("a door `const` the slot does not narrow to is a fault", () => {
  const fixed = json(z.object({ kind: z.literal("bug") }));
  assert.equal(doorCompat(sends(z.object({ kind: z.string() })), fixed).ok, false);
  assert.deepEqual(doorCompat(sends(z.object({ kind: z.literal("bug") })), fixed), { ok: true });
});
