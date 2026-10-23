// `jr2 up` (ADR-0019): the one converging command. These tests drive the LAYER DECISIONS — ownership
// guardrails, operator never-downgrade, image staleness/delivery, Secret idempotence, preflights —
// through injected kube/build/confirm fakes; the real subprocess ports stay thin and are exercised
// by the @kind tier. Manifest shapes are asserted incidentally via what the fake kube captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  CUSTODIAN_PROGRAM,
  configMapDigest,
  imageContextDigest,
  MOUNTED_CONFIGMAPS,
  custodianRef,
  effectorKey,
  gitPushSecretName,
  gitTokenSecretName,
  KIT_VERSION,
  harnessTokenDigest,
  leafStem,
  sandboxToken,
  workspaceHeldPod,
  type HeldManifest,
  type PlacementWalk,
} from "@jr2/orchestrator/internal";
import { linkKit } from "./_kit.ts";
import {
  providerProbes,
  heldDigest,
  MAP_PROPAGATION,
  podFault,
  PROBE_MODEL_SECONDS,
  probeVerdicts,
  up,
} from "../src/commands/up.ts";
import { providerProbeObjects, instanceObjects, type HeldObjects } from "../src/deploy.ts";
// The Harness's own result-line writer, from beside it, so the CLI's parser is held to its format.
// Loaded at run time: it is another package's source, outside this one's compiled tree.
type PreflightVerdict = { kind: "ok" } | { kind: "fault" | "busy" | "warn"; reason: string };
const { preflightLine, PREFLIGHT_MODEL_BUDGET_SECONDS } = (await import(
  new URL("../../harness/src/preflight-line.ts", import.meta.url).href
)) as {
  preflightLine: (specifier: string, verdict: PreflightVerdict) => string;
  PREFLIGHT_MODEL_BUDGET_SECONDS: number;
};
import type { KubeAdmin, KubeObject, PodEnd } from "../src/kube.ts";
import type { BuildPort, ObservedImage } from "../src/build.ts";
import type { Io } from "../src/output.ts";

/** The instance List of a converge: the one that carries the Orchestrator's Deployment — not the
 * apply of the provider preflight's inputs before it, nor a probe pod's own List (ADR-0019). */
const isInstanceList = (m: string): boolean => m.includes(`"kind":"List"`) && m.includes(`"kind":"Deployment"`);

/** A scriptable cluster: `objects` keyed "namespace/kind/name" ("" namespace for cluster-scoped). */
class FakeCluster implements KubeAdmin {
  objects = new Map<string, KubeObject>();
  applied: string[] = [];
  labeled: Array<Record<string, unknown>> = [];
  deleted: string[] = [];
  rollouts: string[] = [];
  ctx = "kind-test";

  set(namespace: string, kind: string, name: string, obj: Partial<KubeObject>): void {
    this.objects.set(`${namespace}/${kind.toLowerCase()}/${name}`, {
      metadata: { name, ...(obj.metadata ?? {}) },
      ...obj,
    } as KubeObject);
  }

  async context(): Promise<string | undefined> {
    return this.ctx;
  }
  async getJson<T = KubeObject>(opts: { kind: string; name: string; namespace?: string }): Promise<T | undefined> {
    return this.objects.get(`${opts.namespace ?? ""}/${opts.kind.toLowerCase()}/${opts.name}`) as T | undefined;
  }
  /** The names of the objects applied server-side (ADR-0059's trust bundles). */
  serverSide: string[] = [];
  /** An apply this answers true for is refused, as a quota or an admission webhook refuses it. */
  refuseApply?: (manifest: string) => boolean | string;
  async apply(opts: { manifest: string; serverSide?: boolean }): Promise<void> {
    const refused = this.refuseApply?.(opts.manifest);
    if (refused) throw new Error(typeof refused === "string" ? refused : 'pods "x" is forbidden: exceeded quota');
    this.applied.push(opts.manifest);
    // A probe pod's List is applied server-side too (ADR-0019); this records the named objects.
    const doc = opts.serverSide
      ? (JSON.parse(opts.manifest) as { kind: string; metadata?: { name: string } })
      : undefined;
    if (doc && doc.kind !== "List") this.serverSide.push(doc.metadata!.name);
  }
  async label(opts: Record<string, unknown>): Promise<void> {
    this.labeled.push(opts);
  }
  async deleteObject(opts: { kind: string; name: string; namespace?: string }): Promise<void> {
    this.deleted.push(`${opts.namespace ?? ""}/${opts.kind}/${opts.name}`);
  }
  async deleteManifest(): Promise<void> {
    this.deleted.push("(manifest)");
  }
  /** Rollouts scripted to time out, keyed `"<namespace>/<name>"` — what `kubectl rollout status`
   * does when a pod never comes up, and the only thing it says about it (ADR-0046). */
  rolloutFails = new Set<string>();
  /** Every rollout waited on, as `<namespace>/<name>` — a DaemonSet's prefixed `daemonset/` and a
   * StatefulSet's `statefulset/`, so a test can tell those waits from a Deployment's. */
  /** Every rollout wait's timeout, by `<namespace>/<name>` — unset where the default applies. */
  rolloutTimeouts: Record<string, number | undefined> = {};
  async waitRollout(opts: { kind?: string; name: string; namespace: string; timeoutSeconds?: number }): Promise<void> {
    const kind = opts.kind === "daemonset" || opts.kind === "statefulset" ? `${opts.kind}/` : "";
    this.rollouts.push(`${opts.namespace}/${kind}${opts.name}`);
    this.rolloutTimeouts[`${opts.namespace}/${opts.name}`] = opts.timeoutSeconds;
    if (this.rolloutFails.has(`${opts.namespace}/${opts.name}`)) {
      throw new Error("error: timed out waiting for the condition");
    }
  }
  /** The pods a failed rollout leaves behind, per selector — the evidence the diagnosis reads
   * instead of the honest cluster's "one pod running whatever was applied". */
  failedPods: Record<string, unknown[]> = {};
  /** The namespace's events, as the diagnosis lists them. */
  events: unknown[] = [];
  /** A container's log tail, by pod name. */
  podLogs: Record<string, string> = {};
  async logs(opts: { pod: string }): Promise<string> {
    return this.podLogs[opts.pod] ?? "";
  }
  /** Drift injection, per selector: the image that layer's pod carries when it must differ from
   * the applied one. Unset → an HONEST cluster, reporting a pod running whatever was last applied. */
  podImages: Record<string, string> = {};
  /** Live Sandbox CRs, as `jr2 up`'s closing report reads them (ADR-0038: report, never re-image). */
  sandboxes: Array<{ metadata: { name: string; namespace?: string }; spec?: { image?: string } }> = [];
  /** `true` → listing Sandboxes throws, as it does when the CRD is absent or RBAC forbids it. */
  sandboxListFails = false;
  /** The sweep's roots (ADR-0039), read cluster-wide: the namespaces some instance owns, their
   * `jr2-images` maps, and every pod in them. Empty by default — a cluster holding nothing but this
   * converge, which is what every test that is not about the sweep wants. */
  instanceNamespaces: Array<{ metadata: { name: string } }> = [];
  /** The cluster's nodes, as ADR-0045's platform derivation reads them: one schedulable amd64 node,
   * the everyday single-arch cluster, so every test that is not about platforms builds `-amd64`. */
  nodes: Array<{
    metadata: { name: string; labels?: Record<string, string> };
    spec?: { unschedulable?: boolean; taints?: Array<{ key: string; value?: string; effect: string }> };
    status?: { nodeInfo?: { architecture?: string }; allocatable?: Record<string, string> };
  }> = [{ metadata: { name: "kind-test-control-plane" }, status: { nodeInfo: { architecture: "amd64" } } }];
  imageMaps: Array<{ metadata: { name: string; namespace?: string }; data?: Record<string, string> }> = [];
  clusterPods: Array<{
    metadata: { name: string; namespace?: string };
    spec?: { containers?: Array<{ image?: string }> };
  }> = [];
  async listJson<T>(opts: {
    kind: string;
    selector?: string;
    fieldSelector?: string;
    namespace?: string;
    allNamespaces?: boolean;
  }): Promise<T[]> {
    if (opts.kind.startsWith("sandboxes")) {
      if (this.sandboxListFails) throw new Error("the server doesn't have a resource type sandboxes");
      return this.sandboxes as T[];
    }
    if (opts.selector?.startsWith("jr2.dev/provider-preflight")) {
      this.leftoverSelectors.push(opts.selector);
      return (this.probeLeftovers[opts.kind] ?? []) as T[];
    }
    if (opts.kind === "node") return this.nodes as T[];
    if (opts.kind === "namespace") return this.instanceNamespaces as T[];
    if (opts.kind === "configmap") return this.imageMaps as T[];
    // The cluster-wide pod read is the sweep's; the selected one is a layer's image verification.
    // Distinguished explicitly, because falling through to the verification branch would answer a
    // keep-set question with whatever the last apply happened to name.
    if (opts.kind === "pod" && opts.allNamespaces) return this.clusterPods as T[];
    if (opts.kind === "event") return this.events as T[];
    // A Secret read by label (`jr2.dev/held-pod`): the ones `set` put in this namespace that carry it.
    if (opts.kind === "secret") {
      return [...this.objects]
        .filter(
          ([key, o]) =>
            key.startsWith(`${opts.namespace ?? ""}/secret/`) && opts.selector! in (o.metadata.labels ?? {}),
        )
        .map(([, o]) => o) as T[];
    }
    if (opts.kind !== "pod") return [];
    const failed = this.failedPods[opts.selector ?? ""];
    if (failed) return failed as T[];
    const image = this.podImages[opts.selector ?? ""] ?? this.lastAppliedImage(opts.selector ?? "");
    if (!image) return [];
    return [{ metadata: { name: "pod-1" }, spec: { containers: [{ image }] } }] as T[];
  }
  /** What the last apply asked this selector's Deployment to run — the honest cluster's answer. */
  private lastAppliedImage(selector: string): string | undefined {
    const app = /app=(.+)$/.exec(selector)?.[1];
    for (const manifest of [...this.applied].reverse()) {
      const doc = manifest.trimStart().startsWith("{") ? JSON.parse(manifest) : undefined;
      const items = doc?.kind === "List" ? doc.items : doc ? [doc] : [];
      for (const i of items) {
        if (i.kind !== "Deployment" && i.kind !== "DaemonSet") continue;
        if (app && i.spec?.selector?.matchLabels?.app !== app) continue;
        return i.spec?.template?.spec?.containers?.[0]?.image;
      }
      // The operator install is YAML, not JSON — its image ref is substituted at apply time.
      const yaml = /^\s*image:\s*(\S+)\s*$/m.exec(manifest);
      if (!app && yaml) return yaml[1];
    }
    return undefined;
  }
  /** The server's `gitVersion`, as `kubectl get --raw /version` reports it: at ADR-0037's floor by
   * default, so every test that is not about the floor converges past it. */
  version = "v1.35.0";
  versionReads = 0;
  versionFails = false;
  async serverVersion(): Promise<string> {
    this.versionReads++;
    if (this.versionFails) throw new Error("no answer after 10s");
    return this.version;
  }
  /** Every server-side dry-run create, as sent. The honest server answers with what it was sent;
   * `podResourcesDropped` plays one whose PodLevelResources gate is off — it drops `spec.resources`
   * at admission and says nothing (ADR-0060). */
  dryRuns: string[] = [];
  podResourcesDropped = false;
  dryRunFails = false;
  async dryRunCreate(opts: { manifest: string }): Promise<{ spec?: { resources?: unknown } }> {
    this.dryRuns.push(opts.manifest);
    if (this.dryRunFails) throw new Error('pods "jr2-probe" is forbidden: cannot create');
    const pod = JSON.parse(opts.manifest);
    if (this.podResourcesDropped) delete pod.spec.resources;
    return pod;
  }
  /** The provider preflight's probe pods (ADR-0019), as applied when each was waited on, with the
   * rollouts waited on and the manifests applied by then. `probeAnswers` scripts a model's line
   * after its name (`fault=…`, `busy=…`, `warn=…`; default `ok`); `probeEnd` a pod that never
   * ran its probe. */
  probePods: Array<{
    pod: Record<string, any>;
    rolloutsBefore: string[];
    appliedBefore: string[];
    labeledBefore: Array<Record<string, unknown>>;
  }> = [];
  probeAnswers: Record<string, string> = {};
  probeEnd?: PodEnd;
  /** A log the pod's wait reads while it runs, when `probeEnd` scripts the end. */
  probeLive?: string;
  /** Lines the pod says while it waits to start, handed to `onPending` as the real wait does. */
  probePending: string[] = [];
  async awaitPodEnd(opts: {
    name: string;
    onPending?: (line: string) => void;
    onLog?: (log: string) => void;
  }): Promise<PodEnd> {
    for (const line of this.probePending) opts.onPending?.(line);
    if (this.probeLive !== undefined) opts.onLog?.(this.probeLive);
    const list = [...this.applied].reverse().find((m) => m.includes(`"name":"${opts.name}"`))!;
    const pod = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find((i) => i.kind === "Pod")!;
    this.probePods.push({
      pod,
      rolloutsBefore: [...this.rollouts],
      appliedBefore: [...this.applied],
      labeledBefore: [...this.labeled],
    });
    if (this.probeEnd) return this.probeEnd;
    const models = (pod.spec.containers[0].command as string[]).slice(4);
    const said = (m: string) => this.probeAnswers[m] ?? "ok";
    const lines = models.flatMap((m) => [`jr2.preflight model=${m} start`, `jr2.preflight model=${m} ${said(m)}`]);
    // While the pod runs: the log so far, with the first model's result, as the real wait reads it.
    opts.onLog?.(lines.slice(0, 2).join("\n"));
    const failed = models.some((m) => said(m).startsWith("fault="));
    return {
      phase: failed ? "Failed" : "Succeeded",
      started: true,
      output: lines.join("\n"),
      custodian: "",
      reasons: [],
    };
  }
  /** The selectors the leftover sweep listed with. */
  leftoverSelectors: string[] = [];
  /** Probe objects of earlier runs, as `jr2 up`'s leftover sweep lists them by label. */
  probeLeftovers: Record<string, Array<Record<string, any>>> = { pod: [], configmap: [], secret: [] };
}

/** A build port that records instead of building. `files` is what `pnpm deploy` would have
 * materialized into the bundle — the Assembly before its strip (ADR-0069). The default carries the
 * one thing staging requires: the Instance's `@jr2/orchestrator`, at this CLI's Kit version.
 *
 * Every verb records distinguishably, because ADR-0038's layers differ in exactly HOW they build:
 * a kit image is `-f <committed Dockerfile>` against another context, and a Sandbox Image is its
 * own directory and nothing else. The tag alone is recorded on the `build ` line so the address
 * stays extractable from it. */
function fakeBuild(
  record: string[],
  opts: {
    files?: Record<string, string>;
    /** What `docker inspect` says a Sandbox Image declares as its `USER` — `""` (the default) is
     * the interesting case: no USER, so the pod's uid-1000 fallback applies (ADR-0037). */
    imageUser?: string;
    /** What a Sandbox Effector's image holds (ADR-0068), by image ref: which paths, and /etc/passwd.
     * Default: every path asked for, and a passwd entry for uid 1000 — an image a push can use. */
    imageFiles?: (image: string, paths: readonly string[]) => { present: string[]; passwd: string };
    /** What the two stores hold when the post-converge sweep looks (ADR-0039). Empty by default,
     * so a test that is not about the sweep sees one narrated line and no removals. */
    hostImages?: ObservedImage[];
    nodeImages?: ObservedImage[];
    /** `true` → the host listing throws, as it does with no docker daemon reachable. */
    sweepFails?: boolean;
    /** What the host can build for (ADR-0045's binfmt preflight). Both supported platforms by
     * default — an emulation-equipped host, so a test that is not about the preflight never trips
     * over it. */
    buildable?: string[];
  } = {},
): BuildPort {
  const files = opts.files ?? STAGED_FILES;
  return {
    bundle: async (dir, out) => {
      record.push("bundle");
      // The Instance's own files ride the bundle, as a real install keeps them: the staged
      // Workflows must be the ones the walk loaded (ADR-0069).
      await cp(join(dir, "workflows"), join(out, "workflows"), { recursive: true }).catch(() => {});
      // `images/` too, minus what staging drops at every depth (`node_modules`, `.git`, `.env`,
      // `.env.*`, `.npmrc`; ADR-0043): a context's key is its STAGED copy's digest (ADR-0069).
      const dropped = (p: string) => {
        const name = p.split("/").at(-1)!;
        return ["node_modules", ".git", ".env", ".npmrc"].includes(name) || name.startsWith(".env.");
      };
      await cp(join(dir, "images"), join(out, "images"), { recursive: true, filter: (src) => !dropped(src) }).catch(
        () => {},
      );
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(out, dirname(rel)), { recursive: true });
        await writeFile(join(out, rel), content);
      }
    },
    build: async ({ tag, platforms, context, dockerfile, labels }) => {
      record.push(`build ${tag}`);
      // Explicit on every build (ADR-0045), recorded on its own line so the platform set stays
      // assertable without disturbing the tag-shaped assertions above it.
      record.push(`platform ${tag} ${platforms.join(",")}`);
      // The ownership stamp is recorded on its own line (ADR-0039): an unstamped build is an image
      // no sweep can ever collect, which is invisible in every other assertion here.
      record.push(`stamp ${tag} ${JSON.stringify(labels ?? null)}`);
      if (dockerfile) record.push(`build-with -f ${dockerfile} ctx ${context}`);
      else record.push(`build-with context-default ${tag}`);
    },
    imageUser: async (image, platforms) => {
      // The verb follows the artifact (ADR-0045): a singleton build is on this daemon, a manifest
      // list is in the registry buildx pushed it to — two reads, recorded as two lines.
      record.push(`${platforms.length > 1 ? "imagetools" : "inspect-user"} ${image}`);
      return opts.imageUser ?? "";
    },
    imageFiles: async (image, _platforms, paths) => {
      record.push(`inspect-files ${image}`);
      return (
        opts.imageFiles?.(image, paths) ?? {
          present: [...paths],
          passwd: "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000::/home/user:/bin/sh\n",
        }
      );
    },
    push: async (tag) => void record.push(`push ${tag}`),
    kindLoad: async (tag, cluster) => void record.push(`kind-load ${tag} → ${cluster}`),
    hostImages: async () => {
      if (opts.sweepFails) throw new Error("Cannot connect to the Docker daemon");
      return opts.hostImages ?? [];
    },
    removeHostImage: async (ref) => void record.push(`rmi-host ${ref}`),
    buildablePlatforms: async () => {
      record.push("buildable-check");
      return opts.buildable ?? ["linux/amd64", "linux/arm64"];
    },
    nodeImages: async (cluster) => [{ node: `${cluster}-control-plane`, images: opts.nodeImages ?? [] }],
    removeNodeImage: async (_cluster, node, id) => void record.push(`rmi-node ${node} ${id}`),
  };
}

/** What a bundle holds by default: the Instance and its `@jr2/orchestrator`, which staging reads
 * the Kit version from and then strips (ADR-0069). */
const STAGED_FILES: Record<string, string> = {
  "package.json": "{}",
  "node_modules/@jr2/orchestrator/package.json": JSON.stringify({ name: "@jr2/orchestrator", version: KIT_VERSION }),
};

/**
 * The running Orchestrator as `jr2 up` reaches it after the rollout (ADR-0069): a port-forward
 * (the `KubePort`) and the two `/assembly` verbs over it (the `fetch`). It keeps a current
 * Assembly, so a second converge in the same world sees the first one's publish. `refuse` scripts
 * the door's answer to the next PUTs.
 */
class FakeOrchestrator {
  current: { hash: string; kitVersion: string } | null = null;
  requests: Array<{ method: string; url: string; headers: Record<string, string>; bytes: number }> = [];
  forwards: string[] = [];
  closed = 0;
  refuse: Array<{ status: number; body: Record<string, unknown> }> = [];
  /** What `GET /assembly` reports as the mounted ConfigMap digests, by GET number (0-based).
   * Unset: no `mounts`, as an Orchestrator that is not deployed answers. */
  mounts?: (n: number) => Record<string, string> | undefined;
  gets = 0;

  kube = {
    currentContext: async () => "kind-test",
    readSecret: async () => undefined,
    portForward: async (opts: { namespace: string; service: string; port: number }) => {
      this.forwards.push(`${opts.namespace}/${opts.service}:${opts.port}`);
      return { url: "http://orchestrator.test", close: () => void this.closed++ };
    },
  };

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body as Uint8Array | undefined;
    this.requests.push({ method, url, headers, bytes: body?.byteLength ?? 0 });
    if (url !== "http://orchestrator.test/assembly") return Response.json({ error: "not found" }, { status: 404 });
    if (method === "GET") {
      const mounts = this.mounts?.(this.gets++);
      return Response.json({
        kitVersion: KIT_VERSION,
        current: this.current && { ...this.current, workflows: [] },
        held: [],
        ...(mounts ? { mounts } : {}),
      });
    }
    const refusal = this.refuse.shift();
    if (refusal) return Response.json(refusal.body, { status: refusal.status });
    const hash = headers["jr2-assembly-hash"]!;
    const unchanged = this.current?.hash === hash;
    this.current = { hash, kitVersion: headers["jr2-kit-version"]! };
    return Response.json({
      hash,
      kitVersion: KIT_VERSION,
      workflows: ["work"],
      held: [],
      ...(unchanged ? { unchanged } : {}),
    });
  };

  /** The PUTs the door received. */
  get puts() {
    return this.requests.filter((r) => r.method === "PUT");
  }
}

/** One image as a store reports it — jr2-built and worth reclaiming unless the test says otherwise. */
function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

/** This checkout's root, for the few tests that read artifacts other packages own. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The kit's own package by ABSOLUTE path. A fixture instance lives in the OS temp dir, where a
 * bare `@jr2/orchestrator` resolves to nothing — and these workflows must be the real thing, since
 * `jr2 up` now LOADS them and walks the Machines for the Agents they carry (ADR-0049). Node caches
 * by resolved path, so this is the same module instance the CLI itself imported. */
const KIT_SRC = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "orchestrator", "src", "index.ts"),
).href;

/** One Agent as a fixture Machine carries it. */
type FixtureAgent = { model: string; workspace?: "write" | "read" | "none" };

/** `agents` writes ONE workflow whose Machine carries them as actor slots (ADR-0049) — what the
 * converge's walk finds, and therefore what the provider preflight probes (there is no
 * instance-wide model — ADR-0018) and what the Instance Harness scan reads (ADR-0031). */
async function mkInstance(config: string, name = "myinst", agents?: Record<string, FixtureAgent>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `jr2-up-${name}-`));
  await writeFile(join(root, "jr2.config.ts"), config);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: `inst-${name}`, version: "0.0.0" }));
  await linkKit(root);
  await mkdir(join(root, "workflows"), { recursive: true });
  if (agents) {
    const slots = Object.entries(agents)
      .map(([slot, def]) => `${slot}: agent({ ...${JSON.stringify(def)}, instructions: "i" })`)
      .join(", ");
    await writeFile(
      join(root, "workflows", "work.ts"),
      `import { agent, jr2Setup } from ${JSON.stringify(KIT_SRC)};\n` +
        `export const machine = jr2Setup({ events: [], actors: { ${slots} } })\n` +
        `  .createMachine({ id: "work", initial: "idle", states: { idle: {} } });\n`,
    );
  }
  return root;
}

/** Scaffold the Instance's `images/default` — ADR-0037's fallback leg, and since ADR-0049/0050 the
 * ONE path `jr2 up` still checks by convention rather than by walking a Machine. */
async function withImage(root: string, name: string, dockerfile = "FROM node:24-slim\n"): Promise<string> {
  await mkdir(join(root, "images", name), { recursive: true });
  await writeFile(join(root, "images", name, "Dockerfile"), dockerfile);
  return root;
}

/** A workflow whose `workspace()` names a docker context the module itself ships (ADR-0037/0049) —
 * `import.meta.resolve` is the only way an ES module can name a folder it owns, and the walk is
 * what turns it into a build. The body is trivial: this fixture is about the image, not the run. */
