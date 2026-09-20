// Abbreviated run ids (ADR-0009): the CLI's answer to "which run", the way `instance.ts` answers
// "which instance". A run id is a bare uuid, so pasting all 36 characters is the common case worth
// removing — git's short hashes, with git's rule: prefix only, and an ambiguous prefix FAILS rather
// than guessing.
//
// Resolution lives here and not on the orchestrator's addressed routes. A prefix is not an identity
// — one that resolves today goes ambiguous tomorrow when an unrelated run starts — and `jr2 send
// <prefix> --event CANCEL` is a write. Resolving first means every write on the wire carries a full
// id, and the HTTP surface stays the machine-to-machine one it claims to be.
//
// The floor is about NOISE, not safety: safety comes from the ambiguity error, since a short prefix
// never resolves to the wrong run, only to a list. Four characters just keeps `jr2 status a` from
// printing the whole table.

import { JR2HttpError, RESOLVE_PATH, type InstanceIdentity, type JR2Client } from "./client.ts";

/** Below this, a prefix is a table scan rather than a question. Mirrors the orchestrator's guard. */
const MIN_PREFIX = 4;

/** A full run id: matched on SHAPE, not `length === 36`, so a 36-character non-uuid takes the error
 * path here instead of 404-ing off an addressed route. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A resolved argument, or the message + exit code to report. A result rather than a throw: throwing
 * would route through `cli.ts`'s catch and flatten everything to exit 1, losing the split between a
 * malformed argument (2, usage) and server state (1, runtime).
 */
export type ResolvedRunId = { ok: true; runId: string } | { ok: false; code: 1 | 2; message: string };

/**
 * What to say when the deployed instance has no prefix-resolution route. Names the workaround
 * (a full id short-circuits before any resolve traffic) AND the fix, in that order: the user is
 * mid-task, and `jr2 up` is a rollout they may not want this second.
 */
function skewMessage(given: string, instance?: InstanceIdentity): string {
  const deployed = instance?.version
    ? `deployed instance: ${instance.version}${instance.hash ? ` (${instance.hash})` : ""}`
    : "the deployed instance predates it";
  return [
    `error: this instance does not support abbreviated run ids ("${given}")`,
    `  ${deployed}`,
    "  use the full run id, or run `jr2 up` to converge the cluster to this kit",
  ].join("\n");
}

/**
 * Turn a user-typed run id — full or abbreviated — into a full one. A full id short-circuits, so
 * scripted pipelines (`jr2 run --detach | jq -r .runId` → `jr2 status $id`) issue exactly the traffic
 * they issue today.
 */
export async function resolveRunId(client: JR2Client, given: string): Promise<ResolvedRunId> {
  if (RUN_ID.test(given)) return { ok: true, runId: given };

  if (given.length < MIN_PREFIX) {
    return { ok: false, code: 2, message: `jr2: run id "${given}" is too short (need ${MIN_PREFIX}+ characters)` };
  }

  let runIds: string[];
  let truncated: boolean;
  try {
    ({ runIds, truncated } = await client.candidates(given));
  } catch (err) {
    // A 404 on `/runs/resolve` is unreachable on an instance that HAS the route — the route is
    // static and answers `{ runIds: [] }` when nothing matches. So a 404 here means the request fell
    // through to `/runs/:runId`, which captured the literal string "resolve" and 404'd naming it:
    // this instance predates abbreviated run ids. Left uncaught, that reads as `no run "resolve"` —
    // an error about a run the user never asked for.
    if (err instanceof JR2HttpError && err.status === 404 && err.path === RESOLVE_PATH) {
      return { ok: false, code: 1, message: skewMessage(given, err.instance) };
    }
    throw err;
  }

  if (runIds.length === 0) return { ok: false, code: 1, message: `no run "${given}"` };
  if (runIds.length === 1) return { ok: true, runId: runIds[0] as string };

  const listed = runIds.map((id) => `    ${id}`).join("\n");
  const more = truncated ? "\n    …" : "";
  return {
    ok: false,
    code: 1,
    message: `error: run id "${given}" is ambiguous\n  candidates:\n${listed}${more}`,
  };
}
