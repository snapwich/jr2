// The run-narrative echo (ADR-0023): rendering per event kind, and the wire route. Rendering is
// the printer's craft — label-prefixed lines, bounded payloads, no ANSI — and the route is
// gated on the placement's bearer (ADR-0058) without the bearer ever resting in this process (the injected check).
// Socket-free: the route is driven via `app.request()`, lines land in a collector.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessApp } from "../src/app.ts";
import { renderEchoEvent } from "../src/printer.ts";
import type { EchoEvent } from "../src/wire.ts";

test("status: an active run renders where it stands, compactly", () => {
  assert.deepEqual(renderEchoEvent({ kind: "status", status: "active", value: "working" }), ["[run] [status] working"]);
  assert.deepEqual(renderEchoEvent({ kind: "status", status: "active", value: { working: "reviewing" } }), [
    "[run] [status] working.reviewing",
  ]);
});

test("status: child machines append as `id: value` — the root's value alone says almost nothing", () => {
  assert.deepEqual(
    renderEchoEvent({
      kind: "status",
      status: "active",
      value: "running",
      children: [{ id: "body", value: "reviewing", children: [{ id: "gate", value: "held" }] }],
    }),
    ["[run] [status] running · body: reviewing · gate: held"],
  );
});

test("status: a terminal status IS the line — done, error, cancelled", () => {
  for (const status of ["done", "error", "cancelled"]) {
    assert.deepEqual(renderEchoEvent({ kind: "status", status, value: "whatever" }), [`[run] [status] ${status}`]);
  }
});

test("emit: the type, then the payload — and no payload suffix for a bare emit", () => {
  assert.deepEqual(renderEchoEvent({ kind: "emit", event: { type: "review_requested", pr: 7 } }), [
    '[run] [emit] review_requested {"pr":7}',
  ]);
  assert.deepEqual(renderEchoEvent({ kind: "emit", event: { type: "pushed" } }), ["[run] [emit] pushed"]);
});

test("admission marker: the Agent's name labels the line, the framing is the body", () => {
  assert.deepEqual(renderEchoEvent({ kind: "admission", agent: "decisioner", prompt: "pick the next step" }), [
    "[decisioner] [admitted] pick the next step",
  ]);
});

test("admission marker: a multi-line framing keeps the agent label on every line (the shim's format)", () => {
  assert.deepEqual(renderEchoEvent({ kind: "admission", agent: "decisioner", prompt: "line one\nline two" }), [
    "[decisioner] [admitted] line one",
    "[decisioner] line two",
  ]);
});

test("admission marker: the framing cuts at the printer's bound, visibly", () => {
  const lines = renderEchoEvent({ kind: "admission", agent: "decisioner", prompt: "x".repeat(2500) });
  assert.deepEqual(lines, [`[decisioner] [admitted] ${"x".repeat(2000)}…`]);
});

test("pick marker: the event name, then its payload under the same bound", () => {
  assert.deepEqual(renderEchoEvent({ kind: "pick", agent: "decisioner", event: "approve", payload: { sha: "abc" } }), [
    '[decisioner] [pick] approve {"sha":"abc"}',
  ]);
  assert.deepEqual(renderEchoEvent({ kind: "pick", agent: "decisioner", event: "approve" }), [
    "[decisioner] [pick] approve",
  ]);
});

test("an event this renderer does not recognize prints nothing — the log never validates", () => {
  assert.deepEqual(renderEchoEvent({ kind: "telemetry", weird: true }), []);
  assert.deepEqual(renderEchoEvent(undefined), []);
  assert.deepEqual(renderEchoEvent({ kind: "emit", event: { notype: 1 } }), []);
});

// ---- The wire route (`POST /echo`) -------------------------------------------------------------

function echoApp() {
  const lines: string[] = [];
  const app = harnessApp({
    runSubmissionFor: () => () => Promise.resolve(),
    checkBearer: (bearer) => bearer === "harness-bearer",
    echoOut: { write: (chunk: string) => void lines.push(chunk) },
  });
  return { app, lines };
}

function post(events: unknown, bearer?: string): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify({ events }),
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  };
}

test("echo: renders each event to the out, in order, and answers the line count", async () => {
  const { app, lines } = echoApp();
  const events: EchoEvent[] = [
    { kind: "status", status: "active", value: "deciding" },
    { kind: "admission", agent: "decisioner", prompt: "pick" },
    { kind: "pick", agent: "decisioner", event: "approve" },
    { kind: "emit", event: { type: "shipped" } },
  ];
  const res = await app.request("/echo", post(events, "harness-bearer"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { printed: 4 });
  assert.deepEqual(lines, [
    "[run] [status] deciding\n",
    "[decisioner] [admitted] pick\n",
    "[decisioner] [pick] approve\n",
    "[run] [emit] shipped\n",
  ]);
});

test("echo: bearer-gated (ADR-0058) — a missing or wrong bearer is 401, and nothing prints", async () => {
  const { app, lines } = echoApp();
  for (const init of [post([{ kind: "emit", event: { type: "x" } }]), post([], "wrong")]) {
    const res = await app.request("/echo", init);
    assert.equal(res.status, 401);
  }
  assert.deepEqual(lines, []);
});

test("echo: a body that is not { events: [...] } is 400", async () => {
  const { app } = echoApp();
  const res = await app.request("/echo", {
    method: "POST",
    body: "not json",
    headers: { "content-type": "application/json", authorization: "Bearer harness-bearer" },
  });
  assert.equal(res.status, 400);
  const noArray = await app.request("/echo", post(undefined, "harness-bearer"));
  assert.equal(noArray.status, 400);
});

test("echo: unrenderable events are skipped, not errors — the batch's good lines still print", async () => {
  const { app, lines } = echoApp();
  const res = await app.request(
    "/echo",
    post([{ kind: "mystery" }, { kind: "emit", event: { type: "ok" } }], "harness-bearer"),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { printed: 1 });
  assert.deepEqual(lines, ["[run] [emit] ok\n"]);
});
