// HTTP-surface tests (ADR-0009/0013): drive `createApp(host)` with `app.request(...)` (no socket)
// and prove each route delegates to the RunHost. Both delivery surfaces are exercised over the
// wire — `/agents/:iid/*` (what a Sandbox's Harness calls, through its Custodian) and `/runs/:id/gates/*` (what a human,
// a webhook or CI calls) — plus the SSE feed that observes what they do.
//
// These apps are built WITHOUT an authenticator, which leaves the surface open: that is the seam
// under test here. Who may call what is auth.test.ts's subject.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "xstate";
import { RunHost } from "../src/run-host.ts";
import { DISPATCHED_BY_HEADER } from "../src/registration.ts";
import { createApp } from "../src/http.ts";
import { KIT_VERSION } from "../src/config.ts";
import type { RepoStatus } from "../src/repos.ts";
import { admittedIid, codingDef, gatedDef, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartHash, type ChartText } from "../src/chart.ts";
import { NamedCharts } from "../src/charts.ts";
import { chartedSrc, machineOf, reviewLoop } from "./_assembly.ts";

/** A host + app pair with the `coding` workflow registered. */
async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  const clients = new Map<string, MockFlueClient>();
  host.register(codingDef(clients));
  return { host, app: createApp(host), clients };
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
  // No publish door here, so no current Assembly to report (ADR-0069) — and that is not an error.
  assert.equal(body.hash, undefined);

  const ready = await app.request("/readyz");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
});

test("an app with no publish door: GET /assembly reports none, PUT /assembly is 404 (ADR-0069)", async () => {
  const { app } = await mkApp();
  assert.deepEqual(await (await app.request("/assembly")).json(), { kitVersion: KIT_VERSION, current: null, held: [] });
  assert.equal((await app.request("/assembly", { method: "PUT" })).status, 404);
});

test("GET /workflows lists registered workflows", async () => {
  const { app } = await mkApp();
  const res = await app.request("/workflows");
  assert.equal(res.status, 200);
  // Each entry is a listing with its origin (ADR-0070); `coding` declares no Open body.
  const listing = (await res.json()) as Array<{ name: string; origin: string; wrapper?: unknown }>;
  assert.deepEqual(
    listing.map((w) => [w.name, w.origin, w.wrapper]),
    [["coding", "machine", undefined]],
  );
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
  const { host, app, clients } = await mkApp();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });
  // The Harness is handed its iid; jr2 minted it (ADR-0057), so the test reads it off the
  // admission rather than inventing one — and addresses it the way the Harness does, encoded,
  // because a minted id carries the path separators its structure is made of.
  const iid = await admittedIid(clients.get(instanceId)!);

  // What the Harness reads to build its Menu: names, input schemas (JSON Schema), semantics.
  const surface = await app.request(`/agents/${encodeURIComponent(iid)}/surface`);
  assert.equal(surface.status, 200);
  const menu = (await surface.json()) as {
    sandbox: string;
    menu: Array<{ name: string; semantics: string; input: { properties?: Record<string, unknown> } }>;
    allowed: string[];
  };
  assert.equal(menu.sandbox, "ws-1");
  assert.deepEqual(
    menu.menu.map((a) => a.name),
    ["done", "request_review"],
  );
  assert.deepEqual(menu.allowed, ["done", "request_review"], "the Allowed picks beside the Menu (ADR-0029)");
  const review = menu.menu.find((a) => a.name === "request_review");
  assert.equal(review?.semantics, "ack");
  assert.ok(review?.input.properties?.summary, "the input schema is what the Harness offers as the tool's parameters");

  // What a `tools/call` becomes: a delivery, answered with a self-describing receipt (ADR-0024) —
  // addressable, and honest about whether the turn it belonged to is over.
  const call = await app.request(
    `/agents/${encodeURIComponent(iid)}/events`,
    jsonPost({ type: "request_review", summary: "PR up" }),
  );
  assert.equal(call.status, 200);
  const receipt = (await call.json()) as {
    delivered: boolean;
    event: string;
    turnComplete: boolean;
    deliveryId: string;
    allowed: string[];
  };
  assert.ok(receipt.deliveryId);
  assert.deepEqual(receipt.allowed, ["done"], "the receipt carries the Allowed picks after the delivery");
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.event, "request_review");
  assert.equal(receipt.turnComplete, false, "the invoking state is still waiting — the turn continues");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  // A name this turn does not accept → 400 naming what it does. (Validation is the table's.)
  const bad = await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "merge" }));
  assert.equal(bad.status, 400);
  // …and names the Allowed picks, read after the refusal (ADR-0029): the guard closed on review.
  assert.deepEqual(((await bad.json()) as { allowed?: string[] }).allowed, ["done"]);

  // The run settles → the registration goes → the surface 404s. The one catch point.
  await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "done" }));
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await app.request(`/agents/${encodeURIComponent(iid)}/surface`)).status, 404);
});

