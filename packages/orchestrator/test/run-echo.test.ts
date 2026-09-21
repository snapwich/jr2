// The run-narrative echo tee (ADR-0023), orchestrator side, driven through a REAL RunHost with a
// real `workspace()` over a fake SandboxPort and a fake echo pusher at the `RunHostOptions.echo`
// seam. What is asserted: the backfilled preamble at workspace attach, the live tee thereafter,
// "markers, not mirrors" (a Turn hosted AT the echo's own target leaves no marker there; a
// remotely-hosted Turn leaves exactly its admission and its pick), the owning-run scope, and the
// fire-and-forget property — an unreachable echo target costs a log line and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "xstate";
import type { EchoEvent } from "../src/wire.ts";
import { doneEvent, requestReviewEvent } from "@jr2/agent-protocol";
import { jr2Setup } from "../src/setup.ts";
import { agentActorWith } from "../src/actor.ts";
import type { AgentRunInput } from "../src/actor.ts";
import { workspace, type SandboxPort, type WorkspaceSpec } from "../src/workspace.ts";
import { RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import { mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

/** A fake Sandbox backend whose endpoint is unique per Workspace — so two runs' echoes are
 * distinguishable by target, which is what the lineage test needs. */
class EchoSandbox implements SandboxPort {
  provisioned = new Map<string, { runId: string }>();
  leaseIntervalMs = 60_000;
  async provision(req: { name: string; runId: string; workflow: string }) {
    this.provisioned.set(req.name, { runId: req.runId });
    return { endpoint: `http://${req.name}.test`, identity: "pod-1" };
  }
  async attach(req: { name: string; spec: WorkspaceSpec; repos: Array<{ slot: string }> }) {
    const repos = Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}/${req.spec.branch}`]));
    return { repos };
  }
  async renew() {
    return { present: true as const, identity: "pod-1" };
  }
  async destroy() {}
  /** The echo target for one run's Workspace — derived the same way the endpoint was. */
  endpointOf(runId: string): string | undefined {
    for (const [name, rec] of this.provisioned) if (rec.runId === runId) return `http://${name}.test`;
    return undefined;
  }
}

/**
 * The workflow: a `workspace()` whose body runs a LOCAL turn (no endpoint — resolves the
 * enclosing Workspace's Harness ambiently), whose pick emits a note and hands off to a REMOTE
 * turn (explicit endpoint — the stub-path stand-in for an Instance-Harness-hosted decisioner),
 * whose pick finishes the run. The port factory is baked into the body's own actors (an inline-
 * invoked machine is out of `provide()`'s reach), one client for every turn — a test tells the
 * turns apart by the Agent each minted iid names (ADR-0057).
 */
function echoDef(client: MockFlueClient): WorkflowDef {
  const body = jr2Setup({
    types: {} as {
      context: { tag: string };
      input: { tag?: string; workspace: { branch: string } };
      emitted: { type: "note"; message: string };
    },
    events: [doneEvent, requestReviewEvent],
    // TWO Agent slots, one port: the body carries both personas itself (ADR-0049), which is also
    // what lets the two turns be told apart by name on the feed.
    actors: {
      coder: agentActorWith(() => client, { model: "test/model", instructions: "code" }),
      decider: agentActorWith(() => client, { model: "test/model", instructions: "decide" }),
    },
  }).createMachine({
    id: "body",
    context: ({ input }) => ({ tag: input.tag ?? "solo" }),
    initial: "local",
    states: {
      local: {
        invoke: { src: "coder", input: { prompt: "code it" } },
        on: {
          request_review: {
            target: "remote",
            actions: emit(({ context }) => ({ type: "note" as const, message: `review for ${context.tag}` })),
          },
        },
      },
      remote: {
        invoke: {
          src: "decider",
          input: { endpoint: "http://decider.test", prompt: "approve or not" },
        },
        on: { done: "finished" },
      },
      finished: { type: "final" },
    },
  });
  const wrapped = workspace(body, {
    repos: { app: "https://example.test/app.git" },
    spec: () => ({ branch: "feat-1" }),
  });
  return { name: "echoed", machine: wrapped, provide: () => ({}) };
}

/** One run's admits: every minted iid is run-scoped by construction (ADR-0057), so the run id is
 * the prefix — no fixture has to invent one. */
const admitsOf = (client: MockFlueClient, runId: string): AgentRunInput[] =>
  client.admits.filter((a) => a.instanceId.startsWith(`${runId}/`));

/** The live iid of one run's Turn on the named Agent — the address a delivery goes to. */
const iidOf = (client: MockFlueClient, runId: string, agentName: string): string =>
  admitsOf(client, runId)
    .filter((a) => a.agentName === agentName)
    .at(-1)!.instanceId;

type Push = { endpoint: string; events: EchoEvent[] };

/** A fake echo server at the factory seam: records pushes, optionally refusing every one. */
function fakeEcho(opts: { down?: boolean } = {}) {
  const pushes: Push[] = [];
  const factory = (endpoint: string) => async (events: EchoEvent[]) => {
    if (opts.down) throw new Error("connect ECONNREFUSED (the Workspace pod is gone)");
    pushes.push({ endpoint, events });
  };
  const flat = () => pushes.flatMap((p) => p.events);
  return { pushes, flat, factory };
}

test("tee + backfill: the Workspace's log opens with the preamble, then follows the run live", async () => {
  const client = new MockFlueClient();
  const { pushes, flat, factory } = fakeEcho();
  const sandbox = new EchoSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox, echo: factory });
  host.register(echoDef(client));

  const feed: RunFeedEvent[] = [];
  const { runId } = await host.start("echoed");
  host.subscribe(runId, (e) => feed.push(e));
  await waitFor(() => pushes.length > 0);

  // The backfilled preamble (ADR-0023): the first push replays the feed-so-far — the run's walk
  // to this point (provisioning/attaching happened BEFORE the Workspace's Harness existed).
  const target = sandbox.endpointOf(runId)!;
  assert.equal(pushes[0]!.endpoint, target);
  assert.ok(
    pushes[0]!.events.some((e) => e.kind === "status" && JSON.stringify(e.value).includes("provisioning")),
    "the preamble reaches back to before the Workspace existed",
  );

  // The LOCAL turn runs on this Workspace's own Harness: its transcript prints there, so its
  // markers ride the FEED but never the echo — markers, not mirrors.
  await waitFor(() => admitsOf(client, runId).length === 1);
  await waitFor(() => feed.some((e) => e.kind === "admission" && e.agent === "coder"));
  const localAdmission = feed.find((e) => e.kind === "admission" && e.agent === "coder");
  assert.equal(localAdmission?.kind === "admission" ? localAdmission.endpoint : undefined, target);

  host.sendToAgent(iidOf(client, runId, "coder"), { type: "request_review", summary: "PR up" });

  // The pick moved the run: the Emit (payload included — instance-gated wire) and the status
  // delta tee live; the local turn's admission/pick markers do not.
  await waitFor(() => flat().some((e) => e.kind === "emit"));
  const note = flat().find((e) => e.kind === "emit");
  assert.deepEqual(note?.kind === "emit" ? note.event : undefined, { type: "note", message: "review for solo" });
  // The delta that says where the run now stands lives in the CHILD tree — the wrapper's own
  // value stays "running" while the body moves, which is why the echo status carries children.
  assert.ok(flat().some((e) => e.kind === "status" && JSON.stringify(e.children ?? []).includes("remote")));
  assert.ok(!flat().some((e) => e.kind === "admission" && e.agent === "coder"));
  assert.ok(!flat().some((e) => e.kind === "pick" && e.agent === "coder"));

  // The REMOTE turn (hosted elsewhere) echoes exactly two narrative lines: its admission (agent +
  // framing) and its settlement pick — never a transcript, which the echo cannot even carry.
  await waitFor(() => admitsOf(client, runId).length === 2);
  await waitFor(() => flat().some((e) => e.kind === "admission" && e.agent === "decider"));
  const admission = flat().find((e) => e.kind === "admission" && e.agent === "decider");
  assert.deepEqual(admission, { kind: "admission", agent: "decider", prompt: "approve or not" });

  host.sendToAgent(iidOf(client, runId, "decider"), { type: "done", summary: "ship it" });
  await waitFor(() => flat().some((e) => e.kind === "pick" && e.agent === "decider"));
  const pick = flat().find((e) => e.kind === "pick" && e.agent === "decider");
  assert.deepEqual(pick, { kind: "pick", agent: "decider", event: "done", payload: { summary: "ship it" } });

  // Projection sanity: nothing the wire does not speak leaks through — no endpoints, no context.
  for (const e of flat()) {
    assert.ok(!("endpoint" in e), "the hosting endpoint is tee routing, not narrative");
    assert.ok(!("context" in e) && !("runId" in e), "a status sheds everything but status + value");
  }

  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "done");
});

