// End-to-end Machine-host tests: prove the three slice-1 modules cohere under RunHost.
//
// The Agent's up-channel is driven the REAL way — `sendToAgent`, the same registration-table path
// `POST /agents/:iid/events` takes when a Sandbox's Harness delivers a pick (ADR-0013) — so
// resolve → validate → deliver-into-the-invoking-state is exercised, not bypassed. The flue side is
// a mock FlueClient: it records admissions and settles (so the ledger and restore can be checked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, fromPromise, setup } from "xstate";
import { z } from "zod";
import { doneEvent, requestReviewEvent } from "@jr2/agent-protocol";
import { agentActorWith, type AgentAdmission } from "../src/actor.ts";
import { agent } from "../src/harness-client.ts";
import { jr2Setup } from "../src/setup.ts";
import { chartSchema, ChartRefusal, type ChartText } from "../src/chart.ts";
import { openBody } from "../src/open-body.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { observe, RunHost, type RunStatus, type WorkflowDef } from "../src/run-host.ts";
import { boundRun, EventValidationError, type DispatchedBy } from "../src/registration.ts";
import {
  approveDef,
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
  // Every delivery is addressable after the fact — an outstanding pick is polled by it (ADR-0013).
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
  // Stamped with the Turn that ledgered it: the key alone does not name a Turn.
  const turnId = clients.get(instanceId)!.admitted!.turnId;
  assert.equal(typeof turnId, "string", "the mapper mints a Turn ID");
  assert.deepEqual(
    agents?.[iid],
    { ...minted, task: "do work", instanceId: iid, agent: "coder", endpoint: "http://harness.invalid", turnId },
    "the durable handle rides RunBlob.agents",
  );
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
    [
      {
        ...minted,
        task: "do work",
        instanceId: iid,
        agent: "coder",
        endpoint: "http://harness.invalid",
        turnId: clientsA.get(instanceId)!.admitted!.turnId,
      },
    ],
    "settlement follows the PERSISTED admission",
  );
});

test("a continued Turn whose state was saved before its admission was ledgered is admitted on restore, not re-attached to the Turn before it (ADR-0016)", async () => {
  const store = await mkStore();
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(continuedDef(clientsA));
  const { runId, instanceId } = await hostA.start("continued");
  const iid = continuedIidOf(runId);
  const flueA = clientsA.get(instanceId)!;
  await waitFor(() => flueA.admits.length === 1);
  const turnOne = flueA.admits[0]!.turnId;
  let blob: Record<string, unknown> = {};
  const ledgered = () => (blob.agents as Record<string, AgentAdmission> | undefined)?.[iid];
  await waitFor(() => {
    void blobOf(store, runId).then((b) => (blob = b));
    return ledgered() !== undefined;
  });

  // Turn two is invoked and its state saved; its admit is sent and never answered, so the ledger
  // still holds Turn one's admission under the key the two Turns share. Then the Orchestrator goes.
  flueA.holdAdmits = true;
  hostA.sendToAgent(iid, { type: "request_review", summary: "PR up" });
  await waitFor(() => flueA.admits.length === 2);
  const turnTwo = flueA.admits[1]!.turnId;
  assert.notEqual(turnTwo, turnOne, "each invocation mints its own Turn ID");
  await waitFor(() => {
    void blobOf(store, runId).then((b) => (blob = b));
    return (blob.snapshot as { value?: unknown } | undefined)?.value === "second";
  });
  assert.equal(ledgered()?.turnId, turnOne, "the ledger still holds Turn one's admission");
  await hostA.stop(runId);

  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store });
  hostB.register(continuedDef(clientsB));
  assert.deepEqual((await hostB.restore()).reattached, [runId]);
  const flueB = clientsB.get(instanceId)!;
  await waitFor(() => flueB.admits.length === 1);
  assert.equal(flueB.admits[0]!.prompt, "turn two", "Turn two is admitted with its own prompt");
  assert.equal(flueB.admits[0]!.turnId, turnTwo);
  await waitFor(() => flueB.settled.length === 1);
  assert.equal(flueB.settled[0]!.submissionId, flueB.minted!.submissionId, "it follows its own Submission");
  await waitFor(() => {
    void blobOf(store, runId).then((b) => (blob = b));
    return ledgered()?.turnId === turnTwo;
  });
  assert.deepEqual(flueB.kept, [true], "the conversation was admitted before, so the admission says kept");
  await hostB.stop(runId);
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

// ---- The Assembly a run started under (ADR-0069) ----------------------------------------------

test("every save stamps the Assembly the run started under, and a publish does not restamp it", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { runId } = await host.start("coding");
  await tick();
  await waitForStamp(store, runId);
  assert.equal(((await store.load(runId))!.snapshot as { assembly?: string }).assembly, "aaaaaaaaaaaa");
  assert.deepEqual([...host.assemblyHolds()], [["aaaaaaaaaaaa", [runId]]]);
  assert.equal(host.status(runId)?.assembly, "aaaaaaaaaaaa");

  // A publish re-registers the name from another Assembly; the live run keeps its own.
  host.register({ ...codingDef(new Map()), assembly: "bbbbbbbbbbbb" });
  await host.cancel(runId);
  assert.equal(((await store.load(runId))!.snapshot as { assembly?: string }).assembly, "aaaaaaaaaaaa");
});

test("a blob that names no Assembly is drift: saved under no Assembly (ADR-0069)", async () => {
  const store = await mkStore();
  // Written by a host whose defs came from no Assembly: stamped with a Machine, not an Assembly.
  const hostA = new RunHost({ store });
  hostA.register(codingDef(new Map()));
  const { runId } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, runId);

  const hostB = new RunHost({ store, reconcile: () => true });
  hostB.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { drifted, reattached } = await hostB.restore();
  assert.deepEqual(drifted, [runId]);
  assert.deepEqual(reattached, []);
  assert.match((await store.load(runId))!.reason ?? "", /saved under no Assembly/);
});

