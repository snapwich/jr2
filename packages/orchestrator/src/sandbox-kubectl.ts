// The canonical SandboxPort (ADR-0012 / GAP(3)): drives the operator's Sandbox CRD through
// `kubectl`, honoring the current kube context (ADR-0009: the kube target IS the kubectl
// context; `--context` overrides). Shelling to kubectl instead of a client library keeps the
// dependency surface at zero and the behavior identical to what a human debugging the cluster
// would type; the `exec` process seam is injectable so the mapping logic is unit-testable
// without a cluster. The kind e2e tier exercises the real thing.
//
// Reachability: the orchestrator always runs in-cluster (ADR-0019), so it dials
// `status.endpoint` (`http://<name>.<ns>.svc:…`) directly — stable across orchestrator
// restarts by nature, which is what ADR-0012's "same endpoint" re-attach promise rides on.
//
// All four operations are idempotent (SandboxPort contract): apply is create-or-update, attach
// guards every clone/worktree, delete ignores absent.
//
// WHICH REPOS a Sandbox attaches arrive resolved from the `workspace()`'s Repo Slots (ADR-0051):
// the CR names each by its cache key, the operator mounts the node's cache read-only at
// `/repos/<key>` and gates Ready on it, and the attach clones off that mount. The one judgement
// made here is the FENCE: a per-run url must match a `git.credentials` entry, or it is refused
// before anything is applied.
//
// WHICH IMAGE a Sandbox runs is not an option here (ADR-0037/0038/0049). The request carries what
// the `workspace()` wrapper statically declared — a `file:` docker context or a registry ref — and
// the resolved key→ref map arrives as a mounted ConfigMap read on EVERY provision, so a `j2 up`
// that rebuilds an image reaches future Sandboxes without rolling this process.
//
// The pod's primary container is the Sandbox Image BYTE-FOR-BYTE (ADR-0037): no appended layers,
// no rewritten Dockerfile, no j2 knowledge inside it. j2's runtime arrives at POD time instead —
// an emptyDir at `/opt/j2`, populated by an init container running the kit's Harness image — and
// the container's COMMAND is overridden to start the Harness from that volume. The image's own
// `USER` and `HOME` are respected (the human who execs in lands in the environment its author
// built); only its `ENTRYPOINT`/`CMD` do not run, because a container has one command and the
// Harness must own it — its death must be the container's death, which is what the operator's
// Ready probe and restart semantics at `:8080` mean. A process the image WANTS running is not
// lost: it has its own seat, the User Container (ADR-0005), composed here when the wrapper's static
// `user` option names an image (ADR-0049).
//
// So this module composes the whole pod — two init steps and up to three containers:
//
//   initContainer runtime     the kit's Harness image → copies /opt/j2 into the volume
//   initContainer preflight   the USER'S image + that volume → ADR-0037's probe, the thing that
//                             proves a registry ref, whose first appearance is this provision
//   container     harness     the Sandbox Image, command overridden, /work + /opt/j2 mounted
//   container     adapter     j2-owned, the pod's only credential holder (below)
//   container     user        optional, the image's own entrypoint, the checkouts (/work, plus
//                             /repos and /opt/j2 read-only) and NOTHING else
//
// This is also where the ADAPTER is injected (ADR-0013). The operator needs no change to carry it:
// ADR-0001 made `Sidecars` generic container fragments it schedules WITHOUT understanding, so the
// Adapter is exactly that — a container with an image, an env, and a Secret. What this module
// builds is the pod's asymmetry:
//
//   harness container   J2_ADAPTER_URL=http://127.0.0.1:8081     (an address, no credential)
//   adapter container   J2_ORCHESTRATOR_URL + J2_SANDBOX_TOKEN   (the credential, via envFrom)
//
// The Agent has code execution in the first and none in the second. The token is minted here — a
// signed Sandbox name (see tokens.ts), so re-provisioning after a restart yields the SAME token and
// the Secret re-applies as a no-op.

import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  matchCredential,
  type GitCredential,
  type HarnessEnvFromSource,
  type HarnessEnvVar,
  type SandboxPlacement,
} from "./config.ts";
import { readImageRefs, resolveSandboxImage, resolveUserImage, type ImageRefs } from "./images.ts";
import { CA_CONFIGMAP, IMAGES_KEY, IMAGES_MOUNT, REPOS_MOUNT } from "./names.ts";
import { repoIdentity } from "./repo-identity.ts";
import type { RepoResources } from "./repos.ts";
import { sandboxToken } from "./tokens.ts";
import type { ProvisionedRepo, SandboxPort, WorkspaceSpec } from "./workspace.ts";

/** Run one kubectl invocation to completion. `input` is piped to stdin (`apply -f -`). */
export type KubectlExec = (args: string[], opts?: { input?: string }) => Promise<{ stdout: string; stderr: string }>;

/** Where the Harness container sees the instance's CA bundle (ADR-0020). */
const CA_MOUNT = "/etc/j2/ca";

/** Where j2's runtime lands in every container that gets it (ADR-0037). `/opt/j2` and not `/app`
 * because a stranger's base may already use `/app`, and one layout must serve both the stock
 * Harness image and an arbitrary Sandbox Image. It is a PUBLISHED surface: `bin/` beside `lib/`
 * (node's rpath is `$ORIGIN/../lib`), `src/main.ts`, `node_modules/`. */
export const RUNTIME_MOUNT = "/opt/j2";

/** Where the populate init container writes the runtime. NOT `/opt/j2`: mounting the volume there
 * would shadow the very directory being copied out of the Harness image. */
const RUNTIME_STAGE = "/mnt/j2";

/** The primary container's command (ADR-0037). Absolute, so it never depends on the image's
 * `WORKDIR`, and identical to the stock Harness image's own `CMD` — one runtime, two placements. */
const HARNESS_COMMAND = [`${RUNTIME_MOUNT}/bin/node`, `${RUNTIME_MOUNT}/src/main.ts`];

/** The program `origin`'s fetch url runs (ADR-0053), on the runtime volume beside `work-acl`. It
 * asks the node cache for a fetch and then serves the cache, so every seat that holds the
 * checkouts must hold this volume — which is why the User Container mounts it (ADR-0005). */
const UPLOAD_PACK = `${RUNTIME_MOUNT}/bin/j2-upload-pack`;

/** The Adapter's port on the pod's loopback. The program defaults to this address too, so the
 * fetch url names it only when the composition moved it (attachScript). */
const DEFAULT_ADAPTER_PORT = 8081;

/** ADR-0005's default work group. Convention, not config: the pod's `fsGroup` is granted to every
 * container as a supplemental group, so the Harness writes `/work` whatever the number and no
 * image's `/etc/group` needs to know it. The one override is the spec's `workGroup`. */
const DEFAULT_WORK_GROUP = 2000;

/**
 * The isolation baseline for a j2-owned seat, spelled out HERE for the init containers because the
 * operator's hardened default covers the primary container and the sidecars only (ADR-0001/0005) —
 * init steps pass through verbatim, which is what keeps the operator agent-agnostic. Deliberately
 * not applied to the `user` container: that seat's identity is "what j2 does not own".
 */
