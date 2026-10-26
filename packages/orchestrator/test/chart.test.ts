// The Chart door (ADR-0070): the grammar, the eight rules in their order, the references and the
// hash. Socket-free: the door's last check compiles the Chart once, and no actor runs here. Each
// refusal test writes a Chart that trips one rule and nothing else, and reads the one line the door
// reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { UnknownActorLogic } from "xstate";
import {
  admitChart,
  CHART_BRIEFING,
  chartBriefingOf,
  chartDigest,
  chartHash,
  ChartRefusal,
  chartSchema,
  chartSchemaFor,
  GENERIC_ACTIONS,
  isChartSchema,
  narrowedChartSchema,
  referencesOf,
  resolveReferences,
  type AdmitOptions,
  type ChartText,
} from "../src/chart.ts";
import { createMachine } from "xstate";
import { arg, commandWith, type ExecPortFactory } from "../src/effect.ts";
import { agent } from "../src/harness-client.ts";
import { dispatch } from "../src/dispatch-effect.ts";
import {
  attachLent,
  declarationFaults,
  isOpenBody,
  lentOf,
  openBody,
  openBodyDeclarationOf,
  type LentParts,
  type OpenBodyDeclaration,
} from "../src/open-body.ts";

const noPort: ExecPortFactory = () => {
  throw new Error("no exec in a door test");
};

const decl: OpenBodyDeclaration = {
  lends: {
    agents: ["coder"],
    effects: ["tests"],
    machines: ["sub"],
    guards: ["underLimit"],
    actions: ["notify"],
    delays: ["cooldown"],
    gate: true,
  },
  allows: { models: ["stub/model"], workspace: ["none", "write"] },
  ceilings: { turns: 6, wallClock: "10m", transitions: 500, fanOut: 2, size: 65536 },
};

const agentSlot = agent({ model: "stub/model", instructions: "You code." }) as unknown as UnknownActorLogic;
const lent: LentParts = {
  actors: {
    coder: agentSlot,
    tests: commandWith(noPort, ["npm", "test", "--", arg("filter")]) as unknown as UnknownActorLogic,
    sub: createMachine({ id: "sub", initial: "x", states: { x: { type: "final" } } }) as unknown as UnknownActorLogic,
  },
  guards: { underLimit: () => true },
  actions: { notify: () => {} },
  delays: { cooldown: 1000 },
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/charts/review-loop.chart.json", import.meta.url), "utf8"),
) as ChartText;

/** The smallest Chart: one final state. */
const base = (): Record<string, unknown> => ({ initial: "a", states: { a: { type: "final" } } });

function report(text: unknown, options?: AdmitOptions, d: OpenBodyDeclaration = decl, l: LentParts = lent): string[] {
  try {
    admitChart(text, d, l, options);
  } catch (err) {
    assert.ok(err instanceof ChartRefusal, `not a ChartRefusal: ${(err as Error).message}`);
    return err.report;
  }
  return [];
}

/** The Chart trips exactly one line, and that line says `expected`. */
function refusedOnce(text: unknown, expected: RegExp, options?: AdmitOptions, d?: OpenBodyDeclaration, l?: LentParts) {
  const lines = report(text, options, d, l);
  assert.equal(lines.length, 1, `expected one line, got:\n${lines.join("\n")}`);
  assert.match(lines[0]!, expected);
}

const admits = (text: unknown, options?: AdmitOptions) => assert.deepEqual(report(text, options), []);

/** An event with no payload, for the pick that ends an Agent's Turn. */
const DONE = { done: { input: { type: "object", properties: {} } } };

// --- A Chart that admits -------------------------------------------------------------------------

test("the review-loop fixture admits, with its events, its minted Agent, hash and size", () => {
  const admitted = admitChart(fixture, decl, lent, { inputKeys: ["task", "endpoint"] });
  assert.deepEqual(
    admitted.events.map((e) => e.name),
    ["submit", "approve", "revise"],
  );
  const revise = admitted.events.find((e) => e.name === "revise")!;
  assert.equal(revise.semantics, "ack");
  assert.equal(revise.input.safeParse({ notes: "add a test" }).success, true);
  assert.equal(revise.input.safeParse({}).success, false);
  assert.deepEqual(Object.keys(admitted.agents), ["reviewer"]);
  assert.equal(admitted.agents.reviewer!.model, "stub/model");
  assert.equal(admitted.hash, chartHash(fixture));
  assert.match(admitted.hash, /^[0-9a-f]{12}$/);
  assert.ok(admitted.size > 0 && admitted.size < decl.ceilings.size);
});

test("the smallest Chart admits", () => admits(base()));

// --- 1. Size -----------------------------------------------------------------------------------

test("1. a text over the size ceiling is refused with its size", () => {
  const big = { ...base(), context: { blob: "x".repeat(200) } };
  refusedOnce(big, /^\(chart\): the text is \d+ bytes; this Open body's ceiling is 100$/, undefined, {
    ...decl,
    ceilings: { ...decl.ceilings, size: 100 },
  });
});

test("1. more than 200 states is refused", () => {
  const states: Record<string, unknown> = {};
  for (let i = 0; i < 201; i++) states[`s${i}`] = { type: "final" };
  refusedOnce({ initial: "s0", states }, /^states: the Chart has 201 states; at most 200$/);
});

test("1. nesting deeper than 8 is refused; exactly 8 admits", () => {
  const nested = (depth: number) => {
    let state: Record<string, unknown> = { type: "final" };
    for (let i = 1; i < depth; i++) state = { initial: "n", states: { n: state } };
    return { initial: "n", states: { n: state } };
  };
  refusedOnce(nested(9), /^states: the Chart nests states 9 deep; at most 8$/);
  admits(nested(8));
});

test("1. a text of exactly the size ceiling admits, and one byte more is refused", () => {
  const sized = (n: number) => ({ ...base(), context: { blob: "x".repeat(n) } });
  const bytes = (n: number) => Buffer.byteLength(JSON.stringify(sized(n)));
  const ceiling = bytes(100);
  const d = { ...decl, ceilings: { ...decl.ceilings, size: ceiling } };
  assert.deepEqual(report(sized(100), undefined, d), []);
  assert.equal(report(sized(101), undefined, d).length, 1);
});

test("1. JSON nested deeper than 64 is a report line, never a stack overflow, at the door and in zod", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 3000; i++) deep = [deep];
  const text = { ...base(), context: { deep } };
  refusedOnce(text, /^context\.deep(\.0)+: the text nests deeper than 64 objects and lists here$/);
  // A door field or a pick param that holds the grammar parses it too: an issue, not a throw.
  const parsed = chartSchema.safeParse(text);
  assert.equal(parsed.success, false);
  let ok: unknown = 1;
  for (let i = 0; i < 60; i++) ok = [ok];
  admits({ ...base(), context: { ok } });
});

test("1. a key that reaches the prototype is refused anywhere, never dropped", () => {
  const text = JSON.parse(
    '{"initial":"a","context":{"__proto__":{"x":1}},"states":{"a":{"type":"final"},"__proto__":{"type":"final"}}}',
  );
  const lines = report(text);
  assert.deepEqual(lines.sort(), [
    'context.__proto__: a key named "__proto__" is refused anywhere in a Chart',
    'states.__proto__: a key named "__proto__" is refused anywhere in a Chart',
  ]);
  refusedOnce(
    { ...base(), agents: { constructor: { model: "stub/model", instructions: "x" } } },
    /^agents\.constructor: a key named "constructor" is refused anywhere in a Chart$/,
  );
});

// --- 2. Grammar --------------------------------------------------------------------------------

