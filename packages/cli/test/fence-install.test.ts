// The Fence's prerequisites (ADR-0084, ADR-0019): what `jr2 up` reads from the cluster before it
// asks, each refusal, the question's text, the fence node's DaemonSet, the wait for it, the install
// and the removal. Through a fake API; the scripts run here against folders in a temp dir, with a
// fake `nft` and fake plugins.

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  awaitFenceNodes,
  BRIDGE_MIN_VERSION,
  CNI_VERSION,
  describeInstall,
  FENCE_RULES,
  fenceNodeDaemonSet,
  installFence,
  eventPrint,
  firstCniOf,
  multusManifest,
  MULTUS_VERSION,
  planAsks,
  planFenceInstall,
  PLUGINS_SCRIPT,
  RULES_REMOVE_SCRIPT,
  RULES_SCRIPT,
  selects,
  uninstallFence,
  type FenceInstallPlan,
} from "../src/fence-install.ts";
import { KIT_VERSION } from "../src/deploy.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";

const exec = promisify(execFile);
const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

// ---- a fake API --------------------------------------------------------------------------------------

type Obj = Record<string, unknown> & {
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
};

const GENERATION = "deprecated.daemonset.template.generation";

/** A cluster: objects by `<namespace>/<kind>/<name>`, the CRDs it has, and the lists it answers. A
 * kind in `refuse` fails each list of it with Forbidden, as the API does for a user with no read. */
function cluster(
  objects: Obj[] = [],
  crds: Array<string | { name: string; annotations: Record<string, string> }> = [],
  refuse: string[] = [],
) {
  const store = new Map<string, Obj>();
  const key = (ns: string | undefined, kind: string, name: string) => `${ns ?? ""}/${kind}/${name}`;
  for (const o of objects) store.set(key(o.metadata.namespace, String(o.kind).toLowerCase(), o.metadata.name), o);
  const kube = {
    applied: [] as string[],
    rollouts: [] as string[],
    reads: [] as string[],
    pods: [] as unknown[],
    events: [] as unknown[],
    store,
    async getJson<T = KubeObject>(o: { kind: string; name: string; namespace?: string }): Promise<T | undefined> {
      kube.reads.push(`get ${o.kind} ${o.namespace ?? ""}/${o.name}`);
      return store.get(key(o.namespace, o.kind, o.name)) as T | undefined;
    },
    async listJson<T>(o: {
      kind: string;
      selector?: string;
      fieldSelector?: string;
      namespace?: string;
      allNamespaces?: boolean;
    }): Promise<T[]> {
      kube.reads.push(`list ${o.kind} ${o.selector ?? o.fieldSelector ?? ""}`);
      if (refuse.includes(o.kind)) {
        throw new Error(`Error from server (Forbidden): ${o.kind} is forbidden: User "u" cannot list resource`);
      }
      if (o.kind === "customresourcedefinition") {
        const name = o.fieldSelector!.replace("metadata.name=", "");
        const found = crds.find((c) => (typeof c === "string" ? c : c.name) === name);
        if (found === undefined) return [];
        return [{ metadata: typeof found === "string" ? { name } : found }] as T[];
      }
      if (o.kind === "pod") return kube.pods as T[];
      if (o.kind === "event") return kube.events as T[];
      const named = o.fieldSelector?.startsWith("metadata.name=") ? o.fieldSelector.slice(14) : undefined;
      const [k, v] = (o.selector ?? "").split("=");
      return [...store.values()].filter(
        (x) =>
          String(x.kind).toLowerCase() === o.kind &&
          (o.namespace === undefined || x.metadata.namespace === o.namespace) &&
          (named === undefined || x.metadata.name === named) &&
          (o.selector === undefined || (x.metadata as { labels?: Record<string, string> }).labels?.[k!] === v),
      ) as T[];
    },
    /** An apply of a DaemonSet stores it, as the API does: a new one gets a uid and template
     * generation 1; one that is there keeps both (a test sets a generation where it needs one). */
    async apply(o: { manifest: string }): Promise<void> {
      kube.applied.push(o.manifest);
      let obj: Obj | undefined;
      try {
        obj = JSON.parse(o.manifest) as Obj;
      } catch {
        return;
      }
      if (obj.kind !== "DaemonSet") return;
      const k = key(obj.metadata.namespace, "daemonset", obj.metadata.name);
      const was = store.get(k);
      store.set(k, {
        ...obj,
        metadata: {
          ...obj.metadata,
          uid: (was?.metadata as { uid?: string } | undefined)?.uid ?? "uid-1",
          annotations: {
            ...obj.metadata.annotations,
            [GENERATION]: was?.metadata.annotations?.[GENERATION] ?? "1",
          },
        } as Obj["metadata"],
      });
    },
    async waitRollout(o: { kind?: string; name: string; namespace: string }): Promise<void> {
      kube.rollouts.push(`${o.namespace}/${o.kind}/${o.name}`);
    },
    deleted: [] as string[],
    /** What the DaemonSet's controller makes in place of a deleted pod: by default the same pod with a
     * new name, as a pod that started after the delete. */
    replacePod: (pod: any): any => ({ ...pod, metadata: { ...pod.metadata, name: `${pod.metadata.name}-new` } }),
    async deleteObject(o: { kind: string; name: string; namespace?: string }): Promise<void> {
      kube.deleted.push(`${o.namespace ?? ""}/${o.kind}/${o.name}`);
      store.delete(key(o.namespace, o.kind, o.name));
      if (o.kind === "pod") {
        kube.pods = kube.pods.map((p: any) => (p.metadata?.name === o.name ? kube.replacePod(p) : p));
      }
    },
    async deleteManifest(o: { manifest: string }): Promise<void> {
      kube.deleted.push(o.manifest === "" ? "" : "manifest");
    },
  };
  return kube as typeof kube &
    Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout" | "deleteObject" | "deleteManifest">;
}

/** A plan, with the parts that a test does not name at their values for a cluster that has jr2-system. */
const planOf = (p: Pick<FenceInstallPlan, "multus" | "node"> & Partial<FenceInstallPlan>): FenceInstallPlan => ({
  system: "present",
  guard: "present",
  notes: [],
  ...p,
});

const node = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, labels } });

const ATTACHMENT_CRD = "network-attachment-definitions.k8s.cni.cncf.io";

const jr2Multus = (version = MULTUS_VERSION): Obj => ({
  kind: "DaemonSet",
  metadata: {
    name: "kube-multus-ds",
    namespace: "kube-system",
    labels: { app: "multus" },
    annotations: { "jr2.dev/multus": version },
  },
});

const nodeDs = (version = KIT_VERSION, image = "jr2-operator:1", generation = "1"): Obj => ({
  kind: "DaemonSet",
  metadata: {
    name: "jr2-fence-node",
    namespace: "jr2-system",
    uid: "uid-1",
    labels: { app: "jr2-fence-node", "jr2.dev/version": version },
    annotations: { [GENERATION]: generation },
  } as Obj["metadata"],
  spec: { template: { spec: { containers: [{ image }] } } },
});

/** The four objects of jr2's admission guard, as the cluster has them. */
const guard = (version = KIT_VERSION): Obj[] =>
  ["jr2-fence-guard-pods", "jr2-fence-guard-attachments"].flatMap((name) => [
    { kind: "ValidatingAdmissionPolicy", metadata: { name, labels: { "jr2.dev/version": version } } },
    { kind: "ValidatingAdmissionPolicyBinding", metadata: { name, labels: { "jr2.dev/version": version } } },
  ]);

// ---- the read ------------------------------------------------------------------------------------------

test("a stock cluster: the policies, Multus and the fence node are installed, and the question lists each part, what it can do, and what a later converge does", async () => {
  const plan = await planFenceInstall(cluster(), { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "install", node: "install", guard: "install", system: "create", notes: [] });
  assert.equal(planAsks(plan), true);
  assert.deepEqual(describeInstall(plan), [
    "fence: this converge installs the Fence's prerequisites (ADR-0084):",
    "  - the namespace jr2-system.",
    "  - the DaemonSet jr2-system/jr2-fence-node, on each Linux node. Its pod runs as root on the node's network. " +
      "At each start, it:",
    '      - loads the rule table "inet jr2_fence" into the node\'s nftables, with the capability NET_ADMIN alone;',
    "      - runs the node's /opt/cni/bin/bridge, if the node has one, to read its version;",
    "      - writes the CNI plugins bridge, static, tuning v1.10.0 into /opt/cni/bin where the node has no file of " +
      "that name (it never replaces a file).",
    "  - the ValidatingAdmissionPolicies jr2-fence-guard-pods and jr2-fence-guard-attachments, each with a " +
      "ValidatingAdmissionPolicyBinding of the same name: cluster-wide objects. They refuse a pod that names an " +
      "attachment of the Fence (the prefix jr2-fence-) from outside its Instance's namespace, through " +
      "v1.multus-cni.io/default-network or k8s.v1.cni.cncf.io/networks, and a NetworkAttachmentDefinition on the " +
      "bridge jr2fence0 outside an Instance's namespace.",
    "  - Multus v4.3.2 (thick), from the manifest that the CLI ships: a cluster-wide CustomResourceDefinition and " +
      "ClusterRole, and a privileged DaemonSet kube-system/kube-multus-ds. Multus writes the first CNI " +
      "configuration of each node, so the cluster makes each new pod through Multus.",
    "  A later jr2 up of a newer Kit changes the DaemonSet jr2-fence-node and the policies to its version, and does " +
      "not ask. It asks before it changes the Multus that jr2 installs.",
    "  jr2 down --all removes the rule table, the bridge jr2fence0 that the bridge plugin makes, the DaemonSet, the " +
      "policies with their bindings, and the Multus that jr2 installs. It keeps that Multus while the cluster has a " +
      "NetworkAttachmentDefinition of another owner. The plugin files and the kernel module 8021q stay on the nodes.",
  ]);
  assert.doesNotMatch(describeInstall(plan)!.join("\n"), /namespaceIsolation|global namespace/);
  // A cluster that has jr2-system (the operator of another Instance): no line for the namespace.
  const system = await planFenceInstall(cluster([{ kind: "Namespace", metadata: { name: "jr2-system" } }]), {
    nodes: [],
  });
  assert.equal(system.system, "present");
  assert.doesNotMatch(describeInstall(system)!.join("\n"), /the namespace jr2-system\./);
});

