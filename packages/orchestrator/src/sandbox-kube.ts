// The canonical SandboxPort (ADR-0012 / GAP(3)): drives the operator's Sandbox CRD through the
// Orchestrator's own Kubernetes client (kube-client.ts, ADR-0063) — plain REST on built-in
// `fetch`, no dependency — and reads it back through the one watch (sandbox-watch.ts). Every wait
// that polled is now a watch event: the provision's Ready, and Continuity (ADR-0021). The
// Orchestrator never reads a Pod: the operator owns it (ADR-0001) and publishes what this port
// needs on the Sandbox's status — `podUID`, the scheduler's word, the Harness container's restarts
// and last end. The client and the watch are injectable, so the mapping is unit-testable against a
// fake API server; the kind e2e tier exercises the real thing.
//
// Reachability: the orchestrator always runs in-cluster (ADR-0019), so it dials
// `status.endpoint` (`http://<name>.<ns>.svc:…`) directly — stable across orchestrator
// restarts by nature, which is what ADR-0012's "same endpoint" re-attach promise rides on.
//
// Every operation is idempotent (SandboxPort contract): apply is create-or-update, the attach is
// the Harness's own `POST /attach`, which guards every clone and worktree (ADR-0063), delete
// ignores absent.
//
// WHICH REPOS a Sandbox attaches arrive resolved from the `workspace()`'s Repo Slots (ADR-0051):
// the CR names each by its cache key, the operator mounts the node's cache read-only at
// `/repos/<key>` and gates Ready on it, and the Harness's attach clones off that mount. The one judgement
// made here is the FENCE: a per-run url must match a `git.credentials` entry, or it is refused
// before anything is applied.
//
// WHICH IMAGE a Sandbox runs is not an option here (ADR-0037/0038/0049). The request carries what
// the `workspace()` wrapper statically declared — a `file:` docker context or a registry ref — and
// the resolved key→ref map arrives as a mounted ConfigMap read on EVERY provision, so a `jr2 up`
// that rebuilds an image reaches future Sandboxes without rolling this process.
//
// The pod's primary container is the Sandbox Image BYTE-FOR-BYTE (ADR-0037): no appended layers,
// no rewritten Dockerfile, no jr2 knowledge inside it. jr2's runtime arrives at POD time instead —
// an `image` volume of the kit's Harness image, its `/opt/jr2` mounted read-only at `/opt/jr2` —
// and the container's COMMAND is overridden to start the Harness from that volume. The kubelet
// mounts the image's own layers, so every Sandbox on a node reads one set of runtime pages. The
// image's own `USER` and `HOME` are respected (the human who execs in lands in the environment its
// author built); only its `ENTRYPOINT`/`CMD` do not run, because a container has one command and the
// Harness must own it — its death must be the container's death, which is what the operator's
// Ready probe and restart semantics at `:8080` mean. A process the image WANTS running is not
// lost: it has its own seat, the User Container (ADR-0005), composed here when the wrapper's static
// `user` option names an image (ADR-0049).
//
// So this module composes the whole pod — one volume from the kit, one init step, and up to three
// containers:
//
//   volume        runtime     the kit's Harness image, as an `image` volume → /opt/jr2
//   initContainer preflight   the USER'S image + that volume → ADR-0037's probe, the thing that
//                             proves a registry ref, whose first appearance is this provision
//   container     harness     the Sandbox Image, command overridden, /work + /opt/jr2 mounted
//   container     custodian   jr2-composed, the pod's only credential holder (below)
//   container     user        optional, the image's own entrypoint, the checkouts (/work, plus
//                             /repos and /opt/jr2 read-only) and NOTHING else
//
// and SIZES it (ADR-0060): the Workspace's Size, resolved down its chain, is the pod-level ceiling;
// the Custodian takes a fixed slice, the User Container its split if the Machine states one, and
// the Harness container the rest as its own limit. Every request equals its limit, so the pod is
// Guaranteed and the CPU limit is enforced.
//
// This is also where the CUSTODIAN is composed (ADR-0013, ADR-0059). The operator needs no change
// to carry it: ADR-0001 made `Sidecars` generic container fragments it schedules WITHOUT
// understanding, so the Custodian is exactly that — a container with an image, its mounts, and a
// readiness probe the pod's Ready waits on. What this module builds is the pod's asymmetry:
//
//   harness container     JR2_CUSTODIAN_URL + the Stand-in of every credential  (no credential)
//   custodian container   the Sandbox token and every held secret, as files     (the credentials)
//
// The Agent has code execution in the first and none in the second. The token is minted here — a
// signed Sandbox name (see tokens.ts), so re-provisioning after a restart yields the SAME token and
// the Secret re-applies as a no-op. What else the Custodian holds is `jr2 up`'s resolution, read
// per provision from the `jr2-held` mount (custodian.ts builds both placements' pods alike).

import { join } from "node:path";
import {
  matchCredential,
  type GitCredential,
  type HarnessEnvFromSource,
  type HarnessEnvVar,
  type SandboxPlacement,
} from "./config.ts";
import { custodianComposition, type CustodianComposition } from "./custodian.ts";
import { readHeldManifest } from "./held-secrets.ts";
import { readImageRefs, resolveSandboxImage, resolveUserImage, type ImageRefs } from "./images.ts";
import { HELD_KEY, HELD_MOUNT, IMAGES_KEY, IMAGES_MOUNT, PRIORITY_CLASS_SANDBOX, REPOS_MOUNT } from "./names.ts";
import { SANDBOXES, SECRETS, kubeClient, type KubeClient } from "./kube-client.ts";
import { repoIdentity } from "./repo-identity.ts";
import type { RepoResources } from "./repos.ts";
import { resolveSize, splitSize, type Size, type SizeSplit } from "./size.ts";
import { watchSandboxes, type Condition, type SandboxObject, type SandboxWatch } from "./sandbox-watch.ts";
import { harnessToken, harnessTokenDigest, sandboxToken } from "./tokens.ts";
import type { AttachError, AttachRequest, AttachResponse } from "./wire.ts";
import type { Continuity, ProvisionedRepo, SandboxPort } from "./workspace.ts";

/** Where jr2's runtime lands in every container that gets it (ADR-0037). `/opt/jr2` and not `/app`
 * because a stranger's base may already use `/app`, and one layout must serve both the stock
 * Harness image and an arbitrary Sandbox Image. It is a PUBLISHED surface: `bin/` beside `lib/`
 * (node's rpath is `$ORIGIN/../lib`), `src/main.ts`, `node_modules/`. */
