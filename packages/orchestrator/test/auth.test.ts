// The authorization boundary (ADR-0013). This is the file that says what the Adapter is FOR.
//
// The setting: an Agent has code execution in its Harness container (that is what `local()` tools
// are), and that container shares the pod's network namespace with the Adapter. So the Agent can
// reach the Orchestrator's HTTP surface — no NetworkPolicy can tell its packets from the Adapter's.
// The ONLY thing standing between it and the delivery API is the token, which is why the token is
// delivered into the Adapter container alone, and why these tests exist:
//
//   - a caller with no token drives nothing;
//   - a Sandbox token may deliver to ITS OWN agent surface, and to no other;
//   - a Sandbox token may NOT deliver to a gate — an Agent cannot approve its own review;
//   - the Instance token (the human's, on the host) may do both.
//
// The last two are the ADR's whole point: with the credential in the Harness container, an Agent
// that can reach the delivery API can APPROVE ITS OWN PR. The tool menu is advisory once you hold
// the key to the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { createAuthenticator, mintInstanceToken, sandboxToken } from "../src/tokens.ts";
import { codingDef, gatedDef, mkStore } from "./_fixtures.ts";

const KEY = Buffer.alloc(32, 7);
const INSTANCE_TOKEN = mintInstanceToken();

/** An authenticated app: one instance token, and Sandbox tokens signed by this key. */
async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  host.register(gatedDef());
  const app = createApp(host, createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY }));
  return { host, app };
}

const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (token?: string): RequestInit => (token ? { headers: { authorization: `Bearer ${token}` } } : {});

test("no token, or a forged one, drives nothing", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });

  assert.equal((await app.request(`/runs/${runId}`)).status, 401);
  assert.equal((await app.request(`/agents/${instanceId}/surface`)).status, 401);
  assert.equal((await app.request(`/agents/${instanceId}/events`, post({ type: "done" }))).status, 401);

  // The Sandbox token is a SIGNED NAME: knowing the name is not holding the token. An Agent knows
  // its own Sandbox name (it is in its pod's env) — that is deliberately not enough.
  const forged = `ws-1.${"A".repeat(43)}`;
  assert.equal((await app.request(`/agents/${instanceId}/surface`, get(forged))).status, 401);
  assert.equal((await app.request(`/agents/${instanceId}/surface`, get("ws-1"))).status, 401);
});

test("a Sandbox token drives its own agent surface", async () => {
  const { host, app } = await mkApp();
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });
  const token = sandboxToken(KEY, "ws-1");

  assert.equal((await app.request(`/agents/${instanceId}/surface`, get(token))).status, 200);
  const call = await app.request(
    `/agents/${instanceId}/events`,
    post({ type: "request_review", summary: "PR" }, token),
  );
  assert.equal(call.status, 200);

  // ...and nothing else on the run. Run state and control need the Instance token (ADR-0014).
  assert.equal((await app.request(`/runs/${runId}`, get(token))).status, 403);
  assert.equal((await app.request(`/runs/${runId}/events`, post({ type: "CANCEL" }, token))).status, 403);
  assert.equal(host.status(runId)?.status, "active", "and the run did not stop");
});

test("a Sandbox token cannot read run state, or cancel a run", async () => {
  const { host, app } = await mkApp();
  const mine = await host.start("coding", { sandbox: "ws-mine" });
  const theirs = await host.start("coding", { sandbox: "ws-theirs" });
  const token = sandboxToken(KEY, "ws-mine");

  // `/runs` hands back every live run's CONTEXT (branches, tickets, verdicts — `RunStatus.context`),
  // and `/runs/:id` adds its open GATES. A Sandbox token authenticates (we minted it), so without a
  // principal check it would read all of that — including other features' runs — and then cancel
  // them. Neither is on the Agent's surface, no more than a gate is.
  assert.equal((await app.request("/runs", get(token))).status, 403);
  assert.equal((await app.request(`/runs/${theirs.runId}`, get(token))).status, 403);
  assert.equal((await app.request(`/runs/${theirs.runId}/events`, get(token))).status, 403);

  const kill = await app.request(`/runs/${theirs.runId}/events`, post({ type: "CANCEL" }, token));
  assert.equal(kill.status, 403);
  assert.equal(host.status(theirs.runId)?.status, "active", "the other run is still running");
  assert.equal(host.status(mine.runId)?.status, "active", "and so is its own");

  // The Instance token reads and steers, as it always did.
  assert.equal((await app.request("/runs", get(INSTANCE_TOKEN))).status, 200);
  assert.equal((await app.request(`/runs/${theirs.runId}`, get(INSTANCE_TOKEN))).status, 200);
});

test("the run surface takes no anonymous caller", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding", { sandbox: "ws-1" });

  assert.equal((await app.request("/runs")).status, 401);
  assert.equal((await app.request(`/runs/${runId}/events`)).status, 401);
  assert.equal((await app.request(`/runs/${runId}/events`, post({ type: "CANCEL" }))).status, 401);
});

