// `j2 down [--all]` (ADR-0019): remove the instance from the cluster. Always confirms; `--all`
// takes the per-cluster operator too. Foreign namespaces are refused, exactly like `up`. It also
// prunes this instance's images off a kind cluster's nodes (ADR-0038) — content addressing means
// abandoned images pile up invisibly, so the pruning is default, and its scoping is what these
// tests pin: this instance's tags only, never the kit's, never a registry's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { down } from "../src/commands/down.ts";
import { prunePlan, type BuildPort, type NodeImage } from "../src/build.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";
import type { Io } from "../src/output.ts";

function mkKube(
  objects: Record<string, Partial<KubeObject>>,
  context = "kind-test",
): KubeAdmin & { deleted: string[] } {
  const store = new Map(Object.entries(objects));
  const fake = {
    deleted: [] as string[],
    context: async () => context,
    getJson: async <T = KubeObject>(o: { kind: string; name: string; namespace?: string }) =>
      store.get(`${o.namespace ?? ""}/${o.kind.toLowerCase()}/${o.name}`) as T | undefined,
    apply: async () => assert.fail("down applies nothing"),
    label: async () => assert.fail("down labels nothing"),
    deleteObject: async (o: { kind: string; name: string; namespace?: string }) =>
      void fake.deleted.push(`${o.namespace ?? ""}/${o.kind}/${o.name}`),
    deleteManifest: async () => void fake.deleted.push("(operator manifest)"),
    waitRollout: async () => {},
    listJson: async () => assert.fail("down verifies no rollout") as never,
    runOneShot: async () => assert.fail("down probes nothing") as never,
  };
  return fake;
}

/** A build port whose only live verb is `kindPrune` — everything else fails, because `down` must
 * never build, push, or load. `nodeImages` is what containerd on the cluster's nodes holds, and the
 * fake answers through the REAL planner: the seam used to sit above it, which is how a prune that
 * matched nothing ever shipped green (the tags containerd holds are namespaced, ADR-0038). */
function mkPrune(
  nodeImages: NodeImage[],
  fails = false,
): BuildPort & { calls: Array<{ cluster: string; prefixes: string[] }> } {
  const port = {
    calls: [] as Array<{ cluster: string; prefixes: string[] }>,
    bundle: async () => assert.fail("down bundles nothing"),
    build: async () => assert.fail("down builds nothing"),
    run: async () => assert.fail("down runs nothing") as never,
    untag: async () => assert.fail("down untags nothing"),
    push: async () => assert.fail("down pushes nothing"),
    kindLoad: async () => assert.fail("down loads nothing"),
    kindPrune: async (cluster: string, prefixes: string[]) => {
      port.calls.push({ cluster, prefixes });
      if (fails) throw new Error("crictl: connection refused");
      const plan = prunePlan(nodeImages, prefixes);
      return { removed: plan.remove.flatMap((e) => e.tags), kept: plan.kept, failed: [] };
    },
  };
  return port;
}

async function mkWorld(kube: KubeAdmin, confirm: boolean, build?: BuildPort) {
  const root = await mkdtemp(join(tmpdir(), "j2-down-"));
  await writeFile(join(root, "j2.config.ts"), `export default { name: "myinst" };\n`);
  // The prune prefixes are derived from the DISCOVERED images (exact names, ADR-0038) — this
  // instance authored one Sandbox Image, `images/default`.
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
    build: build ?? mkPrune([]),
    confirm: async (q) => {
      confirms.push(q);
      return confirm;
    },
  };
  return { io, err, confirms };
}

const ownNs = { "/namespace/myinst": { metadata: { name: "myinst", labels: { "j2.dev/instance": "myinst" } } } };

test("down always confirms; declining leaves the cluster untouched", async () => {
  const kube = mkKube(ownNs);
  const w = await mkWorld(kube, false);
  assert.equal(await down([], w.io), 1);
  assert.equal(w.confirms.length, 1);
  assert.deepEqual(kube.deleted, []);
});

test("down deletes the instance's namespace; --all takes the operator too", async () => {
  const kube = mkKube(ownNs);
  const w = await mkWorld(kube, true);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(kube.deleted, ["/Namespace/myinst"]);

  const kube2 = mkKube(ownNs);
  const w2 = await mkWorld(kube2, true);
  assert.equal(await down(["--all"], w2.io), 0);
  assert.deepEqual(kube2.deleted, ["/Namespace/myinst", "(operator manifest)"]);
});

