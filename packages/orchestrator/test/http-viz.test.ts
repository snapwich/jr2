// Visualizer HTTP surface: the Machine-structure route delegates to `RunHost.machine`, and the
// `/viz/*` routes serve the page's shipped assets — including the vendored elkjs bundle resolved
// through this package's own dep edge (the length assertion pins that resolution under pnpm).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { codingDef, gatedDef, mkStore } from "./_fixtures.ts";
import type { MachineDoc } from "../src/machine-doc.ts";

/** The app with its host in hand — the observation routes need live runs to observe. */
async function mkLive() {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  host.register(gatedDef());
  return { host, app: createApp(host) };
}

async function mkApp() {
  return (await mkLive()).app;
}

test("GET /workflows/:name/machine serves the registered Machine's structure", async () => {
  const app = await mkApp();
  const res = await app.request("/workflows/coding/machine");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as MachineDoc;
  assert.equal(doc.workflow, "coding");
  assert.equal(doc.root.id, doc.id);
  assert.ok(doc.root.states.length > 0, "top-level states present");
  assert.ok(doc.transitions.length > 0, "transitions present");
});

test("GET /workflows/:name/machine on an unknown workflow is a 404", async () => {
  const app = await mkApp();
  const res = await app.request("/workflows/nope/machine");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no workflow "nope"' });
});

test("GET /viz/:name serves the page shell for any name", async () => {
  const app = await mkApp();
  for (const path of ["/viz/coding", "/viz/not-a-workflow"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /machine-svg/);
  }
});

// ---- Observation (`GET /workflows/:name/runs*`) ------------------------------------------------
// The page holds no token (it is a browser), so it reads runs through a PROJECTION rather than the
// operator's `/runs*`. These tests pin the line: scoped to one workflow, live runs only, context
// never crossing. `auth.test.ts` pins the other half — that `/runs*` itself stays shut.

test("GET /workflows/:name/runs lists that workflow's live runs, and no other's", async () => {
  const { host, app } = await mkLive();
  const { runId } = await host.start("coding", { sandbox: "ws-1" });
  await host.start("gated");

  const runs = (await (await app.request("/workflows/coding/runs")).json()) as Array<Record<string, unknown>>;
  assert.deepEqual(runs, [{ runId, workflow: "coding", status: "active", value: { active: "running" } }]);

  // Scoped server-side: asking about `coding` is not a listing of everything this orchestrator runs.
  const gated = (await (await app.request("/workflows/gated/runs")).json()) as Array<Record<string, unknown>>;
  assert.equal(gated.length, 1);
  assert.equal(gated[0]?.workflow, "gated");

  assert.deepEqual(await (await app.request("/workflows/nope/runs")).json(), [], "unknown workflow: nothing to see");
});

test("SSE: the observation feed streams state, never context", async () => {
  const { host, app } = await mkLive();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });

  const res = await app.request(`/workflows/coding/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  try {
    // A transition carrying a payload into context — `summary` lands in the run's context, and is
    // exactly the class of thing (a PR body, a branch, a verdict) this feed must not hand a browser.
    await app.request(`/agents/${instanceId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "request_review", summary: "SECRET-PR-BODY" }),
    });

    let buf = "";
    while (!buf.includes("review")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    assert.ok(buf.includes("review"), "the feed does carry where the run IS");
    assert.ok(!buf.includes("SECRET-PR-BODY"), "and never what it is carrying");
    for (const [, data] of buf.matchAll(/data: (.*)/g)) {
      const frame = JSON.parse(data ?? "{}") as Record<string, unknown>;
      assert.ok(!("context" in frame), "no status frame carries context");
      assert.ok(!("instanceId" in frame), "nor the live iid");
    }
  } finally {
    await reader.cancel();
  }
});

test("the observation feed is live runs of THIS workflow only", async () => {
  const { host, app } = await mkLive();
  const { runId } = await host.start("gated");

  // Right run, wrong workflow in the path → 404. (The operator's read-through to a SETTLED run's
  // terminal status is on `/runs/:id`, which stays the operator's.)
  const crossed = await app.request(`/workflows/coding/runs/${runId}/events`);
  assert.equal(crossed.status, 404);

  const unknown = await app.request("/workflows/coding/runs/nope/events");
  assert.equal(unknown.status, 404);
});

test("GET /viz/assets/* serves the page's script, styles, and the vendored elkjs bundle", async () => {
  const app = await mkApp();

  const js = await app.request("/viz/assets/main.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await js.text(), /workflows\/.*machine/);

  const css = await app.request("/viz/assets/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  const elk = await app.request("/viz/assets/elk.js");
  assert.equal(elk.status, 200);
  assert.match(elk.headers.get("content-type") ?? "", /text\/javascript/);
  assert.ok((await elk.text()).length > 100_000, "the bundled layout engine, not a stub");
});
