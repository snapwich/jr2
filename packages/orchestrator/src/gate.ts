// The `gate` actor (ADR-0011): a pending external input on a run, as an addressable resource.
// The symmetric twin of the Agent actor for every NON-agent caller — humans (`jr2 send`, a UI),
// a Hook, CI. "Human" is policy, not mechanism, so the actor is not named for one caller.
//
// A state that needs outside input invokes `gate` with `{ gate?, accepts?, meta? }`. On start
// the actor resolves the accepted names against the vocabulary of the MACHINE THAT INVOKED IT —
// `self._parent.logic`, per-Machine scoping (ADR-0011, ADR-0049), which is what lets a nested
// Machine keep its own `approve` — and registers into the host's table; `GET /runs/:id` then
// lists the gate (accepts + schemas + meta — what a CLI, an inbox UI, or a Hook's handler reads),
// and `POST /runs/:id/gates/:gate/events` validates against the named schema and delivers through
// the closure below — the event lands on the state that invoked the gate, at any nesting depth.
// Leaving the state stops the actor, which destroys the gate: parking IS retention (ADR-0012),
// and a gone state is a gone surface.
//
// THE HOOKED GATE (ADR-0011). `gate({ meta, delivers, hooks, look, reply })` makes a Gate SLOT: the
// same actor, with parts that the Machine carries. The Machine puts it in `actors` and invokes it by
// its key. Its parts are code in the Assembly; its input stays data, so a restore registers it again
// as before. What the slot adds to the plain Gate:
//
//   - `meta`, a zod object: the Gate checks the invoking state's meta against it when it opens.
//   - `delivers`, the events that its handlers and its look can give. jr2Setup reads them: an event
//     whose def leaves the audience unset reads as `external`, and the walk refuses one that the
//     Gate's derived accepted set does not hold.
//   - `hooks`, by Hook kind id and event key: the Hook's door (`POST /hooks/:name`) calls them. The
//     registration carries them, with `reply`, for the door.
//   - `look`: the Gate's own read of the fact that it waits for, once after it registers, again
//     after each restore (a restore starts this actor again), and every `every` while it is open,
//     until the run takes the event that `until` gives. `look: "none"` for a Gate that hears a
//     command. `look: open` for a packaged Machine, which its composer binds with `customize()`.

import {
  createActor,
  fromCallback,
  type AnyActorLogic,
  type AnyActorRef,
  type CallbackActorLogic,
  type InputFrom,
} from "xstate";
import type { z } from "zod";
import { SENDER_KEY, type EventDef, type EventFrom } from "@jr2/agent-protocol";
import type { KindHooks } from "./hook-kinds/index.ts";
import type { CallerRecord } from "./callers.ts";
import type { Duration } from "./effect.ts";
import { isGateSlotLogic } from "./gate-brand.ts";
import { open } from "./open.ts";
import {
  actorPath,
  boundRun,
  gateAddress,
  resolveAccepts,
  runBindingOf,
  wouldMove,
  type AnyActorSystem,
  type DeliveredEvent,
  type Registration,
  type SourceSeat,
} from "./registration.ts";

export type GateInput = {
  /**
   * The gate's caller-facing id. LEAVE IT UNSET for the derived default: the actor path below
   * the run root (in a jr2Setup machine the leaf is the state key path — `deriveMenus` names the
   * invoke), which is unique wherever concurrently live siblings have distinct actor ids — i.e.
   * wherever fan-out is correct at all. Author an id only to give external callers a meaningful
   * flat name (e.g. the feature id); then run-wide uniqueness is the author's problem, and two
   * LIVE gates with one id fail loudly at invoke. Run-scoped by the host either way — two runs'
   * `"F-12"` gates cannot collide.
   */
  gate?: string;
  /**
   * Accepted event names. In a jr2Setup machine LEAVE IT UNSET: the accepted set derives from
   * the invoking state's transitions, audience ∈ {external, any} (ADR-0015) — this field is the
   * escape hatch. An unlisted name is an invoke-time error either way.
   */
  accepts?: readonly string[];
  /** Serializable context for callers: what a UI renders, what a Hook's handler matches on (prUrl…). */
  meta?: Record<string, unknown>;
};

// --- The hooked Gate's types (ADR-0011) -----------------------------------------------------------

