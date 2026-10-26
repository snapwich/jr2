// The continue-after-signed-push claim (ADR-0067): after a signed push, a correct Agent continues
// its work on its branch and leaves the pushed commits as they are, so its next push publishes.
//
// `publish` enters a state that runs a SIGNED push from the Workspace's Sandbox Effector to the
// seed's push remote. The pick is outstanding while it runs; its answer is the push's output, and
// beside it the paragraph a signed push owes the Agent: its commits were re-created as signed
// copies with new ids, the branch was moved to them (or not, and why), the files did not change,
// and amending, rebasing or resetting the pushed commits makes the next push `diverged`. The prompt
// asks for two commits, each published, then `finish`. The measurement is the Machine's own record
// of the SECOND push: `pushed`. An Agent that "repairs" its branch after the ids changed — a reset to
// the old commits, an amend, a rebase — makes it `diverged`. A trial whose first push was not a
// signed push that published (the setup) is void; so is one whose only push already carried two or
// more commits from `main`, which the step reads on the push remote: the model chose its order
// before it read any post-push text (ADR-0066).
//
// The Effector runs in this module's own image (`images/effector`: git and ssh); its Repo Slot binds
// the seed's push remote over ssh, whose keys the scenario writes into its namespace (`jr2.config.ts`).
//
// Filename `continue-after-signed-push.ts` → workflow "continue-after-signed-push".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  push,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const publish = defineEvent({
  name: "publish",
  description: "Publish the commits on your branch to the team's remote. Its result is this call's answer.",
  input: z.object({}),
});
const finish = defineEvent({
  name: "finish",
  description: "Say the task is done.",
  input: z.object({ summary: z.string() }),
});

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
/** `pushes`: each push's outcome and the fields the step reads, in order. */
type PushRecord = { outcome: string; published?: string; source?: string; via?: string; sync?: string };
type BodyContext = BodyInput & { picks: string[]; pushes: PushRecord[]; fault?: string };

const record = (output: unknown): PushRecord => {
  const o = (output ?? {}) as Record<string, unknown>;
  const field = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {});
  return {
    outcome: String(o.outcome),
    ...field("published"),
    ...field("source"),
    ...field("via"),
    ...field("sync"),
  };
};

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [publish, finish],
  actors: { coder: agent(coder), signed: push({ sign: true }), fail: fail() },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [], pushes: [] }),
  initial: "work",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    work: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] In this repository, \`greet()\` in greet.js returns the wrong text and its ` +
            `tests fail. Fix \`greet()\` so the tests pass, commit the fix, and publish it. Then add a one-line ` +
            `comment above \`greet()\` that says what it returns, commit that as a second commit, and publish ` +
            `again. Then finish.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: { "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) } },
      initial: "ready",
      states: {
        ready: {
          on: {
            publish: {
              target: "publishing",
              actions: assign({ picks: ({ context }) => [...context.picks, "publish"] }),
            },
            finish: {
              target: "#body.finished",
              actions: assign({ picks: ({ context }) => [...context.picks, "finish"] }),
            },
          },
        },
        publishing: {
          invoke: {
            src: "signed",
            onDone: {
              target: "ready",
              actions: assign({ pushes: ({ context, event }) => [...context.pushes, record(event.output)] }),
            },
          },
        },
      },
    },
    finished: {
      type: "final",
      output: ({ context }) => ({ outcome: "finished", picks: context.picks, pushes: context.pushes }),
    },
    lost: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Sandbox was lost",
          detail: { outcome: "lost", picks: context.picks, pushes: context.pushes },
        }),
      },
    },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", picks: context.picks, pushes: context.pushes, reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
  spec: ({ input }) => ({ branch: `model-continue-${input.marker}` }),
  effector: { image: import.meta.resolve("../images/effector") },
});