async function withCarriedImage(root: string, dir: string, dockerfile: string): Promise<string> {
  await mkdir(join(root, "workflows", dir), { recursive: true });
  await writeFile(join(root, "workflows", dir, "Dockerfile"), dockerfile);
  await writeFile(
    join(root, "workflows", "shipped.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, {\n` +
      `  image: import.meta.resolve("./${dir}"),\n` +
      `  repos: { app: "https://e.test/a.git" },\n` +
      `  spec: () => ({ branch: "b" }),\n` +
      `});\n`,
  );
  return root;
}

/** A registered Workflow that COMPOSES a Sandbox — a `workspace()` with one bound Repo Slot
 * (ADR-0051). This is the data-plane switch as `jr2 up` reads it: nothing in `jr2.config.ts` says
 * "this instance has Workspaces" any more; the walk does. The url is what the ssh layer sees. */
async function withWorkspace(root: string, url = "https://e.test/a.git"): Promise<string> {
  await writeFile(
    join(root, "workflows", "ws.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: ${JSON.stringify(url)} }, spec: () => ({ branch: "b" }) });\n`,
  );
  return root;
}

/** A packaged Machine whose one Agent is left OPEN — no model, the one part a package cannot
 * honestly fill (ADR-0054). Registered as-is, so the walk refuses it exactly as it refuses an open
 * Repo Slot, and with the `agents` line instead of the `repos` one. */
async function withOpenAgent(root: string): Promise<string> {
  await writeFile(
    join(root, "workflows", "packaged.ts"),
    `import { agent, jr2Setup, open } from ${JSON.stringify(KIT_SRC)};\n` +
      `export const machine = jr2Setup({ events: [], actors: { coder: agent({ model: open, instructions: "i" }) } })\n` +
      `  .createMachine({ id: "task", initial: "working", states: { working: { invoke: { src: "coder", input: { prompt: "go" } } } } });\n`,
  );
  return root;
}

/** A packaged `workspace()` whose one Repo Slot is left OPEN, registered as-is — what `jr2 up`
 * refuses, naming the `customize` line that binds it (ADR-0051). `under` composes it one level
 * down instead: invoked from an author Machine's `review` slot, the shape a packaged Machine
 * actually arrives in. */
async function withOpenSlot(root: string, under?: "child" | "map"): Promise<string> {
  // `map`: the slot MAP is Open whole (`repos: open`) — no slot for the walk to name, because the
  // composer names them (ADR-0051).
  const repos = under === "map" ? "open" : "{ target: open }";
  const packaged = `workspace(body, { repos: ${repos}, spec: () => ({ branch: "b" }) })`;
  await writeFile(
    join(root, "workflows", "packaged.ts"),
    `import { jr2Setup, open, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      (under === "child"
        ? `export const machine = jr2Setup({ events: [], actors: { review: ${packaged} } })\n` +
          `  .createMachine({ id: "host", initial: "reviewing", states: { reviewing: { invoke: { src: "review" } } } });\n`
        : `export const machine = ${packaged};\n`),
  );
  return root;
}

/** A kit checkout as ADR-0038's detection sees one: BOTH markers, plus each image's hash sources. */
async function mkKit(): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "jr2-kit-"));
  const files: Record<string, string> = {
    "deploy/harness/Dockerfile": "FROM node:24-slim\n",
    "operator/Dockerfile": "FROM golang:1.23\n",
    // The Harness image builds `jr2-upload-pack` out of the operator module too (ADR-0053).
    "operator/go.mod": "module github.com/snapwich/jr2/operator\n",
    "operator/go.sum": "",
    "operator/cmd/jr2-upload-pack/main.go": "package main\n",
    "operator/internal/uploadpack/uploadpack.go": "package uploadpack\n",
    // And the Effector (ADR-0068), on /opt/jr2 beside it.
    "effector/go.mod": "module github.com/snapwich/jr2/effector\n",
    "effector/cmd/effector/main.go": "package main\n",
    "effector/internal/wire/wire.go": "package wire\n",
    "packages/harness/package.json": `{"name":"@jr2/harness"}`,
    // The Orchestrator Kit image (ADR-0069): its Dockerfile, its package and the kit package it
    // depends on.
    "deploy/orchestrator/Dockerfile": "FROM node:24-slim\n",
    "packages/orchestrator/package.json": `{"name":"@jr2/orchestrator"}`,
    "packages/agent-protocol/package.json": `{"name":"@jr2/agent-protocol"}`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(kit, dirname(rel)), { recursive: true });
    await writeFile(join(kit, rel), content);
  }
  return kit;
}

type World = {
  io: Io;
  kube: FakeCluster;
  orchestrator: FakeOrchestrator;
  built: string[];
  err: string[];
  confirms: string[];
  choices: string[][];
};

/** The gate's answer for a world that is not about the gate (ADR-0050). Every converge runs the
 * Instance's own `tsc` first; these fixtures are folders in the temp dir with no `node_modules`, so
 * the port itself is tested against a real compiler in `typecheck.test.ts` and stubbed here. */
const TYPECHECK_OK = async (): Promise<{ ok: boolean; output: string }> => ({ ok: true, output: "" });

function mkWorld(
  root: string,
  over: {
    confirm?: boolean;
    /** What the multiple-choice prompt answers (ADR-0047's key-source menu) — an index, or a
     * function of the offered options. Unset means "none of these", which is a DECLINE: the
     * dangerous options sit on this menu, so a test that never mentions it must not pick one. */
    choose?: number | ((options: string[]) => number | undefined);
    env?: Record<string, string>;
    bundleFiles?: Record<string, string>;
    /** A kit checkout root, when the world is meant to be one. Default: the instance folder, which
     * is NOT a checkout — so every test stays in installed-kit mode unless it says otherwise, and
     * none of them detect the real repo the suite happens to run inside. */
    kitDir?: string;
    imageUser?: string;
    imageFiles?: (image: string, paths: readonly string[]) => { present: string[]; passwd: string };
    /** What the Instance typecheck says (ADR-0050). Default: it passes. */
    typecheck?: Io["typecheck"];
    hostImages?: ObservedImage[];
    nodeImages?: ObservedImage[];
    sweepFails?: boolean;
    buildable?: string[];
  } = {},
): World {
  const kube = new FakeCluster();
  const orchestrator = new FakeOrchestrator();
  const built: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const choices: string[][] = [];
  const io: Io = {
    stdout: () => {},
    stderr: (s) => err.push(s),
    env: over.env ?? {},
    cwd: root,
    kitDir: over.kitDir ?? root,
    kubeAdmin: kube,
    kube: orchestrator.kube,
    fetch: orchestrator.fetch,
    typecheck: over.typecheck ?? TYPECHECK_OK,
    build: fakeBuild(built, {
      files: over.bundleFiles,
      imageUser: over.imageUser,
      imageFiles: over.imageFiles,
      hostImages: over.hostImages,
      nodeImages: over.nodeImages,
      sweepFails: over.sweepFails,
      buildable: over.buildable,
    }),
    confirm: async (q) => {
      confirms.push(q);
      return over.confirm ?? true;
    },
    choose: async (_q, options) => {
      choices.push(options);
      return typeof over.choose === "function" ? over.choose(options) : over.choose;
    },
  };
  return { io, kube, orchestrator, built, err, confirms, choices };
}

/** The Orchestrator Deployment this converge applied. */
function deploymentOf(w: World): Record<string, any> {
  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  return items.find((i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator")!;
}

/** The `jr2-images` map this converge applied — the ConfigMap the Orchestrator reads per provision
 * and, byte-identical, the annotation the next converge diffs (ADR-0038). */
function imagesOf(w: World): Record<string, any> {
  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-images")!;
  return JSON.parse(cm.data["images.json"]);
}

test("the typecheck gate: a folder that does not compile converges nothing (ADR-0050)", async () => {
  // The FIRST layer, and a refusal rather than a warning: since ADR-0049 a Machine's Agent slots and
  // its composed Machines are typed, so a wrong name is a compile error here instead of an
  // invoke-time failure mid-run — but only if nothing is spent before the compiler answers. Repo
  // Slots are typed here too (ADR-0051), so a `customize()` of one the Machine never declared stops
  // here; what the gate itself claims is only that `jr2 up` runs the compiler and refuses on its answer.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const errors = "workflows/task.ts(9,5): error TS2353: Object literal may only specify known properties";
  const bad = mkWorld(root, { typecheck: async () => ({ ok: false, output: errors }) });

  assert.equal(await up(["--yes"], bad.io), 1);
  assert.match(bad.err.join("\n"), /does not typecheck/);
  assert.match(bad.err.join("\n"), /TS2353/, "the compiler's own report is what the user reads");
  assert.deepEqual(bad.kube.applied, [], "not even the namespace — the gate precedes ownership");
  assert.deepEqual(bad.built, [], "no bundle, no image build");
  assert.deepEqual(bad.confirms, [], "and no first-contact ask for a folder that cannot deploy");

  const ok = mkWorld(root);
  assert.equal(await up(["--yes"], ok.io), 0);
  assert.match(ok.err.join("\n"), /typecheck: tsc --noEmit/, "the layer narrates itself either way");
});

test("up refuses a cluster that drops pod-level resources, naming the version (ADR-0060)", async () => {
  // A Workspace's whole Size is one pod-level ceiling (KEP-2837). A server whose PodLevelResources
  // gate is off drops `spec.resources` at admission and says nothing: every Sandbox would run
  // Burstable, a User Container with no split unbounded. A server-side dry-run of a pod that states
  // them is the one read that shows it.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const off = mkWorld(root);
  off.kube.podResourcesDropped = true;
  assert.equal(await up(["--yes"], off.io), 1);
  const said = off.err.join("\n");
  assert.match(said, /refusing: .*kind-test.*drops pod-level resources/);
  assert.match(said, /v1\.35\.0/, "the version the server reported");
  assert.match(said, /PodLevelResources/, "and the gate the owner turned off");
  assert.deepEqual(off.built, ["bundle"], "the Assembly was staged (ADR-0069); nothing was built");
  const probe = JSON.parse(off.kube.dryRuns[0]!);
  assert.equal(probe.kind, "Pod");
  assert.ok(probe.spec.resources?.limits?.memory, "the probe states pod-level limits");

  const on = mkWorld(root);
  assert.equal(await up(["--yes"], on.io), 0);
  assert.equal(on.kube.dryRuns.length, 1, "one dry-run per converge");
});

test("a pod-level resources probe that cannot answer is said, and the converge goes on (ADR-0060)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.dryRunFails = true;
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /could not confirm pod-level resources.*forbidden/);
});

test("up refuses a cluster whose API server does not answer the version read, naming the context", async () => {
  // The floor read is `jr2 up`'s first contact, so a dead context or a down VPN fails HERE — as a
  // refusal that names the context and kubectl's reason (ADR-0046), not kubectl's raw exec error.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const dead = mkWorld(root);
  dead.kube.versionFails = true;

  assert.equal(await up(["--yes"], dead.io), 1);
  const said = dead.err.join("\n");
  assert.match(said, /refusing: cannot reach the API server of kind-test \(no answer after 10s\)/);
  assert.match(said, /Nothing was applied/);
  assert.deepEqual(dead.kube.applied, []);
  assert.deepEqual(dead.built, ["bundle"], "staged before any cluster spend, and nothing built");
});

test("up refuses a cluster below the Kubernetes floor, naming what it found (ADR-0037)", async () => {
  // A Sandbox's /opt/jr2 is an `image` volume, on by default from 1.35, and there is no fallback
  // mechanism below it — so a cluster under the floor would converge and then leave every Sandbox
  // Pending on a volume type its kubelet does not know. The refusal comes before first contact:
  // nothing to confirm, nothing applied, nothing built.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const old = mkWorld(root);
  old.kube.version = "v1.34.2";

  assert.equal(await up([], old.io), 1);
  const said = old.err.join("\n");
  assert.match(said, /refusing: .*v1\.34\.2/, "the version the server reported");
  assert.match(said, /1\.35/, "and the floor");
  assert.match(said, /kind-test/, "on which context — the one fact the user can change");
  assert.deepEqual(old.kube.applied, [], "not even the namespace");
  assert.deepEqual(old.built, ["bundle"], "staged before any cluster spend, and nothing built");
  assert.deepEqual(old.confirms, [], "no first-contact ask for a cluster that cannot host it");

  const current = mkWorld(root);
  assert.equal(await up(["--yes"], current.io), 0);
  assert.equal(current.kube.versionReads, 1, "one read per converge");
  assert.match(current.err.join("\n"), /kubernetes: v1\.35\.0/, "the layer narrates itself either way");
});

test("up refuses a namespace labeled for another instance", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "jr2.dev/instance": "other" } } });

  assert.equal(await up([], w.io), 1);
  assert.match(w.err.join("\n"), /another instance.*other/s);
  assert.deepEqual(w.kube.applied, [], "nothing may be applied to someone else's namespace");
});

test("first contact asks; declining bails before anything is applied; --yes skips the ask", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);

  const declined = mkWorld(root, { confirm: false });
  assert.equal(await up([], declined.io), 1);
  assert.equal(declined.confirms.length, 1);
  assert.match(declined.confirms[0]!, /myinst/);
  assert.match(declined.confirms[0]!, /kind-test/, "the ask names the context it would touch");
  assert.deepEqual(declined.kube.applied, []);

  const yes = mkWorld(root, { confirm: false }); // confirm would say no — but --yes must never ask
  assert.equal(await up(["--yes"], yes.io), 0);
  assert.equal(yes.confirms.length, 0);
  assert.ok(yes.kube.applied.length > 0, "converged without prompting");
});

test("operator: never downgraded — a newer deployed operator is left, with a warning", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.set("jr2-system", "deployment", "jr2-controller-manager", {
    metadata: { name: "jr2-controller-manager", labels: { "jr2.dev/version": "99.0.0" } },
  });

  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /never downgraded/);
  assert.ok(
    !w.kube.applied.some((m) => m.includes("controller-manager")),
    "the operator manifest must not be applied over a newer one",
  );
});

test("operator: the applied version is waited for and verified, like every other layer", async () => {
  // `up` narrated "applying vX" and moved on without ever waiting or looking — the same unverified
  // claim the instance layer made, one layer up.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(
    w.kube.rollouts.includes("jr2-system/jr2-controller-manager"),
    `the operator rollout is waited for (got: ${w.kube.rollouts.join(", ")})`,
  );
  const operatorApply = w.kube.applied.find((m) => m.includes("controller-manager"))!;
  assert.match(operatorApply, new RegExp(`image: ghcr.io/snapwich/jr2-operator:`));
  assert.ok(!operatorApply.includes("controller:latest"), "the placeholder image ref was substituted");

  const drifted = mkWorld(root);
  drifted.kube.podImages = { "control-plane=controller-manager": "jr2-operator:ancient" };
  await assert.rejects(
    () => up(["--yes"], drifted.io),
    /operator.*jr2-operator:ancient.*expected ghcr\.io\/snapwich\/jr2-operator:/s,
  );
});

test("a rollout that times out carries the pods' evidence, not just kubectl's verdict", async () => {
  // The failure that produced ADR-0045 surfaced as `timed out waiting for the condition` and
  // nothing else; the cause was found by hand with `kubectl get pods` + `kubectl logs`. Every
  // rollout wait now does that reading itself (ADR-0046).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.rolloutFails.add("myinst/jr2-orchestrator");
  w.kube.set("", "node", "kind-worker", { status: { nodeInfo: { architecture: "arm64" } } });
  w.kube.failedPods["app=jr2-orchestrator"] = [
    {
      metadata: { name: "jr2-orchestrator-77d-abc" },
      spec: { nodeName: "kind-worker", containers: [{ name: "orchestrator", image: "jr2-orchestrator:abc-amd64" }] },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "orchestrator",
            ready: false,
            state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 40s restarting failed container" } },
            lastState: { terminated: { reason: "StartError", exitCode: 128, message: "exec format error" } },
          },
        ],
      },
    },
  ];

  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(err.message, /jr2-orchestrator: rollout did not complete in namespace myinst/);
      assert.match(err.message, /exec format error/, "the pod's own words are carried");
      assert.match(err.message, /diagnosis: .* built for another platform/);
      assert.match(err.message, /kind-worker runs arm64/);
      assert.match(err.message, /timed out waiting for the condition/, "kubectl's verdict is kept, not replaced");
      return true;
    },
  );
});

test("operator: manage:false skips the layer — and the image build with it", async () => {
  const kit = await mkKit();
  const skipRoot = await mkInstance(`export default { name: "a", operator: { manage: false } };\n`, "a");
  const w1 = mkWorld(skipRoot, { kitDir: kit });
  assert.equal(await up(["--yes"], w1.io), 0);
  assert.ok(!w1.kube.applied.some((m) => m.includes("controller-manager")));
  assert.ok(
    !w1.built.some((b) => b.startsWith("build jr2-operator:")),
    `an image this converge does not deploy is not built (got: ${w1.built.join(", ")})`,
  );
  // …and it is not recorded either: a ref in the record with nothing built would make the NEXT
  // converge (with manage back on) skip a build the cluster needs.
  assert.equal(imagesOf(w1).operator, undefined);
});

// --- kit images (ADR-0038): built from source in a checkout, published when installed -----------

test("a kit checkout builds the Harness, operator and Orchestrator; installed from npm builds none; the Custodian is never built", async () => {
  const kit = await mkKit();
  const root = await mkInstance(`export default { name: "myinst" };\n`);

  const checkout = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], checkout.io), 0);
  assert.match(checkout.err.join("\n"), /kit checkout/, "the mode is narrated once, not inferred");
  for (const repo of ["jr2-harness", "jr2-operator", "jr2-orchestrator"]) {
    const built = checkout.built.find((b) => b.startsWith(`build ${repo}:`))!;
    assert.ok(built, `${repo} is built (got: ${checkout.built.join(", ")})`);
    const ref = built.slice("build ".length);
    assert.match(
      ref,
      new RegExp(`^${repo}:[0-9a-f]{12}-amd64$`),
      "…at a content address of (inputs × platform), never a moving tag",
    );
    // The SAME transport branch every image uses — one story, no per-layer drift.
    assert.ok(checkout.built.includes(`kind-load ${ref} → test`), `${repo} is delivered by kind load`);
    assert.ok(
      checkout.built.some((b) => b.startsWith(`build-with -f ${kit}/`)),
      "…from its committed Dockerfile",
    );
  }

  const installed = mkWorld(root);
  assert.equal(await up(["--yes"], installed.io), 0);
  assert.match(installed.err.join("\n"), /installed kit/);
  assert.ok(
    !installed.built.some((b) => /^build /.test(b)),
    `installed from npm, kit images are pulled, never built (got: ${installed.built.join(", ")})`,
  );
  // The published <kitversion> refs are what the map names, and what the Instance Harness runs —
  // at the canonical home, because a bare tag is `docker.io/library/` and nothing is there
  // (ADR-0044).
  assert.equal(imagesOf(installed).harness, `ghcr.io/snapwich/jr2-harness:${KIT_VERSION}`);
  assert.equal(imagesOf(installed).orchestrator, `ghcr.io/snapwich/jr2-orchestrator:${KIT_VERSION}`);
  assert.match(installed.err.join("\n"), /the published v\S+ Harness, operator and Orchestrator, pulled from ghcr\.io/);
  // The Custodian's image is deployed and never built, in either world (ADR-0038, ADR-0059): the
  // pinned upstream Envoy, by digest.
  for (const world of [checkout, installed]) {
    assert.equal(imagesOf(world).custodian, custodianRef());
    assert.ok(!world.built.some((b) => /envoy/.test(b)), "nothing builds or delivers Envoy");
  }
});

test("installed, kitRegistry re-homes every deployed Kit ref; absent, they come from the home (ADR-0044)", async () => {
  // The self-hosted / air-gapped cluster: the mirror was seeded deliberately (`jr2 kit push`), and
  // the converge's only job is to NAME it — nothing is pushed or built here, since installed mode
  // has no Kit sources at all.
  const mirrored = await mkInstance(`export default { name: "m", kitRegistry: "zot.example.test" };\n`, "m");
  const w = mkWorld(mirrored);
  assert.equal(await up(["--yes"], w.io), 0);
  const images = imagesOf(w);
  assert.equal(images.harness, `zot.example.test/jr2-harness:${KIT_VERSION}`);
  assert.equal(images.custodian, custodianRef("zot.example.test"));
  assert.equal(images.operator, `zot.example.test/jr2-operator:${KIT_VERSION}`);
  assert.equal(
    images.orchestrator,
    `zot.example.test/jr2-orchestrator:${KIT_VERSION}`,
    "the Orchestrator too (ADR-0069)",
  );
  assert.equal(
    deploymentOf(w).spec.template.spec.containers[0].image,
    images.orchestrator,
    "and the Deployment runs it",
  );
  assert.match(w.err.join("\n"), /zot\.example\.test/, "the mirror is narrated, never silently used");
  assert.ok(
    !w.built.some((b) => /^(build|push) (zot|ghcr)/.test(b)),
    `a published Kit image is pulled, never built or mirrored by a converge (got: ${w.built.join(", ")})`,
  );
  // `registry` answers a different question — where THIS converge's builds go (ADR-0044) — so it
  // must not re-home the published Kit images. With no `workspace()` there is no build at all.
  const both = await mkInstance(
    `export default { name: "b", registry: "reg.example.com/jr2", kitRegistry: "zot.example.test" };\n`,
    "b",
  );
  const w2 = mkWorld(both);
  assert.equal(await up(["--yes"], w2.io), 0);
  assert.equal(imagesOf(w2).harness, `zot.example.test/jr2-harness:${KIT_VERSION}`);
  assert.equal(imagesOf(w2).orchestrator, `zot.example.test/jr2-orchestrator:${KIT_VERSION}`);
  assert.deepEqual(w2.built, ["bundle"], "nothing is pushed: an installed Instance builds no image (ADR-0069)");

  const home = mkWorld(await mkInstance(`export default { name: "h" };\n`, "h"));
  assert.equal(await up(["--yes"], home.io), 0);
  assert.equal(imagesOf(home).harness, `ghcr.io/snapwich/jr2-harness:${KIT_VERSION}`);
});

test("a registry pushes every layer; a non-kind context without one fails BEFORE any build", async () => {
  const kit = await mkKit();
  const pushRoot = await mkInstance(`export default { name: "r", registry: "reg.example.com/jr2" };\n`, "r");
  const w = mkWorld(pushRoot, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);
  for (const repo of ["jr2-harness", "jr2-operator", "jr2-orchestrator"]) {
    assert.ok(
      w.built.some((b) => b.startsWith(`push reg.example.com/jr2/${repo}:`)),
      `${repo} is pushed (got: ${w.built.join(", ")})`,
    );
  }
  assert.ok(!w.built.some((b) => b.includes("kind-load")));

  const bareRoot = await mkInstance(`export default { name: "s" };\n`, "s");
  const w2 = mkWorld(bareRoot, { kitDir: kit });
  w2.kube.ctx = "gke-prod";
  await assert.rejects(() => up(["--yes"], w2.io), /not a kind cluster and no `registry`/);
  assert.deepEqual(w2.built, ["bundle"], "a converge that can deliver nothing spends no docker discovering it");
});

test("the Deployment's image annotation makes a second converge spend zero docker; --force overrides it", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
    "default",
  );

  const first = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], first.io), 0);
  const images = imagesOf(first);

  // The cluster now records what was converged — on the Deployment's OWN metadata, so re-resolving
  // a ref never rolls the Orchestrator and never restores a live run's snapshot (ADR-0038/0007).
  const list = first.kube.applied.find(isInstanceList)!;
  const deployment = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator",
  )!;
  assert.equal(deployment.metadata.annotations["jr2.dev/images"], JSON.stringify(images, null, 2));
  assert.deepEqual(
    Object.keys(deployment.spec.template.metadata.annotations),
    ["jr2.dev/secret-digest"],
    "never on the pod template — that would roll every run; only the Instance Secret's digest is there",
  );
  assert.ok(
    !JSON.stringify(deployment.spec.template.spec.containers[0].env).includes("IMAGE"),
    "and never as env: no JR2_*_IMAGE anywhere",
  );

  const again = mkWorld(root, { kitDir: kit });
  // The same Orchestrator, already serving the Assembly the first converge published (ADR-0069).
  again.orchestrator.current = first.orchestrator.current;
  again.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } } });
  again.kube.set("myinst", "deployment", "jr2-orchestrator", {
    metadata: {
      name: "jr2-orchestrator",
      annotations: { "jr2.dev/images": JSON.stringify(images, null, 2) },
    },
  });
  assert.equal(await up([], again.io), 0);
  assert.deepEqual(again.built, ["bundle"], "staged to hash, and nothing else was spent");
  assert.deepEqual(again.orchestrator.puts, [], "…and nothing was published: the Assembly is current");
  assert.deepEqual(imagesOf(again), images, "…and the map re-converges to the same refs");

  const forced = mkWorld(root, { kitDir: kit });
  forced.kube.set("", "namespace", "myinst", {
    metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } },
  });
  forced.kube.set("myinst", "deployment", "jr2-orchestrator", {
    metadata: {
      name: "jr2-orchestrator",
      annotations: { "jr2.dev/images": JSON.stringify(images, null, 2) },
    },
  });
  assert.equal(await up(["--force"], forced.io), 0);
  for (const ref of [images.harness, images.operator, images.orchestrator, images.sandbox.default]) {
    assert.ok(forced.built.includes(`build ${ref}`), `--force rebuilds ${ref} (got: ${forced.built.join(", ")})`);
  }

  // A record that names the ref but NOT the seat it was proved in — what a kit predating ADR-0037's
  // uid-1000 fallback wrote — is incomplete, not fresh. Skipping on it would converge a map with no
  // `sandboxUser` entry, and a userless image would then be admitted as root and refused by the
  // Harness container's runAsNonRoot. So the image is re-proved and the fact re-read.
  const { sandboxUser: _dropped, ...partial } = images;
  const stale = mkWorld(root, { kitDir: kit });
  stale.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } } });
  stale.kube.set("myinst", "deployment", "jr2-orchestrator", {
    metadata: {
      name: "jr2-orchestrator",
      annotations: { "jr2.dev/images": JSON.stringify(partial, null, 2) },
    },
  });
  assert.equal(await up([], stale.io), 0);
  assert.ok(stale.built.includes(`inspect-user ${images.sandbox.default}`), "the seat is read again");
  assert.deepEqual(imagesOf(stale).sandboxUser, { default: "" }, "…and the record converges complete");
});

test("a silent record consults the host daemon: host-built refs skip their builds, never their delivery (ADR-0041)", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
    "default",
  );
  const first = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], first.io), 0);
  const images = imagesOf(first);
  const refs = [images.harness, images.operator, images.orchestrator, images.sandbox.default] as string[];

  // A fresh namespace: no Deployment, no annotation — the record is silent. But the host daemon
  // still holds every ref this converge resolves, labeled, at the exact content-addressed tags:
  // the tag IS the content, so present implies current (ADR-0038's seal made that true).
  const held = refs.map((t, i) => image({ id: `sha256:held${i}`, tags: [t], bytes: 1 }));
  const fresh = mkWorld(root, { kitDir: kit, hostImages: held });
  assert.equal(await up(["--yes"], fresh.io), 0);
  assert.ok(
    !fresh.built.some((b) => b.startsWith("build ")),
    `no docker build was spent (got: ${fresh.built.join(", ")})`,
  );
  for (const t of refs) {
    assert.ok(
      fresh.built.includes(`kind-load ${t} → test`),
      `${t} is still delivered — the disk answers the build question only`,
    );
  }
  // The skip proves the BUILD, not the floor (ADR-0041): a converge holds no preflight obligation
  // at all, so nothing here re-proves anything — but the seat is still re-read, because the map the
  // provision depends on has to carry it whether the build was spent or skipped.
  assert.ok(
    fresh.built.includes(`inspect-user ${images.sandbox.default}`),
    "the host-held Sandbox Image is still inspected for its USER",
  );
  assert.deepEqual(imagesOf(fresh), images, "…and the map converges to the same refs");

  // --force ignores the disk exactly as it ignores the record.
  const forced = mkWorld(root, { kitDir: kit, hostImages: held });
  assert.equal(await up(["--yes", "--force"], forced.io), 0);
  for (const t of refs) {
    assert.ok(forced.built.includes(`build ${t}`), `--force rebuilds ${t} (got: ${forced.built.join(", ")})`);
  }
});

// --- the platform set (ADR-0045): the cluster chooses, the tag says ------------------------------

test("the cluster's schedulable nodes choose the platform set, and every built tag says so", async () => {
  // The hole in ADR-0038's invariant: the bytes are a function of (inputs × platform), no build
  // passed `--platform`, and the tag named only the inputs — so one tag meant an amd64 image on one
  // host and an arm64 image on another, and the wrong one arrived as an opaque rollout timeout.
  const kit = await mkKit();
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
    "default",
  );
  const w = mkWorld(root, { kitDir: kit });
  w.kube.nodes = [
    { metadata: { name: "cp" }, status: { nodeInfo: { architecture: "arm64" } } },
    { metadata: { name: "w1" }, status: { nodeInfo: { architecture: "arm64" } } },
    // Cordoned: nothing can be placed there, so it is not a platform this instance owes an image.
    { metadata: { name: "old" }, spec: { unschedulable: true }, status: { nodeInfo: { architecture: "amd64" } } },
  ];
  assert.equal(await up(["--yes"], w.io), 0);

  const builds = w.built.filter((b) => b.startsWith("build ")).map((b) => b.slice("build ".length));
  assert.ok(builds.length >= 4, `every layer was built (got: ${builds.join(", ")})`);
  for (const ref of builds) {
    assert.match(ref, /:[0-9a-f]{12}-arm64$/, `${ref} names the platform it holds`);
    assert.ok(w.built.includes(`platform ${ref} linux/arm64`), `${ref} was built with an explicit --platform`);
  }
  assert.match(w.err.join("\n"), /platforms: linux\/arm64 \(from 2 schedulable node\(s\)\)/);

  // The same instance against an amd64 cluster addresses different bytes at a different tag — the
  // whole point of putting the platform IN the address rather than in the salt.
  const amd = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], amd.io), 0);
  assert.notEqual(imagesOf(amd).harness, imagesOf(w).harness);
  assert.match(imagesOf(amd).harness, /-amd64$/);
});

test("a node arch the kit publishes nothing for is skipped; no supported arch at all is loud", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const mixed = mkWorld(root);
  mixed.kube.nodes = [
    { metadata: { name: "a" }, status: { nodeInfo: { architecture: "amd64" } } },
    { metadata: { name: "z" }, status: { nodeInfo: { architecture: "s390x" } } },
  ];
  assert.equal(await up(["--yes"], mixed.io), 0);
  // Reported and skipped, never built for: no Kit image could sit beside an s390x Sandbox Image in
  // the pod, so building one would be dead weight discovered at provision.
  assert.match(mixed.err.join("\n"), /skipping node arch s390x/);
  assert.ok(
    mixed.built.filter((b) => b.startsWith("platform ")).every((b) => b.endsWith("linux/amd64")),
    `nothing was built for the unsupported arch (got: ${mixed.built.join(", ")})`,
  );

  const nowhere = mkWorld(root);
  nowhere.kube.nodes = [{ metadata: { name: "z" }, status: { nodeInfo: { architecture: "s390x" } } }];
  await assert.rejects(() => up(["--yes"], nowhere.io), /s390x[\s\S]*`platforms`/);
  assert.deepEqual(nowhere.built, ["bundle"], "and nothing was built finding out");
});

test("`platforms` overrides the cluster absolutely, and an unpublished entry is refused by name", async () => {
  // The escape hatch for what derivation cannot see: a pool that autoscales from zero, or a set
  // polluted by an amd64 GPU pool beside arm64 workers, whose derived pair costs a needless qemu
  // cross-build. Absolute: the key is the build set, not an addition to the derived one.
  const pinned = await mkInstance(`export default { name: "p", platforms: ["linux/arm64"] };\n`, "p");
  const w = mkWorld(pinned);
  w.kube.nodes = [
    { metadata: { name: "a" }, status: { nodeInfo: { architecture: "amd64" } } },
    { metadata: { name: "b" }, status: { nodeInfo: { architecture: "arm64" } } },
  ];
  // Skipping derivation skips the QUESTION: a converge that was told its platforms must not still
  // need permission to read nodes (a pool scaled to zero cannot answer, and RBAC may forbid asking).
  const listJson = w.kube.listJson.bind(w.kube);
  w.kube.listJson = (async (opts: Parameters<typeof listJson>[0]) => {
    if (opts.kind === "node") throw new Error("nodes is forbidden");
    return listJson(opts);
  }) as typeof w.kube.listJson;
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /platforms: linux\/arm64 \(the `platforms` key/);
  assert.ok(
    w.built.filter((b) => b.startsWith("platform ")).every((b) => b.endsWith("linux/arm64")),
    `the key decided alone (got: ${w.built.join(", ")})`,
  );

  const bad = await mkInstance(`export default { name: "b", platforms: ["linux/s390x"] };\n`, "b");
  const w2 = mkWorld(bad);
  await assert.rejects(() => up(["--yes"], w2.io), /`platforms` names linux\/s390x/);
});

test("a context is keyed by the digest of its STAGED copy, which drops a `.env` the folder holds (ADR-0069)", async () => {
  // The door and every provision digest the landed copy, and staging drops `.env`, `.git`,
  // `node_modules` and `.npmrc` at every depth. Keyed off the Instance folder, a context that holds
  // one of those names would be in the map under a digest the Orchestrator never computes, and
  // every publish would be refused "not in the image map".
  const kit = await mkKit();
  const root = await withImage(await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)), "box");
  await writeFile(join(root, "images", "box", ".env"), "SECRET=1\n");
  await writeFile(
    join(root, "workflows", "boxed.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, {\n` +
      `  repos: { app: { url: "https://e.test/a.git" } },\n` +
      `  image: import.meta.resolve("../images/box"),\n` +
      `  spec: () => ({ branch: "b" }),\n` +
      `});\n`,
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);
  const sandbox = imagesOf(w).sandbox as Record<string, string>;
  const digest = Object.keys(sandbox).find((k) => k !== "default")!;
  assert.ok(digest, "the carried context is in the map");
  // The staged copy: the Dockerfile alone.
  const stagedLike = await mkdtemp(join(tmpdir(), "jr2-ctx-"));
  await writeFile(join(stagedLike, "Dockerfile"), "FROM node:24-slim\n");
  assert.equal(digest, await imageContextDigest(stagedLike), "keyed by the staged copy's digest");
  assert.notEqual(
    digest,
    await imageContextDigest(join(root, "images", "box")),
    "not by the folder's, which holds .env",
  );
});

test("a `file:` context the Machine carries is built and keyed by its content DIGEST (ADR-0049)", async () => {
  // The walk is what makes this image exist at all: nothing scans a folder, so a context is found
  // only because a registered Machine names it. The map key is the digest — not a dirname, not a
  // path — which is exactly what lets the Orchestrator resolve the same `file:` URL from the
  // published Assembly's node_modules without either side holding a table.
  const kit = await mkKit();
  const root = await withCarriedImage(
    await withImage(await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)), "default"),
    "toolchain",
    "FROM golang:1.23\nRUN echo hi\n",
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const sandbox = imagesOf(w).sandbox as Record<string, string>;
  const keys = Object.keys(sandbox);
  assert.equal(keys.length, 2, `images/default plus the carried context (got: ${keys.join(", ")})`);
  const digest = keys.find((k) => k !== "default")!;
  assert.match(digest, /^[0-9a-f]{12}$/, "keyed by content digest, never by a dirname");
  // The tag's readable half is the context directory's basename — decoration; the identity is the
  // digest, which appears in the tag too.
  assert.match(sandbox[digest]!, new RegExp(`^jr2-sandbox-myinst-toolchain:${digest}-`));
  assert.ok(w.built.includes(`build ${sandbox[digest]}`), `the carried context was built (${w.built.join(", ")})`);
  assert.ok(w.built.includes(`inspect-user ${sandbox[digest]}`), "…and its seat recorded, like any built image");

  // Editing the Dockerfile re-addresses it — a new key AND a new tag, so nothing stale is reachable.
  await writeFile(join(root, "workflows", "toolchain", "Dockerfile"), "FROM golang:1.23\nRUN echo bye\n");
  const edited = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], edited.io), 0);
  const after = Object.keys(imagesOf(edited).sandbox as Record<string, string>).find((k) => k !== "default")!;
  assert.notEqual(after, digest, "the context IS the address");
});

