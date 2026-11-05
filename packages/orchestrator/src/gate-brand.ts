// The brand of a Gate slot (ADR-0011), alone in its module: the walk (setup.ts, party.ts,
// effect-checks.ts) and the Chart door read it, and gate.ts imports the registration table, which
// imports party.ts. A leaf with no imports lets each of them ask without a cycle.

/** Is this actor logic a Gate slot (`gate({ … })`)? A duck test on the brand, as `isAgent` is. */
export function isGateSlotLogic(logic: unknown): boolean {
  if (typeof logic !== "object" || logic === null) return false;
  const parts = (logic as { gateSlot?: { delivers?: unknown } }).gateSlot;
  return typeof parts === "object" && parts !== null && Array.isArray(parts.delivers);
}

/** Does this invoke run a Gate: the plain `gate`, or a Gate slot? */
export function isGateInvoke(inv: { src?: unknown } | undefined, actors: Record<string, unknown>): boolean {
  if (inv?.src === "gate") return true;
  return typeof inv?.src === "string" && isGateSlotLogic(actors[inv.src]);
}
