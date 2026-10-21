// An Effect's OPEN parts (ADR-0054, ADR-0067): a packaged Machine cannot know the host its http
// Effect calls, the program its command runs, or the secret its composer spends, so it leaves that
// part Open — the `open` sentinel in place of an `http` url (whatever its body) or of a command's
// argv, or `secret(open)` in place of a secret's name in its auth, a header or a command's env — and
// the composer binds it once, with `customize(machine, { effects: { <slot>: { url } | { argv } |
// { secret } } })`. An Effect may leave its url or its argv Open AND name an Open secret: one
// binding object takes both keys. Never per run: the binding is a value, not a mapper over the door,
// so the host stays fixed before any run starts and `jr2 up` reads the bound part as it reads one
// the author wrote — the placement, the secrets it names, the Effector's fence.
//
// An Open Effect is a slot whose logic is unbound: it carries the parts the walk reads (the
// kind, the placement, the secrets its other parts name, each Open part marked) and a binder, and
// it runs nothing. Binding calls the Effect's own constructor again with the definition and the
// bound parts, so a bound Effect is checked by every rule the constructor checks for an Effect
// written whole, and is the same logic; a binding that leaves one of two Open parts unbound gives an
// Effect still Open in that part. The compiler's check is the one it misses: an Open argv's input is
// one string per key, so a slot the invoke does not supply faults when the Effect starts. `jr2 up`
// refuses a registered Machine whose Open part nothing bound, naming the `customize` line; the
// unbound logic is the second fence, for every path that walk never saw — a run of it faults
// before anything is sent.
//
// This module holds only the sentinel's Effect half: the binder's key, the unbound logic, and the
// phantom type `customize()` reads. It imports no Effect kind, so every kind imports it.

import type { ActorLogic, AnyActorRef, EventObject } from "xstate";
import { open } from "./open.ts";
import type { Arg, EffectLogic, EffectParts, EffectSnapshot } from "./effect.ts";
import type { Secret, Text } from "./http-effect.ts";

/** The parts of an Effect a package may leave Open: an http url, a command's argv, a secret's name,
 * a dispatch's target (its url and token together, ADR-0071). */
export type OpenEffectPart = "url" | "argv" | "secret" | "target";

/** What a composer binds an Effect's Open parts to, each key one part: a url (a string, or a `text`
 * with a secret in its path), an argv (each entry one argument, never shell text), a secret's name
 * (its file in the Effector's mount, ADR-0068), a dispatch's target (another Orchestrator's origin and
 * the secret that holds its Instance token, bound as one, ADR-0071). One object for an Effect with
 * two Open parts. */
export type EffectBinding = {
  readonly url?: string | Text;
  readonly argv?: readonly (string | Arg)[];
  readonly secret?: string;
  readonly target?: { readonly url: string; readonly token: Secret };
};

declare const openPart: unique symbol;

/**
 * The TYPE half of an Open Effect: its logic type says which parts are Open, so `customize()`'s
 * `effects` offers exactly the Open slots, each with the binding its parts take — the intersection
 * of each part's, for an Effect with two. Phantom, like `JR2Wrapper`: the property exists in the
 * type alone.
 */
export type OpenEffect<P extends OpenEffectPart> = { readonly [openPart]: P };

/** The phantom for these Open parts, or nothing for none: what a constructor's type adds. */
export type OpenOf<P extends OpenEffectPart> = [P] extends [never] ? unknown : OpenEffect<P>;

/** The binder an Open Effect carries, under a `Symbol.for` key so a second copy of this module (an
 * Instance's own `@jr2/orchestrator` beside the CLI's) reads it. Not enumerable. */
const BIND: unique symbol = Symbol.for("jr2.effect.bind");

type Binder = (binding: EffectBinding) => EffectLogic<unknown, unknown>;

/** Which parts of these parts are Open, in binding order: the url, the argv or the target, then the
 * secret. A dispatch's target is one part: its token is never `secret(open)` (ADR-0071). */
export function openPartsOf(parts: EffectParts): OpenEffectPart[] {
  const out: OpenEffectPart[] = [];
  if (parts.kind === "http" && parts.url === open) out.push("url");
  if (parts.kind === "command" && parts.argv === open) out.push("argv");
  if (parts.kind === "dispatch" && parts.target === open) out.push("target");
  if (parts.kind !== "push" && parts.openSecret) out.push("secret");
  return out;
}

/** The binder of an Open Effect's logic; undefined for an Effect whose parts are all fixed. */
export function binderOf(logic: unknown): Binder | undefined {
  const bind = (logic as { [BIND]?: unknown } | null | undefined)?.[BIND];
  return typeof bind === "function" ? (bind as Binder) : undefined;
}

/** What the fix line writes for each Open part: a sample of the value its binding takes. */
const BINDING_SAMPLE: Record<OpenEffectPart, string> = {
  url: 'url: "https://<host>/<path>"',
  argv: 'argv: ["<program>", "<arg>"]',
  secret: 'secret: "<name>"',
  target: 'target: { url: "https://<host>", token: secret("<name>") }',
};

/** One binding object for these Open parts — `{ url: "…", secret: "<name>" }` for two. */
export function effectBindingShape(parts: OpenEffectPart | readonly OpenEffectPart[]): string {
  const list = typeof parts === "string" ? [parts] : parts;
  return `{ ${list.map((p) => BINDING_SAMPLE[p]).join(", ")} }`;
}

/** The fix line for an Effect's Open parts, as `customize()` takes it under `effects`. */
export function effectBindingLine(slot: string, parts: OpenEffectPart | readonly OpenEffectPart[]): string {
  return `{ effects: { ${slot}: ${effectBindingShape(parts)} } }`;
}

/** The Open parts in words: "url", "url and secret". */
export function openPartsText(parts: OpenEffectPart | readonly OpenEffectPart[]): string {
  return (typeof parts === "string" ? [parts] : parts).join(" and ");
}

type Fault = { type: "jr2.effect.error"; error: unknown };

/**
 * The unbound logic of an Effect with Open parts: the parts the walk reads, the binder
 * `customize()` calls, and a start that faults (a config defect, ADR-0067) naming the line that
 * binds them. It sends nothing and writes no ledger row.
 */
export function openEffectLogic<I, O, P extends OpenEffectPart>(
  parts: EffectParts,
  open: readonly P[],
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
        `${parts.kind} "${slot}" leaves its ${openPartsText(open)} Open — nobody bound it; bind it where the ` +
          `Machine is registered (\`customize(<machine>, ${effectBindingLine(slot, open)})\`), because a packaged ` +
          "Machine cannot know it; nothing was sent (ADR-0054)",
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
