// The Repo half of `jr2 gc` (ADR-0051): eviction is reachability plus age. A `Repo` resource is kept
// while a registered Machine binds it — the Orchestrator labels those at every boot and unlabels
// what its walk no longer names — and, unbound, while a run has attached it within the TTL; the
// Orchestrator moves that clock on every attach. What is left is a Repo nothing binds that no run
// has asked for lately, and deleting the resource is what lets the cache agent evict the node
// copies once nothing there mounts them. The sweep only ever deletes RESOURCES: the bytes on each
// node are the agent's to reclaim, on its own schedule.
//
// Cluster-wide like the image sweep (sweep.ts): every namespace some instance owns is read, so
// "disk is full now" reaches every instance's caches from anywhere. A cluster with no Repo CRD holds
// no Repos — the one read that may answer "none" — while any other failure throws and the caller
// sweeps nothing.

import { ANNOTATION_REPO_LAST_ATTACHED, LABEL_REPO_BOUND } from "@jr2/orchestrator";
import { LABEL_INSTANCE } from "./deploy.ts";
import { isMissingResourceType, type KubeAdmin } from "./kube.ts";
import { activity, type Io } from "./output.ts";

/** The CRD, fully qualified so the read cannot collide with another `repos` resource. */
export const REPO_KIND = "repos.core.jr2.dev";

/** The eviction TTL `jr2 gc` applies when none is given. */
export const DEFAULT_REPO_TTL = "7d";

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** `<n>d|h|m` → milliseconds; `0` is "now" (evict everything unbound). Anything else is refused by
 * name, so a typo cannot read as a zero TTL. */
export function parseRepoTtl(text: string): number {
  if (text === "0") return 0;
  const m = /^(\d+)([dhm])$/.exec(text);
  if (!m) throw new Error(`--repo-ttl ${JSON.stringify(text)} is not a TTL — use <n>d, <n>h, or <n>m (or 0 for now)`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

type RepoObject = {
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { url?: string };
};

/** One Repo the sweep decided about: where it is, what it clones, and when it was last wanted. */
export type SweptRepo = { namespace: string; key: string; url: string; lastAttached: string };

/**
 * Whether one Repo is garbage at `now`, under `ttlMs`: unbound, and last attached (or, never
 * attached, created) before the TTL's edge. An unreadable clock keeps the Repo — a resource this
 * cannot date is not one it may take.
 */
export function repoIsEvictable(repo: RepoObject, now: Date, ttlMs: number): boolean {
  if (repo.metadata.labels?.[LABEL_REPO_BOUND] === "true") return false;
  const stamp = repo.metadata.annotations?.[ANNOTATION_REPO_LAST_ATTACHED] ?? repo.metadata.creationTimestamp;
  if (stamp === undefined) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at >= ttlMs;
}

/**
 * One sweep: every instance namespace's Repos, those the rule above evicts deleted (or, dry, named).
 * Returns what went, for the caller's narration. Throws on any read the fail-closed rule does not
 * excuse — though here a partial read can only UNDER-collect, the caller still owes the user a true
 * "swept nothing" rather than a silent short list.
 */
export async function sweepRepos(opts: {
  io: Io;
  kube: KubeAdmin;
  ctx: { context?: string };
  ttl: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SweptRepo[]> {
  const { io, kube, ctx, ttl, dryRun } = opts;
  const ttlMs = parseRepoTtl(ttl);
  const now = (opts.now ?? (() => new Date()))();
  const namespaces = (await kube.listJson({ kind: "namespace", selector: LABEL_INSTANCE, ...ctx })).map(
    (n) => n.metadata.name,
  );
  const swept: SweptRepo[] = [];
  for (const namespace of namespaces) {
    for (const repo of await listRepos(kube, namespace, ctx)) {
      if (!repoIsEvictable(repo, now, ttlMs)) continue;
      const entry: SweptRepo = {
        namespace,
        key: repo.metadata.name,
        url: repo.spec?.url ?? "",
        lastAttached:
          repo.metadata.annotations?.[ANNOTATION_REPO_LAST_ATTACHED] ?? repo.metadata.creationTimestamp ?? "",
      };
      if (!dryRun) await kube.deleteObject({ kind: REPO_KIND, name: entry.key, namespace, ...ctx });
      swept.push(entry);
    }
  }
  narrateRepoSweep(io, swept, { ttl, dryRun });
  return swept;
}

/** The Repos of one namespace, with the one degradation the fail-closed rule allows: a cluster with
 * no `repos.core.jr2.dev` resource type (the operator never reached it, or `jr2 down --all` took the
 * CRD) holds no Repos, so "none" is the complete answer. */
async function listRepos(kube: KubeAdmin, namespace: string, ctx: { context?: string }): Promise<RepoObject[]> {
  try {
    return await kube.listJson<RepoObject>({ kind: REPO_KIND, namespace, ...ctx });
  } catch (err) {
    if (isMissingResourceType(err)) return [];
    throw err;
  }
}

/** `repos: swept 2 Repo resource(s) no Machine binds and no run attached within 7d` — the count and
 * the rule, since the rule is the whole justification; the resources themselves are listed only for
 * a dry run, where the plan IS the output. */
function narrateRepoSweep(io: Io, swept: SweptRepo[], opts: { ttl: string; dryRun?: boolean }): void {
  const verb = opts.dryRun ? "would sweep" : "swept";
  if (swept.length === 0) {
    activity(
      io,
      `repos: ${verb} nothing — every Repo resource is bound by a Machine or was attached within ${opts.ttl}`,
    );
    return;
  }
  activity(
    io,
    `repos: ${verb} ${swept.length} Repo resource(s) no Machine binds and no run attached within ${opts.ttl}`,
  );
  if (opts.dryRun) {
    for (const r of swept) activity(io, `  ${r.namespace}/${r.key} (${r.url}) — last attached ${r.lastAttached}`);
  }
}
