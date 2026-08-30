// `j2 up` (ADR-0019): the one converging command. These tests drive the LAYER DECISIONS — ownership
// guardrails, operator never-downgrade, image staleness/delivery, Secret idempotence, preflights —
// through injected kube/build/confirm fakes; the real subprocess ports stay thin and are exercised
// by the @kind tier. Manifest shapes are asserted incidentally via what the fake kube captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxToken } from "@j2/orchestrator";
import { up } from "../src/commands/up.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";
import type { BuildPort, ObservedImage } from "../src/build.ts";
import type { Io } from "../src/output.ts";

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
  async apply(opts: { manifest: string }): Promise<void> {
    this.applied.push(opts.manifest);
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
  async waitRollout(opts: { deployment: string; namespace: string }): Promise<void> {
    this.rollouts.push(`${opts.namespace}/${opts.deployment}`);
  }
  /** Drift injection, per selector: the image that layer's pod carries when it must differ from
   * the applied one. Unset → an HONEST cluster, reporting a pod running whatever was last applied. */
  podImages: Record<string, string> = {};
  /** Live Sandbox CRs, as `j2 up`'s closing report reads them (ADR-0038: report, never re-image). */
  sandboxes: Array<{ metadata: { name: string; namespace?: string }; spec?: { image?: string } }> = [];
  /** `true` → listing Sandboxes throws, as it does when the CRD is absent or RBAC forbids it. */
  sandboxListFails = false;
  /** The sweep's roots (ADR-0039), read cluster-wide: the namespaces some instance owns, their
   * `j2-images` maps, and every pod in them. Empty by default — a cluster holding nothing but this
   * converge, which is what every test that is not about the sweep wants. */
  instanceNamespaces: Array<{ metadata: { name: string } }> = [];
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
    if (opts.kind === "namespace") return this.instanceNamespaces as T[];
    if (opts.kind === "configmap") return this.imageMaps as T[];
    // The cluster-wide pod read is the sweep's; the selected one is a layer's image verification.
    // Distinguished explicitly, because falling through to the verification branch would answer a
    // keep-set question with whatever the last apply happened to name.
    if (opts.kind === "pod" && opts.allNamespaces) return this.clusterPods as T[];
    if (opts.kind !== "pod") return [];
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
        if (i.kind !== "Deployment") continue;
        if (app && i.spec?.selector?.matchLabels?.app !== app) continue;
        return i.spec?.template?.spec?.containers?.[0]?.image;
      }
      // The operator install is YAML, not JSON — its image ref is substituted at apply time.
      const yaml = /^\s*image:\s*(\S+)\s*$/m.exec(manifest);
      if (!app && yaml) return yaml[1];
    }
    return undefined;
  }
  probes: string[] = [];
  probeCaPems: Array<string | undefined> = [];
  probeFails = false;
  async runOneShot(opts: { script: string; caPem?: string }): Promise<string> {
    this.probes.push(opts.script);
    this.probeCaPems.push(opts.caPem);
    if (this.probeFails) throw new Error("no tool_calls in the completion");
    return "PROVIDER OK";
  }
}

/** A build port that records instead of building. `files` is what `pnpm deploy` would have
 * materialized into the bundle — including, in the real thing, the kit's own sources under
 * `node_modules/.pnpm` (the resolved dependency, workspace-linked or registry-fetched alike).
 *
 * Every verb records distinguishably, because ADR-0038's layers differ in exactly HOW they build:
 * a kit image is `-f <committed Dockerfile>` against another context, the instance image is a
 * generated Dockerfile on stdin, and a Sandbox Image is its own directory and nothing else. The tag
 * alone is recorded on the `build ` line so the address stays extractable from it. */
function fakeBuild(
  record: string[],
  opts: {
    files?: Record<string, string>;
    /** What `docker inspect` says a Sandbox Image declares as its `USER` — `""` (the default) is
     * the interesting case: no USER, so the pod's uid-1000 fallback applies (ADR-0037). */
    imageUser?: string;
    /** What the two stores hold when the post-converge sweep looks (ADR-0039). Empty by default,
     * so a test that is not about the sweep sees one narrated line and no removals. */
    hostImages?: ObservedImage[];
    nodeImages?: ObservedImage[];
    /** `true` → the host listing throws, as it does with no docker daemon reachable. */
    sweepFails?: boolean;
  } = {},
): BuildPort {
  const files = opts.files ?? { "package.json": "{}" };
  return {
    bundle: async (_dir, out) => {
      record.push("bundle");
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(out, dirname(rel)), { recursive: true });
        await writeFile(join(out, rel), content);
      }
    },
    build: async ({ tag, context, dockerfile, dockerfileContent, labels }) => {
      record.push(`build ${tag}`);
      // The ownership stamp is recorded on its own line (ADR-0039): an unstamped build is an image
      // no sweep can ever collect, which is invisible in every other assertion here.
      record.push(`stamp ${tag} ${JSON.stringify(labels ?? null)}`);
      if (dockerfile) record.push(`build-with -f ${dockerfile} ctx ${context}`);
      else if (dockerfileContent) record.push(`build-with stdin ${tag}`);
      else record.push(`build-with context-default ${tag}`);
    },
    imageUser: async (image) => {
      record.push(`inspect-user ${image}`);
      return opts.imageUser ?? "";
    },
    push: async (tag) => void record.push(`push ${tag}`),
    kindLoad: async (tag, cluster) => void record.push(`kind-load ${tag} → ${cluster}`),
    hostImages: async () => {
      if (opts.sweepFails) throw new Error("Cannot connect to the Docker daemon");
      return opts.hostImages ?? [];
    },
    removeHostImage: async (ref) => void record.push(`rmi-host ${ref}`),
    nodeImages: async (cluster) => [{ node: `${cluster}-control-plane`, images: opts.nodeImages ?? [] }],
    removeNodeImage: async (_cluster, node, id) => void record.push(`rmi-node ${node} ${id}`),
  };
}

