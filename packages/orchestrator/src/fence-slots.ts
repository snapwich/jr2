// The slots of an Instance's VLAN range that the Orchestrator gives to Sandboxes (ADR-0084).
//
// Slot i of the Instance's range is one VLAN, one address and one attachment (`jr2-fence-<i>`).
// `jr2 up` keeps slots 0–2 (the Instance Harness, the check pod, the node probes). The Orchestrator
// gives slots 3–127, one to each Sandbox, for the Sandbox's life. The Custodian knows a Harness pod
// only by its VLAN, so a slot is given again only when no pod can still be on it:
//
//   - its Sandbox CR has been gone for 2 minutes (the pod's grace period, and the time the
//     kubelet takes to remove the pod's network), and
//   - each Custodian pod of the Instance answers that it holds no rules of the slot (`active:
//     null`) and that no pod answers on the slot's VLAN (`present: false`). A Custodian pod that
//     does not answer, or answers 503 (its first full sync has not ended), holds rules as far as
//     this rule knows. With no Custodian pod at all, nothing says that the VLAN is empty.
//
// The allocator keeps no record of its own. At start it is made again from what the API holds: each
// Sandbox CR names its slot (its `spec.network.attachment`), and a slot Secret with no CR is the
// slot of a Sandbox that went at a time this process did not see, so its 2 minutes start then.

import type { SlotStatus } from "./custodian-control.ts";
import { FENCE_SLOTS } from "./custodian.ts";
import { custodianSlotSecret, fenceSlotAttachment } from "./names.ts";

/** The first slot that the Orchestrator gives: 0–2 are `jr2 up`'s. */
export const FIRST_SANDBOX_SLOT = 3;

/** How long a slot waits after its Sandbox CR is gone before it is given again. */
export const SLOT_REUSE_MS = 120_000;

/** What one Custodian pod says of a slot (`GET /slots/<i>`). `status` is absent when the pod did not
 * answer, or answered 503. */
export type SlotReport = { pod: string; status?: Pick<SlotStatus, "active" | "present"> };

/** Whether the reports of every Custodian pod let a slot be given again, and if not, why. */
export function slotIsClear(
  slot: number,
  reports: readonly SlotReport[],
): { clear: true } | { clear: false; why: string } {
  if (reports.length === 0) return { clear: false, why: `slot ${slot}: no Custodian pod answers for it` };
  for (const { pod, status } of reports) {
    if (status === undefined) return { clear: false, why: `slot ${slot}: the Custodian pod ${pod} does not answer` };
    if (status.active !== null) {
      return { clear: false, why: `slot ${slot}: the Custodian pod ${pod} holds its rules ${status.active}` };
    }
    if (status.present !== false) {
      return {
        clear: false,
        why:
          status.present === true
            ? `slot ${slot}: a pod answers on its VLAN on the node of the Custodian pod ${pod}`
            : `slot ${slot}: the Custodian pod ${pod} does not say whether a pod is on its VLAN`,
      };
    }
  }
  return { clear: true };
}

/** The slot of an attachment name (`jr2-fence-<i>`), or undefined. */
export function slotOfAttachment(attachment: string | undefined): number | undefined {
  return slotOfName(attachment, fenceSlotAttachment);
}

/** The slot of a slot Secret's name (`jr2-custodian-slot-<i>`), or undefined. */
export function slotOfSecret(name: string | undefined): number | undefined {
  return slotOfName(name, custodianSlotSecret);
}

function slotOfName(name: string | undefined, of: (slot: number) => string): number | undefined {
  const prefix = of(0).slice(0, -1);
  if (name === undefined || !name.startsWith(prefix)) return undefined;
  const digits = name.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(digits)) return undefined;
  const slot = Number(digits);
  return slot < FENCE_SLOTS && of(slot) === name ? slot : undefined;
}

export type SlotAllocatorOptions = {
  /** Each Sandbox CR at start, with the slot that it names. */
  sandboxes: ReadonlyArray<{ name: string; slot: number }>;
  /** Each slot that has a slot Secret at start. */
  secrets: readonly number[];
  /** What each Custodian pod of the Instance (each one, Ready or not) says of a slot. */
  reports: (slot: number) => Promise<SlotReport[]>;
  now?: () => number;
  reuseMs?: number;
};

