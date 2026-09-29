// End-to-end Machine-host tests: prove the three slice-1 modules cohere under RunHost.
//
// The Agent's up-channel is driven the REAL way — `sendToAgent`, the same registration-table path
// `POST /agents/:iid/events` takes when a Sandbox's Harness delivers a pick (ADR-0013) — so
// resolve → validate → deliver-into-the-invoking-state is exercised, not bypassed. The flue side is
// a mock FlueClient: it records admissions and settles (so the ledger and restore can be checked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "xstate";
import { doneEvent, requestReviewEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { agent } from "../src/harness-client.ts";
import { jr2Setup } from "../src/setup.ts";
import { RunHost, type RunStatus, type WorkflowDef } from "../src/run-host.ts";
import { EventValidationError } from "../src/registration.ts";
import {
  admittedIid,
  codingDef,
  coderDefinition,
  continuedDef,
  continuedIidOf,
  mkStore,
  MockFlueClient,
  pipelineDef,
  tick,
  waitFor,
  workspaceDef,
} from "./_fixtures.ts";
import type { Ctx } from "./_fixtures.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";

test("an Agent's delivery routes into the owning run's Machine", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  // jr2 mints the conversation (ADR-0057), so the address is discovered off the admission —
  // exactly as a Harness learns the iid it was admitted with.
  const iid = await admittedIid(clients.get(instanceId)!);

  const receipt = host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  // Every delivery is addressable after the fact — the room a deferred result needs (ADR-0013).
  assert.ok(receipt.deliveryId, "a delivery answers with a receipt");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  const status = host.status(runId);
  assert.deepEqual(status?.value, { active: "review" });
  assert.equal((status?.context as Ctx).summary, "PR up");

  host.sendToAgent(iid, { type: "done" });
  await waitFor(() => host.status(runId) === undefined); // final → dropped from the registry
});

test("the receipt is self-describing: it says whether the turn is over (ADR-0024)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  // `request_review` moves the machine WITHIN the invoking state, so the same turn is still live.
  const open = host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  assert.equal(open.delivered, true);
  assert.equal(open.event, "request_review");
  assert.equal(open.turnComplete, false, "the invoking state is still waiting — this turn is not over");

  // `done` leaves the state that invoked the Agent, which stops the invocation and destroys the
  // registration. That this is already TRUE when `deliver()` returns is the whole claim: xstate's
  // `sendBack` reaches the mailbox synchronously, so the flag reports what happened rather than
  // what was hoped. If an xstate bump ever breaks that, this test fails instead of a live run.
  const over = host.sendToAgent(iid, { type: "done" });
  assert.equal(over.turnComplete, true, "the state stopped waiting — the turn is over");
  assert.ok(over.deliveryId, "a delivery stays addressable after the fact (ADR-0013)");
});

test("a pick no transition accepts says so, instead of reading as a move (ADR-0029)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  const moved = host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  assert.equal(moved.moved, true);
  assert.equal(moved.turnComplete, false, "moved WITHIN the invoking state: still the same turn");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  // `review` handles only `done`, and the invoke lives on the ANCESTOR — so this delivery is
  // well-formed, arrives, and moves nothing, while the registration survives. Before `moved` the
  // two outcomes above and below were the same receipt, and the Agent's only move was to retry.
  const rejected = host.sendToAgent(iid, { type: "request_review", summary: "again" });
  assert.equal(rejected.delivered, true, "it arrived — validation is unchanged");
  assert.equal(rejected.moved, false, "…and nothing accepted it");
  assert.equal(rejected.turnComplete, false, "which is NOT the same claim as the turn being over");
  assert.equal((host.status(runId)?.context as Ctx).summary, "PR up", "a rejected pick changes nothing");
});

