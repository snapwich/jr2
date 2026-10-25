// `jr2 check` (ADR-0050): the Instance check of `jr2 up`, with no cluster. It runs the same function
// that `jr2 up` runs before it stages the Assembly (`checkInstance`): the Instance's own `tsc
// --noEmit`, then the load of each registered Workflow and the walk of its Machine. So it gives the
// refusals that `npm run typecheck` cannot give: a refusal of `createMachine`, `defineEvent` or
// `workspace()` when a module loads, an Open part nobody bound, a Chart file the door refuses, a
// dispatch, an Effect secret, a Size. Each refusal has the text of `jr2 up`, and the exit code is 1.
//
// It reads no kube context. It touches no cluster, no docker and no registry. Thus an Assistant
// that may not run `jr2 up` can run it before it gives a change to the user. It writes no file: the
// AGENTS.md block is `jr2 up`'s and `jr2 init`'s (ADR-0072). It runs in a kit checkout and in an
// installed Instance. The `jr2` binary strips the types of the kit sources under `node_modules`,
// and `node` alone does not.

import { basename } from "node:path";
import { loadConfig } from "@jr2/orchestrator/internal";
import { parseCommand } from "../command-table.ts";
import { resolveRoot } from "../instance.ts";
import { checkInstance } from "../instance-check.ts";
import { activity, type Io } from "../output.ts";

export async function check(args: string[], io: Io): Promise<number> {
  parseCommand("check", args);
  const root = resolveRoot(io.cwd);
  const config = (await loadConfig(root)) ?? {};
  const name = config.name ?? basename(root);
  activity(io, `jr2 check — instance "${name}" (no cluster)`);

  const checked = await checkInstance(io, root, config);
  if (!checked) return 1;
  const names = [...checked.workflows.map((w) => w.name), ...checked.chartFiles];
  activity(
    io,
    `check: passed — ${names.length} workflow(s): ${names.join(", ") || "(none)"}; ` +
      "`jr2 up` stages the Assembly and converges the cluster after the same check",
  );
  return 0;
}
