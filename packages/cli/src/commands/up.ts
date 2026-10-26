// `jr2 up [--yes] [--force] [--skip-provider-preflight] [-n <ns>] [--context <ctx>]` (ADR-0019): idempotently converge the target
// namespace to this instance — every layer, loudly narrated, safe to re-run. Layers in order: the
// AGENTS.md block (ADR-0072: a file in the Instance folder, not the cluster) → typecheck → the
// Machine walk → staging the Assembly (ADR-0069) → the Kubernetes floor (ADR-0037) → ownership →
// image resolution → Kit images (the operator, the Harness, the Orchestrator) → Sandbox Images →
// Secret (+ preflight of referenced Secrets) → the provider preflight (ADR-0019, ADR-0059: through a
// Custodian, in pods that read their own objects) → operator → git ssh keys → apply → rollout → the cache
// agent (ADR-0051: a DaemonSet converged when a registered Machine composes a Sandbox, deleted
// when none does) → Instance Harness (ADR-0031: converged by convention when a carried definition
// declares `workspace: "none"`, deleted when none does) → Instance Effector → publishing the Assembly to the
// running Orchestrator (ADR-0069) → a report of live workspaces still on an older image.
//
// The Assembly is staged EARLY and published LAST (ADR-0069). Early, so its refusals (a second copy
// of a Kit package, a Kit version mismatch, a tree that names its staging path) come before any
// cluster spend. Last, because the door's own checks are true only once the cluster work is done:
// the image map holds every `file:` digest, the Secrets exist, and the Orchestrator runs the Kit
// version the Assembly names. A Machine edit therefore rolls nothing: it is a new Assembly, not a
// new pod template. The Orchestrator creates a Repo resource per
// Repo the walk found bound, at boot and at each publish, and the cache agent clones it onto a node on first need
// (ADR-0051); every provider a carried model names is preflighted from inside the cluster. A bound ssh url
// asks where its deploy key comes from (ADR-0047), and a converge that GENERATED one ends by saying
// so — the key is dead until a human registers it.
//
// The typecheck is FIRST and is a gate (ADR-0050): a Machine names its Agents, its composed
// Machines, and its Repo Slots by string, and since ADR-0049 those strings are typed, so a wrong
// name is a compile error rather than an invoke-time failure mid-run. The walk comes SECOND and is
// the one converge-time refusal the compiler cannot make (ADR-0051): a registered Machine whose
// Repo Slot is still open has nothing bound where the run would need a url, and a `workflows/`
// export has no type to hang that on. Nothing is built, and nothing on the cluster is touched,
// before the compiler has agreed the folder is coherent and every slot is bound. The two are one
// function, `checkInstance` (instance-check.ts), which `jr2 check` runs alone with no cluster, so
// an Assistant that may not run `jr2 up` gets the same refusals from the same code.
//
// Images (ADR-0038, as amended by ADR-0045): `jr2 up` builds every image it deploys, and every tag is
// a content address of (its own inputs × the platform set it was built for) — `<hash>-<arch>`, with
// `--platform` passed explicitly on every build. The cluster's schedulable nodes choose that set
// (`platforms` in the config overrides absolutely), so the daemon default and
// `DOCKER_DEFAULT_PLATFORM` steer nothing any more. In a kit CHECKOUT the built set includes the
// Harness, the operator and the Orchestrator (ADR-0069); installed from npm those sources do not resolve and the published
// `<kitversion>` refs are used with no docker at all (they are multi-arch manifest lists, so they
// take no suffix and never had this hole). There is no `images` config block and no env escape
// hatch — nobody gets to point a real cluster at a hand-picked Harness (ADR-0027's no-eject-hatch,
// enforced rather than stated). An installed Instance with no `workspace()` therefore needs no
// docker at all: it builds nothing, and its Workflows ride the Assembly (ADR-0069).
// The converged name→ref map is stamped on the Orchestrator Deployment and diffed on the next run,
// so a steady-state converge spends directory walks and no docker. When that record is silent (a
// fresh namespace), the host daemon's labeled listing answers the BUILD question instead
// (ADR-0041): a tag is a content address, so a host-held ref skips its build — never its delivery.
//
// Content addressing also MAKES garbage — iterating on a Dockerfile while up leaves one full image
// per iteration — so a converge that fully succeeded ends by sweeping every labeled image no live
// root names (ADR-0039). It runs here, and not only at `jr2 down`, because here is where the garbage
// is made: the moment this converge's map replaces the last one is the moment the old generation
// stops being reachable.
//
// Addressing (ADR-0019): cluster = the current kube context (never recorded); namespace =
// `config.name` (identity). Whether this cluster hosts the instance is derived FROM the cluster:
// labeled objects found → converge silently (it's home); nothing → confirm first-time setup
// (`--yes` for CI); objects labeled as a DIFFERENT instance → refuse.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as sleepMs } from "node:timers/promises";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  custodianBootstrap,
  custodianRef,
  custodianScript,
  CUSTODIAN_PROGRAM,
  defaultImageContext,
  heldSecretsOf,
  HELD_CA_SECRET,
  HELD_TLS_SECRET,
  INSTANCE_CUSTODIAN_CONFIGMAP,
  INSTANCE_HARNESS_HELD_POD,
  ORCHESTRATOR_PORT,
  imageContextDigest,
  isSshUrl,
  loadConfig,
  doorCompat,
  matchCredential,
  packAssembly,
  configMapDigest,
  MOUNTED_CONFIGMAPS,
  partsOf,
  LABEL_EFFECTOR_POD,
  LABEL_GIT_PUSH,
  LABEL_GIT_CLONE,
  gitCloneSecretsOf,
  gitPushPlansOf,
  repoIdentity,
  type GitPushManifest,
  type SandboxEffectorPlan,
  secretPlacementsOf,
  storedValueLength,
  effectorKey,
  targetText,
  harnessTokenDigest,
  formatCpu,
  formatMemory,
  sandboxToken,
  type CarriedEffect,
  type CarriedImage,
  type CarriedRepo,
  type HeldManifest,
  type HeldPodPlan,
  type ImageRefs,
  MODEL_KEYS,
  PROVIDER_KEY_NAME,
  type PlacementWalk,
  type SandboxPlacement,
  workspaceHeldPod,
  type JR2Config,
} from "@jr2/orchestrator/internal";
import { stageAssembly, stagedCopyOf } from "../assembly.ts";
import { caFits, fingerprint, issueCa, issueLeaf, leafFits, trustBundles, type Pem } from "../held-pki.ts";
import {
  assertEmulation,
  buildSandboxImage,
  choosePlatforms,
  detectKitCheckout,
  isMissingHostImage,
  kitImageBuild,
  kitImageRefs,
  normalizeRef,
  pnpmDockerBuild,
  publishedKitRefs,
  sandboxImageTag,
  KIT_IMAGE_HOME,
  type BuildPort,
  type ImageFiles,
  type KitImageName,
  type KitImageRefs,
} from "../build.ts";
import {
  ANNOTATION_IMAGES,
  compareVersions,
  INSTANCE_HARNESS_DRAIN_SECONDS,
  INSTANCE_HARNESS_PODS_SERVICE,
  INSTANCE_HARNESS_PVC,
  INSTANCE_HARNESS_SERVICE,
  instanceHarnessObjects,
  instanceEffectorObjects,
  effectorDigest,
  storedValueDigest,
  type ValueDigest,
  effectorGraceSeconds,
  INSTANCE_EFFECTOR,
  instanceObjects,
  KIT_POD_SIZES,
  KIT_VERSION,
  LABEL_INSTANCE,
  LABEL_VERSION,
  OPERATOR_DEPLOYMENT,
  OPERATOR_NAMESPACE,
  OPERATOR_SELECTOR,
  operatorManifest,
  priorityClassNames,
  priorityClassObjects,
  REPO_CACHE,
  trustObject,
  holdsAny,
  LABEL_HELD_POD,
  type HeldObjects,
  type CustodianFiles,
  type HeldPodObjects,
  checkPodObjects,
  LABEL_PROVIDER_PREFLIGHT,
  checkPodObjectNames,
  PROVIDER_PREFLIGHT,
  CHECK_CONTAINER,
} from "../deploy.ts";
import { syncAgentsMd } from "../agents-md.ts";
import { resolveRoot } from "../instance.ts";
import { resolvePackage } from "../kit-version.ts";
import { effectorImagePaths, effectorImageRefusal, STOCK_HARNESS_IMAGE, type PushForm } from "../effector-image.ts";
import {
  kubeFloorRefusal,
  podResourcesProbe,
  kubectlAdmin,
  kubectlKube,
  rolloutFailure,
  KUBE_FLOOR,
  ORCHESTRATOR_SERVICE,
  type KubeAdmin,
  type KubeObject,
  type PodEnd,
  type RolloutTarget,
} from "../kube.ts";
import { anyNodeHolds, buildNodes, sandboxNodes, type NodeObject } from "../nodes.ts";
import { activity, chooseOrBail, confirmOrBail, promptLine, readSecretInput, type Io } from "../output.ts";
import { kindCluster, sweepImages } from "../sweep.ts";
import { chartFilesIn, checkInstance } from "../instance-check.ts";
import { parseCommand } from "../command-table.ts";

/** How many times one converge rebuilds a host image a sweep took before it uses it (ADR-0039).
 * A bound, because a tag that is gone again after two rebuilds is not a race to wait out: something
 * on the host removes it as fast as it is built, and docker's own error is the honest report. */
const HOST_REBUILDS = 2;