test("the surface serves the whole Menu, and the Allowed picks narrow as the guards do (ADR-0029)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  const before = host.agentSurface(iid)!;
  assert.deepEqual(
    before.menu.map((e) => e.name),
    ["done", "request_review"],
    "the Menu, in its fixed order",
  );
  assert.deepEqual(before.allowed, ["done", "request_review"]);

  host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  // Same turn, same registration — the guard now refuses a second review, so the Allowed picks
  // narrow to `done`. The Menu does NOT: it is the tools block, and a tools block that changes
  // bills the whole conversation again.
  const after = host.agentSurface(iid)!;
  assert.deepEqual(after.allowed, ["done"]);
  assert.deepEqual(JSON.stringify(after.menu), JSON.stringify(before.menu), "byte-identical Menu");
});

test("the receipt carries the Allowed picks read AFTER the delivery (ADR-0029)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  // The pick moved the Machine within the invoking state, and closed its own guard behind it.
  const moved = host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  assert.deepEqual(moved.allowed, ["done"], "what the Turn may pick NOW, not before the pick");
  await waitFor(() => JSON.stringify(host.status(runId)?.value).includes("review"));

  const refused = host.sendToAgent(iid, { type: "request_review", summary: "again" });
  assert.equal(refused.moved, false);
  assert.deepEqual(refused.allowed, ["done"]);

  // A Turn that is over may pick nothing.
  const over = host.sendToAgent(iid, { type: "done" });
  assert.equal(over.turnComplete, true);
  assert.deepEqual(over.allowed, []);
});

test("one conversation, two turns: the abort is ordered ahead of the next turn's admission", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(continuedDef(clients));
  const { runId, instanceId } = await host.start("continued");
  const flue = clients.get(instanceId)!;
  // Both turns say `continue: true`, so both land on the Machine instance's one conversation —
  // structural, so the test derives the address exactly as jr2 does (ADR-0057).
  const iid = continuedIidOf(runId);
  flue.holdAborts = true;
  await waitFor(() => flue.admits.length === 1);

  // The pick that ends turn one. The next state re-registers the SAME address a moment later, so
  // an existence check would call this turn unfinished; the receipt tracks the REGISTRATION.
  const receipt = host.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  assert.equal(receipt.turnComplete, true, "the state that asked for turn one stopped waiting");

  await tick();
  assert.deepEqual(flue.aborts, [{ agentName: "coder", instanceId: iid }], "turn one's submission is ended");
  assert.equal(flue.admits.length, 1, "turn two waits: an abort that overtook it would settle it unrun");

  flue.releaseAborts();
  await waitFor(() => flue.admits.length === 2);
  assert.equal(flue.admits[1]!.prompt, "turn two");

  // …and turn two still drives the Machine, which is the whole point of ordering it.
  host.sendToAgent(iid, { type: "done" });
  await waitFor(() => host.status(runId) === undefined);
});

test("CANCEL ends the run: its Agents' turns end, and it does not come back (ADR-0025)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  await host.cancel(runId);

  // The human said abandon, so the Agent stops being asked and stops answering (ADR-0024).
  assert.deepEqual(clients.get(instanceId)!.aborts, [{ agentName: "coder", instanceId: iid }]);
  assert.equal(host.status(runId), undefined, "gone from the live registry");
  assert.equal(host.agentSurface(iid), undefined, "and its surface went with it");

  // Terminal in the store: `read` reports how it ended, keeping where it was when it did…
  const read = await host.read(runId);
  assert.equal(read?.status, "cancelled");
  assert.deepEqual(read?.value, { active: "running" });

  // …and a restore leaves it alone. Ending the turns and refusing to restore are ONE decision:
  // a cancelled run that came back would re-attach to submissions that settled `aborted`.
  const second = new RunHost({ store });
  second.register(codingDef(new Map()));
  assert.deepEqual(await second.restore(), { reattached: [], lost: [], drifted: [], failed: [] });
});

test("stop() is the other verb: no abort, and the run restores (ADR-0007/0025)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  await waitFor(() => clients.get(instanceId)!.admits.length === 1);
  let stored: string | undefined;
  await waitFor(() => {
    void store.load(runId).then((s) => (stored = s?.status));
    return stored === "live";
  });

  await host.stop(runId);

  assert.deepEqual(clients.get(instanceId)!.aborts, [], "the submissions stay alive for the re-attach");
  const second = new RunHost({ store });
  second.register(codingDef(new Map()));
  assert.deepEqual((await second.restore()).reattached, [runId]);
});

