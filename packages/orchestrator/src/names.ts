// The fixed in-namespace object names of a deployed instance (ADR-0019). The namespace is the
// instance's IDENTITY, so names inside it are constants — shared by `j2 up` (which creates them),
// the CLI transport (which dials them), and the server entrypoint (which consumes them).

/** The orchestrator's Deployment + Service name; the Service targets `ORCHESTRATOR_PORT`. */
export const ORCHESTRATOR_SERVICE = "j2-orchestrator";
export const ORCHESTRATOR_PORT = 4000;

/** The instance-owned Secret: Instance token + signing key (+ orchestrator-side creds). */
export const INSTANCE_SECRET = "j2-instance";

/** The Instance Harness's Deployment + Service name (ADR-0031): converged by `j2 up` whenever any
 * Agent definition declares `workspace: "none"`, and the deterministic Service DNS the Agent actor
 * resolves such a Turn to. Doubles as the delivery scope a Menu-only registration records — the
 * name the placement's Adapter token is signed for (tokens.ts, ADR-0013). The port is the
 * Harness's own listen port (`PORT` default). */
export const INSTANCE_HARNESS_SERVICE = "j2-instance-harness";
export const INSTANCE_HARNESS_PORT = 8080;

/** The harness config ConfigMap the stock Harness boots from (ADR-0018): what this instance can
 * REACH — the custom model provider, minus its key. No Agents ride it: a Machine carries its own
 * (ADR-0049), and the definition rides each admission, so this holds deployment facts alone
 * (ADR-0050). */
export const HARNESS_CONFIGMAP = "j2-harness";
/** Its one key, hence the env var's value — `J2_HARNESS_JSON` on every Harness container. */
export const HARNESS_CONFIG_KEY = "harness.json";

/** The resolved image map `j2 up` writes and every provision reads (ADR-0037/0038): key → ref for
 * the Harness, the Adapter, and every Sandbox Image context the registered Machines carry — keyed
 * by content digest, plus the reserved `default` (ADR-0049).
 *
 * MOUNTED, never projected into env — the load-bearing part. A mount updates in place through
 * kubelet propagation, so adding a CLI to a Dockerfile costs one propagation window; the same map
 * as Deployment env would be a pod-template change, rolling the Orchestrator and putting every
 * live run through snapshot restore (ADR-0007) for a change that affects only FUTURE Sandboxes. */
export const IMAGES_CONFIGMAP = "j2-images";
export const IMAGES_MOUNT = "/etc/j2/images";
/** The ConfigMap key, hence the filename under the mount — the two-sided contract's other half. */
export const IMAGES_KEY = "images.json";

/** The HARNESS containers' env Secret — Agent creds only, never the Instance token (ADR-0013). */
export const HARNESS_ENV_SECRET = "j2-harness-env";

/** The instance's private-CA bundle ConfigMap (`harness.caBundle`, ADR-0020) — mounted into the
 * Harness container (and only it) so Agent egress trusts an internal CA. Public data by nature. */
export const CA_CONFIGMAP = "j2-ca";

/** The optional git deploy-key Secret the `j2 up` ssh offer generates (ADR-0019). */
export const GIT_SSH_SECRET = "j2-git-ssh";

/** The snapshot store's PVC (sqlite lives on it — ADR-0019) and the in-cluster source volume the
 * boot reconcile populates + Sandboxes mount read-only (ADR-0004). */
export const STATE_PVC = "j2-state";
export const REPOS_PVC = "j2-repos";

/** Where the deploy key is mounted in the orchestrator pod (the boot reconcile's ssh identity). */
export const GIT_SSH_MOUNT = "/etc/j2/git-ssh";
