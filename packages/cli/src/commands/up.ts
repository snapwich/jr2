// `j2 up [--yes] [--force] [-n <ns>] [--context <ctx>]` (ADR-0019): idempotently converge the target
// namespace to this instance — every layer, loudly narrated, safe to re-run. Layers in order:
// ownership → image resolution → operator → kit images → instance image → Sandbox Images → agents
// ConfigMap → Secret (+ preflight of referenced Secrets) → apply + rollout → Instance Harness
// (ADR-0031: converged by convention when any definition declares `workspace: "none"`, deleted when
// none does) → a report of live workspaces still on an older image. Repos reconcile onto the
// in-cluster source volume at orchestrator boot (ADR-0004); a configured custom provider is
// preflighted from inside the cluster.
//
// Images (ADR-0038): `j2 up` builds every image it deploys, and every tag is a content address of
// its own inputs. In a kit CHECKOUT that includes the Harness, Adapter, and operator; installed
// from npm those sources do not resolve and the published `<kitversion>` refs are used with no
// docker at all. There is no `images` config block and no env escape hatch — nobody gets to point a
// real cluster at a hand-picked Harness (ADR-0027's no-eject-hatch, enforced rather than stated).
// The converged name→ref map is stamped on the Orchestrator Deployment and diffed on the next run,
// so a steady-state converge spends directory walks and no docker. When that record is silent (a
// fresh namespace), the host daemon's labeled listing answers the BUILD question instead
// (ADR-0041): a tag is a content address, so a host-held ref skips its build — never its delivery.
//
// Content addressing also MAKES garbage — iterating on a Dockerfile while up leaves one full image
// per iteration — so a converge that fully succeeded ends by sweeping every labeled image no live
// root names (ADR-0039). It runs here, and not only at `j2 down`, because here is where the garbage
// is made: the moment this converge's map replaces the last one is the moment the old generation
// stops being reachable.
//
// Addressing (ADR-0019): cluster = the current kube context (never recorded); namespace =
// `config.name` (identity). Whether this cluster hosts the instance is derived FROM the cluster:
// labeled objects found → converge silently (it's home); nothing → confirm first-time setup
// (`--yes` for CI); objects labeled as a DIFFERENT instance → refuse.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  discoverImages,
  loadAgents,
  loadConfig,
  sandboxToken,
  type DiscoveredAgent,
  type ImageRefs,
  type J2Config,
} from "@j2/orchestrator";
import {
  buildSandboxImage,
  detectKitCheckout,
  instanceImageLabels,
  kitImageBuild,
  kitImageRefs,
  normalizeRef,
  pnpmDockerBuild,
  publishedKitRefs,
  sandboxImageHash,
  sandboxImageTag,
  stageInstanceBundle,
  INSTANCE_DOCKERFILE,
  type BuildPort,
  type KitImageName,
  type KitImageRefs,
} from "../build.ts";
import {
  ANNOTATION_IMAGES,
  compareVersions,
  GIT_SSH_SECRET,
  INSTANCE_HARNESS_SERVICE,
  instanceHarnessObjects,
  instanceObjects,
  KIT_VERSION,
  LABEL_HASH,
  LABEL_INSTANCE,
  LABEL_VERSION,
  OPERATOR_DEPLOYMENT,
  OPERATOR_NAMESPACE,
  OPERATOR_SELECTOR,
  operatorManifest,
} from "../deploy.ts";
import { resolveRoot } from "../instance.ts";
import { kubectlAdmin, ORCHESTRATOR_SERVICE, type KubeAdmin, type KubeObject } from "../kube.ts";
import { activity, confirmOrBail, type Io } from "../output.ts";
import { kindCluster, sweepImages } from "../sweep.ts";