export const RUNTIME_MOUNT = "/opt/jr2";

/** How every seat that holds the runtime mounts it (ADR-0037). The volume is the WHOLE harness
 * image, so `subPath` narrows it to that image's own `/opt/jr2` — the published surface, laid out
 * exactly as the Harness image runs it, so node's `$ORIGIN/../lib` holds with nothing rearranged.
 * Read-only in every seat: an image volume is read-only anyway, and the Agent has code execution
 * in the Harness container, so the CR says so rather than leaving it to the volume type. The
 * layers stay owned by root and the Sandbox Image may run any uid, so the image's MODE is the
 * guarantee that any uid reads it — the harness Dockerfile's build-time check holds it there. */
const RUNTIME_VOLUME = "runtime";
const RUNTIME_VOLUME_MOUNT = { name: RUNTIME_VOLUME, mountPath: RUNTIME_MOUNT, subPath: "opt/jr2", readOnly: true };

/** The primary container's command (ADR-0037). Absolute, so it never depends on the image's
 * `WORKDIR`, and identical to the stock Harness image's own `CMD` — one runtime, two placements.
 * `tini` is PID 1 (ADR-0061): the Agent's processes are the Harness's children, and a tree the
 * memory guard kills must leave no zombies behind. */
const HARNESS_COMMAND = [
  `${RUNTIME_MOUNT}/bin/tini`,
  "--",
  `${RUNTIME_MOUNT}/bin/node`,
  `${RUNTIME_MOUNT}/src/main.ts`,
];

/** Where the Harness attaches (ADR-0004): the `work` volume's mount in every seat that holds the
 * checkouts. Fixed, because the Harness's attach writes exactly here (ADR-0063). */
const WORK_ROOT = "/work";

/** ADR-0005's default work group. Convention, not config: the pod's `fsGroup` is granted to every
 * container as a supplemental group, so the Harness writes `/work` whatever the number and no
 * image's `/etc/group` needs to know it. The one override is the spec's `workGroup`. */
const DEFAULT_WORK_GROUP = 2000;

/**
 * The isolation baseline for a jr2-owned seat, spelled out HERE for the init container because the
 * operator's hardened default covers the primary container and the sidecars only (ADR-0001/0005) —
 * init steps pass through verbatim, which is what keeps the operator agent-agnostic. Deliberately
 * not applied to the `user` container: that seat's identity is "what jr2 does not own".
 */
