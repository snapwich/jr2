// Adapter tests (ADR-0013): the translation, driven by a REAL MCP client over a real socket — the
// same wire flue's `connectMcpServer` speaks — against a fake Orchestrator. What is asserted is
// that the Adapter is a faithful translator and an honest one:
//
//   - `tools/list` IS the turn's surface (nothing else can be called);
//   - `tools/call` becomes one authenticated delivery, and the receipt comes back;
//   - a settled turn has an EMPTY menu rather than a stale one, and picking against it still fails;
//   - the Sandbox token is on every request (the Agent's own container has no such thing);
//   - a `deferred`/`poll` event is REFUSED, not degraded to a fire-and-forget tool;
//   - an ask (ADR-0053) is forwarded to this Sandbox's fetch route and its answer relayed unread.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OrchestratorClient, type Surface } from "../src/adapter.ts";
import { startAdapter } from "../src/serve.ts";

const TOKEN = "ws-1.signed";

/** A fake Orchestrator: serves one surface, records what was delivered — and what bearer arrived. */
function fakeOrchestrator(surface: Surface | undefined, turnComplete = true, moved?: boolean) {
  const seen: { bearers: string[]; delivered: Array<Record<string, unknown>> } = { bearers: [], delivered: [] };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.bearers.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
    if (!surface) return new Response(JSON.stringify({ error: "no live agent surface" }), { status: 404 });
    if (url.endsWith("/surface")) return Response.json(surface);
    const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.delivered.push(event);
    return Response.json({ delivered: true, event: event.type, moved, turnComplete, deliveryId: "d-1" });
  };
  return {
    seen,
    client: new OrchestratorClient({ url: "http://orchestrator.invalid", token: TOKEN, fetch: fetchImpl }),
  };
}

const REVIEW_SURFACE: Surface = {
  instanceId: "iid-1",
  runId: "run-1",
  sandbox: "ws-1",
  accepts: [
    {
      name: "request_review",
      description: "Hand the work off for review.",
      input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      semantics: "ack",
    },
    { name: "done", input: { type: "object", properties: {} }, semantics: "ack" },
  ],
};