/** One plain event of a list of defs: `{ type: "approve", by }`. What a handler, a look's `until`
 * and a Gate's `reply` see. */
export type Delivered<D extends readonly EventDef[]> = {
  [K in keyof D]: D[K] extends EventDef ? EventFrom<D[K]> : never;
}[number];

/**
 * What a Gate's handler reads beside `payload`: the Gate's meta, and the Caller that the Hook's
 * delivery made (`via: "hook"`, the Hook's name, and `onBehalfOf` from the signed payload).
 *
 * @internal
 */
export type GateIn<Meta> = { readonly meta: Meta; readonly caller: CallerRecord };

/**
 * A Gate's read of the fact that it waits for (ADR-0011).
 *
 * - `read`: an `http` Effect marked `idempotent: true`, or a promise actor (`fromPromise`), which the
 *   Machine can invoke anyway and which a restore runs again. `gate()` refuses any other logic.
 * - `input`: the read's input, from the Gate's meta.
 * - `every`: how often the Gate looks again while it is open. Default: `"10m"`.
 * - `until`: the read's output as one event of `delivers`, or `undefined` for "not yet". Pure and
 *   synchronous, as a guard is.
 *
 * The look runs once after the Gate registers, again after each restore, and every `every` while the
 * Gate is open. It stops after the run takes its event, until the Gate opens again. A looked event
 * has the Gate as its Sender and no Caller, and the feed marks it `looked`.
 */
export type GateLook<Meta, Ev, R extends AnyActorLogic = AnyActorLogic> = {
  readonly read: R;
  readonly input: (meta: Meta) => InputFrom<R>;
  readonly every?: Duration;
  readonly until: (output: LookOutput<R>, meta: Meta) => Ev | undefined;
};

/**
 * The output of a look's read.
 *
 * @internal
 */
export type LookOutput<R> = R extends { getInitialSnapshot: (...a: never[]) => { output?: infer O } }
  ? Exclude<O, undefined>
  : unknown;

/**
 * What a delivery did at one open Gate. The run took the event, or it did not: the handler threw,
 * its event is not in `delivers`, or the run does not take it now. A Gate whose handler gave
 * `undefined` was not a target, and its `reply` does not run.
 */
export type GateOutcome<Ev> =
  | { readonly state: "delivered"; readonly event: Ev; readonly run: string }
  | { readonly state: "refused"; readonly event?: Ev; readonly reason: string; readonly run: string };

/**
 * The text that the person who acted reads. Plain text: the Hook kind
 * escapes it and puts it in its envelope. Pure and synchronous. `undefined` or `""`: this Gate says
 * nothing. It runs only for a delivery whose answer a person reads (`slack`, `discord`).
 */
export type GateReply<Meta, Ev> = (
  outcome: GateOutcome<Ev>,
  at: { readonly meta: Meta; readonly caller: CallerRecord },
) => string | undefined;

/**
 * A handler: one event of `delivers`, or `undefined` to ignore the delivery.
 *
 * @internal
 */
export type GateHandler<Meta, Ev, P = unknown> = (delivery: GateIn<Meta> & { readonly payload: P }) => Ev | undefined;

/**
 * The handlers of a Gate slot, by Hook kind id and event key. Each key's payload type comes from the
 * kind's schema (`HookKinds`, `@jr2/orchestrator/hooks`).
 *
 * @internal
 */
export type GateHooks<Meta, Ev> = KindHooks<GateIn<Meta>, Ev | undefined>;

/**
 * The parts of a Gate slot, untyped: what the walk, `customize()` and the Hook's door read.
 *
 * @internal
 */
export type GateSlotParts = {
  readonly meta?: z.ZodType;
  readonly delivers: readonly EventDef[];
  readonly hooks: Readonly<Record<string, Readonly<Record<string, AnyHandler>>>>;
  readonly look?: LooseLook | typeof open | "none";
  readonly reply?: (outcome: GateOutcome<DeliveredEvent>, at: { meta: unknown; caller: CallerRecord }) => unknown;
};

/**
 * A handler, untyped.
 *
 * @internal
 */
export type AnyHandler = (delivery: { payload: unknown; meta: unknown; caller: CallerRecord }) => unknown;
/**
 * A bound look, untyped.
 *
 * @internal
 */