test("the agent surface IS the invoking state's registration, and dies with it", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding", { sandbox: "ws-1" });
  const iid = await admittedIid(clients.get(instanceId)!);

  // What the Harness presents as the Menu: this turn's events, their schemas, their semantics.
  const surface = host.agentSurface(iid);
  assert.equal(surface?.runId, runId);
  assert.equal(surface?.sandbox, "ws-1", "the surface records its Sandbox — what scopes its token");
  assert.deepEqual(
    surface?.menu.map((a) => a.name),
    ["done", "request_review"],
    "exactly what the invoking state accepts — no more, no less",
  );
  assert.deepEqual(
    surface?.menu.map((a) => a.semantics),
    ["done", "request_review"].map(() => "ack"),
  );

  // The state exits → the registration goes with it → there is no surface to serve. The Harness
  // needs no `list_changed` to learn this: it reads per turn, and a dead turn has no menu.
  host.sendToAgent(iid, { type: "done" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(host.agentSurface(iid), undefined);
});

test("a delivery outside the turn's surface is refused, and the Allowed picks ride beside the refusal (ADR-0029)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(clients));
  const { instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);

  // The refusal names no list of its own: the Allowed picks ride beside it, and the Harness writes
  // the one list the model reads (ADR-0029, ADR-0062) — a second, in other names, contradicts it.
  assert.throws(
    () => host.sendToAgent(iid, { type: "merge" }),
    (err: Error) => /"merge"/.test(err.message) && !/accepts:/.test(err.message),
  );
  // The out-of-set refusal names the Allowed picks, so the next call can be one of them (ADR-0029).
  assert.throws(
    () => host.sendToAgent(iid, { type: "merge" }),
    (err: unknown) =>
      err instanceof EventValidationError && JSON.stringify(err.allowed) === '["done","request_review"]',
  );
  assert.throws(() => host.sendToAgent(iid, { type: "request_review" }), /invalid "request_review" payload/);
  assert.throws(() => host.sendToAgent("no-such-iid", { type: "done" }), /no live registration/);
});

test("the vocabulary rides the Machine and is served per Machine node (ADR-0011, ADR-0049)", async () => {
  const host = new RunHost({ store: await mkStore() });

  // A jr2Setup machine carries its own defs, and the machine doc attributes them to that node —
  // there is no run-wide list to read them off any more.
  host.register(codingDef(new Map()));
  assert.deepEqual(
    host
      .machine("coding")!
      .events.map((e) => e.name)
      .sort(),
    ["done", "request_review"],
  );

  // A machine NOT built by jr2Setup declares no workflow events.
  const bare = setup({}).createMachine({ id: "bare", initial: "a", states: { a: {} } });
  host.register({ name: "bare", machine: bare, provide: () => ({}) });
  assert.deepEqual(host.machine("bare")!.events, []);
});

test("the admission is ledgered host-side and persisted beside the snapshot (ADR-0016)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  await tick();

  const minted = clients.get(instanceId)!.minted;
  assert.ok(minted, "the run was admitted");
  const iid = await admittedIid(clients.get(instanceId)!);
  let agents: Record<string, unknown> | undefined;
  await waitFor(() => {
    void store.load(runId).then((l) => (agents = (l?.snapshot as { agents?: Record<string, unknown> })?.agents));
    return agents?.[iid] !== undefined;
  });
  assert.deepEqual(agents?.[iid], { ...minted, instanceId: iid }, "the durable handle rides RunBlob.agents");
});

