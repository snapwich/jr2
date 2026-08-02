// j2Setup tests (ADR-0015): the authoring surface returns a plain xstate machine with the
// mechanism pre-wired — vocabulary attached to the machine object, mechanism events in the
// union, j2 actors pre-registered — and closes xstate's nested-`on` typo hole at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, fromCallback, type AnyActorRef } from "xstate";
import { z } from "zod";
import { defineEvent, eventMap, type EventDef } from "@j2/agent-protocol";
import { agentRunActorWith } from "../src/actor.ts";
import { bindRun, mayMove, RegistrationTable, wouldMove } from "../src/registration.ts";
import { j2Setup } from "../src/setup.ts";
import { vocabularyOf } from "../src/vocabulary.ts";
import { MockFlueClient } from "./_fixtures.ts";

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

// --- Menu derivation (ADR-0015) -------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Run a j2Setup machine under a bare binding (no RunHost): table + run identity only. Binds on
 * the root's creation inspection event — before initial children construct — exactly as RunHost
 * does, so iid minting sees the run identity. */
function hostless(machine: Parameters<typeof createActor>[0], defs: Parameters<typeof eventMap>[1]) {
  const table = new RegistrationTable();
  let bound = false;
  const actor = createActor(machine, {
    inspect: (ev) => {
      if (!bound && ev.type === "@xstate.actor") {
        bound = true;
        bindRun((ev.actorRef as AnyActorRef).system, {
          runId: "run-1",
          workflow: "wf",
          events: eventMap("wf", defs),
          table,
        });
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
  const machine = j2Setup({
    types: {} as { context: Record<string, never> },
    events: defs,
    actors: { agentRun: agentRunActorWith(() => mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "coding",
    // Shared-ancestor handlers: report_blocked bubbles into the AGENT menu (audience: agent),
    // human_approve bubbles into the GATE set (audience: external) — and never vice versa.
    on: { report_blocked: { target: ".done" }, human_approve: { target: ".done" } },
    states: {
      coding: {
        invoke: { src: "agentRun", input: { agent: "coder", prompt: "go", endpoint: "http://x" } },
        on: { request_review: "review" },
      },
      review: {
        invoke: { src: "gate", input: { gate: "g1" } },
        on: { request_changes: "coding" },
      },
      done: { type: "final" },
    },
  });

  const { actor, table } = hostless(machine, defs);
  await tick();

  // The agent's menu: own request_review + bubbled report_blocked; human_approve is excluded
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

test("session continue derives ONE deterministic iid; the fresh default mints a new one per turn", async () => {
  const go = defineEvent({ name: "go", input: z.object({}) });
  const iidsFor = async (session?: "continue") => {
    const mock = new MockFlueClient();
    const machine = j2Setup({
      types: {} as { context: Record<string, never> },
      events: [go],
      actors: { agentRun: agentRunActorWith(() => mock) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "a",
      states: {
        a: {
          invoke: {
            src: "agentRun",
            input: { agent: "coder", prompt: "one", session, scope: "F-1", endpoint: "http://x" },
          },
          on: { go: "b" },
        },
        b: {
          invoke: {
            src: "agentRun",
            input: { agent: "coder", prompt: "two", session, scope: "F-1", endpoint: "http://x" },
          },
        },
      },
    });
    const { actor } = hostless(machine, [go]);
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

test("explicit tools remain the escape hatch over the derived menu", async () => {
  const ping = defineEvent({ name: "ping", input: z.object({}) });
  const pong = defineEvent({ name: "pong", input: z.object({}) });
  const mock = new MockFlueClient();
  const machine = j2Setup({
    types: {} as { context: Record<string, never> },
    events: [ping, pong],
    actors: { agentRun: agentRunActorWith(() => mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: {
      a: {
        invoke: { src: "agentRun", input: { agent: "coder", prompt: "go", tools: ["pong"], endpoint: "http://x" } },
        on: { ping: "b", pong: "b" },
      },
      b: {},
    },
  });
  const { actor } = hostless(machine, [ping, pong]);
  await tick();
  assert.deepEqual(mock.admitted?.tools, ["pong"]);
  actor.stop();
});

test("the dials pass through to the admission; omitted, nothing is invented (ADR-0018 as amended)", async () => {
  const ping = defineEvent({ name: "ping", input: z.object({}) });
  const dialed = new MockFlueClient();
  const plain = new MockFlueClient();
  // `input` is loose for the same reason `turnWith` below is: pinning the invoke-config generic
  // here would only re-state xstate's types in a test that is about the dials.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const build = (mock: MockFlueClient, input: any) =>
    j2Setup({
      types: {} as { context: Record<string, never> },
      events: [ping],
      actors: { agentRun: agentRunActorWith(() => mock) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "a",
      states: { a: { invoke: { src: "agentRun", input }, on: { ping: "b" } }, b: {} },
    });

  const base = { agent: "coder", prompt: "go", endpoint: "http://x" };
  const a = hostless(build(dialed, { ...base, model: "vllm/big", thinkingLevel: "xhigh" }), [ping]);
  const b = hostless(build(plain, base), [ping]);
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
  const machine = j2Setup({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: {} as { context: any },
    events: defs,
    actors: { agentRun: agentRunActorWith(() => mock) },
  }).createMachine({
    id: "wf",
    context,
    initial: "a",
    states: {
      a: { invoke: { src: "agentRun", input: { agent: "coder", prompt: "go", endpoint: "http://x" } }, on },
      b: {},
    },
  });
  const { actor, table } = hostless(machine, defs);
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
