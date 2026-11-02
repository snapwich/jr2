// The authorization boundary (ADR-0013). This is the file that says what the Custodian holds FOR.
//
// The setting: an Agent has code execution in its Harness container (that is what `local()` tools
// are), and that container shares the pod's network namespace with the Custodian. So the Agent can
// reach the Orchestrator's HTTP surface — no NetworkPolicy can tell its packets from the
// Custodian's. The ONLY thing standing between it and the delivery API is the token, which is why
// the token is mounted into the Custodian container alone — the Harness holds its Stand-in
// (ADR-0059) — and why these tests exist:
//
//   - a caller with no token drives nothing;
//   - a control token, with the slot the Harness states, may deliver to ITS OWN pod's agent
//     surface for that slot, and to no other (ADR-0076);
//   - a fetch token opens the fetch route alone, and a control token never opens it;
//   - neither may deliver to a gate — an Agent cannot approve its own review;
//   - the Instance token (the human's, on the host) may do both.
//
// The last two are the ADR's whole point: with the credential in the Harness container, an Agent
// that can reach the delivery API can APPROVE ITS OWN PR. The tool menu is advisory once you hold
// the key to the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import {
  controlStandIn,
  controlToken,
  createAuthenticator,
  harnessToken,
  mayAskForSandbox,
  mayDeliverToAgent,
  mintInstanceToken,
  sandboxToken,
} from "../src/tokens.ts";
import { standIn } from "../src/held-secrets.ts";
import { admittedIid, codingDef, gatedDef, mkStore, MockFlueClient } from "./_fixtures.ts";

const KEY = Buffer.alloc(32, 7);
const INSTANCE_TOKEN = mintInstanceToken();

/** An authenticated app: one instance token, and Sandbox tokens signed by this key. */
async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  const clients = new Map<string, MockFlueClient>();
  host.register(codingDef(clients));
  host.register(gatedDef());
  const app = createApp(host, createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY }));
  /** The live Turn's address, as the Harness reads it: jr2 mints every iid (ADR-0057), so the
   * test reads it off the admission and encodes it — a minted id carries path separators. */
  const agentPath = async (run: { instanceId: string }, suffix: string) =>
    `/agents/${encodeURIComponent(await admittedIid(clients.get(run.instanceId)!))}/${suffix}`;
  /** The slot the Harness states for the run's Turn (ADR-0076): its registration's. */
  const slotOf = async (run: { instanceId: string }) =>
    host.agentSurface(await admittedIid(clients.get(run.instanceId)!))!.slot!;
  return { host, app, agentPath, slotOf };
}

const headers = (token?: string, slot?: string): Record<string, string> => ({
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(slot ? { "x-jr2-slot": slot } : {}),
});
const post = (body: unknown, token?: string, slot?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers(token, slot) },
  body: JSON.stringify(body),
});
const get = (token?: string, slot?: string): RequestInit => (token ? { headers: headers(token, slot) } : {});

test("no token, or a forged one, drives nothing", async () => {
  const { host, app, agentPath } = await mkApp();
  const run = await host.start("coding", { sandbox: "ws-1" });
  const surface = await agentPath(run, "surface");

  assert.equal((await app.request(`/runs/${run.runId}`)).status, 401);
  assert.equal((await app.request(surface)).status, 401);
  assert.equal((await app.request(await agentPath(run, "events"), post({ type: "done" }))).status, 401);

  // The Sandbox token is a SIGNED NAME: knowing the name is not holding the token. An Agent knows
  // its own Sandbox name (it is in its pod's env) — that is deliberately not enough.
  const forged = `ws-1.${"A".repeat(43)}`;
  assert.equal((await app.request(surface, get(forged))).status, 401);
  assert.equal((await app.request(surface, get("ws-1"))).status, 401);
});

test("a control token, with the slot the Harness states, drives its own agent surface", async () => {
  const { host, app, agentPath, slotOf } = await mkApp();
  const run = await host.start("coding", { sandbox: "ws-1" });
  const { runId } = run;
  const token = controlToken(KEY, "ws-1");
  const slot = await slotOf(run);
  assert.equal(slot, "root/coder", "the slot is the Machine's actor path and the agent's name");

  assert.equal((await app.request(await agentPath(run, "surface"), get(token, slot))).status, 200);
  const call = await app.request(
    await agentPath(run, "events"),
    post({ type: "request_review", summary: "PR" }, token, slot),
  );
  assert.equal(call.status, 200);

  // ...and nothing else on the run. Run state and control need the Instance token (ADR-0014).
  assert.equal((await app.request(`/runs/${runId}`, get(token, slot))).status, 403);
  assert.equal((await app.request(`/runs/${runId}/events`, post({ type: "CANCEL" }, token, slot))).status, 403);
  assert.equal(host.status(runId)?.status, "active", "and the run did not stop");
});