test("a Machine that names a registry ref costs no build — deployed, never built (ADR-0037)", async () => {
  const kit = await mkKit();
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  await writeFile(
    join(root, "workflows", "brought.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, {\n` +
      `  image: "ghcr.io/acme/toolchain:2024-11",\n` +
      `  repos: { app: "https://e.test/a.git" },\n` +
      `  spec: () => ({ branch: "b" }),\n` +
      `});\n`,
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  assert.deepEqual(imagesOf(w).sandbox, {}, "a ref needs no entry: it already IS its own ref");
  assert.ok(!w.built.some((b) => b.includes("jr2-sandbox-")), `nothing was built for it (got: ${w.built.join(", ")})`);
  assert.match(w.err.join("\n"), /sandbox images: none carried/);
});

test("a mixed-arch node set is built once by buildx, which delivers by pushing", async () => {
  // ADR-0045's non-singleton case: build for both rather than guess which node a pod lands on.
  // `docker buildx build --push` IS the delivery — a manifest list cannot live in the daemon and
  // `kind load` cannot carry one — so nothing may push it a second time.
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "m", registry: "reg.example.com/jr2" };\n`, "m")),
    "default",
  );
  const w = mkWorld(root);
  w.kube.nodes = [
    { metadata: { name: "a" }, status: { nodeInfo: { architecture: "amd64" } } },
    { metadata: { name: "b" }, status: { nodeInfo: { architecture: "arm64" } } },
  ];
  assert.equal(await up(["--yes"], w.io), 0);

  const sandboxRef = imagesOf(w).sandbox.default as string;
  assert.match(sandboxRef, /^reg\.example\.com\/jr2\/jr2-sandbox-m-default:[0-9a-f]{12}-amd64-arm64$/);
  assert.ok(w.built.includes(`platform ${sandboxRef} linux/amd64,linux/arm64`), "one build, both platforms");
  assert.ok(!w.built.some((b) => b.startsWith("push ")), `buildx already pushed (got: ${w.built.join(", ")})`);
  assert.ok(!w.built.some((b) => b.startsWith("kind-load")), "…and a manifest list is never kind-loaded");
  // The seat is read where the artifact IS: the registry, not this daemon, which never held it.
  assert.ok(w.built.includes(`imagetools ${sandboxRef}`));
  assert.ok(!w.built.includes(`inspect-user ${sandboxRef}`));
});

test("a mixed-arch cluster with nowhere to push fails before any build", async () => {
  // By construction this cannot happen — a kind cluster's nodes are containers on one host, one
  // arch — but the code must not assume its own construction silently.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.nodes = [
    { metadata: { name: "a" }, status: { nodeInfo: { architecture: "amd64" } } },
    { metadata: { name: "b" }, status: { nodeInfo: { architecture: "arm64" } } },
  ];
  await assert.rejects(() => up(["--yes"], w.io), /buildx delivers by PUSHING[\s\S]*`registry`/);
  assert.deepEqual(w.built, ["bundle"], "staged, and nothing built");
});

test("a foreign-arch build is preflighted for binfmt — once, before any build is spent", async () => {
  // Without qemu the foreign `RUN` step dies minutes in with `exec format error`, the same symptom
  // ADR-0045 exists to delete. So emulation is proved first, and the error is a command to run.
  // A kit checkout, so there is a build to spend: an installed Instance with no `workspace()`
  // builds nothing at all (ADR-0069).
  const kit = await mkKit();
  const root = await mkInstance(`export default { name: "f", platforms: ["linux/arm64"] };\n`, "f");
  const w = mkWorld(root, { buildable: ["linux/amd64"], kitDir: kit });
  await assert.rejects(() => up(["--yes"], w.io), /tonistiigi\/binfmt --install arm64/);
  assert.ok(!w.built.some((b) => b.startsWith("build ")), `no build was spent (got: ${w.built.join(", ")})`);

  // Paid once, and only when a build is really about to happen: a steady-state converge still
  // spends no docker at all (the annotation test asserts the whole record is `["bundle"]`).
  const ok = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], ok.io), 0);
  assert.equal(ok.built.filter((b) => b === "buildable-check").length, 1);
  assert.ok(ok.built.indexOf("buildable-check") < ok.built.findIndex((b) => b.startsWith("build ")));
});

// --- Sandbox Images (ADR-0037) -----------------------------------------------------------------

test("a Sandbox Image is ONE build of the user's Dockerfile, inspected, and only when a Machine composes a Sandbox", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
    "default",
    "FROM node:24-slim\nRUN apt-get install -y cargo\n",
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const ref = imagesOf(w).sandbox.default as string;
  assert.match(ref, /^jr2-sandbox-myinst-default:[0-9a-f]{12}-amd64$/);
  // ONE build, of the user's own directory (ADR-0037). No `-base` intermediate exists any more:
  // that mutable shared name was the wrap's, and it serialized concurrent converges of one checkout.
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("build jr2-sandbox-")),
    [`build ${ref}`],
  );
  assert.ok(!w.built.some((b) => b.includes("-base:")), `no intermediate tag anywhere (got: ${w.built.join(", ")})`);
  assert.ok(w.built.includes(`build-with context-default ${ref}`), "the user's Dockerfile, its directory the context");
  const stamp = JSON.stringify({ "jr2.dev/kind": "sandbox", "jr2.dev/instance": "myinst" });
  assert.ok(w.built.includes(`stamp ${ref} ${stamp}`), "stamped on the command line (ADR-0039)");

  // The converge INSPECTS the image and proves nothing about it. The ADR-0037 floor is a
  // Harness-seat obligation, and this same directory may be destined for the User Container seat,
  // which owes no floor (ADR-0005) — which seat it serves is workflow-internal and statically
  // unrecoverable (ADR-0031). So there is no `docker run` on this path at all: the one prover is
  // the `preflight` init step at provision, where the seat is known.
  const harnessRef = imagesOf(w).harness as string;
  assert.ok(w.built.includes(`inspect-user ${ref}`), "the seat comes off the image itself");
  assert.ok(!w.built.some((b) => b.startsWith("run ")), `no probe container at converge (got: ${w.built.join(", ")})`);
  assert.ok(!w.built.some((b) => b.startsWith("extract ")), "…and no runtime is staged to mount into one");
  // The map carries what a provision cannot ask for (ADR-0037): "" = declares no USER, so the pod
  // applies uid 1000 + HOME=/home/jr2 on an emptyDir.
  assert.deepEqual(imagesOf(w).sandboxUser, { default: "" });

  // A Sandbox Image's hash covers its directory ALONE (ADR-0037/0038): a kit edit moves the harness
  // ref and re-images future pods, and re-tags, rebuilds, and re-delivers nothing of the user's.
  await writeFile(join(kit, "packages", "harness", "main.ts"), "export const x = 2;\n");
  const afterKitEdit = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], afterKitEdit.io), 0);
  assert.notEqual(imagesOf(afterKitEdit).harness, harnessRef, "the kit edit did move the harness ref");
  assert.equal(imagesOf(afterKitEdit).sandbox.default, ref, "…and the Sandbox Image tag stands still");

  // An image that declares its own USER records that string instead — the fallback's trigger is a
  // recorded `""`, so the two cases have to stay distinguishable in the map.
  const declared = mkWorld(root, { kitDir: kit, imageUser: "app" });
  assert.equal(await up(["--yes", "--force"], declared.io), 0);
  assert.deepEqual(imagesOf(declared).sandboxUser, { default: "app" });

  // No Machine composing a Sandbox, no Sandbox Image build — said out loud, not skipped silently
  // (ADR-0051: the switch is the walk, not a config key).
  const nosandbox = await withImage(await mkInstance(`export default { name: "n" };\n`, "n"), "default");
  const w2 = mkWorld(nosandbox, { kitDir: kit });
  assert.equal(await up(["--yes"], w2.io), 0);
  assert.ok(!w2.built.some((b) => b.includes("jr2-sandbox-")));
  assert.ok(!w2.built.some((b) => b.startsWith("extract ")));
  assert.match(w2.err.join("\n"), /sandbox images: skipped \(no registered Machine composes a Sandbox\)/);
  assert.deepEqual(imagesOf(w2).sandbox, {});
});

// --- the Repo Slots (ADR-0051): the walk's one refusal, and what the boot is handed ------------

test("an OPEN Repo Slot on a registered Machine is refused after the gate and before anything else", async () => {
  // The one converge-time check the compiler cannot make: a `workflows/` export has no type to
  // hang it on. So it is the walk's, right after the typecheck — before ownership, before any
  // build — and it names the Machine, the slot, and the `customize` line that binds it.
  const root = await withOpenSlot(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  // The Machine is the Workflow's own; the line names the import the author holds it by, never
  // the wrapper's xstate id (every `workspace()` shares it, and `workspace` is the kit's factory).
  assert.match(
    err,
    /refusing: workflow "packaged" leaves Repo Slot "target" open — bind it where the Machine is registered/,
  );
  assert.match(err, /export const machine = customize\(<import>, \{ repos: \{ target: "<url>" \} \}\)/);
  assert.doesNotMatch(err, /machine "workspace"|customize\(workspace,/);
  assert.match(err, /ADR-0051/);
  assert.deepEqual(w.kube.applied, [], "not even the namespace");
  assert.deepEqual(w.built, [], "no bundle, no image build");
  assert.deepEqual(w.confirms, [], "and no first-contact ask for a folder that cannot deploy");
});

test("an OPEN Repo Slot on a COMPOSED Machine is refused with the nested `actors` line that binds it", async () => {
  // The motivating case (ADR-0051): a packaged Machine invoked from an author Machine's slot.
  // `customize()` binds nested slots through `actors`, so the refusal locates the Machine by that
  // route and renders the line in the same nesting — what pastes into the workflows file.
  const root = await withOpenSlot(await mkInstance(`export default { name: "myinst" };\n`), "child");
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "packaged" leaves Repo Slot "target" open \(on the Machine composed as "review"\)/,
  );
  assert.match(
    err,
    /export const machine = customize\(<import>, \{ actors: \{ review: \{ repos: \{ target: "<url>" \} \} \} \}\)/,
  );
  assert.deepEqual(w.kube.applied, []);
  assert.deepEqual(w.built, []);
});

test("an OPEN Repo Slot MAP is refused as the Repo Slots, with the composer's `<slot>` left in the line", async () => {
  // `repos: open` (ADR-0051): the Machine names no slot, so the refusal cannot either — it names
  // the Machine and the line, and the placeholder is the composer's own word to fill.
  const root = await withOpenSlot(await mkInstance(`export default { name: "myinst" };\n`), "map");
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "packaged" leaves its Repo Slots open — bind it where the Machine is registered/,
  );
  assert.match(err, /export const machine = customize\(<import>, \{ repos: \{ <slot>: "<url>" \} \}\)/);
  assert.match(err, /ADR-0051/);
  assert.deepEqual(w.kube.applied, []);
  assert.deepEqual(w.built, []);
});

test("an OPEN Agent is refused the same way, with the `agents` line that binds the model (ADR-0054)", async () => {
  // The sibling of the Repo Slot refusal, and the reason `open` widened: a package cannot pick a
  // vendor, so the kit's own Machines ship with no model and the composer states one. The line is
  // ADR-0018's two-part spelling, because the provider prefix is what picks the endpoint.
  const root = await withOpenAgent(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "packaged" leaves Agent "coder" open — bind it where the Machine is registered/,
  );
  assert.match(
    err,
    /export const machine = customize\(<import>, \{ agents: \{ coder: \{ model: "<provider>\/<model>" \} \} \}\)/,
  );
  assert.match(err, /ADR-0054/);
  assert.deepEqual(w.kube.applied, [], "not even the namespace");
  assert.deepEqual(w.built, [], "no bundle, no image build");
  assert.deepEqual(w.confirms, [], "and no first-contact ask for a folder that cannot deploy");
});

test("an Effect's OPEN url or argv is refused the same way, with the `effects` line that binds it (ADR-0054)", async () => {
  // A packaged Machine cannot know the host its http Effect calls or the program its command runs;
  // until a composer binds it there is no host to fence and no argv to run, so the walk refuses it
  // before anything is built — both parts in one listing pass, each on its own line.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  await writeFile(
    join(root, "workflows", "packaged.ts"),
    `import { command, http, jr2Setup, open, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [], actors: { notify: http({ method: "POST", url: open }), deploy: command(open) } })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "packaged" leaves the url of Effect "notify" open — bind it where the Machine is registered/,
  );
  assert.match(
    err,
    /export const machine = customize\(<import>, \{ effects: \{ notify: \{ url: "https:\/\/<host>\/<path>" \} \} \}\)/,
  );
  // Every Open part is listed, not only the first (ADR-0069: the door returns the same lines).
  assert.match(err, /refusing: workflow "packaged" leaves the argv of Effect "deploy" open/);
  assert.equal((err.match(/^refusing: workflow "packaged" leaves/gm) ?? []).length, 2, "one line per Open part");
  assert.match(err, /ADR-0054/);
  assert.deepEqual(w.kube.applied, [], "not even the namespace");
  assert.deepEqual(w.built, [], "no bundle, no image build");

  // Bound by the composer, the same Machine passes the walk: what `jr2 up` reads is the bound part.
  // A fresh instance: the module cache keeps the first file's Machine under its path.
  const boundRoot = await mkInstance(`export default { name: "myinst" };\n`);
  await writeFile(
    join(boundRoot, "workflows", "packaged.ts"),
    `import { command, customize, http, jr2Setup, open, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [], actors: { notify: http({ method: "POST", url: open }), deploy: command(open) } })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `const shipped = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n` +
      `export const machine = customize(shipped, { effects: { notify: { url: "https://hooks.example.com/x" }, deploy: { argv: ["make", "deploy"] } } });\n`,
  );
  const bound = mkWorld(boundRoot);
  await up(["--yes"], bound.io);
  const out = bound.err.join("\n");
  assert.doesNotMatch(out, /leaves the (url|argv) of Effect/);
  assert.match(out, /notify: http POST https:\/\/hooks\.example\.com — 30s, in the Instance Effector/);
  assert.match(out, /deploy: command \["make","deploy"\]/);
});

test("an Effect's OPEN secret is refused the same way, with the `{ secret }` line — beside an Open url, one object (ADR-0054)", async () => {
  // A composer brings their own secret to a packaged Machine: until it is named there is no file to
  // place in the Effector, so the walk refuses it before anything is built, through workspace().
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  await writeFile(
    join(root, "workflows", "packaged.ts"),
    `import { bearer, http, jr2Setup, open, secret, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [], actors: {\n` +
      `  notify: http({ method: "POST", url: "https://hooks.example.com/x", auth: bearer(secret(open)) }),\n` +
      `  page: http({ method: "POST", url: open, auth: bearer(secret(open)) }) } })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "packaged" leaves the secret of Effect "notify" open — bind it where the Machine is registered/,
  );
  assert.match(
    err,
    /export const machine = customize\(<import>, \{ effects: \{ notify: \{ secret: "<name>" \} \} \}\)/,
  );
  assert.deepEqual(w.kube.applied, [], "not even the namespace");

  // The url and the secret of one Effect: one line, one object with both keys.
  const both = await mkInstance(`export default { name: "myinst" };\n`);
  await writeFile(
    join(both, "workflows", "packaged.ts"),
    `import { bearer, http, jr2Setup, open, secret, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [], actors: { page: http({ method: "POST", url: open, auth: bearer(secret(open)) }) } })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const w2 = mkWorld(both);
  assert.equal(await up(["--yes"], w2.io), 1);
  const err2 = w2.err.join("\n");
  assert.match(err2, /leaves the url and secret of Effect "page" open/);
  assert.match(
    err2,
    /customize\(<import>, \{ effects: \{ page: \{ url: "https:\/\/<host>\/<path>", secret: "<name>" \} \} \}\)/,
  );
});

test("up prints who may send what, per state, and the load warnings — a warning converges on (ADR-0015)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  // A Gate on the parent takes `abandon` from the Agent below: legal, and warned.
  await writeFile(
    join(root, "workflows", "job.ts"),
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` +
      `import { agent, defineEvent, jr2Setup } from ${JSON.stringify(KIT_SRC)};\n` +
      `const finish = defineEvent({ name: "finish", input: z.object({}) });\n` +
      `const abandon = defineEvent({ name: "abandon", input: z.object({}) });\n` +
      `export const machine = jr2Setup({ events: [finish, abandon], actors: { coder: agent({ model: "p/m", instructions: "i" }) } })\n` +
      `  .createMachine({ id: "job", initial: "job", states: {\n` +
      `    job: { invoke: { src: "gate", id: "operator" }, on: { abandon: "gaveUp" }, initial: "working", states: {\n` +
      `      working: { invoke: { src: "coder", input: { prompt: "go" } }, on: { finish: "#job.done" } } } },\n` +
      `    gaveUp: { type: "final" }, done: { type: "final" } } });\n`,
  );
  const w = mkWorld(root);
  await up(["--yes"], w.io);
  const err = w.err.join("\n");
  assert.match(err, /seats: workflow "job" — who may send what, per state \(ADR-0015\)/);
  assert.match(err, /\n {2}job\.job gate: \[abandon\]\n+ {2}job\.job\.working agent:coder: \[finish\]/);
  assert.match(err, /warning: workflow "job": Agent "coder" on "job\.job\.working" cannot send "abandon"/);
  assert.match(err, /converged/, "a warning converges on");
});

test("a bound Repo is narrated as the boot's to create; each token git.credentials names goes into its entry's clone Secret, never the Orchestrator's (ADR-0068)", async () => {
  // `jr2 up` clones nothing (ADR-0051): the Orchestrator creates a Repo resource per bound identity
  // at boot and the cache agent clones on first need, on the node that needs it. What the
  // converge does hold is the credential: each entry's token, when set, lands in that entry's own
  // clone Secret (`jr2-git-<hash>`, Flux's key names) and `git-clone.json` names it — and the
  // Orchestrator's Secret and env hold no git token (ADR-0068).
  const root = await withWorkspace(
    await mkInstance(
      `export default { name: "myinst", git: { credentials: [` +
        `{ match: "github.com/acme/", token: "GH_TOKEN" }, { match: "*", token: "JR2_GIT_TOKEN" }, { match: "gitlab.com/", token: "GL_TOKEN" }` +
        `] } };\n`,
    ),
  );
  const w = mkWorld(root, { env: { GH_TOKEN: "gh-secret", JR2_GIT_TOKEN: "wild-secret", STRAY: "no" } });
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(
    w.err.join("\n"),
    /repos: 1 bound Repo\(s\) — the Orchestrator creates their Repo resources at boot and at each publish/,
  );
  assert.match(w.err.join("\n"), /cache agent clones on first need/);

  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const instance = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-instance")!;
  for (const name of ["GH_TOKEN", "JR2_GIT_TOKEN", "GL_TOKEN", "STRAY"]) {
    assert.ok(!(name in instance.stringData), `${name} is not in the Orchestrator's Secret`);
  }
  // What it does hold is jr2's own, as ADR-0068 and ADR-0069 name it: the signing key, the
  // Instance token, the publish token, the Instance Harness's token — and nothing else.
  assert.deepEqual(
    Object.keys(instance.stringData).sort(),
    ["JR2_INSTANCE_HARNESS_TOKEN", "JR2_INSTANCE_TOKEN", "JR2_PUBLISH_TOKEN", "JR2_SIGNING_KEY"],
    "the Orchestrator's Secret holds jr2's own keys alone",
  );
  assert.ok(
    !Object.values(instance.stringData as Record<string, string>).some((v) => v === "gh-secret" || v === "wild-secret"),
    "no git token's value rides the Orchestrator's Secret under any name",
  );
  const clone = items.filter((i) => i.kind === "Secret" && i.metadata.labels?.["jr2.dev/git-clone"] === "true");
  assert.deepEqual(
    clone.map((s) => s.metadata.name).sort(),
    [gitTokenSecretName("github.com/acme/"), gitTokenSecretName("*")].sort(),
    "one clone Secret per entry whose token is set; an unset one writes none",
  );
  assert.deepEqual(clone.find((s) => s.metadata.name === gitTokenSecretName("github.com/acme/"))!.stringData, {
    username: "x-access-token",
    password: "gh-secret",
  });
  const held = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-held")!;
  assert.deepEqual(JSON.parse(held.data["git-clone.json"]).secrets.sort(), clone.map((s) => s.metadata.name).sort());
  const orchSecrets = items
    .find((i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator")!
    .spec.template.spec.containers[0].envFrom.map((e: { secretRef?: { name: string } }) => e.secretRef?.name);
  assert.deepEqual(orchSecrets, ["jr2-instance"], "the Orchestrator's env reads the instance Secret alone");
  // The Orchestrator neither clones nor holds a key: its one claim is its state, its mounts are
  // state, the image map and the held-secret manifest (names and hosts, never a value — ADR-0059),
  // and its env is its namespace — the credential rides the Secret above and is
  // read only by the cache agent. The one addition is the API server's trust, for its own client
  // (ADR-0063).
  assert.deepEqual(
    items.filter((i) => i.kind === "PersistentVolumeClaim").map((i) => i.metadata.name),
    ["jr2-state"],
  );
  const orch = items.find((i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator")!;
  const podSpec = orch.spec.template.spec;
  assert.deepEqual(
    podSpec.volumes.map((v: { name: string }) => v.name),
    ["state", "images", "held"],
  );
  assert.deepEqual(
    podSpec.containers[0].env.map((e: { name: string }) => e.name),
    ["JR2_NAMESPACE", "NODE_EXTRA_CA_CERTS"],
  );
  // Built-in `fetch` trusts the API server through the ServiceAccount's own CA (ADR-0063).
  assert.equal(
    podSpec.containers[0].env.find((e: { name: string }) => e.name === "NODE_EXTRA_CA_CERTS").value,
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  );
});

// --- the data plane (ADR-0051): the cache agent DaemonSet, converged with the same switch --------

/** The cache agent's objects, as this converge applied them — or nothing, when it did not. */
function findRepoCache(w: World): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const manifest of w.kube.applied) {
    if (!manifest.trimStart().startsWith("{")) continue;
    const doc = JSON.parse(manifest) as { kind?: string; items?: Array<Record<string, any>> };
    for (const i of doc.kind === "List" ? (doc.items ?? []) : []) {
      if (i.metadata?.name === "jr2-repo-cache") out[i.kind] = i;
    }
  }
  return out;
}

test("a Machine composing a Sandbox converges the cache agent: one root-seated pod per node over the node's cache directory", async () => {
  // The data plane's node half (ADR-0051, ADR-0004): a DaemonSet running the operator image as
  // `/manager repo-cache`, the one writer of `/var/lib/jr2/<namespace>/repos` on its node — the
  // hostPath the operator mounts a leaf of, read-only, into every Sandbox there. The switch is
  // the walk's, exactly as for the Sandbox Images: a Machine composes a Sandbox, so the cluster
  // needs somewhere to clone from.
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const objects = findRepoCache(w);
  assert.deepEqual(Object.keys(objects).sort(), ["DaemonSet", "Role", "RoleBinding", "ServiceAccount"]);
  const ds = objects.DaemonSet!;
  const podSpec = ds.spec.template.spec;
  assert.equal(ds.spec.selector.matchLabels.app, "jr2-repo-cache");
  assert.equal(ds.metadata.labels["jr2.dev/instance"], "myinst", "owned like every other object");

  // The same binary as the operator, at the ref THIS converge resolved (installed here, so the
  // published one at the kit version), dispatched into its second entrypoint.
  const agent = podSpec.containers[0];
  assert.equal(agent.name, "agent");
  assert.equal(agent.image, imagesOf(w).operator, "the record and the pod name one operator ref");
  assert.match(agent.image, /^ghcr\.io\/snapwich\/jr2-operator:/);
  assert.deepEqual(agent.command, ["/manager", "repo-cache"]);

  // The node directory, created by the kubelet, mounted where `--cache-dir` defaults.
  const cache = podSpec.volumes.find((v: { name: string }) => v.name === "cache");
  assert.deepEqual(cache.hostPath, { path: "/var/lib/jr2/myinst/repos", type: "DirectoryOrCreate" });
  assert.equal(agent.volumeMounts.find((m: { name: string }) => m.name === "cache").mountPath, "/cache");
  // The seat is root — the kubelet creates that directory root-owned — and nothing else is loose:
  // no capabilities, no escalation, a read-only root with $HOME and /tmp on emptyDirs.
  assert.equal(agent.securityContext.runAsUser, 0);
  assert.equal(agent.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(agent.securityContext.capabilities, { drop: ["ALL"] });
  assert.equal(agent.securityContext.readOnlyRootFilesystem, true);
  assert.ok(agent.env.some((e: { name: string; value?: string }) => e.name === "HOME" && e.value === "/home/jr2"));
  assert.ok(podSpec.volumes.some((v: { name: string; emptyDir?: unknown }) => v.name === "home" && v.emptyDir));
  assert.ok(podSpec.volumes.some((v: { name: string; emptyDir?: unknown }) => v.name === "tmp" && v.emptyDir));
  // Which node it writes for, and whose Repos it watches, come off the downward API.
  const env = Object.fromEntries(agent.env.map((e: { name: string }) => [e.name, e]));
  assert.deepEqual(env.NODE_NAME.valueFrom, { fieldRef: { fieldPath: "spec.nodeName" } });
  assert.deepEqual(env.JR2_NAMESPACE.valueFrom, { fieldRef: { fieldPath: "metadata.namespace" } });
  // Exactly the Sandbox nodes (ADR-0052): no placement configured, so no tolerations and no
  // selector — the agent lands where an ordinary pod lands, which is where a Sandbox lands.
  assert.equal(podSpec.tolerations, undefined);
  assert.equal(podSpec.nodeSelector, undefined);
  assert.match(w.err.join("\n"), /^sandbox nodes: kind-test-control-plane$/m);
  // It is an API client (its own status entry, the Repos, the pods on its node that mount a
  // cache, the credential Secret a Repo names) — read-mostly, and never a creator or deleter of
  // anything.
  assert.equal(podSpec.serviceAccountName, "jr2-repo-cache");
  assert.equal(podSpec.automountServiceAccountToken, true);
  assert.deepEqual(objects.Role!.rules, [
    { apiGroups: ["core.jr2.dev"], resources: ["repos"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["core.jr2.dev"], resources: ["repos/status"], verbs: ["get", "patch", "update"] },
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ]);
  // Demand is a pod's mount, so the agent never reads a Sandbox — nor `status.node`, which is
  // published for a reader of the Sandbox, not for the agent.
  assert.ok(
    !objects.Role!.rules.some((r: { resources: string[] }) => r.resources.includes("sandboxes")),
    "the cache agent's Role names no Sandbox resource",
  );

  // Waited on and verified like every other layer: a DaemonSet that never scheduled is a data
  // plane every provision would park on.
  assert.ok(w.kube.rollouts.includes("myinst/daemonset/jr2-repo-cache"), `got: ${w.kube.rollouts.join(", ")}`);
  assert.match(w.err.join("\n"), /repo cache: verified — 1 pod\(s\) running ghcr\.io\/snapwich\/jr2-operator:/);
  assert.ok(!w.kube.deleted.some((d) => d.includes("jr2-repo-cache")), "nothing of its own is deleted");
});

test("`sandbox.nodeSelector`/`tolerations` ride the cache agent verbatim, and the Sandbox nodes are reported (ADR-0052)", async () => {
  const root = await withWorkspace(
    await mkInstance(
      `export default { name: "myinst", sandbox: { nodeSelector: { pool: "agents" }, ` +
        `tolerations: [{ key: "gpu", operator: "Exists", effect: "NoSchedule" }] } };\n`,
    ),
  );
  const w = mkWorld(root);
  w.kube.nodes = [
    {
      metadata: { name: "cp" },
      spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
    { metadata: { name: "plain" }, status: { nodeInfo: { architecture: "amd64" } } },
    {
      metadata: { name: "gpu-1", labels: { pool: "agents" } },
      spec: { taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
  ];
  assert.equal(await up(["--yes"], w.io), 0);

  const podSpec = findRepoCache(w).DaemonSet!.spec.template.spec;
  assert.deepEqual(podSpec.nodeSelector, { pool: "agents" });
  assert.deepEqual(podSpec.tolerations, [{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);
  const err = w.err.join("\n");
  // The admitted pool joins the build set beside the Orchestrator's own node; the control plane,
  // tainted and untolerated, is not a platform this instance owes an image.
  assert.match(err, /platforms: linux\/amd64 \(from 2 schedulable node\(s\)\)/);
  assert.match(err, /^sandbox nodes: gpu-1$/m);
});

test("no Sandbox node right now is a warning, never a refusal — the set moves (ADR-0052)", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  w.kube.nodes = [
    {
      metadata: { name: "cp" },
      spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
    { metadata: { name: "old" }, spec: { unschedulable: true }, status: { nodeInfo: { architecture: "amd64" } } },
  ];
  // The build set is empty too, and ADR-0045's answer for that stands: `platforms` names it.
  await assert.rejects(up(["--yes"], w.io), /this cluster's schedulable nodes report no architecture at all/);

  const pinned = await withWorkspace(
    await mkInstance(`export default { name: "p", platforms: ["linux/amd64"] };\n`, "p"),
  );
  const p = mkWorld(pinned);
  p.kube.nodes = w.kube.nodes;
  assert.equal(await up(["--yes"], p.io), 0, "told the platform, the converge needs no node at all");
  assert.ok(findRepoCache(p).DaemonSet, "the data plane converges regardless");

  // With nodes readable and none admitting a Sandbox: every exclusion is named, and the fix line.
  const sole = mkWorld(root);
  sole.kube.nodes = [
    {
      metadata: { name: "cp" },
      spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
    {
      metadata: { name: "gpu-1" },
      spec: { taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
  ];
  // No ordinary-pod node either, so derivation fails before the report; pin the platform to see it.
  const pinnedRoot = await withWorkspace(
    await mkInstance(`export default { name: "q", platforms: ["linux/amd64"] };\n`, "q"),
  );
  const q = mkWorld(pinnedRoot);
  q.kube.nodes = sole.kube.nodes;
  assert.equal(await up(["--yes"], q.io), 0);
  // `platforms` skips the node read, and the report with it — a converge told the answer asks no
  // question of the nodes (ADR-0045).
  assert.doesNotMatch(q.err.join("\n"), /sandbox nodes|no Sandbox node/);
});

test("the Sandbox-node warning names each exclusion and the config line (ADR-0052)", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  w.kube.nodes = [
    // An ordinary-pod node exists (the Orchestrator lands), but the selector admits none of them.
    { metadata: { name: "plain" }, status: { nodeInfo: { architecture: "amd64" } } },
    {
      metadata: { name: "gpu-1" },
      spec: { taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] },
      status: { nodeInfo: { architecture: "amd64" } },
    },
  ];
  const selective = await withWorkspace(
    await mkInstance(`export default { name: "s", sandbox: { nodeSelector: { pool: "agents" } } };\n`, "s"),
  );
  const s = mkWorld(selective);
  s.kube.nodes = w.kube.nodes;
  assert.equal(await up(["--yes"], s.io), 0, "warned, converged");
  const err = s.err.join("\n");
  assert.match(err, /warning: no Sandbox node right now — a Sandbox stays Pending until one appears:/);
  assert.match(err, /^  plain: lacks the label pool that sandbox.nodeSelector requires$/m);
  assert.match(err, /^  gpu-1: lacks the label pool that sandbox.nodeSelector requires$/m);
  assert.match(err, /set `sandbox: \{ nodeSelector, tolerations \}` in jr2.config.ts/);
  assert.ok(findRepoCache(s).DaemonSet, "the data plane converges regardless");
  assert.deepEqual(findRepoCache(s).DaemonSet!.spec.template.spec.nodeSelector, { pool: "agents" });
});

test("the Orchestrator's Role reaches the Repo resources it creates", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const role = items.find((i) => i.kind === "Role" && i.metadata.name === "jr2-orchestrator")!;
  const crds = role.rules.find((r: { apiGroups: string[] }) => r.apiGroups.includes("core.jr2.dev"));
  assert.ok(
    crds.resources.includes("repos"),
    `the Orchestrator creates, labels, and lists Repos (got: ${crds.resources})`,
  );
  // …and nothing on Pods (ADR-0063): it never reads one — the operator publishes the pod facts on
  // the Sandbox — and the attach is the Harness's own route, so `pods/exec` is not the Orchestrator's.
  const podRules = role.rules.filter((r: { resources: string[] }) => r.resources.some((x) => x.startsWith("pods")));
  assert.deepEqual(podRules, [], "no pods, pods/log, pods/exec or pods/portforward");
});

test("no Machine composing a Sandbox → no cache agent, and a stale one is deleted on converge", async () => {
  // The switch converges both ways (ADR-0051): a Machine that dropped its `workspace()` leaves no
  // DaemonSet writing the node's disk — nor the ServiceAccount and Role that existed only for it.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.deepEqual(findRepoCache(w), {});
  assert.ok(!w.kube.rollouts.some((r) => r.includes("daemonset/")), "nothing to wait on");
  for (const kind of ["daemonset", "serviceaccount", "role", "rolebinding"]) {
    assert.ok(w.kube.deleted.includes(`myinst/${kind}/jr2-repo-cache`), `stale ${kind} deleted`);
  }
  assert.equal(imagesOf(w).operator !== undefined, true, "the operator layer still resolved its image");
});

test("operator.manage: false with a data plane still resolves the operator image — the cache agent runs it", async () => {
  // The controller loop may be somebody else's (manage: false), but the cache agent is THIS
  // instance's DaemonSet and it is the same binary — so the image is built, delivered, recorded,
  // and run, while the operator manifest itself stays untouched.
  const kit = await mkKit();
  const root = await withWorkspace(
    await mkInstance(`export default { name: "myinst", operator: { manage: false } };\n`),
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  assert.ok(!w.kube.applied.some((m) => m.includes("controller-manager")), "the operator layer is skipped");
  assert.match(w.err.join("\n"), /operator: skipped \(operator\.manage: false/);
  const built = w.built.find((b) => b.startsWith("build jr2-operator:"));
  assert.ok(built, `the operator image is built for the cache agent (got: ${w.built.join(", ")})`);
  const ref = built.slice("build ".length);
  assert.equal(imagesOf(w).operator, ref, "…and recorded, so the next converge can skip the build");
  assert.equal(findRepoCache(w).DaemonSet!.spec.template.spec.containers[0].image, ref);
});

test("live workspaces on an older image are reported, and nothing re-images them", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  w.kube.sandboxes = [
    { metadata: { name: "ws-1" }, spec: { image: "jr2-sandbox-myinst-default:0ldc0ntent" } },
    { metadata: { name: "ws-2" }, spec: { image: "jr2-sandbox-myinst-default:0ldc0ntent" } },
  ];
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /2 running workspace\(s\) keep `jr2-sandbox-myinst-default:0ldc0ntent`/);
  assert.match(w.err.join("\n"), /delete those runs to re-image/);
  assert.ok(!w.kube.deleted.some((d) => d.includes("ws-")), "a running Workspace is never touched (ADR-0021)");

  // The CRD may not be installed at all: informational, so a failed look degrades to a warning.
  const noCrd = mkWorld(root);
  noCrd.kube.sandboxListFails = true;
  assert.equal(await up(["--yes"], noCrd.io), 0);
  assert.match(noCrd.err.join("\n"), /workspaces: could not be listed/);
});

// --- the Assembly (ADR-0069): staged early, published last ----------------------------------------

/** The hash `jr2 up` staged, off its own narration. */
function stagedHash(w: World): string {
  const hash = /assembly: ([0-9a-f]{12}) \(kit v/.exec(w.err.join("\n"))?.[1];
  assert.ok(hash, `jr2 up narrated the staged Assembly:\n${w.err.join("\n")}`);
  return hash;
}

test("the Deployment runs the Orchestrator Kit image and carries no content hash (ADR-0069)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const deployment = deploymentOf(w);
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, `ghcr.io/snapwich/jr2-orchestrator:${KIT_VERSION}`, "the published Kit ref");
  assert.deepEqual(
    Object.keys(deployment.metadata.labels).sort(),
    ["app.kubernetes.io/managed-by", "jr2.dev/instance", "jr2.dev/version"],
    "no content-hash label: the Assembly hash is an Orchestrator fact",
  );
  assert.ok(!container.env.some((e: { name: string }) => e.name === "JR2_CONTENT_HASH"), "and no content-hash env");
  const record = JSON.parse(deployment.metadata.annotations["jr2.dev/images"]);
  assert.equal(record.orchestrator, container.image, "the images record carries the Orchestrator's ref");
  assert.equal(imagesOf(w).orchestrator, container.image);

  // ADR-0069's main consequence: another Assembly is a publish, not a pod-template change. A
  // Workflow edit and an Instance dependency move the hash and leave the template as it was.
  await writeFile(
    join(root, "workflows", "note.ts"),
    `import { jr2Setup } from ${JSON.stringify(KIT_SRC)};\n` +
      `export const machine = jr2Setup({ events: [] }).createMachine({ id: "note", initial: "idle", states: { idle: {} } });\n`,
  );
  const next = mkWorld(root, { bundleFiles: { ...STAGED_FILES, "node_modules/dep/index.js": "export {};\n" } });
  next.orchestrator.current = { hash: stagedHash(w), kitVersion: KIT_VERSION };
  // The Instance Secret the first converge wrote, kept: a minted one would roll the pod by design.
  const kept = (
    JSON.parse(w.kube.applied.find(isInstanceList)!) as {
      items: Array<Record<string, any>>;
    }
  ).items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-instance")!;
  next.kube.set("myinst", "secret", "jr2-instance", {
    metadata: { name: "jr2-instance" },
    data: Object.fromEntries(
      Object.entries(kept.stringData as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
    ),
  });
  const code = await up(["--yes"], next.io);
  assert.notEqual(stagedHash(next), stagedHash(w), "another Assembly");
  assert.equal(code, 0, next.err.join("\n"));
  assert.equal(next.orchestrator.puts.length, 1, "published");
  assert.deepEqual(deploymentOf(next).spec.template, deployment.spec.template, "the pod template did not move");
});

test("the publish token is minted into the Instance Secret and read back from it, never from the environment", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  // A token in the environment is no way in (ADR-0069): an ingress-exposed Instance exposes no
  // publish door.
  const env = { JR2_PUBLISH_TOKEN: "from-env", JR2_TOKEN: "from-env", JR2_URL: "http://elsewhere.test" };
  const first = mkWorld(root, { env });
  assert.equal(await up(["--yes"], first.io), 0);
  const list = first.kube.applied.find(isInstanceList)!;
  const secret = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Secret" && i.metadata.name === "jr2-instance",
  )!;
  const minted = secret.stringData.JR2_PUBLISH_TOKEN as string;
  assert.match(minted, /^[0-9a-f]{48}$/, "minted on first converge");
  assert.notEqual(minted, secret.stringData.JR2_INSTANCE_TOKEN, "it is not the Instance token");
  assert.equal(first.orchestrator.puts.length, 1);
  assert.equal(first.orchestrator.puts[0]!.headers.authorization, `Bearer ${minted}`);
  assert.deepEqual(first.orchestrator.forwards, ["myinst/jr2-orchestrator:4000"], "over a port-forward, never JR2_URL");

  // A kept one is read back from the Secret the converge read, and published with.
  const kept = mkWorld(root, { env });
  kept.kube.set("myinst", "secret", "jr2-instance", {
    metadata: { name: "jr2-instance" },
    data: { JR2_PUBLISH_TOKEN: Buffer.from("pub-kept").toString("base64") },
  });
  assert.equal(await up(["--yes"], kept.io), 0);
  const keptList = kept.kube.applied.find(isInstanceList)!;
  const keptSecret = (JSON.parse(keptList) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Secret" && i.metadata.name === "jr2-instance",
  )!;
  assert.equal(keptSecret.stringData.JR2_PUBLISH_TOKEN, "pub-kept", "the token persists across converges");
  assert.equal(kept.orchestrator.puts[0]!.headers.authorization, "Bearer pub-kept");

  // A changed token rolls the Orchestrator: `envFrom` is read once per pod, so the pod template
  // carries a keyed digest of the Secret, and the digest reveals no token.
  const digestOf = (l: string): string => {
    const deployment = (JSON.parse(l) as { items: Array<Record<string, any>> }).items.find(
      (i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator",
    )!;
    return deployment.spec.template.metadata.annotations["jr2.dev/secret-digest"] as string;
  };
  assert.ok(digestOf(list), "the pod template carries the Secret's digest");
  assert.notEqual(digestOf(keptList), digestOf(list), "another publish token is another pod template");
  assert.ok(!digestOf(list).includes(minted) && !keptList.includes(`secret-digest":"pub-kept`));
  const again = mkWorld(root, { env });
  again.kube.set("myinst", "secret", "jr2-instance", {
    metadata: { name: "jr2-instance" },
    data: Object.fromEntries(
      Object.entries(keptSecret.stringData as Record<string, string>).map(([k, v]) => [
        k,
        Buffer.from(v).toString("base64"),
      ]),
    ),
  });
  assert.equal(await up(["--yes"], again.io), 0);
  assert.equal(
    digestOf(again.kube.applied.find(isInstanceList)!),
    digestOf(keptList),
    "the same Secret is the same pod template: a steady converge rolls nothing",
  );
});

test("GET /assembly first: the current Assembly is not published again; another is PUT with its headers", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", { coder: { model: "openai/gpt-x" } });
  const first = mkWorld(root);
  assert.equal(await up(["--yes"], first.io), 0);
  const hash = stagedHash(first);
  assert.deepEqual(
    first.orchestrator.requests.map((r) => r.method),
    ["GET", "PUT"],
    "a fresh namespace holds no current Assembly, so the converge publishes",
  );
  const put = first.orchestrator.puts[0]!;
  assert.equal(put.headers["content-type"], "application/x-tar");
  assert.equal(put.headers["jr2-kit-version"], KIT_VERSION);
  assert.equal(put.headers["jr2-assembly-hash"], hash);
  assert.ok(put.bytes > 0 && put.bytes % 512 === 0, `one ustar archive (got ${put.bytes} bytes)`);
  assert.equal(first.orchestrator.closed, 1, "the port-forward lives only as long as the publish");
  const said = first.err.join("\n");
  assert.match(said, new RegExp(`assembly: ${hash} is current — workflows: work`), "the door's workflows are printed");
  assert.ok(
    said.indexOf("assembly: publishing") > said.indexOf("instance effector:"),
    "published after every other layer",
  );
  assert.ok(said.indexOf("assembly: staging") < said.indexOf("kubernetes:"), "staged before any cluster read");

  const again = mkWorld(root);
  again.orchestrator.current = { hash, kitVersion: KIT_VERSION };
  assert.equal(await up(["--yes"], again.io), 0);
  assert.deepEqual(again.orchestrator.puts, [], "the hashes agree: nothing is sent");
  assert.match(again.err.join("\n"), new RegExp(`assembly: ${hash} \\(current — publish skipped\\)`));

  // Another Kit version under the same hash is not current: the door decides.
  const other = mkWorld(root);
  other.orchestrator.current = { hash, kitVersion: "0.0.1" };
  assert.equal(await up(["--yes"], other.io), 0);
  assert.equal(other.orchestrator.puts.length, 1);

  // --force publishes even when they agree; the door answers `unchanged`.
  const forced = mkWorld(root);
  forced.orchestrator.current = { hash, kitVersion: KIT_VERSION };
  assert.equal(await up(["--yes", "--force"], forced.io), 0);
  assert.equal(forced.orchestrator.puts.length, 1);
  assert.match(forced.err.join("\n"), /is current \(unchanged\)/);
});

test("a refused publish prints the door's report and fails the converge before the sweep", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const stale = image({ id: "sha256:old", tags: ["jr2-sandbox-myinst-default:0ld"], bytes: 1 });
  const w = mkWorld(root, { hostImages: [stale] });
  w.orchestrator.current = { hash: "0123456789ab", kitVersion: KIT_VERSION };
  w.orchestrator.refuse.push({
    status: 422,
    body: { error: "refused", report: ['workflow "work" leaves Agent "coder" open', "a second line"] },
  });
  assert.equal(await up(["--yes"], w.io), 1);
  const said = w.err.join("\n");
  assert.match(
    said,
    /refusing: the Orchestrator refused Assembly [0-9a-f]{12} \(HTTP 422\): refused — the previous Assembly is still current/,
  );
  assert.match(said, /^ {2}workflow "work" leaves Agent "coder" open$/m, "each report line is printed");
  assert.match(said, /^ {2}a second line$/m);
  assert.doesNotMatch(said, /converged —/, "the converge does not claim success");
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("rmi-")),
    [],
    "and sweeps nothing",
  );
  assert.deepEqual(w.orchestrator.current, { hash: "0123456789ab", kitVersion: KIT_VERSION });

  const version = mkWorld(root);
  version.orchestrator.refuse.push({
    status: 409,
    body: { error: "the Assembly names Kit version 9.9.9; this Orchestrator is 0.3.0", kitVersion: {} },
  });
  assert.equal(await up(["--yes"], version.io), 1);
  assert.match(version.err.join("\n"), /HTTP 409\): the Assembly names Kit version 9\.9\.9/);
});

test("a publish waits until the Orchestrator reads the mounted ConfigMaps this converge applied (ADR-0069)", async () => {
  // A publish rolls no pod, so `jr2-images` and `jr2-held` reach the process on the kubelet's
  // period. The PUT waits for the digests `GET /assembly` reports to be the applied ones.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const applied = (w: World): Record<string, string> => {
    const list = JSON.parse(w.kube.applied.find(isInstanceList)!) as {
      items: Array<{ kind: string; metadata: { name: string }; data?: Record<string, string> }>;
    };
    return Object.fromEntries(
      list.items
        .filter((i) => i.kind === "ConfigMap" && i.metadata.name in MOUNTED_CONFIGMAPS)
        .map((i) => [i.metadata.name, configMapDigest(i.data ?? {})]),
    );
  };
  const saved = { ...MAP_PROPAGATION };
  MAP_PROPAGATION.stepMs = 1;
  try {
    const w = mkWorld(root);
    // The first two reads see the old held manifests; the third sees this converge's.
    w.orchestrator.mounts = (n) => (n < 2 ? { ...applied(w), "jr2-held": "0ld" } : applied(w));
    assert.equal(await up(["--yes"], w.io), 0);
    assert.deepEqual(
      w.orchestrator.requests.map((r) => r.method),
      ["GET", "GET", "GET", "PUT"],
      "the PUT waits for the mount",
    );
    assert.match(w.err.join("\n"), /waiting for the kubelet to deliver jr2-held/);
    assert.deepEqual(Object.keys(applied(w)).sort(), ["jr2-held", "jr2-images"]);

    // A mount that never refreshes refuses the converge, and nothing is sent.
    MAP_PROPAGATION.budgetMs = 5;
    const never = mkWorld(root);
    never.orchestrator.mounts = () => ({ "jr2-images": "0ld", "jr2-held": "0ld" });
    assert.equal(await up(["--yes"], never.io), 1);
    assert.deepEqual(never.orchestrator.puts, []);
    assert.match(never.err.join("\n"), /still reads an older jr2-images, jr2-held from its mount/);
  } finally {
    Object.assign(MAP_PROPAGATION, saved);
  }
});

test("a door refusal for a `file:` digest is final: no retry, one PUT", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.orchestrator.refuse.push({
    status: 422,
    body: {
      error: "refused",
      report: ["the Sandbox Image context file:///x (digest abc) is not in the image map — …"],
    },
  });
  assert.equal(await up(["--yes"], w.io), 1);
  assert.equal(w.orchestrator.puts.length, 1);
  assert.match(w.err.join("\n"), /digest abc\) is not in the image map/);
});

test("the Assembly is staged before any cluster spend: a second copy of a Kit package refuses with nothing applied", async () => {
  // ADR-0054's silent-empty-Menus failure, refused at staging (ADR-0069): the Orchestrator's image
  // ships xstate, so an Assembly that carries a second copy is refused, naming who nests it.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const pkg = (name: string, version: string, dependencies: Record<string, string> = {}) =>
    JSON.stringify({ name, version, dependencies });
  const w = mkWorld(root, {
    bundleFiles: {
      "package.json": "{}",
      "node_modules/@jr2/orchestrator/package.json": pkg("@jr2/orchestrator", KIT_VERSION, { xstate: "^5" }),
      "node_modules/xstate/package.json": pkg("xstate", "5.0.0"),
      "node_modules/helper/package.json": pkg("helper", "1.0.0", { xstate: "^4" }),
      "node_modules/helper/node_modules/xstate/package.json": pkg("xstate", "4.0.0"),
    },
  });
  await assert.rejects(() => up(["--yes"], w.io), /second copy of a Kit package[\s\S]*helper/);
  assert.deepEqual(w.kube.applied, [], "not even the namespace");
  assert.equal(w.kube.versionReads, 0, "the cluster was never asked");
});

test("a staged Assembly that lacks a Workflow the walk loaded refuses before any cluster spend (ADR-0069)", async () => {
  // The walk loads the Instance folder; the door loads the Assembly. A Workflow the install did
  // not keep (a `files:` list that leaves it out) would publish without it, and `jr2 run` would
  // name it unknown after `converged`.
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", { coder: { model: "openai/gpt-x" } });
  const w = mkWorld(root);
  const bundle = w.io.build!.bundle;
  w.io.build = {
    ...w.io.build!,
    bundle: async (dir, out) => {
      await bundle(dir, out);
      await rm(join(out, "workflows", "work.ts"));
    },
  };
  assert.equal(await up(["--yes"], w.io), 1);
  assert.match(
    w.err.join("\n"),
    /refusing: the staged Assembly does not hold[^\n]*absent from the Assembly: workflows\/work\.ts[^\n]*`files:`/,
  );
  assert.deepEqual(w.kube.applied, [], "nothing applied");

  const extra = mkWorld(root, { bundleFiles: { ...STAGED_FILES, "workflows/stray.ts": "export {};\n" } });
  assert.equal(await up(["--yes"], extra.io), 1);
  assert.match(extra.err.join("\n"), /only in the Assembly: workflows\/stray\.ts/);
});

test("the Assembly hash addresses the stripped tree: an Instance dependency moves it, a Kit source does not", async () => {
  // The Kit closure is stripped (ADR-0069): its sources are the Orchestrator Kit image's content,
  // and an edit there moves that image's ref. An Instance dependency rides the Assembly.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const hashWith = async (kit: string, dep: string): Promise<string> => {
    const w = mkWorld(root, {
      bundleFiles: {
        ...STAGED_FILES,
        "node_modules/@jr2/orchestrator/src/lease.ts": kit,
        "node_modules/@jr2/machines/src/coder.ts": dep,
      },
    });
    assert.equal(await up(["--yes"], w.io), 0);
    return stagedHash(w);
  };
  const before = await hashWith("export const renew = () => 1;\n", "export const a = 1;\n");
  assert.equal(
    await hashWith("export const renew = () => 2;\n", "export const a = 1;\n"),
    before,
    "a Kit edit is not Assembly content",
  );
  assert.notEqual(
    await hashWith("export const renew = () => 1;\n", "export const a = 2;\n"),
    before,
    "an Instance dependency is",
  );
});