test("a burned conversation rides the RunBlob, and a restored run still avoids it (ADR-0057)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(continuedDef(clients));
  const { runId, instanceId } = await host.start("continued");
  const conversation = continuedIidOf(runId);
  const flue = clients.get(instanceId)!;
  // Settle-followed, not just admitted: the fault below lands on the settlement.
  await waitFor(() => flue.settled.length === 1);
  assert.equal(flue.admits[0]!.instanceId, conversation, "turn one is the Machine instance's conversation");

  // An infra fault is terminal for a continuation — no reroll (ADR-0035) — so the conversation is
  // burned: its epoch goes to the ledger BESIDE the admissions, in the same blob.
  flue.fault("the harness that held it went away");
  let epochs: Record<string, number> | undefined;
  await waitFor(() => {
    void store.load(runId).then((l) => (epochs = (l?.snapshot as { epochs?: Record<string, number> })?.epochs));
    return epochs?.[conversation] === 1;
  });

  // A restart must not hand the next `continue` a dead conversation, so restore seeds the epoch
  // from the blob: the state after the fault route mints the VIRGIN id, not the burned one.
  await host.stop(runId);
  const clientsB = new Map<string, MockFlueClient>();
  const second = new RunHost({ store, reconcile: () => true });
  second.register(continuedDef(clientsB));
  assert.deepEqual((await second.restore()).reattached, [runId]);
  await tick();

  second.sendToAgent(conversation, { type: "request_review", summary: "PR up" });
  const flueB = clientsB.get(instanceId)!;
  await waitFor(() => flueB.admits.length === 1);
  assert.equal(flueB.admits[0]!.instanceId, `${conversation}/1`, "turn two lands on a virgin conversation");
});

test("a second host restores an in-flight run and re-attaches by persisted admission", async () => {
  const store = await mkStore();

  // Host A: start (the mock admits and parks), then "crash" (we just stop driving it).
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(clientsA));
  const { runId, instanceId } = await hostA.start("coding");
  await tick();
  const minted = clientsA.get(instanceId)!.minted!;
  const iid = await admittedIid(clientsA.get(instanceId)!);
  let persisted = false;
  await waitFor(() => {
    void store
      .load(runId)
      .then((l) => (persisted = !!(l?.snapshot as { agents?: Record<string, unknown> })?.agents?.[iid]));
    return persisted;
  });

  // Host B: a brand-new host on the SAME store; reconcile present → re-attach.
  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store, reconcile: () => true });
  hostB.register(codingDef(clientsB));
  const { reattached } = await hostB.restore();
  await tick();

  assert.deepEqual(reattached, [runId]);
  const reattachedClient = clientsB.get(instanceId);
  assert.ok(reattachedClient, "the restored run rebuilt its port");
  assert.equal(reattachedClient!.admitted, undefined, "re-attach must not re-POST the prompt");
  assert.deepEqual(
    reattachedClient!.settled,
    [{ ...minted, instanceId: iid }],
    "settlement follows the PERSISTED admission",
  );
});

test("restore marks a run lost when the live world is absent", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(new Map()));
  const { runId } = await hostA.start("coding");
  await tick();

  const hostB = new RunHost({ store, reconcile: () => false });
  hostB.register(codingDef(new Map()));
  const { reattached, lost } = await hostB.restore();

  assert.deepEqual(reattached, []);
  assert.deepEqual(lost, [runId]);
  assert.equal((await store.load(runId))!.status, "lost");
});

// ---- Machine drift (ADR-0030) -------------------------------------------------------------------
// A run is matched to a workflow by NAME. The state volume outlives the image, so the def found
// under that name may not be the Machine that wrote the snapshot — and reading it anyway is the
// silent failure this refuses.

/** Wait until a run's blob carries its Machine stamp. `waitFor` takes a SYNC predicate and the
 * store is async, so the read is fired into a captured flag — the pattern the ledger test uses. */
async function waitForStamp(store: SnapshotStore, runId: string): Promise<void> {
  let stamped = false;
  await waitFor(() => {
    void store.load(runId).then((l) => (stamped = (l?.snapshot as { machine?: string })?.machine !== undefined));
    return stamped;
  });
}

