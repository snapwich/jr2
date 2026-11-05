// The hooked Gate (ADR-0011): `gate({ meta, delivers, hooks, look, reply })`, a Gate slot that a
// Machine puts in `actors` and invokes by its key. These tests hold its claims in one process: the
// meta is checked when the Gate opens; `delivers` reads as `audience: "external"` and the walk
// refuses one outside the Gate's accepted set; the registration carries the handlers for the Hook's
// door; and the look reads after the Gate registers, every `every`, after a restore, and stops once
// the run takes its event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { gate, isGateSlot, lookFault } from "../src/gate.ts";
import { agent } from "../src/harness-client.ts";
import { http } from "../src/http-effect.ts";
import { command } from "../src/harness-client.ts";
import { jr2Setup } from "../src/setup.ts";
import { customize } from "../src/customize.ts";
import { open } from "../src/open.ts";
import { RunHost, type RunFeedEvent, type RunStatus } from "../src/run-host.ts";
import { gateAddress, type RegistrationTable } from "../src/registration.ts";
import { seatsOf, vocabularyOf } from "../src/vocabulary.ts";
import { gateLookWarnings } from "../src/assembly-checks.ts";
import { partsOf } from "../src/parts.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const approve = defineEvent({ name: "approve", input: z.object({ by: z.string() }) });
const proposed = defineEvent({ name: "proposed", input: z.object({}) });

/** A fact the look reads: what a forge would answer for the PR, set by each test. */
type Fact = { state: string; reads: number; hold?: Promise<void> };

function lookedMachine(fact: Fact, every?: `${number}s`) {
  const review = gate({
    meta: z.object({ pr: z.string() }),
    delivers: [approve],
    hooks: {},
    look: {
      read: fromPromise(async ({ input }: { input: { pr: string } }) => {
        fact.reads++;
        await fact.hold;
        return { pr: input.pr, state: fact.state };
      }),
      input: (meta) => ({ pr: meta.pr }),
      ...(every ? { every } : {}),
      until: (out, meta) =>
        out.pr === meta.pr && out.state === "approved" ? { type: "approve", by: "look" } : undefined,
    },
  });
  return jr2Setup({
    types: {} as { context: { pr: string; by?: string }; input: { pr: string } },
    events: [approve],
    actors: { review },
  }).createMachine({
    id: "looked",
    context: ({ input }) => ({ pr: input?.pr ?? "https://forge/pr/1" }),
    initial: "inReview",
    states: {
      inReview: {
        invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr } }) },
        on: { approve: "merged" },
      },
      merged: { type: "final" },
    },
  });
}

/** The run's final status. */
const settled = (host: RunHost, runId: string): Promise<RunStatus> =>
  new Promise((resolve) => {
    const off = host.onSettled(runId, (status) => {
      off();
      resolve(status);
    });
  });

/** The host's registration table: what the Hook's door reads. */
const tableOf = (host: RunHost): RegistrationTable => (host as unknown as { table: RegistrationTable }).table;

const def = (machine: AnyStateMachine) => ({ name: "looked", machine, provide: () => ({}) });

test("gate is the factory of a Gate slot, not actor logic", () => {
  const slot = gate({ delivers: [approve], look: "none" });
  assert.ok(isGateSlot(slot));
  assert.equal(typeof gate, "function");
  assert.equal(
    (gate as unknown as { transition?: unknown }).transition,
    undefined,
    "the plain Gate is not on the surface",
  );
});

test("gate() refuses a spec it cannot run", () => {
  assert.throws(() => gate({ delivers: [] }), /delivers lists at least one event/);
  assert.throws(() => gate({ delivers: [approve, approve] }), /lists "approve" twice/);
  assert.throws(
    () => gate({ delivers: [approve], ...({ wake: true } as object) } as Parameters<typeof gate>[0]),
    /"wake" is not a part of a Gate slot/,
  );
  assert.throws(
    () => gate({ delivers: [approve], hooks: { github: { push: "nope" } } } as never),
    /hooks\.github\["push"\] is not a function/,
  );
  // A schema key with `*` types each key with its prefix; a handler names the full key (ADR-0011).
  assert.throws(
    () => gate({ delivers: [approve], hooks: { slack: { "block_actions.*": () => undefined } } } as never),
    /hooks\.slack\["block_actions\.\*"\] holds "\*".*name the full key, such as "block_actions\.approve" \(ADR-0011\)/,
  );
});

