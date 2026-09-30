// Run-lifecycle actor tests. The actor does two things on start — registers its invocation's
// event surface in the host table (ADR-0011) and admits (or re-attaches) the run over the port
// built from `input.endpoint` (ADR-0016) — and undoes both on stop. On the wire side it emits
// only telemetry (`agent.fault`); domain events come up the MCP channel via the registration,
// never from the flue surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, setup, sendTo } from "xstate";
import { z } from "zod";
import { defineEvent, eventMap } from "@jr2/agent-protocol";
import { agentActorWith, type AgentRunOptions } from "../src/actor.ts";
import type { AgentAdmission, AgentRunInput, AgentRunPort } from "../src/actor.ts";
import type { AgentDeclaration, AgentDefinition } from "../src/agent.ts";
import { open } from "../src/open.ts";
import { registerAmbientHandles, type AmbientHandles } from "../src/ambient.ts";
import { bindRun, agentAddress, RegistrationTable, type RetryTelemetry, type RunBinding } from "../src/registration.ts";
import { attachVocabulary } from "../src/vocabulary.ts";
import type { HarnessRestarts } from "../src/workspace.ts";
import { MockFlueClient } from "./_fixtures.ts";

const pingEvent = defineEvent({ name: "ping", input: z.object({}) });

/**
 * `sendBack` needs a parent to land in, so wrap the actor in a tiny machine that records every
 * event the child sends up and forwards a CANCEL down on request. The actor resolves its run
 * binding from the actor system, so the test binds one before start (what RunHost.track does) —
 * including the admission-ledger write half, captured into `ledger`.
 */
function harness(
  client: AgentRunPort,
  input: AgentRunInput,
  options?: AgentRunOptions,
  /** The slot's DECLARATION (ADR-0049) — what places the Turn (ADR-0031). It is a closure over the
   * logic, not a host lookup, so a test states it exactly where the Machine would: at the slot.
   * A DECLARATION, because an Open model is one of the things the actor has to answer for. */
  definition: AgentDeclaration = { model: "test/model", instructions: "i" },
  bindingExtra?: Partial<RunBinding>,
  ambient?: AmbientHandles,
) {
  const received: Array<{ type: string; [k: string]: unknown }> = [];
  const errors: unknown[] = [];
  const ledger: Record<string, AgentAdmission> = {};
  const telemetry: RetryTelemetry[] = [];
  const table = new RegistrationTable();
  const endpoints: string[] = [];
  const bearers: Array<string | undefined> = [];

  const machine = setup({
    actors: {
      run: agentActorWith(
        (endpoint: string, bearer?: string) => (endpoints.push(endpoint), bearers.push(bearer), client),
        definition,
        options,
      ),
    },
  }).createMachine({
    id: "parent",
    initial: "running",
    states: {
      running: {
        invoke: { id: "run", src: "run", input },
        on: {
          CANCEL_RUN: { actions: sendTo("run", { type: "CANCEL" }) },
          "*": { actions: ({ event }) => received.push(event) },
        },
      },
    },
  });

  // The menu resolves against the INVOKING Machine's vocabulary (ADR-0011, ADR-0049), so the
  // parent carries it — what `jr2Setup` does for an authored machine, done by hand here because
  // these fixtures exercise the actor over a plain `setup()` parent.
  attachVocabulary(machine, eventMap("test", [pingEvent]));
  const actor = createActor(machine);
  const binding: RunBinding = {
    runId: "run-1",
    workflow: "test",
    table,
    recordAdmission: (iid, admission) => (ledger[iid] = admission),
    telemetry: (event) => telemetry.push(event),
    ...bindingExtra,
  };
  bindRun(actor.system, binding);
  // Stand in for an enclosing workspace(): the invoked child's `_parent` is this root actor, so
  // handles registered under it are what `ambientHandlesFor` finds.
  if (ambient) registerAmbientHandles(actor, ambient);
  actor.subscribe({ error: (err) => errors.push(err) }); // xstate reports invoke errors here, not out of start()
  actor.start();
  return { actor, received, table, errors, ledger, endpoints, bearers, telemetry, binding };
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-42",
  endpoint: "http://sandbox-7.harness.local:8080",
  prompt: "do the thing",
  tools: ["ping"],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

test("admits the run over a port built from input.endpoint and ledgers the admission", async () => {
  const mock = new MockFlueClient();
  const { ledger, endpoints } = harness(mock, baseInput);
  await tick();

  assert.equal(mock.admitted?.agentName, "coder");
  assert.equal(mock.admitted?.instanceId, "inst-42");
  assert.deepEqual(endpoints, ["http://sandbox-7.harness.local:8080"]);
  // The durable handle went to the HOST ledger the moment flue admitted (ADR-0016), stamped
  // with the conversation it was admitted under (the reroll advances the stamp — ADR-0035) and
  // the Harness that holds it, which the live set is built from (ADR-0031)…
  assert.deepEqual(ledger["inst-42"], {
    ...mock.minted,
    instanceId: "inst-42",
    agent: "coder",
    endpoint: "http://sandbox-7.harness.local:8080",
  });
  // …and the actor is now following that admission to settlement.
  assert.deepEqual(mock.settled, [mock.minted]);
});

test("input.attach (set by the host on restore) re-attaches without re-admitting", async () => {
  const mock = new MockFlueClient();
  const attach: AgentAdmission = {
    streamUrl: "http://mock/agents/coder/inst-42",
    offset: "adm-9",
    submissionId: "sub-9",
  };
  const { ledger } = harness(mock, { ...baseInput, prompt: undefined, attach });
  await tick();

  assert.equal(mock.admitted, undefined, "re-attach must not admit a fresh prompt");
  assert.deepEqual(mock.settled, [attach], "settlement follows the PERSISTED admission");
  assert.deepEqual(ledger, {}, "nothing new to ledger — the admission was already durable");
});

test("registers its event surface on start; delivery lands on the invoking state", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);

  const reg = table.lookup(agentAddress("inst-42"));
  assert.equal(reg?.kind, "agent");
  assert.deepEqual([...(reg?.defs.keys() ?? [])], ["ping"]);

  table.deliver(agentAddress("inst-42"), "ping", {});
  await tick();
  assert.ok(received.some((e) => e.type === "ping"));
});

