// Unit tests for the real, Harness-wire-backed client (ADR-0027, on ADR-0016/0024). `fetch` is
// INJECTED (socket-free): the client depends only on the wire's five-endpoint shapes, so a
// scripted fetch exercises every branch — send (admission = the durable handle, streamUrl
// absolutized), the wait loop (offset advance by header, settlement match by submissionId, fault
// translation, 404 = lost conversation, reconnect-with-backoff on network failure),
// abandon-by-signal, and remote abort. The stub-over-a-socket tests live in stub-harness.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SettlementFault, createEchoPush, createHarnessClient, harnessAgentRunPort } from "../src/harness-client.ts";
import type { AgentAdmission, AgentRunInput } from "../src/actor.ts";
import type { EchoEvent } from "@j2/harness/wire";

const admission: AgentAdmission = {
  streamUrl: "http://h.test/agents/coder/inst-1",
  offset: "0",
  submissionId: "sub-1",
};

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-1",
  endpoint: "http://h.test", // tests inject fetch; nothing ever dials
  prompt: "do the thing",
  tools: [],
};

type Call = { url: URL; init: RequestInit | undefined };

/** A scripted fetch: one handler per call, the last handler repeating. Records every call. */
function scriptedFetch(script: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: new URL(String(input)), init };
    calls.push(call);
    return await script[Math.min(calls.length - 1, script.length - 1)]!(call);
  };
  return { calls, fetch: impl as typeof fetch };
}

const client = (fetchImpl: typeof fetch) =>
  createHarnessClient({ baseUrl: "http://h.test", fetch: fetchImpl, backoffInitialMs: 1, backoffMaxMs: 4 });

/** A `submission-settled` chunk as `@j2/harness` emits it (wire.ts — flat, enveloped). */
function settledChunk(submissionId: string, outcome: string, error?: { type: string; message?: string }) {
  return {
    type: "submission-settled",
    conversationId: "inst-1",
    position: { batch: 0, index: 0 },
    submissionId,
    outcome,
    ...(error ? { error } : {}),
  };
}

function streamResponse(events: unknown[], nextOffset: string): Response {
  return new Response(JSON.stringify(events), {
    status: 200,
    headers: { "content-type": "application/json", "stream-next-offset": nextOffset, "stream-up-to-date": "true" },
  });
}

function parkedResponse(nextOffset: string): Response {
  return new Response(null, { status: 204, headers: { "stream-next-offset": nextOffset } });
}