test("a cluster that has jr2's Multus, the fence node and the policies: nothing to ask; another version of jr2's Multus is an update that asks; a missing policy or binding asks", async () => {
  const plan = await planFenceInstall(cluster([jr2Multus(), nodeDs(), ...guard()]), { nodes: [node("n1")] });
  assert.deepEqual([plan.multus, plan.node, plan.guard], ["jr2", "present", "present"]);
  assert.equal(planAsks(plan), false);
  assert.equal(describeInstall(plan), undefined);
  // The policies of an older or a newer Kit are there: no question (the converge applies its version).
  const older = await planFenceInstall(cluster([jr2Multus("v4.2.0-thick-1"), nodeDs(), ...guard("0.0.1")]), {
    nodes: [],
  });
  assert.deepEqual([older.multus, older.node, older.guard], ["upgrade", "present", "present"]);
  assert.match(
    describeInstall(older)!.join("\n"),
    new RegExp(
      `\\n {2}- an update of the Multus that jr2 installed to ${MULTUS_VERSION}, from the manifest that the CLI ships: a cluster-wide`,
    ),
  );
  assert.doesNotMatch(
    describeInstall(older)!.join("\n"),
    /DaemonSet jr2-system\/jr2-fence-node, on each|ValidatingAdmission/,
  );
  // One binding is missing: the guard is installed, and the question says so.
  const partial = await planFenceInstall(cluster([jr2Multus(), nodeDs(), ...guard().slice(0, 3)]), { nodes: [] });
  assert.equal(partial.guard, "install");
  assert.match(describeInstall(partial)!.join("\n"), /the ValidatingAdmissionPolicies jr2-fence-guard-pods and/);
});

test("a cluster with Multus's definition and no DaemonSet of jr2's has a Multus of another owner: jr2 uses it, reads none of its settings, and the question says that jr2 never changes it", async () => {
  const kube = cluster([], [ATTACHMENT_CRD]);
  const plan = await planFenceInstall(kube, { nodes: [node("n1")] });
  assert.deepEqual([plan.multus, plan.node, plan.guard], ["foreign", "install", "install"]);
  // jr2 reads no ConfigMap and no Multus DaemonSet's settings: only the lists of the plan.
  assert.deepEqual(
    kube.reads.filter((r) => !/^list (daemonset|customresourcedefinition|namespace|validatingadmissionpolicy)/.test(r)),
    [],
  );
  const said = describeInstall(plan)!;
  assert.doesNotMatch(said.join("\n"), /Multus v4|update of the Multus/);
  assert.deepEqual(said.slice(-2), [
    "  A later jr2 up of a newer Kit changes the DaemonSet jr2-fence-node and the policies to its version, and does " +
      "not ask. It never changes the cluster's Multus, which jr2 did not install.",
    "  jr2 down --all removes the rule table, the bridge jr2fence0 that the bridge plugin makes, the DaemonSet, and " +
      "the policies with their bindings. The plugin files and the kernel module 8021q stay on the nodes.",
  ]);
  // A Multus DaemonSet of another owner with no definition is not read either: the definition decides.
  const upstream: Obj = {
    kind: "DaemonSet",
    metadata: { name: "kube-multus-ds", namespace: "kube-system", labels: { app: "multus" } },
  };
  assert.equal((await planFenceInstall(cluster([upstream], [ATTACHMENT_CRD]), { nodes: [] })).multus, "foreign");
});

test("a definition with jr2's annotation and no DaemonSet of jr2's is jr2's Multus that an earlier apply left half done: jr2 installs it again", async () => {
  const kube = cluster([], [{ name: ATTACHMENT_CRD, annotations: { "jr2.dev/multus": MULTUS_VERSION } }]);
  assert.equal((await planFenceInstall(kube, { nodes: [] })).multus, "install");
});

test("the shipped Multus manifest has jr2's annotation on its DaemonSet and on its CustomResourceDefinition, and keeps namespaceIsolation as a second barrier", async () => {
  const text = await multusManifest();
  const docs = text.split("\n---");
  const crd = docs.find((d) => /\nkind: CustomResourceDefinition\n/.test(d))!;
  const ds = docs.find((d) => /\nkind: DaemonSet\n/.test(d))!;
  assert.match(crd, new RegExp(`\\n {4}jr2\\.dev/multus: ${MULTUS_VERSION}\\n`));
  assert.match(ds, new RegExp(`\\n {4}jr2\\.dev/multus: ${MULTUS_VERSION}\\n`));
  assert.match(text, /"namespaceIsolation": true/);
});

test("a read of the plan that fails throws: a part that jr2 cannot read is never taken for absent", async () => {
  for (const kind of ["daemonset", "customresourcedefinition", "namespace", "validatingadmissionpolicy"]) {
    await assert.rejects(planFenceInstall(cluster([], [], [kind]), { nodes: [] }), /Forbidden/, kind);
  }
});

test("refusal (b): Cilium with cni-exclusive true, in its ConfigMap or in a CiliumNodeConfig of a Sandbox node", async () => {
  const cilium: Obj = {
    kind: "DaemonSet",
    metadata: { name: "cilium", namespace: "kube-system", labels: { "k8s-app": "cilium" } },
  };
  const ciliumConfig = (value: string): Obj => ({
    kind: "ConfigMap",
    metadata: { name: "cilium-config", namespace: "kube-system" },
    data: { "cni-exclusive": value },
  });
  await assert.rejects(
    planFenceInstall(cluster([cilium, ciliumConfig("true")]), { nodes: [node("n1"), node("n2")] }),
    (e: Error) => {
      assert.equal(
        e.message,
        'fence: Cilium has cni-exclusive: "true" in the ConfigMap kube-system/cilium-config, so Cilium removes ' +
          "each other CNI configuration on the Sandbox nodes n1, n2, and Multus cannot give a pod the Fence " +
          '(ADR-0084). Set cni-exclusive: "false" in that ConfigMap (with Helm: --set cni.exclusive=false), restart ' +
          "the Cilium agents (kubectl -n kube-system rollout restart daemonset/cilium), then run `jr2 up` again. " +
          "Nothing was applied.",
      );
      return true;
    },
  );
  // Cilium's own default when the key is absent is not read as exclusive: only the value "true" refuses.
  assert.equal(
    (await planFenceInstall(cluster([cilium, ciliumConfig("false")]), { nodes: [node("n1")] })).multus,
    "install",
  );

  const cnc = (name: string, value: string, selector: object): Obj => ({
    kind: "ciliumnodeconfigs.cilium.io",
    metadata: { name, namespace: "kube-system" },
    spec: { nodeSelector: selector, defaults: { "cni-exclusive": value } },
  });
  const crd = ["ciliumnodeconfigs.cilium.io"];
  // A CiliumNodeConfig that sets false for the Sandbox nodes overrides the ConfigMap's true.
  const sandbox = { matchLabels: { pool: "sandbox" } };
  await planFenceInstall(cluster([cilium, ciliumConfig("true"), cnc("sb", "false", sandbox)], crd), {
    nodes: [node("n1", { pool: "sandbox" })],
  });
  // One that sets true for a Sandbox node refuses and names it.
  await assert.rejects(
    planFenceInstall(cluster([cilium, ciliumConfig("false"), cnc("strict", "true", sandbox)], crd), {
      nodes: [node("n1", { pool: "sandbox" }), node("n2")],
    }),
    /cni-exclusive: "true" for the Sandbox node n1 in the CiliumNodeConfig kube-system\/strict.*Set "cni-exclusive": "false" in spec\.defaults of the CiliumNodeConfig kube-system\/strict/s,
  );
  // One for other nodes changes nothing here.
  await planFenceInstall(cluster([cnc("other", "true", { matchLabels: { pool: "gpu" } })], crd), {
    nodes: [node("n1", { pool: "sandbox" })],
  });
});

