// The body of the project-context workflows (`contexted`, `contexted-shared`; ADR-0062): it cuts a
// Worktree, has a command put context files where the walk can meet them, and then starts ONE
// Agent there, whose first provider request the scenario reads. The files come from the command,
// not from the seed Repo: the seed is shared by every @kind scenario, and three of the files are
// outside any Repo (`/work/AGENTS.md`, `/work/app/AGENTS.md`, `~/.pi/agent/AGENTS.md`).
//
//   /work/app/ctx/CLAUDE.md                   the Worktree's own rules            read: always
//   /work/app/ctx/AGENTS.md -> /run/jr2/…     a link to the control Stand-in      read: never (no text)
//   /work/app/ctx/.pi/skills/ctx-skill/       a skill of the Worktree             listed: always
//   /work/app/AGENTS.md                       the slot's folder                   read: under "workspace"
//   /work/AGENTS.md                           the Workspace's folder              read: under "workspace"
//   $HOME/.pi/agent/AGENTS.md                 jr2's fallback home (ADR-0037)      read: never
//
// pi reads the first name of each folder that it can read, so the Worktree's CLAUDE.md is read
// only because its AGENTS.md (a link into /run/jr2) cannot be. The command prints where it wrote
// the home file: the domain writes the home, as every Agent of the Workspace can.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  command,
  defineEvent,
  fail,
  isReady,
  jr2Setup,
  worktree,
  type CommandOutput,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

/** The Worktree the reader works in. */
export const CONTEXT_WORKTREE = "/work/app/ctx";

const SEED = [
  "printf '%s\\n' 'CTX-WORKTREE-RULE' > CLAUDE.md",
  "ln -s /run/jr2/control/standin AGENTS.md",
  "mkdir -p .pi/skills/ctx-skill",
  "printf '%s\\n' '---' 'name: ctx-skill' 'description: CTX-SKILL-DESC' '---' 'The steps.' > .pi/skills/ctx-skill/SKILL.md",
  "printf '%s\\n' 'CTX-SLOT-RULE' > /work/app/AGENTS.md",
  "printf '%s\\n' 'CTX-WORK-RULE' > /work/AGENTS.md",
  'mkdir -p "$HOME/.pi/agent"',
  "printf '%s\\n' 'CTX-HOME-RULE' > \"$HOME/.pi/agent/AGENTS.md\"",
  'echo "home-written:$HOME/.pi/agent/AGENTS.md"',
].join("\n");

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

type BodyInput = Workspaced<HostInjectedInput, "app">;
type BodyContext = BodyInput & { seeded?: CommandOutput; fault?: string };

const seededOk = (output: CommandOutput): boolean =>
  "outcome" in output && output.outcome === "exited" && output.code === 0;

export const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [finish],
  actors: { cut: worktree(), seed: command(["sh", "-ec", SEED]), reader: agent(coder), fail: fail() },
}).createMachine({
  id: "contexted",
  context: ({ input }) => input,
  initial: "cutting",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: { path: CONTEXT_WORKTREE, branch: "ctx-e2e" },
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "seeding" }, { target: "notCut" }],
      },
    },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    seeding: {
      invoke: {
        src: "seed",
        input: { worktree: CONTEXT_WORKTREE },
        onDone: [
          {
            guard: ({ event }) => seededOk(event.output),
            target: "reading",
            actions: assign({ seeded: ({ event }) => event.output }),
          },
          { target: "notSeeded", actions: assign({ seeded: ({ event }) => event.output }) },
        ],
      },
    },
    notSeeded: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({ reason: "the context files were not written", detail: { seeded: context.seeded } }),
      },
    },
    reading: {
      invoke: {
        src: "reader",
        // A continued conversation, so its id is `<runId>/body/reader` (ADR-0057).
        input: () => ({ cwd: CONTEXT_WORKTREE, prompt: "read the rules", continue: true }),
      },
      on: {
        finish: { target: "finished" },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    finished: { type: "final", output: ({ context }) => ({ outcome: "finished", seeded: context.seeded }) },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({ reason: "the reader's Turn could not go on", detail: { fault: context.fault } }),
      },
    },
  },
  output: ({ event }) => (event as { output?: unknown }).output,
});