const HARDENED = {
  runAsNonRoot: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

/**
 * ADR-0037's fallback seat, for a BUILT image that declares no `USER` (the converge's `docker
 * inspect` is what saw that; images.ts holds the record). j2 sets `runAsUser` nowhere else — an
 * image's own `USER` decides its seat's uid (ADR-0005) — so this applies only where the image
 * chose nothing and the alternative is root, which the hardened context refuses.
 *
 * The home is a POD volume, not a directory in the image: uid 1000 on a stranger's base has no
 * home at all, and the floor needs a writable one (`git config --global` writes `$HOME/.gitconfig`
 * on every attach; a real toolchain wants `~/.npm`, `~/.cargo`, `~/.cache`). An emptyDir lands
 * group-writable under the pod's fsGroup, so uid 1000 owns it in practice without j2 chown-ing
 * anything. `/home/j2` and not `/home/node`: the number is j2's choice here, so the path is too.
 */
const FALLBACK_UID = 1000;
const FALLBACK_HOME = "/home/j2";

/**
 * The kubelet's verdict on a container whose image resolves to root under `runAsNonRoot: true`.
 * Matched, not merely reported, because it is the ONE provision failure with no evidence anywhere
 * else: the container never starts, so it has no logs, and the pod sits in this waiting state until
 * the provision times out — which then blames the preflight for a container the preflight never got
 * to run. A BUILT image is caught earlier and cheaper (the converge's `docker inspect` recorded the
 * string; `resolveSandboxImage` in images.ts judges it into `refusedUser` before anything is
 * applied), so this is the brought ref's path: never inspected, never given the uid-1000 fallback,
 * knowable only from the cluster.
 *
 * Reason and message are BOTH required. The reason alone covers a missing Secret or ConfigMap key
 * too — a different fault with a different fix — and only the message distinguishes them.
 */
const ROOT_IMAGE_REASON = "CreateContainerConfigError";
const ROOT_IMAGE_MESSAGE = /runAsNonRoot/i;

/** How many CR polls pass between two pod reads. See the provision loop for why it is not 1. */
const POD_CHECK_EVERY = 5;

/**
 * The kubelet's own words when a container's image resolves to root under `runAsNonRoot`, or
 * undefined for every other pod shape. A pure read of pod status: the caller supplies the parsed
 * `kubectl get pod -o json`, so the claim is testable without a cluster and the fault detection
 * cannot drift from the message the provision prints.
 *
 * Init containers are searched FIRST because they run first: the `preflight` step runs the user's
 * image before the Harness container ever exists, so that is where a root image dies. The primary
 * containers are searched too — the same image sits in the `harness` seat, and the `user` seat is
 * deliberately un-hardened (ADR-0005), so a fault there would mean something else entirely.
 *
 * Both the reason AND the message must match. `CreateContainerConfigError` is also what an absent
 * Secret key produces, and that fault has a different fix; a name with no evidence behind it is
 * worse than the timeout it replaces.
 */
export function rootImageFault(pod: unknown): string | undefined {
  const status = (pod as { status?: Record<string, unknown> } | null)?.status;
  if (!status) return undefined;
  type Waiting = { name?: string; state?: { waiting?: { reason?: string; message?: string } } };
  const groups = [status["initContainerStatuses"], status["containerStatuses"]];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const cs of group as Waiting[]) {
      const waiting = cs?.state?.waiting;
      if (!waiting || waiting.reason !== ROOT_IMAGE_REASON) continue;
      if (!waiting.message || !ROOT_IMAGE_MESSAGE.test(waiting.message)) continue;
      return `container "${cs.name ?? "?"}": ${waiting.message}`;
    }
  }
  return undefined;
}

/**
 * The fix, not the symptom. The kubelet's message says what it refused; it cannot say that the
 * image is a Sandbox Image, that j2 declined to patch a uid onto it, or where the one-line edit
 * goes — and without those three the reader has a Kubernetes error and no next step.
 *
 * It names the BROUGHT case specifically because that is the only one that reaches here: a built
 * image's `USER` was inspected at converge and judged before anything was applied (images.ts), and
 * an image declaring none gets the uid-1000 fallback. A ref is never inspected — that is the point
 * of refs (ADR-0037) — so it must declare a numeric non-root `USER` itself.
 */
function rootImageError(name: string, fault: string): string {
  return (
    `Sandbox "${name}" cannot start: its image runs as ROOT, and every j2-owned seat is hardened ` +
    `with runAsNonRoot (ADR-0005). The kubelet refused it — ${fault}\n` +
    `  - the fix is one line in the image: a NUMERIC non-root \`USER <uid>\` (e.g. \`USER 1000\`)\n` +
    `  - numeric because the kubelet does not read the image's /etc/passwd, so \`USER app\` is ` +
    `refused too — it cannot prove that name is non-root\n` +
    `  - j2 does not supply a uid for a brought registry ref: it is never inspected and never ` +
    `modified, which is what "bring your own image" means (ADR-0037). Only an image j2 BUILDS, ` +
    `and only one that declares no USER at all, gets the uid-${FALLBACK_UID} fallback.`
  );
}

/**
 * ADR-0037's preflight, VERBATIM: git present · `$HOME` writable · glibc new enough for j2's node
 * (with the relocated `libstdc++`) · the vendored ripgrep, reached through the mounted `/opt/j2`.
 *
 * The three commands are the floor, one each: `git config --global` proves git is on the system
 * PATH AND that `$HOME` is writable for the image's user; `node -e ""` proves the glibc is no
 * older than the one j2's node was built against (this is where musl dies); `rg` UNQUALIFIED
 * proves the vendored static binary resolves THROUGH PATH, which is what the Harness's own append
 * buys at runtime.
 *
 * ONE prover, and this is it (ADR-0037/0041). A converge cannot hold an image to this floor: the
 * floor is a HARNESS-SEAT obligation, a built context may equally be destined for the User
 * Container seat — which owes no floor at all (ADR-0005) — and which seat a directory serves is
 * workflow-internal and statically unrecoverable (ADR-0031). Here the seat is known, and here is
 * also the only moment a registry ref exists at all, since j2 never builds or inspects one.
 */
const SANDBOX_PREFLIGHT = `git config --global safe.directory "*" && ${RUNTIME_MOUNT}/bin/node -e "" && rg --version`;

/**
 * The probe as a shell line. The PATH append is mechanism, not part of the claim, and it is not
 * optional: nothing bakes `/opt/j2/bin` into the user's image any more, so a probe that skipped it
 * would report `rg: not found` for every image on earth. APPENDED, never prepended — a toolchain
 * the image pinned wins, which is as much the property being proved as `rg`'s presence (ADR-0037).
 * The seat gets no login shell at either end, so `$PATH` is whatever the image itself set.
 */
function preflightShell(): string {
  return `export PATH="$PATH:${RUNTIME_MOUNT}/bin"; ${SANDBOX_PREFLIGHT}`;
}

/**
 * The preflight as an init step IN THE USER'S IMAGE with `/opt/j2` mounted. It fails the pod
 * before the Harness starts, instead of surfacing as a tool failure mid-turn on a pod nobody is
 * watching.
 *
 * It PROVES, it does not set up: the `.gitconfig` it writes lives in this container's own
 * ephemeral filesystem, so the attach script still runs the same line in the Harness container.
 *
 * `sh -c`, not `sh -ec`: the failure is handled below, because "node did not execute" is not
 * actionable and the message has to name the fix.
 */
const PREFLIGHT_SCRIPT = [
  `${preflightShell()} && exit 0`,
  `echo "j2: this Sandbox Image does not meet the floor (ADR-0037): a glibc base no older than ` +
    `j2's node (musl is out entirely), git on the system PATH, a writable HOME for the image's ` +
    `USER, and /opt/j2 + /work + :8080 unclaimed. j2 vendors the rest." >&2`,
  `exit 1`,
].join("\n");