test("an Open model is refused at start — the second fence, before a Turn is admitted (ADR-0054)", () => {
  // `jr2 up`'s walk is the first fence and covers every registered Machine; this is what catches an
  // import nobody registered as itself. It refuses BEFORE admitting, because the wire takes a
  // string and a Symbol would leave the Harness with a slot key and no model.
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput, undefined, { model: open, instructions: "i" });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /agent "coder" has an Open model/);
  assert.match(String(errEvent?.error?.message), /agents: \{ coder: \{ model: "<provider>\/<model>" \} \}/);
  assert.deepEqual(mock.definitions, [], "nothing was admitted");
});

test("no endpoint and no enclosing workspace → the invoke errors loudly, NAMING the definition's workspace (ADR-0031)", () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, endpoint: undefined });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  // The definition omits `workspace` → the "write" default is what the error names.
  assert.match(String(errEvent?.error?.message), /agent "coder" has workspace: "write"/);
  assert.match(String(errEvent?.error?.message), /invoke it inside a workspace\(\)/);
});

// --- Placement resolution (ADR-0031): endpoint → "none" → Instance Harness → ambient → error ----

/** The two definitions the placement rules turn on (ADR-0031) — the Menu-only Agent, and an
 * ordinary one that must resolve an enclosing workspace(). */
const NONE: AgentDefinition = { model: "test/model", instructions: "i", workspace: "none" };
const READ: AgentDefinition = { model: "test/model", instructions: "i", workspace: "read" };

const AMBIENT: AmbientHandles = {
  endpoint: "http://ws-1.harness.local:8080",
  sandbox: "ws-1",
  repos: { app: "/work/app/main" },
  branch: "main",
};

test('explicit input.endpoint wins over everything — even a "none" definition with an Instance Harness', async () => {
  const mock = new MockFlueClient();
  const { endpoints, table } = harness(
    mock,
    { ...baseInput, sandbox: "stub-1" },
    undefined,
    NONE,
    { instanceHarness: "http://jr2-instance-harness.ns.svc:8080" },
    AMBIENT,
  );
  await tick();

  assert.deepEqual(endpoints, ["http://sandbox-7.harness.local:8080"], "the stub path is untouched");
  assert.equal(table.lookup(agentAddress("inst-42"))?.sandbox, "stub-1", "…and keeps the input's sandbox");
});

test('workspace "none" → the Instance Harness, and the registration records the placement as its scope (ADR-0031)', async () => {
  const mock = new MockFlueClient();
  const { endpoints, table } = harness(mock, { ...baseInput, endpoint: undefined }, undefined, NONE, {
    instanceHarness: "http://jr2-instance-harness.ns.svc:8080",
  });
  await tick();

  assert.deepEqual(endpoints, ["http://jr2-instance-harness.ns.svc:8080"]);
  const reg = table.lookup(agentAddress("inst-42"));
  assert.ok(reg, "the surface registered");
  // ADR-0013's doctrine on the second placement: only a token signed for the Instance Harness's
  // own name (its Custodian's — deploy.ts) or the Instance token may deliver this surface's picks.
  assert.equal(reg.sandbox, "jr2-instance-harness");
});

test('definition-wins: "none" inside an enclosing workspace() still lands on the Instance Harness', async () => {
  // The deciding scenario is conversation continuation: nearest-wins would route the same
  // (agent, iid) to a different server mid-conversation (ADR-0031).
  const mock = new MockFlueClient();
  const { endpoints, table } = harness(
    mock,
    { ...baseInput, endpoint: undefined },
    undefined,
    NONE,
    { instanceHarness: "http://jr2-instance-harness.ns.svc:8080" },
    AMBIENT,
  );
  await tick();

  assert.deepEqual(endpoints, ["http://jr2-instance-harness.ns.svc:8080"], "not the workspace's Harness");
  assert.equal(
    table.lookup(agentAddress("inst-42"))?.sandbox,
    "jr2-instance-harness",
    "…and not the workspace's Sandbox: the placement is the scope",
  );
});

test("everyone else resolves the enclosing workspace(): ambient endpoint AND sandbox", async () => {
  const mock = new MockFlueClient();
  const { endpoints, table } = harness(mock, { ...baseInput, endpoint: undefined }, undefined, READ, {}, AMBIENT);
  await tick();

  assert.deepEqual(endpoints, ["http://ws-1.harness.local:8080"]);
  assert.equal(table.lookup(agentAddress("inst-42"))?.sandbox, "ws-1", "the ADR-0013 token scope");
});

// --- The Harness bearer (ADR-0058): derived from the PLACEMENT the registration records ----------

/** The host's derivation, as a test can read it back: the placement's name, tagged. */
const bearerFor = (placement: string) => `bearer-for:${placement}`;

test("the port is built with the bearer of the placement the Turn resolved — per placement arm (ADR-0058)", async () => {
  const none = harness(new MockFlueClient(), { ...baseInput, endpoint: undefined }, undefined, NONE, {
    instanceHarness: "http://jr2-instance-harness.ns.svc:8080",
    harnessBearer: bearerFor,
  });
  const ambient = harness(
    new MockFlueClient(),
    { ...baseInput, endpoint: undefined },
    undefined,
    READ,
    { harnessBearer: bearerFor },
    AMBIENT,
  );
  const explicit = harness(new MockFlueClient(), { ...baseInput, sandbox: "stub-1" }, undefined, READ, {
    harnessBearer: bearerFor,
  });
  await tick();

  // The bearer and the delivery scope are one name: the pod hosting the Turn.
  assert.deepEqual(none.bearers, ["bearer-for:jr2-instance-harness"]);
  assert.deepEqual(ambient.bearers, ["bearer-for:ws-1"]);
  assert.deepEqual(explicit.bearers, ["bearer-for:stub-1"]);
});

