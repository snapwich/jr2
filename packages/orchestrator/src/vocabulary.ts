// Vocabulary-on-the-machine (ADR-0011, ADR-0015): a Machine's event defs ride the machine, not a
// module export — and they are scoped to THAT Machine alone. `jr2Setup.createMachine` attaches
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
// constructible with no jr2 runtime — and preserves ADR-0011's anti-global-registry argument:
// attribution flows through the machine object, per-Machine by construction (a shared defs module
// can feed two machines; a dev reload's fresh machine gets a fresh entry).
//
// This module is a pure leaf (no wire client, no actors) so `run-host.ts` and `registration.ts`
// can read vocabularies without dragging the Harness wire client onto their test load path — the
// same isolation actor.ts keeps.

import type { AnyActorRef, AnyStateMachine } from "xstate";
import type { z } from "zod";
import type { EventDef } from "@jr2/agent-protocol";

/** The key both attachments use: the machine's raw config, which survives `.provide()`. */
type MachineKey = AnyStateMachine["config"];

const vocabularies = new WeakMap<MachineKey, Map<string, EventDef>>();

/** Attach a Machine's resolved vocabulary. jr2-internal: `jr2Setup` calls it, and `pool()` calls it
 * for the one def it owns (its wake event). The machine factories do NOT propagate their body's
 * or worker's defs onto the wrapper (ADR-0011): those belong to the nested Machine, which is
 * where the actors that use them resolve. */
export function attachVocabulary(machine: AnyStateMachine, defs: Map<string, EventDef>): void {
  vocabularies.set(machine.config, defs);
}

/** The vocabulary a Machine was built with — undefined for a Machine not built by `jr2Setup`
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
  // An Open body's actor (ADR-0070) delegates to the Machine compiled from the Chart it binds, and
  // its own logic is no Machine: the bound Machine is the scope of the Agents and Gates its states
  // invoke, so it is asked first.
  const parent = self._parent;
  const bound = parent ? boundMachines.get(parent) : undefined;
  if (bound) return bound;
  const logic = (parent as { logic?: unknown } | undefined)?.logic as AnyStateMachine | undefined;
  return logic?.root ? logic : undefined;
}

// The Machine an Open body's actor runs (ADR-0070): compiled from the Chart the run bound, per
// actor, at start and again at restore. Keyed on the ACTOR, not on a config: two runs of one
// wrapper bind two Charts under the same slot. Kept here, beside the vocabulary, so this module
// stays a leaf: open-body.ts writes it, and `invokingMachine` reads it.
const boundMachines = new WeakMap<AnyActorRef, AnyStateMachine>();

/** Record the Machine an Open body's actor runs. jr2-internal: the Open body's logic calls it. */
export function attachBoundMachine(actor: AnyActorRef, machine: AnyStateMachine): void {
  boundMachines.set(actor, machine);
}

/** The Machine an Open body's actor runs, or undefined for any other actor. */
export function boundMachineFor(actor: AnyActorRef): AnyStateMachine | undefined {
  return boundMachines.get(actor);
}

// The declared run input (ADR-0033): the one piece of a machine's vocabulary the event defs
// missed — what a run of it is STARTED with. Same key choice as the vocabulary above, for the
// same reasons (per-machine attribution, no global registry, transparent across `.provide()`).

const inputSchemas = new WeakMap<MachineKey, z.ZodObject>();

/** Attach a machine's declared run-input schema. jr2-internal: `jr2Setup.createMachine({ input })`
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

/** A zod schema, by its shape: the Instance can resolve a zod of its own, so `instanceof` does not
 * tell. */
export function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/** The run input that a machine declares: the door that `jr2Setup` attached, or a zod `input` on
 * its `createMachine` config that no door reads (a machine that `setup()` made). */
export function declaresRunInput(machine: AnyStateMachine): boolean {
  return inputSchemaOf(machine) !== undefined || isZodSchema((machine.config as { input?: unknown }).input);
}

// Who may send what, per state (ADR-0015): the seats the menu-derivation walk computed. Same key
// choice as the vocabulary, for the same reasons. The Machine's doc carries them; `jr2 up` and the
// Console show them, so an author reads the audience rule's answer for their own Machine.

/** One party's seat on one state: the state's id, the party, and the names it may send there —
 * for an Agent the derived set its guards narrow; for a Gate its accepted set, unless the Gate's
 * input names `accepts:` itself. */
export type MachineSeat = { state: string; party: "agent" | "gate"; agent?: string; names: string[] };