test("an installed Instance with no workspace() needs no docker and no registry (ADR-0069)", async () => {
  // `npm i -g @jr2/cli && jr2 init && jr2 up`: the Kit images are published refs, the Workflows
  // ride the Assembly, and nothing is built. So a build port whose docker methods throw converges,
  // even on a cluster that is not kind and names no `registry`.
  const root = await mkInstance(`export default { name: "nodock" };\n`, "nodock", { coder: { model: "openai/gpt-x" } });
  const w = mkWorld(root);
  const called: string[] = [];
  const docker = (verb: string) => async (): Promise<never> => {
    called.push(verb);
    throw new Error(`docker ${verb} was called`);
  };
  w.io.build = {
    ...w.io.build!,
    build: docker("build"),
    push: docker("push"),
    kindLoad: docker("kind load"),
    hostImages: docker("image ls"),
    imageUser: docker("inspect"),
    imageFiles: docker("create"),
    buildablePlatforms: docker("buildx"),
  };
  w.kube.ctx = "gke-prod";
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.orchestrator.puts.length, 1, "the Assembly was published");
  // The sweep's host listing is the one docker read, and it already degrades to a warning. A call
  // anywhere else that a caller caught would still show here.
  assert.match(w.err.join("\n"), /images: sweep skipped \(docker image ls was called\)/);
  assert.deepEqual(called, ["image ls"], "no docker call but the sweep's listing");
});

test("secret: token + signing key persist across re-runs; harness.env literals materialize", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { env: [{ name: "API_KEY", value: "k123" }] } };\n`,
  );
  const w = mkWorld(root);
  w.kube.set("myinst", "secret", "jr2-instance", {
    metadata: { name: "jr2-instance" },
    data: { JR2_INSTANCE_TOKEN: Buffer.from("tok-old").toString("base64") },
  });

  assert.equal(await up(["--yes"], w.io), 0);
  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const instance = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-instance")!;
  assert.equal(instance.stringData.JR2_INSTANCE_TOKEN, "tok-old", "an existing token is kept (Sandboxes hold it)");
  assert.ok(instance.stringData.JR2_SIGNING_KEY, "a missing signing key is minted");
  // The Instance Harness Custodian's credential (ADR-0031): a sandbox-style token signed for the
  // placement's name — derived from the kept key, so re-runs converge to the same value.
  assert.equal(
    instance.stringData.JR2_INSTANCE_HARNESS_TOKEN,
    sandboxToken(Buffer.from(instance.stringData.JR2_SIGNING_KEY, "base64"), "jr2-instance-harness"),
  );

  // The ADR-0013 boundary: harness env lands in its OWN Secret — the Harness container envFroms
  // jr2-harness-env, and the Instance token/signing key must be unreachable from Agent code.
  const harnessEnv = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-harness-env")!;
  assert.ok(harnessEnv, "a separate jr2-harness-env Secret is applied");
  assert.equal(harnessEnv.stringData.API_KEY, "k123", "config env values materialize there");
  assert.equal(instance.stringData.API_KEY, undefined, "…and not beside the Instance token");
  assert.equal(harnessEnv.stringData.JR2_INSTANCE_TOKEN, undefined, "the token never rides the harness Secret");
});

/** A `"none"` Agent on the custom provider: the Instance Harness's pod claims the provider's key. */
const VLLM_ADVISOR: Record<string, FixtureAgent> = { advisor: { model: "vllm/qwen-x", workspace: "none" } };

test("provider apiKey is a held secret: the Custodian's Secret holds it, the Harness's never does (ADR-0059)", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "https://10.0.0.5:8000/v1", apiKey: "sk-secret", contextWindow: 131072, maxTokens: 32768, models: { "qwen-x": { contextWindow: 40960 } } } } };\n`,
    "myinst",
    VLLM_ADVISOR,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find(isInstanceList)!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const harnessEnv = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-harness-env")!;
  assert.equal(harnessEnv.stringData.JR2_PROVIDER_API_KEY, undefined, "the Agent can read that Secret");
  // The pod whose Agent names the provider holds it: the Instance Harness's own Secret.
  const held = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-held-secrets-instance")!;
  assert.deepEqual(held.stringData, { JR2_PROVIDER_API_KEY: "sk-secret" }, "written as given, no newline added");
  assert.equal(held.metadata.labels["jr2.dev/held-pod"], "instance");

  // The binding: the endpoint's own host and port, the default credential headers.
  const heldCm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-held")!;
  const manifest = JSON.parse(heldCm.data["held-instance.json"]) as HeldManifest;
  assert.deepEqual(manifest.secrets, [
    {
      name: "JR2_PROVIDER_API_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "10.0.0.5", port: 8000, leaf: leafStem("10.0.0.5", 8000) }],
      headers: ["authorization", "x-api-key", "x-goog-api-key", "api-key"],
    },
  ]);
  // A leaf for that target, from a CA no pod mounts; the CA's key rides only its own Secret.
  const tls = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-held-tls")!;
  assert.deepEqual(Object.keys(tls.stringData).sort(), [
    `${leafStem("10.0.0.5", 8000)}.crt`,
    `${leafStem("10.0.0.5", 8000)}.key`,
  ]);
  const ca = items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-held-ca")!;
  assert.ok(
    new X509Certificate(tls.stringData[`${leafStem("10.0.0.5", 8000)}.crt`]).verify(
      new X509Certificate(ca.stringData["ca.crt"]).publicKey,
    ),
  );
  assert.match(w.err.join("\n"), /held secret JR2_PROVIDER_API_KEY → 10\.0\.0\.5:8000 \(literal\)/);
  for (const line of w.err) assert.ok(!line.includes("sk-secret"), "the converge narrates names, never a value");

  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-harness")!;
  for (const cmItem of items.filter((i) => i.kind === "ConfigMap")) {
    assert.ok(
      !JSON.stringify(cmItem).includes("sk-secret"),
      `the key never lands in a ConfigMap (${cmItem.metadata.name})`,
    );
  }
  assert.match(cm.data["harness.json"], /baseUrl/, "the rest of the provider config does ride the ConfigMap");
  // Token limits are model properties, not credentials — they DO ride the ConfigMap.
  const spec = JSON.parse(cm.data["harness.json"]) as { provider: Record<string, unknown>; agents?: unknown };
  assert.equal(spec.provider.contextWindow, 131072);
  assert.equal(spec.provider.maxTokens, 32768);
  assert.deepEqual(spec.provider.models, { "qwen-x": { contextWindow: 40960 } });
  // What this ConfigMap is NOT any more (ADR-0049): a roster. The definition rides each Turn, so
  // deployment facts are all that is left to mount.
  assert.equal(spec.agents, undefined, "no Agent roster rides the deployment");

  // The trust bundles, server-side: roots + the jr2 CA for the Harness, roots alone upstream.
  const trust = JSON.parse(w.kube.applied.find((m) => m.includes(`"name":"jr2-ca"`))!);
  assert.ok(trust.data["extra.crt"].includes(ca.stringData["ca.crt"]));
  assert.ok(trust.data["bundle.crt"].includes(ca.stringData["ca.crt"]));
  assert.ok(
    !trust.data["upstream.crt"].includes(ca.stringData["ca.crt"]),
    "the Custodian never trusts its own CA upstream",
  );
  assert.deepEqual(w.kube.serverSide, ["jr2-ca"]);
});

test("the CA is kept, a leaf that still fits is reused, and a converge holding nothing drops the Custodian's Secrets", async () => {
  const config = `export default { name: "myinst", harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "https://llm.corp.example/v1", apiKey: "sk-1" } } };\n`;
  const root = await mkInstance(config, "myinst", VLLM_ADVISOR);
  const first = mkWorld(root);
  assert.equal(await up(["--yes"], first.io), 0);
  const items = (JSON.parse(first.kube.applied.find(isInstanceList)!) as { items: Array<Record<string, any>> }).items;
  const ca = items.find((i) => i.metadata.name === "jr2-held-ca")!;
  const tls = items.find((i) => i.metadata.name === "jr2-held-tls")!;

  // The next converge finds both in the cluster: same CA, same leaf.
  const second = mkWorld(root);
  const b64 = (data: Record<string, string>) =>
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
  second.kube.set("myinst", "secret", "jr2-held-ca", { data: b64(ca.stringData) } as never);
  second.kube.set("myinst", "secret", "jr2-held-tls", { data: b64(tls.stringData) } as never);
  assert.equal(await up(["--yes"], second.io), 0);
  const again = (JSON.parse(second.kube.applied.find(isInstanceList)!) as { items: Array<Record<string, any>> }).items;
  assert.deepEqual(again.find((i) => i.metadata.name === "jr2-held-ca")!.stringData, ca.stringData);
  assert.deepEqual(again.find((i) => i.metadata.name === "jr2-held-tls")!.stringData, tls.stringData);

  // Nothing held: each pod's values and the leaves go; the CA stays for the next time.
  const none = mkWorld(await mkInstance(`export default { name: "myinst" };\n`));
  none.kube.set("myinst", "secret", "jr2-held-secrets-instance", {
    metadata: { name: "jr2-held-secrets-instance", labels: { "jr2.dev/held-pod": "instance" } },
  });
  assert.equal(await up(["--yes"], none.io), 0);
  assert.ok(none.kube.deleted.includes("myinst/secret/jr2-held-secrets-instance"));
  assert.ok(none.kube.deleted.includes("myinst/secret/jr2-held-tls"));
  assert.ok(!none.kube.deleted.includes("myinst/secret/jr2-held-ca"));
  const cm = (JSON.parse(none.kube.applied.find(isInstanceList)!) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-held",
  )!;
  assert.deepEqual(
    cm.data,
    { "program.lua": CUSTODIAN_PROGRAM },
    "the ConfigMap is applied always — here with no Harness pod to hold for, and the program once",
  );
  // No Instance Harness: no pod to render Custodian files for, and a stale one's go with it.
  assert.ok(none.kube.deleted.includes("myinst/configmap/jr2-held-custodian"));
  assert.ok(!none.kube.applied.some((m) => m.includes(`"jr2-held-custodian"`)), "nothing rendered for no pod");
});

test("a known model key in harness.env or in an envFrom Secret is refused, naming the line to write (R1)", async () => {
  const inEnv = mkWorld(
    await mkInstance(
      `export default { name: "myinst", harness: { env: [{ name: "ANTHROPIC_API_KEY", value: "sk-x" }] } };\n`,
    ),
  );
  await assert.rejects(
    () => up(["--yes"], inEnv.io),
    /harness\.env\[0\] sets ANTHROPIC_API_KEY.*secrets: \[\{ name: "ANTHROPIC_API_KEY", value: process\.env\.ANTHROPIC_API_KEY \}\]/s,
  );

  const viaSecret = mkWorld(
    await mkInstance(`export default { name: "myinst", harness: { envFrom: [{ secretRef: { name: "team" } }] } };\n`),
  );
  viaSecret.kube.set("myinst", "secret", "team", { data: { OPENAI_API_KEY: "c2stb3BlbmFp", OTHER: "eA==" } } as never);
  await assert.rejects(
    () => up(["--yes"], viaSecret.io),
    /harness\.envFrom\[0\] loads Secret "team", which carries OPENAI_API_KEY/,
  );
  assert.ok(!viaSecret.kube.applied.some((m) => m.includes(`"kind":"List"`)), "refused before anything is applied");
});

test("caBundle: the PEM rides a jr2-ca ConfigMap and the provider preflight; a missing file fails loudly", async () => {
  const config =
    `export default { name: "myinst", harness: { caBundle: "ca.crt", ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.internal/v1" } } };\n`;
  const pem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

  const root = await mkInstance(config, "myinst", { coder: { model: "vllm/qwen-x", workspace: "none" } });
  await writeFile(join(root, "ca.crt"), pem);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  // A ConfigMap, not a Secret — CA certs are public data (ADR-0020). Its own manifest, applied
  // server-side and FIRST: with a held secret it carries every root, past client-side apply's limit.
  const cm = JSON.parse(w.kube.applied[w.kube.applied.findIndex((m) => m.includes(`"name":"jr2-ca"`))]!);
  assert.equal(cm.kind, "ConfigMap");
  assert.equal(cm.data["ca.crt"], pem);
  assert.ok(
    w.kube.applied.findIndex((m) => m.includes(`"name":"jr2-ca"`)) < w.kube.applied.findIndex(isInstanceList),
    "the trust exists before any pod of the Instance that mounts it",
  );
  // The preflight pod trusts the same bundle the Harness will — else it fails where pods succeed.
  const probe = w.kube.probePods[0]!.pod.spec;
  const caEnv = probe.containers[0].env.find((e: { name: string }) => e.name === "NODE_EXTRA_CA_CERTS");
  assert.equal(caEnv?.value, "/etc/jr2/ca/ca.crt");
  // …from its own copy of the trust, written for its life (ADR-0019).
  assert.ok(
    probe.volumes.some(
      (v: { configMap?: { name: string } }) => v.configMap?.name === `${w.kube.probePods[0]!.pod.metadata.name}-ca`,
    ),
  );

  const missing = mkWorld(await mkInstance(config, "missing"));
  await assert.rejects(() => up(["--yes"], missing.io), /caBundle.*relative to the instance folder/s);
});

test("no caBundle and nothing held → no jr2-ca ConfigMap", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(!w.kube.applied.some((m) => m.includes(`"name":"jr2-ca"`)));
});

test("a referenced-but-missing Secret fails the converge naming it, with the creation hint", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { envFrom: [{ secretRef: { name: "anthropic" } }] } };\n`,
  );
  const w = mkWorld(root);
  await assert.rejects(() => up(["--yes"], w.io), /Secret "anthropic".*create secret generic anthropic/s);
});

test("converge applies the instance objects and waits for the rollout", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find(isInstanceList)!;
  const kinds = (JSON.parse(list) as { items: Array<{ kind: string }> }).items.map((i) => i.kind);
  for (const k of ["PersistentVolumeClaim", "ServiceAccount", "ConfigMap", "Secret", "Deployment", "Service"]) {
    assert.ok(kinds.includes(k), `applies a ${k}`);
  }
  assert.deepEqual(w.kube.rollouts, ["jr2-system/jr2-controller-manager", "myinst/jr2-orchestrator"]);
});

test("converged is claimed only of a pod observed carrying the intended image", async () => {
  // The defect this closes: `up` reported convergence off the label it had just written, so a
  // Deployment whose pod template never moved (stale image, no rollout) still printed `converged`.
  // Convergence is now asserted against the running pod — observed state, not the CLI's own claim.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const drifted = mkWorld(root);
  drifted.kube.podImages = { "app=jr2-orchestrator": "jr2-instance-myinst:0ldc0ntent" };

  await assert.rejects(
    () => up(["--yes"], drifted.io),
    /running pod carries jr2-instance-myinst:0ldc0ntent.*expected ghcr\.io\/snapwich\/jr2-orchestrator:/s,
    "the drift is named in both directions, so the fix is obvious",
  );

  const honest = mkWorld(root);
  assert.equal(await up(["--yes"], honest.io), 0);
  assert.match(honest.err.join("\n"), /converged/);
});

test("provider preflight: the custom provider's models go the same path, its key held and never in a pod spec", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.lan:8000/v1", apiKey: "sk-vllm-real" } } };\n`;
  // Two slots on the endpoint, one repeat, one on another provider: each DISTINCT model is probed.
  const agents: Record<string, FixtureAgent> = {
    coder: { model: "vllm/qwen-x", workspace: "none" },
    reviewer: { model: "vllm/qwen-small", workspace: "none" },
    scribe: { model: "vllm/qwen-x", workspace: "none" },
    judge: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
  };
  const ok = mkWorld(await mkInstance(config, "myinst", agents));
  assert.equal(await up(["--yes"], ok.io), 0);
  const { pod } = ok.kube.probePods[0]!;
  // In the walk's order (sorted), each once.
  assert.deepEqual(pod.spec.containers[0].command.slice(4), [
    "anthropic/claude-haiku-5-5",
    "vllm/qwen-small",
    "vllm/qwen-x",
  ]);
  const env = pod.spec.containers[0].env as Array<{ name: string; value?: string }>;
  assert.equal(env.find((e) => e.name === "JR2_PROVIDER_API_KEY")?.value, "jr2-held-JR2_PROVIDER_API_KEY");
  const probeList = JSON.parse(ok.kube.applied.find((m) => m.includes(`"name":"${pod.metadata.name}"`))!) as {
    items: Array<Record<string, any>>;
  };
  assert.deepEqual(
    probeList.items
      .filter((i) => JSON.stringify(i).includes("sk-vllm-real"))
      .map((i) => `${i.kind}/${i.metadata.name}`),
    [`Secret/${pod.metadata.name}`],
    "the key is in the probe's own Secret alone — not in its pod spec, argv or script",
  );
  assert.match(
    ok.err.join("\n"),
    /provider: checking vllm\/qwen-small, vllm\/qwen-x on the Instance Harness, through a Custodian that holds JR2_PROVIDER_API_KEY for vllm\.lan:8000/,
  );

  const bad = mkWorld(await mkInstance(config, "bad", agents));
  bad.kube.probeAnswers["vllm/qwen-small"] = 'fault=the answer carried no tool call (stop reason "length")';
  await assert.rejects(
    () => up(["--yes"], bad.io),
    (err: Error) => {
      assert.match(err.message, /^provider preflight failed for model "vllm\/qwen-small" against vllm\.lan:8000/);
      for (const hint of [
        /localhost never works from a pod/,
        /exactly what the endpoint serves/,
        /--enable-auto-tool-choice and a matching --tool-call-parser/,
        /stop reason "length" means the model ran out of tokens/,
        /held secret JR2_PROVIDER_API_KEY may be wrong/,
      ])
        assert.match(err.message, hint);
      assert.ok(!/add its key to `secrets`/.test(err.message), "a custom provider's key is optional");
      return true;
    },
  );
});

test("provider preflight: the custom provider's refused key lists the key first, and not the reach", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.lan:8000/v1", apiKey: "sk-vllm-real" } } };\n`;
  const w = mkWorld(await mkInstance(config, "myinst", { coder: { model: "vllm/qwen-x", workspace: "none" } }));
  w.kube.probeAnswers["vllm/qwen-x"] =
    "fault=openai-completions call to https://vllm.lan:8000/v1 failed: 401 Unauthorized";
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      const lines = err.message.split("\n").slice(1);
      assert.match(lines[0]!, /^ {2}- the held secret JR2_PROVIDER_API_KEY may be wrong/);
      assert.ok(!lines.some((l) => /localhost never works/.test(l)));
      return true;
    },
  );
});

