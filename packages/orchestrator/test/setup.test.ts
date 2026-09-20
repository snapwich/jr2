// jr2Setup tests (ADR-0015): the authoring surface returns a plain xstate machine with the
// mechanism pre-wired — vocabulary attached to the machine object, mechanism events in the
// union, `gate` pre-registered and every Agent SLOT finalized by brand (ADR-0049) — and closes
// xstate's nested-`on` typo hole at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, fromCallback, type AnyActorRef } from "xstate";
import { z } from "zod";
import { defineEvent, type EventDef } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { agent } from "../src/harness-client.ts";
import { bindRun, mayMove, RegistrationTable, wouldMove, type RunBinding } from "../src/registration.ts";
import { jr2Setup } from "../src/setup.ts";
import { vocabularyOf } from "../src/vocabulary.ts";
import { MockFlueClient } from "./_fixtures.ts";

/** The Agent every fixture here carries. Its content never matters — no model is called — but a
 * slot needs a definition, because the definition IS the slot (ADR-0049). */
const testDefinition: AgentDefinition = { model: "test/model", instructions: "i" };

/** One Agent slot over a mock port: what a Machine declares, with the wire swapped out. */
const slot = (mock: MockFlueClient) => agentActorWith(() => mock, testDefinition);

const approve = defineEvent({ name: "approve", input: z.object({}) });
const requestChanges = defineEvent({ name: "request_changes", input: z.object({ notes: z.string() }) });

