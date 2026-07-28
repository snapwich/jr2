// HTTP-surface tests (ADR-0009/0013): drive `createApp(host)` with `app.request(...)` (no socket)
// and prove each route delegates to the RunHost. Both delivery surfaces are exercised over the
// wire — `/agents/:iid/*` (what a Sandbox's Adapter calls) and `/runs/:id/gates/*` (what a human,
// a webhook or CI calls) — plus the SSE feed that observes what they do.
//
// These apps are built WITHOUT an authenticator, which leaves the surface open: that is the seam
// under test here. Who may call what is auth.test.ts's subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { KIT_VERSION } from "../src/config.ts";
import { codingDef, gatedDef, mkStore, waitFor } from "./_fixtures.ts";

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

test("GET /healthz reports up AND what this instance is — the CLI's only skew signal", async () => {
  const { app } = await mkApp();
  const health = await app.request("/healthz");
  assert.equal(health.status, 200);
  const body = (await health.json()) as { ok: boolean; version?: string; hash?: string };
  assert.equal(body.ok, true);
  assert.equal(body.version, KIT_VERSION);
  // No image to be addressed by (this is the `j2 dev` shape), so no hash — and that is not an error.
  assert.equal(body.hash, undefined);

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

test("the agent surface (ADR-0013): GET lists the turn's tools, POST delivers, then both are gone", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });

  // What the Adapter reads to build `tools/list`: names, input schemas (JSON Schema), semantics.
  const surface = await app.request(`/agents/${instanceId}/surface`);
  assert.equal(surface.status, 200);
  const menu = (await surface.json()) as {
    sandbox: string;
    accepts: Array<{ name: string; semantics: string; input: { properties?: Record<string, unknown> } }>;
  };
  assert.equal(menu.sandbox, "ws-1");
  assert.deepEqual(menu.accepts.map((a) => a.name).sort(), ["done", "request_review"]);
  const review = menu.accepts.find((a) => a.name === "request_review");
  assert.equal(review?.semantics, "ack");
  assert.ok(review?.input.properties?.summary, "the input schema is what the Adapter renders as the tool's");

  // What a `tools/call` becomes: a delivery, answered with a self-describing receipt (ADR-0024) —
  // addressable, and honest about whether the turn it belonged to is over.
  const call = await app.request(
    `/agents/${instanceId}/events`,
    jsonPost({ type: "request_review", summary: "PR up" }),
  );
  assert.equal(call.status, 200);
  const receipt = (await call.json()) as {
    delivered: boolean;
    event: string;
    turnComplete: boolean;
    deliveryId: string;
  };
  assert.ok(receipt.deliveryId);
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.event, "request_review");
  assert.equal(receipt.turnComplete, false, "the invoking state is still waiting — the turn continues");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  // A name this turn does not accept → 400 naming what it does. (Validation is the table's.)
  const bad = await app.request(`/agents/${instanceId}/events`, jsonPost({ type: "merge" }));
  assert.equal(bad.status, 400);

  // The run settles → the registration goes → the surface 404s. The one catch point.
  await app.request(`/agents/${instanceId}/events`, jsonPost({ type: "done" }));
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await app.request(`/agents/${instanceId}/surface`)).status, 404);
});

test("POST /runs/:id/events takes CANCEL, and nothing else", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding");

  // APPROVE and STEER rode the deferred/poll machinery, which ADR-0013 reserves without building.
  const approve = await app.request(`/runs/${runId}/events`, jsonPost({ type: "APPROVE" }));
  assert.equal(approve.status, 400);
  assert.match(((await approve.json()) as { error: string }).error, /accepts: CANCEL/);

  const cancel = await app.request(`/runs/${runId}/events`, jsonPost({ type: "CANCEL" }));
  assert.equal(cancel.status, 200);
  assert.equal(host.status(runId), undefined, "CANCEL abandons the run");
});

test("SSE: GET /runs/:id/events streams a status delta on transition", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding");

  const res = await app.request(`/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  try {
    // Drive a transition (running → review); the SSE feed should push its new status.
    await app.request(`/agents/${instanceId}/events`, jsonPost({ type: "request_review", summary: "PR up" }));

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

// ---- GET /runs/resolve (ADR-0009) ---------------------------------------------------------------
// The prefix→ids search the CLI's abbreviated run ids sit on. Ids only, never RunStatus: it keeps
// the scan index-only and holds down what the route reveals. The addressed routes below it stay
// full-id — resolution is a separate, read-only step precisely so no WRITE is prefix-sensitive.

test("GET /runs/resolve answers the ids sharing a prefix — and nothing else about them", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding");

  const res = await app.request(`/runs/resolve?prefix=${runId.slice(0, 8)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { prefix: string; runIds: string[]; truncated: boolean };
  assert.deepEqual(body.runIds, [runId]);
  assert.equal(body.prefix, runId.slice(0, 8));
  assert.equal(body.truncated, false);
  assert.deepEqual(Object.keys(body).sort(), ["prefix", "runIds", "truncated"], "no status, no context, no gates");
});

test("GET /runs/resolve: a prefix under the floor is refused, an unmatched one is simply empty", async () => {
  const { app } = await mkApp();

  assert.equal((await app.request("/runs/resolve?prefix=ab")).status, 400, "a 2-char prefix is a scan, not a question");
  assert.equal((await app.request("/runs/resolve")).status, 400, "and so is no prefix at all");

  const none = await app.request("/runs/resolve?prefix=zzzzzzzz");
  assert.equal(none.status, 200, "no match is an empty answer, not an error");
  assert.deepEqual(((await none.json()) as { runIds: string[] }).runIds, []);
});

test("GET /runs/resolve truncates rather than dumping the table", async () => {
  // 11 runs sharing a prefix: one past the cap, which is what flips `truncated`.
  const store = await mkStore();
  for (let i = 0; i < 11; i++) await store.save(`abcd${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`, {});
  const app = createApp(new RunHost({ store }));

  const res = await app.request("/runs/resolve?prefix=abcd");
  const body = (await res.json()) as { runIds: string[]; truncated: boolean };
  assert.equal(body.runIds.length, 10);
  assert.equal(body.truncated, true);
});
