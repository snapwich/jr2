// The door's `file:` refusal (ADR-0069): a context whose digest the image map does not hold. The
// door imports the Assembly from a staging path that is gone when its `422` arrives, so the line
// names the context relative to the Assembly and the Workflow that names it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setup, type AnyStateMachine } from "xstate";
import { z } from "zod";
import {
  assemblyRefusals,
  dispatchRefusals,
  doorRefusals,
  placementWalkOf,
  type LoadedWorkflow,
} from "../src/assembly-checks.ts";
import { dispatch } from "../src/dispatch-effect.ts";
import { secret } from "../src/http-effect.ts";
import { open } from "../src/open.ts";
import { partsOf } from "../src/parts.ts";
import { chartedSrc, machineOf } from "./_assembly.ts";
import { agent } from "../src/harness-client.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";

function boxed(image: string) {
  const body = jr2Setup({
    events: [],
    actors: { coder: agent({ model: "vllm/qwen", instructions: "i" }) },
  }).createMachine({
    id: "body",
    initial: "working",
    states: { working: { invoke: { id: "coder", src: "coder", input: { prompt: "go" } } } },
  });
  return workspace(body, { image, repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });
}

test("a `file:` context not in the image map is named relative to the Assembly, with its Workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-checks-"));
  const tree = join(root, ".staging-0123456789ab-dead", "tree");
  await mkdir(join(tree, "images", "box"), { recursive: true });
  await writeFile(join(tree, "images", "box", "Dockerfile"), "FROM scratch\n");
  const lines = await assemblyRefusals({
    config: undefined,
    workflows: [{ name: "build", machine: boxed(pathToFileURL(join(tree, "images", "box")).href) }],
    images: async () => ({ harness: "h", custodian: "c", sandbox: {} }),
    root: tree,
  });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^the Sandbox Image context images\/box that workflow "build" names \(digest [0-9a-f]{12}\)/);
  assert.ok(!lines[0]!.includes(".staging-"), "the staging path never reaches the report");
});

test('the placement walk\'s Instance Harness holds the models of an Open body that allows "none" (ADR-0070)', async () => {
  // `charted` has no "none" Agent; its Open body allows "none" and `stub/model`, so a Chart's
  // minted "none" Agent may name that model: the door and `jr2 up` place its key from one walk.
  const machine = await machineOf(chartedSrc());
  const walk = placementWalkOf([{ name: "charted", machine }]);
  assert.deepEqual(walk.instanceHarness, { models: ["stub/model"] });
  assert.deepEqual(walk.instanceHarness, partsOf([machine]).instanceHarness);
});

// --- What a dispatch names (ADR-0071) ------------------------------------------------------------

/** A Workflow whose door takes `{ ticket, priority? }`. */
function intake() {
  return jr2Setup({ events: [] }).createMachine({
    id: "intake",
    input: z.object({ ticket: z.string(), priority: z.enum(["low", "high"]).optional() }),
    initial: "a",
    states: { a: {} },
  });
}

/** A watcher with one dispatch slot. */
function caller(slot: ReturnType<typeof dispatch>) {
  return jr2Setup({ events: [], actors: { hand: slot } }).createMachine({
    id: "watcher",
    initial: "a",
    states: { a: {} },
  });
}

test("a dispatch of a Workflow the Assembly has passes; a miss refuses, naming the fix", async () => {
  const ok = dispatchRefusals(
    [
      { name: "watch", machine: caller(dispatch("intake", { input: z.object({ ticket: z.string() }) })) },
      { name: "intake", machine: intake() },
    ],
    [],
  );
  assert.deepEqual(ok, { errors: [], warnings: [] });
  const miss = dispatchRefusals([{ name: "watch", machine: caller(dispatch("intak")) }], []);
  assert.deepEqual(miss.errors, [
    'workflow "watch" dispatches "intak" which no Workflow in the Assembly has — add workflows/intak.ts, or name ' +
      'one it registers: "watch" (ADR-0071)',
  ]);
  // The door's walk refuses the publish with the same line.
  const lines = await assemblyRefusals({
    config: undefined,
    workflows: [{ name: "watch", machine: caller(dispatch("intak")) }],
  });
  assert.deepEqual(lines, miss.errors);
});

test("a slot schema the door does not take refuses, naming the field", () => {
  const { errors } = dispatchRefusals(
    [
      { name: "watch", machine: caller(dispatch("intake", { input: z.object({ ticket: z.number() }) })) },
      { name: "intake", machine: intake() },
    ],
    [],
  );
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(
    errors[0]!,
    /^workflow "watch" dispatches "intake" with input its door does not take: "ticket": the slot sends number, and the door takes string — align/,
  );
  const extra = dispatchRefusals(
    [
      {
        name: "watch",
        machine: caller(dispatch("intake", { input: z.object({ ticket: z.string(), sha: z.string() }) })),
      },
      { name: "intake", machine: intake() },
    ],
    [],
  );
  assert.match(extra.errors[0]!, /the slot's field "sha" is not in the door, which strips it silently/);
  // With no schema the door alone checks the body: nothing to compare.
  assert.deepEqual(
    dispatchRefusals(
      [
        { name: "watch", machine: caller(dispatch("intake")) },
        { name: "intake", machine: intake() },
      ],
      [],
    ),
    { errors: [], warnings: [] },
  );
});

test("a schema outside the compared subset is a warning, not compared", () => {
  const r = dispatchRefusals(
    [
      { name: "watch", machine: caller(dispatch("intake", { input: z.object({ ticket: z.string().email() }) })) },
      { name: "intake", machine: intake() },
    ],
    [],
  );
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0]!, /^workflow "watch" dispatches "intake": its input schema and the door are not compared/);
});

