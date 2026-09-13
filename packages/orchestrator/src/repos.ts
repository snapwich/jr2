// The Repo-resource port (ADR-0051): how the Orchestrator creates `Repo` custom resources and reads
// their state back. The Orchestrator CREATES Repos and never syncs them — at boot, one per identity
// its registered Machines bind (so statically known repositories are warm before a run asks), and
// at first attach for a per-run url — and the operator's cache agent does the cloning and fetching
// on every node that needs the repository. What comes back is that agent's per-node status, which
// is what `j2 status` reports and what a provision waits on through the Sandbox's `Ready`.
//
// The port's kubectl implementation (`kubectlRepos`) drives the CRD the same way the Sandbox port
// does (sandbox-kubectl.ts): shelling to `kubectl`, honoring the current kube context, with the
// process seam injectable so the mapping is unit-testable without a cluster.
//
// TWO SPELLINGS, ONE RESOURCE: the resource is named by the cache key, and its `spec.url` and
// `secretRef` are ONE statement — the boot's. The walk collapses every Machine binding an
// identity to the first spelling it meets (parts.ts), and `bind` states that spelling: created on
// the first deploy, restated on every later one, so a config that moved the url or the credential
// reaches the cache at the next boot. A provision only `ensure`s: created if absent, otherwise the
// eviction clock alone — never the spec. So a Machine that binds over ssh what another bound over
// https borrows the cache the boot stated, and its runs never flip the resource between the two
// (each flip is a generation the cache agent re-points origin and refetches on). The push url is
// each Binding's own (attachScript), so nothing about the run is wrong; only the cache's transport
// is shared.

import { credentialSecretFor, matchCredential, type GitCredential } from "./config.ts";
import { ANNOTATION_REPO_IDENTITY, ANNOTATION_REPO_LAST_ATTACHED, LABEL_REPO_BOUND } from "./names.ts";
import { defaultKubectlExec, type KubectlExec } from "./sandbox-kubectl.ts";

/** One node's view of a Repo, as the cache agent reports it on the resource's status. */
export type RepoNodeState = {
  node: string;
  /** A clone exists on this node. */
  present: boolean;
  /** The last attempt — a probe, a clone, or a fetch — succeeded. */
  synced: boolean;
  /** Which of the three the last attempt was. A failed Probe is `j2 status`'s signal for a Repo
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
  /** A registered Machine binds it — never evicted by `j2 gc`. */
  bound: boolean;
  /** When a run last attached it — the eviction clock for a Repo nothing binds. */
  lastAttached?: string;
  nodes: RepoNodeState[];
};

/** The port a deployed Orchestrator drives its Repo resources through. */
export interface RepoResources {
  /**
   * The boot's statement of a Machine's resolution (ADR-0051): create the resource if absent,
   * otherwise restate its url, `secretRef`, and the bound label `j2 gc` honors — so a redeploy
   * that moved the url or the credential reaches the cache. The only caller that writes an
   * existing resource's spec. Resolves the `git.credentials` entry for the identity into the
   * `secretRef` the cache agent reads: an https entry's token materializes as a Secret in Flux's
   * shape, an ssh entry names its deploy-key Secret and the Orchestrator never reads it.
   */
  bind(repo: { url: string; identity: string; key: string }): Promise<void>;
  /**
   * A provision's: create the resource if absent — labeled bound when a Machine's slot names
   * it, so one born before the boot recorded it is not on `j2 gc`'s clock — and annotate it
   * attached now. An existing resource gets the clock and nothing else: its spec is the boot's
   * statement, and a run of a Machine spelling the identity differently must not rewrite it.
   */
  ensure(repo: { url: string; identity: string; key: string; bound: boolean }): Promise<void>;
  /** Drop the bound label from every resource whose key is not in `keys` — a slot unbound since
   * the last deploy is a Repo `j2 gc` may now evict. */
  reconcileBound(keys: Iterable<string>): Promise<void>;
  list(): Promise<RepoStatus[]>;
}

/** The CRD's fully qualified plural — unambiguous to kubectl whatever else calls itself a repo. */
const REPO_RESOURCE = "repos.core.j2.dev";

export type KubectlReposOptions = {
  /** The instance's namespace — the Repo resources live beside the Sandboxes that name them. */
  namespace: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** The instance's `git.credentials`, matched by prefix on the identity (config.ts). */
  credentials: readonly GitCredential[];
  /** Where a token entry's env var is read from (deployed: `process.env`, which the Instance
   * Secret's `envFrom` populated at `j2 up`). Unset → the resource carries no `secretRef` and the
   * clone is anonymous. */
  env: Record<string, string | undefined>;
  /** CR `spec.refreshInterval` — how often the cache agent fetches a warm cache. Default `5m`. */
  refreshInterval?: string;
  /** Process seam, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
  /** The clock `last-attached` is stamped from. Injectable for tests. */
  now?: () => Date;
};

