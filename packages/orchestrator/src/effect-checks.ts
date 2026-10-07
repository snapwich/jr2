// The load walk's Effect checks (ADR-0067), run inside `jr2Setup.createMachine` beside ADR-0015's.
//
//   - A PICK PARAM THAT NOTHING READS. Every param of every pick that enters a state invoking an
//     Effect is read by that invoke's input — `fromPick` for each param that is a key of the Effect's
//     input (a command's argv slots) or that its `fill` reads, a plain mapper probed with a recording
//     event — or read by the entering transition's guard, or stored by an `assign` on the entering
//     transition or on the entry of any state it enters (its targets, their ancestors below the
//     transition's domain, their initial descendants — xstate's entry set — and what an eventless
//     `always` on an entered state enters next, with that transition's guard and actions). Else the
//     Agent supplies it and nothing uses it: refused. A pick that targets a history state enters what
//     was last active, which the walk cannot know: where that may be an Effect's state, a warning. A
//     `fill` that sets a key that is also a param drops the Agent's value: refused. A `fromPick` of
//     another pick than the one that enters the state reads params that are not there: refused.
//     Code the probe cannot or does not run — a mapper or guard that throws, any action other than
//     an assign — may read a param, so where a param is left unread the walk WARNS, never refuses
//     and never stays silent: its params are unchecked.
//   - THE NARROW NO-onDone WARNING. Where an Agent's state answers on a mode's entry (`answer`), an
//     Effect below it with no `onDone` settles in place: that mode is not entered again, and the
//     Agent reads the Effect's output, not the answer. Everywhere else a settled child with no
//     `onDone` is Rest, and the one-line form is correct — silent on purpose.
//
// The probe reads, it never runs work: a mapper is called with a Proxy event whose reads are
// recorded, and a context and self that survive any read. A guard and an assign are pure by
// contract, and only they are probed; any other action may do work, and is never run.

import type { AnyStateMachine, UnknownActorLogic } from "xstate";
import type { EventDef } from "@jr2/agent-protocol";
import { isAgent } from "./agent.ts";
import { inputKeysOf, isEffect } from "./effect.ts";
import { isAnswer, isPickMapper } from "./pick.ts";

type Node = AnyStateMachine["root"];

/** What the walk found: refusals, and warnings. */
export type EffectFindings = { errors: string[]; warnings: string[] };

