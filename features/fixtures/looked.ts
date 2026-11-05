// An e2e fixture for a Gate's look (ADR-0011), with NO cluster and no Instance Effector: the look's
// read is a promise, which reads a file whose path the run's input names. The file stands for the
// fact that a forge would answer — a review's state. Filename `looked.ts` → workflow "looked".
//
// The look reads once after the Gate registers, again every `every` (here one second) while the Gate
// is open, and again after a restore. When the file says "approved", `until` gives `approve`, and the
// run takes it from the Gate: the run ends `done`, and no Caller answered it.

import { readFile } from "node:fs/promises";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent, gate, jr2Setup } from "@jr2/orchestrator/internal";

const approve = defineEvent({
  name: "approve",
  description: "The change is approved.",
  input: z.object({ by: z.string() }),
});

/** The fact, as the look reads it: the file's text, or "" when there is no file yet. */
const readFact = fromPromise(async ({ input }: { input: { file: string } }) => {
  try {
    return (await readFile(input.file, "utf8")).trim();
  } catch {
    return "";
  }
});

const review = gate({
  meta: z.object({ file: z.string() }),
  delivers: [approve],
  look: {
    read: readFact,
    input: (meta) => ({ file: meta.file }),
    every: "1s",
    until: (fact) => (fact === "approved" ? { type: "approve", by: "the look" } : undefined),
  },
});

type Input = { file: string };

export const machine = jr2Setup({
  types: {} as { context: Input & { by?: string }; input: Input },
  events: [approve],
  actors: { review },
}).createMachine({
  id: "looked",
  input: z.object({ file: z.string() }),
  context: ({ input }) => ({ file: input.file }),
  initial: "inReview",
  states: {
    inReview: {
      invoke: { src: "review", input: ({ context }) => ({ meta: { file: context.file } }) },
      on: { approve: "merged" },
    },
    merged: { type: "final" },
  },
});
