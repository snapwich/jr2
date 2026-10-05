// The audience rule (ADR-0015): a transition belongs to the party that its state, or the nearest
// state above it, invokes; root transitions belong to both; an explicit `audience` overrides by
// kind. Each case is a small Machine through the REAL `jr2Setup.createMachine` walk, read back as
// its seats (`seatsOf`) and, where it matters, driven through the real registration table — what
// `POST /runs/:id/gates/:gate/events` and `POST /agents/:iid/events` deliver through.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createActor, fromPromise, type AnyActorRef, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent, type EventDef } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { bindRun, RegistrationTable } from "../src/registration.ts";
import { jr2Setup } from "../src/setup.ts";
import { seatLine, seatsOf } from "../src/vocabulary.ts";
import { workspace } from "../src/workspace.ts";
import { coderDefinition, MockFlueClient, waitFor } from "./_fixtures.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ev = (name: string, audience?: "agent" | "external" | "any"): EventDef =>
  defineEvent({ name, input: z.object({}), ...(audience ? { audience } : {}) });
const sorted = (xs: Iterable<string>) => [...xs].sort();
const EP = "http://harness.invalid";
const slot = (m: MockFlueClient) => agentActorWith(() => m, coderDefinition);
/** Who may send what, per state, as `jr2 up` prints it. */
const seats = (m: AnyStateMachine) => seatsOf(m).map(seatLine);

/** Start a Machine hostless over one MockFlueClient per Agent slot. */
function probe(machine: AnyStateMachine, mocks: Record<string, MockFlueClient>) {
  const table = new RegistrationTable();
  let bound = false;
  const actor = createActor(machine, {
    inspect: (e) => {
      if (!bound && e.type === "@xstate.actor") {
        bound = true;
        bindRun((e.actorRef as AnyActorRef).system, { runId: "r", workflow: "wf", table });
      }
    },
  }).start();
  return {
    actor,
    /** The live Turn's derived set (what delivery validates against) for one slot. */
    tools: (slot: string) => sorted(mocks[slot]!.admits.at(-1)?.tools ?? []),
    gates: () =>
      table
        .byRun("r")
        .filter((g) => g.kind === "gate")
        .map((g) => ({ id: g.id, accepts: sorted(g.defs.keys()) })),
    /** Deliver as the Gate's caller would (`sendToGate` → `table.deliver`). */
    gateSend: (id: string, type: string) => {
      const g = table.byRun("r").find((x) => x.kind === "gate" && x.id === id)!;
      table.deliver(g.address, type, {});
    },
    agentSend: (slot: string, type: string) =>
      table.deliver(`agent/${mocks[slot]!.admits.at(-1)!.instanceId}`, type, {}),
    value: () => actor.getSnapshot().value,
  };
}

test("an in-Turn Gate's caller may send only the Gate's own events — never the Agent's pick", async () => {
  const [submit, approve, ask] = [ev("submit"), ev("approve"), ev("ask")];
  const coder = new MockFlueClient();
  const m = jr2Setup({ events: [submit, approve, ask], actors: { coder: slot(coder) } }).createMachine({
    id: "a",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { submit: "done" },
        initial: "coding",
        states: { coding: { on: { ask: "asking" } }, asking: { invoke: { src: "gate" }, on: { approve: "coding" } } },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), ["a.ticket agent:coder: [ask, submit]", "a.ticket.asking gate: [approve]"]);
  const p = probe(m, { coder });
  await waitFor(() => coder.admits.length === 1);
  assert.deepEqual(p.tools("coder"), ["ask", "submit"], "approve is the Gate's: the descent stops at the Gate child");
  p.agentSend("coder", "ask");
  await tick();
  assert.deepEqual(
    p.gates().map((g) => g.accepts),
    [["approve"]],
  );
  assert.throws(() => p.gateSend("ticket.asking", "submit"), /submit/, "the caller cannot send the Agent's pick");
  p.gateSend("ticket.asking", "approve");
  await tick();
  assert.deepEqual(p.value(), { ticket: "coding" });
  assert.equal(coder.admits.length, 1, "same Turn throughout");
  p.actor.stop();
});

test("`audience: \"any\"` gives the Agent's pick to an in-Turn Gate's caller too", async () => {
  const [submit, approve, ask] = [ev("submit", "any"), ev("approve"), ev("ask")];
  const coder = new MockFlueClient();
  const m = jr2Setup({ events: [submit, approve, ask], actors: { coder: slot(coder) } }).createMachine({
    id: "b",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { submit: "done" },
        initial: "coding",
        states: { coding: { on: { ask: "asking" } }, asking: { invoke: { src: "gate" }, on: { approve: "coding" } } },
      },
      done: { type: "final" },
    },
  });
  const p = probe(m, { coder });
  await waitFor(() => coder.admits.length === 1);
  p.agentSend("coder", "ask");
  await tick();
  assert.deepEqual(
    p.gates().map((g) => g.accepts),
    [["approve", "submit"]],
  );
  p.gateSend("ticket.asking", "submit");
  await tick();
  assert.equal(p.actor.getSnapshot().status, "done", "the caller submitted for the Agent");
  p.actor.stop();
});