export function effectChecks(
  machine: AnyStateMachine,
  actors: Record<string, UnknownActorLogic>,
  defs: Map<string, EventDef>,
): EffectFindings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const all: Node[] = [];
  const collect = (n: Node): void => {
    all.push(n);
    for (const child of Object.values(n.states)) collect(child);
  };
  collect(machine.root);
  const logicOf = (src: unknown): unknown => (typeof src === "string" ? actors[src] : src);

  // Who enters each state, by event: the entering transitions' guards and actions, and the entry
  // actions of every state those transitions enter. A transition enters what xstate enters (its
  // entry set), so a pick that targets a compound state enters the child that invokes, and a pick
  // that targets a child enters the ancestor that invokes.
  // An eventless transition (`always`) on a state the event entered runs in the same macrostep, with
  // the same event: what it enters, the event enters too, and its guard and actions read the event.
  // History is the one target the walk cannot follow: it enters what was last active.
  type Entering = { guards: unknown[]; actions: unknown[]; entries: unknown[] };
  const entering = new Map<Node, Map<string, Entering>>();
  const record = (event: string, entered: Set<Node>, path: readonly Transition[]): void => {
    const entries = [...entered].flatMap((s) => s.entry);
    const guards = path.flatMap((t) => (t.guard === undefined ? [] : [t.guard]));
    const actions = path.flatMap((t) => t.actions);
    for (const target of entered) {
      const byEvent = entering.get(target) ?? new Map<string, Entering>();
      const seen = byEvent.get(event) ?? { guards: [], actions: [], entries: [] };
      byEvent.set(event, {
        guards: [...seen.guards, ...guards],
        actions: [...seen.actions, ...actions],
        entries: [...new Set([...seen.entries, ...entries])],
      });
      entering.set(target, byEvent);
    }
  };
  const follow = (event: string, t: Transition, path: readonly Transition[], seen: Set<Transition>): void => {
    const entered = entrySetOf(t, machine.root);
    const here = [...path, t];
    record(event, entered, here);
    for (const s of entered) {
      for (const next of s.always ?? []) {
        if (seen.has(next)) continue;
        follow(event, next, here, new Set([...seen, next]));
      }
    }
    // A history target: what it enters is not known at load, so an Effect it may enter is
    // unchecked — a warning, never silence.
    for (const h of (t.target ?? []).filter((s) => s.type === "history")) {
      const def = defs.get(event);
      if (!def || Object.keys(def.input.shape).length === 0 || !h.parent) continue;
      const effects = below(h.parent).filter((s) => s.invoke.some((inv) => isEffect(logicOf(inv.src))));
      if (!effects.length) continue;
      warnings.push(
        `pick "${event}" targets history state "${h.id}", which enters what was last active — the walk cannot ` +
          `tell which of ${effects.map((s) => `"${s.id}"`).join(", ")} it enters, so whether each param of ` +
          `"${event}" is read there is unchecked`,
      );
    }
  };
  const below = (p: Node): Node[] => Object.values(p.states).flatMap((c) => [c, ...below(c)]);
  for (const n of all) {
    for (const [event, candidates] of n.transitions) {
      for (const t of candidates) follow(event, t, [], new Set());
    }
  }
  const namedGuards = (machine.implementations?.guards ?? {}) as Record<string, unknown>;

  for (const n of all) {
    const configs = [n.config.invoke ?? []].flat() as Array<{ input?: unknown } | undefined>;
    n.invoke.forEach((inv, i) => {
      const logic = logicOf(inv.src);
      if (!isEffect(logic)) return;
      const keys = inputKeysOf(logic.effect);
      const slot = typeof inv.src === "string" ? inv.src : inv.id;
      const mapper = configs[i]?.input;
      for (const [event, { guards, actions, entries }] of entering.get(n) ?? []) {
        if (isPickMapper(mapper) && mapper.pick.name !== event) {
          errors.push(
            `state "${n.id}" (Effect "${slot}") reads the params of pick "${mapper.pick.name}" but is entered on ` +
              `"${event}" — that event does not carry them`,
          );
          continue;
        }
        const def = defs.get(event);
        if (!def) continue;
        const params = Object.keys(def.input.shape);
        if (params.length === 0) continue;
        const where = `pick "${event}" enters state "${n.id}" (Effect "${slot}")`;
        const read = new Set<string>();
        let probed = true;
        if (isPickMapper(mapper)) {
          // Params flow by NAME: one that is no key of the Effect's input reaches nothing, and
          // TypeScript does not reject an extra key on a spread. Only `fill` can still read it.
          for (const p of params) if (keys.includes(p)) read.add(p);
          if (mapper.fill) {
            try {
              const filled = mapper.fill({ context: anything(), params: recorder(params, read) });
              for (const p of params) {
                if (filled && typeof filled === "object" && p in filled) {
                  read.delete(p);
                  errors.push(
                    `${where}: \`fill\` sets "${p}", which is also a param of the pick — the Machine's value wins ` +
                      `and the Agent's is dropped; rename one, or drop it from the def`,
                  );
                }
              }
            } catch (err) {
              probed = false;
              warnings.push(
                `${where}: could not probe fromPick's fill (${messageOf(err)}); a param it reads or overwrites is unchecked`,
              );
            }
          }
        } else if (typeof mapper === "function") {
          try {
            (mapper as (args: unknown) => unknown)({
              event: recordingEvent(event, params, read),
              context: anything(),
              self: anything(),
            });
          } catch (err) {
            probed = false;
            warnings.push(`${where}: could not probe the input mapper (${messageOf(err)}); its params are unchecked`);
          }
        }
        // A param the entering transition's guard READS, or an assign on it or on the entry of a
        // state it enters STORES, reaches the Machine too. A guard and an assign are pure by
        // contract: both are run.
        for (const guard of guards) {
          try {
            probeGuard(guard, recordingEvent(event, params, read), namedGuards);
          } catch (err) {
            probed = false;
            warnings.push(`${where}: could not probe a guard (${messageOf(err)}); its params are unchecked`);
          }
        }
        const unrun: string[] = [];
        for (const action of [...actions, ...entries]) {
          if (!isAssign(action)) {
            unrun.push(actionName(action));
            continue;
          }
          try {
            probeAssign(action, recordingEvent(event, params, read));
          } catch (err) {
            probed = false;
            warnings.push(`${where}: could not probe an assign (${messageOf(err)}); its params are unchecked`);
          }
        }
        const lost = params.filter((p) => !read.has(p));
        if (probed && lost.length && unrun.length) {
          // Any other action may do work, so the probe never runs one; it may read the param.
          warnings.push(
            `${where}: nothing the walk can run reads ${lost.map((p) => `"${p}"`).join(", ")}; an action it does ` +
              `not run (${unrun.join(", ")}) may — unchecked. If none reads it, the Agent supplies it and nothing ` +
              `uses it`,
          );
        } else if (probed && lost.length && isPickMapper(mapper)) {
          errors.push(
            `${where} with fromPick: ${lost.map((p) => `"${p}"`).join(", ")} is no key of the Effect's input ` +
              `(${keys.join(", ") || "none"}), and nothing else reads it — the Agent supplies it and it reaches ` +
              `nothing; name an argv slot for it, read it in \`fill\`, store it with assign, or drop it from the def`,
          );
        } else if (probed && lost.length) {
          errors.push(
            `${where}, which never reads ${lost.map((p) => `"${p}"`).join(", ")}: the Agent supplies it and nothing ` +
              `uses it — map it in the invoke's input, store it with assign, or drop it from the def`,
          );
        }
      }
    });
  }

  // The narrow no-onDone warning, per Agent's state.
  const invokesAgent = (n: Node): string | undefined =>
    n.invoke.find((inv) => typeof inv.src === "string" && isAgent(actors[inv.src]))?.src as string | undefined;
  for (const a of all) {
    const agent = invokesAgent(a);
    if (agent === undefined) continue;
    const below: Node[] = [];
    const descend = (p: Node): void => {
      for (const child of Object.values(p.states)) {
        if (invokesAgent(child) !== undefined || child.invoke.some((inv) => inv.src === "gate")) continue;
        below.push(child);
        descend(child);
      }
    };
    descend(a);
    const answering = below.find((m) => m.invoke.length === 0 && m.entry.some(isAnswer));
    if (!answering) continue;
    for (const m of below) {
      for (const inv of m.invoke) {
        if (!isEffect(logicOf(inv.src)) || m.transitions.has(`xstate.done.actor.${inv.id}`)) continue;
        const slot = typeof inv.src === "string" ? inv.src : inv.id;
        warnings.push(
          `"${m.id}" invokes Effect "${slot}" with no onDone, and "${answering.id}" answers the Agent on entry: the ` +
            `settled Effect stays in "${m.key}", "${answering.key}" is not entered again, and Agent "${agent}" reads ` +
            `the Effect's output, not that answer — add onDone: "${answering.key}" if the answer must run`,
        );
      }
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}

type Transition = {
  source: Node;
  target?: readonly Node[] | undefined;
  reenter: boolean;
  guard?: unknown;
  actions: readonly unknown[];
};

const isDescendant = (s: Node, of: Node): boolean => {
  for (let p = s.parent; p; p = p.parent) if (p === of) return true;
  return false;
};
const properAncestors = (s: Node, upTo?: Node): Node[] => {
  const out: Node[] = [];
  for (let p = s.parent; p && p !== upTo; p = p.parent) out.push(p);
  return out;
};

/**
 * The states a transition enters: xstate's own entry set (`computeEntrySet`), less history. A
 * target is entered unless it is the source of a transition that does not reenter; below each
 * entered state, its initial child (compound) or every region (parallel); above each target, its
 * ancestors below the transition's domain, with every other region of a parallel one. A history
 * target enters what was last active, which the walk cannot know: it is skipped here, and the caller
 * warns where it may enter an Effect.
 */
function entrySetOf(t: Transition, root: Node): Set<Node> {
  const targets = (t.target ?? []).filter((s) => s.type !== "history");
  const enter = new Set<Node>();
  const domain = ((): Node | undefined => {
    if (!t.reenter && targets.every((s) => s === t.source || isDescendant(s, t.source))) return t.source;
    const [head, ...tail] = [...targets, t.source];
    for (const anc of properAncestors(head!)) if (tail.every((s) => isDescendant(s, anc))) return anc;
    return t.reenter ? undefined : root;
  })();
  const regions = (p: Node): void => {
    for (const region of Object.values(p.states)) {
      if (region.type === "history" || [...enter].some((s) => isDescendant(s, region))) continue;
      enter.add(region);
      descend(region);
    }
  };
  const descend = (s: Node): void => {
    if (s.type === "compound") {
      const initial = s.initial.target[0];
      if (!initial || initial.type === "history") return;
      enter.add(initial);
      descend(initial);
    } else if (s.type === "parallel") regions(s);
  };
  for (const s of targets) {
    if (s !== t.source || t.source !== domain || t.reenter) enter.add(s);
    descend(s);
  }
  const within = !t.source.parent && t.reenter ? undefined : domain;
  for (const s of targets) {
    const ancestors = properAncestors(s, domain);
    if (domain?.type === "parallel") ancestors.push(domain);
    for (const anc of ancestors) {
      if (!within || isDescendant(anc, within)) enter.add(anc);
      if (anc.type === "parallel") regions(anc);
    }
  }
  return enter;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The probe's entering event: `type` is the pick; every other read is recorded. Spread and
 * destructuring see the params as own keys, so `paramsOf` and `{ type, ...rest }` record too. */
function recordingEvent(type: string, params: readonly string[], read: Set<string>): Record<string, unknown> {
  return new Proxy({ type } as Record<string, unknown>, {
    get(target, key) {
      if (key === "type") return target["type"];
      if (typeof key === "string" && params.includes(key)) read.add(key);
      return typeof key === "string" && params.includes(key) ? `\u0000param:${key}` : undefined;
    },
    ownKeys: () => ["type", ...params],
    getOwnPropertyDescriptor: (target, key) =>
      key === "type" || (typeof key === "string" && params.includes(key))
        ? { configurable: true, enumerable: true, writable: true, value: key === "type" ? target["type"] : undefined }
        : undefined,
  });
}

/** The probe's `params` for `fill`: records reads. */
function recorder(params: readonly string[], read: Set<string>): never {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (typeof key === "string" && params.includes(key)) read.add(key);
      return typeof key === "string" ? `\u0000param:${key}` : undefined;
    },
  }) as never;
}

