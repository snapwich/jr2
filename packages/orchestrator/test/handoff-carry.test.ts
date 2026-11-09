// The carry of a Handoff (ADR-0080): the Orchestrator takes the files from the source Harness
// (`POST /handoff`) and gives them to the child's Harness (`PUT /handoffs/<id>`). Socket-free: the
// carrier takes its `fetch`, and the last tests run the real `dialFetch` over in-memory
// connections to real HTTP servers.
//
// Each end of the source's stream maps to one outcome of the cut: the commit or its files gone is
// `refused` (a cut again meets the same files), a source that does not answer or a carry that
// breaks is `unknown` (the Machine can cut again).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { duplexPair, type Duplex } from "node:stream";
import { test } from "node:test";
import { dialFetch } from "../src/dial.ts";
import type { HandoffCarrier, HandoffSource } from "../src/handoff.ts";
import { handoffCarrier, HANDOFF_CARRY_MS, HANDOFF_IDLE_MS } from "../src/handoff-carry.ts";
import { HANDOFF_CONTENT_TYPE, HANDOFF_DEADLINE_MS, HANDOFF_MAX_BYTES, HANDOFF_MAX_OBJECTS } from "../src/wire.ts";

const H = "a".repeat(40);
const OID1 = "1".repeat(64);
const OID2 = "2".repeat(64);
const SOURCE: HandoffSource = {
  run: "run-1",
  sandbox: "ws-parent",
  endpoint: "http://ws-parent-then.invalid",
  row: "row-1",
  slot: "app",
  path: "/work/app/coder",
  head: H,
  branch: "fix/one",
};

type Part = Record<string, unknown> | Buffer | string;
/** A source stream: each object is a header line, each Buffer or string raw bytes. */
const wire = (...parts: Part[]): Buffer =>
  Buffer.concat(
    parts.map((p) =>
      Buffer.isBuffer(p) ? p : typeof p === "string" ? Buffer.from(p) : Buffer.from(`${JSON.stringify(p)}\n`),
    ),
  );

/** A source body that gives `bytes` in chunks of `chunk`, then ends, or `hangs`. */
function body(bytes: Buffer, opts: { chunk?: number; hang?: boolean } = {}) {
  const state = { cancelled: false, read: 0 };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctrl) {
        if (at >= bytes.length) {
          if (opts.hang) return new Promise<void>(() => {});
          ctrl.close();
          return;
        }
        const next = bytes.subarray(at, at + (opts.chunk ?? 7));
        at += next.length;
        state.read = at;
        ctrl.enqueue(new Uint8Array(next));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const handoffAnswer = (stream: ReadableStream<Uint8Array>, type = HANDOFF_CONTENT_TYPE) =>
  new Response(stream, { status: 200, headers: { "content-type": type } });

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Rig = {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  /** What each PUT's body held, and whether it ended or broke. */
  landed: { bytes: Buffer; broke?: unknown }[];
};

/** A fake `fetch` for both legs. `source(n)` answers the nth `POST /handoff` (from 0); `child`
 * answers a PUT after it read the whole body, or `early` before it reads any. */
function rig(opts: {
  source: (n: number) => Response | Error;
  child?: (bytes: Buffer, n: number) => Response | Error;
  early?: Response;
}): Rig {
  const calls: Call[] = [];
  const landed: Rig["landed"] = [];
  let asks = 0;
  let puts = 0;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url: String(input), method: init.method ?? "GET", headers };
    calls.push(call);
    if (call.method === "POST") {
      call.body = init.body as string;
      const answer = opts.source(asks++);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    const n = puts++;
    const stream = init.body as ReadableStream<Uint8Array>;
    if (opts.early) {
      const reader = stream.getReader();
      void reader.read().then(() => reader.cancel());
      return opts.early;
    }
    const chunks: Buffer[] = [];
    const record: Rig["landed"][number] = { bytes: Buffer.alloc(0) };
    landed.push(record);
    try {
      for await (const c of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(c));
        record.bytes = Buffer.concat(chunks);
      }
    } catch (err) {
      record.broke = err;
      throw new TypeError("fetch failed", { cause: err });
    }
    const answer = opts.child?.(record.bytes, n) ?? Response.json({ landed: true });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof globalThis.fetch;
  return { fetch, calls, landed };
}