export type LooseLook = {
  readonly read: AnyActorLogic;
  readonly input: (meta: unknown) => unknown;
  readonly every?: Duration;
  readonly until: (output: unknown, meta: unknown) => unknown;
};

/**
 * The input of a Gate slot: the plain Gate's, with its meta typed by the slot's schema.
 *
 * @internal
 */
export type GateSlotInput<Meta> = Omit<GateInput, "meta"> &
  ({} extends Meta ? { readonly meta?: Meta } : { readonly meta: Meta });

declare const gateSlotMark: unique symbol;

/**
 * A Gate with parts that the Machine carries. Put it in `actors` and invoke it by its key. The
 * brand `gateSlot` holds its parts.
 */
export type GateSlot<Meta, Ev> = CallbackActorLogic<
  DeliveredEvent,
  {} extends Meta ? GateSlotInput<Meta> | undefined : GateSlotInput<Meta>
> & {
  readonly gateSlot: GateSlotParts;
  readonly [gateSlotMark]?: { readonly meta: Meta; readonly ev: Ev };
};

/** Is this actor logic a Gate slot (`gate({ … })`)? A duck test on the brand, as `isAgent` is. */
export function isGateSlot(logic: unknown): logic is GateSlot<unknown, unknown> {
  return isGateSlotLogic(logic);
}
export { isGateInvoke } from "./gate-brand.ts";

/** Is this look bound: a read, an input and an `until`? Not `open`, not `"none"`, not absent. */
export function isBoundLook(look: GateSlotParts["look"]): look is LooseLook {
  return typeof look === "object" && look !== null;
}

/**
 * The plain Gate, as a value: `src: "gate"`.
 *
 * @internal
 */
export type PlainGate = CallbackActorLogic<DeliveredEvent, GateInput | undefined>;

// --- The look --------------------------------------------------------------------------------------

/** How often a look reads again when its Gate names no `every`. */
export const LOOK_EVERY_DEFAULT: Duration = "10m";

/** The milliseconds of a Duration (`"90s"`, `"10m"`, `"2h"`), or undefined. */
export function lookEveryMs(d: unknown): number | undefined {
  if (typeof d !== "string") return undefined;
  const m = /^(\d+(\.\d+)?)(s|m|h)$/.exec(d);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  if (!(n > 0)) return undefined;
  return m[3] === "h" ? n * 3_600_000 : m[3] === "m" ? n * 60_000 : n * 1000;
}

/** The longest delay one timer holds: Node clamps a longer one to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Does this logic settle on its own — a promise, the one plain xstate actor that ends without being
 * stopped? Asked of its own transition: a promise logic's initial snapshot, sent xstate's resolve
 * event, is `done`. That event name is an xstate internal (5.32.2); a bump that renamed it would
 * make every promise read long-lived, and setup.test.ts pins it against the real constructors.
 */
export function settlesOnItsOwn(logic: unknown): boolean {
  const l = logic as {
    getInitialSnapshot?: (scope: unknown, input: unknown) => unknown;
    transition?: (snapshot: unknown, event: unknown, scope: unknown) => { status?: string } | undefined;
  };
  if (typeof l?.getInitialSnapshot !== "function" || typeof l.transition !== "function") return false;
  try {
    const scope = { self: {}, defer: () => {}, emit: () => {} };
    const snapshot = l.getInitialSnapshot(scope, undefined);
    return l.transition(snapshot, { type: "xstate.promise.resolve", data: undefined }, scope)?.status === "done";
  } catch {
    return false;
  }
}

/**
 * The fault of a look, or undefined when it is one that a Gate can run (ADR-0011, ADR-0067): an
 * object with `read`, `input` and `until`, a positive `every`, and a read that is an `http` Effect
 * marked `idempotent: true` or a promise actor. Any other Effect is refused, because the look runs
 * its read again after each restore and every `every`.
 */