test("a Gate on a PARENT state takes the writings beside it: the Agent below cannot send them", async () => {
  const [finish, abandon] = [ev("finish"), ev("abandon")];
  const coder = new MockFlueClient();
  const m = jr2Setup({ events: [finish, abandon], actors: { coder: slot(coder) } }).createMachine({
    id: "c",
    initial: "job",
    states: {
      job: {
        invoke: { src: "gate", id: "operator" },
        on: { abandon: "gaveUp" },
        initial: "working",
        states: {
          working: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "#c.done" } },
        },
      },
      gaveUp: { type: "final" },
      done: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), ["c.job gate: [abandon]", "c.job.working agent:coder: [finish]"]);
  const p = probe(m, { coder });
  await waitFor(() => coder.admits.length === 1);
  assert.deepEqual(p.tools("coder"), ["finish"]);
  p.gateSend("operator", "abandon");
  await tick();
  assert.deepEqual(p.value(), "gaveUp");
  p.actor.stop();
});

test('a root writing belongs to both parties; `audience: "agent"` holds it back from the Gate', () => {
  const build = (blocked: EventDef) =>
    jr2Setup({
      events: [blocked, ev("finish"), ev("approve"), ev("cancel")],
      actors: { coder: slot(new MockFlueClient()) },
    }).createMachine({
      id: "e",
      initial: "work",
      on: { report_blocked: ".blocked", cancel: ".blocked" },
      states: {
        work: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "review" } },
        review: { invoke: { src: "gate" }, on: { approve: "done" } },
        blocked: { type: "final" },
        done: { type: "final" },
      },
    });
  assert.deepEqual(seats(build(ev("report_blocked"))), [
    "e.work agent:coder: [cancel, finish, report_blocked]",
    "e.review gate: [approve, cancel, report_blocked]",
  ]);
  assert.deepEqual(seats(build(ev("report_blocked", "agent"))), [
    "e.work agent:coder: [cancel, finish, report_blocked]",
    "e.review gate: [approve, cancel]",
  ]);
});

test("a nested Agent does not get the outer Agent's picks", async () => {
  const [askReview, finish, verdict] = [ev("ask_review"), ev("finish"), ev("verdict")];
  const coder = new MockFlueClient();
  const reviewer = new MockFlueClient();
  const m = jr2Setup({
    events: [askReview, finish, verdict],
    actors: { coder: slot(coder), reviewer: slot(reviewer) },
  }).createMachine({
    id: "f",
    initial: "coding",
    states: {
      coding: {
        invoke: { src: "coder", input: { prompt: "code", endpoint: EP } },
        on: { ask_review: ".reviewing", finish: "done" },
        initial: "rest",
        states: {
          rest: {},
          reviewing: {
            invoke: { src: "reviewer", input: { prompt: "review", endpoint: EP } },
            on: { verdict: "rest" },
          },
        },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), [
    "f.coding agent:coder: [ask_review, finish]",
    "f.coding.reviewing agent:reviewer: [verdict]",
  ]);
  const p = probe(m, { coder, reviewer });
  await waitFor(() => coder.admits.length === 1);
  p.agentSend("coder", "ask_review");
  await waitFor(() => reviewer.admits.length === 1);
  assert.deepEqual(p.tools("reviewer"), ["verdict"]);
  assert.throws(() => p.agentSend("reviewer", "finish"), /finish/, "the reviewer cannot finish the coder's work");
  p.actor.stop();
});

test("a mode's writings are its Agent's, even below a Gate's sibling; a Gate's reach does not descend", () => {
  const [approve, comment, revise, submit, ask] = [ev("approve"), ev("comment"), ev("revise"), ev("submit"), ev("ask")];
  const m = jr2Setup({
    events: [approve, comment, revise, submit, ask],
    actors: { coder: slot(new MockFlueClient()) },
  }).createMachine({
    id: "g",
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { ask: "reviewing" } },
          reviewing: {
            on: { revise: "coding", submit: "#g.review" },
            initial: "approval",
            states: { approval: { invoke: { src: "gate" }, on: { approve: "decided" } }, decided: {} },
          },
        },
      },
      review: {
        invoke: { src: "gate" },
        on: { approve: "done" },
        initial: "drafting",
        states: { drafting: { on: { comment: "drafting" } } },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), [
    "g.ticket agent:coder: [ask, revise, submit]",
    "g.ticket.reviewing.approval gate: [approve]",
    "g.review gate: [approve]",
  ]);
});