test("a stamped blob restores inside the Assembly it names, through the resolver, and is not registered (ADR-0069)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { runId } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, runId);

  // The current Assembly registers another shape under the name; the run's own Assembly resolves
  // the Machine that wrote it.
  const asked: Array<{ workflow: string; assembly: string }> = [];
  const hostB = new RunHost({
    store,
    reconcile: () => true,
    resolveDef: async (ref) => {
      asked.push(ref);
      return { ...codingDef(new Map()), assembly: ref.assembly };
    },
  });
  hostB.register({ ...reshapedCodingDef(), assembly: "bbbbbbbbbbbb" });
  const { reattached, drifted } = await hostB.restore();
  assert.deepEqual([reattached, drifted], [[runId], []]);
  assert.deepEqual(asked, [{ workflow: "coding", assembly: "aaaaaaaaaaaa" }]);
  assert.equal(hostB.status(runId)?.assembly, "aaaaaaaaaaaa");
  assert.deepEqual([...hostB.assemblyHolds()], [["aaaaaaaaaaaa", [runId]]]);
  assert.notEqual(hostB.status(runId)?.value, "elsewhere", "the run reads under the Machine that wrote it");
  // The registry stays the current Assembly's: the held Machine was lent to the run alone.
  const fresh = await hostB.start("coding");
  assert.equal(hostB.status(fresh.runId)?.value, "elsewhere");
  assert.equal(hostB.status(fresh.runId)?.assembly, "bbbbbbbbbbbb");
  await hostB.cancel(fresh.runId);
  await hostB.cancel(runId);
  assert.equal(((await store.load(runId))!.snapshot as { assembly?: string }).assembly, "aaaaaaaaaaaa");
  await hostB.close();
});

test("the resolver's drift keeps the snapshot; its throw leaves the row live (ADR-0030, ADR-0069)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { runId: one } = await hostA.start("coding");
  const { runId: two } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, two);

  // The first row's Assembly is gone from the volume; reading the second's faults.
  const errors: string[] = [];
  let asked = 0;
  const hostB = new RunHost({
    store,
    reconcile: () => true,
    onRestoreError: (runId) => errors.push(runId),
    resolveDef: async () => {
      if (asked++ === 0) return { drifted: "Assembly aaaaaaaaaaaa is not on the volume" };
      throw new Error("EIO");
    },
  });
  const { drifted, failed, lost } = await hostB.restore();
  assert.deepEqual([drifted, failed, lost], [[one], [two], []]);
  const row = (await store.load(one))!;
  assert.equal(row.status, "drifted");
  assert.match(row.reason ?? "", /aaaaaaaaaaaa is not on the volume/);
  assert.ok(row.snapshot, "drift keeps the snapshot");
  assert.equal((await store.load(two))!.status, "live", "a fault is retried at the next boot");
  assert.deepEqual(errors, [two]);
});

test("without a resolver, a stamped blob resolves only to a registered def of the same hash", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { runId } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, runId);

  const same = new RunHost({ store, reconcile: () => true });
  same.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  assert.deepEqual((await same.restore()).reattached, [runId], "one hash names one Machine");
  await same.close();

  const other = new RunHost({ store, reconcile: () => true });
  other.register({ ...codingDef(new Map()), assembly: "bbbbbbbbbbbb" });
  assert.deepEqual((await other.restore()).drifted, [runId], "another hash is another Assembly");
  assert.match((await store.load(runId))!.reason ?? "", /saved under Assembly aaaaaaaaaaaa/);
});

test("a stamped blob whose Workflow the current Assembly lacks is drift, and keeps its snapshot (ADR-0069)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register({ ...codingDef(new Map()), assembly: "aaaaaaaaaaaa" });
  const { runId } = await hostA.start("coding");
  await tick();
  await waitForStamp(store, runId);

  // The current Assembly holds no "coding": a lost verdict would null the snapshot.
  const hostB = new RunHost({ store, reconcile: () => true });
  const { drifted, lost } = await hostB.restore();
  assert.deepEqual([drifted, lost], [[runId], []]);
  const row = (await store.load(runId))!;
  assert.match(row.reason ?? "", /saved under Assembly aaaaaaaaaaaa/);
  assert.equal((row.snapshot as { assembly?: string } | null)?.assembly, "aaaaaaaaaaaa", "snapshot kept");
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

test("a continued conversation that `holds` took as held, but that the Harness refuses to admit as kept, is told it is new (ADR-0062)", async () => {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store: await mkStore() });
  host.register(continuedDef(clients));
  const { runId, instanceId } = await host.start("continued");
  const flue = clients.get(instanceId)!;
  await waitFor(() => flue.admits.length === 1);
  assert.deepEqual(flue.kept, [false], "a conversation never admitted is not for a kept one");

  // The Harness restarted between the Turns, and `holds` timed out: "held". The Harness keeps none.
  flue.keeps = false;
  host.sendToAgent(continuedIidOf(runId), { type: "request_review", summary: "PR up" });
  await waitFor(() => flue.admits.length === 2);
  assert.equal(flue.refused.length, 1, "the kept admission was refused");
  assert.deepEqual(flue.kept, [false, false]);
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
  flue.guardKill({ id: "k-7", peak: "1.8Gi", limit: "1920Mi" });
  flue.guardKill({ id: "k-7", peak: "1.8Gi", limit: "1920Mi" }); // a replayed read
  // The Harness lists it as told to this conversation: the coder's own `bash` call answered it.
  flue.podKills = [
    {
      id: "k-7",
      at: new Date().toISOString(),
      peak: "1.8Gi",
      limit: "1920Mi",
      told: [{ agent: "coder", instanceId: coder }],
    },
  ];
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

test("a read of the pod's kills that only marks older kills raised is saved at once (ADR-0007, ADR-0062)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(workspaceDef(clients));
  const { runId, instanceId } = await host.start("workspace", { sandbox: "ws-1" });
  const flue = clients.get(instanceId)!;
  await waitFor(() => flue.settled.length === 1);
  const seenOf = async () => ((await blobOf(store, runId)).notices as { seen?: string[] } | undefined)?.seen ?? [];
  const kill = (id: string) => ({ id, at: new Date().toISOString(), peak: "1.8Gi", limit: "1920Mi", told: [] });

  // The newest kill is raised already; this read brings an older one beside it. Nothing new is
  // pending, and the admission it rides is held, so only the raise's own save can keep the mark.
  flue.guardKill({ id: "k-2", peak: "1.8Gi", limit: "1920Mi" });
  // Answered after the transition's own save, so that save cannot carry the mark.
  const listed = [kill("k-1"), kill("k-2")];
  flue.memoryKills = () => new Promise((resolve) => setTimeout(() => resolve(listed), 30));
  flue.holdAdmits = true;
  host.sendToAgent(flue.admits[0]!.instanceId, { type: "request_review", summary: "PR up" });
  await waitFor(() => flue.admits.length === 2);
  let seen: string[] = [];
  await waitFor(() => {
    void seenOf().then((s) => (seen = s));
    return seen.includes("ws-1@guard:k-1");
  });
  assert.deepEqual([...seen].sort(), ["ws-1@guard:k-1", "ws-1@guard:k-2"]);
  flue.releaseAdmits();
});