test("each token opens its own routes alone (ADR-0076)", async () => {
  const { host, app, agentPath, slotOf } = await mkApp();
  const run = await host.start("coding", { sandbox: "ws-1" });
  const slot = await slotOf(run);
  const control = controlToken(KEY, "ws-1");
  const fetch = sandboxToken(KEY, "ws-1");

  // The fetch token on an agent route: a known token, refused there.
  assert.equal((await app.request(await agentPath(run, "surface"), get(fetch, slot))).status, 403);
  assert.equal((await app.request(await agentPath(run, "events"), post({ type: "done" }, fetch, slot))).status, 403);
  assert.equal((await app.request(await agentPath(run, "notices"), post({ heard: [] }, fetch, slot))).status, 403);
  // The control token on the fetch route: refused there.
  assert.equal(
    (await app.request("/sandboxes/ws-1/fetch", post({ identity: "example.test/app" }, control, slot))).status,
    403,
  );
  // A control token that states no slot is no principal at all.
  assert.equal((await app.request(await agentPath(run, "surface"), get(control))).status, 401);
  assert.equal(host.status(run.runId)?.status, "active", "nothing moved");
});

test("a stated slot that is not the registration's is refused on every agent route (ADR-0076)", async () => {
  const { host, app, agentPath } = await mkApp();
  const run = await host.start("coding", { sandbox: "ws-1" });
  const token = controlToken(KEY, "ws-1");
  // Another Agent of the same pod; and the same agent name in another Machine — two slots.
  for (const slot of ["root/reviewer", "feature-1/coder"]) {
    assert.equal((await app.request(await agentPath(run, "surface"), get(token, slot))).status, 403, slot);
    const pick = await app.request(await agentPath(run, "events"), post({ type: "done" }, token, slot));
    assert.equal(pick.status, 403, slot);
    const ack = await app.request(await agentPath(run, "notices"), post({ heard: ["n-1"] }, token, slot));
    assert.equal(ack.status, 403, slot);
  }
  assert.equal(host.status(run.runId)?.status, "active", "nothing moved");
});

test("each verifier accepts its own domain alone: a key's other signed names are no token (ADR-0076)", () => {
  const auth = createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY });
  assert.deepEqual(auth(controlToken(KEY, "ws-1"), "root/coder"), {
    kind: "agent",
    sandbox: "ws-1",
    slot: "root/coder",
  });
  assert.deepEqual(auth(sandboxToken(KEY, "ws-1")), { kind: "sandbox", sandbox: "ws-1" });
  // A control token never reads as a fetch token, with or without a slot.
  assert.equal(auth(controlToken(KEY, "ws-1")), undefined);
  // The bare form signed over another domain's name: the HMACs exist, and still open nothing.
  assert.equal(auth(`harness:ws-1.${harnessToken(KEY, "ws-1")}`), undefined);
  assert.equal(auth(`control-standin:ws-1.${controlStandIn(KEY, "ws-1")}`), undefined);
  // The secret control Stand-in, sent straight here, is no token either.
  assert.equal(auth(controlStandIn(KEY, "ws-1"), "root/coder"), undefined);
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

test("no Agent token delivers to a gate — an Agent does not approve its own review", async () => {
  const { host, app } = await mkApp();
  const { runId } = await host.start("gated");

  // The fetch token, and the control token with any slot it states (ADR-0076).
  for (const [token, slot] of [
    [sandboxToken(KEY, "ws-1"), undefined],
    [controlToken(KEY, "ws-1"), "root/reviewer"],
  ] as const) {
    const attack = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, token, slot));
    assert.equal(attack.status, 403, "THE claim of ADR-0013: gates are not on the Agent's surface");
    assert.match(((await attack.json()) as { error: string }).error, /cannot deliver to a gate/);
  }
  assert.equal(host.status(runId)?.value, "review", "and the gate did not move");

  // The human's token, on the same gate, does.
  const human = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, INSTANCE_TOKEN));
  assert.equal(human.status, 200);
});

