// The Repo-resource port (ADR-0051): how the Orchestrator creates `Repo` custom resources and reads
// their state back. The Orchestrator CREATES Repos and never syncs them — at boot, one per identity
// its registered Machines bind (so statically known repositories are known — probed — before a
// run asks; a node clones on first demand), and
// at first attach for a per-run url — and the operator's cache agent does the cloning and fetching
// on every node that needs the repository. What comes back is that agent's per-node status, which
// is what `jr2 status` reports and what a provision waits on through the Sandbox's `Ready`.
//
// The port's implementation (`kubeRepos`) drives the CRD the same way the Sandbox port does
// (sandbox-kube.ts): through the Orchestrator's own Kubernetes client (kube-client.ts, ADR-0063),
// injectable so the mapping is unit-testable against a fake API server.
//
// TWO SPELLINGS, ONE RESOURCE: the resource is named by the cache key, and its `spec.url` and
// `secretRef` are ONE statement — the boot's. The walk collapses every Machine binding an
// identity to the first spelling it meets (parts.ts), and `bind` states that spelling: created on
// the first deploy, restated on every later one, so a config that moved the url or the credential
// reaches the cache at the next boot. A provision only `ensure`s: created if absent, otherwise the
// eviction clock — never the url. So a Machine that binds over ssh what another bound over https
// borrows the cache the boot stated, and its runs never flip the resource between the two (each
// flip is a generation the cache agent re-points origin and refetches on). The push url is each
// Binding's own (the Harness's attach, ADR-0063), so nothing about the run is wrong; only the cache's transport is
// shared.
//
// A resource NOTHING binds has no boot to restate it, so the provision is its one writer: an
// `ensure` of an existing unbound resource re-resolves the `secretRef` against the url that
// stands — the first attach's spelling, which the run's own spelling never replaces — so a
// `git.credentials` entry fixed after a failed clone reaches the cache at the next run, the path
// the clone error and `jr2 status` name (ADR-0048).
//
// The eviction clock is the RUN's: only an `ensure` stamps `last-attached`. The boot's `bind`
// touches the label and the spec, never the clock, so a Repo the boot created and no run attached
// carries no stamp and `jr2 gc` dates it from its `creationTimestamp` — a boot is not an attach.

import { credentialSecretFor, matchCredential, type GitCredential } from "./config.ts";
import { ANNOTATION_REPO_IDENTITY, ANNOTATION_REPO_LAST_ATTACHED, LABEL_REPO_BOUND } from "./names.ts";
import { REPOS, SECRETS, isAlreadyExists, kubeClient, KubeError, type KubeClient } from "./kube-client.ts";

/** One node's view of a Repo, as the cache agent reports it on the resource's status. */
export type RepoNodeState = {
  node: string;
  /** A clone exists on this node. */
  present: boolean;
  /** The last attempt — a probe, a clone, or a fetch — succeeded. */
  synced: boolean;
  /** Which of the three the last attempt was. A failed Probe is `jr2 status`'s signal for a Repo
   * no pod on the node mounts yet; only a failed Clone fails a Sandbox waiting on that node. */
  attempted?: "Probe" | "Clone" | "Fetch";
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
  /** A registered Machine binds it — never evicted by `jr2 gc`. */
  bound: boolean;
  /** When a run last attached it — the eviction clock for a Repo nothing binds. Absent while only
   * the boot has stated it: a bound Repo no run has attached yet. */
  lastAttached?: string;
  nodes: RepoNodeState[];
};

/** The port a deployed Orchestrator drives its Repo resources through. */
export interface RepoResources {
  /**
   * The boot's statement of a Machine's resolution (ADR-0051): create the resource if absent,
   * otherwise restate its url, `secretRef`, and the bound label `jr2 gc` honors — so a redeploy
   * that moved the url or the credential reaches the cache. The only caller that writes a BOUND
   * resource's spec, and never the eviction clock: a boot is not an attach. Resolves the
   * `git.credentials` entry for the identity into the `secretRef` the cache agent reads: an https
   * entry's token materializes as a Secret in Flux's shape, an ssh entry names its deploy-key
   * Secret and the Orchestrator never reads it.
   */
  bind(repo: { url: string; identity: string; key: string }): Promise<void>;
  /**
   * A provision's: create the resource if absent — labeled bound when a Machine's slot names
   * it, so one born before the boot recorded it is not on `jr2 gc`'s clock — and annotate it
   * attached now. An existing resource gets the clock; its url stands (the boot's statement, or
   * the first attach's), and a run of a Machine spelling the identity differently must not
   * rewrite it. One a Machine binds gets nothing else — the boot restates its credential. One
   * nothing binds has no boot, so the provision restates its `secretRef`, resolved against the
   * url that stands: the fix the clone error names reaches the cache at the next run.
   */
  ensure(repo: { url: string; identity: string; key: string; bound: boolean }): Promise<void>;
  /** Drop the bound label from every resource whose key is not in `keys` — a slot unbound since
   * the last deploy is a Repo `jr2 gc` may now evict. */
  reconcileBound(keys: Iterable<string>): Promise<void>;
  list(): Promise<RepoStatus[]>;
}