test("two reads of the same list save once: a raise that changes nothing is not saved (ADR-0007, ADR-0062)", async () => {
  const store = await mkStore();
  let saves = 0;
  const save = store.save.bind(store);
  store.save = (...args) => (saves++, save(...args));
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(workspaceDef(clients));
  const { instanceId } = await host.start("workspace", { sandbox: "ws-1" });
  const flue = clients.get(instanceId)!;
  await waitFor(() => flue.settled.length === 1);
  await tick();
  // Each nudge reads the list and is held, so no ledger write follows its read in the window.
  const kill = { id: "k-1", at: new Date().toISOString(), peak: "1.8Gi", limit: "1920Mi", told: [] };
  flue.podKills = [kill];
  const windowOf = async (admits: number): Promise<number> => {
    const before = saves;
    flue.holdAdmits = true;
    flue.complete();
    await waitFor(() => flue.admits.length === admits);
    await tick();
    const counted = saves - before;
    flue.holdAdmits = false;
    flue.releaseAdmits();
    await waitFor(() => flue.settled.length === admits);
    await tick();
    return counted;
  };
  assert.equal(await windowOf(2), 1, "the first read raises the kill: one save");
  assert.equal(await windowOf(3), 0, "the same list again changes nothing: no save");
});

/** THREE fresh Turns in one Workspace — `code`, `check`, `recheck` — so a restart can fall between
 * the second and the third. */
const threeTurnsTemplate = jr2Setup({
  types: {} as { context: Ctx; input: { sandbox?: string } },
  events: [doneEvent, requestReviewEvent],
  actors: { coder: agent(coderDefinition) },
}).createMachine({
  id: "w3",
  context: ({ input }) => ({ sandbox: input.sandbox }),
  initial: "code",
  states: {
    code: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ endpoint: "http://harness.invalid", sandbox: context.sandbox, prompt: "write it" }),
      },
      on: { request_review: "check" },
    },
    check: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ endpoint: "http://harness.invalid", sandbox: context.sandbox, prompt: "check it" }),
      },
      on: { request_review: "recheck" },
    },
    recheck: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ endpoint: "http://harness.invalid", sandbox: context.sandbox, prompt: "again" }),
      },
      on: { done: "#w3.done" },
    },
    done: { type: "final" },
  },
});

/** The three-Turn Workspace workflow; `podKills` is what each new client's Harness lists. */
function threeTurnsDef(clients: Map<string, MockFlueClient>, podKills: () => MockFlueClient["podKills"]): WorkflowDef {
  return {
    name: "three",
    machine: threeTurnsTemplate,
    provide: ({ instanceId }) => {
      const client = new MockFlueClient();
      client.podKills = podKills();
      clients.set(instanceId, client);
      return { actors: { coder: agentActorWith(() => client, coderDefinition) } };
    },
  };
}

test("a guard kill while no Submission ran is told to the next Turn in that Workspace — once, across Orchestrator restarts (ADR-0061, ADR-0062)", async () => {
  const store = await mkStore();
  // What the pod's Harness keeps for `GET /memory-kills`: a read removes nothing, so every client
  // of this pod — each restored one too — reads the same kill once it is there.
  const kill = { id: "k-1", at: "2026-10-22T10:00:00.000Z", peak: "1.8Gi", limit: "1920Mi", told: [] };
  const idle = { kind: "memory-limit", scope: "workspace", peak: "1.8Gi", limit: "1920Mi" };
  const noticesOf = async (runId: string) =>
    ((await blobOf(store, runId)).notices ?? {}) as { pending?: unknown[]; seen?: unknown[] };
  const clientsA = new Map<string, MockFlueClient>();
  const hostA = new RunHost({ store });
  hostA.register(threeTurnsDef(clientsA, () => []));
  const { runId, instanceId } = await hostA.start("three", { sandbox: "ws-1" });
  const flueA = clientsA.get(instanceId)!;
  await waitFor(() => flueA.settled.length === 1);
  assert.deepEqual(flueA.notices[0], []);
  const coder = flueA.admits[0]!.instanceId;

  // The coder's Turn ended; while no Submission ran, a process it left passed the limit. The next
  // Turn's admission is held, so nothing is ledgered when the Orchestrator goes away.
  flueA.podKills = [kill];
  flueA.holdAdmits = true;
  hostA.sendToAgent(coder, { type: "request_review", summary: "PR up" });
  await waitFor(() => flueA.admits.length === 2);
  assert.deepEqual(flueA.notices[1], [idle], "the next Turn in the Workspace carries it");
  let pending: unknown[] = [];
  await waitFor(() => {
    void noticesOf(runId).then((n) => (pending = n.pending ?? []));
    return pending.length === 1;
  });
  await hostA.stop(runId);

  // Restart BEFORE the ledger write: the restored Turn reads the same kill again and carries the one
  // notice still pending — the kill's id is in the persisted `seen`, so the read raises no second.
  const clientsB = new Map<string, MockFlueClient>();
  const hostB = new RunHost({ store });
  hostB.register(threeTurnsDef(clientsB, () => [kill]));
  assert.deepEqual((await hostB.restore()).reattached, [runId]);
  const flueB = clientsB.get(instanceId)!;
  await waitFor(() => flueB.admits.length === 1);
  assert.equal(flueB.admits[0]!.prompt, "check it");
  assert.deepEqual(flueB.notices[0], [idle], "not yet delivered, so delivered again — and once");
  let seen: unknown[] = [];
  await waitFor(() => {
    void noticesOf(runId).then((n) => ((pending = n.pending ?? []), (seen = n.seen ?? [])));
    return pending.length === 0;
  });
  assert.deepEqual(seen, ["ws-1@guard:k-1"]);
  await hostB.stop(runId);

  // Restart AFTER the ledger write: nothing is pending. The third Turn reads the same list, and
  // only the persisted `seen` keeps it from raising the kill again.
  const clientsC = new Map<string, MockFlueClient>();
  const hostC = new RunHost({ store });
  hostC.register(threeTurnsDef(clientsC, () => [kill]));
  assert.deepEqual((await hostC.restore()).reattached, [runId]);
  await tick();
  const flueC = clientsC.get(instanceId)!;
  assert.equal(flueC.admits.length, 0, "re-attached, not re-admitted");
  hostC.sendToAgent(flueB.admits[0]!.instanceId, { type: "request_review", summary: "again" });
  await waitFor(() => flueC.admits.length === 1);
  assert.equal(flueC.admits[0]!.prompt, "again");
  assert.ok(flueC.podKillsAsked >= 1, "it read the list");
  assert.deepEqual(flueC.notices[0], [], "delivered once");
});

