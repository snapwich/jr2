// The wire, socket-free (ADR-0027): `app.request()` against the five routes, shaped on the stub
// Harness with the one documented divergence (GET on an unknown conversation is 404; POST
// creates; abort answers `{ aborted: false }`). Turn execution is stubbed through the injected
// factory, so nothing here touches pi, a provider, or a socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessApp, type HarnessAppDeps } from "../src/app.ts";
import type { AgentDefinition } from "../src/spec.ts";
import type { AdmissionRequest, Settlement, StreamEvent } from "../src/wire.ts";

/** The definition every admission here carries (ADR-0049) — the Machine's slot, on the wire. */
const CODER: AgentDefinition = { model: "faux/model", instructions: "code" };

type ScriptedRun = {
  message: string;
  /** The whole admitted request, so a test can assert which dials framed the turn. */
  submission: AdmissionRequest;
  resolve: () => void;
  reject: (err: unknown) => void;
};

/** The app over a scripted turn executor: each running Submission parks until the test settles
 * it; the abort signal rejects it, promptly, the way a real turn winds down. */
function scripted(overrides?: Partial<HarnessAppDeps>) {
  const runs: ScriptedRun[] = [];
  const app = harnessApp({
    longPollMs: 25,
    runSubmissionFor: () => (submission, signal) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ message: submission.message, submission, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("swept")), { once: true });
      }),
    ...overrides,
  });
  return { app, runs };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function admit(
  app: ReturnType<typeof harnessApp>,
  path: string,
  message = "go",
  definition: AgentDefinition = CODER,
) {
  const res = await app.request(path, {
    method: "POST",
    body: JSON.stringify({ message, definition }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { streamUrl: string; offset: string; submissionId: string };
}

test("admission: POST answers the three-string handle immediately", async () => {
  const { app, runs } = scripted();
  const admission = await admit(app, "/agents/coder/i1", "one");
  assert.equal(admission.streamUrl, "http://localhost/agents/coder/i1");
  assert.equal(admission.offset, "0");
  assert.ok(admission.submissionId.length > 0);
  assert.equal(runs[0]?.message, "one");
});

test("updates: 200 JSON array with the stream headers", async () => {
  const { app } = scripted();
  await admit(app, "/agents/coder/i1");
  const res = await app.request("/agents/coder/i1?offset=0&view=updates");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("stream-next-offset"), "0");
  assert.equal(res.headers.get("stream-up-to-date"), "true");
  assert.deepEqual(await res.json(), []);
});

test("long-poll: parks, then 204 with the same headers on timeout", async () => {
  const { app } = scripted();
  await admit(app, "/agents/coder/i1");
  const res = await app.request("/agents/coder/i1?offset=0&live=long-poll");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("stream-next-offset"), "0");
  assert.equal(res.headers.get("stream-up-to-date"), "true");
});

test("long-poll: a settlement wakes a parked poll before the timeout", async () => {
  const { app, runs } = scripted({ longPollMs: 5_000 });
  const admission = await admit(app, "/agents/coder/i1");
  const parked = app.request("/agents/coder/i1?offset=0&live=long-poll");
  await flush();
  runs[0]!.resolve();
  const res = await parked;
  assert.equal(res.status, 200);
  const events = (await res.json()) as StreamEvent[];
  assert.deepEqual(events, [
    {
      type: "submission-settled",
      conversationId: "i1",
      position: { batch: 0, index: 0 },
      submissionId: admission.submissionId,
      outcome: "completed",
    },
  ]);
  assert.equal(res.headers.get("stream-next-offset"), "1");
});

test("abort: sweeps active + queued, history settles all aborted in admission order", async () => {
  const { app, runs } = scripted();
  const admissions = [
    await admit(app, "/agents/coder/i2", "one"),
    await admit(app, "/agents/coder/i2", "two"),
    await admit(app, "/agents/coder/i2", "three"),
  ];
  assert.equal(runs.length, 1); // accept-and-queue: only the first runs

  const aborted = await app.request("/agents/coder/i2/abort", { method: "POST" });
  assert.equal(aborted.status, 200);
  assert.deepEqual(await aborted.json(), { aborted: true });

  const history = await app.request("/agents/coder/i2?view=history");
  assert.equal(history.status, 200);
  const body = (await history.json()) as { v: number; conversationId: string; settlements: Settlement[] };
  assert.equal(body.v, 1);
  assert.equal(body.conversationId, "i2");
  assert.deepEqual(
    body.settlements,
    admissions.map(({ submissionId }) => ({
      submissionId,
      outcome: "aborted",
      error: { type: "submission_aborted" },
    })),
  );
});

test("abort: answers { aborted: false } on an idle conversation and on an unknown one", async () => {
  const { app, runs } = scripted();
  await admit(app, "/agents/coder/i1");
  runs[0]!.resolve();
  await flush();
  const idle = await app.request("/agents/coder/i1/abort", { method: "POST" });
  assert.deepEqual(await idle.json(), { aborted: false });
  const unknown = await app.request("/agents/coder/never/abort", { method: "POST" });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { aborted: false });
});

test("a conversation admits again after an abort: the next Submission runs and completes", async () => {
  const { app, runs } = scripted();
  await admit(app, "/agents/coder/i1", "one");
  await app.request("/agents/coder/i1/abort", { method: "POST" });
  await flush();
  const next = await admit(app, "/agents/coder/i1", "two");
  await flush();
  assert.equal(runs[1]?.message, "two");
  runs[1]!.resolve();
  await flush();
  const history = (await (await app.request("/agents/coder/i1?view=history")).json()) as {
    settlements: Settlement[];
  };
  assert.deepEqual(history.settlements.at(-1), { submissionId: next.submissionId, outcome: "completed" });
});