const HARDENED = {
  runAsNonRoot: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

/**
 * ADR-0037's fallback seat, for a BUILT image that declares no `USER` (the converge's `docker
 * inspect` is what saw that; images.ts holds the record). jr2 sets `runAsUser` nowhere else — an
 * image's own `USER` decides its seat's uid (ADR-0005) — so this applies only where the image
 * chose nothing and the alternative is root, which the hardened context refuses.
 *
 * The home is a POD volume, not a directory in the image: uid 1000 on a stranger's base has no
 * home at all, and the floor needs a writable one (`git config --global` writes `$HOME/.gitconfig`
 * on every attach; a real toolchain wants `~/.npm`, `~/.cargo`, `~/.cache`). An emptyDir lands
 * group-writable under the pod's fsGroup, so uid 1000 owns it in practice without jr2 chown-ing
 * anything. `/home/jr2` and not `/home/node`: the number is jr2's choice here, so the path is too.
 */
const FALLBACK_UID = 1000;
const FALLBACK_HOME = "/home/jr2";

/**
 * The CPU hints (ADR-0060), each the Harness container's own `limits.cpu` through the Downward API
 * (divisor 1, so a fractional limit rounds UP to whole cpus). For the tools that read neither the
 * cgroup's limit nor their affinity: `OMP_NUM_THREADS` also makes `nproc` answer N, and
 * `PYTHON_CPU_COUNT` and `GOMAXPROCS` speak for their runtimes. `os.cpus()` still reports the node —
 * a Machine that runs Playwright passes `--workers=$JR2_CPUS`.
 *
 * TODO(ADR-0062): the Agent is told its CPU count and Size by the Briefing, never by the Frame.
 */
const CPU_HINTS = ["JR2_CPUS", "OMP_NUM_THREADS", "PYTHON_CPU_COUNT", "GOMAXPROCS"] as const;
const cpuHintEnv = (): HarnessEnvVar[] =>
  CPU_HINTS.map((name) => ({ name, valueFrom: { resourceFieldRef: { resource: "limits.cpu", divisor: "1" } } }));

/**
 * How many times the Harness container may end before the provision stops waiting for it
 * (ADR-0063). The operator publishes its restarts and last end on the Sandbox's status, so a
 * Harness that dies on start — a Sandbox Image that misses ADR-0037's floor in a way the preflight
 * did not catch, a runtime the image cannot run — fails the provision by NAME, with the kubelet's
 * reason and exit code, instead of burning the whole Ready budget. Two, not one: a single restart
 * on the way up (a memory kill during a heavy start, ADR-0061) is a pod that may still come up.
 */
const CRASH_LOOP_RESTARTS = 2;

/** The kubelet's reason for a container the kernel killed at its memory limit (ADR-0061). */
const OOM_KILLED = "OOMKilled";

/** How long a lost conversation waits for the operator's word on a memory kill (ADR-0061). The
 * Harness can be serving again — and answering 404 — a moment before the kubelet's status for its
 * last run has reached the Sandbox, and this port never reads the Pod to learn it sooner. */
const MEMORY_FAULT_GRACE_MS = 5_000;

/** Clock skew allowed between a node's kubelet stamping `finishedAt` and this process's `since`. */
const MEMORY_FAULT_SKEW_MS = 10_000;

/** How long an attach keeps re-sending a request that never reached the Harness (ADR-0042): the
 * attach is now the FIRST thing that dials a Sandbox's Service, and Ready is not routable. The
 * same measured window the admission uses (harness-client.ts). */
const ATTACH_WINDOW_MS = 90_000;

/**
 * ADR-0037's preflight, VERBATIM: git present · `$HOME` writable · glibc new enough for jr2's node
 * (with the relocated `libstdc++`) · the vendored ripgrep, reached through the mounted `/opt/jr2`.
 *
 * The three commands are the floor, one each: `git config --global` proves git is on the system
 * PATH AND that `$HOME` is writable for the image's user; `node -e ""` proves the glibc is no
 * older than the one jr2's node was built against (this is where musl dies); `rg` UNQUALIFIED
 * proves the vendored static binary resolves THROUGH PATH, which is what the Harness's own append
 * buys at runtime.
 *
 * ONE prover, and this is it (ADR-0037/0041). A converge cannot hold an image to this floor: the
 * floor is a HARNESS-SEAT obligation, a built context may equally be destined for the User
 * Container seat — which owes no floor at all (ADR-0005) — and which seat a directory serves is
 * workflow-internal and statically unrecoverable (ADR-0031). Here the seat is known, and here is
 * also the only moment a registry ref exists at all, since jr2 never builds or inspects one.
 */
const SANDBOX_PREFLIGHT = `git config --global safe.directory "*" && ${RUNTIME_MOUNT}/bin/node -e "" && rg --version`;

/**
 * The probe as a shell line. The PATH append is mechanism, not part of the claim, and it is not
 * optional: nothing bakes `/opt/jr2/bin` into the user's image any more, so a probe that skipped it
 * would report `rg: not found` for every image on earth. APPENDED, never prepended — a toolchain
 * the image pinned wins, which is as much the property being proved as `rg`'s presence (ADR-0037).
 * The seat gets no login shell at either end, so `$PATH` is whatever the image itself set.
 */
function preflightShell(): string {
  return `export PATH="$PATH:${RUNTIME_MOUNT}/bin"; ${SANDBOX_PREFLIGHT}`;
}

/**
 * The preflight as an init step IN THE USER'S IMAGE with `/opt/jr2` mounted. It fails the pod
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
  `echo "jr2: this Sandbox Image does not meet the floor (ADR-0037): a glibc base no older than ` +
    `jr2's node (musl is out entirely), git on the system PATH, a writable HOME for the image's ` +
    `USER, and /opt/jr2 + /work + :8080 unclaimed. jr2 vendors the rest." >&2`,
  `exit 1`,
].join("\n");

export type KubeSandboxOptions = {
  /** The mounted image map (ADR-0037/0038) — every ref this port can name, written by `jr2 up`.
   * Default: the `jr2-images` ConfigMap's mount. No image option here: which image a Sandbox runs
   * is the `workspace()` wrapper's static `image` option (ADR-0049) — carried on the Machine, read
   * off it at invoke time, handed to `provision()` as a string — and resolved against this map at
   * provision. The per-run spec never names one (ADR-0051). */
  imagesPath?: string;
  /** The held-secret manifest `jr2 up` resolved (ADR-0059) — read per provision like the image map,
   * so a held-secret edit reaches future Sandboxes without rolling this process. Default: the
   * `jr2-held` ConfigMap's mount. */
  heldPath?: string;
  /** Extra env for the HARNESS container (`harness.env`) — merged ahead of the
   * mechanism-owned vars, which win on collision. */
  env?: HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container (`harness.envFrom`) — how a real
   * Harness gets its model API key without the value ever touching jr2 config. */
  envFrom?: HarnessEnvFromSource[];
  /** Where a Sandbox may land (ADR-0052): the Instance's `sandbox.nodeSelector` and
   * `sandbox.tolerations`, written on the CR verbatim and copied onto the pod by the operator, which
   * merges nothing with them. Absent → wherever an ordinary pod lands. */
  placement?: SandboxPlacement;
  /** The Instance's default Size (`sandbox.resources`, ADR-0060): applied only to a Workspace
   * that states no Size, never under or over a stated one. Absent → the kit default. */
  defaultSize?: Size;
  /** The Sandbox pod's PriorityClass (ADR-0060): `priorityClasses.sandbox`, or the `jr2-sandbox`
   * class `jr2 up` creates. */
  priorityClassName?: string;
  /** The instance ships a private-CA bundle (ADR-0020): the HARNESS container trusts it, and the
   * Custodian verifies a bound host with it (custodian.ts). */
  caBundle?: boolean;
  /** The key Sandbox tokens are signed with — from the instance Secret (ADR-0013/0019). */
  signingKey?: Buffer;
  /** Kube namespace for Sandbox CRs. Default `default`. */
  namespace?: string;
  /** CR `spec.idleTimeout` — the operator's abandoned-Sandbox GC backstop (ADR-0001). Default `30m`. */
  idleTimeout?: string;
  /** How often a workspace's lease actor renews (ADR-0001/0021): the cadence at which
   * `jr2.dev/keepalive` is re-stamped, ±20%. Must be ≪ idleTimeout, since a lapsed lease is what
   * lets the operator reap. Default 5m. */
  leaseIntervalMs?: number;
  /** Await-Ready budget for the POD: from the CR apply until the operator reports the pod Ready.
   * Default 120s, measured against watch events. A pod that never comes up (an image that misses
   * ADR-0037's floor) is what this bounds; a pod that is up and waiting on its Repos is
   * `repoTimeoutMs`'s. */
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
  /** The Kubernetes client (ADR-0063), shared with the Repo ports so one write cap covers the
   * process. Default: the in-cluster client. */
  client?: KubeClient;
  /** The one Sandbox watch (ADR-0063), shared with the fetch ask. Default: one started on first
   * use, over `client`, in `namespace`. */
  watch?: SandboxWatch;
  /** The transport the attach dials the Harness with (ADR-0063). Injectable for tests. Default:
   * global `fetch`. */
  harnessFetch?: typeof fetch;
  /** How long an attach re-sends a request that never reached the Harness. Default 90s. */
  attachWindowMs?: number;
};

