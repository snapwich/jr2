// The rig of the cause tests (ADR-0024, `cause.ts`): a run of one workflow whose Agent slots each get
// one `MockFlueClient`, so a test reads the sweeps each Agent's client got — their causes, and the
// Submission each names.

import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { RunHost } from "../src/run-host.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

export const ev = (name: string) => defineEvent({ name, input: z.object({}) });
export const endpoint = "http://harness.invalid";
export const reviewerDefinition = { ...coderDefinition, name: "reviewer" } as typeof coderDefinition;
export const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Agents = Record<string, ReturnType<typeof agentActorWith>>;

/** Each sweep's cause, in order: `pick`, or `none`. */
export const causesOf = (client: MockFlueClient) => client.aborts.map((a) => a.cause ?? "none");

/** A run of one workflow whose Agent slots get one `MockFlueClient` each, built by `machineOf`. */
export async function rig(
  slots: Record<string, typeof coderDefinition>,
  machineOf: (agents: Agents) => AnyStateMachine,
) {
  const clients: Record<string, MockFlueClient[]> = Object.fromEntries(Object.keys(slots).map((k) => [k, []]));
  const agents = (made?: (slot: string) => MockFlueClient): Agents =>
    Object.fromEntries(
      Object.entries(slots).map(([slot, def]) => [
        slot,
        agentActorWith(() => made?.(slot) ?? new MockFlueClient(), def),
      ]),
    );
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "cause",
    machine: machineOf(agents()),
    provide: () => {
      const made: Record<string, MockFlueClient> = {};
      for (const slot of Object.keys(slots)) clients[slot]!.push((made[slot] = new MockFlueClient()));
      return {
        actors: machineOf(agents((slot) => made[slot]!)).implementations.actors as Record<string, AnyActorLogic>,
      };
    },
  });
  const { runId } = await host.start("cause");
  const first = Object.keys(slots)[0]!;
  await waitFor(() => clients[first]![0]?.admits.length === 1);
  const of = (slot: string) => clients[slot]![0]!;
  const iid = (slot: string) => of(slot).admits.at(-1)!.instanceId;
  const causes = (slot: string) => causesOf(of(slot));
  /** The Submission each sweep named, in order. */
  const subs = (slot: string) => of(slot).abortSubmissions;
  return { host, runId, of, iid, causes, subs, clients };
}