export async function up(args: string[], io: Io): Promise<number> {
  const { values } = parseCommand("up", args);

  const root = resolveRoot(io.cwd);
  // --- the AGENTS.md block (ADR-0072): before anything can refuse, because it describes the Kit the
  // Instance resolves, not the cluster, so a converge that fails still leaves the index current.
  const kit = resolvePackage("@jr2/orchestrator", root);
  if (kit) await syncAgentsMd(io, root, kit.root, kit.version);

  const config = (await loadConfig(root)) ?? {};
  const name = config.name ?? basename(root);
  const namespace = (values.namespace as string | undefined) ?? name;
  const kube = io.kubeAdmin ?? kubectlAdmin;
  const context = (values.context as string | undefined) ?? (await kube.context());
  if (!context) {
    throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then re-run `jr2 up`");
  }
  const ctx = values.context ? { context: values.context as string } : {};

  activity(io, `jr2 up — instance "${name}" → context ${context} / namespace ${namespace}`);

  // --- the Instance check (ADR-0050): the typecheck and the Machine walk, shared with `jr2 check` -
  // A REFUSAL, not a warning, and it comes before the namespace apply as well as before the builds:
  // the names a Machine carries are typed since ADR-0049/0051, so the compiler's answer is the
  // author's editor's answer; the walk then refuses what the compiler cannot see (an Open part, a
  // Chart file, a dispatch, an Effect secret, a Size). `jr2 check` runs the same function, so an
  // Assistant that may not run `jr2 up` gets the answer of this converge.
  const checked = await checkInstance(io, root, config);
  if (!checked) return 1;
  const { workflows, carried, placementWalk, sizes, chartFiles } = checked;
  const { agents, images: contexts } = carried;

  // --- the Assembly (ADR-0069): staged here, published last ---------------------------------------
  // Staged BEFORE any cluster spend, so its refusals cost nothing: a second copy of a Kit package
  // (ADR-0054's silent-empty-Menus failure), a Kit version other than this CLI's (ADR-0056), a tree
  // that names its own staging path (ADR-0038). Packed at once and the scratch tree removed: the
  // archive is what the door receives, and no later layer reads the tree.
  const build = io.build ?? pnpmDockerBuild;
  activity(io, "assembly: staging");
  const staged = await stageAssembly(build, root);
  let assembly: { hash: string; kitVersion: string; workflows: string[]; tar: Buffer };
  // The scaffolded `images/default` is a PATH CONVENTION, not discovery (ADR-0049/0050): exactly
  // one path is checked, and it is keyed `default` rather than by digest, because that reserved
  // key IS the middle leg of the resolution chain a `workspace()` that names no image lands on.
  const fallback = await defaultImageContext(root);
  // Every `file:` context is keyed by the digest of its STAGED copy (ADR-0037, ADR-0069): the
  // bytes the door checks against the image map and a provision resolves, which the Instance
  // folder's own copy need not equal (staging drops `node_modules`, `.git`, `.env`, `.npmrc` at
  // every depth). The build below still reads the folder; only the key comes from here. A context
  // the Assembly does not carry is refused now, before any cluster spend.
  let contextDigests: Map<string, string>;
  // The Chart files the staged Assembly carries (ADR-0070): Workflows the door registers too.
  let stagedCharts: string[] = [];
  try {
    assembly = {
      hash: staged.hash,
      kitVersion: staged.kitVersion,
      workflows: staged.workflows,
      tar: await packAssembly(staged.dir),
    };
    contextDigests = await stagedContextDigests(staged.dir, root, [
      ...(fallback ? [fallback] : []),
      ...contexts.map((image: CarriedImage) => image.dir),
    ]);
    stagedCharts = await chartFilesIn(staged.dir);
  } finally {
    await staged.dispose();
  }
  // The walk above loaded the Instance folder; the door loads the Assembly (ADR-0069). The two must
  // hold the same Workflows, or a Workflow the walk built and placed for is absent at the door, and
  // `jr2 run` names it unknown after a converge that said it succeeded.
  // A Chart file is a Workflow too (ADR-0070), `<wrapper>/<name>`, at `workflows/<wrapper>/<name>.chart.json`.
  const walked = [...workflows.map((w) => w.name), ...chartFiles];
  const inAssembly = [...assembly.workflows, ...stagedCharts];
  const absent = walked.filter((n) => !inAssembly.includes(n));
  const extra = inAssembly.filter((n) => !walked.includes(n));
  const fileOf = (n: string) => (n.includes("/") ? `workflows/${n}.chart.json` : `workflows/${n}.ts`);
  if (absent.length || extra.length) {
    activity(
      io,
      `refusing: the staged Assembly does not hold the Workflows this folder holds (ADR-0069)` +
        (absent.length ? `; absent from the Assembly: ${absent.map(fileOf).join(", ")}` : "") +
        (extra.length ? `; only in the Assembly: ${extra.map(fileOf).join(", ")}` : "") +
        ` — the Assembly holds what the Instance's install keeps; check the \`files:\` list in package.json`,
    );
    return 1;
  }
  activity(
    io,
    `assembly: ${assembly.hash} (kit v${assembly.kitVersion}; ${assembly.workflows.length} workflow(s): ` +
      `${assembly.workflows.join(", ") || "(none)"})`,
  );

  // --- the Kubernetes floor (ADR-0037) ----------------------------------------------------------
  // Every Sandbox mounts jr2's runtime as an `image` volume, and there is no fallback below the
  // version that turns them on — so a cluster under it is refused HERE, naming what it runs and the
  // floor (ADR-0046), rather than converging and leaving every Sandbox Pending on a volume type its
  // kubelet does not know. Before ownership, so first contact never asks to deploy somewhere that
  // cannot host it. Unconditional: the floor is the Instance's, not one Machine's. The container
  // runtime owes image volumes too (containerd ≥ 2.1, CRI-O ≥ 1.31); that is not cheaply visible
  // from here, so an older one fails at the first provision, in the pod's own events.
  let serverVersion: string;
  try {
    serverVersion = await kube.serverVersion(ctx);
  } catch (e) {
    activity(io, `refusing: cannot reach the API server of ${context} (${(e as Error).message}). Nothing was applied.`);
    return 1;
  }
  const belowFloor = kubeFloorRefusal(serverVersion);
  if (belowFloor) {
    activity(io, `refusing: ${context} ${belowFloor}. Nothing was applied.`);
    return 1;
  }
  activity(io, `kubernetes: ${serverVersion} (floor ${KUBE_FLOOR.major}.${KUBE_FLOOR.minor}, ADR-0037)`);

  // --- ownership: the cluster is the record (ADR-0019) -------------------------------------------
  const ns = await kube.getJson({ kind: "namespace", name: namespace, ...ctx });
  const owner = ns?.metadata.labels?.[LABEL_INSTANCE];
  if (ns && owner && owner !== name) {
    activity(io, `refusing: namespace "${namespace}" on ${context} belongs to another instance ("${owner}")`);
    activity(io, `  pick a different namespace (-n) or context (--context)`);
    return 1;
  }
  if (!ns || !owner) {
    const what = ns ? `adopt existing namespace "${namespace}"` : `create namespace "${namespace}"`;
    const ok =
      values.yes === true ||
      (await confirmOrBail(io, `first contact: deploy instance "${name}" to context ${context} (${what})?`));
    if (!ok) {
      activity(io, "aborted — nothing was changed");
      return 1;
    }
  }
  await kube.apply({
    manifest: JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace, labels: { [LABEL_INSTANCE]: name } },
    }),
    ...ctx,
  });

  // --- pod-level resources (ADR-0060): the whole Size is one pod-level ceiling (KEP-2837) ------
  // A server with the PodLevelResources gate off drops `spec.resources` silently, and every
  // Sandbox runs Burstable. A server-side dry-run shows it; it needs the namespace, so it runs here.
  try {
    const admitted = await kube.dryRunCreate({ manifest: JSON.stringify(podResourcesProbe(namespace)), ...ctx });
    if (admitted.spec?.resources === undefined) {
      activity(
        io,
        `refusing: ${context} (Kubernetes ${serverVersion}) drops pod-level resources — the PodLevelResources feature gate is off, and a Workspace's Size cannot hold (ADR-0060). Enable the gate on the API server and kubelets. The namespace was created; nothing else was applied.`,
      );
      return 1;
    }
  } catch (e) {
    activity(io, `warning: could not confirm pod-level resources on ${context}: ${(e as Error).message}`);
  }

  // --- image resolution (ADR-0038): decide every ref BEFORE any layer spends a build -----------
  const registry = config.registry;
  const cluster = kindCluster(context);

  // The CLUSTER chooses what every image is built for (ADR-0045): the schedulable nodes'
  // architectures, intersected with the platforms the kit releases for. The set then rides the tag
  // of every image this converge builds, because the bytes are a function of (inputs × platform) —
  // hashing the inputs alone made one tag name an amd64 image on one host and an arm64 image on
  // another, and delivered the wrong one as an opaque rollout timeout. The read is `kubectl get
  // nodes`, and it THROWS on failure like every other converge claim: guessing a platform is how
  // this failure class started. `platforms` skips DERIVATION, so it skips the read too — the key
  // exists for the cases the nodes cannot answer (a pool scaled to zero, a set to trim), and a
  // converge that was told the answer must not still need permission to ask the question.
  //
  // "Schedulable" is the union of where an ordinary pod lands (the Orchestrator's own placement)
  // and the Instance's Sandbox nodes (ADR-0052): a tainted pool no Sandbox reaches is not a platform
  // this instance owes an image. The same read reports the Sandbox nodes themselves below.
  const nodes = config.platforms === undefined ? await kube.listJson<NodeObject>({ kind: "node", ...ctx }) : [];
  const schedulable = buildNodes(nodes, config.sandbox);
  const {
    platforms,
    skipped,
    source: platformSource,
  } = choosePlatforms({
    nodeArches: schedulable.map((n) => n.status?.nodeInfo?.architecture ?? "").filter(Boolean),
    configured: config.platforms,
  });
  activity(
    io,
    `platforms: ${platforms.join(", ")} ` +
      (platformSource === "config"
        ? "(the `platforms` key — derivation skipped)"
        : `(from ${schedulable.length} schedulable node(s))`),
  );
  for (const arch of skipped) {
    activity(io, `  skipping node arch ${arch} — the kit publishes no Kit image for it, so no pod there could run`);
  }
  // The Sandbox nodes (ADR-0052), when a Machine will need one and the nodes were read: the set
  // the scheduler will use, at this moment. Empty WARNS and the converge goes on — a pool that
  // autoscales from zero, a node cordoned mid-converge, a GPU box joining tomorrow are all the
  // ordinary case, and a refusal would make `jr2 up` a point-in-time check of a moving set. The
  // truth while a run waits is the operator's: a Pending Sandbox carries the scheduler's own
  // words in its Ready condition, and `jr2 status` shows them.
  if (carried.composesSandbox && config.platforms === undefined) {
    const { nodes: candidates, excluded } = sandboxNodes(nodes, config.sandbox);
    if (candidates.length > 0) {
      activity(io, `sandbox nodes: ${candidates.map((n) => n.metadata.name).join(", ")}`);
    } else {
      activity(io, "warning: no Sandbox node right now — a Sandbox stays Pending until one appears:");
      for (const { name, reason } of excluded) activity(io, `  ${name}: ${reason}`);
      activity(
        io,
        "  a Sandbox lands where an ordinary pod lands; to admit a tainted or labeled node, set " +
          "`sandbox: { nodeSelector, tolerations }` in jr2.config.ts (raw pod-spec shapes, ADR-0052).",
      );
    }
    // A Size no Sandbox node could hold today WARNS (ADR-0060, the ADR-0052 stance): the node set
    // moves, and an autoscaler may bring a bigger node for the Pending pod. A node that reports no
    // allocatable is an unknown, never a no. One line per distinct Size, naming its workflows.
    const unheld = new Map<string, string[]>();
    for (const { workflow, size } of sizes) {
      if (candidates.length === 0 || anyNodeHolds(candidates, size) !== false) continue;
      const key = `memory ${formatMemory(size.memory.bytes)}, cpu ${formatCpu(size.cpu.millis)}`;
      unheld.set(key, [...new Set([...(unheld.get(key) ?? []), workflow])]);
    }
    for (const [key, names] of unheld) {
      activity(
        io,
        `warning: no Sandbox node right now has the allocatable for a Size of ${key} ` +
          `(workflow ${names.map((n) => `"${n}"`).join(", ")}) — its Sandbox stays Pending until one does`,
      );
    }
  }
  // A multi-platform build is `docker buildx build --push`: it delivers by pushing, and there is
  // nowhere to push without a registry. By CONSTRUCTION this never fires — a mixed-arch cluster is
  // never kind (kind nodes are containers on one host, one arch), and the non-kind transport branch
  // already requires `registry` — but the code must not assume its own construction silently.
  if (platforms.length > 1 && !registry) {
    throw new Error(
      `this cluster needs a ${platforms.join(" + ")} build, which docker buildx delivers by PUSHING a ` +
        `manifest list (kind load cannot carry one) — set \`registry\` in jr2.config.ts, or name a single ` +
        `platform with \`platforms\``,
    );
  }

  // The CHECKOUT is the signal — no flag, no config key, no env (ADR-0038). `io.kitDir` exists so
  // tests can drive both worlds from a temp dir instead of detecting the repo they run inside.
  const kitRoot = await detectKitCheckout(io.kitDir);
  // Two registries, two questions (ADR-0044): a BUILT kit ref goes wherever this converge delivers
  // (`registry`), while a PUBLISHED one is pulled from the canonical home or from the mirror this
  // cluster was pointed at (`kitRegistry`). So each branch takes the key that answers its own.
  // A BUILT kit ref carries this converge's platform suffix; a PUBLISHED one carries none — the
  // released tags are multi-arch manifest lists, mirrored whole (ADR-0044), so they were never
  // exposed to the hole ADR-0045 closes.
  const refs: KitImageRefs = kitRoot
    ? await kitImageRefs(kitRoot, { platforms, registry })
    : publishedKitRefs(config.kitRegistry);
  activity(
    io,
    kitRoot
      ? `images: kit checkout at ${kitRoot} — building the Harness, operator and Orchestrator from source`
      : `images: installed kit — the published v${KIT_VERSION} Harness, operator and Orchestrator, pulled from ` +
          `${config.kitRegistry ? `${config.kitRegistry} (kitRegistry)` : KIT_IMAGE_HOME}`,
  );
  // The Custodian's image is deployed and never built, in either world (ADR-0038, ADR-0059): the
  // pinned upstream Envoy, re-homed onto `kitRegistry` like a Kit image when one is set.
  const custodianImage = custodianRef(config.kitRegistry);
  activity(io, `custodian image: ${custodianImage} (pinned, deployed — never built)`);

  // Read the Orchestrator Deployment ONCE: it carries the convergence record — the previous
  // name→ref map (an annotation, ADR-0038), the Orchestrator's own Kit ref included (ADR-0069).
  const orch = await kube.getJson({ kind: "deployment", name: ORCHESTRATOR_SERVICE, namespace, ...ctx });
  const previous = previousImages(orch);
  const converged: ConvergedImages = {
    harness: refs.harness,
    custodian: custodianImage,
    orchestrator: refs.orchestrator,
    sandbox: {},
    sandboxUser: {},
  };

  // ONE transport branch for every image (ADR-0038), so Kit images and Sandbox Images cannot
  // drift into two delivery stories.
  const deliver = async (tag: string): Promise<void> => {
    // A multi-platform build already pushed (ADR-0045): `docker buildx build --push` IS the
    // delivery, and pushing again would push a tag the daemon never held. Sound at every call site
    // because the only other way here is the host-held skip, and a manifest list never lands in the
    // daemon to be held.
    if (platforms.length > 1) {
      activity(io, `  pushed by buildx → ${registry}`);
      return;
    }
    if (registry) {
      activity(io, `  push → ${registry}`);
      await build.push(tag);
    } else if (cluster) {
      activity(io, `  kind load → cluster "${cluster}"`);
      await build.kindLoad(tag, cluster);
    } else {
      throw undeliverable(context);
    }
  };
  // Checked BEFORE the first build rather than after it: a converge that cannot deliver anything
  // must not spend minutes of docker discovering that.
  const assertDeliverable = (): void => {
    if (!registry && !cluster) throw undeliverable(context);
  };

  // The host daemon's answer to the BUILD question, for when the cluster's record is silent
  // (ADR-0041): a labeled image whose tag equals the resolved ref IS the build — the tag is a
  // content address of the same inputs, so on the host that built it, present implies current
  // (ADR-0038's seal is what made that true). Read lazily and at most once per converge, so a
  // steady-state converge still spends no docker at all; label-filtered, so a hand-built image
  // wearing the right name is invisible and the build proceeds — what jr2 did not stamp, jr2 does
  // not trust. The disk never answers the DELIVERY question: a disk-skip still delivers (`kind
  // load` skips a node already holding the id; a push is idempotent), and a record hit still
  // skips both.
  // A listing that FAILS reads as "holds nothing": this check may only ever save a build, never
  // add a failure mode — a truly dead daemon fails at the build that follows, with docker's own
  // error naming it (the sweep makes the same read later and degrades to its own warning).
  //
  // A MULTI-platform ref is invisible here by construction (ADR-0045): buildx pushes it straight to
  // the registry, so the daemon never holds it, the tag-equality question has no answer, and the
  // skip simply misses — a record-silent mixed-arch converge rebuilds. The accepted cost;
  // ADR-0041's rejection of registry-truth HEAD checks stands.
  let hostHeldOnce: Promise<Set<string>> | undefined;
  const hostHeld = (): Promise<Set<string>> =>
    (hostHeldOnce ??= build
      .hostImages()
      .then((images) => new Set(images.flatMap((i) => i.tags.map(normalizeRef))))
      .catch(() => new Set<string>()));
  const hostBuilt = async (ref: string): Promise<boolean> =>
    values.force !== true && (await hostHeld()).has(normalizeRef(ref));

  // What this converge counts on finding on the host — its own build, or the host-held skip above —
  // can be gone by the time it is used: another converge's sweep keeps only the roots of ITS context
  // (ADR-0039), and a ref whose map is not written yet is in none of them. The tag is a content
  // address and BuildKit's cache is a store no sweep touches, so a ref found missing at its use is
  // built again (seconds) and the use retried, at most HOST_REBUILDS times. Only a singleton build
  // lives on the daemon: a multi-platform one is in the registry (ADR-0045), where no sweep reaches.
  const builders = new Map<string, () => Promise<void>>();
  const onHost = async <T>(ref: string, use: () => Promise<T>): Promise<T> => {
    for (let rebuilt = 0; ; rebuilt++) {
      try {
        return await use();
      } catch (err) {
        const rebuild = builders.get(ref);
        if (!rebuild || platforms.length > 1 || rebuilt >= HOST_REBUILDS || !isMissingHostImage(err)) throw err;
        activity(io, `  ${ref}: gone from the host daemon (another converge's sweep took it) — rebuilding`);
        await rebuild();
      }
    }
  };

  // The binfmt preflight (ADR-0045), paid at most once and only when a build is really about to be
  // spent: a steady-state converge must still spend no docker at all, and a foreign-arch build must
  // fail BEFORE minutes of docker rather than mid-`RUN` with `exec format error`.
  let emulationOnce: Promise<void> | undefined;
  const ensureEmulation = (): Promise<void> => (emulationOnce ??= assertEmulation(build, platforms));

  /** Build + deliver one kit image, unless the cluster's record already names this exact ref.
   * Installed from npm there is nothing to build: the published tag is the answer. */
  const ensureKitImage = async (which: KitImageName): Promise<string> => {
    const ref = refs[which];
    if (!kitRoot) return ref;
    if (previous?.[which] === ref && values.force !== true) {
      // A claim about the CLUSTER'S RECORD, not the node's disk: a `docker rmi` or a `kind load`
      // that never happened leaves a ref recorded but absent, which surfaces as ImagePullBackOff.
      // `--force` is the way back. The record is never audited against the disk (ADR-0041) — it
      // vouches for the cluster, and the cluster was delivered.
      activity(io, `${which} image: ${ref} (fresh — build skipped; --force to rebuild anyway)`);
      return ref;
    }
    assertDeliverable();
    const buildRef = async (): Promise<void> => {
      await ensureEmulation();
      await build.build(kitImageBuild(kitRoot, which, ref, platforms));
    };
    builders.set(ref, buildRef);
    if (await hostBuilt(ref)) {
      activity(io, `${which} image: ${ref} (host-built — build skipped, delivering; --force to rebuild)`);
      await onHost(ref, () => deliver(ref));
      return ref;
    }
    activity(io, `${which} image: building ${ref}${values.force === true ? " (--force)" : ""}`);
    await buildRef();
    await onHost(ref, () => deliver(ref));
    return ref;
  };

  // --- priority (per-cluster, shared, ADR-0060) --------------------------------------------------
  // The two PriorityClasses, beside the CRDs and before anything that names them: a pod whose class
  // does not exist is refused at admission. Unconditional on `operator.manage` — the Instance's own
  // pods name them too — and skipped per key the Instance's `priorityClasses` names.
  const classes = priorityClassObjects(config.priorityClasses);
  for (const manifest of classes) await kube.apply({ manifest, ...ctx });
  const named = Object.entries(config.priorityClasses ?? {}).filter(([, v]) => v !== undefined);
  if (named.length) {
    activity(io, `priority: the Instance's own — ${named.map(([tier, cls]) => `${tier} "${cls}"`).join(", ")}`);
  }

  // --- operator (per-cluster, shared) ------------------------------------------------------------
  // The operator IMAGE is resolved whenever anything this converge deploys runs it: the operator
  // layer itself, or the data plane's cache agent, which is the same binary (`/manager repo-cache`,
  // ADR-0051) and rides the instance's namespace even when the controller loop is somebody else's.
  const operatorImage =
    config.operator?.manage === false && !carried.composesSandbox ? undefined : await ensureKitImage("operator");
  if (operatorImage !== undefined) converged.operator = operatorImage;
  // Applied after the provider preflight (below): the operator is the cluster's, and a converge
  // whose provider check fails must not have changed it.

  // --- the kit's own runtime images (ADR-0038) ---------------------------------------------------
  // Built here rather than lazily beside its consumers. The Harness is the injection source
  // (ADR-0037): every Sandbox mounts this exact ref as an `image` volume, its `/opt/jr2` read-only
  // at `/opt/jr2` in the Sandbox Image. It is not a hash input for a Sandbox Image — the runtime rides
  // the pod's volume, so a kit edit re-images future pods and re-tags nothing of the user's.
  await ensureKitImage("harness");
  // The Orchestrator is a Kit image too (ADR-0069): the engine and its closure, nothing of this
  // Instance. A Machine edit moves the Assembly, never this ref, so it never rolls the pod.
  await ensureKitImage("orchestrator");

  // --- Sandbox Images (ADR-0037/0049): the contexts the Machines carry, plus `images/default` -----
  // Gated on the data-plane switch (ADR-0012/0031/0051): an instance none of whose Machines
  // composes a Sandbox has no Sandboxes, so it must not pay a docker build for an image it can
  // never use. Said out loud, because a silent skip of a folder you just wrote reads as a bug.
  if (carried.composesSandbox) {
    const built: Array<{ dir: string; name: string; reserved?: "default" }> = [
      ...(fallback ? [{ dir: fallback, name: "default", reserved: "default" as const }] : []),
      ...contexts.map((image: CarriedImage) => ({ dir: image.dir, name: image.name })),
    ];
    if (built.length === 0) {
      activity(io, "sandbox images: none carried (a workspace() names one, or scaffold images/default)");
    }
    for (const image of built) {
      // The digest of the context's staged copy, taken above with the Assembly: every carried
      // context is keyed by it, which is how the Orchestrator finds this ref again from the
      // `file:` URL the Assembly's copy of the module carries — no path table on either side
      // (ADR-0049, ADR-0069). The TAG carries the digest either way, so a Machine that names
      // `images/default` by URL lands on the same tag as the reserved key: two records, one build
      // (the host-held check below spends nothing the second time).
      const digest = contextDigests.get(image.dir)!;
      const key = image.reserved ?? digest;
      const ref = sandboxImageTag(name, image.name, digest, { platforms, registry });
      const buildRef = async (): Promise<void> => {
        // ONE build of the user's own Dockerfile, straight to its content tag — no wrap, no
        // intermediate tag, so two converges of one checkout share no mutable image name and
        // the `@kind` tier's `--parallel` rides on it (ADR-0037).
        await ensureEmulation();
        await buildSandboxImage(build, { dir: image.dir, tag: ref, instance: name, platforms });
      };
      // Known on every path, the record's skip included: the Effector check reads this ref off the
      // host daemon later in this converge, whatever decided its build.
      builders.set(ref, buildRef);
      // A record is only worth skipping on when it is COMPLETE: the ref AND the seat the image
      // declared. A record from a kit that predates `sandboxUser` names the right image and
      // silently drops the fallback fact, which surfaces as a pod that will not start — so it reads
      // as stale here and the image is re-inspected (the host skip below then spends no build).
      const remembered = previous?.sandboxUser?.[key];
      if (previous?.sandbox?.[key] === ref && remembered !== undefined && values.force !== true) {
        // Unlike a Kit image there is no rollout to verify a Sandbox Image against, so a
        // recorded-but-absent ref only shows up as ImagePullBackOff at the next provision —
        // `--force` rebuilds and re-delivers it. The seat is carried forward from the same record:
        // the tag is a content address, so the image the record names declares what it declared.
        activity(io, `sandbox image "${image.name}": ${ref} (fresh — build skipped; --force to rebuild anyway)`);
        converged.sandboxUser[key] = remembered;
      } else {
        assertDeliverable();
        if (await hostBuilt(ref)) {
          // A tag is a content address, so a host-held ref is this Dockerfile already built
          // (ADR-0041). Delivery still happens below — the disk answers the build question only.
          activity(io, `sandbox image "${image.name}": ${ref} (host-built — build skipped; --force to rebuild)`);
        } else {
          activity(io, `sandbox image "${image.name}": building ${ref}`);
          await buildRef();
        }
        // The image's own `USER`, read while the image is certainly on this daemon (it was just
        // built, or the host holds it). Recorded because a provision cannot inspect an image, and
        // it is what decides ADR-0037's uid-1000 fallback and what the kubelet will refuse. This
        // is a fact ABOUT the image, not a judgement of it: the ADR-0037 floor is a Harness-seat
        // obligation and this directory may be destined for the User Container seat instead
        // (ADR-0005), which owes no floor — a distinction only the provision can make (ADR-0031).
        // `platforms` says where to look, not which variant to read (ADR-0045): a singleton build is
        // on this daemon, a multi-platform one is the manifest list buildx just pushed.
        const user = await onHost(ref, () => build.imageUser(ref, platforms));
        converged.sandboxUser[key] = user;
        activity(io, `  ${user ? `USER ${user}` : "no USER declared — the pod's uid-1000 fallback applies"}`);
        await onHost(ref, () => deliver(ref));
      }
      converged.sandbox[key] = ref;
    }
  } else {
    activity(io, "sandbox images: skipped (no registered Machine composes a Sandbox)");
  }

  // --- secrets -----------------------------------------------------------------------------------
  // Idempotence: the token + signing key persist across re-runs (live Sandboxes bear tokens the
  // key signed — ADR-0013), minted only on first converge.
  const secret = await kube.getJson<KubeObject & { data?: Record<string, string> }>({
    kind: "secret",
    name: "jr2-instance",
    namespace,
    ...ctx,
  });
  const keep = (key: string, mint: () => string): string =>
    secret?.data?.[key] ? Buffer.from(secret.data[key], "base64").toString("utf8") : mint();
  const instanceToken = keep("JR2_INSTANCE_TOKEN", () => randomBytes(24).toString("hex"));
  // The publish token (ADR-0069): publishing an Assembly imports code into the process that holds
  // the ServiceAccount, so it costs what deploying an image cost — cluster write access. It lives
  // here beside the Instance token, and the publish below reads it from THIS Secret alone: no env
  // var, flag or `--url` path can supply it, so an ingress-exposed Instance exposes no publish door.
  const publishToken = keep("JR2_PUBLISH_TOKEN", () => randomBytes(24).toString("hex"));
  const signingKey = keep("JR2_SIGNING_KEY", () => randomBytes(32).toString("base64"));
  const secretData: Record<string, string> = {
    JR2_INSTANCE_TOKEN: instanceToken,
    JR2_PUBLISH_TOKEN: publishToken,
    JR2_SIGNING_KEY: signingKey,
    // The Instance Harness Custodian's credential (ADR-0013/0031): a sandbox-style token signed
    // for the placement's name — it may deliver only to Turns hosted THERE (tokens.ts), so the
    // Instance token never enters that pod. Derived from the kept key, so re-runs converge to
    // the same value; live Custodians keep verifying.
    JR2_INSTANCE_HARNESS_TOKEN: sandboxToken(Buffer.from(signingKey, "base64"), INSTANCE_HARNESS_SERVICE),
  };
  // Git tokens (ADR-0051, ADR-0068): each entry's token, from `.env`, goes into that entry's own clone
  // Secret (`jr2-git-<hash>`, Flux's key names), which the cache agent reads — never into this
  // Secret, the Orchestrator's env. The Orchestrator names the Secret on a Repo and holds no git token.
  // Only when a registered Machine composes a Sandbox: nothing else clones.
  const gitClone = carried.composesSandbox ? gitCloneSecretsOf(config.git?.credentials ?? [], (n) => io.env[n]) : [];
  for (const s of gitClone) activity(io, `git.credentials "${s.match}": clone Secret ${s.name}`);

  // The HARNESS containers' env — a separate Secret (ADR-0013): Agent code executes where these
  // land, so the Instance token/signing key above must be unreachable from it. Values declared in
  // config (usually read off process.env/.env) materialize here (ADR-0019). The provider key does
  // NOT: it is a held secret (ADR-0059), and the Agent can read everything in this Secret.
  const harnessEnvData: Record<string, string> = {};
  for (const v of config.harness?.env ?? []) if (v.value !== undefined) harnessEnvData[v.name] = v.value;

  // Preflight referenced-but-unmanaged Secrets: turn the CreateContainerConfigError hang into an
  // immediate, named error (ADR-0019). Sealed/External Secrets ride this seam untouched. The read
  // keeps each one's key NAMES (never a value), which the held-secret rules check for a model key.
  const envFromKeys = new Map<string, string[]>();
  for (const ref of config.harness?.envFrom ?? []) {
    const refName = ref.secretRef?.name ?? ref.configMapRef?.name;
    if (!refName) continue;
    const kind = ref.secretRef ? "secret" : "configmap";
    const found = await kube.getJson<KubeObject & { data?: Record<string, string> }>({
      kind,
      name: refName,
      namespace,
      ...ctx,
    });
    if (!found && kind === "secret") {
      throw new Error(
        `harness.envFrom references Secret "${refName}", which does not exist in namespace "${namespace}" — ` +
          `create it first: kubectl -n ${namespace} create secret generic ${refName} --from-literal=KEY=...`,
      );
    }
    envFromKeys.set(`${kind}/${refName}`, Object.keys(found?.data ?? {}));
  }

  // --- private-CA bundle (ADR-0020): read HERE, host-side — the in-cluster config eval never
  // touches the file (the path may not exist there); consumers get the ConfigMap.
  const caPem = await readCaBundle(root, config);

  // --- secrets (ADR-0059, ADR-0068): resolved HERE, host-side, where `.env` exists --------------
  // R10: a Secret an entry references must exist with its key. Read once per Secret — each key's
  // NAME, the LENGTH of its value, and a keyed digest of it, never the value — for both
  // placements. The length is ADR-0068's: an Effect secret shorter than 8 characters is refused
  // wherever its value is kept (ADR-0068). The digest goes into the template digest of each
  // long-lived pod that reads the value once at start — the Instance Harness's Custodian and the
  // Instance Effector — so a value edited in the user's Secret rolls them at the next `jr2 up`.
  const referenced = new Map<string, Map<string, number> | undefined>();
  const valueDigests = new Map<string, string>();
  for (const entry of config.secrets ?? []) {
    const ref = entry.valueFrom?.secretKeyRef.name;
    if (ref === undefined || referenced.has(ref)) continue;
    const found = await kube.getJson<KubeObject & { data?: Record<string, string> }>({
      kind: "secret",
      name: ref,
      namespace,
      ...ctx,
    });
    referenced.set(
      ref,
      found ? new Map(Object.entries(found.data ?? {}).map(([k, b64]) => [k, storedValueLength(b64)])) : undefined,
    );
    for (const [k, b64] of Object.entries(found?.data ?? {})) {
      valueDigests.set(`${ref}/${k}`, storedValueDigest(Buffer.from(signingKey, "base64"), ref, k, b64));
    }
  }
  const valueDigest = (secret: string, key: string) => valueDigests.get(`${secret}/${key}`);
  const secretKeys = (secret: string) => {
    const keys = referenced.get(secret);
    return keys && [...keys.keys()];
  };
  const valueLength = (secret: string, key: string) => referenced.get(secret)?.get(key);
  // Where each secret goes (ADR-0059, ADR-0068): read off the list and what names it, never
  // declared — each Harness pod gets the Held secrets something in it names, the Instance Effector
  // what its Effects name. The walk's refusals ran above; a `valueFrom` the user's Secrets do not
  // hold is refused here, before the instance objects are applied.
  const placements = secretPlacementsOf(config, placementWalk, { secretKeys, valueLength });
  for (const line of placements.report) activity(io, line);
  for (const warning of placements.warnings) activity(io, `warning: ${warning}`);
  const held = await resolveHeld(io, kube, {
    pods: placements.held,
    claimed: placements.claimed,
    config,
    name,
    namespace,
    ctx,
    envFromKeys,
    secretKeys,
    // Every bound Agent's model, and every model an Open body allows a Chart's own Agents (ADR-0070).
    models: carried.models,
    caBundle: caPem,
  });

  // --- provider preflight (ADR-0019, ADR-0059): through a Custodian, FROM INSIDE the cluster -----
  // BEFORE anything the Instance or the cluster reads is written — the operator, a deploy key, the
  // trust, the held objects, the instance List: each check pod has its own copies of what it reads,
  // from the values on this host. So a check that fails leaves the Instance, its Assembly and the
  // operator as they were. Only the namespace, the PriorityClasses and the delivered images come
  // first, because the check pod needs them.
  const checkPods = checkPodsOf(config, placementWalk, held.objects.pods);
  const custom = config.harness?.provider;
  if (custom && !checkPods.some((p) => p.providers.some((v) => v.id === custom.id))) {
    activity(
      io,
      `provider: ${custom.baseUrl} configured, but no carried Agent names a "${custom.id}/…" model — skipped`,
    );
  }
  await preflightProviders(io, kube, {
    checkPods,
    skip: values["skip-provider-preflight"] === true,
    name,
    namespace,
    ctx,
    harnessImage: refs.harness,
    custodianImage,
    harness: config.harness,
    caBundle: caPem !== undefined,
    values: Object.assign({}, ...held.objects.pods.map((p) => p.values)) as Record<string, string>,
    leaves: held.objects.leaves,
    trust: trustData(caPem, held.bundles),
    harnessEnvData,
    priorityClassName: priorityClassNames(config.priorityClasses).sandbox,
  });

  // --- operator (per-cluster, shared): after the provider preflight ------------------------------
  if (config.operator?.manage === false) {
    activity(
      io,
      "operator: skipped (operator.manage: false — run the controller loop yourself)" +
        (operatorImage !== undefined ? `; its image ${operatorImage} still runs as the cache agent` : ""),
    );
  } else {
    const image = operatorImage!;
    const existing = await kube.getJson({
      kind: "deployment",
      name: OPERATOR_DEPLOYMENT,
      namespace: OPERATOR_NAMESPACE,
      ...ctx,
    });
    const deployed = existing?.metadata.labels?.[LABEL_VERSION];
    if (deployed && compareVersions(deployed, KIT_VERSION) > 0) {
      activity(io, `operator: leaving v${deployed} (newer than this kit's v${KIT_VERSION} — never downgraded)`);
    } else {
      activity(io, `operator: applying v${KIT_VERSION} (${image})${deployed ? ` over v${deployed}` : ""}`);
      await kube.apply({
        manifest: await operatorManifest(image, priorityClassNames(config.priorityClasses).control),
        ...ctx,
      });
      await kube.label({
        kind: "deployment",
        name: OPERATOR_DEPLOYMENT,
        namespace: OPERATOR_NAMESPACE,
        labels: { [LABEL_VERSION]: KIT_VERSION },
        ...ctx,
      });
      await awaitRollout(kube, {
        name: OPERATOR_DEPLOYMENT,
        namespace: OPERATOR_NAMESPACE,
        selector: OPERATOR_SELECTOR,
        ...ctx,
      });
      // Sound for every layer now that EVERY tag is a content address (ADR-0038): a source edit
      // moves the ref, which moves the pod template, which rolls. The old hole — kit dev pinning a
      // static `:local` tag, so a rebuild left the template identical and nothing rolled — closed
      // with the `images` block that created it.
      await verifyRunningImage(io, kube, {
        layer: "operator",
        namespace: OPERATOR_NAMESPACE,
        selector: OPERATOR_SELECTOR,
        image,
        ...ctx,
      });
    }
  }

  // --- git over ssh: where the key comes from (ADR-0019, ADR-0047) -------------------------------
  // Runs BEFORE the apply, because a missing key source is a converge that must not start, and the
  // notice it hands back is owed to the END of the converge — a generated key is dead until a human
  // registers it, and by then this line has scrolled away.
  const gitSsh = await ensureGitSsh(io, kube, config, carried.repos, namespace, ctx, values.yes === true);

  // --- what each Sandbox Effector's image owes its pushes (ADR-0068) ------------------------
  // Before anything is applied: an image that lacks a push form's tools, or the passwd entry ssh
  // needs, is refused here with the fix, not at the first push in a pod.
  await checkEffectorImages(
    (ref, paths) => onHost(ref, () => build.imageFiles(ref, platforms, paths)),
    config,
    placements.sandbox,
    converged,
    contextDigests,
  );

  // --- push credentials (ADR-0051): one Secret per git.credentials entry, never per pod ----
  // After the deploy keys exist (a generated one included), before anything else is applied: a
  // static Binding whose entry cannot push is refused here.
  const gitPush = await resolveGitPush(io, kube, config, placements.sandbox, namespace, ctx);

  // --- dispatch preflight (ADR-0071): each foreign target's door, from the host ------------------
  await preflightDispatch(io, carried.effects);

  // --- apply + rollout ---------------------------------------------------------------------------
  // The trust bundles first, and server-side: every pod that mounts them must find them, and they
  // carry every root certificate — past what client-side apply's annotation can hold.
  const trust = trustObject({ name, namespace, caBundle: caPem, bundles: held.bundles });
  if (trust) await kube.apply({ manifest: trust, serverSide: true, ...ctx });
  const instanceList = instanceObjects({
    name,
    namespace,
    image: refs.orchestrator,
    secretData,
    harnessEnvData,
    harness: config.harness,
    held: held.objects,
    imageRefs: converged,
    repoCache: carried.composesSandbox ? { image: operatorImage!, placement: config.sandbox } : undefined,
    ...(config.priorityClasses ? { priorityClasses: config.priorityClasses } : {}),
    sandboxEffectors: placements.sandbox,
    gitPush,
    gitClone,
  });
  activity(io, `orchestrator: applying (image ${refs.orchestrator})`);
  await kube.apply({ manifest: instanceList, warn: (line) => activity(io, line), ...ctx });
  // An entry whose clone Secret this converge did not write loses it: a dropped entry, a token
  // unset, or nothing left that clones.
  const cloneSecrets = new Set(gitClone.map((s) => s.name));
  for (const secret of await kube.listJson<KubeObject>({
    kind: "secret",
    selector: LABEL_GIT_CLONE,
    namespace,
    ...ctx,
  })) {
    if (cloneSecrets.has(secret.metadata.name)) continue;
    await kube.deleteObject({ kind: "secret", name: secret.metadata.name, namespace, ...ctx });
  }
  // An entry whose push Secret this converge did not write loses it: a dropped entry, a token
  // unset, or no push left anywhere.
  const pushSecrets = new Set(gitPush.secrets.map((s) => s.name));
  for (const secret of await kube.listJson<KubeObject>({
    kind: "secret",
    selector: LABEL_GIT_PUSH,
    namespace,
    ...ctx,
  })) {
    if (pushSecrets.has(secret.metadata.name)) continue;
    await kube.deleteObject({ kind: "secret", name: secret.metadata.name, namespace, ...ctx });
  }
  // A Workspace whose body no longer places an Effect in its Sandbox Effector loses its Secret;
  // its manifest went with the ConfigMap's data above, so the next provision adds no container.
  const effectorPods = new Set(placements.sandbox.map((p) => p.pod));
  for (const secret of await kube.listJson<KubeObject>({
    kind: "secret",
    selector: LABEL_EFFECTOR_POD,
    namespace,
    ...ctx,
  })) {
    if (effectorPods.has(secret.metadata.labels?.[LABEL_EFFECTOR_POD] ?? "")) continue;
    await kube.deleteObject({ kind: "secret", name: secret.metadata.name, namespace, ...ctx });
  }
  // A pod's literal values go when it holds none any more, or when the pod is gone; with no secret
  // held anywhere, the leaves go too. The CA stays (`jr2-held-ca`), so a later converge that holds
  // one again issues leaves under the same CA.
  const literalPods = new Set(held.objects.pods.filter((p) => Object.keys(p.values).length).map((p) => p.pod));
  const stale = await kube.listJson<KubeObject>({ kind: "secret", selector: LABEL_HELD_POD, namespace, ...ctx });
  for (const secret of stale) {
    if (literalPods.has(secret.metadata.labels?.[LABEL_HELD_POD] ?? "")) continue;
    await kube.deleteObject({ kind: "secret", name: secret.metadata.name, namespace, ...ctx });
  }
  if (!holdsAny(held.objects)) {
    await kube.deleteObject({ kind: "secret", name: HELD_TLS_SECRET, namespace, ...ctx });
  }

  activity(io, "orchestrator: waiting for rollout");
  await awaitRollout(kube, {
    name: ORCHESTRATOR_SERVICE,
    namespace,
    selector: `app=${ORCHESTRATOR_SERVICE}`,
    ...ctx,
  });
  await verifyRunningImage(io, kube, {
    layer: "orchestrator",
    namespace,
    selector: `app=${ORCHESTRATOR_SERVICE}`,
    image: refs.orchestrator,
    ...ctx,
  });

  // --- the cache agent (ADR-0051): the data plane's node half, converged with the same switch ---
  // Applied in the List above whenever a registered Machine composes a Sandbox; waited on and
  // verified here like every other layer, because a DaemonSet that never scheduled (a Pod Security
  // admission that forbids its root seat, an image the nodes cannot pull) is a data plane every
  // provision will park on. No Machine composing a Sandbox → nothing to cache, and a DaemonSet left
  // over from a Machine that dropped its `workspace()` is deleted with its RBAC: the layer
  // converges toward the Machines like the Instance Harness does.
  if (carried.composesSandbox) {
    activity(io, "repo cache: waiting for the cache agent on every Sandbox node");
    await awaitRollout(kube, {
      kind: "daemonset",
      name: REPO_CACHE,
      namespace,
      selector: `app=${REPO_CACHE}`,
      ...ctx,
    });
    await verifyRunningImage(io, kube, {
      layer: "repo cache",
      namespace,
      selector: `app=${REPO_CACHE}`,
      image: operatorImage!,
      container: "agent",
      ...ctx,
    });
  } else {
    // The Repo resources are NOT deleted here: eviction is reachability plus age (ADR-0051), and
    // the Assembly this converge publishes binds nothing, so the Orchestrator's Repo pass at that
    // publish unlabels every one of them (server.ts, ADR-0069) and `jr2 gc` takes them at the TTL. The bare clones under
    // `/var/lib/jr2/<ns>/repos` outlive the agent that would evict them — inert, like the ones
    // `jr2 down` leaves (down.ts), and swept by the agent's own walk if a `workspace()` ever
    // returns here.
    for (const kind of ["daemonset", "rolebinding", "role", "serviceaccount"]) {
      await kube.deleteObject({ kind, name: REPO_CACHE, namespace, ...ctx });
    }
  }

  // --- Instance Harness (ADR-0031): converged by convention, never by config ---------------------
  // The scan is the Machine walk above, and it is DEFINITION-level (the line ADR-0018 drew:
  // workflow internals are not statically recoverable) — a carried-but-never-invoked `"none"`
  // Agent over-deploys, erring toward "the convention works when you need it". No `"none"`
  // definitions → nothing, and a stale StatefulSet from a definition that dropped its `"none"` is
  // deleted with its conversations: the layer converges toward the Machines like every other layer
  // converges toward the config.
  const menuOnly = [...new Set(agents.filter((a) => a.definition.workspace === "none").map((a) => a.name))];
  // A Chart wrapper whose Open body allows "none" needs it too: a Chart's own Agent may be Menu-only (ADR-0070).
  const noneWrappers = workflows
    .filter((w) => partsOf([w.machine]).openBodies.some((b) => b.declaration.allows.workspace.includes("none")))
    .map((w) => w.name);
  if (carried.instanceHarness !== undefined) {
    const why = [
      ...(menuOnly.length
        ? [`${menuOnly.join(", ")} declare${menuOnly.length === 1 ? "s" : ""} workspace: "none"`]
        : []),
      ...(noneWrappers.length
        ? [
            `chart wrapper${noneWrappers.length === 1 ? "" : "s"} ${noneWrappers.map((n) => `"${n}"`).join(", ")} allow${noneWrappers.length === 1 ? "s" : ""} workspace: "none"`,
          ]
        : []),
    ];
    activity(io, `instance harness: converging (${why.join("; ")})`);
    const harnessImage = refs.harness;
    const instance = instanceHeld(held.objects);
    await kube.apply({
      manifest: instanceHarnessObjects({
        name,
        namespace,
        harnessImage,
        custodianImage,
        held: instance.manifest,
        custodian: instance.custodian,
        heldDigest: heldDigest(Buffer.from(signingKey, "base64"), held.objects, instance, valueDigest),
        harness: config.harness,
        caBundle: caPem !== undefined,
        // The wire's gate (ADR-0058): the digest of the bearer the Orchestrator derives for this
        // placement from the kept key — the same shape it stamps onto every Sandbox at provision.
        bearerSha256: harnessTokenDigest(Buffer.from(signingKey, "base64"), INSTANCE_HARNESS_SERVICE),
        ...(config.priorityClasses ? { priorityClasses: config.priorityClasses } : {}),
      }),
      ...ctx,
    });
    await awaitRollout(kube, {
      kind: "statefulset",
      name: INSTANCE_HARNESS_SERVICE,
      namespace,
      selector: `app=${INSTANCE_HARNESS_SERVICE}`,
      // A rollout waits out the old pod's drain (ADR-0031): up to a Turn's worst case, then the
      // new pod's start.
      timeoutSeconds: INSTANCE_HARNESS_DRAIN_SECONDS + 180,
      ...ctx,
    });
    await verifyRunningImage(io, kube, {
      layer: "instance harness",
      namespace,
      selector: `app=${INSTANCE_HARNESS_SERVICE}`,
      image: harnessImage,
      container: "harness",
      ...ctx,
    });
  } else {
    await kube.deleteObject({ kind: "statefulset", name: INSTANCE_HARNESS_SERVICE, namespace, ...ctx });
    // The claim's retention policy deletes it with the StatefulSet; deleted here too, so the
    // conversations go even from a StatefulSet the controller never got to.
    await kube.deleteObject({ kind: "persistentvolumeclaim", name: INSTANCE_HARNESS_PVC, namespace, ...ctx });
    await kube.deleteObject({ kind: "service", name: INSTANCE_HARNESS_SERVICE, namespace, ...ctx });
    await kube.deleteObject({ kind: "service", name: INSTANCE_HARNESS_PODS_SERVICE, namespace, ...ctx });
    // Its Custodian's files go with the pod they were rendered for (ADR-0059).
    await kube.deleteObject({ kind: "configmap", name: INSTANCE_CUSTODIAN_CONFIGMAP, namespace, ...ctx });
  }

  // --- Instance Effector (ADR-0068): converged when an Effect is placed there, absent otherwise ---
  // The placement is read off the Machines: an `http` Effect runs there. Its objects carry only the
  // secrets those Effects name, and the placement's key, derived from the kept signing key — the
  // key the Orchestrator derives again to sign every call and verify every answer.
  const effectorPlan = placements.instance;
  if (effectorPlan) {
    const names = effectorPlan.secrets.map((s) => `\`${s.name}\``).join(", ") || "none";
    activity(
      io,
      `instance effector: converging (${effectorPlan.effects.join(", ")}; secrets ${names}; grace ` +
        `${effectorGraceSeconds(effectorPlan)}s)`,
    );
    const signing = Buffer.from(signingKey, "base64");
    const key = effectorKey(signing, "instance");
    await kube.apply({
      manifest: instanceEffectorObjects({
        name,
        namespace,
        harnessImage: refs.harness,
        plan: effectorPlan,
        key,
        digest: effectorDigest(signing, effectorPlan, key, valueDigest),
        caBundle: caPem !== undefined,
        ...(config.priorityClasses ? { priorityClasses: config.priorityClasses } : {}),
      }),
      warn: (line) => activity(io, line),
      ...ctx,
    });
    await awaitRollout(kube, {
      name: INSTANCE_EFFECTOR,
      namespace,
      selector: `app=${INSTANCE_EFFECTOR}`,
      // A rollout waits out the old replica's drain: the longest Effect, and its read.
      timeoutSeconds: effectorGraceSeconds(effectorPlan) + 180,
      ...ctx,
    });
    await verifyRunningImage(io, kube, {
      layer: "instance effector",
      namespace,
      selector: `app=${INSTANCE_EFFECTOR}`,
      image: refs.harness,
      container: "effector",
      ...ctx,
    });
  } else {
    activity(io, "instance effector: none (no Effect is placed there)");
    for (const kind of ["deployment", "service", "networkpolicy", "secret"]) {
      await kube.deleteObject({ kind, name: INSTANCE_EFFECTOR, namespace, ...ctx });
    }
  }

  // --- the Assembly (ADR-0069): published last of the layers, before the sweep -------------------
  // After every layer, because the door's checks are true only once the cluster work is done: the
  // image map names every `file:` digest, the Secrets exist, and the rollout above put the Kit
  // version the Assembly names in front of the door. A refusal leaves the previous Assembly
  // current, and the converge fails before the sweep, so nothing it still needs is collected.
  const published = await publishAssembly(io, {
    namespace,
    ctx,
    assembly,
    token: publishToken,
    force: values.force === true,
    mounts: mountedDigests(instanceList),
  });
  if (!published) return 1;

  await reportOlderWorkspaces(io, kube, namespace, ctx, converged);
  await sweepAfterConverge(io, { build, kube, context, ctx, converged, previous });
  noteDeferred(io, carried.repos);
  activity(io, `converged — \`jr2 run <workflow>\` when ready`);
  // LAST, after the success line (ADR-0047): the converge succeeded and the Repos still cannot be
  // fetched, so the one thing left to do belongs at the bottom of the scroll, not in the middle.
  for (const notice of gitSsh) reportGeneratedKey(io, notice);
  return 0;
}

