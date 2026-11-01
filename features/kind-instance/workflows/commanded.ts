// The kind tier's COMMAND workflow (ADR-0067): a `command` Effect in a real Sandbox, with no Agent.
// One body, four commands, one picked by the run's `mode`; the body's final output IS the
// command's output, and the wrapper forwards it, so a scenario reads what the Machine routed on.
//
//   exit     `node -e process.exit(<code>)`  — the exit code is output, and the Machine routes on it
//   argv     prints its own argv as JSON      — a shell metacharacter stays inside its one argument
//   timeout  never ends, a 3s timeout        — the Harness kills the process group: `timeout`
//   restart  counts its runs in a file, then waits 20s and prints the count — an Orchestrator
//            restart in the middle gives one run, re-attached by id
//
// `node` is the image's own (images/default carries it); the cwd is the Worktree the input names.

import { z } from "zod";
import { assign } from "xstate";
import {
  arg,
  command,
  defineEvent,
  fail,
  jr2Setup,
  workspace,
  type CommandOutput,
  type HostInjectedInput,
  type Workspaced,
  isReady,
  worktree,
} from "@jr2/orchestrator";

type Door = { mode: "exit" | "argv" | "timeout" | "restart"; code?: string; text?: string };
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { output?: CommandOutput };

// A Machine with no Agent still declares a vocabulary; this one is never sent.
const unused = defineEvent({ name: "noop", input: z.object({}) });

const COUNT_THEN_WAIT =
  `const fs=require("fs");fs.appendFileSync(".jr2-e2e-runs","x");` +
  `setTimeout(()=>console.log(fs.readFileSync(".jr2-e2e-runs","utf8")),20000)`;

export const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: CommandOutput | { outcome: "none" } },
  events: [unused],
  actors: {
    cut: worktree(),
    fail: fail(),
    exit: command(["node", "-e", "process.exit(Number(process.argv[1]))", arg("code")]),
    argv: command(["node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", arg("text")]),
    timeout: command(["node", "-e", "setInterval(()=>{},1000)"], { timeout: "3s" }),
    restart: command(["node", "-e", COUNT_THEN_WAIT], { timeout: "2m" }),
  },
}).createMachine({
  id: "commanded",
  context: ({ input }) => input,
  initial: "cutting",
  on: { "workspace.lost": { target: ".lost" }, noop: ".settled" },
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: { path: "/work/app/feat-e2e-command", branch: "feat-e2e-command" },
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "choosing" }, { target: "notCut" }],
      },
    },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    choosing: {
      always: [
        { guard: ({ context }) => context.mode === "exit", target: "exit" },
        { guard: ({ context }) => context.mode === "argv", target: "argv" },
        { guard: ({ context }) => context.mode === "timeout", target: "timeout" },
        { target: "restart" },
      ],
    },
    exit: {
      invoke: {
        src: "exit",
        input: ({ context }) => ({ worktree: "/work/app/feat-e2e-command", code: context.code ?? "0" }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    argv: {
      invoke: {
        src: "argv",
        input: ({ context }) => ({ worktree: "/work/app/feat-e2e-command", text: context.text ?? "" }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    timeout: {
      invoke: {
        src: "timeout",
        input: ({ context }) => ({ worktree: "/work/app/feat-e2e-command" }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    restart: {
      invoke: {
        src: "restart",
        input: ({ context }) => ({ worktree: "/work/app/feat-e2e-command" }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
  output: ({ context }) => context.output ?? { outcome: "none" },
});

export const machine = workspace(body, {
  input: z.object({
    mode: z.enum(["exit", "argv", "timeout", "restart"]),
    code: z.string().optional(),
    text: z.string().optional(),
  }),
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
});
