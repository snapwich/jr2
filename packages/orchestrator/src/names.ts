// The fixed in-namespace object names of a deployed instance (ADR-0019). The namespace is the
// instance's IDENTITY, so names inside it are constants — shared by `jr2 up` (which creates them),
// the CLI transport (which dials them), and the server entrypoint (which consumes them).

/** The orchestrator's Deployment + Service name; the Service targets `ORCHESTRATOR_PORT`. */
export const ORCHESTRATOR_SERVICE = "jr2-orchestrator";
export const ORCHESTRATOR_PORT = 4000;

/** The instance-owned Secret: Instance token + signing key (+ orchestrator-side creds). */
export const INSTANCE_SECRET = "jr2-instance";

/** The Instance Harness's StatefulSet + Service name (ADR-0031): converged by `jr2 up` whenever any
 * Agent definition declares `workspace: "none"`, and the deterministic Service DNS the Agent actor
 * resolves such a Turn to. Doubles as the delivery scope a Menu-only registration records — the
 * name the placement's Sandbox token is signed for (tokens.ts, ADR-0013), which its Custodian holds. The port is the
 * Harness's own listen port (`PORT` default). */
export const INSTANCE_HARNESS_SERVICE = "jr2-instance-harness";
export const INSTANCE_HARNESS_PORT = 8080;

/** The Instance Effector (ADR-0068): its Deployment, headless Service, NetworkPolicy and Secret all
 * carry this name. `jr2 up` converges them when a registered Machine places an Effect there, or a
 * Hook needs it (a `mac` verifier, or a kind that declares `posts`). The
 * port is the Effector's own (`JR2_EFFECTOR_PORT` default) — none of the Harness pod's ports. */
export const INSTANCE_EFFECTOR = "jr2-instance-effector";
export const EFFECTOR_PORT = 8082;

/** Where a Harness persists its conversations, and the env var that tells it so (ADR-0031): one
 * fixed path in both placements — the Instance Harness's PersistentVolumeClaim (deploy.ts) and a
 * Sandbox's emptyDir (sandbox-kube.ts), each mounted into the Harness container alone. It is under
 * `/run/jr2`, as each path that the Harness holds alone is, so no process that the Harness confines
 * can read an Agent's history or write into it (ADR-0076). */
export const CONVERSATIONS_DIR = "/run/jr2/conversations";
export const CONVERSATIONS_DIR_ENV = "JR2_CONVERSATIONS_DIR";
export const CONVERSATIONS_VOLUME = "conversations";

/** Where the Harness of a Sandbox listens for a person's shell (`jr2 workspace shell`, ADR-0076):
 * a folder under `/run/jr2`, an emptyDir mounted into the Harness container alone. No process that
 * the Harness confines can make a file there, so none can listen in the Harness's place. */
export const SHELL_DIR = "/run/jr2/shell";
export const SHELL_VOLUME = "shell";

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

/** The digests of the named Caller tokens (ADR-0078): one key, `CALLER_DIGESTS_KEY`, a JSON object
 * `{ "<name>": "<sha-256 hex of the value>" }`. `jr2 up` writes it, and the Orchestrator reads it
 * through a MOUNT and reads it again when it changes, so a rotation rolls no pod. Until the kubelet
 * updates the mount, about a minute, the old value still works. No value is here: each value is in
 * its own Secret (`callerTokenSecret`), which no pod mounts. */
export const CALLER_DIGESTS_SECRET = "jr2-caller-digests";
/** Where the Orchestrator reads the digests. */
export const CALLER_DIGESTS_MOUNT = "/etc/jr2/callers";
/** The Secret's key, hence the filename under the mount. */
export const CALLER_DIGESTS_KEY = "digests.json";
/** The digests of the `token` Hooks' secrets (ADR-0078): one key, `HOOK_DIGESTS_KEY`, a JSON object
 * `{ "<secret name>": "<sha-256 hex of the value>" }`. The door compares the sha-256 of a delivery's
 * token with it, so the Orchestrator holds no Hook secret. Its own Secret, not the Caller digests':
 * `jr2 caller rotate` writes that one whole. The Orchestrator reads it through a mount, again when
 * it changes. */
export const HOOK_DIGESTS_SECRET = "jr2-hook-digests";
/** Where the Orchestrator reads the Hook digests. */
export const HOOK_DIGESTS_MOUNT = "/etc/jr2/hooks";
/** The Secret's key, hence the filename under the mount. */
export const HOOK_DIGESTS_KEY = "digests.json";
/** The Secret that holds one named Caller token's value (ADR-0078), which `jr2 caller token <name>`
 * reads over the kube API. */
export function callerTokenSecret(name: string): string {
  return `jr2-caller-${name}`;
}

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
/** The prefix of each pod's literal held values (`heldSecretsSecret`): one Secret per pod, one key
 * per name it holds — mounted into that pod's Custodian and nothing else. */
