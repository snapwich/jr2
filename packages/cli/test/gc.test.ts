// `jr2 gc [--dry-run] [--repo-ttl <ttl>]` (ADR-0039, ADR-0051): the same image reachability sweep
// `up` and `down` run, off-cycle, plus the Repo sweep only this verb runs. An escape hatch for
// "disk is full now" — so it must work from anywhere (no instance folder), it never confirms (by
// construction it takes only what jr2 built and only what nothing names or binds), and a roots read
// it could not complete is a FAILED run rather than a smaller keep set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { gc } from "../src/commands/gc.ts";
import type { BuildPort, ObservedImage } from "../src/build.ts";
import type { KubeAdmin } from "../src/kube.ts";
import type { Io } from "../src/output.ts";

/** One `Repo` resource as the sweep reads it: the Orchestrator's bound label and attach clock
 * (ADR-0051), and the creation stamp the clock falls back to. */
type RepoListing = {
  namespace: string;
  key: string;
  url?: string;
  bound?: boolean;
  lastAttached?: string;
  created?: string;
};

type Listing = {
  namespaces?: string[];
  maps?: Record<string, unknown>;
  pods?: Array<{ metadata: { name: string; namespace?: string }; spec?: { containers?: Array<{ image?: string }> } }>;
  repos?: RepoListing[];
  fails?: boolean;
  /** A cluster the operator never reached — recreate the kind cluster, then "disk is full now". */
  noSandboxCrd?: boolean;
  /** Same cluster, the other CRD: no `repos.core.jr2.dev` resource type either. */
  noRepoCrd?: boolean;
  /** The Repo listing alone fails, as a forbidden verb or an unreachable API does. */
  reposFail?: boolean;
};

function mkKube(listing: Listing = {}, context = "kind-jr2"): KubeAdmin & { deleted: string[] } {
  const kube = {
    deleted: [] as string[],
    context: async () => context,
    getJson: async () => assert.fail("gc reads roots by LISTING them"),
    apply: async () => assert.fail("gc applies nothing"),
    label: async () => assert.fail("gc labels nothing"),
    // The one kind of object gc deletes: a Repo resource (ADR-0051). Images are not objects.
    deleteObject: async (o: { kind: string; name: string; namespace?: string }) => {
      assert.equal(o.kind, "repos.core.jr2.dev", "gc deletes Repo resources and nothing else");
      kube.deleted.push(`${o.namespace}/${o.name}`);
    },
    deleteManifest: async () => assert.fail("gc deletes no manifests"),
    waitRollout: async () => assert.fail("gc waits for nothing"),
    logs: async () => assert.fail("gc reads no logs") as never,
    runOneShot: async () => assert.fail("gc probes nothing") as never,
    listJson: async <T>(o: { kind: string; namespace?: string }): Promise<T[]> => {
      if (listing.fails) throw new Error("Unable to connect to the server");
      if (o.kind.startsWith("sandboxes") && listing.noSandboxCrd) {
        throw new Error('error: the server doesn\'t have a resource type "sandboxes"');
      }
      if (o.kind === "namespace") return (listing.namespaces ?? []).map((name) => ({ metadata: { name } })) as T[];
      if (o.kind === "configmap") {
        return Object.entries(listing.maps ?? {}).map(([namespace, map]) => ({
          metadata: { name: "jr2-images", namespace },
          data: { "images.json": JSON.stringify(map) },
        })) as T[];
      }
      if (o.kind === "pod") return (listing.pods ?? []) as T[];
      if (o.kind === "repos.core.jr2.dev") {
        if (listing.reposFail) throw new Error("repos.core.jr2.dev is forbidden: User cannot list resource");
        if (listing.noRepoCrd) throw new Error('error: the server doesn\'t have a resource type "repos"');
        assert.ok(o.namespace, "Repos are read per instance namespace");
        return (listing.repos ?? [])
          .filter((r) => r.namespace === o.namespace)
          .map((r) => ({
            metadata: {
              name: r.key,
              namespace: r.namespace,
              creationTimestamp: r.created ?? "2026-01-01T00:00:00Z",
              ...(r.bound ? { labels: { "jr2.dev/bound": "true" } } : {}),
              ...(r.lastAttached ? { annotations: { "jr2.dev/last-attached": r.lastAttached } } : {}),
            },
            spec: { url: r.url ?? `https://e.test/${r.key}.git` },
          })) as T[];
      }
      return [];
    },
  };
  return kube;
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
    imageUser: async () => assert.fail("gc inspects nothing") as never,
    buildablePlatforms: async () => assert.fail("gc builds nothing, so it asks no platform") as never,
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
 * `resolveRoot` throws without a `jr2.config.ts`. A kube context is the only address gc needs. */
function mkIo(kube: KubeAdmin, build: BuildPort): { io: Io; err: () => string } {
  const err: string[] = [];
  return {
    io: { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/", kubeAdmin: kube, build },
    err: () => err.join(""),
  };
}

test("gc sweeps from anywhere — no instance folder, no confirmation", async () => {
  const build = mkBuild({
    host: [image({ id: "sha256:a", tags: ["jr2-instance-gone:0ld"], bytes: 4_445_841 })],
    node: [image({ id: "sha256:b", tags: ["docker.io/library/jr2-instance-gone:0ld"], bytes: 4_685_144 })],
  });
  const { io, err } = mkIo(mkKube(), build);
  io.confirm = async () => assert.fail("gc never asks: it takes only what jr2 built and nothing names");

  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host jr2-instance-gone:0ld", "node jr2-control-plane sha256:b"]);
  // ONE image, however each store spells it (`jr2-instance-gone:0ld` on the host,
  // `docker.io/library/…` in containerd) — and both copies' bytes, because both were on the disk.
  assert.match(err(), /swept 1 image\(s\) \(9\.1 MB\)/, "one image, two stores, two copies of the disk");
});

test("--dry-run prints the plan and removes nothing", async () => {
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["jr2-instance-gone:0ld"], bytes: 2_100_000_000 })] });
  const { io, err } = mkIo(mkKube(), build);

  assert.equal(await gc(["--dry-run"], io), 0);
  assert.deepEqual(build.removed, []);
  assert.match(err(), /would sweep 1 image\(s\) \(2\.1 GB\)/);
  assert.match(err(), /jr2-instance-gone:0ld/, "the plan names what it would take");
});

