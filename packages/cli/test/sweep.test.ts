// The reachability half of ADR-0039: what the cluster's live roots name. `build.ts` decides what to
// do with a keep set; this decides what is IN one. Two claims dominate — the union is read
// cluster-wide (a ref any instance names is not garbage), and a roots read that could not see
// everything must fail rather than hand back a smaller keep set, because "smaller" here means
// "deletes another instance's images".

import { test } from "node:test";
import assert from "node:assert/strict";
import { kindCluster, readRoots } from "../src/sweep.ts";
import type { KubeAdmin } from "../src/kube.ts";

type Listing = {
  namespaces?: string[];
  maps?: Record<string, unknown>;
  sandboxes?: Array<{
    metadata: { name: string; namespace?: string };
    spec?: { image?: string; sidecars?: Array<{ image?: string }> };
  }>;
  /** The cluster has no Sandbox CRD at all — what `j2 down --all` leaves behind, and what any
   * cluster the operator never reached looks like. kubectl's own words. */
  noSandboxCrd?: boolean;
  pods?: Array<{
    metadata: { name: string; namespace?: string };
    spec?: {
      containers?: Array<{ image?: string }>;
      initContainers?: Array<{ image?: string }>;
      ephemeralContainers?: Array<{ image?: string }>;
    };
  }>;
  /** Which read blows up, as an absent CRD, a forbidden verb, or an unreachable API all do. */
  fails?: "namespace" | "configmap" | "sandboxes" | "pod";
};

/** Only `listJson` matters here — the roots are the only thing the sweep asks a cluster for. */
function mkKube(listing: Listing): KubeAdmin & { queries: string[] } {
  const kube = {
    queries: [] as string[],
    context: async () => "kind-test",
    getJson: async () => assert.fail("the roots are LISTED — getJson reads a failure as absence"),
    apply: async () => assert.fail("the sweep applies nothing"),
    label: async () => assert.fail("the sweep labels nothing"),
    deleteObject: async () => assert.fail("the sweep deletes no objects"),
    deleteManifest: async () => assert.fail("the sweep deletes no objects"),
    waitRollout: async () => assert.fail("the sweep waits for nothing"),
    logs: async () => assert.fail("the sweep reads no logs") as never,
    runOneShot: async () => assert.fail("the sweep probes nothing") as never,
    listJson: async <T>(o: { kind: string; selector?: string; fieldSelector?: string; allNamespaces?: boolean }) => {
      kube.queries.push(`${o.kind}${o.selector ? ` -l ${o.selector}` : ""}${o.allNamespaces ? " -A" : ""}`);
      const which = o.kind.startsWith("sandboxes") ? "sandboxes" : o.kind;
      if (listing.fails === which) throw new Error(`the server could not answer for ${which}`);
      if (which === "sandboxes" && listing.noSandboxCrd) {
        throw new Error(
          `Command failed: kubectl get ${o.kind}\nerror: the server doesn't have a resource type "sandboxes"`,
        );
      }
      if (o.kind === "namespace") return (listing.namespaces ?? []).map((name) => ({ metadata: { name } })) as T[];
      if (o.kind === "configmap") {
        return Object.entries(listing.maps ?? {}).map(([namespace, map]) => ({
          metadata: { name: "j2-images", namespace },
          data: { "images.json": typeof map === "string" ? map : JSON.stringify(map) },
        })) as T[];
      }
      if (which === "sandboxes") return (listing.sandboxes ?? []) as T[];
      if (o.kind === "pod") return (listing.pods ?? []) as T[];
      return [];
    },
  };
  return kube;
}

test("the keep set is the union of the three roots, across every instance on the cluster", async () => {
  const kube = mkKube({
    namespaces: ["myinst", "other"],
    maps: {
      myinst: {
        harness: "j2-harness:0f1e",
        adapter: "j2-adapter:5a4b",
        operator: "j2-operator:99cc",
        sandbox: { default: "j2-sandbox-myinst-default:aa11", extra: "j2-sandbox-myinst-extra:bb22" },
      },
      other: { harness: "j2-harness:0f1e", adapter: "j2-adapter:5a4b", sandbox: {} },
    },
    // A PARKED Workspace: no pod may be running, but `IfNotPresent` cannot re-pull a local tag.
    sandboxes: [{ metadata: { name: "ws-1", namespace: "myinst" }, spec: { image: "j2-sandbox-myinst-old:cc33" } }],
    pods: [
      {
        metadata: { name: "orch", namespace: "myinst" },
        spec: { containers: [{ image: "j2-instance-myinst:dd44" }] },
      },
      // The operator lives in the shared `j2-system`, which is not an instance namespace and is
      // still a root — otherwise `up` would sweep the image of the controller it just rolled out.
      {
        metadata: { name: "manager", namespace: "j2-system" },
        spec: { containers: [{ image: "j2-operator:99cc" }] },
      },
    ],
  });

  const { keep, namespaces } = await readRoots(kube);
  assert.deepEqual(namespaces, ["myinst", "other"]);
  assert.deepEqual(
    [...keep].sort(),
    [
      "j2-adapter:5a4b",
      "j2-harness:0f1e",
      "j2-instance-myinst:dd44",
      "j2-operator:99cc",
      "j2-sandbox-myinst-default:aa11",
      "j2-sandbox-myinst-extra:bb22",
      "j2-sandbox-myinst-old:cc33",
    ],
    "one ref, however many roots name it",
  );
  assert.deepEqual(kube.queries, [
    "namespace -l j2.dev/instance",
    "configmap -A",
    "sandboxes.core.j2.dev -A",
    "pod -A",
  ]);
});

