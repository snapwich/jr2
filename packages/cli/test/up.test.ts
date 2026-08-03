// `j2 up` (ADR-0019): the one converging command. These tests drive the LAYER DECISIONS — ownership
// guardrails, operator never-downgrade, image staleness/delivery, Secret idempotence, preflights —
// through injected kube/build/confirm fakes; the real subprocess ports stay thin and are exercised
// by the @kind tier. Manifest shapes are asserted incidentally via what the fake kube captures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { up } from "../src/commands/up.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";
import type { BuildPort } from "../src/build.ts";
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
  async listJson<T>(opts: { kind: string; selector?: string; namespace?: string }): Promise<T[]> {
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
 * `node_modules/.pnpm` (the resolved dependency, workspace-linked or registry-fetched alike). */
function fakeBuild(record: string[], files: Record<string, string> = { "package.json": "{}" }): BuildPort {
  return {
    bundle: async (_dir, out) => {
      record.push("bundle");
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(out, dirname(rel)), { recursive: true });
        await writeFile(join(out, rel), content);
      }
    },
    build: async (tag) => void record.push(`build ${tag}`),
    push: async (tag) => void record.push(`push ${tag}`),
    kindLoad: async (tag, cluster) => void record.push(`kind-load ${tag} → ${cluster}`),
  };
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

type World = { io: Io; kube: FakeCluster; built: string[]; err: string[]; confirms: string[] };

function mkWorld(
  root: string,
  over: { confirm?: boolean; env?: Record<string, string>; bundleFiles?: Record<string, string> } = {},
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
    kubeAdmin: kube,
    build: fakeBuild(built, over.bundleFiles),
    confirm: async (q) => {
      confirms.push(q);
      return over.confirm ?? true;
    },
  };
  return { io, kube, built, err, confirms };
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
  const root = await mkInstance(`export default { name: "myinst", operator: { image: "j2-operator:local" } };\n`);
  const w = mkWorld(root);
  assert.equal(await up(["--yes"], w.io), 0);
  assert.ok(
    w.kube.rollouts.includes("j2-system/j2-controller-manager"),
    `the operator rollout is waited for (got: ${w.kube.rollouts.join(", ")})`,
  );

  const drifted = mkWorld(root);
  drifted.kube.podImages = { "control-plane=controller-manager": "j2-operator:ancient" };
  await assert.rejects(() => up(["--yes"], drifted.io), /operator.*j2-operator:ancient.*expected j2-operator:local/s);
});

test("operator: manage:false skips the layer; operator.image overrides the ref", async () => {
  const skipRoot = await mkInstance(`export default { name: "a", operator: { manage: false } };\n`, "a");
  const w1 = mkWorld(skipRoot);
  assert.equal(await up(["--yes"], w1.io), 0);
  assert.ok(!w1.kube.applied.some((m) => m.includes("controller-manager")));

  const overrideRoot = await mkInstance(
    `export default { name: "b", operator: { image: "j2-operator:local" } };\n`,
    "b",
  );
  const w2 = mkWorld(overrideRoot);
  assert.equal(await up(["--yes"], w2.io), 0);
  const operatorApply = w2.kube.applied.find((m) => m.includes("controller-manager"));
  assert.ok(operatorApply, "the operator install was applied");
  assert.match(operatorApply, /image: j2-operator:local/);
  assert.ok(!operatorApply.includes("controller:latest"), "the placeholder image ref was substituted");
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

test("re-running against the instance's own namespace converges silently (no prompt)", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const w = mkWorld(root, { confirm: false }); // any prompt would fail the run
  w.kube.set("", "namespace", "myinst", { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } });

  assert.equal(await up([], w.io), 0);
  assert.equal(w.confirms.length, 0, "it's home — no prompt");
});
