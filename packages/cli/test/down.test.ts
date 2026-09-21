// `jr2 down [--all]` (ADR-0019): remove the instance from the cluster. Always confirms; `--all`
// takes the per-cluster operator too. Foreign namespaces are refused, exactly like `up`. It also
// sweeps images off the host daemon and, on kind, off every node (ADR-0039) — content addressing
// means abandoned images pile up invisibly, so the sweep is default. Its scoping is what these
// tests pin, and the scoping is REACHABILITY: the namespace delete took this instance's roots, so
// its images are garbage by construction, while every other instance's roots still protect
// everything they share.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { down } from "../src/commands/down.ts";
import type { BuildPort, ObservedImage } from "../src/build.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";
import type { Io } from "../src/output.ts";
import { linkKit } from "./_kit.ts";

/** The cluster's live roots, as the sweep reads them (ADR-0039) — this is what `down` is left
 * looking at AFTER the namespace delete, so a scenario writes the OTHER instances, not its own. */
type Roots = {
  namespaces?: string[];
  /** namespace → the `images.json` its `jr2-images` ConfigMap holds. */
  maps?: Record<string, unknown>;
  sandboxes?: Array<{ metadata: { name: string; namespace?: string }; spec?: { image?: string } }>;
  pods?: Array<{ metadata: { name: string; namespace?: string }; spec?: { containers?: Array<{ image?: string }> } }>;
};

function mkKube(
  objects: Record<string, Partial<KubeObject>>,
  opts: { context?: string; roots?: Roots } = {},
): KubeAdmin & { deleted: string[] } {
  const store = new Map(Object.entries(objects));
  const roots = opts.roots ?? {};
  let crdGone = false;
  const fake = {
    deleted: [] as string[],
    context: async () => opts.context ?? "kind-test",
    getJson: async <T = KubeObject>(o: { kind: string; name: string; namespace?: string }) =>
      store.get(`${o.namespace ?? ""}/${o.kind.toLowerCase()}/${o.name}`) as T | undefined,
    apply: async () => assert.fail("down applies nothing"),
    label: async () => assert.fail("down labels nothing"),
    deleteObject: async (o: { kind: string; name: string; namespace?: string }) =>
      void fake.deleted.push(`${o.namespace ?? ""}/${o.kind}/${o.name}`),
    deleteManifest: async () => {
      fake.deleted.push("(operator manifest)");
      // The manifest CARRIES the `sandboxes.core.jr2.dev` CRD, so `--all` takes the resource type
      // with it — and the sweep runs after (see the `--all` test).
      crdGone = true;
    },
    waitRollout: async () => {},
    listJson: async <T>(o: { kind: string }): Promise<T[]> => {
      if (o.kind.startsWith("sandboxes") && crdGone) {
        throw new Error(
          'Command failed: kubectl get sandboxes.core.jr2.dev\nerror: the server doesn\'t have a resource type "sandboxes"',
        );
      }
      if (o.kind === "namespace") return (roots.namespaces ?? []).map((name) => ({ metadata: { name } })) as T[];
      if (o.kind === "configmap") {
        return Object.entries(roots.maps ?? {}).map(([namespace, map]) => ({
          metadata: { name: "jr2-images", namespace },
          data: { "images.json": JSON.stringify(map) },
        })) as T[];
      }
      if (o.kind.startsWith("sandboxes")) return (roots.sandboxes ?? []) as T[];
      if (o.kind === "pod") return (roots.pods ?? []) as T[];
      return [];
    },
    logs: async () => assert.fail("down reads no logs") as never,
    runOneShot: async () => assert.fail("down probes nothing") as never,
  };
  return fake;
}

/** One image as a store reports it: jr2-built and worth reclaiming unless the test says otherwise. */
function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

/** A build port whose only live verbs are the sweep's — everything else fails, because `down` must
 * never build, push, or load. The fake answers the two LISTINGS and records the removals; the
 * decision between them is the REAL policy in build.ts. The seam sits below the matcher on purpose:
 * a fake that answered "what would you remove" is how a prune that matched nothing shipped green. */
