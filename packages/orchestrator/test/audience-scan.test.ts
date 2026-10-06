// The audience rule never widens (ADR-0015), checked over every Machine the repo ships or tests
// with: the kit's packaged Machines, the e2e fixtures, the `@kind` instance's workflows, and the
// CLI's and this package's own fixtures. For every seat — one party on one state — two readings
// must each be a subset of what the rule it replaced gave, every name in the party's reach whose
// audience is its kind, an unset audience counting as `any`:
//   - the names the load walk derives for it (`seatsOf`) — what it may send;
//   - the names of every writing it may take at run time (`mayTake`) — what a delivery from it may
//     run; `sentBy` only declines, so it cannot add one.
// The reach is own + ancestors, plus the states below with no party-invoking state between: an
// Agent's modes, and a Gate's plain children (position gives a Gate those, as it gives an Agent its
// modes).
//
// Not scanned: the `@model` instance's workflows, whose endpoint profile exists only once the tier
// materializes it (`features/model-instance/workflows/_profile.ts`), and the intro instance under
// `docs/`, which is not a workspace package and so resolves no `xstate` here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AnyStateMachine } from "xstate";
import { isAgent } from "../src/agent.ts";
import { allNodes, mayTake, partiesAt } from "../src/party.ts";
import { seatsOf, vocabularyOf } from "../src/vocabulary.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = [
  "packages/machines/src/task.ts",
  "packages/orchestrator/test/_fixtures.ts",
  "packages/cli/test/_fixtures.ts",
  ...["guarded", "guarded-reshaped", "intake", "loop", "nested", "review", "workspaced"].map(
    (f) => `features/fixtures/${f}.ts`,
  ),
  ...["_body", "advised", "consulted", "handoff", "perrun", "sandboxed", "seated", "task", "unsynced"].map(
    (f) => `features/kind-instance/workflows/${f}.ts`,
  ),
];

type Node = AnyStateMachine["root"];

/** Every jr2Setup Machine reachable from a value: itself, the Machines its states invoke, and
 * every Machine in its actors. */
function machinesIn(value: unknown, seen = new Set<unknown>()): AnyStateMachine[] {
  const isMachine = (v: unknown): v is AnyStateMachine =>
    !!v && typeof v === "object" && "root" in v && "implementations" in v;
  if (!isMachine(value) || seen.has(value)) return [];
  seen.add(value);
  const out: AnyStateMachine[] = vocabularyOf(value) ? [value] : [];
  const actors = value.implementations.actors as Record<string, unknown>;
  const visit = (n: Node) => {
    for (const inv of n.invoke) out.push(...machinesIn(typeof inv.src === "string" ? actors[inv.src] : inv.src, seen));
    Object.values(n.states).forEach(visit);
  };
  visit(value.root);
  for (const logic of Object.values(actors)) out.push(...machinesIn(logic, seen));
  return out;
}

/** The replaced rule's seats, `<state> <party>` in walk order (the order `seatsOf` keeps): reach = own + ancestors (+ modes for an
 * Agent, stopping at a child that invokes a party), filtered by kind with unset read as `any`. */
function replacedRule(machine: AnyStateMachine): Array<{ key: string; names: Set<string> }> {
  const defs = vocabularyOf(machine)!;
  const actors = machine.implementations.actors as Record<string, unknown>;
  const agentSlot = (src: unknown) => (typeof src === "string" && isAgent(actors[src]) ? src : undefined);
  const party = (n: Node) => n.invoke.some((inv) => inv.src === "gate" || agentSlot(inv.src) !== undefined);
  const keys = (n: Node) => [...n.transitions.keys()].filter((k) => defs.has(k));
  const out: Array<{ key: string; names: Set<string> }> = [];
  const visit = (n: Node) => {
    for (const inv of n.invoke) {
      const slot = agentSlot(inv.src);
      if (inv.src !== "gate" && slot === undefined) continue;
      const reach = new Set<string>();
      for (let p: Node | undefined = n; p; p = p.parent) keys(p).forEach((k) => reach.add(k));
      const below = (m: Node) => {
        for (const c of Object.values(m.states)) {
          if (party(c)) continue;
          keys(c).forEach((k) => reach.add(k));
          below(c);
        }
      };
      below(n);
      const kind = slot !== undefined ? "agent" : "external";
      const names = [...reach].filter((k) => {
        const a = defs.get(k)!.audience ?? "any";
        return a === kind || a === "any";
      });
      out.push({ key: `${n.id} ${slot !== undefined ? `agent:${slot}` : "gate"}`, names: new Set(names) });
    }
    Object.values(n.states).forEach(visit);
  };
  visit(machine.root);
  return out;
}

/** Every Machine a module yields: exported Machines, and what zero-argument exported functions
 * return (a fixture's `codingDef()`-style factory). */
async function machinesOf(file: string): Promise<AnyStateMachine[]> {
  const mod = (await import(join(repo, file))) as Record<string, unknown>;
  const seen = new Set<unknown>();
  const out: AnyStateMachine[] = [];
  for (const value of Object.values(mod)) {
    let v = value;
    if (typeof value === "function" && value.length === 0 && !("root" in value)) {
      try {
        v = (value as () => unknown)();
      } catch {
        continue;
      }
    }
    if (v && typeof v === "object" && "machine" in v) v = (v as { machine: unknown }).machine;
    out.push(...machinesIn(v, seen));
  }
  return out;
}

test("the audience rule never widens who may send a name — over every shipped Machine and fixture (ADR-0015)", async () => {
  let scanned = 0;
  for (const file of FILES) {
    const machines = await machinesOf(file);
    for (const machine of machines) {
      const before = replacedRule(machine);
      const seats = seatsOf(machine);
      assert.deepEqual(
        seats.map((seat) => `${seat.state} ${seat.party === "agent" ? `agent:${seat.agent}` : "gate"}`),
        before.map((seat) => seat.key),
        `${file} #${machine.id}: the same seats under both rules`,
      );
      for (const [i, seat] of seats.entries()) {
        const was = before[i]!;
        for (const name of seat.names)
          assert.ok(was.names.has(name), `WIDENED ${file} #${machine.id} ${was.key}: ${name}`);
      }
      // What a delivery from each seat may run: every writing it may take, by name.
      const nodes = allNodes(machine);
      const defs = vocabularyOf(machine)!;
      for (const node of nodes) {
        for (const sender of partiesAt(node, machine)) {
          const key = `${node.id} ${sender.party === "agent" ? `agent:${sender.id}` : "gate"}`;
          const was = before.find((seat) => seat.key === key)!;
          for (const writing of nodes)
            for (const name of writing.transitions.keys())
              if (defs.has(name) && mayTake(machine, sender, node, writing, name))
                assert.ok(
                  was.names.has(name),
                  `WIDENED at run time ${file} #${machine.id} ${key}: ${name} on ${writing.id}`,
                );
        }
      }
      scanned++;
    }
  }
  assert.ok(scanned >= FILES.length, `every listed module yields a Machine (scanned ${scanned})`);
});
