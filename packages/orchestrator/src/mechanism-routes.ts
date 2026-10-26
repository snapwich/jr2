// A mechanism event must have a route (ADR-0074). jr2 sends `agent.fault` to the Machine that
// invoked an Agent when the Agent's Turn cannot go on (ADR-0016), and `workspace()` sends
// `workspace.lost` to its body when the Sandbox is gone (ADR-0012), and an Open body sends a
// Chart's unrouted `agent.fault` to the Machine that invoked it (ADR-0070). Each is a relayed
// event, and xstate drops an event that no active state handles. So the walk refuses a state that cannot
// route one, and the run host faults a run in which none took one.
//
// - `refuseUnroutedAgentFault`: a state that invokes an Agent, or an Open body that can run one
//   (it lends an Agent or allows a model), when that state and all its ancestors have no
//   `agent.fault` route. In `jr2Setup().createMachine` and in the load walk (`partsOf`), beside the
//   lost-output refusal, so `jr2 check`, `jr2 up` and the Orchestrator's load show it. Not for a
//   compiled Chart: there the route is optional, and the Open body sends an `agent.fault` that no
//   transition of the Chart takes to the Machine that invoked it (open-body.ts; ADR-0070).
// - `refuseUnroutedLost`: a non-final leaf state of a `workspace()` body, when that state and all
//   its ancestors have no `workspace.lost` route. In `workspace()`, the one place that knows that a
//   Machine is a body. A compound or parallel state is not judged by itself: an event goes to the
//   active leaves first, so a route on each leaf (or above it) is a route for the compound state.
//   A final state of the root ends the body, so it is not judged. A nested final state is judged
//   when its compound state has no `onDone`: the body then stays in the compound state, and a
//   route on the compound state or above it is the route. The line names the compound state. A
//   final state of a parallel region is not judged: the other regions are active, and their leaves
//   are judged.
// - `unroutedMechanismEvent`: the runtime half, for a route that the walk cannot judge (a guard
//   that is false when the event comes). The run host reads it off each microstep.
//
// A route is any transition for the event: one with actions only counts, because it can be a
// deliberate `reenter: true` that invokes the Agent again. jr2 does not judge what a route does.
// A wildcard (`"*"`, `"agent.*"`) that takes the event is a route too, as it is at runtime.

import type { AnyStateMachine, StateNode } from "xstate";
import { isAgent } from "./agent.ts";
import { isOpenBody, openBodyDeclarationOf } from "./open-body.ts";

/** The two mechanism events that must have a route. */
const ROUTED_MECHANISM_EVENTS = ["agent.fault", "workspace.lost"] as const;

type Node = StateNode<any, any>;

/** Does a descriptor of a state's `on` take this event type? xstate's own match: the exact type,
 * `"*"`, or a partial wildcard like `"agent.*"`. */
function takes(descriptor: string, type: string): boolean {
  if (descriptor === type || descriptor === "*") return true;
  return descriptor.endsWith(".*") && type.startsWith(descriptor.slice(0, -1));
}

/** Does this state, or a state above it, have a route for `type`? */
function routedAt(node: Node, type: string): boolean {
  for (let at: Node | undefined = node; at !== undefined; at = at.parent) {
    for (const descriptor of at.transitions.keys()) if (takes(descriptor, type)) return true;
  }
  return false;
}

/** Every state node of the tree below (and with) `node`, in document order. */
function statesOf(node: Node): Node[] {
  const out: Node[] = [node];
  const children = Object.values(node.states as Record<string, Node>).sort((a, b) => a.order - b.order);
  for (const child of children) out.push(...statesOf(child));
  return out;
}

/** The text of one or more state ids, quoted. */
function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

/** Is this slot an Open body that can run an Agent whose `agent.fault` comes to the Machine? One
 * that lends an Agent or lets a Chart add its own: the body sends the Machine a Chart's unrouted
 * `agent.fault`. A lent Machine routes its own Agents, and the walk judges it by itself. */
function runsChartAgents(logic: unknown): boolean {
  if (!isOpenBody(logic)) return false;
  const decl = openBodyDeclarationOf(logic);
  return (decl.lends.agents?.length ?? 0) > 0 || decl.allows.models.length > 0;
}

/**
 * Refuse a Machine with a state that invokes an Agent, or an Open body that can run one, when that
 * state and all its ancestors have no `agent.fault` route (ADR-0074). The slots are the Machine's
 * own `actors`. Throws one line that names each state, the event and the route to write.
 */