test("a look's read is an http Effect marked idempotent, or a promise: gate() refuses another", () => {
  const until = () => undefined;
  const input = () => ({});
  const plain = http({ method: "GET", url: "https://forge.example.com/api" });
  const idempotent = http({ method: "GET", url: "https://forge.example.com/api", idempotent: true });
  assert.match(lookFault({ read: plain, input, until }) ?? "", /not marked idempotent: true/);
  assert.equal(lookFault({ read: idempotent, input, until }), undefined);
  assert.match(lookFault({ read: command(["true"]), input, until }) ?? "", /a command Effect/);
  assert.equal(lookFault({ read: fromPromise(async () => 1), input, until }), undefined);
  assert.match(
    lookFault({ read: fromPromise(async () => 1), input, until, every: "soon" }) ?? "",
    /not a positive duration/,
  );
  assert.equal(lookFault("none"), undefined);
  assert.equal(lookFault(open), undefined);
  assert.throws(() => gate({ delivers: [approve], look: { read: plain, input, until } }), /gate\(\): its look reads/);
});

test("delivers reads as audience external: an Agent below the Gate does not have it on its Menu (ADR-0015)", () => {
  const coder = agent({ model: "stub/model", instructions: "x", workspace: "none" });
  const review = gate({ delivers: [approve], look: "none" });
  const machine = jr2Setup({
    types: {} as { context: { endpoint: string } },
    events: [approve, proposed],
    actors: { coder, review },
  }).createMachine({
    id: "m",
    context: { endpoint: "" },
    on: { "agent.fault": ".done", approve: ".done" },
    initial: "work",
    states: {
      work: { invoke: { src: "coder", input: { prompt: "p" } }, on: { proposed: "review" } },
      review: { invoke: { src: "review" } },
      done: { type: "final" },
    },
  });
  assert.equal(vocabularyOf(machine)?.get("approve")?.audience, "external");
  assert.equal(
    vocabularyOf(machine)?.get("proposed")?.audience,
    undefined,
    "an event in no delivers keeps its audience",
  );
  const seats = seatsOf(machine);
  assert.deepEqual(seats.find((s) => s.party === "agent")?.names, ["proposed"], "the root's approve is the Gate's");
  assert.deepEqual(seats.find((s) => s.party === "gate")?.names, ["approve"]);
});

test("an explicit audience in delivers stays, and the walk refuses an event its Gate does not accept", () => {
  const agentOnly = defineEvent({ name: "agentOnly", input: z.object({}), audience: "agent" });
  const review = gate({ delivers: [agentOnly], look: "none" });
  assert.throws(
    () =>
      jr2Setup({ events: [agentOnly], actors: { review } }).createMachine({
        id: "m",
        initial: "a",
        states: { a: { invoke: { src: "review" }, on: { agentOnly: "b" } }, b: {} },
      }),
    /invokes Gate slot "review", which delivers "agentOnly", and its Gate does not accept it/,
  );
  const elsewhere = gate({ delivers: [approve], look: "none" });
  assert.throws(
    () =>
      jr2Setup({ events: [approve, proposed], actors: { elsewhere } }).createMachine({
        id: "m",
        initial: "a",
        states: { a: { invoke: { src: "elsewhere" }, on: { proposed: "b" } }, b: { on: { approve: "a" } } },
      }),
    /delivers "approve", and its Gate does not accept it \(accepts: proposed\)/,
  );
  assert.throws(
    () =>
      jr2Setup({ events: [proposed], actors: { review: gate({ delivers: [approve], look: "none" }) } }).createMachine({
        id: "m",
        initial: "a",
        states: { a: { invoke: { src: "review" }, on: { proposed: "b" } }, b: {} },
      }),
    /Gate slot "review" delivers "approve", which no def in jr2Setup\(\{ events \}\) declares/,
  );
});