test("no placement name (the stub path) or no host derivation → no bearer, never a guessed one", async () => {
  const stub = harness(new MockFlueClient(), baseInput, undefined, READ, { harnessBearer: bearerFor });
  const bare = harness(new MockFlueClient(), { ...baseInput, sandbox: "stub-1" }, undefined, READ);
  await tick();
  assert.deepEqual(stub.bearers, [undefined]);
  assert.deepEqual(bare.bearers, [undefined]);
});

test('workspace "none" with no Instance Harness address → loud error at start, naming both', () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, endpoint: undefined }, undefined, NONE);
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /agent "coder" has workspace: "none"/);
  assert.match(String(errEvent?.error?.message), /Instance Harness/);
});

test('the loud no-Harness error names the definition\'s own workspace value ("read" here)', () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, endpoint: undefined }, undefined, READ);
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.match(String(errEvent?.error?.message), /agent "coder" has workspace: "read"/);
});

// --- The Frame's cwd (ADR-0057): the Turn's own → "none" → the one Repo Slot → refusal → none ---

/** A two-slot Workspace — the case with no answer, because the kit gives no slot a meaning
 * (ADR-0051): the state must say which Worktree the Turn works in. */
const TWO_SLOTS: AmbientHandles = {
  ...AMBIENT,
  repos: { target: "/work/target/main", docs: "/work/docs/main" },
};

test("the Turn's own cwd is the Frame — it wins over every resolution (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  harness(mock, { ...baseInput, endpoint: undefined, cwd: "/work/target/review" }, undefined, READ, {}, TWO_SLOTS);
  await tick();

  assert.equal(mock.admitted?.cwd, "/work/target/review", "what the state said, not what the Workspace holds");
});

test("under a Workspace with ONE Repo Slot an absent cwd resolves to that slot's Worktree (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  harness(mock, { ...baseInput, endpoint: undefined }, undefined, READ, {}, AMBIENT);
  await tick();

  // With one slot there is nothing to privilege, so no convention is smuggled in (ADR-0051).
  assert.equal(mock.admitted?.cwd, "/work/app/main");
});

test('a workspace: "none" Agent frames no directory — only Working tools consume one (ADR-0028/0057)', async () => {
  const mock = new MockFlueClient();
  harness(
    mock,
    { ...baseInput, endpoint: undefined },
    undefined,
    NONE,
    { instanceHarness: "http://jr2-instance-harness.ns.svc:8080" },
    AMBIENT,
  );
  await tick();

  assert.equal(mock.admitted?.cwd, undefined, "the Menu-only Agent has no Working tools to root");
});

test("a Menu-only Agent handed a cwd keeps it — the Frame is what the STATE said (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  harness(
    mock,
    { ...baseInput, endpoint: undefined, cwd: "/work/notes" },
    undefined,
    NONE,
    { instanceHarness: "http://jr2-instance-harness.ns.svc:8080" },
    AMBIENT,
  );
  await tick();

  // Resolution is what `workspace: "none"` silences, not the Frame: a state that names a
  // directory is never second-guessed, and the Instance Harness simply has no Working tools to
  // root there (ADR-0028/0031).
  assert.equal(mock.admitted?.cwd, "/work/notes");
});

test("no Workspace and no cwd: the Frame says nothing and the Harness keeps /work (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  harness(mock, baseInput); // the stub path — an explicit endpoint and no workspace() to resolve from
  await tick();

  assert.equal(mock.admitted?.cwd, undefined, "absent is the one silent case, and it says /work");
});

test("more than one Repo Slot and no cwd REFUSES the Turn, naming the slots and the line (ADR-0057)", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, { ...baseInput, endpoint: undefined }, undefined, READ, {}, TWO_SLOTS);
  await tick();

  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  const message = String(errEvent?.error?.message);
  assert.match(message, /agent "coder"/, "names the slot, like the Open-model fence");
  assert.match(message, /target, docs/, "names the slots, in declaration order");
  assert.match(message, /cwd: context\.workspace\.repos\.<slot>/, "names the exact line to add");
  assert.doesNotMatch(message, /repos\.target/, "and privileges no slot while it says the kit privileges none");
  assert.match(message, /ADR-0057/);
  assert.deepEqual(mock.admits, [], "refused BEFORE any admission — no pod is spent on it");
  assert.equal(table.lookup(agentAddress("inst-42")), undefined, "and before any surface is registered");
});

test("a tools name outside the INVOKING MACHINE's vocabulary errors the invoke at start", () => {
  const mock = new MockFlueClient();
  // The harness machine's "*" catches the xstate error event (a real workflow without a handler
  // would escalate and error the run — see gate.test.ts for the host-level path).
  const { received } = harness(mock, { ...baseInput, tools: ["ping", "zap"] });
  const errEvent = received.find((e) => e.type.startsWith("xstate.error.actor")) as { error?: Error } | undefined;
  assert.ok(errEvent, "the invoke must error at start");
  assert.match(String(errEvent?.error?.message), /machine "parent" does not declare event "zap" \(declared: ping\)/);
});

test("a failed settlement surfaces as agent.fault telemetry", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);
  await tick();

  mock.fault("stream reset by peer");
  await tick();

  const fault = received.find((e) => e.type === "agent.fault");
  assert.deepEqual(fault, { type: "agent.fault", instanceId: "inst-42", reason: "stream reset by peer" });
});

