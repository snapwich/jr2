// The party scenarios (ADR-0015, ADR-0029) as real jr2 Machines. Each writing that runs records a
// name in `context.ran`, so a test reads WHICH writing ran. `marked` adds the author's `sentBy`
// guard where the load warning asks for it; `plain` is the Machine as the scenario states it.

import { z } from "zod";
import { and, assign, raise, type AnyStateMachine } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import type { AgentLogic } from "../src/actor.ts";
import { sentBy } from "../src/party.ts";
import { jr2Setup } from "../src/setup.ts";
import type { Ran } from "./_party.ts";

export const approve = defineEvent({
  name: "approve",
  description: "Approve the work.",
  input: z.object({ note: z.string().optional() }),
});
const approveAny = defineEvent({
  name: "approve",
  description: "Approve the work.",
  input: z.object({ note: z.string().optional() }),
  audience: "any",
});
const ev = (name: string) => defineEvent({ name, description: `The ${name} pick.`, input: z.object({}) });
const [askReview, revise, cancel, go, submit, polish, poke, tick] = [
  "ask_review",
  "revise",
  "cancel",
  "go",
  "submit",
  "polish",
  "poke",
  "tick",
].map(ev);

/** Record which writing ran, and the event exactly as the author's action reads it. */
const ran = (name: string): never =>
  assign({
    ran: ({ context }: { context: Ran }) => [...context.ran, name],
    last: ({ event }: { event: unknown }) => event,
  }) as never;
const turn = (prompt: string) => ({ prompt, endpoint: "http://harness.invalid" });
const types = {} as { context: Ran };

export type Mode = "plain" | "marked";

/** S1 siblings: `draft` (the Agent's mode) and `review` (a Gate child) both write `approve`. */
export function s1(coder: AgentLogic): AnyStateMachine {
  return jr2Setup({ types, events: [approve, askReview!], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "s1",
    context: { ran: [] },
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: turn("work") },
        initial: "draft",
        states: {
          draft: { on: { approve: { target: "#s1.byAgent", actions: ran("draft") }, ask_review: "review" } },
          review: {
            invoke: { src: "gate", id: "review-1" },
            on: { approve: { target: "#s1.byReviewer", actions: ran("review") } },
          },
        },
      },
      byAgent: { type: "final" },
      byReviewer: { type: "final" },
    },
  });
}

/**
 * S2, a Gate above and the same name below: `release` invokes Gate `review-1` and writes `approve`
 * (A); its child `work` invokes the Agent, whose mode `draft` writes `approve` (B). A second mode,
 * `polishing`, writes none. `marked`: (B) carries `sentBy("coder")`; with `payloadGuard` it also
 * reads the payload (`note === "ok"`). `any`: the def's audience is `any`. `raiseOnPoke`: the
 * Agent's `poke` raises `approve` (the Machine's own event). `tickDelivers`: the Gate's `tick` runs
 * an action — the hook a test uses to deliver from inside a macrostep.
 */
export function s2(
  coder: AgentLogic,
  mode: Mode,
  opts: { any?: boolean; payloadGuard?: boolean; raiseOnPoke?: boolean; tickDelivers?: () => void } = {},
): AnyStateMachine {
  const guardB =
    mode === "marked"
      ? opts.payloadGuard
        ? and([sentBy("coder"), ({ event }) => (event as { note?: string }).note === "ok"])
        : sentBy("coder")
      : undefined;
  return jr2Setup({
    types,
    events: [opts.any ? approveAny : approve, polish!, revise!, poke!, tick!],
    actors: { coder },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "s2",
    context: { ran: [] },
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate", id: "review-1" },
        on: {
          approve: { target: "doneA", actions: ran("A") },
          tick: { actions: () => opts.tickDelivers?.() },
        },
        initial: "work",
        states: {
          work: {
            invoke: { src: "coder", input: turn("work") },
            initial: "draft",
            states: {
              draft: {
                on: {
                  approve: { target: "#s2.doneB", actions: ran("B"), ...(guardB ? { guard: guardB as never } : {}) },
                  polish: "polishing",
                  poke: opts.raiseOnPoke ? { actions: raise({ type: "approve" }) } : {},
                },
              },
              polishing: { on: { revise: "draft" } },
            },
          },
        },
      },
      doneA: { type: "final" },
      doneB: { type: "final" },
    },
  });
}

