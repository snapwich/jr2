// The `http` Effect (ADR-0068), through the real `jr2Setup` walk, the real `RunHost`, and the real
// signed client against an in-process fake Effector: the request the definition builds, the
// write-ahead intent row, D1 on state exit (no cancel route: polling stops), and the restore rule —
// ask every replica, follow the one that holds it, send again only an idempotent call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { dropSavedTails, type EffectRow } from "../src/effect.ts";
import { createEffectorClient, MAX_START_BYTES, type HttpOutput } from "../src/effector-wire.ts";
import { bearer, httpParts, httpWith, secret, text, type HttpDefinition } from "../src/http-effect.ts";
import { partsOf } from "../src/parts.ts";
import { RunHost, type RunFeedEvent } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { agentActorWith } from "../src/actor.ts";
import { fromPick } from "../src/pick.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({ key: z.string(), body: z.string() }) });
const leave = defineEvent({ name: "leave", input: z.object({}) });

type Ctx = { key?: string; body?: string; result?: HttpOutput; fault?: string };

const commentDef = (extra: Partial<HttpDefinition<z.ZodObject<{ key: z.ZodString; body: z.ZodString }>>> = {}) => ({
  method: "POST" as const,
  url: "https://jira.example.com/rest/api/2/issue",
  auth: bearer(secret("jira")),
  input: z.object({ key: z.string(), body: z.string() }),
  request: ({ key, body }: { key: string; body: string }) => ({ path: [key, "comment"], json: { body } }),
  ...extra,
});

function machineWith(fake: FakeEffector, extra: Parameters<typeof commentDef>[0] = {}) {
  const comment = httpWith(
    (target) => createEffectorClient({ key: target.key, transport: fake.transport }),
    commentDef(extra),
  );
  return jr2Setup({ types: {} as { context: Ctx }, events: [go, leave], actors: { comment } }).createMachine({
    id: "wf",
    context: {},
    initial: "waiting",
    states: {
      waiting: {
        invoke: { src: "gate", id: "start" },
        on: {
          go: {
            target: "calling",
            actions: assign({ key: ({ event }) => event.key, body: ({ event }) => event.body }),
          },
        },
      },
      calling: {
        invoke: [
          {
            src: "comment",
            input: ({ context }) => ({ key: context.key!, body: context.body! }),
            onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
            onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
          },
          { src: "gate", id: "ctl" },
        ],
        on: { leave: "left" },
      },
      done: {},
      left: {},
      faulted: {},
    },
  });
}

const effector = { effector: () => ({ placement: "instance" as const, service: "svc:8082", key: EFFECTOR_KEY }) };

type Rig = { host: RunHost; store: SnapshotStore; runId: string; feed: RunFeedEvent[] };

async function started(
  fake: FakeEffector,
  extra: Parameters<typeof commentDef>[0] = {},
  store?: SnapshotStore,
): Promise<Rig> {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s, ...effector });
  host.register({ name: "fx", machine: machineWith(fake, extra), provide: () => ({}) });
  const { runId } = await host.start("fx");
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (ev) => feed.push(ev));
  host.sendToGate(runId, "start", { type: "go", key: "PROJ-7", body: "Tests pass." });
  return { host, store: s, runId, feed };
}

async function restored(rig: Rig, fake: FakeEffector, extra: Parameters<typeof commentDef>[0] = {}): Promise<RunHost> {
  const host = new RunHost({ store: rig.store, ...effector });
  host.register({ name: "fx", machine: machineWith(fake, extra), provide: () => ({}) });
  await host.restore();
  return host;
}

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};
const response: HttpOutput = {
  outcome: "response",
  status: 201,
  headers: {},
  contentType: "application/json",
  size: 2,
  body: "{}",
};

