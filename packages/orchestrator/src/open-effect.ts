// An Effect's OPEN parts (ADR-0054, ADR-0067): a packaged Machine cannot know the host its http
// Effect calls, or the program its command runs, so it leaves that part Open — the `open` sentinel
// in place of an `http` url (whatever its body), or of a command's argv — and the composer binds it once,
// with `customize(machine, { effects: { <slot>: { url } | { argv } } })`. Never per run: the
// binding is a value, not a mapper over the door, so the host stays fixed before any run starts
// and `jr2 up` reads the bound part as it reads one the author wrote — the placement,
// the secrets it names, the Effector's fence.
//
// An Open Effect is a slot whose logic is unbound: it carries the parts the walk reads (the
// kind, the placement, the secrets its other parts name, the Open part marked with the sentinel)
// and a binder, and it runs nothing. Binding calls the Effect's own constructor again with the
// definition and the bound part, so a bound Effect is checked by every rule the constructor checks
// for an Effect written whole, and is the same logic. The compiler's check is the one it misses:
// an Open argv's input is one string per key, so a slot the invoke does not supply faults when the
// Effect starts. `jr2 up` refuses a registered Machine whose Open
// part nothing bound, naming the `customize` line; the unbound logic is the second fence, for every
// path that walk never saw — a run of it faults before anything is sent.
//
// This module holds only the sentinel's Effect half: the binder's key, the unbound logic, and the
// phantom type `customize()` reads. It imports no Effect kind, so every kind imports it.

import type { ActorLogic, AnyActorRef, EventObject } from "xstate";
import { open } from "./open.ts";
import type { Arg, EffectLogic, EffectParts, EffectSnapshot } from "./effect.ts";
import type { Text } from "./http-effect.ts";

/** The parts of an Effect a package may leave Open: an http url, a command's argv. */
export type OpenEffectPart = "url" | "argv";

/** What a composer binds an Open part to: a url (a string, or a `text` with a secret in its
 * path), or an argv (each entry one argument, never shell text). */
export type EffectBinding = { readonly url: string | Text } | { readonly argv: readonly (string | Arg)[] };

declare const openPart: unique symbol;

/**
 * The TYPE half of an Open Effect: its logic type says which part is Open, so `customize()`'s
 * `effects` offers exactly the Open slots, each with the binding its kind takes. Phantom, like
 * `JR2Wrapper`: the property exists in the type alone.
 */
export type OpenEffect<P extends OpenEffectPart> = { readonly [openPart]: P };

/** The binder an Open Effect carries, under a `Symbol.for` key so a second copy of this module (an
 * Instance's own `@jr2/orchestrator` beside the CLI's) reads it. Not enumerable. */
const BIND: unique symbol = Symbol.for("jr2.effect.bind");

type Binder = (binding: EffectBinding) => EffectLogic<unknown, unknown>;

/** Which part of these parts is Open, if any. */
export function openPartOf(parts: EffectParts): OpenEffectPart | undefined {
  if (parts.kind === "http" && parts.url === open) return "url";
  if (parts.kind === "command" && parts.argv === open) return "argv";
  return undefined;
}

/** The binder of an Open Effect's logic; undefined for an Effect whose parts are all fixed. */
export function binderOf(logic: unknown): Binder | undefined {
  const bind = (logic as { [BIND]?: unknown } | null | undefined)?.[BIND];
  return typeof bind === "function" ? (bind as Binder) : undefined;
}

/** The fix line for an Open part, as `customize()` takes it under `effects`. */
export function effectBindingLine(slot: string, part: OpenEffectPart): string {
  return part === "url"
    ? `{ effects: { ${slot}: { url: "https://<host>/<path>" } } }`
    : `{ effects: { ${slot}: { argv: ["<program>", "<arg>"] } } }`;
}

type Fault = { type: "jr2.effect.error"; error: unknown };

/**
 * The unbound logic of an Effect with an Open part: the parts the walk reads, the binder
 * `customize()` calls, and a start that faults (a config defect, ADR-0067) naming the line that
 * binds it. It sends nothing and writes no ledger row.
 */
export function openEffectLogic<I, O, P extends OpenEffectPart>(
  parts: EffectParts,
  part: P,
  bind: Binder,
): EffectLogic<I, O> & OpenEffect<P> {
  const logic: ActorLogic<EffectSnapshot<O, I>, EventObject, I> = {
    getInitialSnapshot: (_scope, input) => ({
      status: "active",
      output: undefined,
      error: undefined,
      input,
      effectId: "",
    }),
    transition: (snapshot, event) => {
      if (snapshot.status !== "active") return snapshot;
      if (event.type === "jr2.effect.error") {
        return { ...snapshot, status: "error", error: (event as Fault).error, input: undefined };
      }
      if (event.type === "xstate.stop") return { ...snapshot, status: "stopped", input: undefined };
      return snapshot;
    },
    start: (snapshot, { self }) => {
      if (snapshot.status !== "active") return;
      const slot = slotOf(self);
      const error = new Error(
        `${parts.kind} "${slot}" leaves its ${part} Open — nobody bound it; bind it where the Machine is ` +
          `registered (\`customize(<machine>, ${effectBindingLine(slot, part)})\`), because a packaged Machine ` +
          "cannot know it; nothing was sent (ADR-0054)",
      );
      const fault: Fault = { type: "jr2.effect.error", error };
      self.send(fault);
    },
    getPersistedSnapshot: (snapshot) => snapshot,
  };
  Object.defineProperty(logic, BIND, { value: bind, enumerable: false });
  return Object.assign(logic, { effect: parts }) as unknown as EffectLogic<I, O> & OpenEffect<P>;
}

const slotOf = (self: AnyActorRef): string => (typeof self.src === "string" ? self.src : self.id);