/**
 * Every image ref one converge resolved. The Orchestrator reads `harness`/`custodian`/`sandbox` from
 * the mounted map (`ImageRefs`); `operator` and `orchestrator` ride the same JSON because the record `jr2 up` diffs
 * must cover every image it builds, and one map is what keeps the record it diffs and the map pods
 * read from ever disagreeing (ADR-0038).
 *
 * `sandboxUser` is the same map's answer to a question a provision cannot ask: an image that
 * declares no `USER` runs as uid 1000 with `HOME=/home/jr2` on an emptyDir (ADR-0037), and only the
 * host that BUILT the image can see which case it is (`docker inspect` at converge is free; the
 * cluster has no such reach). So the fact travels with the ref, in the same JSON, under the same key:
 * `""` means "declares none — apply the fallback", a non-empty value is the declared user, and an
 * ABSENT key means unknown, which is the only honest reading for an image jr2 did not build. A
 * registry ref is exactly that absent case by construction — it is never built,
 * never inspected, never in this map — so it runs as whatever its own `USER` says, and one that
 * would run as root fails the Harness container's `runAsNonRoot` at provision.
 */
type ConvergedImages = ImageRefs & { operator?: string; orchestrator?: string; sandboxUser: Record<string, string> };

/** The map the LAST converge recorded, off the Orchestrator Deployment's annotation. Anything
 * unreadable (absent, hand-edited, a foreign shape) reads as "no record", which costs a rebuild —
 * the safe direction, since the alternative is skipping a build the cluster needs. */