function mkSweep(
  images: { host?: ObservedImage[]; node?: ObservedImage[] } = {},
  fails = false,
): BuildPort & { removed: string[]; listed: string[] } {
  // Both stores really shrink. The node half is verified by RE-LISTING (ADR-0039's bytes are only
  // true if a removal removed), so a fake that answered the same listing twice would report every
  // removal as failed — and one that returned without removing would be the very lie the re-list
  // exists to catch.
  const host = [...(images.host ?? [])];
  const node = [...(images.node ?? [])];
  const port = {
    removed: [] as string[],
    listed: [] as string[],
    bundle: async () => assert.fail("down bundles nothing"),
    build: async () => assert.fail("down builds nothing"),
    imageUser: async () => assert.fail("down inspects nothing") as never,
    buildablePlatforms: async () => assert.fail("down builds nothing, so it asks no platform") as never,
    push: async () => assert.fail("down pushes nothing"),
    kindLoad: async () => assert.fail("down loads nothing"),
    hostImages: async () => {
      port.listed.push("host");
      if (fails) throw new Error("Cannot connect to the Docker daemon");
      return [...host];
    },
    removeHostImage: async (ref: string) => {
      port.removed.push(`host ${ref}`);
      const at = host.findIndex((i) => i.tags.includes(ref) || i.id === ref);
      if (at >= 0) host.splice(at, 1);
    },
    nodeImages: async (cluster: string) => {
      port.listed.push(`node ${cluster}`);
      return [{ node: `${cluster}-control-plane`, images: [...node] }];
    },
    removeNodeImage: async (_cluster: string, nodeName: string, id: string) => {
      port.removed.push(`node ${nodeName} ${id}`);
      const at = node.findIndex((i) => i.id === id);
      if (at >= 0) node.splice(at, 1);
    },
  };
  return port;
}

async function mkWorld(kube: KubeAdmin, confirm: boolean, build?: BuildPort) {
  const root = await mkdtemp(join(tmpdir(), "jr2-down-"));
  await writeFile(join(root, "jr2.config.ts"), `export default { name: "myinst" };\n`);
  await linkKit(root);
  // An authored Sandbox Image — no longer load-bearing for the sweep (nothing derives a name any
  // more, ADR-0039), kept because a real instance folder has one and `down` must ignore it.
  await mkdir(join(root, "images", "default"), { recursive: true });
  await writeFile(join(root, "images", "default", "Dockerfile"), "FROM node:24-slim\n");
  const err: string[] = [];
  const confirms: string[] = [];
  const io: Io = {
    stdout: () => {},
    stderr: (s) => err.push(s),
    env: {},
    cwd: root,
    kubeAdmin: kube,
    build: build ?? mkSweep(),
    confirm: async (q) => {
      confirms.push(q);
      return confirm;
    },
  };
  return { io, err, confirms };
}

const ownNs = { "/namespace/myinst": { metadata: { name: "myinst", labels: { "jr2.dev/instance": "myinst" } } } };

test("down always confirms; declining leaves the cluster untouched", async () => {
  const kube = mkKube(ownNs);
  const w = await mkWorld(kube, false);
  assert.equal(await down([], w.io), 1);
  assert.equal(w.confirms.length, 1);
  assert.deepEqual(kube.deleted, []);
});

test("down deletes the instance's namespace; --all takes the operator too, BEFORE the sweep", async () => {
  const kube = mkKube(ownNs);
  const w = await mkWorld(kube, true);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(kube.deleted, ["/Namespace/myinst"]);

  // Order is the mechanism, not a detail: while the operator Deployment stands, its pod is a live
  // root and the operator image would survive its own uninstall.
  const kube2 = mkKube(ownNs);
  const sweep = mkSweep();
  const w2 = await mkWorld(kube2, true, sweep);
  assert.equal(await down(["--all"], w2.io), 0);
  assert.deepEqual(kube2.deleted, ["/Namespace/myinst", "(operator manifest)"]);
  assert.deepEqual(sweep.listed, ["host", "node test"], "the stores are read only once both roots are gone");
});