test("while the host is stopping, /agents/* answers 503 — only a Turn that is over answers 404 (ADR-0026)", async () => {
  const { host, app, clients } = await mkApp();
  const { instanceId } = await host.start("coding", { sandbox: "ws-1" });
  const iid = await admittedIid(clients.get(instanceId)!);
  const unknown = "no-such-turn";
  assert.equal((await app.request(`/agents/${unknown}/surface`)).status, 404, "before: a Turn that is over");

  // The Orchestrator is going away, not the Turn: the Harness re-asks a surface read on 503, and a
  // pick in the window is told to try again — never "this turn is over".
  await host.close();
  const surface = await app.request(`/agents/${encodeURIComponent(iid)}/surface`);
  assert.equal(surface.status, 503);
  assert.match(((await surface.json()) as { error: string }).error, /stopping/);
  const pick = await app.request(`/agents/${encodeURIComponent(iid)}/events`, jsonPost({ type: "done" }));
  assert.equal(pick.status, 503);
  assert.equal((await app.request(`/agents/${unknown}/surface`)).status, 503, "no registration reads as 404 no more");
});

test("a surface read that is answered tells the host the Turn is in the Harness's hands (ADR-0026, ADR-0062)", async () => {
  const { host, app, clients } = await mkApp();
  const { instanceId } = await host.start("coding", { sandbox: "ws-1" });
  const iid = await admittedIid(clients.get(instanceId)!);
  const served: string[] = [];
  host.agentSurfaceServed = (id) => void served.push(id);

  // A read that is refused serves nothing.
  assert.equal((await app.request(`/agents/no-such-turn/surface`)).status, 404);
  assert.deepEqual(served, []);
  // The read that is answered is the one the Harness prompts from: its notices reach a model now.
  assert.equal((await app.request(`/agents/${encodeURIComponent(iid)}/surface`)).status, 200);
  assert.deepEqual(served, [iid]);
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

test("POST /runs/:id/events: CANCEL carries `keep` to the host, and refuses one that is not a boolean (ADR-0025)", async () => {
  const { host, app } = await mkApp();
  const seen: Array<{ keep?: boolean }> = [];
  const cancel = host.cancel.bind(host);
  host.cancel = async (id, opts) => {
    seen.push(opts ?? {});
    return cancel(id, opts);
  };

  const a = await host.start("coding");
  const bad = await app.request(`/runs/${a.runId}/events`, jsonPost({ type: "CANCEL", keep: "yes" }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /"keep" must be a boolean/);
  assert.deepEqual(seen, [], "a refused body cancels nothing");
  assert.ok(host.status(a.runId), "the run is still live");

  assert.equal((await app.request(`/runs/${a.runId}/events`, jsonPost({ type: "CANCEL", keep: true }))).status, 200);
  const b = await host.start("coding");
  assert.equal((await app.request(`/runs/${b.runId}/events`, jsonPost({ type: "CANCEL" }))).status, 200);
  assert.deepEqual(seen, [{ keep: true }, { keep: false }]);
});

test("SSE: GET /runs/:id/events streams a status delta on transition", async () => {
  const { host, app, clients } = await mkApp();
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  const res = await app.request(`/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  try {
    // Drive a transition (running → review); the SSE feed should push its new status.
    await app.request(
      `/agents/${encodeURIComponent(iid)}/events`,
      jsonPost({ type: "request_review", summary: "PR up" }),
    );

    // The feed replays the current status on attach (value "running"), then pushes the review
    // delta — and the pick's Turn marker (ADR-0023) rides this feed too, mentioning
    // "request_review" before any status does. So wait on, and scan, STATUS frames alone.
    const statusValues = (buf: string): unknown[] =>
      [...buf.matchAll(/event: status\ndata: (.*)/g)].map(
        (m) => (JSON.parse(m[1] ?? "{}") as { value: unknown }).value,
      );

    let buf = "";
    while (!statusValues(buf).some((v) => JSON.stringify(v).includes("review"))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    const values = statusValues(buf);
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

test("GET /repos serves the data-plane switch and the Repos as the cluster reports them (ADR-0051)", async () => {
  // ADR-0048's observability half, on ADR-0051's shape: the cache agent keeps retrying on its
  // own, so this is read per request off the port, never a boot-time snapshot. An instance
  // without a data plane (what `mkApp` builds) answers `{ dataPlane: false, repos: [] }` rather
  // than 404 — "no Workspace runs here" is an answer.
  const host = new RunHost({ store: await mkStore() });
  const state: RepoStatus[] = [
    {
      key: "app-0123abcd",
      url: "git@github.com:acme/app.git",
      identity: "github.com/acme/app",
      bound: true,
      nodes: [{ node: "n1", present: false, synced: false, lastError: "Permission denied (publickey)." }],
    },
  ];
  const app = createApp(host, undefined, { dataPlane: true, repos: async () => state });

  const res = await app.request("/repos");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dataPlane: true, repos: state });

  // Mutating the port's answer (a clone that finally succeeded) shows on the NEXT read.
  state[0] = { ...state[0]!, nodes: [{ node: "n1", present: true, synced: true }] };
  const after = (await (await app.request("/repos")).json()) as { repos: RepoStatus[] };
  assert.equal(after.repos[0]!.nodes[0]!.present, true);

  const none = await (await mkApp()).app.request("/repos");
  assert.deepEqual(await none.json(), { dataPlane: false, repos: [] });
});

test("SSE: GET /runs/:id/events on a PARKED run streams its status, then `gone` (ADR-0022, ADR-0025)", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding");
  // Stopped, not settled: the stored row stays `live` for the next restore, the live registry
  // drops it, and the read-through answers the Machine's `active` — which says nothing about the
  // feed. `gone` does: this end is the run's own, so a re-attaching reader stops here.
  await host.stop(runId);
  assert.equal(host.status(runId), undefined);

  const res = await app.request(`/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const body = await res.text();
  const events = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, ["status", "gone"]);
  assert.match(body, /event: status\ndata: .*"status":"active"/);
  assert.match(body, new RegExp(`event: gone\\ndata: \\{"runId":"${runId}"\\}`));
});

// ---- Named Charts (ADR-0070) ------------------------------------------------------------------

/** A host with the Chart wrapper `charted`, the plain `coding`, and the in-Machine-only wrapper
 * `inner` registered, and the named-Chart registry bound to them over a fresh volume. */
const chartHosts: RunHost[] = [];
// A Chart run's body arms its wall-clock ceiling, which a stop (a park) leaves armed: each Chart run
// is cancelled, and each host closed, at the end.
after(() =>
  Promise.all(
    chartHosts.map(async (h) => {
      for (const r of h.list()) await h.cancel(r.runId, { keep: false }).catch(() => {});
      await h.close();
    }),
  ),
);

async function mkChartApp() {
  const host = new RunHost({ store: await mkStore() });
  chartHosts.push(host);
  const clients = new Map<string, MockFlueClient>();
  host.register(codingDef(clients));
  const charted = await machineOf(chartedSrc());
  const inner = await machineOf(chartedSrc({ id: "inner", door: false }));
  host.register({ name: "charted", machine: charted, provide: () => ({}) });
  host.register({ name: "inner", machine: inner, provide: () => ({}) });
  const dir = await mkdtemp(join(tmpdir(), "jr2-http-charts-"));
  const charts = new NamedCharts({ dir, host });
  const workflows = [
    { name: "charted", machine: charted },
    { name: "inner", machine: inner },
    { name: "coding", machine: codingDef(clients).machine },
  ];
  charts.bind({ workflows, files: [] });
  return { host, app: createApp(host, undefined, { charts }), charts, dir, workflows };
}

const jsonPut = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** A closed loopback port: an Agent the Chart invokes faults at once, which no assertion reads. */
const NO_HARNESS = "http://127.0.0.1:9";

test("GET /workflows/:wrapper/chart-schema is the grammar narrowed to the Open body; 404 for a non-wrapper", async () => {
  const { app } = await mkChartApp();
  const res = await app.request("/workflows/charted/chart-schema");
  assert.equal(res.status, 200);
  const schema = (await res.json()) as {
    properties: { agents: { additionalProperties: { properties: Record<string, { enum?: unknown[] }> } } };
    $defs: {
      "jr2.ChartInvoke": { properties: { src: { anyOf: Array<{ enum?: unknown[] }> } } };
      "jr2.ChartGuard": { anyOf: Array<{ enum?: unknown[]; properties?: { type?: { enum?: unknown[] } } }> };
    };
  };
  // Each lent or allowed name is an `enum` where the grammar takes it, not only a word in the text.
  const agent = schema.properties.agents.additionalProperties.properties;
  assert.deepEqual(agent.model?.enum, ["stub/model"]);
  assert.deepEqual(agent.workspace?.enum, ["none", "write"]);
  assert.ok(schema.$defs["jr2.ChartInvoke"].properties.src.anyOf[0]!.enum!.includes("coder"), "a lent src");
  assert.deepEqual(schema.$defs["jr2.ChartGuard"].anyOf[0]!.enum, ["underLimit"]);
  assert.deepEqual(schema.$defs["jr2.ChartGuard"].anyOf.find((g) => g.properties?.type?.enum)?.properties?.type?.enum, [
    "underLimit",
  ]);
  assert.equal((await app.request("/workflows/coding/chart-schema")).status, 404);
  assert.equal((await app.request("/workflows/nope/chart-schema")).status, 404);
});

test("PUT /workflows/:wrapper/charts/:name: 201, then 200 replacing; 400, 404, 409 and 422 by cause", async () => {
  const { app, dir } = await mkChartApp();
  const text = await reviewLoop();
  const created = await app.request("/workflows/charted/charts/loop", jsonPut(text));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    name: "charted/loop",
    origin: "runtime",
    hash: chartHash(text as ChartText),
  });
  assert.ok(existsSync(join(dir, ".jr2", "charts", "charted", "loop.chart.json")), "kept on the volume");
  assert.equal((await app.request("/workflows/charted/charts/loop", jsonPut(text))).status, 200);

  assert.equal((await app.request("/workflows/charted/charts/Bad_Name", jsonPut(text))).status, 400);
  // A name too long for a file name is a bad name, never the volume's 500.
  assert.equal((await app.request(`/workflows/charted/charts/${"a".repeat(300)}`, jsonPut(text))).status, 400);
  assert.equal((await app.request(`/workflows/charted/charts/${"a".repeat(64)}`, jsonPut(text))).status, 400);
  assert.equal((await app.request(`/workflows/charted/charts/${"a".repeat(63)}`, jsonPut(text))).status, 201);
  assert.equal((await app.request("/workflows/nope/charts/loop", jsonPut(text))).status, 404);
  const noDoor = await app.request("/workflows/inner/charts/loop", jsonPut(text));
  assert.equal(noDoor.status, 409);
  assert.match(((await noDoor.json()) as { error: string }).error, /no Chart door/);
  const noWrapper = await app.request("/workflows/coding/charts/loop", jsonPut(text));
  assert.equal(noWrapper.status, 409);
  assert.match(((await noWrapper.json()) as { error: string }).error, /no Chart wrapper/);

  const refused = await app.request("/workflows/charted/charts/bad", jsonPut({ ...text, initial: "nowhere" }));
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string; report: string[] };
  assert.equal(body.error, "refused");
  assert.ok(body.report.length > 0);
  const notJson = await app.request("/workflows/charted/charts/bad", jsonPut("{ nope"));
  assert.equal(notJson.status, 422);
  assert.match(((await notJson.json()) as { report: string[] }).report[0]!, /not JSON/);
});