export function kubeSandbox(opts: KubeSandboxOptions = {}): SandboxPort {
  const ns = opts.namespace ?? "default";
  const imagesPath = opts.imagesPath ?? join(IMAGES_MOUNT, IMAGES_KEY);
  const heldPath = opts.heldPath ?? join(HELD_MOUNT, HELD_KEY);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
  const repoTimeoutMs = opts.repoTimeoutMs ?? 25 * 60_000;
  const credentials = opts.credentials ?? [];
  const leaseIntervalMs = opts.leaseIntervalMs ?? 5 * 60_000;
  const harnessFetch = opts.harnessFetch ?? fetch;
  const attachWindowMs = opts.attachWindowMs ?? ATTACH_WINDOW_MS;

  // Built on first use, never at construction: a boot that builds this port has not yet reached
  // the cluster, and must not need to (ADR-0048's stance for the Repos, held for the Sandboxes).
  let client: KubeClient | undefined = opts.client;
  const kube = () => (client ??= kubeClient());
  let watch: SandboxWatch | undefined = opts.watch;
  const sandboxes = () => (watch ??= watchSandboxes(kube(), { namespace: ns }));

  /** The Sandbox's token Secret — mounted into the Custodian container, and nothing else in the pod. */
  const secretName = (name: string) => `${name}-token`;

  /**
   * The User Container (ADR-0005): the opt-in third seat, composed only when the wrapper's static
   * `user` option names an image (ADR-0049). The ZERO-CONTRACT seat — jr2 injects nothing, probes
   * nothing, overrides nothing. So: no `command` (its own entrypoint runs, untouched), no `env`,
   * no `envFrom`, no CA bundle, no ports, no resources. Every key jr2 forwarded would be a crack in
   * "jr2 puts nothing in it", and widening the one authoring string to an object stays compatible
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
   * borrowed object is missing ("unable to normalize alternate object path"). `/opt/jr2` is the
   * other half (ADR-0053): `origin`'s fetch url is a program on that volume, so a seat without it
   * holds checkouts whose `git fetch` dies — and with it the human gets the same fetch as the
   * Agent, with no credential of their own. Nothing else follows it in: `ext::` names the program
   * by absolute path, so this seat still gets no env, no command, and no probe. The repo volumes
   * are the operator's — it defines `repo-<key>` for every key the CR names — so this seat mounts
   * them by name. The Custodian is deliberately not given any of the three: it reads no worktree, and it is the
   * container holding the pod's credentials, so it gets the narrowest mount set that works.
   * It also carries no `securityContext`, which the operator reads as the exemption — root is
   * ALLOWED here, because hardening a seat whose identity is "what jr2 does not own" is an opinion,
   * and the standard managed-access shape (a root sshd that setuids sessions down) must run
   * unmodified.
   */
  const userSidecar = async (refs: ImageRefs, image: string, keys: string[], split: SizeSplit) => ({
    name: "user",
    image: await resolveUserImage(refs, image),
    volumeMounts: [
      { name: "work", mountPath: WORK_ROOT },
      RUNTIME_VOLUME_MOUNT,
      ...keys.map((key) => ({ name: repoVolumeName(key), mountPath: repoMountPath(key), readOnly: true })),
    ],
    // Its split of the Size, only when the Machine states one (ADR-0060) — a fact the Machine
    // wrote, not an injection. Otherwise the seat has no limit of its own and shares the pod's.
    ...(split.user ? { resources: split.user } : {}),
  });

  /** The pod's sidecar list (ADR-0001: opaque fragments the operator schedules verbatim). The
   * Custodian is ALWAYS here: a Sandbox without one is a pod that comes up Ready and then parks its
   * Machine forever on a Menu it cannot read (ADR-0013). The User Container joins it only when the
   * spec named one. */
  const sidecarsFor = async (
    custodian: CustodianComposition,
    refs: ImageRefs,
    keys: string[],
    split: SizeSplit,
    user?: string,
  ) => [custodian.custodianContainer, ...(user !== undefined ? [await userSidecar(refs, user, keys, split)] : [])];

  // The Harness container's env: the instance's passthrough (`harness.env` — e.g. model
  // config) first, then the mechanism-owned vars (the Custodian's address and every Stand-in, the
  // proxy and the trust bundles — custodian.ts), which win on collision. Note the asymmetry stands
  // (ADR-0013): user env/envFrom land on the HARNESS container only — never on the Custodian, whose
  // mounts are composed here and carry the pod's credentials.
  //
  // The gate rides LAST (ADR-0058): the digest of the bearer the Orchestrator derives for THIS
  // Sandbox. A digest because the Agent reads this env; last because a `harness.env` entry of the
  // same name must not be able to choose the Harness's credential.
  const harnessEnv = (name: string, custodian: CustodianComposition, hints: HarnessEnvVar[]): HarnessEnvVar[] => {
    if (!opts.signingKey) throw new Error("kubeSandbox: a Harness needs a signingKey to check its bearer");
    return [
      ...(opts.env ?? []),
      ...custodian.harnessEnv,
      // The CPU hints (ADR-0060) are mechanism: they say what the Size gives, so they win over a
      // `harness.env` entry of the same name.
      ...hints,
      { name: "JR2_HARNESS_TOKEN_SHA256", value: harnessTokenDigest(opts.signingKey, name) },
    ];
  };

  /**
   * The one init step (ADR-0037): `preflight`, the USER'S image with the runtime volume mounted,
   * running the probe. It is a plain container fragment the operator schedules without
   * understanding, exactly like a sidecar — the operator stays agent-agnostic (ADR-0001), so "how a
   * Sandbox proves its image" is composed here, not reconciled there. Nothing populates the volume
   * first: it is the kit's image, mounted (see `runtimeVolume`).
   *
   * It carries jr2's hardened context explicitly, and runs the probe in the SAME seat the Harness
   * will get — the image's own user, or ADR-0037's fallback — because a probe that proved a
   * different uid's `$HOME` proved nothing.
   */
  const initContainersFor = (seat: Seat, split: SizeSplit) => [
    {
      name: "preflight",
      image: seat.image,
      command: ["/bin/sh", "-c", PREFLIGHT_SCRIPT],
      ...(seat.env.length ? { env: seat.env } : {}),
      volumeMounts: [RUNTIME_VOLUME_MOUNT, ...seat.homeMount],
      // Small and fixed, inside the pod's budget (ADR-0060): it runs before the others start.
      resources: split.preflight,
      securityContext: seat.securityContext,
    },
  ];

  /**
   * jr2's runtime (ADR-0037): the kit's Harness image as an `image` volume. This is what makes the
   * runtime's version ride the VOLUME rather than the image: a kit edit moves the harness image's
   * own tag and re-images future pods without touching a single Sandbox Image tag, which is the
   * only way a registry-ref image could ever follow a kit update. A live pod keeps the image it
   * started with — the same create-if-absent stance ADR-0038 takes for images. No `pullPolicy`:
   * the kubelet's default for a volume is its default for a container, so the ref is pulled
   * exactly as the cluster already pulls the Harness image, and the volume adds nothing to deliver.
   */
  const runtimeVolume = (refs: ImageRefs) => ({ name: RUNTIME_VOLUME, image: { reference: refs.harness } });

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
        `the Sandbox Image "${name ?? "default"}" declares \`USER ${refusedUser}\`, which cannot run a jr2 seat: ` +
          "every jr2-owned container is `runAsNonRoot` with no `runAsUser`, so the kubelet needs a NUMERIC " +
          "non-zero uid it can check without reading the image (ADR-0005). Change the Dockerfile's last " +
          "`USER` to that uid (e.g. `USER 1000`, or drop the line entirely and jr2 supplies uid 1000 with a " +
          "writable HOME — ADR-0037), then re-run `jr2 up`.",
      );
    }
    // The common case, and the one ADR-0037 is written around: the image chose its `USER` and its
    // `HOME`, and jr2 touches neither — the human who execs in lands in the environment the
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
    req: {
      name: string;
      runId: string;
      workflow: string;
      image?: string;
      user?: string;
      workGroup?: number;
      userResources?: Size;
    },
    refs: ImageRefs,
    repos: FencedRepo[],
    custodian: CustodianComposition,
    split: SizeSplit,
  ) => {
    const seat = await seatFor(refs, req.image);
    const sidecars = await sidecarsFor(
      custodian,
      refs,
      repos.map((r) => r.key),
      split,
      req.user,
    );
    return {
      apiVersion: "core.jr2.dev/v1alpha1",
      kind: "Sandbox",
      metadata: {
        name: req.name,
        namespace: ns,
        // The run↔workspace link `jr2 ls` groups by (ADR-0009/0012) — readable without the host.
        labels: { "jr2.dev/run": req.runId, "jr2.dev/workflow": req.workflow },
      },
      spec: {
        // The Sandbox Image, unmodified (ADR-0037) — the user's tools, its own USER and HOME, and
        // jr2's runtime arriving beside it on a volume. This container is both the Harness and the
        // human's `exec` shell.
        image: seat.image,
        // The one thing jr2 takes from the image: its command. A container has exactly one, and it
        // must be the Harness's — a pod whose main process is the user's entrypoint keeps
        // "Running" through a Harness death, which makes the operator's Ready probe a lie.
        command: HARNESS_COMMAND,
        // Hardened, and the ONLY place jr2 ever names a uid: ADR-0037's fallback for an image that
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
        // Priority (ADR-0060): a pod of ordinary priority cannot preempt a live Workspace, and a
        // waiting Sandbox evicts nobody (the class's preemptionPolicy is Never).
        priorityClassName: opts.priorityClassName ?? PRIORITY_CLASS_SANDBOX,
        // The Size (ADR-0060). `resources` is the HARNESS container's (the operator's contract):
        // the rest of the Size after the Custodian and the User Container, requests = limits, plus
        // the `/work` disk as an ephemeral-storage request with no limit. `podResources` is the
        // whole Size, pod-level (KEP-2837) — the ceiling the pod never passes.
        resources: split.harness,
        podResources: split.pod,
        // `/dev/shm` (ADR-0060): the operator mounts a memory-backed emptyDir there, in the Harness
        // container only, with this `sizeLimit` — a quarter of the Harness share, minimum 64Mi.
        // Charged inside the Harness container's limit, so it reserves nothing extra; full, it is
        // ENOSPC or SIGBUS — a tool error, never a memory kill.
        shmSize: split.shmSizeLimit,
        // The work group (ADR-0005), the ownership half of cross-uid sharing on `/work`.
        // Kubernetes grants it as a supplemental group to every container, and puts a setgid
        // group on the volume root that propagates down; the WRITABILITY half is the default ACL
        // the Harness's attach stamps on each repo root (ADR-0063), without which fsGroup gives
        // group-READ, which is the trap. Both are inert when the uids match.
        fsGroup: req.workGroup ?? DEFAULT_WORK_GROUP,
        // Before any container starts: prove the image on the mounted `/opt/jr2`.
        initContainers: initContainersFor(seat, split),
        // Never empty: the Custodian's address is unconditional. The seat's own vars (the fallback
        // `HOME`) come FIRST, so the instance's `harness.env` can still override them the way it
        // overrides anything the image set.
        env: [...seat.env, ...harnessEnv(req.name, custodian, cpuHintEnv())],
        ...(opts.envFrom?.length ? { envFrom: opts.envFrom } : {}),
        // What the AGENT gets: an address on its own loopback and a Stand-in for every credential,
        // and no credential anywhere. The Custodian beside it holds them (ADR-0013, ADR-0059).
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
          // both load-bearing: every jr2-owned seat runs as an unprivileged uid, which cannot mkdir
          // under `/` — so an image-owned `/work` would make every attach fail — and `/work` is
          // the one thing all three containers share (ADR-0005), so human and Agent see identical
          // files. An emptyDir lands group-writable under the pod's fsGroup, so it is writable
          // whatever uid the Sandbox Image runs as: `/work` unclaimed is the only image contract.
          { name: "work", emptyDir: {} },
          // jr2's runtime (ADR-0037): the kit's Harness image, mounted.
          runtimeVolume(refs),
          // Only for ADR-0037's fallback seat: uid 1000 on a stranger's base has no home at all.
          ...seat.homeVolume,
          // The Custodian's (its values, leaves and config), and the trust ConfigMap (ADR-0020).
          ...custodian.volumes,
        ],
        // CR-level volumeMounts land on the HARNESS container only (the operator's contract): the
        // trust bundles, and none of the Custodian's volumes. The Repo caches are not listed: the
        // operator mounts each `repo-<key>` into this container itself.
        volumeMounts: [
          { name: "work", mountPath: WORK_ROOT },
          RUNTIME_VOLUME_MOUNT,
          ...seat.homeMount,
          ...custodian.harnessMounts,
        ],
      },
    };
  };

  const conditionOf = (sandbox: SandboxObject | undefined, type: string): Condition | undefined =>
    sandbox?.status?.conditions?.find((c) => c.type === type);

  /**
   * Mint this Sandbox's token into a Secret, BEFORE the CR exists — the operator creates the pod
   * the moment it sees the CR, and a pod whose volume names an absent Secret never starts.
   * Idempotent by construction: the token is the Sandbox's name, signed (tokens.ts), so a
   * re-provision after an orchestrator restart re-applies the SAME value, and the Custodian that has
   * been holding it all along stays valid. `data`, not `stringData`: a server-side apply owns the
   * fields it names, and `stringData` is write-only — it never reads back as the field applied.
   */
  const applyTokenSecret = async (name: string): Promise<void> => {
    if (!opts.signingKey) throw new Error("kubeSandbox: a Custodian needs a signingKey to mint its Sandbox token");
    await kube().apply(SECRETS, ns, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName(name), namespace: ns, labels: { "jr2.dev/sandbox": name } },
      type: "Opaque",
      data: { JR2_SANDBOX_TOKEN: Buffer.from(sandboxToken(opts.signingKey, name)).toString("base64") },
    });
  };

  /**
   * Make the Secret a child of the Sandbox CR, so Kubernetes reaps it whenever the CR goes — including
   * the paths no jr2 code observes (the operator's idle-timeout GC, a `kubectl delete sandbox` by hand).
   * Needs the CR's uid, which the apply answered with; a failure here leaks a Secret, never a pod,
   * so it is not worth failing the provision over.
   */
  const ownSecret = async (name: string, uid: string | undefined): Promise<void> => {
    if (!uid) return;
    const ownerReferences = [
      { apiVersion: "core.jr2.dev/v1alpha1", kind: "Sandbox", name, uid, controller: true, blockOwnerDeletion: false },
    ];
    await kube()
      .patch(SECRETS, ns, secretName(name), { metadata: { ownerReferences } })
      .catch(() => {});
  };

  /**
   * Every Repo the provision names, resolved to its identity and key — and FENCED (ADR-0051). A
   * per-run url is the run's input; one no `git.credentials` entry admits is refused here, before
   * anything is read or applied, naming the list. A bound url is admitted without a match: it is
   * code the instance typechecked and deployed. Two slots spelling one repository collapse to one
   * CR entry (first spelling wins) — one cache, however many slots borrow from it — and the
   * resource is BOUND when any of those slots is the Machine's: a per-run slot alone leaves it on
   * `jr2 gc`'s clock.
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
            "against any host, so jr2.config.ts must admit it by prefix (ADR-0051).",
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
   * agent could not clone onto the node the pod landed on, and the reason names it — so the wait
   * fails on it by name rather than burning the budget. `ReposFresh=False` is the other verdict:
   * the caches are there but a fetch since this CR asked failed, so the attach proceeds STALE and
   * says so. Remembered per name until the Sandbox is destroyed, because the attach is a separate
   * call. The operator takes that verdict once per pod and keeps it, so a provision re-run on
   * snapshot restore reads the same one — unless the pod was replaced, which is the lease's news.
   */
  const staleByName = new Map<string, string>();

  /**
   * The provision's wait, as watch events (ADR-0063): every change the operator publishes on this
   * Sandbox is judged as it lands, and a timer holds the budget. `judge` answers a result, throws a
   * named failure, or answers undefined to keep waiting; `budget` is re-read after every judgement,
   * because the Repo budget replaces the pod's the moment the operator holds the Sandbox on its
   * Repos.
   */
  const waitFor = <T>(
    name: string,
    judge: (sandbox: SandboxObject | undefined) => T | undefined,
    budget: () => { deadline: number; expire: (last: SandboxObject | undefined) => Error },
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let last: SandboxObject | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const arm = () => {
        clearTimeout(timer);
        const { deadline, expire } = budget();
        timer = setTimeout(() => finish(() => reject(expire(last))), Math.max(0, deadline - Date.now()));
      };
      const unsubscribe = sandboxes().subscribe(name, (sandbox) => {
        last = sandbox;
        try {
          const out = judge(sandbox);
          if (out !== undefined) return finish(() => resolve(out));
        } catch (err) {
          return finish(() => reject(err));
        }
        arm();
      });
      arm();
    });

  /** The Harness's `POST /attach` (ADR-0063), re-sent while it demonstrably never reached the
   * Harness. Idempotent on the Harness's side (every step guarded, calls serialized), so a re-send
   * after a request that DID land is harmless too — but only a transport failure is retried: an
   * answer is an answer. */
  const postAttach = async (name: string, endpoint: string, body: AttachRequest): Promise<AttachResponse> => {
    if (!opts.signingKey) throw new Error("kubeSandbox: the attach needs a signingKey for the Harness bearer");
    const url = new URL("/attach", endpoint).toString();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${harnessToken(opts.signingKey, name)}`,
    };
    const until = Date.now() + attachWindowMs;
    let backoff = 250;
    for (;;) {
      let res: Response;
      try {
        res = await harnessFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (err) {
        // Ready is not routable (ADR-0042): the EndpointSlice behind the Service is programmed after
        // the pod passes its probe, and the attach is now the first thing that dials it.
        if (Date.now() >= until) {
          throw new Error(
            `Sandbox "${name}": the attach never reached its Harness at ${endpoint}: ${(err as Error).message}`,
          );
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5_000);
        continue;
      }
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as AttachResponse;
      // The Harness's own words: the slot, the step, and git's stderr.
      let error = text;
      try {
        error = (JSON.parse(text) as AttachError).error ?? text;
      } catch {
        // not an AttachError: the raw body is the most there is
      }
      throw new Error(`Sandbox "${name}": the attach failed (${res.status}): ${error}`);
    }
  };

  return {
    async provision(req) {
      // The fence first: a refused url costs nothing — no map read, no Secret, no CR.
      const repos = fencedRepos(req.name, req.repos);
      // The Size next (ADR-0060), for the same price: the Machine's, then the Instance default, then
      // the kit's, split inside the pod — or refused before anything exists. `jr2 up` makes the
      // same refusal at the converge; this one covers a Machine it never walked.
      let split: SizeSplit;
      try {
        split = splitSize(resolveSize(req.resources, opts.defaultSize), req.userResources);
      } catch (err) {
        throw new Error(`Sandbox "${req.name}" cannot be provisioned: ${(err as Error).message}`);
      }
      if (opts.repos === undefined) {
        throw new Error(
          `Sandbox "${req.name}" cannot be provisioned: this port has no Repo-resource port (ADR-0051). The ` +
            "operator holds a Sandbox's Ready until every Repo it names exists as a resource, and creating " +
            "them is this provision's job — build the port with `repos: kubeRepos(...)`.",
        );
      }
      // Read PER PROVISION, and next (ADR-0038). Not hoisted into `kubeSandbox()`: a boot-time
      // read would freeze the map for the process lifetime, which is precisely the Deployment-env
      // behavior the ConfigMap mount was chosen over — the point of the mount is that a `jr2 up`
      // reaches future Sandboxes without rolling the Orchestrator. Reading before the Secret apply
      // also means an unknown image name costs nothing: no Secret, no CR, nothing to clean up.
      const refs = await readImageRefs(imagesPath);
      // The same stance for what the Custodian holds (ADR-0059): `jr2 up` resolved it host-side,
      // where `.env` exists, and this process reads the result — never its own config, whose
      // `.env` values are absent in-cluster.
      const manifest = await readHeldManifest(heldPath);
      const custodian = custodianComposition(manifest, {
        image: refs.custodian,
        token: { secret: secretName(req.name), key: "JR2_SANDBOX_TOKEN" },
        sandbox: req.name,
        caBundle: opts.caBundle === true,
        resources: split.custodian,
      });
      const cr = await crFor(req, refs, repos, custodian, split);

      // The Repo resources, BEFORE the CR names them (ADR-0051): a bound one already exists from
      // the boot and only its eviction clock moves — this run's spelling never rewrites the spec
      // the boot stated; a per-run one is created here, at its first attach, and every later
      // attach anywhere finds it and restates its credential, so the `git.credentials` fix
      // `repoCloneError` names reaches the cache at the next run. After the image resolution, so
      // a refused image still costs nothing; before the token Secret, so no Secret is minted for
      // a Sandbox whose Repo could not be recorded.
      for (const repo of repos) await opts.repos.ensure(repo);

      // The watch is started before the write (on first use), and it is level-based: whatever it
      // holds when the wait below subscribes is the first thing judged, so no event about this
      // Sandbox can fall between the write and the wait. Not awaited: an API server that cannot
      // be reached fails the apply below at once, rather than hanging on a list.
      sandboxes();
      await applyTokenSecret(req.name); // before the CR: the pod's Custodian mounts it at start
      const applied = await kube().apply(SANDBOXES, ns, cr);
      // The apply answered with the CR's uid, so the Secret's owner is known at once.
      await ownSecret(req.name, applied.metadata?.uid);

      const at = Date.now();
      // Two budgets from one instant (see the options): the pod's until the operator has seen the
      // pod Ready, the Repos' from the first event that finds the Sandbox held on a Repo reason —
      // which the operator reports only once the pod IS Ready, so the preflight has already passed
      // and what remains is a clone or a fetch on the node. Sticky: a pod that came up once is not
      // a pod that will never come up, whatever it does afterwards.
      let held = false;
      return waitFor(
        req.name,
        (sandbox) => {
          const status = sandbox?.status;
          const ready = conditionOf(sandbox, "Ready");
          // Terminal for THIS provision: the cache agent tried to clone onto the pod's node and git
          // refused. The operator's message carries the key, the node, and git's own words; the
          // agent keeps retrying on its own, so `jr2 status` will show the same error until it is fixed.
          if (status?.phase !== "Ready" && ready?.reason === REPO_CLONE_FAILED) {
            throw new Error(repoCloneError(req.name, ready.message ?? ready.reason));
          }
          // A Harness that keeps dying before it is ever Ready (ADR-0063): the kubelet's reason and
          // exit code, published by the operator, instead of the rest of the budget.
          const harness = status?.harness;
          if (status?.phase !== "Ready" && (harness?.restartCount ?? 0) >= CRASH_LOOP_RESTARTS) {
            throw new Error(crashLoopError(req.name, harness!));
          }
          if (ready?.reason !== undefined && REPO_HELD.has(ready.reason)) held = true;
          if (status?.phase !== "Ready") return undefined;
          // Only `phase: Ready` means serving — status.endpoint appears earlier (ADR-0001).
          if (!status.endpoint) throw new Error(`Sandbox "${req.name}" is Ready but reports no endpoint`);
          // Freshness degrades, absence does not (ADR-0051): Ready with `ReposFresh=False` is a
          // Sandbox whose caches exist but could not be fetched since it asked. Remembered for the
          // attach, which is where a slot can be named; forgotten when the caches are fresh.
          const fresh = conditionOf(sandbox, "ReposFresh");
          if (fresh?.status === "False" && fresh.message) staleByName.set(req.name, fresh.message);
          else staleByName.delete(req.name);
          // The identity the lease will hold this workspace to (ADR-0021). Ready means the pod
          // is up, so the operator has published it; an operator too old to do so leaves it
          // undefined and the lease falls back to presence.
          return { endpoint: status.endpoint, identity: status.podUID };
        },
        () => ({
          deadline: at + (held ? repoTimeoutMs : readyTimeoutMs),
          // A Sandbox the operator held on its Repos ran out the Repo budget: the pod is up and the
          // preflight passed, so the hint about the image would be a lie. What is true is the
          // operator's own verdict — which Repo, on which node — and that the agent is still at it.
          expire: (last) =>
            new Error(
              held ? repoWaitError(req.name, repoTimeoutMs, conditionOf(last, "Ready")) : notReadyError(req.name, last),
            ),
        }),
      );
    },

    async attach(req) {
      // The Harness's own route (ADR-0063): the same bearer as every Harness call (ADR-0058), and
      // the Repo's identity and cache key resolved HERE, so the cache the Harness clones from is
      // the one the operator mounted, by construction (ADR-0051). The address is the Sandbox's
      // own, off the watch — the one provision just waited on, or a restore's first list — or the
      // API server's, for one the watch has not listed yet.
      const sandbox = sandboxes().get(req.name) ?? (await kube().get<SandboxObject>(SANDBOXES, ns, req.name));
      const endpoint = sandbox?.status?.endpoint;
      if (!endpoint) throw new Error(`Sandbox "${req.name}" has no endpoint to attach through — is it gone?`);
      if (req.repos.length === 0) {
        throw new Error("the attach names no Repo Slot — nothing to attach (a workspace() declares at least one)");
      }
      const body: AttachRequest = {
        slots: req.repos.map((r) => {
          const { identity, key } = repoIdentity(r.url);
          return { slot: r.slot, url: r.url, identity, key, ...(r.ref !== undefined ? { ref: r.ref } : {}) };
        }),
        branch: req.spec.branch,
        ...(req.spec.reviewSha ? { reviewSha: req.spec.reviewSha } : {}),
      };
      const { repos, review } = await postAttach(req.name, endpoint, body);
      const stale = staleSlots(req.repos, staleByName.get(req.name));
      return { repos, ...(review ? { review } : {}), ...(stale ? { stale } : {}) };
    },

    leaseIntervalMs,

    async renew(name) {
      // A write, and only that (ADR-0021): the stamp the operator's idle GC reads. What the
      // workspace IS comes from the watch, never from this answer.
      await kube().patch(SANDBOXES, ns, name, {
        metadata: { annotations: { "jr2.dev/keepalive": new Date().toISOString() } },
      });
    },

    continuity(name, listener) {
      // The watch's word on this name (ADR-0063): the first list, then every event. A dropped
      // watch says nothing, so this says nothing either — unknown is never loss.
      return sandboxes().subscribe(name, (sandbox) => listener(continuityOf(sandbox)));
    },

    async memoryFault(name, since) {
      // Only a Sandbox the watch knows: the Instance Harness is a Deployment, not a Sandbox, and
      // waiting on a name that will never appear would only delay its fault (ADR-0031).
      if (!sandboxes().get(name)) return undefined;
      const judge = (sandbox: SandboxObject | undefined) => memoryFaultOf(sandbox, since);
      const now = judge(sandboxes().get(name));
      if (now !== undefined) return now;
      // The operator's word can trail the Harness's restart; give it a moment, then call it lost.
      return waitFor<string>(name, judge, () => ({
        deadline: Date.now() + MEMORY_FAULT_GRACE_MS,
        expire: () => new Error("no memory kill"),
      })).catch(() => undefined);
    },

    async destroy(name) {
      staleByName.delete(name);
      // The Secret is an owned child of the CR, so deleting the CR reaps it — this is belt and
      // braces for the case where the ownerRef patch didn't land.
      await kube().delete(SANDBOXES, ns, name);
      await kube()
        .delete(SECRETS, ns, secretName(name))
        .catch(() => {});
    },
  };
}

/** A Sandbox as Continuity (ADR-0021): gone, or present with the pod the operator last published. */
function continuityOf(sandbox: SandboxObject | undefined): Continuity {
  if (!sandbox) return { present: false };
  const identity = sandbox.status?.podUID;
  return identity ? { present: true, identity } : { present: true };
}

/**
 * The memory fault's reason (ADR-0061), or undefined: the Harness container's last run ended
 * `OOMKilled`, at or after `since` (less the skew a node's clock may carry). The prefix is FIXED —
 * `memory limit` — so a Machine, `jr2 status` and the feed can tell a memory kill from a
 * conversation lost any other way; the limit named is the Harness container's own, the one the
 * kernel enforced.
 */
export function memoryFaultOf(sandbox: SandboxObject | undefined, since: Date): string | undefined {
  const last = sandbox?.status?.harness?.lastTerminated;
  if (last?.reason !== OOM_KILLED) return undefined;
  const finished = last.finishedAt === undefined ? NaN : Date.parse(last.finishedAt);
  if (Number.isNaN(finished) || finished < since.getTime() - MEMORY_FAULT_SKEW_MS) return undefined;
  const limit = sandbox?.spec?.resources?.limits?.memory;
  return (
    `memory limit (${OOM_KILLED}${limit ? `, limit ${limit}` : ""}): the Workspace's processes passed the ` +
    "Harness container's memory limit and the kernel killed the container, the conversation with it. " +
    "Use fewer workers, or give the Workspace a larger Size (ADR-0060, ADR-0061)."
  );
}