function previousImages(orch?: KubeObject): Partial<ConvergedImages> | undefined {
  const raw = orch?.metadata.annotations?.[ANNOTATION_IMAGES];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ConvergedImages>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every ref one image map names, flattened — the kit's own plus each Sandbox Image. */
function mapRefs(map: Partial<ConvergedImages>): string[] {
  return [map.harness, map.custodian, map.operator, map.orchestrator, ...Object.values(map.sandbox ?? {})].filter(
    (ref): ref is string => typeof ref === "string",
  );
}

/** What `GET /assembly` answers (ADR-0069), read loosely: this is the CLI's view of the door.
 * `mounts` is the digest of each ConfigMap the process reads through a mount. */
type AssemblyView = { current?: { hash?: string; kitVersion?: string } | null; mounts?: Record<string, string> };

/** The digest of each mounted ConfigMap's data in the List this converge applied (ADR-0069), by
 * name: what the Orchestrator must read from its mounts before the publish. */
function mountedDigests(list: string): Record<string, string> {
  const items = (JSON.parse(list) as { items: Array<KubeObject & { data?: Record<string, string> }> }).items;
  const out: Record<string, string> = {};
  for (const item of items) {
    if (item.kind === "ConfigMap" && item.metadata.name in MOUNTED_CONFIGMAPS) {
      out[item.metadata.name] = configMapDigest(item.data ?? {});
    }
  }
  return out;
}

/**
 * The key of each `file:` Sandbox Image context (ADR-0037, ADR-0049, ADR-0069): the digest of its
 * copy in the staged Assembly at `stagedDir`, by the host directory the walk named. A context the
 * Assembly does not carry is refused by name: a `file:` URL that names no folder, or a folder the
 * Instance's install leaves out, is checkable HERE and nowhere later, since the pod only ever
 * resolves a digest.
 */
async function stagedContextDigests(stagedDir: string, root: string, dirs: string[]): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const dir of new Set(dirs)) {
    const copy = await stagedCopyOf(stagedDir, root, dir);
    const shown = relative(root, dir).startsWith("..") ? dir : relative(root, dir);
    if (copy === undefined) {
      throw new Error(
        `the Sandbox Image context ${shown} is not in the staged Assembly — a \`workspace()\` names its image with ` +
          '`import.meta.resolve("./<dir>")`, so that directory must exist beside the Machine\'s own module and ' +
          "travel with it: check that it exists, and that the package's `files:` list keeps it (ADR-0037/0049, ADR-0069)",
      );
    }
    digests.set(dir, await imageContextDigest(copy));
  }
  return digests;
}

/** What `PUT /assembly` answers, read loosely: the 200 body, or a refusal with its report. */
type PublishBody = {
  hash?: string;
  workflows?: string[];
  unchanged?: boolean;
  error?: string;
  report?: string[];
  kitVersion?: unknown;
};

/**
 * How long a publish waits for the Orchestrator to read the ConfigMaps this converge wrote
 * (ADR-0038, ADR-0069). `jr2-images` and `jr2-held` are mounts, and the kubelet refreshes a mount
 * on its own period (about a minute by default). A publish rolls no pod, so until the refresh the
 * door's checks and the next provision read the previous data. The publish waits until the digests
 * `GET /assembly` reports are the ones this converge applied. Exported so a test can shorten it.
 */
export const MAP_PROPAGATION = { budgetMs: 150_000, stepMs: 5_000 };

/**
 * Publish the staged Assembly to the running Orchestrator (ADR-0069), over a port-forward of its
 * Service, as `resolveTarget` reaches it. `GET /assembly` first: when the current Assembly is this
 * one, at this Kit version, nothing is sent, so a steady-state converge publishes nothing. Then
 * `PUT /assembly` with the publish token from the Instance Secret — never from the environment.
 * Before the PUT, it waits until the Orchestrator reads the mounted ConfigMaps this converge wrote.
 * `--force` sends the PUT even when the hashes agree; the door answers `unchanged` and replaces
 * nothing, because the hash names the bytes it already holds.
 *
 * Returns false after it has said why, when the door refused: the previous Assembly is still
 * current, and the converge fails.
 */
async function publishAssembly(
  io: Io,
  opts: {
    namespace: string;
    ctx: { context?: string };
    assembly: { hash: string; kitVersion: string; workflows: string[]; tar: Buffer };
    token: string;
    force: boolean;
    /** The digest of each mounted ConfigMap this converge applied, by name. */
    mounts: Record<string, string>;
  },
): Promise<boolean> {
  const { namespace, ctx, assembly, token, force } = opts;
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const fwd = await (io.kube ?? kubectlKube).portForward({
    namespace,
    service: ORCHESTRATOR_SERVICE,
    port: ORCHESTRATOR_PORT,
    ...ctx,
  });
  try {
    const base = fwd.url.replace(/\/+$/, "");
    const view = async (): Promise<AssemblyView> => {
      const seen = await fetchImpl(`${base}/assembly`);
      if (!seen.ok) throw new Error(`the Orchestrator answered GET /assembly with HTTP ${seen.status}`);
      return (await seen.json()) as AssemblyView;
    };
    let seen = await view();
    const current = seen.current ?? null;
    if (!force && current?.hash === assembly.hash && current.kitVersion === assembly.kitVersion) {
      activity(io, `assembly: ${assembly.hash} (current — publish skipped)`);
      return true;
    }
    // The mounts first (ADR-0069): the door checks a `file:` digest against `jr2-images`, and a
    // provision after the converge reads `jr2-held`. A process that reports no mounts is not
    // deployed, and has nothing to wait for.
    const stale = (v: AssemblyView): string[] =>
      v.mounts ? Object.keys(opts.mounts).filter((name) => v.mounts![name] !== opts.mounts[name]) : [];
    const deadline = Date.now() + MAP_PROPAGATION.budgetMs;
    let said = false;
    for (let names = stale(seen); names.length; names = stale(seen)) {
      if (Date.now() >= deadline) {
        activity(
          io,
          `refusing: after ${Math.round(MAP_PROPAGATION.budgetMs / 1000)}s the Orchestrator still reads an older ` +
            `${names.join(", ")} from its mount — the kubelet has not refreshed it; nothing was published, and ` +
            `the previous Assembly is still current. Run \`jr2 up\` again`,
        );
        return false;
      }
      if (!said) activity(io, `assembly: waiting for the kubelet to deliver ${names.join(", ")} to the Orchestrator`);
      said = true;
      await new Promise((ok) => setTimeout(ok, MAP_PROPAGATION.stepMs));
      seen = await view();
    }
    activity(
      io,
      `assembly: publishing ${assembly.hash} (${current?.hash ? `current is ${current.hash}` : "no current Assembly"})` +
        (force ? " (--force)" : ""),
    );
    const res = await fetchImpl(`${base}/assembly`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-tar",
        "jr2-kit-version": assembly.kitVersion,
        "jr2-assembly-hash": assembly.hash,
      },
      body: new Uint8Array(assembly.tar),
    });
    const body = (await res.json().catch(() => ({}))) as PublishBody;
    if (res.ok) {
      const names = body.workflows ?? assembly.workflows;
      activity(
        io,
        `assembly: ${body.hash ?? assembly.hash} is current${body.unchanged ? " (unchanged)" : ""} — ` +
          `workflows: ${names.join(", ") || "(none)"}`,
      );
      return true;
    }
    const report = body.report ?? [];
    activity(
      io,
      `refusing: the Orchestrator refused Assembly ${assembly.hash} (HTTP ${res.status}): ` +
        `${body.error ?? "no reason given"}` +
        (res.status >= 500 ? "" : " — the previous Assembly is still current"),
    );
    for (const line of report) activity(io, `  ${line}`);
    return false;
  } finally {
    fwd.close();
  }
}

