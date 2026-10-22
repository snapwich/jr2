// The Sandbox Effector's kinds from the Orchestrator's side (ADR-0067): push, a file-body http and the
// credentialed command, driven through the real signed client against the in-process fake
// Effector (ADR-0010) — the start each builds from the Workspace's handles, the commit the intent
// row keeps, and the restore rule per kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import {
  commandWith,
  inputKeysOf,
  isEffect,
  placementOf,
  type EffectLogic,
  type EffectRow,
  type HttpParts,
} from "../src/effect.ts";
import {
  CommandOutputShape,
  createEffectorClient,
  MAX_START_BYTES,
  PushOutputShape,
  type CommandStartRequest,
  type PushStartRequest,
} from "../src/effector-wire.ts";
import { bearer, file, http, secret } from "../src/http-effect.ts";
import { partsOf } from "../src/parts.ts";
import { RunHost } from "../src/run-host.ts";
import { httpFileWith, pushParts, pushWith } from "../src/sandbox-effect.ts";
import { createSyncPort, type SyncPortFactory } from "../src/sync-client.ts";
import type { SyncAnswer, SyncRequest } from "../src/wire.ts";
import { sandboxEffectorSecret, sandboxEffectorContainer, sandboxEffectorVolumes } from "../src/sandbox-kube.ts";
import { sandboxEffectorService } from "../src/sandbox-effector.ts";
import { effectorTarget } from "../src/instance.ts";
import { effectorKey } from "../src/tokens.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { fakeWorkspace, handles, FakeHarnessExec } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffect = EffectLogic<any, unknown>;

/** Wait for an async condition (a ledger read), polling. */
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("the condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}
type Ctx = { result?: unknown; fault?: string };

const ws = () => ({
  ...handles({ app: "/work/app/jr2-run-1" }),
  bindings: { app: "https://github.com/ourorg/app.git" },
});

function machineOf(effect: AnyEffect, input: object = { path: "dist/report.pdf" }) {
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [go],
    actors: { ws: fakeWorkspace(ws()), effect },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "start" }, on: { go: "running" } },
      running: {
        invoke: {
          src: "effect",
          input: () => input as never,
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      done: {},
      faulted: {},
    },
  });
}

const target = { effector: () => ({ placement: "sandbox" as const, service: "ws-1:8082", key: EFFECTOR_KEY }) };
const port = (fake: FakeEffector) => () => createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });

async function started(effect: AnyEffect, store?: SnapshotStore, input?: object) {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s, ...target });
  host.register({ name: "fx", machine: machineOf(effect, input), provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  return { host, store: s, runId };
}

async function restored(store: SnapshotStore, effect: AnyEffect): Promise<RunHost> {
  const host = new RunHost({ store, ...target });
  host.register({ name: "fx", machine: machineOf(effect), provide: () => ({}) });
  await host.restore();
  return host;
}

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};

const pushed = (published: string) => ({
  outcome: "pushed",
  published,
  source: "a".repeat(40),
  via: "ancestry",
  newCommits: 1,
  bundle: "QlVORExF",
});

/** The Workspace's Harness sync, in-process: what each call asked, and the answer it gives. */
class FakeSync {
  readonly calls: Array<{ endpoint: string; bearer?: string; req: SyncRequest }> = [];
  answer: SyncAnswer = { sync: "synced", from: "a".repeat(40), to: "b".repeat(40), replayed: 0, tries: 1 };
  factory: SyncPortFactory = (endpoint, bearer) => ({
    sync: async (req) => {
      this.calls.push({ endpoint, ...(bearer ? { bearer } : {}), req });
      return this.answer;
    },
  });
}

