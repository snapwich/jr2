// `jr2 status [runId|abbrev]` (ADR-0009): print a run's status as JSON on stdout, reading through to the
// store so a completed run still reports its terminal status + final context. A genuinely unknown run → 1.
//
// With NO run named, the verb answers about the INSTANCE instead (ADR-0048/0051/0069): every
// Assembly a live run holds, the current one first, whether it has a data plane at all, and every Repo
// resource's per-node state, so a Repo that will not clone — an
// unregistered deploy key (ADR-0047), a wrong url, a git host outage — is discoverable by asking
// the thing that knows, rather than by tailing pod logs. The Orchestrator serves either way; only
// the Repo is degraded, and the cache agent retries it on its own.
//
// Two output classes (ADR-0009 as amended): `status <runId>` is a RESULT verb — the RunStatus as one
// JSON line on stdout, for the pipe. Bare `status` is a REPORT verb — a human table on stdout, or the
// one object with `--json`.
//
// A run that binds a Chart (ADR-0070) carries `bound: true`; the verb says so beside the result as
// `chart: bound`, with the route that draws the Machine the run binds, its Charts compiled in.
//
// A dispatched run (ADR-0071) says beside the result who dispatched it: `dispatched by: <run>
// (<slot>), depth <n>`. A run that dispatched says the other direction, one line per run it
// started: `dispatched: <run> (<slot>)`. The result itself carries `dispatchedBy`, `dispatched`
// and, once the run is no longer live, its `output`, as the Orchestrator sends them.
//
// A run that cut a Worktree (ADR-0075) says each one beside the result, one line per cut:
// `worktree: <path> (<slot>), branch <branch>`, or `, detached`. The result carries `worktrees`.
//
// A failed run (ADR-0073) says its reason beside the result: `failed: <reason>`. The result's
// `output` holds the whole Failure, `{ reason, detail? }`.
//
// A run says beside the result who started it (ADR-0078): `started by: <via>/<name>`, with the
// name jr2 shows and the party the Caller said it acts for. A run that a `dispatch` started names
// its first Caller: the verb walks `startedBy` up the chain of runs to the first one that a Caller
// started, and names the runs between. A run that jr2 started says why (`started by: jr2 (boot)`).
// A cancelled run says who cancelled it: `cancelled by: <via>/<name>`. A standing run (ADR-0017)
// says who resumed it (`resumed by:`) and, once a hand-over ended it, which run took over
// (`handed over to:`). Bare `jr2 status` prints each standing Workflow: live, paused with the number
// of items it holds, or waiting out a back-off.

import type { AssemblyView, CallerRecord, RepoStatus, StandingView } from "@jr2/orchestrator/internal";
import { JR2Client, type FetchLike, type RunStatus, workflowPath } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";
import { parseCommand } from "../command-table.ts";

export async function status(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommand("status", args);
  // NO run named, not an EMPTY one: `jr2 status "$RUNID"` with the variable unset asked about a run
  // and got an empty string, and answering that with the instance's repos would report exit 0 on a
  // question nobody asked. An empty positional falls through to the resolver, which says so.
  const given = positionals.length === 0 ? undefined : positionals[0]!;
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
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
    const notes = [
      await startedByActivity(client, s),
      cancelledByActivity(s),
      ...standingRunLines(s),
      failureActivity(s),
      dispatchedActivity(s),
      ...dispatchedLines(s),
      boundActivity(s),
      ...worktreeLines(s),
    ];
    for (const note of notes) if (note) activity(io, note);
    return 0;
  } finally {
    target.close?.();
  }
}

/** The `failed:` line for a run that ended `failed` (ADR-0073): the Failure's reason, read from its
 * output. Undefined for every other status, and for an output with no reason text. */