/** A fake Instance Harness's `PUT /agents` (ADR-0031): every live set stated to it, in order. */
function liveSetRecorder(opts: { fail?: boolean } = {}) {
  const stated: Array<{ endpoint: string; bearer: string | undefined; live: unknown[] }> = [];
  const liveSet = (endpoint: string, bearer: string | undefined) => async (live: unknown[]) => {
    stated.push({ endpoint, bearer, live });
    if (opts.fail) throw new Error("connect ECONNREFUSED");
    return { freed: 0 };
  };
  return { stated, liveSet };
}

/** A run of `coding` admitted and ledgered on `store`, then left for another host to restore. */
async function ledgeredRun(store: SnapshotStore): Promise<{ runId: string; iid: string }> {
  const clients = new Map<string, MockFlueClient>();
  const host = new RunHost({ store });
  host.register(codingDef(clients));
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);
  let ledgered = false;
  await waitFor(() => {
    void store.load(runId).then((l) => {
      ledgered = (l?.snapshot as { agents?: Record<string, unknown> })?.agents?.[iid] !== undefined;
    });
    return ledgered;
  });
  await host.stop(runId);
  return { runId, iid };
}

test("after restore, the live set names the conversations live runs hold on the Instance Harness — and no other Harness's (ADR-0031)", async () => {
  const store = await mkStore();
  const { runId, iid } = await ledgeredRun(store);

  // The coding fixture admits at `http://harness.invalid`: as the Instance Harness, its
  // conversation is stated, under the bearer of the placement (ADR-0058).
  const onIt = liveSetRecorder();
  const host = new RunHost({
    store,
    instanceHarness: "http://harness.invalid",
    harnessBearer: (placement) => `bearer-for-${placement}`,
    liveSet: onIt.liveSet,
  });
  host.register(codingDef(new Map()));
  assert.deepEqual((await host.restore()).reattached, [runId]);
  assert.deepEqual(onIt.stated, [
    {
      endpoint: "http://harness.invalid",
      bearer: "bearer-for-jr2-instance-harness",
      live: [{ agent: "coder", instanceId: iid }],
    },
  ]);
  await host.stop(runId);
  await host.close();

  // The same ledger on a host whose Instance Harness is elsewhere: that conversation lives on
  // another Harness, so the statement names nothing — and the Instance Harness frees what it holds.
  const elsewhere = liveSetRecorder();
  const other = new RunHost({
    store,
    instanceHarness: "http://jr2-instance-harness.ns.svc:8080",
    liveSet: elsewhere.liveSet,
  });
  other.register(codingDef(new Map()));
  assert.deepEqual((await other.restore()).reattached, [runId]);
  assert.deepEqual(
    elsewhere.stated.map((s) => s.live),
    [[]],
  );
  await other.close();
});

test("a run restore left live to retry still holds its conversations: the live set names them (ADR-0030, ADR-0031)", async () => {
  const store = await mkStore();
  const { runId, iid } = await ledgeredRun(store);

  // A kubectl blip at boot: this run is not hosted, but its row stays `live` for the next boot —
  // which must find its conversation still on the Instance Harness.
  const { stated, liveSet } = liveSetRecorder();
  const host = new RunHost({
    store,
    instanceHarness: "http://harness.invalid",
    liveSet,
    reconcile: () => {
      throw new Error("kubectl: connection refused");
    },
    onRestoreError: () => {},
  });
  host.register(codingDef(new Map()));
  assert.deepEqual((await host.restore()).failed, [runId]);
  assert.deepEqual(
    stated.map((s) => s.live),
    [[{ agent: "coder", instanceId: iid }]],
  );
  await host.close();
});

test("a run started after boot is named in the next statement, and a run that ends drops out (ADR-0031)", async () => {
  const store = await mkStore();
  const clients = new Map<string, MockFlueClient>();
  const { stated, liveSet } = liveSetRecorder();
  const host = new RunHost({ store, instanceHarness: "http://harness.invalid", liveSet, liveSetIntervalMs: 5 });
  host.register(codingDef(clients));
  await host.restore();
  const { runId, instanceId } = await host.start("coding");
  const iid = await admittedIid(clients.get(instanceId)!);
  const named = (s: { live: unknown[] }) => s.live.some((c) => (c as { instanceId: string }).instanceId === iid);
  await waitFor(() => stated.some(named));

  await host.stop(runId);
  const ended = stated.length;
  await waitFor(() => stated.length > ended + 1);
  assert.ok(!named(stated.at(-1)!), "the Harness frees a conversation no live run holds");
  await host.close();
});

test("the live set is stated again on the Lease's cadence, and not after close (ADR-0031)", async () => {
  const store = await mkStore();
  const { stated, liveSet } = liveSetRecorder();
  const host = new RunHost({ store, instanceHarness: "http://harness.invalid", liveSet, liveSetIntervalMs: 10 });
  await host.restore();
  await waitFor(() => stated.length >= 3);
  await host.close();
  const after = stated.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(stated.length, after, "close() clears the timer");
});

test("a host that knows no Instance Harness states nothing (ADR-0031)", async () => {
  const store = await mkStore();
  const { stated, liveSet } = liveSetRecorder();
  const host = new RunHost({ store, liveSet, liveSetIntervalMs: 5 });
  await host.restore();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(stated, []);
  await host.close();
});

test("a failing live-set statement logs once per failing streak and touches no run (ADR-0031)", async (t) => {
  const store = await mkStore();
  const { stated, liveSet } = liveSetRecorder({ fail: true });
  const errors = t.mock.method(console, "error", () => {});
  const host = new RunHost({ store, instanceHarness: "http://harness.invalid", liveSet, liveSetIntervalMs: 5 });
  await host.restore();
  await waitFor(() => stated.length >= 3);
  await host.close();
  const lines = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /live-set statement to http:\/\/harness\.invalid failed.*ECONNREFUSED/);
});