/** `codingDef` under its own name, but a different SHAPE — a redeploy that renamed a state. */
function reshapedCodingDef(): WorkflowDef {
  return {
    name: "coding",
    machine: setup({ types: {} as { context: Record<string, never> } }).createMachine({
      id: "m",
      context: {},
      initial: "elsewhere",
      states: { elsewhere: {} },
    }),
    provide: () => ({}),
  };
}

test("a run whose workflow changed shape is refused, not resumed (ADR-0030)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(new Map()));
  const { runId } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, runId);

  // Same workflow name, different Machine — exactly what a `jr2 up` after a workflow edit produces.
  const hostB = new RunHost({ store, reconcile: () => true });
  hostB.register(reshapedCodingDef());
  const { reattached, lost, drifted } = await hostB.restore();

  assert.deepEqual(drifted, [runId]);
  assert.deepEqual([reattached, lost], [[], []], "refused is its own outcome — not lost, not resumed");

  const stored = (await store.load(runId))!;
  assert.equal(stored.status, "drifted");
  assert.ok(stored.snapshot, "the snapshot is KEPT — unlike `lost`, this run is intact and inspectable");
  assert.match(stored.reason ?? "", /changed shape/);

  // …and therefore still readable, which is the whole reason it is not marked lost: `read` returns
  // undefined for a null blob, so a nulled snapshot would answer `jr2 status` with `no run`.
  const read = await hostB.read(runId);
  assert.equal(read?.status, "drifted");
  assert.match(read?.reason ?? "", /coding/, "the refusal names the workflow, and both fingerprints");
});

test("an unstamped snapshot is drift: never interpret one whose Machine cannot be vouched for", async () => {
  const store = await mkStore();
  const host = new RunHost({ store, reconcile: () => true });
  host.register(codingDef(new Map()));
  // A blob written before the stamp existed.
  await store.save("run-old", { workflow: "coding", instanceId: "iid-1", snapshot: {} }, "live");

  const { drifted } = await host.restore();
  assert.deepEqual(drifted, ["run-old"]);
  assert.match((await store.load("run-old"))!.reason ?? "", /unstamped/);
});

test("a run that throws on restore does not take the rest of the boot with it", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(codingDef(new Map()));
  const { runId: first } = await hostA.start("coding");
  const { runId: second } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, second);

  // `reconcile` talks to a cluster, so it is the realistic thrower — a kubectl blip mid-boot. The
  // loop is sequential, so before ADR-0030 this rejected `restore()`, which rejects `startInstance`,
  // which crash-loops the pod — and `second`, which is fine, never restored either.
  const errors: string[] = [];
  const hostB = new RunHost({
    store,
    reconcile: (run) => {
      if (run.runId === first) throw new Error("kubectl: connection refused");
      return true;
    },
    onRestoreError: (runId) => errors.push(runId),
  });
  hostB.register(codingDef(new Map()));
  const { reattached, drifted, failed } = await hostB.restore();

  assert.deepEqual(failed, [first]);
  assert.deepEqual(reattached, [second], "the healthy run behind it still restored");
  assert.deepEqual(drifted, [], "a throw is not a shape change — do not condemn a run for a blip");
  assert.deepEqual(errors, [first], "and it is reported, since the row itself records nothing");

  // Left `live` deliberately: the next boot tries again. Marking it would make a transient cluster
  // failure permanent, and marking it LOST would additionally throw the snapshot away.
  assert.equal((await store.load(first))!.status, "live");
});

// ---- Child machines (the Console's live half) ------------------------------------------------
// A run's root `value` is not where the run IS: `pipeline` (like `coding`) sits in `discover` while
// every feature it spawned works two levels down. `RunStatus.children` is that tree — and it rides
// the SAME feed frame the root's status does, because persistence is driven by the actor system's
// inspection stream, so a GRANDCHILD's transition already pushes one.

/** A pipeline run with both features spawned and both bodies invoked (the wrapper's 5ms provision). */
async function mkPipeline() {
  const host = new RunHost({ store: await mkStore() });
  host.register(pipelineDef());
  const { runId } = await host.start("pipeline");
  await waitFor(() => (host.status(runId)?.children[1]?.children.length ?? 0) > 0);
  return { host, runId };
}