test("createMachine attaches the vocabulary to the machine object (the manifest is dead)", () => {
  const machine = jr2Setup({
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
      jr2Setup({ events: [approve] }).createMachine({
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
  const machine = jr2Setup({ events: [approve] }).createMachine({
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
    () => jr2Setup({ events: [approve, dupe] }).createMachine({ id: "wf", initial: "a", states: { a: {} } }),
    /machine "wf": duplicate event "approve"/,
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
    () => jr2Setup({ events: [held] }).createMachine({ id: "wf", initial: "a", states: { a: {} } }),
    /"request_approval" is `deferred`.*NOT IMPLEMENTED/s,
  );
});

test("an Agent slot is the Machine's own logic; provide() swaps it — the unit-test seam (ADR-0049)", () => {
  let ranFake = false;
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [approve],
    actors: { coder: agent(testDefinition), probe: fromCallback(() => {}) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "working",
    states: {
      // `coder` is not resolved against anything: it is the slot this Machine declares, so its
      // name is checked by xstate's own `src` typing (ADR-0049/0050).
      working: {
        invoke: [
          { src: "coder", input: { prompt: "go", endpoint: "http://x", tools: [] } },
          { src: "probe", input: {} },
        ],
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });

  // Replacing the SLOT replaces the Agent — no roster, no host, nothing to inject: the fake is
  // what runs, so this machine starts with no run binding and no Harness at all.
  const faked = machine.provide({
    actors: {
      coder: fromCallback(() => {
        ranFake = true;
      }),
    },
  });
  const actor = createActor(faked);
  actor.start();
  actor.stop();
  assert.ok(ranFake, "the provided slot logic must win over the declared agent()");
});

test("the returned machine is a plain StateMachine: provide() still works as the test seam", () => {
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [approve],
  }).createMachine({ id: "wf", context: {}, initial: "a", states: { a: { on: { approve: "b" } }, b: {} } });

  const provided = machine.provide({ actors: { gate: fromCallback(() => {}) } });
  assert.ok(provided);
  // Discovery registers the PRE-provide machine, which is the one carrying the vocabulary.
  assert.ok(vocabularyOf(machine));
});

// --- Menu derivation (ADR-0015) -------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Run a jr2Setup machine under a bare binding (no RunHost): table + run identity only. Binds on
 * the root's creation inspection event — before initial children construct — exactly as RunHost
 * does, so iid minting sees the run identity. The binding carries NO vocabulary: names resolve
 * against the invoking Machine, which already carries its own defs (ADR-0011, ADR-0049). */
function hostless(machine: Parameters<typeof createActor>[0], extra: Partial<RunBinding> = {}) {
  const table = new RegistrationTable();
  let bound = false;
  const actor = createActor(machine, {
    inspect: (ev) => {
      if (!bound && ev.type === "@xstate.actor") {
        bound = true;
        bindRun((ev.actorRef as AnyActorRef).system, { runId: "run-1", workflow: "wf", table, ...extra });
      }
    },
  });
  actor.start();
  return { actor, table };
}

test("agent menus and gate accepts derive from transitions, routed by audience", async () => {
  const requestReview = defineEvent({ name: "request_review", input: z.object({}) }); // any
  const reportBlocked = defineEvent({ name: "report_blocked", audience: "agent", input: z.object({}) });
  const humanApprove = defineEvent({ name: "human_approve", audience: "external", input: z.object({}) });
  const requestChanges = defineEvent({ name: "request_changes", input: z.object({}) }); // any
  const defs = [requestReview, reportBlocked, humanApprove, requestChanges];

  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: defs,
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "coding",
    // Shared-ancestor handlers: report_blocked bubbles into the AGENT menu (audience: agent),
    // human_approve bubbles into the GATE set (audience: external) — and never vice versa.
    on: { report_blocked: { target: ".done" }, human_approve: { target: ".done" } },
    states: {
      coding: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        on: { request_review: "review" },
      },
      review: {
        invoke: { src: "gate", input: { gate: "g1" } },
        on: { request_changes: "coding" },
      },
      done: { type: "final" },
    },
  });

  const { actor, table } = hostless(machine);
  await tick();

  // The Agent's name came off the SLOT KEY (ADR-0049) — the invoke never wrote it…
  assert.equal(mock.admitted?.agentName, "coder");
  // …and its menu is own request_review + bubbled report_blocked; human_approve is excluded
  // by its audience even though it bubbles here too.
  assert.deepEqual([...(mock.admitted?.tools ?? [])].sort(), ["report_blocked", "request_review"]);
  // The minted iid is run-scoped and readable; fresh sessions get a random suffix.
  assert.match(mock.admitted?.instanceId ?? "", /^run-1\/.+\/coder\/[0-9a-f]{8}$/);

  // Move to the gate state through the real seam and read the derived accepted set.
  table.deliver(`agent/${mock.admitted!.instanceId}`, "request_review", {});
  await tick();
  const gateReg = table.byRun("run-1").find((r) => r.kind === "gate");
  assert.deepEqual([...(gateReg?.defs.keys() ?? [])].sort(), ["human_approve", "request_changes"]);

  actor.stop();
});

test("two Machines may each carry a `coder`, and each Turn places by ITS OWN definition (ADR-0049)", async () => {
  // The pair a roster could not hold: one name, two definitions, one run. The parent's coder is
  // Menu-only, so its Turn goes to the Instance Harness (ADR-0031); the child's is an ordinary
  // one that resolves the endpoint it was handed. Nothing merges, and neither Machine can see the
  // other's slot.
  const go = defineEvent({ name: "go", input: z.object({}) });
  const outerPort = new MockFlueClient();
  const innerPort = new MockFlueClient();
  const endpoints: string[] = [];
  const named = (mock: MockFlueClient, definition: AgentDefinition) =>
    agentActorWith((endpoint: string) => (endpoints.push(endpoint), mock), definition);

  const child = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: named(innerPort, testDefinition) },
  }).createMachine({
    id: "child",
    context: {},
    initial: "coding",
    states: { coding: { invoke: { src: "coder", input: { prompt: "code it", endpoint: "http://sandbox.test" } } } },
  });

  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [go],
    actors: { coder: named(outerPort, { ...testDefinition, workspace: "none" }), child },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "advising",
    states: {
      advising: { invoke: { src: "coder", input: { prompt: "advise" } }, on: { go: "working" } },
      working: { invoke: { src: "child" } },
    },
  });

  const { actor, table } = hostless(machine, { instanceHarness: "http://jr2-instance-harness.ns.svc:8080" });
  await tick();
  // The parent's Turn: no endpoint authored, and its own definition says "none".
  assert.equal(outerPort.admitted?.agentName, "coder");
  assert.deepEqual(endpoints, ["http://jr2-instance-harness.ns.svc:8080"]);

  table.deliver(`agent/${outerPort.admitted!.instanceId}`, "go", {});
  await tick();

  // The child's Turn: the same NAME, a different Agent — its own port, its own placement.
  assert.equal(innerPort.admitted?.agentName, "coder");
  assert.deepEqual(endpoints, ["http://jr2-instance-harness.ns.svc:8080", "http://sandbox.test"]);
  assert.notEqual(outerPort.admitted?.instanceId, innerPort.admitted?.instanceId, "two conversations");
  actor.stop();
});

