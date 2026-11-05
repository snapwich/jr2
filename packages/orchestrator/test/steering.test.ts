// Steering messages (ADR-0002, ADR-0062) through the run host and the HTTP API: a Caller sends
// free text to one Agent slot of a live run; its open Turn hears it at a step boundary (the surface
// read, then the Harness's acknowledgment), or else the slot's next Turn's admission carries it. A
// held message retires, recorded "not delivered", when its Machine instance ends. The Machine
// sends one with the `steer` action. `steerable: false` refuses Callers only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { doneEvent, requestReviewEvent } from "@jr2/agent-protocol";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { jr2Setup } from "../src/setup.ts";
import { agentActorWith, type AgentTurnInput, type AgentTurnPlacement } from "../src/actor.ts";
import { agent } from "../src/harness-client.ts";
import { steer, boundSteeringText, STEERING_TEXT_MAX } from "../src/steer.ts";
import type { SteeringRecord } from "../src/notices.ts";
import type { SteeringMessage } from "../src/wire.ts";
import {
  admittedIid,
  codingDef,
  coderDefinition,
  continuedDef,
  mkStore,
  MockFlueClient,
  waitFor,
  type Ctx,
} from "./_fixtures.ts";

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function mkApp(def: (clients: Map<string, MockFlueClient>) => WorkflowDef = codingDef) {
  const store = await mkStore();
  const host = new RunHost({ store });
  const clients = new Map<string, MockFlueClient>();
  host.register(def(clients));
  return { host, store, app: createApp(host), clients };
}

type Agents = Array<{ agent: string; open: boolean; steerable: boolean }>;
/** The run's record of its Steering messages, off its status (live or settled). */
const record = async (host: RunHost, runId: string): Promise<SteeringRecord[]> =>
  (await host.read(runId))?.steering ?? [];

test("GET /runs/:id/agents lists the run's Agent slots; a message to an open Turn rides its next surface read", async () => {
  const { host, app, clients } = await mkApp();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });
  const iid = await admittedIid(clients.get(instanceId)!);

  const listed = (await (await app.request(`/runs/${runId}/agents`)).json()) as Agents;
  assert.deepEqual(listed, [{ agent: "root/coder", open: true, steerable: true }]);
  assert.equal((await host.read(runId))?.steering, undefined, "no message yet: the status has no record");

  const sent = await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: "Use the v2 API." }));
  assert.equal(sent.status, 202);
  const { id, open } = (await sent.json()) as { id: string; agent: string; open: boolean };
  assert.equal(open, true);

  // The step boundary's read: the message rides apart from the notices, with its author.
  const surface = (await (await app.request(`/agents/${encodeURIComponent(iid)}/surface`)).json()) as {
    notices: unknown[];
    steering?: Array<{ id: string; message: SteeringMessage }>;
  };
  assert.deepEqual(surface.notices, []);
  assert.equal(surface.steering?.length, 1);
  assert.equal(surface.steering![0]!.id, id);
  assert.equal(surface.steering![0]!.message.text, "Use the v2 API.");
  assert.deepEqual(surface.steering![0]!.message.author, { kind: "caller", via: "token", name: "instance" });
  // Reserved for that read: a second read does not carry it again.
  const again = (await (await app.request(`/agents/${encodeURIComponent(iid)}/surface`)).json()) as {
    steering?: unknown[];
  };
  assert.equal(again.steering, undefined);

  // The Harness appended it: heard, and the record says so.
  const ack = await app.request(`/agents/${encodeURIComponent(iid)}/notices`, jsonPost({ heard: [id] }));
  assert.deepEqual(await ack.json(), { heard: 1 });
  assert.deepEqual(
    (await record(host, runId)).map((m) => [m.agent, m.text, m.outcome, m.author.kind]),
    [["root/coder", "Use the v2 API.", "heard", "caller"]],
  );
});

test("POST /runs/:id/steering refuses: an unknown run 404, no text 400, above 16 KiB 413, a slot no live Machine holds 409", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding");

  assert.equal((await app.request(`/runs/nope/steering`, jsonPost({ agent: "root/coder", text: "x" }))).status, 404);
  assert.equal((await app.request(`/runs/nope/agents`)).status, 404);
  assert.equal((await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder" }))).status, 400);
  assert.equal((await app.request(`/runs/${runId}/steering`, jsonPost({ text: "x" }))).status, 400);
  const big = "é".repeat(STEERING_TEXT_MAX / 2 + 1); // two bytes each: just above 16 KiB
  assert.equal(
    (await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: big }))).status,
    413,
  );
  const exact = "a".repeat(STEERING_TEXT_MAX);
  assert.equal(
    (await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: exact }))).status,
    202,
  );

  const wrong = await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "coder", text: "x" }));
  assert.equal(wrong.status, 409);
  const body = (await wrong.json()) as { error: string; agents?: Array<{ agent: string }> };
  assert.match(body.error, /no live Machine instance .* holds the Agent slot "coder"/);
  assert.deepEqual(
    body.agents?.map((a) => a.agent),
    ["root/coder"],
  );
});

