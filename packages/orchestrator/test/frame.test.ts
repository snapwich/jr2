// A Turn's `cwd`. A word that names no folder settles `agent.fault`, which the
// Machine routes, because a Chart can say it; a Turn with no `cwd` in a Workspace with Repo Slots is a
// defect of the Machine; `/work` is a stated value; `workspace: "none"` is exempt; and `workspace()`'s
// walk refuses what a type cannot see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assign, fromPromise, setup } from "xstate";
import { agentActorWith } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { agent } from "../src/harness-client.ts";
import { commandWith } from "../src/effect.ts";
import { pool, source } from "../src/pool.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const definition: AgentDefinition = { model: "stub/model", instructions: "i" };

class Refusing extends MockFlueClient {
  override async admit(...args: Parameters<MockFlueClient["admit"]>) {
    if (args[0].cwd === "/work/app/nope") {
      throw new Error("harness refused (400): the Turn's `cwd` /work/app/nope does not exist: cut the Worktree first");
    }
    return super.admit(...args);
  }
}

function rig(input: unknown) {
  const port = new Refusing();
  const machine = jr2Setup({
    types: {} as { context: { fault?: string } },
    actors: { coder: agent(definition), ws: fakeWorkspace(handles({ app: "/work/app" })) },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    on: { "agent.fault": { target: ".faulted", actions: assign({ fault: ({ event }) => event.reason }) } },
    initial: "working",
    states: {
      working: { invoke: { src: "coder", input: input as never, onError: "defect" } },
      faulted: {},
      defect: {},
    },
  });
  return {
    port,
    def: {
      name: "fx",
      machine,
      provide: () => ({ actors: { coder: agentActorWith(() => port, definition) } }),
    },
  };
}

test("a `cwd` that does not exist settles `agent.fault`, and the Machine routes", async () => {
  const r = rig(() => ({ prompt: "p", cwd: "/work/app/nope" }));
  const host = new RunHost({ store: await mkStore() });
  host.register(r.def);
  const { runId } = await host.start("fx");
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match((host.status(runId)?.context as { fault: string }).fault, /does not exist/);
  await host.stop(runId);
});

test("no `cwd` in a Workspace with Repo Slots is a defect, and no Turn starts", async () => {
  const r = rig(() => ({ prompt: "p" }));
  const host = new RunHost({ store: await mkStore() });
  host.register(r.def);
  const { runId } = await host.start("fx");
  await waitFor(() => host.status(runId)?.value !== "working");
  assert.equal(r.port.admits.length, 0);
  await host.stop(runId).catch(() => {});
});

test("`cwd: /work` is legal and framed as stated", async () => {
  const r = rig(() => ({ prompt: "p", cwd: "/work" }));
  const host = new RunHost({ store: await mkStore() });
  host.register(r.def);
  const { runId } = await host.start("fx");
  await waitFor(() => r.port.admits.length === 1);
  assert.equal(r.port.admits[0]!.cwd, "/work");
  await host.stop(runId);
});

const url = "https://example.test/a.git";

test("workspace()'s walk, for a plain setup(): a Turn and a command with no key, and a Pool's worker below", () => {
  const body = setup({
    actors: { coder: agent(definition) as never, tests: commandWith(new FakeHarnessExec().factory, ["make"]) as never },
  }).createMachine({
    on: { "workspace.lost": {} },
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "p" } as never } } },
  });
  assert.throws(() => workspace(body as never, { repos: { app: url } } as never), /"coder" names no `cwd`/);
  const second = setup({
    actors: { tests: commandWith(new FakeHarnessExec().factory, ["make"]) as never },
  }).createMachine({
    on: { "workspace.lost": {} },
    initial: "a",
    states: { a: { invoke: { src: "tests" } as never } },
  });
  assert.throws(() => workspace(second as never, { repos: { app: url } } as never), /"tests" names no `worktree`/);
  assert.doesNotThrow(() => workspace(second as never, {} as never), "no Repo Slot: /work");
  const worker = setup({ actors: { coder: agent(definition) as never } }).createMachine({
    on: { "workspace.lost": {}, "agent.fault": {} },
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "p" } as never } } },
  });
  const workers = () =>
    pool(worker, {
      source: source<{ id: string }>({ next: fromPromise(async (): Promise<null> => null) }),
      itemId: (i) => i.id,
    });
  const pooled = setup({ actors: { coders: workers() as never } }).createMachine({
    on: { "workspace.lost": {} },
    initial: "w",
    states: { w: { invoke: { src: "coders", input: {} as never } } },
  });
  assert.throws(() => workspace(pooled as never, { repos: { app: url } } as never), /"coder" names no `cwd`/);
});

test("workspace()'s walk stops at a nested Workspace: its own call walks it, by its own Repo Slots", () => {
  const inner = setup({ actors: { coder: agent(definition) as never } }).createMachine({
    on: { "workspace.lost": {}, "agent.fault": {} },
    initial: "a",
    states: { a: { invoke: { src: "coder", input: { prompt: "p" } as never } } },
  });
  const outer = setup({ actors: { nested: workspace(inner as never, {} as never) as never } }).createMachine({
    on: { "workspace.lost": {} },
    initial: "w",
    states: { w: { invoke: { src: "nested", input: {} as never } } },
  });
  assert.doesNotThrow(() => workspace(outer as never, { repos: { app: url } } as never));
});
