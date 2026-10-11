// The load walk's Effect checks (ADR-0067), run inside `jr2Setup.createMachine` beside ADR-0015's.
//
//   - A PICK PARAM THAT NOTHING READS. Every param of every pick that enters a state invoking an
//     Effect is read by SOMETHING — the check is per state, not per invoke: by the input of any invoke
//     of that state, an Effect's or not (a second invoke beside the state's work is a legal pattern)
//     — `fromPick` for each param that is a key of the Effect's input (a command's argv slots) or that
//     its `fill` reads, every param on an invoke that is no Effect, every param on a command whose
//     argv is Open (its slots are the composer's; `customize()` runs this check again on the bound
//     argv, ADR-0054), a plain mapper probed with a
//     recording event — or read by the entering transition's guard, or stored by an `assign` on the entering
//     transition or on the entry of any state it enters (its targets, their ancestors below the
//     transition's domain, their initial descendants — xstate's entry set — and what an eventless
//     `always` on an entered state enters next, with that transition's guard and actions). Else the
//     Agent supplies it and nothing uses it: refused. A pick is a writing an Agent may send (ADR-0015's
//     position rule); a Gate's event is a human's and is not checked. The walk does not carry a pick's
//     params across a timer: where an `after` on a state the pick entered moves on to an Effect's
//     state, only a guard or assign BEFORE the timer reads them (the Effect's input reads the timer's
//     event), so a param nothing stores before it is refused. A pick that targets a history state enters what
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
import { mayTake, partiesAt } from "./party.ts";
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
  // A PICK is a writing an Agent may send (ADR-0015's position rule, `mayTake`): only a pick's
  // params are checked — a Gate's event is a human's, and nothing says the Agent supplies it. A pick
  // that enters a state whose `after` moves on to an Effect's state reaches that Effect too, but
  // across the timer: the Effect's input, and every guard and action from the timer on, read the
  // timer's event. Only what read the pick before the timer counts (CROSSED).
  type Reads = { guards: unknown[]; actions: unknown[]; entries: unknown[] };
  type Entering = Reads & { pick: boolean };
  type Crossed = { reads: Reads; via: Node };
  const entering = new Map<Node, Map<string, Entering>>();
  const crossing = new Map<Node, Map<string, Crossed[]>>();
  const agentSeats = all.flatMap((node) =>
    partiesAt(node, machine)
      .filter((p) => p.party === "agent")
      .map((sender) => ({ sender, node })),
  );
  const isPick = (source: Node, event: string): boolean =>
    defs.has(event) && agentSeats.some(({ sender, node }) => mayTake(machine, sender, node, source, event));
  const readsOf = (path: readonly Transition[], entered: readonly Node[]): Reads => ({
    guards: path.flatMap((t) => (t.guard === undefined ? [] : [t.guard])),
    actions: path.flatMap((t) => t.actions),
    entries: [...new Set(entered.flatMap((s) => s.entry.filter((a) => !isTimerArm(a))))],
  });
  const record = (event: string, entered: Set<Node>, reads: Reads, pick: boolean): void => {
    for (const target of entered) {
      const byEvent = entering.get(target) ?? new Map<string, Entering>();
      const seen = byEvent.get(event) ?? { guards: [], actions: [], entries: [], pick: false };
      byEvent.set(event, {
        guards: [...seen.guards, ...reads.guards],
        actions: [...seen.actions, ...reads.actions],
        entries: [...new Set([...seen.entries, ...reads.entries])],
        pick: seen.pick || pick,
      });
      entering.set(target, byEvent);
    }
  };
  const recordCrossed = (event: string, entered: Set<Node>, crossed: Crossed): void => {
    for (const target of entered) {
      const byEvent = crossing.get(target) ?? new Map<string, Crossed[]>();
      byEvent.set(event, [...(byEvent.get(event) ?? []), crossed]);
      crossing.set(target, byEvent);
    }
  };
  type Walk = { pick: boolean; crossed?: Crossed };
  const follow = (
    event: string,
    t: Transition,
    path: readonly Transition[],
    before: readonly Node[],
    seen: Set<Transition>,
    walk: Walk,
  ): void => {
    const entered = entrySetOf(t, machine.root);
    const here = [...path, t];
    const sofar = [...before, ...entered];
    if (walk.crossed) recordCrossed(event, entered, walk.crossed);
    else record(event, entered, readsOf(here, sofar), walk.pick);
    for (const s of entered) {
      for (const next of s.always ?? []) {
        if (seen.has(next)) continue;
        follow(event, next, here, sofar, new Set([...seen, next]), walk);
      }
      // A pick's params do not cross a timer: the walk follows the `after` of a state the pick
      // entered, and marks what it reaches as crossed.
      if (!walk.pick) continue;
      for (const [type, candidates] of s.transitions) {
        if (!type.startsWith("xstate.after.")) continue;
        for (const next of candidates) {
          if (seen.has(next)) continue;
          const crossed = walk.crossed ?? { reads: readsOf(here, sofar), via: s };
          follow(event, next, here, sofar, new Set([...seen, next]), { pick: true, crossed });
        }
      }
    }
    if (walk.crossed) return;
    // A history target: what it enters is not known at load, so an Effect it may enter is
    // unchecked — a warning, never silence.
    for (const h of (t.target ?? []).filter((s) => s.type === "history")) {
      const def = defs.get(event);
      if (!walk.pick || !def || Object.keys(def.input.shape).length === 0 || !h.parent) continue;
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
      for (const t of candidates) follow(event, t, [], [], new Set([t]), { pick: isPick(n, event) });
    }
  }
  const namedGuards = (machine.implementations?.guards ?? {}) as Record<string, unknown>;

  /**
   * Probe what reads a pick's params before its Effect starts: the entering guards, run; the
   * assigns, run; any other action, named and not run. Returns what was read, whether every probe
   * ran, and the actions it did not run.
   */
  const probeReads = (
    where: string,
    event: string,
    params: readonly string[],
    reads: Reads,
    read: Set<string>,
  ): { probed: boolean; unrun: string[] } => {
    let probed = true;
    for (const guard of reads.guards) {
      try {
        probeGuard(guard, recordingEvent(event, params, read), namedGuards);
      } catch (err) {
        probed = false;
        warnings.push(`${where}: could not probe a guard (${messageOf(err)}); its params are unchecked`);
      }
    }
    const unrun: string[] = [];
    for (const action of [...reads.actions, ...reads.entries]) {
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
    return { probed, unrun };
  };
  const unrunWarning = (where: string, lost: readonly string[], unrun: readonly string[]): string =>
    `${where}: nothing the walk can run reads ${lost.map((p) => `"${p}"`).join(", ")}; an action it does ` +
    `not run (${unrun.join(", ")}) may — unchecked. If none reads it, the Agent supplies it and nothing ` +
    `uses it`;

  // Per STATE, not per invoke: a param counts as read when ANY invoke of the state reads it (an
  // Effect's or not — a second invoke beside the state's work is a legal pattern), or the entering
  // transition's guard reads it, or an assign stores it. Only a param that NOTHING reads is refused.
  for (const n of all) {
    const configs = [n.config.invoke ?? []].flat() as Array<{ input?: unknown } | undefined>;
    const invokes = n.invoke.map((inv, i) => {
      const logic = logicOf(inv.src);
      const effect = isEffect(logic) ? logic.effect : undefined;
      return {
        effect,
        // Undefined: no Effect, or an Open argv whose slots the composer binds (ADR-0054) — it gets
        // every param here, and `customize()` runs this check again once the argv is bound.
        keys: effect ? inputKeysOf(effect) : undefined,
        slot: typeof inv.src === "string" ? inv.src : inv.id,
        mapper: configs[i]?.input,
      };
    });
    const effects = invokes.filter((inv) => inv.effect !== undefined);
    if (!effects.length) continue;
    const at = `state "${n.id}" (Effect${effects.length > 1 ? "s" : ""} ${effects.map((e) => `"${e.slot}"`).join(", ")})`;
    for (const [event, { pick, ...reads }] of entering.get(n) ?? []) {
      let misread = false;
      for (const { effect, slot, mapper } of invokes) {
        if (!isPickMapper(mapper) || mapper.pick.name === event) continue;
        misread = true;
        errors.push(
          `state "${n.id}" (${effect ? "Effect" : "invoke"} "${slot}") reads the params of pick ` +
            `"${mapper.pick.name}" but is entered on "${event}" — that event does not carry them`,
        );
      }
      if (misread) continue;
      const def = defs.get(event);
      if (!def || !pick) continue;
      const params = Object.keys(def.input.shape);
      if (params.length === 0) continue;
      const where = `pick "${event}" enters ${at}`;
      const read = new Set<string>();
      let probed = true;
      for (const { effect, keys, slot, mapper } of invokes) {
        const own = `pick "${event}" enters state "${n.id}" (${effect ? "Effect" : "invoke"} "${slot}")`;
        if (isPickMapper(mapper)) {
          // Params flow by NAME: one that is no key of the Effect's input reaches nothing, and
          // TypeScript does not reject an extra key on a spread. Only `fill` can still read it. An
          // invoke that is no Effect declares no keys: it gets every param.
          const overwritten = new Set<string>();
          if (mapper.fill) {
            try {
              const filled = mapper.fill({ context: anything(), params: recorder(params, read) });
              for (const p of params) {
                if (filled && typeof filled === "object" && p in filled) {
                  overwritten.add(p);
                  errors.push(
                    `${own}: \`fill\` sets "${p}", which is also a param of the pick — the Machine's value wins ` +
                      `and the Agent's is dropped; rename one, or drop it from the def`,
                  );
                }
              }
            } catch (err) {
              probed = false;
              warnings.push(
                `${own}: could not probe fromPick's fill (${messageOf(err)}); a param it reads or overwrites is unchecked`,
              );
            }
          }
          for (const p of params) if ((keys === undefined || keys.includes(p)) && !overwritten.has(p)) read.add(p);
        } else if (typeof mapper === "function") {
          try {
            (mapper as (args: unknown) => unknown)({
              event: recordingEvent(event, params, read),
              context: anything(),
              self: anything(),
            });
          } catch (err) {
            probed = false;
            warnings.push(`${own}: could not probe the input mapper (${messageOf(err)}); its params are unchecked`);
          }
        }
      }
      // A param the entering transition's guard READS, or an assign on it or on the entry of a
      // state it enters STORES, reaches the Machine too. A guard and an assign are pure by
      // contract: both are run.
      const probe = probeReads(where, event, params, reads, read);
      probed &&= probe.probed;
      const lost = params.filter((p) => !read.has(p));
      const picked = effects.filter((e) => isPickMapper(e.mapper));
      if (probed && lost.length && probe.unrun.length) {
        // Any other action may do work, so the probe never runs one; it may read the param.
        warnings.push(unrunWarning(where, lost, probe.unrun));
      } else if (probed && lost.length && picked.length) {
        const inputs =
          picked.length === 1
            ? `the Effect's input (${picked[0]!.keys?.join(", ") || "none"})`
            : `any fromPick Effect's input (${picked.map((e) => `"${e.slot}": ${e.keys?.join(", ") || "none"}`).join("; ")})`;
        errors.push(
          `${where} with fromPick: ${lost.map((p) => `"${p}"`).join(", ")} is no key of ${inputs}, and nothing ` +
            `else reads it — the Agent supplies it and it reaches nothing; name an argv slot for it, read it in ` +
            `\`fill\`, store it with assign, or drop it from the def`,
        );
      } else if (probed && lost.length) {
        errors.push(
          `${where}, which never reads ${lost.map((p) => `"${p}"`).join(", ")}: the Agent supplies it and nothing ` +
            `uses it — map it in an invoke's input, store it with assign, or drop it from the def`,
        );
      }
    }
    // Across a timer: every invoke's input reads the timer's event, so only what read the pick
    // before the timer counts. A `fromPick` here is refused above (it is entered on the timer's
    // event, which does not carry the params).
    if (invokes.some(({ mapper }) => isPickMapper(mapper))) continue;
    for (const [event, hops] of crossing.get(n) ?? []) {
      const def = defs.get(event);
      if (!def) continue;
      const params = Object.keys(def.input.shape);
      if (params.length === 0) continue;
      for (const { reads, via } of hops) {
        const where = `pick "${event}" enters state "${via.id}", whose \`after\` moves on to ${at}`;
        const read = new Set<string>();
        const probe = probeReads(where, event, params, reads, read);
        const lost = params.filter((p) => !read.has(p));
        if (!probe.probed || !lost.length) continue;
        if (probe.unrun.length) warnings.push(unrunWarning(where, lost, probe.unrun));
        else
          errors.push(
            `${where}, and nothing stores ${lost.map((p) => `"${p}"`).join(", ")} before the timer: the ` +
              `invokes' input reads the timer's event, not the pick's, so the Agent supplies it and nothing uses ` +
              `it — store it with assign on the pick's transition, or drop it from the def`,
          );
      }
    }
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

/** The delayed `raise` xstate adds to a state's entry for each `after`: xstate's own, it reads no
 * param, and the walk neither runs nor names it. */
const isTimerArm = (action: unknown): boolean => {
  const { type, id } = (action ?? {}) as { type?: unknown; id?: unknown };
  return type === "xstate.raise" && typeof id === "string" && id.startsWith("xstate.after.");
};

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