test("DELETE /workflows/:wrapper/charts/:name: 204, then 404; a Chart file is 409", async () => {
  const { app, charts, workflows } = await mkChartApp();
  const text = await reviewLoop();
  await app.request("/workflows/charted/charts/loop", jsonPut(text));
  assert.equal((await app.request("/workflows/charted/charts/loop", { method: "DELETE" })).status, 204);
  assert.equal((await app.request("/workflows/charted/charts/loop", { method: "DELETE" })).status, 404);
  // A name or a wrapper no file can have is "no such Chart", never the volume's 500.
  const del = (path: string) => Promise.resolve(app.request(path, { method: "DELETE" })).then((r) => r.status);
  assert.equal(await del(`/workflows/charted/charts/${"a".repeat(300)}`), 404);
  assert.equal(await del("/workflows/a%00b/charts/x"), 404);
  assert.equal(await del(`/workflows/${"w".repeat(300)}/charts/x`), 404);
  charts.bind({
    workflows,
    files: [{ wrapper: "charted", name: "sample", path: "workflows/charted/sample.chart.json", text }],
  });
  const file = await app.request("/workflows/charted/charts/sample", { method: "DELETE" });
  assert.equal(file.status, 409);
  assert.match(((await file.json()) as { error: string }).error, /Instance's own/);
});

test("GET /workflows lists each wrapper with its Charts inside its entry, with origins", async () => {
  const { app, charts, workflows } = await mkChartApp();
  const text = await reviewLoop();
  await app.request("/workflows/charted/charts/loop", jsonPut(text));
  charts.bind({
    workflows,
    files: [{ wrapper: "charted", name: "sample", path: "workflows/charted/sample.chart.json", text }],
  });
  const listing = (await (await app.request("/workflows")).json()) as Array<{
    name: string;
    origin: string;
    wrapper?: { body: string; oneShot: boolean; charts: Array<{ name: string; origin: string }> };
  }>;
  const charted = listing.find((w) => w.name === "charted");
  assert.equal(charted?.origin, "machine");
  assert.equal(charted?.wrapper?.body, "body");
  assert.equal(charted?.wrapper?.oneShot, true);
  assert.deepEqual(
    charted?.wrapper?.charts.map((c) => [c.name, c.origin]),
    [
      ["loop", "runtime"],
      ["sample", "file"],
    ],
  );
  assert.equal(listing.find((w) => w.name === "inner")?.wrapper?.oneShot, false, "no Chart field, so no one-shot");
  assert.equal(listing.find((w) => w.name === "coding")?.wrapper, undefined);
  assert.ok(
    !listing.some((w) => w.name.includes("/")),
    "a runnable named Chart lists inside its wrapper, not beside it",
  );
});

test("a named Chart starts by its documented route and by its encoded name, with the rest of the door", async () => {
  const { host, app } = await mkChartApp();
  await app.request("/workflows/charted/charts/loop", jsonPut(await reviewLoop()));
  const detail = await app.request("/workflows/charted%2Floop");
  assert.equal(detail.status, 200);
  const doc = (await detail.json()) as {
    name: string;
    input: { properties: Record<string, unknown> };
    chart: { origin: string; hash: string };
  };
  assert.equal(doc.name, "charted/loop");
  assert.deepEqual(Object.keys(doc.input.properties).sort(), ["endpoint", "task"], "the door minus its Chart field");
  assert.equal(doc.chart.origin, "runtime");

  for (const path of ["/workflows/charted/charts/loop/runs", "/workflows/charted%2Floop/runs"]) {
    const res = await app.request(path, jsonPost({ endpoint: NO_HARNESS, task: "add a test" }));
    assert.equal(res.status, 201, path);
    const { runId } = (await res.json()) as { runId: string };
    assert.equal(host.status(runId)?.workflow ?? (await host.read(runId))?.workflow, "charted/loop");
  }
  const bad = await app.request("/workflows/charted/charts/loop/runs", jsonPost({ task: "no endpoint" }));
  assert.equal(bad.status, 400, "the rest of the door is the wrapper's, checked as ever");
});

test("a named Chart that cannot run now is listed with why, and its start is 409", async () => {
  const { host, app, charts } = await mkChartApp();
  await app.request("/workflows/charted/charts/loop", jsonPut(await reviewLoop()));
  const dropped = await machineOf(chartedSrc({ lendCoder: false }));
  host.register({ name: "charted", machine: dropped, provide: () => ({}) });
  charts.bind({ workflows: [{ name: "charted", machine: dropped }], files: [] });
  const res = await app.request("/workflows/charted/charts/loop/runs", jsonPost({ endpoint: NO_HARNESS, task: "t" }));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /cannot run: Chart refused: .*coder/);
  const listing = (await (await app.request("/workflows")).json()) as Array<{
    name: string;
    wrapper?: { charts: Array<{ name: string; unrunnable?: string }> };
  }>;
  const loop = listing.find((w) => w.name === "charted")?.wrapper?.charts.find((c) => c.name === "loop");
  assert.match(loop?.unrunnable ?? "", /coder/);
  // Its detail and its Machine answer why, as its start does: never a 404 for a listed name.
  for (const path of ["/workflows/charted%2Floop", "/workflows/charted%2Floop/machine"]) {
    const got = await app.request(path);
    assert.equal(got.status, 409, path);
    const body = (await got.json()) as { unrunnable: string; chart: { origin: string } };
    assert.match(body.unrunnable, /coder/, path);
    assert.equal(body.chart.origin, "runtime");
  }
});