export type KubectlSandboxOptions = {
  /** The mounted image map (ADR-0037/0038) — every ref this port can name, written by `j2 up`.
   * Default: the `j2-images` ConfigMap's mount. No image option here: which image a Sandbox runs
   * is the `workspace()` wrapper's static `image` option (ADR-0049) — carried on the Machine, read
   * off it at invoke time, handed to `provision()` as a string — and resolved against this map at
   * provision. The per-run spec never names one (ADR-0051). */
  imagesPath?: string;
  /** Extra env for the HARNESS container (`harness.env`) — merged ahead of the
   * mechanism-owned vars, which win on collision. */
  env?: HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container (`harness.envFrom`) — how a real
   * Harness gets its model API key without the value ever touching j2 config. */
  envFrom?: HarnessEnvFromSource[];
  /** Where a Sandbox may land (ADR-0052): the Instance's `sandbox.nodeSelector` and
   * `sandbox.tolerations`, written on the CR verbatim and copied onto the pod by the operator, which
   * merges nothing with them. Absent → wherever an ordinary pod lands. */
  placement?: SandboxPlacement;
  /** The instance ships a private-CA bundle (ADR-0020): mount the `j2-ca` ConfigMap into the
   * HARNESS container and point NODE_EXTRA_CA_CERTS at it — never the Adapter, which speaks plain
   * HTTP to the Orchestrator's Service (the same asymmetry as env/envFrom above). */
  caBundle?: boolean;
  /**
   * Where the Adapter reaches the Orchestrator FROM INSIDE THE CLUSTER — the orchestrator's own
   * Service DNS (derived from J2_NAMESPACE by the entrypoint). The Agent is never told it.
   * A thunk is still accepted for callers that resolve their address late.
   */
  orchestratorUrl?: string | (() => string | undefined);
  /** The key Sandbox tokens are signed with — from the instance Secret (ADR-0013/0019). */
  signingKey?: Buffer;
  /** The Adapter's port on the pod's loopback. Default 8081. */
  adapterPort?: number;
  /** Kube namespace for Sandbox CRs. Default `default`. */
  namespace?: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** In-pod root for the pod-local clones + worktrees (ADR-0004 layout). Default `/work`. */
  workRoot?: string;
  /** CR `spec.idleTimeout` — the operator's abandoned-Sandbox GC backstop (ADR-0001). Default `30m`. */
  idleTimeout?: string;
  /** How often a workspace's lease actor renews (ADR-0001/0021): the cadence at which
   * `j2.dev/keepalive` is re-stamped AND continuity is read back. Must be ≪ idleTimeout, since
   * a lapsed lease is what lets the operator reap. Default 5m. */
  leaseIntervalMs?: number;
  /** Await-Ready budget for the POD: from the CR apply until the operator reports the pod Ready.
   * Default 120s, polled every second. A pod that never comes up (an image that misses ADR-0037's
   * floor) is what this bounds; a pod that is up and waiting on its Repos is `repoTimeoutMs`'s. */
  readyTimeoutMs?: number;
  /**
   * Await-Ready budget for the REPOS (ADR-0051): once the operator holds a Sandbox whose pod is
   * Ready on a Repo reason — the node's cache agent is cloning a cold node, or fetching before the
   * attach — the wait is measured against this, from the same CR apply. Sized for a clone, not a
   * pod: the agent's clone budget is 20m, and this must exceed it so a clone that runs out of
   * time fails BY NAME (`RepoCloneFailed`, git's words) instead of as this port's timeout; and it
   * must stay inside `idleTimeout` (30m), because the lease starts after provision, so the operator
   * reaps a Sandbox that waits longer than that. Default 25m.
   */
  repoTimeoutMs?: number;
  pollMs?: number;
  /**
   * The Repo-resource port (ADR-0051, repos.ts): every Repo a provision names must exist as a
   * `Repo` resource before the CR names it, or the operator reports it missing and the Sandbox
   * never reaches Ready. So `provision` ensures each one here — a per-run url's resource is
   * created at first attach, a bound one is found as the boot stated it — and REFUSES to run
   * without the port: a Sandbox whose Repos nobody creates parks on `RepoMissing` for the whole
   * Ready budget. The other operations (attach, renew, destroy) need no port, so it is optional
   * at construction.
   */
  repos?: RepoResources;
  /**
   * The instance's `git.credentials` (ADR-0051) — THE FENCE. A per-run url is run input, a
   * ticket field, and otherwise a way to spend the cluster's credential against any host: one
   * whose identity matches no entry is refused here, before a Secret or a CR exists, naming the
   * list. A bound url is code the instance typechecked and deployed, admitted without a match.
   * Default: no entries, so every per-run url is refused.
   */
  credentials?: readonly GitCredential[];
  /** Process seam, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
};

export function kubectlSandbox(opts: KubectlSandboxOptions = {}): SandboxPort {
  const ns = opts.namespace ?? "default";
  const imagesPath = opts.imagesPath ?? join(IMAGES_MOUNT, IMAGES_KEY);
  const workRoot = opts.workRoot ?? "/work";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const repoTimeoutMs = opts.repoTimeoutMs ?? 25 * 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const exec = opts.exec ?? defaultKubectlExec;
  const credentials = opts.credentials ?? [];

  const adapterPort = opts.adapterPort ?? DEFAULT_ADAPTER_PORT;
  const leaseIntervalMs = opts.leaseIntervalMs ?? 5 * 60_000;
  const base = ["--namespace", ns, ...(opts.context ? ["--context", opts.context] : [])];

  /** The Sandbox's token Secret — read by the Adapter container, and by nothing else in the pod. */
  const secretName = (name: string) => `${name}-token`;

  /** Resolved at provision time (see the option's doc): the Orchestrator's in-cluster address. */
  const orchestratorUrl = (): string | undefined =>
    typeof opts.orchestratorUrl === "function" ? opts.orchestratorUrl() : opts.orchestratorUrl;

  /** The Adapter, as the operator sees it: an opaque container fragment (ADR-0001). */
  const adapterSidecar = (name: string, refs: ImageRefs) => ({
    name: "adapter",
    image: refs.adapter,
    env: [
      { name: "J2_ORCHESTRATOR_URL", value: orchestratorUrl() },
      { name: "J2_SANDBOX", value: name },
      { name: "J2_ADAPTER_PORT", value: String(adapterPort) },
    ],
    // The credential, and the reason this is a separate container: `local()` tools give the Agent
    // code execution in the HARNESS container, so anything mounted there is the Agent's. Here, it
    // is out of reach — different container, no shared process namespace.
    envFrom: [{ secretRef: { name: secretName(name) } }],
  });

  /**
   * The User Container (ADR-0005): the opt-in third seat, composed only when the wrapper's static
   * `user` option names an image (ADR-0049). The ZERO-CONTRACT seat — j2 injects nothing, probes
   * nothing, overrides nothing. So: no `command` (its own entrypoint runs, untouched), no `env`,
   * no `envFrom`, no CA bundle, no ports, no resources. Every key j2 forwarded would be a crack in
   * "j2 puts nothing in it", and widening the one authoring string to an object stays compatible
   * if a concrete need ever argues its own way in. (Git's dubious-ownership guard is the line's
   * cost, accepted with
   * eyes open — ADR-0005: safe.directory is honored only from files this seat's image owns, so an
   * image whose sessions run git carries its own line.)
   *
   * `/work` read-write plus the checkouts' two read-only halves are the single exception, and they
   * are not an injection but the point: this seat and the Harness mount ONE worktree, so the human
   * and the Agent see identical files — which is also why ADR-0005's cross-uid pair (the pod's
   * `fsGroup`, the attach's default ACL) exists at all. The caches ride along because they are
   * half of the same files: the worktrees are `--shared` clones whose alternates resolve objects
   * from `/repos/<key>` (ADR-0004/0051), so a seat with `/work` alone holds checkouts whose every
   * borrowed object is missing ("unable to normalize alternate object path"). `/opt/j2` is the
   * other half (ADR-0053): `origin`'s fetch url is a program on that volume, so a seat without it
   * holds checkouts whose `git fetch` dies — and with it the human gets the same fetch as the
   * Agent, with no credential of their own. Nothing else follows it in: `ext::` names the program
   * by absolute path, so this seat still gets no env, no command, and no probe. The repo volumes
   * are the operator's — it defines `repo-<key>` for every key the CR names — so this seat mounts
   * them by name. The Adapter is deliberately not given any of the three: it reads no worktree, and it is the
   * container holding the pod's only credential, so it gets the narrowest mount set that works.
   * It also carries no `securityContext`, which the operator reads as the exemption — root is
   * ALLOWED here, because hardening a seat whose identity is "what j2 does not own" is an opinion,
   * and the standard managed-access shape (a root sshd that setuids sessions down) must run
   * unmodified.
   */
  const userSidecar = async (refs: ImageRefs, image: string, keys: string[]) => ({
    name: "user",
    image: await resolveUserImage(refs, image),
    volumeMounts: [
      { name: "work", mountPath: workRoot },
      { name: "runtime", mountPath: RUNTIME_MOUNT, readOnly: true },
      ...keys.map((key) => ({ name: repoVolumeName(key), mountPath: repoMountPath(key), readOnly: true })),
    ],
  });

  /** The pod's sidecar list (ADR-0001: opaque fragments the operator schedules verbatim). The
   * Adapter is ALWAYS here: with its ref in the image map there is no "no adapter configured"
   * state left to branch on, and a Sandbox without one is a pod that comes up Ready and then parks
   * its Machine forever on a tool call it cannot make (ADR-0013). A map with no `adapter` fails the
   * read instead (images.ts). The User Container joins it only when the spec named one. */
  const sidecarsFor = async (name: string, refs: ImageRefs, keys: string[], user?: string) => [
    adapterSidecar(name, refs),
    ...(user !== undefined ? [await userSidecar(refs, user, keys)] : []),
  ];

  // The Harness container's env: the instance's passthrough (`harness.env` — e.g. model
  // config) first, then the mechanism-owned vars (the Adapter address, the CA trust path), which
  // win on collision. Note the asymmetry stands (ADR-0013): user env/envFrom land on the HARNESS
  // container only — never on the Adapter, whose env is minted here and carries the pod's only
  // credential.
  const harnessEnv = (): HarnessEnvVar[] => [
    ...(opts.env ?? []),
    { name: "J2_ADAPTER_URL", value: `http://127.0.0.1:${adapterPort}` },
    ...(opts.caBundle ? [{ name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/ca.crt` }] : []),
  ];

  /**
   * The two init steps, in order (ADR-0037). They are plain container fragments the operator
   * schedules without understanding, exactly like sidecars — the operator stays agent-agnostic
   * (ADR-0001), so "how a Sandbox gets its runtime" is composed here, not reconciled there.
   *
   * 1. `runtime` — the kit's Harness image, copying its `/opt/j2` into the shared emptyDir. This
   *    is what makes the runtime's version ride the VOLUME rather than the image: a kit edit moves
   *    the harness image's own tag and re-images future pods without touching a single Sandbox
   *    Image tag, which is the only way a registry-ref image could ever follow a kit update.
   * 2. `preflight` — the USER'S image with that volume mounted, running the probe. Ordered second
   *    because it needs what the first one wrote.
   *
   * Both carry j2's hardened context explicitly, and `preflight` runs the probe in the SAME seat
   * the Harness will get — the image's own user, or ADR-0037's fallback — because a probe that
   * proved a different uid's `$HOME` proved nothing.
   */
  const initContainersFor = (refs: ImageRefs, seat: Seat) => [
    {
      name: "runtime",
      image: refs.harness,
      // The copy's rules live beside the tree they copy (`deploy/harness/init-copy`), not in a
      // string here: `/opt/j2` is a published surface whose SHAPE is load-bearing — node's rpath
      // is `$ORIGIN/../lib`, so `bin/` and `lib/` must land as siblings — and the script proves
      // its own result by running the copied node before the pod moves on.
      command: [`${RUNTIME_MOUNT}/bin/init-copy`, RUNTIME_STAGE],
      volumeMounts: [{ name: "runtime", mountPath: RUNTIME_STAGE }],
      securityContext: HARDENED,
    },
    {
      name: "preflight",
      image: seat.image,
      command: ["/bin/sh", "-c", PREFLIGHT_SCRIPT],
      ...(seat.env.length ? { env: seat.env } : {}),
      volumeMounts: [{ name: "runtime", mountPath: RUNTIME_MOUNT, readOnly: true }, ...seat.homeMount],
      securityContext: seat.securityContext,
    },
  ];

  /**
   * The primary container's seat: which image runs, as whom, and with what home. One value, built
   * once per provision and shared by the Harness container and the preflight, so the probe cannot
   * drift from the thing it proves.
   */
  type Seat = {
    image: string;
    env: HarnessEnvVar[];
    homeVolume: Array<{ name: string; emptyDir: Record<string, never> }>;
    homeMount: Array<{ name: string; mountPath: string }>;
    securityContext: typeof HARDENED & { runAsUser?: number };
  };

  const seatFor = async (refs: ImageRefs, name?: string): Promise<Seat> => {
    // ONE resolution, so the ref and the two seat facts can never come off different legs of
    // ADR-0037's chain (images.ts). It is async because a `file:` context is keyed by its content
    // digest, which is a directory walk — the price of the host and the pod agreeing about an
    // image without a path table (ADR-0049).
    const { ref: image, fallbackSeat, refusedUser } = await resolveSandboxImage(refs, name);
    // Fail HERE, before a Secret or a CR exists, on a `USER` the kubelet will refuse (images.ts).
    // The alternative is the worst shape a failure has: the preflight container never starts, so
    // it has no logs, and the whole 120s Ready budget burns before anything is said. The converge
    // already inspected the image, so this is knowable at zero cost — and the message names the
    // edit, because the fix is one line of the caller's own Dockerfile.
    if (refusedUser !== undefined) {
      throw new Error(
        `the Sandbox Image "${name ?? "default"}" declares \`USER ${refusedUser}\`, which cannot run a j2 seat: ` +
          "every j2-owned container is `runAsNonRoot` with no `runAsUser`, so the kubelet needs a NUMERIC " +
          "non-zero uid it can check without reading the image (ADR-0005). Change the Dockerfile's last " +
          "`USER` to that uid (e.g. `USER 1000`, or drop the line entirely and j2 supplies uid 1000 with a " +
          "writable HOME — ADR-0037), then re-run `j2 up`.",
      );
    }
    // The common case, and the one ADR-0037 is written around: the image chose its `USER` and its
    // `HOME`, and j2 touches neither — the human who execs in lands in the environment the
    // image's author built, dotfiles included.
    if (!fallbackSeat) {
      return { image, env: [], homeVolume: [], homeMount: [], securityContext: HARDENED };
    }
    return {
      image,
      env: [{ name: "HOME", value: FALLBACK_HOME }],
      homeVolume: [{ name: "home", emptyDir: {} }],
      homeMount: [{ name: "home", mountPath: FALLBACK_HOME }],
      securityContext: { ...HARDENED, runAsUser: FALLBACK_UID },
    };
  };

  const crFor = async (
    req: { name: string; runId: string; workflow: string; image?: string; user?: string; workGroup?: number },
    refs: ImageRefs,
    repos: FencedRepo[],
  ) => {
    const seat = await seatFor(refs, req.image);
    const sidecars = await sidecarsFor(
      req.name,
      refs,
      repos.map((r) => r.key),
      req.user,
    );
    return {
      apiVersion: "core.j2.dev/v1alpha1",
      kind: "Sandbox",
      metadata: {
        name: req.name,
        namespace: ns,
        // The run↔workspace link `j2 ls` groups by (ADR-0009/0012) — readable without the host.
        labels: { "j2.dev/run": req.runId, "j2.dev/workflow": req.workflow },
      },
      spec: {
        // The Sandbox Image, unmodified (ADR-0037) — the user's tools, its own USER and HOME, and
        // j2's runtime arriving beside it on a volume. This container is both the Harness and the
        // human's `exec` shell.
        image: seat.image,
        // The one thing j2 takes from the image: its command. A container has exactly one, and it
        // must be the Harness's — a pod whose main process is the user's entrypoint keeps
        // "Running" through a Harness death, which makes the operator's Ready probe a lie.
        command: HARNESS_COMMAND,
        // Hardened, and the ONLY place j2 ever names a uid: ADR-0037's fallback for an image that
        // declared none. Stating the whole context here rather than leaving it to the operator's
        // default is what makes that possible — the operator hardens only what says nothing.
        securityContext: seat.securityContext,
        idleTimeout: opts.idleTimeout ?? "30m",
        // Placement (ADR-0052): the Instance's word on which nodes are Sandbox nodes, raw pod-spec
        // shapes the operator copies verbatim. Absent keys are absent here too — the CR says
        // nothing, and the pod lands wherever an ordinary pod lands. The operator's own soft
        // affinity toward nodes holding this Sandbox's caches sits beside these untouched: a
        // preference never conflicts with a requirement.
        ...(opts.placement?.nodeSelector ? { nodeSelector: opts.placement.nodeSelector } : {}),
        ...(opts.placement?.tolerations?.length ? { tolerations: opts.placement.tolerations } : {}),
        // The work group (ADR-0005), the ownership half of cross-uid sharing on `/work`.
        // Kubernetes grants it as a supplemental group to every container, and puts a setgid
        // group on the volume root that propagates down; the WRITABILITY half is the default ACL
        // the attach stamps on each repo root (attachScript below), without which fsGroup gives
        // group-READ, which is the trap. Both are inert when the uids match.
        fsGroup: req.workGroup ?? DEFAULT_WORK_GROUP,
        // Ordered, and before any container starts: populate `/opt/j2`, then prove the image on it.
        initContainers: initContainersFor(refs, seat),
        // Never empty any more: J2_ADAPTER_URL is unconditional, so the "omit an empty env" branch
        // this used to carry was unreachable. The seat's own vars (the fallback `HOME`) come
        // FIRST, so the instance's `harness.env` can still override them the way it overrides
        // anything the image set.
        env: [...seat.env, ...harnessEnv()],
        ...(opts.envFrom?.length ? { envFrom: opts.envFrom } : {}),
        // What the AGENT gets: an address on its own loopback, and no credential anywhere. This is
        // the only thing in the pod that tells it how to reach its Machine (ADR-0013).
        sidecars,
        // The Repos this Sandbox attaches, by cache key (ADR-0051). The operator does the rest: a
        // `repo-<key>` volume per entry — the node's cache, hostPath, read-only in the primary
        // container at `/repos/<key>` — a soft affinity toward nodes already holding them, and
        // `Ready` only once every one is present on the pod's node and fetched since this CR
        // asked. Read-only is load-bearing twice (ADR-0004): no write contention, and nothing in
        // a Sandbox can `gc` the object store its `--shared` clones borrow from.
        repos: repos.map(({ key, url }) => ({ key, url })),
        volumes: [
          // The worktree root is a POD volume, not a directory baked into the image. Two reasons,
          // both load-bearing: every j2-owned seat runs as an unprivileged uid, which cannot mkdir
          // under `/` — so an image-owned `/work` would make every attach fail — and `/work` is
          // the one thing all three containers share (ADR-0005), so human and Agent see identical
          // files. An emptyDir lands group-writable under the pod's fsGroup, so it is writable
          // whatever uid the Sandbox Image runs as: `/work` unclaimed is the only image contract.
          { name: "work", emptyDir: {} },
          // j2's runtime (ADR-0037). An emptyDir, so it lives and dies with the pod and carries
          // the version the pod STARTED with — a live Sandbox keeps its runtime across a kit
          // update, the same create-if-absent stance ADR-0038 takes for images.
          { name: "runtime", emptyDir: {} },
          // Only for ADR-0037's fallback seat: uid 1000 on a stranger's base has no home at all.
          ...seat.homeVolume,
          ...(opts.caBundle ? [{ name: "ca", configMap: { name: CA_CONFIGMAP } }] : []),
        ],
        // CR-level volumeMounts land on the HARNESS container only (the operator's contract) —
        // exactly the CA-trust asymmetry ADR-0020 wants: the Adapter never inherits it. The Repo
        // caches are not listed: the operator mounts each `repo-<key>` into this container itself.
        volumeMounts: [
          { name: "work", mountPath: workRoot },
          // Read-only: nothing writes under `/opt/j2` at runtime, and the Agent has code execution
          // in this container — leaving its own runtime writable would let a turn edit it.
          { name: "runtime", mountPath: RUNTIME_MOUNT, readOnly: true },
          ...seat.homeMount,
          ...(opts.caBundle ? [{ name: "ca", mountPath: CA_MOUNT, readOnly: true }] : []),
        ],
      },
    };
  };

  type SandboxStatus = {
    phase?: string;
    endpoint?: string;
    podUID?: string;
    uid?: string;
    conditions?: Condition[];
  };

  /** Parse a Sandbox CR off any kubectl call that printed one (`get -o json`, and the lease's
   * `annotate -o json` — which returns the object AFTER the patch, status included). */
  const readSandbox = (stdout: string): SandboxStatus => {
    const parsed = JSON.parse(stdout) as {
      metadata?: { uid?: string };
      status?: { phase?: string; endpoint?: string; podUID?: string; conditions?: Condition[] };
    };
    return { ...(parsed.status ?? {}), uid: parsed.metadata?.uid };
  };

  const conditionOf = (status: SandboxStatus | undefined, type: string): Condition | undefined =>
    status?.conditions?.find((c) => c.type === type);

  const getSandbox = async (name: string): Promise<SandboxStatus | undefined> => {
    try {
      const { stdout } = await exec(["get", "sandbox", name, ...base, "-o", "json"]);
      return readSandbox(stdout);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  };

  /**
   * Ask the POD whether it is stuck on a fault the Sandbox's phase cannot express (see
   * {@link rootImageFault}). The CR is the port's normal window on a provision; this is the one
   * question it cannot answer, because the operator reports "not Ready yet" for a pod that will
   * never be Ready and one that simply has not started.
   *
   * Absent or unreadable answers undefined: the pod trails the CR by a moment at every provision,
   * and a missing pod is a normal early poll, never evidence of a fault. This may only ever CONVERT
   * a failure that was already going to happen into a named one.
   */
  const podFault = async (name: string): Promise<string | undefined> => {
    try {
      const { stdout } = await exec(["get", "pod", name, ...base, "-o", "json"]);
      return rootImageFault(JSON.parse(stdout));
    } catch {
      return undefined;
    }
  };

  /**
   * Mint this Sandbox's token into a Secret, BEFORE the CR exists — the operator creates the pod
   * the moment it sees the CR, and a pod whose `envFrom` names an absent Secret sits in
   * CreateContainerConfigError. Idempotent by construction: the token is the Sandbox's name, signed
   * (tokens.ts), so a re-provision after an orchestrator restart re-applies the SAME value, and the
   * Adapter that has been holding it all along stays valid.
   */
  const applyTokenSecret = async (name: string): Promise<void> => {
    if (!opts.signingKey) throw new Error("kubectlSandbox: an Adapter needs a signingKey to mint its Sandbox token");
    // Fail the provision rather than ship an Adapter that cannot reach the Orchestrator. A mute
    // Adapter is the worst possible outcome: the pod comes up Ready, the Agent is admitted, its
    // tool call dies on `localhost`, and the Machine simply parks forever — a hang with no error.
    if (!orchestratorUrl()) {
      throw new Error(
        "kubectlSandbox: the Adapter has no route to the Orchestrator (no orchestratorUrl — deployed " +
          "instances derive Service DNS from J2_NAMESPACE). An Agent with no Adapter cannot drive its " +
          "Machine at all (ADR-0013).",
      );
    }
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName(name), namespace: ns, labels: { "j2.dev/sandbox": name } },
      type: "Opaque",
      stringData: { J2_SANDBOX_TOKEN: sandboxToken(opts.signingKey, name) },
    };
    await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(secret) });
  };

  /**
   * Make the Secret a child of the Sandbox CR, so Kubernetes reaps it whenever the CR goes — including
   * the paths no j2 code observes (the operator's idle-timeout GC, a `kubectl delete sandbox` by hand).
   * Needs the CR's uid, so it can only happen after the apply; a failure here leaks a Secret, never a
   * pod, so it is not worth failing the provision over.
   */
  const ownSecret = async (name: string, uid: string | undefined): Promise<void> => {
    if (!uid) return;
    const ownerRef = [
      { apiVersion: "core.j2.dev/v1alpha1", kind: "Sandbox", name, uid, controller: true, blockOwnerDeletion: false },
    ];
    await exec([
      "patch",
      "secret",
      secretName(name),
      ...base,
      "--type",
      "merge",
      "-p",
      JSON.stringify({ metadata: { ownerReferences: ownerRef } }),
    ]).catch(() => {});
  };

  /**
   * Every Repo the provision names, resolved to its identity and key — and FENCED (ADR-0051). A
   * per-run url is the run's input; one no `git.credentials` entry admits is refused here, before
   * anything is read or applied, naming the list. A bound url is admitted without a match: it is
   * code the instance typechecked and deployed. Two slots spelling one repository collapse to one
   * CR entry (first spelling wins) — one cache, however many slots borrow from it — and the
   * resource is BOUND when any of those slots is the Machine's: a per-run slot alone leaves it on
   * `j2 gc`'s clock.
   */
  const fencedRepos = (name: string, repos: ProvisionedRepo[]): FencedRepo[] => {
    const byKey = new Map<string, FencedRepo>();
    for (const repo of repos) {
      const { identity, key } = repoIdentity(repo.url);
      if (repo.perRun && !matchCredential(identity, credentials)) {
        const entries = credentials.map((c) => c.match).join(", ") || "none";
        throw new Error(
          `Sandbox "${name}" refuses the per-run repo ${repo.url} for slot "${repo.slot}": no git.credentials ` +
            `entry matches "${identity}" (entries: ${entries}). A per-run url can spend the cluster's credential ` +
            "against any host, so j2.config.ts must admit it by prefix (ADR-0051).",
        );
      }
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, { key, url: repo.url, identity, bound: !repo.perRun });
      else seen.bound ||= !repo.perRun;
    }
    return [...byKey.values()];
  };

  /**
   * What the operator will hold this Sandbox's Ready on, and what an attach reads afterwards
   * (ADR-0051). `Ready` with reason `RepoCloneFailed` is terminal for the provision — the cache
   * agent could not clone onto the node the pod landed on, and the reason names it — so the loop
   * fails on it by name rather than burning the budget. `ReposFresh=False` is the other verdict:
   * the caches are there but a fetch since this CR asked failed, so the attach proceeds STALE and
   * says so. Remembered per name until the Sandbox is destroyed, because the attach is a separate
   * call. The operator takes that verdict once per pod and keeps it, so a provision re-run on
   * snapshot restore reads the same one — unless the pod was replaced, which is the lease's news.
   */
  const staleByName = new Map<string, string>();

  return {
    async provision(req) {
      // The fence first: a refused url costs nothing — no map read, no Secret, no CR.
      const repos = fencedRepos(req.name, req.repos);
      if (opts.repos === undefined) {
        throw new Error(
          `Sandbox "${req.name}" cannot be provisioned: this port has no Repo-resource port (ADR-0051). The ` +
            "operator holds a Sandbox's Ready until every Repo it names exists as a resource, and creating " +
            "them is this provision's job — build the port with `repos: kubectlRepos(...)`.",
        );
      }
      // Read PER PROVISION, and next (ADR-0038). Not hoisted into `kubectlSandbox()`: a boot-time
      // read would freeze the map for the process lifetime, which is precisely the Deployment-env
      // behavior the ConfigMap mount was chosen over — the point of the mount is that a `j2 up`
      // reaches future Sandboxes without rolling the Orchestrator. Reading before the Secret apply
      // also means an unknown image name costs nothing: no Secret, no CR, nothing to clean up.
      const refs = await readImageRefs(imagesPath);
      const cr = await crFor(req, refs, repos);

      // The Repo resources, BEFORE the CR names them (ADR-0051): a bound one already exists from
      // the boot and only its eviction clock moves — this run's spelling never rewrites the spec
      // the boot stated; a per-run one is created here, at its first attach, and every later
      // attach anywhere finds it and restates its credential, so the `git.credentials` fix
      // `repoCloneError` names reaches the cache at the next run. After the image resolution, so
      // a refused image still costs nothing; before the token Secret, so no Secret is minted for
      // a Sandbox whose Repo could not be recorded.
      for (const repo of repos) await opts.repos.ensure(repo);

      await applyTokenSecret(req.name); // before the CR: the pod's Adapter mounts it at start
      await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(cr) });

      const applied = Date.now();
      // Two budgets from one instant (see the options): the pod's until the operator has seen the
      // pod Ready, the Repos' from the first poll that finds the Sandbox held on a Repo reason —
      // which the operator reports only once the pod IS Ready, so the preflight has already passed
      // and what remains is a clone or a fetch on the node. Sticky: a pod that came up once is not
      // a pod that will never come up, whatever it does afterwards.
      let held = false;
      let owned = false;
      let polls = 0;
      for (;;) {
        const status = await getSandbox(req.name);
        if (!owned && status?.uid) ((owned = true), await ownSecret(req.name, status.uid));
        // The pod is read at a COARSER cadence than the CR, and only while not Ready. The fault it
        // looks for is terminal — the kubelet never retries out of it — so learning about it a few
        // seconds late costs nothing, while reading the pod on every poll would double this port's
        // API traffic for every healthy provision in the cluster.
        if (status?.phase !== "Ready" && polls++ % POD_CHECK_EVERY === 0) {
          const fault = await podFault(req.name);
          if (fault) throw new Error(rootImageError(req.name, fault));
        }
        // Terminal for THIS provision: the cache agent tried to clone onto the pod's node and git
        // refused. The operator's message carries the key, the node, and git's own words; the
        // agent keeps retrying on its own, so `j2 status` will show the same error until it is fixed.
        const ready = conditionOf(status, "Ready");
        if (status?.phase !== "Ready" && ready?.reason === REPO_CLONE_FAILED) {
          throw new Error(repoCloneError(req.name, ready.message ?? ready.reason));
        }
        if (ready?.reason !== undefined && REPO_HELD.has(ready.reason)) held = true;
        if (status?.phase === "Ready") {
          // Only `phase: Ready` means serving — status.endpoint appears earlier (ADR-0001).
          if (!status.endpoint) throw new Error(`Sandbox "${req.name}" is Ready but reports no endpoint`);
          // Freshness degrades, absence does not (ADR-0051): Ready with `ReposFresh=False` is a
          // Sandbox whose caches exist but could not be fetched since it asked. Remembered for the
          // attach, which is where a slot can be named; forgotten when the caches are fresh.
          const fresh = conditionOf(status, "ReposFresh");
          if (fresh?.status === "False" && fresh.message) staleByName.set(req.name, fresh.message);
          else staleByName.delete(req.name);
          // The identity the lease will hold this workspace to (ADR-0021). Ready means the pod
          // is up, so the operator has published it; an operator too old to do so leaves it
          // undefined and the lease falls back to presence.
          return { endpoint: status.endpoint, identity: status.podUID };
        }
        if (Date.now() >= applied + (held ? repoTimeoutMs : readyTimeoutMs)) {
          // A Sandbox the operator held on its Repos ran out the Repo budget: the pod is up and the
          // preflight passed, so the hint about the image would be a lie. What is true is the
          // operator's own verdict — which Repo, on which node — and that the agent is still at it.
          if (held) throw new Error(repoWaitError(req.name, repoTimeoutMs, ready));
          // One last look before falling back to the hint: the fault may have appeared inside the
          // final interval, and a named error beats a timeout in every case where both are true.
          const fault = await podFault(req.name);
          if (fault) throw new Error(rootImageError(req.name, fault));
          // Otherwise name where to look, because the next most likely cause is an image that
          // misses ADR-0037's floor, and that failure is an INIT container's — invisible in the
          // phase alone. A musl or git-less base dies INSIDE the preflight, on j2's own message.
          // The operator's own verdict rides along when it has one: a Repo still pending on the
          // node (a slow clone) reads very differently from a preflight death.
          throw new Error(
            `Sandbox "${req.name}" never reached Ready (last phase: ${status?.phase ?? "absent"}) — if its ` +
              "Sandbox Image is new, check the preflight: `kubectl logs " +
              req.name +
              " -c preflight` (ADR-0037's floor: glibc, git, a writable HOME, a numeric non-root USER)." +
              (ready?.message
                ? `\n  the operator's Ready condition says: ${ready.reason ?? "?"}: ${ready.message}`
                : ""),
          );
        }
        await sleep(pollMs);
      }
    },

    async attach(req) {
      const { script, repos, review } = attachScript(req.spec, req.repos, {
        reposMount: REPOS_MOUNT,
        workRoot,
        // The fetch url names the Adapter only when it is somewhere unexpected (ADR-0053).
        ...(adapterPort !== DEFAULT_ADAPTER_PORT ? { adapterUrl: `http://127.0.0.1:${adapterPort}` } : {}),
      });
      // `-c harness` is unchanged and still correct after ADR-0037: the primary container runs the
      // Sandbox Image, so `git` here is the git the user chose. Never `-c user` — that seat is
      // zero-contract, may hold no git at all, and j2 commands nothing in it (ADR-0005).
      await exec(["exec", `pod/${req.name}`, ...base, "-c", "harness", "--", "sh", "-ec", script]);
      const stale = staleSlots(req.repos, staleByName.get(req.name));
      return { repos, ...(review ? { review } : {}), ...(stale ? { stale } : {}) };
    },

    leaseIntervalMs,

    async renew(name) {
      // ONE call, both directions: `annotate --overwrite -o json` writes the stamp and prints the
      // object as it stands afterwards, status included. So asserting liveness and learning
      // whether the workspace survived cost exactly one API round trip (ADR-0021).
      try {
        const { stdout } = await exec([
          "annotate",
          "sandbox",
          name,
          ...base,
          `j2.dev/keepalive=${new Date().toISOString()}`,
          "--overwrite",
          "-o",
          "json",
        ]);
        return { present: true, identity: readSandbox(stdout).podUID };
      } catch (err) {
        if (isNotFound(err)) return { present: false };
        throw err; // anything else is UNKNOWN — the caller must not read it as loss
      }
    },

    async destroy(name) {
      staleByName.delete(name);
      // The Secret is an owned child of the CR, so deleting the CR reaps it — this is belt and
      // braces for the case where the ownerRef patch didn't land.
      await exec(["delete", "sandbox", name, ...base, "--ignore-not-found"]);
      await exec(["delete", "secret", secretName(name), ...base, "--ignore-not-found"]).catch(() => {});
    },
  };
}