test("observation is open, and carries no context — the Console's whole diet", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding", { sandbox: "ws-1" });

  // The page is a browser with no token. It gets identity + where the run IS, and not one field
  // more: `context` is what the guarded surface exists to protect (ADR-0013).
  const res = await app.request(`/workflows/coding/runs`);
  assert.equal(res.status, 200, "no token needed");
  const [observed] = (await res.json()) as Array<Record<string, unknown>>;
  assert.deepEqual(observed, {
    runId,
    workflow: "coding",
    status: "active",
    value: { active: "running" },
    children: [],
  });
  assert.ok(observed && !("context" in observed), "context never crosses this line");
  assert.ok(observed && !("instanceId" in observed), "nor the live iid");

  // The real-time half of the same band (ADR-0022): a feed the page can hold open without a token,
  // carrying the same projection. Being open is what lets it be a browser's EventSource at all.
  const feed = await app.request("/workflows/coding/events");
  assert.equal(feed.status, 200, "no token needed to watch a workflow either");
  await feed.body!.cancel();

  // ...and the guarded listing still says everything, to the Instance token alone.
  const [full] = (await (await app.request("/runs", get(INSTANCE_TOKEN))).json()) as Array<Record<string, unknown>>;
  assert.ok(full && "context" in full, "the Instance token's view is unchanged");
});

test("a Sandbox token cannot deliver to a gate — an Agent does not approve its own review", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("gated");
  const token = sandboxToken(KEY, "ws-1");

  const attack = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, token));
  assert.equal(attack.status, 403, "THE claim of ADR-0013: gates are not on the Agent's surface");
  assert.match(((await attack.json()) as { error: string }).error, /cannot deliver to a gate/);
  assert.equal(host.status(runId)?.value, "review", "and the gate did not move");

  // The human's token, on the same gate, does.
  const human = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, INSTANCE_TOKEN));
  assert.equal(human.status, 200);
});

test("a Sandbox token cannot speak for another Sandbox's Agent", async () => {
  const { host, app } = await mkApp();
  const mine = await host.start("coding", { sandbox: "ws-mine" });
  const theirs = await host.start("coding", { sandbox: "ws-theirs" });
  const token = sandboxToken(KEY, "ws-mine");

  // Why this matters, concretely (ADR-0013): `coding.ts`'s iids are DERIVABLE — `<runIid>/<featureId>
  // /<scope>/<role>` — and feature ids are readable from the Work Source. A merely run-scoped token
  // would let one feature's coder inject a `review_verdict` into another feature's reviewer.
  assert.equal((await app.request(`/agents/${theirs.instanceId}/surface`, get(token))).status, 403);
  const inject = await app.request(`/agents/${theirs.instanceId}/events`, post({ type: "done" }, token));
  assert.equal(inject.status, 403);
  assert.equal(host.status(theirs.runId)?.status, "active", "the other run did not move");

  assert.equal((await app.request(`/agents/${mine.instanceId}/surface`, get(token))).status, 200);
});

test("a Sandbox token cannot claim a workspace-less agent (no pod owns it)", async () => {
  const { host, app } = await mkApp();
  // The mechanics-tier shape: an `agentRun` against the stub Harness on the host, in no Sandbox.
  const { instanceId } = await host.start("coding");
  const token = sandboxToken(KEY, "ws-1");

  assert.equal((await app.request(`/agents/${instanceId}/surface`, get(token))).status, 403);
  assert.equal((await app.request(`/agents/${instanceId}/surface`, get(INSTANCE_TOKEN))).status, 200);
});

test("the Instance Harness's token speaks for the Turns placed there, and for no Workspace's (ADR-0031)", async () => {
  const { host, app } = await mkApp();
  // A Menu-only registration records the placement's name as its scope (actor.ts); the Instance
  // Harness Adapter bears a token signed for exactly that name (up.ts/deploy.ts) — the same
  // signed-name doctrine that keeps one feature's coder out of another's reviewer, extended to
  // the second placement. It is NOT the Instance token: an in-cluster caller that suborned a
  // Menu-only Turn must not reach a Workspace run's live surface.
  const menuOnly = await host.start("coding", { sandbox: "j2-instance-harness" });
  const workspace = await host.start("coding", { sandbox: "ws-1" });
  const token = sandboxToken(KEY, "j2-instance-harness");

  assert.equal((await app.request(`/agents/${menuOnly.instanceId}/surface`, get(token))).status, 200);
  assert.equal((await app.request(`/agents/${workspace.instanceId}/surface`, get(token))).status, 403);
  const inject = await app.request(`/agents/${workspace.instanceId}/events`, post({ type: "done" }, token));
  assert.equal(inject.status, 403);
  assert.equal(host.status(workspace.runId)?.status, "active", "the Workspace run did not move");
});

test("an unknown iid is 404 for a valid token — the scope check leaks nothing about it", async () => {
  const { app } = await mkApp();
  const res = await app.request(`/agents/no-such-iid/surface`, get(sandboxToken(KEY, "ws-1")));
  assert.equal(res.status, 404);
});

test("/runs/resolve is Instance-only — a prefix search is a run-id enumeration oracle", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("coding", { sandbox: "ws-mine" });
  const prefix = runId.slice(0, 8);

  // Probing prefixes recovers run ids, and a run id is the address of everything else here. Left
  // open (or reachable with a Sandbox token) this route would hand an Agent the ids of every OTHER
  // run on the orchestrator — the enumeration `GET /runs`'s 403 above exists to prevent.
  assert.equal((await app.request(`/runs/resolve?prefix=${prefix}`)).status, 401);
  assert.equal((await app.request(`/runs/resolve?prefix=${prefix}`, get(sandboxToken(KEY, "ws-mine")))).status, 403);
  assert.equal((await app.request(`/runs/resolve?prefix=${prefix}`, get(INSTANCE_TOKEN))).status, 200);
});