test("--all takes the Sandbox CRD with the operator, and the sweep still collects", async () => {
  // The case ADR-0039 cites for collecting kit images at all — the last instance leaves, so the
  // whole kit generation is unreachable — is also the one that deletes the `sandboxes.core.jr2.dev`
  // CRD moments before the roots read. `kubectl get sandboxes…` then exits 1, and reading that as
  // a failed root made `jr2 down --all` sweep NOTHING while narrating a warning and exiting 0.
  const sweep = mkSweep({
    host: [image({ id: "sha256:h", tags: ["jr2-harness:0f1e2d3c4b5a"], bytes: 238_000_000 })],
    node: [image({ id: "sha256:n", tags: ["docker.io/library/jr2-operator:99cc"], bytes: 77_000_000 })],
  });
  const w = await mkWorld(mkKube(ownNs), true, sweep);

  assert.equal(await down(["--all"], w.io), 0);
  assert.deepEqual(sweep.removed, ["host jr2-harness:0f1e2d3c4b5a", "node test-control-plane sha256:n"]);
  assert.match(w.err.join("\n"), /swept 2 image\(s\) \(315\.0 MB\)/);
  assert.ok(!/sweep failed/.test(w.err.join("\n")), "no CRD means no Sandbox CRs, not an unreadable root");
});

test("down sweeps what this instance's deleted roots stopped naming — and nothing another instance's still do", async () => {
  // What the two stores hold after a few converges on a shared cluster: this instance's images,
  // another instance's, the kit's — shared by both — and a registry-pushed copy of this instance's
  // own. The node's wear containerd's `docker.io/library/` namespace, because that is what `kind
  // load` normalizes an unqualified tag into.
  const node = [
    image({ id: "sha256:0", tags: ["docker.io/library/jr2-instance-myinst:aa11bb22cc33"], bytes: 400_000_000 }),
    image({ id: "sha256:1", tags: ["docker.io/library/jr2-instance-myinst:dd44ee55ff66"], bytes: 400_000_000 }),
    image({ id: "sha256:2", tags: ["docker.io/library/jr2-sandbox-myinst-default:99aa88bb77cc"], bytes: 200_000_000 }),
    image({ id: "sha256:3", tags: ["docker.io/library/jr2-instance-other:112233445566"], bytes: 1 }),
    image({ id: "sha256:4", tags: ["docker.io/library/jr2-sandbox-other-default:665544332211"], bytes: 1 }),
    image({ id: "sha256:5", tags: ["docker.io/library/jr2-harness:0f1e2d3c4b5a"], bytes: 1 }),
    image({ id: "sha256:6", tags: ["docker.io/library/jr2-adapter:5a4b3c2d1e0f"], bytes: 1 }),
    // A registry copy is CACHE and sweeps like everything else (ADR-0039) — the registry's own
    // retention stays the registry's business, but this node's copy is nobody's root.
    image({ id: "sha256:7", tags: ["reg.example.com/jr2-instance-myinst:aa11bb22cc33"], bytes: 1 }),
    // Not jr2's to take: no `jr2.dev/kind` stamp, so it is invisible on both sides.
    image({ id: "sha256:8", tags: ["docker.io/library/jr2-workspace-ancient:0000"], bytes: 1, labeled: false }),
  ];
  const sweep = mkSweep({ node, host: [image({ id: "sha256:h", tags: ["jr2-instance-myinst:aa11bb22cc33"] })] });
  // The surviving instance: its map names its own images AND the kit refs both instances share.
  const kube = mkKube(ownNs, {
    roots: {
      namespaces: ["other"],
      maps: {
        other: {
          harness: "jr2-harness:0f1e2d3c4b5a",
          adapter: "jr2-adapter:5a4b3c2d1e0f",
          sandbox: { default: "jr2-sandbox-other-default:665544332211" },
        },
      },
      pods: [
        {
          metadata: { name: "orch", namespace: "other" },
          spec: { containers: [{ image: "jr2-instance-other:112233445566" }] },
        },
      ],
    },
  });
  const w = await mkWorld(kube, true, sweep);
  assert.equal(await down([], w.io), 0);

  assert.deepEqual(sweep.removed, [
    "host jr2-instance-myinst:aa11bb22cc33",
    "node test-control-plane sha256:0",
    "node test-control-plane sha256:1",
    "node test-control-plane sha256:2",
    "node test-control-plane sha256:7",
  ]);
  const line = w.err.join("\n");
  // FOUR images, not five removals: the host's `jr2-instance-myinst:aa11bb22cc33` and the node's
  // `docker.io/library/…` copy of it are one image the user is told about once. The bytes stay
  // summed — two stores, two copies, two lots of the same disk.
  assert.match(line, /swept 4 image\(s\) \(1\.0 GB\)/, "bytes, because disk is the quantity the user feels");
  // Kit refs live because the surviving instance's map names them — not because kit images are
  // exempt (ADR-0039 dissolves that rule); another instance's own are protected the same way.
  assert.ok(!/jr2-harness|jr2-adapter/.test(line));
  assert.ok(!/other/.test(line));
  assert.ok(!/jr2-workspace-ancient/.test(line), "an unlabeled image is invisible — not swept, not reported");

  // After the namespace delete (which waits), which is what made this instance's images garbage.
  assert.deepEqual(kube.deleted, ["/Namespace/myinst"]);
});

