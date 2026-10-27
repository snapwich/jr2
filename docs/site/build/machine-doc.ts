// The graph of an example Machine, for the site's `::: graph` (.vitepress/graph.ts): it loads the
// example file, takes the Machine that it exports, and prints the graph to draw. The graph comes
// from the machine doc that the Console draws, from the same serializer, and it nests as the
// Console nests: a state that runs a child Machine holds that Machine's states, so a `workspace()`
// shows its own states and, in `running`, the body that it runs. Thus the graph on a page is the
// graph of the code above it.
//
// A process of its own, because the site's markdown renders a page at once and a module loads
// later; and because a module, once loaded, stays as it was, while the dev server must show each
// change to the example.
//
//   node build/machine-doc.ts <file.ts>

import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyStateMachine } from "xstate";
import {
  serializeMachine,
  type MachineBodyDoc,
  type MachineStateDoc,
  type MachineTransitionDoc,
} from "@jr2/orchestrator/internal";

/** What a state does: the Agent it invokes, a Gate, an Effect, or a Failure. */
export type GraphSub = { text: string; kind: "agent" | "gate" | "effect" | "fail" };
/** A box: a state, or a child Machine in the state that runs it. A box with boxes in it is a frame. */
export type GraphNode = {
  id: string;
  title: string;
  machine?: true;
  final?: true;
  sub?: GraphSub;
  /** Lines in the box: a transition that stays in the state (`↺ event`), or how a child runs. */
  rows: string[];
  /** The box of the initial state of this frame, when it has one. */
  initial?: string;
  children: GraphNode[];
};
/** `quiet`: jr2 or xstate takes it, not a party of the Machine: the end of an invoke, an eventless
 * transition, or a mechanism event such as `agent.fault`. */
export type GraphEdge = { source: string; target: string; label: string; quiet?: true };
/** `title`: the Machine's name. `any`: what the Machine itself does, in each state. `ordered`: some
 * labels carry the order in which xstate tries the transitions of one event. */
export type Graph = {
  title: string;
  any: string[];
  ordered?: true;
  nodes: GraphNode[];
  initial?: string;
  edges: GraphEdge[];
};

const ORDER = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

/** A transition in words: an event by its name, the end of an invoke as `<invoke> ends` or
 * `<invoke> fails` (`*` is any child), and an eventless transition as `at once`. */
function wordsOf(t: MachineTransitionDoc): string {
  const of = (label: string) => {
    const who = label.replace(/^(?:done|error): /, "");
    return who === "*" ? "a child" : who;
  };
  if (t.kind === "done") return `${of(t.label)} ends`;
  if (t.kind === "error") return `${of(t.label)} fails`;
  if (t.kind === "always") return "at once";
  return t.label;
}

/** The body that a `workspace()` runs in its state `running`. */
function workspaceBody(b: MachineBodyDoc): MachineBodyDoc | undefined {
  const running = b.root.states.find((s) => s.key === "running");
  return running?.children.find((c) => c.label === "body")?.machine;
}

