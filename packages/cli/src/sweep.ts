// The reachability half of image garbage collection (ADR-0039). `build.ts` owns the two stores'
// physics — what the host daemon and a kind node's containerd hold, and the pure policy over them —
// and knows nothing about Kubernetes. This module is the other half: an image is needed iff a LIVE
// ROOT names it, and every root is a Kubernetes object.
//
// The three roots, all read CLUSTER-WIDE (not "my namespace" — a ref another instance's map names
// is not this instance's garbage):
//   1. the `jr2-images` ConfigMap of every jr2 instance (namespaces labeled `jr2.dev/instance`) — what
//      FUTURE Sandboxes will be provisioned with;
//   2. every Sandbox CR's `spec.image` in those namespaces — a parked Workspace must survive a pod
//      restart, and `imagePullPolicy: IfNotPresent` cannot re-pull a local tag;
//   3. every pod's container images in those namespaces plus `jr2-system` — what is actually running
//      (orchestrator, Instance Harness, Adapter, Sandboxes, operator), mid-roll pods INCLUDED,
//      without naming Deployments one by one.
// The keep set is their union. "Kit images are never pruned" is not a rule here: a kit ref is kept
// because some instance's map or pod names it, and collects like anything else when the last
// instance leaves the cluster.
//
// The roots read FAILS CLOSED. A partial root set is not a smaller keep set, it is a WRONG one —
// every ref it failed to see reads as garbage — so any error throws and the caller sweeps nothing.
// This is also why the `jr2-images` read goes through `listJson`, which throws, rather than
// `getJson`, which turns every failure into "absent". The single exception is not a degradation at
// all: a cluster with no Sandbox CRD holds no Sandbox CRs, so that read's "none" is complete (see
// `listSandboxes`).
//
// Accepted, and written down so nobody adds a name filter to "fix" it (ADR-0039): the host keep set
// only sees the CURRENT context's roots, so a second checkout converging to a different cluster can
// have its host kit generation swept. The rebuild is BuildKit-cached seconds. Re-introducing a name
// filter would resurrect the exact primitive this ADR deletes.

import { IMAGES_CONFIGMAP, IMAGES_KEY } from "@jr2/orchestrator";
import { formatBytes, mergeSweeps, sweepHost, sweepNodes, type BuildPort, type SweepResult } from "./build.ts";
import { LABEL_INSTANCE, OPERATOR_NAMESPACE } from "./deploy.ts";
import { isMissingResourceType, type KubeAdmin } from "./kube.ts";
import { activity, type Io } from "./output.ts";

/** The Sandbox CR, fully qualified so the read cannot collide with another `sandboxes` resource. */
const SANDBOX_KIND = "sandboxes.core.jr2.dev";

/** A kube context addresses a kind cluster by convention: `kind-<cluster>`. The node half of the
 * sweep is kind-only — elsewhere the nodes pull from a registry, whose retention is the registry's
 * business (ADR-0038's line, kept) — while the host half runs wherever the CLI does. */
const KIND_CONTEXT_PREFIX = "kind-";

/** The cluster `kind` knows this context by, or undefined when the context is not a kind one. */
export function kindCluster(context: string): string | undefined {
  return context.startsWith(KIND_CONTEXT_PREFIX) ? context.slice(KIND_CONTEXT_PREFIX.length) : undefined;
}

/** What the cluster's live roots name. `namespaces` is the instance namespaces the read found —
 * the scope every other root was narrowed to, worth reporting in a dry run. */
export type Roots = { keep: Set<string>; namespaces: string[] };

type NamespacedObject = { metadata: { name: string; namespace?: string } };
type ConfigMapObject = NamespacedObject & { data?: Record<string, string> };
type SandboxObject = NamespacedObject & { spec?: { image?: string; sidecars?: ContainerSpec[] } };
type ContainerSpec = { image?: string };
type PodObject = NamespacedObject & {
  spec?: {
    containers?: ContainerSpec[];
    initContainers?: ContainerSpec[];
    ephemeralContainers?: ContainerSpec[];
  };
};