test("status().children: the live child machines, their values, and their children's", async () => {
  const { host, runId } = await mkPipeline();
  const status = host.status(runId)!;

  assert.equal(status.value, "discover", "the root has not moved — and says nothing about F-1 or F-2");
  assert.deepEqual(
    status.children.map((c) => ({ id: c.id, src: c.src, value: c.value })),
    [
      { id: "F-1", src: "feature", value: "running" },
      { id: "F-2", src: "feature", value: "running" },
    ],
    "one entry per live instance — this is what makes F-1 and F-2 two boxes, not one",
  );

  // The grandchild: each wrapper invokes its body as an INLINE machine, so its `src` is xstate's
  // generated key — the same string `serializeMachine` records. That string IS the join.
  assert.deepEqual(status.children[0]!.children, [
    { id: "body", src: "xstate.invoke.0.ws.running", status: "active", value: "coding", children: [] },
  ]);
});

test("a GRANDCHILD transition pushes a feed frame carrying its new value", async () => {
  const { host, runId } = await mkPipeline();

  const frames: RunStatus[] = [];
  const off = host.subscribe(runId, (e) => {
    if (e.kind === "status") frames.push(e.status);
  });
  frames.length = 0; // drop the replay-on-attach frame

  // Through the real seam: F-1's gate is registered by the BODY, two levels down (ADR-0011).
  host.sendToGate(runId, "F-1", { type: "approve" });
  await waitFor(() => frames.some((f) => f.children[0]?.children[0]?.value === "shipped"));
  off();

  const last = frames.at(-1)!;
  assert.equal(last.value, "discover", "the root never moved; only the depth did");
  assert.equal(last.children[0]?.children[0]?.status, "done", "F-1's body reached its final state");
  assert.equal(last.children[1]?.children[0]?.value, "coding", "and F-2 is untouched — instances are independent");
});

// ---- Abbreviated run ids (ADR-0009) -------------------------------------------------------------
// `candidates` is the resolution primitive the CLI's prefix matching sits on. Two properties carry
// the weight: it unions the live registry with the store (neither alone is complete), and its
// answer is the set of ids that EXIST — including `lost` ones — because anything narrower resolves
// an ambiguous prefix silently to the wrong run.

test("candidates matches on prefix, sorted, and respects its limit", async () => {
  const store = await mkStore();
  await store.save("aaaa1111-0000-0000-0000-000000000000", {});
  await store.save("aaaa2222-0000-0000-0000-000000000000", {});
  await store.save("bbbb3333-0000-0000-0000-000000000000", {});
  const host = new RunHost({ store });

  assert.deepEqual(await host.candidates("bbbb", 10), ["bbbb3333-0000-0000-0000-000000000000"]);
  assert.deepEqual(
    await host.candidates("aaaa", 10),
    ["aaaa1111-0000-0000-0000-000000000000", "aaaa2222-0000-0000-0000-000000000000"],
    "an ambiguous prefix answers with every match, sorted",
  );
  assert.deepEqual(await host.candidates("zzzz", 10), [], "no match is not an error");
  assert.equal((await host.candidates("aaaa", 1)).length, 1, "the limit caps the scan");
});

test("a prefix ending on a boundary character still scans (no last-char arithmetic)", async () => {
  const store = await mkStore();
  await store.save("ffff0000-0000-0000-0000-000000000000", {});
  const host = new RunHost({ store });

  // 'f' is the top of the hex alphabet — the case an increment-the-last-character upper bound trips on.
  assert.deepEqual(await host.candidates("ffff", 10), ["ffff0000-0000-0000-0000-000000000000"]);
});