const seatTables = new WeakMap<MachineKey, MachineSeat[]>();

/** Attach a Machine's seats. jr2-internal: `jr2Setup.createMachine` calls it. */
export function attachSeats(machine: AnyStateMachine, seats: MachineSeat[]): void {
  seatTables.set(machine.config, seats);
}

/** The seats of a Machine built by `jr2Setup`, in walk order; empty for any other Machine. */
export function seatsOf(machine: AnyStateMachine): MachineSeat[] {
  return seatTables.get(machine.config) ?? [];
}

/** One line per seat — `<state> agent:<slot>: [names]` or `<state> gate: [names]`. */
export function seatLine(seat: MachineSeat): string {
  const party = seat.party === "agent" ? `agent:${seat.agent}` : "gate";
  return `${seat.state} ${party}: [${seat.names.join(", ")}]`;
}

const loadWarnings = new WeakMap<MachineKey, string[]>();

/** Attach the load warnings `jr2Setup.createMachine` found (ADR-0015). jr2-internal. */
export function attachLoadWarnings(machine: AnyStateMachine, warnings: string[]): void {
  loadWarnings.set(machine.config, warnings);
}

/** What the build found legal and suspect — a mode nothing enters, a pick a Gate above takes from
 * the Agent below, one name written for two parties on one path. `jr2 up` prints them; the
 * Machine's doc carries them. A Machine `customize()` bound an Open argv in is rebuilt around a
 * config of its own, which carries the walk's findings for the bound argv (ADR-0054). Empty for a
 * Machine not built by `jr2Setup`. */
export function loadWarningsOf(machine: AnyStateMachine): string[] {
  return loadWarnings.get(machine.config) ?? [];
}

// What the HOST adds to the input of the machine a run STARTS with, beside the door
// (`RunHost.start`). One field today: the run's seed Instance ID, minted with the run and
// reported by `jr2 status`. It names the RUN, never a conversation — jr2 mints every Agent
// Instance ID in the input mapper (ADR-0016, ADR-0057), and a Machine cannot pass one in.
//
// It is deliberately NOT door material (ADR-0033): no caller sends it — `start` overwrites
// whatever arrived, after the parse — and it is never served as JSON Schema, so putting it in a
// door schema would publish it and demand of every caller a field the host supplies anyway.
//
// It is also PLACEMENT-DEPENDENT: only the ROOT machine is started with it. A machine invoked
// further down is fed by its parent, which passes what it chooses. No type can see where a machine
// sits, so the one contract that must reason about this — `workspace()`'s body guard — takes the
// permissive answer and counts these keys as PROVIDED, which lets a body declare the field
// honestly. Counting them as provided (rather than subtracting them from what the body demands)
// is what keeps their TYPE checked: `instanceId` is a string, and a body asking for anything else
// is still rejected.
/**
 * The fields that jr2 adds to the input of the Machine that a run starts, beside the input that
 * the caller sent. Today it is one field: `instanceId`, an id that jr2 makes for the run.
 *
 * Add it to the type of your root Machine's input when the Machine reads it:
 * `HostInjectedInput & RunInput`. Do not put it in the `input` schema that a run starts with. No
 * caller sends it. jr2 writes it over any value that a caller sends.
 *
 * Only the root Machine of a run gets it. A Machine that another Machine invokes gets the input
 * that its parent gives it. A `workspace()` passes its input to its body, so the body of a root
 * `workspace()` gets it too: `Workspaced<HostInjectedInput & RunInput, "app">`.
 *
 * The `spec` of a root `workspace()` also gets it, and the type of its input shows it:
 * ``spec: ({ input }) => ({ branch: `fix/${input.instanceId}` })``.
 *
 * It is not the run id. Use it, for example, to give each run a branch of its own.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
 *
 * const runInput = z.object({ ticket: z.string() });
 * type Input = HostInjectedInput & z.infer<typeof runInput>;
 *
 * export const machine = jr2Setup({
 *   types: {} as { input: Input; context: Input; output: { run: string; ticket: string } },
 * }).createMachine({
 *   id: "ticket",
 *   input: runInput,
 *   context: ({ input }) => input,
 *   initial: "done",
 *   states: { done: { type: "final" } },
 *   output: ({ context }) => ({ run: context.instanceId, ticket: context.ticket }),
 * });
 * ```
 *
 * @see docs/guides/write-a-workflow.md
 * @see docs/reference/decisions/0033-a-machine-declares-the-input-that-starts-it.md
 */
export type HostInjectedInput = { instanceId: string };