test("a lost conversation on a Harness the kernel OOM-killed is a fault NAMED `memory limit` (ADR-0061)", async () => {
  const asked: Array<{ name: string; since: Date }> = [];
  const sandbox = {
    harnessRestarts: () => () => {},
    memoryFault: async (name: string, since: Date) => (
      asked.push({ name, since }),
      {
        reason: "memory limit (OOMKilled, limit 1920Mi): the kernel killed the container",
        limit: "1920Mi",
        at: "2026-09-28T10:03:00Z",
      }
    ),
  } as unknown as RunBinding["sandbox"];
  const lost = () =>
    Object.assign(new Error('conversation lost: the harness answered 404 for submission "sub-1"'), { lost: true });
  const raised: Array<{ notice: unknown; to: string; source?: string }> = [];
  const raiseNotice: RunBinding["raiseNotice"] = (notice, to, source) => raised.push({ notice, to, source });

  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    sandbox,
    raiseNotice,
  });
  await tick();
  (mock as unknown as { pending: Array<{ reject: (e: unknown) => void }> }).pending.pop()!.reject(lost());
  await tick();
  await tick();

  const fault = received.find((e) => e.type === "agent.fault") as { reason?: string } | undefined;
  assert.ok(fault?.reason?.startsWith("memory limit"), String(fault?.reason));
  assert.match(fault!.reason!, /conversation lost/, "the lost conversation rides along beneath the name");
  assert.equal(asked[0]!.name, "ws-7", "asked about THIS Turn's Sandbox");
  // The fault reaches the Machine, and the next Agent in the Workspace is told through the
  // Briefing (ADR-0062) — a notice keyed by the kill itself, so two Turns lost to it raise one.
  assert.deepEqual(raised, [
    {
      notice: { kind: "memory-limit", scope: "workspace", agent: "coder", limit: "1920Mi" },
      to: "ws-7",
      source: "ws-7@2026-09-28T10:03:00Z",
    },
  ]);

  // Any other fault is not asked about: only a lost conversation can hide a memory kill.
  const other = new MockFlueClient();
  const plain = harness(other, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, { sandbox });
  await tick();
  other.fault("stream reset by peer");
  await tick();
  assert.equal(asked.length, 1);
  assert.deepEqual(
    plain.received.find((e) => e.type === "agent.fault"),
    {
      type: "agent.fault",
      instanceId: "inst-42",
      reason: "stream reset by peer",
    },
  );

  // And a lost conversation the Sandbox cannot name stays what it was.
  const unnamed = new MockFlueClient();
  const none = harness(unnamed, { ...baseInput, sandbox: "ws-8" }, undefined, undefined, {
    sandbox: {
      harnessRestarts: () => () => {},
      memoryFault: async () => undefined,
    } as unknown as RunBinding["sandbox"],
  });
  await tick();
  (unnamed as unknown as { pending: Array<{ reject: (e: unknown) => void }> }).pending.pop()!.reject(lost());
  await tick();
  await tick();
  assert.match(
    String((none.received.find((e) => e.type === "agent.fault") as { reason?: string })?.reason),
    /^conversation lost/,
  );
});

/** A Sandbox port that plays the watch's word on its Harness (ADR-0021): `restart()` publishes a
 * new restart count to every listener, as the operator's status write does. */
function restartingSandbox(kill?: { reason: string; limit: string; at: string }) {
  const listeners = new Set<(seen: HarnessRestarts) => void>();
  let seen: HarnessRestarts = { restartCount: 0 };
  const port = {
    harnessRestarts: (_name: string, listener: (seen: HarnessRestarts) => void) => {
      listeners.add(listener);
      queueMicrotask(() => listeners.has(listener) && listener(seen));
      return () => listeners.delete(listener);
    },
    memoryFault: async () => kill,
  } as unknown as RunBinding["sandbox"];
  return {
    port,
    get listening() {
      return listeners.size;
    },
    restart(lastTerminated: HarnessRestarts["lastTerminated"]) {
      seen = { restartCount: seen.restartCount + 1, lastTerminated };
      for (const l of listeners) l(seen);
    },
  };
}

test("a Harness restart ends the Turn at once, in the kubelet's words — the mark is stamped on the ledger (ADR-0021)", async () => {
  const sandbox = restartingSandbox();
  const mock = new MockFlueClient();
  const { received, ledger } = harness(mock, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    sandbox: sandbox.port,
  });
  await tick();
  await tick();
  // The mark is the count once the Harness answered the admission, and it rides the ledger, so a
  // restored Turn is held to the same one.
  assert.equal(ledger["inst-42"]?.harnessRestarts, 0);
  assert.equal(
    received.find((e) => e.type === "agent.fault"),
    undefined,
  );

  sandbox.restart({ reason: "Error", exitCode: 1, finishedAt: "2026-09-29T10:00:00Z" });
  await tick();
  await tick();
  assert.deepEqual(
    received.find((e) => e.type === "agent.fault"),
    {
      type: "agent.fault",
      instanceId: "inst-42",
      reason: "Turn lost (Harness restarted: Error, exit 1)",
    },
  );
});

test("a Harness restart that was a memory kill is named `memory limit` (ADR-0021, ADR-0061)", async () => {
  const sandbox = restartingSandbox({
    reason: "memory limit (OOMKilled, limit 1920Mi): the kernel killed the container",
    limit: "1920Mi",
    at: "2026-09-29T10:00:00Z",
  });
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    sandbox: sandbox.port,
  });
  await tick();
  await tick();
  sandbox.restart({ reason: "OOMKilled", exitCode: 137, finishedAt: "2026-09-29T10:00:00Z" });
  await tick();
  await tick();
  const fault = received.find((e) => e.type === "agent.fault") as { reason?: string } | undefined;
  assert.match(fault?.reason ?? "", /^memory limit \(OOMKilled/);
  assert.match(fault?.reason ?? "", /Turn lost \(Harness restarted: OOMKilled, exit 137\)/);
});