test("a push: the start names the Workspace's repositories and Binding; the pinned commit goes to the intent row; the bundle never reaches the Machine", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const rig = await started(pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect);
  await waitFor(() => fake.starts.length === 1);
  const req = fake.starts[0]!.req as PushStartRequest;
  assert.equal(req.kind, "push");
  assert.deepEqual(req.push.repo, {
    gitDir: "app/default/.git",
    worktree: "app/jr2-run-1",
    cache: req.push.repo.cache,
  });
  assert.match(req.push.repo.cache, /^app-[0-9a-f]{8}$/);
  assert.equal(req.push.url, "https://github.com/ourorg/app.git");
  assert.equal(req.push.branch, "jr2/run-1");
  assert.equal(req.push.sign, true);
  assert.equal(req.push.pin, undefined, "the Effector reads the tip");
  await until(async () => Object.values(await ledger(rig.store, rig.runId)).some((r) => "pinned" in r));
  const row = Object.values(await ledger(rig.store, rig.runId))[0] as Extract<EffectRow, { placement: "sandbox" }>;
  assert.equal(row.pinned, fake.tip);
  assert.equal(row.sandbox, "ws-1");
  fake.settle(pushed("b".repeat(40)));
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  const result = (rig.host.status(rig.runId)?.context as Ctx).result as Record<string, unknown>;
  assert.equal(result.outcome, "pushed");
  assert.equal(result.published, "b".repeat(40));
  assert.equal("bundle" in result, false);
  // The sync ran in the Workspace's Harness, from the bundle the Effector wrote, and its answer is
  // a field beside the outcome.
  assert.equal(syncs.calls.length, 1);
  assert.deepEqual(syncs.calls[0]!.req, {
    worktree: "/work/app/jr2-run-1",
    branch: "jr2/run-1",
    published: "b".repeat(40),
    source: "a".repeat(40),
    bundle: "QlVORExF",
  });
  assert.equal(result.sync, "synced");
  assert.equal("syncReason" in result, false);
});

test("an unsigned push is sync `skipped`, and no sync is asked", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const rig = await started(pushWith(port(fake), {}, syncs.factory) as AnyEffect);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "pushed", published: "a".repeat(40), source: "a".repeat(40), newCommits: 1 });
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  const result = (rig.host.status(rig.runId)?.context as Ctx).result as Record<string, unknown>;
  assert.equal(result.sync, "skipped");
  assert.equal(syncs.calls.length, 0);
});

test("an unsigned squash published a commit that is not the Agent's own, and is synced as a signed push is (ADR-0067)", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const rig = await started(pushWith(port(fake), { squash: true }, syncs.factory) as AnyEffect, undefined, {
    message: "one commit",
  });
  await waitFor(() => fake.starts.length === 1);
  const req = fake.starts[0]!.req as PushStartRequest;
  assert.equal(req.push.sign, undefined);
  assert.equal(req.push.squash, "one commit");
  fake.settle({ ...pushed("c".repeat(40)), squashed: "unsigned" });
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  const result = (rig.host.status(rig.runId)?.context as Ctx).result as Record<string, unknown>;
  assert.equal(result.published, "c".repeat(40));
  assert.equal(result.squashed, "unsigned", "the output tells one squashed commit from signed copies");
  assert.equal(result.sync, "synced");
  assert.equal("bundle" in result, false);
  assert.equal(syncs.calls.length, 1, "the sync was sent: the decision keys on published != source, never on sign");
  assert.deepEqual(syncs.calls[0]!.req, {
    worktree: "/work/app/jr2-run-1",
    branch: "jr2/run-1",
    published: "c".repeat(40),
    source: "a".repeat(40),
    bundle: "QlVORExF",
  });
});

/** A Machine that pushes twice in one run, in one Workspace — three times with `third`. */
function twoPushes(effect: AnyEffect, third = false) {
  return jr2Setup({
    types: {} as { context: Ctx & { first?: unknown } },
    events: [go],
    actors: { ws: fakeWorkspace(ws()), effect },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "start" }, on: { go: "first" } },
      first: {
        invoke: {
          src: "effect",
          onDone: { target: third ? "between" : "second", actions: assign({ first: ({ event }) => event.output }) },
        },
      },
      between: { invoke: { src: "effect", onDone: "second" } },
      second: {
        invoke: { src: "effect", onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) } },
      },
      done: {},
    },
  });
}