const argsOf = (signal = new AbortController().signal): Parameters<HandoffCarrier>[0] => ({
  effect: "eff-1",
  source: SOURCE,
  from: { endpoint: "http://ws-parent.invalid", sandbox: "ws-parent" },
  target: { endpoint: "http://ws-child.invalid", sandbox: "ws-child" },
  bearer: (sandbox) => `tok-${sandbox}`,
  signal,
});

const bundleBytes = Buffer.from("BUNDLE-BYTES");
const lfsBytes = Buffer.from("large");
/** A whole answer: the bundle in two data frames, one Git LFS object, the end. */
const whole = wire(
  { bundle: bundleBytes.length },
  { data: 5 },
  bundleBytes.subarray(0, 5),
  { data: bundleBytes.length - 5 },
  bundleBytes.subarray(5),
  { lfs: OID1, size: lfsBytes.length },
  { data: lfsBytes.length },
  lfsBytes,
  { end: true },
);

test("a whole answer is carried: the source is asked for the ledger's path and head, and the child gets each frame under the cut's id", async () => {
  const src = body(whole);
  const r = rig({ source: () => handoffAnswer(src.stream) });
  const out = await handoffCarrier({ fetch: r.fetch })(argsOf());
  assert.deepEqual(out, { outcome: "carried" });
  const [ask, put] = r.calls;
  assert.equal(ask!.url, "http://ws-parent.invalid/handoff", "the source's Harness where it runs now");
  assert.equal(ask!.method, "POST");
  assert.equal(ask!.headers.authorization, "Bearer tok-ws-parent");
  assert.deepEqual(JSON.parse(ask!.body!), { path: "/work/app/coder", head: H });
  assert.equal(put!.url, "http://ws-child.invalid/handoffs/eff-1");
  assert.equal(put!.method, "PUT");
  assert.equal(put!.headers.authorization, "Bearer tok-ws-child");
  assert.equal(put!.headers["content-type"], HANDOFF_CONTENT_TYPE);
  assert.ok(r.landed[0]!.bytes.equals(whole), "the child got each part and the end");
});

test("the child gets frames in the Orchestrator's own words, not the source's lines", async () => {
  const src = body(wire('{ "bundle" : 3 }\n', '{"data":3}\n', "abc", '{"end":true }\n'));
  const r = rig({ source: () => handoffAnswer(src.stream) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), { outcome: "carried" });
  assert.equal(r.landed[0]!.bytes.toString(), '{"bundle":3}\n{"data":3}\nabc{"end":true}\n');
});

test("an empty range carries nothing, and the child is not asked", async () => {
  const r = rig({ source: () => handoffAnswer(body(wire({ nothing: true })).stream) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), { outcome: "nothing" });
  assert.equal(r.calls.length, 1);
});

test("the source's refusal (the commit or a prerequisite is gone) settles the cut `refused`, with its reason, and the child is not asked", async () => {
  const reason = `the parent's clone does not hold the commit ${H}`;
  const r = rig({ source: () => handoffAnswer(body(wire({ refused: reason })).stream) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: ${reason}`,
  });
  assert.equal(r.calls.length, 1);
});

test("a refusal in the middle of a part is `refused`, and the child's body breaks before its end, so it keeps nothing", async () => {
  const src = body(
    wire({ bundle: 10 }, { data: 4 }, "abcd", { refused: "the bundle step passed its deadline of 300 s" }),
  );
  const r = rig({ source: () => handoffAnswer(src.stream) });
  const out = await handoffCarrier({ fetch: r.fetch })(argsOf());
  assert.deepEqual(out, {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: the bundle step passed its deadline of 300 s`,
  });
  assert.ok(r.landed[0]!.broke !== undefined, "the child's body broke");
  assert.ok(!r.landed[0]!.bytes.toString().includes('"end"'), "and held no end");
});