/** The pod volume the operator defines for one Repo's node cache, and where it lands in the
 * primary container (ADR-0051). Two halves of one contract with the operator, spelled here so the
 * User Container's mounts and the attach's clone source agree with it by construction. */
export const repoVolumeName = (key: string): string => `repo-${key}`;
export const repoMountPath = (key: string): string => `${REPOS_MOUNT}/${key}`;

/** One Repo as the provision names it: the CR entry, plus what its resource records — the
 * identity, and whether a Machine's slot (not only the run's) binds it. */
type FencedRepo = { key: string; url: string; identity: string; bound: boolean };

/** One entry of a Sandbox CR's `status.conditions`, as the operator writes it. */
type Condition = { type: string; status: string; reason?: string; message?: string };

/** The operator's Ready reason when the cache agent could not clone onto the pod's node
 * (sandbox_controller.go) — the one Ready verdict a provision cannot wait out. */
const REPO_CLONE_FAILED = "RepoCloneFailed";

/** The operator's Ready reasons that hold a Sandbox whose POD is Ready on its Repos
 * (sandbox_controller.go, `reposReadiness`): the resource not yet seen, or the node's cache
 * agent still cloning or fetching. The wait against them is the Repo budget, not the pod's. */
const REPO_HELD: ReadonlySet<string> = new Set(["RepoMissing", "RepoPending"]);