test("the next push sends the ledger's pushes of its Workspace's Repo Slot as its pairs, and runs a sync that did not finish again first", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  syncs.answer = { sync: "busy", reason: "a rebase of your branch is in progress" };
  const host = new RunHost({ store: await mkStore(), ...target });
  host.register({
    name: "fx",
    machine: twoPushes(pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect),
    provide: () => ({}),
  });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  await waitFor(() => fake.starts.length === 1);
  assert.equal((fake.starts[0]!.req as PushStartRequest).push.pairs, undefined, "no push before it: omitted, never []");
  fake.settle(pushed("b".repeat(40)));
  // The first sync answered busy: before the second push it is run again, and the push carries
  // the first push's pair.
  await waitFor(() => fake.starts.length === 2);
  assert.equal(syncs.calls.length, 2);
  assert.equal(syncs.calls[1]!.req.published, "b".repeat(40));
  assert.equal(syncs.calls[1]!.req.source, "a".repeat(40));
  const second = fake.starts[1]!.req as PushStartRequest;
  assert.deepEqual(second.push.pairs, [{ published: "b".repeat(40), source: "a".repeat(40) }]);
  const first = (host.status(runId)?.context as { first?: Record<string, unknown> }).first!;
  assert.equal(first.sync, "busy");
  assert.equal(first.syncReason, "a rebase of your branch is in progress");
  syncs.answer = { sync: "already" };
  fake.settle({ ...pushed("c".repeat(40)), source: "d".repeat(40) });
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal(syncs.calls.length, 3, "a sync that answered `already` is not run again");
});

test("the pair carries the last push's `squashed`, so a push that maps its commit names what that commit is", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  syncs.answer = { sync: "not-synced", reason: "the Harness could not be reached" };
  const host = new RunHost({ store: await mkStore(), ...target });
  host.register({
    name: "fx",
    machine: twoPushes(pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect),
    provide: () => ({}),
  });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ ...pushed("b".repeat(40)), squashed: "unsigned" });
  await waitFor(() => fake.starts.length === 2);
  const second = fake.starts[1]!.req as PushStartRequest;
  assert.deepEqual(second.push.pairs, [{ published: "b".repeat(40), source: "a".repeat(40), squashed: "unsigned" }]);
  fake.settle(pushed("c".repeat(40)));
  await waitFor(() => host.status(runId)?.value === "done");
});

test("a push sends every pair the Repo Slot's ledger holds, oldest push first — not the last push's alone (ADR-0067)", async () => {
  // A squash older than the last push still maps its source: the Effector builds its twin set from
  // every push that published, so the start carries each one's pair, with its own `squashed`.
  const fake = new FakeEffector(["sandbox"]);
  const syncs = new FakeSync();
  const host = new RunHost({ store: await mkStore(), ...target });
  host.register({
    name: "fx",
    machine: twoPushes(pushWith(port(fake), { sign: true }, syncs.factory) as AnyEffect, true),
    provide: () => ({}),
  });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ ...pushed("b".repeat(40)), squashed: "signed" });
  await waitFor(() => fake.starts.length === 2);
  fake.settle({ ...pushed("c".repeat(40)), source: "d".repeat(40) });
  await waitFor(() => fake.starts.length === 3);
  assert.deepEqual((fake.starts[2]!.req as PushStartRequest).push.pairs, [
    { published: "b".repeat(40), source: "a".repeat(40), squashed: "signed" },
    { published: "c".repeat(40), source: "d".repeat(40) },
  ]);
  fake.settle(pushed("e".repeat(40)));
  await waitFor(() => host.status(runId)?.value === "done");
});

test("a push restored when its Effector no longer holds it is sent again with only the pinned commit", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const effect = () => pushWith(port(fake), {}, new FakeSync().factory) as AnyEffect;
  const rig = await started(effect());
  await until(async () => Object.values(await ledger(rig.store, rig.runId)).some((r) => "pinned" in r));
  await rig.host.stop(rig.runId);
  fake.restart("sandbox");
  fake.tip = "c".repeat(40); // the Agent moved its branch since
  const host = await restored(rig.store, effect());
  await waitFor(() => fake.starts.length === 2);
  const again = fake.starts[1]!.req as PushStartRequest;
  assert.equal(fake.starts[1]!.id, fake.starts[0]!.id, "the same Effect");
  assert.equal(again.push.pin, "a".repeat(40), "only the commit the intent row holds");
  fake.settle(pushed("d".repeat(40)));
  await waitFor(() => host.status(rig.runId)?.value === "done");
});

