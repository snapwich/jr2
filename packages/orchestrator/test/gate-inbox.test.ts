// The Gate inbox and the per-Gate `answer` scope (ADR-0011, ADR-0078). `GET /gates` lists the open
// Gates of every live run that the Caller may answer, oldest first, each with the time it opened,
// which a restore keeps. An `answer` item `{ workflow, gates }` opens only the Gates that it names,
// by their invoke id: the gate POST refuses another Gate with a 403 that names the scope, the
// Workflow and the Gate, and `GET /runs/:id` and `GET /gates` leave it out. `jr2 up` refuses a
// name that the Workflow's Machines do not have, or that two of its Machines have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createMachine, type AnyStateMachine } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { jr2Setup } from "../src/setup.ts";
import { joinScopes } from "../src/callers.ts";
import { gateScopeChecks } from "../src/assembly-checks.ts";
import type { JR2Config, Scopes } from "../src/config.ts";
import {
  callerMay,
  callerMayAnswer,
  callerTokenDigest,
  createAuthenticator,
  grantOpensGate,
  mintCallerToken,
  mintInstanceToken,
  type NamedToken,
} from "../src/tokens.ts";
import { approveDef, gatedDef, mkStore, waitFor } from "./_fixtures.ts";
import { chartedSrc, machineOf } from "./_assembly.ts";

const shipDef = defineEvent({ name: "ship_it", input: z.object({}) });

/** Two Gates in one run: `review` (its name is its state's key path, `review.open`) and `ship`
 * (an authored invoke id). Each takes its own event, so one answer moves one region. */
const releaseMachine = jr2Setup({
  types: {} as { context: { secret: string } },
  events: [approveDef, shipDef],
}).createMachine({
  id: "release",
  type: "parallel",
  context: { secret: "s3cret" },
  states: {
    review: {
      initial: "open",
      states: {
        open: {
          invoke: { src: "gate", input: { gate: "R-1", accepts: ["approve"], meta: { title: "review" } } },
          on: { approve: "done" },
        },
        done: {},
      },
    },
    ship: {
      initial: "open",
      states: {
        open: {
          invoke: { id: "ship", src: "gate", input: { gate: "S-1", accepts: ["ship_it"] } },
          on: { ship_it: "done" },
        },
        done: {},
      },
    },
  },
});

function releaseDef(): WorkflowDef {
  return { name: "release", machine: releaseMachine, provide: () => ({}) };
}

const KEY = Buffer.alloc(32, 9);
const INSTANCE = mintInstanceToken();

function named(name: string, may: Scopes): { value: string; entry: NamedToken } {
  const value = mintCallerToken();
  return { value, entry: { name, digest: callerTokenDigest(value), may } };
}

async function mkApp(tokens: NamedToken[], now?: () => number) {
  const store = await mkStore();
  const host = new RunHost({ store, ...(now ? { now } : {}) });
  host.register(releaseDef());
  host.register(gatedDef());
  const auth = createAuthenticator({
    instanceToken: INSTANCE,
    signingKey: KEY,
    publishToken: "publish-token",
    namedTokens: () => tokens,
  });
  return { store, host, app: createApp(host, auth) };
}

const get = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const post = (body: unknown, token: string): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

type Entry = { runId: string; workflow: string; gate: string; openedAt: string; [k: string]: unknown };
const inbox = async (app: Awaited<ReturnType<typeof mkApp>>["app"], token: string, query = ""): Promise<Entry[]> => {
  const res = await app.request(`/gates${query}`, get(token));
  assert.equal(res.status, 200);
  return ((await res.json()) as { gates: Entry[] }).gates;
};

