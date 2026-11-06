// The `mcp` Effect (ADR-0067, ADR-0079), through the real `jr2Setup` walk, the real `RunHost`, and
// the real signed client against an in-process fake Effector: the start names the server and one
// request (never a url or a secret), every outcome is output, the restore rule holds as for
// `http`, a saved row drops its text and structured value, and `jr2 up` refuses an undeclared or a
// stdio server, and prints the line for an Open one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { dropSavedTails, placementOf, type EffectRow, type McpParts } from "../src/effect.ts";
import { createEffectorClient, McpOutputShape, type McpCallOutput } from "../src/effector-wire.ts";
import { mcp, mcpWith } from "../src/mcp-effect.ts";
import { partsOf } from "../src/parts.ts";
import { open } from "../src/open.ts";
import { customize } from "../src/customize.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { mcpRefusals, openPartRefusals } from "../src/assembly-checks.ts";
import { secretPlacementsOf } from "../src/secret-placement.ts";
import type { JR2Config } from "../src/config.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { agentActorWith } from "../src/actor.ts";
import { fromPick } from "../src/pick.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";

const go = defineEvent({ name: "go", input: z.object({ text: z.string() }) });

type Ctx = { text?: string; result?: McpCallOutput; fault?: string };

const input = z.object({ channel: z.string(), text: z.string() });

function machineWith(fake: FakeEffector, options: { idempotent?: boolean; timeout?: "5s" } = {}) {
  const post = mcpWith<McpCallOutput>(
    (target) => createEffectorClient({ key: target.key, transport: fake.transport }),
    {
      op: "call",
      server: "slack-acme",
      name: "post_message",
      options: { input, ...options },
    },
  );
  return jr2Setup({ types: {} as { context: Ctx }, events: [go], actors: { post } }).createMachine({
    id: "wf",
    context: {},
    initial: "waiting",
    states: {
      waiting: {
        invoke: { src: "gate", id: "start" },
        on: { go: { target: "calling", actions: assign({ text: ({ event }) => event.text }) } },
      },
      calling: {
        invoke: {
          src: "post",
          input: ({ context }: { context: Ctx }) => ({ channel: "#releases", text: context.text! }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output as McpCallOutput }) },
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      done: {},
      faulted: {},
    },
  });
}

const effector = { effector: () => ({ placement: "instance" as const, service: "svc:8082", key: EFFECTOR_KEY }) };

async function started(fake: FakeEffector, options: Parameters<typeof machineWith>[1] = {}, store?: SnapshotStore) {
  const s = store ?? (await mkStore());
  const host = new RunHost({ store: s, ...effector });
  host.register({ name: "fx", machine: machineWith(fake, options), provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go", text: "v1 is out" });
  return { host, store: s, runId };
}

const ledger = async (store: SnapshotStore, runId: string): Promise<Record<string, EffectRow>> =>
  ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};

test("an mcp Effect: the start names the server and the call, never a url or a secret; the Effector's output is the Machine's", async () => {
  const fake = new FakeEffector();
  const rig = await started(fake);
  await waitFor(() => fake.starts.length === 1);
  assert.deepEqual(fake.starts[0]!.req, {
    kind: "mcp",
    mcp: {
      server: "slack-acme",
      call: { tool: "post_message", arguments: { channel: "#releases", text: "v1 is out" } },
    },
    maxBody: 65_536,
  });
  const rows = Object.values(await ledger(rig.store, rig.runId));
  assert.deepEqual(
    rows.map((r) => [r.state, r.kind, (r as { placement?: string }).placement]),
    [["intent", "mcp", "instance"]],
    "write-ahead: the intent row is on disk before the call",
  );
  const returned = { outcome: "returned", isError: false, text: "Posted.", structured: { ts: "1.2" } };
  fake.settle(returned);
  await waitFor(() => rig.host.status(rig.runId)?.value === "done");
  assert.deepEqual((rig.host.status(rig.runId)?.context as Ctx).result, returned);
});

test("every outcome other than returned is output too: refused, unreachable, input-required, unknown", async () => {
  for (const outcome of ["refused", "unreachable", "input-required", "unknown"] as const) {
    const fake = new FakeEffector();
    const rig = await started(fake);
    await waitFor(() => fake.starts.length === 1);
    const output = { outcome, reason: `the ${outcome} reason` };
    fake.settle(output);
    await waitFor(() => rig.host.status(rig.runId)?.value === "done");
    assert.deepEqual((rig.host.status(rig.runId)?.context as Ctx).result, output, outcome);
    assert.ok(McpOutputShape.safeParse(output).success, outcome);
  }
  assert.ok(!McpOutputShape.safeParse({ outcome: "returned", isError: true }).success, "returned has its text");
});

test("restore when no replica holds it: `unknown`, never sent again — unless the author marked it idempotent; the server's hint is never read", async () => {
  for (const idempotent of [false, true]) {
    const fake = new FakeEffector(["a", "b"]);
    const rig = await started(fake, { idempotent });
    await waitFor(() => fake.starts.length === 1);
    await rig.host.stop(rig.runId);
    fake.restart(fake.starts[0]!.replica);
    const host = new RunHost({ store: rig.store, ...effector });
    host.register({ name: "fx", machine: machineWith(fake, { idempotent }), provide: () => ({}) });
    await host.restore();
    if (!idempotent) {
      await waitFor(() => host.status(rig.runId)?.value === "done");
      const result = (host.status(rig.runId)?.context as Ctx).result;
      assert.equal(result?.outcome, "unknown");
      assert.equal(fake.starts.length, 1);
      continue;
    }
    await waitFor(() => fake.starts.length === 2);
    assert.equal(fake.starts[1]!.id, fake.starts[0]!.id, "sent again under the same id");
    fake.settle({ outcome: "returned", isError: false, text: "ok" });
    await waitFor(() => host.status(rig.runId)?.value === "done");
  }
});

test("an Orchestrator with no Effector: an error, never output, nothing sent", async () => {
  const fake = new FakeEffector();
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "fx", machine: machineWith(fake), provide: () => ({}) });
  const { runId } = await host.start("fx");
  host.sendToGate(runId, "start", { type: "go", text: "x" });
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match((host.status(runId)?.context as Ctx).fault!, /mcp "post" runs in the Instance Effector.*knows none/);
  assert.equal(fake.calls.length, 0);
});