/** One image as a store reports it — j2-built and worth reclaiming unless the test says otherwise. */
function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

/** `agentModels` writes one `agents/<name>.ts` per entry — the definitions are what the provider
 * preflight probes now that there is no instance-wide model (ADR-0018). */
async function mkInstance(config: string, name = "myinst", agentModels?: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `j2-up-${name}-`));
  await writeFile(join(root, "j2.config.ts"), config);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: `inst-${name}`, version: "0.0.0" }));
  await mkdir(join(root, "workflows"), { recursive: true });
  if (agentModels) {
    await mkdir(join(root, "agents"), { recursive: true });
    for (const [agent, model] of Object.entries(agentModels)) {
      await writeFile(
        join(root, "agents", `${agent}.ts`),
        `export default { model: ${JSON.stringify(model)}, instructions: "i" };\n`,
      );
    }
  }
  return root;
}

/** Add a Sandbox Image to an instance (ADR-0037: `images/<name>/Dockerfile`, dirname = name). */
async function withImage(root: string, name: string, dockerfile = "FROM node:24-slim\n"): Promise<string> {
  await mkdir(join(root, "images", name), { recursive: true });
  await writeFile(join(root, "images", name, "Dockerfile"), dockerfile);
  return root;
}

/** A kit checkout as ADR-0038's detection sees one: BOTH markers, plus each image's hash sources. */
async function mkKit(): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "j2-kit-"));
  const files: Record<string, string> = {
    "deploy/harness/Dockerfile": "FROM node:24-slim\n",
    "deploy/adapter/Dockerfile": "FROM node:24-alpine\n",
    "operator/Dockerfile": "FROM golang:1.23\n",
    "packages/harness/package.json": `{"name":"@j2/harness"}`,
    "packages/adapter/package.json": `{"name":"@j2/adapter"}`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(kit, dirname(rel)), { recursive: true });
    await writeFile(join(kit, rel), content);
  }
  return kit;
}

type World = { io: Io; kube: FakeCluster; built: string[]; err: string[]; confirms: string[] };

function mkWorld(
  root: string,
  over: {
    confirm?: boolean;
    env?: Record<string, string>;
    bundleFiles?: Record<string, string>;
    /** A kit checkout root, when the world is meant to be one. Default: the instance folder, which
     * is NOT a checkout — so every test stays in installed-kit mode unless it says otherwise, and
     * none of them detect the real repo the suite happens to run inside. */
    kitDir?: string;
    imageUser?: string;
    hostImages?: ObservedImage[];
    nodeImages?: ObservedImage[];
    sweepFails?: boolean;
  } = {},
): World {
  const kube = new FakeCluster();
  const built: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const io: Io = {
    stdout: () => {},
    stderr: (s) => err.push(s),
    env: over.env ?? {},
    cwd: root,
    kitDir: over.kitDir ?? root,
    kubeAdmin: kube,
    build: fakeBuild(built, {
      files: over.bundleFiles,
      imageUser: over.imageUser,
      hostImages: over.hostImages,
      nodeImages: over.nodeImages,
      sweepFails: over.sweepFails,
    }),
    confirm: async (q) => {
      confirms.push(q);
      return over.confirm ?? true;
    },
  };
  return { io, kube, built, err, confirms };
}

/** The `j2-images` map this converge applied — the ConfigMap the Orchestrator reads per provision
 * and, byte-identical, the annotation the next converge diffs (ADR-0038). */
function imagesOf(w: World): Record<string, any> {
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "j2-images")!;
  return JSON.parse(cm.data["images.json"]);
}

test("up refuses a namespace labeled for another instance", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "other" } } });

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
  w.kube.set("j2-system", "deployment", "j2-controller-manager", {
    metadata: { name: "j2-controller-manager", labels: { "j2.dev/version": "99.0.0" } },
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
    w.kube.rollouts.includes("j2-system/j2-controller-manager"),
    `the operator rollout is waited for (got: ${w.kube.rollouts.join(", ")})`,
  );
  const operatorApply = w.kube.applied.find((m) => m.includes("controller-manager"))!;
  assert.match(operatorApply, new RegExp(`image: j2-operator:`));
  assert.ok(!operatorApply.includes("controller:latest"), "the placeholder image ref was substituted");

  const drifted = mkWorld(root);
  drifted.kube.podImages = { "control-plane=controller-manager": "j2-operator:ancient" };
  await assert.rejects(() => up(["--yes"], drifted.io), /operator.*j2-operator:ancient.*expected j2-operator:/s);
});

test("operator: manage:false skips the layer — and the image build with it", async () => {
  const kit = await mkKit();
  const skipRoot = await mkInstance(`export default { name: "a", operator: { manage: false } };\n`, "a");
  const w1 = mkWorld(skipRoot, { kitDir: kit });
  assert.equal(await up(["--yes"], w1.io), 0);
  assert.ok(!w1.kube.applied.some((m) => m.includes("controller-manager")));
  assert.ok(
    !w1.built.some((b) => b.startsWith("build j2-operator:")),
    `an image this converge does not deploy is not built (got: ${w1.built.join(", ")})`,
  );
  // …and it is not recorded either: a ref in the record with nothing built would make the NEXT
  // converge (with manage back on) skip a build the cluster needs.
  assert.equal(imagesOf(w1).operator, undefined);
});