test("refusal (b): Cilium in another namespace is found by its DaemonSet; a read that the API refuses is a note, not a pass in silence; no Cilium passes", async () => {
  const agent = (namespace: string): Obj => ({
    kind: "DaemonSet",
    metadata: { name: "cilium", namespace, labels: { "k8s-app": "cilium" } },
    spec: { template: { spec: { containers: [{ name: "cilium-agent", image: "quay.io/cilium/cilium:v1.18.0" }] } } },
  });
  const config = (namespace: string, value: string): Obj => ({
    kind: "ConfigMap",
    metadata: { name: "cilium-config", namespace },
    data: { "cni-exclusive": value },
  });
  await assert.rejects(
    planFenceInstall(cluster([agent("cilium"), config("cilium", "true")]), { nodes: [node("n1")] }),
    /Cilium has cni-exclusive: "true" in the ConfigMap cilium\/cilium-config.*kubectl -n cilium rollout restart daemonset\/cilium/s,
  );
  // A ConfigMap in kube-system with no Cilium DaemonSet there is not Cilium's: no Cilium, no refusal.
  assert.equal(
    (await planFenceInstall(cluster([config("kube-system", "true")]), { nodes: [node("n1")] })).multus,
    "install",
  );
  // The read is refused: a note that says so, and no refusal.
  const plan = await planFenceInstall(cluster([agent("kube-system")], [], ["configmap"]), { nodes: [node("n1")] });
  assert.equal(plan.notes.length, 1);
  assert.match(
    plan.notes[0]!,
    /^fence: jr2 cannot read the ConfigMap kube-system\/cilium-config \(Error from server \(Forbidden\).*\), so it cannot tell whether Cilium has cni-exclusive: "true"/,
  );
  const cnc = await planFenceInstall(
    cluster([agent("kube-system")], ["ciliumnodeconfigs.cilium.io"], ["ciliumnodeconfigs.cilium.io"]),
    {
      nodes: [node("n1")],
    },
  );
  assert.match(cnc.notes[0]!, /^fence: jr2 cannot read the CiliumNodeConfigs/);
});

test("a node selector: matchLabels and each operator of matchExpressions; empty selects each node", () => {
  assert.equal(selects(undefined, { a: "1" }), true);
  assert.equal(selects({}, {}), true);
  assert.equal(selects({ matchLabels: { a: "1" } }, { a: "1", b: "2" }), true);
  assert.equal(selects({ matchLabels: { a: "1" } }, { a: "2" }), false);
  const e = (operator: string, values?: string[]) => ({ matchExpressions: [{ key: "a", operator, values }] });
  assert.equal(selects(e("In", ["1", "2"]), { a: "2" }), true);
  assert.equal(selects(e("In", ["1"]), {}), false);
  assert.equal(selects(e("NotIn", ["1"]), { a: "1" }), false);
  assert.equal(selects(e("NotIn", ["1"]), {}), true);
  assert.equal(selects(e("Exists"), { a: "" }), true);
  assert.equal(selects(e("DoesNotExist"), { a: "" }), false);
});

// ---- the fence node's DaemonSet ------------------------------------------------------------------------

const RESTRICTED = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };

test("the fence node's DaemonSet: the operator image on the node's network, NET_ADMIN for the rules alone, the two CNI folders only, on each node", () => {
  const ds = fenceNodeDaemonSet("ghcr.io/snapwich/jr2-operator:9.9.9") as Record<string, any>;
  assert.equal(ds.metadata.name, "jr2-fence-node");
  assert.equal(ds.metadata.namespace, "jr2-system");
  assert.equal(ds.metadata.labels["jr2.dev/version"], KIT_VERSION);
  const spec = ds.spec.template.spec;
  assert.equal(spec.hostNetwork, true, "the rule table is the node's network namespace's");
  for (const key of ["hostPID", "hostIPC", "serviceAccountName", "priorityClassName"]) {
    assert.equal(spec[key], undefined, key);
  }
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual(spec.securityContext, { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: "RuntimeDefault" } });
  assert.deepEqual(spec.tolerations, [
    { operator: "Exists", effect: "NoSchedule" },
    { operator: "Exists", effect: "NoExecute" },
  ]);
  assert.deepEqual(spec.volumes, [
    { name: "cni-bin", hostPath: { path: "/opt/cni/bin", type: "Directory" } },
    { name: "cni-conf", hostPath: { path: "/etc/cni/net.d", type: "Directory" } },
  ]);
  assert.deepEqual(
    spec.initContainers.map((c: { name: string }) => c.name),
    ["rules", "install"],
    "the table first, so that each node gets it, also a node that the checks of install then refuse",
  );
  const [rules, install] = spec.initContainers;
  assert.deepEqual(rules.securityContext, { ...RESTRICTED, capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] } });
  assert.deepEqual(rules.command, ["sh", "-c", RULES_SCRIPT]);
  assert.equal(rules.volumeMounts, undefined, "the rules container mounts nothing of the node");
  assert.deepEqual(install.securityContext, RESTRICTED);
  assert.deepEqual(
    spec.containers[0].securityContext,
    { ...RESTRICTED, runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true },
    "the idle container is not root",
  );
  for (const c of [...spec.initContainers, ...spec.containers]) {
    assert.equal(c.image, "ghcr.io/snapwich/jr2-operator:9.9.9");
    assert.equal(c.securityContext.privileged, undefined);
  }
  assert.deepEqual(install.volumeMounts, [
    { name: "cni-bin", mountPath: "/host/opt/cni/bin" },
    { name: "cni-conf", mountPath: "/host/etc/cni/net.d", readOnly: true },
  ]);
  assert.equal(spec.containers[0].volumeMounts, undefined, "the idle container mounts nothing of the node");

  // The removal form: one init container, which removes the table, and no node folder.
  const remove = fenceNodeDaemonSet("jr2-operator:1", { remove: true }) as Record<string, any>;
  const rspec = remove.spec.template.spec;
  assert.deepEqual(
    rspec.initContainers.map((c: { name: string; command: string[] }) => [c.name, c.command[2]]),
    [["rules", RULES_REMOVE_SCRIPT]],
  );
  assert.equal(rspec.volumes, undefined);
  assert.equal(rspec.hostNetwork, true);
});

test("the rule table, as nft reads it: a table of four base chains, each with its hook and priority, whose rules name the bridge jr2fence0 alone and drop or skip conntrack only", () => {
  // Parse the text as nft's grammar has it: `table <family> <name> { chain <name> { type ...; policy ...; <rules> } }`.
  const table = /^table (\w+) (\w+) \{\n([\s\S]*)\n\}$/.exec(FENCE_RULES);
  assert.ok(table, "one table");
  assert.deepEqual([table[1], table[2]], ["inet", "jr2_fence"], "the inet family: IPv4 and IPv6 alike");
  const chains = new Map<string, { hook: string; priority: number; policy: string; rules: string[] }>();
  for (const m of table[3]!.matchAll(
    /chain (\w+) \{\n\s+type filter hook (\w+) priority (-?\d+); policy (\w+);\n([^}]*)\}/g,
  )) {
    const rules = m[5]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    chains.set(m[1]!, { hook: m[2]!, priority: Number(m[3]), policy: m[4]!, rules });
  }
  assert.equal((FENCE_RULES.match(/\bchain \w+ \{/g) ?? []).length, chains.size, "each chain is a base chain");
  const hooks = Object.fromEntries([...chains.values()].map((c) => [c.hook, c.priority]));
  // notrack runs before conntrack (-200) and NAT (-100): no NAT of the node sees a Sandbox's packet.
  assert.ok(hooks.prerouting! < -200, "prerouting before conntrack");
  // The drops come at the filter hooks of the node's own stack and of routing.
  assert.deepEqual(Object.keys(hooks).sort(), ["forward", "input", "output", "prerouting"]);
  for (const c of chains.values()) {
    assert.equal(c.policy, "accept", "the table changes nothing that does not touch the bridge");
    assert.ok(c.rules.length > 0);
    for (const r of c.rules) {
      assert.match(r, /(iif|oif)name (!= )?"jr2fence0"/, "each rule names the bridge");
      assert.match(r, /\b(notrack|drop)$/, "each rule skips conntrack or drops");
    }
  }
  const pre = [...chains.values()].find((c) => c.hook === "prerouting")!;
  assert.deepEqual(pre.rules, ['iifname "jr2fence0" counter notrack']);
  const forward = [...chains.values()].find((c) => c.hook === "forward")!;
  assert.equal(forward.rules.length, 2, "both directions between the bridge and another interface");
});

/** A temp folder with a fake `nft` that writes each stdin it gets, and the chains of a list. */
async function fakeNft(opts: { fail?: string; chains?: number } = {}): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-fence-nft-"));
  roots.push(dir);
  await mkdir(join(dir, "bin"));
  const chains = Array.from({ length: opts.chains ?? 4 }, (_, i) => `\tchain c${i} {`).join("\\n");
  await writeFile(
    join(dir, "bin/nft"),
    `#!/bin/sh
if [ "$1" = "-f" ]; then
  n=$(ls ${dir} | grep -c '^load-' || true)
  cat > ${dir}/load-$n
  ${opts.fail ? `echo "${opts.fail}" >&2; exit 1` : "exit 0"}
fi
if [ "$1" = list ]; then printf 'table inet jr2_fence {\\n${chains}\\n}\\n'; fi
`,
  );
  await chmod(join(dir, "bin/nft"), 0o755);
  return { dir, path: `${join(dir, "bin")}:${process.env.PATH}` };
}

// ---- the scripts, under the host's sh and under busybox ------------------------------------------------

/** The base of the operator image, whose busybox runs the scripts in the pod. */
const BUSYBOX_IMAGE = "alpine:3.21";
const DOCKER = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 }).status === 0;
type Shell = "sh" | "busybox";
/** The shell of the script test that runs now (the tests of a file run one at a time). */
let shell: Shell = "sh";
let busybox: string | undefined;
after(async () => {
  if (busybox !== undefined) await exec("docker", ["rm", "-f", busybox]).catch(() => {});
});