test("a credentialed command runs in the Sandbox Effector; restored when its Effector forgot it, it is sent again with only the pinned commit", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const exec = new FakeHarnessExec();
  const effect = () =>
    commandWith(
      exec.factory,
      ["terraform", "apply"],
      {
        env: { AWS_SECRET: secret("aws"), KUBECONFIG: secret("kube").path },
      },
      port(fake),
    ) as AnyEffect;
  assert.equal(placementOf(effect().effect), "sandbox");
  const rig = await started(effect());
  await waitFor(() => fake.starts.length === 1);
  assert.equal(exec.starts.length, 0, "nothing ran in the Harness container");
  const req = fake.starts[0]!.req as CommandStartRequest;
  assert.deepEqual(req.command.argv, ["terraform", "apply"]);
  assert.deepEqual(req.command.env, { AWS_SECRET: { secret: "aws" }, KUBECONFIG: { secret: "kube", path: true } });
  await until(async () => Object.values(await ledger(rig.store, rig.runId)).some((r) => "pinned" in r));
  await rig.host.stop(rig.runId);
  fake.restart("sandbox");
  fake.tip = "c".repeat(40); // the Agent moved its branch since
  const host = await restored(rig.store, effect());
  await waitFor(() => fake.starts.length === 2);
  const again = fake.starts[1]!.req as CommandStartRequest;
  assert.equal(fake.starts[1]!.id, fake.starts[0]!.id, "the same Effect");
  assert.equal(again.command.pin, "a".repeat(40), "only the commit the intent row holds");
  fake.settle({ outcome: "exited", code: 0, tail: "applied\n" });
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(((host.status(rig.runId)?.context as Ctx).result as { outcome: string }).outcome, "exited");
});

test("a push or credentialed-command start over the bytes an Effector reads settles as its kind's own outcome: nothing is sent", async () => {
  // An Agent's pick parameter can reach the bound — a squash message, an argv part. `refused` is an
  // http outcome only (ADR-0067): a push settles `rejected` at stage `start`, nothing pushed; a
  // command `exited` 127 with the reason in its tail.
  const fake = new FakeEffector(["sandbox"]);
  const huge = "y".repeat(MAX_START_BYTES);
  const push = await started(pushWith(port(fake), { squash: true }, new FakeSync().factory) as AnyEffect, undefined, {
    message: huge,
  });
  await waitFor(() => push.host.status(push.runId)?.value === "done");
  const pushOut = (push.host.status(push.runId)?.context as Ctx).result as Record<string, unknown>;
  assert.equal(pushOut.outcome, "rejected");
  assert.equal(pushOut.stage, "start");
  assert.match(String(pushOut.reason), /over the 4194304 bytes an Effector reads; nothing was pushed/);
  assert.ok(PushOutputShape.safeParse(pushOut).success, "a push's own outcome");
  assert.deepEqual(
    Object.values(await ledger(push.store, push.runId)).map((r) => r.state),
    ["settled"],
    "no intent row: nothing was sent",
  );

  const command = commandWith(
    new FakeHarnessExec().factory,
    ["deploy", huge],
    { env: { AWS: secret("aws") } },
    port(fake),
  );
  const run = await started(command as AnyEffect);
  await waitFor(() => run.host.status(run.runId)?.value === "done");
  const commandOut = (run.host.status(run.runId)?.context as Ctx).result as Record<string, unknown>;
  assert.equal(commandOut.outcome, "exited");
  assert.equal(commandOut.code, 127);
  assert.match(String(commandOut.tail), /over the 4194304 bytes an Effector reads; nothing was run\n$/);
  assert.ok(CommandOutputShape.safeParse(commandOut).success, "a command's own outcome");
  assert.equal(fake.starts.length, 0, "nothing reached the Effector");
});