test("a saved mcp row keeps the outcome, isError and truncated; its text and structured value are a tail", () => {
  const effects: Record<string, EffectRow> = {
    e1: {
      state: "settled",
      kind: "mcp",
      slot: "post",
      output: { outcome: "returned", isError: true, text: "long", structured: { a: 1 }, truncated: true },
      at: "t",
    },
  };
  dropSavedTails(effects, { children: {} });
  assert.deepEqual((effects.e1 as { output: unknown }).output, { outcome: "returned", isError: true, truncated: true });
});

test("the definition is plain data jr2 up reads: op, server, tool, input keys, the Instance Effector; no secret of its own", () => {
  const fake = new FakeEffector();
  const { effects } = partsOf([machineWith(fake)]);
  assert.deepEqual(effects, [
    {
      name: "post",
      path: [],
      route: [],
      kind: "mcp",
      placement: "instance",
      op: "call",
      server: "slack-acme",
      tool: "post_message",
      secrets: [],
      idempotent: false,
      timeoutMs: 0,
    },
  ]);
  const read = (mcp.read("notes", "file:///a.md", { timeout: "90s" }) as unknown as { effect: McpParts }).effect;
  assert.equal(placementOf(read), "instance");
  assert.deepEqual([read.op, read.uri, read.timeoutMs, read.inputKeys], ["read", "file:///a.md", 90_000, []]);
});

test("the constructors refuse a server name that is not one, the reserved jr2, an Open uri, and a bad timeout", () => {
  assert.throws(() => mcp.call("Slack_Acme", "post"), /is not a server name/);
  assert.throws(() => mcp.call("jr2", "post"), /is not a server name/);
  assert.throws(() => mcp.read("notes", open as never), /never Open/);
  assert.throws(() => mcp.call("notes", ""), /non-empty/);
  assert.throws(() => mcp.call("notes", "x", { timeout: "soon" as never }), /positive duration/);
  for (const timeout of ["1.5.3s", "0.0001s", "0s", ".5s"]) {
    assert.throws(() => mcp.call("notes", "x", { timeout: timeout as never }), /positive duration/, timeout);
  }
  const ms = (mcp.call("notes", "x", { timeout: "0.0015s" }) as unknown as { effect: McpParts }).effect.timeoutMs;
  assert.equal(ms, 2, "a duration is a whole number of milliseconds");
  assert.throws(() => mcp.call("notes", "x", { maxBody: 0 }), /maxBody/);
});