/** One container of the operator image's base, with the temp folder at the same path, as this user. */
async function busyboxContainer(): Promise<string> {
  if (busybox !== undefined) return busybox;
  const { stdout } = await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--user",
    `${process.getuid!()}:${process.getgid!()}`,
    "-v",
    `${tmpdir()}:${tmpdir()}`,
    BUSYBOX_IMAGE,
    "sleep",
    "3600",
  ]);
  busybox = stdout.trim();
  return busybox;
}

/**
 * A test of a script, run twice: under the host's sh, and under busybox in the operator image's base
 * (alpine:3.21), as the pod runs it. With no docker, the busybox run is skipped and says why.
 */
function scriptTest(name: string, fn: () => Promise<void>): void {
  test(`${name} [host sh]`, async () => {
    shell = "sh";
    await fn();
  });
  test(
    `${name} [busybox, ${BUSYBOX_IMAGE}]`,
    { skip: DOCKER ? false : `docker is absent, so this script does not run under busybox (${BUSYBOX_IMAGE}) here` },
    async () => {
      shell = "busybox";
      try {
        await fn();
      } finally {
        shell = "sh";
      }
    },
  );
}

async function runWith(
  script: string,
  dir: string,
  env: Record<string, string> = {},
): Promise<{ code: number; message: string }> {
  const text = script.replaceAll("/dev/termination-log", `${dir}/message`);
  const run =
    shell === "sh"
      ? exec("sh", ["-c", text], { env: { ...process.env, ...env } })
      : exec("docker", [
          "exec",
          ...Object.entries({ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...env }).flatMap(
            ([k, v]) => ["-e", `${k}=${v}`],
          ),
          await busyboxContainer(),
          "sh",
          "-c",
          text,
        ]);
  const code = await run.then(
    () => 0,
    (e: { code?: number }) => e.code ?? 1,
  );
  return { code, message: await readFile(join(dir, "message"), "utf8").catch(() => "") };
}

scriptTest(
  "the rules script loads the table in one transaction that replaces it, each time the same, and fails with nft's reason",
  async () => {
    const nft = await fakeNft();
    const first = await runWith(RULES_SCRIPT, nft.dir, { PATH: nft.path });
    assert.deepEqual(first, { code: 0, message: "jr2.fence-node ok rules=loaded\n" });
    const second = await runWith(RULES_SCRIPT, nft.dir, { PATH: nft.path });
    assert.equal(second.code, 0);
    const load0 = await readFile(join(nft.dir, "load-0"), "utf8");
    // One `nft -f` input, so one transaction: it makes the table (a no-op when the node has it), deletes
    // it, and makes it again with each chain. No window with no rule, and no rule twice.
    const lines = load0.split("\n");
    assert.deepEqual(lines.slice(0, 2), ["table inet jr2_fence", "delete table inet jr2_fence"]);
    assert.equal(lines[2], "table inet jr2_fence {");
    for (const hook of [
      "prerouting priority -350",
      "input priority -200",
      "forward priority -200",
      "output priority -200",
    ]) {
      assert.ok(load0.includes(`type filter hook ${hook}; policy accept;`), hook);
    }
    assert.equal(await readFile(join(nft.dir, "load-1"), "utf8"), load0, "each load is the same");

    const refused = await fakeNft({ fail: "Error: Could not process rule: Operation not permitted" });
    const no = await runWith(RULES_SCRIPT, refused.dir, { PATH: refused.path });
    assert.equal(no.code, 1);
    assert.equal(
      no.message,
      "jr2.fence-node fail rules nft could not load the table inet jr2_fence: Error: Could not process rule: Operation not permitted \n",
    );
    const short = await fakeNft({ chains: 3 });
    const three = await runWith(RULES_SCRIPT, short.dir, { PATH: short.path });
    assert.equal(three.code, 1);
    assert.match(three.message, /fail rules the table inet jr2_fence has 3 chains after the load, not 4/);
  },
);

/**
 * A fake `ip` beside the fake `nft`, as busybox's prints `ip -o link show`: the node's links are the
 * lines of the file `links`. `ip link delete <name>` removes that link's line (or fails as `fail`
 * says), and `ip link show <name>` fails when the link is gone. Each call is written to `ip-calls`.
 */
async function fakeIp(dir: string, links: string[], opts: { fail?: string; list?: string } = {}): Promise<void> {
  await writeFile(join(dir, "links"), links.map((l) => `${l}\n`).join(""));
  await writeFile(
    join(dir, "bin/ip"),
    `#!/bin/sh
echo "$*" >> ${dir}/ip-calls
if [ "$1" = -o ]; then
  ${opts.list ? `echo "${opts.list}" >&2; exit 1` : `cat ${dir}/links; exit 0`}
fi
if [ "$1 $2" = "link delete" ]; then
  ${opts.fail ? `echo "${opts.fail}" >&2; exit 1` : `grep -v "^[0-9]*: $3[:@]" ${dir}/links > ${dir}/links.new || true; mv ${dir}/links.new ${dir}/links; exit 0`}
fi
if [ "$1 $2" = "link show" ]; then grep -q "^[0-9]*: $3[:@]" ${dir}/links; exit $?; fi
exit 2
`,
  );
  await chmod(join(dir, "bin/ip"), 0o755);
}

const LO =
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000\\    link/loopback 00:00:00:00:00:00";
const BR =
  "7: jr2fence0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN qlen 1000\\    link/ether 9e:2b:7a:05:44:05";
const port = (n: number, name: string) =>
  `${n}: ${name}@if3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master jr2fence0 state UP \\    link/ether 4a:1c:00:00:00:0${n}`;
/** A link of another bridge, whose name starts as the Fence's: not the Fence's bridge, not its port. */
const OTHER = "9: jr2fence0x: <BROADCAST> mtu 1500 qdisc noop state DOWN\\    link/ether 00:00:00:00:00:09";

scriptTest(
  "the removal script removes the table whether the node has it or not, then the bridge jr2fence0 when it has no port",
  async () => {
    const nft = await fakeNft();
    await fakeIp(nft.dir, [LO, BR, OTHER]);
    assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, nft.dir, { PATH: nft.path }), {
      code: 0,
      message: "jr2.fence-node ok rules=removed bridge=removed\n",
    });
    assert.equal(
      await readFile(join(nft.dir, "load-0"), "utf8"),
      "table inet jr2_fence\ndelete table inet jr2_fence\n",
    );
    assert.deepEqual((await readFile(join(nft.dir, "ip-calls"), "utf8")).trim().split("\n"), [
      "-o link show",
      "link delete jr2fence0",
    ]);
    assert.equal(await readFile(join(nft.dir, "links"), "utf8"), `${LO}\n${OTHER}\n`, "only the Fence's bridge goes");

    // A second run, or a node where no pod joined the Fence: no bridge is a success, and nothing is deleted.
    assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, nft.dir, { PATH: nft.path }), {
      code: 0,
      message: "jr2.fence-node ok rules=removed bridge=absent\n",
    });
    assert.doesNotMatch((await readFile(join(nft.dir, "ip-calls"), "utf8")).split("\n").slice(2).join("\n"), /delete/);
  },
);

scriptTest(
  "the removal script keeps a bridge that has a port and names the ports; an error of ip keeps it too and says why; only the table fails the pod",
  async () => {
    const busy = await fakeNft();
    await fakeIp(busy.dir, [LO, BR, port(8, "veth1a2b"), port(9, "vethc3d4")]);
    assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, busy.dir, { PATH: busy.path }), {
      code: 0,
      message: "jr2.fence-node ok rules=removed bridge=kept ports=veth1a2b,vethc3d4\n",
    });
    assert.doesNotMatch(await readFile(join(busy.dir, "ip-calls"), "utf8"), /delete/, "a bridge with a port stays");

    const refused = await fakeNft();
    await fakeIp(refused.dir, [LO, BR], { fail: "ip: RTNETLINK answers: Operation not permitted" });
    assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, refused.dir, { PATH: refused.path }), {
      code: 0,
      message: "jr2.fence-node ok rules=removed bridge=kept error=ip: RTNETLINK answers: Operation not permitted \n",
    });

    const unread = await fakeNft();
    await fakeIp(unread.dir, [LO, BR], { list: "ip: can't open netlink socket" });
    assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, unread.dir, { PATH: unread.path }), {
      code: 0,
      message:
        "jr2.fence-node ok rules=removed bridge=kept error=ip could not list the node's links: ip: can't open netlink socket \n",
    });

    // The table fails the pod, before the bridge is touched.
    const noTable = await fakeNft({ fail: "Error: Operation not permitted" });
    await fakeIp(noTable.dir, [LO, BR]);
    const failed = await runWith(RULES_REMOVE_SCRIPT, noTable.dir, { PATH: noTable.path });
    assert.equal(failed.code, 1);
    assert.match(failed.message, /^jr2\.fence-node fail rules nft could not remove the table inet jr2_fence: /);
    assert.equal(await readFile(join(noTable.dir, "ip-calls"), "utf8").catch(() => ""), "");
  },
);

