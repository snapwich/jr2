// Abbreviated run ids (ADR-0009): the CLI's answer to "which run", the way `instance.ts` answers
// "which instance". A run id is a bare uuid, so pasting all 36 characters is the common case worth
// removing — git's short hashes, with git's rule: prefix only, and an ambiguous prefix FAILS rather
// than guessing.
//
// Resolution lives here and not on the orchestrator's addressed routes. A prefix is not an identity
// — one that resolves today goes ambiguous tomorrow when an unrelated run starts — and `j2 send
// <prefix> --event CANCEL` is a write. Resolving first means every write on the wire carries a full
// id, and the HTTP surface stays the machine-to-machine one it claims to be.
//
// The floor is about NOISE, not safety: safety comes from the ambiguity error, since a short prefix
// never resolves to the wrong run, only to a list. Four characters just keeps `j2 status a` from
// printing the whole table.

import type { J2Client } from "./client.ts";

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
 * Turn a user-typed run id — full or abbreviated — into a full one. A full id short-circuits, so
 * scripted pipelines (`j2 run --detach | jq -r .runId` → `j2 status $id`) issue exactly the traffic
 * they issue today.
 */
export async function resolveRunId(client: J2Client, given: string): Promise<ResolvedRunId> {
  if (RUN_ID.test(given)) return { ok: true, runId: given };

  if (given.length < MIN_PREFIX) {
    return { ok: false, code: 2, message: `j2: run id "${given}" is too short (need ${MIN_PREFIX}+ characters)` };
  }

  const { runIds, truncated } = await client.candidates(given);

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
