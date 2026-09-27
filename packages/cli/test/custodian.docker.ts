// The Custodian suite (ADR-0059): the claims about the Custodian that only real sockets can check,
// against the REAL engine — the pinned Envoy image, running the bootstrap and script `jr2 up`
// renders. The list of cases is the same in every held-secret design; see the rig for what is
// faked (the pod, and the providers).
//
// Opt-in: `just custodian-test` (docker + the pinned image). Not in `pnpm -r test`, because the
// default gate needs no infrastructure (ADR-0010).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { leafStem, standIn, type HeldManifest } from "@jr2/orchestrator";
import {
  connectThrough,
  controlRequest,
  lanAddress,
  requestThrough,
  SANDBOX_TOKEN,
  startCustodian,
  startFakeOrchestrator,
  startUpstream,
  type Custodian,
  type Upstream,
} from "./support/custodian-rig.ts";

const VALUES = {
  ANTHROPIC_API_KEY: "sk-ant-value-one",
  GATEWAY_TOKEN: "gw-value-two",
  LITELLM_KEY: "ll-value-three",
  UNTRUSTED_KEY: "un-value-four",
};

let a: Upstream; // bound: two secrets
let b: Upstream; // bound: a paths-narrowed secret
let c: Upstream; // unbound: tunneled
let d: Upstream; // bound, but its CA is not in upstream.crt
let orchestrator: Awaited<ReturnType<typeof startFakeOrchestrator>>;
let custodian: Custodian;

/** Envoy flushes its access log on an interval, so a line is waited for, not read at once. */
async function logLines(count: number, match: (line: string) => boolean): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = custodian.output().split("\n").filter(match);
    if (lines.length >= count || Date.now() > deadline) return lines;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bound = (u: Upstream) => ({ host: u.host, port: u.port, leaf: leafStem(u.host, u.port) });

before(async () => {
  [a, b, c, d] = await Promise.all([startUpstream(), startUpstream(), startUpstream(), startUpstream()]);
  orchestrator = await startFakeOrchestrator();
  const manifest: HeldManifest = {
    version: 1,
    secrets: [
      { name: "ANTHROPIC_API_KEY", source: { kind: "literal" }, hosts: [bound(a)], headers: ["x-api-key"] },
      { name: "GATEWAY_TOKEN", source: { kind: "literal" }, hosts: [bound(a)], headers: ["authorization"] },
      {
        name: "LITELLM_KEY",
        source: { kind: "literal" },
        hosts: [bound(b)],
        headers: ["authorization", "x-api-key"],
        paths: ["/v1/messages"],
      },
      { name: "UNTRUSTED_KEY", source: { kind: "literal" }, hosts: [bound(d)], headers: ["x-api-key"] },
    ],
  };
  custodian = await startCustodian({
    manifest,
    // Case 11: one trailing line end is what `kubectl create secret --from-file` writes.
    values: { ...VALUES, ANTHROPIC_API_KEY: `${VALUES.ANTHROPIC_API_KEY}\n` },
    upstreamCas: [a.ca.cert, b.ca.cert, c.ca.cert],
    orchestrator: { host: lanAddress(), port: orchestrator.port },
    sandbox: "ws-1",
    // Names that RESOLVE to guarded addresses — the half of the dial guard a spelling cannot show.
    names: {
      "loop.guard.test": "127.0.0.1",
      "meta.guard.test": "169.254.169.254",
      "loop6.guard.test": "::1",
      "fine.guard.test": lanAddress(),
    },
  });
});

after(async () => {
  await custodian?.stop();
  await Promise.all([a, b, c, d].map((u) => u?.close()));
  await orchestrator?.close();
});

const via = (
  u: Upstream,
  opts: Parameters<typeof requestThrough>[2] extends infer O ? Omit<O & object, "ca"> : never,
) => requestThrough(custodian.ports.egress, { host: u.host, port: u.port }, { ca: custodian.extraCa, ...opts });