export async function up(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      yes: { type: "boolean" },
      force: { type: "boolean" },
      namespace: { type: "string", short: "n" },
      context: { type: "string" },
    },
  });

  const root = resolveRoot(io.cwd);
  const config = (await loadConfig(root)) ?? {};
  const name = config.name ?? basename(root);
  const namespace = (values.namespace as string | undefined) ?? name;
  const kube = io.kubeAdmin ?? kubectlAdmin;
  const context = (values.context as string | undefined) ?? (await kube.context());
  if (!context) {
    throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then re-run `j2 up`");
  }
  const ctx = values.context ? { context: values.context as string } : {};

  activity(io, `j2 up — instance "${name}" → context ${context} / namespace ${namespace}`);

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

  // --- image resolution (ADR-0038): decide every ref BEFORE any layer spends a build -----------
  const build = io.build ?? pnpmDockerBuild;
  const registry = config.registry;
  const cluster = kindCluster(context);
  // The CHECKOUT is the signal — no flag, no config key, no env (ADR-0038). `io.kitDir` exists so
  // tests can drive both worlds from a temp dir instead of detecting the repo they run inside.
  const kitRoot = await detectKitCheckout(io.kitDir);
  const refs: KitImageRefs = kitRoot ? await kitImageRefs(kitRoot, registry) : publishedKitRefs();
  activity(
    io,
    kitRoot
      ? `images: kit checkout at ${kitRoot} — building the Harness, Adapter, and operator from source`
      : `images: installed kit — the published v${KIT_VERSION} Harness, Adapter, and operator`,
  );

  // Read the Orchestrator Deployment ONCE: it carries both convergence records — the instance
  // image's content hash (a label) and the previous name→ref map (an annotation, ADR-0038).
  const orch = await kube.getJson({ kind: "deployment", name: ORCHESTRATOR_SERVICE, namespace, ...ctx });
  const previous = previousImages(orch);
  const converged: ConvergedImages = { harness: refs.harness, adapter: refs.adapter, sandbox: {}, sandboxUser: {} };

  // ONE transport branch for every image (ADR-0038), so instance, kit, and Sandbox Images cannot
  // drift into three delivery stories.
  const deliver = async (tag: string): Promise<void> => {
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
  // wearing the right name is invisible and the build proceeds — what j2 did not stamp, j2 does
  // not trust. The disk never answers the DELIVERY question: a disk-skip still delivers (`kind
  // load` skips a node already holding the id; a push is idempotent), and a record hit still
  // skips both.
  // A listing that FAILS reads as "holds nothing": this check may only ever save a build, never
  // add a failure mode — a truly dead daemon fails at the build that follows, with docker's own
  // error naming it (the sweep makes the same read later and degrades to its own warning).
  let hostHeldOnce: Promise<Set<string>> | undefined;
  const hostHeld = (): Promise<Set<string>> =>
    (hostHeldOnce ??= build
      .hostImages()
      .then((images) => new Set(images.flatMap((i) => i.tags.map(normalizeRef))))
      .catch(() => new Set<string>()));
  const hostBuilt = async (ref: string): Promise<boolean> =>
    values.force !== true && (await hostHeld()).has(normalizeRef(ref));

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
    if (await hostBuilt(ref)) {
      activity(io, `${which} image: ${ref} (host-built — build skipped, delivering; --force to rebuild)`);
      await deliver(ref);
      return ref;
    }
    activity(io, `${which} image: building ${ref}${values.force === true ? " (--force)" : ""}`);
    await build.build(kitImageBuild(kitRoot, which, ref));
    await deliver(ref);
    return ref;
  };

  // --- operator (per-cluster, shared) ------------------------------------------------------------
  if (config.operator?.manage === false) {
    activity(io, "operator: skipped (operator.manage: false — run the controller loop yourself)");
  } else {
    const image = await ensureKitImage("operator");
    converged.operator = image;
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
      await kube.apply({ manifest: await operatorManifest(image), ...ctx });
      await kube.label({
        kind: "deployment",
        name: OPERATOR_DEPLOYMENT,
        namespace: OPERATOR_NAMESPACE,
        labels: { [LABEL_VERSION]: KIT_VERSION },
        ...ctx,
      });
      await kube.waitRollout({ deployment: OPERATOR_DEPLOYMENT, namespace: OPERATOR_NAMESPACE, ...ctx });
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

  // --- the kit's own runtime images (ADR-0038) ---------------------------------------------------
  // Built here rather than lazily beside their consumers. The Harness is the injection source
  // (ADR-0037): the pod's `runtime` init step copies `/opt/j2` out of this exact ref onto the
  // volume the Sandbox Image mounts. The Adapter is deployed into every Sandbox this instance
  // provisions. Neither is a hash input for a Sandbox Image — the runtime rides the pod's volume,
  // so a kit edit re-images future pods and re-tags nothing of the user's.
  await ensureKitImage("harness");
  await ensureKitImage("adapter");

  // --- instance image (content-addressed by the bundle) ------------------------------------------
  // Stage first, THEN decide: the hash is over the materialized bundle — the actual image inputs,
  // kit included — so the tag is a content address rather than a guess about what changed.
  const staged = await stageInstanceBundle(build, root);
  const hash = staged.hash;
  const tag = registry ? `${registry}/j2-instance-${name}:${hash}` : `j2-instance-${name}:${hash}`;
  try {
    if (orch?.metadata.labels?.[LABEL_HASH] === hash && values.force !== true) {
      // Safe to skip only because the rolled-out pod is verified against `tag` below: this decides
      // whether to spend a docker build, not whether the cluster is already correct.
      activity(io, `image: ${tag} (fresh — build skipped; --force to rebuild anyway)`);
    } else {
      assertDeliverable();
      if (await hostBuilt(tag)) {
        activity(io, `image: ${tag} (host-built — build skipped, delivering; --force to rebuild)`);
        await deliver(tag);
      } else {
        activity(io, `image: building ${tag}${values.force === true ? " (--force)" : ""}`);
        await build.build({
          tag,
          context: staged.dir,
          dockerfileContent: INSTANCE_DOCKERFILE,
          labels: instanceImageLabels(name),
        });
        await deliver(tag);
      }
    }
  } finally {
    await staged.dispose();
  }

  // --- Sandbox Images (ADR-0037): the instance's own `images/<name>/Dockerfile` -------------------
  // Gated on `repos`, which is already the data-plane switch (ADR-0012/0031): a workspace-less
  // instance has no Sandboxes, so it must not pay a docker build for a scaffolded image it can
  // never use. Said out loud, because a silent skip of a folder you just wrote reads as a bug.
  if (config.repos?.length) {
    const images = await discoverImages(root);
    if (images.length === 0) {
      activity(io, "sandbox images: none authored (add images/<name>/Dockerfile — Sandboxes run the stock Harness)");
    }
    for (const image of images) {
      // The hash covers `images/<name>/` and nothing else (ADR-0037/0038). The harness ref is NOT
      // an input any more: the runtime rides the pod's volume, so a kit edit re-images future
      // pods and leaves every Sandbox Image tag — and every delivered layer — where it was.
      const imageHash = await sandboxImageHash(image.dir);
      const ref = sandboxImageTag(name, image.name, imageHash, registry);
      // A record is only worth skipping on when it is COMPLETE: the ref AND the seat the image
      // declared. A record from a kit that predates `sandboxUser` names the right image and
      // silently drops the fallback fact, which surfaces as a pod that will not start — so it reads
      // as stale here and the image is re-inspected (the host skip below then spends no build).
      const remembered = previous?.sandboxUser?.[image.name];
      if (previous?.sandbox?.[image.name] === ref && remembered !== undefined && values.force !== true) {
        // Unlike the instance image there is no rollout to verify a Sandbox Image against, so a
        // recorded-but-absent ref only shows up as ImagePullBackOff at the next provision —
        // `--force` rebuilds and re-delivers it. The seat is carried forward from the same record:
        // the tag is a content address, so the image the record names declares what it declared.
        activity(io, `sandbox image "${image.name}": ${ref} (fresh — build skipped; --force to rebuild anyway)`);
        converged.sandboxUser[image.name] = remembered;
      } else {
        assertDeliverable();
        if (await hostBuilt(ref)) {
          // A tag is a content address, so a host-held ref is this Dockerfile already built
          // (ADR-0041). Delivery still happens below — the disk answers the build question only.
          activity(io, `sandbox image "${image.name}": ${ref} (host-built — build skipped; --force to rebuild)`);
        } else {
          activity(io, `sandbox image "${image.name}": building ${ref}`);
          // ONE build of the user's own Dockerfile, straight to its content tag — no wrap, no
          // intermediate tag, so two converges of one checkout share no mutable image name and
          // the `@kind` tier's `--parallel` rides on it (ADR-0037).
          await buildSandboxImage(build, { dir: image.dir, tag: ref, instance: name });
        }
        // The image's own `USER`, read while the image is certainly on this daemon (it was just
        // built, or the host holds it). Recorded because a provision cannot inspect an image, and
        // it is what decides ADR-0037's uid-1000 fallback and what the kubelet will refuse. This
        // is a fact ABOUT the image, not a judgement of it: the ADR-0037 floor is a Harness-seat
        // obligation and this directory may be destined for the User Container seat instead
        // (ADR-0005), which owes no floor — a distinction only the provision can make (ADR-0031).
        const user = await build.imageUser(ref);
        converged.sandboxUser[image.name] = user;
        activity(io, `  ${user ? `USER ${user}` : "no USER declared — the pod's uid-1000 fallback applies"}`);
        await deliver(ref);
      }
      converged.sandbox[image.name] = ref;
    }
  } else {
    activity(io, "sandbox images: skipped (no `repos` — a workspace-less instance provisions no Sandbox)");
  }

  // --- agents + secrets --------------------------------------------------------------------------
  const agents = await loadAgents(root);
  activity(io, `agents: ${agents.map((a) => a.name).join(", ") || "(none)"}`);

  // Idempotence: the token + signing key persist across re-runs (live Sandboxes bear tokens the
  // key signed — ADR-0013), minted only on first converge.
  const secret = await kube.getJson<KubeObject & { data?: Record<string, string> }>({
    kind: "secret",
    name: "j2-instance",
    namespace,
    ...ctx,
  });
  const keep = (key: string, mint: () => string): string =>
    secret?.data?.[key] ? Buffer.from(secret.data[key], "base64").toString("utf8") : mint();
  const instanceToken = keep("J2_INSTANCE_TOKEN", () => randomBytes(24).toString("hex"));
  const signingKey = keep("J2_SIGNING_KEY", () => randomBytes(32).toString("base64"));
  const secretData: Record<string, string> = {
    J2_INSTANCE_TOKEN: instanceToken,
    J2_SIGNING_KEY: signingKey,
    // The Instance Harness Adapter's credential (ADR-0013/0031): a sandbox-style token signed
    // for the placement's name — it may deliver only to Turns hosted THERE (tokens.ts), so the
    // Instance token never enters that pod. Derived from the kept key, so re-runs converge to
    // the same value; live Adapters keep verifying.
    J2_INSTANCE_HARNESS_TOKEN: sandboxToken(Buffer.from(signingKey, "base64"), INSTANCE_HARNESS_SERVICE),
  };
  // Git creds for the in-cluster repos reconcile (ADR-0019): an HTTPS token from `.env` is the
  // default path for private repos. It rides the ORCHESTRATOR's Secret — never the harness one.
  if (io.env.J2_GIT_TOKEN) secretData.J2_GIT_TOKEN = io.env.J2_GIT_TOKEN;

  // The HARNESS containers' env — a separate Secret (ADR-0013): Agent code executes where these
  // land, so the Instance token/signing key above must be unreachable from it. Values declared in
  // config (usually read off process.env/.env) materialize here (ADR-0019); so does the provider
  // key — the ConfigMap'd agents spec carries the provider MINUS this (ADR-0018).
  const harnessEnvData: Record<string, string> = {};
  for (const v of config.harness?.env ?? []) if (v.value !== undefined) harnessEnvData[v.name] = v.value;
  if (config.harness?.provider?.apiKey) harnessEnvData.J2_PROVIDER_API_KEY = config.harness.provider.apiKey;

  // Preflight referenced-but-unmanaged Secrets: turn the CreateContainerConfigError hang into an
  // immediate, named error (ADR-0019). Sealed/External Secrets ride this seam untouched.
  for (const ref of config.harness?.envFrom ?? []) {
    const refName = ref.secretRef?.name;
    if (!refName) continue;
    if (!(await kube.getJson({ kind: "secret", name: refName, namespace, ...ctx }))) {
      throw new Error(
        `harness.envFrom references Secret "${refName}", which does not exist in namespace "${namespace}" — ` +
          `create it first: kubectl -n ${namespace} create secret generic ${refName} --from-literal=KEY=...`,
      );
    }
  }

  // --- private-CA bundle (ADR-0020): read HERE, host-side — the in-cluster config eval never
  // touches the file (the path may not exist there); consumers get the ConfigMap.
  const caPem = await readCaBundle(root, config);

  // --- git over ssh: the deploy-key offer (ADR-0019) ---------------------------------------------
  await ensureGitSsh(io, kube, config, namespace, ctx, values.yes === true);

  // --- provider preflight (ADR-0019): probe the endpoint FROM INSIDE the cluster ----------------
  await preflightProvider(io, kube, config, agents, namespace, ctx, caPem);

  // --- apply + rollout ---------------------------------------------------------------------------
  activity(io, `orchestrator: applying (image ${tag})`);
  await kube.apply({
    manifest: instanceObjects({
      name,
      namespace,
      image: tag,
      hash,
      secretData,
      harnessEnvData,
      agents,
      harness: config.harness,
      caBundle: caPem,
      imageRefs: converged,
    }),
    ...ctx,
  });
  activity(io, "orchestrator: waiting for rollout");
  await kube.waitRollout({ deployment: ORCHESTRATOR_SERVICE, namespace, ...ctx });
  await verifyRunningImage(io, kube, {
    layer: "orchestrator",
    namespace,
    selector: `app=${ORCHESTRATOR_SERVICE}`,
    image: tag,
    ...ctx,
  });

  // --- Instance Harness (ADR-0031): converged by convention, never by config ---------------------
  // The scan is static and DEFINITION-level (the line ADR-0018 drew: workflow internals are not
  // statically recoverable) — a declared-but-never-invoked `"none"` Agent over-deploys, erring
  // toward "the convention works when you need it". No `"none"` definitions → nothing, and a
  // stale Deployment from a definition that dropped its `"none"` is deleted: the layer converges
  // toward the definitions like every other layer converges toward the config.
  const menuOnly = agents.filter((a) => a.definition.workspace === "none");
  if (menuOnly.length > 0) {
    activity(
      io,
      `instance harness: converging (${menuOnly.map((a) => a.name).join(", ")} declare${menuOnly.length === 1 ? "s" : ""} workspace: "none")`,
    );
    const harnessImage = refs.harness;
    await kube.apply({
      manifest: instanceHarnessObjects({
        name,
        namespace,
        harnessImage,
        adapterImage: refs.adapter,
        harness: config.harness,
        caBundle: caPem !== undefined,
        // The echo gate (ADR-0023): the digest of the token materialized above — the same env
        // the orchestrator stamps onto every Sandbox Harness at provision.
        echoTokenSha256: createHash("sha256").update(instanceToken).digest("base64url"),
      }),
      ...ctx,
    });
    await kube.waitRollout({ deployment: INSTANCE_HARNESS_SERVICE, namespace, ...ctx });
    await verifyRunningImage(io, kube, {
      layer: "instance harness",
      namespace,
      selector: `app=${INSTANCE_HARNESS_SERVICE}`,
      image: harnessImage,
      container: "harness",
      ...ctx,
    });
  } else {
    await kube.deleteObject({ kind: "deployment", name: INSTANCE_HARNESS_SERVICE, namespace, ...ctx });
    await kube.deleteObject({ kind: "service", name: INSTANCE_HARNESS_SERVICE, namespace, ...ctx });
  }

  await reportOlderWorkspaces(io, kube, namespace, ctx, converged);
  await sweepAfterConverge(io, { build, kube, context, ctx, converged, instanceImage: tag, previous });
  noteDeferred(io, config);
  activity(io, `converged — \`j2 run <workflow>\` when ready`);
  return 0;
}