test("a kit ref lives while any instance's map names it, and collects when the last one leaves", async () => {
  // "Kit images are never pruned" was a rule by fiat; ADR-0039 dissolves it into reachability.
  const kit = () => [image({ id: "sha256:k", tags: ["jr2-harness:0f1e2d3c4b5a"], bytes: 238_000_000 })];

  const named = mkBuild({ host: kit() });
  const stillHere = mkKube({
    namespaces: ["other"],
    maps: { other: { harness: "jr2-harness:0f1e2d3c4b5a", adapter: "jr2-adapter:5a4b", sandbox: {} } },
  });
  assert.equal(await gc([], mkIo(stillHere, named).io), 0);
  assert.deepEqual(named.removed, []);

  const orphaned = mkBuild({ host: kit() });
  const empty = mkIo(mkKube(), orphaned);
  assert.equal(await gc([], empty.io), 0);
  assert.deepEqual(orphaned.removed, ["host jr2-harness:0f1e2d3c4b5a"]);
  assert.match(empty.err(), /swept 1 image\(s\) \(238\.0 MB\)/);
});

test("an image jr2 did not build is invisible, whatever it is called", async () => {
  // Images from before ADR-0039 carry no stamp, and sweeping them means guessing by name again —
  // the exact primitive the ADR deletes. So they are not even reported as kept.
  const build = mkBuild({
    host: [
      image({ id: "sha256:a", tags: ["jr2-workspace-myinst-default:ancient"], bytes: 999, labeled: false }),
      image({ id: "sha256:b", tags: ["jr2-harness:local"], bytes: 999, labeled: false }),
    ],
  });
  const { io, err } = mkIo(mkKube(), build);
  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, []);
  assert.match(err(), /swept nothing/);
});

test("a non-kind context sweeps the host and leaves the cluster's nodes alone", async () => {
  const build = mkBuild({
    host: [image({ id: "sha256:a", tags: ["reg.example.com/jr2-instance-gone:0ld"], bytes: 10 })],
    node: [image({ id: "sha256:b", tags: ["jr2-instance-gone:0ld"], bytes: 10 })],
  });
  const { io } = mkIo(mkKube({}, "gke-prod"), build);
  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host reg.example.com/jr2-instance-gone:0ld"], "a registry copy is cache too");
});

test("a cluster with no Sandbox CRD is not a failed read — it is a cluster with no Sandboxes", async () => {
  // "disk is full now" after `kind delete cluster && kind create cluster`: no operator has ever
  // run here, so `kubectl get sandboxes.core.jr2.dev` exits 1 — and treating that as an unreadable
  // root made the escape hatch exit 1 and sweep nothing on the one cluster with nothing to protect.
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["jr2-harness:0f1e"], bytes: 238_000_000 })] });
  const { io, err } = mkIo(mkKube({ noSandboxCrd: true }), build);

  assert.equal(await gc([], io), 0);
  assert.deepEqual(build.removed, ["host jr2-harness:0f1e"]);
  assert.match(err(), /swept 1 image\(s\)/);
});

test("a roots read that failed takes nothing and exits 1", async () => {
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["jr2-instance-gone:0ld"], bytes: 10 })] });
  const { io, err } = mkIo(mkKube({ fails: true }), build);

  assert.equal(await gc([], io), 1);
  assert.deepEqual(build.removed, [], "a keep set missing a root would delete images the cluster needs");
  assert.match(err(), /error: the roots could not be read/);
});