test("a LOST run stays in the candidate set — ambiguity is about ids that exist, not ones that read", async () => {
  const store = await mkStore();
  await store.save("cccc1111-0000-0000-0000-000000000000", {});
  await store.markLost("cccc2222-0000-0000-0000-000000000000", "its flue handle is gone");
  const host = new RunHost({ store });

  assert.deepEqual(
    await host.candidates("cccc", 10),
    ["cccc1111-0000-0000-0000-000000000000", "cccc2222-0000-0000-0000-000000000000"],
    "dropping the lost one would resolve this prefix silently to the readable run",
  );
});

test("the live registry is consulted independently of the store", async () => {
  // The store half is stubbed empty: `persist()` is microtask-scheduled, so a just-started run is in
  // `runs` before it is anywhere in the store. Anyone who 'simplifies' the union away fails here.
  const store = await mkStore();
  const storeBlind: SnapshotStore = Object.assign(Object.create(store) as SnapshotStore, {
    findIdsByPrefix: async () => [],
  });
  const host = new RunHost({ store: storeBlind, newId: () => "dddd4444-0000-0000-0000-000000000000" });
  host.register(codingDef(new Map()));
  const { runId } = await host.start("coding");

  assert.deepEqual(await host.candidates("dddd", 10), [runId]);
});

test("a run in BOTH halves is reported once", async () => {
  const store = await mkStore();
  const host = new RunHost({ store, newId: () => "eeee5555-0000-0000-0000-000000000000" });
  host.register(codingDef(new Map()));
  const { runId } = await host.start("coding");
  await tick(); // let persist() land it in the store too

  assert.deepEqual(await host.candidates("eeee", 10), [runId], "the union dedupes");
});

// ---- Notices (ADR-0062) -------------------------------------------------------------------------
// The Orchestrator is their only keeper: pending notices ride the RunBlob beside the ledgers, go to
// the next admission in their scope, and count as delivered when that admission is ledgered.

const retryTemplate = jr2Setup({
  types: {} as { context: Record<string, never>; input: Record<string, never> },
  events: [doneEvent, requestReviewEvent],
  actors: { coder: agent(coderDefinition) },
}).createMachine({
  id: "r",
  context: {},
  initial: "first",
  states: {
    first: {
      invoke: { src: "coder", input: { continue: true, endpoint: "http://harness.invalid", prompt: "turn one" } },
      on: { "agent.fault": "retry" },
    },
    retry: {
      invoke: { src: "coder", input: { continue: true, endpoint: "http://harness.invalid", prompt: "the whole task" } },
      on: { request_review: "again" },
    },
    again: {
      invoke: { src: "coder", input: { continue: true, endpoint: "http://harness.invalid", prompt: "continue" } },
      on: { done: "#r.done" },
    },
    done: { type: "final" },
  },
});

function retryDef(clients: Map<string, MockFlueClient>, hold = false): WorkflowDef {
  return {
    name: "retry",
    machine: retryTemplate,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      client.holdAdmits = hold;
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition) } };
    },
  };
}

async function blobOf(store: SnapshotStore, runId: string): Promise<Record<string, unknown>> {
  return ((await store.load(runId))?.snapshot ?? {}) as Record<string, unknown>;
}