test("an http Effect: the definition and the input build the request; the Effector's output is the Machine's", async () => {
  const fake = new FakeEffector();
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  assert.deepEqual(fake.starts[0]!.req, {
    kind: "http",
    method: "POST",
    url: [{ text: "https://jira.example.com/rest/api/2/issue" }],
    path: ["PROJ-7", "comment"],
    auth: { bearer: { secret: "jira" } },
    body: { json: { body: "Tests pass." } },
    timeoutMs: 30_000,
    maxBody: 65_536,
  });
  const rows = Object.values(await ledger(rig.store, rig.runId));
  assert.deepEqual(
    rows.map((r) => [r.state, r.kind, (r as { placement?: string }).placement]),
    [["intent", "http", "instance"]],
    "write-ahead: the intent row, with no replica, is on disk before the call",
  );
  fake.settle(response);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  assert.deepEqual((rig.host.status(rig.runId)?.context as Ctx).result, response);
  const marker = rig.feed.find((e) => e.kind === "effect" && e.stage === "started") as { text: string };
  assert.equal(marker.text, "POST https://jira.example.com", "the feed names the method and host, never the path");
});

test("a saved http row keeps the outcome, status, type and size; its body and headers are a tail, dropped once its transition is saved", () => {
  const body = "x".repeat(50_000);
  const full: HttpOutput = { ...response, headers: { "x-echo": "a" }, body, truncated: true };
  const effects: Record<string, EffectRow> = {
    done: { state: "settled", kind: "http", slot: "comment", output: full, at: "t" },
    running: { state: "settled", kind: "http", slot: "comment", output: full, at: "t" },
    refused: { state: "settled", kind: "http", slot: "comment", output: { outcome: "refused", reason: "r" }, at: "t" },
  };
  // `running` is still held running by the saved snapshot: a restore may yet deliver its output.
  dropSavedTails(effects, { children: { c: { snapshot: { effectId: "running", status: "active" } } } });
  assert.deepEqual((effects.done as { output: unknown }).output, {
    outcome: "response",
    status: 201,
    contentType: "application/json",
    size: 2,
    truncated: true,
  });
  assert.deepEqual((effects.running as { output: unknown }).output, full);
  assert.deepEqual((effects.refused as { output: unknown }).output, { outcome: "refused", reason: "r" });
});

test("a start over the bytes an Effector reads is output `refused`: nothing is sent and no intent row is written", async () => {
  const fake = new FakeEffector();
  const rig = await started(fake, {
    request: ({ key, body }) => ({ path: [key], text: body + "y".repeat(MAX_START_BYTES) }),
  });
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  const result = (rig.host.status(rig.runId)?.context as Ctx).result;
  assert.equal(result?.outcome, "refused");
  assert.match((result as { reason: string }).reason, /over the 4194304 bytes an Effector reads; nothing was sent/);
  assert.equal(fake.calls.length, 0, "nothing reached the Effector");
  assert.deepEqual(
    Object.values(await ledger(rig.store, rig.runId)).map((r) => r.state),
    ["settled"],
  );
});

test("D1: its state exits while it runs — polling stops, the ledger and the feed say `outcome unknown`, no cancel is sent", async () => {
  const fake = new FakeEffector();
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  rig.host.sendToGate(rig.runId, "ctl", { type: "leave" });
  await waitFor(() => rig.host.status(rig.runId)?.value === "left");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    Object.values(await ledger(rig.store, rig.runId)).map((r) => r.state),
    ["aborted"],
    "the abort is saved with the transition that exited the state",
  );
  const aborted = rig.feed.find((e) => e.kind === "effect" && e.stage === "aborted") as { text: string };
  assert.match(aborted.text, /may still send it; outcome unknown/);
  const calls = fake.calls.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fake.calls.length, calls, "nobody polls it any more");
  assert.ok(
    fake.calls.every((c) => c.method === "POST" || c.method === "GET"),
    "no cancel route exists",
  );
});

