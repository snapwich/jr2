// A stopped state stops its credentialed command (ADR-0067, ADR-0068): when the actor of a
// credentialed command stops before its process ends — the invoking state exits, or the run is
// cancelled — the Orchestrator sends one signed DELETE on that Effect's own path to its Sandbox
// Effector, through the injected transport (ADR-0010). A settled Effect sends none, a parked run
// sends none (it re-attaches on restore), and a push or a file-body http has no stop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { commandWith, type EffectLogic } from "../src/effect.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import { bearer, file, secret } from "../src/http-effect.ts";
import { RunHost } from "../src/run-host.ts";
import { httpFileWith, pushWith } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { fakeWorkspace, handles, FakeHarnessExec } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({}) });
const leave = defineEvent({ name: "leave", input: z.object({}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffect = EffectLogic<any, unknown>;

const ws = () => ({
  ...handles({ app: "/work/app/jr2-run-1" }),
  bindings: { app: "https://github.com/ourorg/app.git" },
});

/** A Machine whose `running` state invokes the Effect beside a Gate `exit`; `leave` exits it. */
function machineOf(effect: AnyEffect) {
  return jr2Setup({ events: [go, leave], actors: { ws: fakeWorkspace(ws()), effect } }).createMachine({
    id: "wf",
    invoke: { src: "ws" },
    initial: "waiting",
    states: {
      waiting: { invoke: { src: "gate", id: "start" }, on: { go: "running" } },
      running: {
        invoke: [
          { src: "effect", input: () => ({ path: "dist/report.pdf" }) as never, onDone: "done", onError: "faulted" },
          { src: "gate", id: "exit" },
        ],
        on: { leave: "left" },
      },
      left: {},
      done: {},
      faulted: {},
    },
  });
}

const target = { effector: () => ({ placement: "sandbox" as const, service: "ws-1:8082", key: EFFECTOR_KEY }) };
const port = (fake: FakeEffector) => () => createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });

const credentialed = (fake: FakeEffector) =>
  commandWith(
    new FakeHarnessExec().factory,
    ["sleep", "300"],
    { env: { TOKEN: secret("deploy-token") } },
    port(fake),
  ) as AnyEffect;

async function running(effect: AnyEffect, fake: FakeEffector) {
  const host = new RunHost({ store: await mkStore(), ...target });
  host.register({ name: "fx", machine: machineOf(effect), provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go" });
  await waitFor(() => fake.starts.length === 1);
  // The start was answered, so the Effect is followed: what a stop must reach.
  await waitFor(() => fake.calls.some((c) => c.method === "GET"));
  return { host, runId };
}

const deletes = (fake: FakeEffector) => fake.calls.filter((c) => c.method === "DELETE");
const settleTicks = () => new Promise((r) => setTimeout(r, 100));

test("a credentialed command whose state exits is stopped: one signed DELETE on the Effect's own path", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const { host, runId } = await running(credentialed(fake), fake);
  host.sendToGate(runId, "exit", { type: "leave" });
  await waitFor(() => deletes(fake).length === 1);
  await settleTicks();
  const [del] = deletes(fake);
  assert.equal(deletes(fake).length, 1, "sent once");
  assert.equal(del!.path, `/effects/${encodeURIComponent(fake.starts[0]!.id)}`);
  // The fake verified its signature as the Effector does, and stopped it there.
  assert.deepEqual(fake.stopped, [fake.starts[0]!.id]);
  assert.equal(host.status(runId)?.value, "left");
});

test("a cancelled run stops its credentialed command; a parked run does not", async () => {
  const cancelled = new FakeEffector(["sandbox"]);
  const one = await running(credentialed(cancelled), cancelled);
  await one.host.cancel(one.runId);
  await waitFor(() => deletes(cancelled).length === 1);
  await settleTicks();
  assert.equal(deletes(cancelled).length, 1);

  const parked = new FakeEffector(["sandbox"]);
  const two = await running(credentialed(parked), parked);
  await two.host.stop(two.runId);
  await settleTicks();
  assert.equal(deletes(parked).length, 0, "a park is not an exit: the command re-attaches on restore");
});

test("a settled credentialed command sends no DELETE when its state exits", async () => {
  const fake = new FakeEffector(["sandbox"]);
  const { host, runId } = await running(credentialed(fake), fake);
  fake.settle({ outcome: "exited", code: 0, tail: "done\n" });
  await waitFor(() => host.status(runId)?.value === "done");
  await settleTicks();
  assert.equal(deletes(fake).length, 0);
});

test("a push and a file-body http have no stop: their state's exit sends no DELETE", async () => {
  const input = z.object({ path: z.string() });
  const kinds: Record<string, (fake: FakeEffector) => AnyEffect> = {
    push: (fake) => pushWith(port(fake), {}) as AnyEffect,
    http: (fake) =>
      httpFileWith(port(fake), {
        method: "PUT",
        url: "https://files.example.com/reports",
        auth: bearer(secret("files")),
        input,
        body: file<typeof input>(({ path }) => path),
      }) as AnyEffect,
  };
  for (const [name, effect] of Object.entries(kinds)) {
    const fake = new FakeEffector(["sandbox"]);
    const { host, runId } = await running(effect(fake), fake);
    host.sendToGate(runId, "exit", { type: "leave" });
    await waitFor(() => host.status(runId)?.value === "left");
    await settleTicks();
    assert.equal(deletes(fake).length, 0, `${name} sent a DELETE`);
  }
});
