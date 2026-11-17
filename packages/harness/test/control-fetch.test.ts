// The control requests over HTTPS to jr2's own name (ADR-0059, ADR-0084): `controlFetch` against a
// real TLS server whose leaf is from a test CA. The Menu is read, a pick is delivered, and a notice
// is acknowledged, each with the bearer and the stated slot. A peer that does not show a leaf of the
// trusted CA for jr2's name gets no request at all, so the control Stand-in never leaves. And the
// pod's env chooses the path: the control socket while `JR2_CUSTODIAN_SOCKET` names one, else
// HTTPS, and never a plain-HTTP URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { ackNotices, readMenu, type Surface } from "../src/menu.ts";
import { CUSTODIAN_URL, controlFetch, controlReachOf } from "../src/control-fetch.ts";
import { loopbackLookup, testTls } from "./support/rig.ts";

const NAME = new URL(CUSTODIAN_URL).hostname;

const SURFACE: Surface = {
  instanceId: "run-1/coder",
  runId: "run-1",
  sandbox: "ws-1",
  allowed: ["done"],
  menu: [{ name: "done", input: { type: "object", properties: {} }, semantics: "ack" }],
};

type Seen = { method: string; url: string; auth: string | undefined; slot: string | undefined; body: string };

/** A TLS server with `leaf`, which answers as the Custodian's control routes do. */
async function listen(leaf: { cert: string; key: string }) {
  const seen: Seen[] = [];
  let connections = 0;
  const server: Server = createServer({ cert: leaf.cert, key: leaf.key }, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization,
      slot: req.headers["x-jr2-slot"] as string | undefined,
      body,
    });
    const json = (status: number, value?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (req.url?.endsWith("/surface")) return json(200, SURFACE);
    if (req.url?.endsWith("/events")) return json(200, { deliveryId: "d1", allowed: [], turnComplete: true });
    if (req.url?.endsWith("/notices")) return json(204);
    return json(404, { error: "no route" });
  });
  server.on("secureConnection", () => (connections += 1));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${CUSTODIAN_URL}:${port}`,
    seen,
    connections: () => connections,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const ca = testTls(NAME);

const opts = (url: string, fetch: typeof globalThis.fetch) => ({
  url,
  token: "the-control-stand-in",
  slot: "root/coder",
  fetch,
  log: () => {},
  retryWindowMs: 0,
});

test("the Menu, a pick and a notice's acknowledgment go over HTTPS to jr2's own name, with the bearer and the slot, one connection each", async () => {
  const s = await listen(ca);
  try {
    const fetch = controlFetch({ ca: ca.ca, lookup: loopbackLookup });
    const read = await readMenu(opts(s.url, fetch), "run-1/coder");
    assert.ok(read);
    assert.deepEqual(read.allowed, ["done"]);
    assert.equal(typeof (await read.menu[0]!.pick({})), "string");
    assert.equal(await ackNotices(opts(s.url, fetch), "run-1/coder", ["n1"]), true);
    assert.deepEqual(
      s.seen.map((x) => [x.method, x.url, x.auth, x.slot]),
      [
        ["GET", "/agents/run-1%2Fcoder/surface", "Bearer the-control-stand-in", "root/coder"],
        ["POST", "/agents/run-1%2Fcoder/events", "Bearer the-control-stand-in", "root/coder"],
        ["POST", "/agents/run-1%2Fcoder/notices", "Bearer the-control-stand-in", "root/coder"],
      ],
    );
    assert.deepEqual(JSON.parse(s.seen[1]!.body), { type: "done" });
    assert.deepEqual(JSON.parse(s.seen[2]!.body), { heard: ["n1"] });
    // No pooled connection: a connection that a restarted Custodian closed cannot carry a pick.
    assert.equal(s.connections(), 3);
  } finally {
    await s.close();
  }
});

test("no listener at jr2's name: a pick never left, and the model is told to try it again", async () => {
  const s = await listen(ca);
  const fetch = controlFetch({ ca: ca.ca, lookup: loopbackLookup });
  const read = await readMenu(opts(s.url, fetch), "run-1/coder");
  await s.close();
  assert.ok(read);
  await assert.rejects(
    read.menu[0]!.pick({}),
    /the pick never reached the Orchestrator \(connect ECONNREFUSED .*\) — try it again/,
  );
});

test("a peer with a leaf of another CA gets no request: the control Stand-in never leaves", async () => {
  const other = testTls(NAME);
  const s = await listen(other);
  try {
    const fetch = controlFetch({ ca: ca.ca, lookup: loopbackLookup });
    await assert.rejects(
      fetch(`${s.url}/agents/x/surface`, { headers: { authorization: "Bearer the-control-stand-in" } }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match(String((err.cause as { code?: string }).code), /CERT|SIGNATURE|ISSUER/);
        return true;
      },
    );
    assert.deepEqual(s.seen, []);
  } finally {
    await s.close();
  }
});

test("a leaf of the trusted CA for another name gets no request", async () => {
  const s = await listen(testTls("custodian.example.internal", ca));
  try {
    const fetch = controlFetch({ ca: ca.ca, lookup: loopbackLookup });
    await assert.rejects(fetch(`${s.url}/agents/x/surface`), (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.equal((err.cause as { code?: string }).code, "ERR_TLS_CERT_ALTNAME_INVALID");
      return true;
    });
    assert.deepEqual(s.seen, []);
  } finally {
    await s.close();
  }
});

test("an abort ends a request at once, and a plain-HTTP URL with no control socket is refused", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(controlFetch()(`${CUSTODIAN_URL}/x`, { signal: controller.signal }), /stop/);
  await assert.rejects(controlFetch()("http://custodian.jr2.internal/x"), /over HTTPS or the control socket/);
});

test("the pod's env chooses the path: the control socket while JR2_CUSTODIAN_SOCKET names one, else HTTPS at JR2_CUSTODIAN_URL or jr2's own name", () => {
  assert.equal(CUSTODIAN_URL, "https://custodian.jr2.internal");
  assert.equal(controlReachOf({}).url, CUSTODIAN_URL);
  assert.equal(controlReachOf({ JR2_CUSTODIAN_URL: "" }).url, CUSTODIAN_URL);
  assert.equal(
    controlReachOf({ JR2_CUSTODIAN_URL: "https://custodian.jr2.internal:8443" }).url,
    "https://custodian.jr2.internal:8443",
  );
  // A pod with a Custodian container names its socket, and its JR2_CUSTODIAN_URL is the fetch
  // listener's: the socket wins.
  assert.equal(
    controlReachOf({
      JR2_CUSTODIAN_SOCKET: "/run/jr2/custodian/control.sock",
      JR2_CUSTODIAN_URL: "http://127.0.0.1:8081",
    }).url,
    "http://jr2-custodian",
  );
  for (const url of ["http://custodian.jr2.internal", "http://127.0.0.1:8081", "not a url"]) {
    assert.throws(() => controlReachOf({ JR2_CUSTODIAN_URL: url }), /is not an https URL.*only over TLS/);
  }
});