// --- Chart wrappers and named Charts (ADR-0070) ----------------------------------------------------

/** A Chart wrapper: its door takes a Chart and an endpoint; its Open body lends `coder`. */
function chartWrapper() {
  const def: AgentDefinition = { model: "stub/model", instructions: "code" };
  const coder = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as {
      context: { chart: unknown; endpoint: string; result?: unknown };
      input: { chart: unknown; endpoint: string };
    },
    events: [],
    actors: {
      coder: agent(def),
      body: openBody({
        lends: { agents: ["coder"] },
        allows: { models: ["stub/model"], workspace: ["none"] },
        ceilings: { turns: 4, wallClock: "1h", transitions: 100, fanOut: 2, size: 65536 },
      }),
    },
  }).createMachine({
    id: "charted",
    input: z.object({ endpoint: z.string(), chart: chartSchema }),
    context: ({ input }) => ({ ...input }),
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          input: ({ context }: { context: { chart: unknown; endpoint: string } }) => ({
            chart: context.chart,
            endpoint: context.endpoint,
          }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
  });
  const wf: WorkflowDef = {
    name: "charted",
    machine,
    provide: () => ({ actors: { coder: agentActorWith(() => coder, def) } }),
  };
  return { wf, coder, machine };
}

const oneTurn: ChartText = {
  events: { finish: { input: { type: "object", properties: {}, additionalProperties: false } } },
  initial: "work",
  states: {
    work: {
      invoke: { src: "coder", input: { prompt: "work" } },
      on: { finish: "over" },
    },
    over: { type: "final", output: { finished: true } },
  },
};

test("a Chart wrapper registers with its body and Chart fields; the listing shows both facts (ADR-0070)", async () => {
  const host = new RunHost({ store: await mkStore() });
  const { wf, machine } = chartWrapper();
  host.register(wf);
  host.register(codingDef(new Map()));
  host.registerChart({
    ...wf,
    name: "charted/loop",
    chart: { wrapper: "charted", name: "loop", text: oneTurn, hash: "h1", origin: "runtime" },
  });
  assert.deepEqual(host.workflows().sort(), ["charted", "charted/loop", "coding"], "every registered name");
  assert.deepEqual(
    host.workflowList(),
    [
      {
        name: "charted",
        origin: "machine",
        wrapper: { body: "body", oneShot: true, charts: [{ name: "loop", origin: "runtime" }] },
      },
      { name: "coding", origin: "machine" },
    ],
    "a named Chart lists inside its wrapper's entry, not beside it",
  );
  // A named Chart whose wrapper is not registered has an entry of its own.
  host.registerChart({
    ...wf,
    name: "gone/loop",
    chart: { wrapper: "gone", name: "loop", text: oneTurn, hash: "h2", origin: "runtime" },
  });
  assert.deepEqual(
    host.workflowList().filter((w) => w.name.includes("/")),
    [{ name: "gone/loop", origin: "runtime" }],
  );
  host.unregisterChart("gone", "loop");
  assert.deepEqual(host.namedChart("charted", "loop"), {
    wrapper: "charted",
    name: "loop",
    text: oneTurn,
    hash: "h1",
    origin: "runtime",
  });
  // A named Chart's door is the wrapper's minus the Chart field, and its Machine doc the wrapper's.
  const door = host.inputSchema("charted/loop") as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(door.properties), ["endpoint"]);
  assert.ok(Object.keys((host.inputSchema("charted") as { properties: object }).properties).includes("chart"));
  assert.equal(host.machine("charted/loop")?.id, machine.id);

  host.unregisterChart("charted", "loop");
  assert.equal(host.namedChart("charted", "loop"), undefined);
  host.unregisterChart("charted", "nope");
  host.unregisterChart("coding", "x");
  assert.deepEqual(host.workflows().sort(), ["charted", "coding"], "a Machine is never dropped as a Chart");
});

test("a named Chart's start supplies the Chart field from its text and takes the rest from the caller", async () => {
  const host = new RunHost({ store: await mkStore() });
  const { wf, coder } = chartWrapper();
  host.register(wf);
  host.registerChart({
    ...wf,
    name: "charted/loop",
    chart: { wrapper: "charted", name: "loop", text: oneTurn, hash: "h1", origin: "file" },
  });
  // A caller's `chart` is not the run's: the named Chart fixes it.
  const { runId } = await host.start("charted/loop", { endpoint: "http://harness.invalid", chart: { bogus: 1 } });
  await waitFor(() => coder.admits.length === 1);
  const status = host.status(runId)!;
  assert.equal(status.workflow, "charted/loop");
  assert.equal(status.bound, true);
  const observed = host.observations("charted/loop");
  assert.equal(observed[0]!.bound, true, "the open band carries the fact, not the Chart");
  assert.equal((observed[0] as Record<string, unknown>).context, undefined);
  host.sendToAgent(coder.admits[0]!.instanceId, { type: "finish" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { result: unknown }).result, { outcome: "done", output: { finished: true } });
  assert.equal(final?.bound, undefined, "a settled run binds no Chart any more");
});

test("the one-shot door refuses a Chart before any run exists: ChartRefusal with the report", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(chartWrapper().wf);
  const bad = { ...oneTurn, agents: { tester: { model: "openai/gpt-5", instructions: "test" } } };
  await assert.rejects(
    () => host.start("charted", { endpoint: "http://harness.invalid", chart: bad }),
    (err: unknown) =>
      err instanceof ChartRefusal &&
      err.report.some((l) => l.startsWith("agents.tester.model") && l.includes("stub/model")),
  );
  // The grammar is the door's schema: a text that is no Chart is the door's own 400.
  await assert.rejects(
    () => host.start("charted", { endpoint: "http://harness.invalid", chart: { states: {} } }),
    EventValidationError,
  );
  assert.deepEqual(host.list(), []);
});