// --- the Repo sweep (ADR-0051): eviction is reachability plus age ------------------------------
// A Repo resource lives while a registered Machine binds it (the Orchestrator's label) or a run has
// attached it within the TTL (the Orchestrator's clock); what is left is deleted, and its deletion
// is what lets each node's cache agent evict its copy.

/** A cluster whose only garbage question is about Repos: two instances, nothing to sweep off disk. */
function reposWorld(repos: RepoListing[], over: Partial<Listing> = {}) {
  const kube = mkKube({ namespaces: ["a", "b"], repos, ...over });
  const { io, err } = mkIo(kube, mkBuild());
  return { kube, io, err };
}

/** `gc` reads the wall clock, so the fixtures are dated relative to it. */
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

test("a bound Repo survives whatever its age; an unbound one goes once its last attach is older than the TTL", async () => {
  const w = reposWorld([
    { namespace: "a", key: "app-1111aaaa", bound: true, lastAttached: daysAgo(400) },
    { namespace: "a", key: "old-2222bbbb", lastAttached: daysAgo(8) },
    { namespace: "a", key: "warm-3333cccc", lastAttached: daysAgo(6) },
    // Another instance's Repos are read too — the sweep is cluster-wide, like the images'.
    { namespace: "b", key: "old-4444dddd", lastAttached: daysAgo(30) },
    // Never attached: the creation stamp is the clock, so a per-run Repo whose one run never got
    // as far as an attach still ages out.
    { namespace: "b", key: "born-5555eeee", created: daysAgo(9) },
    { namespace: "b", key: "young-6666ffff", created: daysAgo(1) },
  ]);
  assert.equal(await gc([], w.io), 0);
  assert.deepEqual(w.kube.deleted, ["a/old-2222bbbb", "b/old-4444dddd", "b/born-5555eeee"]);
  assert.match(w.err(), /repos: swept 3 Repo resource\(s\) no Machine binds and no run attached within 7d/);
});

test("--repo-ttl sets the age; 0 evicts every unbound Repo now", async () => {
  const fixtures = (): RepoListing[] => [
    { namespace: "a", key: "app-1111aaaa", bound: true, lastAttached: daysAgo(0) },
    { namespace: "a", key: "hour-2222bbbb", lastAttached: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    { namespace: "a", key: "fresh-3333cccc", lastAttached: daysAgo(0) },
  ];
  const hours = reposWorld(fixtures());
  assert.equal(await gc(["--repo-ttl", "1h"], hours.io), 0);
  assert.deepEqual(hours.kube.deleted, ["a/hour-2222bbbb"]);
  assert.match(hours.err(), /within 1h/);

  const now = reposWorld(fixtures());
  assert.equal(await gc(["--repo-ttl", "0"], now.io), 0);
  assert.deepEqual(now.kube.deleted, ["a/hour-2222bbbb", "a/fresh-3333cccc"], "everything unbound, whatever its age");

  // A TTL that does not parse is refused before anything is read — it must never read as zero.
  const typo = reposWorld(fixtures());
  await assert.rejects(() => gc(["--repo-ttl", "7"], typo.io), /--repo-ttl "7" is not a TTL/);
  assert.deepEqual(typo.kube.deleted, []);
});

test("--dry-run names the Repos it would take and deletes none", async () => {
  const w = reposWorld([
    { namespace: "a", key: "old-2222bbbb", url: "https://e.test/old.git", lastAttached: daysAgo(8) },
    { namespace: "a", key: "app-1111aaaa", bound: true },
  ]);
  assert.equal(await gc(["--dry-run"], w.io), 0);
  assert.deepEqual(w.kube.deleted, []);
  assert.match(w.err(), /repos: would sweep 1 Repo resource\(s\)/);
  assert.match(w.err(), /a\/old-2222bbbb \(https:\/\/e\.test\/old\.git\)/, "the plan names what it would take");
  assert.doesNotMatch(w.err(), /app-1111aaaa/);
});

test("a cluster with no Repo CRD has no Repos — not a failed read", async () => {
  const w = reposWorld([], { noRepoCrd: true, noSandboxCrd: true });
  assert.equal(await gc([], w.io), 0);
  assert.deepEqual(w.kube.deleted, []);
  assert.match(w.err(), /repos: swept nothing/);
});

test("a Repo listing that failed sweeps no Repos and exits 1 — the images were still swept", async () => {
  const build = mkBuild({ host: [image({ id: "sha256:a", tags: ["jr2-instance-gone:0ld"], bytes: 10 })] });
  const kube = mkKube({ namespaces: ["a"], reposFail: true });
  const { io, err } = mkIo(kube, build);
  assert.equal(await gc([], io), 1);
  assert.deepEqual(build.removed, ["host jr2-instance-gone:0ld"], "the image sweep ran first and stands");
  assert.deepEqual(kube.deleted, []);
  assert.match(err(), /error: the Repo resources could not be read/);
});

test("`jr2 gc` is a dispatched verb", async () => {
  const build = mkBuild();
  const { io } = mkIo(mkKube(), build);
  assert.equal(await main(["gc", "--dry-run"], io), 0);
});