test("the source's `unknown` (it could not run the step) settles the cut `unknown`", async () => {
  for (const at of ["first", "later"] as const) {
    const text = "the bundle step did not run: the spawner is gone";
    const stream = at === "first" ? wire({ unknown: text }) : wire({ bundle: 2 }, { data: 2 }, "ab", { unknown: text });
    const r = rig({ source: () => handoffAnswer(body(stream).stream) });
    assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), {
      outcome: "unknown",
      reason: `the files of the Handoff were not carried: the source Harness: ${text}`,
    });
  }
});

test("the bound: a bundle past it is `refused` before the child is asked, and an object past it ends the carry `refused`", async () => {
  const big = body(wire({ bundle: 11 }));
  let r = rig({ source: () => handoffAnswer(big.stream) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch, maxBytes: 10 })(argsOf()), {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: its files pass the bound of 10 bytes`,
  });
  assert.equal(r.calls.length, 1, "the child is not asked");
  assert.ok(big.state.cancelled, "the source's stream is ended, which kills its step");

  const src = body(
    wire({ bundle: 5 }, { data: 5 }, "abcde", { lfs: OID1, size: 6 }, { data: 6 }, "123456", { end: true }),
  );
  r = rig({ source: () => handoffAnswer(src.stream) });
  const out = await handoffCarrier({ fetch: r.fetch, maxBytes: 10 })(argsOf());
  assert.deepEqual(out, {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: its files pass the bound of 10 bytes`,
  });
  assert.ok(r.landed[0]!.broke !== undefined && !r.landed[0]!.bytes.includes("123456"), "the object did not go on");
  assert.ok(src.state.cancelled);
  assert.match(
    await handoffCarrier({ fetch: rig({ source: () => handoffAnswer(body(wire({ bundle: 2 ** 31 })).stream) }).fetch })(
      argsOf(),
    ).then((o) => (o as { reason: string }).reason),
    /the bound of 1 GiB/,
    "the default bound is the wire's",
  );
});

