// `j2 gc [--dry-run] [--context <ctx>]` (ADR-0039): the reachability sweep, run off-cycle. An
// escape hatch for "disk is full now", not a step in any workflow — `j2 up` and `j2 down` already
// sweep at the two moments the root set moves, and this is the same sweep with no converge attached.
//
// It never confirms. By construction it removes only images j2 built (the `j2.dev/kind` stamp is
// the ownership gate) and only those no live root names, so there is nothing for a human to weigh:
// the question "is this needed?" is answered by the cluster, not by the operator of the CLI.
//
// It takes no `-n`. The keep set is cluster-wide by definition — a ref another instance's image map
// or pod names is not garbage — so a namespace flag would narrow nothing and mean nothing. And it
// resolves no instance folder: "disk is full now" has to work from anywhere, and a kube context is
// the only address this command needs.

import { parseArgs } from "node:util";
import { pnpmDockerBuild } from "../build.ts";
import { kubectlAdmin } from "../kube.ts";
import { activity, type Io } from "../output.ts";
import { sweepImages } from "../sweep.ts";

export async function gc(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      "dry-run": { type: "boolean" },
      context: { type: "string" },
    },
  });

  const kube = io.kubeAdmin ?? kubectlAdmin;
  const context = (values.context as string | undefined) ?? (await kube.context());
  if (!context) {
    throw new Error("no kube context — `j2 gc` decides what is garbage by asking a cluster what it still needs");
  }
  const ctx = values.context ? { context: values.context as string } : {};
  const dryRun = values["dry-run"] === true;

  activity(io, `j2 gc — images on ${context} that no live root names${dryRun ? " (dry run: nothing is removed)" : ""}`);
  try {
    await sweepImages({ io, build: io.build ?? pnpmDockerBuild, kube, context, ctx, dryRun });
  } catch (err) {
    // Fail closed and say so: a keep set assembled from a partial roots read is not a smaller one,
    // it is a wrong one, and acting on it would delete another instance's images. Unlike `up` and
    // `down` — where the sweep is a courtesy on top of a job that already succeeded — the sweep IS
    // this command, so a sweep that took nothing is a failed run.
    activity(io, `error: the roots could not be read (${err instanceof Error ? err.message : err})`);
    activity(io, "  nothing was swept — a keep set missing one root would delete images the cluster still needs");
    return 1;
  }
  return 0;
}