/**
 * Assemble the keep set from the cluster's three roots. Throws if any read fails — see the
 * fail-closed rule at the top of this module.
 *
 * Terminating pods are deliberately NOT filtered out (the opposite of `up`'s `verifyRunningImage`,
 * which asks what the cluster runs NOW). A keep set is asked a different question: for a mid-roll
 * pod, "still holds this image" is the true and conservative answer, and the ref collects on the
 * next sweep once the pod is gone.
 */
export async function readRoots(kube: KubeAdmin, ctx: { context?: string } = {}): Promise<Roots> {
  // A bare-key selector: every namespace that belongs to SOME instance, whichever they are.
  const namespaces = (await kube.listJson({ kind: "namespace", selector: LABEL_INSTANCE, ...ctx })).map(
    (n) => n.metadata.name,
  );
  const instanceNs = new Set(namespaces);
  const keep = new Set<string>();

  // 1. what future Sandboxes will run.
  const maps = await kube.listJson<ConfigMapObject>({
    kind: "configmap",
    fieldSelector: `metadata.name=${IMAGES_CONFIGMAP}`,
    allNamespaces: true,
    ...ctx,
  });
  for (const cm of maps) {
    if (!instanceNs.has(cm.metadata.namespace ?? "")) continue;
    for (const ref of imageMapRefs(cm)) keep.add(ref);
  }

  // 2. what a parked Workspace's pod will be recreated with — the Sandbox Image AND every sidecar's
  // ref. The CR always carries the Adapter as a sidecar (sandbox-kubectl.ts), and its ref is not
  // covered by the other roots: a running Sandbox is deliberately never re-imaged, so an `up` that
  // rebuilt the Adapter leaves the CR naming the OLD one while the map names the new. If that pod
  // is then lost (node restart, eviction, drain), the recreated one pulls the CR's sidecar ref —
  // and `IfNotPresent` cannot re-pull a local tag a sweep took.
  const sandboxes = await listSandboxes(kube, ctx);
  for (const sandbox of sandboxes) {
    if (!instanceNs.has(sandbox.metadata.namespace ?? "")) continue;
    if (sandbox.spec?.image) keep.add(sandbox.spec.image);
    for (const sidecar of sandbox.spec?.sidecars ?? []) {
      if (sidecar.image) keep.add(sidecar.image);
    }
  }

  // 3. what is running right now — plus the operator, which lives in the shared `jr2-system`.
  const pods = await kube.listJson<PodObject>({ kind: "pod", allNamespaces: true, ...ctx });
  for (const pod of pods) {
    const ns = pod.metadata.namespace ?? "";
    if (!instanceNs.has(ns) && ns !== OPERATOR_NAMESPACE) continue;
    const spec = pod.spec ?? {};
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])]) {
      if (c.image) keep.add(c.image);
    }
  }

  return { keep, namespaces };
}

/**
 * Root #2's read, with the ONE degradation the fail-closed rule allows: a cluster that has no
 * `sandboxes.core.jr2.dev` resource type can hold no Sandbox CRs, so "no Sandboxes" is the complete
 * answer rather than a partial one, and the keep set it feeds is right.
 *
 * The case is the sweep's own doing, not a hypothetical: `jr2 down --all` deletes the operator
 * manifest — the CRD with it — and only then sweeps, which is the very case ADR-0039 cites for
 * collecting kit images. `jr2 gc` meets it too, on any cluster the operator never reached (recreate
 * the kind cluster, then "disk is full now"). Every OTHER failure still throws: Forbidden and an
 * unreachable API did hide Sandboxes that exist.
 */
async function listSandboxes(kube: KubeAdmin, ctx: { context?: string }): Promise<SandboxObject[]> {
  try {
    return await kube.listJson<SandboxObject>({ kind: SANDBOX_KIND, allNamespaces: true, ...ctx });
  } catch (err) {
    if (isMissingResourceType(err)) return [];
    throw err;
  }
}