test("a stream out of its form is `unknown`: the source Harness writes each frame, so the fault is the carry's", async () => {
  const cases: [string, Buffer, RegExp][] = [
    ["not JSON", wire("bundle 3\n"), /a header out of its form/],
    ["an extra key", wire({ bundle: 3, x: 1 }), /a header out of its form/],
    ["a negative size", wire({ bundle: -1 }), /a header out of its form/],
    ["an object first", wire({ lfs: OID1, size: 1 }), /does not start with the bundle/],
    ["a short oid", wire({ bundle: 1 }, { data: 1 }, "a", { lfs: "abc", size: 1 }), /a header out of its form/],
    ["more data than the part", wire({ bundle: 2 }, { data: 3 }, "abc"), /more bytes than a part's header/],
    ["a part with fewer bytes", wire({ bundle: 3 }, { data: 2 }, "ab", { end: true }), /fewer bytes than its header/],
    [
      "an object twice",
      wire(
        { bundle: 1 },
        { data: 1 },
        "a",
        { lfs: OID1, size: 1 },
        { data: 1 },
        "b",
        { lfs: OID2, size: 1 },
        { data: 1 },
        "c",
        { lfs: OID1, size: 1 },
      ),
      /the object 1{64} twice/,
    ],
    [
      "an object of no bytes",
      wire({ bundle: 1 }, { data: 1 }, "a", { lfs: OID1, size: 0 }),
      /a header out of its form/,
    ],
    ["a second bundle", wire({ bundle: 1 }, { data: 1 }, "a", { bundle: 1 }), /has bundle in a stream/],
    ["nothing after a part", wire({ bundle: 1 }, { data: 1 }, "a", { nothing: true }), /has nothing in a stream/],
    ["no last frame", wire({ bundle: 1 }, { data: 1 }, "a"), /ended before its last frame/],
    ["an end in a part's bytes", wire({ bundle: 4 }, { data: 4 }, "ab"), /ended in a part/],
    ["no frame at all", Buffer.alloc(0), /ended before its last frame/],
    ["a header past its length", Buffer.alloc(70 * 1024, 0x61), /a header longer than its form/],
    [
      "more data frames than a part's size takes",
      wire({ bundle: 40 }, ...Array.from({ length: 40 }, () => [{ data: 1 }, "x"]).flat(), { end: true }),
      /more data frames than its form/,
    ],
  ];
  for (const [name, stream, re] of cases) {
    const src = body(stream, { chunk: 4096 });
    const r = rig({ source: () => handoffAnswer(src.stream) });
    const out = (await handoffCarrier({ fetch: r.fetch })(argsOf())) as { outcome: string; reason: string };
    assert.equal(out.outcome, "unknown", `${name}: ${JSON.stringify(out)}`);
    assert.match(out.reason, /^the files of the Handoff were not carried: the source Harness's /, name);
    assert.match(out.reason, re, name);
    for (const put of r.landed) assert.ok(!put.bytes.toString().includes('"end"'), `${name}: the child got no end`);
  }
});

test("a header line past its length that comes whole, with its newline, in one chunk is `unknown`: a long reason does not reach the cut", async () => {
  const line = wire({ refused: "x".repeat(70 * 1024) });
  const src = body(line, { chunk: line.length });
  const r = rig({ source: () => handoffAnswer(src.stream) });
  const out = (await handoffCarrier({ fetch: r.fetch })(argsOf())) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown", JSON.stringify(out).slice(0, 200));
  assert.match(out.reason, /a header longer than its form/);
});

test("the two legs are one pipe: while the child takes nothing, the carry reads little of the source", async () => {
  // Without it, the Orchestrator, which each run shares, holds up to the bound for each carry.
  const size = 4 << 20;
  const chunk = 16 << 10;
  const src = body(wire({ bundle: size }, { data: size }, Buffer.alloc(size, 7), { end: true }), { chunk });
  let readAhead = -1;
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === "POST") return handoffAnswer(src.stream);
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // one chunk, then a stall
    await new Promise((r) => setTimeout(r, 300));
    readAhead = src.state.read;
    for (;;) if ((await reader.read()).done) break;
    return Response.json({ landed: true });
  }) as typeof globalThis.fetch;
  assert.deepEqual(await handoffCarrier({ fetch })(argsOf()), { outcome: "carried" });
  assert.ok(
    readAhead >= 0 && readAhead <= 4 * chunk,
    `the carry read ${readAhead} bytes while the child took one chunk`,
  );
});

/** A source of one 1-byte bundle and then `n` Git LFS objects, each a header and nothing more: a
 * header costs the source nothing, so only the carry's own bounds stop it. */
function manyObjects(n: number, size: number) {
  let i = 0;
  let sent = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctrl) {
        if (i === 0 && sent === 0) ctrl.enqueue(enc.encode('{"bundle":1}\n{"data":1}\nB'));
        if (i >= n) return void (ctrl.enqueue(enc.encode('{"end":true}\n')), ctrl.close());
        let s = "";
        for (let k = 0; k < 500 && i < n; k++, i++) {
          s += `{"lfs":"${i.toString(16).padStart(64, "0")}","size":${size}}\n`;
          if (size > 0) s += `{"data":${size}}\n${"x".repeat(size)}`;
        }
        sent += s.length;
        ctrl.enqueue(enc.encode(s));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, objects: () => i };
}