test("down reports what a mixed image id kept in place, and still exits 0", async () => {
  // Two instances whose image trees are byte-identical share one image id on the node; `crictl
  // rmi` cannot untag, so the id is left whole and SAID — silence would read as "swept everything".
  const sweep = mkSweep({
    node: [
      image({
        id: "sha256:dd",
        tags: [
          "docker.io/library/jr2-sandbox-myinst-default:c0ccbf36fb77",
          "docker.io/library/jr2-sandbox-twin-default:c0ccbf36fb77",
        ],
      }),
    ],
  });
  const kube = mkKube(ownNs, {
    roots: {
      namespaces: ["twin"],
      maps: { twin: { sandbox: { default: "jr2-sandbox-twin-default:c0ccbf36fb77" } } },
    },
  });
  const w = await mkWorld(kube, true, sweep);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(sweep.removed, []);
  const line = w.err.join("\n");
  assert.match(line, /kept 1 tag\(s\).*jr2-sandbox-myinst-default:c0ccbf36fb77/);
  assert.ok(!/swept 1/.test(line));
});

test("a non-kind context still sweeps the host, and a failed sweep still exits 0", async () => {
  // Only the NODE half is kind-conditional: elsewhere the nodes pull from a registry, whose
  // retention is the registry's business — but the host daemon that BUILT the images is right here.
  const remote = mkSweep({ host: [image({ id: "sha256:h", tags: ["jr2-instance-myinst:aa11"], bytes: 10 })] });
  const w = await mkWorld(mkKube(ownNs, { context: "gke-prod" }), true, remote);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(remote.listed, ["host"], "images on a real cluster's nodes are not `jr2 down`'s to remove");
  assert.deepEqual(remote.removed, ["host jr2-instance-myinst:aa11"]);

  // The instance IS removed, which is what `down` promised — a sweep failure may not undo that.
  const broken = mkSweep({}, true);
  const w2 = await mkWorld(mkKube(ownNs), true, broken);
  assert.equal(await down([], w2.io), 0);
  assert.match(w2.err.join("\n"), /image sweep failed.*the instance is still removed/s);
});

test("down refuses a foreign namespace and errors when the instance isn't deployed here", async () => {
  const kube = mkKube({
    "/namespace/myinst": { metadata: { name: "myinst", labels: { "jr2.dev/instance": "other" } } },
  });
  const w = await mkWorld(kube, true);
  assert.equal(await down([], w.io), 1);
  assert.match(w.err.join("\n"), /another instance/);
  assert.deepEqual(kube.deleted, []);

  const kubeEmpty = mkKube({});
  const w2 = await mkWorld(kubeEmpty, true);
  assert.equal(await down([], w2.io), 1);
  assert.match(w2.err.join("\n"), /not deployed here/);
});

test("a Sandbox CR another instance parked keeps its image alive across this instance's removal", async () => {
  // A parked Workspace must survive a pod restart: `IfNotPresent` cannot re-pull a local tag, so
  // the CR's `spec.image` is a root in its own right, separate from any running pod (ADR-0039).
  const parked = "docker.io/library/jr2-sandbox-other-default:c0ffee123456";
  const sweep = mkSweep({ node: [image({ id: "sha256:p", tags: [parked], bytes: 5 })] });
  const kube = mkKube(ownNs, {
    roots: {
      namespaces: ["other"],
      sandboxes: [
        {
          metadata: { name: "ws-1", namespace: "other" },
          spec: { image: "jr2-sandbox-other-default:c0ffee123456" },
        },
      ],
    },
  });
  const w = await mkWorld(kube, true, sweep);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(sweep.removed, []);
});