test("a burned conversation's next Turn is told it is new — once, and again only if a restart came first", async () => {
  const store = await mkStore();
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(retryDef(clientsA, true));
  const { runId, instanceId } = await hostA.start("retry");
  const conversation = continuedIidOf(runId);
  const flueA = clientsA.get(instanceId)!;
  await waitFor(() => flueA.admits.length === 1);
  flueA.releaseAdmits();
  await tick();
  assert.deepEqual(flueA.notices[0], [], "a first conversation is not news");

  // The fault burns the conversation; the fault route's `continue` lands on a virgin one, and is
  // told so — with the fault's own words, because that is why the context is gone.
  flueA.fault("the harness that held it went away");
  await waitFor(() => flueA.admits.length === 2);
  const notice = { kind: "conversation-new", scope: "conversation", reason: "the harness that held it went away" };
  assert.equal(flueA.admits[1]!.instanceId, `${conversation}/1`);
  assert.deepEqual(flueA.notices[1], [notice]);

  // The admission is still unanswered — nothing is ledgered — when the Orchestrator goes away.
  let pending: unknown[] = [];
  await waitFor(() => {
    void blobOf(store, runId).then((b) => (pending = (b.notices as { pending?: unknown[] })?.pending ?? []));
    return pending.length === 1;
  });
  await hostA.stop(runId);

  // Restart BEFORE the ledger write: the restored Turn is admitted again, and carries it again.
  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store });
  hostB.register(retryDef(clientsB));
  assert.deepEqual((await hostB.restore()).reattached, [runId]);
  const flueB = clientsB.get(instanceId)!;
  await waitFor(() => flueB.admits.length === 1);
  assert.deepEqual(flueB.notices[0], [notice], "not yet delivered, so delivered again");

  // The admission is ledgered now, and the notice with it: a restart AFTER does not repeat it.
  await waitFor(() => {
    void blobOf(store, runId).then((b) => (pending = (b.notices as { pending?: unknown[] })?.pending ?? []));
    return pending.length === 0;
  });
  await hostB.stop(runId);
  const clientsC = new Map<string, MockFlueClient>();
  const hostC = new RunHost({ store });
  hostC.register(retryDef(clientsC));
  assert.deepEqual((await hostC.restore()).reattached, [runId]);
  await tick();
  const flueC = clientsC.get(instanceId)!;
  assert.equal(flueC.admits.length, 0, "re-attached, not re-admitted");
  hostC.sendToAgent(`${conversation}/1`, { type: "request_review", summary: "PR up" });
  await waitFor(() => flueC.admits.length === 1);
  assert.deepEqual(flueC.notices[0], [], "delivered once");
  assert.deepEqual(flueC.heldAsked, [`${conversation}/1`], "a continued conversation asks whether it is still held");
});

test("a continued conversation the Harness no longer holds is told it is new", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(continuedDef(clients));
  const { runId, instanceId } = await host.start("continued");
  const flue = clients.get(instanceId)!;
  await waitFor(() => flue.admits.length === 1);
  assert.deepEqual(flue.heldAsked, [], "a conversation never admitted has nothing to lose");

  // Between the Turns the Harness restarted: the conversation is gone, and no fault said so.
  flue.held = false;
  host.sendToAgent(continuedIidOf(runId), { type: "request_review", summary: "PR up" });
  await waitFor(() => flue.admits.length === 2);
  assert.deepEqual(flue.notices[1], [
    { kind: "conversation-new", scope: "conversation", reason: "the Harness no longer holds it" },
  ]);
});

test("a guard kill is told to the next Turn in that Workspace, and only once (ADR-0061, ADR-0062)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(workspaceDef(clients));
  const { instanceId } = await host.start("workspace", { sandbox: "ws-1" });
  const flue = clients.get(instanceId)!;
  await waitFor(() => flue.settled.length === 1);
  const coder = flue.admits[0]!.instanceId;

  // The Harness's guard killed the Agent's processes during this Turn and said so on its stream.
  flue.guardKill({ peak: "1.8Gi", limit: "1920Mi", source: "c@7.0" });
  flue.guardKill({ peak: "1.8Gi", limit: "1920Mi", source: "c@7.0" }); // a replayed read
  // The Turn ends with no pick. Its nudge is a re-prompt WITHIN the Turn (ADR-0016), not the next
  // Turn: the Agent read about the kill in its `bash` answer, so the nudge carries nothing.
  flue.complete();
  await waitFor(() => flue.settled.length === 2);
  assert.deepEqual(flue.notices[1], [], "the killed Turn's own nudge does not use up the notice");

  // The next Turn in the Workspace — the tester after the coder — is the reader the notice is for.
  host.sendToAgent(coder, { type: "request_review", summary: "PR up" });
  await waitFor(() => flue.admits.length === 3);
  assert.equal(flue.admits[2]!.prompt, "check it");
  assert.deepEqual(flue.notices[2], [
    { kind: "memory-limit", scope: "workspace", agent: "coder", peak: "1.8Gi", limit: "1920Mi" },
  ]);
});
