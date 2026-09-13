// The Repo-resource port (ADR-0051): how the Orchestrator creates `Repo` custom resources and reads
// their state back. The Orchestrator CREATES Repos and never syncs them — at boot, one per identity
// its registered Machines bind (so statically known repositories are warm before a run asks), and
// at first attach for a per-run url — and the operator's cache agent does the cloning and fetching
// on every node that needs the repository. What comes back is that agent's per-node status, which
// is what `j2 status` reports and what a provision waits on through the Sandbox's `Ready`.
//
// This module holds the port's CONTRACT. Its kubectl implementation (`kubectlRepos`) is the boot's
// and the provision's business and lands beside it.

/** One node's view of a Repo, as the cache agent reports it on the resource's status. */
export type RepoNodeState = {
  node: string;
  /** A clone exists on this node. */
  present: boolean;
  /** The last attempt — a probe, a clone, or a fetch — succeeded. */
  synced: boolean;
  lastAttempt?: string;
  /** The last successful clone or fetch. */
  lastFetched?: string;
  /** git's own words; absent when synced. */
  lastError?: string;
};

/** One `Repo` resource as the instance reports it (`GET /repos`). */
export type RepoStatus = {
  /** The cache key (repo-identity.ts): the resource's name, the hostPath leaf, `/repos/<key>`. */
  key: string;
  /** The Binding's own spelling — what the cache clones. */
  url: string;
  identity?: string;
  /** A registered Machine binds it — never evicted by `j2 gc`. */
  bound: boolean;
  /** When a run last attached it — the eviction clock for a Repo nothing binds. */
  lastAttached?: string;
  nodes: RepoNodeState[];
};

/** The port a deployed Orchestrator drives its Repo resources through. */
export interface RepoResources {
  /**
   * Create the resource if absent (AlreadyExists tolerated) and annotate it attached now; when
   * `bound`, also label it bound and patch its spec to the current resolution. Resolves the
   * `git.credentials` entry for the identity and writes the `secretRef` the cache agent reads
   * (ADR-0051): an https entry's token materializes as a Secret in Flux's shape, an ssh entry
   * names its deploy-key Secret and the Orchestrator never reads it.
   */
  ensure(repo: { url: string; identity: string; key: string; bound: boolean }): Promise<void>;
  /** Drop the bound label from every resource whose key is not in `keys` — a slot unbound since
   * the last deploy is a Repo `j2 gc` may now evict. */
  reconcileBound(keys: Iterable<string>): Promise<void>;
  list(): Promise<RepoStatus[]>;
}
