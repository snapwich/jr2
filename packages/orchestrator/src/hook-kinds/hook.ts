// The key that a Hook value keeps its parts under. Internal: `defineHookKind` (./index.ts) writes
// it and the door (./door.ts) reads it. A kind never imports this module.
//
// `Symbol.for`, so that the key is the same in each copy of this module. The Kit image holds one
// copy of `@jr2/orchestrator` (ADR-0069), so a second copy is a fault, but the key does not depend on it.

export const HOOK: unique symbol = Symbol.for("@jr2/orchestrator/hooks.hook");