/**
 * Collect (ADR-0039) — and only here, at the end of a converge that fully succeeded: the annotation
 * is applied and every rollout is verified, which is the moment the root set moved, and moving the
 * root set is precisely what makes the previous generation garbage. A converge that threw never
 * reaches this line, so a failed run sweeps nothing.
 *
 * The keep set gets two additions on top of the cluster's own roots. `extraKeep` is what THIS
 * converge resolved — recorded in the map and running in the pods this function's callers just
 * verified, but named explicitly so a read that raced the apply cannot make a fresh image look
 * unreachable. `grace` is the map this converge REPLACED, and it is node-only: the `jr2-images`
 * ConfigMap reaches a Sandbox through a kubelet propagation window, so for one more round a
 * provision can still ask a node for a ref the new map no longer names. The host has no such
 * window — nothing is ever provisioned from it — so it is swept aggressively.
 *
 * A failure here is a WARNING. The instance is converged, which is what `up` promised; disk is not
 * that promise, and the next `jr2 up` or `jr2 gc` collects whatever this run could not.
 */
async function sweepAfterConverge(
  io: Io,
  opts: {
    build: BuildPort;
    kube: KubeAdmin;
    context: string;
    ctx: { context?: string };
    converged: ConvergedImages;
    previous?: Partial<ConvergedImages>;
  },
): Promise<void> {
  const { build, kube, context, ctx, converged, previous } = opts;
  try {
    await sweepImages({
      io,
      build,
      kube,
      context,
      ctx,
      // The map carries every ref this converge resolved, the Orchestrator's own Kit ref included
      // (ADR-0069), so it is the whole of what this converge adds to the keep set.
      extraKeep: mapRefs(converged),
      grace: previous ? mapRefs(previous) : [],
    });
  } catch (err) {
    activity(io, `images: sweep skipped (${err instanceof Error ? err.message : err}) — the converge stands`);
  }
}

/**
 * Held secrets, resolved (ADR-0059): the rules (`heldSecretsOf`, over the names some pod claims, fed
 * what only the cluster knows), each pod's own manifest, values and Custodian config, the
 * per-Instance CA (kept, or minted on first need), one leaf per bound target (reused while it still
 * fits), and the trust bundles. Narrated one line per secret — its name, its hosts, its source — and
 * never a value.
 */
async function resolveHeld(
  io: Io,
  kube: KubeAdmin,
  opts: {
    /** Each Harness pod and the names it holds (`secretPlacementsOf`). */
    pods: readonly HeldPodPlan[];
    claimed: ReadonlySet<string>;
    config: JR2Config;
    name: string;
    namespace: string;
    ctx: { context?: string };
    envFromKeys: Map<string, string[]>;
    /** R10's read of the user's Secrets: key NAMES, never values. */
    secretKeys: (secret: string) => readonly string[] | undefined;
    models: string[];
    /** The user's `caBundle` (ADR-0020): trusted upstream, and by the Harness beside the jr2 CA. */
    caBundle?: string;
  },
): Promise<{ objects: HeldObjects; bundles?: { extra: string; bundle: string; upstream: string } }> {
  const { config, namespace, ctx } = opts;
  type Data = KubeObject & { data?: Record<string, string> };
  const decode = (data: Record<string, string> | undefined, key: string): string | undefined =>
    data?.[key] === undefined ? undefined : Buffer.from(data[key], "base64").toString("utf8");

  const { manifest, values, warnings } = heldSecretsOf(config, opts.claimed, {
    envFromKeys: opts.envFromKeys,
    secretKeys: opts.secretKeys,
    models: opts.models,
  });
  for (const warning of warnings) activity(io, `warning: ${warning}`);
  // Each pod's own: the bindings of the names it holds and their literal values. Its Custodian's
  // files are rendered by whoever makes the pod — here for the Instance Harness alone; the
  // Orchestrator at provision for a Sandbox, from the same manifest (ADR-0059).
  const pods: HeldPodObjects[] = opts.pods.map((plan) => {
    const own: HeldManifest = { version: 1, secrets: manifest.secrets.filter((b) => plan.names.includes(b.name)) };
    const literals = Object.fromEntries(
      own.secrets.filter((b) => b.source.kind === "literal").map((b) => [b.name, values[b.name] as string]),
    );
    return { pod: plan.pod, manifest: own, values: literals };
  });
  // The Instance Harness, when the walk placed one: the one pod `jr2 up` makes, so the one whose
  // Custodian files it renders.
  const instancePod = pods.find((p) => p.pod === INSTANCE_HARNESS_HELD_POD);
  const orchestrator = { host: `${ORCHESTRATOR_SERVICE}.${namespace}.svc`, port: ORCHESTRATOR_PORT };
  const instance: CustodianFiles | undefined = instancePod && {
    bootstrap: JSON.stringify(custodianBootstrap(instancePod.manifest, orchestrator)),
    script: custodianScript(instancePod.manifest),
  };
  if (manifest.secrets.length === 0) return { objects: { pods, ...(instance && { instance }), leaves: {} } };
  for (const s of manifest.secrets) {
    const where = s.hosts.map((h) => (h.port === 443 ? h.host : `${h.host}:${h.port}`)).join(", ");
    const source = s.source.kind === "literal" ? "literal" : `secret ${s.source.secret}/${s.source.key}`;
    activity(io, `held secret ${s.name} → ${where} (${source})`);
  }

  // The CA: kept whenever the cluster holds a usable one — a live pod's Harness trusts it from its
  // start, so a leaf a restarted Custodian reads must still chain to it. A human rotates it by
  // deleting the Secret.
  const stored = await kube.getJson<Data>({ kind: "secret", name: HELD_CA_SECRET, namespace, ...ctx });
  const kept = { cert: decode(stored?.data, "ca.crt") ?? "", key: decode(stored?.data, "ca.key") ?? "" };
  const ca: Pem = stored && caFits(kept) ? kept : issueCa(opts.name);
  if (ca !== kept) activity(io, `held secrets: minted the Instance's CA into ${HELD_CA_SECRET}`);

  const tls = await kube.getJson<Data>({ kind: "secret", name: HELD_TLS_SECRET, namespace, ...ctx });
  const leaves: Record<string, Pem> = {};
  for (const s of manifest.secrets) {
    for (const h of s.hosts) {
      if (leaves[h.leaf]) continue;
      const existing = {
        cert: decode(tls?.data, `${h.leaf}.crt`) ?? "",
        key: decode(tls?.data, `${h.leaf}.key`) ?? "",
      };
      leaves[h.leaf] = leafFits(existing, ca, h.host) ? existing : issueLeaf(ca, h.host);
    }
  }
  return {
    objects: { pods, ...(instance && { instance }), ca, leaves },
    bundles: trustBundles(ca.cert, opts.caBundle),
  };
}

/** The Instance Harness's held objects and its Custodian's files — the walk always places it when
 * it converges. */
function instanceHeld(held: HeldObjects): HeldPodObjects & { custodian: CustodianFiles } {
  const pod = held.pods.find((p) => p.pod === INSTANCE_HARNESS_HELD_POD);
  if (!pod || !held.instance)
    throw new Error("jr2 up placed no held secrets for the Instance Harness it converges — a jr2 defect");
  return { ...pod, custodian: held.instance };
}

/** The Instance Harness's `jr2.dev/held-digest` (ADR-0059): an HMAC over its pod's held-secret
 * inputs — a literal's value, a `valueFrom`'s reference and the digest of its value — keyed with
 * the signing key so the annotation reveals nothing about a value. Its Custodian reads each value
 * once at start, so a value edited in the user's Secret must roll it — and so must an edit to its
 * two rendered files or the program they load. `program` is the kit's program; it is an input
 * only so that its test can change it. Exported for its test alone. */
export function heldDigest(
  key: Buffer,
  all: HeldObjects,
  held: HeldPodObjects & { custodian: CustodianFiles },
  valueDigest: ValueDigest,
  program: string = CUSTODIAN_PROGRAM,
): string {
  const mac = createHmac("sha256", key);
  mac.update(JSON.stringify(held.manifest));
  const stems = new Set(held.manifest.secrets.flatMap((s) => s.hosts.map((h) => h.leaf)));
  for (const stem of [...stems].sort()) mac.update(`${stem}:${fingerprint(all.leaves[stem]!.cert)}`);
  for (const name of Object.keys(held.values).sort()) mac.update(`${name}=${held.values[name]}`);
  for (const s of held.manifest.secrets) {
    if (s.source.kind === "secret") mac.update(`${s.name}<-${valueDigest(s.source.secret, s.source.key) ?? ""}`);
  }
  // Its Custodian's files, and the program they load: Envoy reads all three once at start.
  mac.update(held.custodian.bootstrap);
  mac.update(held.custodian.script);
  mac.update(program);
  return mac.digest("base64url").slice(0, 32);
}

/** The one delivery failure that is a configuration error rather than a docker one (ADR-0019). */
function undeliverable(context: string): Error {
  return new Error(
    `context ${context} is not a kind cluster and no \`registry\` is configured — ` +
      `set \`registry\` in jr2.config.ts (from env) so the image can be pushed (ADR-0019)`,
  );
}

/**
 * Report live workspaces still on an image this converge did not resolve — and NEVER re-image one
 * (ADR-0038). Provision is create-if-absent, so a running Sandbox keeps the image its CR was
 * created with; replacing the pod would take the worktrees and unpushed commits with it, which is
 * precisely the Continuity break ADR-0021 exists to report rather than cause. Informational, so a
 * failed look (no CRD installed, no RBAC) degrades to a warning: this must never fail a converge
 * that already succeeded.
 */
async function reportOlderWorkspaces(
  io: Io,
  kube: KubeAdmin,
  namespace: string,
  ctx: { context?: string },
  converged: ConvergedImages,
): Promise<void> {
  const current = new Set([converged.harness, ...Object.values(converged.sandbox)]);
  try {
    const sandboxes = await kube.listJson<{ metadata: { name: string }; spec?: { image?: string } }>({
      kind: "sandboxes.core.jr2.dev",
      namespace,
      ...ctx,
    });
    const older = sandboxes.filter((s) => s.spec?.image && !current.has(s.spec.image));
    if (older.length === 0) return;
    const byImage = new Map<string, number>();
    for (const s of older) byImage.set(s.spec!.image!, (byImage.get(s.spec!.image!) ?? 0) + 1);
    for (const [image, count] of byImage) {
      activity(io, `${count} running workspace(s) keep \`${image}\` — delete those runs to re-image them`);
    }
    activity(io, `  new workspaces use the refs this converge resolved`);
  } catch (err) {
    activity(io, `workspaces: could not be listed (${err instanceof Error ? err.message : err}) — not re-imaged`);
  }
}

/**
 * One rollout wait, with the pods' own words in front of kubectl's verdict when it fails
 * (ADR-0046). Every layer waits through here, because every layer was equally blind: `kubectl
 * rollout status` reports `timed out waiting for the condition` and drops the line that says why,
 * so the user went and read the pods by hand — the step this deletes.
 *
 * A WRAPPER rather than a fatter `waitRollout`, so the port keeps saying one thing (wait for this
 * workload) and the diagnosis is driven through the same injected KubeAdmin the tests fake:
 * evidence gathering that hid inside the kubectl port could never be exercised without a cluster.
 */