/** The pod volume the operator defines for one Repo's node cache, and where it lands in the
 * primary container (ADR-0051). Two halves of one contract with the operator, spelled here so the
 * User Container's mounts and the attach's clone source agree with it by construction. */
export const repoVolumeName = (key: string): string => `repo-${key}`;
export const repoMountPath = (key: string): string => `${REPOS_MOUNT}/${key}`;

/** One Repo as the provision names it: the CR entry, plus what its resource records — the
 * identity, and whether a Machine's slot (not only the run's) binds it. */
type FencedRepo = { key: string; url: string; identity: string; bound: boolean };

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
 * what the operator cannot say: the agent is still working, `jr2 status` shows it per node, and
 * the budget is the port's, not the clone's.
 */
function repoWaitError(name: string, budgetMs: number, ready: Condition | undefined): string {
  const verdict = ready?.message ? `${ready.reason ?? "?"}: ${ready.message}` : "no Ready condition reported";
  return (
    `Sandbox "${name}" waited ${Math.round(budgetMs / 60_000)}m for its Repos and the operator still holds it — ` +
    `${verdict} (ADR-0051). The node's cache agent clones a cold node once and fetches before every attach; ` +
    "`jr2 status` reports each Repo per node. Start the run again once the cache is present, or raise " +
    "the port's `repoTimeoutMs` for a repository whose clone outlasts it."
  );
}