test("send POSTs the prompt and resolves with the admission — streamUrl absolutized against baseUrl", async () => {
  const { calls, fetch } = scriptedFetch([
    () =>
      new Response(JSON.stringify({ streamUrl: "/agents/coder/inst-1", offset: "3", submissionId: "sub-9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ]);

  const adm = await client(fetch).send("coder", "inst-1", { message: "do the thing" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.toString(), "http://h.test/agents/coder/inst-1");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { message: "do the thing" });
  // The relative streamUrl the Harness may mint resolves against baseUrl, so the ledgered handle
  // re-attaches without remembering this client (an absolute one passes through unchanged).
  assert.deepEqual(adm, { streamUrl: "http://h.test/agents/coder/inst-1", offset: "3", submissionId: "sub-9" });
});

test("a refused admission is an error carrying the wire's detail", async () => {
  const { fetch } = scriptedFetch([() => new Response(JSON.stringify({ error: "no such agent" }), { status: 404 })]);
  await assert.rejects(
    () => client(fetch).send("ghost", "inst-1", { message: "hi" }),
    /harness admission failed \(404\): no such agent/,
  );
});

/** A transport rejection shaped the way undici shapes one: a generic `fetch failed` over a cause
 * that carries the syscall and errno. What the client reads is the CAUSE, never the message. */
function transportError(code: string, syscall: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }) });
}

test("an admission that never left the host is retried — a Service with no backend yet is not a failed turn", async () => {
  const { calls, fetch } = scriptedFetch([
    // What a ClusterIP with no programmed EndpointSlice answers: kube-proxy REJECTs, so the
    // connection is refused before a byte of the prompt is sent.
    () => Promise.reject(transportError("ECONNREFUSED", "connect")),
    () => Promise.reject(transportError("ECONNREFUSED", "connect")),
    () => new Response(JSON.stringify(admission), { status: 200 }),
  ]);

  const adm = await client(fetch).send("coder", "inst-1", { message: "do the thing" });

  assert.equal(calls.length, 3, "the POST is re-sent until it connects");
  assert.deepEqual(adm, admission);
});

test("a retry that SUCCEEDED still says what it cost — an absorbed fault must not be an unmeasured one", async () => {
  // ADR-0042 absorbs the retry (ADR-0016: no event, no budget on the authoring surface), which is
  // right and is also how this whole class stayed invisible for three sessions. The line is the
  // compromise: not a run-feed event, just a number the `@kind` tier can hold a budget against.
  const lines: string[] = [];
  const { fetch } = scriptedFetch([
    () => Promise.reject(transportError("ECONNREFUSED", "connect")),
    () => new Response(JSON.stringify(admission), { status: 200 }),
  ]);
  const measured = createHarnessClient({
    baseUrl: "http://h.test",
    fetch,
    backoffInitialMs: 1,
    backoffMaxMs: 2,
    log: (line) => lines.push(line),
  });

  await measured.send("coder", "inst-1", { message: "do the thing" });

  assert.equal(lines.length, 1);
  // This shape is a CONTRACT with features/steps/kind.steps.ts, which parses it for the tier's
  // routability budget — a rename here that is not made there fails nothing and checks nothing.
  assert.match(
    lines[0]!,
    /^j2\.routability seat=admission attempts=2 ms=\d+ url=http:\/\/h\.test\/agents\/coder\/inst-1$/,
  );
});

test("an admission that connects first time is silent — a line existing at all is the signal", async () => {
  const lines: string[] = [];
  const { fetch } = scriptedFetch([() => new Response(JSON.stringify(admission), { status: 200 })]);

  await createHarnessClient({ baseUrl: "http://h.test", fetch, log: (line) => lines.push(line) }).send(
    "coder",
    "inst-1",
    { message: "do the thing" },
  );

  assert.deepEqual(lines, []);
});

test("a transport failure that may have reached the Harness is NOT retried — a re-POST is a second turn", async () => {
  // Admission is accept-and-queue (ADR-0027): a POST the Harness received but could not answer
  // has already queued a Submission, so re-sending it would run the turn twice. Only a failure
  // that proves the request never left the host may be retried, and a reset connection does not.
  const { calls, fetch } = scriptedFetch([() => Promise.reject(transportError("ECONNRESET", "read"))]);

  await assert.rejects(() => client(fetch).send("coder", "inst-1", { message: "do the thing" }), /fetch failed/);
  assert.equal(calls.length, 1);
});

test("an endpoint that never answers faults with the address it kept trying", async () => {
  const { calls, fetch } = scriptedFetch([() => Promise.reject(transportError("ECONNREFUSED", "connect"))]);
  const bounded = createHarnessClient({
    baseUrl: "http://h.test",
    fetch,
    backoffInitialMs: 1,
    backoffMaxMs: 2,
    admitWindowMs: 20,
  });

  await assert.rejects(
    () => bounded.send("coder", "inst-1", { message: "do the thing" }),
    // Not a bare `fetch failed`: the reason lands on the run as the terminal `agent.fault`, and a
    // fault nobody can act on is what made this class of failure invisible.
    /never connected to http:\/\/h\.test\/agents\/coder\/inst-1/,
  );
  assert.ok(calls.length > 1, "it kept trying for the whole window");
});

test("the port admits via send and forwards the signal; admit without a prompt is an error", async () => {
  const { calls, fetch } = scriptedFetch([() => new Response(JSON.stringify(admission), { status: 200 })]);
  const port = harnessAgentRunPort(client(fetch));

  const adm = await port.admit(baseInput, { signal: new AbortController().signal });
  assert.deepEqual(adm, admission);
  assert.ok(calls[0]!.init?.signal, "admit forwards its signal into the POST");

  await assert.rejects(() => port.admit({ ...baseInput, prompt: undefined }), /needs a prompt/);
});

test("wait long-polls from the admission offset and resolves on this submission's completed settlement", async () => {
  const { calls, fetch } = scriptedFetch([() => streamResponse([settledChunk("sub-1", "completed")], "1")]);

  await client(fetch).wait(admission);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, "/agents/coder/inst-1");
  assert.equal(calls[0]!.url.searchParams.get("offset"), "0");
  assert.equal(calls[0]!.url.searchParams.get("view"), "updates");
  assert.equal(calls[0]!.url.searchParams.get("live"), "long-poll");
});

test("wait advances by the stream-next-offset header and skips foreign chunks", async () => {
  const { calls, fetch } = scriptedFetch([
    // An empty park, then another submission's settlement riding with a message chunk, then ours.
    () => parkedResponse("0"),
    () =>
      streamResponse(
        [
          {
            type: "message-appended",
            conversationId: "inst-1",
            position: { batch: 0, index: 0 },
            message: { id: "m-1", role: "assistant", parts: [{ type: "text", text: "hi", state: "done" }] },
          },
          settledChunk("sub-other", "completed"),
        ],
        "2",
      ),
    () => streamResponse([settledChunk("sub-1", "completed")], "3"),
  ]);

  await client(fetch).wait(admission);

  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get("offset")),
    ["0", "0", "2"],
    "a 204 keeps the offset; a read advances it by the header",
  );
});

