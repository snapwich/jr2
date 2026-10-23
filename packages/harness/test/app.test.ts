// The wire, socket-free (ADR-0027): `app.request()` against the five routes, shaped on the stub
// Harness with the one documented divergence (GET on an unknown conversation is 404; POST
// creates; abort answers `{ aborted: false }`). Turn execution is stubbed through the injected
// factory, so nothing here touches pi, a provider, or a socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessApp, type HarnessAppDeps } from "../src/app.ts";
import type { AgentDefinition } from "../src/spec.ts";
import type {
  AdmissionRequest,
  MemoryKillsResponse,
  NotKeptResponse,
  PodMemoryKill,
  Settlement,
  StreamEvent,
} from "../src/wire.ts";

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
    // Routing alone is under test here; the gate is `auth.test.ts`'s (ADR-0058).
    checkBearer: () => true,
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

test("an admission for a kept conversation is 404 on an unknown one and creates nothing; on a known one it admits (ADR-0062)", async () => {
  const { app, runs } = scripted();
  const kept = (path: string) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify({ message: "Your previous turn was cut", definition: CODER, kept: true }),
      headers: { "content-type": "application/json" },
    });
  const refused = await kept("/agents/coder/gone");
  assert.equal(refused.status, 404);
  const body = (await refused.json()) as NotKeptResponse;
  assert.equal(body.kept, false, "the marker the Orchestrator requires");
  assert.match(body.error, /no conversation "gone".*kept conversation/);
  assert.equal((await app.request("/agents/coder/gone")).status, 404, "no conversation was seated");
  assert.equal(runs.length, 0, "nothing ran");

  await admit(app, "/agents/coder/here", "one");
  runs[0]!.resolve();
  await flush();
  const admitted = await kept("/agents/coder/here");
  assert.equal(admitted.status, 200);
  await flush();
  assert.equal(runs[1]?.message, "Your previous turn was cut");
  assert.equal("kept" in runs[1]!.submission, false, "the Turn gets the Frame, not the wire's flag");
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

test("the Frame's cwd rides the admit body to the turn (ADR-0057)", async () => {
  const { app, runs } = scripted();
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", cwd: "/work/target/feature", definition: CODER }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  // Frame beside Dials on one flat body: where this Turn works is the same kind of fact as what
  // it is about, and the turn reads both off the admission that queued it.
  assert.deepEqual(runs[0]!.submission, { definition: CODER, message: "go", cwd: "/work/target/feature" });
});