export function kubectlRepos(opts: KubectlReposOptions): RepoResources {
  const exec = opts.exec ?? defaultKubectlExec;
  const now = opts.now ?? (() => new Date());
  const base = ["--namespace", opts.namespace, ...(opts.context ? ["--context", opts.context] : [])];

  /**
   * The Secret the cache agent spends for an https url, in Flux's shape (`username`/`password`),
   * so a Flux or Argo user reuses the Secret they have. Its name is derived from the entry's
   * `match`, so a redeploy finds its own and two entries never share one. Applied (create-or-
   * update) on every ensure: a token rotated by `j2 up` reaches the Secret at the next boot.
   */
  const applyTokenSecret = async (name: string, password: string): Promise<void> => {
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace: opts.namespace, labels: { "app.kubernetes.io/managed-by": "j2" } },
      type: "Opaque",
      stringData: { username: "x-access-token", password },
    };
    await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(secret) });
  };

  /**
   * The `secretRef` for one url: the entry the identity matches, then the url's scheme picks
   * which of its fields applies (config.ts). A token entry whose env var is unset writes no ref —
   * the clone is anonymous, and `j2 status` will show git's refusal if the host wanted one.
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

  /** The resource as one statement writes it: `create` needs the whole, `bind` its spec again. */
  const resourceFor = async (repo: { url: string; identity: string; key: string; bound: boolean }) => {
    const secretRef = await secretRefFor(repo.url, repo.identity);
    const attached = now().toISOString();
    return {
      attached,
      secretRef,
      cr: {
        apiVersion: "core.j2.dev/v1alpha1",
        kind: "Repo",
        metadata: {
          name: repo.key,
          namespace: opts.namespace,
          ...(repo.bound ? { labels: { [LABEL_REPO_BOUND]: "true" } } : {}),
          annotations: { [ANNOTATION_REPO_IDENTITY]: repo.identity, [ANNOTATION_REPO_LAST_ATTACHED]: attached },
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
  const create = async (cr: object): Promise<boolean> => {
    try {
      await exec(["create", ...base, "-f", "-"], { input: JSON.stringify(cr) });
      return true;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return false;
    }
  };

  const patch = async (key: string, body: object): Promise<void> => {
    await exec(["patch", REPO_RESOURCE, key, ...base, "--type", "merge", "-p", JSON.stringify(body)]);
  };

  return {
    async bind(repo) {
      const { attached, secretRef, cr } = await resourceFor({ ...repo, bound: true });
      if (await create(cr)) return;
      // Already there from an earlier deploy: ONE merge patch says what the Machine resolves now —
      // url, credential, and the label `j2 gc` honors. `secretRef: null` clears a credential the
      // config no longer names, so a dropped entry does not linger.
      await patch(repo.key, {
        metadata: {
          labels: { [LABEL_REPO_BOUND]: "true" },
          annotations: { [ANNOTATION_REPO_IDENTITY]: repo.identity, [ANNOTATION_REPO_LAST_ATTACHED]: attached },
        },
        spec: { url: repo.url, secretRef: secretRef ?? null },
      });
    },

    async ensure(repo) {
      const { attached, cr } = await resourceFor(repo);
      if (await create(cr)) return;
      // Already there — the boot's statement, or an earlier run's. Only the eviction clock moves:
      // the run attached it now. Bound or not, the spec stays as stated.
      await patch(repo.key, { metadata: { annotations: { [ANNOTATION_REPO_LAST_ATTACHED]: attached } } });
    },

    async reconcileBound(keys) {
      const keep = new Set(keys);
      const { stdout } = await exec(["get", REPO_RESOURCE, ...base, "-l", `${LABEL_REPO_BOUND}=true`, "-o", "json"]);
      for (const item of itemsOf(stdout)) {
        const name = item.metadata?.name;
        if (name === undefined || keep.has(name)) continue;
        // `<label>-` is kubectl's spelling for "remove the label".
        await exec(["label", REPO_RESOURCE, name, ...base, `${LABEL_REPO_BOUND}-`]);
      }
    },

    async list() {
      const { stdout } = await exec(["get", REPO_RESOURCE, ...base, "-o", "json"]);
      return itemsOf(stdout).map(repoStatusOf);
    },
  };
}

/** A `Repo` resource as `kubectl get -o json` prints it — the fields this port reads. */
type RepoItem = {
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

function itemsOf(stdout: string): RepoItem[] {
  const parsed = JSON.parse(stdout) as { items?: RepoItem[] };
  return parsed.items ?? [];
}

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

function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && /AlreadyExists|already exists/i.test(err.message);
}
