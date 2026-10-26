// The chain-answer claim (ADR-0024): a pick that runs work inside the Agent's state is answered at
// Rest, and the answer is the LAST reply since the pick. A correct Agent acts on that reply.
//
// `run_checks` enters a chain of two child Machines below the Agent's state: `lint`, which passes,
// then `licence`, which fails and says why. The pick is outstanding through both — no false Rest
// between the links — and its answer is `licence`'s output alone, with the Allowed picks read after
// the route back to `ready`: `release` and `hold`, neither guarded. The prompt says to release if
// the checks pass and to hold if they do not; it says nothing about which check matters. So the
// first Menu call after `run_checks` is the measurement: `hold`. An Agent that reads only that the
// work ran, or the first link, releases.
//
// Filename `chain-answer.ts` → workflow "chain-answer".

import { z } from "zod";
import { assign, createMachine } from "xstate";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const runChecks = defineEvent({
  name: "run_checks",
  description: "Run the release checks. Their result is this call's answer.",
  input: z.object({}),
});
const release = defineEvent({
  name: "release",
  description: "Release v2.3.",
  input: z.object({ notes: z.string() }),
});
const hold = defineEvent({
  name: "hold",
  description: "Hold the release, and say why.",
  input: z.object({ reason: z.string() }),
});

/** A check that takes a moment and ends with its verdict: a child Machine (no Effect exists yet). */
const check = (output: Record<string, unknown>) =>
  createMachine({
    initial: "running",
    states: { running: { after: { 1500: "done" } }, done: { type: "final" } },
    output: () => output,
  });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type Input = z.infer<typeof door> & HostInjectedInput;
/** `picks`: every pick the Machine took, in order. */
type Ctx = Input & { picks: string[]; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [runChecks, release, hold],
  actors: {
    fail: fail(),
    advisor: agent(advisor),
    lint: check({ check: "lint", passed: true }),
    licence: check({
      check: "licence",
      passed: false,
      reason: "left-pad-gpl@1.0.0 is GPL-3.0, not allowed in this product",
    }),
  },
}).createMachine({
  id: "chain-answer",
  input: door,
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "releasing",
  states: {
    releasing: {
      invoke: {
        src: "advisor",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] v2.3 is ready to go out. Run the release checks first. If they pass, ` +
            `release it; if they do not, hold it and say why.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
      initial: "ready",
      states: {
        ready: {
          on: {
            run_checks: {
              target: "linting",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_checks"] }),
            },
            release: {
              target: "#chain-answer.released",
              actions: assign({ picks: ({ context }) => [...context.picks, "release"] }),
            },
            hold: {
              target: "#chain-answer.held",
              actions: assign({ picks: ({ context }) => [...context.picks, "hold"] }),
            },
          },
        },
        linting: { invoke: { src: "lint", onDone: "licensing" } },
        licensing: { invoke: { src: "licence", onDone: "ready" } },
      },
    },
    released: { type: "final", output: ({ context }) => ({ outcome: "released", picks: context.picks }) },
    held: { type: "final", output: ({ context }) => ({ outcome: "held", picks: context.picks }) },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", picks: context.picks, reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