test("an answer grant opens a Gate by its name: a bare Workflow name opens each Gate, an item the Gates it names", () => {
  const grant = ["gated", { workflow: "release", gates: ["ship"] }] as const;
  assert.ok(grantOpensGate(grant, "gated", "anything"));
  assert.ok(grantOpensGate(grant, "release", "ship"));
  assert.ok(!grantOpensGate(grant, "release", "review.open"));
  assert.ok(grantOpensGate("all", "release", "review.open"));
  // A wrapper's item opens the Gate in each of its named Charts (ADR-0070).
  assert.ok(grantOpensGate([{ workflow: "plan", gates: ["approve"] }], "plan/weekly", "approve"));
  assert.ok(!grantOpensGate([{ workflow: "plan/weekly", gates: ["approve"] }], "plan/daily", "approve"));
  const caller = { via: "token" as const, name: "rm", may: { answer: grant } };
  assert.ok(callerMay(caller, "answer", "release"), "some Gate of the Workflow opens the scope's routes");
  assert.ok(callerMayAnswer(caller, "release", "ship"));
  assert.ok(!callerMayAnswer(caller, "release", "review.open"));
});

test("joinScopes joins the per-Gate items of each group, each item once", () => {
  const joined = joinScopes([
    { answer: [{ workflow: "release", gates: ["ship"] }], read: ["release"] },
    { answer: ["gated", { workflow: "release", gates: ["ship"] }, { workflow: "release", gates: ["review.open"] }] },
  ]);
  assert.deepEqual(joined, {
    answer: [{ workflow: "release", gates: ["ship"] }, "gated", { workflow: "release", gates: ["review.open"] }],
    read: ["release"],
  });
  assert.deepEqual(joinScopes([{ answer: [{ workflow: "release", gates: ["ship"] }] }, { answer: "all" }]), {
    answer: "all",
  });
});

test("a Gate's openedAt is recorded when it opens, kept by a restore, and dropped when it closes", async () => {
  let clock = Date.parse("2026-11-05T10:00:00.000Z");
  const { store, host } = await mkApp([], () => clock);
  const { runId } = await host.start("release");
  await waitFor(() => host.gates(runId).length === 2);
  const opened = (h: RunHost) =>
    Object.fromEntries(h.gateInbox(() => true).map((e) => [e.gate, e.openedAt])) as Record<string, string>;
  assert.deepEqual(opened(host), { "R-1": "2026-11-05T10:00:00.000Z", "S-1": "2026-11-05T10:00:00.000Z" });
  let saved: string | undefined;
  await waitFor(() => {
    void store.load(runId).then((s) => (saved = s?.status));
    return saved === "live";
  });
  await host.stop(runId);

  // The restore is an hour later: the Gates register again, and keep the time they first opened.
  clock += 3_600_000;
  const second = new RunHost({ store, now: () => clock });
  second.register(releaseDef());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  await waitFor(() => second.gates(runId).length === 2);
  assert.deepEqual(opened(second), { "R-1": "2026-11-05T10:00:00.000Z", "S-1": "2026-11-05T10:00:00.000Z" });

  // A Gate that closes leaves the record.
  second.sendToGate(runId, "R-1", { type: "approve" });
  await waitFor(() => second.gates(runId).length === 1);
  assert.deepEqual(opened(second), { "S-1": "2026-11-05T10:00:00.000Z" });
});

test("GET /gates: the open Gates the Caller may answer, oldest first, with ?workflow, and never the context", async () => {
  let clock = Date.parse("2026-11-05T10:00:00.000Z");
  const ops = named("ops", { answer: "all" });
  const { app, host } = await mkApp([ops.entry], () => clock);
  const first = await host.start("release");
  clock += 60_000;
  const second = await host.start("gated");
  await waitFor(() => host.gates(first.runId).length === 2 && host.gates(second.runId).length === 1);

  const all = await inbox(app, ops.value);
  assert.deepEqual(
    all.map((e) => [e.workflow, e.gate, e.openedAt]),
    [
      ["release", "R-1", "2026-11-05T10:00:00.000Z"],
      ["release", "S-1", "2026-11-05T10:00:00.000Z"],
      ["gated", "F-1", "2026-11-05T10:01:00.000Z"],
    ],
  );
  const review = all[0]!;
  assert.equal(review.runId, first.runId);
  assert.ok(Array.isArray(review.path), "the Gate says where it is in the Machine");
  assert.deepEqual(review.acceptsNow, ["approve"]);
  assert.deepEqual(review.meta, { title: "review" });
  assert.equal((review.accepts as Array<{ name: string }>)[0]?.name, "approve");
  assert.equal(review.hook, undefined, "a Gate that hears no Hook names none");
  assert.ok(!JSON.stringify(all).includes("s3cret"), "no entry carries a run's context");

  assert.deepEqual(
    (await inbox(app, ops.value, "?workflow=gated")).map((e) => e.gate),
    ["F-1"],
  );
  assert.deepEqual(await inbox(app, ops.value, "?workflow=nothing"), []);
});