test("2. a key outside the grammar is refused at its path", () => {
  refusedOnce(
    { ...base(), states: { a: { type: "final", script: "rm -rf /" } } },
    /^states\.a\.script: this key is not in the Chart grammar here$/,
  );
});

test("2. an expression in a placeholder fails the grammar", () => {
  refusedOnce(
    { ...base(), states: { a: { type: "final", output: "{{context.round + 1}}" } } },
    /^states\.a\.output: "context\.round \+ 1" is not a reference/,
  );
});

test("2. a reference outside the three roots fails the grammar", () => {
  refusedOnce(
    { ...base(), output: { $ref: "process.env.HOME" } },
    /^output\.\$ref: "process\.env\.HOME" is not a reference: it starts at context, event or input/,
  );
});

test("2. a path that walks the prototype fails the grammar", () => {
  refusedOnce({ ...base(), output: "{{context.__proto__.x}}" }, /^output: "context\.__proto__\.x" is not a reference/);
});

test("2. the initial context is plain data: a `{{` or a `$ref` in it admits and is never resolved", () => {
  admits({ ...base(), context: { notes: "{{input.task}}", schema: { $ref: "#/defs/x" } } });
});

test("2. a state key with a dot is refused", () => {
  refusedOnce(
    { initial: "a.b", states: { "a.b": { type: "final" } } },
    /^states\.a\.b: the key is refused: a state key is letters/,
  );
});

test("2. a union reports the arm the value came closest to", () => {
  refusedOnce(
    { ...base(), states: { a: { on: { go: { target: 3 } } } } },
    /^states\.a\.on\.go\.target: expected string or array, found number$/,
  );
  refusedOnce(
    { ...base(), states: { a: { type: "final", entry: [{ type: "increment", path: "round", by: "one" }] } } },
    /^states\.a\.entry\.0\.by: .*expected number/,
  );
});

// --- 3. Names ----------------------------------------------------------------------------------

test("3. an un-lent src is refused, naming the lent set and the minted Agents", () => {
  refusedOnce(
    { initial: "a", states: { a: { invoke: { src: "linter", onDone: "b" } }, b: { type: "final" } } },
    /^states\.a\.invoke\.src: "linter" is not a lent actor or an Agent of this Chart; lent: coder \(Agent\), tests \(Effect\), sub \(Machine\); kit: gate; minted: none$/,
  );
});

test("3. a lent name the Chart wrapper no longer has is refused", () => {
  const { coder: _dropped, ...actors } = lent.actors;
  refusedOnce(
    {
      events: DONE,
      initial: "a",
      states: { a: { invoke: { src: "coder", input: { prompt: "go" } }, on: { done: "b" } }, b: { type: "final" } },
    },
    /^states\.a\.invoke\.src: "coder" is lent by the Open body, but the Chart wrapper has no actor slot "coder" now/,
    undefined,
    decl,
    { ...lent, actors },
  );
});

test("3. a guard that is not lent is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { always: { target: "b", guard: "isReady" } }, b: { type: "final" } } },
    /^states\.a\.always\.guard: "isReady" is not a lent guard; lent guards: underLimit/,
  );
});

test("3. an action that is neither generic nor lent is refused", () => {
  refusedOnce(
    { ...base(), states: { a: { type: "final", entry: [{ type: "deploy" }] } } },
    /^states\.a\.entry\.0\.type: "deploy" is not a generic or a lent action; generic: set, append, increment, clear; lent: notify$/,
  );
});

test("3. a delay that is not lent is refused; an integer delay admits", () => {
  refusedOnce(
    { initial: "a", states: { a: { after: { soon: "b" } }, b: { type: "final" } } },
    /^states\.a\.after\.soon: "soon" is not a lent delay or an integer of ms; lent delays: cooldown$/,
  );
  admits({ initial: "a", states: { a: { after: { "500": "b", cooldown: "b" } }, b: { type: "final" } } });
});

test("3. the wildcard is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { on: { "*": "b" } }, b: { type: "final" } } },
    /^states\.a\.on\.\*: "\*" is refused/,
  );
});

test("3. an xstate.done.actor or xstate.error.actor key is refused for onDone and onError", () => {
  refusedOnce(
    { initial: "a", states: { a: { on: { "xstate.done.actor.x": "b" } }, b: { type: "final" } } },
    /^states\.a\.on\.xstate\.done\.actor\.x: .* write the invoke's `onDone` or `onError`$/,
  );
  refusedOnce(
    { initial: "a", states: { a: { on: { "xstate.error.actor.x": "b" } }, b: { type: "final" } } },
    /^states\.a\.on\.xstate\.error\.actor\.x: .* write the invoke's `onDone` or `onError`$/,
  );
});

test("3. an integer delay above what a timer holds, or above the wall clock, is refused", () => {
  const after = (key: string) => ({ initial: "a", states: { a: { after: { [key]: "b" } }, b: { type: "final" } } });
  refusedOnce(after("3000000000"), /^states\.a\.after\.3000000000: 3000000000 ms is more than a timer holds/);
  refusedOnce(after("99999999999999999999999"), /is more than a timer holds/);
  // The wall clock is 10m: 600000 ms.
  refusedOnce(
    after("600001"),
    /^states\.a\.after\.600001: 600001 ms is more than this Open body's wallClock ceiling \(10m\)/,
  );
  admits(after("600000"));
});

test("3. a sentBy names a party the Chart invokes, as a literal", () => {
  const chart = (id: string) => ({
    events: DONE,
    initial: "a",
    states: {
      a: {
        invoke: { src: "coder", input: { prompt: "go" } },
        on: { done: { target: "b", guard: { type: "jr2.sentBy", params: { id } } } },
      },
      b: { type: "final" },
    },
  });
  admits(chart("coder"));
  refusedOnce(
    chart("nobody"),
    /^states\.a\.on\.done\.guard\.params\.id: sentBy\("nobody"\) names no party of this Chart; Agents it invokes: coder; Gate invoke ids: none$/,
  );
  refusedOnce(chart("{{event.notes}}"), /^states\.a\.on\.done\.guard\.params\.id: a sentBy id is a literal party name/);
  // An unnamed Gate's id is its state's key path, as jr2Setup names it.
  admits({
    events: DONE,
    initial: "a",
    states: {
      a: {
        initial: "w",
        states: {
          w: {
            invoke: { src: "gate" },
            on: { done: { target: "#g.b", guard: { type: "jr2.sentBy", params: { id: "a.w" } } } },
          },
        },
      },
      b: { type: "final" },
    },
    id: "g",
  });
});

test("3. a dotted name that is not a mechanism event is refused; agent.fault admits", () => {
  refusedOnce(
    { initial: "a", states: { a: { on: { "jr2.secret": "b" } }, b: { type: "final" } } },
    /^states\.a\.on\.jr2\.secret: "jr2\.secret" is not an event a Chart may handle \(a dotted name is the kit's\); mechanism events: agent\.fault, workspace\.lost; a pick is a Chart event/,
  );
  admits({
    initial: "a",
    states: {
      a: { on: { "agent.fault": { target: "b", actions: [{ type: "set", path: "why", from: "{{event.reason}}" }] } } },
      b: { type: "final" },
    },
  });
});

// --- 4. Events ---------------------------------------------------------------------------------

const objectSchema = { type: "object", properties: {} };

test("4. a handled name no event declares is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { on: { approve: "b" } }, b: { type: "final" } } },
    /^states\.a\.on\.approve: event "approve" is not declared in the Chart's `events`; declared: none; a state handles only the events the Chart declares: add `events\.approve`/,
  );
});