/**
 * The fix beside the symptom. The operator's message carries the Repo, the node, and git's own
 * words; what it cannot say is that the cache agent keeps retrying, that `jr2 status` reports the
 * same line per node, or where a credential is configured (ADR-0047/0051).
 */
function repoCloneError(name: string, verdict: string): string {
  return (
    `Sandbox "${name}" cannot start: ${verdict} (ADR-0051). The node's cache agent keeps retrying on its own — ` +
    "fix the url or its git.credentials entry (an ssh url needs its deploy key registered with the host, " +
    "ADR-0047), then start the run again; `jr2 status` reports the same error per node until it clears."
  );
}

/**
 * A Harness that never came up (ADR-0063): the kubelet's reason and exit code for its last run,
 * as the operator published them, and where the rest is — the container's own log. A preflight
 * that passes and a Harness that still dies is a Sandbox Image the floor did not fully prove, or
 * a Harness that ran out of memory on the way up (ADR-0061).
 */
function crashLoopError(name: string, harness: NonNullable<NonNullable<SandboxObject["status"]>["harness"]>): string {
  const last = harness.lastTerminated;
  const how = last ? `${last.reason ?? "?"}, exit ${last.exitCode ?? "?"}` : "no reason reported";
  return (
    `Sandbox "${name}" cannot start: its Harness has ended ${harness.restartCount} times before it was ever ` +
    `Ready (last: ${how}). See its output: \`kubectl logs ${name} -c harness --previous\`` +
    (last?.reason === OOM_KILLED
      ? " — it passed its memory limit, so give the Workspace a larger Size (ADR-0060)."
      : ".")
  );
}

