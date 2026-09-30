// A conversation's lifetime on the Harness (ADR-0031): persisted to a directory as it goes and
// rebuilt from it on boot, freed when the Orchestrator's live set stops naming it, and drained on
// SIGTERM. Socket-free like `app.test.ts` — a "restart" is a second app over the same directory —
// except the listen's own fault, which needs a port another listener holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessServer, type ConversationSeat, type HarnessAppDeps } from "../src/app.ts";
import { conversationDir } from "../src/record.ts";
import { listenFault, serveHarness } from "../src/serve.ts";
import type { AgentDefinition } from "../src/spec.ts";
import {
  SUBMISSION_HARNESS_RESTARTED,
  SUBMISSION_RESTARTED_MESSAGE,
  type HistoryView,
  type LiveSetRequest,
  type StreamEvent,
} from "../src/wire.ts";

const DECISIONER: AgentDefinition = { model: "faux/model", instructions: "decide", workspace: "none" };

type Run = { seat: ConversationSeat; message: string; resolve: () => void; reject: (err: unknown) => void };

/** A Harness over `dir` whose turns park until the test settles them. Each turn says its prompt
 * back through the seat, as the real turn loop reports what was said. */
function harnessOver(dir: string | undefined, overrides?: Partial<HarnessAppDeps>) {
  const runs: Run[] = [];
  const seats: ConversationSeat[] = [];
  const boot: string[] = [];
  const server = harnessServer({
    longPollMs: 25,
    checkBearer: () => true,
    ...(dir ? { conversationsDir: dir } : {}),
    bootOut: { write: (chunk: string) => void boot.push(chunk) },
    runSubmissionFor: (seat) => {
      seats.push(seat);
      return (submission, signal) =>
        new Promise<void>((resolve, reject) => {
          seat.appendMessage({ role: "user", text: submission.message });
          runs.push({ seat, message: submission.message, resolve, reject });
          signal.addEventListener("abort", () => reject(new Error("swept")), { once: true });
        });
    },
    ...overrides,
  });
  return { ...server, runs, seats, boot };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const scratch = () => mkdtempSync(join(tmpdir(), "jr2-conversations-"));

async function admit(app: ReturnType<typeof harnessOver>["app"], path: string, message = "go") {
  const res = await app.request(path, {
    method: "POST",
    body: JSON.stringify({ message, definition: DECISIONER }),
    headers: { "content-type": "application/json" },
  });
  return res;
}

async function admitted(app: ReturnType<typeof harnessOver>["app"], path: string, message = "go") {
  const res = await admit(app, path, message);
  assert.equal(res.status, 200);
  return (await res.json()) as { offset: string; submissionId: string };
}

async function history(app: ReturnType<typeof harnessOver>["app"], path: string): Promise<HistoryView> {
  const res = await app.request(`${path}?view=history`);
  assert.equal(res.status, 200);
  return (await res.json()) as HistoryView;
}

async function stream(app: ReturnType<typeof harnessOver>["app"], path: string, offset = "0") {
  const res = await app.request(`${path}?offset=${offset}`);
  assert.equal(res.status, 200);
  return (await res.json()) as StreamEvent[];
}

async function statement(app: ReturnType<typeof harnessOver>["app"], body: LiveSetRequest | unknown) {
  return app.request("/agents", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// ---- persisted, and rebuilt on boot --------------------------------------------------------------

test("a rebuilt conversation reads as it was written: the stream, the messages, the settlements", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  // An iid is hierarchical (ADR-0015), and a path segment must not be one.
  const path = `/agents/decider/${encodeURIComponent("run-1/machine.deciding/decider/s1")}`;
  await admitted(before.app, path, "one");
  await flush();
  before.runs[0]!.resolve();
  await flush();
  const written = { stream: await stream(before.app, path), history: await history(before.app, path) };
  assert.equal(written.history.settlements.length, 1);

  const after = harnessOver(dir);
  assert.deepEqual(await stream(after.app, path), written.stream);
  assert.deepEqual(await history(after.app, path), written.history);
  assert.deepEqual(after.boot, [], "nothing unreadable");
  // Nothing re-runs on boot: a Turn is continued by the NEXT Submission.
  assert.equal(after.runs.length, 0);
});

test("a Submission in flight at the restart settles failed on the rebuilt stream, naming the restart", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  const path = "/agents/decider/i1";
  await admitted(before.app, path, "one");
  await flush();
  before.runs[0]!.resolve();
  await flush();
  const running = await admitted(before.app, path, "two");
  const queued = await admitted(before.app, path, "three");
  await flush();
  // The process dies here: "two" is running, "three" is queued behind it.

  const after = harnessOver(dir);
  // The re-attached `wait` reads from the offset its Admission carried — and finds a Settlement.
  const settled = (await stream(after.app, path, running.offset)).filter((e) => e.type === "submission-settled");
  const restarted = { type: SUBMISSION_HARNESS_RESTARTED, message: SUBMISSION_RESTARTED_MESSAGE };
  assert.deepEqual(
    settled.map((e) => ({ submissionId: e.submissionId, outcome: e.outcome, error: e.error })),
    [
      { submissionId: running.submissionId, outcome: "failed", error: restarted },
      { submissionId: queued.submissionId, outcome: "failed", error: restarted },
    ],
  );
  assert.deepEqual(
    (await history(after.app, path)).settlements.map((s) => s.outcome),
    ["completed", "failed", "failed"],
  );

  // The next Submission continues the conversation, with a Submission id of its own.
  const next = await admitted(after.app, path, "four");
  assert.ok(![running.submissionId, queued.submissionId].includes(next.submissionId));
  await flush();
  assert.equal(after.runs[0]?.message, "four");
  // The failed settlements are in the record: a third boot does not settle them again.
  after.runs[0]!.resolve();
  await flush();
  const third = harnessOver(dir);
  assert.deepEqual(
    (await history(third.app, path)).settlements.map((s) => s.outcome),
    ["completed", "failed", "failed", "completed"],
  );
});

test("the engine seat: a directory the engine names, beside the record, and the record's messages", async () => {
  const dir = scratch();
  const harness = harnessOver(dir);
  await admitted(harness.app, "/agents/decider/i1", "hello");
  await flush();
  const engine = harness.seats[0]!.engine;
  assert.equal(engine.dir("pi"), join(conversationDir(dir, "decider", "i1"), "engine", "pi"));
  assert.deepEqual(engine.history(), [{ role: "user", text: "hello" }]);
  // Rebuilt, the engine gets the same directory and the history the record kept.
  const after = harnessOver(dir);
  await admitted(after.app, "/agents/decider/i1", "again");
  await flush();
  assert.equal(after.seats[0]!.engine.dir("pi"), engine.dir("pi"));
  assert.deepEqual(after.seats[0]!.engine.history(), [
    { role: "user", text: "hello" },
    { role: "user", text: "again" },
  ]);
});

test("no directory, no persistence: the engine keeps its part in memory, and a restart forgets", async () => {
  const harness = harnessOver(undefined);
  await admitted(harness.app, "/agents/decider/i1");
  await flush();
  assert.equal(harness.seats[0]!.engine.dir("pi"), undefined);
  assert.equal((await harness.app.request("/agents/decider/i1")).status, 200);
  assert.equal((await harnessOver(undefined).app.request("/agents/decider/i1")).status, 404);
});

test("an unreadable record is said and skipped; the rest rebuild; a new admission starts it over", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  await admitted(before.app, "/agents/decider/good");
  await admitted(before.app, "/agents/decider/bad");
  await flush();
  writeFileSync(join(conversationDir(dir, "decider", "bad"), "record", "stream.jsonl"), "{not json\n");

  const after = harnessOver(dir);
  assert.equal((await after.app.request("/agents/decider/good")).status, 200);
  assert.equal((await after.app.request("/agents/decider/bad")).status, 404);
  assert.equal(after.boot.length, 1);
  assert.match(after.boot[0]!, /conversation at .*bad is unreadable, not rebuilt/);

  await admitted(after.app, "/agents/decider/bad", "fresh");
  await flush();
  const third = harnessOver(dir);
  assert.deepEqual(third.boot, [], "the new record replaced the unreadable one");
  assert.deepEqual((await history(third.app, "/agents/decider/bad")).messages, [{ role: "user", text: "fresh" }]);
});