/** Start the Adapter and connect a real MCP client to one agent's turn, as the Harness would. */
async function connect(orchestrator: OrchestratorClient, instanceId = "iid-1") {
  const adapter = await startAdapter({ orchestrator, port: 0 });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${adapter.url}/mcp/${instanceId}`)));
  return {
    client,
    close: async () => {
      await client.close();
      await adapter.close();
    },
  };
}

test("tools/list is the turn's surface, with the def's schema as the tool's", async () => {
  const { client, close } = await connect(fakeOrchestrator(REVIEW_SURFACE).client);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["done", "request_review"],
      "the Agent can call exactly what the invoking state accepts",
    );
    const review = tools.find((t) => t.name === "request_review");
    assert.equal(review?.description, "Hand the work off for review.");
    assert.deepEqual(review?.inputSchema.required, ["summary"], "the advertised signature survives the round trip");
  } finally {
    await close();
  }
});

test("tools/call becomes one authenticated delivery, and the receipt comes back", async () => {
  const { seen, client: orch } = fakeOrchestrator(REVIEW_SURFACE);
  const { client, close } = await connect(orch);
  try {
    const result = await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });

    assert.deepEqual(seen.delivered, [{ type: "request_review", summary: "PR up" }], "the pick, as a run event");
    assert.deepEqual(
      result.structuredContent,
      { delivered: true, event: "request_review", turnComplete: true, deliveryId: "d-1" },
      "the delivery receipt reaches the Agent",
    );
    // The Sandbox token rides EVERY request. It came from a Secret mounted into this container
    // alone — the Agent, next door with code execution, has no way to read it.
    assert.ok(
      seen.bearers.every((b) => b === `Bearer ${TOKEN}`),
      `every call to the Orchestrator is authenticated (saw: ${seen.bearers.join(", ")})`,
    );
  } finally {
    await close();
  }
});

test("the receipt reads as PROSE, because that is what a model acts on (ADR-0024)", async () => {
  const over = await connect(fakeOrchestrator(REVIEW_SURFACE, true).client);
  try {
    const result = await over.client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    // A bare UUID told the Agent nothing about whether it was finished, and the retry that invited
    // is the failure ADR-0024 closes. The end of the turn must be stated, in words.
    assert.match(text, /request_review/);
    assert.match(text, /turn is over/i);
    assert.match(text, /stop/i);
  } finally {
    await over.close();
  }

  const open = await connect(fakeOrchestrator(REVIEW_SURFACE, false).client);
  try {
    const result = await open.client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    // The hint fails conservatively: an unmoved workflow is never reported as an ended turn.
    assert.doesNotMatch(text, /turn is over/i);
  } finally {
    await open.close();
  }
});

test("a rejected pick is told it was rejected, not that the turn is merely unfinished (ADR-0029)", async () => {
  const { client, close } = await connect(fakeOrchestrator(REVIEW_SURFACE, false, false).client);
  try {
    const result = await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    // "still in the state that asked for this turn" is TRUE here and useless: it reads as progress,
    // and the model answers it by calling again. Say the thing it can act on.
    assert.match(text, /did NOT act on it/);
    assert.match(text, /not repeat this call unchanged/i);
    assert.doesNotMatch(text, /turn is over/i);
  } finally {
    await close();
  }
});

test("an Orchestrator too old to report `moved` is not read as rejecting everything", async () => {
  // The Adapter ships as a stock image and the Orchestrator as the instance image (ADR-0027), so
  // the two can skew. Absent must mean unknown, not rejected — every receipt would say "did NOT act
  // on it" on the happy path, which is the cry-wolf failure ADR-0026 already paid for once.
  const { client, close } = await connect(fakeOrchestrator(REVIEW_SURFACE, true, undefined).client);
  try {
    const result = await client.callTool({ name: "request_review", arguments: { summary: "PR up" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /turn is over/i);
    assert.doesNotMatch(text, /did NOT act on it/);
  } finally {
    await close();
  }
});

test("a settled turn has an EMPTY menu, not a stale one and not an error (ADR-0026)", async () => {
  const { client, close } = await connect(fakeOrchestrator(undefined).client, "iid-gone");
  try {
    // The turn is over, so there is nothing to call. That is a complete answer, and the Harness
    // re-initializing after the turn (to write flue's abort advisory) gets it without an error —
    // which is the whole point: a 404 here fired on every SUCCESSFUL turn.
    assert.deepEqual((await client.listTools()).tools, []);
  } finally {
    await close();
  }
});

test("picking against a settled turn fails — an empty menu is not a permissive one", async () => {
  const { client, close } = await connect(fakeOrchestrator(undefined).client, "iid-gone");
  try {
    // Acting is where the claim actually matters, and it is still refused. The surface path went
    // quiet (ADR-0026); this one did not.
    await assert.rejects(client.callTool({ name: "request_review", arguments: { summary: "late" } }));
  } finally {
    await close();
  }
});

test("a deferred event is refused, not degraded to a fire-and-forget tool", async () => {
  const deferred: Surface = {
    ...REVIEW_SURFACE,
    accepts: [
      {
        name: "request_approval",
        input: { type: "object", properties: { action: { type: "string" } } },
        semantics: "deferred",
      },
    ],
  };
  const adapter = await startAdapter({ orchestrator: fakeOrchestrator(deferred).client, port: 0 });
  try {
    // Serving this as an ordinary tool would promise the Agent a result the Machine never sends.
    // Better to fail the turn loudly than to hand it a contract that is a lie (ADR-0013).
    const res = await fetch(`${adapter.url}/mcp/iid-1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /reserved, not built/);
  } finally {
    await adapter.close();
  }
});

test("a surface read that never connected is retried — an Orchestrator Service between endpoints does not kill the turn", async () => {
  // ADR-0042, one hop over from the admission it was written for. The Adapter dials the
  // Orchestrator's Service, and that Service is between EndpointSlices every time the Orchestrator
  // restarts (which ADR-0007's restore makes an ordinary event) and for a moment after a fresh
  // namespace converges. Un-retried, the turn behind it settles `failed` before the model is asked
  // once — the Harness fetches its Menu first, so the whole turn rides on this GET.
  let attempts = 0;
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    attempts += 1;
    if (attempts <= 2) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.7:4000"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      });
    }
    if (String(input).endsWith("/surface")) return Response.json(REVIEW_SURFACE);
    return Response.json({ delivered: true, event: "done", turnComplete: true, deliveryId: "d-1" });
  };
  const client = new OrchestratorClient({
    url: "http://orchestrator.invalid",
    token: TOKEN,
    fetch: fetchImpl,
    retryInitialMs: 1,
    retryMaxMs: 2,
    retryWindowMs: 500,
  });

  const surface = await client.surface("iid-1");

  assert.equal(attempts, 3, "it re-asked until the Service answered");
  assert.deepEqual(
    surface.accepts.map((a) => a.name),
    ["request_review", "done"],
  );
});

