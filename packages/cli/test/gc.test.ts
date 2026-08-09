// `j2 gc [--dry-run]` (ADR-0039): the same reachability sweep `up` and `down` run, off-cycle. An
// escape hatch for "disk is full now" — so it must work from anywhere (no instance folder), it
// never confirms (by construction it takes only what j2 built and only what nothing names), and a
// roots read it could not complete is a FAILED run rather than a smaller keep set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { gc } from "../src/commands/gc.ts";
import type { BuildPort, ObservedImage } from "../src/build.ts";
import type { KubeAdmin } from "../src/kube.ts";
import type { Io } from "../src/output.ts";

type Listing = {
  namespaces?: string[];
  maps?: Record<string, unknown>;
  pods?: Array<{ metadata: { name: string; namespace?: string }; spec?: { containers?: Array<{ image?: string }> } }>;
  fails?: boolean;
  /** A cluster the operator never reached — recreate the kind cluster, then "disk is full now". */
  noSandboxCrd?: boolean;
};

function mkKube(listing: Listing = {}, context = "kind-j2"): KubeAdmin {
  return {
    context: async () => context,
    getJson: async () => assert.fail("gc reads roots by LISTING them"),
    apply: async () => assert.fail("gc applies nothing"),
    label: async () => assert.fail("gc labels nothing"),
    deleteObject: async () => assert.fail("gc deletes no objects — images are not objects"),
    deleteManifest: async () => assert.fail("gc deletes no objects"),
    waitRollout: async () => assert.fail("gc waits for nothing"),
    runOneShot: async () => assert.fail("gc probes nothing") as never,
    listJson: async <T>(o: { kind: string }): Promise<T[]> => {
      if (listing.fails) throw new Error("Unable to connect to the server");
      if (o.kind.startsWith("sandboxes") && listing.noSandboxCrd) {
        throw new Error('error: the server doesn\'t have a resource type "sandboxes"');
      }
      if (o.kind === "namespace") return (listing.namespaces ?? []).map((name) => ({ metadata: { name } })) as T[];
      if (o.kind === "configmap") {
        return Object.entries(listing.maps ?? {}).map(([namespace, map]) => ({
          metadata: { name: "j2-images", namespace },
          data: { "images.json": JSON.stringify(map) },
        })) as T[];
      }
      if (o.kind === "pod") return (listing.pods ?? []) as T[];
      return [];
    },
  };
}

function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

/** Both stores really shrink — the node half's report is only true if the re-list agrees. */
function mkBuild(images: { host?: ObservedImage[]; node?: ObservedImage[] } = {}): BuildPort & { removed: string[] } {
  const host = [...(images.host ?? [])];
  const node = [...(images.node ?? [])];
  const port = {
    removed: [] as string[],
    bundle: async () => assert.fail("gc bundles nothing"),
    build: async () => assert.fail("gc builds nothing"),
    run: async () => assert.fail("gc runs nothing") as never,
    push: async () => assert.fail("gc pushes nothing"),
    kindLoad: async () => assert.fail("gc loads nothing"),
    hostImages: async () => [...host],
    removeHostImage: async (ref: string) => {
      port.removed.push(`host ${ref}`);
      const at = host.findIndex((i) => i.tags.includes(ref) || i.id === ref);
      if (at >= 0) host.splice(at, 1);
    },
    nodeImages: async (cluster: string) => [{ node: `${cluster}-control-plane`, images: [...node] }],
    removeNodeImage: async (_c: string, nodeName: string, id: string) => {
      port.removed.push(`node ${nodeName} ${id}`);
      const at = node.findIndex((i) => i.id === id);
      if (at >= 0) node.splice(at, 1);
    },
  };
  return port;
}

/** cwd "/" on purpose: "disk is full now" has to work from outside any instance folder, and
 * `resolveRoot` throws without a `j2.config.ts`. A kube context is the only address gc needs. */
