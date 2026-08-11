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
 * attaches it, and the machine factories (`workspace`, `pool`) attach their OWN — the `input` in
 * their options. Unlike the vocabulary, the door deliberately does NOT propagate up from a body
 * or a worker (ADR-0033): a wrapper feeds its child something other than the run input (the
 * injected `workspace` handles; a source item), so the child's contract is not the door's. */
export function attachInputSchema(machine: AnyStateMachine, schema: z.ZodObject): void {
  inputSchemas.set(machine, schema);
}

/** The run-input schema a machine declared — undefined for a machine that declared none, which
 * is PERMISSIVE (ADR-0033): a run of it starts with anything, today's behavior. */
export function inputSchemaOf(machine: AnyStateMachine): z.ZodObject | undefined {
  return inputSchemas.get(machine);
}

/**
 * What the HOST adds to the input of the machine a run STARTS with, beside the door
 * (`RunHost.start`). One field today: the run's seed Instance ID, minted with the run and
 * reported by `j2 status`, so an external caller can address the run's first conversation.
 *
 * It is deliberately NOT door material (ADR-0033): no caller sends it — `start` overwrites
 * whatever arrived, after the parse — and it is never served as JSON Schema, so putting it in a
 * door schema would publish it and demand of every caller a field the host supplies anyway.
 *
 * It is also PLACEMENT-DEPENDENT: only the ROOT machine is started with it. A machine invoked
 * further down is fed by its parent, which passes what it chooses. No type can see where a machine
 * sits, so the one contract that must reason about this — `workspace()`'s body guard — takes the
 * permissive answer and counts these keys as PROVIDED, which lets a body declare the field
 * honestly. Counting them as provided (rather than subtracting them from what the body demands)
 * is what keeps their TYPE checked: `instanceId` is a string, and a body asking for anything else
 * is still rejected.
 */
export type HostInjectedInput = { instanceId: string };