test("the operator image has busybox's ip, which deletes a link with NET_ADMIN alone: no iproute2 is added", async () => {
  const dockerfile = await readFile(join(import.meta.dirname, "../../../operator/Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM alpine:\S+$/m, "alpine's busybox has the applet ip");
});

/** A plugin that prints what a stock plugin prints with no CNI_COMMAND. */
const plugin = (name: string, version = "v1.10.0") =>
  `#!/bin/sh\necho "CNI ${name} plugin ${version}" >&2\necho "CNI protocol versions supported: 1.1.0" >&2\n`;

/** Run the plugins' script with its folders under `dir` (the script's paths, rewritten), with no wait
 * for the node's CNI folders unless `wait` says so. */
async function runScript(dir: string, env: Record<string, string> = {}): Promise<{ code: number; message: string }> {
  const script = PLUGINS_SCRIPT.replaceAll("/host/", `${dir}/host/`).replace("SRC=/opt/jr2/cni/bin", `SRC=${dir}/src`);
  return runWith(script, dir, { JR2_CNI_WAIT: "0", ...env });
}

/** A node's CNI configuration file: one plugin of that type. */
const conf = (type: string) => JSON.stringify({ cniVersion: "1.0.0", name: "n", plugins: [{ type }] });

async function nodeDirs(opts: {
  conf?: Record<string, string> | string[];
  bin?: Record<string, string>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-fence-node-"));
  roots.push(dir);
  await mkdir(join(dir, "host/opt/cni/bin"), { recursive: true });
  await mkdir(join(dir, "host/etc/cni/net.d"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  for (const p of ["bridge", "static", "tuning"]) await writeFile(join(dir, "src", p), plugin(p), { mode: 0o755 });
  const confs = Array.isArray(opts.conf)
    ? Object.fromEntries(opts.conf.map((f) => [f, conf("ptp")]))
    : (opts.conf ?? {});
  for (const [f, text] of Object.entries(confs)) await writeFile(join(dir, "host/etc/cni/net.d", f), text);
  for (const [f, text] of Object.entries(opts.bin ?? {})) {
    await writeFile(join(dir, "host/opt/cni/bin", f), text, { mode: 0o755 });
  }
  return dir;
}

scriptTest(
  "the plugins' script writes each missing plugin, executable, keeps each file of that name, and says which, the bridge's version and the node's first CNI configuration",
  async () => {
    const dir = await nodeDirs({
      conf: ["10-kindnet.conflist", "99-other.conf"],
      bin: { loopback: "x", static: "theirs" },
    });
    const run = await runScript(dir);
    assert.equal(run.code, 0);
    assert.equal(
      run.message.trim(),
      "jr2.fence-node ok wrote=bridge tuning kept=static bridge=v1.10.0 cni=10-kindnet.conflist type=ptp",
    );
    const bin = join(dir, "host/opt/cni/bin");
    assert.deepEqual(
      (await readdir(bin)).sort(),
      ["bridge", "loopback", "static", "tuning"],
      "no temporary file stays",
    );
    assert.equal(await readFile(join(bin, "static"), "utf8"), "theirs", "a file of that name is never replaced");
    assert.equal(await readFile(join(bin, "bridge"), "utf8"), plugin("bridge"));
    // A second run (a pod again on the node) keeps each.
    assert.equal(
      (await runScript(dir)).message.trim(),
      "jr2.fence-node ok wrote= kept=bridge static tuning bridge=v1.10.0 cni=10-kindnet.conflist type=ptp",
    );
    // A Multus's configuration first: its type is in the line, for `jr2 up` to read.
    const multus = await nodeDirs({
      conf: { "00-multus.conf": JSON.stringify({ type: "multus-shim" }), "10-kindnet.conflist": conf("ptp") },
      bin: { loopback: "x" },
    });
    assert.match((await runScript(multus)).message, / cni=00-multus\.conf type=multus-shim\n$/);
  },
);

scriptTest(
  "the plugins' script never replaces a file that appears after its check: ln, not a move, and the file of the node is kept",
  async () => {
    const dir = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { loopback: "x" } });
    const bin = join(dir, "host/opt/cni/bin");
    // A `cp` that, as it copies static, lets another tool put a file of that name in place.
    const tools = join(dir, "tools");
    await mkdir(tools);
    await writeFile(
      join(tools, "cp"),
      `#!/bin/sh\ncase "$2" in *.static.jr2-new) printf theirs > ${bin}/static ;; esac\nexec /bin/cp "$@"\n`,
      { mode: 0o755 },
    );
    const run = await runScript(dir, { PATH: `${tools}:${process.env.PATH}` });
    assert.equal(run.code, 0, run.message);
    assert.match(run.message, /ok wrote=bridge tuning kept=static /);
    assert.equal(await readFile(join(bin, "static"), "utf8"), "theirs");
    assert.deepEqual((await readdir(bin)).sort(), ["bridge", "loopback", "static", "tuning"]);
  },
);

scriptTest("the plugins' script says why a write fails", async () => {
  const dir = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { loopback: "x" } });
  await rm(join(dir, "src/tuning"));
  const run = await runScript(dir);
  assert.equal(run.code, 1);
  assert.match(
    run.message,
    /^jr2\.fence-node fail write cannot write tuning into \/opt\/cni\/bin on the node: .*tuning/,
  );
  assert.deepEqual((await readdir(join(dir, "host/opt/cni/bin"))).sort(), ["bridge", "loopback", "static"]);
});

scriptTest(
  `the plugins' script refuses a bridge of the node older than v${BRIDGE_MIN_VERSION}, or one whose version it cannot read, keeps it, and writes nothing then`,
  async () => {
    for (const [version, ok] of [
      ["v1.8.0", true],
      ["v1.9.1", true],
      ["v2.0.0", true],
      ["v1.7.1", false],
      ["v1.3.0", false],
      ["v0.9.1", false],
    ] as const) {
      const dir = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { bridge: plugin("bridge", version) } });
      const run = await runScript(dir);
      assert.equal(run.code, ok ? 0 : 1, version);
      assert.equal(
        run.message.trim(),
        ok
          ? `jr2.fence-node ok wrote=static tuning kept=bridge bridge=${version} cni=10-kindnet.conflist type=ptp`
          : `jr2.fence-node fail bridge /opt/cni/bin/bridge is ${version}, older than v${BRIDGE_MIN_VERSION}`,
      );
      assert.equal(await readFile(join(dir, "host/opt/cni/bin/bridge"), "utf8"), plugin("bridge", version));
      if (!ok)
        assert.deepEqual(await readdir(join(dir, "host/opt/cni/bin")), ["bridge"], "a refused node gets no plugin");
    }
    const unknown = await nodeDirs({
      conf: ["10-kindnet.conflist"],
      bin: { bridge: '#!/bin/sh\necho "CNI bridge plugin version unknown" >&2\n' },
    });
    const run = await runScript(unknown);
    assert.equal(run.code, 1);
    assert.equal(
      run.message.trim(),
      "jr2.fence-node fail bridge /opt/cni/bin/bridge prints no version (it printed: CNI bridge plugin version unknown)",
    );
  },
);

scriptTest(
  "the plugins' script waits for the node's CNI configuration (a new node), and fails, and says why, on a node whose CNI folders are not the default ones",
  async () => {
    const noConf = await runScript(await nodeDirs({ conf: [], bin: { loopback: "x" } }));
    assert.equal(noConf.code, 1);
    assert.match(
      noConf.message,
      /^jr2\.fence-node fail folder no CNI configuration in \/etc\/cni\/net\.d on the node after 0 s/,
    );
    const noBin = await runScript(await nodeDirs({ conf: ["05-cilium.conflist"] }));
    assert.equal(noBin.code, 1);
    assert.match(noBin.message, /^jr2\.fence-node fail folder \/opt\/cni\/bin on the node is empty after 0 s/);
    // The primary CNI writes its configuration while the script waits: no refusal.
    const late = await nodeDirs({ conf: [], bin: { loopback: "x" } });
    const running = runScript(late, { JR2_CNI_WAIT: "20" });
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(join(late, "host/etc/cni/net.d/10-calico.conflist"), conf("calico"));
    const run = await running;
    assert.equal(run.code, 0, run.message);
    assert.match(run.message, / cni=10-calico\.conflist type=calico\n$/);
  },
);

scriptTest(
  "the rules script writes a result line with its cause when the table has no chain after the load, or nft cannot list it",
  async () => {
    const none = await fakeNft({ chains: 0 });
    const zero = await runWith(RULES_SCRIPT, none.dir, { PATH: none.path });
    assert.deepEqual(zero, {
      code: 1,
      message: "jr2.fence-node fail rules the table inet jr2_fence has 0 chains after the load, not 4\n",
    });
    const unlisted = await fakeNft();
    await writeFile(
      join(unlisted.dir, "bin/nft"),
      `#!/bin/sh\nif [ "$1" = "-f" ]; then cat > /dev/null; exit 0; fi\necho "Error: No such file or directory" >&2; exit 1\n`,
    );
    const list = await runWith(RULES_SCRIPT, unlisted.dir, { PATH: unlisted.path });
    assert.equal(list.code, 1);
    assert.equal(
      list.message,
      "jr2.fence-node fail rules nft could not list the table inet jr2_fence after the load: Error: No such file or directory \n",
    );
  },
);

