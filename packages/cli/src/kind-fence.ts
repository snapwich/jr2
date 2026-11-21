// On a kind cluster, `jr2 up` makes the Fence's node parts itself (ADR-0084, ADR-0019): a kind node is a
// container on the user's own host, which jr2 already reaches through docker (`kind load`). On any
// other cluster it makes none of them, and the probe (`fence-probe.ts`) names what a node lacks.
//
// The parts, on each node of the cluster: the stock CNI plugins bridge, static and tuning (v1.10.0,
// from the release tarball, checked by sha256), the 8021q module, the bridge jr2fence0 and its
// settings, the rule set and the unreachable route of the segment (`manifests/fence/kind-node.sh`
// says what each is). For the cluster: Multus v4.3.2 thick with namespaceIsolation
// (`manifests/fence/multus-v4.3.2.yaml`).
//
// It runs at every converge on kind, before anything needs the parts, so a part that a restart of
// the node lost comes back at the next `jr2 up`. It is in two steps: `planKindFence` reads what is
// missing and changes nothing; `makeKindFence` makes it. Between them, `jr2 up` asks once, under
// its first-time confirmation, when the plan installs something on the cluster for the first time
// (the plugins or Multus). A part that a restart lost is made again with no question. Two converges
// at once on one cluster are safe: the node script runs under a lock on the node, its scratch table
// has a name of its own process, and a plugin goes in under a name of its own process, then moves.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import type { KubeAdmin } from "./kube.ts";
import { ATTACHMENT_CRD } from "./fence-probe.ts";

/** The folder of the shipped files: the node script, the Multus manifest and the sha256 list. */
const FILES = fileURLToPath(new URL("../manifests/fence/", import.meta.url));
export const CNI_VERSION = "v1.10.0";
export const PLUGINS = ["bridge", "static", "tuning"] as const;
export const MULTUS_DAEMONSET = "kube-multus-ds";
export const MULTUS_NAMESPACE = "kube-system";
/** The annotation of the Multus DaemonSet that names the version of the shipped manifest. */
export const MULTUS_ANNOTATION = "jr2.dev/multus";
/** Its value in the shipped manifest. Change both when the manifest changes. */
export const MULTUS_VERSION = "v4.3.2-thick-namespace-isolation-1";
/** The label that kind puts on each node container of a cluster. */
const KIND_LABEL = "io.x-k8s.kind.cluster";
/** The lock on each node: two converges at once make the parts one after the other. */
const NODE_LOCK = "/run/jr2-fence.lock";

export type DockerResult = { code: number; stdout: string; stderr: string };
/** One `docker` command: its arguments, and its stdin. */
export type DockerRunner = (args: string[], input?: string) => Promise<DockerResult>;
/** One download of a release file. */
export type Download = (url: string) => Promise<Uint8Array>;

export type KindFencePorts = {
  docker: DockerRunner;
  download: Download;
  /** The CLI's cache folder: the plugin tarball of each architecture is kept there. */
  cacheDir: string;
  kube: Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout">;
  /** The folder of the shipped files; a test gives its own. */
  files?: string;
};

/** What one node lacks. */
export type KindNodePlan = {
  node: string;
  arch: "amd64" | "arm64";
  /** The plugins to write: absent, or not the shipped v1.10.0. */
  plugins: string[];
  /** The other parts that the node script reports missing. */
  parts: string[];
};

export type KindFencePlan = {
  cluster: string;
  segment: string;
  nodes: KindNodePlan[];
  /** Multus must be applied: no CustomResourceDefinition, or no DaemonSet with this manifest's version. */
  multus: boolean;
};

// ---- the shipped files -----------------------------------------------------------------------------

/** The sha256 list: a tarball name, or `linux-<arch>/<plugin>`, to its sum. */
export async function shippedSums(files = FILES): Promise<Map<string, string>> {
  const text = await readFile(join(files, "cni-plugins.sha256"), "utf8");
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

/** The Multus manifest. Its DaemonSet's annotation must name `MULTUS_VERSION`. */
export async function multusManifest(files = FILES): Promise<string> {
  const text = await readFile(join(files, "multus-v4.3.2.yaml"), "utf8");
  if (!text.includes(`\n    ${MULTUS_ANNOTATION}: ${MULTUS_VERSION}\n`)) {
    throw new Error(`fence: the shipped Multus manifest does not have ${MULTUS_ANNOTATION}: ${MULTUS_VERSION}`);
  }
  return text;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export const tarballName = (arch: string): string => `cni-plugins-linux-${arch}-${CNI_VERSION}.tgz`;
export const tarballUrl = (arch: string): string =>
  `https://github.com/containernetworking/plugins/releases/download/${CNI_VERSION}/${tarballName(arch)}`;

/** The CLI's cache folder: `$XDG_CACHE_HOME/jr2`, else `~/.cache/jr2`. */
export function cacheDirOf(env: Record<string, string | undefined>): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "jr2");
}