test("a Frame cwd that is not an absolute path is a 400 — never a silent /work (ADR-0057)", async () => {
  const { app, runs } = scripted();
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", cwd: 7, definition: CODER }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /agent "coder".*Frame/s);
  // A relative path is the same incident dressed as a path: it would root the Working tools
  // wherever the Harness process sits, which no Machine named.
  const relative = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({ message: "go", cwd: "target/feature", definition: CODER }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(relative.status, 400);
  assert.match(((await relative.json()) as { error: string }).error, /absolute/);
  assert.equal(runs.length, 0, "nothing ran");
  // A dial is dropped when it is garbage; a cwd is refused, because dropping it roots the Turn in
  // the parent of every checkout and nothing says so.
  assert.equal((await app.request("/agents/coder/i1")).status, 404);
});

test("the notices ride the admit body to the turn, typed; one this Harness cannot word is dropped (ADR-0062)", async () => {
  const { app, runs } = scripted();
  const memory = { kind: "memory-limit", scope: "workspace", agent: "coder", peak: "1.9Gi", limit: "2Gi" };
  // A guard kill while no Submission ran names no Agent; one whose sizes were not sizes has none.
  const idle = { kind: "memory-limit", scope: "workspace", peak: "1.9Gi", limit: "2Gi" };
  const unsized = { kind: "memory-limit", scope: "workspace" };
  const fresh = { kind: "conversation-new", scope: "conversation", reason: "the last one was lost" };
  // A pick's answer that never reached its call (ADR-0024, ADR-0031): with a Gate's event, with a
  // child's output, and with no reply at all.
  const cut = {
    kind: "pick-answer",
    scope: "conversation",
    pick: "run_audit",
    cut: true,
    answer: { kind: "event", event: "audited", sender: { party: "gate", id: "auditor" }, payload: { findings: "f" } },
  };
  const left = {
    kind: "pick-answer",
    scope: "conversation",
    pick: "ship",
    cut: false,
    answer: { kind: "output", actor: "tests", output: { pushed: "abc" } },
  };
  const silent = { kind: "pick-answer", scope: "conversation", pick: "ship", cut: false };
  // Stopped by an exit that was not the pick's route, with an earlier link's reply kept.
  const stopped = { ...left, stopped: true };
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({
      message: "go",
      definition: CODER,
      // A newer Orchestrator's kind, and a known kind missing its facts: neither can be worded.
      notices: [
        memory,
        idle,
        unsized,
        { kind: "memory-limit", scope: "workspace", peak: "1Gi" },
        { kind: "disk-full", scope: "workspace" },
        { kind: "memory-limit", agent: "x" },
        fresh,
        cut,
        left,
        silent,
        stopped,
        { kind: "pick-answer", scope: "conversation", cut: true },
        { kind: "pick-answer", scope: "conversation", pick: "ship", cut: false, stopped: "yes" },
        { kind: "pick-answer", scope: "conversation", pick: "ship", cut: false, answer: { kind: "event" } },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runs[0]!.submission, {
    definition: CODER,
    message: "go",
    notices: [memory, idle, unsized, fresh, cut, left, silent, stopped],
  });
  // Garbage in the slot is no notices, as a garbage dial is no dial.
  await app.request("/agents/coder/i2", {
    method: "POST",
    body: JSON.stringify({ message: "go", definition: CODER, notices: "memory" }),
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(runs[1]!.submission, { definition: CODER, message: "go" });
});

test("a pick's answer rides the admit body as a notice — the cut call's, and a route's out of the Agent's state (ADR-0024, ADR-0067)", async () => {
  const { app, runs } = scripted();
  const cut = {
    kind: "pick-answer",
    scope: "conversation",
    pick: "run_tests",
    cut: true,
    answer: { kind: "output", actor: "tests", output: { outcome: "exited", code: 0, tail: "" } },
  };
  const left = { kind: "pick-answer", scope: "conversation", pick: "ship", cut: false };
  const shaped = {
    kind: "pick-answer",
    scope: "conversation",
    pick: "deploy",
    cut: false,
    answer: { kind: "answer", value: "Preview at https://p.example/1." },
  };
  const res = await app.request("/agents/coder/i1", {
    method: "POST",
    body: JSON.stringify({
      message: "go",
      definition: CODER,
      // Missing its facts, or an answer of a kind this Harness cannot word: dropped.
      notices: [cut, left, shaped, { kind: "pick-answer", scope: "conversation" }, { ...left, answer: { kind: "x" } }],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runs[0]!.submission.notices, [cut, left, shaped]);
});

/** A Harness over `root` whose guard the test fires by hand. */
type Fired = { seq?: number; peak: string; limit: string };
type Owner = { agent: string; instanceId: string };

function guarded(root?: string) {
  let report: ((kill: Fired) => void) | undefined;
  let tell: ((seq: number, owner: Owner) => void) | undefined;
  const harness = scripted({
    ...(root === undefined ? {} : { conversationsDir: root }),
    memoryKills: (listener) => {
      report = listener;
      return () => {};
    },
    memoryTold: (teller) => {
      tell = teller;
      return () => {};
    },
  });
  return { ...harness, kill: (kill: Fired) => report!(kill), told: (seq: number, owner: Owner) => tell!(seq, owner) };
}

async function kills(app: ReturnType<typeof harnessApp>): Promise<PodMemoryKill[]> {
  const res = await app.request("/memory-kills");
  assert.equal(res.status, 200);
  return ((await res.json()) as MemoryKillsResponse).kills;
}

const memoryEvents = async (app: ReturnType<typeof harnessApp>, path: string) =>
  ((await (await app.request(`${path}?offset=0`)).json()) as StreamEvent[]).flatMap((event) =>
    event.type === "memory-limit" ? [event] : [],
  );

test("a guard kill lands on the stream of every conversation whose Submission runs, and in the pod's list, under ONE id (ADR-0061/0062)", async () => {
  const { app, runs, kill, told } = guarded();
  await admit(app, "/agents/coder/i1");
  await admit(app, "/agents/tester/i2");
  await admit(app, "/agents/idle/i3");
  runs[2]!.resolve();
  await flush();
  // The coder's `bash` call was running when the guard fired; the tester's model was writing text.
  kill({ seq: 1, peak: "1.9Gi", limit: "2Gi" });
  const [onCoder] = await memoryEvents(app, "/agents/coder/i1");
  const [onTester] = await memoryEvents(app, "/agents/tester/i2");
  assert.deepEqual(await memoryEvents(app, "/agents/idle/i3"), [], "no Submission runs there");
  assert.equal(onCoder!.peak, "1.9Gi");
  assert.equal(onCoder!.limit, "2Gi");
  // One kill, one id: the Orchestrator's ledger makes it one notice, whichever path it reads first.
  const [kept, ...more] = await kills(app);
  assert.deepEqual(more, []);
  assert.equal(onTester!.id, onCoder!.id);
  assert.equal(kept!.id, onCoder!.id);
  assert.deepEqual(kept!.told, [], "no answer has reached a model yet");
  // The coder's call returns its verdict: now its conversation is told, and the list says so.
  told(1, { agent: "coder", instanceId: "i1" });
  told(1, { agent: "coder", instanceId: "i1" });
  told(9, { agent: "tester", instanceId: "i2" }); // a kill the pod never had
  assert.deepEqual((await kills(app))[0]!.told, [{ agent: "coder", instanceId: "i1" }]);
  runs[0]!.resolve();
  runs[1]!.resolve();
});

test("a guard kill while no Submission runs is kept for GET /memory-kills, told to no one, and is on no stream (ADR-0061/0062)", async () => {
  const { app, runs, kill } = guarded();
  await admit(app, "/agents/coder/i1");
  runs[0]!.resolve();
  await flush();
  // The workflow waits at a Gate, and a dev server the Turn left passes the limit.
  kill({ peak: "1.9Gi", limit: "2Gi" });
  assert.deepEqual(await memoryEvents(app, "/agents/coder/i1"), [], "no wait reads this stream now");
  const [kept, ...more] = await kills(app);
  assert.deepEqual(more, []);
  assert.equal(kept!.peak, "1.9Gi");
  assert.equal(kept!.limit, "2Gi");
  assert.deepEqual(kept!.told, []);
  assert.ok(kept!.id.length > 0 && !Number.isNaN(Date.parse(kept!.at)));
  // A read changes nothing: the Orchestrator keeps the ids it has raised.
  assert.deepEqual(await kills(app), [kept]);
});

test("a guard kill outlives a Harness restart on the same volume (ADR-0031, ADR-0062)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jr2-kills-"));
  try {
    const first = guarded(root);
    first.kill({ peak: "1.9Gi", limit: "2Gi" });
    const before = await kills(first.app);
    // The restarted process reads it back with its id, so the Orchestrator's `seen` still knows it.
    const second = guarded(root);
    assert.deepEqual(await kills(second.app), before);
    second.kill({ peak: "1.8Gi", limit: "2Gi" });
    const after = await kills(second.app);
    assert.equal(after.length, 2);
    assert.notEqual(after[1]!.id, after[0]!.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Instance Harness keeps no memory kill: it holds no Workspace (ADR-0031, ADR-0062)", async () => {
  const { app } = scripted({ menuOnly: true });
  const res = await app.request("/memory-kills");
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /Instance Harness/);
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
  // Every admission carries its own definition (ADR-0049), so the placement gate is the Harness's
  // own: without it, a caller holding this placement's bearer (ADR-0058) could POST a
  // `workspace: "write"` definition here and be handed the Working tools — code execution in the
  // one pod ADR-0031 says has none. The bearer narrows who may try; this decides what.
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

// ---- POST /attach (ADR-0063) -------------------------------------------------------------------

const SLOT = { slot: "app", url: "https://example.test/app.git", identity: "example.test/app", key: "k" };
const attachInit = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

test("attach hands a valid body to the attach and answers its paths", async () => {
  const seen: unknown[] = [];
  const { app } = scripted({
    attach: async (req) => (seen.push(req), { repos: { app: "/work/app/b" } }),
  });
  const res = await app.request("/attach", attachInit({ branch: "b", slots: [SLOT] }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { repos: { app: "/work/app/b" } });
  assert.deepEqual(seen, [{ branch: "b", slots: [SLOT] }]);
});

test("attach refuses a malformed body with 400, naming what is wrong, and runs nothing", async () => {
  let runs = 0;
  const { app } = scripted({ attach: async () => (runs++, { repos: {} }) });
  const res = await app.request("/attach", attachInit({ branch: "b", slots: [] }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /names no Repo Slot/);
  assert.equal(runs, 0);
});

test("a failed attach is 500 with the slot and git's own words", async () => {
  const { AttachFault } = await import("../src/attach.ts");
  const { app } = scripted({
    attach: async () => {
      throw new AttachFault('the attach of slot "app" failed at git clone --shared: fatal: no such repo', "app");
    },
  });
  const res = await app.request("/attach", attachInit({ branch: "b", slots: [SLOT] }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), {
    error: 'the attach of slot "app" failed at git clone --shared: fatal: no such repo',
    slot: "app",
  });
});

// ---- POST /sync (ADR-0067) ---------------------------------------------------------------------

test("the sync hands a valid body to the syncer and answers its report; a malformed one is 400; the Instance Harness refuses it", async () => {
  const seen: unknown[] = [];
  const body = {
    worktree: "/work/app/b",
    branch: "b",
    published: "2".repeat(40),
    source: "1".repeat(40),
    bundle: "QQ==",
  };
  const { app } = scripted({ sync: async (req) => (seen.push(req), { sync: "already" }) });
  const res = await app.request("/sync", attachInit(body));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sync: "already" });
  assert.deepEqual(seen, [body]);
  const bad = await app.request("/sync", attachInit({ ...body, worktree: "/etc" }));
  assert.equal(bad.status, 400);
  assert.equal(seen.length, 1, "nothing ran");
  const instance = scripted({ menuOnly: true, sync: async () => (seen.push(body), { sync: "already" }) });
  assert.equal((await instance.app.request("/sync", attachInit(body))).status, 403);
  assert.equal(seen.length, 1);
});

test("the Instance Harness refuses the attach: it has no /work (ADR-0031)", async () => {
  let runs = 0;
  const { app } = scripted({ menuOnly: true, attach: async () => (runs++, { repos: {} }) });
  const res = await app.request("/attach", attachInit({ branch: "b", slots: [SLOT] }));
  assert.equal(res.status, 403);
  assert.equal(runs, 0);
});