describe("toward a bound host", () => {
  test("1. the Stand-in is swapped: x-api-key alone, Bearer, and two secrets in one request", async () => {
    let r = await via(a, { headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY, "the value, its trailing newline gone");
    // Nothing added either way (§5.4): no server, no x-envoy-*, no x-forwarded-*, no x-request-id.
    assert.equal(r.headers.server, undefined);
    assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("x-envoy")), JSON.stringify(r.headers));
    const up = a.seen.at(-1)!.headers;
    assert.ok(
      !Object.keys(up).some((h) => /^(x-envoy|x-forwarded|x-request-id|via)/.test(h)),
      `the upstream got only the client's headers: ${Object.keys(up).join(", ")}`,
    );

    r = await via(a, { headers: { authorization: `Bearer ${standIn("GATEWAY_TOKEN")}` } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.GATEWAY_TOKEN}`);

    r = await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY"), authorization: `Bearer ${standIn("GATEWAY_TOKEN")}` },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY);
    assert.equal(a.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.GATEWAY_TOKEN}`);
  });

  test("2. no Stand-in → 403, and the upstream receives nothing", async () => {
    const before = a.seen.length;
    const r = await via(a, { headers: { "x-api-key": "sk-something-else" } });
    assert.equal(r.status, 403);
    assert.match(r.body, /needs the stand-in of ANTHROPIC_API_KEY, GATEWAY_TOKEN/);
    assert.equal(a.seen.length, before);
  });

  test("3. a foreign credential beside a swap is stripped; a duplicate credential header → 400", async () => {
    let r = await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY"), authorization: "Bearer mine", "api-key": "also-mine" },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.authorization, undefined);
    assert.equal(a.seen.at(-1)?.headers["api-key"], undefined);
    const before = a.seen.length;
    r = await via(a, { headers: { "x-api-key": [standIn("ANTHROPIC_API_KEY"), standIn("ANTHROPIC_API_KEY")] } });
    assert.equal(r.status, 400);
    assert.equal(a.seen.length, before);
  });

  test("3b. a method outside the list → 405; an underscore header → 400; nothing is sent", async () => {
    const before = a.seen.length;
    const k = { "x-api-key": standIn("ANTHROPIC_API_KEY") };
    for (const method of ["TRACE", "PROPFIND"]) {
      const r = await via(a, { method, headers: k });
      assert.equal(r.status, 405, method);
    }
    const r = await via(a, { headers: { ...k, x_api_key: "mine" } });
    assert.equal(r.status, 400);
    assert.equal(a.seen.length, before);
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal((await via(a, { method, headers: k })).status, 200, method);
    }
  });

  test("3c. a header the Connection header names never leaves; two Host headers → 421", async () => {
    const before = a.seen.length;
    // Envoy drops what Connection names before the swap, so the request has no Stand-in.
    let r = await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY"), connection: "keep-alive, x-api-key" },
    });
    assert.equal(r.status, 403);
    r = await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY"), host: [`${a.host}:${a.port}`, "evil.example"] },
    });
    assert.equal(r.status, 421);
    assert.equal(a.seen.length, before);
    r = await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY"), connection: "keep-alive, foo", foo: "x" },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.foo, undefined);
    assert.equal(a.seen.at(-1)?.headers.connection, undefined);
  });

  test("4. Host ≠ target → 421; outside `paths` → 403, after \\ and ..; are read; an encoded / or \\ → 400", async () => {
    const before = b.seen.length;
    let r = await via(a, { headers: { host: "elsewhere.example:443", "x-api-key": standIn("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 421);
    r = await via(b, { path: "/key/generate", headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` } });
    assert.equal(r.status, 403);
    r = await via(b, {
      path: "/v1/messages/../../key/generate",
      headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` },
    });
    assert.equal(r.status, 403, "dot segments are removed before the prefix is checked");
    r = await via(b, {
      path: "/v1/messages%2F..%2Fkey",
      headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` },
    });
    assert.equal(r.status, 400);
    r = await via(b, {
      path: "/v1/messages%5C..%5Ckey",
      headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` },
    });
    assert.equal(r.status, 400, "an encoded \\, which IIS reads as /");
    // Envoy reads `\` as `/` and `..;` as `..` (Tomcat's reading) before the prefix is checked.
    for (const path of ["/v1/messages/..\\key", "/v1/messages/..;/key"]) {
      r = await via(b, { path, headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` } });
      assert.equal(r.status, 403, path);
    }
    assert.equal(b.seen.length, before, "none of them reached the upstream");
    r = await via(b, {
      path: "/v1/messages?beta=true",
      headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(b.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.LITELLM_KEY}`);
    r = await via(b, { path: "/v1/messages\\x", headers: { authorization: `Bearer ${standIn("LITELLM_KEY")}` } });
    assert.equal(r.status, 200, r.body);
    assert.equal(b.seen.at(-1)?.url, "/v1/messages/x", "the upstream gets the path that was checked");
  });

  test("7. an upstream certificate upstream.crt does not trust → 502, and nothing is sent", async () => {
    const r = await via(d, { headers: { "x-api-key": standIn("UNTRUSTED_KEY") } });
    assert.equal(r.status, 502);
    assert.match(r.body, new RegExp(`${d.host}:${d.port}`));
    assert.equal(d.seen.length, 0);
  });

  test("8. SSE: each event reaches the client within 100 ms of the upstream write", async () => {
    const written: number[] = [];
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        written.push(Date.now());
        res.write(`event: delta\ndata: {"n":${n}}\n\n`);
        if (++n === 5) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    };
    const arrived: number[] = [];
    await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") },
      onResponse: (res) => res.on("data", () => arrived.push(Date.now())),
    });
    assert.equal(arrived.length, 5, `five events, one read each (got ${arrived.length})`);
    for (const [i, at] of arrived.entries()) {
      assert.ok(
        at - (written[i] as number) < 100,
        `event ${i} arrived ${at - (written[i] as number)} ms after its write`,
      );
    }
  });

  test("9. abort: the client goes after 2 events, and the upstream sees the close within 1 s", async () => {
    let seen: { closedAt?: number } | undefined;
    a.handler = (_req, res, entry) => {
      seen = entry;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => res.write(`data: tick\n\n`), 100);
      res.on("close", () => {
        clearInterval(tick);
        entry.closedAt ??= Date.now();
      });
    };
    let abortedAt = 0;
    await via(a, {
      headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") },
      onResponse: (res, req) => {
        let events = 0;
        res.on("data", () => {
          if (++events === 2) {
            abortedAt = Date.now();
            req.destroy();
          }
        });
      },
    }).catch(() => undefined);
    const deadline = Date.now() + 2000;
    while (seen?.closedAt === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen?.closedAt, "the upstream saw its request end");
    assert.ok(
      (seen.closedAt as number) - abortedAt < 1000,
      `closed ${(seen.closedAt as number) - abortedAt} ms after the abort`,
    );
  });

  test("10. a 302 passes to the client, and the Custodian makes no second request", async () => {
    a.handler = (_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/next" });
      res.end();
    };
    const before = a.seen.length;
    const r = await via(a, { headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "https://elsewhere.example/next");
    assert.equal(a.seen.length, before + 1);
    a.handler = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
  });
});

