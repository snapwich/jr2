// The held answer over the wire (ADR-0013, ADR-0024): `POST /agents/:iid/events` answers an
// outstanding pick at once with its delivery id; `GET /agents/:iid/deliveries/:id` long-polls the
// answer; a pick while one is outstanding is refused 409. Scoped by the Sandbox token like the pick.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { createApp } from "../src/http.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { createAuthenticator, mintInstanceToken, sandboxToken } from "../src/tokens.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const KEY = Buffer.alloc(32, 9);
const run_tests = defineEvent({ name: "run_tests", input: z.object({}) });
const finish = defineEvent({ name: "finish", input: z.object({}) });

async function rig() {
  let settle: ((v: unknown) => void) | undefined;
  const tests = fromPromise(() => new Promise((resolve) => (settle = resolve)));
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [run_tests, finish],
      actors: { coder, tests },
    }).createMachine({
      id: "wf",
      context: {},
      initial: "work",
      states: {
        work: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid", sandbox: "ws-1" } },
          on: { finish: "#wf.done" },
          initial: "rest",
          states: { rest: { on: { run_tests: "testing" } }, testing: { invoke: { src: "tests", onDone: "rest" } } },
        },
        done: { type: "final" },
      },
    });
  const client = new MockFlueClient();
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "held",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => ({ actors: { coder: agentActorWith(() => client, coderDefinition), tests } }),
  });
  const app = createApp(host, createAuthenticator({ instanceToken: mintInstanceToken(), signingKey: KEY }), {
    deliveryWaitMs: 20,
  });
  await host.start("held");
  await waitFor(() => client.admits.length > 0);
  const iid = encodeURIComponent(client.admits[0]!.instanceId);
  return { host, app, iid, settle: (v: unknown) => settle?.(v) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const pick = (body: unknown, token: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...auth(token) },
  body: JSON.stringify(body),
});

test("an outstanding pick: answered at once with its delivery id, refused 409 beside it, and its answer long-polled", async () => {
  const { app, iid, settle } = await rig();
  const token = sandboxToken(KEY, "ws-1");

  const first = await app.request(`/agents/${iid}/events`, pick({ type: "run_tests" }, token));
  assert.equal(first.status, 200);
  const receipt = (await first.json()) as { outstanding?: boolean; deliveryId: string; allowed: string[] };
  assert.equal(receipt.outstanding, true);
  assert.deepEqual(receipt.allowed, []);

  const second = await app.request(`/agents/${iid}/events`, pick({ type: "finish" }, token));
  assert.equal(second.status, 409);
  const refusal = (await second.json()) as { refused: string; outstanding: string; allowed: string[] };
  assert.deepEqual(
    { refused: refusal.refused, outstanding: refusal.outstanding, allowed: refusal.allowed },
    { refused: "outstanding", outstanding: "run_tests", allowed: [] },
  );

  const poll = `/agents/${iid}/deliveries/${receipt.deliveryId}`;
  const waiting = await app.request(poll, { headers: auth(token) });
  assert.equal(waiting.status, 200);
  assert.equal(((await waiting.json()) as { outstanding?: boolean }).outstanding, true, "ask again");

  // Another Sandbox's token reads nothing of it.
  assert.equal((await app.request(poll, { headers: auth(sandboxToken(KEY, "ws-2")) })).status, 403);
  assert.equal((await app.request(`/agents/${iid}/deliveries/nope`, { headers: auth(token) })).status, 404);

  settle({ passed: 1 });
  let answered: { answered?: boolean; answer?: unknown; allowed?: string[] } = {};
  for (let i = 0; i < 20 && !answered.answered; i++) {
    answered = (await (await app.request(poll, { headers: auth(token) })).json()) as typeof answered;
  }
  assert.deepEqual(answered, {
    delivered: true,
    event: "run_tests",
    moved: true,
    deliveryId: receipt.deliveryId,
    turnComplete: false,
    allowed: ["finish", "run_tests"],
    answered: true,
    answer: { kind: "output", actor: "tests", output: { passed: 1 } },
  });
});

test("a poll ends with its connection: the answer that lands after is not read by it (ADR-0031)", async () => {
  const { host, app, iid, settle } = await rig();
  const token = sandboxToken(KEY, "ws-1");
  const receipt = (await (await app.request(`/agents/${iid}/events`, pick({ type: "run_tests" }, token))).json()) as {
    deliveryId: string;
  };
  settle({ passed: 1 });
  await waitFor(() => host.list()[0]?.held?.length === 0);
  // The answer is there; a poll whose caller is already gone does not take it.
  const gone = new AbortController();
  gone.abort();
  const poll = `/agents/${iid}/deliveries/${receipt.deliveryId}`;
  const cut = await app.request(poll, { headers: auth(token), signal: gone.signal });
  assert.equal(((await cut.json()) as { outstanding?: boolean }).outstanding, true);
  const read = await app.request(poll, { headers: auth(token) });
  assert.equal(((await read.json()) as { answered?: boolean }).answered, true, "the next poll reads it");
});

test("a stopping Orchestrator answers the poll 503: the Harness asks again, and the Turn is not over", async () => {
  const { host, app, iid } = await rig();
  const token = sandboxToken(KEY, "ws-1");
  const receipt = (await (await app.request(`/agents/${iid}/events`, pick({ type: "run_tests" }, token))).json()) as {
    deliveryId: string;
  };
  const polling = app.request(`/agents/${iid}/deliveries/${receipt.deliveryId}`, { headers: auth(token) });
  await host.close();
  assert.equal((await polling).status, 503);
});
