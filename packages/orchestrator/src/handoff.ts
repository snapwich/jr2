// The Handoff (ADR-0080): the commit that a nested Workspace takes at its cut, and the check of the
// run's ledger that finds it.
//
// A Handoff is plain data, the parent cut's `WorktreeReady`, and it comes through a door, so it is
// the Agent's word: a pick or a Chart can fill each field. jr2 trusts no field. The cut finds the
// whole Handoff in the run's Effect ledger, and each fact that does not agree is `refused`, with a
// reason, never `onError` (ADR-0067). What the check finds (`HandoffSource`) goes on the cut's
// intent row, so a restored run asks the same source, and the transport reads it there.
//
// This module is the check and the seam. The transport (the bundle of the parent Sandbox, the two
// Harness legs, `handoff-carry.ts`) plugs in through `HandoffCarrier`. With no carrier, nothing is
// carried, and the cut takes the Handoff's commit from the child's clone after its fetch: the case
// of an empty range, where the remote already holds the commit.

import { z } from "zod";
import type { AmbientHandles } from "./ambient.ts";
import { repoKey } from "./repo-identity.ts";

/**
 * A Handoff: the commit of a `ready` cut of an enclosing Workspace, which a nested Workspace takes
 * at its own cut (ADR-0080). It is the `ready` output of the parent's cut, as plain data: a
 * `WorktreeReady` is a Handoff. Pass it to the nested Workspace through its door, and give it to
 * the cut there: `{ path, handoff }`.
 */
export type Handoff = {
  /** The Repo Slot of the parent's cut. */
  slot: string;
  /** The Worktree of the parent's cut. */
  path: string;
  /** The branch of the parent's cut. `null` when that Worktree is detached. */
  branch: string | null;
  /** The commit to hand off: the head of that cut. */
  head: string;
};

/** A full commit id: sha-1 or sha-256. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The schema of a {@link Handoff}, for a door's input or a pick's param: `z.object({ handoff })`.
 * It checks the shape only. The cut checks each field against the run's ledger, and refuses a
 * Handoff that the run did not make. Other fields of a `WorktreeReady` (`outcome`, `found`) are
 * dropped.
 *
 * @example
 * ```ts
 * import { handoff } from "@jr2/orchestrator";
 * import { z } from "zod";
 *
 * export const finalInput = z.object({ handoff, earlier: z.array(z.string()) });
 * ```
 *
 * @see docs/reference/decisions/0080-a-nested-workspace-takes-a-handoff-at-its-cut.md
 */
export const handoff: z.ZodType<Handoff> = z.object({
  slot: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1).nullable(),
  head: z.string().regex(COMMIT, "a full commit id"),
});

/** Why a value is not a Handoff, or undefined when it is one. The shape only: the ledger check
 * comes after. */
export function handoffShapeFault(value: unknown): string | undefined {
  const parsed = handoff.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0]!;
  const at = issue.path.length > 0 ? `\`${issue.path.join(".")}\`` : "it";
  return `a cut's \`handoff\` is a Handoff, { slot, path, branch, head }: ${at}: ${issue.message}`;
}

/**
 * What the ledger check found: the `ready` cut that the Handoff names, in the run that the child
 * runs in (ADR-0080). It goes on the child cut's intent row. `run`, `sandbox` and `row` say where
 * the commit is: the run, the Workspace whose cut made it, and that cut's ledger row. `endpoint` is
 * that Workspace's Harness, which the transport asks for the files. `branch` is the branch of the
 * child's cut: the cut's `branch`, or the row's.
 */
export type HandoffSource = {
  run: string;
  sandbox: string;
  endpoint: string;
  row: string;
  slot: string;
  path: string;
  head: string;
  branch: string;
};

/** A settled `ready` cut row, as the check reads it. */
type CutRowView = {
  state: string;
  sandbox?: string;
  repo?: string;
  cut?: { path: string; branch: string | null; head?: string };
  output?: unknown;
};

/** The head of a settled `ready` cut row: the row's field, or its output's. */
function headOf(row: CutRowView): string | undefined {
  if (row.cut?.head !== undefined) return row.cut.head;
  const head = (row.output as { head?: unknown } | undefined)?.head;
  return typeof head === "string" ? head : undefined;
}

/** Two Binding urls are one Repo: one identity (ADR-0051). */
function sameRepo(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    return repoKey(a) === repoKey(b);
  } catch {
    return false;
  }
}