/**
 * The pod budget ran out. The most likely cause is an image that misses ADR-0037's floor, and that
 * failure is an INIT container's — invisible in the phase alone. A musl or git-less base dies
 * INSIDE the preflight, on jr2's own message; a root image never starts it. The operator's words
 * ride along: a pod the scheduler could not place reads very differently from a preflight death.
 */
function notReadyError(name: string, last: SandboxObject | undefined): string {
  const said = (c: Condition | undefined) => (c?.message ? `${c.reason ?? "?"}: ${c.message}` : undefined);
  const ready = said(last?.status?.conditions?.find((c) => c.type === "Ready"));
  const scheduled = last?.status?.conditions?.find((c) => c.type === "Scheduled");
  const unplaced = scheduled && scheduled.status !== "True" ? said(scheduled) : undefined;
  return (
    `Sandbox "${name}" never reached Ready (last phase: ${last?.status?.phase ?? "absent"}) — if its ` +
    "Sandbox Image is new, check the preflight: `kubectl logs " +
    name +
    " -c preflight` (ADR-0037's floor: glibc, git, a writable HOME, a numeric non-root USER — an image " +
    "that runs as root never starts it, and `kubectl describe pod` says so)." +
    (unplaced ? `\n  the scheduler says: ${unplaced}` : "") +
    (ready ? `\n  the operator's Ready condition says: ${ready}` : "")
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
