// The control requests over the Custodian's control socket (ADR-0076): `unixFetch` against a real
// HTTP server on a Unix socket. The Menu reads the surface, a pick is delivered and its answer
// read, and a notice is acknowledged, each with the bearer and the stated slot. No socket at the
// path is a transport failure that proves the pick never left, so the model is told to try again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackNotices, readMenu, type Surface } from "../src/menu.ts";
import { unixFetch } from "../src/unix-fetch.ts";

const SURFACE: Surface = {
  instanceId: "run-1/coder",
  runId: "run-1",
  sandbox: "ws-1",
  allowed: ["done"],
  menu: [{ name: "done", input: { type: "object", properties: {} }, semantics: "ack" }],
};

type Seen = { method: string; url: string; auth: string | undefined; slot: string | undefined; body: string };

async function listen(answer: (req: IncomingMessage, body: string) => { status: number; json?: unknown }) {
  const socket = join(mkdtempSync(join(tmpdir(), "jr2-control-")), "control.sock");
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization,
      slot: req.headers["x-jr2-slot"] as string | undefined,
      body,
    });
    const a = answer(req, body);
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(a.json === undefined ? "" : JSON.stringify(a.json));
  });
  await new Promise<void>((r) => server.listen(socket, r));
  return { socket, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const opts = (socket: string) => ({
  url: "http://jr2-custodian",
  token: "the-control-stand-in",
  slot: "root/coder",
  fetch: unixFetch(socket),
  log: () => {},
  retryWindowMs: 0,
});

test("the Menu, a pick and a notice's acknowledgment go over the control socket, with the bearer and the slot", async () => {
  const s = await listen((req) => {
    if (req.url?.endsWith("/surface")) return { status: 200, json: SURFACE };
    if (req.url?.endsWith("/events"))
      return { status: 200, json: { deliveryId: "d1", allowed: [], turnComplete: true } };
    if (req.url?.endsWith("/notices")) return { status: 204 };
    return { status: 404, json: { error: "no route" } };
  });
  try {
    const read = await readMenu(opts(s.socket), "run-1/coder");
    assert.ok(read);
    assert.deepEqual(read.allowed, ["done"]);
    const answer = await read.menu[0]!.pick({});
    assert.equal(typeof answer, "string");
    assert.equal(await ackNotices(opts(s.socket), "run-1/coder", ["n1"]), true);
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
  } finally {
    await s.close();
  }
});

test("an error answer is a Response, read as the Orchestrator's word", async () => {
  const s = await listen(() => ({ status: 403, json: { error: "the slot is not the registration's" } }));
  try {
    await assert.rejects(readMenu(opts(s.socket), "run-1/coder"), /the slot is not the registration's/);
  } finally {
    await s.close();
  }
});

test("no socket at the path: a pick never left, and the model is told to try it again", async () => {
  const s = await listen(() => ({ status: 200, json: SURFACE }));
  const read = await readMenu(opts(s.socket), "run-1/coder");
  await s.close();
  assert.ok(read);
  await assert.rejects(
    read.menu[0]!.pick({}),
    /the pick never reached the Orchestrator \(connect ENOENT .*\) — try it again/,
  );
});

test("an abort ends a request at once", async () => {
  const s = await listen(() => ({ status: 200, json: SURFACE }));
  try {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(unixFetch(s.socket)("http://jr2-custodian/x", { signal: controller.signal }), /stop/);
  } finally {
    await s.close();
  }
});