/**
 * Check a Handoff against the run's ledger (ADR-0080). `chain` is the Workspaces around the cut,
 * nearest first: `chain[0]` is the child's own Workspace, and each later one encloses it. `rows` is
 * the ledger of the child's run, and `run` its id. `branch` is the cut's `branch`, if it names one.
 *
 * Each fact that does not agree is a refusal, with the reason:
 * - a `ready` cut of the run has the Handoff's path and head (an earlier `ready` cut of the path is
 *   good too). A run's ledger holds only its own cuts, so a Handoff of another run, a dispatched run
 *   too, finds no row;
 * - the Workspace of that cut encloses the child's: not the child's own, and not a sibling;
 * - the Handoff's slot is the row's Repo Slot, and that slot's Repo is the child slot's;
 * - the Handoff's branch is the row's branch;
 * - the child's branch is a name: a detached Handoff needs the cut's `branch`.
 */
export function handoffSourceOf(
  given: Handoff,
  ctx: {
    rows: Readonly<Record<string, CutRowView>>;
    chain: readonly AmbientHandles[];
    run: string;
    path: string;
    branch?: string;
  },
): { source: HandoffSource } | { refused: string } {
  const own = ctx.chain[0]!;
  const enclosing = ctx.chain.slice(1);
  const of = `the Handoff of ${given.path} at ${given.head}`;
  const matching = Object.entries(ctx.rows).filter(
    ([, row]) =>
      row.state === "settled" &&
      row.cut !== undefined &&
      row.sandbox !== undefined &&
      row.cut.path === given.path &&
      headOf(row) === given.head,
  );
  if (matching.length === 0) {
    return { refused: `${of}: no ready cut of this run made that commit at that path` };
  }
  // The nearest enclosing Workspace first.
  const found = enclosing
    .map((handles) => ({ handles, hit: matching.find(([, row]) => row.sandbox === handles.sandbox) }))
    .find((m) => m.hit !== undefined);
  if (found === undefined) {
    const where = matching.some(([, row]) => row.sandbox === own.sandbox)
      ? "this nested Workspace's own cut made it, and a Handoff comes from an enclosing Workspace"
      : "a Workspace that does not enclose this one made it, and a Handoff comes from an enclosing Workspace";
    return { refused: `${of}: ${where}` };
  }
  const { handles } = found;
  const [rowId, row] = found.hit!;
  if (row.repo !== given.slot) {
    return { refused: `${of}: the cut made it in Repo Slot "${row.repo}", not "${given.slot}"` };
  }
  const slot = ctx.path.split("/")[2]!;
  if (!sameRepo(handles.bindings?.[row.repo], own.bindings?.[slot])) {
    return {
      refused:
        `${of}: Repo Slot "${row.repo}" of the enclosing Workspace holds ${handles.bindings?.[row.repo] ?? "no Repo"}, ` +
        `and Repo Slot "${slot}" here holds ${own.bindings?.[slot] ?? "no Repo"}: a Handoff stays in one Repo`,
    };
  }
  if (row.cut!.branch !== given.branch) {
    return {
      refused: `${of}: the cut made it on ${row.cut!.branch ?? "a detached Worktree"}, not on ${given.branch ?? "a detached Worktree"}`,
    };
  }
  const branch = ctx.branch ?? given.branch;
  if (branch === null) {
    return { refused: `${of}: the Handoff is detached, so the cut names the branch: { path, handoff, branch }` };
  }
  return {
    source: {
      run: ctx.run,
      sandbox: handles.sandbox,
      endpoint: handles.endpoint,
      row: rowId,
      slot: row.repo,
      path: given.path,
      head: given.head,
      branch,
    },
  };
}

/**
 * The transport's seam (ADR-0080): carry the files of a Handoff from the source Workspace's Harness
 * to the child's, under the cut's Effect id, before the cut's exec starts. `carried`: the child's
 * Harness holds them for this cut. `nothing`: the range is empty, and the cut takes the commit from
 * its clone. `refused`: the parent's files or clone caused it, and the cut is `refused` with the
 * reason. `unknown`: the source Harness did not answer, and the cut is `unknown`. A carrier that
 * throws is `unknown` too: a fault that an Agent's files can cause never reaches `onError`.
 *
 * The Orchestrator calls it again before each send of the cut's start: a child Harness that
 * restarted may not hold the files of the last call.
 *
 * With no carrier, the Orchestrator carries nothing, as for `nothing`. `worktree()` gives the
 * carrier of `handoff-carry.ts`.
 */
export type HandoffCarrier = (args: {
  /** The cut's Effect id: the child's Harness keeps the files under it. */
  effect: string;
  source: HandoffSource;
  /** The source Workspace's Harness as it runs now: the Workspace of `source.sandbox`, which still
   * encloses the child. */
  from: { endpoint: string; sandbox: string };
  /** The child's Harness. */
  target: { endpoint: string; sandbox: string };
  /** The Harness bearer of a Workspace, by its Sandbox (ADR-0058). */
  bearer: (sandbox: string) => string | undefined;
  signal: AbortSignal;
}) => Promise<{ outcome: "carried" | "nothing" } | { outcome: "refused" | "unknown"; reason: string }>;
