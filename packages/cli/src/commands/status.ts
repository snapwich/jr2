// `j2 status [runId|abbrev]` (ADR-0009): print a run's status as JSON on stdout, reading through to the
// store so a completed run still reports its terminal status + final context. A genuinely unknown run → 1.
//
// With NO run named, the verb answers about the INSTANCE instead (ADR-0048/0051): whether it has a
// data plane at all, and every Repo resource's per-node state, so a Repo that will not clone — an
// unregistered deploy key (ADR-0047), a wrong url, a git host outage — is discoverable by asking
// the thing that knows, rather than by tailing pod logs. The Orchestrator serves either way; only
// the Repo is degraded, and the cache agent retries it on its own.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
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
 * The instance's own status: the data-plane switch and every Repo resource, on stdout as one JSON
 * object (extensible — the instance has more to report eventually), and every node whose last
 * attempt on a Repo FAILED spelled out on stderr with git's own error, since that is the line a
 * human acts on. An instance with no data plane says so — "no registered Machine composes a
 * Sandbox" is the answer, not an empty list.
 *
 * Exit 0 even with Repos failing: this is a report, and a degraded Repo is a state the instance
 * is serving in, not a failure of the asking.
 */
async function instanceStatus(client: J2Client, io: Io): Promise<number> {
  const { dataPlane, repos } = await client.repos();
  if (!dataPlane) activity(io, "this instance has no data plane (no registered Machine composes a Sandbox)");
  let failing = 0;
  for (const repo of repos) {
    for (const node of repo.nodes) {
      if (node.synced || node.lastError === undefined) continue;
      failing++;
      activity(io, `repo ${repo.key} (${repo.url}) on node ${node.node}: ${node.lastError}`);
    }
  }
  if (failing) {
    activity(
      io,
      "the cache agent keeps retrying these — register the deploy key with your git host, or fix the url or the " +
        "git.credentials entry, and the next attempt lands (ADR-0047/0048/0051). Workspaces needing them wait until then.",
    );
  }
  result(io, { dataPlane, repos });
  return 0;
}
