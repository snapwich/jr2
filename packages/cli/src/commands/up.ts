// `j2 up [--yes] [--force] [-n <ns>] [--context <ctx>]` (ADR-0019): idempotently converge the target
// namespace to this instance — every layer, loudly narrated, safe to re-run. Layers in order:
// ownership → operator → instance image → agents ConfigMap → Secret (+ preflight of referenced
// Secrets) → apply + rollout. Repos reconcile onto the in-cluster source volume at orchestrator
// boot (ADR-0004); a configured custom provider is preflighted from inside the cluster.
//
// Addressing (ADR-0019): cluster = the current kube context (never recorded); namespace =
// `config.name` (identity). Whether this cluster hosts the instance is derived FROM the cluster:
// labeled objects found → converge silently (it's home); nothing → confirm first-time setup
// (`--yes` for CI); objects labeled as a DIFFERENT instance → refuse.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadAgents, loadConfig, type DiscoveredAgent, type J2Config } from "@j2/orchestrator";
import { pnpmDockerBuild, stageInstanceBundle } from "../build.ts";
import {
  compareVersions,
  GIT_SSH_SECRET,
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

  // --- operator (per-cluster, shared) ------------------------------------------------------------
  if (config.operator?.manage === false) {
    activity(io, "operator: skipped (operator.manage: false — run the controller loop yourself)");
  } else {
    const image = config.operator?.image ?? `j2-operator:${KIT_VERSION}`;
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
      // Kit dev pins a static tag (`j2-operator:local`), which this cannot catch — a same-tag
      // rebuild leaves the pod template identical and nothing rolls. `just operator-image`
      // restarts the Deployment for exactly that reason; here the tag is the released version.
      await verifyRunningImage(io, kube, {
        layer: "operator",
        namespace: OPERATOR_NAMESPACE,
        selector: OPERATOR_SELECTOR,
        image,
        ...ctx,
      });
    }
  }

  // --- instance image (content-addressed by the bundle) ------------------------------------------
  // Stage first, THEN decide: the hash is over the materialized bundle — the actual image inputs,
  // kit included — so the tag is a content address rather than a guess about what changed.
  const build = io.build ?? pnpmDockerBuild;
  const staged = await stageInstanceBundle(build, root);
  const hash = staged.hash;
  const registry = config.registry;
  const tag = registry ? `${registry}/j2-instance-${name}:${hash}` : `j2-instance-${name}:${hash}`;
  try {
    const orch = await kube.getJson({ kind: "deployment", name: ORCHESTRATOR_SERVICE, namespace, ...ctx });
    if (orch?.metadata.labels?.[LABEL_HASH] === hash && values.force !== true) {
      // Safe to skip only because the rolled-out pod is verified against `tag` below: this decides
      // whether to spend a docker build, not whether the cluster is already correct.
      activity(io, `image: ${tag} (fresh — build skipped; --force to rebuild anyway)`);
    } else {
      activity(io, `image: building ${tag}${values.force === true ? " (--force)" : ""}`);
      await build.build(tag, staged.dir);
      if (registry) {
        activity(io, `image: pushing to ${registry}`);
        await build.push(tag);
      } else if (context.startsWith("kind-")) {
        const cluster = context.slice("kind-".length);
        activity(io, `image: no registry configured — \`kind load\` onto cluster "${cluster}"`);
        await build.kindLoad(tag, cluster);
      } else {
        throw new Error(
          `context ${context} is not a kind cluster and no \`registry\` is configured — ` +
            `set \`registry\` in j2.config.ts (from env) so the image can be pushed (ADR-0019)`,
        );
      }
    }
  } finally {
    await staged.dispose();
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
  const secretData: Record<string, string> = {
    J2_INSTANCE_TOKEN: keep("J2_INSTANCE_TOKEN", () => randomBytes(24).toString("hex")),
    J2_SIGNING_KEY: keep("J2_SIGNING_KEY", () => randomBytes(32).toString("base64")),
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

  noteDeferred(io, config);
  activity(io, `converged — \`j2 run <workflow>\` when ready`);
  return 0;
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
  opts: { layer: string; namespace: string; selector: string; image: string; context?: string },
): Promise<void> {
  const { layer, image, ...q } = opts;
  const pods = await kube.listJson<PodObject>({ kind: "pod", ...q });
  // Mid-termination pods from the outgoing ReplicaSet still carry the old image and are not the
  // thing serving — the question is what the cluster runs now, not what it is done running.
  const live = pods.filter((p) => !p.metadata.deletionTimestamp);
  const stale = live.filter((p) => p.spec.containers.some((c) => c.image !== image));
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
  spec: { containers: Array<{ image: string }> };
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