test("a prompt's input schema is of strings: another field is refused where the Effect is defined", () => {
  assert.throws(
    () => mcp.prompt("notes", "release-note", { input: z.object({ title: z.string(), version: z.number() }) }),
    /mcp\.prompt\("release-note"\): the input field "version" is not a string schema/,
  );
  mcp.prompt("notes", "release-note", {
    input: z.object({
      title: z.string().min(1),
      tone: z.enum(["short", "long"]).optional(),
      kind: z.literal("patch").default("patch"),
    }),
  });
});

test("a prompt's arguments are strings: another value is the Machine's error", async () => {
  const fake = new FakeEffector();
  const ask = mcpWith((target) => createEffectorClient({ key: target.key, transport: fake.transport }), {
    op: "prompt",
    server: "notes",
    name: "release-note",
    options: {},
  });
  const machine = jr2Setup({ types: {} as { context: Ctx }, actors: { ask } }).createMachine({
    id: "wf",
    context: {},
    initial: "asking",
    states: {
      asking: {
        invoke: {
          src: "ask",
          input: () => ({ version: 1 }),
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      faulted: {},
    },
  });
  const host = new RunHost({ store: await mkStore(), ...effector });
  host.register({ name: "fx", machine, provide: () => ({}) });
  const { runId } = await host.start("fx");
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match(
    (host.status(runId)?.context as Ctx).fault!,
    /"version" is number, and a prompt's arguments are strings/,
  );
  assert.equal(fake.starts.length, 0);
});

// --- jr2 up ------------------------------------------------------------------------------------

const loaded = (
  machine: ReturnType<typeof jr2Setup>["createMachine"] extends (...a: never[]) => infer M ? M : never,
) => [{ name: "notify", machine }];

function effectMachine(post: unknown) {
  return jr2Setup({ actors: { post: post as ReturnType<typeof mcp.call> } }).createMachine({
    id: "notify",
    initial: "posting",
    states: { posting: { invoke: { src: "post", input: { channel: "#a", text: "b" } } } },
  });
}

const config = (mcpBlock: JR2Config["mcp"]): JR2Config =>
  ({ secrets: [{ name: "SLACK_TOKEN", value: "xoxb-0123456789" }], mcp: mcpBlock }) as JR2Config;

test("jr2 up refuses an mcp Effect whose server the mcp block does not declare, or is a stdio server, and prints the entry", () => {
  const workflows = loaded(effectMachine(mcp.call("slack-acme", "post_message", { input })) as never);
  const none = mcpRefusals(workflows as never, config({}));
  assert.equal(none.length, 1);
  assert.match(
    none[0]!,
    /the mcp Effect "post" names the MCP server "slack-acme", which the mcp block of jr2\.config\.ts declares no server/,
  );
  assert.match(none[0]!, /mcp: \{ "slack-acme": \{ url: "https:\/\/<host>\/mcp", secret: "<SECRET>" \} \}/);
  const stdio = mcpRefusals(workflows as never, config({ "slack-acme": { command: "slack-mcp" } }));
  assert.equal(stdio.length, 1);
  assert.match(stdio[0]!, /names the stdio MCP server "slack-acme" — an mcp Effect runs in the Instance Effector/);
  assert.deepEqual(
    mcpRefusals(
      workflows as never,
      config({ "slack-acme": { url: "https://mcp.slack.example/mcp", secret: "SLACK_TOKEN" } }),
    ),
    [],
  );
});

test("an Open server and tool: jr2 up prints the customize() line; customize() binds them, once", () => {
  // Built inline, not with effectMachine: the binding's type comes from the logic's own Open parts.
  const packaged = jr2Setup({ actors: { post: mcp.call(open, open, { input }) } }).createMachine({
    id: "notify",
    initial: "posting",
    states: { posting: { invoke: { src: "post", input: { channel: "#a", text: "b" } } } },
  });
  const lines = openPartRefusals(loaded(packaged as never) as never);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\{ effects: \{ post: \{ server: "<name>", tool: "<tool>" \} \} \}/);
  const bound = customize(packaged, { effects: { post: { server: "slack-acme", tool: "post_message" } } });
  assert.deepEqual(openPartRefusals(loaded(bound as never) as never), []);
  const [effect] = partsOf([bound]).effects;
  assert.deepEqual(
    [effect!.kind, (effect as { server?: string }).server, (effect as { tool?: string }).tool],
    ["mcp", "slack-acme", "post_message"],
  );
  assert.throws(
    () => customize(packaged, { effects: { post: { server: "" } as never } }),
    /is bound to a name, a string/,
  );
});

test("placement: the server's secret is an Effect secret of the Instance Effector, and effector.json names the server, its origin and its timeout", () => {
  const workflows = loaded(effectMachine(mcp.call("slack-acme", "post_message", { input, timeout: "5s" })) as never);
  const walk = {
    effects: partsOf([workflows[0]!.machine]).effects.map((effect) => ({ workflow: "notify", effect })),
    workspaces: [],
  };
  const placements = secretPlacementsOf(
    config({ "slack-acme": { url: "https://mcp.slack.example:8443/mcp", secret: "SLACK_TOKEN", timeout: "2m" } }),
    walk,
  );
  const plan = placements.instance!;
  assert.deepEqual(
    plan.secrets.map((s) => s.name),
    ["SLACK_TOKEN"],
  );
  assert.deepEqual(plan.targets, [
    { scheme: "https", host: "mcp.slack.example", port: 8443, secrets: ["SLACK_TOKEN"] },
  ]);
  assert.deepEqual(plan.mcp, {
    "slack-acme": { url: "https://mcp.slack.example:8443/mcp", secret: "SLACK_TOKEN", timeoutMs: 120_000 },
  });
  assert.equal(plan.longestTimeoutMs, 5_000, "the Effect's own timeout replaces the server's");
  assert.ok(
    placements.report.some((l) =>
      /secret SLACK_TOKEN: an Effect secret in the Instance Effector \(notify\/post\)/.test(l),
    ),
  );

  const noTimeout = loaded(effectMachine(mcp.call("slack-acme", "post_message", { input })) as never);
  const walk2 = {
    effects: partsOf([noTimeout[0]!.machine]).effects.map((effect) => ({ workflow: "notify", effect })),
    workspaces: [],
  };
  const plan2 = secretPlacementsOf(
    config({ "slack-acme": { url: "https://mcp.slack.example/mcp", secret: "SLACK_TOKEN", timeout: "2m" } }),
    walk2,
  ).instance!;
  assert.equal(plan2.longestTimeoutMs, 120_000, "with no timeout of its own, the server's");
});

test("placement: an mcp Effect whose server's secret the secrets list does not hold is refused, by the server it calls", () => {
  const workflows = loaded(effectMachine(mcp.call("slack-acme", "post_message", { input })) as never);
  const walk = {
    effects: partsOf([workflows[0]!.machine]).effects.map((effect) => ({ workflow: "notify", effect })),
    workspaces: [],
  };
  assert.throws(
    () =>
      secretPlacementsOf(
        config({ "slack-acme": { url: "https://mcp.slack.example/mcp", secret: "SLACK_OTHER" } }),
        walk,
      ),
    (e: Error) =>
      e.message.startsWith(
        'workflow "notify": the mcp Effect "post" calls the MCP server "slack-acme", whose secret "SLACK_OTHER" the ' +
          '`secrets` list does not hold — add it: secrets: [{ name: "SLACK_OTHER", value: process.env.',
      ) && !e.message.includes("secret("),
  );
});

test("fromPick into an mcp Effect: the pick's params fill the tool's arguments by name; a param no key reads is refused", () => {
  const post = mcp.call("slack-acme", "post_message", { input });
  const build = (pick: ReturnType<typeof defineEvent<"post_message", z.ZodObject<z.ZodRawShape>>>) =>
    jr2Setup({
      events: [pick],
      actors: { coder: agentActorWith(() => new MockFlueClient(), coderDefinition), post },
    }).createMachine({
      on: { "agent.fault": {} },
      id: "wf",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid" } },
          initial: "rest",
          states: {
            rest: {},
            post_message: {
              invoke: {
                src: "post",
                input: fromPick(pick, () => ({ channel: "#releases" })) as never,
                onDone: "rest",
              },
            },
          },
          on: { post_message: ".post_message" },
        },
      },
    });
  const pick = defineEvent({ name: "post_message", input: z.object({ text: z.string() }) });
  assert.deepEqual(loadWarningsOf(build(pick as never)), []);
  const wide = defineEvent({ name: "post_message", input: z.object({ text: z.string(), cc: z.string() }) });
  assert.throws(() => build(wide as never), /"cc"/);
});