test("provider preflight: configured but no carried Agent names its models → skipped, not a silent pass", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } } };\n`;
  const w = mkWorld(await mkInstance(config, "myinst", { judge: { model: "anthropic/claude-x", workspace: "none" } }));
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(!w.kube.probePods[0]!.pod.spec.containers[0].command.some((m: string) => m.startsWith("vllm/")));
  assert.match(w.err.join("\n"), /no carried Agent names a "vllm\/…" model/);
});

// --- the catalog provider preflight (ADR-0019, ADR-0059) -----------------------------------------

/** A held pod as `resolveHeld` makes it: its key, and the bindings of the names it holds. */
function heldPod(pod: string, names: string[], hosts: Record<string, string> = {}) {
  return {
    pod,
    manifest: {
      version: 1 as const,
      secrets: names.map((name) => ({
        name,
        source: { kind: "literal" as const },
        hosts: [{ host: hosts[name] ?? "api.anthropic.com", port: 443, leaf: "l" }],
        headers: ["x-api-key"],
      })),
    },
    values: {},
  };
}

/** The walk as `placementWalkOf` reads it: one Workspace's models, and the Instance Harness's. */
function walkOf(workspace: string[] | undefined, instance: string[] | undefined): PlacementWalk {
  return {
    effects: [],
    workspaces: workspace
      ? [{ workflow: "w", pod: { path: undefined, route: [], secrets: [], models: workspace } as never }]
      : [],
    ...(instance ? { instanceHarness: { models: instance } } : {}),
  };
}

const WS_POD = workspaceHeldPod({ workflow: "w", route: [] });

test("providerProbes: every model a Harness pod runs, in a probe with its pod's placement, with the keys a pod there holds", () => {
  const config = {
    sandbox: { nodeSelector: { pool: "sandbox" } },
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } },
  } as const;
  const probes = providerProbes(
    config,
    walkOf(
      ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-x", "vllm/qwen-x", "antropic/typo"],
      ["anthropic/claude-haiku-5-5"],
    ),
    [heldPod(WS_POD, ["ANTHROPIC_API_KEY"]), heldPod("instance", ["ANTHROPIC_API_KEY"])],
  );
  assert.deepEqual(
    probes.map((p) => [p.where, p.placement, p.manifest.secrets.map((b) => b.name)]),
    [
      ["the Sandbox nodes", { nodeSelector: { pool: "sandbox" } }, ["ANTHROPIC_API_KEY"]],
      ["the Instance Harness", undefined, ["ANTHROPIC_API_KEY"]],
    ],
  );
  assert.deepEqual(
    probes[0]!.providers.map((v) => [v.id, v.models, v.keys, v.hosts]),
    [
      // Each model: a typo, a retired model or a model the key cannot reach is per model.
      [
        "anthropic",
        ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"],
        ["ANTHROPIC_API_KEY"],
        ["api.anthropic.com"],
      ],
      // No pod holds a key of these: probed with none, as a Turn there would run.
      ["openai", ["openai/gpt-x"], [], ["api.openai.com"]],
      // The custom provider goes the same way; it has no key here (`apiKey` is optional).
      ["vllm", ["vllm/qwen-x"], [], ["10.0.0.5:8000"]],
      ["antropic", ["antropic/typo"], [], []],
    ],
  );
});

test("providerProbes: one probe when the Sandbox nodes have no predicate of their own, and a gateway is the host", () => {
  const probes = providerProbes(
    { harness: { catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } } } },
    walkOf(["anthropic/claude-sonnet-5-5"], ["anthropic/claude-haiku-5-5"]),
    [],
  );
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.where, "the Sandbox nodes and the Instance Harness");
  const [p] = probes[0]!.providers;
  assert.deepEqual(p!.models, ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"]);
  assert.deepEqual([p!.keys, p!.hosts, p!.gateway], [[], ["litellm.corp.example"], "https://litellm.corp.example"]);
});

test("probeVerdicts reads every line provider-preflight.ts writes: the format is the Harness's (preflight-line.ts)", () => {
  const verdicts: PreflightVerdict[] = [
    { kind: "ok" },
    { kind: "fault", reason: "HTTP 401\ninvalid key" },
    { kind: "busy", reason: "provider limit (anthropic/m): Overloaded" },
    { kind: "warn", reason: "no tool call" },
  ];
  const output = ["noise", ...verdicts.map((v, i) => preflightLine(`p/m${i}`, v))].join("\n");
  assert.deepEqual(
    [...probeVerdicts(output)],
    [
      ["p/m0", { kind: "ok" }],
      ["p/m1", { kind: "fault", reason: "HTTP 401 invalid key" }],
      ["p/m2", { kind: "busy", reason: "provider limit (anthropic/m): Overloaded" }],
      ["p/m3", { kind: "warn", reason: "no tool call" }],
    ],
  );
});

test("podFault: the hint follows the kubelet's reason, and quotes the Custodian's refusal", () => {
  const images = { harnessImage: "ghcr.io/x/jr2-harness:1", custodianImage: "envoyproxy/envoy@sha256:abc" };
  const where = { where: "the Sandbox nodes" };
  const end = (over: Partial<PodEnd>): PodEnd => ({
    phase: "stuck",
    started: false,
    output: "",
    custodian: "",
    reasons: [],
    ...over,
  });
  const pull = podFault(end({ stuck: "custodian: ImagePullBackOff" }), where, images);
  assert.match(pull, /cannot pull envoyproxy\/envoy@sha256:abc/);
  assert.ok(!/held value/.test(pull), "no Custodian-value hint for an image a node cannot pull");
  assert.match(
    podFault(end({ stuck: "probe: ErrImagePull" }), where, images),
    /cannot pull ghcr\.io\/x\/jr2-harness:1/,
  );
  assert.match(
    podFault(
      end({
        stuck: "custodian: restarted",
        custodian: "[critical] script load error: jr2.custodian refuse secret=ANTHROPIC_API_KEY reason=empty-value",
      }),
      where,
      images,
    ),
    /Custodian did not start: jr2\.custodian refuse secret=ANTHROPIC_API_KEY reason=empty-value — .*missing, empty/,
  );
  assert.match(podFault(end({ stuck: "probe: CreateContainerConfigError" }), where, images), /harness\.envFrom/);
  const oom = podFault(end({ stuck: "custodian: restarted (last ended OOMKilled)" }), where, images);
  assert.match(oom, /ran out of memory: custodian: restarted \(last ended OOMKilled\).*64Mi/);
  assert.ok(!/held value/.test(oom), "an OOMKilled Custodian is not a held value it refused");
  assert.match(
    podFault(end({ phase: "Failed", reasons: ["probe: terminated OOMKilled"] }), where, images),
    /the check container's limit is 512Mi/,
  );
  assert.match(
    podFault(end({ phase: "timeout" }), where, images),
    /did not start in 300s .*no node on the Sandbox nodes fits it/,
  );
});

test("providerProbeObjects: the probe pod takes its placement, and labels that select no Harness pod", () => {
  const list = JSON.parse(
    providerProbeObjects({
      name: "myinst",
      namespace: "myinst",
      object: "jr2-provider-preflight-ab12cd34-0",
      run: "ab12cd34",
      harnessImage: "h",
      custodianImage: "c",
      held: { version: 1, secrets: [] },
      values: {},
      leaves: {},
      trust: {},
      custodian: { bootstrap: "{}", script: "" },
      token: "t",
      harnessEnvData: {},
      models: ["anthropic/m"],
      priorityClassName: "jr2-sandbox",
      placement: {
        nodeSelector: { pool: "sandbox" },
        tolerations: [{ key: "k", operator: "Exists", effect: "NoSchedule" }],
      },
      deadlineSeconds: 500,
    }),
  ) as { items: Array<Record<string, any>> };
  const pod = list.items.find((i) => i.kind === "Pod")!;
  assert.deepEqual(pod.spec.nodeSelector, { pool: "sandbox" });
  assert.equal(pod.spec.tolerations.length, 1);
  assert.equal(pod.spec.activeDeadlineSeconds, 500);
  assert.equal(pod.spec.priorityClassName, "jr2-sandbox", "the Sandbox tier's class, as the pods it stands for");
  assert.deepEqual(pod.metadata.labels, {
    "jr2.dev/instance": "myinst",
    "app.kubernetes.io/managed-by": "jr2",
    "jr2.dev/provider-preflight": "ab12cd34",
    app: "jr2-provider-preflight",
  });
  // No key held: the Custodian mounts its token alone, and the probe's HTTPS goes direct.
  const values = pod.spec.volumes.find((v: { name: string }) => v.name === "custodian-values");
  assert.deepEqual(
    values.projected.sources.map((s: { secret: { name: string } }) => s.secret.name),
    ["jr2-provider-preflight-ab12cd34-0"],
  );
  assert.ok(!pod.spec.containers[0].env.some((e: { name: string }) => e.name === "HTTPS_PROXY"));
});

const CATALOG_CONFIG = `export default { name: "myinst", secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-real-value" }] };\n`;

/** Every object an apply put in `namespace`, by name, off the manifests a fake cluster recorded. */
function namespaced(applied: readonly string[], namespace: string): string[] {
  return applied.flatMap((m) => {
    if (!m.trimStart().startsWith("{")) return [];
    const doc = JSON.parse(m) as { kind: string; items?: Array<Record<string, any>>; metadata?: Record<string, any> };
    const items = doc.kind === "List" ? (doc.items ?? []) : [doc as Record<string, any>];
    return items.filter((i) => i.metadata?.namespace === namespace).map((i) => `${i.kind}/${i.metadata.name}`);
  });
}

test("provider preflight: a Harness-shaped pod with its own objects, before anything the Instance reads is written", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.kube.probePods.length, 1, "one probe pod for one placement");
  const { pod, rolloutsBefore, appliedBefore } = w.kube.probePods[0]!;
  const o = pod.metadata.name as string;
  assert.match(o, /^jr2-provider-preflight-[0-9a-f]{8}-0$/, "a name for this run alone");
  assert.deepEqual(
    rolloutsBefore.filter((r) => r.startsWith("myinst/")),
    [],
    "before the instance's rollout waits, so before the publish",
  );
  // A failed probe writes no object the Instance reads: before it, the namespace holds the probe's own.
  assert.deepEqual(namespaced(appliedBefore, "myinst").sort(), [
    `ConfigMap/${o}`,
    `ConfigMap/${o}-ca`,
    `Pod/${o}`,
    `Secret/${o}`,
    `Secret/${o}-env`,
    `Secret/${o}-tls`,
  ]);

  // The probe: the stock Harness image's provider-preflight.ts, EVERY carried model in argv, the Harness's env.
  const [probe] = pod.spec.containers;
  assert.deepEqual(probe.command, [
    "/opt/jr2/bin/tini",
    "--",
    "/opt/jr2/bin/node",
    "/opt/jr2/src/provider-preflight.ts",
    "anthropic/claude-haiku-5-5",
    "anthropic/claude-sonnet-5-5",
  ]);
  const harnessPod = findInstanceHarness(w).statefulSet!.spec.template.spec;
  assert.equal(probe.image, harnessPod.containers[0].image);
  const env = probe.env as Array<{ name: string; value?: string; valueFrom?: any }>;
  assert.equal(env.find((e) => e.name === "ANTHROPIC_API_KEY")?.value, "jr2-held-ANTHROPIC_API_KEY");
  assert.equal(env.find((e) => e.name === "HTTPS_PROXY")?.value, "http://127.0.0.1:15001");
  assert.equal(env.find((e) => e.name === "NODE_EXTRA_CA_CERTS")?.value, "/etc/jr2/ca/extra.crt");
  assert.equal(env.find((e) => e.name === "JR2_HARNESS_JSON")?.valueFrom.configMapKeyRef.name, o);
  assert.deepEqual(probe.envFrom, [{ secretRef: { name: `${o}-env` } }]);

  // The Custodian is the Instance Harness's, but for the startup probe that gates the probe.
  const [custodian] = pod.spec.initContainers;
  const { startupProbe, ...same } = custodian;
  assert.ok(startupProbe?.httpGet, "the probe starts once Envoy serves");
  assert.deepEqual(same, harnessPod.initContainers[0]);
  // …and reads the probe's own copies, by the same paths.
  const volumes = JSON.stringify(pod.spec.volumes);
  for (const shared of ['"jr2-held"', '"jr2-held-tls"', '"jr2-ca"', '"jr2-held-secrets-instance"', '"jr2-harness"']) {
    assert.ok(!volumes.includes(shared) && !JSON.stringify(probe).includes(shared), `the probe reads no ${shared}`);
  }
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.automountServiceAccountToken, false);

  // The literal value is in the probe's own Secret alone, and only for the probe's life.
  const list = JSON.parse(w.kube.applied.find((m) => m.includes(`"name":"${o}"`))!) as {
    items: Array<Record<string, any>>;
  };
  const withValue = list.items.filter((i) => JSON.stringify(i).includes("sk-ant-real-value"));
  assert.deepEqual(
    withValue.map((i) => `${i.kind}/${i.metadata.name}`),
    [`Secret/${o}`],
  );
  for (const { kind, name } of [
    { kind: "pod", name: o },
    { kind: "configmap", name: o },
    { kind: "configmap", name: `${o}-ca` },
    { kind: "secret", name: o },
    { kind: "secret", name: `${o}-tls` },
    { kind: "secret", name: `${o}-env` },
  ]) {
    assert.ok(w.kube.deleted.includes(`myinst/${kind}/${name}`), `the probe's ${kind} ${name} is deleted`);
  }
  const said = w.err.join("\n");
  assert.match(
    said,
    /provider: checking anthropic\/claude-haiku-5-5, anthropic\/claude-sonnet-5-5 on the Instance Harness, through a Custodian that holds ANTHROPIC_API_KEY for api\.anthropic\.com/,
  );
  assert.match(said, /provider: anthropic\/claude-sonnet-5-5 reachable, and it completed a tool call/);
});

test("provider preflight: before the first check, only the namespace, the PriorityClasses and the check's own objects are written — no operator, no deploy key", async () => {
  const { home } = await mkSshHome();
  const root = await withWorkspace(
    await mkInstance(
      `export default { name: "myinst", git: { credentials: [{ match: "*", sshKey: "jr2-git-ssh" }] }, ` +
        `secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-real-value" }] };\n`,
      "myinst",
      { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } },
    ),
    SSH_URL,
  );
  const w = mkWorld(root, { choose: 0, env: { HOME: home } });
  w.io.prompt = async () => "";
  w.io.sshKeygen = async () => ({ privateKey: PRIVATE_KEY, publicKey: `${PUBLIC_KEY}\n` });
  assert.equal(await up([], w.io), 0);
  const { pod, appliedBefore, labeledBefore } = w.kube.probePods[0]!;
  const kinds = appliedBefore.map((m) => {
    if (!m.trimStart().startsWith("{")) return `yaml: ${m.slice(0, 40)}`;
    const doc = JSON.parse(m) as { kind: string; metadata?: { name: string }; items?: Array<Record<string, any>> };
    return doc.kind === "List"
      ? `List ${doc.items!.map((i) => `${i.kind}/${i.metadata.name}`).join(",")}`
      : `${doc.kind}/${doc.metadata!.name}`;
  });
  const o = pod.metadata.name as string;
  assert.deepEqual(kinds, [
    "Namespace/myinst",
    "PriorityClass/jr2-control",
    "PriorityClass/jr2-sandbox",
    `List ConfigMap/${o},ConfigMap/${o}-ca,Secret/${o},Secret/${o}-tls,Secret/${o}-env,Pod/${o}`,
  ]);
  assert.deepEqual(labeledBefore, [], "no label either: the operator's comes after the check");
  // …and both come after it.
  assert.ok(
    w.kube.applied.some((m) => m.includes('"name":"jr2-git-ssh"')),
    "the deploy key, after the check",
  );
  assert.ok(
    w.kube.applied.some((m) => /^\s*image:/m.test(m)),
    "the operator, after the check",
  );
});

test("provider preflight: every failure in one error, and the Instance as it was — nothing of it applied, no publish, no sweep", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  w.kube.set("myinst", "secret", "jr2-held-secrets-gone", {
    metadata: { name: "x", labels: { "jr2.dev/held-pod": "gone" } },
  });
  w.kube.probeAnswers["anthropic/claude-haiku-5-5"] = "fault=anthropic-messages call failed: 401 invalid x-api-key";
  w.kube.probeAnswers["anthropic/claude-sonnet-5-5"] = "fault=404 model not found";
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(
        err.message,
        /^provider preflight failed for model "anthropic\/claude-haiku-5-5" toward api\.anthropic\.com \(from a pod on the Instance Harness/,
      );
      assert.match(err.message, /401 invalid x-api-key/);
      assert.match(err.message, /no egress to api\.anthropic\.com/);
      assert.match(err.message, /held secret ANTHROPIC_API_KEY may be empty, wrong/);
      assert.match(err.message, /model "anthropic\/claude-sonnet-5-5".*404 model not found/s, "the second failure too");
      assert.ok(!/harness\.catalog/.test(err.message), "no gateway, so no gateway cause");
      return true;
    },
  );
  const o = w.kube.probePods[0]!.pod.metadata.name as string;
  assert.ok(
    namespaced(w.kube.applied, "myinst").every((n) => n.split("/")[1]!.startsWith(o)),
    `only the probe's own objects were applied: ${namespaced(w.kube.applied, "myinst").join(", ")}`,
  );
  assert.ok(!w.kube.applied.some((m) => m.includes('"name":"jr2-ca"')), "no trust bundle either");
  assert.equal(w.orchestrator.requests.length, 0, "no Assembly is published");
  assert.equal(w.kube.rollouts.filter((r) => r.startsWith("myinst/")).length, 0);
  assert.ok(!w.kube.deleted.some((d) => d.includes("jr2-held-secrets-")), "no stale held Secret is deleted");
  assert.ok(w.kube.deleted.includes(`myinst/pod/${o}`), "the pod goes, pass or fail");
});

test("provider preflight: a probe pod the cluster refuses is that probe's fault; the other probes still run", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", sandbox: { nodeSelector: { pool: "sandbox" } }, ` +
      `secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-real-value" }] };\n`,
    "myinst",
    { reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" } },
  );
  await writeFile(
    join(root, "workflows", "ws.ts"),
    `import { agent, jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [], actors: { coder: agent({ model: "anthropic/claude-haiku-5-5", instructions: "i" }) } })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://e.test/a.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const w = mkWorld(root);
  w.kube.refuseApply = (m) => m.includes('"kind":"Pod"') && m.includes('"pool":"sandbox"');
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(
        err.message,
        /model "anthropic\/claude-haiku-5-5" .*on the Sandbox nodes.*the cluster refused the check pod's objects: .*exceeded quota/s,
      );
      assert.ok(!/claude-sonnet-5-5/.test(err.message), "the Instance Harness's probe ran, and passed");
      return true;
    },
  );
  assert.equal(w.kube.probePods.length, 1, "the second probe ran after the first was refused");
  assert.equal(w.kube.probePods[0]!.pod.spec.nodeSelector, undefined);
});

test("catalog provider preflight: a busy provider and an unforced answer in text warn, and the converge goes on", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  w.kube.probeAnswers["anthropic/claude-haiku-5-5"] = "busy=provider limit (anthropic/claude-haiku-5-5): Overloaded";
  w.kube.probeAnswers["anthropic/claude-sonnet-5-5"] = "warn=the answer carried no tool call";
  assert.equal(await up(["--yes"], w.io), 0);
  const said = w.err.join("\n");
  assert.match(
    said,
    /warning: provider: anthropic\/claude-haiku-5-5 answered with the key, but is busy — provider limit/,
  );
  assert.match(
    said,
    /warning: provider: anthropic\/claude-sonnet-5-5 answered with the key — the answer carried no tool call/,
  );
});

test("catalog provider preflight: a provider no pod holds a key for is probed with none, and its failure names the key to add", async () => {
  const w = mkWorld(
    await mkInstance(`export default { name: "myinst" };\n`, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      typo: { model: "antropic/claude-haiku-5-5", workspace: "none" },
    }),
  );
  w.kube.probeAnswers["anthropic/claude-haiku-5-5"] = "fault=Provider is not configured: anthropic";
  w.kube.probeAnswers["antropic/claude-haiku-5-5"] = 'fault=model "antropic/claude-haiku-5-5" resolves to nothing';
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(
        err.message,
        /not configured: anthropic\n.*\n {2}- no Harness pod on the Instance Harness holds a key of "anthropic": add its key to `secrets` \(ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY\)/,
      );
      assert.match(
        err.message,
        /resolves to nothing\n.*jr2 knows no key name of "antropic" \(when pi does not know the id either/s,
      );
      return true;
    },
  );
  const { pod } = w.kube.probePods[0]!;
  assert.ok(
    !pod.spec.containers[0].env.some((e: { name: string }) => e.name === "HTTPS_PROXY"),
    "nothing held: direct",
  );
});

test("catalog provider preflight: a pod that never ran says why, from the kubelet's reason", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  w.kube.probeEnd = {
    phase: "stuck",
    started: false,
    stuck: "probe: ErrImagePull",
    output: "",
    custodian: "",
    reasons: [],
  };
  await assert.rejects(
    () => up(["--yes"], w.io),
    /the check pod cannot start: probe: ErrImagePull — a node on the Instance Harness cannot pull/,
  );
});

test("providerProbes: a probe stands for one class of pod — its nodes, and whether it holds a secret (its proxy)", () => {
  // A Workspace that holds a workspace() secret calls a keyless provider through its Custodian's
  // tunnel; the probe holds that pod's set, so it has the proxy too.
  const tunnel = providerProbes({}, walkOf(["openai/gpt-x"], undefined), [
    heldPod(WS_POD, ["JIRA_TOKEN"], { JIRA_TOKEN: "jira.example" }),
  ]);
  assert.deepEqual(
    tunnel.map((p) => [p.manifest.secrets.map((b) => b.name), p.providers.map((v) => [v.id, v.keys])]),
    [[["JIRA_TOKEN"], [["openai", []]]]],
  );
  // The same nodes, a Workspace that holds a key and an Instance Harness that holds nothing: two
  // probes, one through a Custodian, one direct.
  const split = providerProbes({}, walkOf(["anthropic/claude-haiku-5-5"], ["openai/gpt-x"]), [
    heldPod(WS_POD, ["ANTHROPIC_API_KEY"]),
    heldPod("instance", []),
  ]);
  assert.deepEqual(
    split.map((p) => [p.where, p.manifest.secrets.map((b) => b.name), p.providers.map((v) => v.id)]),
    [
      ["the Sandbox nodes", ["ANTHROPIC_API_KEY"], ["anthropic"]],
      ["the Instance Harness", [], ["openai"]],
    ],
  );
});

test("providerProbeObjects: a binding with no leaf is a jr2 defect, thrown before anything is applied", () => {
  assert.throws(
    () =>
      providerProbeObjects({
        name: "myinst",
        namespace: "myinst",
        object: "o",
        run: "r",
        harnessImage: "h",
        custodianImage: "c",
        held: heldPod("instance", ["ANTHROPIC_API_KEY"]).manifest,
        values: { ANTHROPIC_API_KEY: "v" },
        leaves: {},
        trust: {},
        custodian: { bootstrap: "{}", script: "" },
        token: "t",
        harnessEnvData: {},
        models: ["anthropic/m"],
        priorityClassName: "jr2-sandbox",
        deadlineSeconds: 500,
      }),
    /no leaf .* a jr2 defect/,
  );
});

test("provider preflight: a new namespace's missing default ServiceAccount is waited for, and a pod that waits to start says why", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  let refusals = 1;
  w.kube.refuseApply = (m) =>
    m.includes('"kind":"Pod"') && refusals-- > 0
      ? 'pods "jr2-provider-preflight-x" is forbidden: error looking up service account myinst/default: serviceaccount "default" not found'
      : false;
  w.kube.probePending = ["Unschedulable: 0/3 nodes are available"];
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.kube.probePods.length, 1, "applied on the second try");
  assert.match(
    w.err.join("\n"),
    /provider: the check pod is not running yet — Unschedulable: 0\/3 nodes are available/,
  );
});

test("provider preflight: each result is said as it comes, with the worst-case time first; a pod that stops names the models it never reached", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  assert.equal(await up(["--yes"], w.io), 0);
  const said = w.err.join("\n");
  assert.match(said, /provider: the check pod has up to 5 min to start, then up to 6 min for each of its 2 models/);
  assert.equal(said.split("provider: anthropic/claude-haiku-5-5 reachable").length - 1, 1, "said once, as it came");

  const stopped = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  stopped.kube.probeEnd = {
    phase: "Failed",
    started: true,
    output: "jr2.preflight model=anthropic/claude-haiku-5-5 start",
    custodian: "",
    reasons: ["probe: terminated DeadlineExceeded"],
  };
  await assert.rejects(
    () => up(["--yes"], stopped.io),
    (err: Error) => {
      assert.match(
        err.message,
        /model "anthropic\/claude-haiku-5-5".*the check pod stopped while it checked this model/s,
      );
      assert.match(
        err.message,
        /model "anthropic\/claude-sonnet-5-5".*not checked: the check pod stopped before it reached this model/s,
      );
      return true;
    },
  );
});

test("provider preflight: no answer in time gets the hint that a model loads on first use — behind a gateway, not at pi's own host", async () => {
  const gateway = mkWorld(
    await mkInstance(
      `export default { name: "myinst", harness: { catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } } }, ` +
        `secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-litellm" }] };\n`,
      "myinst",
      { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } },
    ),
  );
  gateway.kube.probeAnswers["anthropic/claude-haiku-5-5"] = "fault=no answer in 120 s";
  await assert.rejects(
    () => up(["--yes"], gateway.io),
    /no answer in 120 s\n {2}- a model that loads on first use can take longer than the check waits: run `jr2 up` again/,
  );
  const direct = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  direct.kube.probeAnswers["anthropic/claude-haiku-5-5"] = "fault=no answer in 120 s";
  await assert.rejects(
    () => up(["--yes"], direct.io),
    (err: Error) => !/loads on first use/.test(err.message),
  );
});

test("provider preflight: a refused key lists the key first and no egress; a connection failure lists the egress first", async () => {
  const run = async (fault: string) => {
    const w = mkWorld(
      await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
    );
    w.kube.probeAnswers["anthropic/claude-haiku-5-5"] = `fault=${fault}`;
    return up(["--yes"], w.io).then(
      () => assert.fail("the converge failed"),
      (err: Error) => err.message.split("\n").slice(1),
    );
  };
  const refused = await run(
    'anthropic-messages call to https://api.anthropic.com failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  );
  assert.match(refused[0]!, /^ {2}- the held secret ANTHROPIC_API_KEY may be empty, wrong/);
  assert.ok(!refused.some((l) => /no egress/.test(l)), "the provider answered: not the egress");
  const unreachable = await run("anthropic-messages call to https://api.anthropic.com failed: Connection error.");
  assert.match(unreachable[0]!, /^ {2}- the pods may have no egress to api\.anthropic\.com/);
  assert.match(unreachable[1]!, /^ {2}- the held secret ANTHROPIC_API_KEY/);
  const silent = await run("no answer in 120 s");
  assert.match(silent[0]!, /no egress/);
});

test("PROBE_MODEL_SECONDS is the check's own budget for a model (PREFLIGHT_MODEL_BUDGET_SECONDS in @jr2/harness)", () => {
  assert.equal(PROBE_MODEL_SECONDS, PREFLIGHT_MODEL_BUDGET_SECONDS);
});

test("provider preflight: an empty last log read still knows which model the check was on, from the log read while it ran", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", {
      coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" },
      reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" },
    }),
  );
  w.kube.probeEnd = { phase: "Failed", started: true, output: "", custodian: "", reasons: [] };
  w.kube.probeLive = "jr2.preflight model=anthropic/claude-haiku-5-5 start";
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(err.message, /"anthropic\/claude-haiku-5-5".*stopped while it checked this model/s);
      assert.match(err.message, /"anthropic\/claude-sonnet-5-5".*not checked/s);
      return true;
    },
  );
});

test("provider preflight: a result said while the pod ran stands when the last log read comes back empty", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  w.kube.probeEnd = { phase: "Succeeded", started: true, output: "", custodian: "", reasons: [] };
  w.kube.probeLive =
    "jr2.preflight model=anthropic/claude-haiku-5-5 start\njr2.preflight model=anthropic/claude-haiku-5-5 ok";
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /provider: anthropic\/claude-haiku-5-5 reachable/);
});

test("refusing: a harness.provider.api the Harness does not speak, before anything is built or applied (ADR-0018)", async () => {
  const w = mkWorld(
    await mkInstance(
      `export default { name: "myinst", harness: { provider: { id: "local", api: "ollama-native", baseUrl: "http://10.0.0.5:11434" } } };\n`,
      "myinst",
      { coder: { model: "local/qwen", workspace: "none" } },
    ),
  );
  assert.equal(await up(["--yes"], w.io), 1);
  assert.match(
    w.err.join("\n"),
    /refusing: harness\.provider\.api is "ollama-native" — the Harness speaks: openai-completions/,
  );
  assert.equal(w.kube.applied.length, 0);
});

test("provider preflight: a check pod whose log cannot be read says so, and is not called a check that did not run", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  w.kube.probeEnd = { phase: "Succeeded", started: true, output: "", custodian: "", reasons: [] };
  await assert.rejects(() => up(["--yes"], w.io), /the check pod ended Succeeded, and jr2 up could not read its log/);
});

test("provider preflight: an earlier run's leftovers go even when this converge has nothing to check", async () => {
  const w = mkWorld(await mkInstance(`export default { name: "myinst" };\n`, "myinst"));
  const ago = new Date(Date.now() - 7200 * 1000).toISOString();
  w.kube.probeLeftovers = {
    pod: [
      {
        metadata: { name: "jr2-provider-preflight-old00000-0", creationTimestamp: ago },
        spec: { activeDeadlineSeconds: 510 },
        status: { phase: "Pending" },
      },
    ],
    configmap: [],
    secret: [],
  };
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.kube.probePods.length, 0, "no check to run");
  assert.ok(
    w.kube.deleted.includes("myinst/secret/jr2-provider-preflight-old00000-0"),
    "its Secret, which can hold a key, goes",
  );
});

test("provider preflight: this Instance's probe pods that ended over 10 minutes ago, and old orphans, go first; the rest stay", async () => {
  const w = mkWorld(
    await mkInstance(CATALOG_CONFIG, "myinst", { coder: { model: "anthropic/claude-haiku-5-5", workspace: "none" } }),
  );
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const ended = (name: string, s: number) => ({
    metadata: { name, creationTimestamp: ago(s + 60) },
    status: { phase: "Failed", containerStatuses: [{ name: "probe", state: { terminated: { finishedAt: ago(s) } } }] },
  });
  w.kube.probeLeftovers = {
    pod: [
      ended("jr2-provider-preflight-dead0000-0", 11 * 60),
      // Ended a short time ago: its run may still be reading its log.
      ended("jr2-provider-preflight-just0000-0", 60),
      { metadata: { name: "jr2-provider-preflight-live0000-0" }, status: { phase: "Running" } },
      // No node took it: no start time, so its deadline never fired, and its Secret holds a key.
      {
        metadata: { name: "jr2-provider-preflight-stuck000-0", creationTimestamp: ago(7200) },
        spec: { activeDeadlineSeconds: 510 },
        status: { phase: "Pending" },
      },
    ],
    configmap: [
      { metadata: { name: "jr2-provider-preflight-live0000-0-ca", creationTimestamp: ago(7200) } },
      { metadata: { name: "jr2-provider-preflight-orphan00-0-ca", creationTimestamp: ago(7200) } },
      { metadata: { name: "jr2-provider-preflight-young000-0", creationTimestamp: ago(10) } },
    ],
    secret: [],
  };
  assert.equal(await up(["--yes"], w.io), 0);
  assert.deepEqual(
    w.kube.leftoverSelectors,
    [
      "jr2.dev/provider-preflight,jr2.dev/instance=myinst",
      "jr2.dev/provider-preflight,jr2.dev/instance=myinst",
      "jr2.dev/provider-preflight,jr2.dev/instance=myinst",
    ],
    "this Instance's alone",
  );
  const mine = w.kube.probePods[0]!.pod.metadata.name as string;
  const gone = w.kube.deleted.filter((d) => d.includes("jr2-provider-preflight-") && !d.includes(mine));
  assert.deepEqual(
    gone.sort(),
    [
      "myinst/configmap/jr2-provider-preflight-dead0000-0",
      "myinst/configmap/jr2-provider-preflight-dead0000-0-ca",
      "myinst/configmap/jr2-provider-preflight-orphan00-0-ca",
      "myinst/pod/jr2-provider-preflight-dead0000-0",
      "myinst/secret/jr2-provider-preflight-dead0000-0",
      "myinst/secret/jr2-provider-preflight-dead0000-0-env",
      "myinst/secret/jr2-provider-preflight-dead0000-0-tls",
      "myinst/configmap/jr2-provider-preflight-stuck000-0",
      "myinst/configmap/jr2-provider-preflight-stuck000-0-ca",
      "myinst/pod/jr2-provider-preflight-stuck000-0",
      "myinst/secret/jr2-provider-preflight-stuck000-0",
      "myinst/secret/jr2-provider-preflight-stuck000-0-env",
      "myinst/secret/jr2-provider-preflight-stuck000-0-tls",
    ].sort(),
  );
});

test("catalog provider preflight: behind a gateway, the gateway is a cause", async () => {
  const w = mkWorld(
    await mkInstance(
      `export default { name: "myinst", harness: { catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } } }, ` +
        `secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-litellm" }] };\n`,
      "myinst",
      { reviewer: { model: "anthropic/claude-sonnet-5-5", workspace: "none" } },
    ),
  );
  w.kube.probeAnswers["anthropic/claude-sonnet-5-5"] = "fault=model not found";
  await assert.rejects(
    () => up(["--yes"], w.io),
    /model "anthropic\/claude-sonnet-5-5" toward litellm\.corp\.example.*harness\.catalog\.anthropic\.baseUrl \(https:\/\/litellm\.corp\.example\) may not answer, or may not serve "claude-sonnet-5-5"/s,
  );
});

// --- git over ssh: the key source is the user's choice (ADR-0047) --------------------------------

/** The scaffold's wildcard, minus the token: every ssh url's key is the `jr2-git-ssh` Secret. */
const SSH_CONFIG = `export default { name: "myinst", git: { credentials: [{ match: "*", sshKey: "jr2-git-ssh" }] } };\n`;
/** The bound ssh url the walk finds — what the ssh layer asks about, by url (ADR-0051). */
const SSH_URL = "git@github.com:o/app";
/** An instance whose one registered Machine binds `SSH_URL`. */
const sshInstance = async (name?: string): Promise<string> =>
  withWorkspace(await mkInstance(SSH_CONFIG, name), SSH_URL);
/** A private key as its file holds it — the PEM header is what makes a `~/.ssh` file a candidate. */
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMock user@host";

/** A HOME whose `~/.ssh` holds one real-looking private key beside the files that are NOT keys —
 * the discovery has to tell them apart by content, since `known_hosts` is a file like any other. */