// ---- the real ports --------------------------------------------------------------------------------

/** `docker <args>`, stdin from `input`. Never throws: a docker that cannot start is code 127. */
export const dockerRunner: DockerRunner = (args, input) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

/** A plain GET, with no header that names the user, the project or the host. */
export const httpDownload: Download = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

// ---- the plan --------------------------------------------------------------------------------------

/** The node containers of a kind cluster, by kind's own label. */
async function kindNodes(docker: DockerRunner, cluster: string): Promise<string[]> {
  const r = await docker(["ps", "--filter", `label=${KIND_LABEL}=${cluster}`, "--format", "{{.Names}}"]);
  if (r.code !== 0) {
    throw new Error(
      `fence: the context names the kind cluster "${cluster}", and jr2 up makes the Fence's node parts on its ` +
        `nodes through docker, but \`docker ps\` failed: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  }
  const nodes = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  if (nodes.length === 0) {
    throw new Error(
      `fence: the context names the kind cluster "${cluster}", but docker on this computer has no node container ` +
        `of it (label ${KIND_LABEL}=${cluster}). jr2 up makes the Fence's node parts on a kind cluster through ` +
        "the docker that runs it: run jr2 up where the cluster's docker runs.",
    );
  }
  return nodes;
}

/** The refusal for a kernel with no 8021q module. */
function moduleRefusal(node: string, why: string): Error {
  return new Error(
    `fence: the kind node ${node} cannot have the 8021q module: ${why}. The uplink of the Custodian needs it for a ` +
      "VLAN interface of each slot (ADR-0084). A kind node shares the kernel of the host that runs its container, " +
      "so that kernel must give the module: load it on that host (`modprobe 8021q`), or use a kernel that has it. " +
      "Then run `jr2 up` again.",
  );
}

/** Run the node script in `mode` on one node, under the node's lock. */
async function runNodeScript(
  docker: DockerRunner,
  node: string,
  mode: "check" | "make",
  segment: string,
  files: string,
): Promise<{ lines: string[] }> {
  const script = await readFile(join(files, "kind-node.sh"), "utf8");
  const r = await docker(["exec", "-i", node, "flock", NODE_LOCK, "sh", "-s", "--", mode, segment], script);
  if (r.code !== 0) {
    throw new Error(
      `fence: the ${mode} of the Fence's node parts failed on the kind node ${node}: ` +
        `${(r.stderr.trim() || r.stdout.trim()).slice(-600) || `exit ${r.code}`}`,
    );
  }
  return { lines: r.stdout.split("\n").map((l) => l.trim()) };
}

const ARCH: Record<string, "amd64" | "arm64"> = { x86_64: "amd64", aarch64: "arm64", arm64: "arm64" };

/** What the node script said, read into a node's plan. Throws on `refuse`. */
export function readNodeLines(
  node: string,
  lines: readonly string[],
  sums: ReadonlyMap<string, string>,
  word: "missing" | "made",
): KindNodePlan {
  const machine = lines.find((l) => l.startsWith("arch "))?.slice(5) ?? "";
  const arch = ARCH[machine];
  if (!arch) {
    throw new Error(
      `fence: the kind node ${node} has the architecture "${machine || "unknown"}"; jr2 has the CNI plugins for ` +
        "x86_64 and aarch64 only",
    );
  }
  const refused = lines.find((l) => l.startsWith("refuse 8021q"));
  if (refused) throw moduleRefusal(node, refused.slice("refuse 8021q".length).trim());
  const plugins: string[] = [];
  for (const p of PLUGINS) {
    const have = lines.find((l) => l.startsWith(`plugin ${p} `))?.split(" ")[2];
    if (have !== sums.get(`linux-${arch}/${p}`)) plugins.push(p);
  }
  const parts = lines.filter((l) => l.startsWith(`${word} `)).map((l) => l.slice(word.length + 1));
  return { node, arch, plugins, parts };
}

/** Is a plan's Multus current? Its CustomResourceDefinition, and its DaemonSet with this version. */
async function multusCurrent(ports: KindFencePorts, context?: string): Promise<boolean> {
  const ctx = context !== undefined ? { context } : {};
  const crds = await ports.kube.listJson({
    kind: "customresourcedefinition",
    fieldSelector: `metadata.name=${ATTACHMENT_CRD}`,
    ...ctx,
  });
  if (crds.length === 0) return false;
  const ds = await ports.kube.getJson({
    kind: "daemonset",
    name: MULTUS_DAEMONSET,
    namespace: MULTUS_NAMESPACE,
    ...ctx,
  });
  return ds?.metadata.annotations?.[MULTUS_ANNOTATION] === MULTUS_VERSION;
}

