// Menu tests (ADR-0013/0027/0029/0059): `readMenu` against the surface the Orchestrator serves, as
// the Custodian relays it — no pi here (menu-tools.test.ts). Asserted: the bare name (sanitized like
// flue did), the encoded-iid path, the Stand-in as the bearer on both routes, the event's schema as
// the item's parameters, the Menu and the Allowed picks read apart — and an older Orchestrator's
// `accepts` read as both (ADR-0029's skew) — a pick as one delivery whose receipt reads as prose and
// names the Allowed picks, that a turn that is over reads as NO surface rather than an empty Menu
// (ADR-0026), that a pick against a settled turn fails, that a deferred event refuses the turn, and
// the surface read's retry ladder (ADR-0042) — including the Custodian's own word that the
// Orchestrator never answered, and a stopping Orchestrator's 503 — while a pick is never retried.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedPicksText, readMenu, receiptProse, type DeliveryReceipt, type Surface } from "../src/menu.ts";

const STAND_IN = "jr2-held-JR2_SANDBOX_TOKEN";

const SURFACE: Surface = {
  instanceId: "run-1/reviewer",
  runId: "run-1",
  sandbox: "ws-1",
  allowed: ["review_verdict"],
  menu: [
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

/** The items of a read that found a live surface — every read here but the turn-is-over ones. */
async function menuOf(...args: Parameters<typeof readMenu>) {
  const read = await readMenu(...args);
  assert.ok(read, "a live surface");
  return read.menu;
}

test("the surface becomes the Menu: the bare name, sanitized, the event's schema as parameters", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json(SURFACE));
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  assert.deepEqual(
    menu.map((item) => [item.name, item.event]),
    [
      ["review_verdict", "review_verdict"],
      ["note_add", "note.add"],
    ],
  );
  assert.equal(menu[0]!.description, "Record the verdict.");
  // The real contract, not a rebuilt shape — minus the dialect tag model APIs do not take.
  assert.deepEqual(menu[0]!.parameters, {
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
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  const prose = await menu[0]!.pick({ verdict: "approved" });
  const post = calls[1]!;
  assert.equal(post.method, "POST");
  assert.equal(post.url, "http://127.0.0.1:8081/agents/run-1%2Freviewer/events");
  assert.equal(post.headers.authorization, `Bearer ${STAND_IN}`);
  assert.deepEqual(JSON.parse(post.body!), { type: "review_verdict", verdict: "approved" });
  assert.equal(prose, receiptProse(receipt));
  assert.match(receiptProse(receipt), /your turn is over/);
});

test("an argument named `type` cannot make a pick another event", async () => {
  const { fetch, calls } = fakeFetch((call) =>
    Response.json(
      call.method === "GET" ? SURFACE : { delivered: true, event: "note.add", turnComplete: false, deliveryId: "d" },
    ),
  );
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  await menu[1]!.pick({ type: "review_verdict", verdict: "approved" });
  assert.equal(JSON.parse(calls[1]!.body!).type, "note.add");
});

test("the receipt says a rejected pick was rejected, and reads an absent `moved` fail-open (ADR-0029)", () => {
  const base = { delivered: true, event: "review_verdict", turnComplete: false, deliveryId: "d-2" };
  assert.match(receiptProse({ ...base, moved: false }), /did NOT act on it.*Do not repeat this call unchanged/s);
  assert.match(receiptProse(base), /still in the state that asked for this turn/);
});

test("a turn that is over has NO surface — not an empty Menu (ADR-0026); a pick against it fails loudly", async () => {
  let live = true;
  const { fetch } = fakeFetch((call) => {
    if (!live) return Response.json({ error: "no live agent surface" }, { status: 404 });
    return call.method === "GET" ? Response.json(SURFACE) : Response.json({});
  });
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  live = false;
  assert.equal(await readMenu(opts(fetch), "run-1/reviewer"), undefined);
  await assert.rejects(() => menu[0]!.pick({ verdict: "approved" }), /this turn is over/);
});

test("the Menu and the Allowed picks are read apart: the tools are the Menu, whatever is allowed (ADR-0029)", async () => {
  const { fetch } = fakeFetch(() => Response.json({ ...SURFACE, allowed: ["note.add"] }));
  const read = await readMenu(opts(fetch), "run-1/reviewer");
  assert.deepEqual(
    read?.menu.map((item) => item.event),
    ["review_verdict", "note.add"],
  );
  assert.deepEqual(read?.allowed, ["note.add"]);
});

test("an older Orchestrator's `accepts` is read as both the tools and the Allowed picks (ADR-0029 skew)", async () => {
  const { menu: events, allowed: _allowed, ...rest } = SURFACE;
  const { fetch } = fakeFetch(() => Response.json({ ...rest, accepts: events }));
  const read = await readMenu(opts(fetch), "run-1/reviewer");
  assert.deepEqual(
    read?.menu.map((item) => item.event),
    ["review_verdict", "note.add"],
  );
  assert.deepEqual(read?.allowed, ["review_verdict", "note.add"]);
});

test("a Menu with no `allowed` beside it allows all of it — absent is not empty (ADR-0029)", async () => {
  const { allowed: _allowed, ...rest } = SURFACE;
  const { fetch } = fakeFetch(() => Response.json(rest));
  assert.deepEqual((await readMenu(opts(fetch), "run-1/reviewer"))?.allowed, ["review_verdict", "note.add"]);
});

test("the Allowed-picks text names each pick as the presenter names it, and says so when none is allowed", () => {
  assert.equal(allowedPicksText(["finish"]), "Allowed now: `finish`.");
  assert.equal(
    allowedPicksText(["finish", "note.add"], (name) => `mcp__jr2__${name}`),
    "Allowed now: `mcp__jr2__finish`, `mcp__jr2__note_add`.",
  );
  assert.match(allowedPicksText([]), /^Allowed now: none\b/);
});

test("a pick the workflow did not act on, or that left the turn open, says what is allowed now (ADR-0029)", async () => {
  const receipt: DeliveryReceipt = {
    delivered: true,
    event: "review_verdict",
    moved: false,
    turnComplete: false,
    deliveryId: "d-3",
    allowed: ["note.add"],
  };
  assert.match(receiptProse(receipt), /did NOT act on it.*Allowed now: `note_add`\./s);
  assert.match(receiptProse({ ...receipt, moved: true }), /not over yet.*Allowed now: `note_add`\./s);
  // An older Orchestrator sends no `allowed`: nothing is said, rather than "none".
  const { allowed: _a, ...old } = receipt;
  assert.doesNotMatch(receiptProse(old), /Allowed now/);
  // A pick that ended the turn says nothing of picks: there are none left to make.
  assert.doesNotMatch(receiptProse({ ...receipt, moved: true, turnComplete: true }), /Allowed now/);

  // The presenter's names reach the receipt a pick answers with.
  const { fetch } = fakeFetch((call) => Response.json(call.method === "GET" ? SURFACE : receipt));
  const menu = await menuOf({ ...opts(fetch), toolName: (name) => `mcp__jr2__${name}` }, "run-1/reviewer");
  assert.match(await menu[0]!.pick({ verdict: "x" }), /Allowed now: `mcp__jr2__note_add`\./);
});

test("a pick outside the Allowed picks is refused, and the refusal names them (ADR-0029)", async () => {
  const { fetch } = fakeFetch((call) =>
    call.method === "GET"
      ? Response.json(SURFACE)
      : Response.json(
          { error: 'event "review_verdict" is not accepted by the invoking state', allowed: ["note.add"] },
          { status: 400 },
        ),
  );
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  await assert.rejects(
    () => menu[0]!.pick({ verdict: "approved" }),
    /not accepted by the invoking state.*Allowed now: `note_add`\./s,
  );
});

test("a stopping Orchestrator's 503 is re-asked on the surface read (ADR-0026/0042)", async () => {
  let n = 0;
  const lines: string[] = [];
  const { fetch } = fakeFetch(() => {
    n += 1;
    if (n <= 2) return Response.json({ error: "the Orchestrator is stopping" }, { status: 503 });
    return Response.json(SURFACE);
  });
  const menu = await menuOf(
    { ...opts(fetch), retryInitialMs: 1, retryMaxMs: 2, log: (l) => lines.push(l) },
    "run-1/reviewer",
  );
  assert.equal(menu.length, 2);
  assert.equal(n, 3);
  assert.match(lines[0]!, /attempts=3 ms=\d+ last=503 /);
});

test("a surface read that only ever gets 503 fails when the window closes, and says the Orchestrator was unavailable", async () => {
  const { fetch } = fakeFetch(() => Response.json({ error: "the Orchestrator is stopping" }, { status: 503 }));
  await assert.rejects(
    () => readMenu({ ...opts(fetch), retryInitialMs: 1, retryMaxMs: 1, retryWindowMs: 5 }, "run-1/reviewer"),
    /the Orchestrator never answered .*: HTTP 503 .*the Orchestrator is stopping/,
  );
});

test("a pick that gets 503 says try it again, and is NOT re-sent (ADR-0026/0042)", async () => {
  const { fetch, calls } = fakeFetch((call) =>
    call.method === "GET"
      ? Response.json(SURFACE)
      : Response.json({ error: "the Orchestrator is stopping" }, { status: 503 }),
  );
  const menu = await menuOf(opts(fetch), "run-1/reviewer");
  await assert.rejects(() => menu[0]!.pick({ verdict: "approved" }), /try it again/);
  assert.equal(
    calls.filter((c) => c.method === "POST").length,
    1,
    "one POST — a duplicate pick is a duplicate transition",
  );
});

test("an Orchestrator refusal is loud — a 403 is not an empty Menu", async () => {
  const { fetch } = fakeFetch(() => Response.json({ error: "this token cannot speak for instance" }, { status: 403 }));
  await assert.rejects(() => readMenu(opts(fetch), "run-1/reviewer"), /this token cannot speak/);
});

test("a deferred event refuses the turn — a tool whose result never comes is a lie (ADR-0013)", async () => {
  const deferred = { ...SURFACE, menu: [{ ...SURFACE.menu![0]!, semantics: "deferred" as const }] };
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
  const menu = await menuOf(
    { ...opts(fetch), retryInitialMs: 1, retryMaxMs: 2, log: (l) => lines.push(l) },
    "run-1/reviewer",
  );
  assert.equal(menu.length, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^jr2\.routability seat=surface attempts=3 ms=\d+ last=custodian:UF url=/);

  // A first-time read stays silent.
  lines.length = 0;
  await menuOf({ ...opts(fakeFetch(() => Response.json(SURFACE)).fetch), log: (l) => lines.push(l) }, "x");
  assert.deepEqual(lines, []);
});

test("a surface read with no answer is ended and retried; a window that closes on one says so", async () => {
  let n = 0;
  const lines: string[] = [];
  const { fetch } = fakeFetch(() => {
    n += 1;
    // Accepted, and never answered: a hung Custodian or Orchestrator.
    if (n === 1) return new Promise<Response>(() => {});
    return Response.json(SURFACE);
  });
  const hanging = (f: typeof fetch): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.race([
        f(input, init),
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error), { once: true }),
        ),
      ])) as typeof fetch;
  const menu = await menuOf(
    { ...opts(hanging(fetch)), attemptTimeoutMs: 20, retryInitialMs: 1, retryMaxMs: 1, log: (l) => lines.push(l) },
    "run-1/reviewer",
  );
  assert.equal(menu.length, 2);
  assert.match(lines[0]!, /attempts=2 ms=\d+ last=timeout /);

  const never = hanging((() => new Promise<Response>(() => {})) as typeof fetch);
  await assert.rejects(
    () => readMenu({ ...opts(never), attemptTimeoutMs: 5, retryInitialMs: 1, retryMaxMs: 1, retryWindowMs: 5 }, "x"),
    /the Orchestrator never answered .*: no answer within 5 ms/,
  );
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
    const menu = await menuOf({ url, token: STAND_IN }, "run-1/reviewer");
    await menu[1]!.pick({});
    assert.deepEqual(seen, [
      `GET /agents/run-1%2Freviewer/surface Bearer ${STAND_IN}`,
      `POST /agents/run-1%2Freviewer/events Bearer ${STAND_IN}`,
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
