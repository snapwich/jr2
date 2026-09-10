// Vocabulary-on-the-machine (ADR-0011, ADR-0015): a Machine's event defs ride the machine, not a
// module export — and they are scoped to THAT Machine alone. `j2Setup.createMachine` attaches
// them here; `gate` and the Agent slots read them back off the Machine that invoked them, and nothing ever
// merges two Machines' sets. That is what makes a Machine composable by plain `invoke`
// (ADR-0049): the importing Machine neither re-declares nor sees the nested one's events, so
// `coding`'s `approve` and `release`'s `approve` may differ and one run may hold both.
//
// The attachment is keyed on `machine.config` — the raw config object xstate's `.provide()`
// passes through unchanged (`new StateMachine(this.config, …)`, verified against the pinned
// xstate 5.32.2). So the host's per-run `provide` and a test's `.provide()` both keep the
// vocabulary, which is ADR-0049's rule that parts resolve at invoke time THROUGH THE LIVE ACTOR'S
// LOGIC rather than a build-time closure: whatever machine object an actor was invoked as, its
// config is the one the defs were attached to.
//
// A WeakMap (rather than a field) keeps the returned machine bit-identical — Stately-inspectable,
// constructible with no j2 runtime — and preserves ADR-0011's anti-global-registry argument:
// attribution flows through the machine object, per-Machine by construction (a shared defs module
// can feed two machines; a dev reload's fresh machine gets a fresh entry).
//
// This module is a pure leaf (no wire client, no actors) so `run-host.ts` and `registration.ts`
// can read vocabularies without dragging the Harness wire client onto their test load path — the
// same isolation actor.ts keeps.

import type { AnyActorRef, AnyStateMachine } from "xstate";
import type { z } from "zod";
import type { EventDef } from "@j2/agent-protocol";

/** The key both attachments use: the machine's raw config, which survives `.provide()`. */
type MachineKey = AnyStateMachine["config"];

const vocabularies = new WeakMap<MachineKey, Map<string, EventDef>>();

/** Attach a Machine's resolved vocabulary. j2-internal: `j2Setup` calls it, and `pool()` calls it
 * for the one def it owns (its wake event). The machine factories do NOT propagate their body's
 * or worker's defs onto the wrapper (ADR-0011): those belong to the nested Machine, which is
 * where the actors that use them resolve. */
export function attachVocabulary(machine: AnyStateMachine, defs: Map<string, EventDef>): void {
  vocabularies.set(machine.config, defs);
}

/** The vocabulary a Machine was built with — undefined for a Machine not built by `j2Setup`
 * (a plain `setup()` machine declares no workflow events and resolves to an empty scope). */
export function vocabularyOf(machine: AnyStateMachine): Map<string, EventDef> | undefined {
  return vocabularies.get(machine.config);
}

/**
 * The Machine that invoked this actor — `self._parent.logic`, public xstate API (ADR-0011). This
 * is the resolution scope for `gate`'s `accepts` and an Agent turn's menu: the derived set came from
 * THIS Machine's transitions, so its defs are the only ones a delivery may be validated against.
 *
 * Undefined for a rootless actor (`createActor(gate)` directly) and for a parent that is not a
 * state machine — both read as an empty vocabulary, which fails the invoke loudly rather than
 * silently accepting a name nobody declared.
 */
export function invokingMachine(self: AnyActorRef): AnyStateMachine | undefined {
  const logic = (self._parent as { logic?: unknown } | undefined)?.logic as AnyStateMachine | undefined;
  return logic?.root ? logic : undefined;
}

// The declared run input (ADR-0033): the one piece of a machine's vocabulary the event defs
// missed — what a run of it is STARTED with. Same key choice as the vocabulary above, for the
// same reasons (per-machine attribution, no global registry, transparent across `.provide()`).

const inputSchemas = new WeakMap<MachineKey, z.ZodObject>();

/** Attach a machine's declared run-input schema. j2-internal: `j2Setup.createMachine({ input })`
 * attaches it, and the machine factories (`workspace`, `pool`) attach their OWN — the `input` in
 * their options. Like the vocabulary, the door does NOT propagate up from a body or a worker
 * (ADR-0033): a wrapper feeds its child something other than the run input (the injected
 * `workspace` handles; a source item), so the child's contract is not the door's. */
export function attachInputSchema(machine: AnyStateMachine, schema: z.ZodObject): void {
  inputSchemas.set(machine.config, schema);
}

/** The run-input schema a machine declared — undefined for a machine that declared none, which
 * is PERMISSIVE (ADR-0033): a run of it starts with anything, today's behavior. */
export function inputSchemaOf(machine: AnyStateMachine): z.ZodObject | undefined {
  return inputSchemas.get(machine.config);
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