test("a credentialed command with `pin` takes the approved commit from its input; `pin` with no secret is refused", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const exec = new FakeHarnessExec();
  const effect = commandWith(
    exec.factory,
    ["terraform", "apply"],
    { env: { AWS: secret("aws") }, pin: true },
    port(fake),
  );
  assert.deepEqual(effect.effect.kind === "command" && effect.effect.pin, true);
  // The load walk's pick-param check reads this: a fromPick that hands it `sha` is read.
  assert.deepEqual(inputKeysOf(effect.effect), ["sha"]);
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [go],
    actors: { ws: fakeWorkspace(ws()), effect },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "start" }, on: { go: "running" } },
      running: {
        invoke: {
          src: "effect",
          input: { sha: "e".repeat(40) },
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: {},
    },
  });
  const host = new RunHost({ store: await mkStore(), ...target });
  host.register({ name: "fx", machine, provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  await waitFor(() => fake.starts.length === 1);
  assert.equal((fake.starts[0]!.req as CommandStartRequest).command.pin, "e".repeat(40));
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => host.status(runId)?.value === "done");
  assert.throws(() => commandWith(exec.factory, ["make"], { pin: true }), /names no secret/);
});

test("a port takeover: a process on the Sandbox Effector's address gets a signed start that carries no secret, and its answer fails the Effect closed", async () => {
  const seen: Array<{ headers: Record<string, string>; body: string }> = [];
  const takeover = () =>
    createEffectorClient({
      key: EFFECTOR_KEY,
      transport: {
        replicas: async () => ["10.0.0.9:8082"],
        send: async (_address, _method, _path, headers, body) => {
          seen.push({ headers, body });
          // It holds no key: it can answer, and it cannot sign.
          return { status: 202, headers: { "x-jr2-signature": "forged" }, body: '{"state":"settled"}' };
        },
      },
    });
  const exec = new FakeHarnessExec();
  const effect = commandWith(exec.factory, ["deploy"], { env: { AWS: secret("aws") } }, takeover);
  const rig = await started(effect as AnyEffect);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  const result = (rig.host.status(rig.runId)?.context as Ctx).result as { outcome: string; reason: string };
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /not the Sandbox Effector's; not run again/);
  assert.ok(seen.length >= 1);
  const start = seen[0]!;
  assert.ok(start.headers["x-jr2-signature"], "the start is signed");
  assert.match(start.body, /"secret":"aws"/, "it names the secret");
  assert.equal(start.body.includes(EFFECTOR_KEY), false, "and carries no key");
  assert.equal(exec.starts.length, 0, "nothing ran in the Harness container");
});

test("an http whose body is a Worktree file names it, in the Sandbox Effector; restored with no Effector holding it, unknown unless idempotent (ADR-0067)", async () => {
  const input = z.object({ path: z.string() });
  const def = {
    method: "PUT" as const,
    url: "https://files.example.com/reports",
    auth: bearer(secret("files")),
    input,
    body: file<typeof input>(({ path }) => path),
  };
  const fake = new FakeEffector(["sandbox"]);
  const effect = (idempotent = false) => httpFileWith(port(fake), { ...def, idempotent }) as AnyEffect;
  const rig = await started(effect());
  await waitFor(() => fake.starts.length === 1);
  const req = fake.starts[0]!.req as { kind: string; method: string; body: unknown };
  assert.equal(req.kind, "http");
  assert.equal(req.method, "PUT");
  assert.deepEqual(req.body, { file: { worktree: "app/jr2-run-1", path: "dist/report.pdf" } });
  await rig.host.stop(rig.runId);
  fake.restart("sandbox");
  const host = await restored(rig.store, effect());
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(((host.status(rig.runId)?.context as Ctx).result as { outcome: string }).outcome, "unknown");

  const twice = new FakeEffector(["sandbox"]);
  const again = (idempotent: boolean) => httpFileWith(port(twice), { ...def, idempotent }) as AnyEffect;
  const rig2 = await started(again(true));
  await waitFor(() => twice.starts.length === 1);
  await rig2.host.stop(rig2.runId);
  twice.restart("sandbox");
  const host2 = await restored(rig2.store, again(true));
  await waitFor(() => twice.starts.length === 2);
  twice.settle({ outcome: "response", status: 201, headers: {}, contentType: "", size: 0 });
  await waitFor(() => host2.status(rig2.runId)?.value === "done");
});

