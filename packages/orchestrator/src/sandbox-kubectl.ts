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
// WHICH IMAGE a Sandbox runs is not an option here (ADR-0037/0038). The spec carries a NAME —
// an `images/<name>` dirname or a registry ref — and the resolved name→ref map arrives as a
// mounted ConfigMap read on EVERY provision, so a `j2 up` that rebuilds an image reaches future
// Sandboxes without rolling this process.
//
// The pod's primary container is the Sandbox Image BYTE-FOR-BYTE (ADR-0037): no appended layers,
// no rewritten Dockerfile, no j2 knowledge inside it. j2's runtime arrives at POD time instead —
// an emptyDir at `/opt/j2`, populated by an init container running the kit's Harness image — and
// the container's COMMAND is overridden to start the Harness from that volume. The image's own
// `USER` and `HOME` are respected (the human who execs in lands in the environment its author
// built); only its `ENTRYPOINT`/`CMD` do not run, because a container has one command and the
// Harness must own it — its death must be the container's death, which is what the operator's
// Ready probe and restart semantics at `:8080` mean. A process the image WANTS running is not
// lost: it has its own seat, the User Container (ADR-0005), composed here when the spec names it.
//
// So this module composes the whole pod — two init steps and up to three containers:
//
//   initContainer runtime     the kit's Harness image → copies /opt/j2 into the volume
//   initContainer preflight   the USER'S image + that volume → ADR-0037's probe, the thing that
//                             proves a registry ref, whose first appearance is this provision
//   container     harness     the Sandbox Image, command overridden, /work + /opt/j2 mounted
//   container     adapter     j2-owned, the pod's only credential holder (below)
//   container     user        optional, the image's own entrypoint, /work and NOTHING else
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
  declaresNoUser,
  readImageRefs,
  resolveSandboxImage,
  resolveUserImage,
  unrunnableUser,
  type ImageRefs,
} from "./images.ts";
import { CA_CONFIGMAP, IMAGES_KEY, IMAGES_MOUNT, REPOS_PVC } from "./names.ts";
import { sandboxToken } from "./tokens.ts";
import type { HarnessEnvFromSource, HarnessEnvVar } from "./config.ts";
import type { WorkspaceSpec, SandboxPort } from "./workspace.ts";

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
 * string; `unrunnableUser` in images.ts reads it before anything is applied), so this is the brought
 * ref's path: never inspected, never given the uid-1000 fallback, knowable only from the cluster.
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
 * floor is a HARNESS-SEAT obligation, a built `images/<name>` may equally be destined for the User
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
   * Default: the `j2-images` ConfigMap's mount. No image option here any more: which image a
   * Sandbox runs is a NAME on the spec, resolved against this map at provision. */
  imagesPath?: string;
  /** Extra env for the HARNESS container (`harness.env`) — merged ahead of the
   * mechanism-owned vars, which win on collision. */
  env?: HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container (`harness.envFrom`) — how a real
   * Harness gets its model API key without the value ever touching j2 config. */
  envFrom?: HarnessEnvFromSource[];
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
  /** Await-Ready budget. Default 120s, polled every second. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /**
   * The last sync error for one source-volume repo, or undefined when its last sync succeeded
   * (ADR-0048) — the supervised reconcile's `errorFor`. The attach is where the degradation bites:
   * it clones `<reposMount>/<name>/default`, so a repo that has not synced is a checkout that is
   * absent or stale, and the run that needs it is the one that must hear about it. Absent (no
   * reconcile wired — tests, a hand-built port) means "nothing known", which asserts nothing.
   *
   * It may ANSWER LATE, and the deployed one does: the boot no longer waits for the first pass, so
   * the entrypoint's implementation waits for it here instead. A run that starts while its repo is
   * still cloning then waits for the clone rather than racing it into an empty volume — the wait
   * the boot used to do, moved to the only caller that actually needs it.
   */
  repoError?: (name: string) => string | undefined | Promise<string | undefined>;
  /** Process seam, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
};

export function kubectlSandbox(opts: KubectlSandboxOptions = {}): SandboxPort {
  const ns = opts.namespace ?? "default";
  const imagesPath = opts.imagesPath ?? join(IMAGES_MOUNT, IMAGES_KEY);
  const workRoot = opts.workRoot ?? "/work";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const exec = opts.exec ?? defaultExec;

  const adapterPort = opts.adapterPort ?? 8081;
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
   * The User Container (ADR-0005): the opt-in third seat, composed only when the spec names an
   * image. The ZERO-CONTRACT seat — j2 injects nothing, probes nothing, overrides nothing. So:
   * no `command` (its own entrypoint runs, untouched), no `env`, no `envFrom`, no `/opt/j2`, no CA
   * bundle, no ports, no resources. Every key j2 forwarded would be a crack in "j2 puts nothing in
   * it", and widening the one authoring string to an object stays compatible if a concrete need
   * ever argues its own way in.
   *
   * `/work` read-write is the single exception, and it is not an injection but the point: this
   * seat and the Harness mount ONE worktree, so the human and the Agent see identical files —
   * which is also why ADR-0005's cross-uid pair (the pod's `fsGroup`, the attach's default ACL)
   * exists at all. The Adapter is deliberately not given `/work`: it reads no worktree, and it is
   * the container holding the pod's only credential, so it gets the narrowest mount set that
   * works. It also carries no
   * `securityContext`, which the operator reads as the exemption — root is ALLOWED here, because
   * hardening a seat whose identity is "what j2 does not own" is an opinion, and the standard
   * managed-access shape (a root sshd that setuids sessions down) must run unmodified.
   */
  const userSidecar = (refs: ImageRefs, image: string) => ({
    name: "user",
    image: resolveUserImage(refs, image),
    volumeMounts: [{ name: "work", mountPath: workRoot }],
  });

  /** The pod's sidecar list (ADR-0001: opaque fragments the operator schedules verbatim). The
   * Adapter is ALWAYS here: with its ref in the image map there is no "no adapter configured"
   * state left to branch on, and a Sandbox without one is a pod that comes up Ready and then parks
   * its Machine forever on a tool call it cannot make (ADR-0013). A map with no `adapter` fails the
   * read instead (images.ts). The User Container joins it only when the spec named one. */
  const sidecarsFor = (name: string, refs: ImageRefs, user?: string) => [
    adapterSidecar(name, refs),
    ...(user !== undefined ? [userSidecar(refs, user)] : []),
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

  const seatFor = (refs: ImageRefs, name?: string): Seat => {
    const image = resolveSandboxImage(refs, name);
    // Fail HERE, before a Secret or a CR exists, on a `USER` the kubelet will refuse (images.ts).
    // The alternative is the worst shape a failure has: the preflight container never starts, so
    // it has no logs, and the whole 120s Ready budget burns before anything is said. The converge
    // already inspected the image, so this is knowable at zero cost — and the message names the
    // edit, because the fix is one line of the caller's own Dockerfile.
    const refused = unrunnableUser(refs, name);
    if (refused !== undefined) {
      throw new Error(
        `the Sandbox Image "${name ?? "default"}" declares \`USER ${refused}\`, which cannot run a j2 seat: ` +
          "every j2-owned container is `runAsNonRoot` with no `runAsUser`, so the kubelet needs a NUMERIC " +
          "non-zero uid it can check without reading the image (ADR-0005). Change the Dockerfile's last " +
          "`USER` to that uid (e.g. `USER 1000`, or drop the line entirely and j2 supplies uid 1000 with a " +
          "writable HOME — ADR-0037), then re-run `j2 up`.",
      );
    }
    // The common case, and the one ADR-0037 is written around: the image chose its `USER` and its
    // `HOME`, and j2 touches neither — the human who execs in lands in the environment the
    // image's author built, dotfiles included.
    if (!declaresNoUser(refs, name)) {
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

  const crFor = (
    req: { name: string; runId: string; workflow: string; image?: string; user?: string; workGroup?: number },
    refs: ImageRefs,
  ) => {
    const seat = seatFor(refs, req.image);
    const sidecars = sidecarsFor(req.name, refs, req.user);
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
        volumes: [
          // The in-cluster source volume (ADR-0004/0019): the same PVC the orchestrator's boot
          // reconcile writes, mounted read-only here. No hostPath, nothing kind-special.
          { name: "repos", persistentVolumeClaim: { claimName: REPOS_PVC, readOnly: true } },
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
        // Read-only is load-bearing twice (ADR-0004): no write contention, and nothing in a
        // Sandbox can `gc` the object store its `--shared` clones borrow from.
        // CR-level volumeMounts land on the HARNESS container only (the operator's contract) —
        // exactly the CA-trust asymmetry ADR-0020 wants: the Adapter never inherits it.
        volumeMounts: [
          { name: "repos", mountPath: "/repos", readOnly: true },
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

  type SandboxStatus = { phase?: string; endpoint?: string; podUID?: string; uid?: string };

  /** Parse a Sandbox CR off any kubectl call that printed one (`get -o json`, and the lease's
   * `annotate -o json` — which returns the object AFTER the patch, status included). */
  const readSandbox = (stdout: string): SandboxStatus => {
    const parsed = JSON.parse(stdout) as {
      metadata?: { uid?: string };
      status?: { phase?: string; endpoint?: string; podUID?: string };
    };
    return { ...(parsed.status ?? {}), uid: parsed.metadata?.uid };
  };

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

  return {
    async provision(req) {
      // Read PER PROVISION, and first (ADR-0038). Not hoisted into `kubectlSandbox()`: a boot-time
      // read would freeze the map for the process lifetime, which is precisely the Deployment-env
      // behavior the ConfigMap mount was chosen over — the point of the mount is that a `j2 up`
      // reaches future Sandboxes without rolling the Orchestrator. Reading before the Secret apply
      // also means an unknown image name costs nothing: no Secret, no CR, nothing to clean up.
      const refs = await readImageRefs(imagesPath);
      const cr = crFor(req, refs);

      await applyTokenSecret(req.name); // before the CR: the pod's Adapter mounts it at start
      await exec(["apply", ...base, "-f", "-"], { input: JSON.stringify(cr) });

      const deadline = Date.now() + readyTimeoutMs;
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
        if (status?.phase === "Ready") {
          // Only `phase: Ready` means serving — status.endpoint appears earlier (ADR-0001).
          if (!status.endpoint) throw new Error(`Sandbox "${req.name}" is Ready but reports no endpoint`);
          // The identity the lease will hold this workspace to (ADR-0021). Ready means the pod
          // is up, so the operator has published it; an operator too old to do so leaves it
          // undefined and the lease falls back to presence.
          return { endpoint: status.endpoint, identity: status.podUID };
        }
        if (Date.now() >= deadline) {
          // One last look before falling back to the hint: the fault may have appeared inside the
          // final interval, and a named error beats a timeout in every case where both are true.
          const fault = await podFault(req.name);
          if (fault) throw new Error(rootImageError(req.name, fault));
          // Otherwise name where to look, because the next most likely cause is an image that
          // misses ADR-0037's floor, and that failure is an INIT container's — invisible in the
          // phase alone. A musl or git-less base dies INSIDE the preflight, on j2's own message.
          throw new Error(
            `Sandbox "${req.name}" never reached Ready (last phase: ${status?.phase ?? "absent"}) — if its ` +
              "Sandbox Image is new, check the preflight: `kubectl logs " +
              req.name +
              " -c preflight` (ADR-0037's floor: glibc, git, a writable HOME, a numeric non-root USER).",
          );
        }
        await sleep(pollMs);
      }
    },

    async attach(req) {
      // Before the exec (ADR-0048): every repo this attach is about to clone must have synced.
      // A failed sync leaves either no checkout at all or last boot's objects, and both attach
      // "successfully" into a Sandbox whose worktrees are wrong — a silent, much later failure.
      // Named here instead: the repo, and git's own reason, to the run that owns the consequence.
      const unsynced = (
        await Promise.all(
          req.spec.repos.map(async (repo) => ({ name: repo.name, error: await opts.repoError?.(repo.name) })),
        )
      ).filter((r): r is { name: string; error: string } => r.error !== undefined);
      if (unsynced.length) {
        throw new Error(
          `Sandbox "${req.name}" cannot attach ${unsynced.map((r) => `repo "${r.name}" (${r.error})`).join("; ")} — ` +
            "the source volume's sync for it has not succeeded, so its read-only `default/` checkout is absent or " +
            "stale. The reconcile keeps retrying (ADR-0048); `j2 status` lists every repo that is not synced, and " +
            "the fix is on the git side — register the deploy key (ADR-0047), correct the url, or grant the token.",
        );
      }
      const { script, workdir, repos, review } = attachScript(req.spec, { reposMount: "/repos", workRoot });
      // `-c harness` is unchanged and still correct after ADR-0037: the primary container runs the
      // Sandbox Image, so `git` here is the git the user chose. Never `-c user` — that seat is
      // zero-contract, may hold no git at all, and j2 commands nothing in it (ADR-0005).
      await exec(["exec", `pod/${req.name}`, ...base, "-c", "harness", "--", "sh", "-ec", script]);
      return { workdir, repos, ...(review ? { review } : {}) };
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
      // The Secret is an owned child of the CR, so deleting the CR reaps it — this is belt and
      // braces for the case where the ownerRef patch didn't land.
      await exec(["delete", "sandbox", name, ...base, "--ignore-not-found"]);
      await exec(["delete", "secret", secretName(name), ...base, "--ignore-not-found"]).catch(() => {});
    },
  };
}

/**
 * The post-Ready attach step as one idempotent in-pod script (ADR-0004): per repo, a pod-local
 * `git clone --shared --no-checkout` borrowing objects from the RO `default/` volume, then the
 * branch worktree as a sibling (gwtmux layout: `<repo>/default/` + `<repo>/<branch>/`).
 * With a `reviewSha`, also the detached review worktree (ADR-0028) — another sibling.
 * Exported for the port's tests; the workflow never sees it.
 */
export function attachScript(
  spec: WorkspaceSpec,
  paths: { reposMount: string; workRoot: string },
): { script: string; workdir: string; repos: Record<string, string>; review?: Record<string, string> } {
  const repos: Record<string, string> = {};
  const review: Record<string, string> = {};
  // The RO repos volume is written by the ORCHESTRATOR's uid and read here as the Harness's
  // unprivileged uid (ADR-0001/0004), so git's dubious-ownership guard would refuse the clone
  // source. safe.directory is only honored from global/system config (never `-c`), and inside
  // the pod every path is j2-owned — trusting them all is the honest scope.
  // The attach runs via exec, not as a child of the Harness process, so it does NOT inherit the
  // Harness's `umask 002` — without its own, the repo roots it mkdirs land 755 and the work group
  // could never create a file at a tree's top. INSIDE the trees the umask stops mattering: the
  // default ACL stamped below governs everything created beneath a repo root (ADR-0005).
  const lines: string[] = [`umask 002`, `git config --global safe.directory '*'`];
  const branchDir = spec.branch.replace(/\//g, "-");
  for (const repo of spec.repos) {
    const dflt = `${paths.workRoot}/${repo.name}/default`;
    const worktree = `${paths.workRoot}/${repo.name}/${branchDir}`;
    repos[repo.name] = worktree;
    lines.push(
      `mkdir -p ${sq(`${paths.workRoot}/${repo.name}`)}`,
      // BEFORE the clone fills it: a default ACL is inherited at creation, never retrofitted, so
      // the stamp must exist while the tree is still empty. From here down, both seats' files land
      // group-writable with zero umask lines in any image (ADR-0005); on a filesystem without
      // POSIX ACLs the helper warns and exits 0, degrading to the umask sharing above.
      `/opt/j2/bin/work-acl ${sq(`${paths.workRoot}/${repo.name}`)}`,
      `[ -d ${sq(`${dflt}/.git`)} ] || git clone --shared --no-checkout ${sq(`${paths.reposMount}/${repo.name}/default`)} ${sq(dflt)}`,
      `[ -d ${sq(worktree)} ] || git -C ${sq(dflt)} worktree add ${sq(worktree)} -b ${sq(spec.branch)} ${sq(repo.baseRef)}`,
    );
    if (spec.reviewSha) {
      // The reviewer's seat (ADR-0028): a DETACHED HEAD at the sha under review, so a rogue write
      // cannot move the branch and a rogue commit evaporates with the checkout. Forced checkout
      // AND clean on every attach: a previous round's rogue edits (tracked) and leftovers
      // (untracked) must not survive into this round — the review worktree's contents are the
      // sha under review, period.
      const reviewDir = `${worktree}-review`;
      review[repo.name] = reviewDir;
      lines.push(
        `[ -d ${sq(reviewDir)} ] || git -C ${sq(dflt)} worktree add --detach ${sq(reviewDir)} ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} checkout --detach -f ${sq(spec.reviewSha)}`,
        `git -C ${sq(reviewDir)} clean -fd`,
      );
    }
  }
  const first = spec.repos[0];
  if (!first) throw new Error("workspace spec has no repos — nothing to attach");
  return {
    script: lines.join("\n"),
    workdir: repos[first.name]!,
    repos,
    ...(spec.reviewSha ? { review } : {}),
  };
}

/** POSIX single-quote an argument for the in-pod `sh -ec` script. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /NotFound|not found/i.test(err.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const defaultExec: KubectlExec = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile("kubectl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`kubectl ${args[0]} failed: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
  });