test("the Gate checks its meta when it opens, and its registration carries the handlers for the door", async () => {
  const handler = () => undefined;
  const review = gate({
    meta: z.object({ pr: z.string() }),
    delivers: [approve],
    hooks: { github: { "pull_request_review.submitted": handler } } as never,
    look: "none",
  });
  const machine = jr2Setup({
    types: {} as { context: { pr: unknown } },
    events: [approve],
    actors: { review },
  }).createMachine({
    id: "metaed",
    context: ({ input }) => ({ pr: (input as { pr: unknown }).pr }),
    initial: "inReview",
    states: {
      inReview: {
        invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr as string } }) },
        on: { approve: "merged" },
        // A refused meta is the invoke's error: the run does not wait on a Gate whose handlers would
        // read a meta of the wrong shape.
      },
      merged: { type: "final" },
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "metaed", machine, provide: () => ({}) });
  const good = await host.start("metaed", { pr: "https://forge/pr/1" });
  const [open1] = host.gates(good.runId);
  assert.equal(open1?.gate, "inReview");
  const reg = tableOf(host).lookup(gateAddress(good.runId, "inReview"));
  assert.equal(reg?.hooked?.hooks.github?.["pull_request_review.submitted"], handler);
  assert.deepEqual(reg?.hooked?.delivers, ["approve"]);

  const bad = await host.start("metaed", { pr: 7 });
  const badEnd = await settled(host, bad.runId);
  assert.equal(badEnd.status, "error");
  assert.deepEqual(host.gates(bad.runId), []);
  await host.close();
});

test("the look reads after the Gate registers: a fact that is already there moves the run, marked looked", async () => {
  let release!: () => void;
  const fact: Fact = { state: "approved", reads: 0, hold: new Promise<void>((r) => (release = r)) };
  const host = new RunHost({ store: await mkStore() });
  host.register(def(lookedMachine(fact)));
  const { runId } = await host.start("looked", { pr: "https://forge/pr/1" });
  const feed: RunFeedEvent[] = [];
  const off = host.subscribe(runId, (e) => feed.push(e));
  await waitFor(() => fact.reads === 1);
  release();
  const done = await settled(host, runId);
  off();
  assert.equal(done.status, "done");
  assert.deepEqual(
    feed.filter((e) => e.kind === "looked"),
    [{ kind: "looked", gate: "inReview", event: "approve" }],
  );
  // A looked event has no Caller: the run records no answer for it.
  assert.deepEqual(done.answers ?? [], []);
  await host.close();
});

test("the look reads again every `every` while the fact is not there, and stops once the run takes its event", async () => {
  const fact: Fact = { state: "pending", reads: 0 };
  const host = new RunHost({ store: await mkStore() });
  host.register(def(lookedMachine(fact, "0.02s")));
  const { runId } = await host.start("looked", { pr: "https://forge/pr/1" });
  await waitFor(() => fact.reads >= 3);
  assert.equal(host.status(runId)?.value, "inReview");
  fact.state = "approved";
  const done = await settled(host, runId);
  assert.equal(done.status, "done");
  const reads = fact.reads;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fact.reads, reads, "no read after the run took its event");
  await host.close();
});

test("a restore looks again: a fact that came while the Orchestrator was down reaches the Gate", async () => {
  const store = await mkStore();
  const fact: Fact = { state: "pending", reads: 0 };
  const first = new RunHost({ store });
  first.register(def(lookedMachine(fact, "1h" as `${number}s`)));
  const { runId } = await first.start("looked", { pr: "https://forge/pr/1" });
  await waitFor(() => fact.reads === 1);
  await first.close();
  fact.state = "approved";
  const second = new RunHost({ store });
  second.register(def(lookedMachine(fact, "1h" as `${number}s`)));
  assert.deepEqual((await second.restore()).reattached, [runId]);
  const done = await settled(second, runId);
  assert.equal(done.status, "done");
  assert.equal(fact.reads, 2);
  await second.close();
});