test("an answer item that names one Gate: GET /gates and GET /runs/:id list it alone, and the POST refuses the other", async () => {
  const shipper = named("shipper", { answer: [{ workflow: "release", gates: ["ship"] }] });
  const reviewer = named("reviewer", { answer: [{ workflow: "release", gates: ["review.open"] }], read: ["release"] });
  const outsider = named("outsider", { answer: ["gated"] });
  const { app, host } = await mkApp([shipper.entry, reviewer.entry, outsider.entry]);
  const { runId } = await host.start("release");
  await host.start("gated");
  await waitFor(() => host.gates(runId).length === 2);

  assert.deepEqual(
    (await inbox(app, shipper.value)).map((e) => e.gate),
    ["S-1"],
  );
  assert.deepEqual(
    (await inbox(app, reviewer.value)).map((e) => e.gate),
    ["R-1"],
  );
  assert.deepEqual(
    (await inbox(app, outsider.value)).map((e) => e.workflow),
    ["gated"],
  );

  const view = (await (await app.request(`/runs/${runId}`, get(shipper.value))).json()) as {
    gates: Array<{ gate: string }>;
    context?: unknown;
  };
  assert.deepEqual(
    view.gates.map((g) => g.gate),
    ["S-1"],
  );
  assert.equal(view.context, undefined);

  const refused = await app.request(`/runs/${runId}/gates/R-1/events`, post({ type: "approve" }, shipper.value));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: 'the Caller token/shipper needs the "answer" scope for Gate "review.open" of Workflow "release" (ADR-0078)',
    scope: "answer",
    workflow: "release",
    gate: "review.open",
  });
  assert.equal(host.gates(runId).length, 2, "the Gate did not move");
  // The 404 lists only the Gates that the Caller may answer.
  const missing = await app.request(`/runs/${runId}/gates/nope/events`, post({ type: "ship_it" }, shipper.value));
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { error: string }).error,
    `no open gate "nope" on run "${runId}" (open: S-1)`,
  );
  const outside = await app.request(`/runs/${runId}/gates/S-1/events`, post({ type: "ship_it" }, outsider.value));
  assert.equal(outside.status, 403);
  assert.equal(((await outside.json()) as { gate?: string }).gate, undefined, "no scope for the Workflow at all");

  const taken = await app.request(`/runs/${runId}/gates/S-1/events`, post({ type: "ship_it" }, shipper.value));
  assert.equal(taken.status, 200);
  await waitFor(() => host.gates(runId).length === 1);
  const byReviewer = await app.request(`/runs/${runId}/gates/R-1/events`, post({ type: "approve" }, reviewer.value));
  assert.equal(byReviewer.status, 200);
});

/** Two Gates one after the other: `review` (its name is `review`), then `ship` (an authored id). */
const seqMachine = jr2Setup({ types: {} as { context: object }, events: [approveDef, shipDef] }).createMachine({
  id: "seq",
  context: {},
  initial: "review",
  states: {
    review: { invoke: { src: "gate", input: { gate: "R-1", accepts: ["approve"] } }, on: { approve: "ship" } },
    ship: {
      invoke: { id: "ship", src: "gate", input: { gate: "S-1", accepts: ["ship_it"] } },
      on: { ship_it: "done" },
    },
    done: {},
  },
});