const isAssign = (action: unknown): boolean =>
  typeof action === "function" && (action as { type?: unknown }).type === "xstate.assign";

/** How a warning names an action the probe does not run. */
function actionName(action: unknown): string {
  if (typeof action === "string") return `"${action}"`;
  const type = (action as { type?: unknown } | null)?.type;
  if (typeof type === "string") return type.startsWith("xstate.") ? type.slice("xstate.".length) : `"${type}"`;
  return "an inline action";
}

/**
 * Run a guard against the probe's event: a guard is pure by contract (xstate). Inline, named (by
 * string or `{ type, params }`, from the Machine's own guards), and inside `and`/`or`/`not`. A
 * guard that reads no event (`stateIn`) is nothing to probe. A named guard the Machine does not
 * carry throws: the caller warns.
 */
function probeGuard(guard: unknown, event: unknown, named: Record<string, unknown>): void {
  if (guard === undefined) return;
  if (typeof guard === "string") return probeGuard({ type: guard }, event, named);
  if (typeof guard === "function") {
    const nested = (guard as { guards?: unknown }).guards;
    if (Array.isArray(nested)) {
      for (const g of nested) probeGuard(g, event, named);
      return;
    }
    if ((guard as { check?: unknown }).check !== undefined) return;
    (guard as (args: unknown, params: unknown) => unknown)({ context: anything(), event }, undefined);
    return;
  }
  const { type, params } = guard as { type?: unknown; params?: unknown };
  const impl = typeof type === "string" ? named[type] : undefined;
  if (typeof impl !== "function") throw new Error(`no guard named ${JSON.stringify(type)}`);
  const resolved = typeof params === "function" ? params({ context: anything(), event }) : params;
  (impl as (args: unknown, params: unknown) => unknown)({ context: anything(), event }, resolved);
}

/** Run an `assign` against the probe's event: an assign is pure by contract, and is run. */
function probeAssign(action: unknown, event: unknown): void {
  if (!isAssign(action)) return;
  const assignment = (action as { assignment?: unknown }).assignment;
  const args = { event, context: anything(), self: anything(), spawn: anything() };
  const call = (f: unknown): void => {
    if (typeof f === "function") (f as (a: unknown) => unknown)(args);
  };
  if (typeof assignment === "function") call(assignment);
  else if (assignment && typeof assignment === "object") Object.values(assignment).forEach(call);
}

/** A value that survives any read, call, or coercion — the probe's context and self. */
function anything(): never {
  const f = function () {};
  const p: unknown = new Proxy(f, {
    get: (_t, key) =>
      key === Symbol.toPrimitive ? () => "" : key === Symbol.iterator ? [][Symbol.iterator].bind([]) : p,
    apply: () => p,
  });
  return p as never;
}
