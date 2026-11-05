// The @kind tier's read Source (ADR-0017, ADR-0068): a Pool of child Machines whose Source reads the
// whole set with an `http` Effect marked idempotent, in the real Instance Effector. The read goes
// to the echo with the run's marker in its path; `items` gives two items when the echo's answer
// names that path, so the two items exist only when the read went through the Effector. Each
// worker ends at once, and the Pool drains: the run ends `done` with both items in its output. The
// echo counts the reads by the marker.

import { z } from "zod";
import { http, jr2Setup, pool, source } from "@jr2/orchestrator";

/** The echo server's in-cluster address (`steps/seed.ts`). */
const ECHO = "http://echo.jr2-e2e-seed.svc";

const door = z.object({ marker: z.string().regex(/^m-[a-z0-9]+$/) });

type Item = { n: number };

const read = http({
  method: "GET",
  url: `${ECHO}/source`,
  idempotent: true,
  input: door,
  request: ({ marker }) => ({ path: [marker] }),
});

const worker = jr2Setup({ types: {} as { input: Item } }).createMachine({
  id: "item",
  initial: "go",
  states: { go: { after: { 1: "end" } }, end: { type: "final" } },
  // The Pool's output keeps each worker's output by its item's id.
  output: ({ self }) => ({ worker: self.id }),
});

export const machine = pool(worker, {
  id: "sourced",
  input: door,
  source: source<Item, z.infer<typeof door>, typeof read>({
    read,
    items: (output, { input }) =>
      output.outcome === "response" &&
      output.status === 200 &&
      String(output.body ?? "").includes(`/source/${input.marker}`)
        ? [{ n: 1 }, { n: 2 }]
        : [],
  }),
  itemId: (item) => `n-${item.n}`,
  cap: 2,
});
