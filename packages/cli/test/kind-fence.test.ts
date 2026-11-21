// The Fence's node parts on a kind cluster (ADR-0084, ADR-0019): `jr2 up` reads what each node
// lacks, asks the first time it installs something, and makes it, through a fake docker and a
// fake API. The plugin tarball here is one this test makes, with a sha256 list of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  MULTUS_ANNOTATION,
  MULTUS_VERSION,
  cacheDirOf,
  describePlan,
  makeKindFence,
  multusManifest,
  planAsks,
  planIsEmpty,
  planKindFence,
  pluginBinaries,
  tarballName,
  tarballUrl,
  untarGz,
  type KindFencePorts,
} from "../src/kind-fence.ts";
import type { KubeObject } from "../src/kube.ts";
import { FakeKindDocker } from "./support/kind-docker.ts";

const SHIPPED = fileURLToPath(new URL("../manifests/fence/", import.meta.url));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A ustar archive of `files`, gzipped, as the release tarball is laid out (`./<name>`). */
function tgzOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";
  const entry = (name: string, body: Buffer, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(octal(0o755, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(body.length, 12), 124);
    h.write(octal(0, 12), 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + " ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  entry("./", Buffer.alloc(0), "5");
  entry("./macvlan", Buffer.from("not wanted"), "0");
  for (const [name, text] of Object.entries(files)) entry(`./${name}`, Buffer.from(text), "0");
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const BINARIES = { bridge: "bridge-bin", static: "static-bin", tuning: "tuning-bin".repeat(300) };
const TGZ = tgzOf(BINARIES);

/** The shipped node script and Multus manifest, and a sha256 list for this test's tarball. */
async function filesDir(tgz = TGZ): Promise<{ dir: string; sums: Map<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-kind-fence-"));
  await copyFile(join(SHIPPED, "kind-node.sh"), join(dir, "kind-node.sh"));
  await copyFile(join(SHIPPED, "multus-v4.3.2.yaml"), join(dir, "multus-v4.3.2.yaml"));
  const sums = new Map<string, string>([[tarballName("amd64"), sha(tgz)]]);
  for (const [p, text] of Object.entries(BINARIES)) sums.set(`linux-amd64/${p}`, sha(Buffer.from(text)));
  await writeFile(join(dir, "cni-plugins.sha256"), [...sums].map(([n, s]) => `${s}  ${n}\n`).join(""));
  return { dir, sums };
}

/** A fake API: Multus's definition and DaemonSet, as `present` says; each apply and rollout recorded. */
function fakeKube(present: boolean) {
  const state = { present, applied: [] as string[], rollouts: [] as string[] };
  const kube: KindFencePorts["kube"] = {
    async listJson<T>(opts: { kind: string }) {
      assert.equal(opts.kind, "customresourcedefinition");
      return (state.present ? [{ metadata: { name: "network-attachment-definitions.k8s.cni.cncf.io" } }] : []) as T[];
    },
    async getJson<T>() {
      return (
        state.present
          ? { metadata: { name: "kube-multus-ds", annotations: { [MULTUS_ANNOTATION]: MULTUS_VERSION } } }
          : undefined
      ) as T | undefined;
    },
    async apply(opts: { manifest: string }) {
      state.applied.push(opts.manifest);
      state.present = true;
    },
    async waitRollout(opts: { kind?: string; name: string; namespace: string }) {
      state.rollouts.push(`${opts.namespace}/${opts.kind}/${opts.name}`);
    },
  };
  return { kube, state };
}

async function world(opts: { prepared: boolean; multus: boolean; module?: "loaded" | "loadable" | "absent" }) {
  const { dir, sums } = await filesDir();
  const docker = new FakeKindDocker();
  docker.add("jr2-control-plane", {
    cluster: "jr2",
    prepared: opts.prepared,
    sums,
    ...(opts.module ? { module: opts.module } : {}),
  });
  docker.add("other-control-plane", { cluster: "other", prepared: false, sums });
  const { kube, state } = fakeKube(opts.multus);
  const downloads: string[] = [];
  const cacheDir = await mkdtemp(join(tmpdir(), "jr2-cache-"));
  const ports: KindFencePorts = {
    docker: docker.run,
    download: async (url) => {
      downloads.push(url);
      return TGZ;
    },
    cacheDir,
    kube,
    files: dir,
  };
  const log: string[] = [];
  return { ports, docker, state, downloads, log, sums, cacheDir };
}

const OPTS = { cluster: "jr2", segment: "198.19.0.0/20" };

test("a stock kind node: the plan names each part and asks; the make writes each, applies Multus, and a second plan is empty", async () => {
  const w = await world({ prepared: false, multus: false });
  const plan = await planKindFence(w.ports, OPTS);
  assert.deepEqual(plan.nodes, [
    {
      node: "jr2-control-plane",
      arch: "amd64",
      plugins: ["bridge", "static", "tuning"],
      parts: ["8021q", "bridge", "rule-set", "route"],
    },
  ]);
  assert.equal(plan.multus, true);
  assert.equal(planAsks(plan), true);
  assert.equal(
    describePlan(plan),
    'on kind cluster "jr2": install the CNI plugins bridge, static, tuning v1.10.0 on 1 node; make the bridge ' +
      "jr2fence0, the rule set inet jr2_fence, the route unreachable 198.19.0.0/20 and the 8021q module where " +
      "missing on 1 node; apply Multus v4.3.2 thick with namespaceIsolation to kube-system",
  );
  // The plan changed nothing: only the cluster's own node was read, in check mode, under the lock.
  assert.deepEqual(w.docker.calls, [
    "ps --filter label=io.x-k8s.kind.cluster=jr2 --format {{.Names}}",
    "exec -i jr2-control-plane flock /run/jr2-fence.lock sh -s -- check 198.19.0.0/20",
  ]);
  assert.deepEqual(w.state.applied, []);

  await makeKindFence(w.ports, plan, { log: (l) => w.log.push(l) });
  const node = w.docker.nodes.get("jr2-control-plane")!;
  for (const p of ["bridge", "static", "tuning"]) assert.equal(node.plugins[p], w.sums.get(`linux-amd64/${p}`));
  assert.deepEqual([...node.missing], []);
  assert.equal(node.module, "loaded");
  assert.deepEqual(w.downloads, [tarballUrl("amd64")]);
  assert.equal(w.state.applied.length, 1);
  assert.equal(w.state.applied[0], await multusManifest(SHIPPED));
  assert.deepEqual(w.state.rollouts, ["kube-system/daemonset/kube-multus-ds"]);
  assert.ok(
    w.log.includes(
      "fence: kind node jr2-control-plane: made plugin:bridge plugin:static plugin:tuning 8021q bridge rule-set route",
    ),
    w.log.join("\n"),
  );
  assert.ok(w.log.includes("fence: multus: ready on each node"));
  // The other kind cluster on this host is not touched.
  assert.ok(!w.docker.calls.some((c) => c.includes("other-control-plane")));
  assert.equal(w.docker.nodes.get("other-control-plane")!.missing.size, 3);

  // A second converge: nothing missing, nothing asked, one line, no change.
  const again = await planKindFence(w.ports, OPTS);
  assert.equal(planIsEmpty(again), true);
  assert.equal(planAsks(again), false);
  const calls = w.docker.calls.length;
  const lines: string[] = [];
  await makeKindFence(w.ports, again, { log: (l) => lines.push(l) });
  assert.deepEqual(lines, [
    'fence: the node parts on kind cluster "jr2" are unchanged (1 node, segment 198.19.0.0/20)',
  ]);
  assert.equal(w.docker.calls.length, calls);
  assert.equal(w.state.applied.length, 1);
  assert.equal(w.state.rollouts.length, 1);
});

test("parts that a restart of the node lost are made again with no question", async () => {
  const w = await world({ prepared: true, multus: true });
  w.docker.nodes.get("jr2-control-plane")!.missing = new Set(["bridge", "rule-set", "route"]);
  const plan = await planKindFence(w.ports, OPTS);
  assert.equal(planAsks(plan), false, "the plugins and Multus are there: nothing is installed for the first time");
  assert.equal(planIsEmpty(plan), false);
  await makeKindFence(w.ports, plan, { log: (l) => w.log.push(l) });
  assert.deepEqual(w.log, ["fence: kind node jr2-control-plane: made bridge rule-set route"]);
  assert.deepEqual(w.downloads, [], "no plugin is written, so no tarball is read");
  assert.deepEqual(w.state.applied, []);
  assert.deepEqual(w.state.rollouts, ["kube-system/daemonset/kube-multus-ds"], "Multus is ready before the probe");
});

test("a kernel with no 8021q module refuses, and names the module and the host's kernel", async () => {
  const w = await world({ prepared: false, multus: false, module: "absent" });
  await assert.rejects(planKindFence(w.ports, OPTS), (e: Error) => {
    assert.match(e.message, /^fence: the kind node jr2-control-plane cannot have the 8021q module: the kernel/);
    assert.match(e.message, /A kind node shares the kernel of the host that runs its container/);
    return true;
  });
});

test("no node container of the cluster, or no docker, refuses with what to do", async () => {
  const w = await world({ prepared: true, multus: true });
  await assert.rejects(
    planKindFence(w.ports, { ...OPTS, cluster: "elsewhere" }),
    /docker on this computer has no node container of it \(label io\.x-k8s\.kind\.cluster=elsewhere\)/,
  );
  w.docker.down = true;
  await assert.rejects(planKindFence(w.ports, OPTS), /`docker ps` failed: Cannot connect to the Docker daemon/);
  await assert.rejects(
    planKindFence(w.ports, { ...OPTS, segment: "198.19.0.0" }),
    /the segment must be an IPv4 prefix such as 198\.19\.0\.0\/20, not "198\.19\.0\.0"/,
  );
});

test("the tarball: downloaded once into the cache and checked by sha256; a wrong one, or no network, refuses with the path", async () => {
  const w = await world({ prepared: false, multus: false });
  const log: string[] = [];
  const got = await pluginBinaries(w.ports, "amd64", (l) => log.push(l));
  assert.deepEqual(Object.fromEntries([...got].map(([k, v]) => [k, v.toString()])), BINARIES);
  const cached = join(w.cacheDir, "cni-plugins", tarballName("amd64"));
  assert.equal(sha(await readFile(cached)), sha(TGZ));
  assert.equal(w.downloads.length, 1);
  await pluginBinaries(w.ports, "amd64", () => {});
  assert.equal(w.downloads.length, 1, "the cached tarball is used again");

  // A tarball whose sum is not the shipped one is refused and not kept.
  const wrong = await world({ prepared: false, multus: false });
  wrong.ports.download = async () => tgzOf({ ...BINARIES, bridge: "a changed bridge" });
  await assert.rejects(
    pluginBinaries(wrong.ports, "amd64", () => {}),
    (e: Error) => {
      assert.match(e.message, /the download's sha256 is [0-9a-f]{64}, not [0-9a-f]{64}/);
      assert.ok(e.message.includes(`Download ${tarballUrl("amd64")}`));
      assert.ok(e.message.includes(`put it at ${join(wrong.cacheDir, "cni-plugins", tarballName("amd64"))}`));
      return true;
    },
  );
  await assert.rejects(readFile(join(wrong.cacheDir, "cni-plugins", tarballName("amd64"))));

  // No network: the same refusal, with the download's reason.
  wrong.ports.download = async () => {
    throw new Error("getaddrinfo ENOTFOUND github.com");
  };
  await assert.rejects(
    pluginBinaries(wrong.ports, "amd64", () => {}),
    /the download failed: getaddrinfo ENOTFOUND/,
  );

  // A cached file that is not the shipped one is read as absent, and downloaded again.
  const stale = await world({ prepared: false, multus: false });
  const path = join(stale.cacheDir, "cni-plugins", tarballName("amd64"));
  await pluginBinaries(stale.ports, "amd64", () => {});
  await writeFile(path, "garbage");
  await pluginBinaries(stale.ports, "amd64", () => {});
  assert.equal(stale.downloads.length, 2);
});

test("untarGz reads only the files asked for, and the cache folder follows XDG_CACHE_HOME", async () => {
  const files = await untarGz(TGZ, ["static", "tuning"]);
  assert.deepEqual([...files.keys()].sort(), ["static", "tuning"]);
  assert.equal(files.get("tuning")!.toString(), BINARIES.tuning);
  assert.equal(cacheDirOf({ XDG_CACHE_HOME: "/x", HOME: "/h" }), "/x/jr2");
  assert.equal(cacheDirOf({ HOME: "/h" }), "/h/.cache/jr2");
});

test("the shipped files: the Multus DaemonSet names MULTUS_VERSION, the sha256 list has both architectures, and the node script parses", async () => {
  const text = await multusManifest(SHIPPED);
  assert.match(text, /"namespaceIsolation": true/);
  const list = await readFile(join(SHIPPED, "cni-plugins.sha256"), "utf8");
  for (const arch of ["amd64", "arm64"]) {
    assert.match(list, new RegExp(`^[0-9a-f]{64} {2}${tarballName(arch).replace(/\./g, "\\.")}$`, "m"));
    for (const p of ["bridge", "static", "tuning"])
      assert.match(list, new RegExp(`^[0-9a-f]{64} {2}linux-${arch}/${p}$`, "m"));
  }
  await promisify(execFile)("sh", ["-n", join(SHIPPED, "kind-node.sh")]);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("manifests"), "the files ship in the published package");
});

test("planning a cluster changes nothing, and gives the same node to each of two converges at once", async () => {
  const w = await world({ prepared: false, multus: false });
  const [a, b] = await Promise.all([planKindFence(w.ports, OPTS), planKindFence(w.ports, OPTS)]);
  assert.deepEqual(a, b);
  const kube = w.ports.kube as unknown as { getJson(): Promise<KubeObject | undefined> };
  assert.equal(await kube.getJson(), undefined);
  // Both make: the second finds the node made, and says so.
  await makeKindFence(w.ports, a, { log: (l) => w.log.push(l) });
  await makeKindFence(w.ports, b, { log: (l) => w.log.push(l) });
  assert.ok(w.log.includes("fence: kind node jr2-control-plane: made plugin:bridge plugin:static plugin:tuning"));
});
