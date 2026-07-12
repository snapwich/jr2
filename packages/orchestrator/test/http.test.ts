// HTTP-surface tests (ADR-0009): drive `createApp(host)` with `app.request(...)` (no socket) and
// prove each route delegates to the RunHost. The interesting paths — approval round-trip and the
// SSE status feed — are exercised end-to-end: a real in-memory MCP Client drives the up-channel
// (request_approval / request_review) while the HTTP surface drives the down-channel and observes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { codingDef, connectMcp, gatedDef, mkStore, waitFor } from "./_fixtures.ts";

/** A host + app pair with the `coding` workflow registered. */
async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  return { host, app: createApp(host) };
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("GET /healthz and /readyz report up", async () => {
  const { app } = await mkApp();
  const health = await app.request("/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const ready = await app.request("/readyz");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
});

test("GET /workflows lists registered workflows", async () => {
  const { app } = await mkApp();
  const res = await app.request("/workflows");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), ["coding"]);
});

test("POST /workflows/:name/runs starts a run, then it shows in /runs and /runs/:id", async () => {
  const { app } = await mkApp();
  const start = await app.request("/workflows/coding/runs", jsonPost({ note: "hi" }));
  assert.equal(start.status, 201);
  const { runId, instanceId } = (await start.json()) as { runId: string; instanceId: string };
  assert.ok(runId && instanceId);

  const list = (await (await app.request("/runs")).json()) as Array<{ runId: string }>;
  assert.ok(list.some((r) => r.runId === runId));

  const status = await app.request(`/runs/${runId}`);
  assert.equal(status.status, 200);
  const body = (await status.json()) as { runId: string; workflow: string; status: string };
  assert.equal(body.runId, runId);
  assert.equal(body.workflow, "coding");
  assert.equal(body.status, "active");
});

test("unknown run and unknown workflow are 404", async () => {
  const { app } = await mkApp();
  const run = await app.request("/runs/nope");
  assert.equal(run.status, 404);

  const start = await app.request("/workflows/nope/runs", jsonPost({}));
  assert.equal(start.status, 404);
});

test("approval round-trip: POST APPROVE releases a parked request_approval", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding");

  const { client, close } = await connectMcp(host.mcpServer(instanceId));
  try {
    // Up-channel: park the run on an approval gate (do NOT await — it blocks until answered).
    const callP = client.callTool({ name: "request_approval", arguments: { action: "deploy" } });
    await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("awaitingApproval"));

    // Down-channel: APPROVE over HTTP releases the gate.
    const res = await app.request(`/runs/${runId}/events`, jsonPost({ type: "APPROVE" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const settled = await callP;
    assert.deepEqual(settled.structuredContent, { decision: "approved" });
  } finally {
    await close();
  }
});

test("SSE: GET /runs/:id/events streams a status delta on transition", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding");

  const res = await app.request(`/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  const { client, close } = await connectMcp(host.mcpServer(instanceId));
  try {
    // Drive a transition (running → review); the SSE feed should push its new status.
    await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });

    let buf = "";
    while (!buf.includes("review")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    // The feed replays the current status on attach (value "running"), then pushes the review delta —
    // so scan every `data:` line rather than the first, and assert one reflects the review state.
    const values = [...buf.matchAll(/data: (.*)/g)].map((m) => (JSON.parse(m[1] ?? "{}") as { value: unknown }).value);
    assert.ok(values.length >= 1, "SSE must carry status data lines");
    assert.ok(
      values.some((v) => JSON.stringify(v).includes("review")),
      "a streamed status value must reflect the review state",
    );
  } finally {
    await reader.cancel();
    await close();
  }
});

test("gates over HTTP (ADR-0011): discovered on GET /runs/:id, delivered via POST, 404/400 mapped", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const app = createApp(host);
  const { runId } = await host.start("gated");

  // Discovery: the run status carries its open gates — names, schemas, meta.
  const status = (await (await app.request(`/runs/${runId}`)).json()) as {
    gates: Array<{ gate: string; accepts: Array<{ name: string }>; meta: unknown }>;
  };
  assert.equal(status.gates.length, 1);
  assert.equal(status.gates[0]?.gate, "F-1");
  assert.deepEqual(status.gates[0]?.meta, { prUrl: "https://forge/pr/1" });

  // Bad payload → 400 (schema), unknown gate → 404 (with the open set named), unknown name → 400.
  const badPayload = await app.request(`/runs/${runId}/gates/F-1/events`, jsonPost({ type: "request_changes" }));
  assert.equal(badPayload.status, 400);
  const unknownGate = await app.request(`/runs/${runId}/gates/F-9/events`, jsonPost({ type: "approve" }));
  assert.equal(unknownGate.status, 404);
  assert.match(((await unknownGate.json()) as { error: string }).error, /no open gate "F-9".*open: F-1/);
  const unknownName = await app.request(`/runs/${runId}/gates/F-1/events`, jsonPost({ type: "merge" }));
  assert.equal(unknownName.status, 400);

  // Valid delivery transitions the gated state; the gate is destroyed with it.
  const ok = await app.request(`/runs/${runId}/gates/F-1/events`, jsonPost({ type: "approve" }));
  assert.equal(ok.status, 200);
  await waitFor(() => host.status(runId)?.value === "approved");
  const after = (await (await app.request(`/runs/${runId}`)).json()) as { gates: unknown[] };
  assert.deepEqual(after.gates, []);
});
