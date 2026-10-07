// The load walk's Effect checks (ADR-0067), run inside `jr2Setup.createMachine` beside ADR-0015's.
//
//   - A PICK PARAM THAT NOTHING READS. Every param of every pick that enters a state invoking an
//     Effect is read by that invoke's input — `fromPick` for each param that is a key of the Effect's
//     input (a command's argv slots) or that its `fill` reads, a plain mapper probed with a recording
//     event — or stored by an `assign` on the entering transition or the state's entry.
//     Else the Agent supplies it and nothing uses it: refused. A `fill` that sets a key that is also a
//     param drops the Agent's value: refused. A `fromPick` of another pick than the one that enters
//     the state reads params that are not there: refused. A mapper or an assign the probe cannot run
//     is a WARNING, never silent: its params are unchecked.
//   - THE NARROW NO-onDone WARNING. Where an Agent's state answers on a mode's entry (`answer`), an
//     Effect below it with no `onDone` settles in place: that mode is not entered again, and the
//     Agent reads the Effect's output, not the answer. Everywhere else a settled child with no
//     `onDone` is Rest, and the one-line form is correct — silent on purpose.
//
// The probe reads, it never runs work: a mapper is called with a Proxy event whose reads are
// recorded, and a context and self that survive any read. An assign is pure by contract, and only
// an assign is probed.

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

  // Who enters each state, by event, with the entering transitions' actions. A target that is a
  // compound or parallel state also enters its initial descendants.
  const enteredBy = (t: Node): Node[] => {
    if (t.type === "parallel") return [t, ...Object.values(t.states).flatMap(enteredBy)];
    if (t.type === "compound") return [t, ...t.initial.target.flatMap(enteredBy)];
    return [t];
  };
  const entering = new Map<Node, Map<string, unknown[]>>();
  for (const n of all) {
    for (const [event, candidates] of n.transitions) {
      for (const t of candidates) {
        for (const target of (t.target ?? []).flatMap(enteredBy)) {
          const byEvent = entering.get(target) ?? new Map<string, unknown[]>();
          byEvent.set(event, [...(byEvent.get(event) ?? []), ...t.actions]);
          entering.set(target, byEvent);
        }
      }
    }
  }

  for (const n of all) {
    const configs = [n.config.invoke ?? []].flat() as Array<{ input?: unknown } | undefined>;
    n.invoke.forEach((inv, i) => {
      const logic = logicOf(inv.src);
      if (!isEffect(logic)) return;
      const keys = inputKeysOf(logic.effect);
      const slot = typeof inv.src === "string" ? inv.src : inv.id;
      const mapper = configs[i]?.input;
      for (const [event, actions] of entering.get(n) ?? []) {
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
        // A param the entering transition or the state's entry STORES reaches the Machine too.
        for (const action of [...actions, ...n.entry]) {
          try {
            probeAssign(action, recordingEvent(event, params, read));
          } catch (err) {
            probed = false;
            warnings.push(`${where}: could not probe an assign (${messageOf(err)}); its params are unchecked`);
          }
        }
        const lost = params.filter((p) => !read.has(p));
        if (probed && lost.length && isPickMapper(mapper)) {
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
  return { errors, warnings };
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

/** Run an `assign` against the probe's event: only assign is pure by contract, and only it is run. */
function probeAssign(action: unknown, event: unknown): void {
  if (typeof action !== "function" || (action as { type?: unknown }).type !== "xstate.assign") return;
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