// --- kit images (ADR-0038): built from source in a checkout, published when installed -----------

test("a kit checkout builds the Harness, Adapter, and operator; installed from npm builds none", async () => {
  const kit = await mkKit();
  const root = await mkInstance(`export default { name: "myinst" };\n`);

  const checkout = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], checkout.io), 0);
  assert.match(checkout.err.join("\n"), /kit checkout/, "the mode is narrated once, not inferred");
  for (const repo of ["j2-harness", "j2-adapter", "j2-operator"]) {
    const built = checkout.built.find((b) => b.startsWith(`build ${repo}:`))!;
    assert.ok(built, `${repo} is built (got: ${checkout.built.join(", ")})`);
    const ref = built.slice("build ".length);
    assert.match(ref, new RegExp(`^${repo}:[0-9a-f]{12}$`), "…at a content address, never a moving tag");
    // The SAME transport branch the instance image uses — one story, no per-layer drift.
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
    !installed.built.some((b) => /^build j2-(harness|adapter|operator):/.test(b)),
    `installed from npm, kit images are pulled, never built (got: ${installed.built.join(", ")})`,
  );
  // The published <kitversion> refs are what the map names, and what the Instance Harness runs.
  assert.equal(imagesOf(installed).harness, "j2-harness:0.0.0");
  assert.equal(imagesOf(installed).adapter, "j2-adapter:0.0.0");
});

test("a registry pushes every layer; a non-kind context without one fails BEFORE any build", async () => {
  const kit = await mkKit();
  const pushRoot = await mkInstance(`export default { name: "r", registry: "reg.example.com/j2" };\n`, "r");
  const w = mkWorld(pushRoot, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);
  for (const repo of ["j2-harness", "j2-adapter", "j2-operator", "j2-instance-r"]) {
    assert.ok(
      w.built.some((b) => b.startsWith(`push reg.example.com/j2/${repo}:`)),
      `${repo} is pushed (got: ${w.built.join(", ")})`,
    );
  }
  assert.ok(!w.built.some((b) => b.includes("kind-load")));

  const bareRoot = await mkInstance(`export default { name: "s" };\n`, "s");
  const w2 = mkWorld(bareRoot, { kitDir: kit });
  w2.kube.ctx = "gke-prod";
  await assert.rejects(() => up(["--yes"], w2.io), /not a kind cluster and no `registry`/);
  assert.deepEqual(w2.built, [], "a converge that can deliver nothing spends no docker discovering it");
});

test("the Deployment's image annotation makes a second converge spend zero docker; --force overrides it", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await mkInstance(`export default { name: "myinst", repos: [{ name: "app", url: "https://e.test/a.git" }] };\n`),
    "default",
  );

  const first = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], first.io), 0);
  const images = imagesOf(first);

  // The cluster now records what was converged — on the Deployment's OWN metadata, so re-resolving
  // a ref never rolls the Orchestrator and never restores a live run's snapshot (ADR-0038/0007).
  const list = first.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const deployment = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Deployment" && i.metadata.name === "j2-orchestrator",
  )!;
  assert.equal(deployment.metadata.annotations["j2.dev/images"], JSON.stringify(images, null, 2));
  assert.equal(
    deployment.spec.template.metadata.annotations,
    undefined,
    "never on the pod template — that would roll every run",
  );
  assert.ok(
    !JSON.stringify(deployment.spec.template.spec.containers[0].env).includes("IMAGE"),
    "and never as env: no J2_*_IMAGE anywhere",
  );

  const again = mkWorld(root, { kitDir: kit });
  again.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  again.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: {
      name: "j2-orchestrator",
      labels: { "j2.dev/content-hash": deployment.metadata.labels["j2.dev/content-hash"] },
      annotations: { "j2.dev/images": JSON.stringify(images, null, 2) },
    },
  });
  assert.equal(await up([], again.io), 0);
  assert.deepEqual(again.built, ["bundle"], "staged to hash, and nothing else was spent");
  assert.deepEqual(imagesOf(again), images, "…and the map re-converges to the same refs");

  const forced = mkWorld(root, { kitDir: kit });
  forced.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  forced.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: {
      name: "j2-orchestrator",
      labels: { "j2.dev/content-hash": deployment.metadata.labels["j2.dev/content-hash"] },
      annotations: { "j2.dev/images": JSON.stringify(images, null, 2) },
    },
  });
  assert.equal(await up(["--force"], forced.io), 0);
  for (const ref of [images.harness, images.adapter, images.operator, images.sandbox.default]) {
    assert.ok(forced.built.includes(`build ${ref}`), `--force rebuilds ${ref} (got: ${forced.built.join(", ")})`);
  }

  // A record that names the ref but NOT the seat it was proved in — what a kit predating ADR-0037's
  // uid-1000 fallback wrote — is incomplete, not fresh. Skipping on it would converge a map with no
  // `sandboxUser` entry, and a userless image would then be admitted as root and refused by the
  // Harness container's runAsNonRoot. So the image is re-proved and the fact re-read.
  const { sandboxUser: _dropped, ...partial } = images;
  const stale = mkWorld(root, { kitDir: kit });
  stale.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  stale.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: {
      name: "j2-orchestrator",
      labels: { "j2.dev/content-hash": deployment.metadata.labels["j2.dev/content-hash"] },
      annotations: { "j2.dev/images": JSON.stringify(partial, null, 2) },
    },
  });
  assert.equal(await up([], stale.io), 0);
  assert.ok(stale.built.includes(`inspect-user ${images.sandbox.default}`), "the seat is read again");
  assert.deepEqual(imagesOf(stale).sandboxUser, { default: "" }, "…and the record converges complete");
});