test("objects outside an instance namespace are not roots — labels decide, not proximity", async () => {
  // A namespace with no `j2.dev/instance` label is somebody else's; its `j2-images`-shaped
  // ConfigMap and its pods say nothing about what j2 still needs.
  const kube = mkKube({
    namespaces: ["myinst"],
    maps: { myinst: { harness: "j2-harness:0f1e", sandbox: {} }, stranger: { harness: "j2-harness:beef" } },
    sandboxes: [{ metadata: { name: "ws", namespace: "stranger" }, spec: { image: "j2-sandbox-x:1" } }],
    pods: [{ metadata: { name: "p", namespace: "stranger" }, spec: { containers: [{ image: "j2-instance-x:1" }] } }],
  });
  const { keep } = await readRoots(kube);
  assert.deepEqual([...keep], ["j2-harness:0f1e"]);
});

test("a pod's init and ephemeral containers hold images too, and a terminating pod still counts", async () => {
  // The opposite of `verifyRunningImage`, deliberately: that asks what the cluster runs NOW, while
  // a keep set asks what still HOLDS an image. For a mid-roll pod the conservative answer is yes.
  const kube = mkKube({
    namespaces: ["myinst"],
    pods: [
      {
        metadata: { name: "sandbox-1", namespace: "myinst" },
        spec: {
          containers: [{ image: "j2-sandbox-myinst-default:aa11" }, { image: "j2-adapter:5a4b" }],
          initContainers: [{ image: "j2-instance-myinst:dd44" }],
          ephemeralContainers: [{ image: "busybox:1" }],
        },
      },
    ],
  });
  const { keep } = await readRoots(kube);
  assert.deepEqual([...keep].sort(), [
    "busybox:1",
    "j2-adapter:5a4b",
    "j2-instance-myinst:dd44",
    "j2-sandbox-myinst-default:aa11",
  ]);
});

test("a roots read that could not see everything THROWS — a partial keep set is a wrong one", async () => {
  // Every ref a failed read would have named reads as garbage, so degrading to "what I could see"
  // deletes another instance's images. Fail closed, at every one of the four reads.
  for (const fails of ["namespace", "configmap", "sandboxes", "pod"] as const) {
    await assert.rejects(
      () => readRoots(mkKube({ namespaces: ["myinst"], fails })),
      /could not answer/,
      `a failed ${fails} read must not yield a smaller keep set`,
    );
  }
});

test("a Sandbox's SIDECAR refs are roots too — the Adapter's is on the CR and nowhere else", async () => {
  // A running Sandbox is deliberately never re-imaged, so after an `up` that rebuilt the Adapter
  // the map names the new ref while the CR still names the old one. Lose that pod (node restart,
  // eviction, drain) and the replacement is created from the CR — with `IfNotPresent`, which
  // cannot re-pull a local tag. The map (root 1) names the new one; only the CR names the old.
  const kube = mkKube({
    namespaces: ["myinst"],
    maps: { myinst: { adapter: "j2-adapter:new0", sandbox: {} } },
    sandboxes: [
      {
        metadata: { name: "ws-1", namespace: "myinst" },
        spec: { image: "j2-sandbox-myinst-default:aa11", sidecars: [{ image: "j2-adapter:0ld0" }] },
      },
    ],
  });
  const { keep } = await readRoots(kube);
  assert.deepEqual([...keep].sort(), ["j2-adapter:0ld0", "j2-adapter:new0", "j2-sandbox-myinst-default:aa11"]);
});

test("a cluster with no Sandbox CRD has no Sandboxes — the one read that may answer 'none'", async () => {
  // `j2 down --all` deletes the operator manifest, CRD included, and only THEN sweeps — the very
  // case ADR-0039 cites for collecting kit images. A throw there is a sweep that takes nothing on
  // the one run that has the most to take. No CRD means no Sandbox CRs can exist, so "none" is the
  // complete answer, not a partial one; every other failure still throws (the test above).
  const kube = mkKube({
    namespaces: ["myinst"],
    maps: { myinst: { harness: "j2-harness:0f1e", sandbox: {} } },
    noSandboxCrd: true,
  });
  const { keep } = await readRoots(kube);
  assert.deepEqual([...keep], ["j2-harness:0f1e"]);
});

test("an unreadable image map is a failed root, not an empty one", async () => {
  // A hand-edited ConfigMap must not be read as "that instance needs nothing".
  const kube = mkKube({ namespaces: ["myinst"], maps: { myinst: "{ not json" } });
  await assert.rejects(() => readRoots(kube), /j2-images ConfigMap in namespace "myinst" is not JSON/);
});

test("nodes exist to sweep only on a kind context", async () => {
  assert.equal(kindCluster("kind-j2"), "j2");
  assert.equal(kindCluster("gke-prod"), undefined);
  assert.equal(kindCluster("kind-"), "");
});
