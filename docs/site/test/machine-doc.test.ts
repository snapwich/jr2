// The graph of an example Machine (build/machine-doc.ts): from the machine doc that the Console
// draws, on two examples of the site, one with no Workspace and one in a `workspace()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnyStateMachine } from "xstate";
import { graphOf, type GraphNode } from "../build/machine-doc.ts";

const load = async (file: string) =>
  ((await import(new URL(`../examples/${file}`, import.meta.url).href)) as { machine: AnyStateMachine }).machine;
const find = (nodes: GraphNode[], id: string): GraphNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
};

test("a graph has each state, each transition, and who sends in each state", async () => {
  const g = graphOf("triage", await load("get-started/a-model-decides/anthropic/triage.ts"));
  assert.deepEqual(
    g.nodes.map((n) => n.title),
    ["triaging", "clarify", "accepted", "rejected"],
  );
  assert.equal(g.initial, "triage.triaging");
  assert.deepEqual(find(g.nodes, "triage.triaging")!.sub, { text: "triager", kind: "agent" });
  assert.deepEqual(find(g.nodes, "triage.clarify")!.sub, { text: "Gate", kind: "gate" });
  assert.equal(find(g.nodes, "triage.accepted")!.final, true);
  assert.deepEqual(
    g.edges.map((e) => `${e.source} ${e.label} ${e.target}`),
    [
      "triage.triaging accept triage.accepted",
      "triage.triaging reject triage.rejected",
      "triage.triaging needs_info triage.clarify",
      "triage.triaging agent.fault triage.clarify",
      "triage.clarify answer triage.triaging",
    ],
  );
});

test("a Machine in a workspace() shows the Workspace's states, and its body in running", async () => {
  const g = graphOf("task", await load("get-started/an-agent-in-a-sandbox/anthropic/task.ts"));
  assert.deepEqual(
    g.nodes.map((n) => n.title),
    ["placing", "provisioning", "attaching", "running", "teardown", "done", "failing"],
  );
  const body = find(g.nodes, "workspace.running>task")!;
  assert.equal(body.machine, true);
  // The body's own transition from each state is a row, and its invoke id is not.
  assert.deepEqual(body.rows, ["any state: workspace.lost → lost"]);
  assert.deepEqual(
    body.children.map((n) => n.title),
    ["working", "review", "done", "lost"],
  );
  assert.deepEqual(find(g.nodes, "workspace.running>task.working")!.sub, { text: "coder", kind: "agent" });
  assert.ok(g.edges.some((e) => e.source === "workspace.running>task.review" && e.label === "request_changes"));
});

test("a graph says in words what xstate writes in code: the end of an invoke, the order of conditions", async () => {
  const g = graphOf("tickets", await load("concepts/pools-and-sources/tickets.ts"));
  // The Pool's own Gate, and its wildcard on each child, are what the Machine does in each state.
  assert.deepEqual(g.any, ["the Gate source waits", "a child ends → discovering", "a child fails, if → discovering"]);
  assert.equal(g.ordered, true);
  const from = (state: string) =>
    g.edges.filter((e) => e.source === `tickets.${state}`).map((e) => `${e.label}${e.quiet ? " (quiet)" : ""}`);
  assert.deepEqual(from("discovering"), [
    "discover ends ① (quiet)",
    "discover ends ② (quiet)",
    "discover ends ③ (quiet)",
    "discover ends ④ (quiet)",
    "discover ends else (quiet)",
    "at once, if (quiet)",
  ]);
  assert.deepEqual(from("parked"), ["tickets_changed"]);
});

test("a Workspace in a child Machine is a frame around its body, and its initial state is the body's", async () => {
  const g = graphOf("route", await load("concepts/composition/anthropic/route.ts"));
  const deep = find(g.nodes, "route.deep>task")!;
  assert.deepEqual(deep.rows, ["in a workspace()", "any state: workspace.lost → lost"]);
  assert.equal(deep.initial, "route.deep>task.working");
  assert.equal(find(g.nodes, "route.deep>workspace.placing"), undefined);
});
