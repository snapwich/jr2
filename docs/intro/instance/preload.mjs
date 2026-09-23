// `npm run preload` — put every image the demo runs onto the kind node, so the talk needs no network.
//
// `jr2 up` delivers only what it BUILDS (instance, Sandbox Image; in a kit checkout, the kit too). Every
// other image is a registry ref the kubelet pulls when a pod first asks for it — on a cold node with
// no network, that pod sits in ImagePullBackOff while the room watches. This loads those refs ahead
// of time: from the host's docker if it holds them, from the registry otherwise (so run it ONLINE).
//
// The deck's preflight (`../slides/stage.mjs`) imports `missingImages` and names anything absent.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The refs `jr2 up` does not deliver. Keep in step with the files named beside each. */
export const EXTRA_IMAGES = [
  // workflows/task.ts `user:` — the User Container.
  "ghcr.io/snapwich/dev:k8s-arm64",
  // `jr2 up`'s provider preflight runs its probe in this (packages/cli/src/kube.ts `runOneShot`).
  "node:24-slim",
  // seed.mjs — the git server the toy repo is served from.
  "alpine/git:v2.47.2",
  "nginx:1.27-alpine",
];

const NAMESPACE = "intro";

async function out(cmd, args) {
  const { stdout } = await exec(cmd, args, { maxBuffer: 16 << 20 });
  return stdout.trim();
}

/** The kind cluster the current context names, or a thrown error that says why not. */
export async function kindCluster() {
  const context = await out("kubectl", ["config", "current-context"]);
  if (!context.startsWith("kind-")) throw new Error(`kube context ${context} is not a kind cluster`);
  return context.slice("kind-".length);
}

async function nodes(cluster) {
  return (await out("kind", ["get", "nodes", "--name", cluster])).split("\n").filter(Boolean);
}

async function nodeHolds(node, ref) {
  return exec("docker", ["exec", node, "crictl", "inspecti", "-q", ref]).then(
    () => true,
    () => false,
  );
}

/** The refs `jr2 up` delivered to this instance, from the record it keeps on the Orchestrator. */
export async function kitImages() {
  const json = await out("kubectl", ["-n", NAMESPACE, "get", "deploy", "jr2-orchestrator", "-o", "json"]).catch(
    () => "",
  );
  if (!json) return [];
  const deploy = JSON.parse(json);
  const record = JSON.parse(deploy.metadata.annotations?.["jr2.dev/images"] ?? "{}");
  return [
    ...deploy.spec.template.spec.containers.map((c) => c.image),
    record.harness,
    record.adapter,
    record.operator,
    ...Object.values(record.sandbox ?? {}),
    ...Object.values(record.sandboxUser ?? {}),
  ].filter(Boolean);
}

/** Every ref in `refs` that some node of `cluster` does not hold. */
export async function missingImages(cluster, refs) {
  const missing = [];
  for (const node of await nodes(cluster)) {
    for (const ref of refs) if (!(await nodeHolds(node, ref))) missing.push(ref);
  }
  return [...new Set(missing)];
}

/** Put `ref` on every node: from the host's docker, pulled first if the host lacks it. */
export async function loadImage(cluster, ref) {
  const [node] = await nodes(cluster);
  // One platform, the node's: a pulled multi-arch index cannot go through `kind load` whole.
  const arch = (await out("docker", ["exec", node, "uname", "-m"])) === "aarch64" ? "arm64" : "amd64";
  const onHost = await exec("docker", ["image", "inspect", ref]).then(
    () => true,
    () => false,
  );
  if (!onHost) {
    console.log(`  pull ${ref} (linux/${arch})`);
    await exec("docker", ["pull", "-q", "--platform", `linux/${arch}`, ref]);
  }
  console.log(`  kind load ${ref}`);
  await exec("kind", ["load", "docker-image", "--name", cluster, ref], { maxBuffer: 16 << 20 });
}

/** Load each of `refs` that a node lacks. */
export async function ensureImages(cluster, refs) {
  for (const ref of await missingImages(cluster, refs)) await loadImage(cluster, ref);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cluster = await kindCluster();
  console.log(`preload → kind cluster "${cluster}"`);
  // A kit ref with a registry in it is a PUBLISHED image (installed mode, ADR-0044): the kubelet
  // pulls it, so it is preloaded like the rest. A bare ref is one `jr2 up` built and delivered.
  const kit = await kitImages();
  await ensureImages(cluster, [...EXTRA_IMAGES, ...kit.filter((ref) => ref.includes("/"))]);
  const lost = await missingImages(cluster, kit);
  if (lost.length > 0) {
    console.log(`  missing images jr2 up delivered — run \`npx jr2 up --force\`:\n    ${lost.join("\n    ")}`);
    process.exit(1);
  }
  console.log("  every image the demo runs is on the node");
}