test("a Settlement `failed` by a Harness restart is `Turn lost`, and a memory kill behind it is still named (ADR-0021, ADR-0031)", async () => {
  // The rebuilt stream settles the cut Submission `failed` (ADR-0031) — possibly before the watch
  // hears the restart, and always on the Instance Harness, which the watch does not see.
  const restartSettlement = () =>
    Object.assign(new Error("submission settled failed: Harness restarted"), {
      settlement: { submissionId: "sub-1", outcome: "failed", error: { message: "Harness restarted" } },
    });

  const onInstance = new MockFlueClient();
  const plain = harness(
    onInstance,
    baseInput,
    undefined,
    { model: "test/model", instructions: "i", workspace: "none" },
    {
      instanceHarness: "http://jr2-instance-harness:8080",
    },
  );
  await tick();
  (onInstance as unknown as { pending: Array<{ reject: (e: unknown) => void }> }).pending
    .pop()!
    .reject(restartSettlement());
  await tick();
  await tick();
  assert.deepEqual(
    plain.received.find((e) => e.type === "agent.fault"),
    {
      type: "agent.fault",
      instanceId: "inst-42",
      reason: "Turn lost (Harness restarted)",
    },
  );

  // In a Sandbox, the Settlement may beat the watch: the kill is asked about, as for a 404.
  const sandbox = restartingSandbox({
    reason: "memory limit (OOMKilled, limit 1920Mi): the kernel killed the container",
    limit: "1920Mi",
    at: "2026-09-29T10:00:00Z",
  });
  const inSandbox = new MockFlueClient();
  const named = harness(inSandbox, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    sandbox: sandbox.port,
  });
  await tick();
  await tick();
  (inSandbox as unknown as { pending: Array<{ reject: (e: unknown) => void }> }).pending
    .pop()!
    .reject(restartSettlement());
  await tick();
  await tick();
  const fault = named.received.find((e) => e.type === "agent.fault") as { reason?: string } | undefined;
  assert.match(fault?.reason ?? "", /^memory limit \(OOMKilled/);
  assert.match(fault?.reason ?? "", /Turn lost \(Harness restarted\)/);
});

test("a re-attached Turn is held to its ledgered mark; the Instance Harness is not watched (ADR-0021)", async () => {
  // Restored: the Harness had restarted once before this Turn was admitted, and once since.
  const sandbox = restartingSandbox();
  sandbox.restart(undefined);
  sandbox.restart({ reason: "Error", exitCode: 2 });
  const mock = new MockFlueClient();
  const attach = {
    streamUrl: "http://mock/agents/coder/inst-42",
    offset: "adm-9",
    submissionId: "sub-9",
    harnessRestarts: 1,
  };
  const { received } = harness(
    mock,
    { ...baseInput, sandbox: "ws-7", prompt: undefined, attach },
    undefined,
    undefined,
    {
      sandbox: sandbox.port,
    },
  );
  await tick();
  await tick();
  assert.equal(
    (received.find((e) => e.type === "agent.fault") as { reason?: string } | undefined)?.reason,
    "Turn lost (Harness restarted: Error, exit 2)",
  );

  // A Menu-only Agent's Turn runs on the Instance Harness, a StatefulSet: nothing to watch.
  const other = restartingSandbox();
  harness(
    new MockFlueClient(),
    { ...baseInput, sandbox: "ws-7" },
    undefined,
    { model: "test/model", instructions: "i", workspace: "none" },
    {
      sandbox: other.port,
      instanceHarness: "http://jr2-instance-harness:8080",
    },
  );
  await tick();
  assert.equal(other.listening, 0);
});

test("every admission carries the SLOT's definition — the Harness holds no roster (ADR-0049)", async () => {
  const mock = new MockFlueClient();
  const definition: AgentDefinition = { model: "vllm/qwen", instructions: "be the coder", workspace: "read" };
  const { received } = harness(mock, baseInput, undefined, definition);
  await tick();

  assert.deepEqual(mock.definitions, [definition], "read off the slot's own closure, not a lookup");

  // A nudge is a fresh admission on the same conversation — it carries the definition too, or the
  // re-prompt would arrive at a Harness that cannot say who is answering it.
  mock.complete();
  await tick();
  assert.deepEqual(mock.definitions, [definition, definition]);
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

test("no-signal: a completed turn with no menu call is re-prompted on the SAME iid (ADR-0016)", async () => {
  const mock = new MockFlueClient();
  const { received, ledger, telemetry } = harness(mock, baseInput);
  await tick();

  mock.complete(); // the turn settled COMPLETED, but no `ping` was ever delivered
  await tick();

  assert.equal(mock.admits.length, 2, "a nudge is a fresh admission");
  assert.equal(mock.admits[1]!.instanceId, "inst-42", "same iid — the conversation continues");
  // The nudge names no picks: the Harness's Turn part after it states the Allowed picks, narrowed
  // by the guards and in the model's own tool names (ADR-0029, ADR-0062).
  assert.doesNotMatch(mock.admits[1]!.prompt ?? "", /ping/);
  assert.match(mock.admits[1]!.prompt ?? "", /allowed/i);
  assert.deepEqual(
    ledger["inst-42"],
    { ...mock.minted, instanceId: "inst-42", agent: "coder", endpoint: "http://sandbox-7.harness.local:8080" },
    "the nudge's admission is ledgered like any other",
  );
  // `child` is the invoking parent's actor id — meaningful in real trees ("F-1", "body"); the
  // root harness here gets a generated one, so assert the shape, not the label.
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.kind, "retry");
  assert.equal(telemetry[0]!.attempt, 1);
  assert.equal(telemetry[0]!.reason, "no-signal nudge");
  assert.equal(typeof telemetry[0]!.child, "string");
  assert.ok(!received.some((e) => e.type === "agent.fault"), "budget not exhausted — no fault yet");
});

test("no-signal budget exhausted → ONE terminal agent.fault naming the menu", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput, { nudgeBudget: 0 });
  await tick();

  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1, "budget 0: no nudge");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /without calling any of: ping/);
});