scriptTest(
  "the plugins' script takes a link as a plugin that the node has: it never replaces one, runs a link to a file beside it, and refuses a link that it cannot run, with the link and its target",
  async () => {
    // A link to a file in another folder of the node: the pod sees only /opt/cni/bin, so it cannot run it.
    const outside = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { loopback: "x" } });
    const bin = join(outside, "host/opt/cni/bin");
    await exec("ln", ["-s", "/usr/libexec/cni/bridge", join(bin, "bridge")]);
    const run = await runScript(outside);
    assert.equal(run.code, 1);
    assert.equal(
      run.message.trim(),
      "jr2.fence-node fail link /opt/cni/bin/bridge is a link to /usr/libexec/cni/bridge, which this pod cannot run (it " +
        "sees only /opt/cni/bin of the node), so jr2 cannot read the version of that bridge plugin",
    );
    assert.equal(
      (await exec("readlink", [join(bin, "bridge")])).stdout.trim(),
      "/usr/libexec/cni/bridge",
      "the link stays",
    );
    assert.deepEqual((await readdir(bin)).sort(), ["bridge", "loopback"], "a refused node gets no plugin");

    // A link to a file beside it is run, and kept. A link of static that leads nowhere is kept too.
    const beside = await nodeDirs({
      conf: ["10-kindnet.conflist"],
      bin: { "bridge-1.9.1": plugin("bridge", "v1.9.1") },
    });
    const bin2 = join(beside, "host/opt/cni/bin");
    await exec("ln", ["-s", "bridge-1.9.1", join(bin2, "bridge")]);
    await exec("ln", ["-s", "/usr/libexec/cni/static", join(bin2, "static")]);
    const ok = await runScript(beside);
    assert.equal(ok.code, 0, ok.message);
    assert.equal(
      ok.message.trim(),
      "jr2.fence-node ok wrote=tuning kept=bridge static bridge=v1.9.1 cni=10-kindnet.conflist type=ptp",
    );
    assert.equal((await exec("readlink", [join(bin2, "static")])).stdout.trim(), "/usr/libexec/cni/static");
    // A link to a link: jr2 does not follow it.
    const chain = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { "bridge-real": plugin("bridge", "v1.9.1") } });
    const bin3 = join(chain, "host/opt/cni/bin");
    await exec("ln", ["-s", "bridge-real", join(bin3, "bridge-mid")]);
    await exec("ln", ["-s", "bridge-mid", join(bin3, "bridge")]);
    assert.match(
      (await runScript(chain)).message,
      /^jr2\.fence-node fail link \/opt\/cni\/bin\/bridge is a link to bridge-mid,/,
    );
  },
);

scriptTest(
  "the plugins' script names the first CNI configuration and its first type, and reads no setting of a Multus in it",
  async () => {
    const thin =
      '{"cniVersion":"0.3.1","name":"multus-cni-network","type":"multus","namespaceIsolation":true,"delegates":[{"type":"ptp"}]}';
    const dir = await nodeDirs({
      conf: { "00-multus.conf": thin, "10-kindnet.conflist": conf("ptp") },
      bin: { loopback: "x" },
    });
    const run = await runScript(dir);
    assert.equal(run.code, 0, run.message);
    assert.ok(run.message.endsWith(" cni=00-multus.conf type=multus\n"), run.message);
    assert.deepEqual(firstCniOf(run.message.replace("jr2.fence-node ok ", "")), {
      file: "00-multus.conf",
      type: "multus",
    });
  },
);

const INSTALLED = "jr2.fence-node ok wrote=bridge static tuning kept= bridge=v1.10.0 cni=10-kindnet.conflist type=ptp";

const readyPod = (nodeName: string, install = INSTALLED, generation = "1", uid = "uid-1") => ({
  metadata: {
    name: `p-${nodeName}-${uid}-${generation}`,
    labels: { "pod-template-generation": generation },
    ownerReferences: [{ uid }],
  },
  spec: { nodeName },
  status: {
    conditions: [{ type: "Ready", status: "True" }],
    initContainerStatuses: [
      { name: "install", state: { terminated: { exitCode: 0, message: install } } },
      { name: "rules", state: { terminated: { exitCode: 0, message: "jr2.fence-node ok rules=loaded\n" } } },
    ],
  },
});

const failedPod = (nodeName: string, statuses: Array<{ name: string; message: string }>) => ({
  metadata: { name: `p-${nodeName}` },
  spec: { nodeName },
  status: {
    initContainerStatuses: statuses.map((s) => ({
      name: s.name,
      state: { waiting: { reason: "CrashLoopBackOff" } },
      lastState: { terminated: { exitCode: 1, message: s.message } },
    })),
  },
});

test("the wait: each Sandbox node's Ready pod, and its lines; a failed folder, write, bridge or rule table refuses with its node, its advice and what stays; no pod in time refuses", async () => {
  const kube = cluster();
  kube.pods = [
    readyPod("a"),
    readyPod("b", "jr2.fence-node ok wrote= kept=bridge static tuning bridge=v1.9.1 cni=10-kindnet.conflist type=ptp"),
    readyPod("x"),
  ];
  const got = await awaitFenceNodes(kube, { nodes: ["a", "b"] });
  assert.deepEqual(
    [...got],
    [
      ["a", "wrote=bridge static tuning kept= bridge=v1.10.0 cni=10-kindnet.conflist type=ptp rules=loaded"],
      ["b", "wrote= kept=bridge static tuning bridge=v1.9.1 cni=10-kindnet.conflist type=ptp rules=loaded"],
    ],
  );

  const failed = cluster();
  failed.pods = [
    readyPod("a"),
    failedPod("b", [{ name: "install", message: "jr2.fence-node fail folder no CNI configuration in /etc" }]),
    failedPod("c", [
      { name: "install", message: "jr2.fence-node fail bridge /opt/cni/bin/bridge is v1.7.1, older than v1.8.0" },
    ]),
    failedPod("d", [
      { name: "install", message: INSTALLED },
      { name: "rules", message: "jr2.fence-node fail rules nft could not load the table inet jr2_fence: x" },
    ]),
    failedPod("e", [
      {
        name: "install",
        message:
          "jr2.fence-node fail write cannot write bridge into /opt/cni/bin on the node: cp: Read-only file system",
      },
    ]),
  ];
  await assert.rejects(awaitFenceNodes(failed, { nodes: ["a", "b", "c", "d", "e"], pollMs: 1 }), (e: Error) => {
    const lines = e.message.split("\n");
    assert.equal(lines[0], "fence: the DaemonSet jr2-system/jr2-fence-node failed on 4 Sandbox nodes (ADR-0084):");
    assert.equal(lines[1], "  b: no CNI configuration in /etc");
    assert.equal(lines[2], "  c: /opt/cni/bin/bridge is v1.7.1, older than v1.8.0");
    assert.equal(lines[3], "  d: nft could not load the table inet jr2_fence: x");
    assert.equal(lines[4], "  e: cannot write bridge into /opt/cni/bin on the node: cp: Read-only file system");
    assert.match(lines[5]!, /^jr2 puts the plugins bridge, static, tuning into \/opt\/cni\/bin, and the Fence needs/);
    assert.match(
      lines[6]!,
      /^The pod writes as root into the node's \/opt\/cni\/bin\. On a node where that folder is read-only/,
    );
    assert.match(lines[7]!, /^jr2 never replaces a plugin file\. A bridge plugin older than v1\.8\.0 /);
    assert.match(
      lines[8]!,
      /^The node must have nftables with the inet family, and the pod needs the capability NET_ADMIN/,
    );
    assert.equal(
      lines[9],
      "jr2 applied the namespace jr2-system and the DaemonSet jr2-fence-node. They stay, with the plugins that the " +
        "DaemonSet wrote and the rule table on each node where it loaded. This converge applied no Multus. " +
        "`jr2 down --all` removes the DaemonSet and the table.",
    );
    assert.match(lines[10]!, /Then run `jr2 up` again\.$/);
    return true;
  });

  const mount = cluster();
  mount.pods = [{ metadata: { name: "p-a" }, spec: { nodeName: "a" }, status: { phase: "Pending" } }];
  mount.events = [{ reason: "FailedMount", message: "hostPath type check failed: /opt/cni/bin is not a directory" }];
  let t = 0;
  await assert.rejects(
    awaitFenceNodes(mount, { nodes: ["a"], pollMs: 1, now: () => (t += 10_000) }),
    /\n {2}a: the kubelet cannot mount a CNI folder of the node after 180 s: hostPath type check failed: \/opt\/cni\/bin is not a directory\n/,
  );
  // A new node: the folder is not there yet, and the kubelet mounts it when the primary CNI makes it.
  // Within the wait of 180 s, the mount's event does not refuse.
  const late = cluster();
  late.pods = [{ metadata: { name: "p-a" }, spec: { nodeName: "a" }, status: { phase: "Pending" } }];
  late.events = mount.events;
  let polls = 0;
  const list = late.listJson.bind(late);
  late.listJson = (async (o: { kind: string }) => {
    if (o.kind === "pod" && ++polls === 15) late.pods = [readyPod("a")];
    return list(o as never);
  }) as typeof late.listJson;
  t = 0;
  assert.equal((await awaitFenceNodes(late, { nodes: ["a"], pollMs: 1, now: () => (t += 2_000) })).size, 1);
  // A pod whose init container has started: the kubelet mounted the folders, so an old FailedMount
  // event of it never refuses, also after 180 s. The wait goes on to its own bound.
  const mounted = cluster();
  mounted.pods = [
    {
      metadata: { name: "p-a" },
      spec: { nodeName: "a" },
      status: {
        phase: "Pending",
        initContainerStatuses: [
          { name: "rules", state: { terminated: { exitCode: 0, message: "jr2.fence-node ok rules=loaded\n" } } },
          { name: "install", state: { running: {} } },
        ],
      },
    },
  ];
  mounted.events = mount.events;
  t = 0;
  await assert.rejects(
    awaitFenceNodes(mounted, { nodes: ["a"], pollMs: 1, now: () => (t += 10_000) }),
    (e: Error) => /no Ready pod of the DaemonSet/.test(e.message) && !/cannot mount/.test(e.message),
  );

  const none = cluster();
  t = 0;
  await assert.rejects(
    awaitFenceNodes(none, { nodes: ["a"], pollMs: 1, now: () => (t += 60_000) }),
    /no Ready pod of the DaemonSet jr2-system\/jr2-fence-node on the Sandbox node a in 300 s.*\njr2 applied the namespace jr2-system/s,
  );
});

