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
  const no = (reports: SlotReport[], of: "pod" | "slot") => {
    const v = slotIsClear(5, reports);
    assert.equal(v.clear, false);
    assert.equal((v as { of: string }).of, of);
    return (v as { why: string }).why;
  };
  assert.match(no([], "pod"), /no Custodian pod/);
  assert.match(no([{ pod: "a", status: CLEAR }, { pod: "b" }], "pod"), /b does not answer/);
  assert.match(no([{ pod: "a", status: { active: null } }], "pod"), /cannot tell whether/);
  assert.match(no([{ pod: "a", status: { active: "v1", present: false } }], "slot"), /holds its rules v1/);
  assert.match(no([{ pod: "a", status: { active: null, present: true } }], "slot"), /a pod answers on its VLAN/);
  // A pod that does not answer says nothing of the slot, whatever the others say.
  assert.match(no([{ pod: "a", status: { active: "v1", present: true } }, { pod: "b" }], "pod"), /b does not answer/);
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

test("the 2-minute wait is on the monotonic clock: a forward step of the wall clock gives no slot early", async (t) => {
  let step = 0;
  t.mock.method(Date, "now", () => new Date().getTime() + step);
  const slots = slotAllocator({ sandboxes: holdersFrom(4), secrets: [3], reports: custodians().reports });
  step = 5 * 60_000;
  await assert.rejects(slots.take("a"), /1 wait 120 s after their Sandbox went/);
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
    /gets no Fence slot \(ADR-0084\): 0 of the 125 Sandbox slots are held, 0 wait 120 s after their Sandbox went, and the Custodian cannot say whether a slot is clear now: slot 3: the Custodian pod c-2 does not answer$/,
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

test("a Custodian pod that does not answer stops a take at once, and gives no slot a new wait", async () => {
  const t = clock();
  let down = true;
  const c = custodians(() =>
    down
      ? [{ pod: "c-1", status: CLEAR }, { pod: "c-2" }]
      : [
          { pod: "c-1", status: CLEAR },
          { pod: "c-2", status: CLEAR },
        ],
  );
  const slots = slotAllocator({ sandboxes: [], secrets: [], reports: c.reports, now: t.now });
  await assert.rejects(slots.take("a"), /c-2 does not answer/);
  assert.deepEqual(c.asked, [3], "one ask: the reason is the same for every slot");
  // A pod that cannot tell whether a pod is on the VLAN is the same kind of reason.
  down = false;
  const blind = slotAllocator({
    sandboxes: [],
    secrets: [],
    reports: async () => [{ pod: "c-1", status: { active: null } }],
    now: t.now,
  });
  await assert.rejects(blind.take("a"), /c-1 cannot tell whether a pod is on its VLAN$/);
  // Ten seconds later the pod answers (a roll of the Custodian ended): the first slot, at once.
  t.advance(10_000);
  c.asked.length = 0;
  assert.equal(await slots.take("b"), 3);
  assert.deepEqual(c.asked, [3]);
});

test("a slot that a Custodian pod holds rules of waits again; a later pod-level reason ends the take", async () => {
  const t = clock();
  let down = true;
  const c = custodians((slot) =>
    slot === 3
      ? [{ pod: "c-1", status: { active: "v9", present: false } }]
      : slot === 4 && down
        ? [{ pod: "c-1" }]
        : undefined,
  );
  const slots = slotAllocator({ sandboxes: holdersFrom(6), secrets: [], reports: c.reports, now: t.now });
  await assert.rejects(
    slots.take("a"),
    /0 wait 120 s after their Sandbox went, 1 are still in use, and the Custodian cannot say whether a slot is clear now: slot 4: the Custodian pod c-1 does not answer$/,
  );
  assert.deepEqual(c.asked, [3, 4], "slot 5 is not asked");
  down = false;
  c.asked.length = 0;
  assert.equal(await slots.take("b"), 4, "slot 3 waits; slot 4 got no wait");
  assert.deepEqual(c.asked, [4]);
  assert.equal(await slots.take("c"), 5);
  await assert.rejects(slots.take("d"), /1 wait 120 s/);
});

test("a release while the Sandbox's take waits: the take gives no slot, and the slot can be given at once", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const slots = slotAllocator({
    sandboxes: [],
    secrets: [],
    reports: async () => {
      await gate;
      return [{ pod: "c-1", status: CLEAR }];
    },
  });
  const a = slots.take("a");
  slots.release("a");
  const b = slots.take("b");
  open();
  await assert.rejects(a, /Sandbox "a" was released while it waited for a Fence slot/);
  assert.equal(await b, 4, "slot 3 was under the check of a's take");
  assert.equal(slots.holder(3), undefined, "a holds no slot");
  assert.equal(await slots.take("c"), 3, "no Sandbox was on slot 3, so it has no wait");
  // A take of the same Sandbox after the release is a new take.
  const again = slotAllocator({ sandboxes: [], secrets: [], reports: async () => [{ pod: "c-1", status: CLEAR }] });
  const first = again.take("a");
  again.release("a");
  const second = again.take("a");
  await assert.rejects(first, /was released/);
  assert.equal(await second, 4);
  assert.equal(again.holder(4), "a");
});

test("two CRs that name one slot at start: the slot is free only when the last one goes", async () => {
  const t = clock();
  const slots = slotAllocator({
    sandboxes: [{ name: "a", slot: 9 }, { name: "b", slot: 9 }, ...holdersFrom(10)],
    secrets: [],
    reports: custodians().reports,
    now: t.now,
  });
  slots.release("a");
  assert.equal(slots.holder(9), "b", "b still names slot 9");
  t.advance(10 * SLOT_REUSE_MS);
  for (let slot = 3; slot < 9; slot++) await slots.take(`n${slot}`);
  await assert.rejects(slots.take("x"), /125 of the 125 Sandbox slots are held, 0 wait/);
  slots.release("b");
  assert.equal(slots.holder(9), undefined);
  await assert.rejects(slots.take("x"), /1 wait 120 s/);
  t.advance(SLOT_REUSE_MS);
  assert.equal(await slots.take("x"), 9);
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