test("a retried surface read reports what it cost, and a first-time connect stays silent", async () => {
  // The same contract the Orchestrator's admission emits, from the other seat — parsed by
  // features/steps/kind.steps.ts to hold the tier's routability budget.
  const lines: string[] = [];
  let attempts = 0;
  const fetchImpl: typeof globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.7:4000"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      });
    }
    return Response.json(REVIEW_SURFACE);
  };
  const opts = { url: "http://orchestrator.invalid", token: TOKEN, retryInitialMs: 1, retryMaxMs: 2 };
  const client = new OrchestratorClient({ ...opts, fetch: fetchImpl, log: (line) => lines.push(line) });

  await client.surface("iid-1");
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    /^j2\.routability seat=surface attempts=2 ms=\d+ last=ECONNREFUSED url=http:\/\/orchestrator\.invalid\/agents\/iid-1\/surface$/,
  );

  // A second client whose very first attempt connects says nothing at all.
  const quiet: string[] = [];
  await new OrchestratorClient({
    ...opts,
    fetch: async () => Response.json(REVIEW_SURFACE),
    log: (line) => quiet.push(line),
  }).surface("iid-1");
  assert.deepEqual(quiet, []);
});

test("a surface read whose window closes names the address, not `fetch failed`", async () => {
  const fetchImpl: typeof globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.7:4000"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      }),
    });
  };
  const client = new OrchestratorClient({
    url: "http://orchestrator.invalid",
    token: TOKEN,
    fetch: fetchImpl,
    retryInitialMs: 1,
    retryMaxMs: 2,
    retryWindowMs: 20,
  });

  await assert.rejects(() => client.surface("iid-1"), /ECONNREFUSED 10\.96\.0\.7:4000/);
});

// The ask (ADR-0053): `POST /fetch` on the same loopback listener. Its caller is not the Agent and
// not MCP — it is `j2-upload-pack`, the program git runs for `origin`'s fetch url, on behalf of
// whoever typed `git fetch` in the pod. What is asserted is that the Adapter forwards the one verb,
// scoped to this Sandbox and carrying the token, and hands the answer back unread.

/** A fake Orchestrator for the ask path: records the ask, answers what the test dictates. */
function fakeAskOrchestrator(
  answer: Response | (() => Promise<Response>),
  opts: { sandbox?: string } = { sandbox: "ws-1" },
) {
  const seen: Array<{ url: string; bearer: string; body: unknown; method: string }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    seen.push({
      url: String(input),
      bearer: String((init?.headers as Record<string, string> | undefined)?.authorization),
      body: JSON.parse(String(init?.body)) as unknown,
      method: String(init?.method),
    });
    return typeof answer === "function" ? await answer() : answer.clone();
  };
  return {
    seen,
    client: new OrchestratorClient({
      url: "http://orchestrator.invalid",
      token: TOKEN,
      sandbox: opts.sandbox,
      fetch: fetchImpl,
      askTimeoutMs: 500,
    }),
  };
}