test("a control token cannot speak for another Sandbox's Agent", async () => {
  const { host, app, agentPath, slotOf } = await mkApp();
  const mine = await host.start("coding", { sandbox: "ws-mine" });
  const theirs = await host.start("coding", { sandbox: "ws-theirs" });
  const token = controlToken(KEY, "ws-mine");
  const slot = await slotOf(theirs);

  // Why this matters, concretely (ADR-0013): a continued iid is DERIVABLE — `<runId>/<machine
  // actor path>/<agent>` (ADR-0057), and a Pool's actor path is its item's id, readable from the
  // Work Source. A merely run-scoped token would let one item's coder inject a verdict into
  // another item's reviewer.
  assert.equal((await app.request(await agentPath(theirs, "surface"), get(token, slot))).status, 403);
  const inject = await app.request(await agentPath(theirs, "events"), post({ type: "done" }, token, slot));
  assert.equal(inject.status, 403);
  assert.equal(host.status(theirs.runId)?.status, "active", "the other run did not move");

  assert.equal((await app.request(await agentPath(mine, "surface"), get(token, await slotOf(mine)))).status, 200);
});

test("a control token cannot claim a workspace-less agent (no pod owns it)", async () => {
  const { host, app, agentPath, slotOf } = await mkApp();
  // The mechanics-tier shape: an Agent turn against the stub Harness on the host, in no Sandbox.
  const run = await host.start("coding");
  const token = controlToken(KEY, "ws-1");
  const surface = await agentPath(run, "surface");

  assert.equal((await app.request(surface, get(token, await slotOf(run)))).status, 403);
  assert.equal((await app.request(surface, get(INSTANCE_TOKEN))).status, 200);
});

test("the Instance Harness's token speaks for the Turns placed there, and for no Workspace's (ADR-0031)", async () => {
  const { host, app, agentPath } = await mkApp();
  // A Menu-only registration records the placement's name as its scope (actor.ts); the Instance
  // Harness's Custodian holds a token signed for exactly that name (up.ts/deploy.ts) — the same
  // signed-name doctrine that keeps one feature's coder out of another's reviewer, extended to
  // the second placement. It is NOT the Instance token: an in-cluster caller that suborned a
  // Menu-only Turn must not reach a Workspace run's live surface.
  const menuOnly = await host.start("coding", { sandbox: "jr2-instance-harness" });
  const workspace = await host.start("coding", { sandbox: "ws-1" });
  const token = controlToken(KEY, "jr2-instance-harness");
  const slot = "root/coder";

  assert.equal((await app.request(await agentPath(menuOnly, "surface"), get(token, slot))).status, 200);
  assert.equal((await app.request(await agentPath(workspace, "surface"), get(token, slot))).status, 403);
  const inject = await app.request(await agentPath(workspace, "events"), post({ type: "done" }, token, slot));
  assert.equal(inject.status, 403);
  assert.equal(host.status(workspace.runId)?.status, "active", "the Workspace run did not move");
});