function mkIo(kube: KubeAdmin, build: BuildPort): { io: Io; err: () => string } {
  const err: string[] = [];
  return {
    io: { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/", kubeAdmin: kube, build },
    err: () => err.join(""),
  };
}

test("gc sweeps from anywhere — no instance folder, no confirmation", async () => {
  const build = mkBuild({
    host: [image({ id: "sha256:a", tags: ["j2-instance-gone:0ld"], bytes: 4_445_841 })],
    node: [image({ id: "sha256:b", tags: ["docker.io/library/j2-instance-gone:0ld"], bytes: 4_685_144 })],
  });
  const { io, err } = mkIo(mkKube(), build);
  io.confirm = async () => assert.fail("gc never asks: it takes only what j2 built and nothing names");

  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host j2-instance-gone:0ld", "node j2-control-plane sha256:b"]);
  // ONE image, however each store spells it (`j2-instance-gone:0ld` on the host,
  // `docker.io/library/…` in containerd) — and both copies' bytes, because both were on the disk.
  assert.match(err(), /swept 1 image\(s\) \(9\.1 MB\)/, "one image, two stores, two copies of the disk");
});

test("--dry-run prints the plan and removes nothing", async () => {
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["j2-instance-gone:0ld"], bytes: 2_100_000_000 })] });
  const { io, err } = mkIo(mkKube(), build);

  assert.equal(await gc(["--dry-run"], io), 0);
  assert.deepEqual(build.removed, []);
  assert.match(err(), /would sweep 1 image\(s\) \(2\.1 GB\)/);
  assert.match(err(), /j2-instance-gone:0ld/, "the plan names what it would take");
});

test("a kit ref lives while any instance's map names it, and collects when the last one leaves", async () => {
  // "Kit images are never pruned" was a rule by fiat; ADR-0039 dissolves it into reachability.
  const kit = () => [image({ id: "sha256:k", tags: ["j2-harness:0f1e2d3c4b5a"], bytes: 238_000_000 })];

  const named = mkBuild({ host: kit() });
  const stillHere = mkKube({
    namespaces: ["other"],
    maps: { other: { harness: "j2-harness:0f1e2d3c4b5a", adapter: "j2-adapter:5a4b", sandbox: {} } },
  });
  assert.equal(await gc([], mkIo(stillHere, named).io), 0);
  assert.deepEqual(named.removed, []);

  const orphaned = mkBuild({ host: kit() });
  const empty = mkIo(mkKube(), orphaned);
  assert.equal(await gc([], empty.io), 0);
  assert.deepEqual(orphaned.removed, ["host j2-harness:0f1e2d3c4b5a"]);
  assert.match(empty.err(), /swept 1 image\(s\) \(238\.0 MB\)/);
});

test("an image j2 did not build is invisible, whatever it is called", async () => {
  // Images from before ADR-0039 carry no stamp, and sweeping them means guessing by name again —
  // the exact primitive the ADR deletes. So they are not even reported as kept.
  const build = mkBuild({
    host: [
      image({ id: "sha256:a", tags: ["j2-workspace-myinst-default:ancient"], bytes: 999, labeled: false }),
      image({ id: "sha256:b", tags: ["j2-harness:local"], bytes: 999, labeled: false }),
    ],
  });
  const { io, err } = mkIo(mkKube(), build);
  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, []);
  assert.match(err(), /swept nothing/);
});

test("a non-kind context sweeps the host and leaves the cluster's nodes alone", async () => {
  const build = mkBuild({
    host: [image({ id: "sha256:a", tags: ["reg.example.com/j2-instance-gone:0ld"], bytes: 10 })],
    node: [image({ id: "sha256:b", tags: ["j2-instance-gone:0ld"], bytes: 10 })],
  });
  const { io } = mkIo(mkKube({}, "gke-prod"), build);
  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host reg.example.com/j2-instance-gone:0ld"], "a registry copy is cache too");
});

test("a cluster with no Sandbox CRD is not a failed read — it is a cluster with no Sandboxes", async () => {
  // "disk is full now" after `kind delete cluster && kind create cluster`: no operator has ever
  // run here, so `kubectl get sandboxes.core.j2.dev` exits 1 — and treating that as an unreadable
  // root made the escape hatch exit 1 and sweep nothing on the one cluster with nothing to protect.
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["j2-harness:0f1e"], bytes: 238_000_000 })] });
  const { io, err } = mkIo(mkKube({ noSandboxCrd: true }), build);

  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host j2-harness:0f1e"]);
  assert.match(err(), /swept 1 image\(s\)/);
});

test("a roots read that failed takes nothing and exits 1", async () => {
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["j2-instance-gone:0ld"], bytes: 10 })] });
  const { io, err } = mkIo(mkKube({ fails: true }), build);

  assert.equal(await gc([], io), 1);
  assert.deepEqual(build.removed, [], "a keep set missing a root would delete images the cluster needs");
  assert.match(err(), /error: the roots could not be read/);
});

test("`j2 gc` is a dispatched verb", async () => {
  const build = mkBuild();
  const { io } = mkIo(mkKube(), build);
  assert.equal(await main(["gc", "--dry-run"], io), 0);
});
