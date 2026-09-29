// The fixed in-namespace object names of a deployed instance (ADR-0019). The namespace is the
// instance's IDENTITY, so names inside it are constants — shared by `jr2 up` (which creates them),
// the CLI transport (which dials them), and the server entrypoint (which consumes them).

/** The orchestrator's Deployment + Service name; the Service targets `ORCHESTRATOR_PORT`. */
export const ORCHESTRATOR_SERVICE = "jr2-orchestrator";
export const ORCHESTRATOR_PORT = 4000;

/** The instance-owned Secret: Instance token + signing key (+ orchestrator-side creds). */
export const INSTANCE_SECRET = "jr2-instance";

/** The Instance Harness's Deployment + Service name (ADR-0031): converged by `jr2 up` whenever any
 * Agent definition declares `workspace: "none"`, and the deterministic Service DNS the Agent actor
 * resolves such a Turn to. Doubles as the delivery scope a Menu-only registration records — the
 * name the placement's Sandbox token is signed for (tokens.ts, ADR-0013), which its Custodian holds. The port is the
 * Harness's own listen port (`PORT` default). */
export const INSTANCE_HARNESS_SERVICE = "jr2-instance-harness";
export const INSTANCE_HARNESS_PORT = 8080;

/** The harness config ConfigMap the stock Harness boots from (ADR-0018): what this instance can
 * REACH — the custom model provider minus its key, and the catalog providers' gateways (ADR-0059). No Agents ride it: a Machine carries its own
 * (ADR-0049), and the definition rides each admission, so this holds deployment facts alone
 * (ADR-0050). */
export const HARNESS_CONFIGMAP = "jr2-harness";
/** Its one key, hence the env var's value — `JR2_HARNESS_JSON` on every Harness container. */
export const HARNESS_CONFIG_KEY = "harness.json";

/** The resolved image map `jr2 up` writes and every provision reads (ADR-0037/0038): key → ref for
 * the Harness, the Custodian, and every Sandbox Image context the registered Machines carry — keyed
 * by content digest, plus the reserved `default` (ADR-0049).
 *
 * MOUNTED, never projected into env — the load-bearing part. A mount updates in place through
 * kubelet propagation, so adding a CLI to a Dockerfile costs one propagation window; the same map
 * as Deployment env would be a pod-template change, rolling the Orchestrator and putting every
 * live run through snapshot restore (ADR-0007) for a change that affects only FUTURE Sandboxes. */
export const IMAGES_CONFIGMAP = "jr2-images";
export const IMAGES_MOUNT = "/etc/jr2/images";
/** The ConfigMap key, hence the filename under the mount — the two-sided contract's other half. */
export const IMAGES_KEY = "images.json";

/** The HARNESS containers' env Secret — the literal `harness.env` values, never the Instance token
 * (ADR-0013) and never a model key (ADR-0059: those are held). */
export const HARNESS_ENV_SECRET = "jr2-harness-env";

/** The instance's trust ConfigMap (ADR-0020, ADR-0059): the user's `harness.caBundle` as `ca.crt`
 * and, while a held secret exists, the three bundles the held-secret path needs — `extra.crt` and
 * `bundle.crt` for the Harness, `upstream.crt` for the Custodian. Public data by nature. */
export const CA_CONFIGMAP = "jr2-ca";

/** Held secrets (ADR-0059). The per-Instance CA — its key included — that `jr2 up` alone reads over
 * the kube API, and that NO pod mounts: every leaf is issued before a pod starts. */
export const HELD_CA_SECRET = "jr2-held-ca";
/** The literal held values, one key per name — mounted into the Custodian and nothing else. */
export const HELD_SECRETS_SECRET = "jr2-held-secrets";
/** One leaf per bound `host:port` (`<stem>.crt`, `<stem>.key`) — the Custodian's alone. */
export const HELD_TLS_SECRET = "jr2-held-tls";
/** `held.json` (what `jr2 up` resolved) plus the Custodian's bootstrap and script. Always applied,
 * possibly holding no secret: every Harness pod runs a Custodian. */
export const HELD_CONFIGMAP = "jr2-held";
/** Where the Orchestrator reads `held.json`, per provision — a mount, so a held-secret edit reaches
 * future Sandboxes without rolling the Orchestrator (the `jr2-images` pattern, ADR-0038). */
