import { test } from "node:test";
import assert from "node:assert/strict";
import { dialFetch } from "../src/dial.ts";
import { answers, fakeConnection, neverOpens } from "./_fake-connection.ts";

// Socket-free: `dialFetch` takes the function that makes its connection, and these tests hand it
// in-memory connections that go through a socket's phases (lookup, connect) when the test says.

type CauseError = TypeError & { cause: { code: string; syscall?: string; message: string } };

const failure = (p: Promise<unknown>): Promise<CauseError> =>
  p.then(
    () => assert.fail("a request that should fail answered"),
    (e: unknown) => e as CauseError,
  );

test("a connection that does not open is given up after the bound, as a connect failure", async () => {
  const socket = neverOpens();
  const fetch = dialFetch({ connectTimeoutMs: 50, connect: () => socket });
  const started = Date.now();
  const err = await failure(fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" }));
  const took = Date.now() - started;
  assert.ok(took >= 45 && took < 2_000, `given up after the bound, not the 10 s of the global fetch (took ${took}ms)`);
  assert.equal(err.message, "fetch failed", "shaped as the global fetch's transport failure");
  assert.equal(err.cause.syscall, "connect", "a connect failure: it never reached the wire");
  assert.equal(err.cause.code, "ETIMEDOUT");
  assert.match(err.cause.message, /connect ETIMEDOUT ws-1\.ns\.svc:8080/);
  assert.ok(socket.destroyed, "the connection that did not open is closed");
});

test("the bound is on the connect only: a connection that opens in time waits past the bound for its answer", async () => {
  // Connects at 20 ms, inside the 50 ms bound; the answer comes 150 ms after the request.
  const socket = fakeConnection({ lookupMs: 5, connectMs: 20, answer: JSON.stringify({ ok: true }), answerMs: 150 });
  const fetch = dialFetch({ connectTimeoutMs: 50, connect: () => socket });
  const started = Date.now();
  const res = await fetch("http://ws-1.ns.svc:8080/attach?x=1", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ slots: [] }),
  });
  assert.ok(Date.now() - started >= 140, "the answer came after the connect bound had passed");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const raw = await socket.request;
  assert.match(raw, /^POST \/attach\?x=1 HTTP\/1\.1\r\n/);
  assert.match(raw, /\r\nhost: ws-1\.ns\.svc:8080\r\n/i);
  assert.match(raw, /\r\nauthorization: Bearer t\r\n/i);
  assert.ok(raw.endsWith(JSON.stringify({ slots: [] })), "the body is sent");
});

test("the bound starts when the name lookup answers: a slow lookup is not cut", async () => {
  // Node cannot cancel a getaddrinfo, so a bound that cut it would leave it holding a pool thread.
  const socket = fakeConnection({ lookupMs: 100, connectMs: 120, answer: "{}" });
  const fetch = dialFetch({ connectTimeoutMs: 50, connect: () => socket });
  const res = await fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
});

test("an IPv6 literal is dialed without its brackets, and its bound starts at once (no lookup)", async () => {
  let host: string | undefined;
  const fetch = dialFetch({
    connectTimeoutMs: 50,
    connect: (args) => {
      host = args.host ?? undefined;
      return fakeConnection({ lookupMs: null });
    },
  });
  const err = await failure(fetch("http://[::1]:8080/attach"));
  assert.equal(host, "::1");
  assert.equal(err.cause.syscall, "connect");
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

test("a connected request that hears nothing for the idle bound fails, as one that may have arrived", async () => {
  const fetch = dialFetch({ idleTimeoutMs: 50, connect: () => fakeConnection({ open: true }) });
  const err = await failure(fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: "{}" }));
  assert.equal(err.cause.code, "ETIMEDOUT");
  assert.equal(err.cause.syscall, undefined, "no syscall: the request may have reached the server");
  assert.match(err.cause.message, /no answer from ws-1\.ns\.svc:8080 in 50ms/);
});

test("a body that stops for the idle bound fails its read", async () => {
  const fetch = dialFetch({
    idleTimeoutMs: 50,
    connect: () => fakeConnection({ open: true, answer: "{}", holdBody: true }),
  });
  const res = await fetch("http://ws-1.ns.svc:8080/attach");
  await assert.rejects(res.text(), /no answer from ws-1\.ns\.svc:8080 in 50ms/);
});

test("an abort before the answer rejects with the signal's reason", async () => {
  const fetch = dialFetch({ connectTimeoutMs: 5_000, connect: () => neverOpens() });
  const controller = new AbortController();
  const pending = fetch("http://ws-1.ns.svc:8080/attach", { signal: controller.signal });
  const reason = new Error("stopped");
  controller.abort(reason);
  await assert.rejects(pending, (err) => err === reason);
});

test("an abort after the headers ends the body's read with the signal's reason", async () => {
  const fetch = dialFetch({ connect: () => fakeConnection({ open: true, answer: "{}", holdBody: true }) });
  const controller = new AbortController();
  const res = await fetch("http://ws-1.ns.svc:8080/attach", { signal: controller.signal });
  const reason = new Error("stopped");
  controller.abort(reason);
  await assert.rejects(res.text(), (err) => err === reason);
});

test("what it does not take fails clearly: a Request input, a body that is not a string", async () => {
  const fetch = dialFetch({ connect: () => assert.fail("nothing is dialed") });
  await assert.rejects(fetch(new Request("http://ws-1.ns.svc:8080/attach") as never), TypeError);
  await assert.rejects(
    fetch("http://ws-1.ns.svc:8080/attach", { method: "POST", body: new Uint8Array([1]) }),
    /string body only/,
  );
});