describe("toward every other host", () => {
  test("5. an unbound host is tunneled: it receives the Stand-in byte for byte, over its own certificate", async () => {
    const r = await requestThrough(
      custodian.ports.egress,
      { host: c.host, port: c.port },
      { ca: c.ca.cert, headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") } },
    );
    assert.equal(r.status, 200, r.body);
    assert.equal(c.seen.at(-1)?.headers["x-api-key"], standIn("ANTHROPIC_API_KEY"));
  });

  test("6. the dial guard refuses loopback, link-local and localhost — each with a reason=guard line", async () => {
    for (const authority of [
      "127.0.0.1:443",
      "[::1]:443",
      "169.254.169.254:80",
      "localhost:443",
      "[::ffff:127.0.0.1]:443",
      "LOCALHOST.:443",
    ]) {
      const t = await connectThrough(custodian.ports.egress, authority);
      assert.ok("refused" in t && t.refused.status === 403, `${authority} is refused`);
    }
    const lines = await logLines(6, (l) => l.includes("reason=guard"));
    assert.ok(lines.length >= 6, `a guard line per refusal:\n${lines.join("\n")}`);
    assert.ok(lines.every((l) => /action=refuse/.test(l) && /status=403/.test(l)));
  });

  test("6b. the dial guard refuses a NAME that resolves to loopback or link-local, and passes one that does not", async () => {
    for (const authority of ["loop.guard.test:443", "meta.guard.test:80", "loop6.guard.test:443"]) {
      const t = await connectThrough(custodian.ports.egress, authority);
      assert.ok("refused" in t && t.refused.status === 403, `${authority} is refused`);
      assert.match(t.refused.body, /resolves to a loopback, link-local or unspecified address/);
    }
    const lines = await logLines(3, (l) => l.includes("reason=guard") && l.includes(".guard.test"));
    assert.equal(lines.length, 3, `a guard line per refusal:\n${custodian.output()}`);
    assert.ok(lines.every((l) => /action=refuse/.test(l) && /status=403/.test(l)));

    const t = await connectThrough(custodian.ports.egress, `fine.guard.test:${c.port}`);
    assert.ok("socket" in t, `a name that resolves elsewhere is tunneled: ${JSON.stringify(t)}`);
    t.socket.destroy();
  });

  test("6c. every other spelling of a guarded address is refused, and none is tunneled", async () => {
    const guarded = [
      "[0:0:0:0:0:0:0:1]:443",
      "[0::1]:443",
      "[::]:443",
      "[::ffff:7f00:1]:443",
      "[::FFFF:127.0.0.1]:443",
      "[0:0:0:0:0:ffff:a9fe:a9fe]:80",
      "[fd00:ec2::254]:80",
      "LOCALHOST.:443",
      "127.0.0.1.:443",
    ];
    for (const authority of guarded) {
      const t = await connectThrough(custodian.ports.egress, authority);
      assert.ok("refused" in t && t.refused.status === 403, `${authority} is refused by the guard`);
    }
    // A zone ID is no CONNECT target. An inet_aton form (`2130706433` is 127.0.0.1) is a name to the
    // resolver, which has none; one that resolved to a guarded address would meet the second half.
    for (const authority of ["[::1%25lo]:443", "[fe80::1%25eth0]:443", "2130706433:443"]) {
      const t = await connectThrough(custodian.ports.egress, authority);
      assert.ok("refused" in t, `${authority} is not tunneled`);
    }
  });

  test("the egress listener speaks CONNECT alone", async () => {
    const res = await fetch(`http://127.0.0.1:${custodian.ports.egress}/`, {
      headers: { host: `${c.host}:${c.port}` },
    });
    assert.equal(res.status, 405);
  });
});

describe("toward the Orchestrator (the control listener)", () => {
  const bearer = { authorization: `Bearer ${standIn("JR2_SANDBOX_TOKEN")}` };

  test("the Menu's two routes carry the Sandbox token, and an encoded Instance ID stays one segment", async () => {
    let r = await controlRequest(custodian.ports.control, "/agents/run%2Fcoder/surface", {
      headers: { ...bearer, "x-api-key": "stray" },
    });
    assert.equal(r.status, 200, r.body);
    const surface = orchestrator.seen.at(-1)!;
    assert.equal(surface.url, "/agents/run%2Fcoder/surface");
    assert.equal(surface.headers.authorization, `Bearer ${SANDBOX_TOKEN}`);
    assert.equal(surface.headers["x-api-key"], undefined, "no other credential rides along");
    r = await controlRequest(custodian.ports.control, "/agents/run%2Fcoder/events", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: '{"type":"done"}',
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(orchestrator.seen.at(-1)?.body, '{"type":"done"}');
  });

  test("a connection the Orchestrator closes under a read is retried; under a pick, it says unreachable", async () => {
    orchestrator.drop(1);
    let r = await controlRequest(custodian.ports.control, "/agents/run-1/surface", { headers: bearer });
    assert.equal(r.status, 200, r.body);
    const before = orchestrator.seen.length;
    orchestrator.drop(1);
    r = await controlRequest(custodian.ports.control, "/agents/run-1/events", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: '{"type":"done"}',
    });
    assert.equal(r.status, 502, "a pick the Orchestrator may have read is not sent twice");
    assert.equal(r.headers["x-jr2-custodian"], "unreachable");
    assert.equal(orchestrator.seen.length, before);
  });

  test("the ask is addressed to THIS pod's Sandbox, whatever the caller writes", async () => {
    const r: Awaited<ReturnType<typeof controlRequest>> = await controlRequest(custodian.ports.control, "/fetch", {
      method: "POST",
      headers: bearer,
      body: '{"identity":"github.com/a/b"}',
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(orchestrator.seen.at(-1)?.url, "/sandboxes/ws-1/fetch");
  });

  test("nothing else reaches the Orchestrator: another route, another method, another Sandbox, no Stand-in", async () => {
    const before = orchestrator.seen.length;
    for (const [path, method, headers] of [
      ["/runs/r-1", "GET", bearer],
      ["/workflows/ping/runs", "POST", bearer],
      ["/runs/r-1/gates/review/events", "POST", bearer],
      ["/agents/x/surface", "POST", bearer],
      ["/sandboxes/ws-2/fetch", "POST", bearer],
      ["/agents/x/surface", "GET", {}],
      ["/agents/x/surface", "GET", { authorization: "Bearer ws-1.forged" }],
    ] as const) {
      const r = await controlRequest(custodian.ports.control, path, { method, headers });
      assert.ok(r.status === 404 || r.status === 403, `${method} ${path} → ${r.status}`);
    }
    assert.equal(orchestrator.seen.length, before);
  });
});

describe("the health listener (0.0.0.0, the one a peer can reach)", () => {
  test("14. idle connections past Envoy's global limit fill the health listener alone: the Menu still answers", async () => {
    // More than `max_active_downstream_connections` (4096), none of them sending a byte.
    const sockets = await Promise.all(
      Array.from(
        { length: 4200 },
        () =>
          new Promise<Socket>((resolve) => {
            const s = connect(custodian.ports.health, "127.0.0.1");
            s.on("error", () => {});
            s.once("connect", () => resolve(s));
            s.once("close", () => resolve(s));
          }),
      ),
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      const open = sockets.filter((s) => !s.destroyed && s.readyState === "open").length;
      assert.ok(open <= 32, `the health listener holds few connections, not ${open}`);
      const r = await controlRequest(custodian.ports.control, "/agents/run-1/surface", {
        headers: { authorization: `Bearer ${standIn("JR2_SANDBOX_TOKEN")}` },
      });
      assert.equal(r.status, 200, r.body);
    } finally {
      for (const s of sockets) s.destroy();
    }
    const r = await fetch(`http://127.0.0.1:${custodian.ports.health}/healthz`);
    assert.equal(r.status, 200);
  });

  test("15. a health connection that sends nothing is closed within seconds", async () => {
    const s = connect(custodian.ports.health, "127.0.0.1");
    s.on("error", () => {});
    const started = performance.now();
    await new Promise((r) => s.once("close", r));
    const ms = performance.now() - started;
    assert.ok(ms < 8_000, `closed after ${Math.round(ms)} ms`);
  });
});

describe("start-up and the log", () => {
  test("11. a value with an inner \\r stops the start-up with a line that names the secret", async () => {
    const bad = await startCustodian({
      manifest: {
        version: 1,
        secrets: [{ name: "BROKEN_KEY", source: { kind: "literal" }, hosts: [bound(a)], headers: ["x-api-key"] }],
      },
      values: { BROKEN_KEY: "abc\rdef" },
      upstreamCas: [],
      orchestrator: { host: "127.0.0.1", port: 1 },
      expectFailure: true,
    });
    await bad.stop();
    assert.match(bad.output(), /jr2\.custodian refuse secret=BROKEN_KEY reason=value-not-printable-ascii/);
    assert.ok(!bad.output().includes("abc"), "the value is not in the line");
  });

  test("12. the log holds names, never a value or a Stand-in", async () => {
    await controlRequest(custodian.ports.health, "/healthz");
    await logLines(1, (l) => l.includes("jr2.custodian ready"));
    const out = custodian.output();
    assert.match(
      out,
      /jr2\.custodian ready secrets=JR2_SANDBOX_TOKEN,ANTHROPIC_API_KEY,GATEWAY_TOKEN,LITELLM_KEY,UNTRUSTED_KEY hosts=3/,
    );
    assert.match(out, /action=intercept target=\S+ secret=ANTHROPIC_API_KEY .*method=GET status=200/);
    assert.match(out, /action=tunnel target=\S+/);
    for (const value of [...Object.values(VALUES), SANDBOX_TOKEN]) {
      assert.ok(!out.includes(value), "a value in the log");
      assert.ok(!out.includes(Buffer.from(value).toString("base64")), "a base64 value in the log");
    }
    assert.ok(!out.includes("jr2-held-"), "a Stand-in in the log");
  });
});

describe("a real client", () => {
  test("13. the Anthropic SDK streams through the Custodian with HTTPS_PROXY, NODE_USE_ENV_PROXY and NODE_EXTRA_CA_CERTS", async () => {
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "m1",
              type: "message",
              role: "assistant",
              model: "m",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const;
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };
    const ca = join(custodian.dir, "extra.crt");
    await writeFile(ca, custodian.extraCa);
    const script = `
      import Anthropic from "@anthropic-ai/sdk";
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.BASE, maxRetries: 0 });
      const stream = await client.messages.create({ model: "m", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] });
      let text = "";
      for await (const e of stream) if (e.type === "content_block_delta") text += e.delta.text;
      console.log(text);`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: standIn("ANTHROPIC_API_KEY"),
          BASE: `https://${a.host}:${a.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${custodian.ports.egress}`,
          NODE_USE_ENV_PROXY: "1",
          NODE_EXTRA_CA_CERTS: ca,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      child.on("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
    });
    assert.equal(out, "pong");
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY);
  });

  test("time to the first SSE event: through the Custodian against direct (median of 20)", async () => {
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.end();
    };
    const first = async (through: boolean): Promise<number> => {
      const start = performance.now();
      let at = 0;
      const onResponse = (res: import("node:http").IncomingMessage) => res.once("data", () => (at = performance.now()));
      if (through) await via(a, { headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") }, onResponse });
      else {
        const { request } = await import("node:https");
        await new Promise<void>((resolve, reject) => {
          const req = request({ host: a.host, port: a.port, path: "/", ca: a.ca.cert, agent: false }, (res) => {
            onResponse(res);
            res.resume();
            res.on("end", resolve);
          });
          req.on("error", reject);
          req.end();
        });
      }
      return at - start;
    };
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;
    const through: number[] = [];
    const direct: number[] = [];
    for (let i = 0; i < 20; i++) {
      through.push(await first(true));
      direct.push(await first(false));
    }
    console.log(
      `# first SSE event: through the Custodian ${median(through).toFixed(1)} ms, direct ${median(direct).toFixed(1)} ms`,
    );
    assert.ok(median(through) < 250);
  });
});
