import { test } from "node:test";
import assert from "node:assert/strict";
import { dialFetch } from "../src/dial.ts";
import { answers, neverOpens } from "./_fake-connection.ts";

// Socket-free: `dialFetch` takes the function that makes its connection, and these tests hand it
// in-memory streams. One never opens (a dropped SYN); the other is an HTTP server in memory.

test("a connection that does not open is given up after the bound, as a connect failure", async () => {
  const socket = neverOpens();
  const fetch = dialFetch({ connectTimeoutMs: 50, connect: () => socket });
  const started = Date.now();
  const err = await fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" }).then(
    () => assert.fail("a connection that never opened answered"),
    (e: unknown) => e as TypeError & { cause: { code: string; syscall: string; message: string } },
  );
  const took = Date.now() - started;
  assert.ok(took >= 45 && took < 2_000, `given up after the bound, not the 10 s of the global fetch (took ${took}ms)`);
  assert.equal(err.message, "fetch failed", "shaped as the global fetch's transport failure");
  assert.equal(err.cause.syscall, "connect", "a connect failure: it never reached the wire");
  assert.equal(err.cause.code, "ETIMEDOUT");
  assert.match(err.cause.message, /connect ETIMEDOUT ws-1\.ns\.svc:8080/);
  assert.ok(socket.destroyed, "the connection that did not open is closed");
});

test("the bound is on the connect only: an open connection waits for its answer", async () => {
  const socket = answers(JSON.stringify({ ok: true }), 150);
  const fetch = dialFetch({ connectTimeoutMs: 50, connect: () => socket });
  const res = await fetch("http://ws-1.ns.svc:8080/attach?x=1", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ slots: [] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const raw = await socket.request;
  assert.match(raw, /^POST \/attach\?x=1 HTTP\/1\.1\r\n/);
  assert.match(raw, /\r\nhost: ws-1\.ns\.svc:8080\r\n/i);
  assert.match(raw, /\r\nauthorization: Bearer t\r\n/i);
  assert.ok(raw.endsWith(JSON.stringify({ slots: [] })), "the body is sent");
});

test("each request is a new connection", async () => {
  let made = 0;
  const fetch = dialFetch({
    connectTimeoutMs: 50,
    connect: () => {
      made += 1;
      return made === 1 ? neverOpens() : answers("{}");
    },
  });
  await assert.rejects(() => fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" }));
  const res = await fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(made, 2, "the second try dials again; it does not wait on the first connection");
});

test("an abort rejects with the signal's reason", async () => {
  const fetch = dialFetch({ connectTimeoutMs: 5_000, connect: () => neverOpens() });
  const controller = new AbortController();
  const pending = fetch("http://ws-1.ns.svc:8080/attach", { signal: controller.signal });
  const reason = new Error("stopped");
  controller.abort(reason);
  await assert.rejects(pending, (err) => err === reason);
});