test("a snapshot save that fails is logged for its run, and never ends the process", async () => {
  const store = await mkStore();
  const failing: SnapshotStore = Object.assign(Object.create(store) as SnapshotStore, {
    save: async () => {
      throw new RangeError("Invalid string length");
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    const host = new RunHost({ store: failing });
    host.register({
      name: "bare",
      machine: setup({}).createMachine({ id: "bare", initial: "a", states: { a: {} } }),
      provide: () => ({}),
    });
    const { runId } = await host.start("bare", {});
    await tick();
    await host.stop(runId);
    await tick();
    assert.deepEqual(unhandled, [], "no rejection escapes the save");
    assert.ok(
      logged.some((l) => l.includes(runId) && l.includes("not saved") && l.includes("Invalid string length")),
      `the failed save is logged for its run (logged: ${JSON.stringify(logged)})`,
    );
  } finally {
    console.error = error;
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---- A run starts a run (ADR-0071) ---------------------------------------------------------------
// The host's half of a `dispatch`: the key on the callee's row, the chain's depth, the output a
// settled run serves, and the settle hook a `wait` rides — keyed by run id, so a restore in either
// order resumes it.

const calleeDoor = z.object({ ticket: z.string() });

/** A Workflow with a door, parked on Gate "go" until `approve`; its output names its ticket. */
const calleeTemplate = jr2Setup({
  types: {} as { context: { ticket: string }; input: { ticket: string } },
  events: [approveDef],
}).createMachine({
  id: "callee",
  input: calleeDoor,
  context: ({ input }) => ({ ticket: input.ticket }),
  initial: "waiting",
  states: {
    waiting: { invoke: { src: "gate", input: { gate: "go", accepts: ["approve"] } }, on: { approve: "done" } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ ticket: context.ticket, verdict: "ok" }),
});

function calleeDef(): WorkflowDef {
  return { name: "callee", machine: calleeTemplate, provide: () => ({}) };
}

/** What a caller's `dispatch` Effect sends, by its ledger row id `effect` (the key). */
const by = (effect: string, depth = 1): DispatchedBy => ({ run: "caller-run", slot: "review", effect, depth });

/**
 * A caller that dispatches `callee` through the binding and waits, as an in-process `dispatch` with
 * `wait` does: its one promise actor is re-run by a restore, and its key makes the re-run's start
 * the same run. Its output is what the wait settled with.
 */
const callerTemplate = setup({
  types: {} as { context: { result?: unknown } },
  actors: {
    call: fromPromise(async ({ system }) => {
      const binding = boundRun(system)!;
      const started = await binding.dispatch!.start(
        "callee",
        { ticket: "T-7" },
        { run: binding.runId, slot: "call", effect: "caller-key", depth: (binding.depth ?? 0) + 1 },
      );
      if (!started.ok) throw new Error(started.report.join("; "));
      const settled = await binding.dispatch!.settled(started.runId, new AbortController().signal);
      return { run: started.runId, existing: started.existing, status: settled.status, output: settled.output };
    }),
  },
}).createMachine({
  id: "caller",
  context: {},
  initial: "calling",
  states: {
    calling: {
      invoke: { src: "call", onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) } },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.result,
});

function callerDef(): WorkflowDef {
  return { name: "caller", machine: callerTemplate, provide: () => ({}) };
}

async function storedStatus(store: SnapshotStore, runId: string): Promise<string | undefined> {
  return (await store.load(runId))?.status;
}

async function untilStored(store: SnapshotStore, runId: string, pred: (blob: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 100; i++) {
    if (pred(await blobOf(store, runId))) return;
    await tick();
  }
  throw new Error(`run ${runId}: the stored blob never matched`);
}

test("a dispatched run's record, blob and status carry dispatchedBy at its depth; restore rebuilds it (ADR-0071)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(calleeDef());
  const { runId, existing } = await hostA.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-1", 3) });
  assert.equal(existing, undefined, "a new run is not `existing`");
  const expected = { ...by("k-1"), depth: 3 };
  assert.deepEqual(
    hostA.status(runId)?.dispatchedBy,
    expected,
    "the row records the depth as the caller sent it: the callee's own",
  );
  assert.equal(hostA.depthOf(runId), 3);
  await untilStored(store, runId, (blob) => blob.dispatchedBy !== undefined);
  assert.deepEqual((await blobOf(store, runId)).dispatchedBy, expected, "the blob carries it, key and all");

  // A run nothing dispatched is depth 0, and carries none.
  const root = await hostA.start("callee", { ticket: "T-2" });
  assert.equal(hostA.depthOf(root.runId), 0);
  assert.equal(hostA.status(root.runId)?.dispatchedBy, undefined);

  await hostA.stop(runId);
  assert.equal(hostA.depthOf(runId), undefined, "a run this process does not host is not a root run");
  const hostB = new RunHost({ store });
  hostB.register(calleeDef());
  const { reattached } = await hostB.restore();
  assert.ok(reattached.includes(runId));
  assert.deepEqual(hostB.status(runId)?.dispatchedBy, expected, "restore rebuilds the record from the blob");
  assert.equal(hostB.depthOf(runId), 3);
});

test("the key answers the run it started from the live set, before the run's first save (ADR-0071)", async () => {
  const store = await mkStore();
  // A store that keeps nothing: whatever answers the second start, it is not the store.
  const blind: SnapshotStore = Object.assign(Object.create(store) as SnapshotStore, { save: async () => {} });
  const host = new RunHost({ store: blind });
  host.register(calleeDef());
  const first = await host.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-live") });
  assert.equal(await store.findByDispatch("k-live"), undefined, "nothing was saved");
  const again = await host.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-live") });
  assert.deepEqual(again, { runId: first.runId, instanceId: first.instanceId, existing: true });

  // Two starts with one key at once — the second before the first has spawned — are one run.
  const [a, b] = await Promise.all([
    host.start("callee", { ticket: "T-2" }, { dispatchedBy: by("k-race") }),
    host.start("callee", { ticket: "T-2" }, { dispatchedBy: by("k-race") }),
  ]);
  assert.equal(a.runId, b.runId);
  assert.equal(b.existing, true);
  assert.equal(host.list().filter((s) => s.dispatchedBy?.effect === "k-race").length, 1);
});

test("a key a run of another Workflow carries is refused, never answered as that run (ADR-0071)", async () => {
  const store = await mkStore();
  let answer: unknown;
  const probe = setup({
    actors: {
      probe: fromPromise(async ({ system }) => {
        answer = await boundRun(system)!.dispatch!.start("other", { ticket: "T-1" }, by("k-shared"));
        return null;
      }),
    },
  }).createMachine({ id: "probe", initial: "a", states: { a: { invoke: { src: "probe" } } } });
  const host = new RunHost({ store });
  host.register(calleeDef());
  host.register({ name: "other", machine: calleeTemplate, provide: () => ({}) });
  host.register({ name: "probe", machine: probe, provide: () => ({}) });
  const first = await host.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-shared") });
  await assert.rejects(
    host.start("other", { ticket: "T-1" }, { dispatchedBy: by("k-shared") }),
    (err: Error) => err.name === "DispatchKeyConflictError" && /of "callee", not of "other"/.test(err.message),
  );
  // From the store too: a host that does not host the run refuses it the same way.
  await untilStored(store, first.runId, (blob) => blob.dispatchedBy !== undefined);
  await host.stop(first.runId);
  await assert.rejects(
    host.start("other", { ticket: "T-1" }, { dispatchedBy: by("k-shared") }),
    (err: Error) => err.name === "DispatchKeyConflictError",
  );
  // In-process, the refusal is the Effect's output, 409.
  await host.start("probe");
  await waitFor(() => answer !== undefined);
  const refused = answer as { ok: false; status: number; report: string[] };
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.match(refused.report[0]!, new RegExp(`run ${first.runId} of "callee", not of "other"`));
  assert.equal(host.list().filter((s) => s.workflow === "other").length, 0, "no run of the other Workflow started");
});

test("the key answers a run from the store on a host that does not host it, whatever its status (ADR-0071)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(calleeDef());
  const first = await hostA.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-stored") });
  hostA.sendToGate(first.runId, "go", { type: "approve" });
  await waitFor(() => hostA.status(first.runId) === undefined);
  assert.equal(await storedStatus(store, first.runId), "done");

  // Host B never restored and hosts nothing; the Workflow is not even registered there: the key is
  // asked before the name.
  const hostB = new RunHost({ store });
  const again = await hostB.start("callee", { ticket: "T-1" }, { dispatchedBy: by("k-stored") });
  assert.deepEqual(again, { runId: first.runId, instanceId: first.instanceId, existing: true });
  assert.deepEqual(hostB.list(), [], "no second run");
});

test("a settled run's status carries the Machine's output; a live one's never does (ADR-0071)", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(calleeDef());
  const { runId } = await host.start("callee", { ticket: "T-9" });
  await tick();
  assert.equal(host.status(runId)?.output, undefined);
  assert.equal((await host.read(runId))?.output, undefined, "live: no output");
  host.sendToGate(runId, "go", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  const read = await host.read(runId);
  assert.equal(read?.status, "done");
  assert.deepEqual(read?.output, { ticket: "T-9", verdict: "ok" }, "read through the store");
});

test("observe carries dispatchedBy without its key (ADR-0071, ADR-0014)", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(calleeDef());
  const { runId } = await host.start(
    "callee",
    { ticket: "T-1" },
    { dispatchedBy: { ...by("k-secret"), instance: "other-instance" } },
  );
  const observed = host.observations("callee").find((o) => o.runId === runId);
  assert.deepEqual(observed?.dispatchedBy, { run: "caller-run", slot: "review", depth: 1, instance: "other-instance" });
  assert.ok(!JSON.stringify(observe(host.status(runId)!)).includes("k-secret"), "the key stays off the open band");
  assert.equal(host.status(runId)?.dispatchedBy?.effect, "k-secret", "behind the token it is there");
});

test("onSettled hears a run settle once, with its output, and answers a run already settled at once (ADR-0071)", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(calleeDef());
  const { runId } = await host.start("callee", { ticket: "T-3" });
  const heard: RunStatus[] = [];
  host.onSettled(runId, (s) => heard.push(s));
  const detached: RunStatus[] = [];
  const off = host.onSettled(runId, (s) => detached.push(s));
  off();
  await tick();
  assert.equal(heard.length, 0, "a live run has not settled");
  host.sendToGate(runId, "go", { type: "approve" });
  await waitFor(() => heard.length === 1);
  assert.equal(heard[0]!.status, "done");
  assert.deepEqual(heard[0]!.output, { ticket: "T-3", verdict: "ok" });
  assert.deepEqual(detached, [], "a detached listener hears nothing");

  const late: RunStatus[] = [];
  host.onSettled(runId, (s) => late.push(s));
  await waitFor(() => late.length === 1);
  assert.equal(late[0]!.status, "done");
  assert.deepEqual(late[0]!.output, { ticket: "T-3", verdict: "ok" }, "answered from read()");
  await tick();
  assert.equal(heard.length, 1, "once");

  // A cancel is a settle, in the store's word.
  const other = await host.start("callee", { ticket: "T-4" });
  const cancelled: string[] = [];
  host.onSettled(other.runId, (s) => cancelled.push(s.status));
  await host.cancel(other.runId);
  assert.deepEqual(cancelled, ["cancelled"]);
});

test("onSettled attached before restore hosts the run hears it settle after (ADR-0071)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(calleeDef());
  const { runId } = await hostA.start("callee", { ticket: "T-5" });
  await untilStored(store, runId, (blob) => blob.machine !== undefined);
  await hostA.stop(runId);

  const hostB = new RunHost({ store });
  hostB.register(calleeDef());
  const heard: RunStatus[] = [];
  // Attached to a run this host does not host: its row is live, so nothing is answered yet.
  hostB.onSettled(runId, (s) => heard.push(s));
  await tick();
  assert.equal(heard.length, 0);
  await hostB.restore();
  hostB.sendToGate(runId, "go", { type: "approve" });
  await waitFor(() => heard.length === 1);
  assert.equal(heard[0]!.status, "done");
  assert.deepEqual(heard[0]!.output, { ticket: "T-5", verdict: "ok" });
});