export function lookFault(look: unknown): string | undefined {
  if (look === undefined || look === open || look === "none") return undefined;
  if (typeof look !== "object" || look === null) {
    return 'its look is a { read, input, until, every? } object, "none", or open';
  }
  const l = look as Partial<LooseLook>;
  if (typeof l.input !== "function" || typeof l.until !== "function") {
    return "its look has no input or no until function";
  }
  if (l.every !== undefined) {
    const ms = lookEveryMs(l.every);
    if (ms === undefined || ms > MAX_TIMER_MS) {
      return `its look's every ${JSON.stringify(l.every)} is not a positive duration (like "90s", "10m", "2h")`;
    }
  }
  const effect = (l.read as { effect?: { kind?: unknown; idempotent?: unknown } } | undefined)?.effect;
  if (typeof effect === "object" && effect !== null) {
    if (effect.kind === "http" && effect.idempotent === true) return undefined;
    return (
      `its look reads with ${effect.kind === "http" ? "an http Effect that is not marked idempotent: true" : `a ${String(effect.kind)} Effect`} — ` +
      "a look reads again after each restore and every `every`, so its read is an http Effect marked idempotent: true, " +
      "or a promise (ADR-0067)"
    );
  }
  if (!settlesOnItsOwn(l.read)) {
    return "its look's read is not an http Effect marked idempotent: true, or a promise (fromPromise)";
  }
  return undefined;
}

/** The fault of a Gate slot's spec, or undefined. */
function specFault(spec: unknown): string | undefined {
  if (typeof spec !== "object" || spec === null) return "it takes { meta?, delivers, hooks?, look?, reply? }";
  const s = spec as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!["meta", "delivers", "hooks", "look", "reply"].includes(key)) {
      return `"${key}" is not a part of a Gate slot (meta, delivers, hooks, look, reply)`;
    }
  }
  if (s.meta !== undefined && typeof (s.meta as { safeParse?: unknown }).safeParse !== "function") {
    return "its meta is a zod object";
  }
  if (!Array.isArray(s.delivers) || s.delivers.length === 0) {
    return "its delivers lists at least one event that defineEvent made";
  }
  const names = new Set<string>();
  for (const d of s.delivers as unknown[]) {
    const name = (d as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || typeof (d as { input?: { safeParse?: unknown } }).input?.safeParse !== "function") {
      return "an entry of its delivers is not an event that defineEvent made";
    }
    if (names.has(name)) return `its delivers lists "${name}" twice`;
    names.add(name);
  }
  const hooksFault = hooksTableFault(s.hooks);
  if (hooksFault) return hooksFault;
  if (s.reply !== undefined && typeof s.reply !== "function") return "its reply is a function";
  return lookFault(s.look);
}

/** The fault of a handler table, or undefined. A key that holds `*` is refused: a kind's schema
 * key `"block_actions.*"` types each key with that prefix, but the door matches a handler's key
 * exactly, so a handler keyed with `*` would never hear a delivery (ADR-0011). */
export function hooksTableFault(hooks: unknown): string | undefined {
  if (hooks === undefined) return undefined;
  if (typeof hooks !== "object" || hooks === null) return "its hooks are { <kind>: { <event key>: handler } }";
  for (const [kind, keys] of Object.entries(hooks)) {
    if (typeof keys !== "object" || keys === null) return `its hooks.${kind} is { <event key>: handler }`;
    for (const [key, handler] of Object.entries(keys)) {
      if (typeof handler !== "function") return `its hooks.${kind}["${key}"] is not a function`;
      if (key.includes("*")) {
        return (
          `its hooks.${kind}["${key}"] holds "*", and the door matches an event key exactly, so this handler ` +
          `never hears a delivery — name the full key, such as "block_actions.approve" (ADR-0011)`
        );
      }
    }
  }
  return undefined;
}

/** Make the parts of a slot from a spec that `specFault` passed. Frozen: the slot's parts never change. */
function partsOf(spec: Record<string, unknown>): GateSlotParts {
  const hooks: Record<string, Readonly<Record<string, AnyHandler>>> = {};
  for (const [kind, keys] of Object.entries((spec.hooks ?? {}) as Record<string, Record<string, AnyHandler>>)) {
    hooks[kind] = Object.freeze({ ...keys });
  }
  return Object.freeze({
    ...(spec.meta !== undefined ? { meta: spec.meta as z.ZodType } : {}),
    delivers: Object.freeze([...(spec.delivers as EventDef[])]),
    hooks: Object.freeze(hooks),
    ...(spec.look !== undefined ? { look: spec.look as GateSlotParts["look"] } : {}),
    ...(spec.reply !== undefined ? { reply: spec.reply as GateSlotParts["reply"] } : {}),
  });
}