/** A fake `fetch` whose child counts the bytes it takes and keeps none: `rig` keeps them all. */
function counting(src: ReadableStream<Uint8Array>) {
  const child = { bytes: 0, broke: false };
  const fetch = (async (_input: string | URL, init: RequestInit = {}) => {
    if (init.method === "POST") return handoffAnswer(src);
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) child.bytes += next.value.length;
    } catch (err) {
      child.broke = true;
      throw new TypeError("fetch failed", { cause: err });
    }
    return Response.json({ landed: true });
  }) as typeof globalThis.fetch;
  return { fetch, child };
}

test("the number of Git LFS objects has a bound: a million objects are `refused` at the first past it, so what the carry holds has a bound", async () => {
  // The validator's probe: a million objects of no bytes each passed the byte bound for free, and
  // the carry kept one oid for each (about 250 MiB). Now an object of no bytes is out of the form...
  let src = manyObjects(1_000_000, 0);
  let c = counting(src.stream);
  let out = (await handoffCarrier({ fetch: c.fetch })(argsOf())) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /a header out of its form/);
  assert.ok(src.objects() <= 500, "the carry stopped at the first one");

  // ...and objects of one byte each stop at the object bound, well under the byte bound.
  src = manyObjects(1_000_000, 1);
  c = counting(src.stream);
  out = (await handoffCarrier({ fetch: c.fetch })(argsOf())) as typeof out;
  assert.deepEqual(out, {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: its files hold more than ${HANDOFF_MAX_OBJECTS} Git LFS objects`,
  });
  assert.ok(src.objects() < HANDOFF_MAX_OBJECTS + 1000, "the source was read no further");
  assert.ok(c.child.broke, "the child's body broke before its end");
  assert.ok(HANDOFF_MAX_OBJECTS < HANDOFF_MAX_BYTES / 1000, "the object bound is far under the byte bound");

  // A smaller bound, for the exact edge: two objects pass, the third is refused.
  const three = wire(
    { bundle: 1 },
    { data: 1 },
    "a",
    { lfs: OID1, size: 1 },
    { data: 1 },
    "b",
    { lfs: OID2, size: 1 },
    { data: 1 },
    "c",
    { lfs: "3".repeat(64), size: 1 },
    { data: 1 },
    "d",
    { end: true },
  );
  let r = rig({ source: () => handoffAnswer(body(three).stream) });
  assert.equal((await handoffCarrier({ fetch: r.fetch, maxObjects: 3 })(argsOf())).outcome, "carried");
  r = rig({ source: () => handoffAnswer(body(three).stream) });
  assert.equal((await handoffCarrier({ fetch: r.fetch, maxObjects: 2 })(argsOf())).outcome, "refused");
});

test("the default dial of both legs has the carry's idle bound, longer than the step's deadline", async () => {
  const given: unknown[] = [];
  const r = rig({ source: () => handoffAnswer(body(whole).stream) });
  const carrier = handoffCarrier({
    dial: (options) => {
      given.push(options);
      return r.fetch;
    },
  });
  assert.deepEqual(given, [{ idleTimeoutMs: HANDOFF_IDLE_MS }]);
  assert.deepEqual(await carrier(argsOf()), { outcome: "carried" });
});

test("a carry has a time of its own: a child that takes a byte now and then cannot hold it, and it ends `unknown`", async () => {
  // A child that reads one chunk, then nothing more (each byte would reset the idle bound).
  const src = body(whole, { chunk: 1 });
  let childClosed = false;
  const fetch = (async (_input: string | URL, init: RequestInit = {}) => {
    if (init.method === "POST") return handoffAnswer(src.stream);
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener("abort", () => {
        childClosed = true;
        reject(init.signal!.reason);
      }),
    );
  }) as typeof globalThis.fetch;
  const out = await handoffCarrier({ fetch, carryMs: 50 })(argsOf());
  assert.deepEqual(out, {
    outcome: "unknown",
    reason: "the files of the Handoff were not carried: the carry passed its time of 0 s",
  });
  assert.ok(childClosed, "the child's request ended");
  assert.ok(src.state.cancelled, "the source's stream ended, which kills its step");

  // A source that sends nothing: its stream breaks at the end of the time, and the reason is the time.
  const quiet = (async (_input: string | URL, init: RequestInit = {}) =>
    handoffAnswer(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          init.signal!.addEventListener("abort", () => ctrl.error(init.signal!.reason));
        },
      }),
    )) as typeof globalThis.fetch;
  assert.deepEqual(await handoffCarrier({ fetch: quiet, carryMs: 50 })(argsOf()), {
    outcome: "unknown",
    reason: "the files of the Handoff were not carried: the carry passed its time of 0 s",
  });
  // The default: the bound at 1 MiB/s, and one idle wait.
  assert.equal(HANDOFF_CARRY_MS, Math.ceil(HANDOFF_MAX_BYTES / (1024 ** 2 / 1000)) + HANDOFF_IDLE_MS);
});

test("a source that answers with an HTTP error or another content type is `unknown`, and the child is not asked", async () => {
  let r = rig({ source: () => Response.json({ error: "this Harness gives no Handoff (ADR-0080)" }, { status: 501 }) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), {
    outcome: "unknown",
    reason:
      "the files of the Handoff were not carried: the source Harness (ws-parent) answered 501: this Harness gives no Handoff (ADR-0080)",
  });
  assert.equal(r.calls.length, 1);
  r = rig({ source: () => handoffAnswer(body(whole).stream, "application/json") });
  const out = (await handoffCarrier({ fetch: r.fetch })(argsOf())) as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /the source Harness \(ws-parent\) answered 200/);
  assert.equal(r.calls.length, 1);
});

const refusedConnect = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.7:8080"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    }),
  });
const idle = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error(`no answer from ws-parent:8080 in ${HANDOFF_IDLE_MS}ms`), { code: "ETIMEDOUT" }),
  });

test("a source that does not answer is `unknown`: a connection that never opened is tried again, then given up", async () => {
  let r = rig({ source: (n) => (n < 2 ? refusedConnect() : handoffAnswer(body(whole).stream)) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch, retryWaitsMs: [1, 1] })(argsOf()), { outcome: "carried" });
  assert.equal(r.calls.filter((c) => c.method === "POST").length, 3);

  r = rig({ source: () => refusedConnect() });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch, retryWaitsMs: [1, 1] })(argsOf()), {
    outcome: "unknown",
    reason:
      "the files of the Handoff were not carried: the source Harness (ws-parent) did not answer: connect ECONNREFUSED 10.96.0.7:8080",
  });
  assert.equal(r.calls.length, 3, "the first try and one for each wait");
});

test("a source that went quiet is `unknown` at once: the request may have reached it", async () => {
  const r = rig({ source: () => idle() });
  const out = (await handoffCarrier({ fetch: r.fetch, retryWaitsMs: [1, 1] })(argsOf())) as { reason: string };
  assert.match(out.reason, /did not answer: no answer from ws-parent:8080 in 360000ms/);
  assert.equal(r.calls.length, 1);
  assert.ok(HANDOFF_IDLE_MS > HANDOFF_DEADLINE_MS, "the carry waits longer than the step's deadline");
});

test("a child that does not take the files is `unknown`: an error, an answer that is not `landed`, an answer before the end", async () => {
  let r = rig({
    source: () => handoffAnswer(body(whole).stream),
    child: () => Response.json({ error: "no space" }, { status: 507 }),
  });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), {
    outcome: "unknown",
    reason: "the files of the Handoff were not carried: the child's Harness (ws-child) answered 507: no space",
  });
  r = rig({ source: () => handoffAnswer(body(whole).stream), child: () => Response.json({ ok: true }) });
  assert.match(((await handoffCarrier({ fetch: r.fetch })(argsOf())) as { reason: string }).reason, /answered 200: /);

  const src = body(whole, { hang: true });
  r = rig({ source: () => handoffAnswer(src.stream), early: Response.json({ error: "not found" }, { status: 404 }) });
  assert.deepEqual(await handoffCarrier({ fetch: r.fetch })(argsOf()), {
    outcome: "unknown",
    reason:
      "the files of the Handoff were not carried: the child's Harness (ws-child) answered 404 before it took them all: not found",
  });
  assert.ok(src.state.cancelled, "the source's stream is ended, which kills its step");
});

test("a child whose connection never opened: the whole carry goes again, from a new ask of the source", async () => {
  let puts = 0;
  const srcs: ReturnType<typeof body>[] = [];
  const base = rig({
    source: () => {
      const s = body(whole);
      srcs.push(s);
      return handoffAnswer(s.stream);
    },
  });
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && puts++ === 0) {
      await (init.body as ReadableStream).cancel().catch(() => {});
      throw refusedConnect();
    }
    return base.fetch(input, init);
  }) as typeof globalThis.fetch;
  assert.deepEqual(await handoffCarrier({ fetch, retryWaitsMs: [1] })(argsOf()), { outcome: "carried" });
  assert.equal(srcs.length, 2, "the source was asked again");
  assert.ok(srcs[0]!.state.cancelled, "and the first stream was let go");
  assert.ok(base.landed[0]!.bytes.equals(whole));
});

// --- Over real HTTP: `dialFetch` and in-memory connections ---------------------------------------

/** HTTP servers behind in-memory connections, by host. */
function servers(handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void>) {
  const byHost = Object.fromEntries(Object.entries(handlers).map(([host, h]) => [host, createServer(h)]));
  return {
    connect: (args: { host?: string | null }): Duplex => {
      const server = byHost[args.host ?? ""];
      if (!server)
        throw Object.assign(new Error(`connect ECONNREFUSED ${args.host}`), {
          code: "ECONNREFUSED",
          syscall: "connect",
        });
      const [client, side] = duplexPair();
      server.emit("connection", side);
      return client;
    },
    close: () => Object.values(byHost).forEach((s) => s.close()),
  };
}

test("over real HTTP: 4 MiB of parts go through the two legs, every byte in order", async () => {
  const big = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  const obj = Buffer.from("object bytes");
  const frames: Buffer[] = [Buffer.from(`${JSON.stringify({ bundle: big.length })}\n`)];
  for (let at = 0; at < big.length; at += 64 * 1024) {
    const piece = big.subarray(at, at + 64 * 1024);
    frames.push(Buffer.from(`${JSON.stringify({ data: piece.length })}\n`), piece);
  }
  frames.push(wire({ lfs: OID1, size: obj.length }, { data: obj.length }, obj, { end: true }));
  const sent = Buffer.concat(frames);
  let asked: { auth?: string; body?: string } = {};
  let got = Buffer.alloc(0);
  let path = "";
  const net = servers({
    "ws-parent.invalid": (req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        asked = { auth: req.headers.authorization, body: b };
        res.writeHead(200, { "content-type": HANDOFF_CONTENT_TYPE });
        let at = 0;
        const pump = () => {
          while (at < sent.length) {
            const piece = sent.subarray(at, at + 16 * 1024);
            at += piece.length;
            if (!res.write(piece)) return void res.once("drain", pump);
          }
          res.end();
        };
        pump();
      });
    },
    "ws-child.invalid": async (req, res) => {
      path = `${req.method} ${req.url}`;
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c as Buffer);
      got = Buffer.concat(parts);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ landed: true }));
    },
  });
  try {
    const out = await handoffCarrier({ fetch: dialFetch({ connect: net.connect as never }) })(argsOf());
    assert.deepEqual(out, { outcome: "carried" });
    assert.equal(asked.auth, "Bearer tok-ws-parent");
    assert.deepEqual(JSON.parse(asked.body!), { path: "/work/app/coder", head: H });
    assert.equal(path, "PUT /handoffs/eff-1");
    assert.ok(got.equals(sent), "every byte, in order");
  } finally {
    net.close();
  }
});

test("over real HTTP: a source that is not there is tried again and then `unknown`; a refusal mid-stream ends the child's request", async () => {
  let net = servers({});
  let out = (await handoffCarrier({ fetch: dialFetch({ connect: net.connect as never }), retryWaitsMs: [1] })(
    argsOf(),
  )) as {
    outcome: string;
    reason: string;
  };
  assert.equal(out.outcome, "unknown");
  assert.match(out.reason, /the source Harness \(ws-parent\) did not answer: connect ECONNREFUSED ws-parent\.invalid/);
  net.close();

  let childSaw: "end" | "aborted" | undefined;
  net = servers({
    "ws-parent.invalid": (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": HANDOFF_CONTENT_TYPE });
        res.write(wire({ bundle: 10 }, { data: 4 }, "abcd"));
        setTimeout(() => res.end(wire({ refused: "the bundle file is not a regular file" })), 20);
      });
    },
    "ws-child.invalid": (req, res) => {
      req.resume();
      req.on("end", () => {
        childSaw = "end";
        res.end(JSON.stringify({ landed: true }));
      });
      req.on("aborted", () => (childSaw = "aborted"));
      req.on("error", () => (childSaw ??= "aborted"));
    },
  });
  try {
    out = (await handoffCarrier({ fetch: dialFetch({ connect: net.connect as never }) })(argsOf())) as typeof out;
    assert.deepEqual(out, {
      outcome: "refused",
      reason: `the Handoff of /work/app/coder at ${H}: the bundle file is not a regular file`,
    });
    for (let i = 0; i < 100 && childSaw === undefined; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(childSaw, "aborted", "the child's request broke before its end");
  } finally {
    net.close();
  }
});

test("over real HTTP: a source whose stream breaks mid-part is `unknown`, and the reason names the source, not the child", async () => {
  const net = servers({
    "ws-parent.invalid": (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": HANDOFF_CONTENT_TYPE });
        res.write(wire({ bundle: 100 }, { data: 100 }, "abcd"));
        setTimeout(() => res.socket?.destroy(), 20);
      });
    },
    "ws-child.invalid": (req, res) => {
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ landed: true })));
    },
  });
  try {
    const out = (await handoffCarrier({ fetch: dialFetch({ connect: net.connect as never }) })(argsOf())) as {
      outcome: string;
      reason: string;
    };
    assert.equal(out.outcome, "unknown");
    assert.match(out.reason, /^the files of the Handoff were not carried: the source Harness's stream broke: /);
  } finally {
    net.close();
  }
});

test("over real HTTP: a stop of the cut mid-carry ends the source's request, which kills its step, and the child's", async () => {
  const closed: string[] = [];
  const net = servers({
    "ws-parent.invalid": (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": HANDOFF_CONTENT_TYPE });
        res.write(wire({ bundle: 100 }, { data: 4 }, "abcd"));
        res.on("close", () => closed.push("source"));
      });
    },
    "ws-child.invalid": (req) => {
      req.on("data", () => {});
      req.on("close", () => closed.push("child"));
    },
  });
  try {
    const ctl = new AbortController();
    const carrying = handoffCarrier({ fetch: dialFetch({ connect: net.connect as never }) })(argsOf(ctl.signal)).then(
      () => assert.fail("a stopped carry answered"),
      (err: unknown) => err as Error,
    );
    for (let i = 0; i < 200 && closed.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 5));
      if (i === 10) ctl.abort(new Error("the state exited"));
    }
    assert.equal((await carrying).message, "the state exited", "the stop's reason: drive settles nothing on a stop");
    for (let i = 0; i < 100 && closed.length < 2; i++) await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(closed.sort(), ["child", "source"]);
  } finally {
    net.close();
  }
});
