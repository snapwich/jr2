// j2Setup tests (ADR-0015): the authoring surface returns a plain xstate machine with the
// mechanism pre-wired — vocabulary attached to the machine object, mechanism events in the
// union, j2 actors pre-registered — and closes xstate's nested-`on` typo hole at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, fromCallback } from "xstate";
import { z } from "zod";
import { defineEvent } from "@j2/agent-protocol";
import { j2Setup } from "../src/setup.ts";
import { vocabularyOf } from "../src/vocabulary.ts";

const approve = defineEvent({ name: "approve", input: z.object({}) });
const requestChanges = defineEvent({ name: "request_changes", input: z.object({ notes: z.string() }) });

test("createMachine attaches the vocabulary to the machine object (the manifest is dead)", () => {
  const machine = j2Setup({
    types: {} as { context: Record<string, never> },
    events: [approve, requestChanges],
  }).createMachine({
    id: "wf",
    context: {},
    initial: "review",
    states: { review: { on: { approve: "done", request_changes: "review" } }, done: { type: "final" } },
  });

  const vocab = vocabularyOf(machine);
  assert.equal(vocab?.get("approve"), approve);
  assert.equal(vocab?.get("request_changes"), requestChanges);
  assert.equal(vocab?.size, 2);
});

test("audience defaults to any and rides the def", () => {
  assert.equal(approve.audience, "any");
  const external = defineEvent({ name: "human_only", audience: "external", input: z.object({}) });
  assert.equal(external.audience, "external");
});

test("an event key with no def fails at createMachine — even in a NESTED state's `on`", () => {
  // The RUNTIME check is the subject: xstate's excess-property checking is porous for nested
  // `on` keys in looser configs (report-xstate §6), and with vocabulary derived from the machine
  // a typo would silently become vocabulary. Here tsc happens to catch the literal too, hence
  // the expect-error — the throw below is what protects the configs tsc can't see through.
  assert.throws(
    () =>
      j2Setup({ events: [approve] }).createMachine({
        id: "wf",
        initial: "outer",
        states: {
          outer: {
            initial: "inner",
            // @ts-expect-error — the typo'd key, nested two levels down, is deliberate
            states: { inner: { on: { aprove: {} } } },
          },
        },
      }),
    /machine "wf" handles event "aprove".*declared: approve/s,
  );
});

test("mechanism events (dotted) and the wildcard are never mistaken for vocabulary", () => {
  const machine = j2Setup({ events: [approve] }).createMachine({
    id: "wf",
    initial: "a",
    states: {
      a: {
        on: {
          approve: "b",
          "agent.fault": "b",
          "workspace.lost": "b",
          "*": { guard: () => false, target: "b" },
        },
        after: { 1000: "b" },
      },
      b: {},
    },
  });
  assert.deepEqual([...vocabularyOf(machine)!.keys()], ["approve"]);
});

test("duplicate and reserved-semantics defs fail at createMachine, naming the machine", () => {
  const dupe = defineEvent({ name: "approve", input: z.object({ notes: z.string() }) });
  assert.throws(
    () => j2Setup({ events: [approve, dupe] }).createMachine({ id: "wf", initial: "a", states: { a: {} } }),
    /workflow "wf": duplicate event "approve"/,
  );

  // ADR-0013 reserves `deferred`/`poll`; degrading one to `ack` would hand the Agent a lying
  // tool contract, so the machine refuses to build.
  const held = defineEvent({
    name: "request_approval",
    semantics: "deferred",
    input: z.object({ action: z.string() }),
    output: z.object({ decision: z.string() }),
  });
  assert.throws(
    () => j2Setup({ events: [held] }).createMachine({ id: "wf", initial: "a", states: { a: {} } }),
    /"request_approval" is `deferred`.*NOT IMPLEMENTED/s,
  );
});

test("agentRun and gate are pre-registered; a consumer actor under the same name wins", async () => {
  let ranOverride = false;
  const machine = j2Setup({
    types: {} as { context: Record<string, never> },
    events: [approve],
    actors: {
      agentRun: fromCallback(() => {
        ranOverride = true;
      }),
      probe: fromCallback(() => {}),
    },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "working",
    states: {
      // Both resolve by NAME with no consumer listing: gate from j2, agentRun overridden.
      working: {
        invoke: [
          { src: "agentRun", input: { agentName: "x", instanceId: "i", endpoint: "http://x", tools: [] } },
          { src: "probe", input: {} },
        ],
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });

  // The override means no run binding / flue client is needed — it starts as a plain machine.
  const actor = createActor(machine);
  actor.start();
  actor.stop();
  assert.ok(ranOverride, "consumer-supplied agentRun logic must win over the pre-registered one");
});

test("the returned machine is a plain StateMachine: provide() still works as the test seam", () => {
  const machine = j2Setup({
    types: {} as { context: Record<string, never> },
    events: [approve],
  }).createMachine({ id: "wf", context: {}, initial: "a", states: { a: { on: { approve: "b" } }, b: {} } });

  const provided = machine.provide({ actors: { agentRun: fromCallback(() => {}) } });
  assert.ok(provided);
  // Discovery registers the PRE-provide machine, which is the one carrying the vocabulary.
  assert.ok(vocabularyOf(machine));
});
