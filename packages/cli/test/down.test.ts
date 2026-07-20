// `j2 down [--all]` (ADR-0019): remove the instance from the cluster. Always confirms; `--all`
// takes the per-cluster operator too. Foreign namespaces are refused, exactly like `up`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { down } from "../src/commands/down.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";
import type { Io } from "../src/output.ts";

function mkKube(objects: Record<string, Partial<KubeObject>>): KubeAdmin & { deleted: string[] } {
  const store = new Map(Object.entries(objects));
  const fake = {
    deleted: [] as string[],
    context: async () => "kind-test",
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

async function mkWorld(kube: KubeAdmin, confirm: boolean) {
  const root = await mkdtemp(join(tmpdir(), "j2-down-"));
  await writeFile(join(root, "j2.config.ts"), `export default { name: "myinst" };\n`);
  const err: string[] = [];
  const confirms: string[] = [];
  const io: Io = {
    stdout: () => {},
    stderr: (s) => err.push(s),
    env: {},
    cwd: root,
    kubeAdmin: kube,
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