test("onSettled hears a run restore marks lost or drifted (ADR-0071)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(calleeDef());
  const lostRun = await hostA.start("callee", { ticket: "T-L" });
  await untilStored(store, lostRun.runId, (blob) => blob.machine !== undefined);

  const hostB = new RunHost({ store, reconcile: () => false });
  hostB.register(calleeDef());
  const lost: RunStatus[] = [];
  hostB.onSettled(lostRun.runId, (s) => lost.push(s));
  await hostB.restore();
  await waitFor(() => lost.length === 1);
  assert.equal(lost[0]!.status, "lost");
  assert.equal(lost[0]!.reason, "reconcile: live world absent");

  const hostC = new RunHost({ store });
  hostC.register(calleeDef());
  const driftRun = await hostC.start("callee", { ticket: "T-D" });
  await untilStored(store, driftRun.runId, (blob) => blob.machine !== undefined);
  await hostC.stop(driftRun.runId);
  // Host D registers another Machine under the name: the snapshot's shape no longer matches.
  const hostD = new RunHost({ store });
  hostD.register({
    name: "callee",
    machine: setup({}).createMachine({ id: "callee", initial: "other", states: { other: {} } }),
    provide: () => ({}),
  });
  const drifted: RunStatus[] = [];
  hostD.onSettled(driftRun.runId, (s) => drifted.push(s));
  await hostD.restore();
  await waitFor(() => drifted.length === 1);
  assert.equal(drifted[0]!.status, "drifted");
  assert.match(drifted[0]!.reason ?? "", /changed shape/);
});