test("a look's event that the run does not take now is read again, and never faults the run", async () => {
  const fact: Fact = { state: "approved", reads: 0 };
  const review = gate({
    delivers: [approve],
    look: {
      read: fromPromise(async () => {
        fact.reads++;
        return fact.state;
      }),
      input: () => ({}),
      every: "0.02s",
      until: (s) => (s === "approved" ? { type: "approve", by: "look" } : undefined),
    },
  });
  const machine = jr2Setup({
    types: {} as { context: { open: boolean } },
    events: [approve],
    actors: { review },
  }).createMachine({
    id: "guarded",
    context: { open: false },
    initial: "inReview",
    states: {
      inReview: {
        invoke: { src: "review" },
        on: { approve: { guard: ({ context }) => context.open, target: "merged" } },
      },
      merged: { type: "final" },
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "guarded", machine, provide: () => ({}) });
  const { runId } = await host.start("guarded");
  await waitFor(() => fact.reads >= 3);
  assert.equal(host.status(runId)?.status, "active");
  assert.equal(host.status(runId)?.value, "inReview");
  await host.close();
});

test("customize() binds an Open look and patches the handlers by kind and event key (ADR-0054)", () => {
  const a = () => undefined;
  const b = () => undefined;
  const review = gate({
    delivers: [approve],
    hooks: { github: { "pull_request_review.submitted": a }, gitlab: { "note.MergeRequest": a } } as never,
    look: open,
  });
  const packaged = jr2Setup({ events: [approve], actors: { review } }).createMachine({
    id: "pkg",
    initial: "inReview",
    states: { inReview: { invoke: { src: "review" }, on: { approve: "done" } }, done: { type: "final" } },
  });
  assert.deepEqual(gateLookWarnings([{ name: "pkg", machine: packaged }]), [
    'workflow "pkg": Gate slot "review" on "pkg.inReview" leaves its look open — a delivery lost in an outage stops the ' +
      "run until a person answers the Gate: bind it with customize(machine, { gates: { review: { look } } }), or " +
      'give it look: "none" (ADR-0011, ADR-0054)',
  ]);
  const look = { read: fromPromise(async () => "x"), input: () => ({}), until: () => undefined };
  const bound = customize(packaged, {
    gates: {
      review: { look, hooks: { gitlab: { "note.MergeRequest": null }, slack: { "block_actions.approve": b } } },
    },
  } as never);
  const slot = (bound.implementations.actors as Record<string, unknown>).review;
  assert.ok(isGateSlot(slot));
  assert.equal(slot.gateSlot.look, look);
  assert.equal(slot.gateSlot.hooks.github?.["pull_request_review.submitted"], a, "a handler not named stays");
  assert.equal(slot.gateSlot.hooks.gitlab, undefined, "null removes one, and an empty kind goes");
  assert.equal(slot.gateSlot.hooks.slack?.["block_actions.approve"], b);
  assert.deepEqual(gateLookWarnings([{ name: "pkg", machine: bound }]), []);
  // The import keeps its own parts.
  const own = (packaged.implementations.actors as Record<string, unknown>).review;
  assert.ok(isGateSlot(own) && own.gateSlot.look === open);
  assert.throws(
    () => customize(packaged, { gates: { nope: { look } } } as never),
    /carries no Gate slot "nope" — its Gate slots are: review/,
  );
  assert.throws(() => customize(packaged, { gates: { review: { look: open } } } as never), /look is bound once/);
});

test("jr2 up warns about a hooked Gate with no look and no after on its state", () => {
  const h = () => undefined;
  const noLook = gate({ delivers: [approve], hooks: { github: { push: h } } as never });
  const withAfter = gate({ delivers: [approve], hooks: { github: { push: h } } as never });
  const none = gate({ delivers: [approve], hooks: { github: { push: h } } as never, look: "none" });
  const machine = jr2Setup({ events: [approve], actors: { noLook, withAfter, none } }).createMachine({
    id: "w",
    initial: "a",
    states: {
      a: { invoke: { src: "noLook" }, on: { approve: "b" } },
      b: { invoke: { src: "withAfter" }, after: { 60000: "c" }, on: { approve: "c" } },
      c: { invoke: { src: "none" }, on: { approve: "d" } },
      d: { type: "final" },
    },
  });
  assert.deepEqual(gateLookWarnings([{ name: "w", machine }]), [
    'workflow "w": Gate slot "noLook" on "w.a" hears a Hook and has no look and no `after` on its state — a delivery ' +
      'lost in an outage stops the run until a person answers the Gate: give it a look, or look: "none" for a Gate ' +
      "that hears a command (ADR-0011)",
  ]);
});

test("a look's http read is an Effect that jr2 up places in the Instance Effector", () => {
  const read = http({ method: "GET", url: "https://forge.example.com/api", idempotent: true });
  const review = gate({ delivers: [approve], look: { read, input: () => ({}), until: () => undefined } });
  const machine = jr2Setup({ events: [approve], actors: { review } }).createMachine({
    id: "w",
    initial: "a",
    states: { a: { invoke: { src: "review" }, on: { approve: "b" } }, b: { type: "final" } },
  });
  const effects = partsOf([machine]).effects;
  assert.deepEqual(
    effects.map((e) => [e.name, e.kind]),
    [["review.look", "http"]],
  );
});