test("lineage: a Workspace's echo carries its OWNING run's feed only — never a sibling run's", async () => {
  const client = new MockFlueClient();
  const { pushes, factory } = fakeEcho();
  const sandbox = new EchoSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox, echo: factory });
  host.register(echoDef(client));

  const a = await host.start("echoed", { tag: "A" });
  const b = await host.start("echoed", { tag: "B" });
  for (const run of [a, b]) {
    await waitFor(() => admitsOf(client, run.runId).length === 1);
    host.sendToAgent(iidOf(client, run.runId, "coder"), { type: "request_review", summary: "up" });
  }
  await waitFor(() =>
    [a, b].every((run) =>
      pushes.some(
        (p) =>
          p.endpoint === sandbox.endpointOf(run.runId) &&
          p.events.some((e) => e.kind === "emit" && e.event.type === "note"),
      ),
    ),
  );

  for (const [run, tag] of [
    [a, "A"],
    [b, "B"],
  ] as const) {
    const notes = pushes
      .filter((p) => p.endpoint === sandbox.endpointOf(run.runId))
      .flatMap((p) => p.events)
      .filter((e) => e.kind === "emit");
    assert.ok(notes.length > 0);
    for (const e of notes) assert.deepEqual(e.event, { type: "note", message: `review for ${tag}` });
  }
});