test("4. a declared event no state handles is refused", () => {
  refusedOnce(
    { ...base(), events: { approve: { input: objectSchema } } },
    /^events\.approve: no state handles "approve"/,
  );
});

const handlingGo = (input: Record<string, unknown>) => ({
  events: { go: { input } },
  initial: "a",
  states: { a: { on: { go: "b" } }, b: { type: "final" } },
});

test("4. an event input zod cannot read is refused", () => {
  refusedOnce(
    handlingGo({ type: "object", properties: { a: { type: "nonsense" } } }),
    /^events\.go\.input: .*nonsense/,
  );
});

test("4. a payload keyword whose cost the door cannot bound is refused by name, with its path", () => {
  // `pattern` would put a backtracking regex in the Orchestrator's delivery check.
  refusedOnce(
    handlingGo({ type: "object", properties: { notes: { type: "string", pattern: "^(a+)+$" } } }),
    /^events\.go\.input\.properties\.notes\.pattern: "pattern" is not a keyword a Chart event's payload may use/,
  );
  for (const keyword of ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "patternProperties", "dependentSchemas"]) {
    const lines = report(handlingGo({ type: "object", properties: { a: { [keyword]: {} } } }));
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.ok(
      lines[0]!.startsWith(`events.go.input.properties.a.${keyword}: "${keyword}" is not a keyword`),
      lines[0]!,
    );
  }
  refusedOnce(
    handlingGo({ type: "object", properties: { a: { type: "array", items: [{ type: "string" }] } } }),
    /^events\.go\.input\.properties\.a\.items: `items` is one schema, not a list$/,
  );
  admits(
    handlingGo({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      title: "go",
      properties: {
        n: { type: "integer", minimum: 0, maximum: 9 },
        s: { type: "string", minLength: 1, maxLength: 9, enum: ["a", "b"] },
        l: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      },
      required: ["n"],
      additionalProperties: false,
    }),
  );
});

test("4. an event input that declares `type` is refused: the payload never names the event", () => {
  refusedOnce(
    handlingGo({ type: "object", properties: { type: { type: "string" } } }),
    /^events\.go\.input\.properties\.type: a payload field named `type` is refused/,
  );
});

test("4. an event input that declares `sender` is refused", () => {
  refusedOnce(
    {
      events: { go: { input: { type: "object", properties: { sender: { type: "string" } } } } },
      initial: "a",
      states: { a: { on: { go: "b" } }, b: { type: "final" } },
    },
    /^events\.go\.input: "go" declares `sender` in its input/,
  );
});

// --- 5. Minted Agents --------------------------------------------------------------------------

const minted = (agent: Record<string, unknown>, slot = "tester") => ({
  agents: { [slot]: { instructions: "You test.", ...agent } },
  events: DONE,
  initial: "a",
  states: { a: { invoke: { src: slot, input: { prompt: "test it" } }, on: { done: "b" } }, b: { type: "final" } },
});

test("5. a minted model the Open body does not allow is refused", () => {
  refusedOnce(
    minted({ model: "anthropic/claude-opus-4", workspace: "none" }),
    /^agents\.tester\.model: "anthropic\/claude-opus-4" is not a model this Open body allows; allowed: stub\/model$/,
  );
});

test("5. a minted Workspace access the Open body does not allow is refused, the default included", () => {
  refusedOnce(
    minted({ model: "stub/model", workspace: "read" }),
    /^agents\.tester\.workspace: "read" is not a Workspace access this Open body allows; allowed: none, write$/,
  );
  refusedOnce(
    minted({ model: "stub/model" }),
    /^agents\.tester\.workspace: "write" \(the default\) is not .*allowed: none$/,
    undefined,
    { ...decl, allows: { models: ["stub/model"], workspace: ["none"] } },
  );
});

test("5. a minted slot that shadows a lent name is refused", () => {
  refusedOnce(minted({ model: "stub/model" }, "coder"), /^agents\.coder: "coder" is a lent name/);
});

// --- 6. Structure ------------------------------------------------------------------------------

test("6. a root initial that names no state is refused", () => {
  refusedOnce(
    { initial: "start", states: { a: { type: "final" } } },
    /^initial: "start" is not a state here; states: a$/,
  );
});

test("6. a compound state with no initial is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { states: { x: { type: "final" } } } } },
    /^states\.a\.initial: a compound state names its initial child; states: x$/,
  );
});

test("6. a target that resolves to no state is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { always: "nowhere" }, b: { type: "final" } } },
    /^states\.a\.always: target "nowhere" resolves to no state; siblings: a, b$/,
  );
});

test("6. a # target needs the Chart's id, and names it", () => {
  const chart = {
    initial: "a",
    states: { a: { initial: "x", states: { x: { always: "#loop.b" } } }, b: { type: "final" } },
  };
  refusedOnce(chart, /^states\.a\.states\.x\.always: "#loop\.b" is a `#` target, which needs the Chart's `id`/);
  refusedOnce({ ...chart, id: "other" }, /names "#loop"; this Chart's id is "other"$/);
  admits({ ...chart, id: "loop" });
});

test("6. a .child target and a sibling path resolve", () => {
  admits({
    initial: "a",
    states: {
      a: { initial: "x", states: { x: {}, y: { type: "final" } }, on: { "agent.fault": ".y" } },
      b: { always: "a.y" },
    },
  });
});

test("6. a final state has no invoke", () => {
  refusedOnce(
    { initial: "a", states: { a: { type: "final", invoke: { src: "sub" } } } },
    /^states\.a\.invoke: a final state has no `invoke`$/,
  );
});

test("6. a final state's output is read only directly under the root, and only when the Chart has none", () => {
  refusedOnce(
    { initial: "a", states: { a: { initial: "x", states: { x: { type: "final", output: 1 } } } } },
    /^states\.a\.states\.x\.output: only a final state directly under the Chart's `states` has an output that is read/,
  );
  refusedOnce(
    { initial: "a", output: 2, states: { a: { type: "final", output: 1 } } },
    /^states\.a\.output: the Chart has its own `output`, which is what it outputs; this one is never read/,
  );
  admits({ initial: "a", states: { a: { type: "final", output: 1 } } });
});

test("6. an Agent's invoke takes no onDone: its Turn never settles", () => {
  refusedOnce(
    {
      events: DONE,
      initial: "a",
      states: {
        a: { invoke: { src: "coder", input: { prompt: "go" }, onDone: "b" }, on: { done: "b" } },
        b: { type: "final" },
      },
    },
    /^states\.a\.invoke\.onDone: an Agent's Turn never settles, so this never runs/,
  );
});

test("6. an Agent's state that nothing can leave (its Menu is empty) is refused", () => {
  refusedOnce(
    { initial: "a", states: { a: { invoke: { src: "coder", input: { prompt: "go" } } }, b: { type: "final" } } },
    /^states\.a: nothing ends Agent "coder"'s Turn: no state at, above or below it handles a Chart event \(its Menu is empty\)/,
  );
  // A mode below it, a handler above it, or an `after` ends it.
  admits({
    events: DONE,
    initial: "a",
    states: {
      a: { invoke: { src: "coder", input: { prompt: "go" } }, initial: "m", states: { m: { on: { done: "#c.b" } } } },
      b: { type: "final" },
    },
    id: "c",
  });
  admits({
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "go" } }, after: { "1000": "b" } }, b: { type: "final" } },
  });
});