test("a file body has one content type: file()'s contentType and a content-type header together are refused (ADR-0067)", () => {
  const url = "https://files.example.com/r";
  assert.throws(
    () =>
      http({
        method: "PUT",
        url,
        headers: { "content-type": "text/plain" },
        body: file("a", { contentType: "application/pdf" }),
      }),
    /http\(\{ headers, body: file\(path, \{ contentType \}\) \}\): "content-type" is set by file\(\)'s contentType — write one of them/,
  );
  // Either one alone is legal.
  assert.doesNotThrow(() => http({ method: "PUT", url, headers: { "content-type": "text/plain" }, body: file("a") }));
  assert.doesNotThrow(() => http({ method: "PUT", url, body: file("a", { contentType: "application/pdf" }) }));
  // Without a file body, a content-type header is the request's own.
  assert.doesNotThrow(() =>
    http({ method: "POST", url, headers: { "content-type": "text/plain" }, request: () => ({ text: "a" }) }),
  );
});

test("http({ body: file(...) }) is refused, with the fix, with a method that sends no body and beside a request (ADR-0067)", () => {
  const url = "https://files.example.com/r";
  assert.throws(() => http({ method: "GET", url, body: file("a") }), /a file body is sent with PUT, POST, PATCH/);
  assert.throws(
    () => http({ method: "PUT", url, body: file("a"), request: () => ({ path: ["x"] }) }),
    /with a file body the run's part is file\(\)'s .* write no `request`/,
  );
  // Placement follows the body: a file body is the Sandbox Effector's, any other the Instance's.
  assert.equal(placementOf(http({ method: "PUT", url, body: file("a", { slot: "app" }) }).effect), "sandbox");
  assert.equal(placementOf(http({ method: "PUT", url, request: () => ({ text: "a" }) }).effect), "instance");
  assert.deepEqual(
    (http({ method: "POST", url, body: file("a", { slot: "app", contentType: "text/plain" }) }).effect as HttpParts)
      .file,
    {
      slot: "app",
      contentType: "text/plain",
    },
  );
});

test("the kinds' plain data: placement, the brand, what jr2 up reads", () => {
  const exec = new FakeHarnessExec();
  const fake = new FakeEffector(["sandbox"]);
  const plain = commandWith(exec.factory, ["pnpm", "test"]);
  const credentialed = commandWith(exec.factory, ["deploy"], { env: { TOKEN: secret("deploy-token") } }, port(fake));
  const pusher = pushWith(port(fake), { sign: true, pin: true });
  const up = httpFileWith(port(fake), { method: "PUT", url: "https://x.example.com/u", body: file("a") });
  assert.equal(placementOf(plain.effect), "harness");
  assert.equal(placementOf(credentialed.effect), "sandbox");
  assert.equal(placementOf(pusher.effect), "sandbox");
  assert.equal(placementOf(up.effect), "sandbox");
  for (const e of [plain, credentialed, pusher, up]) assert.ok(isEffect(e));
  const machine = jr2Setup({ events: [], actors: { plain, credentialed, pusher, up } }).createMachine({ id: "m" });
  const kinds = partsOf([machine]).effects.map((e) => `${e.name}:${e.kind}:${e.placement}`);
  assert.deepEqual(kinds.sort(), [
    "credentialed:command:sandbox",
    "plain:command:harness",
    "pusher:push:sandbox",
    "up:http:sandbox",
  ]);
  const carried = partsOf([machine]).effects.find((e) => e.name === "credentialed") as { secrets?: string[] };
  assert.deepEqual(carried.secrets, ["deploy-token"]);
  assert.deepEqual(pusher.effect.kind === "push" && pusher.effect.inputKeys, ["sha"]);
});