/** Read what each node of the kind cluster lacks, and whether Multus must be applied. Changes nothing. */
export async function planKindFence(
  ports: KindFencePorts,
  opts: { cluster: string; segment: string; context?: string },
): Promise<KindFencePlan> {
  if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(opts.segment)) {
    throw new Error(`fence: the segment must be an IPv4 prefix such as 198.19.0.0/20, not "${opts.segment}"`);
  }
  const files = ports.files ?? FILES;
  const sums = await shippedSums(files);
  const nodes: KindNodePlan[] = [];
  for (const node of await kindNodes(ports.docker, opts.cluster)) {
    const { lines } = await runNodeScript(ports.docker, node, "check", opts.segment, files);
    nodes.push(readNodeLines(node, lines, sums, "missing"));
  }
  const multus = !(await multusCurrent(ports, opts.context));
  return { cluster: opts.cluster, segment: opts.segment, nodes, multus };
}

/** Nothing to make. */
export const planIsEmpty = (plan: KindFencePlan): boolean =>
  !plan.multus && plan.nodes.every((n) => n.plugins.length === 0 && n.parts.length === 0);

/** The plan installs something on the cluster for the first time (the plugins or Multus): `jr2 up`
 * asks. A part that a restart of a node lost is made again with no question. */
export const planAsks = (plan: KindFencePlan): boolean => plan.multus || plan.nodes.some((n) => n.plugins.length > 0);

const count = (n: number): string => `${n} node${n === 1 ? "" : "s"}`;

/** What the plan will do, as the confirmation says it. */
export function describePlan(plan: KindFencePlan): string {
  const said: string[] = [];
  const withPlugins = plan.nodes.filter((n) => n.plugins.length > 0).length;
  if (withPlugins > 0) {
    said.push(`install the CNI plugins ${PLUGINS.join(", ")} ${CNI_VERSION} on ${count(withPlugins)}`);
  }
  const withParts = plan.nodes.filter((n) => n.parts.length > 0).length;
  if (withParts > 0) {
    said.push(
      `make the bridge jr2fence0, the rule set inet jr2_fence, the route unreachable ${plan.segment} and the ` +
        `8021q module where missing on ${count(withParts)}`,
    );
  }
  if (plan.multus) said.push("apply Multus v4.3.2 thick with namespaceIsolation to kube-system");
  return `on kind cluster "${plan.cluster}": ${said.join("; ")}`;
}

// ---- the plugins -----------------------------------------------------------------------------------

/** The refusal for a tarball that could not be had. */
function tarballRefusal(arch: string, path: string, want: string, why: string): Error {
  return new Error(
    `fence: jr2 up could not get the CNI plugins for a kind node (${why}). Download ${tarballUrl(arch)} ` +
      `on a computer that can reach it, and put it at ${path}. jr2 up checks its sha256 (${want}). Then run ` +
      "`jr2 up` again.",
  );
}

/** The files `wanted` of a gzipped tar, read as a stream (the tarball is about 80 MB). */
export async function untarGz(tgz: Uint8Array, wanted: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const gunzip = createGunzip();
  gunzip.end(tgz);
  let buf: Buffer = Buffer.alloc(0);
  let state: "header" | "body" | "pad" = "header";
  let remaining = 0;
  let pad = 0;
  let name: string | undefined;
  let parts: Buffer[] = [];
  const cstr = (b: Buffer): string => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
  };
  outer: for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length > 0) {
      if (state === "header") {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) break outer;
        const prefix = cstr(h.subarray(345, 500));
        const full = (prefix ? `${prefix}/` : "") + cstr(h.subarray(0, 100));
        const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
        const type = String.fromCharCode(h[156]!);
        const base = full.replace(/^\.\//, "");
        name = (type === "0" || type === "\0") && wanted.includes(base) ? base : undefined;
        parts = [];
        remaining = size;
        pad = (512 - (size % 512)) % 512;
        state = "body";
        if (remaining === 0) state = "pad";
      } else if (state === "body") {
        const take = Math.min(remaining, buf.length);
        if (name) parts.push(Buffer.from(buf.subarray(0, take)));
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining === 0) {
          if (name) out.set(name, Buffer.concat(parts));
          if (out.size === wanted.length) break outer;
          state = "pad";
        }
      } else {
        const take = Math.min(pad, buf.length);
        buf = buf.subarray(take);
        pad -= take;
        if (pad === 0) state = "header";
      }
    }
  }
  gunzip.destroy();
  return out;
}

