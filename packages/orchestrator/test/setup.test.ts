// jr2Setup tests (ADR-0015): the authoring surface returns a plain xstate machine with the
// mechanism pre-wired — vocabulary attached to the machine object, mechanism events in the
// union, `gate` pre-registered and every Agent SLOT finalized by brand (ADR-0049) — and closes
// xstate's nested-`on` typo hole at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, fromCallback, spawnChild, type AnyActorRef } from "xstate";
import { z } from "zod";
import { defineEvent, type EventDef } from "@jr2/agent-protocol";
import { agentActorWith, type AgentTurnInput } from "../src/actor.ts";
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
          { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
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
 * against the invoking Machine, which already carries its own defs (ADR-0011, ADR-0049).
 *
 * `errors` is the actor's ERROR channel, subscribed before start exactly as RunHost's `track`
 * does: an invoke that throws — an input mapper refusing a Turn — errors the root and becomes
 * the run's fault, instead of escaping as an unhandled rejection. */
function hostless(machine: Parameters<typeof createActor>[0], extra: Partial<RunBinding> = {}) {
  const table = new RegistrationTable();
  const errors: Error[] = [];
  let bound = false;
  const actor = createActor(machine, {
    inspect: (ev) => {
      if (!bound && ev.type === "@xstate.actor") {
        bound = true;
        bindRun((ev.actorRef as AnyActorRef).system, { runId: "run-1", workflow: "wf", table, ...extra });
      }
    },
  });
  actor.subscribe({ error: (err) => errors.push(err instanceof Error ? err : new Error(String(err))) });
  actor.start();
  return { actor, table, errors };
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
  // The minted iid is run-scoped and readable; a FRESH Turn gets a random suffix (ADR-0057).
  assert.match(mock.admitted?.instanceId ?? "", /^run-1\/.+\/coder\/[0-9a-f]{8}$/);

  // Move to the gate state through the real seam and read the derived accepted set.
  table.deliver(`agent/${mock.admitted!.instanceId}`, "request_review", {});
  await tick();
  const gateReg = table.byRun("run-1").find((r) => r.kind === "gate");
  assert.deepEqual([...(gateReg?.defs.keys() ?? [])].sort(), ["human_approve", "request_changes"]);

  actor.stop();
});

// An EMPTY Menu is legitimate — a state moved by a Gate or a timer asks its Agent for text and
// nothing else — so it cannot be refused on sight. What is refused is the shape that LOOKS like
// a Menu and is not one: picks written in the invoking state's SUBSTATES, which the derivation
// (own + ancestor handlers, per statechart semantics) cannot see. Retiring the `tools:` override
// (ADR-0057) left no way to say it by hand, so the kit says it here, at build.
test("picks written BELOW the invoking state are refused at build — the Menu cannot see them (ADR-0015/0057)", () => {
  const finish = defineEvent({ name: "finish", input: z.object({}) });
  const build = () =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [finish],
      actors: { coder: slot(new MockFlueClient()) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "active",
      states: {
        active: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
          initial: "working",
          states: { working: { on: { finish: "#wf.done" } } },
        },
        done: { type: "final" },
      },
    });

  assert.throws(build, (err: Error) => {
    assert.match(err.message, /agent "coder"/, "names the slot");
    assert.match(err.message, /active/, "names the state that holds the Turn");
    assert.match(err.message, /finish/, "names the pick the Menu could not see");
    assert.match(err.message, /ADR-0015/);
    return true;
  });
});

test("a Turn with no Menu at all still builds — nothing below it claims a pick (ADR-0015)", () => {
  const finish = defineEvent({ name: "finish", input: z.object({}) });
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [finish],
    actors: { coder: slot(new MockFlueClient()) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "active",
    states: {
      // The Agent writes and says nothing back; the TIMER moves the state, so the Turn ends when
      // the model stops and the actor lets it (no nudge, no fault).
      active: {
        invoke: { src: "coder", input: { prompt: "go", endpoint: "http://x" } },
        after: { 10: "done" },
      },
      done: { type: "final" },
    },
  });

  assert.equal(machine.id, "wf");
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

test("`continue: true` lands every state of one Machine on ONE conversation (ADR-0057)", async () => {
  const go = defineEvent({ name: "go", input: z.object({}) });
  const iidsFor = async (turn: { continue?: true }) => {
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
        a: { invoke: { src: "coder", input: { prompt: "one", ...turn, endpoint: "http://x" } }, on: { go: "b" } },
        b: { invoke: { src: "coder", input: { prompt: "two", ...turn, endpoint: "http://x" } } },
      },
    });
    const { actor } = hostless(machine);
    await tick();
    actor.send({ type: "go" });
    await tick();
    actor.stop();
    return mock.admits.map((a) => a.instanceId);
  };

  const continued = await iidsFor({ continue: true });
  assert.equal(continued.length, 2);
  // The id is STRUCTURAL — run, Machine instance, Agent — so the author writes a boolean and
  // never a key. Epoch 0 is not spelled (ADR-0057).
  assert.equal(continued[0], "run-1/root/coder", "structural: <runId>/<machine actor path>/<agent>");
  assert.equal(continued[0], continued[1], "one conversation, whichever state of the Machine asks");

  const fresh = await iidsFor({});
  assert.equal(fresh.length, 2);
  assert.notEqual(fresh[0], fresh[1], "the default is FRESH: every invocation is a new conversation");
});