test("6. a parallel state at or below an Agent's state is refused, with its path", () => {
  refusedOnce(
    {
      events: DONE,
      initial: "a",
      states: {
        a: {
          invoke: { src: "coder", input: { prompt: "go" } },
          on: { done: "b" },
          initial: "p",
          states: { p: { type: "parallel", states: { l: {}, r: {} } } },
        },
        b: { type: "final" },
      },
    },
    /^states\.a\.states\.p: a parallel state at or below Agent "coder"'s state \(states\.a\) is refused/,
  );
});

test("6. jr2Setup's load warnings are refusals for a Chart: an unentered mode", () => {
  refusedOnce(
    {
      events: { ...DONE, stay: { input: { type: "object", properties: {} } } },
      id: "c",
      initial: "a",
      states: {
        a: {
          invoke: { src: "coder", input: { prompt: "go" } },
          initial: "x",
          states: { x: { on: { done: "#c.b" } }, y: { on: { stay: "x" } } },
        },
        b: { type: "final" },
      },
    },
    /^\(chart\): mode "c\.a\.y" of Agent "coder"'s state "c\.a" — nothing enters it/,
  );
});

test("6. a final state has no on", () => {
  refusedOnce(
    { initial: "a", states: { a: { type: "final", on: { "workspace.lost": "a" } } } },
    /^states\.a\.on: a final state has no `on`$/,
  );
});

test("6. a history state has no children", () => {
  refusedOnce(
    {
      initial: "a",
      states: {
        a: { initial: "x", states: { x: { type: "final" }, h: { type: "history", states: { z: { type: "final" } } } } },
      },
    },
    /^states\.a\.states\.h\.states: a history state has no child states$/,
  );
});

test("6. a parallel state has no initial", () => {
  refusedOnce(
    {
      initial: "p",
      states: { p: { type: "parallel", initial: "l", states: { l: { type: "final" }, r: { type: "final" } } } },
    },
    /^states\.p\.initial: a parallel state has no `initial`$/,
  );
});

test("6. an always cycle with one unguarded edge is refused; the same cycle fully guarded admits", () => {
  const cycle = (guardFirst: boolean) => ({
    initial: "a",
    states: {
      a: { always: guardFirst ? { target: "b", guard: "underLimit" } : "b" },
      b: { always: { target: "c", guard: "underLimit" } },
      c: { always: { target: "a", guard: { not: "underLimit" } } },
    },
  });
  refusedOnce(
    cycle(false),
    /^states\.a\.always: an `always` cycle \(a -> b -> c -> a\) has an unguarded edge; it would never end/,
  );
  admits(cycle(true));
});

test("6. an always cycle across parallel regions is refused", () => {
  refusedOnce(
    {
      id: "c",
      initial: "p",
      states: {
        p: {
          type: "parallel",
          states: {
            L: { initial: "a", states: { a: { always: "b" }, b: {} } },
            R: { initial: "x", states: { x: { always: "#c.p.L.a" }, y: {} } },
          },
        },
      },
    },
    /an `always` cycle .* has an unguarded edge/,
  );
});

test("6. an always cycle through a history state is refused", () => {
  refusedOnce(
    {
      initial: "a",
      states: { a: { initial: "x", states: { x: { always: "y" }, y: { always: "h" }, h: { type: "history" } } } },
    },
    /an `always` cycle .* has an unguarded edge/,
  );
});

test("6. a region's one-time always step beside another region's guarded loop admits", () => {
  admits({
    initial: "p",
    states: {
      p: {
        type: "parallel",
        states: {
          L: {
            initial: "a",
            states: {
              a: { always: { target: "b", guard: "underLimit" } },
              b: { always: { target: "a", guard: "underLimit" } },
            },
          },
          R: { initial: "x", states: { x: { always: "y" }, y: {} } },
        },
      },
    },
  });
});

test("6. an unguarded targetless always is a cycle of one", () => {
  refusedOnce(
    { initial: "a", states: { a: { always: { actions: [{ type: "increment", path: "n" }] } } } },
    /^states\.a\.always: an `always` cycle \(a -> a\)/,
  );
});

// --- 7. Dataflow -------------------------------------------------------------------------------