async function mkSshHome(): Promise<{ home: string; keyPath: string }> {
  const home = await mkdtemp(join(tmpdir(), "jr2-home-"));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), PRIVATE_KEY);
  await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${PUBLIC_KEY}\n`);
  await writeFile(join(home, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n");
  await writeFile(join(home, ".ssh", "config"), "Host *\n  AddKeysToAgent yes\n");
  return { home, keyPath: join(home, ".ssh", "id_ed25519") };
}

/** The Secret the git-ssh layer applied, parsed — or undefined when it applied none. */
function gitSshSecret(w: World): { stringData: Record<string, string> } | undefined {
  const manifest = w.kube.applied.find((m) => m.includes(`"name":"jr2-git-ssh"`));
  return manifest ? JSON.parse(manifest) : undefined;
}

test("git ssh source: generate — the menu leads with it, the key prints, and up pauses to register", async () => {
  const { home } = await mkSshHome();
  const w = mkWorld(await sshInstance(), { choose: 0, env: { HOME: home } });
  const pauses: string[] = [];
  w.io.prompt = async (q) => {
    pauses.push(q);
    return "";
  };
  w.io.sshKeygen = async () => ({ privateKey: PRIVATE_KEY, publicKey: `${PUBLIC_KEY}\n` });
  w.io.sshPublicKey = async () => assert.fail("a generated keypair derives nothing");

  assert.equal(await up([], w.io), 0);
  assert.equal(w.choices.length, 1, "asked exactly once");
  assert.match(w.choices[0]![0]!, /generate/, "the recommended source is offered first");
  assert.match(w.err.join("\n"), /readable by anyone with/, "the Secret's readability is warned at choice time");
  // Flux's key names (ADR-0051), so a Flux or Argo user's existing Secret serves unchanged.
  assert.equal(gitSshSecret(w)!.stringData.identity, PRIVATE_KEY);
  assert.equal(gitSshSecret(w)!.stringData["identity.pub"], `${PUBLIC_KEY}\n`);
  assert.ok(!("key" in gitSshSecret(w)!.stringData), "never the retired `key`");
  assert.equal(pauses.length, 1, "the converge waits at the moment of truth");
  assert.match(pauses[0]!, /register this public key.*press enter/i);

  // The end of the converge repeats it: the key, what will not sync, and who retries (ADR-0048).
  const tail = w.err.join("");
  const notice = tail.slice(tail.indexOf("converged —"));
  assert.match(notice, /ssh-ed25519 AAAAC3/, "the public key is repeated last");
  assert.match(notice, /generated into "jr2-git-ssh"/, "…and the Secret it landed in");
  assert.match(notice, /git@github\.com:o\/app will not sync/, "the url, never a name");
  assert.match(notice, /cache agent retries on its own/);
});

test("git ssh: the Secret is the matched entry's `sshKey`; an ssh url no entry keys is warned, not asked", async () => {
  // Matched by prefix on the identity (ADR-0051): the entry decides the Secret NAME, so two entries
  // can hold two deploy keys and the ask is per Secret. An ssh url whose entry names no `sshKey`
  // — or that matches nothing — has no key to ask for: its cache clone fails unless the host allows
  // anonymous ssh, and the fix is a config line, so it is said once and the converge proceeds.
  const { home } = await mkSshHome();
  const config =
    `export default { name: "myinst", git: { credentials: [` +
    `{ match: "github.com/o/", sshKey: "acme-deploy" }, { match: "github.com/x/" }` +
    `] } };\n`;
  const root = await withWorkspace(await mkInstance(config), SSH_URL);
  await writeFile(
    join(root, "workflows", "other.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { keyless: "git@github.com:x/y.git", stranger: "ssh://git@gitlab.com/z/z.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const w = mkWorld(root, { choose: 0, env: { HOME: home } });
  w.io.prompt = async () => "";
  w.io.sshKeygen = async () => ({ privateKey: PRIVATE_KEY, publicKey: `${PUBLIC_KEY}\n` });

  assert.equal(await up([], w.io), 0);
  assert.equal(w.choices.length, 1, "asked once — for the one Secret an entry names");
  const err = w.err.join("\n");
  assert.match(
    err,
    /git@github\.com:o\/app bind over ssh and the "acme-deploy" Secret their git\.credentials entry names does not exist/,
  );
  const applied = w.kube.applied.find((m) => m.includes(`"name":"acme-deploy"`));
  assert.ok(applied, "the Secret is applied under the entry's name");
  assert.equal(gitSshSecret(w), undefined, "and not under the scaffold's default");
  assert.match(err, /git@github\.com:x\/y\.git is an ssh url and no git\.credentials entry names a key for it/);
  assert.match(err, /ssh:\/\/git@gitlab\.com\/z\/z\.git is an ssh url and no git\.credentials entry names a key/);
  assert.match(err, /anonymous ssh/);
});

test("git ssh source: a local key — discovered by content, applied, and only its fingerprint printed", async () => {
  const { home, keyPath } = await mkSshHome();
  const w = mkWorld(await sshInstance(), {
    env: { HOME: home },
    choose: (options) => options.findIndex((o) => o.includes("id_ed25519")),
  });
  w.io.sshKeygen = async () => assert.fail("a supplied key generates nothing");
  w.io.sshPublicKey = async (priv) => {
    assert.equal(priv, PRIVATE_KEY, "the supplied key itself is what gets derived from");
    return `${PUBLIC_KEY}\n`;
  };

  assert.equal(await up([], w.io), 0);
  const offered = w.choices[0]!;
  assert.ok(
    offered.some((o) => o === `use ${keyPath}`),
    `the ~/.ssh candidate is offered by path (offered: ${offered.join(" | ")})`,
  );
  assert.ok(
    !offered.some((o) => /known_hosts|config|\.pub/.test(o)),
    "only private keys are candidates — not known_hosts, config, or the public halves",
  );
  assert.equal(gitSshSecret(w)!.stringData.identity, PRIVATE_KEY);
  const err = w.err.join("\n");
  assert.match(err, /SHA256:/, "the fingerprint identifies the key");
  assert.ok(!err.includes("AAAAC3"), "key material is never printed");
  assert.ok(!err.includes("BEGIN OPENSSH"), "the private half least of all");
  assert.ok(!err.includes("will not sync"), "a supplied key is already registered — no closing notice");
});

test("git ssh source: another local key by typed path, and a key pasted with echo off", async () => {
  const { home, keyPath } = await mkSshHome();

  const typed = mkWorld(await sshInstance("typed"), {
    env: { HOME: home },
    choose: (options) => options.findIndex((o) => /type a path/.test(o)),
  });
  typed.io.prompt = async () => keyPath;
  typed.io.sshPublicKey = async () => `${PUBLIC_KEY}\n`;
  assert.equal(await up([], typed.io), 0);
  assert.equal(gitSshSecret(typed)!.stringData.identity, PRIVATE_KEY);

  const pasted = mkWorld(await sshInstance("pasted"), {
    env: { HOME: home },
    choose: (options) => options.findIndex((o) => /paste/.test(o)),
  });
  const hidden: string[] = [];
  pasted.io.readSecret = async (q) => {
    hidden.push(q);
    return "-----BEGIN OPENSSH PRIVATE KEY-----\ncGFzdGVk\n-----END OPENSSH PRIVATE KEY-----\n";
  };
  pasted.io.prompt = async () => assert.fail("a pasted key is read hidden, never as a visible line");
  pasted.io.sshPublicKey = async () => `${PUBLIC_KEY}\n`;
  assert.equal(await up([], pasted.io), 0);
  assert.equal(hidden.length, 1);
  assert.match(hidden[0]!, /hidden/);
  assert.match(gitSshSecret(pasted)!.stringData.identity!, /cGFzdGVk/);
});

test("git ssh: --yes generates — it never asks, never pauses, and still ends with the notice", async () => {
  const { home } = await mkSshHome();
  const w = mkWorld(await sshInstance(), {
    env: { HOME: home },
    // A menu answer that would pick a personal key, to prove --yes never reaches the menu.
    choose: (options) => options.findIndex((o) => o.includes("id_ed25519")),
  });
  w.io.prompt = async () => assert.fail("--yes has nobody to wait for");
  w.io.sshPublicKey = async () => assert.fail("--yes never selects a personal key");
  w.io.sshKeygen = async () => ({ privateKey: PRIVATE_KEY, publicKey: `${PUBLIC_KEY}\n` });

  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.choices.length, 0, "non-interactive means generate — the dangerous option is never a default");
  assert.equal(gitSshSecret(w)!.stringData.identity, PRIVATE_KEY);
  assert.match(w.err.join("\n"), /will not sync/, "the closing notice does not depend on the pause");
});

test("git ssh: a passphrase-protected key is refused BY NAME, before anything is applied", async () => {
  const { home } = await mkSshHome();
  const w = mkWorld(await sshInstance(), {
    env: { HOME: home },
    choose: (options) => options.findIndex((o) => o.includes("id_ed25519")),
  });
  w.io.sshPublicKey = async () => {
    throw new Error("it is passphrase-protected. The in-cluster clone runs unattended…");
  };
  await assert.rejects(() => up([], w.io), /passphrase-protected/);
  assert.equal(gitSshSecret(w), undefined, "no Secret may be applied on a key jr2 refuses");
});

test("git ssh: declining every source bails; an existing Secret is never offered against", async () => {
  const { home } = await mkSshHome();
  const decline = mkWorld(await sshInstance("decl"), { env: { HOME: home } }); // → none of these
  decline.io.sshKeygen = async () => assert.fail("declined — no key may be generated");
  // The bail spells the scripted escape, and it must name the key the cache agent reads — `identity`
  // (Flux's names, ADR-0051). A Secret under any other key is refused by every clone.
  await assert.rejects(() => up([], decline.io), /jr2-git-ssh.*--from-file=identity=<path>/s);
  assert.equal(gitSshSecret(decline), undefined);

  const has = mkWorld(await sshInstance("has"));
  has.kube.set("myinst", "secret", "jr2-git-ssh", { metadata: { name: "jr2-git-ssh" } });
  has.io.sshKeygen = async () => assert.fail("Secret exists — no key may be generated");
  assert.equal(await up(["--yes"], has.io), 0);
  assert.equal(has.choices.length, 0);
});

test("git ssh: every documented kubectl escape names a Secret key the cache agent accepts", async () => {
  // The scripted path (ADR-0047) hands the user a `kubectl create secret generic` line, and the
  // cache agent reads Flux's key names only (ADR-0051) — a line naming any other key builds a
  // Secret every clone refuses, reported as a credential error that never blames the key name. So
  // the prose and the agent are held to one list: whatever creds.go keys.
  const creds = await readFile(join(REPO_ROOT, "operator/internal/repocache/creds.go"), "utf8");
  const accepted = [...creds.matchAll(/secretKey\w+ += +"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(accepted.includes("identity") && accepted.includes("password"), "creds.go still keys both shapes");

  let found = 0;
  for (const dir of ["docs/adr", "packages/cli/src"]) {
    for (const file of await readdir(join(REPO_ROOT, dir), { recursive: true })) {
      if (!/\.(md|ts)$/.test(file)) continue;
      const text = await readFile(join(REPO_ROOT, dir, file), "utf8");
      for (const [, key] of text.matchAll(/--from-file=([\w.]+)=/g)) {
        found += 1;
        assert.ok(accepted.includes(key!), `${dir}/${file} tells the user --from-file=${key}=, which no clone reads`);
      }
    }
  }
  assert.ok(found > 0, "the scripted escape is still documented");
});

// --- Instance Harness (ADR-0031): converged by convention, never by config -----------------------

/** A Machine carrying one `workspace: "none"` Agent beside a plain one — what the walk finds and
 * the Instance Harness scan triggers on (ADR-0031/0049). */
const DECISIONER_AGENTS: Record<string, FixtureAgent> = {
  decisioner: { model: "anthropic/claude-x", workspace: "none" },
  coder: { model: "anthropic/claude-x" },
};

function findInstanceHarness(w: World): { statefulSet?: Record<string, any>; service?: Record<string, any> } {
  for (const manifest of w.kube.applied) {
    if (!manifest.trimStart().startsWith("{")) continue;
    const doc = JSON.parse(manifest) as { kind?: string; items?: Array<Record<string, any>> };
    const items = doc.kind === "List" ? (doc.items ?? []) : [];
    const statefulSet = items.find((i) => i.kind === "StatefulSet" && i.metadata.name === "jr2-instance-harness");
    const service = items.find((i) => i.kind === "Service" && i.metadata.name === "jr2-instance-harness");
    if (statefulSet || service) return { statefulSet, service };
  }
  return {};
}

test('a workspace: "none" definition converges the Instance Harness — Harness + Custodian, minus the Workspace', async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { env: [{ name: "K", value: "v" }] } };\n`,
    "myinst",
    DECISIONER_AGENTS,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const { statefulSet, service } = findInstanceHarness(w);
  assert.ok(statefulSet, "the StatefulSet is applied");
  assert.ok(service, "…with its Service");
  assert.ok(w.kube.rollouts.includes("myinst/statefulset/jr2-instance-harness"), "and the rollout is waited for");

  // The one Harness shape, minus the Workspace (ADR-0031): two containers, no /work, no user.
  const podSpec = statefulSet.spec.template.spec;
  assert.deepEqual(
    podSpec.containers.map((c: { name: string }) => c.name),
    ["harness"],
  );
  // The Custodian as a native sidecar: the kubelet stops it only after the Harness exits, so the
  // drain keeps its route to the Menu and the model to the end (ADR-0031).
  assert.deepEqual(
    podSpec.initContainers.map((c: { name: string; restartPolicy?: string }) => [c.name, c.restartPolicy]),
    [["custodian", "Always"]],
  );
  assert.deepEqual(
    podSpec.volumes.map((v: { name: string }) => v.name),
    ["custodian-values", "custodian-config"],
    "no /work — nothing to attach; the Custodian's own two alone",
  );
  // Its Custodian's two files from the ConfigMap `jr2 up` rendered for this pod, beside the one
  // program every pod projects from `jr2-held` (ADR-0059).
  assert.deepEqual(
    podSpec.volumes.find((v: { name: string }) => v.name === "custodian-config"),
    {
      name: "custodian-config",
      projected: {
        sources: [
          {
            configMap: {
              name: "jr2-held-custodian",
              items: [
                { key: "envoy.json", path: "envoy.json" },
                { key: "custodian.lua", path: "custodian.lua" },
              ],
            },
          },
          { configMap: { name: "jr2-held", items: [{ key: "program.lua", path: "program.lua" }] } },
        ],
      },
    },
  );
  assert.equal(podSpec.shareProcessNamespace, undefined, "the Harness cannot read the Custodian's /proc");

  // Same wiring a Sandbox's Harness container gets: the harness-config ConfigMap + the env Secret.
  const harness = podSpec.containers[0];
  // This world is NOT a kit checkout (mkWorld's default kitDir is the instance folder), so the
  // resolved ref is the published one — the branch a real instance takes (ADR-0038), at the
  // canonical home (ADR-0044).
  assert.equal(harness.image, `ghcr.io/snapwich/jr2-harness:${KIT_VERSION}`, "the stock image at the kit version");
  assert.deepEqual(harness.env[0], {
    name: "JR2_HARNESS_JSON",
    valueFrom: { configMapKeyRef: { name: "jr2-harness", key: "harness.json" } },
  });
  assert.ok(
    harness.envFrom.some((e: { secretRef?: { name: string } }) => e.secretRef?.name === "jr2-harness-env"),
    "the Harness envFroms its own Secret",
  );
  // The placement gate (ADR-0031): every admission carries its own definition (ADR-0049), so the
  // Harness itself must refuse any non-Menu-only one — no code execution in this pod is a claim
  // this env makes checkable.
  assert.ok(
    harness.env.some((e: { name: string; value?: string }) => e.name === "JR2_MENU_ONLY" && e.value === "1"),
    "the Harness is told it is the Instance Harness",
  );

  // The Custodian's credential is the PLACEMENT's own signed token, not the Instance token: it may
  // deliver only for registrations recording the Instance Harness (tokens.ts, ADR-0013/0031). A
  // FILE in the Custodian alone — one key of the instance Secret, and no other key of it.
  const values = podSpec.volumes.find((v: { name: string }) => v.name === "custodian-values");
  assert.deepEqual(values.projected.sources, [
    { secret: { name: "jr2-instance", items: [{ key: "JR2_INSTANCE_HARNESS_TOKEN", path: "JR2_SANDBOX_TOKEN" }] } },
  ]);
  assert.ok(
    harness.env.some(
      (e: { name: string; value?: string }) =>
        e.name === "JR2_SANDBOX_TOKEN" && e.value === "jr2-held-JR2_SANDBOX_TOKEN",
    ),
    "the Harness holds the token's Stand-in",
  );
  assert.equal(podSpec.securityContext.fsGroup, 2000, "the values are readable by the Custodian's uid");
  // Where the Custodian carries the Menu: this instance's Orchestrator Service, rendered by `jr2 up`
  // for the one pod it makes — and the script is the HELD table, which loads the program.
  const objects = appliedObjects(w);
  const files = objects.get("ConfigMap/jr2-held-custodian")!;
  assert.deepEqual(Object.keys(files.data).sort(), ["custodian.lua", "envoy.json"]);
  assert.match(files.data["envoy.json"], /jr2-orchestrator\.myinst\.svc/);
  assert.match(files.data["custodian.lua"], /\ndofile\("\/etc\/jr2\/custodian\/config\/program\.lua"\)\n$/);
  // `jr2-held` DECLARES: each pod's manifest and the program once — nothing rendered per pod.
  const heldCm = objects.get("ConfigMap/jr2-held")!;
  const keys = Object.keys(heldCm.data);
  assert.ok(keys.includes("held-instance.json") && keys.includes("program.lua"), keys.join(", "));
  for (const key of keys) {
    assert.ok(key === "program.lua" || /^held-[a-z0-9-]+\.json$/.test(key), `jr2-held holds no rendered file: ${key}`);
  }
  assert.equal(heldCm.data["program.lua"], CUSTODIAN_PROGRAM);
  assert.ok(statefulSet.spec.template.metadata.annotations["jr2.dev/held-digest"], "a held-secret edit rolls this pod");
});

test("the Instance Harness checks the bearer derived for ITS placement — a digest, never the Instance token's (ADR-0058)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find((m) => isInstanceList(m) && m.includes(`"jr2-instance"`))!;
  const secret = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Secret" && i.metadata.name === "jr2-instance",
  )!;
  const key = Buffer.from(secret.stringData.JR2_SIGNING_KEY, "base64");
  const env = findInstanceHarness(w).statefulSet!.spec.template.spec.containers[0].env as Array<{
    name: string;
    value?: string;
  }>;
  // Last, so a `harness.env` entry of the same name cannot choose it.
  assert.deepEqual(env.at(-1), {
    name: "JR2_HARNESS_TOKEN_SHA256",
    value: harnessTokenDigest(key, "jr2-instance-harness"),
  });
  assert.ok(!env.some((e) => e.name === "JR2_ECHO_TOKEN_SHA256"), "the Instance token's digest is gone");
});

/** The NetworkPolicies the instance List carries, by name. */
function policiesOf(w: World): Record<string, Record<string, any>> {
  const list = w.kube.applied.find((m) => isInstanceList(m) && m.includes(`"jr2-orchestrator"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  return Object.fromEntries(items.filter((i) => i.kind === "NetworkPolicy").map((i) => [i.metadata.name, i]));
}

test("ingress to every Harness pod is the Orchestrator's alone — Sandboxes and the Instance Harness (ADR-0058)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const policies = policiesOf(w);

  // Only the Orchestrator's pods, and only this instance's: a second instance's Orchestrator in
  // another namespace is not a peer — `podSelector` alone never crosses a namespace.
  const fromOrchestrator = [
    { from: [{ podSelector: { matchLabels: { app: "jr2-orchestrator", "jr2.dev/instance": "myinst" } } }] },
  ];
  const sandboxes = policies["jr2-sandbox-ingress"]!;
  assert.equal(sandboxes.metadata.namespace, "myinst");
  // Every pod the operator makes for a Sandbox carries this label (helpers.go) — and only those.
  assert.deepEqual(sandboxes.spec.podSelector, {
    matchExpressions: [{ key: "sandbox.jr2.dev/name", operator: "Exists" }],
  });
  assert.deepEqual(sandboxes.spec.policyTypes, ["Ingress"], "egress is not decided here (ADR-0058)");
  assert.deepEqual(sandboxes.spec.ingress, fromOrchestrator);

  const instanceHarness = policies["jr2-instance-harness-ingress"]!;
  assert.deepEqual(instanceHarness.spec.podSelector, { matchLabels: { app: "jr2-instance-harness" } });
  assert.deepEqual(instanceHarness.spec.policyTypes, ["Ingress"]);
  assert.deepEqual(instanceHarness.spec.ingress, fromOrchestrator);

  // The Orchestrator itself is NOT selected: every route there is token-gated (ADR-0013), and a
  // Custodian in any Harness pod must reach it.
  for (const policy of Object.values(policies)) {
    assert.notDeepEqual(policy.spec.podSelector, { matchLabels: { app: "jr2-orchestrator" } });
  }
});

test("the ingress policies converge with the instance, whatever it composes — a Harness pod is never unguarded", async () => {
  // No Sandbox and no "none" Agent: the policies still ship, so the first Harness pod a later
  // `jr2 up` adds is born selected, never in a window before its policy exists.
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst");
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.deepEqual(Object.keys(policiesOf(w)).sort(), ["jr2-instance-harness-ingress", "jr2-sandbox-ingress"]);
});

test("both readiness probes set a period — a ~1s boot must not be billed as a 10s rollout wait", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find(isInstanceList)!;
  const orchestrator = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator",
  )!;
  const { statefulSet: harness } = findInstanceHarness(w);

  // Measured on kind: the Orchestrator answers /healthz 1.1s after its container starts, and the
  // omitted period (k8s default 10s) made the rollout 11.0s. The period is the rollout wait.
  //
  // The threshold is pinned BESIDE it, because the period alone would have paid for the faster
  // rollout with the stall tolerance: one knob sets both, and these pods are single-replica, so
  // dropping the only endpoint is an outage rather than a failover. 15 × 2s holds the 30s that the
  // default 3 × 10s gave. A future edit that shortens the period must move this too.
  for (const probe of [
    orchestrator.spec.template.spec.containers[0].readinessProbe,
    harness!.spec.template.spec.containers[0].readinessProbe,
  ]) {
    assert.equal(probe.periodSeconds, 2);
    assert.equal(probe.periodSeconds * probe.failureThreshold, 30, "the stall tolerance the default period gave");
  }
});

test("the Orchestrator carries a liveness probe that restarts only a process silent for five minutes (ADR-0008)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find(isInstanceList)!;
  const orchestrator = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Deployment" && i.metadata.name === "jr2-orchestrator",
  )!;
  const container = orchestrator.spec.template.spec.containers[0];
  const liveness = container.livenessProbe;
  assert.equal(liveness.httpGet.path, "/healthz");
  assert.equal(liveness.httpGet.port, container.readinessProbe.httpGet.port);
  assert.equal(liveness.periodSeconds, 10);
  assert.equal(liveness.failureThreshold, 30);
  assert.equal(liveness.initialDelaySeconds, undefined, "the five minutes cover a boot too");
  assert.equal(liveness.periodSeconds * liveness.failureThreshold, 300, "dead, not stalled: five minutes of silence");
  // Readiness stays the 30s take-out-of-service it was — the two probes answer different questions.
  assert.equal(container.readinessProbe.periodSeconds * container.readinessProbe.failureThreshold, 30);
});

test("the Instance Harness is a StatefulSet of one: its conversations on a claim, a drain for a grace, a ClusterIP to dial (ADR-0031)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const { statefulSet, service } = findInstanceHarness(w);

  assert.equal(statefulSet!.spec.replicas, 1, "N is 1 until a measured need");
  assert.equal(statefulSet!.spec.serviceName, "jr2-instance-harness-pods", "governed by the headless Service");
  // The volume is the value: one claim per ordinal, and it goes with the StatefulSet, not a scale.
  assert.deepEqual(
    statefulSet!.spec.volumeClaimTemplates.map((t: Record<string, any>) => [
      t.metadata.name,
      t.spec.accessModes,
      t.spec.resources.requests.storage,
    ]),
    [["conversations", ["ReadWriteOnce"], "1Gi"]],
  );
  assert.deepEqual(statefulSet!.spec.persistentVolumeClaimRetentionPolicy, {
    whenDeleted: "Delete",
    whenScaled: "Retain",
  });

  const pod = statefulSet!.spec.template.spec;
  // The drain: a Turn's worst case, so a deploy loses no Turn.
  assert.equal(pod.terminationGracePeriodSeconds, 600);
  assert.equal(pod.securityContext.fsGroup, 2000, "the claim is writable by the Harness's group");
  const [harness] = pod.containers;
  const [custodian] = pod.initContainers;
  assert.deepEqual(harness.volumeMounts[0], { name: "conversations", mountPath: "/conversations" });
  assert.ok(
    harness.env.some(
      (e: { name: string; value?: string }) => e.name === "JR2_CONVERSATIONS_DIR" && e.value === "/conversations",
    ),
    "the Harness is told where its conversations persist",
  );
  assert.ok(
    !(custodian.volumeMounts ?? []).some((m: { name: string }) => m.name === "conversations"),
    "the Custodian never reads an Agent's history",
  );

  // The dialed name is a ClusterIP Service: kube-proxy still routes it to the draining pod while
  // no other is ready, where a headless name stops resolving the moment the pod terminates.
  assert.equal(service!.spec.clusterIP, undefined);
  assert.deepEqual(service!.spec.selector, { app: "jr2-instance-harness" });
  const governing = appliedObjects(w).get("Service/jr2-instance-harness-pods")!;
  assert.equal(governing.spec.clusterIP, "None");
  assert.deepEqual(governing.spec.selector, { app: "jr2-instance-harness" });

  // `jr2 up` waits out a rollout as long as the old pod may drain, then its start.
  assert.equal(w.kube.rolloutTimeouts["myinst/jr2-instance-harness"], 600 + 180);
});

test('no "none" definitions → nothing new deploys, and a stale Instance Harness is deleted on converge', async () => {
  // Agents exist, none of them Menu-only: the feature stays invisible (ADR-0031).
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", {
    coder: { model: "anthropic/claude-x" },
  });
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const { statefulSet, service } = findInstanceHarness(w);
  assert.equal(statefulSet, undefined);
  assert.equal(service, undefined);
  // Idempotent converge: a definition that dropped its "none" must not leave a stale StatefulSet —
  // nor its conversations (ADR-0031), nor either Service.
  assert.ok(w.kube.deleted.includes("myinst/statefulset/jr2-instance-harness"));
  assert.ok(w.kube.deleted.includes("myinst/persistentvolumeclaim/conversations-jr2-instance-harness-0"));
  assert.ok(w.kube.deleted.includes("myinst/service/jr2-instance-harness"));
  assert.ok(w.kube.deleted.includes("myinst/service/jr2-instance-harness-pods"));
});

test("the Instance Harness runs the refs THIS converge resolved — the same ones the map names", async () => {
  // There is no `images` block to override them with (ADR-0038): in a kit checkout the Instance
  // Harness runs the content-addressed images just built here, and nothing else can be pointed at.
  // The accepted asymmetry: this StatefulSet names its images in the pod template (it is SUPPOSED
  // to roll when they move), while a Sandbox's refs travel through the jr2-images ConfigMap.
  const kit = await mkKit();
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const images = imagesOf(w);
  assert.match(images.harness, /^jr2-harness:[0-9a-f]{12}-amd64$/);
  const { statefulSet } = findInstanceHarness(w);
  assert.equal(statefulSet!.spec.template.spec.containers[0].image, images.harness);
  assert.equal(statefulSet!.spec.template.spec.initContainers[0].image, images.custodian);
});

// --- the post-converge sweep (ADR-0039) ----------------------------------------------------------

test("every layer jr2 builds is stamped with who owns it", async () => {
  // Ownership is a label, never a name (ADR-0039) — so an unstamped build is not a cosmetic miss,
  // it is an image no sweep can ever collect. The kit's three and the Sandbox Image builds all
  // pass through here; an Instance has no image of its own any more (ADR-0069).
  const kit = await mkKit();
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
    "default",
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const stamps = new Map(
    w.built
      .filter((b) => b.startsWith("stamp "))
      .map((b) => {
        const rest = b.slice("stamp ".length);
        const cut = rest.indexOf(" ");
        return [rest.slice(0, cut), rest.slice(cut + 1)] as const;
      }),
  );
  const kind = (ref: string): unknown => JSON.parse(stamps.get(ref) ?? "null");
  for (const repo of ["jr2-harness", "jr2-operator", "jr2-orchestrator"]) {
    const ref = [...stamps.keys()].find((r) => r.startsWith(`${repo}:`))!;
    assert.deepEqual(kind(ref), { "jr2.dev/kind": "kit" }, `${repo} is stamped as the kit's`);
  }
  assert.ok(![...stamps.keys()].some((r) => r.startsWith("jr2-instance-")), "no per-Instance image is built");
  const sandboxRef = [...stamps.keys()].find((r) => r.startsWith("jr2-sandbox-myinst-default:"))!;
  assert.deepEqual(kind(sandboxRef), { "jr2.dev/kind": "sandbox", "jr2.dev/instance": "myinst" });
});

test("a converge that succeeded sweeps the generation it replaced, and keeps what it just resolved", async () => {
  // The garbage this collects is made HERE: iterating while up leaves one full image per iteration,
  // and the moment this converge's map replaces the last one is the moment the old one stops being
  // reachable (ADR-0039).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const stale = image({ id: "sha256:old", tags: ["jr2-instance-myinst:0ldc0ntent"], bytes: 2_100_000_000 });
  const foreign = image({ id: "sha256:pg", tags: ["postgres:16"], bytes: 500, labeled: false });
  const w = mkWorld(root, { hostImages: [stale, foreign] });
  assert.equal(await up(["--yes"], w.io), 0);

  // A per-Instance image a kit before ADR-0069 built is labeled and named by no root: garbage.
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("rmi-host ")),
    ["rmi-host jr2-instance-myinst:0ldc0ntent"],
    `only the unreachable image goes — never ${imagesOf(w).orchestrator}, and never an image jr2 did not build`,
  );
  assert.match(w.err.join("\n"), /swept 1 image\(s\) \(2\.1 GB\)/, "bytes, because disk is what the user feels");
});

test("the node sweep grants the map it replaced one generation of grace; the host gets none", async () => {
  // The `jr2-images` ConfigMap reaches a Sandbox through a kubelet propagation window, so for one
  // more round a provision can still ask a NODE for a ref the new map no longer names. Nothing is
  // ever provisioned from the host daemon, so its copy goes immediately (ADR-0039).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const previous = { harness: "jr2-harness:0ldharnes", operator: "jr2-operator:0.0.0", sandbox: {} };
  const replaced = (id: string) => image({ id, tags: ["jr2-harness:0ldharnes"], bytes: 10 });
  const w = mkWorld(root, { hostImages: [replaced("sha256:host")], nodeImages: [replaced("sha256:node")] });
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } } });
  w.kube.set("myinst", "deployment", "jr2-orchestrator", {
    metadata: { name: "jr2-orchestrator", annotations: { "jr2.dev/images": JSON.stringify(previous) } },
  });

  assert.equal(await up([], w.io), 0);
  assert.ok(w.built.includes("rmi-host jr2-harness:0ldharnes"), `the host copy goes (got: ${w.built.join(", ")})`);
  assert.ok(
    !w.built.some((b) => b.startsWith("rmi-node ")),
    "…while the node keeps it one more round, so the propagation window cannot lose a provision",
  );
});

test("a converge that failed sweeps nothing", async () => {
  // The sweep is the last act of a run that fully succeeded — annotation applied, rollouts
  // verified. A converge that threw has not moved the root set, so nothing it built is garbage.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { hostImages: [image({ id: "sha256:old", tags: ["jr2-instance-myinst:0ld"], bytes: 1 })] });
  w.kube.podImages = { "app=jr2-orchestrator": "jr2-instance-myinst:0ldc0ntent" };

  await assert.rejects(() => up(["--yes"], w.io), /running pod carries/);
  assert.ok(!w.built.some((b) => b.startsWith("rmi-host ")), "a failed converge collects nothing");
});

test("a sweep that cannot run is a warning — the converge still succeeded", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { sweepFails: true });
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /sweep skipped.*the converge stands/);
  assert.match(w.err.join("\n"), /converged/);
});

test("another instance's roots protect its images, kit refs included", async () => {
  // The keep set is cluster-wide: a ref ANY instance's image map names is not garbage, which is
  // what makes "kit images are never pruned" dissolve into reachability rather than stay a rule.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, {
    hostImages: [
      image({ id: "sha256:other", tags: ["jr2-instance-other:c0ffee"], bytes: 10 }),
      image({ id: "sha256:kit", tags: ["jr2-harness:0f1e2d3c4b5a"], bytes: 20 }),
      image({ id: "sha256:gone", tags: ["jr2-harness:deadbeef1234"], bytes: 30 }),
    ],
  });
  w.kube.instanceNamespaces = [{ metadata: { name: "other" } }];
  w.kube.imageMaps = [
    {
      metadata: { name: "jr2-images", namespace: "other" },
      data: {
        "images.json": JSON.stringify({
          harness: "jr2-harness:0f1e2d3c4b5a",
          operator: "jr2-operator:5a4b3c2d1e0f",
          sandbox: { default: "jr2-sandbox-other-default:99aa88bb77cc" },
        }),
      },
    },
  ];
  w.kube.clusterPods = [
    { metadata: { name: "orch", namespace: "other" }, spec: { containers: [{ image: "jr2-instance-other:c0ffee" }] } },
  ];

  assert.equal(await up(["--yes"], w.io), 0);
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("rmi-host ")),
    ["rmi-host jr2-harness:deadbeef1234"],
    "the kit generation nothing names goes; the one another instance's map names stays",
  );
});

test("re-running against the instance's own namespace converges silently (no prompt)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { confirm: false }); // any prompt would fail the run
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } } });

  assert.equal(await up([], w.io), 0);
  assert.equal(w.confirms.length, 0, "it's home — no prompt");
});