test("a wrapper adds no owner: a body's seats are its own Machine's, wrapped or not", () => {
  const body = jr2Setup({
    events: [ev("cancel"), ev("finish"), ev("approve")],
    actors: { coder: slot(new MockFlueClient()) },
  }).createMachine({
    id: "body",
    initial: "work",
    on: { cancel: ".cancelled" },
    states: {
      work: { invoke: { src: "coder", input: { prompt: "p", endpoint: EP } }, on: { finish: "review" } },
      review: { invoke: { src: "gate" }, on: { approve: "done" } },
      cancelled: { type: "final" },
      done: { type: "final" },
    },
  });
  const before = seats(body);
  workspace(body as never, { repos: { app: { url: "https://example.invalid/app.git" } } } as never);
  assert.deepEqual(seats(body), before);
  assert.deepEqual(before, ["body.work agent:coder: [cancel, finish]", "body.review gate: [approve, cancel]"]);
});

test("an Agent state with a child that runs something and a Gate child: no audience written, no leak", async () => {
  const [deploy, finish, anyway, skip] = [ev("deploy_preview"), ev("finish"), ev("deploy_anyway"), ev("skip")];
  const coder = new MockFlueClient();
  const build = fromPromise(async () => ({ ok: false }));
  const m = jr2Setup({ events: [deploy, finish, anyway, skip], actors: { coder: slot(coder), build } }).createMachine({
    id: "i",
    initial: "working",
    states: {
      working: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { deploy_preview: ".building", finish: "done" },
        initial: "rest",
        states: {
          rest: {},
          building: {
            invoke: {
              src: "build",
              onDone: [{ guard: ({ event }) => event.output.ok, target: "rest" }, { target: "asking" }],
            },
          },
          asking: { invoke: { src: "gate" }, on: { deploy_anyway: "rest", skip: "rest" } },
        },
      },
      done: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), [
    "i.working agent:coder: [deploy_preview, finish]",
    "i.working.asking gate: [deploy_anyway, skip]",
  ]);
  const p = probe(m, { coder });
  await waitFor(() => coder.admits.length === 1);
  p.agentSend("coder", "deploy_preview");
  await waitFor(() => p.gates().length === 1);
  assert.throws(() => p.gateSend("working.asking", "finish"), /finish/);
  p.gateSend("working.asking", "skip");
  await tick();
  assert.deepEqual(p.value(), { working: "rest" });
  p.actor.stop();
});

test("one state that invokes an Agent AND a Gate: both share its writings", () => {
  const m = jr2Setup({
    events: [ev("finish"), ev("abandon")],
    actors: { coder: slot(new MockFlueClient()) },
  }).createMachine({
    id: "arr",
    initial: "w",
    states: {
      w: {
        invoke: [
          { src: "coder", input: { prompt: "p", endpoint: EP } },
          { src: "gate", id: "operator" },
        ],
        on: { finish: "d", abandon: "d" },
      },
      d: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), ["arr.w agent:coder: [abandon, finish]", "arr.w gate: [abandon, finish]"]);
});

test("audience says who may SEND, never which transition runs: the deepest active handler takes the event", async () => {
  const [stop, ask] = [ev("stop"), ev("ask")];
  const coder = new MockFlueClient();
  const m = jr2Setup({ events: [stop, ask], actors: { coder: slot(coder) } }).createMachine({
    id: "same",
    initial: "t",
    states: {
      t: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { stop: "agentStopped" },
        initial: "coding",
        states: { coding: { on: { ask: "asking" } }, asking: { invoke: { src: "gate" }, on: { stop: "coding" } } },
      },
      agentStopped: { type: "final" },
    },
  });
  assert.deepEqual(seats(m), ["same.t agent:coder: [ask, stop]", "same.t.asking gate: [stop]"]);
  const p = probe(m, { coder });
  await waitFor(() => coder.admits.length === 1);
  p.agentSend("coder", "ask");
  await tick();
  p.agentSend("coder", "stop");
  await tick();
  assert.deepEqual(p.value(), { t: "coding" }, "the Agent's `stop` ran the Gate state's transition");
  p.actor.stop();
});

test("an explicit audience is by kind over the reach: `external` on an Agent state's writing reaches its Gate child", () => {
  const m = jr2Setup({
    events: [ev("hand_over", "external"), ev("approve", "agent")],
    actors: { coder: slot(new MockFlueClient()) },
  }).createMachine({
    id: "x",
    initial: "t",
    states: {
      t: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: EP } },
        on: { hand_over: "d" },
        initial: "a",
        states: { a: { invoke: { src: "gate" }, on: { approve: "a" } } },
      },
      d: { type: "final" },
    },
  });
  // `approve: agent` written on the Gate's state reaches no one: the Gate may not take it, and the
  // Agent's descent stops at the Gate child.
  assert.deepEqual(seats(m), ["x.t agent:coder: []", "x.t.a gate: [hand_over]"]);
});