/**
 * The Repo budget ran out with the operator still holding the Sandbox. The pod is up, so the
 * preflight is not the question; the verdict names the Repo and the node, and the port adds
 * what the operator cannot say: the agent is still working, `j2 status` shows it per node, and
 * the budget is the port's, not the clone's.
 */
function repoWaitError(name: string, budgetMs: number, ready: Condition | undefined): string {
  const verdict = ready?.message ? `${ready.reason ?? "?"}: ${ready.message}` : "no Ready condition reported";
  return (
    `Sandbox "${name}" waited ${Math.round(budgetMs / 60_000)}m for its Repos and the operator still holds it — ` +
    `${verdict} (ADR-0051). The node's cache agent clones a cold node once and fetches before every attach; ` +
    "`j2 status` reports each Repo per node. Start the run again once the cache is present, or raise " +
    "the port's `repoTimeoutMs` for a repository whose clone outlasts it."
  );
}

/**
 * The fix beside the symptom. The operator's message carries the Repo, the node, and git's own
 * words; what it cannot say is that the cache agent keeps retrying, that `j2 status` reports the
 * same line per node, or where a credential is configured (ADR-0047/0051).
 */
function repoCloneError(name: string, verdict: string): string {
  return (
    `Sandbox "${name}" cannot start: ${verdict} (ADR-0051). The node's cache agent keeps retrying on its own — ` +
    "fix the url or its git.credentials entry (an ssh url needs its deploy key registered with the host, " +
    "ADR-0047), then start the run again; `j2 status` reports the same error per node until it clears."
  );
}