export type KubeReposOptions = {
  /** The instance's namespace — the Repo resources live beside the Sandboxes that name them. */
  namespace: string;
  /** The instance's `git.credentials`, matched by prefix on the identity (config.ts). */
  credentials: readonly GitCredential[];
  /** Where a token entry's env var is read from (deployed: `process.env`, which the Instance
   * Secret's `envFrom` populated at `jr2 up`). Unset → the resource carries no `secretRef` and the
   * clone is anonymous. */
  env: Record<string, string | undefined>;
  /** CR `spec.refreshInterval` — how often the cache agent fetches a warm cache. Default `5m`. */
  refreshInterval?: string;
  /** The Kubernetes client (ADR-0063), shared with the Sandbox port. Default: the in-cluster one. */
  client?: KubeClient;
  /** The clock `last-attached` is stamped from. Injectable for tests. */
  now?: () => Date;
};

export function kubeRepos(opts: KubeReposOptions): RepoResources {
  const now = opts.now ?? (() => new Date());
  const ns = opts.namespace;
  // Built on first use: a boot never needs the cluster to construct this port (ADR-0048).
  let client: KubeClient | undefined = opts.client;
  const kube = () => (client ??= kubeClient());

  /**
   * The Secret the cache agent spends for an https url, in Flux's shape (`username`/`password`),
   * so a Flux or Argo user reuses the Secret they have. Its name is derived from the entry's
   * `match`, so a redeploy finds its own and two entries never share one. Applied (create-or-
   * update) on every ensure: a token rotated by `jr2 up` reaches the Secret at the next boot.
   * `data`, not `stringData`: a server-side apply owns the fields it names, and `stringData` never
   * reads back as one.
   */
  const applyTokenSecret = async (name: string, password: string): Promise<void> => {
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    await kube().apply(SECRETS, ns, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace: ns, labels: { "app.kubernetes.io/managed-by": "jr2" } },
      type: "Opaque",
      data: { username: b64("x-access-token"), password: b64(password) },
    });
  };

  /**
   * The `secretRef` for one url: the entry the identity matches, then the url's scheme picks
   * which of its fields applies (config.ts). A token entry whose env var is unset writes no ref —
   * the clone is anonymous, and `jr2 status` will show git's refusal if the host wanted one.
   */
  const secretRefFor = async (url: string, identity: string): Promise<{ name: string } | undefined> => {
    const cred = credentialSecretFor(url, matchCredential(identity, opts.credentials));
    if (cred === undefined) return undefined;
    if (cred.kind === "ssh") return { name: cred.secret };
    const value = opts.env[cred.env];
    if (value === undefined || value === "") return undefined;
    await applyTokenSecret(cred.secret, value);
    return { name: cred.secret };
  };

  /** The resource as one statement writes it: `create` needs the whole, `bind` its spec again.
   * `attached` is the run's clock — a provision passes it, the boot does not. */
  const resourceFor = async (
    repo: { url: string; identity: string; key: string; bound: boolean },
    attached?: string,
  ) => {
    const secretRef = await secretRefFor(repo.url, repo.identity);
    return {
      secretRef,
      cr: {
        apiVersion: "core.jr2.dev/v1alpha1",
        kind: "Repo",
        metadata: {
          name: repo.key,
          namespace: ns,
          ...(repo.bound ? { labels: { [LABEL_REPO_BOUND]: "true" } } : {}),
          annotations: {
            [ANNOTATION_REPO_IDENTITY]: repo.identity,
            ...(attached !== undefined ? { [ANNOTATION_REPO_LAST_ATTACHED]: attached } : {}),
          },
        },
        spec: {
          url: repo.url,
          ...(secretRef ? { secretRef } : {}),
          refreshInterval: opts.refreshInterval ?? "5m",
        },
      },
    };
  };

  /** Create, never apply — an existing resource keeps its spec. True when this call created it. */
  const create = async (cr: RepoItem & { metadata: { name: string } }): Promise<boolean> => {
    try {
      await kube().create(REPOS, ns, cr);
      return true;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return false;
    }
  };

  const patch = async (key: string, body: object): Promise<void> => {
    await kube().patch(REPOS, ns, key, body);
  };

  /** One resource as it stands — what an unbound `ensure` restates its credential against. */
  const get = async (key: string): Promise<RepoItem> => {
    const item = await kube().get<RepoItem>(REPOS, ns, key);
    if (!item) throw new Error(`Repo "${key}" vanished between its create and its read`);
    return item;
  };

  return {
    async bind(repo) {
      const { secretRef, cr } = await resourceFor({ ...repo, bound: true });
      if (await create(cr)) return;
      // Already there from an earlier deploy: ONE merge patch says what the Machine resolves now —
      // url, credential, and the label `jr2 gc` honors. `secretRef: null` clears a credential the
      // config no longer names, so a dropped entry does not linger. The clock is not touched: it
      // records attaches, and a boot is not one.
      await patch(repo.key, {
        metadata: {
          labels: { [LABEL_REPO_BOUND]: "true" },
          annotations: { [ANNOTATION_REPO_IDENTITY]: repo.identity },
        },
        spec: { url: repo.url, secretRef: secretRef ?? null },
      });
    },

    async ensure(repo) {
      const attached = now().toISOString();
      const { cr } = await resourceFor(repo, attached);
      if (await create(cr)) return;
      // Already there — the boot's statement, or an earlier run's. The eviction clock moves: the
      // run attached it now. The url stays as stated, whatever spelling this run brought.
      const clock = { metadata: { annotations: { [ANNOTATION_REPO_LAST_ATTACHED]: attached } } };
      // A Machine's slot binds it: the boot is its writer, and restates the credential at the next
      // deploy. Read nothing.
      if (repo.bound) return patch(repo.key, clock);
      // This run's slot is per-run, but another registered Machine may bind the identity — the
      // label says so, and then the boot is still the writer.
      const standing = await get(repo.key);
      if (standing.metadata?.labels?.[LABEL_REPO_BOUND] === "true") return patch(repo.key, clock);
      // Nothing binds it: no boot ever restates it, so this attach does — the credential resolved
      // against the url that STANDS, since the scheme picks the Secret's kind (config.ts) and the
      // cache clones that url, not this run's spelling of it. `secretRef: null` clears an entry
      // the config no longer names.
      const secretRef = await secretRefFor(standing.spec?.url ?? repo.url, repo.identity);
      await patch(repo.key, { ...clock, spec: { secretRef: secretRef ?? null } });
    },

    async reconcileBound(keys) {
      const keep = new Set(keys);
      let items: RepoItem[];
      try {
        ({ items } = await kube().list<RepoItem>(REPOS, ns, { labelSelector: `${LABEL_REPO_BOUND}=true` }));
      } catch (err) {
        // A cluster with no `repos.core.jr2.dev` resource type holds no Repos, so "nothing to
        // unlabel" is the complete answer — the one read that may answer none. An instance that
        // binds nothing runs this reconcile on every boot (server.ts), and `operator.manage: false`
        // without the operator is exactly the cluster where the type is absent: an error line there
        // would report a failure that is not one. Any other refusal still throws.
        if (!isMissingResourceType(err)) throw err;
        return;
      }
      for (const item of items) {
        const name = item.metadata?.name;
        if (name === undefined || keep.has(name)) continue;
        // A merge patch's `null` removes the label.
        await patch(name, { metadata: { labels: { [LABEL_REPO_BOUND]: null } } });
      }
    },

    async list() {
      const { items } = await kube().list<RepoItem>(REPOS, ns);
      return items.map(repoStatusOf);
    },
  };
}