test("session continue derives ONE deterministic iid; the fresh default mints a new one per turn", async () => {
  const go = defineEvent({ name: "go", input: z.object({}) });
  const iidsFor = async (session?: "continue") => {
    const mock = new MockFlueClient();
    const machine = jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [go],
      actors: { coder: slot(mock) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "a",
      states: {
        a: {
          invoke: {
            src: "coder",
            input: { prompt: "one", session, scope: "F-1", endpoint: "http://x" },
          },
          on: { go: "b" },
        },
        b: {
          invoke: {
            src: "coder",
            input: { prompt: "two", session, scope: "F-1", endpoint: "http://x" },
          },
        },
      },
    });
    const { actor } = hostless(machine);
    await tick();
    actor.send({ type: "go" });
    await tick();
    actor.stop();
    return mock.admits.map((a) => a.instanceId);
  };

  const continued = await iidsFor("continue");
  assert.equal(continued.length, 2);
  assert.equal(continued[0], continued[1], "continue: one conversation travels across states");

  const fresh = await iidsFor(undefined);
  assert.equal(fresh.length, 2);
  assert.notEqual(fresh[0], fresh[1], "fresh (default): every invocation is a new conversation");
});

test("a `conversation` pin derives ONE run-scoped iid across MACHINES; `continue` alone cannot", async () => {
  // `session: "continue"`'s derived id carries the invoking actor's path, so it spans states of
  // one machine only. The pin replaces the path with a workflow-chosen name — the seam that lets
  // a pre-workspace triage state and a state inside the workspace() body continue one
  // conversation (triaged-task's shape, ADR-0031's continuation scenario).
  const go = defineEvent({ name: "go", input: z.object({}) });
  const iidsFor = async (conversation?: string) => {
    const mock = new MockFlueClient();
    const turn = (prompt: string) =>
      conversation
        ? { prompt, conversation, endpoint: "http://x" }
        : { prompt, session: "continue" as const, endpoint: "http://x" };
    const child = jr2Setup({
      types: {} as { context: Record<string, never> },
      // The nested Machine carries its OWN `triager` slot (ADR-0049): same name, same definition
      // here, but a separate declaration — nothing crosses the invoke boundary.
      events: [],
      actors: { triager: slot(mock) },
    }).createMachine({
      id: "child",
      context: {},
      initial: "deciding",
      states: { deciding: { invoke: { src: "triager", input: turn("again") } } },
    });
    const machine = jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [go],
      actors: { triager: slot(mock), child },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "triage",
      states: {
        triage: { invoke: { src: "triager", input: turn("one") }, on: { go: "working" } },
        working: { invoke: { src: "child" } },
      },
    });
    const { actor, table } = hostless(machine);
    await tick();
    table.deliver(`agent/${mock.admits[0]!.instanceId}`, "go", {});
    await tick();
    actor.stop();
    return mock.admits.map((a) => a.instanceId);
  };

  const pinned = await iidsFor("triage");
  assert.equal(pinned.length, 2);
  assert.equal(pinned[0], "run-1/triage/triager", "deterministic, run-scoped, path-free");
  assert.equal(pinned[0], pinned[1], "one conversation across the two machines");

  const unpinned = await iidsFor(undefined);
  assert.equal(unpinned.length, 2);
  assert.notEqual(unpinned[0], unpinned[1], "continue is path-scoped: a machine boundary diverges it");
});

test("explicit tools remain the escape hatch over the derived menu", async () => {
  const ping = defineEvent({ name: "ping", input: z.object({}) });
  const pong = defineEvent({ name: "pong", input: z.object({}) });
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [ping, pong],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: {
      a: {
        invoke: { src: "coder", input: { prompt: "go", tools: ["pong"], endpoint: "http://x" } },
        on: { ping: "b", pong: "b" },
      },
      b: {},
    },
  });
  const { actor } = hostless(machine);
  await tick();
  assert.deepEqual(mock.admitted?.tools, ["pong"]);
  actor.stop();
});

