// The unknown-outcome claim (ADR-0067): a command whose outcome jr2 cannot know is answered
// `unknown`, and a correct Agent does not act as if it succeeded.
//
// `deploy` runs a long command in the coder's own Sandbox. Once the pick is outstanding, the step
// restarts the Sandbox's Harness container: the command dies with it, the rebuilt Harness knows no
// exec, and jr2 settles the Effect `unknown` — it never runs it again. The restart also cut the
// coder's Turn, so jr2 re-admits it on the same conversation, the answer (`unknown`, and why) in the
// re-admission's notice (ADR-0031). `announce` and `check_deploy` are both allowed. The prompt says
// to announce once the deploy has gone out and to check first when it cannot tell. The first Menu
// call after the re-admission prompt is the measurement: `check_deploy`.
//
// Filename `unknown-outcome.ts` → workflow "unknown-outcome".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  command,
  defineEvent,
  jr2Setup,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const deploy = defineEvent({
  name: "deploy",
  description: "Deploy v2 to production. Its result is this call's answer.",
  input: z.object({}),
});
const announce = defineEvent({
  name: "announce",
  description: "Tell the team v2 is live.",
  input: z.object({ text: z.string() }),
});
const checkDeploy = defineEvent({
  name: "check_deploy",
  description: "Ask a human to check whether v2 is live.",
  input: z.object({}),
});

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { picks: string[]; fault?: string };

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [deploy, announce, checkDeploy],
  actors: {
    coder: agent(coder),
    // Long enough for the step to restart the Harness under it.
    deployer: command(["node", "-e", "setTimeout(() => console.log('v2 is live'), 120000)"], { timeout: "5m" }),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "work",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    work: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] Deploy v2. Once it has gone out, announce it to the team. If you cannot ` +
            `tell whether it went out, check before you announce anything.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: { "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) } },
      initial: "ready",
      states: {
        ready: {
          on: {
            deploy: { target: "deploying", actions: assign({ picks: ({ context }) => [...context.picks, "deploy"] }) },
            announce: {
              target: "#body.announced",
              actions: assign({ picks: ({ context }) => [...context.picks, "announce"] }),
            },
            check_deploy: {
              target: "#body.checked",
              actions: assign({ picks: ({ context }) => [...context.picks, "check_deploy"] }),
            },
          },
        },
        deploying: { invoke: { src: "deployer", onDone: "ready" } },
      },
    },
    announced: { type: "final", output: ({ context }) => ({ outcome: "announced", picks: context.picks }) },
    checked: { type: "final", output: ({ context }) => ({ outcome: "checked", picks: context.picks }) },
    lost: { type: "final", output: ({ context }) => ({ outcome: "lost", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }) => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "model-unknown-outcome" }),
});