test("a silent record consults the host daemon: host-built refs skip their builds, never their delivery (ADR-0041)", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await mkInstance(`export default { name: "myinst", repos: [{ name: "app", url: "https://e.test/a.git" }] };\n`),
    "default",
  );
  const first = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], first.io), 0);
  const images = imagesOf(first);
  const instanceTag = first.built.find((b) => b.startsWith("build j2-instance-myinst:"))!.slice("build ".length);
  const refs = [images.harness, images.adapter, images.operator, images.sandbox.default, instanceTag] as string[];

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

// --- Sandbox Images (ADR-0037) -----------------------------------------------------------------

test("a Sandbox Image is ONE build of the user's Dockerfile, inspected, and only with repos to work on", async () => {
  const kit = await mkKit();
  const root = await withImage(
    await mkInstance(`export default { name: "myinst", repos: [{ name: "app", url: "https://e.test/a.git" }] };\n`),
    "default",
    "FROM node:24-slim\nRUN apt-get install -y cargo\n",
  );
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const ref = imagesOf(w).sandbox.default as string;
  assert.match(ref, /^j2-sandbox-myinst-default:[0-9a-f]{12}$/);
  // ONE build, of the user's own directory (ADR-0037). No `-base` intermediate exists any more:
  // that mutable shared name was the wrap's, and it serialized concurrent converges of one checkout.
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("build j2-sandbox-")),
    [`build ${ref}`],
  );
  assert.ok(!w.built.some((b) => b.includes("-base:")), `no intermediate tag anywhere (got: ${w.built.join(", ")})`);
  assert.ok(w.built.includes(`build-with context-default ${ref}`), "the user's Dockerfile, its directory the context");
  const stamp = JSON.stringify({ "j2.dev/kind": "sandbox", "j2.dev/instance": "myinst" });
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
  // applies uid 1000 + HOME=/home/j2 on an emptyDir.
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

  // No repos, no Sandbox Image build — said out loud, not skipped silently.
  const norepos = await withImage(await mkInstance(`export default { name: "n" };\n`, "n"), "default");
  const w2 = mkWorld(norepos, { kitDir: kit });
  assert.equal(await up(["--yes"], w2.io), 0);
  assert.ok(!w2.built.some((b) => b.includes("j2-sandbox-")));
  assert.ok(!w2.built.some((b) => b.startsWith("extract ")));
  assert.match(w2.err.join("\n"), /sandbox images: skipped \(no `repos`/);
  assert.deepEqual(imagesOf(w2).sandbox, {});
});

test("live workspaces on an older image are reported, and nothing re-images them", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", repos: [{ name: "app", url: "https://e.test/a.git" }] };\n`,
  );
  const w = mkWorld(root);
  w.kube.sandboxes = [
    { metadata: { name: "ws-1" }, spec: { image: "j2-sandbox-myinst-default:0ldc0ntent" } },
    { metadata: { name: "ws-2" }, spec: { image: "j2-sandbox-myinst-default:0ldc0ntent" } },
  ];
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /2 running workspace\(s\) keep `j2-sandbox-myinst-default:0ldc0ntent`/);
  assert.match(w.err.join("\n"), /delete those runs to re-image/);
  assert.ok(!w.kube.deleted.some((d) => d.includes("ws-")), "a running Workspace is never touched (ADR-0021)");

  // The CRD may not be installed at all: informational, so a failed look degrades to a warning.
  const noCrd = mkWorld(root);
  noCrd.kube.sandboxListFails = true;
  assert.equal(await up(["--yes"], noCrd.io), 0);
  assert.match(noCrd.err.join("\n"), /workspaces: could not be listed/);
});

test("image: fresh hash skips the build; stale hash builds and kind-loads (no registry, kind context)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const stale = mkWorld(root);
  assert.equal(await up(["--yes"], stale.io), 0);
  assert.ok(stale.built.some((b) => b.startsWith("build j2-instance-myinst:")));
  assert.ok(
    stale.built.some((b) => b.includes("kind-load") && b.includes("→ test")),
    `delivered by kind load onto the context's cluster (got: ${stale.built.join(", ")})`,
  );

  // Second run against a Deployment already stamped with the same hash: the whole layer skips.
  const tag = stale.built.find((b) => b.startsWith("build "))!.slice("build ".length);
  const hash = tag.split(":")[1]!;
  const fresh = mkWorld(root);
  fresh.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: { name: "j2-orchestrator", labels: { "j2.dev/content-hash": hash } },
  });
  fresh.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  assert.equal(await up([], fresh.io), 0);
  // The bundle is still staged — it is how the hash is computed at all — but the expensive half
  // (docker build + delivery) is what the staleness check buys.
  assert.deepEqual(fresh.built, ["bundle"], "staged to hash, but neither built nor loaded");

  // --force spends the build anyway, against the very same hash.
  const forced = mkWorld(root);
  forced.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: { name: "j2-orchestrator", labels: { "j2.dev/content-hash": hash } },
  });
  forced.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  assert.equal(await up(["--force"], forced.io), 0);
  assert.ok(forced.built.includes(`build ${tag}`), `--force rebuilds (got: ${forced.built.join(", ")})`);
});