test("the gate POST checks the Gate that it delivers to, so a Gate that opens while the body is in flight is checked", async () => {
  const reviewer = named("reviewer", { answer: [{ workflow: "seq", gates: ["review"] }] });
  const { app, host } = await mkApp([reviewer.entry]);
  host.register({ name: "seq", machine: seqMachine, provide: () => ({}) });
  const { runId } = await host.start("seq");
  await waitFor(() => host.gates(runId).length === 1);

  // A POST to S-1, which is not open yet, whose body comes later.
  let send!: (text: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      send = (text) => {
        ctrl.enqueue(new TextEncoder().encode(text));
        ctrl.close();
      };
    },
  });
  const pending = app.request(`/runs/${runId}/gates/S-1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${reviewer.value}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  await new Promise((r) => setTimeout(r, 20));
  host.sendToGate(runId, "R-1", { type: "approve" });
  await waitFor(() => host.gates(runId).some((g) => g.gate === "S-1"));
  send(JSON.stringify({ type: "ship_it" }));

  const res = await pending;
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { gate: string }).gate, "ship");
  assert.deepEqual(
    host.gates(runId).map((g) => g.gate),
    ["S-1"],
    "the Gate did not move",
  );
});

test("GET /gates needs the answer scope; GET /whoami shows the per-Gate form", async () => {
  const reader = named("reader", { read: "all" });
  const shipper = named("shipper", { answer: [{ workflow: "release", gates: ["ship"] }] });
  const { app } = await mkApp([reader.entry, shipper.entry]);
  const refused = await app.request("/gates", get(reader.value));
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { scope: string }).scope, "answer");
  const who = (await (await app.request("/whoami", get(shipper.value))).json()) as { may: Scopes };
  assert.deepEqual(who.may, { answer: [{ workflow: "release", gates: ["ship"] }] });
});

// ---- jr2 up's check -------------------------------------------------------------------------------

/** A Machine that composes `child` and gates a state `approve` of its own. */
function composing(child: AnyStateMachine): AnyStateMachine {
  return jr2Setup({ types: {} as { context: object }, actors: { child }, events: [approveDef] }).createMachine({
    id: "outer",
    context: {},
    type: "parallel",
    states: {
      approve: { invoke: { src: "gate", input: { gate: "O-1", accepts: ["approve"] } }, on: { approve: {} } },
      inner: { invoke: { src: "child" } },
    },
  });
}

const innerMachine = jr2Setup({ types: {} as { context: object }, events: [approveDef] }).createMachine({
  id: "inner",
  context: {},
  initial: "approve",
  states: {
    approve: { invoke: { src: "gate", input: { gate: "I-1", accepts: ["approve"] } }, on: { approve: "done" } },
    done: {},
  },
});

const config = (answer: Scopes["answer"], groups?: Scopes["answer"]): JR2Config =>
  ({
    callers: {
      tokens: { rm: { may: { answer } } },
      ...(groups
        ? { issuers: [{ issuer: "https://dex.example.com", audience: "jr2", groups: { ops: { answer: groups } } }] }
        : {}),
    },
  }) as JR2Config;

test("jr2 up checks each per-Gate name against the Workflow's Machines", () => {
  const workflows = [
    { name: "release", machine: releaseMachine },
    { name: "outer", machine: composing(innerMachine) },
    { name: "plain", machine: createMachine({ id: "plain", initial: "a", states: { a: {} } }) },
  ];
  const ok = gateScopeChecks(workflows, config(["plain", { workflow: "release", gates: ["ship", "review.open"] }]));
  assert.deepEqual(ok, { errors: [], warnings: [] });

  const typo = gateScopeChecks(workflows, config([{ workflow: "release", gates: ["shipp"] }]));
  assert.equal(typo.errors.length, 1);
  assert.match(
    typo.errors[0]!,
    /^callers\.tokens\.rm\.may\.answer: Workflow "release" has no Gate "shipp" — a Gate's name is its invoke id.*its Gates are "review\.open", "ship"/,
  );

  const twice = gateScopeChecks(workflows, config(undefined, [{ workflow: "outer", gates: ["approve"] }]));
  assert.equal(twice.errors.length, 1);
  assert.match(
    twice.errors[0]!,
    /^callers\.issuers\.0\.groups\.ops\.answer: Gate "approve" of Workflow "outer" is in more than one Machine \(machine "outer", machine "inner"\)/,
  );

  const unknown = gateScopeChecks(workflows, config([{ workflow: "nope", gates: ["x"] }]));
  assert.match(unknown.errors[0]!, /names the Gates of a Workflow that this Assembly does not register/);

  const none = gateScopeChecks(workflows, config([{ workflow: "plain", gates: ["x"] }]));
  assert.match(none.errors[0]!, /Workflow "plain" has no Gate "x" .*it has no Gate/);

  // A bare name and "all" are not checked here: they name no Gate.
  assert.deepEqual(gateScopeChecks(workflows, config(["nope"])), { errors: [], warnings: [] });
});

test("jr2 up reads the Gates of a child Machine written inline on an invoke", () => {
  const signing = jr2Setup({ types: {} as { context: object }, events: [approveDef] }).createMachine({
    id: "signing",
    context: {},
    initial: "sign",
    states: {
      sign: { invoke: { src: "gate", input: { gate: "I-1", accepts: ["approve"] } }, on: { approve: "done" } },
      done: {},
    },
  });
  const inline = (child: AnyStateMachine): AnyStateMachine =>
    jr2Setup({ types: {} as { context: object }, events: [approveDef] }).createMachine({
      id: "outer",
      context: {},
      type: "parallel",
      states: {
        approve: { invoke: { src: "gate", input: { gate: "O-1", accepts: ["approve"] } }, on: { approve: {} } },
        inner: { invoke: { src: child } },
      },
    });
  const ok = gateScopeChecks(
    [{ name: "outer", machine: inline(signing) }],
    config([{ workflow: "outer", gates: ["sign", "approve"] }]),
  );
  assert.deepEqual(ok, { errors: [], warnings: [] });
  const twice = gateScopeChecks(
    [{ name: "outer", machine: inline(innerMachine) }],
    config([{ workflow: "outer", gates: ["approve"] }]),
  );
  assert.equal(twice.errors.length, 1);
  assert.match(
    twice.errors[0]!,
    /Gate "approve" of Workflow "outer" is in more than one Machine \(machine "outer", machine "inner"\)/,
  );
});

test("a Chart wrapper's per-Gate names: its Chart files are checked, and a runtime Chart's Gates are a warning", async () => {
  const workflows = [{ name: "charted", machine: await machineOf(chartedSrc({ gate: true })) }];
  const gated = {
    events: { go: { input: { type: "object" }, audience: "external" } },
    initial: "wait",
    states: { wait: { invoke: { src: "gate" }, on: { go: "over" } }, over: { type: "final" } },
  };
  const charts = [{ wrapper: "charted", name: "loop", path: "workflows/charted/loop.chart.json", text: gated }];
  const check = (answer: Scopes["answer"]) => gateScopeChecks(workflows, config(answer), charts);

  assert.deepEqual(check([{ workflow: "charted", gates: ["wait"] }]), { errors: [], warnings: [] });
  assert.deepEqual(check([{ workflow: "charted/loop", gates: ["wait"] }]), { errors: [], warnings: [] });
  const missing = check([{ workflow: "charted/loop", gates: ["nope"] }]);
  assert.match(missing.errors[0]!, /Workflow "charted\/loop" has no Gate "nope" .*its Gates are "wait"/);
  const maybe = check([{ workflow: "charted", gates: ["nope"] }]);
  assert.deepEqual(maybe.errors, []);
  assert.match(
    maybe.warnings[0]!,
    /has no Gate "nope" .*a runtime Chart of it may have one, which jr2 up cannot check$/,
  );
  // A Chart file that does not admit gets its own refusal from chartFileRefusals, and no second line.
  const broken = [{ wrapper: "charted", name: "loop", path: "workflows/charted/loop.chart.json", text: { states: 1 } }];
  assert.deepEqual(gateScopeChecks(workflows, config([{ workflow: "charted/loop", gates: ["nope"] }]), broken), {
    errors: [],
    warnings: [],
  });
  const runtime = check([{ workflow: "charted/weekly", gates: ["wait"] }]);
  assert.deepEqual(runtime.errors, []);
  assert.match(
    runtime.warnings[0]!,
    /names a Chart that is no Chart file of this Assembly; a runtime Chart's Gates cannot be checked/,
  );
});