/** The plugin binaries of one architecture: from the cached tarball, or downloaded once, each checked by sha256. */
export async function pluginBinaries(
  ports: Pick<KindFencePorts, "download" | "cacheDir" | "files">,
  arch: "amd64" | "arm64",
  log: (line: string) => void,
): Promise<Map<string, Buffer>> {
  const sums = await shippedSums(ports.files ?? FILES);
  const name = tarballName(arch);
  const want = sums.get(name);
  if (!want) throw new Error(`fence: the shipped sha256 list has no sum for ${name}`);
  const dir = join(ports.cacheDir, "cni-plugins");
  const path = join(dir, name);
  let tgz = await readFile(path).catch(() => undefined);
  if (tgz === undefined || sha256(tgz) !== want) {
    log(`fence: downloading ${tarballUrl(arch)} into ${dir}`);
    let got: Uint8Array;
    try {
      got = await ports.download(tarballUrl(arch));
    } catch (e) {
      throw tarballRefusal(arch, path, want, `the download failed: ${(e as Error).message}`);
    }
    const sum = sha256(got);
    if (sum !== want) throw tarballRefusal(arch, path, want, `the download's sha256 is ${sum}, not ${want}`);
    await mkdir(dir, { recursive: true });
    const part = `${path}.${process.pid}.part`;
    await writeFile(part, got);
    await rename(part, path);
    tgz = Buffer.from(got);
  }
  const files = await untarGz(tgz, PLUGINS);
  for (const p of PLUGINS) {
    const bin = files.get(p);
    const wantBin = sums.get(`linux-${arch}/${p}`);
    if (!bin || sha256(bin) !== wantBin) {
      throw new Error(
        `fence: ${p} in ${path} is ${bin ? `not the shipped one (sha256 ${sha256(bin)})` : "absent"}; delete the file and run \`jr2 up\` again`,
      );
    }
  }
  return files;
}

// ---- the make --------------------------------------------------------------------------------------

/** Write the plugins that a node lacks: each under a name of this process, then moved into place. */
async function writePlugins(
  docker: DockerRunner,
  node: string,
  plugins: readonly string[],
  binaries: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-cni-"));
  try {
    for (const p of plugins) {
      const local = join(dir, p);
      await writeFile(local, binaries.get(p)!, { mode: 0o755 });
      const temp = `/opt/cni/bin/${p}.jr2-new-${process.pid}`;
      const cp = await docker(["cp", local, `${node}:${temp}`]);
      const mv =
        cp.code === 0
          ? await docker(["exec", node, "sh", "-c", `chmod 0755 '${temp}' && mv -f '${temp}' '/opt/cni/bin/${p}'`])
          : cp;
      if (mv.code !== 0) {
        throw new Error(`fence: writing the CNI plugin ${p} on the kind node ${node} failed: ${mv.stderr.trim()}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Make what the plan says is missing, and print one line for each node that changed (or one line
 * when nothing was missing). Multus is applied when the plan says so, and its rollout is waited for
 * whenever something was made.
 */
export async function makeKindFence(
  ports: KindFencePorts,
  plan: KindFencePlan,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  if (planIsEmpty(plan)) {
    opts.log(
      `fence: the node parts on kind cluster "${plan.cluster}" are unchanged (${count(plan.nodes.length)}, ` +
        `segment ${plan.segment})`,
    );
    return;
  }
  const files = ports.files ?? FILES;
  const sums = await shippedSums(files);
  const binaries = new Map<string, Map<string, Buffer>>();
  for (const n of plan.nodes) {
    if (n.plugins.length === 0 && n.parts.length === 0) {
      opts.log(`fence: kind node ${n.node}: unchanged`);
      continue;
    }
    const made: string[] = [];
    if (n.plugins.length > 0) {
      if (!binaries.has(n.arch)) binaries.set(n.arch, await pluginBinaries(ports, n.arch, opts.log));
      await writePlugins(ports.docker, n.node, n.plugins, binaries.get(n.arch)!);
      made.push(...n.plugins.map((p) => `plugin:${p}`));
    }
    const { lines } = await runNodeScript(ports.docker, n.node, "make", plan.segment, files);
    made.push(...readNodeLines(n.node, lines, sums, "made").parts);
    opts.log(`fence: kind node ${n.node}: made ${made.join(" ") || "nothing (another converge made it)"}`);
  }
  if (plan.multus) {
    const text = await multusManifest(files);
    opts.log(`fence: multus: applying v4.3.2 thick with namespaceIsolation to kind cluster "${plan.cluster}"`);
    try {
      await ports.kube.apply({ manifest: text, ...ctx });
    } catch {
      // Another converge at the same moment can make the same objects first (AlreadyExists): once more.
      await sleep(2000);
      await ports.kube.apply({ manifest: text, ...ctx });
    }
  }
  await ports.kube.waitRollout({
    kind: "daemonset",
    name: MULTUS_DAEMONSET,
    namespace: MULTUS_NAMESPACE,
    timeoutSeconds: 300,
    ...ctx,
  });
  if (plan.multus) opts.log("fence: multus: ready on each node");
}
