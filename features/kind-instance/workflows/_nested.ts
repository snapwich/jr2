// The kind tier's nested Workspaces (ADR-0012): a parent `workspace()` whose body invokes a child
// `workspace()` from one state. No Agent and no Repo Slot: the child's step is a command Effect in
// its own `/work`, which prints its pod's hostname, and a Sandbox's pod has the Sandbox's name.
//
//   parent  reviewing  invokes `child` with round 1. In mode "rounds", when the child ends, the
//                      parent enters the state again and invokes it with round 2: the same state,
//                      so the same actor path and the same Sandbox name. In mode "leave", the Gate
//                      `leave` takes the parent to `left` while the child runs.
//           left       not final: the run goes on, with the parent's Sandbox, until a cancel
//   child   running    prints "child round <n> on <hostname>", then sleeps
//
// `_`-prefixed, so workflow discovery skips it: `nested.ts` and `pooled.ts` register it.

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
} from "@jr2/orchestrator";

const leave = defineEvent({ name: "leave", input: z.object({}) });

const tailOf = (output: CommandOutput): string =>
  "tail" in output && typeof output.tail === "string" ? output.tail : JSON.stringify(output);

// --- the child ---------------------------------------------------------------------------------

const childDoor = z.object({ round: z.string(), sleep: z.string() });
type ChildInput = Workspaced<z.infer<typeof childDoor>, never>;
type ChildContext = ChildInput & { tail?: string };

const CHILD = 'echo "child round $1 on $(hostname)"; sleep "$2"';

const childBody = jr2Setup({
  types: {} as { context: ChildContext; input: ChildInput; output: { round: string; tail?: string } },
  actors: {
    run: command(["sh", "-c", CHILD, "sh", arg("round"), arg("sleep")], { timeout: "15m" }),
    fail: fail(),
  },
}).createMachine({
  id: "nested-child",
  context: ({ input }) => input,
  initial: "running",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    running: {
      invoke: {
        src: "run",
        input: ({ context }) => ({ round: context.round, sleep: context.sleep }),
        onDone: { target: "ran", actions: assign({ tail: ({ event }) => tailOf(event.output) }) },
      },
    },
    ran: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the child's Sandbox was lost" } } },
  },
  output: ({ context }) => ({ round: context.round, tail: context.tail }),
});

const child = workspace(childBody, { input: childDoor });

// --- the parent --------------------------------------------------------------------------------

const parentDoor = z.object({ mode: z.enum(["rounds", "leave"]), sleep: z.string() });
type ParentInput = Workspaced<HostInjectedInput & z.infer<typeof parentDoor>, never>;
type ParentContext = ParentInput & { round: number; tails: string[]; error?: string };

const parentBody = jr2Setup({
  types: {} as { context: ParentContext; input: ParentInput; output: { tails: string[]; error?: string } },
  events: [leave],
  actors: { child, fail: fail() },
}).createMachine({
  id: "nested-parent",
  context: ({ input }) => ({ ...input, round: 1, tails: [] }),
  initial: "reviewing",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    reviewing: {
      invoke: [
        {
          src: "child",
          input: ({ context }) => ({ round: String(context.round), sleep: context.sleep }),
          onDone: [
            {
              guard: ({ context }) => context.mode === "rounds" && context.round < 2,
              target: "reviewing",
              reenter: true,
              actions: assign({
                round: ({ context }) => context.round + 1,
                tails: ({ context, event }) => [...context.tails, event.output.tail ?? ""],
              }),
            },
            {
              target: "done",
              actions: assign({ tails: ({ context, event }) => [...context.tails, event.output.tail ?? ""] }),
            },
          ],
          onError: {
            target: "childFailed",
            actions: assign({ error: ({ event }) => String((event.error as Error)?.message ?? event.error) }),
          },
        },
        { id: "leave", src: "gate" },
      ],
      on: { leave: { guard: ({ context }) => context.mode === "leave", target: "left" } },
    },
    left: {},
    done: { type: "final" },
    childFailed: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the parent's Sandbox was lost" } } },
  },
  output: ({ context }) => ({ tails: context.tails, ...(context.error !== undefined ? { error: context.error } : {}) }),
});

export const parent = workspace(parentBody, { input: parentDoor });