test("the Instance Harness with two held secrets: the Custodian alone mounts what it holds (ADR-0059)", async () => {
  // The LiteLLM shape (ADR-0059's example): a catalog provider moved to a gateway, its key held
  // with no hosts (the gateway's host is its default), and a second key referenced from a Secret
  // the user manages.
  const root = await mkInstance(
    `export default { name: "myinst", harness: { catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } } }, ` +
      `secrets: [{ name: "ANTHROPIC_API_KEY", value: "sk-litellm-secret", paths: ["/v1/messages"] }, ` +
      `{ name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "team", key: "openai" } }, hosts: ["api.openai.com"] }] };\n`,
    "myinst",
    { ...DECISIONER_AGENTS, critic: { model: "openai/gpt-x", workspace: "none" } },
  );
  const w = mkWorld(root);
  w.kube.set("myinst", "secret", "team", { data: { openai: "c2stb3Blbg==" } } as never);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find((m) => isInstanceList(m) && m.includes(`"jr2-held"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const manifest = JSON.parse(
    items.find((i) => i.metadata.name === "jr2-held")!.data["held-instance.json"],
  ) as HeldManifest;
  assert.deepEqual(
    manifest.secrets.map((s) => [s.name, s.source.kind, s.hosts.map((h) => h.host)]),
    [
      ["ANTHROPIC_API_KEY", "literal", ["litellm.corp.example"]],
      ["OPENAI_API_KEY", "secret", ["api.openai.com"]],
    ],
  );
  // The catalog rides the Harness's config: the gateway is where pi sends `anthropic/…` turns.
  const harnessCm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-harness")!;
  assert.deepEqual(JSON.parse(harnessCm.data["harness.json"]).catalog, {
    anthropic: { baseUrl: "https://litellm.corp.example" },
  });

  const pod = findInstanceHarness(w).statefulSet!.spec.template.spec;
  const env = pod.containers[0].env as Array<{ name: string; value?: string }>;
  assert.equal(env.find((e) => e.name === "ANTHROPIC_API_KEY")?.value, "jr2-held-ANTHROPIC_API_KEY");
  assert.equal(env.find((e) => e.name === "OPENAI_API_KEY")?.value, "jr2-held-OPENAI_API_KEY");
  assert.equal(env.find((e) => e.name === "HTTPS_PROXY")?.value, "http://127.0.0.1:15001");
  assert.deepEqual(env.at(-1)?.name, "JR2_HARNESS_TOKEN_SHA256", "the gate still rides last");

  // Only the Custodian references what it holds; no manifest but its own Secret names the CA.
  const held = ["jr2-held-secrets-instance", "jr2-held-tls", "team"];
  const harnessRefs = JSON.stringify(pod.containers[0]);
  for (const name of held) assert.ok(!harnessRefs.includes(`"${name}"`), `the Harness container references ${name}`);
  const values = pod.volumes.find((v: { name: string }) => v.name === "custodian-values");
  assert.deepEqual(
    values.projected.sources.map((s: { secret: { name: string } }) => s.secret.name),
    ["jr2-instance", "jr2-held-secrets-instance", "team"],
  );
  // The provider preflight's probe holds its own copy for its life (ADR-0019); it is left out here.
  const everything = w.kube.applied.filter((m) => !m.includes(`"jr2.dev/provider-preflight"`)).join("\n");
  const caMentions = everything.split('"jr2-held-ca"').length - 1;
  assert.equal(caMentions, 1, "jr2-held-ca is named once: by its own Secret, and by no pod");
  assert.ok(
    !everything.replace(/"sk-litellm-secret"/, "").includes("sk-litellm-secret"),
    "the value is in one place alone",
  );
  assert.ok(
    items.find((i) => i.metadata.name === "jr2-held-secrets-instance")!.stringData.ANTHROPIC_API_KEY ===
      "sk-litellm-secret",
    "…the Custodian's Secret",
  );
});

// --- the Size and the priority tiers (ADR-0060) ------------------------------------------------

/** A `workspace()` that states a Size, and optionally a User Container split — `under` composes it
 * one level down, as a packaged Machine arrives. */
async function withSized(root: string, resources: string, user?: string, under?: "child"): Promise<string> {
  const sized =
    `workspace(body, { repos: { app: "https://e.test/a.git" }, spec: () => ({ branch: "b" }), ` +
    `resources: ${resources}${user ? `, user: ${user}` : ""} })`;
  await writeFile(
    join(root, "workflows", "sized.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      (under === "child"
        ? `export const machine = jr2Setup({ events: [], actors: { review: ${sized} } })\n` +
          `  .createMachine({ id: "host", initial: "reviewing", states: { reviewing: { invoke: { src: "review" } } } });\n`
        : `export const machine = ${sized};\n`),
  );
  return root;
}

/** Every object this converge applied, flattened out of Lists, by `<kind>/<name>`. */
function appliedObjects(w: World): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const manifest of w.kube.applied) {
    if (!manifest.trimStart().startsWith("{")) continue;
    const doc = JSON.parse(manifest) as Record<string, any>;
    for (const i of doc.kind === "List" ? doc.items : [doc]) out.set(`${i.kind}/${i.metadata?.name}`, i);
  }
  return out;
}

test("a split that leaves the Harness below its floor is refused at the converge, naming the number and the line", async () => {
  const root = await withSized(
    await mkInstance(`export default { name: "myinst" };\n`),
    `{ limits: { memory: "1Gi" } }`,
    `{ image: "ghcr.io/acme/sshd:1", resources: { limits: { memory: "800Mi" } } }`,
    "child",
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(
    err,
    /refusing: workflow "sized" \(on the Machine composed as "review"\): the Size leaves the Harness container 160Mi/,
  );
  assert.match(err, /the User Container's 800Mi \(its user\.resources\.limits\.memory\)/);
  assert.match(
    err,
    /export const machine = customize\(<import>, \{ actors: \{ review: \{ resources: \{ limits: \{ memory: "<memory>" \} \} \} \} \}\)/,
  );
  assert.deepEqual(w.kube.applied, [], "not even the namespace");
  assert.deepEqual(w.built, []);
});

test("the Instance default is split too: a sandbox.resources below the floor is refused naming jr2.config.ts", async () => {
  const root = await withWorkspace(
    await mkInstance(`export default { name: "myinst", sandbox: { resources: { limits: { memory: "300Mi" } } } };\n`),
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  assert.match(w.err.join("\n"), /sandbox\.resources\.limits\.memory in jr2\.config\.ts/);
});

test("a Size no Sandbox node could hold WARNS and converges; a node reporting no allocatable is no evidence", async () => {
  const root = await withSized(
    await mkInstance(`export default { name: "myinst" };\n`),
    `{ limits: { memory: "64Gi", cpu: "2" } }`,
  );
  const w = mkWorld(root);
  w.kube.nodes = [
    {
      metadata: { name: "small" },
      status: { nodeInfo: { architecture: "amd64" }, allocatable: { memory: "16Gi", cpu: "8" } },
    },
  ];
  assert.equal(await up(["--yes"], w.io), 0, "a warning, never a refusal — the node set moves");
  assert.match(
    w.err.join("\n"),
    /warning: no Sandbox node right now has the allocatable for a Size of memory 64Gi, cpu 2 \(workflow "sized"\)/,
  );

  const fits = mkWorld(root);
  fits.kube.nodes = [
    {
      metadata: { name: "big" },
      status: { nodeInfo: { architecture: "amd64" }, allocatable: { memory: "128Gi", cpu: "32" } },
    },
  ];
  assert.equal(await up(["--yes"], fits.io), 0);
  assert.doesNotMatch(fits.err.join("\n"), /has the allocatable/);

  const unknown = mkWorld(root); // the default fake node reports no allocatable
  assert.equal(await up(["--yes"], unknown.io), 0);
  assert.doesNotMatch(unknown.err.join("\n"), /has the allocatable/);
});

test("`jr2 up` creates the two PriorityClasses before the operator, and none for a key the Instance names", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const objects = appliedObjects(w);
  assert.deepEqual(
    { ...objects.get("PriorityClass/jr2-control"), metadata: undefined, description: undefined },
    {
      apiVersion: "scheduling.k8s.io/v1",
      kind: "PriorityClass",
      metadata: undefined,
      value: 100000,
      preemptionPolicy: "PreemptLowerPriority",
      globalDefault: false,
      description: undefined,
    },
  );
  assert.equal(objects.get("PriorityClass/jr2-sandbox")!.value, 1000);
  assert.equal(objects.get("PriorityClass/jr2-sandbox")!.preemptionPolicy, "Never");
  // Before anything that names them: a pod whose class does not exist is refused at admission.
  const firstClass = w.kube.applied.findIndex((m) => m.includes(`"kind":"PriorityClass"`));
  const operator = w.kube.applied.findIndex((m) => m.includes("controller-manager"));
  assert.ok(firstClass >= 0 && firstClass < operator, "the classes precede the operator layer");

  const own = await withWorkspace(
    await mkInstance(`export default { name: "own", priorityClasses: { sandbox: "batch-low" } };\n`, "own"),
  );
  const o = mkWorld(own);
  assert.equal(await up(["--yes"], o.io), 0);
  const ownObjects = appliedObjects(o);
  assert.ok(ownObjects.has("PriorityClass/jr2-control"), "the key it did not name is still jr2's");
  assert.ok(!ownObjects.has("PriorityClass/jr2-sandbox"), "the cluster's own scheme names the other");
});

test("the operator runs under the Instance's control class when `priorityClasses` names one", async () => {
  const root = await withWorkspace(
    await mkInstance(`export default { name: "own", priorityClasses: { control: "ops-high" } };\n`, "own"),
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const operatorApply = w.kube.applied.find((m) => m.includes("controller-manager") && m.includes("kind: Deployment"));
  assert.ok(operatorApply, "the operator layer was applied");
  assert.match(operatorApply, /priorityClassName: ops-high/);
  assert.doesNotMatch(operatorApply, /priorityClassName: jr2-control/, "no pod names a class jr2 did not create");
  assert.ok(!appliedObjects(w).has("PriorityClass/jr2-control"));
});

test("jr2's own pods are kit-sized: memory request = limit, a cpu request, no cpu limit, and the control class", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const objects = appliedObjects(w);
  const orch = objects.get("Deployment/jr2-orchestrator")!.spec.template.spec;
  assert.equal(orch.priorityClassName, "jr2-control");
  assert.deepEqual(orch.containers[0].resources, {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { memory: "1Gi" },
  });
  assert.deepEqual(
    Object.keys(objects.get("Deployment/jr2-orchestrator")!.spec.template.metadata.annotations),
    ["jr2.dev/secret-digest"],
    "a restarted Orchestrator re-attaches — no disruption opt-out",
  );
  const cache = objects.get("DaemonSet/jr2-repo-cache")!.spec.template.spec;
  assert.equal(cache.priorityClassName, "jr2-control");
  // The one exception: `git index-pack` spikes, and its OOM costs only a refetch.
  assert.deepEqual(cache.containers[0].resources, {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { memory: "1Gi" },
  });
});

test("the Instance Harness: kit-sized, the sandbox class, and the two disruption opt-outs (ADR-0060)", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", priorityClasses: { sandbox: "batch-low" } };\n`,
    "myinst",
    {
      triager: { model: "anthropic/claude-haiku-x", workspace: "none" },
    },
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const deploy = appliedObjects(w).get("StatefulSet/jr2-instance-harness")!;
  const pod = deploy.spec.template;
  assert.equal(pod.spec.priorityClassName, "batch-low");
  assert.equal(pod.metadata.annotations["cluster-autoscaler.kubernetes.io/safe-to-evict"], "false");
  assert.equal(pod.metadata.annotations["karpenter.sh/do-not-disrupt"], "true");
  const [harness] = pod.spec.containers;
  const [custodian] = pod.spec.initContainers;
  assert.deepEqual(harness.resources, { requests: { cpu: "250m", memory: "1Gi" }, limits: { memory: "1Gi" } });
  assert.deepEqual(custodian.resources, { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "64Mi" } });
});

// --- the Instance Effector (ADR-0068) ---------------------------------------------------------

/** A workflow that carries one http Effect naming `secret("jira")`. */
async function withHttpEffect(root: string, name = "jira"): Promise<string> {
  await writeFile(
    join(root, "workflows", "notify.ts"),
    `import { bearer, http, jr2Setup, secret } from ${JSON.stringify(KIT_SRC)};\n` +
      `const comment = http({ method: "POST", url: "https://jira.example.com/rest/api/2/issue", ` +
      `auth: bearer(secret("${name}")), timeout: "2m" });\n` +
      `export const machine = jr2Setup({ events: [], actors: { comment } })\n` +
      `  .createMachine({ id: "notify", initial: "idle", states: { idle: {} } });\n`,
  );
  return root;
}

test("an http Effect places its secret in the Instance Effector: the four objects, the key, the report (ADR-0068)", async () => {
  const root = await withHttpEffect(
    await mkInstance(
      `export default { name: "myinst", secrets: [{ name: "jira", value: "jira-token-value-0123" }, ` +
        `{ name: "orphan", value: "orphan-value-0123" }] };\n`,
    ),
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const out = w.err.join("\n");
  assert.match(out, /comment: http POST https:\/\/jira\.example\.com — 120s, in the Instance Effector, secrets "jira"/);
  assert.match(out, /secret jira: an Effect secret in the Instance Effector \(notify\/comment\)/);
  assert.match(out, /warning: secrets\[1\] \(orphan\) is named by nothing; goes nowhere/);
  assert.match(out, /instance effector: converging \(notify\/comment; secrets `jira`; grace 150s\)/);

  const list = w.kube.applied.find(
    (m) => m.includes(`"name":"jr2-instance-effector"`) && m.includes(`"kind":"Deployment"`),
  )!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["Secret", "Deployment", "Service", "NetworkPolicy"],
  );
  const [secret, deployment, service, policy] = items;
  assert.equal(secret!.stringData["secret.jira"], "jira-token-value-0123");
  assert.equal(secret!.stringData.orphan, undefined, "a secret nothing names goes nowhere");
  const instanceList = w.kube.applied.find((m) => isInstanceList(m) && m.includes(`"jr2-instance"`))!;
  const instanceSecret = (JSON.parse(instanceList) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Secret" && i.metadata.name === "jr2-instance",
  )!;
  const signing = Buffer.from(instanceSecret.stringData.JR2_SIGNING_KEY, "base64");
  assert.equal(secret!.stringData.key, effectorKey(signing, "instance"), "the placement's key, derived");
  assert.deepEqual(JSON.parse(secret!.stringData["effector.json"]), {
    version: 1,
    placement: "instance",
    targets: [{ scheme: "https", host: "jira.example.com", port: 443, secrets: ["jira"] }],
  });
  const pod = deployment!.spec.template.spec;
  assert.equal(deployment!.spec.strategy.rollingUpdate.maxSurge, 1);
  assert.equal(pod.terminationGracePeriodSeconds, 150, "the longest Effect timeout, plus the read margin");
  assert.deepEqual(pod.containers[0].command, ["/opt/jr2/bin/effector"]);
  assert.match(pod.containers[0].image, /jr2-harness/);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.containers[0].securityContext.runAsNonRoot, true);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.ok(deployment!.spec.template.metadata.annotations["jr2.dev/effector-digest"]);
  assert.deepEqual(pod.volumes.find((v: { name: string }) => v.name === "secrets").projected.sources, [
    { secret: { name: "jr2-instance-effector", items: [{ key: "secret.jira", path: "jira" }] } },
  ]);
  assert.equal(service!.spec.clusterIP, "None");
  assert.equal(service!.spec.publishNotReadyAddresses, true);
  // The policy guards the Effector's own pods: its selector is exactly theirs, and every label it
  // asks for is on the pod template — a selector that matches no pod would guard nothing (ADR-0068).
  assert.deepEqual(policy!.spec.podSelector, { matchLabels: { app: "jr2-instance-effector" } });
  const podLabels = deployment!.spec.template.metadata.labels as Record<string, string>;
  for (const [k, v] of Object.entries(policy!.spec.podSelector.matchLabels as Record<string, string>)) {
    assert.equal(podLabels[k], v, `the Effector's pods carry ${k}=${v}, so the policy selects them`);
  }
  assert.deepEqual(policy!.spec.policyTypes, ["Ingress"]);
  assert.deepEqual(policy!.spec.ingress, [
    { from: [{ podSelector: { matchLabels: { app: "jr2-orchestrator", "jr2.dev/instance": "myinst" } } }] },
  ]);
  assert.ok(
    !JSON.stringify(w.kube.applied.filter((m) => !m.includes("jr2-instance-effector"))).includes(
      "jira-token-value-0123",
    ),
    "the value lands in the Effector's Secret alone",
  );
});

test("the Instance Effector trusts the instance's caBundle: the jr2-ca ConfigMap mounted, JR2_CA_FILE naming its file (ADR-0068, ADR-0020)", async () => {
  const effectorPod = async (config: string, pem?: string) => {
    const root = await withHttpEffect(await mkInstance(config));
    if (pem) await writeFile(join(root, "ca.crt"), pem);
    const w = mkWorld(root);
    assert.equal(await up(["--yes"], w.io), 0);
    const list = w.kube.applied.find(
      (m) => m.includes(`"name":"jr2-instance-effector"`) && m.includes(`"kind":"Deployment"`),
    )!;
    const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
    return { pod: items.find((i) => i.kind === "Deployment")!.spec.template.spec, w };
  };
  const secrets = `secrets: [{ name: "jira", value: "jira-token-value-0123" }]`;
  const pem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";
  const { pod, w } = await effectorPod(
    `export default { name: "myinst", harness: { caBundle: "ca.crt" }, ${secrets} };\n`,
    pem,
  );
  const [container] = pod.containers;
  const caFile = container.env.find((e: { name: string }) => e.name === "JR2_CA_FILE");
  const caMount = container.volumeMounts.find((m: { name: string }) => m.name === "ca");
  assert.deepEqual(
    pod.volumes.find((v: { name: string }) => v.name === "ca"),
    { name: "ca", configMap: { name: "jr2-ca" } },
  );
  assert.equal(caMount.readOnly, true);
  assert.equal(caFile.value, `${caMount.mountPath}/ca.crt`, "the env names the mounted file");
  const cm = JSON.parse(w.kube.applied.find((m) => m.includes(`"name":"jr2-ca"`))!);
  assert.equal(cm.data["ca.crt"], pem, "…and the ConfigMap holds the bundle under that key");

  const none = (await effectorPod(`export default { name: "myinst", ${secrets} };\n`)).pod;
  assert.ok(!none.volumes.some((v: { name: string }) => v.name === "ca"), "no caBundle, no mount");
  assert.ok(!none.containers[0].env.some((e: { name: string }) => e.name === "JR2_CA_FILE"));
});

test("the Instance Effector's digest is a function of its secret inputs: the same inputs keep it, an edit rolls it (ADR-0068)", async () => {
  const signing = randomBytes(32).toString("base64");
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const digestOf = async (secrets: string): Promise<string> => {
    const w = mkWorld(
      await withHttpEffect(await mkInstance(`export default { name: "myinst", secrets: ${secrets} };\n`)),
    );
    // The kept signing key: the digest is keyed with it, so every converge here keys with one.
    w.kube.set("myinst", "secret", "jr2-instance", {
      data: { JR2_INSTANCE_TOKEN: b64("tok"), JR2_SIGNING_KEY: b64(signing) },
    } as never);
    w.kube.set("myinst", "secret", "team", {
      data: { jira: b64("team-jira-value-0123"), other: b64("team-other-value-4567") },
    } as never);
    assert.equal(await up(["--yes"], w.io), 0);
    const list = w.kube.applied.find(
      (m) => m.includes(`"name":"jr2-instance-effector"`) && m.includes(`"kind":"Deployment"`),
    )!;
    const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
    return items.find((i) => i.kind === "Deployment")!.spec.template.metadata.annotations["jr2.dev/effector-digest"];
  };
  const literal = await digestOf(`[{ name: "jira", value: "jira-token-value-0123" }]`);
  assert.equal(
    await digestOf(`[{ name: "jira", value: "jira-token-value-0123" }]`),
    literal,
    "the same inputs, the same pod",
  );
  assert.notEqual(
    await digestOf(`[{ name: "jira", value: "jira-token-value-4567" }]`),
    literal,
    "a new value rolls it",
  );
  const fromSecret = await digestOf(`[{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }]`);
  assert.notEqual(fromSecret, literal, "a literal moved to the user's Secret rolls it");
  assert.notEqual(
    await digestOf(`[{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "other" } } }]`),
    fromSecret,
    "another key of the user's Secret rolls it",
  );
});

test("a value edited in the user's Secret behind a valueFrom rolls the Instance Effector at the next converge, and the digest shows no value (ADR-0068)", async () => {
  const root = await withHttpEffect(
    await mkInstance(
      `export default { name: "myinst", secrets: [{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }] };\n`,
    ),
  );
  const w = mkWorld(root);
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  // The kept signing key: the digest is keyed with it, so every converge here keys with one.
  w.kube.set("myinst", "secret", "jr2-instance", {
    data: { JR2_INSTANCE_TOKEN: b64("tok"), JR2_SIGNING_KEY: b64(randomBytes(32).toString("base64")) },
  } as never);
  const digest = async (): Promise<string> => {
    w.kube.applied.length = 0;
    assert.equal(await up(["--yes"], w.io), 0);
    const list = w.kube.applied.find(
      (m) => m.includes(`"name":"jr2-instance-effector"`) && m.includes(`"kind":"Deployment"`),
    )!;
    const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
    return items.find((i) => i.kind === "Deployment")!.spec.template.metadata.annotations["jr2.dev/effector-digest"];
  };
  w.kube.set("myinst", "secret", "team", { data: { jira: b64("team-jira-value-0123") } } as never);
  const first = await digest();
  assert.equal(await digest(), first, "the same value, the same pod");
  w.kube.set("myinst", "secret", "team", { data: { jira: b64("team-jira-value-4567") } } as never);
  const rotated = await digest();
  assert.notEqual(rotated, first, "a new value under the same key rolls it");
  assert.ok(!w.kube.applied.some((m) => m.includes("team-jira-value")), "no applied object holds the value");
});

test("every text that says what jr2 up keeps of a valueFrom value names the digest beside the length (ADR-0068)", async () => {
  // The test above holds the code: `jr2 up` keeps a value's length (ADR-0068) AND a keyed digest of it
  // (the roll). A sentence that says it keeps the length ALONE tells a reader the digest does not
  // exist — ADR-0068 said so after the digest landed. So no ADR and no source says "only" of it.
  let read = 0;
  for (const dir of ["docs/adr", "packages/cli/src", "packages/orchestrator/src"]) {
    for (const file of await readdir(join(REPO_ROOT, dir), { recursive: true })) {
      if (!/\.(md|ts)$/.test(file)) continue;
      read += 1;
      const text = (await readFile(join(REPO_ROOT, dir, file), "utf8")).replace(/\s+/g, " ");
      const stale = /keeps only (?:that|the|its) length/i.exec(text);
      assert.equal(stale, null, `${dir}/${file} says jr2 up "${stale?.[0]}" of a value; it also keeps a keyed digest`);
    }
  }
  assert.ok(read > 0, "the texts were read");
  const adr = await readFile(
    join(REPO_ROOT, "docs/adr/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md"),
    "utf8",
  );
  const flat = adr.replace(/\s+/g, " ");
  assert.match(flat, /keeps that length and a keyed digest of the value/);
  // Both tests above roll a pod on that digest; the ADR names both, not the Effector alone.
  assert.match(flat, /The digest rolls [^.]*the Instance Effector[^.]*and the Instance Harness/);
});

test("a value edited in the user's Secret behind a valueFrom rolls the Instance Harness at the next converge (ADR-0059)", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", secrets: [` +
      `{ name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "team", key: "anthropic" } } }] };\n`,
    "myinst",
    DECISIONER_AGENTS,
  );
  const w = mkWorld(root);
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  // The kept signing key: the digest is keyed with it, so every converge here keys with one.
  w.kube.set("myinst", "secret", "jr2-instance", {
    data: { JR2_INSTANCE_TOKEN: b64("tok"), JR2_SIGNING_KEY: b64(randomBytes(32).toString("base64")) },
  } as never);
  const digest = async (): Promise<string> => {
    w.kube.applied.length = 0;
    assert.equal(await up(["--yes"], w.io), 0);
    // The cluster keeps the CA and the leaves this converge applied, as a real one does.
    const items = (
      JSON.parse(w.kube.applied.find((m) => isInstanceList(m) && m.includes(`"jr2-held-ca"`))!) as {
        items: Array<Record<string, any>>;
      }
    ).items;
    for (const name of ["jr2-held-ca", "jr2-held-tls"]) {
      const kept = items.find((i) => i.metadata.name === name)!.stringData as Record<string, string>;
      w.kube.set("myinst", "secret", name, {
        data: Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, b64(v)])),
      } as never);
    }
    return findInstanceHarness(w).statefulSet!.spec.template.metadata.annotations["jr2.dev/held-digest"];
  };
  w.kube.set("myinst", "secret", "team", { data: { anthropic: b64("sk-ant-first-value") } } as never);
  const first = await digest();
  assert.equal(await digest(), first, "the same value, the same pod");
  w.kube.set("myinst", "secret", "team", { data: { anthropic: b64("sk-ant-rotated-value") } } as never);
  assert.notEqual(await digest(), first, "a new value under the same key rolls it");
  assert.ok(!w.kube.applied.some((m) => m.includes("sk-ant-")), "no applied object holds the value");
});

test("no Effect placed there: no Instance Effector, and a stale one is deleted (ADR-0068)", async () => {
  const w = mkWorld(await mkInstance(`export default { name: "myinst" };\n`));
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /instance effector: none \(no Effect is placed there\)/);
  for (const kind of ["deployment", "service", "networkpolicy", "secret"]) {
    assert.ok(w.kube.deleted.includes(`myinst/${kind}/jr2-instance-effector`), kind);
  }
});

test("an Effect secret shorter than 8 characters is refused before anything is built or applied (ADR-0068)", async () => {
  const root = await withHttpEffect(
    await mkInstance(`export default { name: "myinst", secrets: [{ name: "jira", value: "short" }] };\n`),
  );
  const w = mkWorld(root);
  await assert.rejects(
    () => up(["--yes"], w.io),
    /secrets\[0\] \(jira\) is an Effect secret shorter than 8 characters/,
  );
  assert.deepEqual(w.built, [], "nothing was built");
  assert.deepEqual(w.kube.applied, [], "nothing was applied");
});

test("a valueFrom Effect secret shorter than 8 characters in the user's Secret is refused before the instance is applied, value unshown (ADR-0068)", async () => {
  const root = await withHttpEffect(
    await mkInstance(
      `export default { name: "myinst", secrets: [{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }] };\n`,
    ),
  );
  const w = mkWorld(root);
  // A trailing newline (`kubectl create secret --from-file`) is not counted, as the Effector drops it.
  w.kube.set("myinst", "secret", "team", { data: { jira: Buffer.from("tiny-7c\n").toString("base64") } } as never);
  await assert.rejects(
    () => up(["--yes"], w.io),
    (err: Error) => {
      assert.match(err.message, /secrets\[0\] \(jira\) is an Effect secret shorter than 8 characters/);
      assert.ok(!err.message.includes("tiny-7c"), "the value itself is not shown");
      return true;
    },
  );
  assert.ok(!w.kube.applied.some((m) => m.includes(`"name":"jr2-instance-effector"`)), "no Effector is applied");
  // Long enough, the same reference converges.
  const ok = mkWorld(root);
  ok.kube.set("myinst", "secret", "team", {
    data: { jira: Buffer.from("team-jira-value-0123").toString("base64") },
  } as never);
  assert.equal(await up(["--yes"], ok.io), 0);
});

test("an Effect that names a secret the list does not hold is refused before anything is built or applied, naming the line to add (ADR-0050)", async () => {
  const root = await withHttpEffect(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  await assert.rejects(() => up(["--yes"], w.io), /names secret\("jira"\), which the `secrets` list does not hold/);
  assert.deepEqual(w.built, [], "nothing was built");
  assert.deepEqual(w.kube.applied, [], "nothing was applied");
});

/** A `workspace()` whose pod is named the Held secrets in `secrets` (ADR-0059). */
async function withHeldWorkspace(root: string, secrets: string[]): Promise<string> {
  await writeFile(
    join(root, "workflows", "coding.ts"),
    `import { jr2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://e.test/a.git" }, ` +
      `secrets: ${JSON.stringify(secrets)}, spec: () => ({ branch: "b" }) });\n`,
  );
  return root;
}

test("one secret both Held and named by an Effect is both, and the report says so per pod", async () => {
  const config = `export default { name: "myinst", secrets: [{ name: "JIRA_TOKEN", value: "jira-token-value-0123", hosts: ["jira.example.com"] }] };\n`;
  const root = await withHeldWorkspace(await withHttpEffect(await mkInstance(config), "JIRA_TOKEN"), ["JIRA_TOKEN"]);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const out = w.err.join("\n");
  assert.match(
    out,
    /secret JIRA_TOKEN: Held in Workspace of workflow "coding" and an Effect secret in the Instance Effector \(notify\/comment\)/,
  );
  assert.match(out, /Workspace of workflow "coding": Custodian holds JIRA_TOKEN/);
  assert.match(out, /the Instance Effector: holds JIRA_TOKEN/);
  // The Workspace's pod has its own manifest and its own values' Secret; the Effector its own.
  const objects = appliedObjects(w);
  const pod = workspaceHeldPod({ workflow: "coding", route: [] });
  assert.deepEqual(objects.get(`Secret/jr2-held-secrets-${pod}`)?.stringData, { JIRA_TOKEN: "jira-token-value-0123" });
  const cm = objects.get("ConfigMap/jr2-held")!;
  assert.deepEqual(
    (JSON.parse(cm.data[`held-${pod}.json`]) as HeldManifest).secrets.map((s) => s.name),
    ["JIRA_TOKEN"],
  );
  // As a Held secret its name is an env var; one that is not is refused as one (R2).
  const lower = await withHeldWorkspace(
    await mkInstance(
      `export default { name: "myinst", secrets: [{ name: "jira", value: "jira-token-value-0123", hosts: ["jira.example.com"] }] };\n`,
    ),
    ["jira"],
  );
  await assert.rejects(() => up(["--yes"], mkWorld(lower).io), /not an env var name/);
});

test("hosts alone places nothing: an Effect secret with hosts that no workspace() lists reaches no Custodian (ADR-0059)", async () => {
  // The verifier's case: a known model key that only an Effect names, with one default host or
  // none, is the Effector's alone — no Custodian binds it, and R5 does not fire.
  for (const name of ["HF_TOKEN", "AZURE_OPENAI_API_KEY"]) {
    const root = await withHttpEffect(
      await mkInstance(
        `export default { name: "myinst", secrets: [{ name: "${name}", value: "a-long-enough-value" }] };\n`,
        "myinst",
        DECISIONER_AGENTS,
      ),
      name,
    );
    const w = mkWorld(root);
    assert.equal(await up(["--yes"], w.io), 0, name);
    const cm = appliedObjects(w).get("ConfigMap/jr2-held")!;
    for (const [key, manifest] of Object.entries(cm.data as Record<string, string>)) {
      if (key.startsWith("held-")) assert.deepEqual(JSON.parse(manifest).secrets, [], `${name} in ${key}`);
    }
    assert.equal(appliedObjects(w).get(`Secret/jr2-held-secrets-instance`), undefined);
    assert.match(w.err.join("\n"), new RegExp(`secret ${name}: an Effect secret in the Instance Effector`));
  }
});

/** A Workspace pod's manifest as the walk places it: two bound secrets, each its own host. */
function wsManifest(i: number): HeldManifest {
  return {
    version: 1,
    secrets: [
      {
        name: "ANTHROPIC_API_KEY",
        source: { kind: "secret", secret: "team", key: "anthropic" },
        hosts: [{ host: "api.anthropic.com", port: 443, leaf: leafStem("api.anthropic.com", 443) }],
        headers: ["x-api-key"],
        paths: ["/v1/messages"],
      },
      {
        name: `JIRA_TOKEN_${i}`,
        source: { kind: "literal" },
        hosts: [{ host: `jira-${i}.example.com`, port: 443, leaf: leafStem(`jira-${i}.example.com`, 443) }],
        headers: ["authorization"],
      },
    ],
  };
}

test("jr2-held grows by one manifest per Workspace and holds the program once — 40 Workspaces stay under the apply limit (ADR-0059)", () => {
  // The @kind failure this pins: nine pods' rendered Envoy files in one ConfigMap passed client-side
  // apply's 256 KiB annotation. `jr2 up` DECLARES; a pod's maker renders its own files.
  const heldOf = (n: number): HeldObjects => ({
    pods: Array.from({ length: n }, (_, i) => ({
      pod: workspaceHeldPod({ workflow: `w${i}`, route: [] }),
      manifest: wsManifest(i),
      values: {},
    })),
    leaves: {},
  });
  const heldCm = (n: number): { text: string; data: Record<string, string> } => {
    const list = JSON.parse(
      instanceObjects({
        name: "myinst",
        namespace: "myinst",
        image: "jr2-orchestrator:o",
        secretData: {},
        harnessEnvData: {},
        held: heldOf(n),
        imageRefs: {},
      }),
    ) as { items: Array<Record<string, any>> };
    const cm = list.items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-held")!;
    // The whole List, too: no other object carries a rendered file or a copy of the program.
    assert.equal(JSON.stringify(list).split("function envoy_on_request").length - 1, 1, "the program once");
    assert.ok(!list.items.some((i) => i.metadata.name === "jr2-held-custodian"), "no Instance Harness, no files");
    return { text: JSON.stringify(cm), data: cm.data };
  };

  const forty = heldCm(40);
  assert.ok(forty.text.length < 256 * 1024, `jr2-held for 40 Workspaces: ${forty.text.length} bytes`);
  assert.equal(Object.keys(forty.data).length, 41, "forty manifests and one program");
  assert.equal(forty.data["program.lua"], CUSTODIAN_PROGRAM);
  for (const key of Object.keys(forty.data)) {
    assert.ok(key === "program.lua" || /^held-ws-[0-9a-f]+\.json$/.test(key), `no rendered file: ${key}`);
  }

  // One more Workspace adds its manifest, and nothing else.
  const fortyOne = heldCm(41);
  const added = Object.keys(fortyOne.data).filter((k) => !(k in forty.data));
  assert.equal(added.length, 1);
  const entry = JSON.stringify({ [added[0]!]: fortyOne.data[added[0]!] }).length - 2 + 1; // `,"k":"v"`
  assert.equal(fortyOne.text.length - forty.text.length, entry);
});

test("a Workspace's Sandbox Effector: its manifest rides jr2-held with names only; its Secret holds its literals and effector.json (ADR-0068)", () => {
  const pod = workspaceHeldPod({ workflow: "ticket", route: [] });
  const list = JSON.parse(
    instanceObjects({
      name: "myinst",
      namespace: "myinst",
      image: "jr2-orchestrator:o",
      secretData: {},
      harnessEnvData: {},
      held: { pods: [], leaves: {} },
      imageRefs: {},
      sandboxEffectors: [
        {
          placement: "sandbox",
          pod,
          label: 'Workspace of workflow "ticket"',
          secrets: [
            { name: "aws", source: { kind: "literal" } },
            { name: "kube", source: { kind: "secret", secret: "team", key: "kubeconfig" } },
          ],
          values: { aws: "aws-secret-value-0123" },
          targets: [],
          pushes: [{ slot: "app", sign: true, url: "https://github.com/acme/app.git", match: "*" }],
          commands: true,
          effects: ["ticket/deploy", "ticket/publish"],
        },
      ],
      gitPush: {
        secrets: [
          {
            name: "jr2-git-push-0a1b2c3d",
            data: { "entry.json": "e30=", password: Buffer.from("ghp_token_value_0123").toString("base64") },
          },
        ],
        manifest: {
          version: 1,
          entries: [{ match: "*", order: 0, secret: "jr2-git-push-0a1b2c3d", push: ["token"], sign: "ssh" }],
        },
      },
    }),
  ) as { items: Array<Record<string, any>> };
  const cm = list.items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "jr2-held")!;
  const manifest = JSON.parse(cm.data[`effector-${pod}.json`]);
  assert.deepEqual(manifest, {
    version: 1,
    secret: `jr2-effector-${pod}`,
    sources: [
      { secret: { name: `jr2-effector-${pod}`, items: [{ key: "secret.aws", path: "aws" }] } },
      { secret: { name: "team", items: [{ key: "kubeconfig", path: "kube" }] } },
    ],
    // Its pushes by Repo Slot (ADR-0051): the provision matches each url and names the entry's Secret.
    pushes: [{ slot: "app", sign: true }],
  });
  // The push manifest: names only.
  assert.deepEqual(JSON.parse(cm.data["git-push.json"]), {
    version: 1,
    entries: [{ match: "*", order: 0, secret: "jr2-git-push-0a1b2c3d", push: ["token"], sign: "ssh" }],
  });
  assert.ok(!JSON.stringify(cm).includes("aws-secret-value") && !JSON.stringify(cm).includes("ghp_token"), "no value");
  const secret = list.items.find((i) => i.kind === "Secret" && i.metadata.name === `jr2-effector-${pod}`)!;
  assert.equal(secret.metadata.labels["jr2.dev/effector-pod"], pod);
  assert.equal(secret.stringData["secret.aws"], "aws-secret-value-0123");
  assert.ok(!JSON.stringify(secret).includes("ghp_token"), "no push token in the Workspace's Secret");
  assert.deepEqual(JSON.parse(secret.stringData["effector.json"]), {
    version: 1,
    placement: "sandbox",
    targets: [],
    commands: true,
  });
  // The entry's own push Secret, labeled so a stale one is found.
  const push = list.items.find((i) => i.kind === "Secret" && i.metadata.name === "jr2-git-push-0a1b2c3d")!;
  assert.equal(push.metadata.labels["jr2.dev/git-push"], "true");
  assert.equal(Buffer.from(push.data.password, "base64").toString(), "ghp_token_value_0123");
  assert.equal("kube" in secret.stringData || "secret.kube" in secret.stringData, false, "a valueFrom is never copied");
});

