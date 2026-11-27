// jr2's admission policies of the Fence against a real API server (ADR-0084). Multus gives a pod each
// attachment that its annotations name, of any namespace, so the policies are the guard: a pod may
// name an attachment of the Fence only from its own Instance's namespace, in the one text form, and
// only an Instance's namespace may hold an attachment on the bridge. Each check here is a
// server-side dry run, which makes nothing: no pod takes an attachment, and a scenario beside this
// one sees no change. The UPDATE checks are dry-run patches of pods that are there. The Binding
// checks are dry-run Bindings of a pod that no node can take, so no pod is bound. Each row is also
// judged by the rule in TypeScript that the audit of `jr2 up` uses, so that it and the CEL cannot
// drift apart: each row sets or changes a value, so that rule, which judges a CREATE, gives the same
// answer.

import { Given, Then, type DataTable } from "@cucumber/cucumber";
import { attachmentGuardRefusal, podGuardRefusal, type GuardNamespace } from "@jr2/cli";
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

/** A namespace as the policies read it, from the API server. */
async function guardNamespace(name: string): Promise<GuardNamespace> {
  const r = await run(["get", "namespace", name, "-o", "json"]);
  assert.ok(r.ok, r.said);
  const labels = (JSON.parse(r.said) as { metadata: { labels?: Record<string, string> } }).metadata.labels;
  return { name, ...(labels !== undefined ? { labels } : {}) };
}

/** A pod that passes the restricted Pod Security level. */
const checkPod = (metadata: Record<string, unknown>, spec: Record<string, unknown> = {}) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata,
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
    ...spec,
  },
});

/** A pod in `ns` that no node can take, with no annotation: the target of the dry-run Bindings. */
async function unboundPod(world: E2EWorld, made: Map<string, string>, ns: string): Promise<string> {
  const known = made.get(ns);
  if (known !== undefined) return known;
  const name = `jr2-guard-unbound-${process.pid}`;
  const pod = checkPod({ name, namespace: ns }, { nodeSelector: { "jr2.dev/no-node": "none" } });
  const r = await run(["create", "-f", "-"], JSON.stringify(pod));
  assert.ok(r.ok, r.said);
  world.closers.push(async () => {
    await run(["-n", ns, "delete", "pod", name, "--ignore-not-found", "--wait=false"]);
  });
  made.set(ns, name);
  return name;
}

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
    const unbound = new Map<string, string>();
    const node = await run(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    assert.ok(node.ok && node.said !== "", node.said);
    for (const row of table.hashes() as Array<Record<string, string>>) {
      const ns = namespaceOf(this, row.namespace!);
      const key = ANNOTATIONS[row.annotation!];
      const value = fill(this, row.value!);
      const annotations: Record<string, string> = key !== undefined ? { [key]: value } : {};
      let r: { ok: boolean; said: string };
      if (row.request === "create") {
        const pod = checkPod({ generateName: "jr2-guard-check-", namespace: ns, annotations });
        r = await run(["create", "--dry-run=server", "-f", "-"], JSON.stringify(pod));
      } else if (row.request === "binding" || row.request === "bindings") {
        // A Binding's annotations are merged into its pod. `binding` is the subresource
        // pods/<pod>/binding, as the scheduler uses it; `bindings` is the older resource.
        const pod = await unboundPod(this, unbound, ns);
        const binding = {
          apiVersion: "v1",
          kind: "Binding",
          metadata: { name: pod, namespace: ns, annotations },
          target: { apiVersion: "v1", kind: "Node", name: node.said },
        };
        const path =
          row.request === "binding"
            ? `/api/v1/namespaces/${ns}/pods/${pod}/binding`
            : `/api/v1/namespaces/${ns}/bindings`;
        r = await run(["create", "--raw", `${path}?dryRun=All`, "-f", "-"], JSON.stringify(binding));
      } else {
        assert.ok(key !== undefined, `an annotation for the request ${row.request}`);
        // `change`: the pod of the namespace that has the annotation already, so its value changes.
        // Else a pod that is there: the first one of the namespace.
        const listed = await run(["-n", ns, "get", "pods", "-o", "json"]);
        assert.ok(listed.ok, listed.said);
        const pods = (
          JSON.parse(listed.said) as {
            items: Array<{ metadata: { name: string; annotations?: Record<string, string> } }>;
          }
        ).items;
        const target =
          row.request === "change" ? pods.find((p) => p.metadata.annotations?.[key] !== undefined) : pods[0];
        assert.ok(target !== undefined, `a pod in ${ns} to patch for the request ${row.request}`);
        if (row.request === "change") assert.notEqual(target.metadata.annotations![key], value);
        const patch = JSON.stringify({ metadata: { annotations } });
        r = await run([
          "-n",
          ns,
          "patch",
          "pod",
          target.metadata.name,
          "--type=merge",
          "-p",
          patch,
          "--dry-run=server",
          ...(row.request === "status" ? ["--subresource=status"] : []),
        ]);
      }
      const got = answerOf(r);
      const want = row.answer === "admit" ? "admit" : "deny jr2-fence-guard-pods";
      const label = `${row.namespace} ${row.request} ${row.annotation}=${value}`;
      if (got !== want) wrong.push(`${label}: ${got}, not ${want}`);
      const ts =
        podGuardRefusal(annotations, await guardNamespace(ns)) === undefined ? "admit" : "deny jr2-fence-guard-pods";
      if (ts !== want) wrong.push(`${label}: the rule of the audit says ${ts}, not ${want}`);
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
      const label = `${row.namespace} ${row.name} (${row.config})`;
      if (got !== want) wrong.push(`${label}: ${got}, not ${want}`);
      const ts =
        attachmentGuardRefusal(row.name!, nad.spec.config, await guardNamespace(ns)) === undefined
          ? "admit"
          : "deny jr2-fence-guard-attachments";
      if (ts !== want) wrong.push(`${label}: the rule of the audit says ${ts}, not ${want}`);
    }
    assert.deepEqual(wrong, []);
  },
);
