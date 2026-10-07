// `fromPick`, `paramsOf` and `answer` (ADR-0067): what an author writes between a pick and the work
// it starts. The params flow by name; `fill` adds only what the Machine supplies; `answer` shapes
// what the Agent reads, from the typed `chain` of every reply since the pick. Through the real
// `jr2Setup` walk and the real `RunHost`, with a fake Harness exec and a mock Agent port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { arg, commandWith, type CommandOutput } from "../src/effect.ts";
import { answer, fromPick, isPickMapper, paramsOf } from "../src/pick.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const lint = defineEvent({ name: "lint", input: z.object({ path: z.string() }) });
const finish = defineEvent({ name: "finish", input: z.object({}) });
const deploy = defineEvent({ name: "deploy_preview", input: z.object({}) });
const skip = defineEvent({ name: "skip", audience: "external", input: z.object({ why: z.string() }) });

test("paramsOf reads the pick's params off the entering event — never its type or its sender", () => {
  const event = { type: "lint", path: "src", sender: { party: "agent", id: "coder" } };
  assert.deepEqual(paramsOf(event, lint), { path: "src" });
  assert.throws(
    () => paramsOf({ type: "finish" }, lint),
    /entered by "finish", but its input reads the params of pick "lint"/,
  );
});

test("fromPick: the params flow by name, `fill` adds what the Machine supplies; the mapper carries its pick", () => {
  const mapper = fromPick(lint, ({ context }: { context: { repo: string } }) => ({ repo: context.repo }));
  const input = mapper({
    context: { repo: "app" },
    event: { type: "lint", path: "src" } as never,
    self: undefined as never,
  });
  assert.deepEqual(input, { path: "src", repo: "app" });
  assert.ok(isPickMapper(mapper));
  assert.equal(mapper.pick, lint);
  assert.equal(typeof mapper.fill, "function");
});

type Ctx = { build?: CommandOutput };

/** s13 in miniature: one pick runs the build; a red build asks a human, a green one deploys; `rest`'s
 * entry `answer` gives the Agent the whole chain. */
function chainMachine(fake: FakeHarnessExec, coder: ReturnType<typeof agentActorWith>) {
  const ok = (o: CommandOutput) => o.outcome === "exited" && o.code === 0;
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [deploy, finish, skip, lint],
    actors: {
      ws: fakeWorkspace(),
      coder,
      build: commandWith(fake.factory, ["pnpm", "build"]),
      deployer: commandWith(fake.factory, ["deploy-preview"]),
      linter: commandWith(fake.factory, ["pnpm", "lint", arg("path")]),
    },
  }).createMachine({
    id: "chain",
    context: {},
    invoke: { src: "ws" },
    initial: "working",
    states: {
      working: {
        invoke: { src: "coder", input: { prompt: "Make the change.", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: {
          rest: { entry: answer(({ chain }) => chain) },
          building: {
            invoke: {
              src: "build",
              onDone: [
                { guard: ({ event }) => ok(event.output), target: "deploying" },
                { target: "asking", actions: assign({ build: ({ event }) => event.output }) },
              ],
            },
          },
          asking: { invoke: { src: "gate", id: "review", input: {} }, on: { skip: "rest" } },
          deploying: { invoke: { src: "deployer", onDone: "rest" } },
          linting: { invoke: { src: "linter", input: fromPick(lint), onDone: "rest" } },
        },
        on: { deploy_preview: ".building", lint: ".linting", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

async function chainRig() {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "chain",
    machine: chainMachine(
      fake,
      agentActorWith(() => coder, coderDefinition),
    ),
    provide: () => ({}),
  });
  const { runId } = await host.start("chain");
  await waitFor(() => coder.admits.length === 1);
  return { fake, host, runId, iid: coder.admits[0]!.instanceId };
}

test("`answer` on rest's entry: the Agent reads the chain — the build's output, then the Gate's event — oldest first", async () => {
  const { fake, host, runId, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "deploy_preview" });
  assert.equal(picked.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 2, tail: "type error" });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "review", { type: "skip", why: "known flake" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "answer",
    value: [
      { kind: "output", src: "build", output: { outcome: "exited", code: 2, tail: "type error" } },
      { kind: "event", event: { type: "skip", why: "known flake", sender: { party: "gate", id: "review" } } },
    ],
  });
  assert.ok(answered?.allowed.includes("finish"), "the Allowed picks after the route");
});

test("the green path: build then deploy — two outputs in the chain; no `answer` that ran before the pick leaks into it", async () => {
  const { fake, host, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "deploy_preview" });
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "built" });
  await waitFor(() => fake.starts.length === 2);
  fake.settle({ outcome: "exited", code: 0, tail: "https://p.example/1" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "answer",
    value: [
      { kind: "output", src: "build", output: { outcome: "exited", code: 0, tail: "built" } },
      { kind: "output", src: "deployer", output: { outcome: "exited", code: 0, tail: "https://p.example/1" } },
    ],
  });
});

test("fromPick: the Agent's param reaches the command as one argument", async () => {
  const { fake, host, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "lint", path: "src; rm -rf /" });
  await waitFor(() => fake.starts.length === 1);
  assert.deepEqual(fake.starts[0]!.req.argv, ["pnpm", "lint", "src; rm -rf /"]);
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.equal(answered?.answer?.kind, "answer", "rest's entry answers every pick that comes back through it");
});

// The chain's types (ADR-0067): a link's output is typed by its slot, an event link by the Machine's
// events. Order and length are not typed. `tsc` is the assertion; the test only names the bindings.
test("the chain is typed by slot and by kind", () => {
  const fake = new FakeHarnessExec();
  jr2Setup({
    types: {} as { context: Ctx },
    events: [deploy, skip, finish],
    actors: {
      coder: agentActorWith(() => new MockFlueClient(), coderDefinition),
      build: commandWith(fake.factory, ["b"]),
    },
  }).createMachine({
    id: "typed",
    context: {},
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://h.invalid" } },
        initial: "rest",
        states: {
          rest: {
            entry: answer(({ chain }) =>
              chain.map((link) => {
                if (link.kind === "output") {
                  if (link.src === "build") {
                    const outcome: CommandOutput["outcome"] = link.output.outcome;
                    // @ts-expect-error — a command's output has no `body`
                    void link.output.body;
                    return outcome;
                  }
                  // @ts-expect-error — no slot named `deploy`
                  return link.src === "deploy";
                }
                // @ts-expect-error — `skip` carries `why`, not `reason`
                return link.event.type === "skip" ? link.event.reason : link.event.type;
              }),
            ),
          },
          building: { invoke: { src: "build", onDone: "asking" } },
          asking: { invoke: { src: "gate", input: {} }, on: { skip: "rest" } },
        },
        on: { deploy_preview: ".building", finish: "#typed.done" },
      },
      done: { type: "final" },
    },
  });
  assert.ok(true);
});