test("a completed turn that DID signal is simply over — no nudge, no fault", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);
  await tick();

  table.deliver(agentAddress("inst-42"), "ping", {});
  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1, "no nudge after a delivered signal");
  assert.ok(!received.some((e) => e.type === "agent.fault"));
  assert.ok(received.some((e) => e.type === "ping"));
});

test("a menuless invocation (tools: []) never nudges — there is nothing to demand", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, { ...baseInput, tools: [] });
  await tick();

  mock.complete();
  await tick();

  assert.equal(mock.admits.length, 1);
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

test("a CANCEL abandons the run locally and destroys the registration", async () => {
  const mock = new MockFlueClient();
  const { actor, table, received } = harness(mock, baseInput);
  await tick();
  assert.ok(table.lookup(agentAddress("inst-42")));

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.equal(mock.abandoned, true, "abandon aborts the local settle consumption");
  assert.equal(table.lookup(agentAddress("inst-42")), undefined);
  // Local abandon never fabricates a fault: the durable run stays alive for restore.
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

// --- Runaway: ended by the Harness, rerolled once, then a fault (ADR-0035) ---------------------

test("runaway: a FRESH turn is rerolled ONCE — fresh conversation, IDENTICAL prompt", async () => {
  const mock = new MockFlueClient();
  const { received, ledger, telemetry, table } = harness(mock, baseInput);
  await tick();

  mock.faultSettled("runaway", "repeated an identical tool call 4 times");
  await tick();

  assert.equal(mock.admits.length, 2, "the reroll is a fresh admission");
  assert.equal(mock.admits[1]!.instanceId, "inst-42-r1", "a fresh conversation, derived from the original");
  assert.equal(mock.admits[1]!.prompt, "do the thing", "the identical prompt — no annotation");
  // The reroll's admission is ledgered under the ORIGINAL iid (the persisted input's key, like a
  // nudge's) and STAMPED with the reroll's own, so a restore settle-follows the LIVE submission
  // and re-addresses the live conversation…
  assert.deepEqual(ledger["inst-42"], {
    ...mock.minted,
    instanceId: "inst-42-r1",
    agent: "coder",
    endpoint: "http://sandbox-7.harness.local:8080",
  });
  assert.equal(ledger["inst-42-r1"], undefined);
  // …and the reroll's surface is live at the DERIVED address: its conversation's Menu reads
  // /agents/inst-42-r1/surface (surfaces resolve by iid, end to end).
  assert.ok(table.lookup(agentAddress("inst-42-r1")), "the reroll surface registered before the admit");
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.kind, "retry");
  assert.equal(telemetry[0]!.attempt, 1);
  assert.equal(telemetry[0]!.reason, "runaway reroll");
  assert.ok(!received.some((e) => e.type === "agent.fault"), "budget not exhausted — no fault yet");
});

test("runaway: a pick delivered on the reroll surface lands on the invoking state — and IS the signal", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);
  await tick();
  mock.faultSettled("runaway", "exceeded 128 steps");
  await tick();

  table.deliver(agentAddress("inst-42-r1"), "ping", {});
  mock.complete();
  await tick();

  assert.ok(received.some((e) => e.type === "ping"));
  assert.equal(mock.admits.length, 2, "no nudge after a delivered signal");
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

test("runaway: a second runaway is the ONE terminal agent.fault, carrying the runaway reason", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);
  await tick();
  mock.faultSettled("runaway", "repeated an identical tool call 4 times");
  await tick();
  mock.faultSettled("runaway", "repeated an identical tool call 4 times");
  await tick();

  assert.equal(mock.admits.length, 2, "budget 1: two independent runaways mean the task is pathological");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /repeated an identical tool call 4 times/);
});

test("runaway: a continuation gets NO reroll, and its terminal fault BURNS it (ADR-0035, ADR-0057)", async () => {
  const mock = new MockFlueClient();
  const burned: string[] = [];
  const { received } = harness(
    mock,
    { ...baseInput, instanceId: "run-1/root/coder", continuation: true },
    undefined,
    undefined,
    {
      bumpEpoch: (conversation) => burned.push(conversation),
    },
  );
  await tick();
  mock.faultSettled("runaway", "exceeded 128 steps");
  await tick();

  assert.equal(mock.admits.length, 1, "jr2 does not invent a conversation the workflow asked to continue");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /exceeded 128 steps/);
  // The poisoned context is not worth continuing, so the next `continue` must not land on it. The
  // actor names the conversation the way the mapper minted it — from the invoking Machine's path.
  assert.deepEqual(burned, ["run-1/root/coder"]);
});

test("a typed settlement failure that is NOT runaway keeps its terminal behavior", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);
  await tick();
  mock.faultSettled("provider_error", "the provider gave up");
  await tick();

  assert.equal(mock.admits.length, 1, "no reroll for any other class");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /the provider gave up/);
});

test("a provider limit faults with the fixed prefix FIRST, unwrapped from the settlement (ADR-0064)", async () => {
  const mock = new MockFlueClient();
  const { received } = harness(mock, baseInput);
  await tick();
  mock.faultSettled("submission_failed", "provider limit (p/m): 429 rate_limit_error");
  await tick();

  assert.equal(mock.admits.length, 1, "no reroll: the provider's pressure is the Machine's to route");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(String(faults[0]!.reason), /^provider limit \(p\/m\): 429/);
});