test("the one-shot door: a Chart field the door refuses is 422 with the report, before any run", async () => {
  const { host, app } = await mkChartApp();
  const before = host.list().length;
  const text = await reviewLoop();
  const res = await app.request(
    "/workflows/charted/runs",
    jsonPost({
      endpoint: NO_HARNESS,
      task: "t",
      chart: { ...text, states: { ...(text.states as object), draft: { invoke: { src: "linter" } } } },
    }),
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error: string; report: string[] };
  assert.equal(body.error, "refused");
  assert.match(body.report.join("\n"), /linter/);
  assert.equal(host.list().length, before, "nothing started");
});

test("GET /workflows/:name/runs/:runId/machine: the run's bound Machine; 404 for an unknown run", async () => {
  const { app } = await mkChartApp();
  const res = await app.request(
    "/workflows/charted/runs",
    jsonPost({ endpoint: NO_HARNESS, task: "t", chart: await reviewLoop() }),
  );
  assert.equal(res.status, 201);
  const { runId } = (await res.json()) as { runId: string };
  const doc = await app.request(`/workflows/charted/runs/${runId}/machine`);
  assert.equal(doc.status, 200);
  const text = JSON.stringify(await doc.json());
  for (const state of ["draft", "review", "shipped"]) assert.ok(text.includes(`"${state}"`), state);
  assert.equal((await app.request("/workflows/charted/runs/nope/machine")).status, 404);
  // Only through the Workflow the run is of, as the per-run feed (open band).
  assert.equal((await app.request(`/workflows/coding/runs/${runId}/machine`)).status, 404);
  assert.equal((await app.request(`/workflows/other/runs/${runId}/machine`)).status, 404);
});