export function failureActivity(s: Pick<RunStatus, "status" | "output">): string | undefined {
  if (s.status !== "failed") return undefined;
  const reason = (s.output as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? `failed: ${reason}` : undefined;
}

/** A Caller as one line names it (ADR-0078): `<via>/<name>`, the name jr2 shows, and the party it
 * said it acts for. */
export function callerText(c: CallerRecord): string {
  return (
    `${c.via}/${c.name}` +
    (c.shown !== undefined && c.shown !== c.name ? ` (${c.shown})` : "") +
    (c.onBehalfOf !== undefined ? ` on behalf of ${c.onBehalfOf}` : "")
  );
}

/** The most runs the `started by:` walk reads: a chain of dispatches longer than this is named as
 * cut, never read without end. */
const STARTED_BY_HOPS = 16;

/**
 * The `started by:` line (ADR-0078): the run's first Caller. A run that a `dispatch` started is
 * walked up its `startedBy` chain, one read per run, to the first run that a Caller or jr2 started;
 * the line names the runs between, nearest first. A run of the chain that the Caller may not read,
 * or that is no longer known, ends the walk, and the line says so. Undefined for a run that records
 * no starter.
 */
export async function startedByActivity(
  client: Pick<JR2Client, "read">,
  s: Pick<RunStatus, "startedBy">,
): Promise<string | undefined> {
  let by = s.startedBy;
  if (!by) return undefined;
  const through: string[] = [];
  const via = () => (through.length ? `, through ${through.join(" ← ")}` : "");
  while (by.kind === "run") {
    if (through.length >= STARTED_BY_HOPS) {
      return `started by: not read — the chain is longer than ${STARTED_BY_HOPS} runs${via()}`;
    }
    const hop = `run ${by.run} (${by.slot})`;
    let next: RunStatus | undefined;
    try {
      next = await client.read(by.run);
    } catch (e) {
      return `started by: not read — ${hop}: ${e instanceof Error ? e.message : String(e)}${via()}`;
    }
    if (!next) return `started by: not known — ${hop} is no longer known${via()}`;
    through.push(hop);
    if (!next.startedBy) return `started by: not recorded${via()}`;
    by = next.startedBy;
  }
  if (by.kind === "jr2") return `started by: jr2 (${by.why})${via()}`;
  const { kind: _kind, ...caller } = by;
  return `started by: ${callerText(caller)}${via()}`;
}

/** A standing run's lines (ADR-0017): the Caller whose `jr2 run` resumed it, and the run that took
 * over from it at a hand-over. */
export function standingRunLines(s: Pick<RunStatus, "resumedBy" | "handedOverTo">): string[] {
  return [
    ...(s.resumedBy ? [`resumed by: ${callerText(s.resumedBy)}`] : []),
    ...(s.handedOverTo ? [`handed over to: ${s.handedOverTo}`] : []),
  ];
}

/** The `cancelled by:` line for a run a Caller cancelled (ADR-0078). */
export function cancelledByActivity(s: Pick<RunStatus, "cancelledBy">): string | undefined {
  return s.cancelledBy ? `cancelled by: ${callerText(s.cancelledBy)}` : undefined;
}

/** The most `dispatched:` lines `jr2 status` prints: a watcher dispatches on every pass, and the
 * result carries the whole list. */
const DISPATCHED_LINES = 10;

/** The `dispatched:` lines for the runs this run's `dispatch` Effects started (ADR-0071), newest
 * last, the older ones counted. */
export function dispatchedLines(s: RunStatus): string[] {
  const all = s.dispatched ?? [];
  const shown = all.slice(-DISPATCHED_LINES);
  const older = all.length - shown.length;
  return [
    ...(older > 0 ? [`dispatched: ${older} older run(s); the result lists them all`] : []),
    ...shown.map((d) => `dispatched: ${d.run} (${d.slot})`),
  ];
}

/** The `worktree:` lines for the Worktrees this run's cuts made (ADR-0075), oldest first. */
export function worktreeLines(s: RunStatus): string[] {
  return (s.worktrees ?? []).map(
    (w) => `worktree: ${w.path} (${w.slot}), ${w.branch === null ? "detached" : `branch ${w.branch}`}`,
  );
}

/** The `dispatched by:` line for a run a `dispatch` Effect started (ADR-0071), or undefined for a
 * run nobody dispatched. A foreign caller is named by its Orchestrator, as that one sent it: opaque
 * text, which this Orchestrator could not verify. */
export function dispatchedActivity(s: RunStatus): string | undefined {
  const by = s.dispatchedBy;
  if (!by) return undefined;
  // A Pool of runs (ADR-0017) names the item's key, and the Hook delivery that carried it.
  const pool =
    by.key !== undefined
      ? `, key ${by.key}${
          by.hook
            ? `, hook ${by.hook.name}, delivery ${by.hook.delivery}${by.hook.onBehalfOf ? `, on behalf of ${by.hook.onBehalfOf}` : ""}`
            : ""
        }`
      : "";
  return `dispatched by: ${by.run} (${by.slot}), depth ${by.depth}${by.instance ? `, from Orchestrator ${by.instance}` : ""}${pool}`;
}

/** The `chart: bound` line for a run that binds a Chart (ADR-0070), or undefined for one that binds
 * none. The Workflow name rides the route as one encoded segment. */
export function boundActivity(s: RunStatus): string | undefined {
  if (s.bound !== true) return undefined;
  const route = `GET ${workflowPath(s.workflow)}/runs/${encodeURIComponent(s.runId)}/machine`;
  // A drifted run's Chart may no longer admit (D-B): the route then draws the slot's own subgraph
  // and names why in `chartsNotDrawn`, so the line does not claim more than the route draws.
  if (s.status === "drifted") return `chart: bound, drifted — ${route} names each Chart it cannot draw`;
  return `chart: bound — ${route} draws the Machine this run binds`;
}

/**
 * The instance's own status: the held Assemblies, the data-plane switch and every Repo resource. As a table on stdout —
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
async function readAssembly(fetchImpl: FetchLike, url: string): Promise<InstanceAssembly | { error: string }> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/assembly`);
    if (!res.ok) return { error: `GET /assembly answered HTTP ${res.status}` };
    // Read loosely: a `held` that is absent or not a list reads as none held, so a report never
    // fails on the shape of one field (ADR-0048: a report is not a failure of the asking).
    const view = (await res.json()) as Partial<AssemblyView>;
    const standing = (view as { standing?: unknown }).standing;
    return {
      kitVersion: view.kitVersion ?? "",
      current: view.current ?? null,
      held: Array.isArray(view.held) ? view.held : [],
      ...(Array.isArray(standing) ? { standing: standing as StandingView[] } : {}),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The Assembly lines (ADR-0069): one per Assembly a live run holds, the current one first and so
 * marked, each with how many live runs hold it — or why there is none. A run holds the Assembly it
 * started under, so after a publish the previous one stays on the volume while a run still holds it.
 * The current Assembly prints first, whatever order `held` uses; the other held Assemblies follow
 * in the server's order.
 */
function assemblyLines(view: InstanceAssembly | { error: string } | undefined): string {
  if (view === undefined) return "";
  if ("error" in view) return `assembly: unknown — ${view.error}\n`;
  const current = view.current;
  const heldList = view.held;
  const line = (hash: string, kitVersion: string, runs: number, isCurrent: boolean): string =>
    `assembly: ${hash} (kit v${kitVersion}${isCurrent ? ", current" : ""}), ` +
    `${runs} live run${runs === 1 ? "" : "s"} hold${runs === 1 ? "s" : ""} it\n`;
  let out = "";
  if (current) {
    const runs = heldList.find((h) => h.hash === current.hash)?.runs.length ?? 0;
    out += line(current.hash, current.kitVersion, runs, true);
  } else {
    out += "assembly: none — `jr2 up` publishes\n";
  }
  for (const held of heldList) {
    if (held.hash === current?.hash) continue;
    out += line(held.hash, held.kitVersion, held.runs.length, false);
  }
  for (const s of view.standing ?? []) out += `${standingLine(s)}\n`;
  return out;
}

/** What `GET /assembly` answers, with its standing Workflows (ADR-0017). */
export type InstanceAssembly = AssemblyView & { standing?: StandingView[] };

/**
 * One standing Workflow as one line (ADR-0017): its Pool's chain to its callee, and its state. A
 * paused one says why, how many items it holds and how to resume it; one with no live run and no
 * pause waits out the back-off of a hand-over.
 */
export function standingLine(s: StandingView): string {
  const items = `${s.held} held item${s.held === 1 ? "" : "s"}`;
  const head = `standing ${s.workflow} → ${s.callee}`;
  if (s.state === "live") return `${head}: live, run ${s.run ?? "?"}, ${items}`;
  if (s.state === "paused") {
    const why =
      s.why === "errors"
        ? "4 runs in a row in which no item that the run took started a run; the last one ended error or failed"
        : s.why === "bound"
          ? "4 runs in a row in which no item that the run took started a run; the last one took its bound of items"
          : "a cancel";
    return (
      `${head}: paused (${why}), ${items}${s.run ? ` in run ${s.run}` : ""} — \`jr2 run ${s.workflow}\` resumes it, ` +
      "and `--drop-held` resumes it with no held item"
    );
  }
  return `${head}: no live run — jr2 starts its next run after the back-off`;
}

/** The human table — the held Assemblies, current first, one line per Repo, one per node under it, then the
 * hints for what was seen. */
export function renderInstanceStatus({
  assembly,
  dataPlane,
  repos,
}: {
  assembly?: InstanceAssembly | { error: string };
  dataPlane: boolean;
  repos: RepoStatus[];
}): string {
  let out = assemblyLines(assembly);
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
