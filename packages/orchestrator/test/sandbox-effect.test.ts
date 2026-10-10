// The Sandbox Effector's kinds from the Orchestrator's side (ADR-0067): push, upload and the
// credentialed command, driven through the real signed client against the in-process fake
// Effector (ADR-0010) — the start each builds from the Workspace's handles, the commit the intent
// row keeps, and the restore rule per kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { commandWith, isEffect, placementOf, type EffectLogic, type EffectRow } from "../src/effect.ts";
import { createEffectorClient, type CommandStartRequest, type PushStartRequest } from "../src/effector-wire.ts";
import { bearer, secret } from "../src/http-effect.ts";
import { partsOf } from "../src/parts.ts";
import { RunHost } from "../src/run-host.ts";
import { pushParts, pushWith, uploadWith } from "../src/sandbox-effect.ts";
import { sandboxEffectorSecret, sandboxEffectorContainer } from "../src/sandbox-kube.ts";
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

function machineOf(effect: AnyEffect) {
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
          input: () => ({ path: "dist/report.pdf" }) as never,
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

async function started(effect: AnyEffect, store?: SnapshotStore) {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s, ...target });
  host.register({ name: "fx", machine: machineOf(effect), provide: () => ({}) });
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
  bundle: "QlVORExF",
});

test("a push: the start names the Workspace's repositories and Binding; the pinned commit goes to the intent row; the bundle never reaches the Machine", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const rig = await started(pushWith(port(fake), { sign: true }) as AnyEffect);
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
});

test("a push restored when its Effector no longer holds it is sent again with only the pinned commit", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const effect = () => pushWith(port(fake)) as AnyEffect;
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

test("a credentialed command runs in the Sandbox Effector; restored when its Effector forgot it, it settles unknown and never runs again", async () => {
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
  const host = await restored(rig.store, effect());
  await waitFor(() => host.status(rig.runId)?.value === "done");
  const result = (host.status(rig.runId)?.context as Ctx).result as { outcome: string; reason: string };
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /not run again/);
  assert.equal(fake.starts.length, 1);
});

test("an upload names its Worktree file; restored with no Effector holding it, unknown unless idempotent", async () => {
  const def = {
    url: "https://files.example.com/reports",
    auth: bearer(secret("files")),
    input: z.object({ path: z.string() }),
    file: ({ path }: { path: string }) => ({ path }),
  };
  const fake = new FakeEffector(["sandbox"]);
  const effect = (idempotent = false) => uploadWith(port(fake), { ...def, idempotent }) as AnyEffect;
  const rig = await started(effect());
  await waitFor(() => fake.starts.length === 1);
  const req = fake.starts[0]!.req as { kind: string; method: string; body: unknown };
  assert.equal(req.kind, "upload");
  assert.equal(req.method, "PUT");
  assert.deepEqual(req.body, { file: { worktree: "app/jr2-run-1", path: "dist/report.pdf" } });
  await rig.host.stop(rig.runId);
  fake.restart("sandbox");
  const host = await restored(rig.store, effect());
  await waitFor(() => host.status(rig.runId)?.value === "done");
  assert.equal(((host.status(rig.runId)?.context as Ctx).result as { outcome: string }).outcome, "unknown");

  const twice = new FakeEffector(["sandbox"]);
  const again = (idempotent: boolean) => uploadWith(port(twice), { ...def, idempotent }) as AnyEffect;
  const rig2 = await started(again(true));
  await waitFor(() => twice.starts.length === 1);
  await rig2.host.stop(rig2.runId);
  twice.restart("sandbox");
  const host2 = await restored(rig2.store, again(true));
  await waitFor(() => twice.starts.length === 2);
  twice.settle({ outcome: "response", status: 201, headers: {}, contentType: "", size: 0 });
  await waitFor(() => host2.status(rig2.runId)?.value === "done");
});

test("the kinds' plain data: placement, the brand, what jr2 up reads", () => {
  const exec = new FakeHarnessExec();
  const fake = new FakeEffector(["sandbox"]);
  const plain = commandWith(exec.factory, ["pnpm", "test"]);
  const credentialed = commandWith(exec.factory, ["deploy"], { env: { TOKEN: secret("deploy-token") } }, port(fake));
  const pusher = pushWith(port(fake), { sign: true, pin: true });
  const up = uploadWith(port(fake), { url: "https://x.example.com/u", file: () => ({ path: "a" }) });
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
    "up:upload:sandbox",
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

test("refusals that name the fix: a squash without sign, an env that sets PATH or HOME", () => {
  assert.throws(() => pushParts({ squash: true }), /push\(\{ squash: true, sign: true \}\)/);
  const exec = new FakeHarnessExec();
  assert.throws(() => commandWith(exec.factory, ["x"], { env: { PATH: secret("abcdefgh") } }), /PATH and HOME/);
  assert.equal(JSON.stringify(secret("aws")), '{"secret":"aws"}', "`.path` is not in a definition's plain data");
  assert.deepEqual(secret("aws").path, { secret: "aws", path: true });
});