test("restore: the replica that holds it is found by asking every replica, and followed — one send", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  await rig.host.stop(rig.runId);
  const host = await restored(rig, fake);
  await waitFor(() => fake.calls.filter((c) => c.method === "GET").length >= 2);
  fake.settle(response);
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(fake.starts.length, 1, "sent once, across the restart");
  assert.deepEqual((host.status(rig.runId)?.context as Ctx).result, response);
});

test("restore when no replica holds it: `unknown`, never sent again — unless the author marked it idempotent", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  await rig.host.stop(rig.runId);
  fake.restart(fake.starts[0]!.replica);
  const host = await restored(rig, fake);
  await waitFor(() => host.status(rig.runId)?.value === "done");
  const result = (host.status(rig.runId)?.context as Ctx).result;
  assert.equal(result?.outcome, "unknown");
  assert.match((result as { reason: string }).reason, /no Effector replica holds it; not sent again/);
  assert.equal(fake.starts.length, 1);

  const twice = new FakeEffector(["a", "b"]);
  const rig2 = await started(twice, { idempotent: true });
  await waitFor(() => twice.starts.length === 1);
  await rig2.host.stop(rig2.runId);
  twice.restart(twice.starts[0]!.replica);
  const host2 = await restored(rig2, twice, { idempotent: true });
  await waitFor(() => twice.starts.length === 2);
  assert.equal(twice.starts[1]!.id, twice.starts[0]!.id, "sent again under the same id");
  twice.settle(response);
  await waitFor(() => host2.status(rig2.runId)?.value === "done");
});

test("a start whose answer was lost: every replica is asked, and the one that took it is followed — one send", async () => {
  const fake = new FakeEffector(["a", "b"]);
  fake.loseNextAnswer = true;
  const rig = await started(fake);
  await waitFor(() => fake.calls.filter((c) => c.method === "GET").length >= 2);
  fake.settle(response);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  assert.equal(fake.starts.length, 1);
});

test("a start no replica could take (every connection refused) is sent again until one does", async () => {
  const fake = new FakeEffector(["a"]);
  fake.replica("a").down = true;
  const rig = await started(fake);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.starts.length, 0);
  fake.replica("a").down = false;
  await waitFor(() => fake.starts.length === 1);
  fake.settle(response);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
});

test("the replica that held it restarted while it was followed: not sent again, `unknown`", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  fake.restart(fake.starts[0]!.replica);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  assert.match(
    ((rig.host.status(rig.runId)?.context as Ctx).result as { reason: string }).reason,
    /no longer knows it/,
  );
  assert.equal(fake.starts.length, 1);
});

test("an Effector whose key is not the Orchestrator's: every answer is forged, so the call settles `unknown` — never a wait without end, idempotent or not", async () => {
  for (const idempotent of [false, true]) {
    const fake = new FakeEffector(["a", "b"], "a-key-the-orchestrator-does-not-derive");
    const rig = await started(fake, { idempotent });
    await waitFor(() => rig.host.status(rig.runId)?.value === "done");
    const result = (rig.host.status(rig.runId)?.context as Ctx).result as { outcome: string; reason: string };
    assert.equal(result.outcome, "unknown", `idempotent: ${idempotent}`);
    assert.match(result.reason, /does not carry the Effector's signature/);
    assert.match(result.reason, /not sent again/);
    assert.equal(fake.starts.length, 0, "the Effector verified nothing, so it started nothing");
    const settled = rig.feed.find((e) => e.kind === "effect" && e.stage === "settled") as
      | { output: { outcome: string } }
      | undefined;
    assert.equal(settled?.output.outcome, "unknown", "the feed says how it ended");
    const rows = Object.values(await ledger(rig.store, rig.runId));
    assert.deepEqual(
      rows.map((r) => r.state),
      ["settled"],
    );
  }
});

test("a forged answer to a poll is a replica gone: every replica is asked, and the one that holds it is followed", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  fake.forgePolls = 1;
  await waitFor(() => fake.forgePolls === 0);
  fake.settle(response);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  assert.deepEqual((rig.host.status(rig.runId)?.context as Ctx).result, response);
  assert.equal(fake.starts.length, 1);
});