test("unknown conversation: GET is 404 on both views — the documented stub divergence", async () => {
  const { app } = scripted();
  for (const path of ["/agents/coder/never", "/agents/coder/never?view=history"]) {
    const res = await app.request(path);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("never"));
  }
});

test("POST creates: the same path 404s before admission and streams after", async () => {
  const { app } = scripted();
  assert.equal((await app.request("/agents/coder/i9")).status, 404);
  await admit(app, "/agents/coder/i9");
  assert.equal((await app.request("/agents/coder/i9")).status, 200);
});

test("an admission with no definition is a 400 naming the slot (ADR-0049)", async () => {
  // There is no unknown agent any more: the Harness holds no roster, so any name admits — what it
  // will not do is run a Turn nobody handed it a definition for.
  const { app, runs } = scripted();
  const res = await app.request("/agents/ghost/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /agent "ghost": the admission carries no definition/);
  assert.equal(runs.length, 0, "nothing ran");
  // The rejected POST must not have created the conversation behind it (ADR-0027: POST creates).
  assert.equal((await app.request("/agents/ghost/i1")).status, 404);
});

test("a definition that cannot run is a 400 naming the slot, before any conversation exists", async () => {
  const { app, runs } = scripted();
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", definition: { instructions: "code" } }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /agent "coder".*names no model/s);
  assert.equal(runs.length, 0);
  assert.equal((await app.request("/agents/coder/i1")).status, 404);
});

test("the definition rides the admit body to the turn, per Submission (ADR-0049)", async () => {
  const { app, runs } = scripted();
  await admit(app, "/agents/coder/i1", "one");
  // A later Submission on the SAME conversation may carry a retuned definition — the turn reads
  // the one it was handed, so a Machine edit reaches the next Turn with no pod restart. Accept
  // and queue (ADR-0027), so the second runs once the first settles.
  await admit(app, "/agents/coder/i1", "two", { ...CODER, instructions: "code, but better" });
  runs[0]!.resolve();
  await flush();
  assert.deepEqual(
    runs.map((r) => r.submission.definition.instructions),
    ["code", "code, but better"],
  );
});

test("dials ride the admit body to the turn (ADR-0018)", async () => {
  const { app, runs } = scripted();
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", definition: CODER, model: "vllm/big", thinkingLevel: "xhigh" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runs[0]!.submission, {
    definition: CODER,
    message: "go",
    model: "vllm/big",
    thinkingLevel: "xhigh",
  });
});

test("a dial-less admission is unchanged — no keys invented for the turn", async () => {
  const { app, runs } = scripted();
  await admit(app, "/agents/coder/i1");
  assert.deepEqual(runs[0]!.submission, { definition: CODER, message: "go" });
});

test("an admission that cannot run is a 400 — no conversation, no Submission", async () => {
  const { app, runs } = scripted({
    checkAdmission: (resolved) => (resolved.model === "nope/x" ? `model "nope/x" resolves to nothing` : undefined),
  });
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", definition: CODER, model: "nope/x" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /resolves to nothing/);
  assert.equal(runs.length, 0, "nothing ran");
  // The rejected POST must not have created the conversation behind it (ADR-0027: POST creates).
  assert.equal((await app.request("/agents/coder/i1")).status, 404);
});

test("the Instance Harness admits Menu-only Agents alone — Workspace access is a 403 (ADR-0031)", async () => {
  // Every admission carries its own definition (ADR-0049) and the wire is unauthenticated
  // in-cluster, so the placement gate is the Harness's own: without it, any in-cluster caller
  // could POST a `workspace: "write"` definition here and be handed the Working tools — code
  // execution in the one pod ADR-0031 says has none.
  const menuOnlyDef: AgentDefinition = { model: "faux/model", instructions: "pick", workspace: "none" };
  const { app, runs } = scripted({ menuOnly: true });

  const refused = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", definition: CODER }), // "write" default
    headers: { "content-type": "application/json" },
  });
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /workspace: "write"/);
  assert.match(body.error, /Instance Harness/);
  assert.equal(runs.length, 0, "nothing ran");
  // The refusal precedes creation: no conversation may exist here for a refused definition.
  assert.equal((await app.request("/agents/coder/i1")).status, 404);

  // The refusal is DEFINITION-level, not name-level: the same slot key admits when what it
  // carries is Menu-only.
  await admit(app, "/agents/coder/i2", "go", menuOnlyDef);
  assert.equal(runs.length, 1);
});

test("a Sandbox's Harness (no placement gate) admits every definition unchanged", async () => {
  const { app, runs } = scripted();
  await admit(app, "/agents/coder/i1");
  assert.equal(runs.length, 1);
});

test("unknown method on the conversation path is 405; unknown paths are 404", async () => {
  const { app } = scripted();
  for (const method of ["DELETE", "PUT"]) {
    const res = await app.request("/agents/coder/i1", { method });
    assert.equal(res.status, 405);
  }
  // The stub's shape: only POST exists on the abort path — anything else falls to 404.
  assert.equal((await app.request("/agents/coder/i1/abort")).status, 404);
  assert.equal((await app.request("/nope")).status, 404);
});

test("hierarchical iids travel URL-encoded as one segment", async () => {
  const { app } = scripted();
  const iid = "run-1/machine.reviewing/reviewer/s1";
  const path = `/agents/coder/${encodeURIComponent(iid)}`;
  const admission = await admit(app, path);
  assert.equal(admission.streamUrl, `http://localhost${path}`);
  const history = await app.request(`${path}?view=history`);
  assert.equal(history.status, 200);
  const body = (await history.json()) as { conversationId: string };
  assert.equal(body.conversationId, iid);
});