test("a re-run caller attaches onSettled before its callee is hosted, and its start under a known key answers the existing run (ADR-0071)", async () => {
  const store = await mkStore();
  const hostA = new RunHost({ store });
  hostA.register(callerDef());
  hostA.register(calleeDef());
  const caller = await hostA.start("caller");
  await waitFor(() => hostA.list().some((s) => s.workflow === "callee"));
  const callee = hostA.list().find((s) => s.workflow === "callee")!;
  assert.deepEqual(callee.dispatchedBy, { run: caller.runId, slot: "call", effect: "caller-key", depth: 1 });
  await untilStored(store, callee.runId, (blob) => blob.machine !== undefined);
  // The restart: neither run is hosted any more, and both rows stay live.
  await hostA.stop(caller.runId);
  await hostA.stop(callee.runId);
  assert.deepEqual(
    (await store.live()).map((r) => r.runId),
    [caller.runId, callee.runId],
    "the caller's row restores first",
  );

  // The callee's reconcile is slow, so the restored caller's re-run reaches its wait while the
  // callee is not hosted: the wait attaches to a run id, not to a hosted run.
  let calleeHosted = false;
  let waitedUnhosted = false;
  const hostB = new RunHost({
    store,
    reconcile: async (record) => {
      if (record.runId === callee.runId) {
        await tick();
        waitedUnhosted = attached.includes(callee.runId) && !calleeHosted;
        calleeHosted = true;
      }
      return true;
    },
  });
  const attached: string[] = [];
  const onSettled = hostB.onSettled.bind(hostB);
  hostB.onSettled = (runId, listener) => {
    attached.push(runId);
    return onSettled(runId, listener);
  };
  hostB.register(callerDef());
  hostB.register(calleeDef());
  const { reattached } = await hostB.restore();
  assert.deepEqual(reattached, [caller.runId, callee.runId]);
  assert.ok(waitedUnhosted, "the caller's wait attached to its callee before the callee was hosted");
  await tick();
  assert.equal(
    (await store.live()).filter((r) => (r.snapshot as { workflow?: string }).workflow === "callee").length,
    1,
    "the re-run start found the callee by its key: one callee",
  );
  hostB.sendToGate(callee.runId, "go", { type: "approve" });
  await waitFor(() => hostB.status(caller.runId) === undefined);
  const settled = await hostB.read(caller.runId);
  assert.equal(settled?.status, "done");
  assert.deepEqual(settled?.output, {
    run: callee.runId,
    existing: true,
    status: "done",
    output: { ticket: "T-7", verdict: "ok" },
  });
});

test("the binding's dispatch.start answers each door refusal as output, and settled rejects on abort (ADR-0071)", async () => {
  let refusals: unknown[] = [];
  let aborted: unknown;
  const probe = setup({
    actors: {
      probe: fromPromise(async ({ system }) => {
        const d = boundRun(system)!.dispatch!;
        refusals = [
          await d.start("callee", { ticket: 7 }, by("p-400")),
          await d.start("nowhere", {}, by("p-404")),
          await d.start("wrap/broken", {}, by("p-409")),
        ];
        const ac = new AbortController();
        const waiting = d.settled("no-such-run", ac.signal).catch((err: unknown) => (aborted = err));
        ac.abort(new Error("the state exited"));
        await waiting;
        return null;
      }),
    },
  }).createMachine({ id: "probe", initial: "a", states: { a: { invoke: { src: "probe", onDone: "b" } }, b: {} } });
  const host = new RunHost({
    store: await mkStore(),
    unrunnableChart: (name) => (name === "wrap/broken" ? "its lent slot is gone" : undefined),
  });
  host.register(calleeDef());
  host.register({ name: "probe", machine: probe, provide: () => ({}) });
  await host.start("probe");
  await waitFor(() => refusals.length === 3 && aborted !== undefined);
  const [bad, missing, unrunnable] = refusals as [{ ok: false; status: number; report: string[] }, unknown, unknown];
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.match(bad.report[0]!, /invalid input for workflow "callee"/);
  assert.match(bad.report[1]!, /the door of "callee" takes .*"ticket"/, "the report names the door's shape");
  assert.deepEqual(missing, { ok: false, status: 404, report: ['no workflow registered as "nowhere"'] });
  assert.deepEqual(unrunnable, {
    ok: false,
    status: 409,
    report: ['named Chart "wrap/broken" cannot run: its lent slot is gone'],
  });
  assert.equal((aborted as Error).message, "the state exited");
  assert.equal(host.list().filter((s) => s.workflow === "callee").length, 0, "no refused start made a run");
});

test("the binding's dispatch.start answers a Chart the door refuses 422 with the report (ADR-0071)", async () => {
  const { wf } = chartWrapper();
  let answer: unknown;
  const probe = setup({
    actors: {
      probe: fromPromise(async ({ system }) => {
        const bad = { ...oneTurn, agents: { tester: { model: "openai/gpt-5", instructions: "test" } } };
        answer = await boundRun(system)!.dispatch!.start(
          wf.name,
          { endpoint: "http://harness.invalid", chart: bad },
          by("p-422"),
        );
        return null;
      }),
    },
  }).createMachine({ id: "probe", initial: "a", states: { a: { invoke: { src: "probe" } } } });
  const host = new RunHost({ store: await mkStore() });
  host.register(wf);
  host.register({ name: "probe", machine: probe, provide: () => ({}) });
  await host.start("probe");
  await waitFor(() => answer !== undefined);
  const refused = answer as { ok: false; status: number; report: string[] };
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  assert.ok(
    refused.report.some((l) => l.startsWith("agents.tester.model")),
    JSON.stringify(refused.report),
  );
});