test("the wait: no pod because the cluster refused to create it names the DaemonSet's FailedCreate event, and what to allow", async () => {
  const kube = cluster();
  const asked: string[] = [];
  const list = kube.listJson.bind(kube);
  kube.listJson = (async (o: { kind: string; fieldSelector?: string }) => {
    if (o.kind === "event") {
      asked.push(o.fieldSelector ?? "");
      return o.fieldSelector === "involvedObject.kind=DaemonSet,involvedObject.name=jr2-fence-node"
        ? [
            {
              reason: "FailedCreate",
              message:
                'Error creating: pods "jr2-fence-node-x" is forbidden: violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true)',
            },
          ]
        : [];
    }
    return list(o as never);
  }) as typeof kube.listJson;
  let t = 0;
  await assert.rejects(awaitFenceNodes(kube, { nodes: ["a"], pollMs: 1, now: () => (t += 10_000) }), (e: Error) => {
    assert.match(
      e.message,
      /\n {2}a: no pod: Error creating: pods "jr2-fence-node-x" is forbidden: violates PodSecurity/,
    );
    assert.match(e.message, /kubectl label namespace jr2-system pod-security\.kubernetes\.io\/enforce=privileged/);
    return true;
  });
});

test("the wait counts only a pod that the DaemonSet owns now, by its uid, of its template generation or a later one", async () => {
  const kube = cluster();
  const owner = async () => ({ uid: "uid-2", generation: 2 });
  let t = 0;
  // A Ready pod of the template before, and one of a DaemonSet that was made again (its generation
  // starts again at 1, and a pod of the old one can have a higher number): neither counts.
  kube.pods = [readyPod("a", INSTALLED, "1", "uid-2"), readyPod("a", INSTALLED, "7", "uid-1")];
  await assert.rejects(
    awaitFenceNodes(kube, { nodes: ["a"], owner, pollMs: 1, now: () => (t += 60_000) }),
    /no Ready pod of the DaemonSet/,
  );
  kube.pods.push(readyPod("a", INSTALLED, "2", "uid-2"));
  assert.equal((await awaitFenceNodes(kube, { nodes: ["a"], owner })).size, 1);
});

test("the wait reads the DaemonSet at each poll and accepts its generation or a later one: a converge whose template a later converge (a newer Kit) replaced does not wait out its 300 s; a read that fails throws", async () => {
  const kube = cluster();
  kube.pods = [readyPod("a", INSTALLED, "5")];
  let generation = 4;
  let reads = 0;
  const owner = async () => {
    reads++;
    return { uid: "uid-1", generation };
  };
  assert.equal((await awaitFenceNodes(kube, { nodes: ["a"], owner })).size, 1, "a pod of a later generation counts");
  // Once the later template is in force, a Ready pod of the earlier one does not count.
  kube.pods = [readyPod("a", INSTALLED, "4")];
  generation = 5;
  let t = 0;
  await assert.rejects(
    awaitFenceNodes(kube, { nodes: ["a"], owner, pollMs: 1, now: () => (t += 60_000) }),
    /no Ready pod/,
  );
  assert.ok(reads >= 2);
  // A read of the DaemonSet that fails, in the install: the wait throws, and accepts no pod of any template.
  const blind = cluster([nodeDs()], [], ["daemonset"]);
  blind.pods = [readyPod("n1")];
  await assert.rejects(
    installFence(blind, planOf({ multus: "jr2", node: "present" }), { image: "i:1", nodes: ["n1"], log: () => {} }),
    /Forbidden/,
  );
  // A DaemonSet that is gone after its apply: the wait says so.
  const gone = cluster();
  gone.apply = async () => {};
  gone.pods = [readyPod("n1")];
  await assert.rejects(
    installFence(gone, planOf({ multus: "jr2", node: "install" }), { image: "i:1", nodes: ["n1"], log: () => {} }),
    /the DaemonSet jr2-system\/jr2-fence-node is gone after its apply/,
  );
});

// ---- the install ----------------------------------------------------------------------------------------

