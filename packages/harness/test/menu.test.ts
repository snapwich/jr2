// Menu tests (ADR-0013/0027/0059): `readMenu` against the surface the Orchestrator serves, as the
// Custodian relays it. Asserted: the `mcp__jr2__<name>` naming (sanitized like flue did), the
// encoded-iid path, the Stand-in as the bearer on both routes, the event's schema as the tool's
// parameters, a pick as one delivery whose receipt reads as prose, that an empty Menu is zero tools
// and no error (ADR-0026), that a pick against a settled turn fails, that a deferred event refuses
// the turn, and the surface read's retry ladder (ADR-0042) — including the Custodian's own word
// that the Orchestrator never answered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readMenu, receiptProse, type DeliveryReceipt, type Surface } from "../src/menu.ts";

const STAND_IN = "jr2-held-JR2_SANDBOX_TOKEN";

const SURFACE: Surface = {
  instanceId: "run-1/reviewer",
  runId: "run-1",
  sandbox: "ws-1",
  accepts: [
    {
      name: "review_verdict",
      description: "Record the verdict.",
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { verdict: { type: "string", enum: ["approved", "changes"] } },
        required: ["verdict"],
        additionalProperties: false,
      },
      semantics: "ack",
    },
    { name: "note.add", input: { type: "object", properties: {} }, semantics: "ack" },
  ],
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fetch that answers like the Custodian relaying the Orchestrator. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  };
}

const opts = (f: typeof fetch) => ({ url: "http://127.0.0.1:8081/", token: STAND_IN, fetch: f, log: () => {} });

test("the surface becomes the Menu: mcp__jr2__<name>, sanitized, the event's schema as parameters", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(SURFACE));
  const menu = await readMenu(opts(fetch), "run-1/reviewer");
  assert.deepEqual(
    menu.tools.map((t) => [t.name, t.label]),
    [
      ["mcp__jr2__review_verdict", "review_verdict"],
      ["mcp__jr2__note_add", "note.add"],
    ],
  );
  assert.equal(menu.tools[0]!.description, "Record the verdict.");
  // The real contract, not a rebuilt shape — minus the dialect tag model APIs do not take.
  assert.deepEqual(menu.tools[0]!.parameters, {
    type: "object",
    properties: { verdict: { type: "string", enum: ["approved", "changes"] } },
    required: ["verdict"],
    additionalProperties: false,
  });
  // The iid is ONE path segment on the wire, and the bearer is the Stand-in — never a token.
  assert.equal(calls[0]!.url, "http://127.0.0.1:8081/agents/run-1%2Freviewer/surface");
  assert.equal(calls[0]!.headers.authorization, `Bearer ${STAND_IN}`);
});

test("a pick is one delivery with the Stand-in, and the receipt comes back as prose", async () => {
  const receipt: DeliveryReceipt = {
    delivered: true,
    event: "review_verdict",
    moved: true,
    turnComplete: true,
    deliveryId: "d-1",
  };
  const { fetch, calls } = fakeFetch((call) => Response.json(call.method === "GET" ? SURFACE : receipt));
  const menu = await readMenu(opts(fetch), "run-1/reviewer");
  const result = await menu.tools[0]!.execute("call-1", { verdict: "approved" } as never, undefined as never);
  const post = calls[1]!;
  assert.equal(post.method, "POST");
  assert.equal(post.url, "http://127.0.0.1:8081/agents/run-1%2Freviewer/events");
  assert.equal(post.headers.authorization, `Bearer ${STAND_IN}`);
  assert.deepEqual(JSON.parse(post.body!), { type: "review_verdict", verdict: "approved" });
  assert.deepEqual(result.content, [{ type: "text", text: receiptProse(receipt) }]);
  assert.match(receiptProse(receipt), /your turn is over/);
});

test("the receipt says a rejected pick was rejected, and reads an absent `moved` fail-open (ADR-0029)", () => {
  const base = { delivered: true, event: "review_verdict", turnComplete: false, deliveryId: "d-2" };
  assert.match(receiptProse({ ...base, moved: false }), /did NOT act on it.*Do not repeat this call unchanged/s);
  assert.match(receiptProse(base), /still in the state that asked for this turn/);
});