test("fire-and-forget: the echo target down costs one log line — the run is untouched", async (t) => {
  const client = new MockFlueClient();
  const { factory } = fakeEcho({ down: true });
  const host = new RunHost({ store: await mkStore(), sandbox: new EchoSandbox(), echo: factory });
  host.register(echoDef(client));
  const logged = t.mock.method(console, "error", () => {});

  const { runId } = await host.start("echoed");
  await waitFor(() => admitsOf(client, runId).length === 1);
  host.sendToAgent(iidOf(client, runId, "coder"), { type: "request_review", summary: "up" });
  await waitFor(() => admitsOf(client, runId).length === 2);
  host.sendToAgent(iidOf(client, runId, "decider"), { type: "done" });

  // The run settles `done` — no fault, no stall — while every push was refused.
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.equal(final?.fault, undefined);
  // Log-and-continue, at most: ONE line for the whole attachment, not one per event.
  await waitFor(() => logged.mock.callCount() > 0);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /echo to http:\/\/ws-.+failed \(log only/);
});

test("a host with no echo factory runs identically — the echo is a courtesy, never a dependency", async () => {
  const client = new MockFlueClient();
  const host = new RunHost({ store: await mkStore(), sandbox: new EchoSandbox() }); // no `echo`
  host.register(echoDef(client));
  const { runId } = await host.start("echoed");
  await waitFor(() => admitsOf(client, runId).length === 1);
  host.sendToAgent(iidOf(client, runId, "coder"), { type: "request_review", summary: "up" });
  await waitFor(() => admitsOf(client, runId).length === 2);
  host.sendToAgent(iidOf(client, runId, "decider"), { type: "done" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "done");
});