export const HELD_MOUNT = "/etc/jr2/held";
export const HELD_KEY = "held.json";

/** The Custodian's listeners (ADR-0059), all taken on every Harness pod (ADR-0005): the Harness's
 * HTTPS proxy on loopback, the kubelet's probe, and the control listener the Menu and the ask ride
 * to the Orchestrator, at the address `jr2-upload-pack` defaults to (ADR-0053). */
export const CUSTODIAN_PORT = 15001;
export const CUSTODIAN_HEALTH_PORT = 15021;
export const CUSTODIAN_CONTROL_PORT = 8081;

/** The scaffold's default deploy-key Secret name (ADR-0047/0051): what `jr2 init`'s wildcard
 * `git.credentials` entry names as its `sshKey`, and what `jr2 up`'s ssh offer generates into when
 * an entry names it. Only a default — an entry may name any Secret. */
export const GIT_SSH_SECRET = "jr2-git-ssh";

/** The snapshot store's PVC (sqlite lives on it — ADR-0019). */
export const STATE_PVC = "jr2-state";

/** The cache agent (ADR-0051): the per-Instance DaemonSet that clones each Repo onto its node and
 * fetches it in place, plus its ServiceAccount/Role/RoleBinding, all by this name. */
export const REPO_CACHE = "jr2-repo-cache";
/** The node directory the cache agent owns — `<REPO_CACHE_HOSTPATH>/<namespace>/repos/<key>` is one
 * Repo's bare clone on one node, mounted read-only into every Sandbox there that names it. */
export const REPO_CACHE_HOSTPATH = "/var/lib/jr2";
/** Where a Sandbox sees the node's caches: `/repos/<key>`, one mount per Repo the CR names. */
export const REPOS_MOUNT = "/repos";

/** Metadata the Orchestrator writes on a `Repo` resource (ADR-0051). `bound` is set when a
 * registered Machine binds the Repo, so `jr2 gc` never evicts it; the identity is what every
 * spelling of the url normalizes to (repo-identity.ts); `last-attached` is the eviction clock for
 * a Repo nothing binds. */
export const LABEL_REPO_BOUND = "jr2.dev/bound";
export const ANNOTATION_REPO_IDENTITY = "jr2.dev/identity";
export const ANNOTATION_REPO_LAST_ATTACHED = "jr2.dev/last-attached";

/** The mark one ask leaves on a Sandbox CR, per Repo key (ADR-0053): a timestamp the Orchestrator
 * writes when something inside the pod asks for a fetch. The operator copies it onto the pod, and
 * the node's cache agent takes `asked` as the later of the pod's creation and this — so a fetch
 * that started before the ask does not satisfy it. The Lease's shape: an annotation, written by
 * the Orchestrator, read by the operator. */
export const askedAnnotation = (key: string): string => `jr2.dev/asked-${key}`;

/** The two PriorityClasses `jr2 up` creates, cluster-scoped, beside the CRDs (ADR-0060) — unless
 * `priorityClasses` in jr2.config.ts names existing ones. `jr2-control` (100000,
 * PreemptLowerPriority) is for the Orchestrator, the operator and the Repo cache agent: small, fixed,
 * and needed by every Sandbox. `jr2-sandbox` (1000, preemptionPolicy Never) is for Sandboxes and the
 * Instance Harness: an ordinary pod cannot preempt a live Workspace, and a waiting Sandbox evicts
 * nobody. Both stay far below the system classes. */
export const PRIORITY_CLASS_CONTROL = "jr2-control";
export const PRIORITY_CLASS_SANDBOX = "jr2-sandbox";

/** The voluntary-disruption opt-outs (ADR-0060) a Sandbox pod and the Instance Harness pod carry:
 * moving either loses work (`/work`; live conversations). No PodDisruptionBudget — `maxUnavailable:
 * 0` blocks node upgrades without end. */
export const NO_DISRUPT_ANNOTATIONS = {
  "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
  "karpenter.sh/do-not-disrupt": "true",
} as const;

/** The API server's CA as the kubelet mounts it with the Pod's ServiceAccount. The Orchestrator
 * Deployment points `NODE_EXTRA_CA_CERTS` at it, so the Orchestrator's own Kubernetes client
 * (kube-client.ts, ADR-0063) trusts the API server with built-in `fetch` and no TLS code. */
export const SERVICE_ACCOUNT_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