test("`continue: true` is per MACHINE INSTANCE: two children of one Machine never share (ADR-0057)", async () => {
  // Fan-out is safe by construction: a Pool spawns each worker under the item's id (pool.ts), so
  // the packaged Machine never learns it is under a Pool and two workers' `continue` cannot meet.
  const mock = new MockFlueClient();
  const worker = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "worker",
    context: {},
    initial: "first",
    states: {
      first: {
        invoke: { src: "coder", input: { prompt: "one", continue: true, endpoint: "http://x" } },
        after: { 0: "second" },
      },
      // A SECOND state of the same Machine instance: same conversation, by saying `continue`.
      second: { invoke: { src: "coder", input: { prompt: "two", continue: true, endpoint: "http://x" } } },
    },
  });
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { worker },
  }).createMachine({
    id: "fanout",
    context: {},
    initial: "working",
    states: {
      working: {
        entry: [spawnChild("worker", { id: "F-1" }), spawnChild("worker", { id: "F-2" })],
      },
    },
  });

  const { actor } = hostless(machine);
  await tick();
  await tick();
  actor.stop();

  const iids = mock.admits.map((a) => a.instanceId);
  assert.deepEqual(
    [...new Set(iids)].sort(),
    ["run-1/F-1/coder", "run-1/F-2/coder"],
    "one conversation per Machine INSTANCE — the two states of each share, the two children do not",
  );
  assert.equal(iids.length, 4, "two states x two children");
});

test("a terminal fault burns the conversation: the next `continue` mints a virgin id (ADR-0057)", async () => {
  // No fault leaves a conversation worth continuing (ADR-0035), so jr2 keeps an EPOCH per
  // continued conversation in the ledger: the terminal `agent.fault` bumps it, and the next
  // `continue` on that Agent lands on `<id>/<epoch>` — a fresh conversation the author never named.
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: {
      // Re-briefing is the author's (ADR-0057): the fault route says the next prompt carries the
      // whole task again. The conversation it lands on is jr2's.
      a: {
        invoke: { src: "coder", input: { prompt: "one", continue: true, endpoint: "http://x" } },
        on: { "agent.fault": "b" },
      },
      b: { invoke: { src: "coder", input: { prompt: "re-briefed", continue: true, endpoint: "http://x" } } },
    },
  });

  const epochs: Record<string, number> = {};
  const { actor } = hostless(machine, {
    epochOf: (conversation) => epochs[conversation] ?? 0,
    bumpEpoch: (conversation) => (epochs[conversation] = (epochs[conversation] ?? 0) + 1),
  });
  await tick();
  assert.equal(mock.admits[0]?.instanceId, "run-1/root/coder");
  assert.equal(mock.admits[0]?.continuation, true, "and it is closed to the reroll (ADR-0035)");

  mock.fault("the harness went away");
  await tick();

  assert.deepEqual(epochs, { "run-1/root/coder": 1 }, "the terminal fault bumped the conversation's epoch");
  assert.equal(mock.admits[1]?.instanceId, "run-1/root/coder/1", "the next continue is a virgin conversation");
  actor.stop();
});

test("a FRESH turn's fault burns nothing — there is no conversation to continue (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "one", endpoint: "http://x" } } } },
  });

  const burned: string[] = [];
  const { actor } = hostless(machine, { bumpEpoch: (conversation) => burned.push(conversation) });
  await tick();
  assert.equal(mock.admits[0]?.continuation, undefined, "a fresh turn keeps its reroll (ADR-0035)");
  mock.fault("the harness went away");
  await tick();
  assert.deepEqual(burned, [], "every fresh invocation already mints its own conversation");
  actor.stop();
});

test("the minted id rides the child's PERSISTED input — what a restore re-spawns from", async () => {
  // Minting lives in the input mapper, not the actor (ADR-0016): restore re-spawns from the
  // persisted input WITHOUT re-running the mapper, so the conversation survives the restart.
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "one", continue: true, endpoint: "http://x" } } } },
  });

  const { actor } = hostless(machine);
  await tick();
  // The exact field a restore re-spawns the Agent from (run-host.ts `restore`), not a substring
  // of the blob: the child's persisted `input.instanceId`.
  const persisted = actor.getPersistedSnapshot() as unknown as {
    children: Record<string, { src: string; snapshot: { input?: { instanceId?: string } } }>;
  };
  const child = Object.values(persisted.children).find((c) => c.src === "coder");
  assert.equal(child?.snapshot.input?.instanceId, "run-1/root/coder");
  assert.equal(child?.snapshot.input?.instanceId, mock.admits[0]?.instanceId, "and it is the id that was admitted");
  actor.stop();
});

