// `jr2 status [runId|abbrev]` (ADR-0009): print a run's status as JSON on stdout, reading through to the
// store so a completed run still reports its terminal status + final context. A genuinely unknown run → 1.
//
// With NO run named, the verb answers about the INSTANCE instead (ADR-0048/0051/0069): its current
// Assembly and the live runs that hold it, whether it has a data plane at all, and every Repo
// resource's per-node state, so a Repo that will not clone — an
// unregistered deploy key (ADR-0047), a wrong url, a git host outage — is discoverable by asking
// the thing that knows, rather than by tailing pod logs. The Orchestrator serves either way; only
// the Repo is degraded, and the cache agent retries it on its own.
//
// Two output classes (ADR-0009 as amended): `status <runId>` is a RESULT verb — the RunStatus as one
// JSON line on stdout, for the pipe. Bare `status` is a REPORT verb — a human table on stdout, or the
// one object with `--json`.

import { parseArgs } from "node:util";
import type { AssemblyView, RepoStatus } from "@jr2/orchestrator";
import { JR2Client, type FetchLike } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";

export async function status(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { ...TARGET_ARGS, json: { type: "boolean" } },
  });
  // NO run named, not an EMPTY one: `jr2 status "$RUNID"` with the variable unset asked about a run
  // and got an empty string, and answering that with the instance's repos would report exit 0 on a
  // question nobody asked. An empty positional falls through to the resolver, which says so.
  const given = positionals.length === 0 ? undefined : positionals[0]!;
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    if (given === undefined) return await instanceStatus(client, io, target.url, values.json === true);
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
 * The instance's own status: the current Assembly, the data-plane switch and every Repo resource. As a table on stdout —
 * every node's state per Repo, and every node whose last attempt FAILED spelled out with git's own
 * error, since that is the line a human acts on — or, with `--json`, as the one object (extensible:
 * the instance has more to report eventually). An instance with no data plane says so — "it runs
 * outside a cluster" is the answer, not an empty list. A deployed Orchestrator always has one: it
 * wires its kube client whatever the current Assembly composes (ADR-0069).
 *
 * Two failures, two consequences (ADR-0004/0051): a cache that is ABSENT on the node (a cold clone
 * failed) parks every Workspace that needs it there; a cache that is PRESENT but whose last fetch
 * failed is STALE, and an attach proceeds on the objects it holds. Each node line names which, and
 * the hint states the consequence for the cases actually seen — not the cold-node rule for both.
 *
 * Exit 0 even with Repos failing: this is a report, and a degraded Repo is a state the instance
 * is serving in, not a failure of the asking.
 */
async function instanceStatus(client: JR2Client, io: Io, url: string, json: boolean): Promise<number> {
  const report = { assembly: await readAssembly(io.fetch ?? globalThis.fetch, url), ...(await client.repos()) };
  if (json) result(io, report);
  else io.stdout(renderInstanceStatus(report));
  return 0;
}

/** `GET /assembly` (ADR-0069): open, like `GET /workflows`, so it needs no token. An answer that
 * cannot be read is reported as the reason, never as a failure of the verb. */
async function readAssembly(fetchImpl: FetchLike, url: string): Promise<AssemblyView | { error: string }> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/assembly`);
    if (!res.ok) return { error: `GET /assembly answered HTTP ${res.status}` };
    return (await res.json()) as AssemblyView;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The Assembly line: the current one and how many live runs hold it, or why there is none. */
function assemblyLine(view: AssemblyView | { error: string } | undefined): string {
  if (view === undefined) return "";
  if ("error" in view) return `assembly: unknown — ${view.error}\n`;
  const current = view.current;
  if (!current) return "assembly: none — `jr2 up` publishes\n";
  const runs = view.held.find((h) => h.hash === current.hash)?.runs.length ?? 0;
  return `assembly: ${current.hash} (kit v${current.kitVersion}), ${runs} live run${runs === 1 ? "" : "s"} hold${runs === 1 ? "s" : ""} it\n`;
}

/** The human table — the current Assembly, one line per Repo, one per node under it, then the
 * hints for what was seen. */
export function renderInstanceStatus({
  assembly,
  dataPlane,
  repos,
}: {
  assembly?: AssemblyView | { error: string };
  dataPlane: boolean;
  repos: RepoStatus[];
}): string {
  let out = assemblyLine(assembly);
  out += dataPlane
    ? "data plane: yes\n"
    : "data plane: none — this Orchestrator runs outside a cluster, so it provisions no Sandbox (ADR-0069)\n";
  let absent = 0;
  let stale = 0;
  for (const repo of repos) {
    out += `repo ${repo.key} (${repo.url})${repo.bound ? "  bound" : ""}\n`;
    for (const node of repo.nodes) {
      if (node.synced) {
        out += `  node ${node.node}: present, synced\n`;
      } else if (node.lastError === undefined) {
        out += `  node ${node.node}: ${node.present ? "present" : "absent"}, not yet fetched\n`;
      } else {
        if (node.present) stale++;
        else absent++;
        out += `  node ${node.node}: ${node.present ? "stale" : "absent"} — ${node.lastError}\n`;
      }
    }
  }
  if (absent || stale) {
    out +=
      "the cache agent keeps retrying these — register the deploy key with your git host, or fix the url or the " +
      "git.credentials entry, and the next attempt lands (ADR-0047/0048/0051).\n";
  }
  if (absent) out += "absent: Workspaces needing that cache on that node wait until it lands.\n";
  if (stale) out += "stale: attaches proceed on what the cache holds until the next fetch lands.\n";
  return out;
}