test("a CANCEL after a reroll aborts the REROLL conversation and destroys both surfaces", async () => {
  const mock = new MockFlueClient();
  const { actor, table } = harness(mock, baseInput);
  await tick();
  mock.faultSettled("runaway", "exceeded 128 steps");
  await tick();

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  // The runaway original was ended by the Harness itself (the self-abort); the reroll is the one
  // live conversation this turn still owns.
  assert.deepEqual(mock.aborts, [{ agentName: "coder", instanceId: "inst-42-r1" }]);
  assert.equal(table.lookup(agentAddress("inst-42")), undefined);
  assert.equal(table.lookup(agentAddress("inst-42-r1")), undefined);
});

test("runaway: restore after a reroll rebinds to the LIVE conversation via the admission stamp", async () => {
  const mock = new MockFlueClient();
  // What durability rewrites after a reroll: `attach` is the ledgered record — stamped with the
  // reroll's iid — under the ORIGINAL instanceId, `prompt` dropped.
  const attach: AgentAdmission = {
    streamUrl: "http://mock/agents/coder/inst-42-r1",
    offset: "adm-9",
    submissionId: "sub-9",
    instanceId: "inst-42-r1",
  };
  const { actor, received, table } = harness(mock, { ...baseInput, prompt: undefined, attach });
  await tick();

  // The LIVE conversation's surface is the registered one: its menu dials /mcp/inst-42-r1.
  assert.ok(table.lookup(agentAddress("inst-42-r1")), "the reroll surface survives restore");
  assert.equal(table.lookup(agentAddress("inst-42")), undefined, "the dead original gets no surface");
  table.deliver(agentAddress("inst-42-r1"), "ping", {});
  await tick();
  assert.ok(received.some((e) => e.type === "ping"));

  actor.send({ type: "CANCEL_RUN" });
  await tick();
  assert.deepEqual(mock.aborts, [{ agentName: "coder", instanceId: "inst-42-r1" }], "abandon ends the LIVE turn");
});

test("runaway: a restored turn (attach, no prompt) gets NO reroll — there is nothing identical to replay", async () => {
  const mock = new MockFlueClient();
  const attach: AgentAdmission = {
    streamUrl: "http://mock/agents/coder/inst-42",
    offset: "adm-9",
    submissionId: "sub-9",
    instanceId: "inst-42",
  };
  const { received } = harness(mock, { ...baseInput, prompt: undefined, attach });
  await tick();
  mock.faultSettled("runaway", "exceeded 128 steps");
  await tick();

  assert.equal(mock.admits.length, 0, "no admit — a promptless reroll would be a mechanism 400");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1);
  assert.match(
    String(faults[0]!.reason),
    /exceeded 128 steps/,
    "the fault carries the runaway reason, not admit noise",
  );
});

test("runaway AFTER a delivered pick gets NO reroll — the workflow already holds this turn's signal", async () => {
  const mock = new MockFlueClient();
  const { received, table } = harness(mock, baseInput);
  await tick();

  table.deliver(agentAddress("inst-42"), "ping", {});
  mock.faultSettled("runaway", "repeated an identical tool call 4 times");
  await tick();

  assert.equal(mock.admits.length, 1, "a reroll would replay a prompt whose signal was already delivered");
  const faults = received.filter((e) => e.type === "agent.fault");
  assert.equal(faults.length, 1, "terminal, like every settle rejection before the reroll existed");
});

// --- The turn ends with the state that asked for it (ADR-0024) ---------------------------------

test("the invocation ending ends the TURN: the submission is aborted, not just abandoned", async () => {
  const mock = new MockFlueClient();
  const { actor, received } = harness(mock, baseInput);
  await tick();

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.deepEqual(mock.aborts, [{ agentName: "coder", instanceId: "inst-42" }]);
  // The actor is already stopped when the abort fires, so its outcome is unobservable BY
  // CONSTRUCTION — never a fault, never a machine event (ADR-0024).
  assert.ok(!received.some((e) => e.type === "agent.fault"));
});

test("a HOST-initiated stop abandons without aborting — restore must find the run alive (ADR-0007)", async () => {
  const mock = new MockFlueClient();
  const { actor, binding } = harness(mock, baseInput);
  await tick();

  // What `RunHost.stop()` sets before stopping the actor: "the host did this". It is a flag,
  // not something the actor could infer — every other ending is the state losing interest.
  binding.hostStopping = true;
  actor.stop();
  await tick();

  assert.deepEqual(mock.aborts, [], "the durable run stays alive server-side, for restore to re-attach");
  assert.equal(mock.abandoned, true, "local consumption is still abandoned");
});

test("a failing abort is swallowed — there is no one left to report it to", async () => {
  const mock = new MockFlueClient();
  mock.abort = () => Promise.reject(new Error("harness gone"));
  const { actor, received } = harness(mock, baseInput);
  await tick();

  actor.send({ type: "CANCEL_RUN" });
  await tick();

  assert.ok(!received.some((e) => e.type === "agent.fault"), "the actor is stopped: nothing to fault");
});

test("the next turn on the same iid waits for the pending abort (continue: true — ADR-0024)", async () => {
  // Two states, one iid: exactly what `continue: true` produces. flue QUEUES per instance, so
  // an abort that lost this race would settle the SECOND submission before it ran — a silently
  // lost turn, the worst failure available.
  const mock = new MockFlueClient();
  mock.holdAborts = true;
  const table = new RegistrationTable();
  const input: AgentRunInput = { ...baseInput, instanceId: "inst-continue" };

  const machine = setup({
    actors: { run: agentActorWith(() => mock, { model: "test/model", instructions: "i" }) },
  }).createMachine({
    id: "parent",
    initial: "first",
    states: {
      first: { invoke: { id: "run", src: "run", input }, on: { NEXT: "second" } },
      second: { invoke: { id: "run", src: "run", input: { ...input, prompt: "and again" } } },
    },
  });
  attachVocabulary(machine, eventMap("test", [pingEvent]));
  const actor = createActor(machine);
  bindRun(actor.system, { runId: "run-1", workflow: "test", table });
  actor.start();
  await tick();
  assert.equal(mock.admits.length, 1);

  actor.send({ type: "NEXT" });
  await tick();

  assert.deepEqual(mock.aborts, [{ agentName: "coder", instanceId: "inst-continue" }]);
  assert.equal(mock.admits.length, 1, "the second turn is NOT admitted while its predecessor's abort is in flight");

  mock.releaseAborts();
  await tick();

  assert.equal(mock.admits.length, 2, "…and is admitted once the abort is recorded");
  assert.equal(mock.admits[1]!.prompt, "and again");
});