/** Build a Gate slot from its parts: the actor logic with the brand. `customize()` builds one again. */
export function gateSlotOf(parts: GateSlotParts): GateSlot<unknown, unknown> {
  return Object.assign(gateLogic(parts), { gateSlot: parts }) as unknown as GateSlot<unknown, unknown>;
}

// --- The actor -------------------------------------------------------------------------------------

/**
 * What a Pool gives its `source` Gate (ADR-0017): the Source's seat, made when the Gate opens, from
 * the Pool's actor (the Gate's parent), the Gate's `sendBack` to it, and the run's actor system.
 *
 * @internal
 */
export type SourceSeatOf = (at: {
  pool: AnyActorRef;
  send: (event: DeliveredEvent) => void;
  system: AnyActorSystem;
}) => SourceSeat;

/**
 * A Pool's `source` Gate (ADR-0017): a plain Gate that also carries the push half of the Pool's
 * Source on its registration, so the Hook's fan-in reaches it as it reaches any open Gate
 * (ADR-0011). It may accept no event: a Source with no `wake` hears Hooks alone.
 *
 * @internal
 */
export function sourceGate(seat: SourceSeatOf): PlainGate {
  return gateLogic(undefined, seat);
}

function gateLogic(slot: GateSlotParts | undefined, seat?: SourceSeatOf) {
  return fromCallback<DeliveredEvent, GateInput | undefined>(({ input: raw, system, sendBack, self }) => {
    const input = raw ?? {};
    const binding = runBindingOf(system);
    // The derived id is deterministic from machine structure, so recomputing it on every (re)start
    // is restore-stable and needs no input-mapper persistence — the mapper is only load-bearing
    // where minting has a random component (mintIid's fresh-Turn suffix, ADR-0016).
    const path = actorPath(self);
    const id = input.gate ?? path.join(".");
    if (!id) {
      // Only a rootless invocation (createActor(plainGate) directly) has an empty path.
      throw new Error("gate has no derivable id (no parent actor) — pass `gate` explicitly");
    }
    if (!input.accepts?.length && !seat) {
      // Derivation found nothing (or a plain-setup machine passed nothing): a gate accepting no
      // events can never be moved — refuse loudly at invoke rather than park a dead surface.
      throw new Error(
        `gate "${id}" accepts no events — handle at least one external/any event on the ` +
          `invoking state (the accepted set derives from its transitions), or pass \`accepts\` explicitly`,
      );
    }
    // A Gate slot checks the invoking state's meta when it opens (ADR-0011): its handlers, its look
    // and its reply read the meta typed, so a meta the schema refuses never reaches them.
    let meta = input.meta;
    if (slot?.meta !== undefined) {
      const parsed = slot.meta.safeParse(input.meta ?? {});
      if (!parsed.success) {
        throw new Error(
          `gate "${id}": its meta does not match the Gate slot's meta schema — ` +
            parsed.error.issues.map((i) => `${i.path.join(".") || "(meta)"}: ${i.message}`).join("; "),
        );
      }
      meta = parsed.data as Record<string, unknown>;
    }
    const defs = resolveAccepts(self, input.accepts ?? []);
    const registration: Registration = {
      address: gateAddress(binding.runId, id),
      runId: binding.runId,
      kind: "gate",
      id,
      path,
      defs,
      meta,
      // A Gate's caller sends as the Gate's invoke id (ADR-0015): static in the config (authored, or
      // named by the walk), the same after a restore, and checkable at load — unlike the
      // caller-facing `id`, which may be computed at run time.
      sender: { party: "gate", id: self.id },
      invokeId: self.id,
      // The Machine that invoked the Gate: the one whose selection says which writing a caller's
      // event would run (ADR-0029's question, asked for the Gate's caller too).
      invoker: self._parent,
      deliver: (event) => sendBack(event),
      // The Hook's door reads the slot's handlers and its reply here (ADR-0011).
      ...(slot ? { hooked: { hooks: slot.hooks, reply: slot.reply, delivers: slot.delivers.map((d) => d.name) } } : {}),
      // A Pool's Source hears Hooks through its `source` Gate (ADR-0017).
      ...(seat && self._parent ? { source: seat({ pool: self._parent, send: sendBack, system }) } : {}),
    };
    const dispose = binding.table.register(registration);
    const look = slot && isBoundLook(slot.look) ? startLook(slot.look, registration, self, meta) : undefined;
    return () => {
      look?.();
      dispose();
    };
  });
}