test("a message the run never delivered retires when the run ends, and the settled run's record says not delivered", async () => {
  const { host, app, clients } = await mkApp();
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);
  assert.equal(
    (await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: "too late" }))).status,
    202,
  );
  await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "done" }));
  await waitFor(() => host.status(runId) === undefined);

  const settled = (await (await app.request(`/runs/${runId}/agents`)).json()) as Agents;
  assert.deepEqual(settled, [], "a run that ended has no slot to steer");
  assert.deepEqual(
    (await record(host, runId)).map((m) => [m.text, m.outcome]),
    [["too late", "not-delivered"]],
  );
  const late = await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: "x" }));
  assert.equal(late.status, 409, "the slot's Machine has ended");
});

test("a message that the open Turn did not read waits for the slot's next Turn, whose admission carries it", async () => {
  const { host, app, clients } = await mkApp(continuedDef);
  const { runId, instanceId } = await host.start("continued", {});
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: "Keep the old flag." }));

  // The Turn ends on its own pick before the Harness reads its surface again.
  await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "request_review", summary: "s" }));
  await waitFor(() => client.admits.length === 2);
  assert.deepEqual(
    client.steering[1]!.map((m) => [m.text, m.author.kind]),
    [["Keep the old flag."]].map(([t]) => [t, "caller"]),
  );
  assert.deepEqual(client.steering[0], [], "the first admission came before the message");
  // Ledgered with that admission: heard.
  await waitFor(() => host.status(runId) !== undefined);
  const listed = (await (await app.request(`/runs/${runId}/agents`)).json()) as Agents;
  assert.deepEqual(
    (await record(host, runId)).map((m) => m.outcome),
    ["heard"],
  );
});

test("the record survives a restart: a held message is still held for the slot after restore", async () => {
  const { host, store, clients } = await mkApp();
  const { runId, instanceId } = await host.start("coding");
  await admittedIid(clients.get(instanceId)!);
  host.steer(runId, "root/coder", "survive", { via: "token", name: "instance" });
  await host.stop(runId);

  const second = new RunHost({ store });
  const clients2 = new Map<string, MockFlueClient>();
  second.register(codingDef(clients2));
  assert.deepEqual((await second.restore()).reattached, [runId]);
  assert.deepEqual(
    (await record(second, runId)).map((r) => [r.text, r.outcome]),
    [["survive", "held"]],
  );
});

// ---- `steerable: false`, and the Machine's own `steer` action -----------------------------------

const quietDefinition = { ...coderDefinition, steerable: false };

/** `coding`, with a coder that refuses Callers' messages. */
function quietDef(clients: Map<string, MockFlueClient>): WorkflowDef {
  const def = codingDef(clients);
  return {
    ...def,
    name: "quiet",
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, quietDefinition) } };
    },
  };
}

test("steerable: false refuses a Caller (403), lists the slot as not steerable, and never reaches the Harness", async () => {
  const { host, app, clients } = await mkApp(quietDef);
  const { runId, instanceId } = await host.start("quiet", {});
  await admittedIid(clients.get(instanceId)!);
  const listed = (await (await app.request(`/runs/${runId}/agents`)).json()) as Agents;
  assert.deepEqual(listed, [{ agent: "root/coder", open: true, steerable: false }]);
  const refused = await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "root/coder", text: "x" }));
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /not steerable/);
  assert.deepEqual(await record(host, runId), []);
});

/** Two Turns of one coder: the first's `request_review` relays its summary to the second with the
 * `steer` action, as a peer's word (`from` the pick's Sender). The coder is not steerable by
 * Callers, and the Machine still steers it. */