/**
 * The `ReposFresh=False` message, keyed back to SLOTS for the attach's `stale`. The operator
 * writes one clause per stale Repo — `Repo "<key>" on node <n> is stale: <error>` — joined by
 * `; `; each slot whose key a clause names gets that clause. A message that names no key at all
 * lands on every slot: a verdict with no address is still a verdict.
 */
function staleSlots(
  repos: Array<{ slot: string; url: string }>,
  message: string | undefined,
): Record<string, string> | undefined {
  if (!message) return undefined;
  const byKey = new Map<string, string>();
  for (const clause of message.split("; ")) {
    const key = /^Repo "([^"]+)"/.exec(clause)?.[1];
    if (key !== undefined) byKey.set(key, clause);
  }
  const stale: Record<string, string> = {};
  for (const repo of repos) {
    const clause = byKey.size === 0 ? message : byKey.get(repoIdentity(repo.url).key);
    if (clause !== undefined) stale[repo.slot] = clause;
  }
  return Object.keys(stale).length ? stale : undefined;
}

/**
 * The post-Ready attach step as one idempotent in-pod script (ADR-0004, ADR-0051): per Repo Slot
 * in declaration order, a pod-local `git clone --shared` borrowing objects from the node's
 * read-only cache at `/repos/<key>` — `<slot>/default/`, a checkout of the Repo's default branch
 * — then the branch worktree as a sibling (gwtmux layout: `<slot>/default/` + `<slot>/<branch>/`). With a `reviewSha`, also the detached review worktree
 * (ADR-0028) — another sibling. `repos` keeps the slots' declaration order. Exported for the port's
 * tests; the workflow never sees it.
 */
