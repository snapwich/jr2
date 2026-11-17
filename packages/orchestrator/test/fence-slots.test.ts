// The slot allocator (ADR-0084): which slot of the Instance's range a Sandbox gets, made again at start
// from the CRs and the slot Secrets, and the reuse rule: a slot is given again only 2 minutes after
// its Sandbox went, and only when each Custodian pod says it holds no rules of it and sees no pod on
// its VLAN.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_SANDBOX_SLOT,
  slotAllocator,
  slotIsClear,
  slotOfAttachment,
  slotOfSecret,
  SLOT_REUSE_MS,
  type SlotReport,
} from "../src/fence-slots.ts";

const CLEAR: SlotReport["status"] = { active: null, present: false };

/** Two Custodian pods that both say each slot is clear, unless `per` says otherwise; and each ask. */
function custodians(per: (slot: number) => SlotReport[] | undefined = () => undefined) {
  const asked: number[] = [];
  return {
    asked,
    reports: async (slot: number): Promise<SlotReport[]> => {
      asked.push(slot);
      return (
        per(slot) ?? [
          { pod: "c-1", status: CLEAR },
          { pod: "c-2", status: CLEAR },
        ]
      );
    },
  };
}

/** A CR on each slot from `from` to the last, so that only the slots below `from` can be given. */
const holdersFrom = (from: number) => Array.from({ length: 128 - from }, (_, i) => ({ name: `h${i}`, slot: from + i }));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("the names of a slot: an attachment and a slot Secret, and nothing that only looks like one", () => {
  assert.equal(slotOfAttachment("jr2-fence-7"), 7);
  assert.equal(slotOfAttachment("jr2-fence-127"), 127);
  for (const n of ["jr2-fence-128", "jr2-fence-07", "jr2-fence-", "jr2-fence-uplink", "jr2-fence-1x", undefined]) {
    assert.equal(slotOfAttachment(n), undefined, String(n));
  }
  assert.equal(slotOfSecret("jr2-custodian-slot-3"), 3);
  assert.equal(slotOfSecret("jr2-custodian-dial"), undefined);
});

test("the reuse rule needs each Custodian pod's word: no rules held, no pod on the VLAN", () => {
  assert.deepEqual(slotIsClear(5, [{ pod: "a", status: CLEAR }]), { clear: true });
  const no = (reports: SlotReport[]) => {
    const v = slotIsClear(5, reports);
    assert.equal(v.clear, false);
    return (v as { why: string }).why;
  };
  assert.match(no([]), /no Custodian pod/);
  assert.match(no([{ pod: "a", status: CLEAR }, { pod: "b" }]), /b does not answer/);
  assert.match(no([{ pod: "a", status: { active: "v1", present: false } }]), /holds its rules v1/);
  assert.match(no([{ pod: "a", status: { active: null, present: true } }]), /a pod answers on its VLAN/);
  assert.match(no([{ pod: "a", status: { active: null } }]), /does not say whether/);
});

test("a Sandbox gets the first free slot from 3, and the same slot again when it asks again", async () => {
  const c = custodians();
  const slots = slotAllocator({ sandboxes: [], secrets: [], reports: c.reports });
  assert.equal(await slots.take("a"), FIRST_SANDBOX_SLOT);
  assert.equal(await slots.take("b"), 4);
  assert.equal(await slots.take("a"), 3, "a re-provision keeps its slot");
  assert.equal(slots.holder(3), "a");
  assert.equal(slots.holder(0), undefined, "slots 0–2 are jr2 up's");
});

test("two provisions at once get two slots", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slots = slotAllocator({
    sandboxes: [],
    secrets: [],
    reports: async () => {
      await gate;
      return [{ pod: "c-1", status: CLEAR }];
    },
  });
  const a = slots.take("a");
  const b = slots.take("b");
  const a2 = slots.take("a");
  release();
  const got = await Promise.all([a, b, a2]);
  assert.equal(got[0], got[2], "one take for a Sandbox in flight");
  assert.notEqual(got[0], got[1]);
});