async function awaitRollout(kube: KubeAdmin, target: RolloutTarget): Promise<void> {
  const { kind, name, namespace, context, timeoutSeconds } = target;
  try {
    await kube.waitRollout({
      ...(kind ? { kind } : {}),
      name,
      namespace,
      ...(context ? { context } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    });
  } catch (err) {
    throw await rolloutFailure(kube, err, target);
  }
}

/**
 * Convergence is a claim about the CLUSTER, so it is checked against the cluster (ADR-0019): after
 * a rollout, the pod actually serving must carry the image this run intended. Without this, `up`
 * reported success off the content-hash label it had just written — and a Deployment whose pod
 * template never moved (stale image, no rollout) printed `converged` while running old code.
 *
 * Tag equality is the whole check, which is only sound because the tag IS the content address (see
 * `kitImageRefs`): on the `kind load` path a pod's `imageID` is containerd's manifest digest
 * under a rewritten `import-<date>` repo, comparable to nothing the host holds.
 */
async function verifyRunningImage(
  io: Io,
  kube: KubeAdmin,
  opts: { layer: string; namespace: string; selector: string; image: string; container?: string; context?: string },
): Promise<void> {
  const { layer, image, container, ...q } = opts;
  const pods = await kube.listJson<PodObject>({ kind: "pod", ...q });
  // Mid-termination pods from the outgoing ReplicaSet still carry the old image and are not the
  // thing serving — the question is what the cluster runs now, not what it is done running.
  const live = pods.filter((p) => !p.metadata.deletionTimestamp);
  // `container` narrows a multi-container pod to the one this layer's image claim is about
  // (the Instance Harness pod also carries the Custodian, which is not this check's business).
  const stale = live.filter((p) =>
    p.spec.containers.some((c) => (container === undefined || c.name === container) && c.image !== image),
  );
  if (stale.length > 0) {
    const carried = stale[0]!.spec.containers.map((c) => c.image).join(", ");
    throw new Error(
      `${layer}: rollout reported success, but the running pod carries ${carried} — expected ${image}. ` +
        `The cluster is serving code this converge did not deploy; ` +
        `\`kubectl -n ${opts.namespace} rollout restart deploy\` and re-run \`jr2 up\` to resolve it.`,
    );
  }
  if (live.length === 0) {
    activity(io, `${layer}: WARNING — rollout succeeded but no pod matched ${opts.selector} (nothing verified)`);
    return;
  }
  activity(io, `${layer}: verified — ${live.length} pod(s) running ${image}`);
}

type PodObject = {
  metadata: { name: string; deletionTimestamp?: string };
  spec: { containers: Array<{ name?: string; image: string }> };
};

/** What a converge that GENERATED a keypair owes its own last line (ADR-0047): the Secret it
 * landed in, the key nobody has registered yet, and the Repos that stay uncloneable until somebody
 * does. A supplied key produces none of this — it is registered already. */
type GitSshNotice = { secret: string; publicKey: string; urls: string[] };

/** What `jr2 up` writes for the push credentials (ADR-0051): each entry's Secret, its data base64, and
 * the manifest the provision reads. */
export type GitPushObjects = {
  secrets: Array<{ name: string; data: Record<string, string> }>;
  manifest: GitPushManifest;
};

/**
 * Each `git.credentials` entry's push Secret (ADR-0051), when any Workspace pushes: the
 * entry's token from `.env` (Flux's `username`/`password`), and the keys of the Secrets its
 * `sshKey`, `push.sshKey` and `sign` name, copied as data — base64 to base64, never decoded — so
 * one Secret holds what the entry pushes and signs with, and the provision names it on the Sandbox
 * of a push whose url the entry matches. An entry with nothing it can push with is not written,
 * and says why. A push on a slot the Machine binds to an https url whose entry's token is unset is
 * refused, with its fix. A key's Secret that is absent, or a signing key's, is a warning, not a
 * refusal: the Secret may be written after `jr2 up` (ADR-0047's prompt, a scenario, a human), and
 * the entry's Secret is written without that key, so the provision refuses the push that needs it
 * until the Secret exists and `jr2 up` runs again.
 */
async function resolveGitPush(
  io: Io,
  kube: KubeAdmin,
  config: JR2Config,
  sandbox: readonly SandboxEffectorPlan[],
  namespace: string,
  ctx: { context?: string },
): Promise<GitPushObjects> {
  const none: GitPushObjects = { secrets: [], manifest: { version: 1, entries: [] } };
  if (!sandbox.some((p) => p.pushes.length > 0)) return none;
  const { plans, skipped } = gitPushPlansOf(config.git?.credentials ?? [], (n) => io.env[n]);
  const read = new Map<string, Record<string, string> | undefined>();
  const dataOf = async (secret: string) => {
    if (!read.has(secret)) {
      const found = await kube.getJson<KubeObject & { data?: Record<string, string> }>({
        kind: "secret",
        name: secret,
        namespace,
        ...ctx,
      });
      read.set(secret, found ? (found.data ?? {}) : undefined);
    }
    return read.get(secret);
  };
  const out: GitPushObjects = { secrets: [], manifest: { version: 1, entries: [] } };
  for (const plan of plans) {
    const data: Record<string, string> = {};
    let sshMissing: string | undefined;
    let signMissing: string | undefined;
    // One warning per entry and cause: an absent Secret is missing every key it was to give.
    const warned = new Set<string>();
    for (const source of plan.sources) {
      if ("literal" in source) {
        data[source.key] = Buffer.from(source.literal).toString("base64");
        continue;
      }
      const held = await dataOf(source.from.secret);
      const value = held?.[source.from.key];
      if (value !== undefined) {
        data[source.key] = value;
        continue;
      }
      if (source.optional) continue;
      const why =
        held === undefined
          ? `the Secret "${source.from.secret}" does not exist in namespace ${namespace}`
          : `the Secret "${source.from.secret}" holds no key ${source.from.key}`;
      if (source.key.startsWith("sign.")) signMissing ??= why;
      else sshMissing ??= why;
      if (warned.has(why)) continue;
      warned.add(why);
      // Not a refusal: the Secret may be written later (a scenario writes it, a human creates it).
      // A push under the entry that needs it is refused at provision until `jr2 up` runs again.
      activity(
        io,
        `warning: git.credentials "${plan.entry.match}": ${why} — a push that needs it is refused at provision ` +
          "until it exists and jr2 up runs again (ADR-0051)",
      );
    }
    const entry = { ...plan.entry };
    if (sshMissing !== undefined) {
      entry.push = entry.push.filter((k) => k !== "ssh");
      for (const k of ["identity", "identity.pub", "known_hosts"]) delete data[k];
    }
    if (signMissing !== undefined) {
      delete entry.sign;
      for (const k of ["sign.identity", "sign.private.asc"]) delete data[k];
      const json = JSON.parse(Buffer.from(data["entry.json"]!, "base64").toString("utf8")) as Record<string, unknown>;
      delete json.sign;
      data["entry.json"] = Buffer.from(JSON.stringify({ ...json, push: entry.push })).toString("base64");
    } else if (sshMissing !== undefined) {
      const json = JSON.parse(Buffer.from(data["entry.json"]!, "base64").toString("utf8")) as Record<string, unknown>;
      data["entry.json"] = Buffer.from(JSON.stringify({ ...json, push: entry.push })).toString("base64");
    }
    if (entry.push.length === 0) continue;
    out.secrets.push({ name: entry.secret, data });
    out.manifest.entries.push(entry);
    activity(
      io,
      `git.credentials "${entry.match}": push Secret ${entry.secret} — pushes over ` +
        `${entry.push.map((k) => (k === "ssh" ? "ssh" : "https")).join(" and ")}` +
        `${entry.sign ? `; signs with ${entry.sign}` : ""}`,
    );
  }
  for (const [match, why] of skipped) activity(io, `git.credentials "${match}": ${why}`);
  // A slot the Machine binds to an https url: its token's value is known now. An unset one is
  // refused, with the fix, as the clone's token is.
  for (const plan of sandbox) {
    for (const push of plan.pushes) {
      if (push.url === undefined || push.match === undefined) continue;
      if (repoIdentity(push.url).scheme === "ssh") continue;
      const placed = out.manifest.entries.find((e) => e.match === push.match);
      const why = skipped.get(push.match);
      if (!placed?.push.includes("token") && why !== undefined) {
        throw new Error(
          `${plan.label}: the push of Repo Slot "${push.slot}" (${push.url}): git.credentials entry ` +
            `"${push.match}" cannot push — ${why} (ADR-0051)`,
        );
      }
    }
  }
  return out;
}

/**
 * What each Workspace's Sandbox Effector image owes its pushes (ADR-0068), read off the image
 * this converge built — its effector image, else its Sandbox Image — by the push forms `jr2 up` can
 * see: a slot the Machine binds (its url's scheme, its entry's `sign`), never one the run or a
 * `customize()` binds, whose url is the provision's. The stock Harness image — the fallback when the
 * Workspace names no image and there is no `images/default` — is the kit's, so what it holds is
 * known, not read (STOCK_HARNESS_IMAGE). An author's image `jr2 up` did not build (a registry ref)
 * is not read, as its `USER` is not.
 */
async function checkEffectorImages(
  /** {@link BuildPort.imageFiles} for a ref this converge resolved — rebuilt if a sweep took it. */
  imageFiles: (ref: string, paths: readonly string[]) => Promise<ImageFiles>,
  config: JR2Config,
  sandbox: readonly SandboxEffectorPlan[],
  converged: ConvergedImages,
  /** Each `file:` context's key in the map: the digest of its staged copy (ADR-0069). */
  contextDigests: ReadonlyMap<string, string>,
): Promise<void> {
  const list = config.git?.credentials ?? [];
  for (const plan of sandbox) {
    const forms: Array<{ form: PushForm; push: string }> = [];
    for (const push of plan.pushes) {
      if (push.url === undefined || push.match === undefined) continue;
      const what = `the push of Repo Slot "${push.slot}" (${push.url})`;
      if (isSshUrl(push.url)) forms.push({ form: "ssh-transport", push: what });
      const sign = push.sign ? list.find((e) => e.match === push.match)?.sign : undefined;
      if (sign) forms.push({ form: "gpgKey" in sign ? "gpg-sign" : "ssh-sign", push: what });
    }
    if (forms.length === 0) continue;
    const image = plan.image ?? plan.sandboxImage;
    let key = "default";
    if (image !== undefined) {
      if (!image.startsWith("file:")) continue;
      // A Workspace's image is a context the walk carried, so it was keyed with the Assembly.
      const digest = contextDigests.get(fileURLToPath(image));
      if (digest === undefined) continue;
      key = digest;
    }
    const ref = converged.sandbox[key];
    if (ref === undefined) {
      if (image !== undefined) continue;
      // No image named and no images/default: the Effector runs in the stock Harness image.
      const refusal = effectorImageRefusal({
        label: plan.label,
        ref: converged.harness,
        user: STOCK_HARNESS_IMAGE.user,
        forms,
        present: new Set(STOCK_HARNESS_IMAGE.present),
        passwd: STOCK_HARNESS_IMAGE.passwd,
        stock: true,
      });
      if (refusal) throw new Error(refusal);
      continue;
    }
    const files = await imageFiles(ref, effectorImagePaths(forms.map((f) => f.form)));
    const refusal = effectorImageRefusal({
      label: plan.label,
      ref,
      user: converged.sandboxUser[key] ?? "",
      forms,
      present: new Set(files.present),
      passwd: files.passwd,
    });
    if (refusal) throw new Error(refusal);
  }
}

/** Where the git ssh key comes from — the three sources ADR-0047 offers, as a pick. */
type GitSshSource = { kind: "generate" } | { kind: "file"; path: string } | { kind: "paste" };

/**
 * A BOUND ssh url needs a deploy key the CLUSTER holds, and the USER chooses which one
 * (ADR-0047, ADR-0051). The key lives in the Secret the url's `git.credentials` entry names as its
 * `sshKey` — the scaffold's wildcard names `jr2-git-ssh`; an entry may name any — and this asks
 * once per such Secret that does not exist yet, listing the urls it will serve. The sources are
 * ADR-0047's three: a fresh in-cluster deploy keypair (recommended, listed first, and the only
 * thing `--yes` will ever take), a local key — the `~/.ssh` candidates plus a path typed in — or
 * one pasted with echo off. Declining bails, as before: the cache agent would only fail on an
 * unauthenticated clone later. An ssh url whose entry names no `sshKey` — or that matches no
 * entry — is warned once and not asked about: its cache clone will fail unless the host allows
 * anonymous ssh, and the fix is a config line, not a key.
 *
 * ADR-0019's flat "personal keys never enter a cluster" is demoted to a DEFAULT, not deleted: a git
 * host allows one deploy key on exactly one repo, so the invariant charged a multi-repo instance N
 * registrations and pushed users into hand-rolled Secrets anyway. jr2 still never lifts a personal
 * key silently — only by this explicit, warned pick, and never from a flag (`--yes` generates; the
 * scripted supplied-key path is `kubectl create secret generic <name> --from-file=identity=…`).
 *
 * Per-run ssh urls are not seen here: they are the run's input, first met at attach (ADR-0051).
 *
 * Returns the notices generated keypairs owe the end of the converge; a supplied key returns none.
 */
async function ensureGitSsh(
  io: Io,
  kube: KubeAdmin,
  config: JR2Config,
  repos: CarriedRepo[],
  namespace: string,
  ctx: { context?: string },
  yes: boolean,
): Promise<GitSshNotice[]> {
  const credentials = config.git?.credentials ?? [];
  const bySecret = new Map<string, string[]>();
  for (const repo of repos) {
    if (!isSshUrl(repo.url)) continue;
    const entry = matchCredential(repo.identity, credentials);
    if (entry?.sshKey === undefined) {
      activity(
        io,
        `${repo.url} is an ssh url and no git.credentials entry names a key for it — its cache clone will fail ` +
          "unless the host allows anonymous ssh",
      );
      continue;
    }
    bySecret.set(entry.sshKey, [...(bySecret.get(entry.sshKey) ?? []), repo.url]);
  }

  const notices: GitSshNotice[] = [];
  for (const [secret, urls] of bySecret) {
    if (await kube.getJson({ kind: "secret", name: secret, namespace, ...ctx })) continue;

    // Non-interactive is GENERATE, always (ADR-0047): the dangerous option is never a default, so
    // there is nothing to ask and nothing a script can silently answer with a personal key.
    const source: GitSshSource | undefined = yes
      ? { kind: "generate" }
      : await chooseGitSshSource(io, secret, urls, namespace);
    if (!source) {
      throw new Error(
        `${urls.join(", ")} bind over ssh and need the "${secret}" Secret — re-run and pick a key source, create ` +
          `the Secret yourself (kubectl -n ${namespace} create secret generic ${secret} --from-file=identity=<path>), ` +
          "or bind the urls over https (+ a token in git.credentials)",
      );
    }

    if (source.kind === "generate") {
      const { privateKey, publicKey } = await (io.sshKeygen ?? sshKeygen)();
      await applyGitSshSecret(io, kube, namespace, ctx, secret, privateKey, publicKey);
      activity(io, `generated deploy key ${sshFingerprint(publicKey)} — register this PUBLIC key (read access):`);
      activity(io, `  ${publicKey.trim()}`);
      // The pause sits exactly where the user must act anyway (ADR-0047): the printed key is useless
      // until it is registered, and the cache agent's first clone of every one of these Repos will
      // fail until it is. `--yes` has nobody to wait for.
      if (!yes) {
        await promptLine(io, `register this public key with your git host, then press enter to continue: `);
      }
      notices.push({ secret, publicKey: publicKey.trim(), urls });
      continue;
    }

    // A key the USER handed over. Read it, derive the public half, and refuse a passphrase-protected
    // one BEFORE anything is applied (ADR-0047) — the in-cluster clone runs unattended and can
    // answer no passphrase, and storing a decrypted copy would strip protection the user chose to
    // have.
    const where = source.kind === "file" ? source.path : "the pasted key";
    const privateKey =
      source.kind === "file"
        ? await readSuppliedKey(source.path)
        : await readSecretInput(io, `paste the private key (input hidden), ending with its -----END … ----- line:`);
    if (privateKey.trim() === "") {
      throw new Error(`no key was read from ${where} — nothing was applied; re-run \`jr2 up\` to pick a key source`);
    }
    let publicKey: string;
    try {
      publicKey = await (io.sshPublicKey ?? sshPublicKey)(privateKey);
    } catch (err) {
      throw new Error(`refusing the key from ${where}: ${err instanceof Error ? err.message : err}`);
    }
    await applyGitSshSecret(io, kube, namespace, ctx, secret, privateKey, publicKey);
    // The FINGERPRINT, never the material — not the private half, and not the public one either:
    // this key is the user's own, and its public half identifies them wherever it is registered.
    activity(io, `git ssh: "${secret}" applied from ${where} — ${sshFingerprint(publicKey)}`);
  }
  return notices;
}

/** The choice itself, warning first (ADR-0047): a Secret is not a vault, and the two supplied-key
 * options differ from the generated one in exactly how much a reader of it gets. */
async function chooseGitSshSource(
  io: Io,
  secret: string,
  urls: string[],
  namespace: string,
): Promise<GitSshSource | undefined> {
  const candidates = await discoverSshKeys(io);
  activity(
    io,
    `${urls.join(", ")} bind over ssh and the "${secret}" Secret their git.credentials entry names does not exist.`,
  );
  activity(io, `  whichever key you pick lands in a Secret in namespace "${namespace}" — readable by anyone with`);
  activity(io, `  Secret read there, and at rest in etcd. A deploy key leaks read access to the repos you`);
  activity(io, `  register it on; a personal key leaks everything it can reach.`);
  const options = [
    "generate a fresh in-cluster deploy keypair (recommended — one registration per repo)",
    ...candidates.map((path) => `use ${path}`),
    "use another local key (type a path)",
    "paste a private key (input hidden)",
  ];
  const pick = await chooseOrBail(io, `where should the git ssh key come from?`, options);
  // An out-of-range answer reads as a decline, not as a neighbouring option: this menu's entries
  // are not interchangeable, and bailing is the safe end of it.
  if (pick === undefined || pick < 0 || pick >= options.length) return undefined;
  if (pick === 0) return { kind: "generate" };
  if (pick <= candidates.length) return { kind: "file", path: candidates[pick - 1]! };
  if (pick === candidates.length + 1) {
    const typed = await promptLine(io, `path to the private key: `);
    return typed === "" ? undefined : { kind: "file", path: expandHome(io, typed) };
  }
  return { kind: "paste" };
}

/** The `~/.ssh` private keys to offer by name. A candidate is a plain file that is not a `.pub`
 * and whose first bytes are a PEM private-key header — cheaper and truer than a name convention
 * (`id_*` misses a key called `work`, and `known_hosts` is not a key however it is named). Only the
 * head is read: this directory also holds `known_hosts`, which can be large and is never a key. */
async function discoverSshKeys(io: Io): Promise<string[]> {
  const dir = join(io.env.HOME ?? homedir(), ".ssh");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no ~/.ssh — the local-key options still stand, typed or pasted
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.endsWith(".pub")) continue;
    const path = join(dir, entry.name);
    let head = "";
    try {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(64);
        const { bytesRead } = await fh.read(buf, 0, 64, 0);
        head = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue; // unreadable → not a candidate to offer
    }
    if (/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(head)) found.push(path);
  }
  return found;
}

/** `~/…` as the shell would have expanded it, since this path is typed at jr2's prompt, not the
 * shell's — the one expansion a user reasonably expects to still work here. */
function expandHome(io: Io, path: string): string {
  return path.startsWith("~/") ? join(io.env.HOME ?? homedir(), path.slice(2)) : path;
}

/** Read a supplied key file, naming the path when it cannot be read — the alternative is a
 * ssh-keygen failure about a temp file the user never heard of. */
async function readSuppliedKey(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`${path} is not readable (${err instanceof Error ? err.message : err}) — nothing was applied`);
  }
}

/** The Secret both key sources converge on, in Flux's key names (ADR-0051) so a Flux or Argo user's
 * existing Secret serves unchanged: `identity` is what the cache agent authenticates with,
 * `identity.pub` rides along so the cluster can say which key it holds without holding it up to a
 * human. Trailing newline enforced — ssh refuses a key file that lacks one. */
async function applyGitSshSecret(
  io: Io,
  kube: KubeAdmin,
  namespace: string,
  ctx: { context?: string },
  secret: string,
  privateKey: string,
  publicKey: string,
): Promise<void> {
  await kube.apply({
    manifest: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secret, namespace },
      type: "Opaque",
      stringData: { identity: newlineTerminated(privateKey), "identity.pub": newlineTerminated(publicKey) },
    }),
    warn: (line) => activity(io, line),
    ...ctx,
  });
}

function newlineTerminated(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** OpenSSH's own fingerprint form (`SHA256:<unpadded base64>` of the wire blob), computed here
 * rather than shelled out for: it is a hash of the public half, so it needs no key on disk and no
 * subprocess to fake in tests. */
function sshFingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1] ?? "";
  if (blob === "") return "SHA256:(unreadable)";
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** The last word of a converge that generated a keypair (ADR-0047): the key, what stays broken
 * until it is registered, and who fixes it — the cache agent, on its own (ADR-0048/0051), so nobody
 * re-runs `jr2 up` looking for a button. */
function reportGeneratedKey(io: Io, notice: GitSshNotice): void {
  activity(
    io,
    `git ssh: a deploy key was generated into "${notice.secret}" this converge and nothing has registered it yet:`,
  );
  activity(io, `  ${notice.publicKey}`);
  activity(io, `  until it is registered, ${notice.urls.join(", ")} will not sync (the Orchestrator serves anyway)`);
  activity(io, `  the cache agent retries on its own — \`jr2 status\` reports each Repo's last error per node`);
}