/** A `Repo` resource as the API server answers it — the fields this port reads. */
type RepoItem = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: { url?: string };
  status?: {
    nodes?: Array<{
      node: string;
      present?: boolean;
      synced?: boolean;
      attempted?: "Probe" | "Clone" | "Fetch";
      lastAttempt?: string;
      lastFetched?: string;
      lastError?: string;
    }>;
  };
};

/** The resource → what `GET /repos` reports: the Orchestrator's own metadata read back, and the
 * cache agent's per-node entries verbatim. Absent optional fields stay absent, not `undefined`
 * keys, so the JSON a client sees is exactly the type. */
export function repoStatusOf(item: RepoItem): RepoStatus {
  const identity = item.metadata?.annotations?.[ANNOTATION_REPO_IDENTITY];
  const lastAttached = item.metadata?.annotations?.[ANNOTATION_REPO_LAST_ATTACHED];
  return {
    key: item.metadata?.name ?? "",
    url: item.spec?.url ?? "",
    ...(identity !== undefined ? { identity } : {}),
    bound: item.metadata?.labels?.[LABEL_REPO_BOUND] === "true",
    ...(lastAttached !== undefined ? { lastAttached } : {}),
    nodes: (item.status?.nodes ?? []).map((n) => ({
      node: n.node,
      present: n.present ?? false,
      synced: n.synced ?? false,
      ...(n.attempted !== undefined ? { attempted: n.attempted } : {}),
      ...(n.lastAttempt !== undefined ? { lastAttempt: n.lastAttempt } : {}),
      ...(n.lastFetched !== undefined ? { lastFetched: n.lastFetched } : {}),
      ...(n.lastError !== undefined && n.lastError !== "" ? { lastError: n.lastError } : {}),
    })),
  };
}

/** The API server's answer for a kind it does not serve: 404 on the collection itself — the Repo
 * type is the operator's to install (ADR-0051), and an instance may be deployed where nothing
 * installed it. (An object that is absent is a 404 on the OBJECT, which a list never asks for.) */
function isMissingResourceType(err: unknown): boolean {
  return err instanceof KubeError && err.status === 404;
}