export const HELD_SECRETS_SECRET = "jr2-held-secrets";
/** The literal held values of one pod (ADR-0059): `jr2-held-secrets-<pod>`. */
export function heldSecretsSecret(pod: string): string {
  return `${HELD_SECRETS_SECRET}-${pod}`;
}
/** One leaf per bound `host:port` (`<stem>.crt`, `<stem>.key`) — the Custodians' alone. */
export const HELD_TLS_SECRET = "jr2-held-tls";
/** What `jr2 up` DECLARES about held secrets: each pod's held manifest (`heldManifestKey` — names,
 * bindings, headers; never a value) and the Custodian's program once (`CUSTODIAN_PROGRAM_KEY`).
 * Nothing rendered per pod lives here: a shared object stops at 1 MiB, and Envoy's files are a
 * pod's own, rendered where the pod is made (`sandboxCustodianConfigMap`,
 * `INSTANCE_CUSTODIAN_CONFIGMAP`). Always applied, possibly holding no secret: every Harness pod
 * runs a Custodian. */
export const HELD_CONFIGMAP = "jr2-held";
/** Where the Orchestrator reads a Workspace's held manifest, per provision — a mount, so a
 * held-secret edit reaches future Sandboxes without rolling the Orchestrator (the `jr2-images`
 * pattern, ADR-0038). */
export const HELD_MOUNT = "/etc/jr2/held";
/** The `jr2-held` key of one pod's manifest. */
export const heldManifestKey = (pod: string): string => `held-${pod}.json`;
/** The `jr2-held` key of the Custodian's fixed Lua — `custodian.lua` as written, once per Instance;
 * each pod's own script loads it by this name from its config mount. */
export const CUSTODIAN_PROGRAM_KEY = "program.lua";
/** The ConfigMap with the Instance Harness's Custodian's two rendered files (`envoy.json`,
 * `custodian.lua`), written by `jr2 up`: the one pod it makes. */
export const INSTANCE_CUSTODIAN_CONFIGMAP = "jr2-held-custodian";
/** The ConfigMap with one Sandbox's Custodian's two rendered files, written by the Orchestrator at
 * provision and owned by the Sandbox CR — the `<name>-token` family: it goes with the pod. */
export const sandboxCustodianConfigMap = (sandbox: string): string => `${sandbox}-custodian`;
/** The Instance Harness's pod, as its held objects are keyed. A Workspace's is `ws-<digest>`
 * (`workspaceHeldPod`), so the two cannot collide. */
export const INSTANCE_HARNESS_HELD_POD = "instance";

/** The Custodian's ports (ADR-0059), all taken on every Harness pod (ADR-0005): the Harness's
 * HTTPS proxy on loopback, the kubelet's probe, and the fetch listener that the ask rides to the
 * Orchestrator, at the address `jr2-upload-pack` defaults to (ADR-0053). The agent routes are not
 * on a port: they are on the control socket ({@link CUSTODIAN_CONTROL_SOCKET}, ADR-0076). */
export const CUSTODIAN_PORT = 15001;
export const CUSTODIAN_HEALTH_PORT = 15021;
export const CUSTODIAN_FETCH_PORT = 8081;

/** The folder of the Custodian's control socket (ADR-0076): an emptyDir that the Harness container
 * and the Custodian container alone mount, at this path in both. It is under `/run/jr2`, so no
 * process that the Harness confines can make a socket here, and none can take the control
 * listener's place while the Custodian restarts. The Custodian writes it; the Harness mounts it
 * read-only, which still lets it connect to the socket. */
export const CUSTODIAN_SOCKET_DIR = "/run/jr2/custodian";
/** The control socket: the Custodian's listener for the five agent routes, which carry the control
 * Stand-in (ADR-0059, ADR-0076). */
export const CUSTODIAN_CONTROL_SOCKET = `${CUSTODIAN_SOCKET_DIR}/control.sock`;

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

/** What a Workspace writes on its Sandbox CR (ADR-0012, ADR-0021). The labels carry its run, its
 * Workflow and a selector form of its path; the annotation carries the exact path, which the
 * `jr2 workspace` verbs compare a handle with (ADR-0009). The keepalive is the Lease's stamp, and
 * the hold mark says whether a run still holds the Sandbox: `held` from the Lease's first write,
 * `released` when the Lease stops for the body's final state, a fault, a cancel or a parent that
 * leaves the Workspace's state. */
export const LABEL_SANDBOX_RUN = "jr2.dev/run";
export const LABEL_SANDBOX_WORKFLOW = "jr2.dev/workflow";
export const LABEL_SANDBOX_WORKSPACE = "jr2.dev/workspace";
export const ANNOTATION_WORKSPACE_PATH = "jr2.dev/workspace-path";
export const ANNOTATION_KEEPALIVE = "jr2.dev/keepalive";
export const ANNOTATION_HOLD = "jr2.dev/hold";
export const HOLD_HELD = "held";
export const HOLD_RELEASED = "released";

/** The selector form of a Workspace path for the `jr2.dev/workspace` label (ADR-0012): a label
 * value holds at most 63 characters from `[A-Za-z0-9._-]` and starts and ends with an alphanumeric.
 * Each other character becomes `-`; a value above 63 characters is cut and ends with a hash of the
 * whole path. For `kubectl -l` alone: no jr2 reader selects by it. */
export function workspaceLabel(path: string): string {
  const form = path.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (form.length <= 63) return form;
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hash = (h >>> 0).toString(36);
  return `${form.slice(0, 62 - hash.length).replace(/[^A-Za-z0-9]+$/, "")}-${hash}`;
}

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