test("the Sandbox Effector container: jr2's binary, the Worktree, caches and runtime read-only, its own Secret, key and scratch", () => {
  const c = sandboxEffectorContainer({
    image: "registry.example/sandbox:1",
    keys: ["app-14189a29"],
    securityContext: { runAsNonRoot: true },
    secretVolume: "effector-secrets",
    keyVolume: "effector-key",
    scratchVolume: "effector-scratch",
  });
  assert.equal(c.name, "effector");
  assert.deepEqual(c.command, ["/opt/jr2/bin/effector"]);
  const mounts = Object.fromEntries(c.volumeMounts.map((m) => [m.mountPath, m.readOnly === true]));
  assert.deepEqual(mounts, {
    "/work": true,
    "/opt/jr2": true,
    "/repos/app-14189a29": true,
    "/run/jr2/secrets": true,
    "/run/jr2/effector": true,
    "/run/jr2/scratch": false,
  });
  const names = c.env.map((e) => e.name);
  assert.ok(!names.some((n) => /TOKEN|KEY$|SECRET$/.test(n) && n !== "JR2_EFFECTOR_KEY"), "no value in its env");
  assert.ok(c.env.every((e) => !("value" in e) || String(e.value).startsWith("/") || /^\d+$/.test(String(e.value))));
  assert.equal(sandboxEffectorSecret("task-review"), "jr2-effector-task-review");
});

// ADR-0068: the Effector refuses a request signed before its process started. With no probe of its
// own the pod went Ready on the Harness's while the Effector still read its mounts, the body's
// first Effect request was signed then, and its answer was that refusal: unsigned, so `unknown`.
// The probe holds pod Ready (and so the Sandbox's, ADR-0063) until the Effector serves.
test("the Sandbox Effector container is probed on its own /healthz: the pod is Ready only once the Effector serves", () => {
  const c = sandboxEffectorContainer({
    image: "registry.example/sandbox:1",
    keys: [],
    securityContext: { runAsNonRoot: true },
    secretVolume: "effector-secrets",
    keyVolume: "effector-key",
    scratchVolume: "effector-scratch",
  });
  assert.deepEqual(c.readinessProbe, { httpGet: { path: "/healthz", port: 8082 }, periodSeconds: 1 });
});

// ADR-0068: a credentialed command's child reads the image's top-level trees, bar the denied names
// (`/run`, `/tmp`'s own rules, …) and the Effector's deny list (`/work`, `/repos`, the scratch). So
// each mount the provision gives the Effector is in one of those, or one of the two public mounts
// the child may read. A new mount fails this test until its place is chosen: a secret goes under
// `/run/jr2`, and a mount under `/etc` or `/opt` is the child's to read.
test("every Sandbox Effector mount that holds a secret or the Agent's files is where its child is denied; the two others are public", () => {
  const c = sandboxEffectorContainer({
    image: "registry.example/sandbox:1",
    keys: ["app-14189a29"],
    securityContext: { runAsNonRoot: true },
    secretVolume: "effector-secrets",
    keyVolume: "effector-key",
    scratchVolume: "effector-scratch",
    caVolume: "effector-ca",
  });
  const env = Object.fromEntries(c.env.flatMap((e) => ("value" in e ? [[e.name, String(e.value)]] : [])));
  const denied = [env.JR2_EFFECTOR_WORK, env.JR2_EFFECTOR_REPOS, env.JR2_EFFECTOR_SCRATCH];
  const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);
  const publicMounts: Record<string, string> = { "/opt/jr2": "runtime", "/etc/jr2/effector-ca": "effector-ca" };
  for (const m of c.volumeMounts) {
    if (under(m.mountPath, "/run")) continue;
    if (denied.some((d) => d !== undefined && under(m.mountPath, d))) continue;
    assert.equal(publicMounts[m.mountPath], m.name, `${m.mountPath} is readable by a credentialed command's child`);
  }
  assert.deepEqual(denied, ["/work", "/repos", "/run/jr2/scratch"]);
  // The secrets, @git, the key and the config: each under /run.
  for (const p of [env.JR2_EFFECTOR_SECRETS, env.JR2_EFFECTOR_GIT, env.JR2_EFFECTOR_KEY, env.JR2_EFFECTOR_CONFIG]) {
    assert.ok(p !== undefined && under(p, "/run/jr2"), `${p} is under /run/jr2`);
  }
  // The caBundle is a ConfigMap, never a Secret.
  const ca = sandboxEffectorVolumes({
    sandbox: "ws-1",
    manifest: { version: 1, secret: "jr2-effector-ws-1", sources: [] },
    caBundle: true,
  }).find((v) => v.name === "effector-ca");
  assert.ok(ca && "configMap" in ca);
});