/** Every ref one instance's image map names: the kit's own at the top level (`harness`, `adapter`,
 * and the `operator` that rides the same JSON), and each Sandbox Image under `sandbox`. An
 * unreadable map is a FAILED root, not an empty one — a hand-edited ConfigMap must not be read as
 * "that instance needs nothing". */
function imageMapRefs(cm: ConfigMapObject): string[] {
  const raw = cm.data?.[IMAGES_KEY];
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `the ${IMAGES_CONFIGMAP} ConfigMap in namespace "${cm.metadata.namespace}" is not JSON ` +
        `(${err instanceof Error ? err.message : err}) — the sweep cannot tell what that instance still ` +
        `needs, so it takes nothing. \`jr2 up\` in that instance rewrites the map.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const refs: string[] = [];
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value === "string") refs.push(value);
    else if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === "string") refs.push(nested);
      }
    }
  }
  return refs;
}

/**
 * One sweep: read the roots, then take every LABELED image on the host daemon — and, on a kind
 * context, on every node — that the keep set does not name. Narrates the result.
 *
 * `extraKeep` is what the caller just resolved and has not necessarily observed in the cluster yet;
 * it protects both stores. `grace` is the NODE-only one-generation reprieve (ADR-0039): the refs the
 * image map this converge REPLACED named, kept one more round so the ConfigMap's kubelet
 * propagation window cannot provision a ref this sweep just took. The host needs no such window —
 * nothing is provisioned from it.
 */
export async function sweepImages(opts: {
  io: Io;
  build: BuildPort;
  kube: KubeAdmin;
  /** The kube context, both to address the reads and to decide whether nodes exist to sweep. */
  context: string;
  ctx: { context?: string };
  extraKeep?: Iterable<string>;
  grace?: Iterable<string>;
  dryRun?: boolean;
}): Promise<SweepResult> {
  const { io, build, kube, context, ctx, dryRun } = opts;
  const roots = await readRoots(kube, ctx);
  const keep = new Set([...roots.keep, ...(opts.extraKeep ?? [])]);
  const cluster = kindCluster(context);
  const host = await sweepHost(build, { keep, dryRun });
  // The node keep set is the host's plus the grace generation — a superset, deliberately: the two
  // stores answer different questions, and only one of them has a propagation window.
  const nodes = cluster
    ? await sweepNodes(build, { cluster, keep: new Set([...keep, ...(opts.grace ?? [])]), dryRun })
    : undefined;
  const report = nodes ? mergeSweeps(host, nodes) : host;
  narrateSweep(io, report, { dryRun });
  return report;
}

/** `swept 4 image(s) (2.1 GB)` — bytes, not counts, because disk is the quantity the user feels
 * (ADR-0039). A silent collector plus one visible number is the entire intended interface, so the
 * refs themselves are listed only for a dry run, where the plan IS the output. */
export function narrateSweep(io: Io, report: SweepResult, opts: { dryRun?: boolean } = {}): void {
  const verb = opts.dryRun ? "would sweep" : "swept";
  if (report.removed.length > 0) {
    activity(io, `${verb} ${report.removed.length} image(s) (${formatBytes(report.bytes)})`);
    if (opts.dryRun) for (const ref of report.removed) activity(io, `  ${ref}`);
  } else {
    // Said rather than silent: on a cluster whose images predate ADR-0039 nothing carries a stamp,
    // so nothing is ever collectable, and a silent sweep would read as a broken one.
    activity(io, `${verb} nothing — every labeled image is named by a live root`);
  }
  if (report.kept.length > 0) {
    activity(
      io,
      `kept ${report.kept.length} tag(s) — their image id also carries a tag a live root names: ${report.kept.join(", ")}`,
    );
  }
  if (report.failed.length > 0) {
    activity(io, `failed to remove ${report.failed.length} image(s): ${report.failed.join(", ")}`);
  }
}
