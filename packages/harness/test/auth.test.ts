// The Harness wire is authenticated (ADR-0058). Every route that touches a conversation — admit,
// stream, history, abort — and the echo take ONE bearer: the one the Orchestrator derives for this
// placement. Without it, any pod that can reach this Harness could admit Turns into another
// conversation (iids are derivable — ADR-0013/0057), read its history, or abort it; on the Instance
// Harness that is every Menu-only conversation in the Instance (ADR-0031).
//
// The check is injected (`checkBearer`), because the bearer never enters this process at rest:
// `main.ts` compares a digest from the env. What this file pins is the ROUTING half — which
// routes the gate covers, that a refusal leaks nothing (401 before 404), and that a refused
// admission leaves no conversation behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessApp } from "../src/app.ts";
import type { AgentDefinition } from "../src/spec.ts";

const BEARER = "placement-bearer";
const CODER: AgentDefinition = { model: "faux/model", instructions: "code" };

function gated() {
  let runs = 0;
  const lines: string[] = [];
  const app = harnessApp({
    longPollMs: 25,
    checkBearer: (bearer) => bearer === BEARER,
    runSubmissionFor: () => () => {
      runs++;
      return new Promise<void>(() => {});
    },
    echoOut: { write: (chunk: string) => void lines.push(chunk) },
  });
  return { app, lines, runs: () => runs };
}

const auth = (bearer?: string): Record<string, string> => (bearer ? { authorization: `Bearer ${bearer}` } : {});
const admitInit = (bearer?: string): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ message: "go", definition: CODER }),
  headers: { "content-type": "application/json", ...auth(bearer) },
});

test("admission without the placement's bearer is 401, and creates no conversation", async () => {
  const { app, runs } = gated();
  for (const bearer of [undefined, "wrong", `${BEARER}x`]) {
    const res = await app.request("/agents/coder/i1", admitInit(bearer));
    assert.equal(res.status, 401, `bearer ${bearer}`);
  }
  assert.equal(runs(), 0);
  // Nothing was created: the bearer's own GET finds no conversation.
  assert.equal((await app.request("/agents/coder/i1", { headers: auth(BEARER) })).status, 404);
});

test("the bearer admits, and the same bearer reads the stream, the history, and aborts", async () => {
  const { app } = gated();
  assert.equal((await app.request("/agents/coder/i1", admitInit(BEARER))).status, 200);
  assert.equal((await app.request("/agents/coder/i1?offset=0", { headers: auth(BEARER) })).status, 200);
  assert.equal((await app.request("/agents/coder/i1?view=history", { headers: auth(BEARER) })).status, 200);
  const abort = await app.request("/agents/coder/i1/abort", { method: "POST", headers: auth(BEARER) });
  assert.equal(abort.status, 200);
  assert.deepEqual(await abort.json(), { aborted: true });
});

test("stream, history, and abort refuse a caller without the bearer — before saying whether the conversation exists", async () => {
  const { app } = gated();
  assert.equal((await app.request("/agents/coder/live", admitInit(BEARER))).status, 200);
  for (const iid of ["live", "never-admitted"]) {
    for (const bearer of [undefined, "wrong"]) {
      const where = `${iid} / ${bearer}`;
      assert.equal((await app.request(`/agents/coder/${iid}?offset=0`, { headers: auth(bearer) })).status, 401, where);
      assert.equal(
        (await app.request(`/agents/coder/${iid}?view=history`, { headers: auth(bearer) })).status,
        401,
        where,
      );
      const abort = await app.request(`/agents/coder/${iid}/abort`, { method: "POST", headers: auth(bearer) });
      assert.equal(abort.status, 401, where);
    }
  }
  // The refused abort did not reach the live conversation: the bearer's own abort still finds work.
  const abort = await app.request("/agents/coder/live/abort", { method: "POST", headers: auth(BEARER) });
  assert.deepEqual(await abort.json(), { aborted: true });
});

test("echo takes the same bearer — the Instance token is not the echo's credential any more", async () => {
  const { app, lines } = gated();
  const echo = (bearer?: string) =>
    app.request("/echo", {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "emit", event: { type: "shipped" } }] }),
      headers: { "content-type": "application/json", ...auth(bearer) },
    });
  assert.equal((await echo()).status, 401);
  assert.equal((await echo("wrong")).status, 401);
  assert.deepEqual(lines, []);
  assert.equal((await echo(BEARER)).status, 200);
  assert.deepEqual(lines, ["[run] [emit] shipped\n"]);
});