test("an unknown iid is 404 for a valid token — the scope check leaks nothing about it", async () => {
  const { app } = await mkApp();
  const res = await app.request(`/agents/no-such-iid/surface`, get(controlToken(KEY, "ws-1"), "root/coder"));
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

test("the Repo report is Instance-band: a Repo's url plus git's error is state, not structure", async () => {
  // ADR-0048/0051 put each Repo's per-node cache state on the status surface, and ADR-0014 says
  // where that lands: the rows name this instance's Repos by url and carry git's own error text —
  // the same class of thing the open observation projections strip out of a RunStatus.
  const { app } = await mkApp();
  assert.equal((await app.request("/repos")).status, 401);
  assert.equal((await app.request("/repos", get(sandboxToken(KEY, "ws-mine")))).status, 403);
  assert.equal((await app.request("/repos", get(INSTANCE_TOKEN))).status, 200);
});

test("starting a run is Instance-band: a Sandbox token starts nothing", async () => {
  // A Sandbox token's whole scope is delivering to its OWN agent surface (ADR-0013). Starting a
  // run is not on that surface: an Agent that could start `deploy` — or itself, in a loop — would
  // spend Sandboxes and model calls nobody asked for. The Custodian's route allowlist does not
  // forward this route, and that is not what refuses it: the principal is.
  const { app } = await mkApp();
  assert.equal((await app.request("/workflows/coding/runs", post({ sandbox: "ws-x" }))).status, 401);
  assert.equal(
    (await app.request("/workflows/coding/runs", post({ sandbox: "ws-x" }, sandboxToken(KEY, "ws-mine")))).status,
    403,
  );
  assert.equal((await app.request("/workflows/coding/runs", post({ sandbox: "ws-x" }, INSTANCE_TOKEN))).status, 201);
});

test("the Stand-in the Harness holds opens nothing: every route refuses it, and nothing moves (ADR-0059)", async () => {
  // What the Agent gains by skipping the Custodian and calling the Orchestrator itself, with the
  // public fetch Stand-in: nothing. The Custodian swaps it on the fetch route toward this Service;
  // sent straight here, it is a string no key signed.
  const { host, app, agentPath } = await mkApp();
  const run = await host.start("coding", { sandbox: "ws-1" });
  const gated = await host.start("gated");
  const held = standIn("JR2_SANDBOX_TOKEN");
  const refused = [
    await app.request(await agentPath(run, "surface"), get(held)),
    await app.request(await agentPath(run, "events"), post({ type: "request_review", summary: "self" }, held)),
    await app.request(await agentPath(run, "deliveries/d-1"), get(held)),
    await app.request("/sandboxes/ws-1/fetch", post({ identity: "example.test/app" }, held)),
    await app.request(`/runs/${gated.runId}/gates/F-1/events`, post({ type: "approve" }, held)),
    await app.request("/runs", get(held)),
    await app.request("/workflows/coding/runs", post({}, held)),
  ];
  assert.deepEqual(
    refused.map((r) => r.status),
    [401, 401, 401, 401, 401, 401, 401],
  );
  assert.equal(host.status(run.runId)?.status, "active", "the Agent's own run did not move");
  assert.equal(host.status(gated.runId)?.value, "review", "and no gate moved");
});

test("the publish token resolves to the publisher, which delivers to nothing (ADR-0069)", async () => {
  const publishToken = mintInstanceToken();
  const auth = createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY, publishToken });
  assert.deepEqual(auth(publishToken), { kind: "publisher" });
  assert.deepEqual(auth(INSTANCE_TOKEN), { kind: "instance" });
  // Without one configured, no bearer is the publisher.
  assert.equal(createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY })(publishToken), undefined);
  assert.equal(mayDeliverToAgent({ kind: "publisher" }, { sandbox: "ws-1", slot: "root/coder" }), false);
  assert.equal(mayAskForSandbox({ kind: "publisher" }, "ws-1"), false);

  // On the routes: the agent surface and a Gate refuse it as they refuse an Instance-only route.
  const host = new RunHost({ store: await mkStore() });
  const clients = new Map<string, MockFlueClient>();
  host.register(codingDef(clients));
  host.register(gatedDef());
  const app = createApp(host, auth);
  const run = await host.start("coding", { sandbox: "ws-1" });
  const surface = `/agents/${encodeURIComponent(await admittedIid(clients.get(run.instanceId)!))}/surface`;
  assert.equal((await app.request(surface, get(publishToken))).status, 403);
  assert.equal((await app.request(`/runs/${run.runId}`, get(publishToken))).status, 403);
  assert.equal((await app.request("/workflows/coding/runs", post({}, publishToken))).status, 403);
});

test("a start with jr2-dispatched-by is Instance-band like any start: the key opens nothing (ADR-0071)", async () => {
  const { host, app } = await mkApp();
  const header = JSON.stringify({ run: "c", slot: "s", effect: "k-auth", depth: 1, instance: "ops" });
  const start = (token?: string): RequestInit => {
    const init = post({}, token);
    return { ...init, headers: { ...(init.headers as Record<string, string>), "jr2-dispatched-by": header } };
  };
  assert.equal((await app.request("/workflows/gated/runs", start())).status, 401);
  assert.equal((await app.request("/workflows/gated/runs", start(sandboxToken(KEY, "ws-mine")))).status, 403);
  const first = await app.request("/workflows/gated/runs", start(INSTANCE_TOKEN));
  assert.equal(first.status, 201);
  // A repeat answers the run only to the Instance token, too: the key is no credential.
  assert.equal((await app.request("/workflows/gated/runs", start(sandboxToken(KEY, "ws-mine")))).status, 403);
  assert.equal((await app.request("/workflows/gated/runs", start(INSTANCE_TOKEN))).status, 200);
  assert.equal(host.list().filter((s) => s.workflow === "gated").length, 1);
});