test("a door zod cannot draw as JSON Schema is not compared — a warning, never a guessed match", () => {
  const dated = jr2Setup({ events: [] }).createMachine({
    id: "dated",
    input: z.object({ when: z.date() }),
    initial: "a",
    states: { a: {} },
  });
  const r = dispatchRefusals(
    [
      { name: "watch", machine: caller(dispatch("dated", { input: z.object({ when: z.string() }) })) },
      { name: "dated", machine: dated },
    ],
    [],
  );
  assert.deepEqual(r.errors, []);
  assert.match(
    r.warnings[0]!,
    /^workflow "watch" dispatches "dated": its input schema and the door are not compared — the door has a part JSON Schema cannot state/,
  );
});

test("a named Chart: a Chart file resolves it; a slashed name under a known wrapper warns without the registry and refuses with it", async () => {
  const wrapper = await machineOf(chartedSrc());
  const workflows = (slot: ReturnType<typeof dispatch>) => [
    { name: "watch", machine: caller(slot) },
    { name: "task", machine: wrapper },
  ];
  const file = { wrapper: "task", name: "loop", path: "workflows/task/loop.chart.json", text: {} };
  // The door of a named Chart is the wrapper's minus its Chart field: `{ endpoint, task }`.
  const body = z.object({ endpoint: z.string(), task: z.string() });
  assert.deepEqual(dispatchRefusals(workflows(dispatch("task/loop", { input: body })), [file]), {
    errors: [],
    warnings: [],
  });
  const withChart = dispatchRefusals(workflows(dispatch("task/loop", { input: body.extend({ chart: z.string() }) })), [
    file,
  ]);
  assert.match(withChart.errors[0]!, /the slot's field "chart" is not in the door/);
  // No Chart file: the host cannot see the volume, so it warns.
  const host = dispatchRefusals(workflows(dispatch("task/other")), []);
  assert.deepEqual(host.errors, []);
  assert.match(
    host.warnings[0]!,
    /^workflow "watch" dispatches "task\/other": the Assembly has no Chart file workflows\/task\/other\.chart\.json, and a runtime Chart lives on the Orchestrator's volume alone/,
  );
  // The door sees the volume: a runtime Chart resolves it, and a miss refuses.
  assert.deepEqual(dispatchRefusals(workflows(dispatch("task/other")), [], [{ name: "task/other" }]).errors, []);
  const door = dispatchRefusals(workflows(dispatch("task/other")), [], []);
  assert.match(
    door.errors[0]!,
    /^workflow "watch" dispatches "task\/other" which no Workflow in the Assembly has — add the Chart file/,
  );
  // The fix names the order a publish that adds the wrapper needs: a PUT needs it current.
  assert.match(
    door.errors[0]!,
    /PUT \/workflows\/task\/charts\/other before this publish \(a PUT needs "task" in the current Assembly: when this publish adds it, publish "task" first, then PUT the Chart, then publish the dispatch\)/,
  );
  // With no Chart file the door is still known — the wrapper's minus its Chart fields — so the host
  // warns AND compares, and a mismatch refuses before any cluster work.
  const mismatch = dispatchRefusals(
    workflows(dispatch("task/other", { input: z.object({ endpoint: z.number(), task: z.string() }) })),
    [],
  );
  assert.equal(mismatch.warnings.length, 1);
  assert.match(mismatch.errors[0]!, /"endpoint": the slot sends number, and the door takes string/);
  // A wrapper the Assembly does not have is a miss on both ends.
  assert.match(
    dispatchRefusals(workflows(dispatch("gone/loop")), []).errors[0]!,
    /no workflows\/gone\.ts registers the Chart wrapper "gone"/,
  );
  // A wrapper that is no Chart wrapper is named as such.
  assert.match(dispatchRefusals(workflows(dispatch("watch/loop")), []).errors[0]!, /is no Chart wrapper/);
});

test("a foreign target is not checked here: its door is another Instance's, which jr2 up only warns about", () => {
  const away = dispatch("missing", { target: { url: "https://ops.example.com", token: secret("ops") } });
  const later = dispatch("missing", { target: open });
  assert.deepEqual(dispatchRefusals([{ name: "watch", machine: caller(away) }], []), { errors: [], warnings: [] });
  assert.deepEqual(dispatchRefusals([{ name: "watch", machine: caller(later as never) }], []), {
    errors: [],
    warnings: [],
  });
});

// --- A door that no one reads (ADR-0033) ----------------------------------------------------------

test("a zod `input` on a Machine that plain setup() made is refused, naming jr2Setup; one with no door passes", async () => {
  const lost = setup({}).createMachine({
    id: "lost",
    input: z.object({ message: z.string() }),
    initial: "a",
    states: { a: {} },
  }) as AnyStateMachine;
  const plain = setup({}).createMachine({ id: "plain", initial: "a", states: { a: {} } }) as AnyStateMachine;
  const workflows: LoadedWorkflow[] = [
    { name: "lost", machine: lost },
    { name: "plain", machine: plain },
    { name: "intake", machine: intake() },
    { name: "build", machine: boxed("node:24") },
  ];
  const lines = doorRefusals(workflows);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(
    lines[0]!,
    /^workflow "lost": machine "lost" has a zod `input` on createMachine, but jr2Setup did not make it, so no door reads that input/,
  );
  assert.match(lines[0]!, /make the Machine with jr2Setup in place of setup\(\) .*\(ADR-0033\)$/);
  // A `.provide()` clone keeps the config, so it is refused too.
  assert.equal(doorRefusals([{ name: "lost", machine: lost.provide({}) }]).length, 1);
  // The door's walk holds the same line.
  assert.deepEqual(await assemblyRefusals({ config: undefined, workflows }), lines);
});