test("no ADR, glossary entry or source says `jr2 up` reads `.env` into the Orchestrator's Secret (ADR-0068)", async () => {
  // The converge test that holds `jr2-instance` to jr2's own keys holds the code: each git token
  // goes to its entry's clone Secret. A sentence that sends `.env` into the Orchestrator's Secret
  // tells a reader the Orchestrator holds a value — ADR-0043 and two comments on the bundle stage
  // said so once.
  const stale = /(?:\.env`?|reads it) [^.]{0,40}into the Orchestrator's (?:Secret|env)/i;
  const texts: Array<[string, string]> = [["GLOSSARY.md", await readFile(join(REPO_ROOT, "GLOSSARY.md"), "utf8")]];
  for (const dir of ["docs/adr", "packages/cli/src", "packages/cli/test", "packages/orchestrator/src"]) {
    for (const file of await readdir(join(REPO_ROOT, dir), { recursive: true })) {
      if (!/\.(md|ts)$/.test(file) || file === "up.test.ts") continue;
      texts.push([`${dir}/${file}`, await readFile(join(REPO_ROOT, dir, file), "utf8")]);
    }
  }
  assert.ok(texts.length > 1, "the texts were read");
  for (const [file, raw] of texts) {
    // A comment's line breaks carry `//` or `*`; drop them so a sentence reads as one line.
    const text = raw.replace(/\s*(?:\/\/|\*)\s+/g, " ").replace(/\s+/g, " ");
    assert.equal(stale.exec(text)?.[0], undefined, `${file} still sends .env into the Orchestrator's Secret`);
  }
});

test("no ADR and no glossary entry says `jr2 up` writes a Sandbox's Custodian configuration (ADR-0059)", async () => {
  // `jr2 up` DECLARES; a pod's maker renders its files — the Orchestrator a Sandbox's at provision.
  // A sentence that gives `jr2 up` the whole of Envoy's configuration tells a reader the
  // Orchestrator renders nothing: ADR-0059, -0005, -0010, -0013 and GLOSSARY.md said so once.
  const stale = [
    /`jr2 up` writes Envoy's whole configuration/,
    /`jr2 up` writes into the Custodian's configuration/,
    /Envoy,? (?:a Pinned image, )?configured by `jr2 up`/,
    /bootstrap and script `jr2 up` writes/,
    /its pod's config \(`jr2-held`\)/,
  ];
  const texts: Array<[string, string]> = [["GLOSSARY.md", await readFile(join(REPO_ROOT, "GLOSSARY.md"), "utf8")]];
  for (const file of await readdir(join(REPO_ROOT, "docs/adr"))) {
    if (file.endsWith(".md")) texts.push([file, await readFile(join(REPO_ROOT, "docs/adr", file), "utf8")]);
  }
  assert.ok(texts.length > 1, "the ADRs were read");
  for (const [file, raw] of texts) {
    const text = raw.replace(/\s+/g, " ");
    for (const re of stale) assert.equal(re.exec(text)?.[0], undefined, `${file} still says the old placement`);
  }
  // ADR-0005's mount table, "stated once", names the pod's own ConfigMap beside the program.
  const adr5 = texts.find(([f]) => f.startsWith("0005-"))![1];
  const row = adr5.split("\n").find((l) => l.startsWith("| `custodian` |"))!;
  assert.match(row, /`<sandbox>-custodian`/);
  assert.match(row, /`program\.lua` from `jr2-held`/);
});

test("the Instance Harness's held digest covers its Custodian's two files: a changed custodian.lua rolls it (ADR-0059)", () => {
  // A literal bound to no target, so the digest reads no leaf: what moves it here is the files.
  const manifest: HeldManifest = {
    version: 1,
    secrets: [{ name: "JIRA_TOKEN", source: { kind: "literal" }, hosts: [], headers: ["authorization"] }],
  };
  const pod = { pod: "instance", manifest, values: { JIRA_TOKEN: "jira-value-0" } };
  const files = { bootstrap: '{"static_resources":{}}', script: 'HELD = {}\ndofile("program.lua")\n' };
  const all: HeldObjects = { pods: [pod], instance: files, leaves: {} };
  const digest = (custodian: { bootstrap: string; script: string }) =>
    heldDigest(Buffer.from("k"), all, { ...pod, custodian }, () => "d");
  const first = digest(files);
  assert.equal(digest({ ...files }), first, "the same files, the same pod");
  assert.notEqual(digest({ ...files, script: 'HELD = { x = 1 }\ndofile("program.lua")\n' }), first, "custodian.lua");
  assert.notEqual(digest({ ...files, bootstrap: '{"static_resources":{"x":1}}' }), first, "envoy.json");
});

test("the Instance Harness's held digest covers the program its custodian.lua loads: a changed program.lua rolls it (ADR-0059)", () => {
  const manifest: HeldManifest = {
    version: 1,
    secrets: [{ name: "JIRA_TOKEN", source: { kind: "literal" }, hosts: [], headers: ["authorization"] }],
  };
  const pod = { pod: "instance", manifest, values: { JIRA_TOKEN: "jira-value-0" } };
  const files = { bootstrap: '{"static_resources":{}}', script: 'HELD = {}\ndofile("program.lua")\n' };
  const all: HeldObjects = { pods: [pod], instance: files, leaves: {} };
  const digest = (program?: string) =>
    heldDigest(Buffer.from("k"), all, { ...pod, custodian: files }, () => "d", program);
  // `jr2 up` passes no program, so the digest it writes is over the kit's own program.lua.
  assert.equal(digest(), digest(CUSTODIAN_PROGRAM), "the kit's program is the default");
  assert.notEqual(digest(`${CUSTODIAN_PROGRAM}\n-- edited\n`), digest(), "program.lua");
});

test("the Orchestrator may apply a Sandbox's Custodian ConfigMap — and may not read, list or delete one (ADR-0059)", async () => {
  // It renders a Sandbox's two files at provision with a server-side apply (create + patch); the
  // CR's ownerReference takes them away with the pod, so the Orchestrator needs no delete.
  const w = mkWorld(await mkInstance(`export default { name: "myinst" };\n`));
  assert.equal(await up(["--yes"], w.io), 0);
  const role = appliedObjects(w).get("Role/jr2-orchestrator")!;
  const rules = role.rules.filter((r: { resources: string[] }) => r.resources.includes("configmaps"));
  assert.deepEqual(rules, [{ apiGroups: [""], resources: ["configmaps"], verbs: ["create", "patch"] }]);
});

/** An instance whose one workflow pushes Repo Slot `app`, bound to `url`. */
async function pushingInstance(url: string, credentials: string, sign: boolean | string = false): Promise<string> {
  const root = await mkInstance(`export default { name: "myinst", git: { credentials: ${credentials} } };\n`);
  const options = typeof sign === "string" ? sign : sign ? "{ sign: true }" : "";
  await writeFile(
    join(root, "workflows", "publish.ts"),
    `import { jr2Setup, push, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const publish = push(${options});\n` +
      `const body = jr2Setup({ events: [], actors: { publish } })\n` +
      `  .createMachine({ id: "body", initial: "run", states: { run: { invoke: { src: "publish", onDone: "done" } }, done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: ${JSON.stringify(url)} }, spec: () => ({ branch: "b" }) });\n`,
  );
  return root;
}

test("jr2 up reads the Sandbox Effector's image for what each push form owes, and refuses with the fix before it applies anything (ADR-0068)", async () => {
  const sshPushing = async () =>
    withImage(
      await pushingInstance(
        "git@github.com:ourorg/app.git",
        `[{ match: "*", sshKey: "deploy", sign: { sshKey: "signer", name: "n", email: "e@x.test" } }]`,
        true,
      ),
      "default",
    );
  const keys = (w: World) => {
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    w.kube.set("myinst", "secret", "deploy", {
      metadata: { name: "deploy" },
      data: { identity: b64("K"), known_hosts: b64("h") },
    } as never);
  };
  // The image holds git and nothing of ssh: the push over ssh is refused, naming the tool.
  const bare = mkWorld(await sshPushing(), { imageFiles: () => ({ present: [], passwd: "" }) });
  keys(bare);
  await assert.rejects(
    () => up(["--yes"], bare.io),
    /over ssh needs ssh, and its Sandbox Effector's image .* holds none/,
  );
  assert.ok(!bare.kube.applied.some((m) => m.includes(`"kind":"List"`)), "nothing applied");
  // ssh, but no passwd entry for uid 1000 (the image declares no USER): adduser is the fix.
  const nobody = mkWorld(await sshPushing(), {
    imageFiles: (_image, paths) => ({ present: [...paths], passwd: "root:x:0:0::/root:/bin/sh\n" }),
  });
  keys(nobody);
  await assert.rejects(
    () => up(["--yes"], nobody.io),
    /passwd entry for the uid 1000 .*RUN adduser -D -u 1000 <name>/s,
  );
  // ssh-keygen missing for the signed push.
  const unsigned = mkWorld(await sshPushing(), {
    imageFiles: (_image, paths) => ({
      present: paths.filter((p) => !p.endsWith("/ssh-keygen")),
      passwd: "u:x:1000:1000::/h:/bin/sh\n",
    }),
  });
  keys(unsigned);
  await assert.rejects(() => up(["--yes"], unsigned.io), /signed with an ssh key needs ssh-keygen/);
  // Everything there: the converge goes on, and the image was read.
  const ok = mkWorld(await sshPushing());
  keys(ok);
  assert.equal(await up(["--yes"], ok.io), 0);
  assert.ok(
    ok.built.some((l) => l.startsWith("inspect-files ")),
    "the Effector's image was read",
  );
  // No image named and no images/default: the Effector runs in the stock Harness image, which the
  // kit built with git alone — an ssh push is refused before anything is applied, and no image is
  // read for it.
  const stock = mkWorld(
    await pushingInstance(
      "git@github.com:ourorg/app.git",
      `[{ match: "*", sshKey: "deploy", sign: { sshKey: "signer", name: "n", email: "e@x.test" } }]`,
      true,
    ),
    { imageFiles: () => assert.fail("the stock Harness image is known, not read") },
  );
  keys(stock);
  await assert.rejects(
    () => up(["--yes"], stock.io),
    /over ssh needs ssh, and its Sandbox Effector runs in the stock Harness image .*, which holds git alone/,
  );
  assert.ok(!stock.kube.applied.some((m) => m.includes(`"kind":"List"`)), "nothing applied");
  // A token over https owes nothing beyond git: the image is not read.
  const https = mkWorld(
    await withImage(
      await pushingInstance("https://github.com/ourorg/app.git", `[{ match: "*", token: "GH_TOKEN" }]`),
      "default",
    ),
    { env: { GH_TOKEN: "ghp_0123456789abcdef" }, imageFiles: () => assert.fail("an https token push reads no image") },
  );
  assert.equal(await up(["--yes"], https.io), 0);
  // …in the stock Harness image too.
  const stockHttps = mkWorld(
    await pushingInstance("https://github.com/ourorg/app.git", `[{ match: "*", token: "GH_TOKEN" }]`),
    { env: { GH_TOKEN: "ghp_0123456789abcdef" }, imageFiles: () => assert.fail("an https token push reads no image") },
  );
  assert.equal(await up(["--yes"], stockHttps.io), 0);
});

test("jr2 up refuses an unsigned squash only when the matched entry has neither sign nor committer, and names both fixes (ADR-0067)", async () => {
  const env = { GH_TOKEN: "ghp_0123456789abcdef" };
  const url = "https://git.example.com/acme/app.git";
  const bare = mkWorld(await pushingInstance(url, `[{ match: "*", token: "GH_TOKEN" }]`, "{ squash: true }"), { env });
  await assert.rejects(
    () => up(["--yes"], bare.io),
    /squashed without sign, and git\.credentials entry "\*" holds neither sign nor committer.*add committer: \{ name: "<committer name>", email: "<committer email>" \} to it, or sign the push — push\(\{ squash: true, sign: true \}\) — and add sign: \{ sshKey/s,
  );
  assert.deepEqual(bare.kube.applied, [], "nothing applied");
  // The first fix: a committer. The entry's push Secret says who commits the squash.
  const committed = mkWorld(
    await pushingInstance(
      url,
      `[{ match: "*", token: "GH_TOKEN", committer: { name: "jr2 bot", email: "bot@example.test" } }]`,
      "{ squash: true }",
    ),
    { env },
  );
  assert.equal(await up(["--yes"], committed.io), 0);
  const secret = appliedObjects(committed).get(`Secret/${gitPushSecretName("*")}`)!;
  assert.deepEqual(JSON.parse(Buffer.from(secret.data["entry.json"], "base64").toString()).committer, {
    name: "jr2 bot",
    email: "bot@example.test",
  });
  // A signed squash needs no committer: the signer commits (in an image that holds ssh-keygen).
  const signed = mkWorld(
    await withImage(
      await pushingInstance(
        url,
        `[{ match: "*", token: "GH_TOKEN", sign: { sshKey: "signer", name: "n", email: "e@x.test" } }]`,
        "{ squash: true, sign: true }",
      ),
      "default",
    ),
    { env },
  );
  assert.equal(await up(["--yes"], signed.io), 0);
});

test("jr2 up writes one push Secret per git.credentials entry — the token, the keys copied as data — and names none per Workspace (ADR-0051)", async () => {
  const root = await withImage(
    await pushingInstance(
      "https://github.com/ourorg/app.git",
      `[{ match: "*", token: "GH_TOKEN", sshKey: "jr2-git-ssh", sign: { sshKey: "signer", name: "jr2 bot", email: "bot@example.test" } }]`,
      true,
    ),
    "default",
  );
  const w = mkWorld(root, { env: { GH_TOKEN: "ghp_0123456789abcdef" } });
  const b64 = (v: string) => Buffer.from(v).toString("base64");
  w.kube.set("myinst", "secret", "jr2-git-ssh", {
    metadata: { name: "jr2-git-ssh" },
    data: { identity: b64("PRIVATE-PUSH"), known_hosts: b64("github.com ssh-ed25519 AAAA") },
  } as never);
  w.kube.set("myinst", "secret", "signer", {
    metadata: { name: "signer" },
    data: { identity: b64("PRIVATE-SIGN") },
  } as never);
  w.kube.set("myinst", "secret", "jr2-git-push-stale", {
    metadata: { name: "jr2-git-push-stale", labels: { "jr2.dev/git-push": "true" } },
  });
  assert.equal(await up(["--yes"], w.io), 0);
  const objects = appliedObjects(w);
  const name = gitPushSecretName("*");
  const secret = objects.get(`Secret/${name}`)!;
  assert.ok(secret, "the entry's push Secret");
  const data = Object.fromEntries(
    Object.entries(secret.data as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "base64").toString()]),
  );
  assert.equal(data.username, "x-access-token");
  assert.equal(data.password, "ghp_0123456789abcdef");
  assert.equal(data.identity, "PRIVATE-PUSH");
  assert.equal(data.known_hosts, "github.com ssh-ed25519 AAAA");
  assert.equal(data["sign.identity"], "PRIVATE-SIGN");
  assert.deepEqual(JSON.parse(data["entry.json"]!), {
    match: "*",
    order: 0,
    push: ["ssh", "token"],
    sign: { format: "ssh", name: "jr2 bot", email: "bot@example.test" },
  });
  const held = objects.get("ConfigMap/jr2-held")!;
  assert.deepEqual(JSON.parse(held.data["git-push.json"]).entries, [
    { match: "*", order: 0, secret: name, push: ["ssh", "token"], sign: "ssh" },
  ]);
  assert.ok(!JSON.stringify(held).includes("ghp_"), "the manifest holds no value");
  const own = [...objects.values()].find(
    (o) => o.kind === "Secret" && String(o.metadata.name).startsWith("jr2-effector-"),
  );
  assert.ok(!JSON.stringify(own ?? {}).includes("ghp_"), "no push token in the Workspace's Secret");
  assert.ok(w.kube.deleted.includes("myinst/secret/jr2-git-push-stale"), "a stale entry's Secret goes");
  assert.match(w.err.join("\n"), /pushes Repo Slot "app" with git\.credentials "\*"/, "the report names the entry");
});

test("a key's Secret absent at jr2 up is a warning, and the entry's Secret is written without it — the provision refuses the push that needs it (ADR-0051)", async () => {
  const root = await withImage(
    await pushingInstance(
      "git@github.com:ourorg/app.git",
      `[{ match: "*", sshKey: "deploy", sign: { sshKey: "signer", name: "n", email: "e@x.test" } }]`,
      true,
    ),
    "default",
  );
  const w = mkWorld(root);
  w.kube.set("myinst", "secret", "deploy", {
    metadata: { name: "deploy" },
    data: { identity: Buffer.from("K").toString("base64"), known_hosts: Buffer.from("h").toString("base64") },
  } as never);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(
    w.err.join("\n"),
    /warning: git\.credentials "\*": the Secret "signer" does not exist in namespace myinst/,
  );
  assert.equal(
    w.err.filter((l) => l.includes('the Secret "signer" does not exist')).length,
    1,
    "one warning for the absent Secret, not one for each key it was to give",
  );
  const held = appliedObjects(w).get("ConfigMap/jr2-held")!;
  assert.deepEqual(JSON.parse(held.data["git-push.json"]).entries, [
    { match: "*", order: 0, secret: gitPushSecretName("*"), push: ["ssh"] },
  ]);
});

test("jr2 up refuses, before it applies anything, a token over http, and a token whose variable is unset — and the fix works (ADR-0051)", async () => {
  const http = mkWorld(
    await pushingInstance("http://git.example.com/acme/app.git", `[{ match: "*", token: "GH_TOKEN" }]`),
    {
      env: { GH_TOKEN: "ghp_0123456789abcdef" },
    },
  );
  await assert.rejects(
    () => up(["--yes"], http.io),
    /over http:\/\/, and jr2 sends a push credential over https or ssh only/,
  );
  assert.deepEqual(http.kube.applied, [], "nothing applied");
  // The fix it names: the https url.
  const https = mkWorld(
    await pushingInstance("https://git.example.com/acme/app.git", `[{ match: "*", token: "GH_TOKEN" }]`),
    {
      env: { GH_TOKEN: "ghp_0123456789abcdef" },
    },
  );
  assert.equal(await up(["--yes"], https.io), 0);
  const unset = mkWorld(
    await pushingInstance("https://git.example.com/acme/app.git", `[{ match: "*", token: "GH_TOKEN" }]`),
  );
  await assert.rejects(
    () => up(["--yes"], unset.io),
    /the push of Repo Slot "app" \(https:\/\/git\.example\.com\/acme\/app\.git\): git\.credentials entry "\*" cannot push — its token's variable GH_TOKEN is not set — set it in \.env/,
  );
});

test("a Workspace that no longer places an Effect in its Sandbox Effector loses its Secret; one that does keeps it (ADR-0068)", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", secrets: [{ name: "aws", value: "aws-secret-value-0123" }] };\n`,
  );
  await writeFile(
    join(root, "workflows", "deploy.ts"),
    `import { bearer, file, http, jr2Setup, secret, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const deploy = http({ method: "PUT", url: "https://files.example.com/r", auth: bearer(secret("aws")), body: file("r.txt") });\n` +
      `const body = jr2Setup({ events: [], actors: { deploy } })\n` +
      `  .createMachine({ id: "body", initial: "run", states: { run: { invoke: { src: "deploy", onDone: "done" } }, done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://e.test/a.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  const first = mkWorld(root);
  assert.equal(await up(["--yes"], first.io), 0);
  // An http whose body is a Worktree file is the Sandbox Effector's (ADR-0067): its body places it.
  assert.match(
    first.err.join("\n"),
    /deploy: http PUT https:\/\/files\.example\.com — 30s, in the Sandbox Effector, a Worktree file as its body, secrets "aws"/,
  );
  const items = first.kube.applied
    .filter((m) => m.startsWith("{"))
    .flatMap(
      (m) => ((JSON.parse(m) as { items?: Array<Record<string, any>> }).items ?? []) as Array<Record<string, any>>,
    );
  const own = items.find((i) => i.kind === "Secret" && String(i.metadata.name).startsWith("jr2-effector-"))!;
  assert.ok(own, "the Workspace's Effector Secret");
  const pod = own.metadata.labels["jr2.dev/effector-pod"] as string;

  const w = mkWorld(root);
  w.kube.set("myinst", "secret", own.metadata.name, {
    metadata: { name: own.metadata.name, labels: { "jr2.dev/effector-pod": pod } },
  });
  w.kube.set("myinst", "secret", "jr2-effector-gone", {
    metadata: { name: "jr2-effector-gone", labels: { "jr2.dev/effector-pod": "gone" } },
  });
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(w.kube.deleted.includes("myinst/secret/jr2-effector-gone"), "the stale Workspace's Secret goes");
  assert.ok(!w.kube.deleted.includes(`myinst/secret/${own.metadata.name}`), "the placing Workspace's stays");
});

test("the Orchestrator's Role reads no Secret: create and patch only, and ConfigMaps as ADR-0059 states (ADR-0068)", async () => {
  // It applies its own per-Sandbox `<sandbox>-token` and `<sandbox>-effector`, server-side, and
  // holds no value (ADR-0068): no get, no list, no watch, no delete, no update on a Secret.
  const w = mkWorld(await mkInstance(`export default { name: "myinst" };\n`));
  assert.equal(await up(["--yes"], w.io), 0);
  const role = appliedObjects(w).get("Role/jr2-orchestrator")!;
  const on = (resource: string) =>
    role.rules.filter((r: { apiGroups: string[]; resources: string[] }) => r.resources.includes(resource));
  assert.deepEqual(on("secrets"), [{ apiGroups: [""], resources: ["secrets"], verbs: ["create", "patch"] }]);
  assert.deepEqual(on("configmaps"), [{ apiGroups: [""], resources: ["configmaps"], verbs: ["create", "patch"] }]);
  assert.ok(
    !role.rules.some((r: { resources: string[] }) => r.resources.includes("*")),
    "no wildcard resource reaches a Secret",
  );
});

test("the Orchestrator may apply a Sandbox Effector's Service — and may not read, list or delete one (ADR-0068)", async () => {
  // It writes the headless Service at provision, server-side applied, owned by the CR.
  const w = mkWorld(await mkInstance(`export default { name: "myinst" };\n`));
  assert.equal(await up(["--yes"], w.io), 0);
  const role = appliedObjects(w).get("Role/jr2-orchestrator")!;
  const rules = role.rules.filter((r: { resources: string[] }) => r.resources.includes("services"));
  assert.deepEqual(rules, [{ apiGroups: [""], resources: ["services"], verbs: ["create", "patch"] }]);
});

// --- Chart wrappers (ADR-0070): the walk reads an Open body's declaration --------------------------

/** The Open body's constructor, by its module: the same module instance the kit's index loads. */
const OPEN_BODY_SRC = new URL("./open-body.ts", KIT_SRC).href;

/** A Chart wrapper lending `coder`, `tests` and a guard, allowing two models and `none`, with a
 * Chart door and one Chart file (`chart`: its text, by default one the door admits). */
async function withChartWrapper(
  root: string,
  allows: { models: string[]; workspace: string[] },
  chart: unknown = { initial: "a", states: { a: { type: "final" } } },
): Promise<string> {
  await writeFile(
    join(root, "workflows", "charted.ts"),
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` +
      `import { agent, chartSchema, command, jr2Setup } from ${JSON.stringify(KIT_SRC)};\n` +
      `import { openBody } from ${JSON.stringify(OPEN_BODY_SRC)};\n` +
      `export const machine = jr2Setup({ events: [], actors: {\n` +
      `  coder: agent({ model: "anthropic/claude-x", instructions: "i" }),\n` +
      `  tests: command(["pnpm", "test"]),\n` +
      `  body: openBody({ lends: { agents: ["coder"], effects: ["tests"], guards: ["ready"] }, allows: ${JSON.stringify(allows)},\n` +
      `    ceilings: { turns: 6, wallClock: "10m", transitions: 500, fanOut: 2, size: 65536 } }),\n` +
      `}, guards: { ready: () => true } })\n` +
      `  .createMachine({ id: "charted", input: z.object({ chart: chartSchema }), initial: "run",\n` +
      `    states: { run: { invoke: { src: "body", input: ({ event }) => event.input } } } });\n`,
  );
  await mkdir(join(root, "workflows", "charted"), { recursive: true });
  await writeFile(join(root, "workflows", "charted", "sample.chart.json"), JSON.stringify(chart));
  return root;
}

test("a Chart wrapper is narrated with what it lends, its allowed models and its Chart files (ADR-0070)", async () => {
  const root = await withChartWrapper(await mkInstance(`export default { name: "myinst" };\n`), {
    models: ["anthropic/claude-x", "openai/gpt-5"],
    workspace: ["none"],
  });
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0, w.err.join("\n"));
  const err = w.err.join("\n");
  assert.match(err, /chart wrapper "charted": lends coder, tests, ready; allows 2 model\(s\); 1 Chart file\(s\)/);
  // An Open body that allows "none" converges the Instance Harness, as a "none" Agent does (ADR-0031).
  assert.match(err, /instance harness: converging \(chart wrapper "charted" allows workspace: "none"\)/);
  assert.ok(findInstanceHarness(w).statefulSet, "the Instance Harness is applied");
});

test("a Chart file the door would refuse is refused by `jr2 up` before any cluster work (ADR-0070)", async () => {
  const root = await withChartWrapper(
    await mkInstance(`export default { name: "myinst" };\n`),
    { models: ["anthropic/claude-x"], workspace: ["write"] },
    { initial: "a", states: { a: { invoke: { src: "linter" } } } },
  );
  await writeFile(join(root, "workflows", "loose.chart.json"), "{}");
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 1);
  const err = w.err.join("\n");
  assert.match(err, /refusing: workflows\/charted\/sample\.chart\.json: Chart refused: .*linter/);
  assert.match(err, /warning: workflows\/loose\.chart\.json: ignored/, "a Chart file at the flat level is named");
  assert.equal(appliedObjects(w).size, 0, "nothing was applied");
});

test("an Open body that allows only a Workspace access converges no Instance Harness", async () => {
  const root = await withChartWrapper(await mkInstance(`export default { name: "myinst" };\n`), {
    models: ["anthropic/claude-x"],
    workspace: ["write"],
  });
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0, w.err.join("\n"));
  assert.doesNotMatch(w.err.join("\n"), /instance harness: converging/);
  assert.equal(findInstanceHarness(w).statefulSet, undefined);
});

// --- dispatch (ADR-0071) -------------------------------------------------------------------------

/** Workflows that dispatch: `intake` (door `{ ticket }`) and a `watch` whose slots are `slots`. */
async function withDispatch(root: string, slots: string): Promise<string> {
  const kit = JSON.stringify(KIT_SRC);
  await writeFile(
    join(root, "workflows", "intake.ts"),
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` +
      `import { jr2Setup } from ${kit};\n` +
      `export const machine = jr2Setup({ events: [] })\n` +
      `  .createMachine({ id: "intake", input: z.object({ ticket: z.string() }), initial: "idle", states: { idle: {} } });\n`,
  );
  await writeFile(
    join(root, "workflows", "watch.ts"),
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` +
      `import { dispatch, jr2Setup, secret } from ${kit};\n` +
      `export const machine = jr2Setup({ events: [], actors: { ${slots} } })\n` +
      `  .createMachine({ id: "watch", initial: "idle", states: { idle: {} } });\n`,
  );
  return root;
}

test("a dispatch is listed with its Workflow, its wait and where it runs; a same-Instance miss refuses before any cluster work", async () => {
  const root = await withDispatch(
    await mkInstance(`export default { name: "myinst" };\n`),
    `next: dispatch("intake", { input: z.object({ ticket: z.string() }), wait: true })`,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const out = w.err.join("\n");
  assert.match(out, /next: dispatch intake wait → this Orchestrator — 600s, in the Orchestrator's own process/);
  assert.doesNotMatch(out, /instance effector: converging/, "an in-process dispatch needs no Effector");

  const missRoot = await withDispatch(
    await mkInstance(`export default { name: "myinst" };\n`),
    `next: dispatch("intak"), bad: dispatch("intake", { input: z.object({ ticket: z.number() }) })`,
  );
  const miss = mkWorld(missRoot);
  assert.equal(await up(["--yes"], miss.io), 1);
  const said = miss.err.join("\n");
  assert.match(
    said,
    /refusing: workflow "watch" dispatches "intak" which no Workflow in the Assembly has — add workflows\/intak\.ts/,
  );
  assert.match(
    said,
    /refusing: workflow "watch" dispatches "intake" with input its door does not take: "ticket": the slot sends number, and the door takes string/,
  );
  assert.deepEqual(miss.kube.applied, [], "nothing applied");
});

test("a foreign dispatch is placed in the Instance Effector and preflighted from the host: every failure warns, none refuses", async () => {
  const config = `export default { name: "myinst", secrets: [{ name: "ops", value: "ops-instance-token-0123" }] };\n`;
  const slots =
    `away: dispatch("intake", { input: z.object({ ticket: z.string(), sha: z.string() }), ` +
    `target: { url: "https://ops.example.com", token: secret("ops") } })`;
  const asked: Array<{ url: string; auth?: string; redirect?: RequestInit["redirect"] }> = [];
  const world = async (
    answer: (url: string) => Promise<Response>,
    cfg = config,
    seed?: (w: ReturnType<typeof mkWorld>) => void,
  ) => {
    const w = mkWorld(await withDispatch(await mkInstance(cfg), slots));
    seed?.(w);
    const inner = w.io.fetch!;
    w.io.fetch = async (url: string, init?: RequestInit) => {
      if (!url.startsWith("https://ops.example.com/")) return inner(url, init);
      asked.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined, redirect: init?.redirect });
      return answer(url);
    };
    return w;
  };

  // A door that strips the slot's `sha`: a mismatch, warned.
  const strips = await world(async () =>
    Response.json({
      name: "intake",
      input: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
    }),
  );
  assert.equal(await up(["--yes"], strips.io), 0);
  let out = strips.err.join("\n");
  assert.match(out, /away: dispatch intake → https:\/\/ops\.example\.com — 30s, in the Instance Effector, token "ops"/);
  assert.match(
    out,
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: the door does not take the slot's input: the slot's field "sha" is not in the door, which strips it silently \(ADR-0071\)/,
  );
  assert.match(out, /instance effector: converging \(watch\/away; secrets `ops`/);
  // The route is open band: the token stays with the Effector, and never leaves this host.
  assert.deepEqual(asked[0], { url: "https://ops.example.com/workflows/intake", auth: undefined, redirect: "manual" });
  assert.ok(!out.includes("ops-instance-token-0123"), "the token is never printed");
  const list = strips.kube.applied.find(
    (m) => m.includes(`"name":"jr2-instance-effector"`) && m.includes(`"kind":"Deployment"`),
  )!;
  const secretObj = (JSON.parse(list) as { items: Array<Record<string, any>> }).items[0]!;
  assert.deepEqual(JSON.parse(secretObj.stringData["effector.json"]).targets, [
    { scheme: "https", host: "ops.example.com", port: 443, secrets: ["ops"] },
  ]);

  // No answer, and a miss: warnings, exit 0.
  const down = await world(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(await up(["--yes"], down.io), 0);
  out = down.err.join("\n");
  assert.match(
    out,
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: no answer from this host \(connect ECONNREFUSED\)/,
  );
  const gone = await world(async () => Response.json({ error: 'no workflow "intake"' }, { status: 404 }));
  assert.equal(await up(["--yes"], gone.io), 0);
  assert.match(
    gone.err.join("\n"),
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: no Workflow "intake" there/,
  );
  // A door outside the compared subset: not compared, warned.
  const anyOf = await world(async () =>
    Response.json({ input: { type: "object", properties: { ticket: { anyOf: [{ type: "string" }] } } } }),
  );
  assert.equal(await up(["--yes"], anyOf.io), 0);
  assert.match(
    anyOf.err.join("\n"),
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: its input schema and the door are not compared/,
  );
  // Any other status: warned with it, exit 0.
  const refused = await world(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  assert.equal(await up(["--yes"], refused.io), 0);
  assert.match(
    refused.err.join("\n"),
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: the door answered HTTP 401/,
  );
  // A page that is no Workflow detail (an ingress's HTML): not compared, never "strips".
  const page = await world(
    async () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  assert.equal(await up(["--yes"], page.io), 0);
  out = page.err.join("\n");
  assert.match(
    out,
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: the door's answer is not a Workflow detail \(no `input`\); not compared/,
  );
  assert.doesNotMatch(out, /strips it silently/);
  // A redirect is not followed, as the Effector follows none: warned with its status.
  const moved = await world(async () => new Response(null, { status: 302, headers: { location: "/login" } }));
  assert.equal(await up(["--yes"], moved.io), 0);
  assert.match(
    moved.err.join("\n"),
    /warning: dispatch "intake" at https:\/\/ops\.example\.com: the door redirected \(HTTP 302\); the Effector follows no redirect/,
  );
});