/** S3, a Gate above and the name only above: `draft` writes `revise`; only `release` writes `approve`. */
export function s3(coder: AgentLogic): AnyStateMachine {
  return jr2Setup({ types, events: [approve, revise!], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "s3",
    context: { ran: [] },
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate", id: "review-1" },
        on: { approve: { target: "doneA", actions: ran("A") } },
        initial: "work",
        states: {
          work: {
            invoke: { src: "coder", input: turn("work") },
            initial: "draft",
            states: { draft: { on: { revise: { target: "draft", actions: ran("revise") } } } },
          },
        },
      },
      doneA: { type: "final" },
    },
  });
}

/** S4, one party's nested override: `work` and its mode `draft` both write `cancel`. */
export function s4(coder: AgentLogic): AnyStateMachine {
  return jr2Setup({ types, events: [cancel!], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "s4",
    context: { ran: [] },
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: turn("work") },
        on: { cancel: { target: "abandoned", actions: ran("work") } },
        initial: "draft",
        states: { draft: { on: { cancel: { target: "#s4.discarded", actions: ran("draft") } } } },
      },
      abandoned: { type: "final" },
      discarded: { type: "final" },
    },
  });
}

/** S5, parallel regions above the Agent: `r1` invokes the Agent and writes `go`; `r2` a Gate, `go`. */
export function s5(coder: AgentLogic, mode: Mode): AnyStateMachine {
  return jr2Setup({ types, events: [go!], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "s5",
    context: { ran: [] },
    type: "parallel",
    states: {
      r1: {
        invoke: { src: "coder", input: turn("r1") },
        on: { go: { target: ".b", actions: ran("r1"), ...(mode === "marked" ? { guard: sentBy("coder") } : {}) } },
        initial: "a",
        states: { a: {}, b: {} },
      },
      r2: {
        invoke: { src: "gate", id: "review-1" },
        on: { go: { target: ".b", actions: ran("r2"), ...(mode === "marked" ? { guard: sentBy("review-1") } : {}) } },
        initial: "a",
        states: { a: {}, b: {} },
      },
    },
  });
}

/** S8, a nested Agent: `outer` invokes `coder` and writes `submit`; `outer.inner` invokes
 * `reviewer`, whose mode `check` writes `submit`. `marked`: the inner writing carries
 * `sentBy("reviewer")`, which the walk does not ask for here: while `reviewer` runs, `outer` is not
 * at Rest, so every pick of `coder` is refused whatever the guard (ADR-0024). */
export function s8(coder: AgentLogic, reviewer: AgentLogic, mode: Mode): AnyStateMachine {
  return jr2Setup({ types, events: [submit!], actors: { coder, reviewer } }).createMachine({
    on: { "agent.fault": {} },
    id: "s8",
    context: { ran: [] },
    initial: "outer",
    states: {
      outer: {
        invoke: { src: "coder", input: turn("outer") },
        on: { submit: { target: "outerDone", actions: ran("outer") } },
        initial: "inner",
        states: {
          inner: {
            invoke: { src: "reviewer", input: turn("inner") },
            initial: "check",
            states: {
              check: {
                on: {
                  submit: {
                    target: "#s8.innerDone",
                    actions: ran("inner"),
                    ...(mode === "marked" ? { guard: sentBy("reviewer") } : {}),
                  },
                },
              },
            },
          },
        },
      },
      outerDone: { type: "final" },
      innerDone: { type: "final" },
    },
  });
}

/** The root-writing shape: the root writes `cancel` (both parties'), `release` invokes a Gate, and
 * the Agent's mode `draft` below writes `cancel` too. `marked`: the mode's writing declines others. */