/**
 * Run a Gate's look (ADR-0011): read now, and again every `every`, until the run takes the event
 * that `until` gives. Returns the stop. The read is a child of the Gate, so it is in the run's actor
 * system: an `http` read runs through the run's Instance Effector and its ledger, as any Effect does.
 * A read, an `until` or a delivery that fails is a line in the Orchestrator's log, and the Gate looks
 * again at the next `every`: it never faults the run.
 */
function startLook(
  look: LooseLook,
  reg: Registration,
  self: Parameters<Parameters<typeof fromCallback>[0]>[0]["self"],
  meta: unknown,
): () => void {
  const every = Math.min(lookEveryMs(look.every ?? LOOK_EVERY_DEFAULT) ?? 600_000, MAX_TIMER_MS);
  const binding = boundRun(self.system);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: { stop: () => void } | undefined;
  const log = (what: string): void => console.error(`run ${reg.runId}: gate ${reg.id}: look: ${what}`);
  const again = (): void => {
    if (stopped) return;
    timer = setTimeout(read, every);
    timer.unref?.();
  };
  const settle = (output: unknown): void => {
    reading = undefined;
    if (stopped) return;
    let event: unknown;
    try {
      event = look.until(output, meta);
    } catch (err) {
      log(`until threw: ${(err as Error).message}`);
      return again();
    }
    if (event === undefined) return again();
    const type = (event as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !reg.hooked?.delivers.includes(type)) {
      log(`until gave ${JSON.stringify(type)}, which is not in the Gate's delivers`);
      return again();
    }
    const { type: _type, ...payload } = event as Record<string, unknown>;
    const def = reg.defs.get(type);
    const parsed = def?.input.safeParse(payload);
    if (!def || !parsed?.success) {
      log(`until gave "${type}", which the Gate does not accept now or whose payload its def refuses`);
      return again();
    }
    // Asked as `jr2 send` asks (ADR-0013): would the run take it from this Gate now? A level that the
    // run does not take now is read again at the next `every`.
    if (!wouldMove(reg.invoker, { type, ...parsed.data, [SENDER_KEY]: reg.sender })) return again();
    // The mark first, as an Effect marks its output before it settles: the delivery can end the run
    // in its own send, and a run that has ended has no feed for the mark.
    binding?.marker?.({ kind: "looked", gate: reg.id, event: type });
    // The look reads a level, so it stops once the run takes its event, until the Gate opens again
    // (ADR-0011).
    stopped = true;
    try {
      binding?.table.deliver(reg.address, type, payload);
    } catch (err) {
      stopped = false;
      log(`the run did not take "${type}": ${(err as Error).message}`);
      return again();
    }
  };
  const read = (): void => {
    timer = undefined;
    if (stopped) return;
    let input: unknown;
    try {
      input = look.input(meta);
    } catch (err) {
      log(`input threw: ${(err as Error).message}`);
      return again();
    }
    const actor = createActor(look.read, { input, parent: self, id: "look" });
    let done = false;
    actor.subscribe({
      next: (snapshot) => {
        if (done) return;
        if (snapshot.status === "done") {
          done = true;
          settle(snapshot.output);
        }
      },
      error: (err) => {
        if (done) return;
        done = true;
        reading = undefined;
        log(`the read failed: ${(err as Error)?.message ?? String(err)}`);
        again();
      },
    });
    reading = actor;
    actor.start();
  };
  // Once after the Gate registered: a change before the read is in its answer, and a change after
  // it reaches the Gate as a delivery. Not inside the registration's own start: the Gate's
  // registration and the run's save come first.
  queueMicrotask(read);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    reading?.stop();
    reading = undefined;
  };
}

/** The plain Gate's logic: what jr2Setup registers as `src: "gate"`, and what a test's
 * `provide({ actors: { gate: … } })` replaces. */
export const plainGate: PlainGate = gateLogic(undefined);