/** Generate an ed25519 keypair with ssh-keygen (no passphrase — it lives only in the Secret). */
async function sshKeygen(): Promise<{ privateKey: string; publicKey: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "jr2-ssh-"));
  try {
    await promisify(execFile)("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "jr2-git-ssh", "-f", join(dir, "key")]);
    return {
      privateKey: await readFile(join(dir, "key"), "utf8"),
      publicKey: await readFile(join(dir, "key.pub"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Derive `key.pub` from a supplied private key — and, in the same call, decide whether jr2 will
 * take it at all (ADR-0047). `-P ""` supplies an EMPTY passphrase, so an encrypted key fails here,
 * by name, before any Secret is applied; prompting for the passphrase and storing the decrypted
 * key would silently strip protection the user chose to have.
 *
 * The key is written to a private temp file because `ssh-keygen -y` reads a file, not stdin — mode
 * 0600 both because ssh-keygen refuses a group/world-readable key and because the material must not
 * be exposed on this host for the seconds it takes to read one line out of it.
 */
async function sshPublicKey(privateKey: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "jr2-ssh-"));
  const file = join(dir, "key");
  try {
    await writeFile(file, newlineTerminated(privateKey), { mode: 0o600 });
    try {
      const { stdout } = await promisify(execFile)("ssh-keygen", ["-y", "-P", "", "-f", file]);
      return newlineTerminated(stdout.trim());
    } catch (err) {
      const detail = `${(err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : "")}`.trim();
      if (/passphrase/i.test(detail)) {
        throw new Error(
          `it is passphrase-protected. The in-cluster clone runs unattended and cannot answer a passphrase, ` +
            `and jr2 will not store a decrypted copy — use an unencrypted key, or let jr2 generate a deploy key`,
        );
      }
      throw new Error(`ssh-keygen could not read it as a private key (${detail || "no output"})`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `harness.caBundle` (ADR-0020): a path relative to the instance folder, read host-side by `up`
 * alone. Loud on a missing file — a silently absent CA turns up later as a TLS failure inside a
 * pod, the exact hang-shaped outcome preflights exist to prevent.
 */
async function readCaBundle(root: string, config: JR2Config): Promise<string | undefined> {
  if (!config.harness?.caBundle) return undefined;
  const path = join(root, config.harness.caBundle);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(
      `harness.caBundle names "${config.harness.caBundle}" but ${path} is not readable — ` +
        `the path is relative to the instance folder; commit the PEM bundle there (CA certs are public)`,
    );
  }
}

/**
 * The foreign dispatch preflight (ADR-0071): for each dispatch whose target is another
 * Orchestrator, `GET <origin>/workflows/<name>`, and the served door compared with the slot's
 * input schema (`doorCompat`, one direction). The route is open band (ADR-0014), so no token is
 * sent: the token is the Effector's to hold, and the host would otherwise carry it over a wire the
 * target may not secure. Every failure — no answer, a miss, a mismatch, a schema not compared — is a
 * WARNING, never a refusal: the other Instance may be down or publish later, and refusing here
 * would couple two Instances' publish order. A run of the dispatch answers what the door then says,
 * the token's refusal included.
 */
async function preflightDispatch(io: Io, effects: readonly CarriedEffect[]): Promise<void> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const seen = new Set<string>();
  for (const e of effects) {
    if (e.kind !== "dispatch" || e.target === undefined) continue;
    const url = targetText({ target: e.target });
    const once = JSON.stringify([url, e.workflow, e.secrets, e.input ?? null]);
    if (seen.has(once)) continue;
    seen.add(once);
    const warn = (why: string) => activity(io, `warning: dispatch "${e.workflow}" at ${url}: ${why} (ADR-0071)`);
    let res: Response;
    try {
      // No redirect is followed: the Effector's dispatch client follows none, so a door that
      // redirects is one it never reaches.
      res = await fetchImpl(`${url}/workflows/${encodeURIComponent(e.workflow)}`, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      warn(
        `no answer from this host (${(err as Error).message}) — the other Instance may be down, or reached only ` +
          'from inside its cluster; while no door answers, the dispatch settles "unreachable"',
      );
      continue;
    }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      warn(
        `the door redirected (HTTP ${res.status}); the Effector follows no redirect, so a run of the dispatch is refused there`,
      );
      continue;
    }
    if (res.status === 404) {
      warn(`no Workflow "${e.workflow}" there — a run of the dispatch is refused with the door's 404 until it has one`);
      continue;
    }
    if (!res.ok) {
      warn(`the door answered HTTP ${res.status}`);
      continue;
    }
    if (e.input === undefined) {
      activity(io, `dispatch "${e.workflow}" at ${url}: the door answers; the slot states no input schema to compare`);
      continue;
    }
    // A Workflow detail carries its door as `input` (null: it declares none). Any other answer — a
    // page an ingress serves, another shape at another Kit version — is no door: not compared,
    // never compared as `{}`, which would call every slot field stripped.
    const detail: unknown = await res.json().catch(() => undefined);
    if (typeof detail !== "object" || detail === null || Array.isArray(detail) || !Object.hasOwn(detail, "input")) {
      warn("the door's answer is not a Workflow detail (no `input`); not compared");
      continue;
    }
    const compared = doorCompat(e.input, (detail as { input: unknown }).input);
    if (compared.ok === true) {
      activity(io, `dispatch "${e.workflow}" at ${url}: the door takes the slot's input (ADR-0071)`);
    } else if (compared.ok === "not-compared") {
      warn(`its input schema and the door are not compared — ${compared.why}`);
    } else {
      for (const fault of compared.faults) warn(`the door does not take the slot's input: ${fault}`);
    }
  }
}

/** One provider of one check pod (ADR-0019, ADR-0059). */
export type CheckedProvider = {
  /** The provider id, the specifier's part before the first `/`. */
  id: string;
  /** Every carried model of it that a Harness pod of this placement runs: a typo, a retired model
   * or a model the key has no access to is per model. */
  models: string[];
  /** The held secrets that are its keys in the check pod's Custodian; none when no pod of this
   * placement holds one, and the check then shows what a Turn there meets. */
  keys: string[];
  /** Where the calls go: the keys' bound hosts, else the provider's host as jr2 knows it. */
  hosts: string[];
  /** `harness.catalog.<id>.baseUrl`, when it moves the provider. */
  gateway?: string;
  /** The custom provider (`harness.provider`, ADR-0018): its key is optional, and its causes are
   * its own. */
  custom?: true;
};

/** One check pod: the providers that the Harness pods of one placement call. */
export type CheckPod = {
  /** For a human: `the Sandbox nodes`, `the Instance Harness`, or both. */
  where: string;
  /** The node predicate of those pods (ADR-0052); none for the Instance Harness. */
  placement?: SandboxPlacement;
  /** The bindings of the checked keys: each a part of a held pod's manifest. */
  manifest: HeldManifest;
  providers: CheckedProvider[];
};

/** One Harness pod as the walk places it: its held pod key, its class, the models it runs, and
 * the bindings it holds (none: its HTTPS goes direct, with no proxy). */
type Seat = { pod: string; sandbox: boolean; models: readonly string[]; held: HeldManifest["secrets"] };

/**
 * Which providers the preflight checks, and in which pod (ADR-0019, ADR-0059). Every carried model
 * that a Harness pod runs is checked, in a pod with that pod's placement: a Workspace's model on the
 * Sandbox nodes, a `"none"` Agent's where the Instance Harness runs, so a node class whose egress is
 * closed fails here. The two are one check pod when their placements are the same. The custom provider
 * (`harness.provider`) goes the same way: its key is a held secret too (`JR2_PROVIDER_API_KEY`), so
 * the key never enters a pod spec, an argv or a script.
 *
 * In one placement, a provider's keys are the ones the first pod there that runs one of its models
 * holds (`MODEL_KEYS`, claimed by the provider). The check pod holds that pod's bindings of them and
 * reads their values where that pod reads them. A provider no pod there holds a key for is checked
 * all the same, with no key: a Turn there meets the same, and pi says so (`not configured`); a
 * signing credential in `harness.env` reaches the check as it reaches a Turn. Pure, for its test.
 */
export function checkPodsOf(config: JR2Config, walk: PlacementWalk, pods: readonly HeldPodObjects[]): CheckPod[] {
  const custom = config.harness?.provider;
  const heldOf = (pod: string) => pods.find((p) => p.pod === pod)?.manifest.secrets ?? [];
  const seats: Seat[] = [
    ...walk.workspaces.map((ws) => {
      const pod = workspaceHeldPod({ workflow: ws.workflow, route: ws.pod.route });
      return { pod, sandbox: true, models: ws.pod.models, held: heldOf(pod) };
    }),
    ...(walk.instanceHarness
      ? [
          {
            pod: INSTANCE_HARNESS_HELD_POD,
            sandbox: false,
            models: walk.instanceHarness.models,
            held: heldOf(INSTANCE_HARNESS_HELD_POD),
          },
        ]
      : []),
  ];
  const sandbox = config.sandbox?.nodeSelector || config.sandbox?.tolerations?.length ? config.sandbox : undefined;
  const placementOf = (seat: Seat) => (seat.sandbox ? sandbox : undefined);
  // A check pod stands for one class of Harness pod: its nodes, and whether it holds a secret. A pod
  // that holds one sends its HTTPS through its Custodian (a tunnel for an unbound host); a pod that
  // holds none sends it direct. So the two are two check pods, even on the same nodes.
  const keyOf = (seat: Seat) => {
    const placement = placementOf(seat);
    return JSON.stringify({
      nodeSelector: placement?.nodeSelector ?? {},
      tolerations: placement?.tolerations ?? [],
      holds: seat.held.length > 0,
    });
  };
  const groups = new Map<string, { seats: Seat[]; placement?: SandboxPlacement }>();
  for (const seat of seats) {
    const key = keyOf(seat);
    const group = groups.get(key) ?? { seats: [], ...(placementOf(seat) ? { placement: placementOf(seat) } : {}) };
    group.seats.push(seat);
    groups.set(key, group);
  }
  const checkPods: CheckPod[] = [];
  for (const group of groups.values()) {
    const models: string[] = [];
    for (const seat of group.seats) for (const m of seat.models) if (!models.includes(m)) models.push(m);
    const checkPod: CheckPod = {
      where: [
        ...(group.seats.some((s) => s.sandbox) ? ["the Sandbox nodes"] : []),
        ...(group.seats.some((s) => !s.sandbox) ? ["the Instance Harness"] : []),
      ].join(" and "),
      ...(group.placement ? { placement: group.placement } : {}),
      // A class that holds a secret: the first pod's own held set, so the check pod's env (the proxy, the
      // Stand-ins) is that of a pod of the class; the keys the class's other pods hold join it below.
      manifest: { version: 1, secrets: [...group.seats[0]!.held] },
      providers: [],
    };
    for (const model of models) {
      const slash = model.indexOf("/");
      const id = slash > 0 ? model.slice(0, slash) : model;
      const known = checkPod.providers.find((p) => p.id === id);
      if (known) {
        known.models.push(model);
        continue;
      }
      const names =
        id === custom?.id
          ? [PROVIDER_KEY_NAME]
          : Object.keys(MODEL_KEYS).filter((name) => MODEL_KEYS[name]!.providers.includes(id));
      const runs = group.seats.filter((s) => s.models.some((m) => m.startsWith(`${id}/`)));
      const holder = runs
        .map((s) => pods.find((p) => p.pod === s.pod))
        .find((p) => p?.manifest.secrets.some((b) => names.includes(b.name)));
      const bindings = holder?.manifest.secrets.filter((b) => names.includes(b.name)) ?? [];
      for (const b of bindings) {
        if (checkPod.manifest.secrets.some((h) => h.name === b.name)) continue;
        checkPod.manifest.secrets.push(b);
      }
      const gateway = config.harness?.catalog?.[id]?.baseUrl;
      const fallback =
        id === custom?.id
          ? [new URL(custom.baseUrl).host]
          : gateway
            ? [new URL(gateway).host]
            : names.flatMap((n) => (MODEL_KEYS[n]!.host ? [MODEL_KEYS[n]!.host!] : [])).slice(0, 1);
      checkPod.providers.push({
        id,
        ...(id === custom?.id ? { custom: true } : {}),
        models: [model],
        keys: bindings.map((b) => b.name),
        hosts: bindings.length ? [...new Set(bindings.flatMap((b) => b.hosts.map(hostText)))] : fallback,
        ...(gateway ? { gateway } : {}),
      });
    }
    if (checkPod.providers.length) checkPods.push(checkPod);
  }
  return checkPods;
}

const hostText = (h: { host: string; port: number }): string => (h.port === 443 ? h.host : `${h.host}:${h.port}`);

/** How long a check pod may take to start: two cold image pulls (the Harness and the Custodian) and
 * Envoy's start. The check's own bound starts when its container runs. */
const CHECK_START_SECONDS = 300;
/** Each model's bound in the pod: its own budget in the check (`PREFLIGHT_MODEL_BUDGET_SECONDS` in
 * `@jr2/harness`'s `preflight-line.ts`, which a test holds this to), so one slow model never uses
 * the time of the others. Exported for that test. */
export const CHECK_MODEL_SECONDS = 360;
const CHECK_RUN_MARGIN_SECONDS = 30;
/** A leftover a run left with no pod, older than this, is a dead run's, not a live one's. */
const CHECK_LEFTOVER_SECONDS = 3600;

/**
 * The provider preflight (ADR-0019, ADR-0059): each check pod of `checkPodsOf`, one at a time — a
 * one-shot Harness-shaped pod, a Custodian that holds the providers' keys and the stock Harness
 * image's `provider-preflight.ts` — that demands one tool call of each model, on the path a Turn takes. So no
 * egress to the provider's host, a missing, wrong or empty key, a model no endpoint serves, and a
 * gateway that does not answer each fail HERE. Every check pod runs, a pod that cannot be applied
 * included, and every failure is in one error. A provider still busy after the retries, and a
 * model that answered but did not call a tool it was not forced to, are warnings (ADR-0064).
 *
 * Each pod reads its own objects (`checkPodObjects`), written from `values`, `leaves`, `trust`
 * and `harnessEnvData` — what the apply would write — and named for this run (`<run>-<n>`), so two
 * converges in one namespace never read or delete each other's. The ones of an earlier run of this
 * Instance that did not end go first (`removeCheckLeftovers`). A failed cleanup is a warning and
 * never hides the check's own answer.
 */
async function preflightProviders(
  io: Io,
  kube: KubeAdmin,
  opts: {
    checkPods: CheckPod[];
    /** `--skip-provider-preflight`: no check pod runs, and one warning line says so. */
    skip: boolean;
    name: string;
    namespace: string;
    ctx: { context?: string };
    harnessImage: string;
    custodianImage: string;
    harness?: JR2Config["harness"];
    caBundle: boolean;
    values: Record<string, string>;
    leaves: Record<string, Pem>;
    trust: Record<string, string>;
    harnessEnvData: Record<string, string>;
    priorityClassName: string;
  },
): Promise<void> {
  const { namespace, ctx } = opts;
  // First, and with no check to run too: the leftovers of an earlier run can hold a key.
  await removeCheckLeftovers(io, kube, opts.name, namespace, ctx);
  if (opts.skip) {
    // Never silent: a converge that checked nothing must not read as one that checked. A model that
    // two check pods would check is named once.
    const models = [...new Set(opts.checkPods.flatMap((p) => p.providers.flatMap((v) => v.models)))];
    activity(
      io,
      "warning: provider: preflight skipped (--skip-provider-preflight) — " +
        (models.length ? `these models were not checked: ${models.join(", ")}` : "no model was checked"),
    );
    return;
  }
  if (!opts.checkPods.length) return;
  const run = randomBytes(4).toString("hex");
  const orchestrator = { host: `${ORCHESTRATOR_SERVICE}.${namespace}.svc`, port: ORCHESTRATOR_PORT };
  const faults: string[] = [];
  for (const [n, checkPod] of opts.checkPods.entries()) {
    const object = `${PROVIDER_PREFLIGHT}-${run}-${n}`;
    const models = checkPod.providers.flatMap((p) => p.models);
    /** The models whose result is already said, while the pod ran, and what it was: a final log
     * read that comes back empty must not turn a result already said into "not checked". */
    const said = new Set<string>();
    const live = new Map<string, CheckVerdict>();
    let lastLive = "";
    for (const p of checkPod.providers) {
      // No held key is not no credential: a credential that pi reads from `harness.env` (an AWS
      // role for Bedrock, say) reaches the check as it reaches a Turn.
      const why = p.custom
        ? "harness.provider has no apiKey"
        : `no Harness pod there holds a key of "${p.id}"; a credential in harness.env still reaches it`;
      const holds = p.keys.length
        ? `through a Custodian that holds ${p.keys.join(", ")} for ${p.hosts.join(", ")}`
        : checkPod.manifest.secrets.length
          ? `with no held key (${why}), through the Custodian's tunnel, as those pods call it`
          : `with no held key (${why}), direct, as a pod that holds no secret calls it`;
      activity(io, `provider: checking ${p.models.join(", ")} on ${checkPod.where}, ${holds}`);
    }
    activity(
      io,
      `provider: the check pod has up to ${CHECK_START_SECONDS / 60} min to start, then up to ` +
        `${CHECK_MODEL_SECONDS / 60} min for ${models.length === 1 ? "its model" : `each of its ${models.length} models`}`,
    );
    const runSeconds = CHECK_MODEL_SECONDS * models.length + CHECK_RUN_MARGIN_SECONDS;
    // Built before the apply: a fault in jr2 here is jr2's, never the cluster's refusal.
    const manifest = checkPodObjects({
      name: opts.name,
      namespace,
      object,
      run,
      harnessImage: opts.harnessImage,
      custodianImage: opts.custodianImage,
      held: checkPod.manifest,
      values: opts.values,
      leaves: opts.leaves,
      trust: opts.trust,
      custodian: {
        bootstrap: JSON.stringify(custodianBootstrap(checkPod.manifest, orchestrator)),
        script: custodianScript(checkPod.manifest),
      },
      token: randomBytes(24).toString("hex"),
      harnessEnvData: opts.harnessEnvData,
      models,
      ...(checkPod.placement ? { placement: checkPod.placement } : {}),
      priorityClassName: opts.priorityClassName,
      ...(opts.harness ? { harness: opts.harness } : {}),
      caBundle: opts.caBundle,
      deadlineSeconds: CHECK_START_SECONDS + runSeconds + 60,
    });
    let end: PodEnd | undefined;
    let refused: string | undefined;
    try {
      // Server-side: the trust bundles carry every root, past client-side apply's annotation.
      await applyFirstContact(kube, { manifest, serverSide: true, warn: (line) => activity(io, line), ...ctx });
    } catch (err) {
      // A quota, a Pod Security level or a webhook that refuses the pod: this check pod's fault alone.
      refused = `the cluster refused the check pod's objects: ${errText(err)}`;
    }
    try {
      if (refused === undefined) {
        end = await kube.awaitPodEnd({
          namespace,
          name: object,
          container: CHECK_CONTAINER,
          startSeconds: CHECK_START_SECONDS,
          runSeconds,
          onPending: (line) => activity(io, `provider: the check pod is not running yet — ${line}`),
          // Each model's result as it arrives: a check of several slow models is not silence.
          onLog: (log: string) => {
            lastLive = log;
            for (const [model, verdict] of checkVerdicts(log)) {
              live.set(model, verdict);
              if (said.has(model) || verdict.kind === "fault") continue;
              said.add(model);
              sayVerdict(io, model, verdict);
            }
          },
          ...ctx,
        });
      }
    } finally {
      await removeCheckPod(io, kube, object, namespace, ctx);
    }
    // The last log read while the pod ran stands in for an empty final read.
    const output = end?.output || lastLive;
    const verdicts = checkVerdicts(output);
    const started = checkStarts(output);
    for (const p of checkPod.providers) {
      for (const model of p.models) {
        const verdict = verdicts.get(model) ?? live.get(model);
        if (verdict && verdict.kind !== "fault") {
          if (!said.has(model)) sayVerdict(io, model, verdict);
          continue;
        }
        const pod = () => podFault(end!, checkPod, opts);
        const why =
          verdict?.reason ??
          refused ??
          (started.has(model)
            ? `the check pod stopped while it checked this model: ${pod()}`
            : `not checked: the check pod stopped before it reached this model: ${pod()}`);
        faults.push(providerFault(p, model, checkPod.where, why, checkPod.manifest.secrets.length > 0));
      }
    }
  }
  if (faults.length) throw new Error(faults.join("\n"));
}

/** How long the first apply in a new namespace waits for its `default` ServiceAccount: the
 * controller makes it a moment after the namespace, and until then a pod is refused. */
const FIRST_CONTACT_TRIES = 10;
const FIRST_CONTACT_PAUSE_MS = 1000;

/** `kube.apply`, tried again while the namespace has no `default` ServiceAccount yet. Any other
 * refusal is the answer. */
async function applyFirstContact(kube: KubeAdmin, opts: Parameters<KubeAdmin["apply"]>[0]): Promise<void> {
  for (let n = 1; ; n++) {
    try {
      return await kube.apply(opts);
    } catch (err) {
      if (n >= FIRST_CONTACT_TRIES || !/serviceaccount "default" not found/i.test(errText(err))) throw err;
      await sleepMs(FIRST_CONTACT_PAUSE_MS);
    }
  }
}

/** The trust bundles a check pod reads (`<object>-ca`), as `trustObject` writes them to `jr2-ca`. */
function trustData(
  caBundle: string | undefined,
  bundles: { extra: string; bundle: string; upstream: string } | undefined,
) {
  return {
    ...(caBundle !== undefined ? { "ca.crt": caBundle } : {}),
    ...(bundles ? { "extra.crt": bundles.extra, "bundle.crt": bundles.bundle, "upstream.crt": bundles.upstream } : {}),
  };
}

/** How long after it ended an earlier run's check pod is left alone: that run may still be reading
 * its log. Exported for its test. */
export const CHECK_ENDED_MARGIN_SECONDS = 600;

/**
 * The leftovers of earlier runs of THIS Instance (`preflightProviders`), by label: a check pod
 * past its `activeDeadlineSeconds` and `CHECK_ENDED_MARGIN_SECONDS`, in any phase; a check pod that
 * ended more than `CHECK_ENDED_MARGIN_SECONDS` ago; each with its objects; and each object whose
 * pod is gone and that is older than any check pod lives. A live pod, a pod that ended a short time
 * ago and another Instance's objects stay. Every failure here is a warning.
 */
async function removeCheckLeftovers(
  io: Io,
  kube: KubeAdmin,
  name: string,
  namespace: string,
  ctx: { context?: string },
) {
  const selector = `${LABEL_PROVIDER_PREFLIGHT},${LABEL_INSTANCE}=${name}`;
  const since = (at: string | undefined) => (Date.now() - Date.parse(at ?? "")) / 1000;
  try {
    type CheckObject = KubeObject & {
      metadata: { creationTimestamp?: string };
      spec?: { activeDeadlineSeconds?: number };
      status?: {
        phase?: string;
        containerStatuses?: Array<{ name?: string; state?: { terminated?: { finishedAt?: string } } }>;
      };
    };
    const pods = await kube.listJson<CheckObject>({ kind: "pod", selector, namespace, ...ctx });
    const named = new Set(pods.map((p) => p.metadata.name));
    for (const p of pods) {
      // Past its deadline and the margin, in any phase: a pod no node took has no start time, so
      // the kubelet never applies `activeDeadlineSeconds` to it, and its Secret holds a key.
      const deadline = (p.spec?.activeDeadlineSeconds ?? 0) + CHECK_ENDED_MARGIN_SECONDS;
      if (since(p.metadata.creationTimestamp) > deadline) {
        await removeCheckPod(io, kube, p.metadata.name, namespace, ctx);
        continue;
      }
      if (!["Succeeded", "Failed"].includes(p.status?.phase ?? "")) continue;
      // The check container, or `probe` in a pod that an older `jr2 up` made: the label finds both.
      const finished = p.status?.containerStatuses?.find((c) => c.name === CHECK_CONTAINER || c.name === "probe")?.state
        ?.terminated?.finishedAt;
      if (!(since(finished ?? p.metadata.creationTimestamp) > CHECK_ENDED_MARGIN_SECONDS)) continue;
      await removeCheckPod(io, kube, p.metadata.name, namespace, ctx);
    }
    for (const kind of ["configmap", "secret"]) {
      for (const o of await kube.listJson<CheckObject>({ kind, selector, namespace, ...ctx })) {
        const owner = o.metadata.name.replace(/-(ca|tls|env)$/, "");
        if (named.has(owner) || !(since(o.metadata.creationTimestamp) > CHECK_LEFTOVER_SECONDS)) continue;
        await kube.deleteObject({ kind, name: o.metadata.name, namespace, wait: false, ...ctx });
      }
    }
  } catch (err) {
    activity(io, `warning: provider: the leftovers of an earlier preflight were not removed (${errText(err)})`);
  }
}

/** One check pod's objects, deleted; a failure is a warning, so it hides no check's answer. */
async function removeCheckPod(io: Io, kube: KubeAdmin, object: string, namespace: string, ctx: { context?: string }) {
  for (const { kind, name } of checkPodObjectNames(object)) {
    try {
      await kube.deleteObject({ kind, name, namespace, wait: false, ...ctx });
    } catch (err) {
      activity(
        io,
        `warning: provider: ${kind} ${name} was not deleted (${errText(err)}) — the next \`jr2 up\` removes it`,
      );
    }
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A fault in which the provider refused the key or its rights: a 401 or a 403, in the words the
 * apis use. The provider answered, so the key is the likely cause, and the egress is not. */
export function refusedKey(fault: string): boolean {
  return /\b40[13]\b|authentication|unauthori[sz]ed|permission|forbidden|invalid[ _-]?(x-)?api[ _-]?key/i.test(fault);
}

/** One model's result line (`preflight-line.ts` in `@jr2/harness`). */
type CheckVerdict = { kind: "ok" } | { kind: "fault" | "busy" | "warn"; reason: string };

/** One model's result that does not fail the converge, said as it comes. */
function sayVerdict(
  io: Io,
  model: string,
  verdict: { kind: "ok" } | { kind: "busy" | "warn" | "fault"; reason: string },
) {
  if (verdict.kind === "ok") activity(io, `provider: ${model} reachable, and it completed a tool call`);
  else if (verdict.kind === "busy") {
    activity(io, `warning: provider: ${model} answered with the key, but is busy — ${verdict.reason} (ADR-0064)`);
  } else if (verdict.kind === "warn")
    activity(io, `warning: provider: ${model} answered with the key — ${verdict.reason}`);
}

/** The models whose check began (`start` lines, `preflight-line.ts`): a model with a start and no
 * verdict was on when the pod stopped; a model with neither was never reached. */
export function checkStarts(output: string): Set<string> {
  const started = new Set<string>();
  for (const line of output.split("\n")) {
    const m = /^jr2\.preflight model=(\S+) start$/.exec(line.trim());
    if (m) started.add(m[1]!);
  }
  return started;
}

/** Each model's verdict, off the check container's output lines (`preflight-line.ts` in `@jr2/harness`, held
 * to this parser by a test). A line that is not a result is not a verdict. */
export function checkVerdicts(output: string): Map<string, CheckVerdict> {
  const verdicts = new Map<string, CheckVerdict>();
  for (const line of output.split("\n")) {
    const m = /^jr2\.preflight model=(\S+) (?:(ok)|(fault|busy|warn)=(.*))$/.exec(line.trim());
    if (!m) continue;
    verdicts.set(m[1]!, m[2] ? { kind: "ok" } : { kind: m[3] as "fault" | "busy" | "warn", reason: m[4]! });
  }
  return verdicts;
}

/**
 * Why a check pod said nothing of a model, from how it ended (`PodEnd`): the hint follows the reason
 * the kubelet gave, and the Custodian's own refusal line is quoted when it has one. Exported for its
 * test.
 */
export function podFault(
  end: PodEnd,
  checkPod: Pick<CheckPod, "where">,
  images: { harnessImage: string; custodianImage: string },
): string {
  const refusal = /jr2\.custodian refuse secret=\S+ reason=[\w-]+/.exec(end.custodian)?.[0];
  const said = end.reasons.length ? ` (${end.reasons.join("; ")})` : "";
  const stuck = end.stuck ?? "";
  if (/ErrImagePull|ImagePullBackOff|InvalidImageName/.test(stuck)) {
    return (
      `the check pod cannot start: ${stuck}${said} — a node on ${checkPod.where} cannot pull ` +
      `${stuck.startsWith("custodian") ? images.custodianImage : images.harnessImage}; check \`registry\` or ` +
      "`kitRegistry`, and that those nodes can pull from it"
    );
  }
  if (/CreateContainerConfigError/.test(stuck)) {
    // The env of the check container: what `harness.env` and `harness.envFrom` name.
    return (
      `the check pod cannot start: ${stuck}${said} — a Secret, a ConfigMap or a key that the Harness env names ` +
      "is missing (a `harness.envFrom` Secret, or a `harness.env` valueFrom)"
    );
  }
  if (stuck.startsWith("FailedMount")) {
    // A volume of the Custodian: a held secret's `valueFrom` Secret, or its key.
    return (
      `the check pod cannot start: ${stuck} — a Secret or a key that a \`secrets\` valueFrom names is missing ` +
      "in the Instance's namespace"
    );
  }
  const oom = [stuck, ...end.reasons].find((r) => /OOMKilled/.test(r));
  if (oom) {
    const custodian = oom.startsWith("custodian");
    return (
      `the check pod ran out of memory: ${oom}${said} — ` +
      (custodian
        ? `its Custodian has the Instance Harness Custodian's limit (${KIT_POD_SIZES.instanceCustodian.limits.memory})`
        : `the check container's limit is ${KIT_POD_SIZES.checkContainer.limits.memory}`) +
      "; a jr2 defect, not a fault of the provider"
    );
  }
  if (refusal || stuck.startsWith("custodian")) {
    return (
      `the check pod's Custodian did not start: ${refusal ?? stuck}${said} — a Custodian stops at start on a held ` +
      "value that is missing, empty or not printable ASCII"
    );
  }
  if (end.phase === "timeout") {
    return end.started
      ? `the check did not end in time${said}`
      : `the check pod did not start in ${CHECK_START_SECONDS}s${said} — no node on ${checkPod.where} fits it, or its image pulls are slow`;
  }
  if (!end.output.trim()) {
    return `the check pod ended ${end.phase}${said}, and jr2 up could not read its log — run \`jr2 up\` again`;
  }
  const tail = end.output.trim().split("\n").filter(Boolean).slice(-5).join("; ");
  return `the check pod ended ${end.phase} before it checked this model${said} — it said: ${tail}`;
}

/** One model's preflight failure: the model, the host, and the likely causes. */
function providerFault(p: CheckedProvider, model: string, where: string, fault: string, custodian: boolean): string {
  const hosts = p.hosts.join(", ") || `the host of "${p.id}"`;
  // A model that loads on first use (Ollama, a large vLLM model) can take longer than the bound.
  // Only where jr2 cannot know the endpoint: the custom provider, or a gateway.
  const slow =
    (p.custom || p.gateway) && /no answer in \d+ s|no verdict in \d+ s|time ran out/.test(fault)
      ? "  - a model that loads on first use can take longer than the check waits: run `jr2 up` again once it has loaded\n"
      : "";
  if (p.custom) {
    // The custom provider's own causes (ADR-0018): an endpoint jr2 knows nothing about but its url.
    return (
      `provider preflight failed for model "${model}" against ${hosts} (from a pod on ${where}, as a Turn calls it): ` +
      `${fault}\n` +
      slow +
      // A refused key: the endpoint answered, so the key comes first and the reach is not it.
      (refusedKey(fault)
        ? (p.keys.length
            ? `  - the held secret ${p.keys.join(" or ")} may be wrong (harness.provider.apiKey)\n`
            : "  - the endpoint wants a key: set harness.provider.apiKey\n") +
          "  - the model id must be exactly what the endpoint serves (vLLM: GET /v1/models)"
        : "  - localhost never works from a pod; use a LAN address\n" +
          "  - the model id must be exactly what the endpoint serves (vLLM: GET /v1/models)\n" +
          "  - vLLM needs --enable-auto-tool-choice and a matching --tool-call-parser\n" +
          '  - stop reason "length" means the model ran out of tokens before the call (a thinking model reasons first)' +
          (p.keys.length ? `\n  - the held secret ${p.keys.join(" or ")} may be wrong (harness.provider.apiKey)` : ""))
    );
  }
  const key = p.keys.length
    ? `  - the held secret ${p.keys.join(" or ")} may be empty, wrong, or without access to this model (\`secrets\` in jr2.config.ts)\n`
    : `  - no Harness pod on ${where} holds a key of "${p.id}": add its key to \`secrets\`` +
      (Object.keys(MODEL_KEYS).some((n) => MODEL_KEYS[n]!.providers.includes(p.id))
        ? ` (${Object.keys(MODEL_KEYS)
            .filter((n) => MODEL_KEYS[n]!.providers.includes(p.id))
            .join(" or ")}), or set in harness.env the credential that pi reads for it\n`
        : `, or set in harness.env the credential that pi reads for it; jr2 knows no key name of "${p.id}" ` +
          "(when pi does not know the id either, the line above says that it resolves to nothing)\n");
  // The likely cause first: a provider that refused the key answered, so the egress is not it.
  const egress = `  - the pods may have no egress to ${hosts} (a NetworkPolicy, a firewall, no route out of the cluster)\n`;
  const causes = refusedKey(fault) ? key : egress + key;
  return (
    `provider preflight failed for model "${model}" toward ${hosts} (from a pod on ${where}, ` +
    `${custodian ? "through a Custodian" : "direct"}, ` +
    `as a Turn calls it): ${fault}\n` +
    slow +
    causes +
    (p.gateway
      ? `  - harness.catalog.${p.id}.baseUrl (${p.gateway}) may not answer, or may not serve "${model.slice(p.id.length + 1)}" ` +
        "(a LiteLLM model_name alias)\n"
      : "") +
    "  - a private CA on that path must be in harness.caBundle"
  );
}

/** The layers this converge hands to the cluster, said out loud rather than silently skipped. */
function noteDeferred(io: Io, repos: CarriedRepo[]): void {
  if (repos.length) {
    activity(
      io,
      `repos: ${repos.length} bound Repo(s) — the Orchestrator creates their Repo resources at boot and at each publish (ADR-0069); the cache ` +
        "agent clones on first need (`jr2 status` reports sync state)",
    );
  }
}