/**
 * Every image ref one converge resolved. The Orchestrator reads `harness`/`adapter`/`sandbox` from
 * the mounted map (`ImageRefs`); `operator` rides the same JSON because the record `j2 up` diffs
 * must cover every image it builds, and one map is what keeps the record it diffs and the map pods
 * read from ever disagreeing (ADR-0038).
 *
 * `sandboxUser` is the same map's answer to a question a provision cannot ask: an image that
 * declares no `USER` runs as uid 1000 with `HOME=/home/j2` on an emptyDir (ADR-0037), and only the
 * host that BUILT the image can see which case it is (`docker inspect` at converge is free; the
 * cluster has no such reach). So the fact travels with the ref, in the same JSON, keyed by the same
 * `images/<name>` dirname: `""` means "declares none — apply the fallback", a non-empty value is
 * the declared user, and an ABSENT key means unknown, which is the only honest reading for an image
 * j2 did not build. A registry ref is exactly that absent case by construction — it is never built,
 * never inspected, never in this map — so it runs as whatever its own `USER` says, and one that
 * would run as root fails the Harness container's `runAsNonRoot` at provision.
 */
type ConvergedImages = ImageRefs & { operator?: string; sandboxUser: Record<string, string> };

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
  return [map.harness, map.adapter, map.operator, ...Object.values(map.sandbox ?? {})].filter(
    (ref): ref is string => typeof ref === "string",
  );
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
 * unreachable. `grace` is the map this converge REPLACED, and it is node-only: the `j2-images`
 * ConfigMap reaches a Sandbox through a kubelet propagation window, so for one more round a
 * provision can still ask a node for a ref the new map no longer names. The host has no such
 * window — nothing is ever provisioned from it — so it is swept aggressively.
 *
 * A failure here is a WARNING. The instance is converged, which is what `up` promised; disk is not
 * that promise, and the next `j2 up` or `j2 gc` collects whatever this run could not.
 */