test("down prunes this instance's images off kind nodes — and only this instance's", async () => {
  const kube = mkKube(ownNs);
  // What a kind node's containerd actually holds after a few converges: this instance's images,
  // ANOTHER instance's — including one named `myinst-extra`, which an open-ended
  // `j2-sandbox-myinst-` prefix would have matched — the shared kit's, and a registry-pushed copy
  // of this instance's own. The local ones wear containerd's `docker.io/library/` namespace,
  // because that is what `kind load` normalizes an unqualified tag into.
  const tag = (t: string, i: number): NodeImage => ({ id: `sha256:${i}`, repoTags: [t] });
  const prune = mkPrune([
    tag("docker.io/library/j2-instance-myinst:aa11bb22cc33", 0),
    tag("docker.io/library/j2-instance-myinst:dd44ee55ff66", 1),
    tag("docker.io/library/j2-sandbox-myinst-default:99aa88bb77cc", 2),
    tag("docker.io/library/j2-instance-other:112233445566", 3),
    tag("docker.io/library/j2-sandbox-other-default:665544332211", 4),
    tag("docker.io/library/j2-sandbox-myinst-extra-default:314159265358", 5),
    tag("docker.io/library/j2-harness:0f1e2d3c4b5a", 6),
    tag("docker.io/library/j2-adapter:5a4b3c2d1e0f", 7),
    tag("reg.example.com/j2-instance-myinst:aa11bb22cc33", 8),
  ]);
  const w = await mkWorld(kube, true, prune);
  assert.equal(await down([], w.io), 0);

  // Exact, colon-terminated repo names per discovered image — one open-ended `j2-sandbox-myinst-`
  // also matched instance `myinst-extra`'s images on a shared node (ADR-0038).
  assert.deepEqual(prune.calls, [
    {
      cluster: "test",
      prefixes: ["j2-instance-myinst:", "j2-sandbox-myinst-default:", "j2-sandbox-myinst-default-base:"],
    },
  ]);
  const line = w.err.join("\n");
  assert.match(line, /pruned 3 image\(s\)/);
  assert.match(line, /j2-sandbox-myinst-default:99aa88bb77cc/, "every content-addressed iteration goes");
  // Kit images are shared by every instance on the cluster; another instance's are not ours —
  // `myinst-extra` above all; and a registry-pushed tag is the registry's business.
  assert.ok(!/j2-harness|j2-adapter/.test(line));
  assert.ok(!/other|extra/.test(line));
  assert.ok(!/reg\.example\.com/.test(line));

  // After the namespace delete (which waits), so containerd is no longer holding them.
  assert.deepEqual(kube.deleted, ["/Namespace/myinst"]);
});

test("down reports what a mixed image id kept in place, and still exits 0", async () => {
  // Two instances whose image trees are byte-identical share one image id on the node; `crictl
  // rmi` cannot untag, so the id is left whole and SAID (build.ts prunePlan) — silence would read
  // as "pruned everything".
  const prune = mkPrune([
    {
      id: "sha256:dd",
      repoTags: [
        "docker.io/library/j2-sandbox-myinst-default:c0ccbf36fb77",
        "docker.io/library/j2-sandbox-twin-default:c0ccbf36fb77",
      ],
    },
  ]);
  const w = await mkWorld(mkKube(ownNs), true, prune);
  assert.equal(await down([], w.io), 0);
  const line = w.err.join("\n");
  assert.match(line, /kept 1 tag\(s\).*j2-sandbox-myinst-default:c0ccbf36fb77/);
  assert.ok(!/pruned/.test(line));
});

test("down prunes nothing off a non-kind context, and a failed prune still exits 0", async () => {
  const remote = mkPrune([]);
  const w = await mkWorld(mkKube(ownNs, "gke-prod"), true, remote);
  assert.equal(await down([], w.io), 0);
  assert.deepEqual(remote.calls, [], "images on a real cluster's nodes are not `j2 down`'s to remove");

  // The instance IS removed, which is what `down` promised — a prune failure may not undo that.
  const broken = mkPrune([], true);
  const w2 = await mkWorld(mkKube(ownNs), true, broken);
  assert.equal(await down([], w2.io), 0);
  assert.match(w2.err.join("\n"), /image prune failed.*the instance is still removed/s);
});

test("down refuses a foreign namespace and errors when the instance isn't deployed here", async () => {
  const kube = mkKube({
    "/namespace/myinst": { metadata: { name: "myinst", labels: { "j2.dev/instance": "other" } } },
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