test("the install: the fence node first, then Multus and its rollout, with a line for each; an empty plan prints one quiet line", async () => {
  const kube = cluster();
  kube.pods = [readyPod("n1")];
  const lines: string[] = [];
  const plan = planOf({ multus: "install", node: "install" });
  await installFence(kube, plan, { image: "jr2-operator:1", nodes: ["n1"], log: (l) => lines.push(l) });
  assert.equal(kube.applied.length, 2);
  assert.deepEqual(JSON.parse(kube.applied[0]!), fenceNodeDaemonSet("jr2-operator:1"));
  assert.equal(kube.applied[1], await multusManifest());
  assert.deepEqual(kube.rollouts, ["kube-system/daemonset/kube-multus-ds"]);
  assert.deepEqual(lines, [
    "fence: applying the DaemonSet jr2-system/jr2-fence-node (jr2-operator:1)",
    "fence: n1: wrote=bridge static tuning kept= bridge=v1.10.0 cni=10-kindnet.conflist type=ptp rules=loaded",
    "fence: applying Multus v4.3.2 (thick) to kube-system",
    "fence: Multus is ready on each node",
  ]);
  // No pod of the DaemonSet is deleted, and no node's file is read for a Multus's settings.
  assert.deepEqual(kube.deleted, []);

  // A later converge: everything is there. The DaemonSet is applied again, which changes nothing
  // when it is the same, and puts back the template that an interrupted removal left; one line.
  const later = cluster([jr2Multus(), nodeDs(KIT_VERSION, "jr2-operator:1")]);
  later.pods = [readyPod("n1")];
  const quiet: string[] = [];
  await installFence(later, planOf({ multus: "jr2", node: "present" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: (l) => quiet.push(l),
  });
  assert.deepEqual(later.applied, [JSON.stringify(fenceNodeDaemonSet("jr2-operator:1"))]);
  assert.deepEqual(quiet, [
    "fence: prerequisites in place — jr2's Multus, the admission policies, and the rule table and the CNI plugins on 1 Sandbox node",
  ]);

  // A Multus of another owner: jr2 applies no Multus, and deletes no pod. A new Kit image updates the
  // DaemonSet with no line of its own; a newer Kit's DaemonSet stays.
  const update = cluster([nodeDs(KIT_VERSION, "jr2-operator:0")]);
  update.pods = [readyPod("n1")];
  const updated: string[] = [];
  await installFence(update, planOf({ multus: "foreign", node: "present" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: (l) => updated.push(l),
  });
  assert.equal(update.applied.length, 1);
  assert.deepEqual([update.rollouts, update.deleted], [[], []]);
  assert.deepEqual(updated, [
    "fence: prerequisites in place — the cluster's Multus, the admission policies, and the rule table and the CNI plugins on 1 Sandbox node",
  ]);
  const newer = cluster([nodeDs("999.0.0", "jr2-operator:9")]);
  newer.pods = [readyPod("n1")];
  await installFence(newer, planOf({ multus: "foreign", node: "present" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: () => {},
  });
  assert.deepEqual(newer.applied, []);
});

test("the install waits for the pods of the template that it applied: the DaemonSet's generation after the apply", async () => {
  const kube = cluster([jr2Multus(), nodeDs(KIT_VERSION, "jr2-operator:0", "3")]);
  kube.pods = [readyPod("n1", INSTALLED, "2")];
  let t = 0;
  await assert.rejects(
    installFence(kube, planOf({ multus: "jr2", node: "present" }), {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: () => {},
      pollMs: 1,
      now: () => (t += 60_000),
    }),
    /no Ready pod of the DaemonSet jr2-system\/jr2-fence-node on the Sandbox node n1/,
  );
  kube.pods.push(readyPod("n1", INSTALLED, "3"));
  await installFence(kube, planOf({ multus: "jr2", node: "present" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: () => {},
  });
});

test("a FailedCreate event of the DaemonSet from before this converge's apply does not refuse: only a new one, or one that came again, does", async () => {
  const old = {
    metadata: { name: "jr2-fence-node.1" },
    reason: "FailedCreate",
    message: 'Error creating: pods "jr2-fence-node-x" is forbidden: violates PodSecurity "baseline:latest"',
    count: 4,
    lastTimestamp: "2026-11-20T10:00:00Z",
  };
  const kube = cluster();
  kube.events = [old];
  let t = 0;
  // The user fixed Pod Security: the old event stays in the API, and the pod comes.
  let polls = 0;
  const list = kube.listJson.bind(kube);
  kube.listJson = (async (o: { kind: string }) => {
    if (o.kind === "pod" && ++polls === 30) kube.pods = [readyPod("n1")];
    return list(o as never);
  }) as typeof kube.listJson;
  await installFence(kube, planOf({ multus: "jr2", node: "install" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: () => {},
    pollMs: 1,
    now: () => (t += 1_000),
  });
  // The same event again (its count went up): this converge's own refusal.
  const again = cluster();
  again.events = [old];
  const list2 = again.listJson.bind(again);
  let applied = false;
  const apply = again.apply.bind(again);
  again.apply = (async (o: { manifest: string }) => {
    applied = true;
    await apply(o);
  }) as typeof again.apply;
  again.listJson = (async (o: { kind: string }) => {
    if (o.kind === "event" && applied) return [{ ...old, count: 5, lastTimestamp: "2026-11-23T10:00:00Z" }];
    return list2(o as never);
  }) as typeof again.listJson;
  t = 0;
  await assert.rejects(
    installFence(again, planOf({ multus: "jr2", node: "install" }), {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: () => {},
      pollMs: 1,
      now: () => (t += 10_000),
    }),
    /\n {2}n1: no pod: Error creating: pods "jr2-fence-node-x" is forbidden/,
  );
  assert.notEqual(eventPrint(old), eventPrint({ ...old, count: 5 }));
});

// ---- jr2 down --all -------------------------------------------------------------------------------------

/** What the removal of the guard deletes: the bindings, then the policies. */
const GUARD_DELETES = [
  "/validatingadmissionpolicybinding/jr2-fence-guard-pods",
  "/validatingadmissionpolicybinding/jr2-fence-guard-attachments",
  "/validatingadmissionpolicy/jr2-fence-guard-pods",
  "/validatingadmissionpolicy/jr2-fence-guard-attachments",
];

test("the removal: the removal form with the running image, its rollout, then the DaemonSet goes; jr2's Multus and its definition go, another stays", async () => {
  const kube = cluster([nodeDs(KIT_VERSION, "jr2-operator:7"), jr2Multus()]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.applied, [JSON.stringify(fenceNodeDaemonSet("jr2-operator:7", { remove: true }))]);
  assert.deepEqual(kube.rollouts, ["jr2-system/daemonset/jr2-fence-node"]);
  assert.deepEqual(kube.deleted, ["jr2-system/daemonset/jr2-fence-node", ...GUARD_DELETES, "manifest"]);
  assert.deepEqual(lines, [
    'removing the rule table "inet jr2_fence" and the bridge jr2fence0 from each node',
    "uninstalling the DaemonSet jr2-system/jr2-fence-node; the CNI plugins bridge, static, tuning stay in /opt/cni/bin on each node",
    "uninstalling the admission policies jr2-fence-guard-pods and jr2-fence-guard-attachments and their bindings",
    "uninstalling Multus (kube-system), which jr2 installed, and its CustomResourceDefinition network-attachment-definitions.k8s.cni.cncf.io",
  ]);

  // A node that does not take the removal in time: a warning with the command, and the DaemonSet goes.
  const upstream: Obj = {
    kind: "DaemonSet",
    metadata: { name: "kube-multus-ds", namespace: "kube-system", labels: { app: "multus" } },
  };
  const slow = cluster([nodeDs(), upstream]);
  slow.waitRollout = async () => {
    throw new Error("error: timed out waiting for the condition\nmore");
  };
  const warned: string[] = [];
  await uninstallFence(slow, { log: (l) => warned.push(l) });
  assert.equal(
    warned[1],
    'warning: the rule table "inet jr2_fence" and the bridge jr2fence0 were not removed from each node in 120 s ' +
      "(error: timed out waiting for the condition); on a node that keeps them, run `nft delete table inet " +
      "jr2_fence` as root, and `ip link delete jr2fence0` when the bridge has no port",
  );
  assert.equal(warned.length, 4, "no read of the pods after a rollout that did not end");
  assert.deepEqual(
    slow.deleted,
    ["jr2-system/daemonset/jr2-fence-node", ...GUARD_DELETES],
    "a Multus of another owner stays",
  );

  // No DaemonSet: only the policies, whose delete ignores one that is not there.
  const empty = cluster();
  await uninstallFence(empty, { log: () => {} });
  assert.deepEqual([empty.applied, empty.deleted], [[], GUARD_DELETES]);
});

test("the removal warns with the node when a node kept its bridge: its ports, or the error of ip; a pod of an earlier template, a removed or absent bridge, say nothing", async () => {
  const kube = cluster([nodeDs(KIT_VERSION, "jr2-operator:7", "4")]);
  const pod = (node: string, line: string, generation = "4", uid = "uid-1") => ({
    metadata: {
      name: `jr2-fence-node-${node}`,
      labels: { "pod-template-generation": generation },
      ownerReferences: [{ uid }],
    },
    spec: { nodeName: node },
    status: {
      initContainerStatuses: [
        { name: "rules", state: { terminated: { exitCode: 0, message: `jr2.fence-node ${line}\n` } } },
      ],
    },
  });
  kube.pods = [
    pod("n1", "ok rules=removed bridge=removed"),
    pod("n2", "ok rules=removed bridge=absent"),
    pod("n3", "ok rules=removed bridge=kept ports=veth1a2b,vethc3d4"),
    pod("n4", "ok rules=removed bridge=kept error=ip: RTNETLINK answers: Operation not permitted"),
    pod("n5", "ok rules=removed bridge=kept ports=vethold", "3"),
    // A pod of a DaemonSet of the same name that was there before: another uid, not this removal's.
    pod("n6", "ok rules=removed bridge=kept ports=vethother", "9", "uid-0"),
  ];
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(lines.slice(1, 3), [
    "warning: the node n3 keeps the bridge jr2fence0, because it has the ports veth1a2b, vethc3d4: a pod is still " +
      "on the Fence there. When that pod is gone, run `ip link delete jr2fence0` as root on the node",
    "warning: the node n4 keeps the bridge jr2fence0 (ip: RTNETLINK answers: Operation not permitted); run " +
      "`ip link delete jr2fence0` as root on the node when the bridge has no port",
  ]);
  assert.match(lines[3]!, /^uninstalling the DaemonSet jr2-system\/jr2-fence-node/, "the DaemonSet still goes");
  assert.deepEqual(kube.deleted, ["jr2-system/daemonset/jr2-fence-node", ...GUARD_DELETES]);

  // A read of the pods that fails warns; it never skips the check in silence.
  const blind = cluster([nodeDs()], [], ["pod"]);
  const said: string[] = [];
  await uninstallFence(blind, { log: (l) => said.push(l) });
  assert.match(
    said[1]!,
    /^warning: jr2 cannot read the pods of jr2-system\/jr2-fence-node \(Error from server \(Forbidden\).*\), so it cannot tell whether each node removed the bridge jr2fence0; on a node that keeps it, run `nft delete table inet jr2_fence` as root, and `ip link delete jr2fence0` when the bridge has no port$/,
  );
});

test("the removal keeps jr2's Multus and its definition while the cluster has a NetworkAttachmentDefinition, or when it cannot list them, and says how to remove them", async () => {
  const nad = (namespace: string, name: string): Obj => ({
    kind: "network-attachment-definitions.k8s.cni.cncf.io",
    metadata: { name, namespace },
  });
  const kube = cluster([jr2Multus(), nad("team-a", "macvlan"), nad("team-b", "sriov")]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.deleted, GUARD_DELETES, "the policies go; jr2's Multus stays");
  assert.equal(lines.length, 2);
  assert.match(
    lines[1]!,
    /^warning: the cluster has NetworkAttachmentDefinitions that are not jr2's \(team-a\/macvlan, team-b\/sriov\), so jr2 keeps the Multus that it installed and its CustomResourceDefinition: their removal deletes each NetworkAttachmentDefinition\. When nothing uses them, remove them: kubectl delete crd network-attachment-definitions\.k8s\.cni\.cncf\.io; /,
  );
  const refused = cluster([jr2Multus()], [], ["network-attachment-definitions.k8s.cni.cncf.io"]);
  const said: string[] = [];
  await uninstallFence(refused, { log: (l) => said.push(l) });
  assert.deepEqual(refused.deleted, GUARD_DELETES);
  assert.match(
    said[1]!,
    /^warning: jr2 cannot list the NetworkAttachmentDefinitions of the cluster \(Error from server \(Forbidden\)/,
  );
});

test("the removal warns when it cannot read the DaemonSet: the table is not removed in silence", async () => {
  const kube = cluster([], [], ["daemonset"]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.match(
    lines[0]!,
    /^warning: jr2 cannot read the DaemonSet jr2-system\/jr2-fence-node \(Error from server \(Forbidden\).*\), so it did not remove the rule table "inet jr2_fence" and the bridge jr2fence0 from the nodes\. On each node that keeps them, run `nft delete table inet jr2_fence` as root, and `ip link delete jr2fence0` when the bridge has no port/,
  );
  assert.deepEqual(kube.applied, []);
});

test("the CLI names the CNI plugins' version of the operator image, and the image's sums file has each plugin", async () => {
  const kitRoot = join(import.meta.dirname, "../../..");
  const dockerfile = await readFile(join(kitRoot, "operator/Dockerfile"), "utf8");
  assert.equal(/^ARG CNI_PLUGINS_VERSION=(\S+)$/m.exec(dockerfile)?.[1], CNI_VERSION);
  const sums = await readFile(join(kitRoot, "operator/cni-plugins.sha256"), "utf8");
  for (const arch of ["amd64", "arm64"]) {
    assert.match(sums, new RegExp(`^[0-9a-f]{64} {2}cni-plugins-linux-${arch}-${CNI_VERSION}\\.tgz$`, "m"));
    for (const p of ["bridge", "static", "tuning"]) {
      assert.match(sums, new RegExp(`^[0-9a-f]{64} {2}linux-${arch}/${p}$`, "m"));
    }
  }
});
