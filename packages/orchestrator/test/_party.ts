// A RunHost per test for the party claims (ADR-0015, ADR-0029): in-process and socket-free. Each
// Agent slot is a MockFlueClient (no model, no Harness). Picks go through `RunHost.sendToAgent`
// (what `POST /agents/:iid/events` calls), Gate answers through `RunHost.sendToGate`, and the HTTP
// answers through `createApp(host)`.

import assert from "node:assert/strict";
import type { AnyStateMachine } from "xstate";
import { agentActorWith, type AgentLogic } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { createApp } from "../src/http.ts";
import { RunHost, type RunFeedEvent, type WorkflowDef } from "../src/run-host.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { admittedIid, coderDefinition, mkStore, MockFlueClient } from "./_fixtures.ts";

const reviewer: AgentDefinition = { model: "test/model", instructions: "you are the test reviewer" };
const definitionOf = (slot: string): AgentDefinition => (slot === "reviewer" ? reviewer : coderDefinition);

/** An Agent slot for a Machine's build; each run gets its own client through `provide`. */
export const placeholder = (slot: string): AgentLogic => agentActorWith(() => new MockFlueClient(), definitionOf(slot));

export type Slots = Record<string, AgentLogic>;
export type Build = (slots: Slots) => AnyStateMachine;

/** The context a party Machine records: which writings ran, in order, and the last event an action
 * read — so a test reads WHICH writing ran and what the author saw. */
export type Ran = { ran: string[]; last?: unknown };

/** A host serving one Machine as workflow "wf", its slots fresh MockFlueClients per run. */
export async function partyHost(build: Build, slots: string[] = ["coder"], store?: SnapshotStore) {
  const s = store ?? (await mkStore());
  const runs = new Map<string, Record<string, MockFlueClient>>();
  const def: WorkflowDef = {
    name: "wf",
    machine: build(Object.fromEntries(slots.map((slot) => [slot, placeholder(slot)]))),
    provide: ({ instanceId }) => {
      const clients: Record<string, MockFlueClient> = {};
      const actors: Slots = {};
      for (const slot of slots) {
        const client = new MockFlueClient();
        clients[slot] = client;
        actors[slot] = agentActorWith(() => client, definitionOf(slot));
      }
      runs.set(instanceId, clients);
      return { actors };
    },
  };
  const host = new RunHost({ store: s });
  host.register(def);
  const feed: RunFeedEvent[] = [];
  const handle = (runId: string) => {
    const value = async (): Promise<string> => JSON.stringify((await host.read(runId))?.value);
    const context = async (): Promise<Ran> => (await host.read(runId))?.context as Ran;
    const until = async (expected: unknown): Promise<void> => {
      const want = JSON.stringify(expected);
      for (let i = 0; i < 200; i++) {
        if ((await value()) === want) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail(`run never reached ${want}; it is ${await value()}`);
    };
    return { runId, value, context, until };
  };
  const start = async () => {
    const { runId, instanceId } = await host.start("wf");
    host.subscribe(runId, (event) => feed.push(event));
    const clients = runs.get(instanceId)!;
    const iids: Record<string, string> = {};
    for (const slot of slots) iids[slot] = await admittedIid(clients[slot]!);
    return { ...handle(runId), iids, clients };
  };
  /** A run's open Gates as `GET /runs/:id` lists them: names only. */
  const gateNow = (runId: string) =>
    host.gates(runId).map((g) => ({ gate: g.gate, accepts: g.accepts.map((a) => a.name), acceptsNow: g.acceptsNow }));
  return { host, store: s, start, handle, feed, gateNow, app: createApp(host), machine: def.machine };
}

/** A receipt's three facts the Harness reads to pick its prose (ADR-0029). */
export const receipt = (r: { moved: boolean; turnComplete: boolean; allowed: string[] }) => ({
  moved: r.moved,
  turnComplete: r.turnComplete,
  allowed: r.allowed,
});

/** POST a JSON body to the app, as a client would. */
export const post = (app: ReturnType<typeof createApp>, path: string, body: object) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