export function attachScript(
  spec: WorkspaceSpec,
  repos: Array<{ slot: string; url: string; ref?: string }>,
  paths: { reposMount: string; workRoot: string; adapterUrl?: string },
): { script: string; repos: Record<string, string>; review?: Record<string, string> } {
  const worktrees: Record<string, string> = {};
  const review: Record<string, string> = {};
  // The cache is written by the node's cache agent and read here as the Harness's unprivileged
  // uid (ADR-0001/0004/0051), so git's dubious-ownership guard would refuse the clone source.
  // safe.directory is only honored from global/system config (never `-c`), and inside the pod
  // every path is j2-owned — trusting them all is the honest scope.
  // The attach runs via exec, not as a child of the Harness process, so it does NOT inherit the
  // Harness's `umask 002` — without its own, the repo roots it mkdirs land 755 and the work group
  // could never create a file at a tree's top. INSIDE the trees the umask stops mattering: the
  // default ACL stamped below governs everything created beneath a repo root (ADR-0005).
  const lines: string[] = [`umask 002`, `git config --global safe.directory '*'`];
  const branchDir = spec.branch.replace(/\//g, "-");
  for (const repo of repos) {
    const slotDir = `${paths.workRoot}/${repo.slot}`;
    const dflt = `${slotDir}/default`;
    const worktree = `${slotDir}/${branchDir}`;
    const { identity, key } = repoIdentity(repo.url);
    const cache = `${paths.reposMount}/${key}`;
    worktrees[repo.slot] = worktree;
    lines.push(
      `mkdir -p ${sq(slotDir)}`,
      // BEFORE the clone fills it: a default ACL is inherited at creation, never retrofitted, so
      // the stamp must exist while the tree is still empty. From here down, both seats' files land
      // group-writable with zero umask lines in any image (ADR-0005); on a filesystem without
      // POSIX ACLs the helper warns and exits 0, degrading to the umask sharing above.
      `/opt/j2/bin/work-acl ${sq(slotDir)}`,
      `[ -d ${sq(`${dflt}/.git`)} ] || git clone --shared ${sq(cache)} ${sq(dflt)}`,
      // No ref → the Repo's own default branch: this clone's `origin/HEAD` tracks the cache's
      // HEAD, which the cache agent's clone pointed at the remote's default (ADR-0004).
      `[ -d ${sq(worktree)} ] || git -C ${sq(dflt)} worktree add ${sq(worktree)} -b ${sq(spec.branch)} ${repo.ref === undefined ? sq("origin/HEAD") : baseOf(dflt, repo.ref)}`,
      // Fetch/push split (ADR-0005). The FETCH url is a command, not a path (ADR-0053): git's
      // built-in `ext::` transport runs the program on the runtime volume, which asks the node
      // cache to fetch the remote, waits for the landing, then serves the cache — so every fetch
      // inside the pod is a fetch of the remote's now, and a stale attach is stale only until the
      // next fetch anyone in the pod runs. Git substitutes `%S` with the service it wants
      // (`git-upload-pack`), and splits the rest on spaces with no quoting of its own, so the
      // url's arguments carry none: the Repo's IDENTITY, never the cache key — that is the name a
      // human reads in `git remote -v`, and a key is a derived directory name (ADR-0004). The
      // program discovers the cache from the checkout's alternates, so the url says nothing about
      // where the objects are. `git push` goes to the REAL remote — the Binding's own spelling, so
      // a Machine that bound over ssh pushes over ssh even when the cache was cloned over https
      // (ADR-0051). Push still succeeds only with a caller-supplied credential (a forwarded agent
      // in the User Container); the pod itself holds none. `--` keeps the url an operand, never an
      // option.
      `git -C ${sq(dflt)} remote set-url origin -- ${sq(fetchUrl(identity, paths.adapterUrl))}`,
      `git -C ${sq(dflt)} remote set-url --push origin -- ${sq(repo.url)}`,
      // `ext` is on git's own "known scary" list, so its built-in default is `never` and the url
      // above would die with `fatal: transport 'ext' not allowed` before the program ever ran.
      // `user` is the policy ADR-0053 argues for, said out loud: a fetch A PERSON OR THE AGENT
      // runs is allowed, and a recursive one git makes for itself (a submodule url, anything with
      // `GIT_PROTOCOL_FROM_USER=0`) is still refused — so a repository cannot smuggle a program
      // into this pod through a url j2 did not write. Repo-level, on the pod-local clone: the
      // linked worktrees share this config, so the branch worktree and the review worktree inherit
      // it with no env and no `--global`.
      `git -C ${sq(dflt)} config protocol.ext.allow user`,
    );
    if (spec.reviewSha) {
      // The reviewer's seat (ADR-0028): a DETACHED HEAD at the sha under review, so a rogue write
      // cannot move the branch and a rogue commit evaporates with the checkout. Forced checkout
      // AND clean on every attach: a previous round's rogue edits (tracked) and leftovers
      // (untracked) must not survive into this round — the review worktree's contents are the
      // sha under review, period.
      const reviewDir = `${worktree}-review`;
      review[repo.slot] = reviewDir;
      lines.push(
        `[ -d ${sq(reviewDir)} ] || git -C ${sq(dflt)} worktree add --detach ${sq(reviewDir)} ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} checkout --detach -f ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} clean -fd`,
      );
    }
  }
  if (repos.length === 0)
    throw new Error("the attach names no Repo Slot — nothing to attach (a workspace() declares at least one)");
  return {
    script: lines.join("\n"),
    repos: worktrees,
    ...(spec.reviewSha ? { review } : {}),
  };
}

/**
 * `origin`'s fetch url for one Repo (ADR-0053): the `ext::` transport, the program's absolute path
 * on the runtime volume, the service git asks for, and the Repo's identity. The Adapter's address
 * rides as a third argument only when the composition moved the Adapter off its default port —
 * the program reads `$J2_ADAPTER_URL` and then falls back to that same address, so spelling it out
 * unconditionally would put a number in every `git remote -v` that says nothing.
 */
function fetchUrl(identity: string, adapterUrl?: string): string {
  return `ext::${UPLOAD_PACK} %S ${extArg(identity)}${adapterUrl !== undefined ? ` ${extArg(adapterUrl)}` : ""}`;
}

/**
 * One argument of an `ext::` url, in git's own escaping. Git splits the url on spaces and reads
 * `%` as a placeholder introducer — `%S` is the service it substitutes — so it DIES on a `%` it
 * does not recognize (`fatal: Bad remote-ext placeholder '%2'`) and silently splits an argument
 * that holds a space. An identity carries both: a forge path may be percent-encoded
 * (`dev.azure.com/org/My%20Project/_git/repo`) and an scp-style url may hold a literal space. Git
 * spells those two `%%` and `% `, and the program receives the identity back exactly as written —
 * which it must, because the Orchestrator derives the cache key from that same string. The
 * placeholder j2 writes itself (`%S`) is not escaped: it is git's, not an argument's.
 */
function extArg(value: string): string {
  return value.replace(/%/g, "%%").replace(/ /g, "% ");
}

/**
 * The commit-ish a Binding's `ref` names inside the pod-local clone, as a shell expression: the
 * remote-tracking branch `refs/remotes/origin/<ref>` when the clone has one, else `<ref>` as
 * written (a tag, a sha). A fresh clone holds ONE local branch — the default — so a bare
 * branch name is never a local ref here, and git's "worktree add" DWIM would then create the BASE
 * branch tracking `origin/<ref>` and discard `-b`: the Agent would commit on, and push to, the base
 * it was meant to branch FROM. Naming the remote-tracking ref outright leaves nothing to guess.
 */
function baseOf(dflt: string, ref: string): string {
  const remote = sq(`refs/remotes/origin/${ref}`);
  return `"$(git -C ${sq(dflt)} rev-parse --verify -q ${remote} >/dev/null && printf %s ${remote} || printf %s ${sq(ref)})"`;
}

/** POSIX single-quote an argument for the in-pod `sh -ec` script. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /NotFound|not found/i.test(err.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `kubectl` on PATH, as every kubectl-driven port shells to it (this one and repos.ts). */
export const defaultKubectlExec: KubectlExec = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile("kubectl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`kubectl ${args[0]} failed: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
  });
