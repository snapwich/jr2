// The kind tier's PER-RUN workflow (ADR-0051): the same body and the same one slot as `sandboxed`,
// but the slot is a mapper over the door — the url is run input, a ticket field, the shape that
// can spend the cluster's credential against any host. So this is the workflow the FENCE is proved
// on: a url `git.credentials` admits by prefix provisions a Sandbox naming it (the cache clones it
// on first need, and every later attach finds it); one no entry matches is refused at attach,
// naming the list. The walk sees a per-run slot as the run's business — nothing to warm, nothing
// to refuse at `jr2 up`.

import { z } from "zod";
import { workspace } from "@jr2/orchestrator";
import { body } from "./_body.ts";

export const machine = workspace(body, {
  input: z.object({ repo: z.string() }),
  repos: { app: ({ input }) => ({ url: input.repo, ref: "main" }) },
  spec: () => ({ branch: "feat-e2e" }),
});
