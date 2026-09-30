// The notice claim (ADR-0061/0062): the Harness's guard kills the Agent's processes at the memory
// limit during a Turn, and the NEXT Turn in that Workspace is told so — once, in the Briefing's
// Turn part. Two coder Turns on one conversation. The first starts a server in the background and
// picks `started`; while it runs, the STEP trips the memory guard from outside (the kill is the
// tier's, not the model's — a real model cannot be told to exhaust memory and also be measured).
// The second Turn asks whether that server still answers, and its `report` is the measurement: an
// Agent working blind says yes from memory; one that read the notice checks, or says no. Then a
// Gate, so the step can probe the pod for the truth before the Sandbox goes.
//
// Filename `noticed.ts` → workflow "noticed".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

/** The port every trial's server listens on — the step probes it, so it is the Machine's word. */
export const SERVER_PORT = 8765;

const started = defineEvent({
  name: "started",
  description: "The server is up and answering. Say how you started it.",
  audience: "agent",
  input: z.object({ how: z.string() }),
});
const report = defineEvent({
  name: "report",
  description: "Whether the server you started is still answering, and how you know.",
  audience: "agent",
  input: z.object({ running: z.boolean(), how: z.string() }),
});
const done = defineEvent({ name: "done", audience: "external", input: z.object({}) });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off") });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { running?: boolean; how?: string; fault?: string };

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [started, report, done],
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "starting",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    starting: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          // The command is GIVEN: the claim is about the next Turn, and the image is node:24-slim
          // — a model left to choose reached for `nc`, which the image has not got, in a loop that
          // held the bash tool's pipe open until the Turn timed out (the first run of this tier).
          prompt:
            `Start a small HTTP server on port ${SERVER_PORT} in the background, so that it keeps running ` +
            `after your command returns. Use exactly this command:\n\n` +
            `setsid nohup node -e 'require("http").createServer((q, s) => s.end("ok")).listen(${SERVER_PORT})' ` +
            `> /dev/null 2>&1 &\n\nThen confirm it answers (for example with \`node -e 'fetch("http://localhost:${SERVER_PORT}").then(r => r.text()).then(console.log)'\`; the image has no curl) ` +
            `and call \`started\`.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        started: { target: "asking" },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    asking: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          // Deliberately does not say "check": whether the model checks is the measurement.
          prompt: `Is the server you started on port ${SERVER_PORT} still answering? Call \`report\`.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        report: {
          target: "inspecting",
          actions: assign({ running: ({ event }) => event.running, how: ({ event }) => event.how }),
        },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    // The inspection window: the step asks the pod whether the port answers, compares, sends `done`.
    inspecting: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: { port: SERVER_PORT, running: context.running, how: context.how },
        }),
      },
      on: { done: { target: "finished" } },
    },
    finished: { type: "final", output: { outcome: "finished" } },
    lost: { type: "final", output: { outcome: "lost" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "model-e2e" }),
});
