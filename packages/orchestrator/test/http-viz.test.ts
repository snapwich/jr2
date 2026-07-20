// Visualizer HTTP surface: the Machine-structure route delegates to `RunHost.machine`, and the
// `/viz/*` routes serve the page's shipped assets — including the vendored elkjs bundle resolved
// through this package's own dep edge (the length assertion pins that resolution under pnpm).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, emit } from "xstate";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { codingDef, gatedDef, mkStore, pipelineDef, waitFor } from "./_fixtures.ts";
import type { MachineDoc } from "../src/machine-doc.ts";

/** The app with its host in hand — the observation routes need live runs to observe. */
async function mkLive() {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  host.register(gatedDef());
  host.register(pipelineDef());
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
  assert.deepEqual(runs, [{ runId, workflow: "coding", status: "active", value: { active: "running" }, children: [] }]);

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

// ---- The WORKFLOW feed (`GET /workflows/:name/events`) -----------------------------------------
// One connection that outlives every run on it (ADR-0022). It is the same open band as the routes
// above, so the same two questions apply: does it carry where the runs ARE, and does it carry
// nothing of what they are carrying.

/** Read frames off an SSE body until `until` is satisfied (or the stream ends). */
async function readFrames(res: Response, until: (buf: string) => boolean): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!until(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return buf;
}

/** The `data:` payload of each frame of one event type. */
function framesOf(buf: string, event: string): Array<Record<string, any>> {
  return [...buf.matchAll(new RegExp(`event: ${event}\\ndata: (.*)`, "g"))].map((m) => JSON.parse(m[1] ?? "{}"));
}

test("the workflow feed opens with the current set, then carries runs that start later", async () => {
  const { host, app } = await mkLive();
  const first = await host.start("coding", { sandbox: "ws-1" });

  const res = await app.request("/workflows/coding/events");
  assert.equal(res.status, 200);

  // The opening frame is the whole current set — a page that just loaded is not missing anything.
  let buf = await readFrames(res, (b) => b.includes("event: runs"));
  const [runs] = framesOf(buf, "runs");
  assert.deepEqual(
    (runs as unknown as Array<Record<string, unknown>>).map((r) => r.runId),
    [first.runId],
  );

  // And a run started with the page already open arrives on its own — the entire point. There is no
  // re-fetch here and no ↻ button; this is the staleness the feed exists to remove.
  const res2 = await app.request("/workflows/coding/events");
  const second = await host.start("coding", { sandbox: "ws-2" });
  buf = await readFrames(res2, (b) => b.includes(second.runId));
  assert.ok(
    framesOf(buf, "status").some((f) => f.runId === second.runId),
    "a run that started after the subscribe arrives as a status frame",
  );
});

test("the workflow feed announces a run leaving, and never another workflow's runs", async () => {
  const { host, app } = await mkLive();
  const { runId } = await host.start("coding", { sandbox: "ws-1" });
  const res = await app.request("/workflows/coding/events");
  await readFrames(res, (b) => b.includes("event: runs"));

  const res2 = await app.request("/workflows/coding/events");
  await host.start("gated"); // a different workflow, moving at the same time
  await host.stop(runId);

  const buf = await readFrames(res2, (b) => b.includes("event: gone"));
  assert.deepEqual(framesOf(buf, "gone"), [{ runId }]);
  // `gone` is a FACT, not an inference: `stop()` leaves the stored status "live" for restore, so a
  // client watching for a terminal status would show this run as live forever.
  for (const frame of framesOf(buf, "status")) assert.equal(frame.workflow, "coding");
});

test("the workflow feed streams state, never context — the same line as the per-run feed", async () => {
  const { host, app } = await mkLive();
  const { instanceId } = await host.start("coding", { sandbox: "ws-1" });

  const res = await app.request("/workflows/coding/events");
  await app.request(`/agents/${instanceId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "request_review", summary: "SECRET-PR-BODY" }),
  });
  const buf = await readFrames(res, (b) => b.includes("review"));

  assert.ok(buf.includes("review"), "the feed does carry where the run IS");
  assert.ok(!buf.includes("SECRET-PR-BODY"), "and never what it is carrying");
  for (const [, data] of buf.matchAll(/data: (.*)/g)) {
    const frame = JSON.parse(data ?? "{}") as Record<string, unknown>;
    assert.ok(!("context" in frame), "no frame carries context");
    assert.ok(!("instanceId" in frame), "nor the live iid");
  }
});

test("the workflow feed carries the child tree at every depth, and no context at any of them", async () => {
  const { host, app, runId } = await mkPipelineRun();

  const res = await app.request("/workflows/pipeline/events");
  host.sendToGate(runId, "F-1", { type: "approve" });
  const buf = await readFrames(res, (b) => b.includes("shipped"));

  assert.ok(!buf.includes("SECRET-1"), "no child context on the wire");
  assert.ok(!buf.includes("SECRET-2"), "nor any sibling's");
  // The `runs` frame's payload is an ARRAY of observations; every other frame is one. Both get the
  // same walk — the opening snapshot is exactly as exposed as the deltas that follow it.
  const opening = (framesOf(buf, "runs")[0] ?? []) as unknown as Array<Record<string, any>>;
  for (const frame of [...framesOf(buf, "status"), ...opening]) {
    const walk = (children: Array<Record<string, unknown>>) => {
      for (const child of children) {
        assert.deepEqual(
          Object.keys(child).sort(),
          ["children", "id", "src", "status", "value"],
          "a child carries ids and keys — there is no context field to leak, at any depth",
        );
        walk(child.children as Array<Record<string, unknown>>);
      }
    };
    walk((frame.children ?? []) as Array<Record<string, unknown>>);
  }
});

test("an emit reaches the workflow feed as its type and run alone", async () => {
  // A workflow whose author emits a message with a PAYLOAD — the thing the projection must drop.
  const machine = setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "note"; message: string };
    },
  }).createMachine({
    id: "noisy",
    context: {},
    initial: "working",
    states: {
      working: { after: { 5: { target: "done", actions: emit({ type: "note", message: "SECRET-NOTE" }) } } },
      done: { type: "final" },
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "noisy", machine, provide: () => ({}) });
  const app = createApp(host);

  const res = await app.request("/workflows/noisy/events");
  const { runId } = await host.start("noisy");
  const buf = await readFrames(res, (b) => b.includes("event: emit"));

  // An emit's PAYLOAD is author data — the same class of thing as context. Only the type crosses.
  assert.deepEqual(framesOf(buf, "emit"), [{ runId, type: "note" }]);
  assert.ok(!buf.includes("SECRET-NOTE"), "the message itself is not the browser's business");
});

test("an unknown workflow attaches to an empty set rather than 404-ing", async () => {
  const app = await mkApp();
  const res = await app.request("/workflows/not-yet/events");
  assert.equal(res.status, 200);

  // Matching `/workflows/:name/runs`. The page is opened by path, and a `j2 dev` reload may register
  // the name a moment later — the already-open feed then just starts working.
  const buf = await readFrames(res, (b) => b.includes("event: runs"));
  assert.deepEqual(framesOf(buf, "runs"), [[]]);
});

test("a quiet feed still writes — the ping is what an idle intermediary needs to see", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const app = createApp(host, undefined, { pingMs: 5 });
  await host.start("gated"); // parks on a gate: zero transitions, so zero status frames

  const res = await app.request("/workflows/gated/events");
  // An SSE comment: every client ignores it, so it needs no place in the wire vocabulary.
  const buf = await readFrames(res, (b) => b.includes("\n:\n\n"));
  assert.ok(buf.includes("\n:\n\n"), "a parked run's feed keeps writing");
});

test("a client going away detaches its observer", async () => {
  const { host, app } = await mkLive();
  const res = await app.request("/workflows/coding/events");
  await readFrames(res, (b) => b.includes("event: runs"));

  // readFrames cancels the body on its way out, which aborts the request. A feed that did not
  // unsubscribe here would leak an observer per page load, invisibly, until the process died.
  await waitFor(() => host.observerCount("coding") === 0);
});

test("GET /viz/assets/* serves the page's script, styles, and the vendored elkjs bundle", async () => {
  const app = await mkApp();

  const js = await app.request("/viz/assets/main.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await js.text(), /workflows\/.*machine/);

  const store = await app.request("/viz/assets/store.js");
  assert.equal(store.status, 200);
  assert.match(store.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await store.text(), /applyFrame/);

  const css = await app.request("/viz/assets/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  const elk = await app.request("/viz/assets/elk.js");
  assert.equal(elk.status, 200);
  assert.match(elk.headers.get("content-type") ?? "", /text\/javascript/);
  assert.ok((await elk.text()).length > 100_000, "the bundled layout engine, not a stub");
});

// ---- Child machines: the observation surface carries the TREE, and still no context --------------
// A `pipeline` run is `coding`'s shape: the root parks in `discover` and the work happens two levels
// down, in spawned children whose context holds secrets. So the projection has to reach that far —
// and stop exactly as short.

/** A live pipeline run with both features spawned and both bodies invoked. */
async function mkPipelineRun() {
  const { host, app } = await mkLive();
  const { runId } = await host.start("pipeline");
  await waitFor(() => (host.status(runId)?.children[1]?.children.length ?? 0) > 0);
  return { host, app, runId };
}

test("GET /workflows/:name/runs carries each run's child tree, values and all", async () => {
  const { app } = await mkPipelineRun();
  const [run] = (await (await app.request("/workflows/pipeline/runs")).json()) as Array<Record<string, any>>;

  assert.equal(run!.value, "discover", "the root alone would say nothing about this run");
  assert.deepEqual(
    run!.children.map((c: any) => [c.id, c.value, c.children[0]?.value]),
    [
      ["F-1", "running", "coding"],
      ["F-2", "running", "coding"],
    ],
    "both instances, each with its own body — the page draws one subgraph per entry",
  );
});

test("SSE: a grandchild's transition reaches the observation feed, and its context does not", async () => {
  const { host, app, runId } = await mkPipelineRun();

  const res = await app.request(`/workflows/pipeline/runs/${runId}/events`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  try {
    // Two levels down: F-1's gate is registered by its BODY, whose context holds SECRET-1.
    host.sendToGate(runId, "F-1", { type: "approve" });

    let buf = "";
    while (!buf.includes("shipped")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    assert.ok(buf.includes("shipped"), "the feed does carry where the run IS — three levels deep");

    // Every secret planted in the tree, at every level. None of them are the browser's business.
    assert.ok(!buf.includes("SECRET-1"), "no child context on the wire");
    assert.ok(!buf.includes("SECRET-2"), "nor any sibling's");

    for (const [, data] of buf.matchAll(/data: (.*)/g)) {
      const frame = JSON.parse(data ?? "{}") as Record<string, unknown>;
      assert.ok(!("context" in frame), "no status frame carries context");
      const walk = (children: Array<Record<string, unknown>>) => {
        for (const child of children) {
          assert.deepEqual(
            Object.keys(child).sort(),
            ["children", "id", "src", "status", "value"],
            "a child carries ids and keys — there is no context field to leak, at any depth",
          );
          walk(child.children as Array<Record<string, unknown>>);
        }
      };
      walk((frame.children ?? []) as Array<Record<string, unknown>>);
    }
  } finally {
    await reader.cancel();
  }
});