export function rootShape(coder: AgentLogic, mode: Mode): AnyStateMachine {
  return jr2Setup({ types, events: [cancel!, approve], actors: { coder } }).createMachine({
    id: "root",
    context: { ran: [] },
    on: { "agent.fault": {}, cancel: { target: ".cancelled", actions: ran("root") } },
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate", id: "review-1" },
        on: { approve: "shipped" },
        initial: "work",
        states: {
          work: {
            invoke: { src: "coder", input: turn("work") },
            initial: "draft",
            states: {
              draft: {
                on: {
                  cancel: {
                    target: "#root.discarded",
                    actions: ran("draft"),
                    ...(mode === "marked" ? { guard: sentBy("coder") } : {}),
                  },
                },
              },
            },
          },
        },
      },
      shipped: { type: "final" },
      cancelled: { type: "final" },
      discarded: { type: "final" },
    },
  });
}

/** Two Gates on one path: `outer` (Gate "outer") writes `approve` (A); `outer.inner` (Gate
 * "inner") writes `approve` (C). `marked`: (C) carries `sentBy("inner")`. */
export function twoGatesPath(mode: Mode): AnyStateMachine {
  return jr2Setup({ types, events: [approve] }).createMachine({
    id: "tg",
    context: { ran: [] },
    initial: "outer",
    states: {
      outer: {
        invoke: { src: "gate", id: "outer" },
        on: { approve: { target: "doneA", actions: ran("A") } },
        initial: "inner",
        states: {
          inner: {
            invoke: { src: "gate", id: "inner" },
            on: {
              approve: {
                target: "#tg.doneC",
                actions: ran("C"),
                ...(mode === "marked" ? { guard: sentBy("inner") } : {}),
              },
            },
          },
        },
      },
      doneA: { type: "final" },
      doneC: { type: "final" },
    },
  });
}

/** Two Gates in parallel regions, one name: `marked`, each region's writing names its Gate. */
export function twoGatesParallel(mode: Mode): AnyStateMachine {
  const region = (id: string) => ({
    invoke: { src: "gate" as const, id },
    on: { approve: { target: ".b", actions: ran(id), ...(mode === "marked" ? { guard: sentBy(id) } : {}) } },
    initial: "a",
    states: { a: {}, b: {} },
  });
  return jr2Setup({ types, events: [approve] }).createMachine({
    id: "tp",
    context: { ran: [] },
    type: "parallel",
    states: { left: region("left"), right: region("right") },
  });
}

/** S2 with a delayed re-raise of the reviewer's own event: the reviewer's `submit` raises a copy of
 * itself as `approve`, sender and all, 300 ms later — a pending timer the run host persists beside
 * the snapshot. (B) declines it by `sentBy("coder")`, so (A) runs only if the sender survived. */
export function s2Delayed(coder: AgentLogic): AnyStateMachine {
  return jr2Setup({ types, events: [approve, submit!], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "dl",
    context: { ran: [] },
    initial: "release",
    states: {
      release: {
        invoke: { src: "gate", id: "review-1" },
        on: {
          submit: { actions: raise(({ event }) => ({ ...event, type: "approve" }) as never, { delay: 300 }) },
          approve: { target: "doneA", actions: ran("A") },
        },
        initial: "work",
        states: {
          work: {
            invoke: { src: "coder", input: turn("work") },
            initial: "draft",
            states: { draft: { on: { approve: { target: "#dl.doneB", actions: ran("B"), guard: sentBy("coder") } } } },
          },
        },
      },
      doneA: { type: "final" },
      doneB: { type: "final" },
    },
  });
}

/** The fail-open shape: `work` (the Agent's) writes `approve`; its child `review` invokes a Gate and
 * writes `approve` behind a guard that reads the payload. */
export function payloadBelow(coder: AgentLogic): AnyStateMachine {
  const ask = ev("ask");
  return jr2Setup({ types, events: [approve, ask], actors: { coder } }).createMachine({
    on: { "agent.fault": {} },
    id: "fo",
    context: { ran: [] },
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: turn("work") },
        on: { approve: { target: "byAgent", actions: ran("work") }, ask: ".review" },
        initial: "draft",
        states: {
          draft: {},
          review: {
            invoke: { src: "gate", id: "review-1" },
            on: {
              approve: {
                target: "#fo.byGate",
                guard: ({ event }) => (event as { note?: string }).note === "ship",
                actions: ran("review"),
              },
            },
          },
        },
      },
      byAgent: { type: "final" },
      byGate: { type: "final" },
    },
  });
}