test("a failed settlement rejects as SettlementFault carrying the settlement's error", async () => {
  const { fetch } = scriptedFetch([
    () => streamResponse([settledChunk("sub-1", "failed", { type: "submission_failed", message: "boom" })], "1"),
  ]);

  await assert.rejects(
    () => client(fetch).wait(admission),
    (err: unknown) => {
      assert.ok(err instanceof SettlementFault);
      assert.match(err.message, /submission settled failed: boom/);
      assert.deepEqual(err.settlement, {
        submissionId: "sub-1",
        outcome: "failed",
        error: { type: "submission_failed", message: "boom" },
      });
      return true;
    },
  );
});

test("an aborted settlement rejects as SettlementFault (ADR-0024's swept outcome)", async () => {
  const { fetch } = scriptedFetch([
    () => streamResponse([settledChunk("sub-1", "aborted", { type: "submission_aborted" })], "1"),
  ]);
  await assert.rejects(() => client(fetch).wait(admission), /submission settled aborted: submission_aborted/);
});

test("a 404 is a lost conversation — SettlementFault, never an endless poll (ADR-0027)", async () => {
  const { fetch } = scriptedFetch([() => new Response(JSON.stringify({ error: "no conversation" }), { status: 404 })]);
  await assert.rejects(
    () => client(fetch).wait(admission),
    (err: unknown) => err instanceof SettlementFault && /conversation lost/.test(err.message),
  );
});

test("a network failure reconnects from the SAME offset with backoff, indefinitely", async () => {
  const { calls, fetch } = scriptedFetch([
    () => Promise.reject(new Error("ECONNREFUSED")),
    () => Promise.reject(new Error("socket hang up")),
    () => streamResponse([settledChunk("sub-1", "completed")], "1"),
  ]);

  await client(fetch).wait(admission);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get("offset")),
    ["0", "0", "0"],
    "a failed read never advances the offset",
  );
});

test("a server hiccup (5xx) is reconnected like a network failure", async () => {
  const { calls, fetch } = scriptedFetch([
    () => new Response("oops", { status: 502 }),
    () => streamResponse([settledChunk("sub-1", "completed")], "1"),
  ]);
  await client(fetch).wait(admission);
  assert.equal(calls.length, 2);
});

test("a local abort propagates untranslated — abandon is not a fault", async () => {
  const { fetch } = scriptedFetch([
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      }),
  ]);
  const controller = new AbortController();

  const waitP = client(fetch).wait(admission, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    () => waitP,
    (err: unknown) => err instanceof Error && err.name === "AbortError" && !(err instanceof SettlementFault),
  );
});

test("a local abort during the reconnect backoff also propagates untranslated", async () => {
  const controller = new AbortController();
  const { fetch } = scriptedFetch([
    () => {
      setTimeout(() => controller.abort(), 10); // fires while wait sleeps off the failure
      return Promise.reject(new Error("ECONNREFUSED"));
    },
  ]);

  await assert.rejects(
    () =>
      createHarnessClient({
        baseUrl: "http://h.test",
        fetch,
        backoffInitialMs: 1_000, // long enough that the abort lands mid-sleep
      }).wait(admission, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("abort POSTs the third verb and drops the answer (ADR-0024)", async () => {
  const { calls, fetch } = scriptedFetch([() => new Response(JSON.stringify({ aborted: false }), { status: 200 })]);

  const result = await client(fetch).abort("coder", "inst-1");

  assert.equal(result, undefined);
  assert.equal(calls[0]!.url.toString(), "http://h.test/agents/coder/inst-1/abort");
  assert.equal(calls[0]!.init?.method, "POST");
});

test("createEchoPush POSTs the structured events to /echo, bearing the Instance token (ADR-0023)", async () => {
  const { calls, fetch } = scriptedFetch([() => new Response(JSON.stringify({ printed: 2 }), { status: 200 })]);
  const push = createEchoPush({ baseUrl: "http://ws.test", token: "instance-token", fetch });

  const events: EchoEvent[] = [
    { kind: "emit", event: { type: "note" } },
    { kind: "pick", agent: "decider", event: "approve" },
  ];
  await push(events);

  assert.equal(calls[0]!.url.toString(), "http://ws.test/echo");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, "Bearer instance-token");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { events });
});

test("a refused echo rejects with the wire's detail — the TEE decides fire-and-forget, not this client", async () => {
  const { fetch } = scriptedFetch([() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })]);
  const push = createEchoPush({ baseUrl: "http://ws.test", token: "stale", fetch });
  await assert.rejects(
    () => push([{ kind: "emit", event: { type: "note" } }]),
    (err: unknown) => err instanceof Error && /echo failed \(401\): unauthorized/.test(err.message),
  );
});