test("the image tag addresses the BUNDLE — a kit change the instance folder never saw moves it", async () => {
  // The staleness defect: the hash walked the instance folder, so kit sources (a resolved
  // dependency, materialized into the bundle) were not inputs. Editing the orchestrator left the
  // tag unmoved → identical pod template → no rollout → `up` deployed nothing and said converged.
  // Hashing the bundle makes the tag a content address of what actually goes into the image,
  // identically in a workspace checkout and against a published kit.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const kitFile = "node_modules/.pnpm/@j2+orchestrator/node_modules/@j2/orchestrator/src/lease.ts";

  const tagWith = async (kit: string): Promise<string> => {
    const w = mkWorld(root, { bundleFiles: { "package.json": "{}", [kitFile]: kit } });
    assert.equal(await up(["--yes"], w.io), 0);
    return w.built.find((b) => b.startsWith("build "))!.slice("build ".length);
  };

  const before = await tagWith("export const renew = () => 1;\n");
  const after = await tagWith("export const renew = () => 2;\n");
  assert.notEqual(after, before, "a kit source edit must move the tag");
  assert.equal(await tagWith("export const renew = () => 1;\n"), before, "…and equal content must not");
});

test("image: a registry pushes instead of kind-loading; a non-kind context without one fails loudly", async () => {
  const pushRoot = await mkInstance(`export default { name: "p", registry: "reg.example.com/j2" };\n`, "p");
  const w = mkWorld(pushRoot);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(w.built.some((b) => b.startsWith("push reg.example.com/j2/j2-instance-p:")));
  assert.ok(!w.built.some((b) => b.includes("kind-load")));

  const bareRoot = await mkInstance(`export default { name: "q" };\n`, "q");
  const w2 = mkWorld(bareRoot);
  w2.kube.ctx = "gke-prod";
  await assert.rejects(() => up(["--yes"], w2.io), /not a kind cluster and no `registry`/);
});

test("secret: token + signing key persist across re-runs; harness.env literals materialize", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { env: [{ name: "API_KEY", value: "k123" }] } };\n`,
  );
  const w = mkWorld(root);
  w.kube.set("myinst", "secret", "j2-instance", {
    metadata: { name: "j2-instance" },
    data: { J2_INSTANCE_TOKEN: Buffer.from("tok-old").toString("base64") },
  });

  assert.equal(await up(["--yes"], w.io), 0);
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const instance = items.find((i) => i.kind === "Secret" && i.metadata.name === "j2-instance")!;
  assert.equal(instance.stringData.J2_INSTANCE_TOKEN, "tok-old", "an existing token is kept (Sandboxes hold it)");
  assert.ok(instance.stringData.J2_SIGNING_KEY, "a missing signing key is minted");
  // The Instance Harness Adapter's credential (ADR-0031): a sandbox-style token signed for the
  // placement's name — derived from the kept key, so re-runs converge to the same value.
  assert.equal(
    instance.stringData.J2_INSTANCE_HARNESS_TOKEN,
    sandboxToken(Buffer.from(instance.stringData.J2_SIGNING_KEY, "base64"), "j2-instance-harness"),
  );

  // The ADR-0013 boundary: harness env lands in its OWN Secret — the Harness container envFroms
  // j2-harness-env, and the Instance token/signing key must be unreachable from Agent code.
  const harnessEnv = items.find((i) => i.kind === "Secret" && i.metadata.name === "j2-harness-env")!;
  assert.ok(harnessEnv, "a separate j2-harness-env Secret is applied");
  assert.equal(harnessEnv.stringData.API_KEY, "k123", "config env values materialize there");
  assert.equal(instance.stringData.API_KEY, undefined, "…and not beside the Instance token");
  assert.equal(harnessEnv.stringData.J2_INSTANCE_TOKEN, undefined, "the token never rides the harness Secret");
});

test("provider apiKey rides the Secret (J2_PROVIDER_API_KEY), never the agents ConfigMap", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1", apiKey: "sk-secret", contextWindow: 131072, maxTokens: 32768, models: { "qwen-x": { contextWindow: 40960 } } } } };\n`,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const secret = items.find((i) => i.kind === "Secret" && i.metadata.name === "j2-harness-env")!;
  assert.equal(secret.stringData.J2_PROVIDER_API_KEY, "sk-secret");

  const cm = items.find((i) => i.kind === "ConfigMap")!;
  assert.ok(!cm.data["agents.json"].includes("sk-secret"), "the key never lands in a ConfigMap");
  assert.match(cm.data["agents.json"], /baseUrl/, "the rest of the provider config does ride the ConfigMap");
  // Token limits are model properties, not credentials — they DO ride the ConfigMap.
  const spec = JSON.parse(cm.data["agents.json"]) as { harness: { provider: Record<string, unknown> } };
  assert.equal(spec.harness.provider.contextWindow, 131072);
  assert.equal(spec.harness.provider.maxTokens, 32768);
  assert.deepEqual(spec.harness.provider.models, { "qwen-x": { contextWindow: 40960 } });
});

test("caBundle: the PEM rides a j2-ca ConfigMap and the provider preflight; a missing file fails loudly", async () => {
  const config =
    `export default { name: "myinst", harness: { caBundle: "ca.crt", ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.internal/v1" } } };\n`;
  const pem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

  const root = await mkInstance(config, "myinst", { coder: "vllm/qwen-x" });
  await writeFile(join(root, "ca.crt"), pem);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  // A ConfigMap, not a Secret — CA certs are public data (ADR-0020).
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "j2-ca")!;
  assert.equal(cm.data["ca.crt"], pem);
  // The preflight pod trusts the same bundle the Harness will — else it fails where pods succeed.
  assert.deepEqual(w.kube.probeCaPems, [pem]);

  const missing = mkWorld(await mkInstance(config, "missing"));
  await assert.rejects(() => up(["--yes"], missing.io), /caBundle.*relative to the instance folder/s);
});