async function sweepAfterConverge(
  io: Io,
  opts: {
    build: BuildPort;
    kube: KubeAdmin;
    context: string;
    ctx: { context?: string };
    converged: ConvergedImages;
    instanceImage: string;
    previous?: Partial<ConvergedImages>;
  },
): Promise<void> {
  const { build, kube, context, ctx, converged, instanceImage, previous } = opts;
  try {
    await sweepImages({
      io,
      build,
      kube,
      context,
      ctx,
      // The instance image rides `extraKeep` explicitly: it is the one ref this converge resolved
      // that the image map does not carry (it is the Deployment's own, ADR-0038).
      extraKeep: [instanceImage, ...mapRefs(converged)],
      grace: previous ? mapRefs(previous) : [],
    });
  } catch (err) {
    activity(io, `images: sweep skipped (${err instanceof Error ? err.message : err}) — the converge stands`);
  }
}

/** The one delivery failure that is a configuration error rather than a docker one (ADR-0019). */
function undeliverable(context: string): Error {
  return new Error(
    `context ${context} is not a kind cluster and no \`registry\` is configured — ` +
      `set \`registry\` in j2.config.ts (from env) so the image can be pushed (ADR-0019)`,
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
      kind: "sandboxes.core.j2.dev",
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
 * Convergence is a claim about the CLUSTER, so it is checked against the cluster (ADR-0019): after
 * a rollout, the pod actually serving must carry the image this run intended. Without this, `up`
 * reported success off the content-hash label it had just written — and a Deployment whose pod
 * template never moved (stale image, no rollout) printed `converged` while running old code.
 *
 * Tag equality is the whole check, which is only sound because the tag IS the content address (see
 * `stageInstanceBundle`): on the `kind load` path a pod's `imageID` is containerd's manifest digest
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
  // (the Instance Harness pod also carries the Adapter, which is not this check's business).
  const stale = live.filter((p) =>
    p.spec.containers.some((c) => (container === undefined || c.name === container) && c.image !== image),
  );
  if (stale.length > 0) {
    const carried = stale[0]!.spec.containers.map((c) => c.image).join(", ");
    throw new Error(
      `${layer}: rollout reported success, but the running pod carries ${carried} — expected ${image}. ` +
        `The cluster is serving code this converge did not deploy; ` +
        `\`kubectl -n ${opts.namespace} rollout restart deploy\` and re-run \`j2 up\` to resolve it.`,
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

/**
 * ssh repo urls need a key the CLUSTER holds (ADR-0019): personal keys never enter a cluster, so
 * with no `j2-git-ssh` Secret present, `up` OFFERS to generate a fresh in-cluster deploy keypair
 * and prints the public key to register with the git host. Declining bails — the reconcile would
 * only hang on an unauthenticated fetch later.
 */
async function ensureGitSsh(
  io: Io,
  kube: KubeAdmin,
  config: J2Config,
  namespace: string,
  ctx: { context?: string },
  yes: boolean,
): Promise<void> {
  const sshUrls = (config.repos ?? []).filter((r) => /^(git@|ssh:\/\/)/.test(r.url));
  if (sshUrls.length === 0) return;
  if (await kube.getJson({ kind: "secret", name: GIT_SSH_SECRET, namespace, ...ctx })) return;

  const ok =
    yes ||
    (await confirmOrBail(
      io,
      `repos ${sshUrls.map((r) => r.name).join(", ")} use ssh urls and no "${GIT_SSH_SECRET}" Secret exists — ` +
        `generate a fresh in-cluster deploy keypair? (personal keys never enter a cluster)`,
    ));
  if (!ok) {
    throw new Error(
      `ssh repos need a "${GIT_SSH_SECRET}" Secret — accept the generated deploy key, create the Secret ` +
        `yourself, or switch the repo urls to https (+ J2_GIT_TOKEN in .env)`,
    );
  }

  const { privateKey, publicKey } = await (io.sshKeygen ?? sshKeygen)();
  await kube.apply({
    manifest: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: GIT_SSH_SECRET, namespace },
      type: "Opaque",
      stringData: { key: privateKey, "key.pub": publicKey },
    }),
    ...ctx,
  });
  activity(io, `generated deploy key — register this PUBLIC key with your git host (read access):`);
  activity(io, `  ${publicKey.trim()}`);
}

/** Generate an ed25519 keypair with ssh-keygen (no passphrase — it lives only in the Secret). */
async function sshKeygen(): Promise<{ privateKey: string; publicKey: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "j2-ssh-"));
  try {
    await promisify(execFile)("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "j2-git-ssh", "-f", join(dir, "key")]);
    return {
      privateKey: await readFile(join(dir, "key"), "utf8"),
      publicKey: await readFile(join(dir, "key.pub"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `harness.caBundle` (ADR-0020): a path relative to the instance folder, read host-side by `up`
 * alone. Loud on a missing file — a silently absent CA turns up later as a TLS failure inside a
 * pod, the exact hang-shaped outcome preflights exist to prevent.
 */
async function readCaBundle(root: string, config: J2Config): Promise<string | undefined> {
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
 * The custom-provider preflight (ADR-0019): from a pod, list models AND demand one trivial
 * tool-call completion — so an unreachable endpoint (localhost never works from a pod) or a vLLM
 * missing `--enable-auto-tool-choice` fails HERE, at converge time, not as an `agent.fault`
 * mid-run. Reachability itself stays the user's concern; this makes the answer immediate.
 */
async function preflightProvider(
  io: Io,
  kube: KubeAdmin,
  config: J2Config,
  agents: DiscoveredAgent[],
  namespace: string,
  ctx: { context?: string },
  caPem?: string,
): Promise<void> {
  const provider = config.harness?.provider;
  if (!provider) return;
  // The DEFINITIONS name the models (ADR-0018), so probe the ones that will actually
  // run, not one instance-wide default. "vllm/Qwen/Qwen3-32B" → the endpoint's model id is
  // everything after the provider prefix; a definition on a different provider is not this
  // endpoint's business. A workflow's per-turn dial cannot be probed here — invoke `input` is a
  // function, so it is not statically recoverable; it is checked at admission instead.
  const prefix = `${provider.id}/`;
  const models = [
    ...new Set(
      agents
        .map((a) => a.definition.model)
        .filter((m) => m.startsWith(prefix))
        .map((m) => m.slice(prefix.length)),
    ),
  ];
  if (models.length === 0) {
    activity(io, `provider: ${provider.baseUrl} configured, but no Agent names a "${provider.id}/…" model — skipped`);
    return;
  }
  for (const model of models) {
    activity(io, `provider: probing ${provider.baseUrl} from inside the cluster (model ${model})`);
    const script = providerProbeScript(provider.baseUrl, model, provider.apiKey);
    try {
      // caPem: the probe trusts the instance's CA bundle exactly like the Harness will (ADR-0020) —
      // a preflight that fails where the Harness would succeed is a broken promise, and vice versa.
      await kube.runOneShot({ namespace, name: `j2-provider-preflight-${Date.now() % 100000}`, script, caPem, ...ctx });
      activity(io, `provider: ${model} reachable, and it completed a tool call`);
    } catch (err) {
      throw new Error(
        `provider preflight failed for model "${model}" against ${provider.baseUrl} (from inside the cluster): ` +
          `${err instanceof Error ? err.message : err}\n` +
          `  - localhost never works from a pod; use a LAN address\n` +
          `  - the model id must be exactly what the endpoint serves (vLLM: GET /v1/models)\n` +
          `  - vLLM needs --enable-auto-tool-choice and a matching --tool-call-parser`,
      );
    }
  }
}

/** The in-cluster probe: GET /models, then one chat completion that must answer with tool_calls. */
function providerProbeScript(baseUrl: string, model: string, apiKey?: string): string {
  const base = JSON.stringify(baseUrl.replace(/\/+$/, ""));
  const headers = apiKey
    ? `{ "content-type": "application/json", authorization: "Bearer " + ${JSON.stringify(apiKey)} }`
    : `{ "content-type": "application/json" }`;
  return (
    `const h = ${headers};` +
    `const m = await fetch(${base} + "/models", { headers: h });` +
    `if (!m.ok) throw new Error("GET /models: HTTP " + m.status);` +
    `const c = await fetch(${base} + "/chat/completions", { method: "POST", headers: h, body: JSON.stringify({` +
    ` model: ${JSON.stringify(model)}, max_tokens: 64,` +
    ` messages: [{ role: "user", content: "Call the ping tool." }],` +
    ` tools: [{ type: "function", function: { name: "ping", description: "reply with a ping", parameters: { type: "object", properties: {} } } }]` +
    ` }) });` +
    `const j = await c.json();` +
    `if (!c.ok) throw new Error("POST /chat/completions: HTTP " + c.status + " " + JSON.stringify(j).slice(0, 300));` +
    `const calls = j.choices?.[0]?.message?.tool_calls;` +
    `if (!calls?.length) throw new Error("completion carried no tool_calls");` +
    `console.log("PROVIDER OK");`
  );
}

/** The layers this slice defers, said out loud rather than silently skipped. */
function noteDeferred(io: Io, config: J2Config): void {
  if (config.repos?.length) {
    activity(io, `repos: ${config.repos.map((r) => r.name).join(", ")} reconcile at orchestrator boot (in-cluster)`);
  }
}