// ---- Notices (ADR-0062) -------------------------------------------------------------------------

test("each admission asks for the notices in ITS scope: a Menu-only Agent never hears a Workspace's", async () => {
  const takeFor =
    (asked: unknown[]): RunBinding["takeNotices"] =>
    (to) => (asked.push(to), { ids: [], notices: [] });

  // A continued Menu-only Agent on the Instance Harness: its conversation's notices, nothing else.
  const advisorAsked: unknown[] = [];
  harness(
    new MockFlueClient(),
    { ...baseInput, endpoint: undefined, instanceId: "run-1/root/coder", continuation: true },
    undefined,
    { model: "test/model", instructions: "i", workspace: "none" },
    { instanceHarness: "http://ih.test", takeNotices: takeFor(advisorAsked) },
  );
  await tick();
  assert.deepEqual(advisorAsked, [{ conversation: "run-1/root/coder" }]);

  // A FRESH Turn in a Workspace: the Workspace's notices, and no conversation's — a fresh
  // conversation is new by definition, and the notice waits for the `continue` that needs it.
  const coderAsked: unknown[] = [];
  harness(new MockFlueClient(), { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    takeNotices: takeFor(coderAsked),
  });
  await tick();
  assert.deepEqual(coderAsked, [{ workspace: "ws-7" }]);
});

test("an admission that fails releases its notices for the next one; a ledgered one delivers them", async () => {
  const released: Array<readonly string[]> = [];
  const delivered: Array<readonly string[] | undefined> = [];
  const notice = { kind: "memory-limit" as const, scope: "workspace" as const, agent: "coder", limit: "2Gi" };
  const binding: Partial<RunBinding> = {
    takeNotices: () => ({ ids: ["n1"], notices: [notice] }),
    releaseNotices: (ids) => released.push(ids),
    recordAdmission: (_iid, _admission, ids) => delivered.push(ids),
  };

  const failing = new MockFlueClient();
  failing.admit = () => Promise.reject(new Error("harness admission failed (400): bad cwd"));
  harness(failing, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, binding);
  await tick();
  assert.deepEqual(released, [["n1"]], "never reached a ledger, so it is pending again");

  const ok = new MockFlueClient();
  harness(ok, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, binding);
  await tick();
  assert.deepEqual(ok.notices, [[notice]], "the notices ride the admission");
  assert.deepEqual(delivered, [["n1"]], "and are delivered by the SAME ledger write");
});

test("a nudge takes no notices: it re-prompts the Turn that heard its own kill (ADR-0016, ADR-0062)", async () => {
  const notice = { kind: "memory-limit" as const, scope: "workspace" as const, agent: "coder", limit: "2Gi" };
  let takes = 0;
  const mock = new MockFlueClient();
  harness(mock, { ...baseInput, sandbox: "ws-7" }, undefined, undefined, {
    // Every take finds the notice pending — as one raised DURING the Turn would be.
    takeNotices: () => (takes++, { ids: ["n1"], notices: [notice] }),
  });
  await tick();
  assert.equal(takes, 1, "the Turn's own admission takes");

  mock.complete(); // no pick → the nudge
  await tick();
  assert.equal(mock.admits.length, 2);
  assert.equal(takes, 1, "the nudge does not take");
  assert.deepEqual(mock.notices[1], [], "…so it carries nothing, and the next Turn hears it");
});

test("a Turn the Orchestrator ends before its surface is read raises its notices again (ADR-0026, ADR-0062)", async () => {
  const kill = { kind: "memory-limit" as const, scope: "workspace" as const, agent: "coder", limit: "2Gi" };
  const lost = { kind: "conversation-new" as const, scope: "conversation" as const, reason: "a fault" };
  const run = () => {
    const raised: Array<{ notice: unknown; to: string }> = [];
    const mock = new MockFlueClient();
    let taken = false;
    const h = harness(
      mock,
      { ...baseInput, instanceId: "run-1/root/coder", continuation: true, sandbox: "ws-7" },
      undefined,
      undefined,
      {
        takeNotices: () =>
          taken ? { ids: [], notices: [] } : ((taken = true), { ids: ["n1", "n2"], notices: [lost, kill] }),
        raiseNotice: (notice, to) => raised.push({ notice, to }),
      },
    );
    return { h, mock, raised };
  };

  // Admitted and ledgered — but the state exits before the Harness reads the surface, so the
  // Harness finds it gone and settles the Submission `aborted` with no model asked (ADR-0026).
  const unread = run();
  await tick();
  assert.deepEqual(unread.mock.notices[0], [lost, kill]);
  unread.h.actor.send({ type: "CANCEL_RUN" });
  await tick();
  assert.deepEqual(
    unread.raised,
    [
      { notice: lost, to: "run-1/root/coder" },
      { notice: kill, to: "ws-7" },
    ],
    "no model heard them, so the next Turn in scope does",
  );

  // Read: the Harness had the Turn in hand, so the notices reached a model and stay delivered.
  const read = run();
  await tick();
  read.h.table.lookup(agentAddress("run-1/root/coder"))!.served!();
  read.h.actor.send({ type: "CANCEL_RUN" });
  await tick();
  assert.deepEqual(read.raised, []);
});
