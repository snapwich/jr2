// Shared test scaffolding: a RunHost + hono app wired with two tiny Machines, plus a J2Client bound to
// the app's `request` so the whole client/SSE path runs WITHOUT a socket (the same trick the
// orchestrator's own http tests use). No flue/MCP needed — these Machines are self-contained.
//
//   feed: working ─(emit "note")▶ notify ▶ done   (exercises replay + a mid-flight emit + terminal)
//   loop: working {}                              (stays active — exercises list / down-channel)
//   gated: review holds gate "review-1"           (exercises the gate-delivery down-channel)

import { emit, setup } from "xstate";
import { z } from "zod";
import { RunHost, SqliteSnapshotStore, createApp, defineEvent, j2Setup } from "@j2/orchestrator";
import { J2Client } from "../src/client.ts";

function feedMachine() {
  return setup({
    types: {} as {
      context: Record<string, never>;
      input: { instanceId: string };
      emitted: { type: "note"; message: string };
    },
  }).createMachine({
    id: "feed",
    context: {},
    initial: "working",
    states: {
      working: { after: { 25: { target: "notify", actions: emit({ type: "note", message: "hi" }) } } },
      notify: { after: { 5: { target: "done" } } },
      done: { type: "final" },
    },
  });
}

function loopMachine() {
  return setup({
    types: {} as { context: Record<string, never>; input: { instanceId: string } },
  }).createMachine({
    id: "loop",
    context: {},
    initial: "working",
    states: { working: {} },
  });
}

function gatedMachine() {
  const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });
  const requestChanges = defineEvent({
    name: "request_changes",
    audience: "external",
    input: z.object({ notes: z.string() }),
  });
  return j2Setup({
    types: {} as { context: Record<string, never>; input: { instanceId: string } },
    events: [approve, requestChanges],
  }).createMachine({
    id: "gated",
    context: {},
    initial: "review",
    states: {
      review: {
        invoke: { src: "gate", input: { gate: "review-1", meta: { title: "t" } } },
        on: { approve: "approved", request_changes: "changes" },
      },
      approved: { type: "final" },
      changes: {},
    },
  });
}

export type Harness = { host: RunHost; app: ReturnType<typeof createApp>; client: J2Client };

/** A fresh host (in-memory store) with `feed` + `loop` registered, plus a socket-free J2Client. */
export async function mkHarness(): Promise<Harness> {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  const host = new RunHost({ store });
  host.register({ name: "feed", machine: feedMachine(), provide: () => ({}) });
  host.register({ name: "loop", machine: loopMachine(), provide: () => ({}) });
  host.register({ name: "gated", machine: gatedMachine(), provide: () => ({}) });
  const app = createApp(host);
  const client = new J2Client("http://test", (url, init) => Promise.resolve(app.request(url, init)));
  return { host, app, client };
}