export function graphOf(name: string, machine: AnyStateMachine): Graph {
  const doc = serializeMachine(name, machine);
  const edges: GraphEdge[] = [];
  let ordered = false;

  /** The boxes of one Machine's states, in `scope`, and its transitions as edges. */
  const body = (b: MachineBodyDoc, scope: string): { nodes: GraphNode[]; any: string[] } => {
    const sub = (s: MachineStateDoc): GraphSub | undefined => {
      const seat = b.seats.find((x) => x.state === s.id);
      if (seat?.party === "agent") return { text: seat.agent ?? "Agent", kind: "agent" };
      if (seat?.party === "gate") return { text: "Gate", kind: "gate" };
      const inv = s.invoke.find((i) => i.fail || i.effect);
      if (inv?.fail) return { text: "fail", kind: "fail" };
      if (inv?.effect) return { text: `${inv.effect.kind} Effect`, kind: "effect" };
      return undefined;
    };
    const state = (s: MachineStateDoc): GraphNode => {
      const id = scope + s.id;
      const rows = b.transitions.filter((t) => t.source === s.id && t.targets.length === 0).map((t) => `↺ ${t.label}`);
      const children = s.states.map(state);
      for (const c of s.children) {
        if (!c.machine) {
          children.push({ id: `${id}>${c.src}`, title: c.label, machine: true, rows: ["recursive"], children: [] });
          continue;
        }
        // A Workspace in a child: its body, in a frame that says so. The Workspace's own states are
        // the same in each copy, and the graph of the Machine at the top shows them when it is one.
        const run = c.machine.id === "workspace" ? workspaceBody(c.machine) : undefined;
        const shown = run ?? c.machine;
        const inner = body(shown, `${id}>`);
        const root = `${id}>${shown.root.id}`;
        children.push({
          id: root,
          title: shown.root.id,
          machine: true,
          // An invoked child's name is its invoke id, which says nothing that the frame does not; a
          // spawned one outlives its state, which the reader must see.
          rows: [
            ...(c.via === "spawn" ? [`spawned as ${c.label}`] : []),
            ...(run ? ["in a workspace()"] : []),
            ...inner.any.map((a) => `any state: ${a}`),
          ],
          initial: shown.root.initial && `${id}>${shown.root.initial}`,
          children: inner.nodes,
        });
      }
      const node: GraphNode = { id, title: s.key, rows, children };
      if (s.type === "final") node.final = true;
      const what = sub(s);
      if (what) node.sub = what;
      if (s.initial) node.initial = scope + s.initial;
      return node;
    };
    /** The label of a transition: its words, and its condition. Two or more transitions of one
     * event from one state are tried in order, so each has its number, and the one with no
     * condition is `else`. One with a condition alone says `if`, with the condition's name when it
     * has one; an inline condition has no name. */
    const labelOf = (t: MachineTransitionDoc) => {
      const group = b.transitions.filter((x) => x.source === t.source && x.event === t.event && x.kind === t.kind);
      const words = wordsOf(t);
      if (group.length > 1) {
        ordered = true;
        return `${words} ${t.guard ? (ORDER[group.indexOf(t)] ?? `(${group.indexOf(t) + 1})`) : "else"}`;
      }
      if (!t.guard) return words;
      return t.guard === "inline" ? `${words}, if` : `${words}, if ${t.guard}`;
    };
    const any: string[] = [];
    // A Gate of the Machine itself waits in each state, such as the wake Gate of a Pool.
    for (const inv of b.root.invoke) if (inv.src === "gate") any.push(`the Gate ${inv.id} waits`);
    b.transitions.forEach((t) => {
      // A transition of the Machine itself runs from each state, so one line from one box would be
      // wrong: the Console lists it, and so does the graph.
      if (t.source === b.root.id) {
        any.push(`${labelOf(t)} → ${t.targets.map((x) => x.split(".").pop()).join(", ") || "stays"}`);
        return;
      }
      const quiet = t.kind !== "event" || /^(?:agent|xstate|workspace)\./.test(t.event);
      for (const target of t.targets)
        edges.push({
          source: scope + t.source,
          target: scope + target,
          label: labelOf(t),
          ...(quiet ? { quiet: true as const } : {}),
        });
    });
    return { nodes: b.root.states.map(state), any };
  };

  const top = body(doc, "");
  return {
    title: doc.root.id,
    any: top.any,
    ...(ordered ? { ordered: true as const } : {}),
    nodes: top.nodes,
    initial: doc.root.initial,
    edges,
  };
}

if (import.meta.main) {
  const file = resolve(process.argv[2] ?? "");
  const mod = (await import(pathToFileURL(file).href)) as { machine?: AnyStateMachine; default?: AnyStateMachine };
  const machine = mod.machine ?? mod.default;
  if (!machine) {
    process.stderr.write(`${file} exports no Machine: export it as \`machine\`\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(graphOf(basename(file, extname(file)), machine)));
}