test("a signed answer that is not the wire's shape is a jr2 defect: an error, never output, never retried", async () => {
  const fake = new FakeEffector();
  fake.malformed = true;
  const rig = await started(fake);
  await waitFor(() => rig.host.status(rig.runId)?.value === "faulted");
  assert.match((rig.host.status(rig.runId)?.context as Ctx).fault!, /is not the wire's shape/);
  assert.equal(fake.calls.length, 1, "one start, and nothing after it");
});

test("an Orchestrator with no Effector, and an input that misses the schema: an error, never output, nothing sent", async () => {
  const fake = new FakeEffector();
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "fx", machine: machineWith(fake), provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go", key: "K", body: "b" });
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match((host.status(runId)?.context as Ctx).fault!, /knows none/);
  assert.equal(fake.calls.length, 0);
});

test("the definition is plain data jr2 up reads: kind, placement, fixed host, secret names, input keys", () => {
  const fake = new FakeEffector();
  const { effects } = partsOf([machineWith(fake)]);
  assert.deepEqual(effects, [
    {
      name: "comment",
      path: [],
      route: [],
      kind: "http",
      placement: "instance",
      method: "POST",
      target: { scheme: "https", host: "jira.example.com", port: 443 },
      secrets: ["jira"],
      idempotent: false,
      timeoutMs: 30_000,
    },
  ]);
  assert.deepEqual(httpParts(commentDef()).inputKeys, ["key", "body"]);
});

test("the definition refuses a host that is not literal, a framing header, and a bad secret name", () => {
  assert.throws(
    () => httpParts({ method: "GET", url: text`https://${secret("host")}/x` }),
    /scheme and host are literal/,
  );
  assert.throws(
    () => httpParts({ method: "GET", url: text`https://api.example.com${secret("tg")}` }),
    /only in its path/,
  );
  assert.doesNotThrow(() => httpParts({ method: "GET", url: text`https://api.example.com/bot${secret("tg")}/send` }));
  // A secret sits only in the path: the Effector encodes it as a path segment, which a query or a
  // fragment would read as a different value.
  for (const url of [
    text`https://api.example.com/x?key=${secret("qkey")}`,
    text`https://api.example.com?k=${secret("qkey")}`,
    text`https://api.example.com/x#${secret("qkey")}`,
  ]) {
    assert.throws(() => httpParts({ method: "GET", url }), /secret\("qkey"\) sits in the url's query or fragment/);
  }
  assert.doesNotThrow(() => httpParts({ method: "GET", url: text`https://api.example.com/bot${secret("tg")}/x?a=1` }));
  assert.throws(() => httpParts({ method: "GET", url: "ftp://x.example.com/" }), /http:\/\/ or https:\/\//);
  assert.throws(() => httpParts({ method: "GET", url: "https://u:p@x.example.com/" }), /userinfo/);
  assert.throws(() => httpParts({ method: "GET", url: "https://x.example.com/", headers: { host: "y" } }), /frame or/);
  assert.throws(
    () => httpParts({ method: "GET", url: "https://x.example.com/", headers: { Accept: "y" } }),
    /lowercase/,
  );
  assert.throws(() => secret("../etc"), /secret's name/);
  assert.throws(() => httpParts({ method: "TRACE" as "GET", url: "https://x.example.com/" }), /method/);
  const parts = httpParts({
    method: "GET",
    url: text`https://api.example.com:8443/bot${secret("tg")}/send`,
    headers: { "x-api-key": text`${secret("k")}` },
    auth: bearer(secret("tg")),
  });
  assert.deepEqual(parts.target, { scheme: "https", host: "api.example.com", port: 8443 });
  assert.deepEqual(parts.secrets, ["tg", "k"]);
});

test("fromPick into an http Effect: the pick's params fill its input by name; a param no key reads is refused", () => {
  const finish = defineEvent({ name: "finish", input: z.object({}) });
  const post = httpWith(() => {
    throw new Error("never run at load");
  }, commentDef());
  const build = (pick: ReturnType<typeof defineEvent<"comment_on_ticket", z.ZodObject<z.ZodRawShape>>>) =>
    jr2Setup({
      types: {} as { context: { ticket: string } },
      events: [pick, finish],
      actors: { coder: agentActorWith(() => new MockFlueClient(), coderDefinition), post },
    }).createMachine({
      on: { "agent.fault": {} },
      id: "wf",
      context: { ticket: "PROJ-7" },
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid" } },
          initial: "rest",
          states: {
            rest: {},
            comment_on_ticket: {
              invoke: {
                src: "post",
                input: fromPick(pick, ({ context }: { context: { ticket: string } }) => ({
                  key: context.ticket,
                })) as never,
                onDone: "rest",
              },
            },
          },
          on: { comment_on_ticket: ".comment_on_ticket", finish: "done" },
        },
        done: { type: "final" },
      },
    });
  const comment = defineEvent({ name: "comment_on_ticket", input: z.object({ body: z.string() }) });
  assert.deepEqual(loadWarningsOf(build(comment as never)), []);
  const wide = defineEvent({ name: "comment_on_ticket", input: z.object({ body: z.string(), cc: z.string() }) });
  assert.throws(() => build(wide as never), /"cc"/);
});

test("a pick that runs an http Effect is answered with the Effector's output as it came — each outcome the Agent reads", async () => {
  // What the model reads is `answerText` over this answer (the Harness's own test renders each
  // outcome); this pins that the run host hands the Effector's scrubbed output through whole.
  const comment = defineEvent({ name: "comment_on_ticket", input: z.object({ body: z.string() }) });
  const fake = new FakeEffector();
  const coder = new MockFlueClient();
  const post = httpWith((target) => createEffectorClient({ key: target.key, transport: fake.transport }), commentDef());
  const machine = jr2Setup({
    types: {} as { context: { ticket: string } },
    events: [comment],
    actors: { coder: agentActorWith(() => coder, coderDefinition), post },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "wf",
    context: { ticket: "PROJ-7" },
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid", continue: true } },
        initial: "rest",
        states: {
          rest: {},
          comment_on_ticket: {
            invoke: {
              src: "post",
              input: fromPick(comment, ({ context }: { context: { ticket: string } }) => ({
                key: context.ticket,
              })) as never,
            },
          },
        },
        on: { comment_on_ticket: ".comment_on_ticket" },
      },
    },
  });
  const host = new RunHost({ store: await mkStore(), ...effector });
  host.register({ name: "fx", machine, provide: () => ({}) });
  await host.start("fx");
  await waitFor(() => coder.admits.length === 1);
  const iid = coder.admits[0]!.instanceId;
  const outputs: HttpOutput[] = [
    {
      outcome: "response",
      status: 201,
      headers: { "x-echo-auth": "[secret:jira]" },
      contentType: "application/json",
      size: 2,
      body: "{}",
    },
    { outcome: "refused", reason: 'path segment 1 is "..", which a path may not hold; nothing was sent' },
    { outcome: "unreachable", reason: "dial tcp 10.0.0.9:443: connect: connection refused; nothing was sent" },
    { outcome: "unknown", reason: "the timeout passed; the request may have reached the host, and no answer came" },
  ];
  for (const [i, output] of outputs.entries()) {
    const pick = host.sendToAgent(iid, { type: "comment_on_ticket", body: `try ${i}` });
    assert.equal(pick.outstanding, true, "held while the Effect runs");
    await waitFor(() => fake.starts.length === i + 1);
    fake.settle(output);
    const answered = await host.awaitDelivery(iid, pick.deliveryId);
    assert.deepEqual(answered?.answer, { kind: "output", actor: "post", output }, output.outcome);
  }
});
