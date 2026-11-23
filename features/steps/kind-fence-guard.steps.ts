// jr2's admission policies of the Fence against a real API server (ADR-0084). Multus gives a pod each
// attachment that its annotations name, of any namespace, so the policies are the guard: a pod may
// name an attachment of the Fence only from its own Instance's namespace, in the one text form, and
// only an Instance's namespace may hold an attachment on the bridge. Each check here is a
// server-side dry run, which makes nothing: no pod takes an attachment, and a scenario beside this
// one sees no change. The UPDATE checks are dry-run patches of pods that are there.

import { Given, Then, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { E2EWorld } from "./world.ts";

const ANNOTATIONS: Record<string, string> = {
  "default-network": "v1.multus-cni.io/default-network",
  networks: "k8s.v1.cni.cncf.io/networks",
};

/** The configs of the NetworkAttachmentDefinition table, by the words of its `config` column. */
const CONFIGS: Record<string, string> = {
  "bridge jr2fence0": JSON.stringify({ cniVersion: "1.0.0", name: "c", type: "bridge", bridge: "jr2fence0" }),
  "macvlan on jr2fence0": JSON.stringify({ cniVersion: "1.0.0", name: "c", type: "macvlan", master: "jr2fence0" }),
  // `jr2fence0` with its `f` as a JSON escape: the plugin reads the same name.
  "bridge jr2fence0 through an escape": '{"cniVersion":"1.0.0","name":"c","type":"bridge","bridge":"jr2\\u0066ence0"}',
  "bridge br0": JSON.stringify({ cniVersion: "1.0.0", name: "c", type: "bridge", bridge: "br0" }),
};

/** The peer namespace of each World: another Instance's namespace, with no Instance in it. */
const peers = new WeakMap<E2EWorld, string>();

function run(args: string[], input?: string): Promise<{ ok: boolean; said: string }> {
  return new Promise((resolve) => {
    const child = execFile("kubectl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: err === null, said: `${stdout}${stderr}`.trim() }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** What the API server did: `admit`, `deny <policy>`, or the refusal of something else. */
function answerOf(r: { ok: boolean; said: string }): string {
  if (r.ok) return "admit";
  const policy = /ValidatingAdmissionPolicy '([^']+)' with binding '[^']+' denied request/.exec(r.said)?.[1];
  return policy !== undefined ? `deny ${policy}` : `error: ${r.said.split("\n")[0]}`;
}

function namespaceOf(world: E2EWorld, word: string): string {
  if (word === "own") return world.namespace!;
  if (word === "peer") return peers.get(world)!;
  return word;
}

const fill = (world: E2EWorld, value: string): string =>
  value.replaceAll("{own}", world.namespace!).replaceAll("{peer}", peers.get(world)!);

Given(
  "a namespace that carries the label of an Instance and holds no Instance",
  async function (this: E2EWorld): Promise<void> {
    const peer = `${this.namespace}-peer`;
    peers.set(this, peer);
    const made = await run(["create", "namespace", peer]);
    assert.ok(made.ok, made.said);
    this.closers.push(async () => {
      await run(["delete", "namespace", peer, "--ignore-not-found", "--wait=false"]);
    });
    const labeled = await run(["label", "namespace", peer, "jr2.dev/instance=peer"]);
    assert.ok(labeled.ok, labeled.said);
  },
);

Then(
  "the API server answers each server-side dry run of a pod as the table says",
  { timeout: 300_000 },
  async function (this: E2EWorld, table: DataTable): Promise<void> {
    const wrong: string[] = [];
    for (const row of table.hashes() as Array<Record<string, string>>) {
      const ns = namespaceOf(this, row.namespace!);
      const key = ANNOTATIONS[row.annotation!]!;
      const value = fill(this, row.value!);
      let r: { ok: boolean; said: string };
      if (row.request === "create") {
        const pod = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { generateName: "jr2-guard-check-", namespace: ns, annotations: { [key]: value } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "c",
                image: "registry.k8s.io/pause:3.10",
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
            ],
          },
        };
        r = await run(["create", "--dry-run=server", "-f", "-"], JSON.stringify(pod));
      } else {
        // A pod that is there: the first one of the namespace.
        const listed = await run(["-n", ns, "get", "pods", "-o", "jsonpath={.items[0].metadata.name}"]);
        assert.ok(listed.ok && listed.said !== "", `a pod in ${ns} to patch: ${listed.said}`);
        const patch = JSON.stringify({ metadata: { annotations: { [key]: value } } });
        r = await run([
          "-n",
          ns,
          "patch",
          "pod",
          listed.said,
          "--type=merge",
          "-p",
          patch,
          "--dry-run=server",
          ...(row.request === "status" ? ["--subresource=status"] : []),
        ]);
      }
      const got = answerOf(r);
      const want = row.answer === "admit" ? "admit" : "deny jr2-fence-guard-pods";
      if (got !== want) wrong.push(`${row.namespace} ${row.request} ${row.annotation}=${value}: ${got}, not ${want}`);
    }
    assert.deepEqual(wrong, []);
  },
);

Then(
  "the API server answers each server-side dry run of a NetworkAttachmentDefinition as the table says",
  { timeout: 120_000 },
  async function (this: E2EWorld, table: DataTable): Promise<void> {
    const wrong: string[] = [];
    for (const row of table.hashes() as Array<Record<string, string>>) {
      const ns = namespaceOf(this, row.namespace!);
      const nad = {
        apiVersion: "k8s.cni.cncf.io/v1",
        kind: "NetworkAttachmentDefinition",
        metadata: { name: row.name, namespace: ns },
        spec: { config: CONFIGS[row.config!] },
      };
      assert.ok(nad.spec.config !== undefined, `a config named "${row.config}"`);
      const got = answerOf(await run(["create", "--dry-run=server", "-f", "-"], JSON.stringify(nad)));
      const want = row.answer === "admit" ? "admit" : "deny jr2-fence-guard-attachments";
      if (got !== want) wrong.push(`${row.namespace} ${row.name} (${row.config}): ${got}, not ${want}`);
    }
    assert.deepEqual(wrong, []);
  },
);