test("two PARALLEL states continuing one Agent are refused — one live surface per address", async () => {
  // ADR-0057 leans on the registration table: `continue: true` derives the SAME id for every
  // state of a Machine instance, so two states that run at once would otherwise both claim one
  // conversation. Sequential states never race (ADR-0024 ends a Turn with the state that asked
  // for it); parallel ones are a Machine that cannot be run, and it says so at the first Turn.
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    type: "parallel",
    states: {
      left: { invoke: { src: "coder", input: { prompt: "one", continue: true, endpoint: "http://x" } } },
      right: { invoke: { src: "coder", input: { prompt: "two", continue: true, endpoint: "http://x" } } },
    },
  });

  const { errors } = hostless(machine);
  assert.match(errors[0]?.message ?? "", /"agent\/run-1\/root\/coder" is already live/);
});

test("a key a Turn has no use for REFUSES the Turn, naming the surface (ADR-0057)", async () => {
  // A Turn's input is its Frame, its Dials and `continue` — and tsc cannot hold an author to
  // that: an invoke's input is a FUNCTION returning a union, and the conditional spreads inside
  // it defeat excess-property checking. So a misspelled `continue`, or a key from a surface
  // that never existed here, would compile, run, and silently get a fresh conversation every
  // Turn. `wrapAgentInput` is the one place that reads the authored input: it refuses at the
  // first Turn, before any pod is spent, and names the key and the whole surface.
  const stray: Array<[string, unknown, RegExp]> = [
    ["contine", true, /`contine`/],
    ["session", "continue", /`session`/],
    ["scope", "g0", /`scope`/],
    ["conversation", "coder", /`conversation`/],
    ["instanceId", "mine", /`instanceId`/],
  ];
  for (const [key, value, advice] of stray) {
    const mock = new MockFlueClient();
    const machine = jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [],
      actors: { coder: slot(mock) },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "a",
      states: {
        a: {
          invoke: {
            src: "coder",
            // A cast, because the authoring type has no such field — which is exactly the
            // Machine tsc lets through when the input is written as a function.
            input: { prompt: "one", endpoint: "http://x", [key]: value } as unknown as AgentTurnInput,
          },
        },
      },
    });

    // The refusal reaches the world the way ADR-0011's invoke-time manifest check does: the
    // invoke throws, the root errors, and RunHost's error subscription turns that into the run's
    // fault with this message.
    const { actor, errors } = hostless(machine);
    assert.equal(actor.getSnapshot().status, "error", `the run stopped on \`${key}\``);
    const message = errors[0]?.message ?? "";
    assert.ok(message.includes(`\`${key}\``), `names the key it found: ${key}`);
    assert.match(message, /ADR-0057/);
    assert.match(message, advice, `names the line to write instead of \`${key}\``);
    assert.match(message, /agent "coder"/, "names the slot");
    assert.deepEqual(mock.admits, [], `nothing was admitted for \`${key}\` — the refusal is before any pod`);
  }
});

test("jr2 mints every Instance ID — the Turn carries none to honor (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "one", endpoint: "http://x" } } } },
  });

  const { actor } = hostless(machine);
  await tick();
  assert.match(mock.admits[0]?.instanceId ?? "", /^run-1\/root\/coder\/[0-9a-f]{8}$/);
  actor.stop();
});

test("a `tools:` override is REFUSED — the Menu is what the state will accept (ADR-0029/0057)", async () => {
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
        // A hand-written Menu can only agree with the transitions or lie about them, and the
        // lie is a pick that moves nothing (ADR-0029).
        invoke: { src: "coder", input: { prompt: "go", tools: ["pong"], endpoint: "http://x" } },
        on: { ping: "b", pong: "b" },
      },
      b: {},
    },
  });
  const { actor, errors } = hostless(machine);
  await tick();
  assert.match(String((errors[0] as Error | undefined)?.message), /agent "coder": the Turn's input carries `tools`/);
  assert.deepEqual(mock.admits, [], "refused before anything is admitted");
  actor.stop();
});

test("the Frame's cwd rides the invoke input to the admission (ADR-0057)", async () => {
  const ping = defineEvent({ name: "ping", input: z.object({}) });
  const mock = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: Record<string, never> },
    events: [ping],
    actors: { coder: slot(mock) },
  }).createMachine({
    id: "wf",
    context: {},
    initial: "a",
    states: {
      a: {
        // What a state under a Workspace writes: `cwd: context.workspace.repos.target`.
        invoke: { src: "coder", input: { prompt: "go", cwd: "/work/target/feature", endpoint: "http://x" } },
        on: { ping: "b" },
      },
      b: {},
    },
  });
  const { actor } = hostless(machine);
  await tick();
  assert.equal(mock.admitted?.cwd, "/work/target/feature");
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