test("a turn that is over has an EMPTY Menu, not an error (ADR-0026); a pick against it fails loudly", async () => {
  let live = true;
  const { fetch } = fakeFetch((call) => {
    if (!live) return Response.json({ error: "no live agent surface" }, { status: 404 });
    return call.method === "GET" ? Response.json(SURFACE) : Response.json({});
  });
  const menu = await readMenu(opts(fetch), "run-1/reviewer");
  live = false;
  assert.deepEqual((await readMenu(opts(fetch), "run-1/reviewer")).tools, []);
  await assert.rejects(
    () => menu.tools[0]!.execute("call-1", { verdict: "approved" } as never, undefined as never),
    /this turn is over/,
  );
});

test("an Orchestrator refusal is loud — a 403 is not an empty Menu", async () => {
  const { fetch } = fakeFetch(() => Response.json({ error: "this token cannot speak for instance" }, { status: 403 }));
  await assert.rejects(() => readMenu(opts(fetch), "run-1/reviewer"), /this token cannot speak/);
});

test("a deferred event refuses the turn — a tool whose result never comes is a lie (ADR-0013)", async () => {
  const deferred = { ...SURFACE, accepts: [{ ...SURFACE.accepts[0]!, semantics: "deferred" as const }] };
  const { fetch } = fakeFetch(() => Response.json(deferred));
  await assert.rejects(() => readMenu(opts(fetch), "run-1/reviewer"), /`deferred`.*reserved, not built/);
});

test("a surface read that never got an answer is retried, and what it cost is logged once (ADR-0042)", async () => {
  let n = 0;
  const lines: string[] = [];
  const { fetch } = fakeFetch(() => {
    n += 1;
    if (n === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    if (n === 2) {
      // The Custodian's own word: it could not reach the Orchestrator's Service (custodian.ts).
      return Response.json(
        {
          error: "the Orchestrator never answered through the Custodian",
          detail: "delayed_connect_error",
          flags: "UF",
        },
        { status: 502, headers: { "x-jr2-custodian": "unreachable" } },
      );
    }
    return Response.json(SURFACE);
  });
  const menu = await readMenu(
    { ...opts(fetch), retryInitialMs: 1, retryMaxMs: 2, log: (l) => lines.push(l) },
    "run-1/reviewer",
  );
  assert.equal(menu.tools.length, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^jr2\.routability seat=surface attempts=3 ms=\d+ last=custodian:UF url=/);

  // A first-time read stays silent.
  lines.length = 0;
  await readMenu({ ...opts(fakeFetch(() => Response.json(SURFACE)).fetch), log: (l) => lines.push(l) }, "x");
  assert.deepEqual(lines, []);
});

test("a surface read whose window closes names the address and the reason, not `fetch failed`", async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8081") });
  });
  await assert.rejects(
    () => readMenu({ ...opts(fetch), retryInitialMs: 1, retryMaxMs: 1, retryWindowMs: 5 }, "run-1/reviewer"),
    /the Orchestrator never answered http:\/\/127\.0\.0\.1:8081\/agents\/run-1%2Freviewer\/surface: connect ECONNREFUSED/,
  );
});

test("the Submission's signal ends a read in flight at once (ADR-0024 hot path)", async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error("swept")), 20);
  await assert.rejects(
    () => readMenu({ ...opts(fetch), retryInitialMs: 10_000, retryMaxMs: 10_000 }, "run-1/reviewer", controller.signal),
    /swept/,
  );
  assert.ok(Date.now() - started < 2000);
});

test("over a real socket: the Menu reads and delivers through whatever answers at the Custodian's address", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    let body = "";
    req.on("data", (b: Buffer) => (body += b));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.method === "GET"
            ? SURFACE
            : { delivered: true, event: JSON.parse(body).type, turnComplete: true, deliveryId: "d-9" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const menu = await readMenu({ url, token: STAND_IN }, "run-1/reviewer");
    await menu.tools[1]!.execute("call-1", {} as never, undefined as never);
    assert.deepEqual(seen, [
      `GET /agents/run-1%2Freviewer/surface Bearer ${STAND_IN}`,
      `POST /agents/run-1%2Freviewer/events Bearer ${STAND_IN}`,
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
