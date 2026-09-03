// `j2 status [runId|abbrev]` (ADR-0009): print a run's status as JSON on stdout, reading through to the
// store so a completed run still reports its terminal status + final context. A genuinely unknown run → 1.
//
// With NO run named, the verb answers about the INSTANCE instead (ADR-0048): the source volume's
// per-repo sync state, so a repo that will not clone — an unregistered deploy key (ADR-0047), a
// wrong url, a git host outage — is discoverable by asking the thing that knows, rather than by
// tailing pod logs for the boot's announce lines. The Orchestrator serves either way; only the
// repo is degraded, and the reconcile retries it on its own.

import { parseArgs } from "node:util";
import { J2Client, type RepoState } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";

export async function status(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { ...TARGET_ARGS },
  });
  // NO run named, not an EMPTY one: `j2 status "$RUNID"` with the variable unset asked about a run
  // and got an empty string, and answering that with the instance's repos would report exit 0 on a
  // question nobody asked. An empty positional falls through to the resolver, which says so.
  const given = positionals.length === 0 ? undefined : positionals[0]!;
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new J2Client(target.url, io.fetch, target.token);
    if (given === undefined) return await instanceStatus(client, io);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }
    const s = await client.read(ref.runId);
    if (!s) {
      activity(io, `no run "${ref.runId}"`);
      return 1;
    }
    result(io, s);
    return 0;
  } finally {
    target.close?.();
  }
}

/**
 * The instance's own status: every repo the reconcile has tried, on stdout as one JSON object
 * (extensible — the instance has more to report than repos eventually), and the UNSYNCED ones
 * spelled out on stderr with git's own error, since that is the line a human acts on.
 *
 * Exit 0 even with repos unsynced: this is a report, and a degraded repo is a state the instance
 * is serving in, not a failure of the asking.
 */
async function instanceStatus(client: J2Client, io: Io): Promise<number> {
  const repos = await client.repos();
  const unsynced = repos.filter((r: RepoState) => !r.synced);
  for (const repo of unsynced) {
    activity(io, `repo "${repo.name}" is not synced (attempt ${repo.attempts ?? 1}): ${repo.error ?? "unknown error"}`);
  }
  if (unsynced.length) {
    activity(
      io,
      "the orchestrator keeps retrying these — register the deploy key with your git host, or fix the url/token, " +
        "and the next attempt attaches (ADR-0047/0048). Workspaces needing them fail until then.",
    );
  }
  result(io, { repos });
  return 0;
}