// ---- The idempotency key at the door (ADR-0071) -------------------------------------------------

/** A foreign caller's `jr2-dispatched-by`, by its ledger row id. */
const dispatchedBy = (effect: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ run: "caller-run", slot: "review", effect, depth: 1, instance: "ops-instance", ...extra });

const dispatchPost = (body: unknown, header: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", [DISPATCHED_BY_HEADER]: header },
  body: JSON.stringify(body),
});

test("a start with jr2-dispatched-by is 201, and its repeat 200 `existing` with the same run, on both start routes (ADR-0071)", async () => {
  const { host, app } = await mkChartApp();
  host.register(gatedDef());
  const first = await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-1")));
  assert.equal(first.status, 201);
  const started = (await first.json()) as { runId: string; instanceId: string; existing?: boolean };
  assert.equal(started.existing, undefined, "a new run says nothing of a key");
  const again = await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-1")));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { runId: started.runId, instanceId: started.instanceId, existing: true });
  assert.equal(host.list().filter((s) => s.workflow === "gated").length, 1, "one run");
  // Another key is another run; no header is a start as ever.
  assert.equal((await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-2")))).status, 201);
  assert.equal((await app.request("/workflows/gated/runs", jsonPost({}))).status, 201);
  assert.equal(host.list().filter((s) => s.workflow === "gated").length, 3);

  await app.request("/workflows/charted/charts/loop", jsonPut(await reviewLoop()));
  const body = { endpoint: NO_HARNESS, task: "add a test" };
  const chart = await app.request("/workflows/charted/charts/loop/runs", dispatchPost(body, dispatchedBy("k-c")));
  assert.equal(chart.status, 201);
  const { runId } = (await chart.json()) as { runId: string };
  const repeat = await app.request("/workflows/charted%2Floop/runs", dispatchPost(body, dispatchedBy("k-c")));
  assert.equal(repeat.status, 200, "the encoded route is the same door");
  assert.equal(((await repeat.json()) as { runId: string }).runId, runId);
});

test("a key a run of another Workflow carries is 409 naming both, never that run answered `existing` (ADR-0071)", async () => {
  const { host, app } = await mkApp();
  host.register(gatedDef());
  host.register({
    name: "quick",
    machine: setup({}).createMachine({ id: "quick", initial: "done", states: { done: { type: "final" } } }),
    provide: () => ({}),
  });
  const first = await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-shared")));
  assert.equal(first.status, 201);
  const { runId } = (await first.json()) as { runId: string };
  const other = await app.request("/workflows/quick/runs", dispatchPost({}, dispatchedBy("k-shared")));
  assert.equal(other.status, 409);
  const { error } = (await other.json()) as { error: string };
  assert.match(error, new RegExp(`run ${runId} of "gated", not of "quick"`));
  assert.equal(host.list().filter((s) => s.workflow === "quick").length, 0, "nothing of the other Workflow ran");
});

test("a start that throws a defect is 500, not 404: a foreign caller reads 404 as nothing started (ADR-0071)", async () => {
  const { host, app } = await mkApp();
  host.register(gatedDef());
  host.start = async () => {
    throw new Error("spawn failed after the key check");
  };
  const res = await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-defect")));
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /spawn failed/);
  // A name no Workflow has is still the 404.
  const { app: plain } = await mkApp();
  assert.equal((await plain.request("/workflows/nowhere/runs", jsonPost({}))).status, 404);
});

test("a jr2-dispatched-by that does not parse, or names no instance, is 400 naming the header (ADR-0071)", async () => {
  const { host, app } = await mkApp();
  host.register(gatedDef());
  for (const header of [
    "not json",
    JSON.stringify({ run: "c", slot: "s", effect: "k", depth: 1 }),
    dispatchedBy("k", { depth: 0 }),
    dispatchedBy(""),
  ]) {
    const res = await app.request("/workflows/gated/runs", dispatchPost({}, header));
    assert.equal(res.status, 400, header);
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /jr2-dispatched-by/, header);
  }
  assert.deepEqual(
    host.list().filter((s) => s.workflow === "gated"),
    [],
    "a refused header starts nothing",
  );
});