const relayTemplate = jr2Setup({
  types: {} as { context: Ctx; input: Record<string, never> },
  events: [doneEvent, requestReviewEvent],
  actors: { coder: agent(quietDefinition) },
}).createMachine({
  on: { "agent.fault": {} },
  id: "r",
  context: {},
  initial: "first",
  states: {
    first: {
      invoke: {
        src: "coder",
        input: { endpoint: "http://harness.invalid", prompt: "turn one" } satisfies AgentTurnInput & AgentTurnPlacement,
      },
      on: {
        request_review: {
          target: "second",
          actions: [
            steer("coder", ({ event }) => `the reviewer said: ${event.summary}`, { from: ({ event }) => event.sender }),
            steer("coder", "Finish before noon."),
          ],
        },
      },
    },
    second: {
      invoke: {
        src: "coder",
        input: { endpoint: "http://harness.invalid", prompt: "turn two" } satisfies AgentTurnInput & AgentTurnPlacement,
      },
      on: { done: "end" },
    },
    end: { type: "final" },
  },
});

test("the steer action holds a Machine's message for the slot's next Turn, with the Sender it relays", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  const clients = new Map<string, MockFlueClient>();
  host.register({
    name: "relay",
    machine: relayTemplate,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, quietDefinition) } };
    },
  });
  const app = createApp(host);
  const { runId, instanceId } = await host.start("relay", {});
  const client = clients.get(instanceId)!;
  const iid = await admittedIid(client);
  await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "request_review", summary: "LGTM" }));
  await waitFor(() => client.admits.length === 2);
  assert.deepEqual(
    client.steering[1]!.map((m) => [m.text, m.author]),
    [
      ["the reviewer said: LGTM", { kind: "machine", from: { party: "agent", id: "coder" } }],
      ["Finish before noon.", { kind: "machine" }],
    ],
  );
  assert.ok(host.status(runId));
});

test("the steer action cuts a text above 16 KiB, and keeps one at the bound", () => {
  const at = "a".repeat(STEERING_TEXT_MAX);
  assert.equal(boundSteeringText(at), at);
  const cut = boundSteeringText(`${"é".repeat(STEERING_TEXT_MAX)}`);
  assert.ok(new TextEncoder().encode(cut).length <= STEERING_TEXT_MAX);
  assert.match(cut, /\[jr2 cut this message at 16 KiB\]$/);
  assert.doesNotMatch(cut, /�/, "no half character");
});

/** A child Machine that holds the coder: the root invokes it as `worker`, and it ends on the coder's
 * `done`. The root then waits for ever in `idle`, so the run stays live. */
const workerTemplate = jr2Setup({
  types: {} as { context: Ctx; input: Record<string, never> },
  events: [doneEvent],
  actors: { coder: agent(coderDefinition) },
}).createMachine({
  on: { "agent.fault": {} },
  id: "worker",
  context: {},
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        input: { endpoint: "http://harness.invalid", prompt: "work" } satisfies AgentTurnInput & AgentTurnPlacement,
      },
      on: { done: "end" },
    },
    end: { type: "final" },
  },
});

test("a held message retires, recorded not delivered, when its child Machine instance ends while the run goes on", async () => {
  const clients = new Map<string, MockFlueClient>();
  const parent = jr2Setup({
    types: {} as { context: Ctx; input: Record<string, never> },
    events: [],
    actors: { worker: workerTemplate },
  }).createMachine({
    id: "p",
    context: {},
    initial: "working",
    states: {
      working: { invoke: { id: "worker", src: "worker", input: {}, onDone: "idle" } },
      idle: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "parent",
    machine: parent,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      clients.set(instanceId, client);
      return {
        actors: {
          worker: workerTemplate.provide({ actors: { coder: agentActorWith(() => client, coderDefinition) } }),
        },
      };
    },
  });
  const app = createApp(host);
  const { runId, instanceId } = await host.start("parent", {});
  const iid = await admittedIid(clients.get(instanceId)!);
  const listed = (await (await app.request(`/runs/${runId}/agents`)).json()) as Agents;
  assert.deepEqual(
    listed.map((a) => a.agent),
    ["worker/coder"],
    "the root carries no Agent; its child Machine does",
  );
  assert.equal(
    (await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "worker/coder", text: "unread" }))).status,
    202,
  );
  await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "done" }));
  await waitFor(() => (host.agents(runId) ?? []).length === 0);
  assert.ok(host.status(runId), "the run goes on");
  assert.deepEqual(
    (await record(host, runId)).map((r) => [r.agent, r.outcome]),
    [["worker/coder", "not-delivered"]],
  );
  const late = await app.request(`/runs/${runId}/steering`, jsonPost({ agent: "worker/coder", text: "x" }));
  assert.equal(late.status, 409);
});