export function refuseUnroutedAgentFault(machine: AnyStateMachine): void {
  const actors = (machine.implementations.actors ?? {}) as Record<string, unknown>;
  const agents: string[] = [];
  const bodies: string[] = [];
  for (const node of statesOf(machine.root as Node)) {
    if (routedAt(node, "agent.fault")) continue;
    const srcs = node.invoke.map((inv) => (typeof inv.src === "string" ? actors[inv.src] : undefined));
    if (srcs.some((logic) => isAgent(logic))) agents.push(node.id);
    else if (srcs.some((logic) => runsChartAgents(logic))) bodies.push(node.id);
  }
  if (!agents.length && !bodies.length) return;
  const clause = (ids: string[], what: string) =>
    `${ids.length > 1 ? "states" : "state"} ${quoted(ids)} ${ids.length > 1 ? "invoke" : "invokes"} ${what}`;
  const what = [
    ...(agents.length ? [clause(agents, "an Agent")] : []),
    ...(bodies.length ? [clause(bodies, "an Open body that can run an Agent")] : []),
  ].join(", and ");
  const many = agents.length + bodies.length > 1;
  throw new Error(
    `machine "${machine.id}": ${what}, and no route for "agent.fault" is on ${many ? "them" : "it"} or on a state ` +
      `above — jr2 sends agent.fault when the Agent's Turn cannot go on, and with no route the run faults: route it ` +
      `on that state or on a state above it, as on: { "agent.fault": "<the state that handles it>" } (ADR-0074)`,
  );
}

/** Does the body stay in this final state? It does when the final state is nested, its compound
 * state has no `onDone`, and that compound state is no region of a parallel state. */
function staysIn(final: Node): boolean {
  const parent = final.parent;
  if (parent === undefined || parent.parent === undefined) return false;
  if (parent.parent.type === "parallel") return false;
  return !parent.transitions.has(`xstate.done.state.${parent.id}`);
}

/**
 * Refuse a `workspace()` body with a state that is not final, that it can stay in, when that state
 * and all its ancestors have no `workspace.lost` route (ADR-0074). Throws one line that names each
 * state, the event and the route to write.
 */
export function refuseUnroutedLost(body: AnyStateMachine): void {
  // The leaves: an atomic state, a root with no child state, or a final state that the body can stay
  // in. A history state is no state the body is in.
  const unrouted = statesOf(body.root as Node)
    .filter((node) => Object.keys(node.states).length === 0 && node.type !== "history")
    .filter((node) => node.type !== "final" || staysIn(node))
    .filter((node) => !routedAt(node, "workspace.lost"))
    // The body stays in the compound state of a final state that it can stay in, and that state is
    // not final: the line names it.
    .map((node) => (node.type === "final" ? node.parent!.id : node.id));
  if (!unrouted.length) return;
  const many = unrouted.length > 1;
  throw new Error(
    `workspace(): the body "${body.id}" has ${many ? "states" : "a state"} ${quoted(unrouted)} that ` +
      `${many ? "are" : "is"} not final, and no route for "workspace.lost" is on ${many ? "them" : "it"} or on a ` +
      `state above — jr2 sends workspace.lost to the body when its Sandbox is gone, and with no route the run ` +
      `faults: route it on the body's root, as on: { "workspace.lost": "<the state that handles it>" } (ADR-0074)`,
  );
}

/** The parts of an `@xstate.microstep` inspection event that the runtime check reads. */
export type MicrostepView = {
  actorRef: { id: string; getSnapshot(): unknown; logic?: unknown };
  event: { type: string; reason?: unknown };
  snapshot?: unknown;
  _transitions?: readonly unknown[];
};

/**
 * The fault of a microstep in which a Machine got `agent.fault` or `workspace.lost` and took no
 * transition for it (ADR-0074), or undefined for every other microstep. The text names the event,
 * the Machine and its state, and the event's `reason`. For `workspace.lost` this is the body's
 * microstep: the wrapper always takes its own transition, to forward the event to the body.
 */
export function unroutedMechanismEvent(ev: MicrostepView): string | undefined {
  const type = ev.event?.type;
  if (!(ROUTED_MECHANISM_EVENTS as readonly string[]).includes(type)) return undefined;
  if (ev._transitions === undefined || ev._transitions.length > 0) return undefined;
  const snapshot = (ev.snapshot ?? ev.actorRef.getSnapshot()) as { value?: unknown; status?: string } | undefined;
  if (snapshot?.status !== undefined && snapshot.status !== "active") return undefined;
  const machine = (ev.actorRef.logic as { id?: unknown } | undefined)?.id;
  const name = typeof machine === "string" ? machine : ev.actorRef.id;
  const reason = typeof ev.event.reason === "string" && ev.event.reason !== "" ? ev.event.reason : "no reason given";
  return (
    `machine "${name}" got "${type}" in state ${JSON.stringify(snapshot?.value ?? null)}, and no transition took ` +
    `it (${reason}) — no route for "${type}" is on that state or on a state above, or the guard of each route ` +
    `was false: route it with a transition that is always taken (ADR-0074)`
  );
}