export type SlotAllocator = {
  /** The slot of a Sandbox: the one it holds, else a slot that may be given again. Throws when no
   * slot may, with the reason of each kind. */
  take(sandbox: string): Promise<number>;
  /** The Sandbox's CR is gone: its slot waits, then may be given again. */
  release(sandbox: string): void;
  /** The Sandbox that holds a slot, if one does. */
  holder(slot: number): string | undefined;
};

/** The slot allocator of an Instance's Orchestrator, made again from the API's state (above). */
export function slotAllocator(opts: SlotAllocatorOptions): SlotAllocator {
  const now = opts.now ?? Date.now;
  const reuseMs = opts.reuseMs ?? SLOT_REUSE_MS;
  const bySandbox = new Map<string, number>();
  const bySlot = new Map<number, string>();
  /** When each slot's Sandbox went, for a slot that no Sandbox holds now. */
  const goneAt = new Map<number, number>();
  /** The slots that a `take` checks now, and the take of each Sandbox in flight. */
  const checking = new Set<number>();
  const taking = new Map<string, Promise<number>>();

  const start = now();
  for (const { name, slot } of opts.sandboxes) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= FENCE_SLOTS) continue;
    bySandbox.set(name, slot);
    if (!bySlot.has(slot)) bySlot.set(slot, name);
  }
  for (const slot of opts.secrets) if (!bySlot.has(slot)) goneAt.set(slot, start);

  const hold = (sandbox: string, slot: number): number => {
    bySandbox.set(sandbox, slot);
    bySlot.set(slot, sandbox);
    goneAt.delete(slot);
    return slot;
  };

  const choose = async (sandbox: string): Promise<number> => {
    const t = now();
    // Never used first, in order, then the slots whose Sandbox went first.
    const free: number[] = [];
    let waiting = 0;
    for (let slot = FIRST_SANDBOX_SLOT; slot < FENCE_SLOTS; slot++) {
      if (bySlot.has(slot) || checking.has(slot)) continue;
      const gone = goneAt.get(slot);
      if (gone !== undefined && t - gone < reuseMs) waiting++;
      else free.push(slot);
    }
    free.sort((a, b) => (goneAt.get(a) ?? -Infinity) - (goneAt.get(b) ?? -Infinity) || a - b);
    const reasons: string[] = [];
    for (const slot of free) {
      if (bySlot.has(slot) || checking.has(slot)) continue;
      checking.add(slot);
      try {
        let verdict: ReturnType<typeof slotIsClear>;
        try {
          verdict = slotIsClear(slot, await opts.reports(slot));
        } catch (err) {
          verdict = {
            clear: false,
            why: `slot ${slot}: the Custodian pods cannot be asked: ${(err as Error).message}`,
          };
        }
        if (verdict.clear) return hold(sandbox, slot);
        reasons.push(verdict.why);
        // Not again at once: the pod that the Custodian sees, or the rules it holds, need time to go.
        goneAt.set(slot, now());
      } finally {
        checking.delete(slot);
      }
    }
    throw new Error(
      `Sandbox "${sandbox}" gets no Fence slot (ADR-0084): ${bySlot.size} of the ${FENCE_SLOTS - FIRST_SANDBOX_SLOT} ` +
        `Sandbox slots are held, ${waiting} wait ${reuseMs / 1000} s after their Sandbox went` +
        (reasons.length ? `, and ${reasons.length} are still in use: ${reasons.slice(0, 3).join("; ")}` : ""),
    );
  };

  return {
    take(sandbox) {
      const held = bySandbox.get(sandbox);
      if (held !== undefined) return Promise.resolve(held);
      const inFlight = taking.get(sandbox);
      if (inFlight !== undefined) return inFlight;
      const p = choose(sandbox).finally(() => taking.delete(sandbox));
      taking.set(sandbox, p);
      return p;
    },
    release(sandbox) {
      const slot = bySandbox.get(sandbox);
      if (slot === undefined) return;
      bySandbox.delete(sandbox);
      if (bySlot.get(slot) === sandbox) {
        bySlot.delete(slot);
        goneAt.set(slot, now());
      }
    },
    holder(slot) {
      return bySlot.get(slot);
    },
  };
}
