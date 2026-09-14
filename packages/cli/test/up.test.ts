// `j2 up` (ADR-0019): the one converging command. These tests drive the LAYER DECISIONS — ownership
// guardrails, operator never-downgrade, image staleness/delivery, Secret idempotence, preflights —
// through injected kube/build/confirm fakes; the real subprocess ports stay thin and are exercised
// by the @kind tier. Manifest shapes are asserted incidentally via what the fake kube captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  /** Rollouts scripted to time out, keyed `"<namespace>/<name>"` — what `kubectl rollout status`
   * does when a pod never comes up, and the only thing it says about it (ADR-0046). */
  rolloutFails = new Set<string>();
  /** Every rollout waited on, as `<namespace>/<name>` — a DaemonSet's prefixed `daemonset/`, so a
   * test can tell the cache agent's wait from a Deployment's of the same name. */
  async waitRollout(opts: { kind?: string; name: string; namespace: string }): Promise<void> {
    const kind = opts.kind === "daemonset" ? "daemonset/" : "";
    this.rollouts.push(`${opts.namespace}/${kind}${opts.name}`);
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
  /** Live Sandbox CRs, as `j2 up`'s closing report reads them (ADR-0038: report, never re-image). */
  sandboxes: Array<{ metadata: { name: string; namespace?: string }; spec?: { image?: string } }> = [];
  /** `true` → listing Sandboxes throws, as it does when the CRD is absent or RBAC forbids it. */
  sandboxListFails = false;
  /** The sweep's roots (ADR-0039), read cluster-wide: the namespaces some instance owns, their
   * `j2-images` maps, and every pod in them. Empty by default — a cluster holding nothing but this
   * converge, which is what every test that is not about the sweep wants. */
  instanceNamespaces: Array<{ metadata: { name: string } }> = [];
  /** The cluster's nodes, as ADR-0045's platform derivation reads them: one schedulable amd64 node,
   * the everyday single-arch cluster, so every test that is not about platforms builds `-amd64`. */
  nodes: Array<{
    metadata: { name: string; labels?: Record<string, string> };
    spec?: { unschedulable?: boolean; taints?: Array<{ key: string; value?: string; effect: string }> };
    status?: { nodeInfo?: { architecture?: string } };
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
    if (opts.kind === "node") return this.nodes as T[];
    if (opts.kind === "namespace") return this.instanceNamespaces as T[];
    if (opts.kind === "configmap") return this.imageMaps as T[];
    // The cluster-wide pod read is the sweep's; the selected one is a layer's image verification.
    // Distinguished explicitly, because falling through to the verification branch would answer a
    // keep-set question with whatever the last apply happened to name.
    if (opts.kind === "pod" && opts.allNamespaces) return this.clusterPods as T[];
    if (opts.kind === "event") return this.events as T[];
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
    /** What the host can build for (ADR-0045's binfmt preflight). Both supported platforms by
     * default — an emulation-equipped host, so a test that is not about the preflight never trips
     * over it. */
    buildable?: string[];
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
    build: async ({ tag, platforms, context, dockerfile, dockerfileContent, labels }) => {
      record.push(`build ${tag}`);
      // Explicit on every build (ADR-0045), recorded on its own line so the platform set stays
      // assertable without disturbing the tag-shaped assertions above it.
      record.push(`platform ${tag} ${platforms.join(",")}`);
      // The ownership stamp is recorded on its own line (ADR-0039): an unstamped build is an image
      // no sweep can ever collect, which is invisible in every other assertion here.
      record.push(`stamp ${tag} ${JSON.stringify(labels ?? null)}`);
      if (dockerfile) record.push(`build-with -f ${dockerfile} ctx ${context}`);
      else if (dockerfileContent) record.push(`build-with stdin ${tag}`);
      else record.push(`build-with context-default ${tag}`);
    },
    imageUser: async (image, platforms) => {
      // The verb follows the artifact (ADR-0045): a singleton build is on this daemon, a manifest
      // list is in the registry buildx pushed it to — two reads, recorded as two lines.
      record.push(`${platforms.length > 1 ? "imagetools" : "inspect-user"} ${image}`);
      return opts.imageUser ?? "";
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

/** One image as a store reports it — j2-built and worth reclaiming unless the test says otherwise. */
function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

/** This checkout's root, for the few tests that read artifacts other packages own. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The kit's own package by ABSOLUTE path. A fixture instance lives in the OS temp dir, where a
 * bare `@j2/orchestrator` resolves to nothing — and these workflows must be the real thing, since
 * `j2 up` now LOADS them and walks the Machines for the Agents they carry (ADR-0049). Node caches
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
  const root = await mkdtemp(join(tmpdir(), `j2-up-${name}-`));
  await writeFile(join(root, "j2.config.ts"), config);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: `inst-${name}`, version: "0.0.0" }));
  await mkdir(join(root, "workflows"), { recursive: true });
  if (agents) {
    const slots = Object.entries(agents)
      .map(([slot, def]) => `${slot}: agent({ ...${JSON.stringify(def)}, instructions: "i" })`)
      .join(", ");
    await writeFile(
      join(root, "workflows", "work.ts"),
      `import { agent, j2Setup } from ${JSON.stringify(KIT_SRC)};\n` +
        `export const machine = j2Setup({ events: [], actors: { ${slots} } })\n` +
        `  .createMachine({ id: "work", initial: "idle", states: { idle: {} } });\n`,
    );
  }
  return root;
}

/** Scaffold the Instance's `images/default` — ADR-0037's fallback leg, and since ADR-0049/0050 the
 * ONE path `j2 up` still checks by convention rather than by walking a Machine. */
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
    `import { j2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = j2Setup({ events: [] })\n` +
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
 * (ADR-0051). This is the data-plane switch as `j2 up` reads it: nothing in `j2.config.ts` says
 * "this instance has Workspaces" any more; the walk does. The url is what the ssh layer sees. */
async function withWorkspace(root: string, url = "https://e.test/a.git"): Promise<string> {
  await writeFile(
    join(root, "workflows", "ws.ts"),
    `import { j2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = j2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: ${JSON.stringify(url)} }, spec: () => ({ branch: "b" }) });\n`,
  );
  return root;
}

/** A packaged `workspace()` whose one Repo Slot is left OPEN, registered as-is — what `j2 up`
 * refuses, naming the `customize` line that binds it (ADR-0051). `under` composes it one level
 * down instead: invoked from an author Machine's `review` slot, the shape a packaged Machine
 * actually arrives in. */
async function withOpenSlot(root: string, under?: "child"): Promise<string> {
  const packaged = `workspace(body, { repos: { target: open }, spec: () => ({ branch: "b" }) })`;
  await writeFile(
    join(root, "workflows", "packaged.ts"),
    `import { j2Setup, open, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = j2Setup({ events: [] })\n` +
      `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      (under === "child"
        ? `export const machine = j2Setup({ events: [], actors: { review: ${packaged} } })\n` +
          `  .createMachine({ id: "host", initial: "reviewing", states: { reviewing: { invoke: { src: "review" } } } });\n`
        : `export const machine = ${packaged};\n`),
  );
  return root;
}

/** A kit checkout as ADR-0038's detection sees one: BOTH markers, plus each image's hash sources. */
async function mkKit(): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "j2-kit-"));
  const files: Record<string, string> = {
    "deploy/harness/Dockerfile": "FROM node:24-slim\n",
    "deploy/adapter/Dockerfile": "FROM node:24-alpine\n",
    "operator/Dockerfile": "FROM golang:1.23\n",
    // The Harness image builds `j2-upload-pack` out of the operator module too (ADR-0053).
    "operator/go.mod": "module github.com/snapwich/j2/operator\n",
    "operator/go.sum": "",
    "operator/cmd/j2-upload-pack/main.go": "package main\n",
    "operator/internal/uploadpack/uploadpack.go": "package uploadpack\n",
    "packages/harness/package.json": `{"name":"@j2/harness"}`,
    "packages/adapter/package.json": `{"name":"@j2/adapter"}`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(kit, dirname(rel)), { recursive: true });
    await writeFile(join(kit, rel), content);
  }
  return kit;
}

type World = { io: Io; kube: FakeCluster; built: string[]; err: string[]; confirms: string[]; choices: string[][] };

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
    /** What the Instance typecheck says (ADR-0050). Default: it passes. */
    typecheck?: Io["typecheck"];
    hostImages?: ObservedImage[];
    nodeImages?: ObservedImage[];
    sweepFails?: boolean;
    buildable?: string[];
  } = {},
): World {
  const kube = new FakeCluster();
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
    typecheck: over.typecheck ?? TYPECHECK_OK,
    build: fakeBuild(built, {
      files: over.bundleFiles,
      imageUser: over.imageUser,
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
  return { io, kube, built, err, confirms, choices };
}

/** The `j2-images` map this converge applied — the ConfigMap the Orchestrator reads per provision
 * and, byte-identical, the annotation the next converge diffs (ADR-0038). */
function imagesOf(w: World): Record<string, any> {
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "j2-images")!;
  return JSON.parse(cm.data["images.json"]);
}

test("the typecheck gate: a folder that does not compile converges nothing (ADR-0050)", async () => {
  // The FIRST layer, and a refusal rather than a warning: since ADR-0049 a Machine's Agent slots and
  // its composed Machines are typed, so a wrong name is a compile error here instead of an
  // invoke-time failure mid-run — but only if nothing is spent before the compiler answers. Repo
  // Slots are typed here too (ADR-0051), so a `customize()` of one the Machine never declared stops
  // here; what the gate itself claims is only that `j2 up` runs the compiler and refuses on its answer.
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
  assert.match(operatorApply, new RegExp(`image: ghcr.io/snapwich/j2-operator:`));
  assert.ok(!operatorApply.includes("controller:latest"), "the placeholder image ref was substituted");

  const drifted = mkWorld(root);
  drifted.kube.podImages = { "control-plane=controller-manager": "j2-operator:ancient" };
  await assert.rejects(
    () => up(["--yes"], drifted.io),
    /operator.*j2-operator:ancient.*expected ghcr\.io\/snapwich\/j2-operator:/s,
  );
});

test("a rollout that times out carries the pods' evidence, not just kubectl's verdict", async () => {
  // The failure that produced ADR-0045 surfaced as `timed out waiting for the condition` and
  // nothing else; the cause was found by hand with `kubectl get pods` + `kubectl logs`. Every
  // rollout wait now does that reading itself (ADR-0046).
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root);
  w.kube.rolloutFails.add("myinst/j2-orchestrator");
  w.kube.set("", "node", "kind-worker", { status: { nodeInfo: { architecture: "arm64" } } });
  w.kube.failedPods["app=j2-orchestrator"] = [
    {
      metadata: { name: "j2-orchestrator-77d-abc" },
      spec: { nodeName: "kind-worker", containers: [{ name: "orchestrator", image: "j2-instance-myinst:abc-amd64" }] },
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
      assert.match(err.message, /j2-orchestrator: rollout did not complete in namespace myinst/);
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
    assert.match(
      ref,
      new RegExp(`^${repo}:[0-9a-f]{12}-amd64$`),
      "…at a content address of (inputs × platform), never a moving tag",
    );
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
  // The published <kitversion> refs are what the map names, and what the Instance Harness runs —
  // at the canonical home, because a bare tag is `docker.io/library/` and nothing is there
  // (ADR-0044).
  assert.equal(imagesOf(installed).harness, "ghcr.io/snapwich/j2-harness:0.0.0");
  assert.equal(imagesOf(installed).adapter, "ghcr.io/snapwich/j2-adapter:0.0.0");
});

test("installed, kitRegistry re-homes every deployed Kit ref; absent, they come from the home (ADR-0044)", async () => {
  // The self-hosted / air-gapped cluster: the mirror was seeded deliberately (`j2 kit push`), and
  // the converge's only job is to NAME it — nothing is pushed or built here, since installed mode
  // has no Kit sources at all.
  const mirrored = await mkInstance(`export default { name: "m", kitRegistry: "zot.example.test" };\n`, "m");
  const w = mkWorld(mirrored);
  assert.equal(await up(["--yes"], w.io), 0);
  const images = imagesOf(w);
  assert.equal(images.harness, "zot.example.test/j2-harness:0.0.0");
  assert.equal(images.adapter, "zot.example.test/j2-adapter:0.0.0");
  assert.equal(images.operator, "zot.example.test/j2-operator:0.0.0");
  assert.match(w.err.join("\n"), /zot\.example\.test/, "the mirror is narrated, never silently used");
  assert.ok(
    !w.built.some((b) => /^(build|push) (zot|ghcr)/.test(b)),
    `a published Kit image is pulled, never built or mirrored by a converge (got: ${w.built.join(", ")})`,
  );
  // `registry` answers a different question — where THIS converge's builds go (ADR-0044) — so it
  // must not re-home the published three, and `kitRegistry` must not re-home the instance image.
  const both = await mkInstance(
    `export default { name: "b", registry: "reg.example.com/j2", kitRegistry: "zot.example.test" };\n`,
    "b",
  );
  const w2 = mkWorld(both);
  assert.equal(await up(["--yes"], w2.io), 0);
  assert.equal(imagesOf(w2).harness, "zot.example.test/j2-harness:0.0.0");
  assert.ok(
    w2.built.some((b) => b.startsWith("push reg.example.com/j2/j2-instance-b:")),
    `the instance image still goes to registry (got: ${w2.built.join(", ")})`,
  );

  const home = mkWorld(await mkInstance(`export default { name: "h" };\n`, "h"));
  assert.equal(await up(["--yes"], home.io), 0);
  assert.equal(imagesOf(home).harness, "ghcr.io/snapwich/j2-harness:0.0.0");
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
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
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
    await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`)),
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
  // Reported and skipped, never built for: no Kit image could sit beside an s390x instance image in
  // the pod, so building one would be dead weight discovered at provision.
  assert.match(mixed.err.join("\n"), /skipping node arch s390x/);
  assert.ok(
    mixed.built.filter((b) => b.startsWith("platform ")).every((b) => b.endsWith("linux/amd64")),
    `nothing was built for the unsupported arch (got: ${mixed.built.join(", ")})`,
  );

  const nowhere = mkWorld(root);
  nowhere.kube.nodes = [{ metadata: { name: "z" }, status: { nodeInfo: { architecture: "s390x" } } }];
  await assert.rejects(() => up(["--yes"], nowhere.io), /s390x[\s\S]*`platforms`/);
  assert.deepEqual(nowhere.built, [], "and nothing was spent finding out");
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

test("a `file:` context the Machine carries is built and keyed by its content DIGEST (ADR-0049)", async () => {
  // The walk is what makes this image exist at all: nothing scans a folder, so a context is found
  // only because a registered Machine names it. The map key is the digest — not a dirname, not a
  // path — which is exactly what lets the baked Orchestrator resolve the same `file:` URL from its
  // own node_modules without either side holding a table.
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
  assert.match(sandbox[digest]!, new RegExp(`^j2-sandbox-myinst-toolchain:${digest}-`));
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
    `import { j2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = j2Setup({ events: [] })\n` +
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
  assert.ok(!w.built.some((b) => b.includes("j2-sandbox-")), `nothing was built for it (got: ${w.built.join(", ")})`);
  assert.match(w.err.join("\n"), /sandbox images: none carried/);
});

test("a mixed-arch node set is built once by buildx, which delivers by pushing", async () => {
  // ADR-0045's non-singleton case: build for both rather than guess which node a pod lands on.
  // `docker buildx build --push` IS the delivery — a manifest list cannot live in the daemon and
  // `kind load` cannot carry one — so nothing may push it a second time.
  const root = await withImage(
    await withWorkspace(await mkInstance(`export default { name: "m", registry: "reg.example.com/j2" };\n`, "m")),
    "default",
  );
  const w = mkWorld(root);
  w.kube.nodes = [
    { metadata: { name: "a" }, status: { nodeInfo: { architecture: "amd64" } } },
    { metadata: { name: "b" }, status: { nodeInfo: { architecture: "arm64" } } },
  ];
  assert.equal(await up(["--yes"], w.io), 0);

  const sandboxRef = imagesOf(w).sandbox.default as string;
  assert.match(sandboxRef, /^reg\.example\.com\/j2\/j2-sandbox-m-default:[0-9a-f]{12}-amd64-arm64$/);
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
  assert.deepEqual(w.built, []);
});

test("a foreign-arch build is preflighted for binfmt — once, before any build is spent", async () => {
  // Without qemu the foreign `RUN` step dies minutes in with `exec format error`, the same symptom
  // ADR-0045 exists to delete. So emulation is proved first, and the error is a command to run.
  const root = await mkInstance(`export default { name: "f", platforms: ["linux/arm64"] };\n`, "f");
  const w = mkWorld(root, { buildable: ["linux/amd64"] });
  await assert.rejects(() => up(["--yes"], w.io), /tonistiigi\/binfmt --install arm64/);
  assert.ok(!w.built.some((b) => b.startsWith("build ")), `no build was spent (got: ${w.built.join(", ")})`);

  // Paid once, and only when a build is really about to happen: a steady-state converge still
  // spends no docker at all (the annotation test asserts the whole record is `["bundle"]`).
  const ok = mkWorld(root);
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
  assert.match(ref, /^j2-sandbox-myinst-default:[0-9a-f]{12}-amd64$/);
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

  // No Machine composing a Sandbox, no Sandbox Image build — said out loud, not skipped silently
  // (ADR-0051: the switch is the walk, not a config key).
  const nosandbox = await withImage(await mkInstance(`export default { name: "n" };\n`, "n"), "default");
  const w2 = mkWorld(nosandbox, { kitDir: kit });
  assert.equal(await up(["--yes"], w2.io), 0);
  assert.ok(!w2.built.some((b) => b.includes("j2-sandbox-")));
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

test("a bound Repo is narrated as the boot's to create; the token env vars git.credentials names ride the Secret", async () => {
  // `j2 up` clones nothing (ADR-0051): the Orchestrator creates a Repo resource per bound identity
  // at boot and the cache agent clones on first need, on the node that needs it. What the
  // converge does hold is the credential: every env var an entry names, when set, lands in the
  // Orchestrator's Secret — and nothing an entry does not name.
  const root = await withWorkspace(
    await mkInstance(
      `export default { name: "myinst", git: { credentials: [` +
        `{ match: "github.com/acme/", token: "GH_TOKEN" }, { match: "*", token: "J2_GIT_TOKEN" }, { match: "gitlab.com/", token: "GL_TOKEN" }` +
        `] } };\n`,
    ),
  );
  const w = mkWorld(root, { env: { GH_TOKEN: "gh-secret", J2_GIT_TOKEN: "wild-secret", STRAY: "no" } });
  assert.equal(await up(["--yes"], w.io), 0);
  assert.match(w.err.join("\n"), /repos: 1 bound Repo\(s\) — the Orchestrator creates their Repo resources at boot/);
  assert.match(w.err.join("\n"), /cache agent clones on first need/);

  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const instance = items.find((i) => i.kind === "Secret" && i.metadata.name === "j2-instance")!;
  assert.equal(instance.stringData.GH_TOKEN, "gh-secret");
  assert.equal(instance.stringData.J2_GIT_TOKEN, "wild-secret");
  assert.ok(!("GL_TOKEN" in instance.stringData), "an unset var materializes nothing");
  assert.ok(!("STRAY" in instance.stringData), "and an env var no entry names never enters the Secret");
  // The Orchestrator neither clones nor holds a key: its one claim is its state, its mounts are
  // state and the image map, and its env is its namespace and content hash — the credential
  // rides the Secret above and is read only by the cache agent.
  assert.deepEqual(
    items.filter((i) => i.kind === "PersistentVolumeClaim").map((i) => i.metadata.name),
    ["j2-state"],
  );
  const orch = items.find((i) => i.kind === "Deployment" && i.metadata.name === "j2-orchestrator")!;
  const podSpec = orch.spec.template.spec;
  assert.deepEqual(
    podSpec.volumes.map((v: { name: string }) => v.name),
    ["state", "images"],
  );
  assert.deepEqual(
    podSpec.containers[0].env.map((e: { name: string }) => e.name),
    ["J2_NAMESPACE", "J2_CONTENT_HASH"],
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
      if (i.metadata?.name === "j2-repo-cache") out[i.kind] = i;
    }
  }
  return out;
}

test("a Machine composing a Sandbox converges the cache agent: one root-seated pod per node over the node's cache directory", async () => {
  // The data plane's node half (ADR-0051, ADR-0004): a DaemonSet running the operator image as
  // `/manager repo-cache`, the one writer of `/var/lib/j2/<namespace>/repos` on its node — the
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
  assert.equal(ds.spec.selector.matchLabels.app, "j2-repo-cache");
  assert.equal(ds.metadata.labels["j2.dev/instance"], "myinst", "owned like every other object");

  // The same binary as the operator, at the ref THIS converge resolved (installed here, so the
  // published one at the kit version), dispatched into its second entrypoint.
  const agent = podSpec.containers[0];
  assert.equal(agent.name, "agent");
  assert.equal(agent.image, imagesOf(w).operator, "the record and the pod name one operator ref");
  assert.match(agent.image, /^ghcr\.io\/snapwich\/j2-operator:/);
  assert.deepEqual(agent.command, ["/manager", "repo-cache"]);

  // The node directory, created by the kubelet, mounted where `--cache-dir` defaults.
  const cache = podSpec.volumes.find((v: { name: string }) => v.name === "cache");
  assert.deepEqual(cache.hostPath, { path: "/var/lib/j2/myinst/repos", type: "DirectoryOrCreate" });
  assert.equal(agent.volumeMounts.find((m: { name: string }) => m.name === "cache").mountPath, "/cache");
  // The seat is root — the kubelet creates that directory root-owned — and nothing else is loose:
  // no capabilities, no escalation, a read-only root with $HOME and /tmp on emptyDirs.
  assert.equal(agent.securityContext.runAsUser, 0);
  assert.equal(agent.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(agent.securityContext.capabilities, { drop: ["ALL"] });
  assert.equal(agent.securityContext.readOnlyRootFilesystem, true);
  assert.ok(agent.env.some((e: { name: string; value?: string }) => e.name === "HOME" && e.value === "/home/j2"));
  assert.ok(podSpec.volumes.some((v: { name: string; emptyDir?: unknown }) => v.name === "home" && v.emptyDir));
  assert.ok(podSpec.volumes.some((v: { name: string; emptyDir?: unknown }) => v.name === "tmp" && v.emptyDir));
  // Which node it writes for, and whose Repos it watches, come off the downward API.
  const env = Object.fromEntries(agent.env.map((e: { name: string }) => [e.name, e]));
  assert.deepEqual(env.NODE_NAME.valueFrom, { fieldRef: { fieldPath: "spec.nodeName" } });
  assert.deepEqual(env.J2_NAMESPACE.valueFrom, { fieldRef: { fieldPath: "metadata.namespace" } });
  // Exactly the Sandbox nodes (ADR-0052): no placement configured, so no tolerations and no
  // selector — the agent lands where an ordinary pod lands, which is where a Sandbox lands.
  assert.equal(podSpec.tolerations, undefined);
  assert.equal(podSpec.nodeSelector, undefined);
  assert.match(w.err.join("\n"), /^sandbox nodes: kind-test-control-plane$/m);
  // It is an API client (its own status entry, the Repos, the pods on its node that mount a
  // cache, the credential Secret a Repo names) — read-mostly, and never a creator or deleter of
  // anything.
  assert.equal(podSpec.serviceAccountName, "j2-repo-cache");
  assert.equal(podSpec.automountServiceAccountToken, true);
  assert.deepEqual(objects.Role!.rules, [
    { apiGroups: ["core.j2.dev"], resources: ["repos"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["core.j2.dev"], resources: ["repos/status"], verbs: ["get", "patch", "update"] },
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
  assert.ok(w.kube.rollouts.includes("myinst/daemonset/j2-repo-cache"), `got: ${w.kube.rollouts.join(", ")}`);
  assert.match(w.err.join("\n"), /repo cache: verified — 1 pod\(s\) running ghcr\.io\/snapwich\/j2-operator:/);
  assert.ok(!w.kube.deleted.some((d) => d.includes("j2-repo-cache")), "nothing of its own is deleted");
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
  assert.match(err, /set `sandbox: \{ nodeSelector, tolerations \}` in j2.config.ts/);
  assert.ok(findRepoCache(s).DaemonSet, "the data plane converges regardless");
  assert.deepEqual(findRepoCache(s).DaemonSet!.spec.template.spec.nodeSelector, { pool: "agents" });
});

test("the Orchestrator's Role reaches the Repo resources it creates", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const role = items.find((i) => i.kind === "Role" && i.metadata.name === "j2-orchestrator")!;
  const crds = role.rules.find((r: { apiGroups: string[] }) => r.apiGroups.includes("core.j2.dev"));
  assert.ok(
    crds.resources.includes("repos"),
    `the Orchestrator creates, labels, and lists Repos (got: ${crds.resources})`,
  );
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
    assert.ok(w.kube.deleted.includes(`myinst/${kind}/j2-repo-cache`), `stale ${kind} deleted`);
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
  const built = w.built.find((b) => b.startsWith("build j2-operator:"));
  assert.ok(built, `the operator image is built for the cache agent (got: ${w.built.join(", ")})`);
  const ref = built.slice("build ".length);
  assert.equal(imagesOf(w).operator, ref, "…and recorded, so the next converge can skip the build");
  assert.equal(findRepoCache(w).DaemonSet!.spec.template.spec.containers[0].image, ref);
});

test("live workspaces on an older image are reported, and nothing re-images them", async () => {
  const root = await withWorkspace(await mkInstance(`export default { name: "myinst" };\n`));
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

test("provider apiKey rides the Secret (J2_PROVIDER_API_KEY), never the harness ConfigMap", async () => {
  const root = await mkInstance(
    `export default { name: "myinst", harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1", apiKey: "sk-secret", contextWindow: 131072, maxTokens: 32768, models: { "qwen-x": { contextWindow: 40960 } } } } };\n`,
  );
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);

  const list = w.kube.applied.find((m) => m.includes(`"kind":"List"`))!;
  const items = (JSON.parse(list) as { items: Array<Record<string, any>> }).items;
  const secret = items.find((i) => i.kind === "Secret" && i.metadata.name === "j2-harness-env")!;
  assert.equal(secret.stringData.J2_PROVIDER_API_KEY, "sk-secret");

  const cm = items.find((i) => i.kind === "ConfigMap" && i.metadata.name === "j2-harness")!;
  assert.ok(!cm.data["harness.json"].includes("sk-secret"), "the key never lands in a ConfigMap");
  assert.match(cm.data["harness.json"], /baseUrl/, "the rest of the provider config does ride the ConfigMap");
  // Token limits are model properties, not credentials — they DO ride the ConfigMap.
  const spec = JSON.parse(cm.data["harness.json"]) as { provider: Record<string, unknown>; agents?: unknown };
  assert.equal(spec.provider.contextWindow, 131072);
  assert.equal(spec.provider.maxTokens, 32768);
  assert.deepEqual(spec.provider.models, { "qwen-x": { contextWindow: 40960 } });
  // What this ConfigMap is NOT any more (ADR-0049): a roster. The definition rides each Turn, so
  // deployment facts are all that is left to mount.
  assert.equal(spec.agents, undefined, "no Agent roster rides the deployment");
});

test("caBundle: the PEM rides a j2-ca ConfigMap and the provider preflight; a missing file fails loudly", async () => {
  const config =
    `export default { name: "myinst", harness: { caBundle: "ca.crt", ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.internal/v1" } } };\n`;
  const pem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

  const root = await mkInstance(config, "myinst", { coder: { model: "vllm/qwen-x" } });
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
  // Four slots on ONE Machine — two on the endpoint, one repeat, one on another provider. The
  // preflight probes the DISTINCT vllm models and leaves the anthropic one alone.
  const agents: Record<string, FixtureAgent> = {
    coder: { model: "vllm/qwen-x" },
    reviewer: { model: "vllm/qwen-small" },
    scribe: { model: "vllm/qwen-x" },
    judge: { model: "anthropic/claude-x" },
  };

  const ok = mkWorld(await mkInstance(config, "myinst", agents));
  assert.equal(await up(["--yes"], ok.io), 0);
  assert.equal(ok.kube.probes.length, 2, "one probe per DISTINCT model this endpoint serves");
  assert.ok(
    ok.kube.probes.every((p) => /10\.0\.0\.5:8000/.test(p)),
    "the probes target the configured baseUrl",
  );
  const probed = ok.kube.probes.join("\n");
  assert.match(probed, /qwen-x/, "…with a carried definition's model (provider prefix stripped)");
  assert.match(probed, /qwen-small/, "…and the other one");
  assert.ok(!/claude-x/.test(probed), "a model on another provider is not this endpoint's business");
  assert.match(ok.kube.probes[0]!, /tool_calls/, "…and demands a tool-call completion (ADR-0019)");

  const bad = mkWorld(await mkInstance(config, "bad", agents));
  bad.kube.probeFails = true;
  await assert.rejects(() => up(["--yes"], bad.io), /provider.*enable-auto-tool-choice/s);
});

test("provider preflight: configured but no carried Agent names its models → skipped, not a silent pass", async () => {
  const config =
    `export default { name: "myinst", harness: { ` +
    `provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } } };\n`;
  const w = mkWorld(await mkInstance(config, "myinst", { judge: { model: "anthropic/claude-x" } }));
  assert.equal(await up(["--yes"], w.io), 0);
  assert.equal(w.kube.probes.length, 0);
  assert.match(w.err.join("\n"), /no carried Agent names a "vllm\/…" model/);
});

// --- git over ssh: the key source is the user's choice (ADR-0047) --------------------------------

/** The scaffold's wildcard, minus the token: every ssh url's key is the `j2-git-ssh` Secret. */
const SSH_CONFIG = `export default { name: "myinst", git: { credentials: [{ match: "*", sshKey: "j2-git-ssh" }] } };\n`;
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
  const home = await mkdtemp(join(tmpdir(), "j2-home-"));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), PRIVATE_KEY);
  await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${PUBLIC_KEY}\n`);
  await writeFile(join(home, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n");
  await writeFile(join(home, ".ssh", "config"), "Host *\n  AddKeysToAgent yes\n");
  return { home, keyPath: join(home, ".ssh", "id_ed25519") };
}

/** The Secret the git-ssh layer applied, parsed — or undefined when it applied none. */
function gitSshSecret(w: World): { stringData: Record<string, string> } | undefined {
  const manifest = w.kube.applied.find((m) => m.includes(`"name":"j2-git-ssh"`));
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
  assert.match(notice, /generated into "j2-git-ssh"/, "…and the Secret it landed in");
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
    `import { j2Setup, workspace } from ${JSON.stringify(KIT_SRC)};\n` +
      `const body = j2Setup({ events: [] })\n` +
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
  assert.equal(gitSshSecret(w), undefined, "no Secret may be applied on a key j2 refuses");
});

test("git ssh: declining every source bails; an existing Secret is never offered against", async () => {
  const { home } = await mkSshHome();
  const decline = mkWorld(await sshInstance("decl"), { env: { HOME: home } }); // → none of these
  decline.io.sshKeygen = async () => assert.fail("declined — no key may be generated");
  // The bail spells the scripted escape, and it must name the key the cache agent reads — `identity`
  // (Flux's names, ADR-0051). A Secret under any other key is refused by every clone.
  await assert.rejects(() => up([], decline.io), /j2-git-ssh.*--from-file=identity=<path>/s);
  assert.equal(gitSshSecret(decline), undefined);

  const has = mkWorld(await sshInstance("has"));
  has.kube.set("myinst", "secret", "j2-git-ssh", { metadata: { name: "j2-git-ssh" } });
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
  const root = await mkInstance(
    `export default { name: "myinst", harness: { env: [{ name: "K", value: "v" }] } };\n`,
    "myinst",
    DECISIONER_AGENTS,
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
  assert.equal(podSpec.volumes, undefined, "no /work — nothing to attach");

  // Same wiring a Sandbox's Harness container gets: the harness-config ConfigMap + the env Secret.
  const harness = podSpec.containers[0];
  // This world is NOT a kit checkout (mkWorld's default kitDir is the instance folder), so the
  // resolved ref is the published one — the branch a real instance takes (ADR-0038), at the
  // canonical home (ADR-0044).
  assert.equal(harness.image, "ghcr.io/snapwich/j2-harness:0.0.0", "the stock image at the kit version");
  assert.deepEqual(harness.env[0], {
    name: "J2_HARNESS_JSON",
    valueFrom: { configMapKeyRef: { name: "j2-harness", key: "harness.json" } },
  });
  assert.ok(
    harness.envFrom.some((e: { secretRef?: { name: string } }) => e.secretRef?.name === "j2-harness-env"),
    "the Harness envFroms its own Secret",
  );
  // The placement gate (ADR-0031): every admission carries its own definition (ADR-0049), so the
  // Harness itself must refuse any non-Menu-only one — no code execution in this pod is a claim
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
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
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
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", {
    coder: { model: "anthropic/claude-x" },
  });
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
  const root = await mkInstance(`export default { name: "myinst" };\n`, "myinst", DECISIONER_AGENTS);
  const w = mkWorld(root, { kitDir: kit });
  assert.equal(await up(["--yes"], w.io), 0);

  const images = imagesOf(w);
  assert.match(images.harness, /^j2-harness:[0-9a-f]{12}-amd64$/);
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