test("no caBundle → no j2-ca ConfigMap", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  assert.ok(!items.some((i) => i.kind === "ConfigMap" && i.metadata.name === "j2-ca"));
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

  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const kinds = (JSON.parse(list) as { items: Array<{ kind: string }> }).items.map((i) => i.kind);
  for (const k of ["PersistentVolumeClaim", "ServiceAccount", "ConfigMap", "Secret", "Deployment", "Service"]) {
    assert.ok(kinds.includes(k), `applies a ${k}`);
  }
  assert.deepEqual(w.kube.rollouts, ["j2-system/j2-controller-manager", "myinst/j2-orchestrator"]);
});

test("converged is claimed only of a pod observed carrying the intended image", async () => {
  // The defect this closes: `up` reported convergence off the label it had just written, so a
  // Deployment whose pod template never moved (stale image, no rollout) still printed `converged`.
  // Convergence is now asserted against the running pod — observed state, not the CLI's own claim.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const drifted = mkWorld(root);
  drifted.kube.podImages = { "app=j2-orchestrator": "j2-instance-myinst:0ldc0ntent" };

  await assert.rejects(
    () => up(["--yes"], drifted.io),
    /running pod carries j2-instance-myinst:0ldc0ntent.*expected j2-instance-myinst:/s,
    "the drift is named in both directions, so the fix is obvious",
  );

  const honest = mkWorld(root);
  assert.equal(await up(["--yes"], honest.io), 0);
  assert.match(honest.err.join("\n"), /converged/);
});

test("provider preflight: every definition's model probed from inside the cluster; a failing probe fails the converge", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } } };\n`;
  // Two agents on the endpoint, one on another provider, and a repeat — the preflight probes the
  // DISTINCT vllm models and leaves the anthropic one alone.
  const agents = {
    coder: "vllm/qwen-x",
    reviewer: "vllm/qwen-small",
    scribe: "vllm/qwen-x",
    judge: "anthropic/claude-x",
  };

  const ok = mkWorld(await mkInstance(config, "myinst", agents));
  assert.equal(await up(["--yes"], ok.io), 0);
  assert.equal(ok.kube.probes.length, 2, "one probe per DISTINCT model this endpoint serves");
  assert.ok(
    ok.kube.probes.every((p) => /10\.0\.0\.5:8000/.test(p)),
    "the probes target the configured baseUrl",
  );
  const probed = ok.kube.probes.join("\n");
  assert.match(probed, /qwen-x/, "…with a definition's model (provider prefix stripped)");
  assert.match(probed, /qwen-small/, "…and the other one");
  assert.ok(!/claude-x/.test(probed), "a model on another provider is not this endpoint's business");
  assert.match(ok.kube.probes[0]!, /tool_calls/, "…and demands a tool-call completion (ADR-0019)");

  const bad = mkWorld(await mkInstance(config, "bad", agents));
  bad.kube.probeFails = true;
  await assert.rejects(() => up(["--yes"], bad.io), /provider.*enable-auto-tool-choice/s);
});

test("provider preflight: configured but no Agent names its models → skipped, not a silent pass", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } } };\n`;
  const w = mkWorld(await mkInstance(config, "myinst", { judge: "anthropic/claude-x" }));
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.kube.probes.length, 0);
  assert.match(w.err.join("\n"), /no Agent names a "vllm\/…" model/);
});

test("ssh repo urls with no j2-git-ssh Secret: offer a deploy key — accept creates it, decline bails", async () => {
  const config = `export default { name: "myinst", repos: [{ name: "app", url: "git@github.com:o/app" }] };\n`;

  const accept = mkWorld(await mkInstance(config));
  accept.io.confirm = async () => true;
  accept.io.sshKeygen = async () => ({ privateKey: "PRIV", publicKey: "ssh-ed25519 AAAA j2-git-ssh" });
  assert.equal(await up([], accept.io), 0);
  const secretApply = accept.kube.applied.find((m) => m.includes("j2-git-ssh"))!;
  assert.ok(secretApply, "the deploy-key Secret is applied");
  assert.match(secretApply, /PRIV/);
  assert.match(accept.err.join("\n"), /ssh-ed25519 AAAA/, "the PUBLIC key is printed for registration");

  const decline = mkWorld(await mkInstance(config, "decl"));
  decline.io.confirm = async (q) => !/deploy keypair/.test(q); // yes to first-contact, no to the key
  decline.io.sshKeygen = async () => assert.fail("declined — no key may be generated");
  await assert.rejects(() => up([], decline.io), /j2-git-ssh/);

  // An existing Secret means no offer at all.
  const has = mkWorld(await mkInstance(config, "has"));
  has.kube.set("myinst", "secret", "j2-git-ssh", { metadata: { name: "j2-git-ssh" } });
  has.io.sshKeygen = async () => assert.fail("Secret exists — no key may be generated");
  assert.equal(await up(["--yes"], has.io), 0);
});

// --- Instance Harness (ADR-0031): converged by convention, never by config -----------------------

/** One `workspace: "none"` definition beside a plain one — the static scan's trigger. */
async function withDecisioner(root: string): Promise<string> {
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents", "decisioner.ts"),
    `export default { model: "anthropic/claude-x", instructions: "pick", workspace: "none" };\n`,
  );
  await writeFile(
    join(root, "agents", "coder.ts"),
    `export default { model: "anthropic/claude-x", instructions: "code" };\n`,
  );
  return root;
}