/** Ask the way the program does: one POST to the loopback listener, and read what comes back. */
async function ask(orchestrator: OrchestratorClient, body: string) {
  const adapter = await startAdapter({ orchestrator, port: 0 });
  try {
    const res = await fetch(`${adapter.url}/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    await adapter.close();
  }
}

test("an ask becomes one authenticated POST to this Sandbox's fetch route", async () => {
  const { seen, client } = fakeAskOrchestrator(Response.json({ fetched: "2026-09-13T10:00:00.000Z" }));

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/app" }));

  assert.deepEqual(seen, [
    {
      // The Sandbox is named in the path, and the token is checked against it: this pod can ask for
      // the caches it mounts and nothing else.
      url: "http://orchestrator.invalid/sandboxes/ws-1/fetch",
      bearer: `Bearer ${TOKEN}`,
      body: { identity: "github.com/acme/app" },
      method: "POST",
    },
  ]);
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { fetched: "2026-09-13T10:00:00.000Z" });
});

test("a stale landing is relayed exactly as the Orchestrator wrote it", async () => {
  // The Adapter forms no opinion about freshness. `stale` is the Orchestrator's verdict and the
  // program's decision — serve the cache, warn on stderr — so anything read or reshaped here would
  // be a second opinion about a question that already has one (ADR-0053).
  const stale = { stale: "fatal: could not read Username for 'https://github.com'", asOf: "2026-09-13T09:00:00.000Z" };
  const { client } = fakeAskOrchestrator(Response.json(stale));

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/app" }));

  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), stale);
});

test("a refused ask keeps the Orchestrator's status — the program is told, not fooled", async () => {
  // A Repo the Sandbox does not mount is a 404 naming the identity, and a 404 must arrive as a 404:
  // the program falls through to the cache on anything that is not a landing, and a status the
  // Adapter softened would hide a scope error behind a freshness one.
  const { client } = fakeAskOrchestrator(
    new Response(JSON.stringify({ error: 'this Sandbox mounts no Repo "github.com/acme/other"' }), { status: 404 }),
  );

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/other" }));

  assert.equal(answer.status, 404);
  assert.match(JSON.parse(answer.body).error as string, /mounts no Repo/);
});

test("an Orchestrator that never answered is an answer, and it names the address", async () => {
  // The ask never throws its way back to git: every failure is the same instruction to the program
  // — serve the cache and say so — and `fetch failed` in a human's terminal diagnoses nothing.
  const { client } = fakeAskOrchestrator(async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.7:4000"), { code: "ECONNREFUSED" }),
    });
  });

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/app" }));

  assert.equal(answer.status, 502);
  assert.match(
    JSON.parse(answer.body).error as string,
    /sandboxes\/ws-1\/fetch: connect ECONNREFUSED 10\.96\.0\.7:4000/,
  );
});

test("an Orchestrator that outruns the ask's budget answers too, rather than hanging the fetch", async () => {
  // The route's own wait is bounded (ADR-0053), so a hop that outlives it is a lost request. The
  // program has its own deadline behind this one; going quiet here would spend it for nothing.
  const fetchImpl: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, "the ask carries its own deadline");
      signal.addEventListener("abort", () => reject(signal.reason as Error));
    });
  const client = new OrchestratorClient({
    url: "http://orchestrator.invalid",
    token: TOKEN,
    sandbox: "ws-1",
    fetch: fetchImpl,
    askTimeoutMs: 20,
  });

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/app" }));

  assert.equal(answer.status, 502);
  assert.match((JSON.parse(answer.body) as { error: string }).error, /timeout|abort/i);
});

test("an ask with no identity is refused before the Orchestrator is troubled", async () => {
  const { seen, client } = fakeAskOrchestrator(Response.json({ fetched: "2026-09-13T10:00:00.000Z" }));

  assert.equal((await ask(client, JSON.stringify({}))).status, 400);
  assert.equal((await ask(client, "not json")).status, 400);
  assert.deepEqual(seen, [], "nothing was forwarded");
});

test("an Adapter with no Sandbox says so — the Instance Harness mounts no Repo", async () => {
  // ADR-0031's placement pairs a Harness with an Adapter and no worktree, so there is no cache to
  // ask for and nothing to name in the path. The ability is ambient in a Workspace pod and absent
  // here, which is the answer, not a failure.
  const { seen, client } = fakeAskOrchestrator(Response.json({ fetched: "2026-09-13T10:00:00.000Z" }), {});

  const answer = await ask(client, JSON.stringify({ identity: "github.com/acme/app" }));

  assert.equal(answer.status, 404);
  assert.match(JSON.parse(answer.body).error as string, /serves no Sandbox/);
  assert.deepEqual(seen, []);
});

test("the ask is POST, and every other path is still the Agent's or nothing", async () => {
  const adapter = await startAdapter({ orchestrator: fakeAskOrchestrator(Response.json({})).client, port: 0 });
  try {
    assert.equal((await fetch(`${adapter.url}/fetch`)).status, 405, "a GET is not an ask");
    assert.equal((await fetch(`${adapter.url}/healthz`)).status, 200, "the health route is untouched");
    assert.equal((await fetch(`${adapter.url}/fetches`)).status, 404, "and the Adapter forwards no other verb");
  } finally {
    await adapter.close();
  }
});