test("an unsigned squash is built (ADR-0067); an env that sets PATH, HOME or TMPDIR is refused with the fix", () => {
  assert.deepEqual(
    (({ squash, sign, inputKeys }) => ({ squash, sign, inputKeys }))(pushParts({ squash: true })),
    { squash: true, sign: false, inputKeys: ["message"] },
    "jr2 up decides whether the entry can commit it",
  );
  const exec = new FakeHarnessExec();
  assert.throws(() => commandWith(exec.factory, ["x"], { env: { PATH: secret("abcdefgh") } }), /PATH, HOME and TMPDIR/);
  assert.throws(
    () => commandWith(exec.factory, ["x"], { env: { TMPDIR: secret("abcdefgh") } }),
    /PATH, HOME and TMPDIR/,
  );
  assert.equal(JSON.stringify(secret("aws")), '{"secret":"aws"}', "`.path` is not in a definition's plain data");
  assert.deepEqual(secret("aws").path, { secret: "aws", path: true });
});

test("the sync's client: POST /sync with the Workspace's bearer; a Harness that refuses or cannot be reached is not-synced, never a fault", async () => {
  const req = { worktree: "/work/app/b", branch: "b", published: "2".repeat(40), source: "1".repeat(40) };
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const ok = createSyncPort({
    baseUrl: "http://ws-1.default.svc:8080",
    token: "bearer-1",
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ sync: "already" }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(await ok.sync(req, new AbortController().signal), { sync: "already" });
  assert.equal(sent[0]!.url, "http://ws-1.default.svc:8080/sync");
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, "Bearer bearer-1");
  const refused = createSyncPort({
    baseUrl: "http://ws-1:8080",
    fetch: (async () => new Response('{"error":"no"}', { status: 400 })) as unknown as typeof fetch,
  });
  assert.equal((await refused.sync(req, new AbortController().signal)).sync, "not-synced");
  const gone = createSyncPort({
    baseUrl: "http://ws-1:8080",
    fetch: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  const answer = await gone.sync(req, new AbortController().signal);
  assert.equal(answer.sync, "not-synced");
  assert.match("reason" in answer ? answer.reason : "", /could not be reached/);
});

test("where each Effector is: the Instance Effector's Service and key; a Sandbox Effector's Service and its Sandbox's key", () => {
  const key = Buffer.from("k");
  const opts = {
    instanceEffector: "jr2-instance-effector.ns.svc:8082",
    sandboxEffector: (sandbox: string) => `${sandboxEffectorService(sandbox)}.ns.svc:8082`,
  };
  assert.deepEqual(effectorTarget("instance", opts, key), {
    placement: "instance",
    service: "jr2-instance-effector.ns.svc:8082",
    key: effectorKey(key, "instance"),
  });
  assert.deepEqual(effectorTarget({ sandbox: "ws-run-coding-1a2b" }, opts, key), {
    placement: "sandbox",
    service: "fx-run-coding-1a2b.ns.svc:8082",
    key: effectorKey(key, "ws-run-coding-1a2b"),
  });
  assert.equal(effectorTarget({ sandbox: "ws-x" }, {}, key), undefined);
  assert.equal(effectorTarget("instance", {}, key), undefined);
});