/**
 * The Gate: an input that a run waits for from outside the run (ADR-0011).
 *
 * `gate({ … })` declares a GATE SLOT that also hears a Hook: put it in `actors` and invoke it by
 * its key. A plain Gate needs no value: jr2Setup puts it in each Machine as `invoke: { src: "gate" }`.
 * Its accepted set derives from the invoking state's transitions, and a Caller answers it with
 * `jr2 send`, the Console or `POST /runs/:runId/gates/:gate/events`.
 *
 * - `meta`: a zod object of the meta that the invoking state sets. The Gate checks it when it
 *   opens, and the handlers, the look and `reply` read it typed.
 * - `delivers`: the events that the handlers and the look can give. An event whose def leaves the
 *   audience unset reads as `audience: "external"`, so no Agent below the Gate has it on its Menu.
 *   `createMachine` refuses an entry that the Gate's derived accepted set does not hold.
 * - `hooks`: a handler for each Hook kind id and event key. A handler reads `{ payload, meta,
 *   caller }` and gives one event of `delivers`, or `undefined` to ignore the delivery. It is pure
 *   and synchronous. A throw is a refusal that the hook log keeps; it never faults the run.
 * - `look`: the Gate's read of the fact that it waits for (see {@link GateLook}), `"none"` for a
 *   Gate that hears a command, or `open` for the composer to bind with
 *   `customize(m, { gates: { <slot>: { look } } })`. With no look and no `after` on the invoking
 *   state, or with an Open look, `jr2 up` warns.
 * - `reply`: the text that the person who acted reads, for a Hook kind whose answer a person reads.
 *
 * It throws on a spec that it cannot run: an unknown key, a `delivers` that is empty or that holds an
 * entry `defineEvent` did not make, a handler that is not a function, or a look whose read is not an
 * `http` Effect marked `idempotent: true` or a promise.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import type {} from "@jr2/orchestrator/hooks/github";
 * import { defineEvent, gate, jr2Setup } from "@jr2/orchestrator";
 *
 * const approve = defineEvent({ name: "approve", input: z.object({ by: z.string() }) });
 *
 * const review = gate({
 *   meta: z.object({ pr: z.string(), sha: z.string() }),
 *   delivers: [approve],
 *   hooks: {
 *     github: {
 *       "pull_request_review.submitted": ({ payload, meta }) =>
 *         payload.pull_request.html_url === meta.pr &&
 *         payload.review.commit_id === meta.sha &&
 *         payload.review.state === "approved"
 *           ? { type: "approve", by: payload.review.user.login }
 *           : undefined,
 *     },
 *   },
 *   look: "none",
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: { pr: string; sha: string }; input: { pr: string; sha: string } },
 *   events: [approve],
 *   actors: { review },
 * }).createMachine({
 *   id: "pr",
 *   context: ({ input }) => input,
 *   initial: "inReview",
 *   states: {
 *     inReview: {
 *       invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr, sha: context.sha } }) },
 *       on: { approve: "merged" },
 *     },
 *     merged: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/gates.md
 * @see docs/guides/answer-a-gate-from-a-forge.md
 * @see docs/reference/decisions/0011-workflow-defined-events.md
 */
export function gate<
  const D extends readonly EventDef[],
  M extends z.ZodObject = z.ZodObject<{}>,
  R extends AnyActorLogic = never,
>(spec: {
  /** A zod object for the meta that the invoking state sets. The Gate checks it when it opens. */
  readonly meta?: M;
  /** The events that the handlers and the look can give. */
  readonly delivers: D;
  /** The handlers, by Hook kind id and event key. */
  readonly hooks?: GateHooks<z.output<NoInfer<M>>, Delivered<D>>;
  /** The look, `"none"` for a Gate that hears a command, or `open` for its composer to bind. */
  readonly look?: GateLook<z.output<NoInfer<M>>, Delivered<D>, R> | typeof open | "none";
  /** The text that the person who acted reads. */
  readonly reply?: GateReply<z.output<NoInfer<M>>, Delivered<D>>;
}): GateSlot<z.output<M>, Delivered<D>> {
  const fault = specFault(spec);
  if (fault) throw new Error(`gate(): ${fault} (ADR-0011)`);
  return gateSlotOf(partsOf(spec as unknown as Record<string, unknown>)) as GateSlot<z.output<M>, Delivered<D>>;
}