test("a write the restart cut short is dropped, not fatal", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  await admitted(before.app, "/agents/decider/i1");
  await flush();
  const file = join(conversationDir(dir, "decider", "i1"), "record", "messages.jsonl");
  writeFileSync(file, `${JSON.stringify({ role: "user", text: "go" })}\n{"role":"assis`);
  const after = harnessOver(dir);
  assert.deepEqual((await history(after.app, "/agents/decider/i1")).messages, [{ role: "user", text: "go" }]);
});

test("a torn write is cut before the rebuilt record appends, so the boot after that reads it too", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  await admitted(before.app, "/agents/decider/i1", "one");
  await flush();
  // The process dies mid-line: the Submission is running, and its stream holds a torn write.
  const file = join(conversationDir(dir, "decider", "i1"), "record", "stream.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"message-app`);

  // Boot 1 rebuilds, and at once appends the restart's Settlement to that same stream.
  const after = harnessOver(dir);
  await admitted(after.app, "/agents/decider/i1", "two");
  await flush();
  // Boot 2 still reads the conversation — the tail went before the append, not into it.
  const third = harnessOver(dir);
  assert.deepEqual(third.boot, [], "nothing unreadable");
  assert.deepEqual(
    (await history(third.app, "/agents/decider/i1")).settlements.map((s) => s.error?.type),
    [SUBMISSION_HARNESS_RESTARTED, SUBMISSION_HARNESS_RESTARTED],
  );
});

test("a Settlement whose stream line the restart tore is settled again, so a re-attached wait reads one", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  const admission = await admitted(before.app, "/agents/decider/i1", "one");
  await flush();
  before.runs[0]!.resolve();
  await flush();
  // The process dies while it writes the Settlement's line: the line is torn, and the stream is
  // the only place a Settlement is recorded.
  const file = join(conversationDir(dir, "decider", "i1"), "record", "stream.jsonl");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.slice(0, text.lastIndexOf("\n", text.length - 2) + 20));

  const after = harnessOver(dir);
  const settled = (await stream(after.app, "/agents/decider/i1", admission.offset)).filter(
    (e) => e.type === "submission-settled",
  );
  assert.deepEqual(
    settled.map((e) => [e.submissionId, e.outcome, e.error?.type]),
    [[admission.submissionId, "failed", SUBMISSION_HARNESS_RESTARTED]],
  );
  assert.deepEqual((await history(after.app, "/agents/decider/i1")).settlements.length, 1);
});

test("a record write that fails is the process's end, not a Settlement no wait hears", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes through a read-only mode");
  const dir = scratch();
  const faults: string[] = [];
  const harness = harnessOver(dir, {
    recordFault: (err, path) => {
      faults.push(path);
      throw err;
    },
  });
  await admitted(harness.app, "/agents/decider/i1");
  await flush();
  // The volume refuses the Settlement's line.
  const file = join(conversationDir(dir, "decider", "i1"), "record", "stream.jsonl");
  chmodSync(file, 0o444);
  harness.runs[0]!.resolve();
  await flush();
  assert.deepEqual(faults, [file]);
});

// ---- the live set ---------------------------------------------------------------------------------

test("PUT /agents frees every conversation the live set does not name — memory and directory", async () => {
  const dir = scratch();
  const harness = harnessOver(dir);
  for (const id of ["keep", "drop-1", "drop-2"]) await admitted(harness.app, `/agents/decider/${id}`);
  await flush();
  for (const run of harness.runs) run.resolve();
  await flush();

  const res = await statement(harness.app, { live: [{ agent: "decider", instanceId: "keep" }] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { freed: 2 });
  assert.equal((await harness.app.request("/agents/decider/keep")).status, 200);
  assert.equal((await harness.app.request("/agents/decider/drop-1")).status, 404);
  assert.deepEqual(readdirSync(join(dir, "decider")), ["keep"]);
  // Idempotent: the same statement again frees nothing more.
  assert.deepEqual(await (await statement(harness.app, { live: [{ agent: "decider", instanceId: "keep" }] })).json(), {
    freed: 0,
  });
  // And a freed conversation is gone across a restart too.
  assert.equal((await harnessOver(dir).app.request("/agents/decider/drop-1")).status, 404);
});

test("PUT /agents keeps a conversation whose Submission runs, and frees it on the next statement", async () => {
  const harness = harnessOver(scratch());
  await admitted(harness.app, "/agents/decider/busy");
  await flush();
  assert.deepEqual(await (await statement(harness.app, { live: [] })).json(), { freed: 0 });
  assert.equal((await harness.app.request("/agents/decider/busy")).status, 200);
  harness.runs[0]!.resolve();
  await flush();
  assert.deepEqual(await (await statement(harness.app, { live: [] })).json(), { freed: 1 });
  assert.equal((await harness.app.request("/agents/decider/busy")).status, 404);
});

test("PUT /agents frees the directory the boot could not read", async () => {
  const dir = scratch();
  const before = harnessOver(dir);
  await admitted(before.app, "/agents/decider/bad");
  await flush();
  writeFileSync(join(conversationDir(dir, "decider", "bad"), "conversation.json"), "[]\n");
  const after = harnessOver(dir);
  assert.deepEqual(await (await statement(after.app, { live: [] })).json(), { freed: 1 });
  assert.equal(existsSync(join(dir, "decider")), false, "an Agent with no conversation left has no directory");
});

test("a live set that cannot be read whole frees nothing: 400", async () => {
  const harness = harnessOver(scratch());
  await admitted(harness.app, "/agents/decider/i1");
  await flush();
  harness.runs[0]!.resolve();
  await flush();
  for (const body of [{}, { live: "all" }, { live: [{ agent: "decider" }] }]) {
    assert.equal((await statement(harness.app, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await harness.app.request("/agents/decider/i1")).status, 200);
});

test("PUT /agents is gated on the bearer like every route (ADR-0058)", async () => {
  const harness = harnessOver(scratch(), { checkBearer: (bearer) => bearer === "b" });
  assert.equal((await statement(harness.app, { live: [] })).status, 401);
  const res = await harness.app.request("/agents", {
    method: "PUT",
    body: JSON.stringify({ live: [] }),
    headers: { "content-type": "application/json", authorization: "Bearer b" },
  });
  assert.equal(res.status, 200);
});

// ---- the drain ------------------------------------------------------------------------------------

test("the drain: a new admission is 503, and the Submissions it holds settle before it resolves", async () => {
  const harness = harnessOver(scratch());
  const running = await admitted(harness.app, "/agents/decider/i1", "one");
  const queued = await admitted(harness.app, "/agents/decider/i1", "two");
  await flush();

  let drained = false;
  const drain = harness.drain().then(() => {
    drained = true;
  });
  const refused = await admit(harness.app, "/agents/decider/i2");
  assert.equal(refused.status, 503);
  assert.match(((await refused.json()) as { error: string }).error, /draining/);
  // The Orchestrator re-sends it; closing the socket sends that retry to the Service, not here.
  assert.equal(refused.headers.get("connection"), "close");
  // A 503 queued nothing: no conversation was created for it.
  assert.equal((await harness.app.request("/agents/decider/i2")).status, 404);
  // Reads still answer while it drains — the Orchestrator's `wait` reads its Settlement here.
  assert.equal((await harness.app.request("/agents/decider/i1?offset=0")).status, 200);

  harness.runs[0]!.resolve();
  await flush();
  await flush();
  assert.equal(drained, false, "the queued Submission was admitted, so the drain owes it its Turn");
  assert.equal(harness.runs[1]?.message, "two");
  harness.runs[1]!.resolve();
  await drain;
  assert.deepEqual(
    (await history(harness.app, "/agents/decider/i1")).settlements.map((s) => [s.submissionId, s.outcome]),
    [
      [running.submissionId, "completed"],
      [queued.submissionId, "completed"],
    ],
  );
});

test("the drain of an idle Harness resolves at once", async () => {
  await harnessOver(scratch()).drain();
});

test("SIGTERM's stop: drains, closes the port, exits 0", async () => {
  const harness = harnessOver(undefined);
  const exits: number[] = [];
  const served = serveHarness(harness, {
    port: 0,
    hostname: "127.0.0.1",
    exit: (code) => exits.push(code),
    flushMs: 10,
  });
  await new Promise((resolve) => served.server.once("listening", resolve));
  await admitted(harness.app, "/agents/decider/i1");
  await flush();
  const stopped = served.stop();
  await flush();
  assert.deepEqual(exits, [], "not while a Submission runs");
  harness.runs[0]!.resolve();
  await stopped;
  assert.deepEqual(exits, [0]);
  assert.equal(served.server.listening, false);
});

// ---- the listen's fault (R16) ---------------------------------------------------------------------

test("a port another container took is ONE line naming the port and the cause, then exit 1", async () => {
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const port = (squatter.address() as { port: number }).port;
  try {
    const lines: string[] = [];
    const exits: number[] = [];
    serveHarness(harnessOver(undefined), {
      port,
      hostname: "127.0.0.1",
      say: (line) => lines.push(line),
      exit: (code) => exits.push(code),
    });
    const deadline = Date.now() + 5000;
    while (exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(exits, [1]);
    assert.deepEqual(lines, [
      `port ${port} is taken inside this pod: another container listens on it — ` +
        "the Harness's and the Custodian's ports are the pod's (CONTEXT.md)",
    ]);
  } finally {
    squatter.close();
  }
});

test("any other listen error is not dressed up as a taken port", () => {
  assert.equal(listenFault(Object.assign(new Error("denied"), { code: "EACCES" }), 80), undefined);
  assert.match(
    listenFault(Object.assign(new Error("in use"), { code: "EADDRINUSE" }), 8080) ?? "",
    /^port 8080 is taken/,
  );
});
