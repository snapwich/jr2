// Vocabulary-on-the-machine (ADR-0015): the workflow's event defs ride the machine OBJECT, not a
// module export. `j2Setup.createMachine` attaches them here; discovery (`RunHost.register`) reads
// them back. A WeakMap keeps the returned machine bit-identical — Stately-inspectable and
// `.provide()`-testable — and preserves ADR-0011's anti-global-registry argument: attribution
// flows through the machine object, per-workflow by construction (a shared defs module can feed
// two machines; a dev reload's fresh machine object gets a fresh entry).
//
// The one caveat this key choice carries: `.provide()` returns a NEW machine object, which is why
// discovery registers the pre-provide machine (it does — `WorkflowDef.machine`) and `provide`
// stays a per-run assembly step below the vocabulary lookup.
//
// This module is a pure leaf (no wire client, no actors) so `run-host.ts` can read vocabularies
// without dragging the Harness wire client onto its test load path — the same isolation actor.ts
// keeps.

import type { AnyStateMachine } from "xstate";
import type { z } from "zod";
import type { EventDef } from "@j2/agent-protocol";

const vocabularies = new WeakMap<AnyStateMachine, Map<string, EventDef>>();

/** Attach a machine's resolved vocabulary. j2-internal: `j2Setup` and the machine factories
 * (`workspace`, `pool`) call it — the factories PROPAGATE their body's vocabulary onto the
 * wrapper they return, so a workflow whose root is a wrapper still registers its defs. */
export function attachVocabulary(machine: AnyStateMachine, defs: Map<string, EventDef>): void {
  vocabularies.set(machine, defs);
}

/** The vocabulary a machine was built with — undefined for a machine not built by `j2Setup`
 * (a plain `setup()` machine has no workflow events and resolves to an empty scope). */
export function vocabularyOf(machine: AnyStateMachine): Map<string, EventDef> | undefined {
  return vocabularies.get(machine);
}

// The declared run input (ADR-0033): the one piece of a machine's vocabulary the event defs
// missed — what a run of it is STARTED with. Same key choice as the vocabulary above, for the
// same reasons (per-machine attribution, no global registry, `.provide()` registers pre-provide).

const inputSchemas = new WeakMap<AnyStateMachine, z.ZodObject>();

/** Attach a machine's declared run-input schema. j2-internal: `j2Setup.createMachine({ input })`
 * attaches it, and the machine factories (`workspace`, `pool`) PROPAGATE it onto the wrapper
 * they return exactly as they propagate the vocabulary — so a workflow whose root is a wrapper
 * still declares its door. */
export function attachInputSchema(machine: AnyStateMachine, schema: z.ZodObject): void {
  inputSchemas.set(machine, schema);
}

/** The run-input schema a machine declared — undefined for a machine that declared none, which
 * is PERMISSIVE (ADR-0033): a run of it starts with anything, today's behavior. */
export function inputSchemaOf(machine: AnyStateMachine): z.ZodObject | undefined {
  return inputSchemas.get(machine);
}