test("the dials pass through to the admission; omitted, nothing is invented (ADR-0018)", async () => {
  const ping = defineEvent({ name: "ping", input: z.object({}) });
  const dialed = new MockFlueClient();
  const plain = new MockFlueClient();
  // `input` is loose for the same reason `turnWith` below is: pinning the invoke-config generic
  // here would only re-state xstate's types in a test that is about the dials.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const build = (mock: MockFlueClient, input: any) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [ping],
      actors: { coder: slot(mock) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "a",
      states: { a: { invoke: { src: "coder", input }, on: { ping: "b" } }, b: {} },
    });

  const base = { prompt: "go", endpoint: "http://x" };
  const a = hostless(build(dialed, { ...base, model: "vllm/big", thinkingLevel: "xhigh" }));
  const b = hostless(build(plain, base));
  await tick();

  assert.equal(dialed.admitted?.model, "vllm/big");
  assert.equal(dialed.admitted?.thinkingLevel, "xhigh");
  // A workflow that names no dials must not start naming them — the Harness runs the definition.
  assert.equal(plain.admitted?.model, undefined);
  assert.equal(plain.admitted?.thinkingLevel, undefined);
  a.actor.stop();
  b.actor.stop();
});

// --- Guard filtering (ADR-0029) ---------------------------------------------------------------
// The VOCABULARY stays static — the registration still carries every name the state's transitions
// handle, because that is what delivery validates against. What guards decide is what the SURFACE
// offers, which is `mayMove`, asked per turn.

/** Build a one-state agent turn whose transitions are `on`, and hand back its live registration.
 * `on` is loose on purpose: these cases are ABOUT guard shapes, and pinning the transition-config
 * generic here would only re-state xstate's types in the test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function turnWith(on: any, context: Record<string, unknown>, defs: EventDef[]) {
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: {} as { context: any },
    events: defs,
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context,
    initial: "a",
    states: {
      a: { invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } }, on },
      b: {},
    },
  });
  const { actor, table } = hostless(machine);
  await tick();
  const reg = table.byRun("run-1").find((r) => r.kind === "agent")!;
  return { actor, reg, mock };
}

test("a context guard filters the menu; the vocabulary it validates against is untouched", async () => {
  const escalate = defineEvent({ name: "escalate", input: z.object({ reason: z.string() }) });
  const go = defineEvent({ name: "go", input: z.object({}) });
  const on = {
    escalate: { guard: ({ context }: { context: { rounds: number } }) => context.rounds > 0, target: "b" },
    go: { target: "b" },
  };

  const cold = await turnWith(on, { rounds: 0 }, [escalate, go]);
  // Registered defs are the full derived vocabulary either way — filtering is a surface concern.
  assert.deepEqual([...cold.reg.defs.keys()].sort(), ["escalate", "go"]);
  assert.equal(mayMove(cold.reg.invoker, "escalate"), false, "guarded false on round 0: not offered");
  assert.equal(mayMove(cold.reg.invoker, "go"), true);
  cold.actor.stop();

  // Same machine, same menu names, one context value different — and the tool appears.
  const warm = await turnWith(on, { rounds: 1 }, [escalate, go]);
  assert.equal(mayMove(warm.reg.invoker, "escalate"), true, "the guard flipped: now offered");
  warm.actor.stop();
});

test("a guard that reads the PICK is never hidden — the menu defers to delivery", async () => {
  const verdict = defineEvent({ name: "verdict", input: z.object({ verdict: z.string() }) });
  const on = {
    verdict: { guard: ({ event }: { event: { verdict: string } }) => event.verdict === "approved", target: "b" },
  };
  const { actor, reg } = await turnWith(on, {}, [verdict]);

  // Payload-blind, this guard answers `false` on `undefined` — a plain `can()` would delete the
  // Agent's only tool. The probe sees it read the payload and offers it anyway.
  assert.equal(mayMove(reg.invoker, "verdict"), true, "offered: the guard judges arguments we do not have yet");
  // Delivery HAS the arguments, so there the same guard is answered exactly, both ways.
  assert.equal(wouldMove(reg.invoker, { type: "verdict", verdict: "nope" }), false);
  assert.equal(wouldMove(reg.invoker, { type: "verdict", verdict: "approved" }), true);
  actor.stop();
});

test("a handler that neither targets nor acts is not a handler", async () => {
  const noop = defineEvent({ name: "noop", input: z.object({}) });
  const { actor, reg } = await turnWith({ noop: {} }, {}, [noop]);
  assert.equal(mayMove(reg.invoker, "noop"), false);
  actor.stop();
});

test("no invoker to ask means offer everything — the predicate fails open", () => {
  assert.equal(mayMove(undefined, "anything"), true);
  assert.equal(wouldMove(undefined, { type: "anything" }), true);
});