function findInstanceHarness(w: World): { deployment?: Record<string, any>; service?: Record<string, any> } {
  for (const manifest of w.kube.applied) {
    if (!manifest.trimStart().startsWith("{")) continue;
    const doc = JSON.parse(manifest) as { kind?: string; items?: Array<Record<string, any>> };
    const items = doc.kind === "List" ? (doc.items ?? []) : [];
    const deployment = items.find((i) => i.kind === "Deployment" && i.metadata.name === "j2-instance-harness");
    const service = items.find((i) => i.kind === "Service" && i.metadata.name === "j2-instance-harness");
    if (deployment || service) return { deployment, service };
  }
  return {};
}

test('a workspace: "none" definition converges the Instance Harness — Harness + Adapter, minus the Workspace', async () => {
  const root = await withDecisioner(
    await mkInstance(`export default { name: "myinst", harness: { env: [{ name: "K", value: "v" }] } };\n`),
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const { deployment, service } = findInstanceHarness(w);
  assert.ok(deployment, "the Deployment is applied");
  assert.ok(service, "…with its Service");
  assert.ok(w.kube.rollouts.includes("myinst/j2-instance-harness"), "and the rollout is waited for");

  // The one Harness shape, minus the Workspace (ADR-0031): two containers, no /work, no user.
  const podSpec = deployment.spec.template.spec;
  assert.deepEqual(
    podSpec.containers.map((c: { name: string }) => c.name),
    ["harness", "adapter"],
  );
  assert.equal(podSpec.volumes, undefined, "no /work volume, no repos volume");

  // Same wiring a Sandbox's Harness container gets: the definitions ConfigMap + the env Secret.
  const harness = podSpec.containers[0];
  // This world is NOT a kit checkout (mkWorld's default kitDir is the instance folder), so the
  // resolved ref is the published one — the branch a real instance takes (ADR-0038).
  assert.equal(harness.image, "j2-harness:0.0.0", "the stock image at the kit version");
  assert.deepEqual(harness.env[0], {
    name: "J2_AGENTS_JSON",
    valueFrom: { configMapKeyRef: { name: "j2-agents", key: "agents.json" } },
  });
  assert.ok(
    harness.envFrom.some((e: { secretRef?: { name: string } }) => e.secretRef?.name === "j2-harness-env"),
    "the Harness envFroms its own Secret",
  );
  // The placement gate (ADR-0031): the mounted spec is the FULL agents.json, so the Harness
  // itself must refuse any non-Menu-only admission — no code execution in this pod is a claim
  // this env makes checkable.
  assert.ok(
    harness.env.some((e: { name: string; value?: string }) => e.name === "J2_MENU_ONLY" && e.value === "1"),
    "the Harness is told it is the Instance Harness",
  );

  // The Adapter's credential is the PLACEMENT's own signed token, not the Instance token: it may
  // deliver only for registrations recording the Instance Harness (tokens.ts, ADR-0013/0031).
  const adapter = podSpec.containers[1];
  assert.ok(
    adapter.env.some((e: { name: string; value?: string }) => /j2-orchestrator\.myinst\.svc/.test(e.value ?? "")),
  );
  const bearer = adapter.env.find((e: { name: string }) => e.name === "J2_SANDBOX_TOKEN");
  assert.deepEqual(bearer.valueFrom, { secretKeyRef: { name: "j2-instance", key: "J2_INSTANCE_HARNESS_TOKEN" } });
});

test("both readiness probes set a period — a ~1s boot must not be billed as a 10s rollout wait", async () => {
  const root = await withDecisioner(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find((m) => m.includes(`"j2-orchestrator"`) && m.includes(`"kind":"List"`))!;
  const orchestrator = (JSON.parse(list) as { items: Array<Record<string, any>> }).items.find(
    (i) => i.kind === "Deployment" && i.metadata.name === "j2-orchestrator",
  )!;
  const { deployment: harness } = findInstanceHarness(w);

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

test('no "none" definitions → nothing new deploys, and a stale Instance Harness is deleted on converge', async () => {
  // Agents exist, none of them Menu-only: the feature stays invisible (ADR-0031).
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", { coder: "anthropic/claude-x" });
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const { deployment, service } = findInstanceHarness(w);
  assert.equal(deployment, undefined);
  assert.equal(service, undefined);
  // Idempotent converge: a definition that dropped its "none" must not leave a stale Deployment.
  assert.ok(w.kube.deleted.includes("myinst/deployment/j2-instance-harness"));
  assert.ok(w.kube.deleted.includes("myinst/service/j2-instance-harness"));
});

test("the Instance Harness runs the refs THIS converge resolved — the same ones the map names", async () => {
  // There is no `images` block to override them with (ADR-0038): in a kit checkout the Instance
  // Harness runs the content-addressed images just built here, and nothing else can be pointed at.
  // The accepted asymmetry: this Deployment names its images in the pod template (it is SUPPOSED
  // to roll when they move), while a Sandbox's refs travel through the j2-images ConfigMap.
  const kit = await mkKit();
  const root = await withDecisioner(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const images = imagesOf(w);
  assert.match(images.harness, /^j2-harness:[0-9a-f]{12}$/);
  const { deployment } = findInstanceHarness(w);
  assert.equal(deployment!.spec.template.spec.containers[0].image, images.harness);
  assert.equal(deployment!.spec.template.spec.containers[1].image, images.adapter);
});

// --- the post-converge sweep (ADR-0039) ----------------------------------------------------------

test("every layer j2 builds is stamped with who owns it", async () => {
  // Ownership is a label, never a name (ADR-0039) — so an unstamped build is not a cosmetic miss,
  // it is an image no sweep can ever collect. The kit's three, the instance's own, and the two
  // Sandbox Image builds all pass through here.
  const kit = await mkKit();
  const root = await withImage(
    await mkInstance(`export default { name: "myinst", repos: [{ name: "app", url: "https://e.test/a.git" }] };\n`),
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
  for (const repo of ["j2-harness", "j2-adapter", "j2-operator"]) {
    const ref = [...stamps.keys()].find((r) => r.startsWith(`${repo}:`))!;
    assert.deepEqual(kind(ref), { "j2.dev/kind": "kit" }, `${repo} is stamped as the kit's`);
  }
  const instanceRef = [...stamps.keys()].find((r) => r.startsWith("j2-instance-myinst:"))!;
  assert.deepEqual(kind(instanceRef), { "j2.dev/kind": "instance", "j2.dev/instance": "myinst" });
  const sandboxRef = [...stamps.keys()].find((r) => r.startsWith("j2-sandbox-myinst-default:"))!;
  assert.deepEqual(kind(sandboxRef), { "j2.dev/kind": "sandbox", "j2.dev/instance": "myinst" });
});

test("a converge that succeeded sweeps the generation it replaced, and keeps what it just resolved", async () => {
  // The garbage this collects is made HERE: iterating while up leaves one full image per iteration,
  // and the moment this converge's map replaces the last one is the moment the old one stops being
  // reachable (ADR-0039).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const stale = image({ id: "sha256:old", tags: ["j2-instance-myinst:0ldc0ntent"], bytes: 2_100_000_000 });
  const foreign = image({ id: "sha256:pg", tags: ["postgres:16"], bytes: 500, labeled: false });
  const w = mkWorld(root, { hostImages: [stale, foreign] });
  assert.equal(await up(["--yes"], w.io), 0);

  const fresh = w.built.find((b) => b.startsWith("build j2-instance-myinst:"))!.slice("build ".length);
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("rmi-host ")),
    ["rmi-host j2-instance-myinst:0ldc0ntent"],
    `only the replaced generation goes — never ${fresh}, and never an image j2 did not build`,
  );
  assert.match(w.err.join("\n"), /swept 1 image\(s\) \(2\.1 GB\)/, "bytes, because disk is what the user feels");
});

test("the node sweep grants the map it replaced one generation of grace; the host gets none", async () => {
  // The `j2-images` ConfigMap reaches a Sandbox through a kubelet propagation window, so for one
  // more round a provision can still ask a NODE for a ref the new map no longer names. Nothing is
  // ever provisioned from the host daemon, so its copy goes immediately (ADR-0039).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const previous = { harness: "j2-harness:0ldharnes", adapter: "j2-adapter:0.0.0", sandbox: {} };
  const replaced = (id: string) => image({ id, tags: ["j2-harness:0ldharnes"], bytes: 10 });
  const w = mkWorld(root, { hostImages: [replaced("sha256:host")], nodeImages: [replaced("sha256:node")] });
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });
  w.kube.set("myinst", "deployment", "j2-orchestrator", {
    metadata: { name: "j2-orchestrator", annotations: { "j2.dev/images": JSON.stringify(previous) } },
  });

  assert.equal(await up([], w.io), 0);
  assert.ok(w.built.includes("rmi-host j2-harness:0ldharnes"), `the host copy goes (got: ${w.built.join(", ")})`);
  assert.ok(
    !w.built.some((b) => b.startsWith("rmi-node ")),
    "…while the node keeps it one more round, so the propagation window cannot lose a provision",
  );
});

test("a converge that failed sweeps nothing", async () => {
  // The sweep is the last act of a run that fully succeeded — annotation applied, rollouts
  // verified. A converge that threw has not moved the root set, so nothing it built is garbage.
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { hostImages: [image({ id: "sha256:old", tags: ["j2-instance-myinst:0ld"], bytes: 1 })] });
  w.kube.podImages = { "app=j2-orchestrator": "j2-instance-myinst:0ldc0ntent" };

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
      image({ id: "sha256:other", tags: ["j2-instance-other:c0ffee"], bytes: 10 }),
      image({ id: "sha256:kit", tags: ["j2-harness:0f1e2d3c4b5a"], bytes: 20 }),
      image({ id: "sha256:gone", tags: ["j2-harness:deadbeef1234"], bytes: 30 }),
    ],
  });
  w.kube.instanceNamespaces = [{ metadata: { name: "other" } }];
  w.kube.imageMaps = [
    {
      metadata: { name: "j2-images", namespace: "other" },
      data: {
        "images.json": JSON.stringify({
          harness: "j2-harness:0f1e2d3c4b5a",
          adapter: "j2-adapter:5a4b3c2d1e0f",
          sandbox: { default: "j2-sandbox-other-default:99aa88bb77cc" },
        }),
      },
    },
  ];
  w.kube.clusterPods = [
    { metadata: { name: "orch", namespace: "other" }, spec: { containers: [{ image: "j2-instance-other:c0ffee" }] } },
  ];

  assert.equal(await up(["--yes"], w.io), 0);
  assert.deepEqual(
    w.built.filter((b) => b.startsWith("rmi-host ")),
    ["rmi-host j2-harness:deadbeef1234"],
    "the kit generation nothing names goes; the one another instance's map names stays",
  );
});

test("re-running against the instance's own namespace converges silently (no prompt)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { confirm: false }); // any prompt would fail the run
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });

  assert.equal(await up([], w.io), 0);
  assert.equal(w.confirms.length, 0, "it's home — no prompt");
});