test("7. a context reference is supplied by a set anywhere", () => {
  admits({
    events: { note: { input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
    initial: "a",
    states: {
      a: { on: { note: { target: "b", actions: [{ type: "set", path: "notes", from: "{{event.text}}" }] } } },
      b: { type: "final", output: { notes: "{{context.notes}}" } },
    },
  });
});

test("7. an event reference is supplied by the schema of the event the transition handles", () => {
  const chart = (ref: string, required: string[] = ["verdict"]) => ({
    events: {
      decide: {
        input: { type: "object", properties: { verdict: { type: "string" }, why: { type: "string" } }, required },
      },
    },
    initial: "a",
    states: {
      a: { on: { decide: { target: "b", actions: [{ type: "set", path: "v", from: ref }] } } },
      b: { type: "final" },
    },
  });
  admits(chart("{{event.verdict}}"));
  refusedOnce(
    chart("{{event.notes}}"),
    /^states\.a\.on\.decide\.actions\.0\.from: event\.notes is not a field of event "decide"'s input; fields: verdict, why; a pick's fields are at the top of `event`/,
  );
  // A `set` from one optional field alone admits: it writes the field when it is there.
  admits(chart("{{event.why}}"));
  refusedOnce(
    chart("why: {{event.why}}"),
    /event\.why is optional in event "decide"'s input \(not in its `required`\)/,
  );
});

test("7. a context path written only from a field the pick may leave out is refused naming that write, not 'nothing'", () => {
  const chart = (required: string[]) => ({
    initial: "a",
    events: { done: { input: { type: "object", properties: { summary: { type: "string" } }, required } } },
    states: {
      a: {
        invoke: { src: "coder", input: { prompt: "go" } },
        on: { done: { target: "b", actions: [{ type: "set", path: "summary", from: "{{event.summary}}" }] } },
      },
      b: { type: "final" },
    },
    output: "{{context.summary}}",
  });
  admits(chart(["summary"]));
  refusedOnce(
    chart([]),
    /^output: context\.summary is written only by `set` at states\.a\.on\.done\.actions\.0, from `event\.summary`, which the pick may leave out: event\.summary is optional in event "done"'s input \(not in its `required`\).*; a field in the event's `required` is always there$/,
  );
});

test("7. onDone supplies event.output, onError event.error", () => {
  admits({
    initial: "a",
    states: {
      a: {
        invoke: {
          src: "sub",
          onDone: { target: "b", actions: [{ type: "set", path: "result", from: { $ref: "event.output" } }] },
          onError: { target: "b", actions: [{ type: "set", path: "fault", from: "{{event.error}}" }] },
        },
      },
      b: { type: "final", output: "{{context.result}}" },
    },
  });
  refusedOnce(
    {
      initial: "a",
      states: {
        a: {
          invoke: {
            src: "sub",
            onDone: { target: "b", actions: [{ type: "set", path: "r", from: "{{event.error}}" }] },
          },
        },
        b: { type: "final" },
      },
    },
    /^states\.a\.invoke\.onDone\.actions\.0\.from: event\.error: an `onDone` transition supplies event\.output, whole/,
  );
});

test("7. a path below what anything supplies is refused", () => {
  const ev = {
    note: {
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          a: { type: ["object", "null"], properties: { b: { type: "string" } }, required: ["b"] },
          items: { type: "array", items: { type: "string" } },
          two: { type: "array", items: { type: "string" }, minItems: 2 },
          ticket: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
        required: ["text", "a", "items", "two", "ticket"],
      },
    },
  };
  const chart = (from: string, writes: unknown[] = []) => ({
    events: ev,
    initial: "a",
    states: {
      a: {
        on: {
          note: {
            target: "b",
            actions: [
              ...writes,
              { type: "set", path: "n", from: "{{event.text}}" },
              { type: "set", path: "t", from: "{{event.ticket}}" },
              { type: "increment", path: "r" },
              { type: "set", path: "out", from },
            ],
          },
        },
      },
      b: { type: "final" },
    },
  });
  for (const [from, line] of [
    ["{{event.text.deep}}", /event\.text\.deep: event "note"'s input has no object with fields here/],
    ["{{event.a.b}}", /event\.a\.b: event "note"'s input has no object with fields here/],
    ["{{event.items.0}}", /event\.items\.0: the list in event "note"'s input may hold fewer than 1 items/],
    ["{{event.two.2}}", /may hold fewer than 3 items \(its minItems is 2\)/],
    ["{{context.n.deep}}", /context\.n\.deep is supplied by nothing/],
    ["{{context.r.x}}", /context\.r\.x is supplied by nothing/],
  ] as const) {
    refusedOnce(chart(from), line);
  }
  admits(chart("{{event.two.1}}"));
  // Below a `set` from one reference, what that reference supplies.
  admits(chart("{{context.t.title}}"));
  refusedOnce(chart("{{context.t.body}}"), /context\.t\.body is supplied by nothing/);
});

test("7. event.output and event.error are read whole; the error is its message", () => {
  const invoke = (onDone: string, onError: string) => ({
    initial: "a",
    states: {
      a: {
        invoke: {
          src: "sub",
          onDone: { target: "b", actions: [{ type: "set", path: "o", from: onDone }] },
          onError: { target: "b", actions: [{ type: "set", path: "e", from: onError }] },
        },
      },
      b: { type: "final" },
    },
  });
  admits(invoke("{{event.output}}", "{{event.error}}"));
  refusedOnce(
    invoke("{{event.output.x}}", "{{event.error}}"),
    /event\.output\.x: an `onDone` transition supplies event\.output, whole/,
  );
  refusedOnce(
    invoke("{{event.output}}", "{{event.error.stack}}"),
    /event\.error\.stack: an `onError` transition supplies event\.error, whole/,
  );
});

test("7. an input key is referenced whole when the door knows only the keys", () => {
  refusedOnce(
    { ...base(), states: { a: { type: "final", output: "{{input.task.title}}" } } },
    /input\.task\.title: the door knows the keys of the Chart's input, not what they hold/,
    { inputKeys: ["task"] },
  );
});

test("7. a reference nothing supplies is refused naming it", () => {
  refusedOnce(
    { ...base(), states: { a: { type: "final", output: "{{context.notes}}" } } },
    /^states\.a\.output: context\.notes is supplied by nothing: it is not in the initial `context`/,
  );
});

test("7. an event reference where no event is handled is refused", () => {
  refusedOnce(
    {
      initial: "a",
      states: {
        a: { always: { target: "b", actions: [{ type: "set", path: "x", from: "{{event.x}}" }] } },
        b: { type: "final" },
      },
    },
    /^states\.a\.always\.actions\.0\.from: event\.x has no event to read here: an `always` transition handles no event/,
  );
});

test("7. an input reference is checked against the input keys when the door knows them", () => {
  const chart = { ...base(), states: { a: { type: "final", output: "{{input.repo}}" } } };
  admits(chart);
  refusedOnce(chart, /^states\.a\.output: input\.repo is not in the Chart's input; input keys: task, endpoint$/, {
    inputKeys: ["task", "endpoint"],
  });
});

// --- 8. Lent input shapes ----------------------------------------------------------------------

/** A Chart whose one state invokes `src`: an Effect or a Machine settles with `onDone`, and an
 * Agent's Turn ends on a pick. */
const invoking = (src: string, input: unknown) =>
  src === "coder"
    ? { events: DONE, initial: "a", states: { a: { invoke: { src, input }, on: { done: "b" } }, b: { type: "final" } } }
    : { initial: "a", states: { a: { invoke: { src, input, onDone: "b" } }, b: { type: "final" } } };

test("8. a lent Effect takes exactly its input keys", () => {
  admits(invoking("tests", { filter: "chart" }));
  refusedOnce(
    invoking("tests", {}),
    /^states\.a\.invoke\.input: the lent Effect "tests" takes exactly filter; missing: filter$/,
  );
  refusedOnce(
    invoking("tests", { filter: "x", argv: "rm" }),
    /^states\.a\.invoke\.input: the lent Effect "tests" takes exactly filter; not its input: argv$/,
  );
  refusedOnce(
    invoking("tests", { filter: { nested: true } }),
    /^states\.a\.invoke\.input\.filter: an Effect's input slot takes a string or a reference$/,
  );
});

test("8. a lent dispatch with no input schema takes any object, the run's body; one with a schema takes its keys (ADR-0071)", () => {
  const withDispatch: LentParts = {
    ...lent,
    actors: {
      ...lent.actors,
      go: dispatch("intake") as unknown as UnknownActorLogic,
      typed: dispatch("intake", { input: z.object({ ticket: z.string() }) }) as unknown as UnknownActorLogic,
    },
  };
  const lends = { ...decl, lends: { ...decl.lends, effects: ["tests", "go", "typed"] } };
  const lines = (text: unknown) => report(text, undefined, lends, withDispatch);
  assert.deepEqual(lines(invoking("go", { ticket: "x" })), []);
  assert.deepEqual(lines(invoking("go", undefined)), []);
  assert.deepEqual(lines(invoking("typed", { ticket: "x" })), []);
  assert.match(lines(invoking("go", "x")).join("\n"), /the lent dispatch "go" takes an object, the run's body/);
  assert.match(
    lines(invoking("go", { ticket: { nested: true } })).join("\n"),
    /states\.a\.invoke\.input\.ticket: an Effect's input slot takes a string or a reference/,
  );
  assert.match(lines(invoking("typed", {})).join("\n"), /takes exactly ticket; missing: ticket/);
});

test("8. an Agent takes a prompt and its Dials, nothing else", () => {
  admits(invoking("coder", { prompt: "go", continue: true, thinkingLevel: "high", model: "stub/model" }));
  refusedOnce(
    invoking("coder", { cwd: "/work" }),
    /^states\.a\.invoke\.input: the lent Agent "coder" takes a `prompt`$/,
  );
  refusedOnce(
    invoking("coder", { prompt: "go", instructions: "be evil" }),
    /^states\.a\.invoke\.input\.instructions: not an Agent's Turn input/,
  );
  refusedOnce(
    invoking("coder", { prompt: "go", model: "anthropic/claude-opus-4" }),
    /^states\.a\.invoke\.input\.model: "anthropic\/claude-opus-4" is not a model this Open body allows/,
  );
});

test("8. a Chart names no placement: `endpoint` and `sandbox` are refused on an Agent invoke, whatever the value", () => {
  const keys = { inputKeys: ["task", "endpoint"] };
  for (const endpoint of ["http://evil.example", "{{input.endpoint}}", { $ref: "input.endpoint" }, "{{input.task}}"]) {
    refusedOnce(
      invoking("coder", { prompt: "go", endpoint }),
      /^states\.a\.invoke\.input\.endpoint: a Chart names no placement; the Open body places each Turn its Chart starts/,
      keys,
    );
  }
  refusedOnce(
    invoking("coder", { prompt: "go", sandbox: "ws-1" }),
    /^states\.a\.invoke\.input\.sandbox: a Chart names no placement/,
  );
});

// --- Every line, in rule order -------------------------------------------------------------------

test("the report lists every fault after the grammar, in rule order", () => {
  const lines = report({
    initial: "a",
    states: {
      a: { invoke: { src: "linter" }, on: { approve: "nowhere" } },
    },
  });
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[0]!, /"linter" is not a lent actor/);
  assert.match(lines[1]!, /event "approve" is not declared/);
  assert.match(lines[2]!, /target "nowhere" resolves to no state/);
  const err = (() => {
    try {
      admitChart({ initial: "a", states: { a: { invoke: { src: "linter" } } } }, decl, lent);
    } catch (e) {
      return e as ChartRefusal;
    }
  })()!;
  assert.match(err.message, /^Chart refused:\n- states\.a\.invoke\.src: "linter"/);
});

// --- References and the resolver -----------------------------------------------------------------

const scope = {
  context: { round: 2, ticket: { title: "Fix it", tags: ["a", "b"] }, notes: "say {{context.round}}" },
  event: { verdict: { ok: true } },
  input: { task: "ship" },
};

test("resolveReferences walks nested paths and array indexes", () => {
  assert.equal(resolveReferences("{{context.ticket.title}}", scope), "Fix it");
  assert.equal(resolveReferences("{{context.ticket.tags.1}}", scope), "b");
  assert.equal(resolveReferences({ $ref: "input.task" }, scope), "ship");
});

test("resolveReferences yields a whole value for a lone placeholder and interpolates the rest", () => {
  assert.deepEqual(resolveReferences("{{event.verdict}}", scope), { ok: true });
  assert.equal(resolveReferences("{{context.round}}", scope), 2);
  assert.equal(resolveReferences("round {{context.round}} of {{input.task}}", scope), "round 2 of ship");
  assert.equal(resolveReferences("v={{event.verdict}}", scope), 'v={"ok":true}');
  assert.deepEqual(resolveReferences({ a: ["{{input.task}}", 3, null] }, scope), { a: ["ship", 3, null] });
});

test("resolveReferences never resolves {{ inside data", () => {
  assert.equal(resolveReferences("{{context.notes}}", scope), "say {{context.round}}");
  assert.equal(resolveReferences("notes: {{context.notes}}", scope), "notes: say {{context.round}}");
});

test("resolveReferences throws on a missing path and never walks the prototype", () => {
  assert.throws(() => resolveReferences("{{context.missing}}", scope), /resolves to nothing/);
  assert.throws(() => resolveReferences("{{context.ticket.constructor}}", scope), /resolves to nothing/);
});

test("referencesOf lists placeholders and $ref paths", () => {
  assert.deepEqual(referencesOf({ a: "x {{context.a}} {{ event.b }}", b: [{ $ref: "input.c" }], c: 3 }), [
    "context.a",
    "event.b",
    "input.c",
  ]);
});

// --- Hash, brand, narrowed schema ----------------------------------------------------------------

test("chartDigest is the full sha256; chartHash is its first 12 hex", () => {
  const text = base() as ChartText;
  assert.match(chartDigest(text), /^[0-9a-f]{64}$/);
  assert.ok(chartDigest(text).startsWith(chartHash(text)));
});

test("chartHash does not depend on key order", () => {
  const a = { initial: "a", states: { a: { type: "final" } }, context: { x: 1, y: 2 } } as ChartText;
  const b = { context: { y: 2, x: 1 }, states: { a: { type: "final" } }, initial: "a" } as ChartText;
  assert.equal(chartHash(a), chartHash(b));
  assert.notEqual(chartHash(a), chartHash({ ...a, initial: "b" }));
});

test("isChartSchema sees the grammar under a door field's wrappers", () => {
  assert.equal(isChartSchema(chartSchema), true);
  assert.equal(isChartSchema(chartSchema.optional()), true);
  assert.equal(isChartSchema(chartSchema.describe("the Chart to run")), true);
  assert.equal(isChartSchema(z.object({})), false);
  const door = z.object({ endpoint: z.string(), chart: chartSchema });
  assert.equal(isChartSchema(door.shape.chart), true);
  const json = z.toJSONSchema(door) as unknown as { properties: { chart: unknown } };
  assert.ok(json.properties.chart);
});

test("the narrowed schema carries the Open body's names as enums", () => {
  const schema = narrowedChartSchema(decl);
  const text = JSON.stringify(schema);
  const defs = (schema as { $defs: Record<string, unknown> }).$defs;
  const invoke = JSON.stringify(defs["jr2.ChartInvoke"]);
  assert.match(invoke, /"enum":\["coder","tests","sub","gate"\]/);
  assert.match(JSON.stringify(defs["jr2.ChartGuard"]), /"enum":\["underLimit"\]/);
  assert.match(JSON.stringify(defs["jr2.ChartAction"]), /"enum":\["notify"\]/);
  for (const g of GENERIC_ACTIONS) assert.match(JSON.stringify(defs["jr2.ChartAction"]), new RegExp(`"const":"${g}"`));
  assert.match(JSON.stringify(defs["jr2.ChartState"]), /"enum":\["cooldown"\]/);
  assert.match(text, /"model":\{"type":"string","enum":\["stub\/model"\]\}/);
  assert.match(text, /"workspace":\{"type":"string","enum":\["none","write"\]\}/);
  // The free arm for a minted Agent stays, described.
  assert.match(invoke, /A minted Agent/);
});

test("chartSchemaFor: the narrowed grammar as zod is a Chart field, and a pick's tool parameters carry its enums", () => {
  const narrowed = chartSchemaFor(decl);
  assert.equal(chartSchemaFor(decl), narrowed, "one schema per declaration");
  assert.equal(isChartSchema(narrowed), true);
  assert.equal(isChartSchema(z.object({ chart: narrowed.optional() }).shape.chart), true);
  const params = JSON.stringify(z.toJSONSchema(z.object({ chart: narrowed }), { unrepresentable: "any" }));
  assert.match(params, /"enum":\["underLimit"\]/);
  assert.match(params, /"enum":\["stub\/model"\]/);
  // At generation time an unknown guard or model fails the grammar, before the door.
  const chart = fixture as ChartText;
  assert.equal(narrowed.safeParse(chart).success, true);
  const badGuard = { ...chart, states: { a: { always: { target: "a", guard: "nope" } } }, initial: "a" };
  assert.equal(narrowed.safeParse(badGuard).success, false);
  assert.equal(chartSchema.safeParse(badGuard).success, true, "the un-narrowed grammar leaves names to the door");
});

test("the Chart briefing is the grammar's root description, per body: no model allowed means no `agents` (ADR-0070)", () => {
  // The un-narrowed grammar carries the generic text; a narrowed one names the lent Agents.
  assert.equal(chartBriefingOf(chartSchema), CHART_BRIEFING);
  assert.match(CHART_BRIEFING, /`src` is a lent Agent's name or a key of `agents`/);
  // In a Chart the `agent.fault` route is optional (ADR-0070), so the briefing does not teach it.
  assert.doesNotMatch(CHART_BRIEFING, /agent\.fault/);
  assert.equal(
    (z.toJSONSchema(chartSchema, { unrepresentable: "any" }) as { description?: string }).description,
    CHART_BRIEFING,
  );
  assert.match(chartBriefingOf(chartSchemaFor(decl))!, /a lent Agent's name \(`coder`\) or a key of `agents`/);
  assert.equal(chartBriefingOf(z.object({})), undefined);

  // A body that allows no model mints nothing: its grammar has no `agents`, its briefing says so,
  // and a Chart that brings one reads why, where a strict object would say "unrecognized key".
  const mintless = chartSchemaFor({ ...decl, allows: { models: [], workspace: [] } });
  const json = z.toJSONSchema(mintless, { unrepresentable: "any" }) as {
    description?: string;
    properties: Record<string, unknown>;
  };
  assert.equal("agents" in json.properties, false);
  assert.match(
    json.description!,
    /`src` is a lent Agent's name \(`coder`\)\. This Chart mints no Agent of its own: there is no `agents`\./,
  );
  assert.doesNotMatch(json.description!, /and the Agents it mints/);
  const minted = mintless.safeParse({ ...(fixture as ChartText), agents: { x: { model: "m", instructions: "i" } } });
  assert.equal(minted.success, false);
  assert.ok(
    minted.error!.issues.some(
      (i) =>
        i.path.join(".") === "agents" &&
        i.message ===
          "this body allows no model, so a Chart under it mints no Agent; its Agents are the lent ones: coder",
    ),
    JSON.stringify(minted.error!.issues),
  );
  const { agents: _minted, ...lentOnly } = fixture as ChartText & { agents?: unknown };
  assert.equal(mintless.safeParse(lentOnly).success, true, "the grammar; the door judges the names");
});

test("a narrowed grammar shows one Agent state and its pick as `examples`, with the first lent Agent's name; it admits (ADR-0070)", () => {
  type Json = { $defs: Record<string, { examples?: unknown[] }>; properties: Record<string, { examples?: unknown[] }> };
  const json = (schema: z.ZodType<ChartText>) => z.toJSONSchema(schema, { unrepresentable: "any" }) as unknown as Json;
  const narrowed = json(chartSchemaFor(decl));
  const [state] = narrowed.$defs["jr2.ChartState"]!.examples as [
    { invoke: { src: string }; on: Record<string, unknown> },
  ];
  assert.equal(state.invoke.src, "coder");
  // The pick only: in a Chart the `agent.fault` route is optional (ADR-0070).
  assert.deepEqual(Object.keys(state.on), ["finished"]);
  const [events] = narrowed.properties.events!.examples as [Record<string, unknown>];
  assert.deepEqual(Object.keys(events), ["finished"]);
  // The fragment is a runnable Chart once given its next state: the door admits it as shown.
  assert.deepEqual(
    report({ initial: "step", events, states: { step: state, next: { type: "final" } }, output: "{{context.result}}" }),
    [],
  );
  // No lent Agent, no real name to show; the un-narrowed grammar shows nothing either.
  assert.equal(
    json(chartSchemaFor({ ...decl, lends: { guards: ["underLimit"] } })).$defs["jr2.ChartState"]!.examples,
    undefined,
  );
  assert.equal(json(chartSchema).$defs["jr2.ChartState"]!.examples, undefined);
  assert.equal(json(chartSchema).properties.events!.examples, undefined);
});

test("the grammar's JSON Schema ids are jr2's own, so an author's id beside it never collides", () => {
  const withOwn = z.object({ chart: chartSchema, other: z.object({}).meta({ id: "ChartState" }) });
  const json = z.toJSONSchema(withOwn, { unrepresentable: "any" }) as { $defs: Record<string, unknown> };
  assert.ok(json.$defs["jr2.ChartState"]);
  assert.ok(json.$defs.ChartState);
});

// --- The declaration half of open-body.ts --------------------------------------------------------

test("openBody validates its declaration and carries it as its brand", () => {
  const body = openBody(decl);
  assert.equal(isOpenBody(body), true);
  assert.equal(isOpenBody(agentSlot), false);
  assert.deepEqual(openBodyDeclarationOf(body), decl);
  assert.equal(lentOf(body), undefined);
  attachLent(body, lent);
  assert.equal(lentOf(body), lent);
  assert.throws(
    () => openBody({ ...decl, lends: { agents: ["coder", "coder"] } }),
    /lends\.agents: "coder" is listed twice/,
  );
  assert.deepEqual(
    declarationFaults({
      ...decl,
      ceilings: { turns: 0, wallClock: "soon", transitions: 1, fanOut: 1, size: 2 * 1024 * 1024 },
    }),
    [
      "ceilings.turns: 0 is not a positive integer",
      'ceilings.wallClock: "soon" is not a positive duration (like "90s", "10m", "2h")',
      "ceilings.size: 2097152 is more than 1048576 bytes (1 MiB)",
    ],
  );
  assert.deepEqual(declarationFaults({ ...decl, allows: { models: [], workspace: ["all"] } }), [
    'allows.workspace: "all" is not a Workspace access (write, read, none)',
  ]);
  assert.deepEqual(declarationFaults({ ...decl, lends: { gate: "yes" as unknown as boolean } }), [
    "lends.gate: the kit's Gate is lent whole: true or false",
  ]);
});

test("3. the kit's Gate is lent whole (`lends.gate: true`): unlent, it is not a `src`, in the grammar or at the door", () => {
  const gated: ChartText = {
    events: { go: { input: { type: "object" }, audience: "external" } },
    initial: "wait",
    states: { wait: { invoke: { src: "gate" }, on: { go: "over" } }, over: { type: "final" } },
  };
  assert.deepEqual(report(gated), []);
  const unlent = { ...decl, lends: { agents: ["coder"] } };
  assert.deepEqual(report(gated, undefined, unlent), [
    'states.wait.invoke.src: "gate" is the kit\'s Gate, which waits for an outside answer (a human, a webhook), and this Open body does not lend it (`lends.gate: true` would); lent: coder (Agent); kit: none; minted: none',
  ]);
  const srcs = (narrowed: z.ZodType<ChartText>) =>
    JSON.stringify(z.toJSONSchema(narrowed, { unrepresentable: "any" })).includes('"gate"');
  assert.equal(srcs(chartSchemaFor(decl)), true, "lent: in the src enum and the briefing");
  assert.equal(srcs(chartSchemaFor(unlent)), false, "unlent: no `gate` anywhere in the grammar");
  assert.match(chartBriefingOf(chartSchemaFor(decl))!, /`src: "gate"` is the kit's Gate/);
  assert.doesNotMatch(chartBriefingOf(chartSchemaFor(unlent))!, /Gate/);
});

// --- `fail` and `jr2.failure` (ADR-0073) --------------------------------------------------------

/** A Chart that fails the run from `stop` with `input`, and catches nothing. */
const failing = (input: unknown): ChartText =>
  ({ initial: "stop", states: { stop: { invoke: { src: "fail", input } } } }) as ChartText;

test("3. the Part that fails the run is lent whole (`lends.fail: true`): unlent, it is not a `src`, in the grammar or at the door", () => {
  const lending = { ...decl, lends: { ...decl.lends, fail: true } };
  assert.deepEqual(report(failing({ reason: "no plan fits" }), undefined, lending), []);
  assert.deepEqual(report(failing({ reason: "{{input.task}}", detail: { n: 1 } }), undefined, lending), []);
  assert.deepEqual(report(failing({ reason: "no plan fits" })), [
    'states.stop.invoke.src: "fail" is the kit\'s Part that ends the run as a Failure, and this Open body does not lend it (`lends.fail: true` would); lent: coder (Agent), tests (Effect), sub (Machine); kit: gate; minted: none',
  ]);
  const srcOf = (narrowed: Record<string, unknown>) =>
    (narrowed as { $defs: { "jr2.ChartInvoke": { properties: { src: { anyOf: Array<{ enum?: string[] }> } } } } })
      .$defs["jr2.ChartInvoke"].properties.src.anyOf[0]!.enum;
  assert.ok(srcOf(narrowedChartSchema(lending))!.includes("fail"), "lent: in the src enum");
  assert.ok(!srcOf(narrowedChartSchema(decl))!.includes("fail"), "unlent: not a src");
  // The `src` description names `fail` only where the body lends it: a model reads only what it can use.
  const srcText = (narrowed: Record<string, unknown>) =>
    (narrowed as { $defs: { "jr2.ChartInvoke": { properties: { src: { description: string } } } } }).$defs[
      "jr2.ChartInvoke"
    ].properties.src.description;
  assert.match(srcText(narrowedChartSchema(lending)), /`fail` \(ends the run as a Failure/);
  assert.doesNotMatch(srcText(narrowedChartSchema(decl)), /fail/);
  assert.match(
    chartBriefingOf(chartSchemaFor(lending))!,
    /`src: "fail"` with `input: \{ reason \}` ends the run as a Failure/,
  );
  assert.doesNotMatch(chartBriefingOf(chartSchemaFor(decl))!, /Failure/);
  assert.doesNotMatch(CHART_BRIEFING, /Failure/, "the un-narrowed briefing lends nothing");
  // The kit's names in a refusal's `kit:` list.
  assert.match(
    report({ initial: "a", states: { a: { invoke: { src: "nope" } } } }, undefined, lending)[0]!,
    /; kit: gate, fail; minted: none$/,
  );
});

test("8. `fail` takes { reason, detail? }: reason is a text that is not empty, or a reference", () => {
  const lending = { ...decl, lends: { ...decl.lends, fail: true } };
  const once = (input: unknown, expected: RegExp) => refusedOnce(failing(input), expected, undefined, lending);
  once(undefined, /^states\.stop\.invoke\.input: `fail` takes \{ reason, detail\? \}: reason is a text for a person$/);
  once("stuck", /^states\.stop\.invoke\.input: `fail` takes \{ reason, detail\? \}/);
  once({ detail: 1 }, /^states\.stop\.invoke\.input\.reason: `fail` needs a reason, a text for a person$/);
  once({ reason: "" }, /^states\.stop\.invoke\.input\.reason: a reason is a string that is not empty, or a reference$/);
  once({ reason: 7 }, /^states\.stop\.invoke\.input\.reason: a reason is a string that is not empty, or a reference$/);
  once({ reason: "r", why: "x" }, /^states\.stop\.invoke\.input\.why: `fail` takes reason and detail only$/);
});

test("3. `jr2.failure` is a guard every Chart has, with no params, and no Open body lends a part named `fail`", () => {
  const caught = (guard: unknown): ChartText =>
    ({
      initial: "try",
      states: {
        try: {
          invoke: {
            src: "tests",
            input: { filter: "x" },
            onDone: "ok",
            onError: [{ guard, target: "failed" }, { target: "broken" }],
          },
        },
        ok: { type: "final" },
        failed: { type: "final" },
        broken: { type: "final" },
      },
    }) as ChartText;
  const unlent = { ...decl, lends: { effects: ["tests"] } };
  assert.deepEqual(report(caught("jr2.failure"), undefined, unlent), [], "lent by nobody: every Chart has it");
  assert.deepEqual(report(caught({ type: "jr2.failure" }), undefined, unlent), []);
  assert.deepEqual(report(caught({ not: "jr2.failure" }), undefined, unlent), []);
  assert.ok(report(caught({ type: "jr2.failure", params: { x: 1 } }), undefined, unlent).length > 0, "no params");
  const faults = declarationFaults({ ...decl, lends: { agents: ["fail"], effects: ["fail"], fail: "yes" as never } });
  assert.deepEqual(faults, [
    "lends.fail: the kit's Part that fails the run is lent whole: true or false",
    'lends.agents: "fail" is the kit\'s Part that fails the run, lent as `fail: true`; lend a slot of another name',
    'lends.effects: "fail" is the kit\'s Part that fails the run, lent as `fail: true`; lend a slot of another name',
  ]);
  assert.deepEqual(declarationFaults({ ...decl, lends: { fail: true } }), []);
  // A minted Agent may not take the kit's name.
  assert.match(
    report({
      events: DONE,
      agents: { fail: { model: "stub/model", instructions: "i" } },
      initial: "a",
      states: {
        a: { invoke: { src: "coder", input: { prompt: "go" } }, on: { done: "b" } },
        b: { type: "final" },
      },
    }).join("\n"),
    /agents\.fail: "fail" is a lent name/,
  );
});

test("6. the door admits a Chart state that invokes an Agent with no agent.fault route: in a Chart it is optional (ADR-0070)", () => {
  const work = (on: Record<string, unknown>, parentOn?: Record<string, unknown>): ChartText =>
    ({
      events: DONE,
      initial: "outer",
      states: {
        outer: {
          ...(parentOn ? { on: parentOn } : {}),
          initial: "a",
          states: { a: { invoke: { src: "coder", input: { prompt: "go" } }, on: { done: "#c.b", ...on } } },
        },
        b: { type: "final" },
      },
      id: "c",
    }) as ChartText;
  // No route: the door admits it (the trial compile does too: open-body.test.ts).
  admits(work({}));
  // A route is still a route, on the state, above it, or with actions only.
  admits(work({ "agent.fault": "#c.b" }));
  admits(work({}, { "agent.fault": "#c.b" }));
  admits(work({ "agent.fault": { actions: [{ type: "increment", path: "faults" }] } }));
});

test("a declaration's wall clock is one timer: at most 2147483647 ms", () => {
  assert.deepEqual(declarationFaults({ ...decl, ceilings: { ...decl.ceilings, wallClock: "596h" } }), []);
  assert.deepEqual(declarationFaults({ ...decl, ceilings: { ...decl.ceilings, wallClock: "700h" } }), [
    'ceilings.wallClock: "700h" is more than one timer holds (2147483647 ms, about 596h)',
  ]);
});

test("a declaration lends no name the Chart grammar reads as its own", () => {
  const faults = declarationFaults({
    ...decl,
    lends: {
      agents: ["gate"],
      effects: ["a.b"],
      guards: ["jr2.sentBy"],
      actions: ["set", "clear"],
      delays: ["500"],
    },
  });
  assert.equal(faults.length, 6, faults.join("\n"));
  assert.match(faults[0]!, /^lends\.agents: "gate" is the kit's Gate/);
  assert.match(faults[1]!, /^lends\.effects: "a\.b" holds a dot/);
  assert.match(faults[2]!, /^lends\.guards: "jr2\.sentBy" holds a dot/);
  assert.match(faults[3]!, /^lends\.actions: "set" is a generic action/);
  assert.match(faults[5]!, /^lends\.delays: "500" reads as a delay of 500 ms/);
});

test("7. dataflow: a path the door cannot prove is refused — no `properties`, below `event.output`, an open map", () => {
  const onGo = (schema: Record<string, unknown>, from: string) => ({
    events: { go: { input: schema } },
    initial: "a",
    states: {
      a: { on: { go: { target: "b", actions: [{ type: "set", path: "out", from }] } } },
      b: { type: "final" },
    },
  });
  refusedOnce(onGo({ type: "object" }, "{{event.x}}"), /event\.x: event "go"'s input has no object with fields here/);
  refusedOnce(
    onGo({ type: "object", properties: {}, additionalProperties: { type: "string" } }, "{{event.k}}"),
    /event\.k is not a field of event "go"'s input/,
  );
  const done = {
    initial: "a",
    states: {
      a: {
        invoke: {
          src: "sub",
          onDone: { target: "b", actions: [{ type: "set", path: "out", from: "{{event.output.deep.er}}" }] },
        },
      },
      b: { type: "final" },
    },
  };
  refusedOnce(done, /event\.output\.deep\.er: an `onDone` transition supplies event\.output, whole/);
});