test("GET /runs/:id serves a dispatched run's dispatchedBy and, once settled, its output; the open band drops the key (ADR-0071)", async () => {
  const { host, app } = await mkApp();
  host.register(gatedDef());
  host.register({
    name: "quick",
    machine: setup({}).createMachine({
      id: "quick",
      initial: "done",
      states: { done: { type: "final" } },
      output: () => ({ answer: 42 }),
    }),
    provide: () => ({}),
  });
  const res = await app.request("/workflows/quick/runs", dispatchPost({}, dispatchedBy("k-q")));
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(() => host.status(runId) === undefined);
  let status = (await (await app.request(`/runs/${runId}`)).json()) as Record<string, unknown>;
  for (let i = 0; i < 50 && status.status !== "done"; i++) {
    await new Promise((r) => setTimeout(r, 5));
    status = (await (await app.request(`/runs/${runId}`)).json()) as Record<string, unknown>;
  }
  assert.equal(status.status, "done");
  assert.deepEqual(status.output, { answer: 42 });
  assert.deepEqual(status.dispatchedBy, {
    run: "caller-run",
    slot: "review",
    effect: "k-q",
    depth: 1,
    instance: "ops-instance",
  });

  // A live run serves no output; the open band carries its routing and never its key.
  const live = await app.request("/workflows/gated/runs", dispatchPost({}, dispatchedBy("k-g")));
  const gated = (await live.json()) as { runId: string };
  const liveStatus = (await (await app.request(`/runs/${gated.runId}`)).json()) as Record<string, unknown>;
  assert.equal("output" in liveStatus, false);
  const observed = (await (await app.request("/workflows/gated/runs")).json()) as Array<Record<string, unknown>>;
  const row = observed.find((o) => o.runId === gated.runId);
  assert.deepEqual(row?.dispatchedBy, { run: "caller-run", slot: "review", depth: 1, instance: "ops-instance" });
  assert.ok(!JSON.stringify(observed).includes("k-g"), "the key stays behind the token");
});