test("at start: each CR keeps its slot; a slot Secret with no CR waits 2 minutes from the start", async () => {
  const t = clock();
  const slots = slotAllocator({
    sandboxes: [{ name: "a", slot: 3 }, { name: "b", slot: 5 }, ...holdersFrom(7)],
    secrets: [3, 4, 5],
    reports: custodians().reports,
    now: t.now,
  });
  assert.equal(await slots.take("a"), 3);
  assert.equal(await slots.take("c"), 6, "4 waits: its Sandbox went at a time this process did not see");
  await assert.rejects(slots.take("d"), /1 wait 120 s after their Sandbox went/);
  t.advance(SLOT_REUSE_MS);
  assert.equal(await slots.take("d"), 4);
});

test("a slot never used is given before a slot whose Sandbox went", async () => {
  const t = clock();
  const slots = slotAllocator({ sandboxes: [], secrets: [], reports: custodians().reports, now: t.now });
  assert.equal(await slots.take("a"), 3);
  slots.release("a");
  t.advance(10 * SLOT_REUSE_MS);
  assert.equal(await slots.take("b"), 4, "slot 3 could be given, and waits longer still");
});

test("a released slot is not given again for 2 minutes, then only when each Custodian pod says it is clear", async () => {
  const t = clock();
  let present = false;
  const c = custodians((slot) =>
    slot === 3
      ? [
          { pod: "c-1", status: CLEAR },
          { pod: "c-2", status: { active: null, present } },
        ]
      : undefined,
  );
  // Only slots 3 and 4 can be given.
  const slots = slotAllocator({ sandboxes: holdersFrom(5), secrets: [], reports: c.reports, now: t.now });
  assert.equal(await slots.take("old"), 3);
  slots.release("old");
  // The old pod is still on the VLAN of slot 3 when its CR is gone.
  present = true;
  assert.equal(slots.holder(3), undefined);
  assert.equal(await slots.take("x"), 4);
  await assert.rejects(slots.take("y"), /1 wait 120 s/, "slot 3 waits");
  t.advance(SLOT_REUSE_MS - 1);
  await assert.rejects(slots.take("y"), /1 wait 120 s/, "still waits");
  t.advance(1);
  c.asked.length = 0;
  await assert.rejects(slots.take("y"), /1 are still in use: slot 3: a pod answers on its VLAN .* c-2/);
  assert.deepEqual(c.asked, [3]);
  present = false;
  await assert.rejects(slots.take("y"), /1 wait 120 s/, "a refused slot waits again before it is asked again");
  t.advance(SLOT_REUSE_MS);
  assert.equal(await slots.take("y"), 3);
  assert.equal(slots.holder(3), "y");
});

test("no slot is given while a Custodian pod does not answer, or none answers", async () => {
  const slots = slotAllocator({
    sandboxes: [],
    secrets: [],
    reports: async () => [{ pod: "c-1", status: CLEAR }, { pod: "c-2" }],
  });
  await assert.rejects(
    slots.take("a"),
    /gets no Fence slot \(ADR-0084\): 0 of the 125 Sandbox slots are held, 0 wait 120 s.*125 are still in use: slot 3: the Custodian pod c-2 does not answer/,
  );
  const none = slotAllocator({ sandboxes: [], secrets: [], reports: async () => [] });
  await assert.rejects(none.take("a"), /no Custodian pod answers/);
  const broken = slotAllocator({
    sandboxes: [],
    secrets: [],
    reports: async () => {
      throw new Error("EndpointSlice list failed");
    },
  });
  await assert.rejects(broken.take("a"), /cannot be asked: EndpointSlice list failed/);
});

test("a full range refuses with the count of each kind", async () => {
  const t = clock();
  const sandboxes = Array.from({ length: 125 }, (_, i) => ({ name: `s${i}`, slot: i + 3 }));
  const slots = slotAllocator({ sandboxes, secrets: [], reports: custodians().reports, now: t.now });
  await assert.rejects(slots.take("one-more"), /125 of the 125 Sandbox slots are held, 0 wait/);
  slots.release("s0");
  await assert.rejects(slots.take("one-more"), /124 of the 125 Sandbox slots are held, 1 wait/);
  t.advance(SLOT_REUSE_MS);
  assert.equal(await slots.take("one-more"), 3);
});
