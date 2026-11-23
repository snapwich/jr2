// The Fence's prerequisites (ADR-0084, ADR-0019): what `jr2 up` reads from the cluster before it
// asks, each refusal, the question's text, the fence node's DaemonSet, the wait for it, the install
// and the removal. Through a fake API; the scripts run here against folders in a temp dir, with a
// fake `nft` and fake plugins.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  multusHostDirs,
  multusManifest,
  MULTUS_VERSION,
  flagValue,
  planAsks,
  planFenceInstall,
  PLUGINS_SCRIPT,
  RULES_REMOVE_SCRIPT,
  RULES_SCRIPT,
  selects,
  uninstallFence,
  type DaemonSetObject,
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

/** A cluster: objects by `<namespace>/<kind>/<name>`, the CRDs it has, and the lists it answers. A
 * kind in `refuse` fails each list of it with Forbidden, as the API does for a user with no read. */
function cluster(objects: Obj[] = [], crds: string[] = [], refuse: string[] = []) {
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
        return (crds.includes(name) ? [{ metadata: { name } }] : []) as T[];
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
    async apply(o: { manifest: string }): Promise<void> {
      kube.applied.push(o.manifest);
    },
    async waitRollout(o: { kind?: string; name: string; namespace: string }): Promise<void> {
      kube.rollouts.push(`${o.namespace}/${o.kind}/${o.name}`);
    },
    deleted: [] as string[],
    async deleteObject(o: { kind: string; name: string; namespace?: string }): Promise<void> {
      kube.deleted.push(`${o.namespace ?? ""}/${o.kind}/${o.name}`);
      store.delete(key(o.namespace, o.kind, o.name));
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
  multusPods: [{ namespace: "kube-system", selector: "app=multus" }],
  notes: [],
  ...p,
});

const node = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, labels } });

/** The upstream thick Multus (no jr2 annotation): its daemon config holds `config`. */
function thickMultus(config: Record<string, unknown>, over: { bin?: string; conf?: string } = {}): Obj[] {
  return [
    {
      kind: "DaemonSet",
      metadata: { name: "kube-multus-ds", namespace: "kube-system", labels: { app: "multus" } },
      spec: {
        template: {
          spec: {
            initContainers: [
              { name: "install-multus-binary", volumeMounts: [{ name: "cnibin", mountPath: "/host/opt/cni/bin" }] },
            ],
            containers: [
              {
                name: "kube-multus",
                volumeMounts: [
                  { name: "cni", mountPath: "/host/etc/cni/net.d" },
                  { name: "cnibin", mountPath: "/opt/cni/bin" },
                  { name: "multus-daemon-config", mountPath: "/etc/cni/net.d/multus.d" },
                ],
              },
            ],
            volumes: [
              { name: "cni", hostPath: { path: over.conf ?? "/etc/cni/net.d" } },
              { name: "cnibin", hostPath: { path: over.bin ?? "/opt/cni/bin" } },
              { name: "multus-daemon-config", configMap: { name: "multus-daemon-config" } },
            ],
          },
        },
      },
    },
    {
      kind: "ConfigMap",
      metadata: { name: "multus-daemon-config", namespace: "kube-system" },
      data: { "daemon-config.json": JSON.stringify({ cniConfigDir: "/host/etc/cni/net.d", ...config }) },
    },
  ];
}

const jr2Multus = (version = MULTUS_VERSION): Obj => ({
  kind: "DaemonSet",
  metadata: {
    name: "kube-multus-ds",
    namespace: "kube-system",
    labels: { app: "multus" },
    annotations: { "jr2.dev/multus": version },
  },
});

const nodeDs = (version = KIT_VERSION, image = "jr2-operator:1"): Obj => ({
  kind: "DaemonSet",
  metadata: {
    name: "jr2-fence-node",
    namespace: "jr2-system",
    labels: { app: "jr2-fence-node", "jr2.dev/version": version },
  },
  spec: { template: { spec: { containers: [{ image }] } } },
});

// ---- the read ------------------------------------------------------------------------------------------

test("a stock cluster: Multus and the fence node are installed, and the question lists each part, what it can do on a node, and what a later converge does", async () => {
  const plan = await planFenceInstall(cluster(), { nodes: [node("n1")] });
  assert.deepEqual(plan, {
    multus: "install",
    node: "install",
    system: "create",
    multusPods: [{ namespace: "kube-system", selector: "app=multus" }],
    notes: [],
  });
  assert.equal(planAsks(plan), true);
  assert.deepEqual(describeInstall(plan), [
    "fence: this converge installs the Fence's prerequisites (ADR-0084):",
    "  - the namespace jr2-system.",
    "  - the DaemonSet jr2-system/jr2-fence-node, on each Linux node. Its pod runs as root on the node's network. " +
      "At each start, it:",
    "      - runs the node's /opt/cni/bin/bridge, if the node has one, to read its version;",
    "      - writes the CNI plugins bridge, static, tuning v1.10.0 into /opt/cni/bin where the node has no file of " +
      "that name (it never replaces a file);",
    '      - loads the rule table "inet jr2_fence" into the node\'s nftables, with the capability NET_ADMIN alone.',
    "  - Multus v4.3.2 (thick, namespaceIsolation, no global namespace), from the manifest that the CLI ships: a " +
      "cluster-wide CustomResourceDefinition and ClusterRole, and a privileged DaemonSet kube-system/kube-multus-ds. " +
      "Multus writes the first CNI configuration of each node, so the cluster makes each new pod through Multus.",
    "  A later jr2 up of a newer Kit changes the DaemonSet jr2-fence-node to its version, and does not ask. It asks " +
      "before it changes Multus.",
    "  jr2 down --all removes the rule table, the DaemonSet and Multus. The plugin files stay on the nodes.",
  ]);
  // A cluster that has jr2-system (the operator of another Instance): no line for the namespace.
  const system = await planFenceInstall(cluster([{ kind: "Namespace", metadata: { name: "jr2-system" } }]), {
    nodes: [],
  });
  assert.equal(system.system, "present");
  assert.doesNotMatch(describeInstall(system)!.join("\n"), /the namespace jr2-system\./);
});

test("a cluster that has jr2's Multus and the fence node: nothing to ask; another version of jr2's Multus is an update that asks", async () => {
  const plan = await planFenceInstall(cluster([jr2Multus(), nodeDs()]), { nodes: [node("n1")] });
  assert.deepEqual([plan.multus, plan.node], ["jr2", "present"]);
  assert.equal(planAsks(plan), false);
  assert.equal(describeInstall(plan), undefined);

  const older = await planFenceInstall(cluster([jr2Multus("v4.2.0-thick-1"), nodeDs()]), { nodes: [] });
  assert.deepEqual([older.multus, older.node], ["upgrade", "present"]);
  assert.match(
    describeInstall(older)!.join("\n"),
    new RegExp(
      `\\n {2}- an update of the Multus that jr2 installed to ${MULTUS_VERSION}, from the manifest that the CLI ships: a cluster-wide`,
    ),
  );
  assert.doesNotMatch(describeInstall(older)!.join("\n"), /DaemonSet jr2-system\/jr2-fence-node, on each/);
});

test("a Multus that jr2 did not install, with namespaceIsolation and no global namespace, is accepted and left alone; its pods are found by its own selector", async () => {
  const kube = cluster(thickMultus({ namespaceIsolation: true, globalNamespaces: "" }));
  const plan = await planFenceInstall(kube, { nodes: [node("n1")] });
  assert.deepEqual([plan.multus, plan.node], ["foreign", "install"]);
  assert.deepEqual(plan.multusPods, [{ namespace: "kube-system", selector: "app=multus" }]);
  assert.doesNotMatch(describeInstall(plan)!.join("\n"), /Multus v4|update of the Multus/);
});

test("refusal (a): a Multus of another owner is found by more than the label app=multus: RKE2's label, its name, or its image", async () => {
  const rke2 = (over: { labels?: Record<string, string>; name?: string; image?: string; namespace?: string }): Obj => ({
    kind: "DaemonSet",
    metadata: {
      name: over.name ?? "rke2-multus",
      namespace: over.namespace ?? "kube-system",
      labels: over.labels ?? {},
    },
    spec: {
      selector: { matchLabels: { app: "rke2-multus" } },
      template: {
        spec: {
          containers: [
            {
              name: "kube-rke2-multus",
              image: over.image ?? "rancher/hardened-multus-cni:v4.1.0",
              args: ["--multus-conf-file=auto"],
            },
          ],
        },
      },
    },
  });
  for (const ds of [
    rke2({ labels: { app: "rke2-multus" } }),
    rke2({ name: "cni-a", image: "registry.local/multus-cni:v4" }),
    rke2({ name: "kube-multus", image: "registry.local/x:1", namespace: "network" }),
  ]) {
    await assert.rejects(
      planFenceInstall(cluster([ds]), { nodes: [] }),
      /does not have namespaceIsolation in the arguments of the container/,
      ds.metadata.name,
    );
  }
  // Accepted: the pods are found by the DaemonSet's own selector, in its namespace.
  const ok = rke2({ labels: { app: "rke2-multus" } });
  (ok.spec as any).template.spec.containers[0].args = ["--multus-conf-file=auto", "--namespace-isolation"];
  const plan = await planFenceInstall(cluster([ok]), { nodes: [] });
  assert.equal(plan.multus, "foreign");
  assert.deepEqual(plan.multusPods, [{ namespace: "kube-system", selector: "app=rke2-multus" }]);
});

test("refusal (d): the cluster has Multus's definition and jr2 finds no Multus DaemonSet; it waits for a concurrent apply first", async () => {
  const crd = ["network-attachment-definitions.k8s.cni.cncf.io"];
  await assert.rejects(planFenceInstall(cluster([], crd), { nodes: [], settleMs: 0 }), (e: Error) => {
    assert.match(
      e.message,
      /^fence: the cluster has the CustomResourceDefinition network-attachment-definitions\.k8s\.cni\.cncf\.io, which Multus uses, but jr2 found no Multus DaemonSet whose settings it can read\. jr2 looked in each namespace for a DaemonSet with "multus" in its name, in a label or in a container image\./,
    );
    assert.match(e.message, /Nothing was applied\.$/);
    return true;
  });
  // A DaemonSet that appears while the read waits (another converge's apply) is read.
  const late = cluster([], crd);
  let lists = 0;
  const list = late.listJson.bind(late);
  late.listJson = (async (o: { kind: string }) => {
    if (o.kind === "daemonset" && ++lists === 2) late.store.set("kube-system/daemonset/kube-multus-ds", jr2Multus());
    return list(o as never);
  }) as typeof late.listJson;
  const plan = await planFenceInstall(late, { nodes: [], settleMs: 10, pollMs: 1 });
  assert.equal(plan.multus, "jr2");
});

test("the flags of a thin Multus, as pflag reads them: a bare bool is true, a string takes = or the next word, the last one counts", () => {
  assert.equal(flagValue(["--namespace-isolation"], "--namespace-isolation", "bool"), "true");
  assert.equal(flagValue(["--namespace-isolation=false"], "--namespace-isolation", "bool"), "false");
  assert.equal(flagValue(["--namespace-isolation", "false"], "--namespace-isolation", "bool"), "true");
  assert.equal(flagValue(["--global-namespaces", "foo"], "--global-namespaces", "string"), "foo");
  assert.equal(flagValue(["--global-namespaces=a,b"], "--global-namespaces", "string"), "a,b");
  assert.equal(
    flagValue(["/thin_entrypoint --global-namespaces x --global-namespaces=y"], "--global-namespaces", "string"),
    "y",
  );
  assert.equal(flagValue(["--multus-conf-file=auto"], "--namespace-isolation", "bool"), undefined);
});

test("refusal (a): a Multus that jr2 did not install, with no namespaceIsolation or with a global namespace", async () => {
  for (const config of [{}, { namespaceIsolation: false }]) {
    await assert.rejects(planFenceInstall(cluster(thickMultus(config)), { nodes: [node("n1")] }), (e: Error) => {
      assert.equal(
        e.message,
        "fence: the cluster's Multus (DaemonSet kube-system/kube-multus-ds, which jr2 did not install) does not " +
          "have namespaceIsolation in daemon-config.json of the ConfigMap kube-system/multus-daemon-config, so a " +
          "pod of another namespace can name an attachment of the Instance and join its VLANs (ADR-0084). jr2 " +
          'never changes a Multus that it did not install. Set "namespaceIsolation": true in daemon-config.json ' +
          "of the ConfigMap kube-system/multus-daemon-config, restart the DaemonSet (kubectl -n kube-system " +
          "rollout restart daemonset/kube-multus-ds), then run `jr2 up` again. Nothing was applied.",
      );
      return true;
    });
  }
  await assert.rejects(
    planFenceInstall(cluster(thickMultus({ namespaceIsolation: true, globalNamespaces: "default" })), { nodes: [] }),
    /has the global namespaces "default" in daemon-config\.json of the ConfigMap kube-system\/multus-daemon-config.*Set "globalNamespaces": "" in daemon-config\.json/s,
  );
});

test("refusal (a), thin form: the settings are the container's arguments, with no daemon ConfigMap", async () => {
  const thin = (args: string[]): Obj => ({
    kind: "DaemonSet",
    metadata: { name: "kube-multus-ds", namespace: "kube-system", labels: { app: "multus" } },
    spec: {
      template: {
        spec: { containers: [{ name: "kube-multus", command: ["/thin_entrypoint"], args }], volumes: [] },
      },
    },
  });
  await assert.rejects(
    planFenceInstall(cluster([thin(["--multus-conf-file=auto"])]), { nodes: [] }),
    /does not have namespaceIsolation in the arguments of the container kube-multus of the DaemonSet kube-system\/kube-multus-ds.*Set --namespace-isolation=true in the arguments/s,
  );
  await assert.rejects(
    planFenceInstall(cluster([thin(["--namespace-isolation=true", "--global-namespaces=team"])]), { nodes: [] }),
    /has the global namespaces "team".*Remove --global-namespaces from the arguments/s,
  );
  // The space form of a string flag is read too.
  await assert.rejects(
    planFenceInstall(cluster([thin(["--namespace-isolation", "--global-namespaces", "team"])]), { nodes: [] }),
    /has the global namespaces "team"/,
  );
  await assert.rejects(
    planFenceInstall(cluster([thin(["--namespace-isolation=false"])]), { nodes: [] }),
    /does not have namespaceIsolation/,
  );
  for (const args of [["--namespace-isolation=true"], ["--namespace-isolation"]]) {
    assert.equal((await planFenceInstall(cluster([thin(args)]), { nodes: [] })).multus, "foreign", args.join(" "));
  }
});

test("refusal (a): a ConfigMap of the settings that the API refuses to read, or that does not exist, refuses, and says which", async () => {
  await assert.rejects(
    planFenceInstall(cluster(thickMultus({ namespaceIsolation: true }), [], ["configmap"]), { nodes: [] }),
    /the API refused the read of the ConfigMap kube-system\/multus-daemon-config that holds its settings \(Error from server \(Forbidden\).*Give the user of this context read access to that ConfigMap/s,
  );
  const missing = thickMultus({ namespaceIsolation: true }).slice(0, 1);
  await assert.rejects(planFenceInstall(cluster(missing), { nodes: [] }), (e: Error) => {
    assert.match(
      e.message,
      /the ConfigMap kube-system\/multus-daemon-config that its pods mount, and that holds its settings, does not exist/,
    );
    assert.doesNotMatch(e.message, /read access/);
    return true;
  });
});

test("refusal (c): a Multus that jr2 did not install mounts a CNI folder other than the default", async () => {
  const ok = { namespaceIsolation: true };
  await assert.rejects(
    planFenceInstall(cluster(thickMultus(ok, { bin: "/var/lib/rancher/k3s/data/cni" })), { nodes: [] }),
    (e: Error) => {
      assert.equal(
        e.message,
        "fence: the cluster's Multus (DaemonSet kube-system/kube-multus-ds) mounts the node's CNI bin directory " +
          "from /var/lib/rancher/k3s/data/cni, not /opt/cni/bin. jr2 puts the CNI plugins bridge, static, tuning " +
          "into /opt/cni/bin, and its Fence needs nodes whose container runtime reads /opt/cni/bin and " +
          "/etc/cni/net.d (ADR-0084). Keep such nodes out of the Sandbox nodes with sandbox.nodeSelector or a " +
          "taint (ADR-0052), or use a cluster whose nodes use those directories. Nothing was applied.",
      );
      return true;
    },
  );
  await assert.rejects(
    planFenceInstall(cluster(thickMultus(ok, { conf: "/var/lib/cni/conf" })), { nodes: [] }),
    /CNI configuration directory from \/var\/lib\/cni\/conf, not \/etc\/cni\/net\.d/,
  );
  const [ds] = thickMultus(ok);
  assert.deepEqual(multusHostDirs(ds as DaemonSetObject), { bin: "/opt/cni/bin", conf: "/etc/cni/net.d" });
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
    ["install", "rules"],
    "the checks that can refuse a node first: a node that they refuse gets no table",
  );
  const [install, rules] = spec.initContainers;
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

async function runWith(
  script: string,
  dir: string,
  env: Record<string, string> = {},
): Promise<{ code: number; message: string }> {
  const text = script.replaceAll("/dev/termination-log", `${dir}/message`);
  const code = await exec("sh", ["-c", text], { env: { ...process.env, ...env } }).then(
    () => 0,
    (e: { code?: number }) => e.code ?? 1,
  );
  return { code, message: await readFile(join(dir, "message"), "utf8").catch(() => "") };
}

test("the rules script loads the table in one transaction that replaces it, each time the same, and fails with nft's reason", async () => {
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
});

test("the removal script removes the table whether the node has it or not", async () => {
  const nft = await fakeNft();
  assert.deepEqual(await runWith(RULES_REMOVE_SCRIPT, nft.dir, { PATH: nft.path }), {
    code: 0,
    message: "jr2.fence-node ok rules=removed\n",
  });
  assert.equal(await readFile(join(nft.dir, "load-0"), "utf8"), "table inet jr2_fence\ndelete table inet jr2_fence\n");
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

test("the plugins' script writes each missing plugin, executable, keeps each file of that name, and says which, the bridge's version and the node's first CNI configuration", async () => {
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
  assert.deepEqual((await readdir(bin)).sort(), ["bridge", "loopback", "static", "tuning"], "no temporary file stays");
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
});

test("the plugins' script never replaces a file that appears after its check: ln, not a move, and the file of the node is kept", async () => {
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
});

test("the plugins' script says why a write fails", async () => {
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

test(`the plugins' script refuses a bridge of the node older than v${BRIDGE_MIN_VERSION}, or one whose version it cannot read, keeps it, and writes nothing then`, async () => {
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
});

test("the plugins' script waits for the node's CNI configuration (a new node), and fails, and says why, on a node whose CNI folders are not the default ones", async () => {
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
});

const INSTALLED = "jr2.fence-node ok wrote=bridge static tuning kept= bridge=v1.10.0 cni=10-kindnet.conflist type=ptp";

const readyPod = (nodeName: string, install = INSTALLED, generation?: string) => ({
  metadata: {
    name: `p-${nodeName}`,
    labels: generation !== undefined ? { "pod-template-generation": generation } : {},
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
    /\n {2}a: the kubelet cannot mount a CNI folder: hostPath type check failed: \/opt\/cni\/bin is not a directory\n/,
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

test("the wait after an apply counts only a pod of the new template: a Ready pod of the template before it does not", async () => {
  const kube = cluster();
  kube.pods = [readyPod("a", INSTALLED, "1")];
  let t = 0;
  await assert.rejects(
    awaitFenceNodes(kube, { nodes: ["a"], generation: "2", pollMs: 1, now: () => (t += 60_000) }),
    /no Ready pod of the DaemonSet/,
  );
  kube.pods = [readyPod("a", INSTALLED, "1"), readyPod("a", INSTALLED, "2")];
  assert.equal((await awaitFenceNodes(kube, { nodes: ["a"], generation: "2" })).size, 1);
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
    "fence: applying Multus v4.3.2 (thick, namespaceIsolation) to kube-system",
    "fence: Multus is ready on each node",
  ]);

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
    "fence: prerequisites in place — jr2's Multus, and the rule table and the CNI plugins on 1 Sandbox node",
  ]);

  // A new Kit image updates the DaemonSet with no line of its own; a newer Kit's DaemonSet stays.
  const update = cluster([nodeDs(KIT_VERSION, "jr2-operator:0")]);
  update.pods = [readyPod("n1")];
  const updated: string[] = [];
  await installFence(update, planOf({ multus: "foreign", node: "present" }), {
    image: "jr2-operator:1",
    nodes: ["n1"],
    log: (l) => updated.push(l),
  });
  assert.equal(update.applied.length, 1);
  assert.deepEqual(updated, [
    "fence: prerequisites in place — the cluster's Multus, and the rule table and the CNI plugins on 1 Sandbox node",
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
  const ds = nodeDs(KIT_VERSION, "jr2-operator:0");
  ds.metadata.annotations = { "deprecated.daemonset.template.generation": "3" };
  const kube = cluster([jr2Multus(), ds]);
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

test("the install refuses, before Multus, a node whose first CNI configuration is a Multus's when the API shows no Multus", async () => {
  const kube = cluster();
  kube.pods = [
    readyPod("n1"),
    readyPod("n2", INSTALLED.replace("cni=10-kindnet.conflist type=ptp", "cni=00-multus.conf type=multus-shim")),
  ];
  await assert.rejects(
    installFence(kube, planOf({ multus: "install", node: "install" }), {
      image: "jr2-operator:1",
      nodes: ["n1", "n2"],
      log: () => {},
    }),
    (e: Error) => {
      const lines = e.message.split("\n");
      assert.equal(
        lines[0],
        "fence: a Sandbox node has a Multus CNI configuration first in its CNI folder, but jr2 found no Multus DaemonSet in the API (ADR-0084):",
      );
      assert.equal(lines[1], "  n2: /etc/cni/net.d/00-multus.conf (type multus-shim)");
      assert.match(lines[2]!, /^jr2 looked in each namespace for a DaemonSet with "multus"/);
      assert.match(lines[3]!, /^jr2 applied the namespace jr2-system and the DaemonSet jr2-fence-node\. They stay/);
      return true;
    },
  );
  assert.equal(kube.applied.length, 1, "the DaemonSet, and no Multus");
  // jr2's Multus of another converge, applied in the meantime: no refusal.
  const raced = cluster([jr2Multus()]);
  raced.pods = kube.pods;
  await installFence(raced, planOf({ multus: "install", node: "install" }), {
    image: "jr2-operator:1",
    nodes: ["n1", "n2"],
    log: () => {},
  });
  // A Multus of the cluster (the plan says `foreign`): the node's Multus file is that Multus's.
  const foreign = cluster();
  foreign.pods = kube.pods;
  await installFence(foreign, planOf({ multus: "foreign", node: "install" }), {
    image: "jr2-operator:1",
    nodes: ["n1", "n2"],
    log: () => {},
  });
});

// ---- jr2 down --all -------------------------------------------------------------------------------------

test("the removal: the removal form with the running image, its rollout, then the DaemonSet goes; jr2's Multus and its definition go, another stays", async () => {
  const kube = cluster([nodeDs(KIT_VERSION, "jr2-operator:7"), jr2Multus()]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.applied, [JSON.stringify(fenceNodeDaemonSet("jr2-operator:7", { remove: true }))]);
  assert.deepEqual(kube.rollouts, ["jr2-system/daemonset/jr2-fence-node"]);
  assert.deepEqual(kube.deleted, ["jr2-system/daemonset/jr2-fence-node", "manifest"]);
  assert.deepEqual(lines, [
    'removing the rule table "inet jr2_fence" from each node',
    "uninstalling the DaemonSet jr2-system/jr2-fence-node; the CNI plugins bridge, static, tuning stay in /opt/cni/bin on each node",
    "uninstalling Multus (kube-system), which jr2 installed, and its CustomResourceDefinition network-attachment-definitions.k8s.cni.cncf.io",
  ]);

  // A node that does not take the removal in time: a warning with the command, and the DaemonSet goes.
  const slow = cluster([nodeDs(), ...thickMultus({ namespaceIsolation: true })]);
  slow.waitRollout = async () => {
    throw new Error("error: timed out waiting for the condition\nmore");
  };
  const warned: string[] = [];
  await uninstallFence(slow, { log: (l) => warned.push(l) });
  assert.equal(
    warned[1],
    'warning: the rule table "inet jr2_fence" was not removed from each node in 120 s (error: timed out waiting ' +
      "for the condition); on a node that keeps it, run `nft delete table inet jr2_fence` as root",
  );
  assert.deepEqual(slow.deleted, ["jr2-system/daemonset/jr2-fence-node"], "a Multus of another owner stays");

  // No DaemonSet: nothing to remove.
  const empty = cluster();
  await uninstallFence(empty, { log: () => {} });
  assert.deepEqual([empty.applied, empty.deleted], [[], []]);
});

test("the removal keeps jr2's Multus and its definition while the cluster has a NetworkAttachmentDefinition, or when it cannot list them, and says how to remove them", async () => {
  const nad = (namespace: string, name: string): Obj => ({
    kind: "network-attachment-definitions.k8s.cni.cncf.io",
    metadata: { name, namespace },
  });
  const kube = cluster([jr2Multus(), nad("team-a", "macvlan"), nad("team-b", "sriov")]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.deleted, []);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    /^warning: the cluster has NetworkAttachmentDefinitions that are not jr2's \(team-a\/macvlan, team-b\/sriov\), so jr2 keeps the Multus that it installed and its CustomResourceDefinition: their removal deletes each NetworkAttachmentDefinition\. When nothing uses them, remove them: kubectl delete crd network-attachment-definitions\.k8s\.cni\.cncf\.io; /,
  );
  const refused = cluster([jr2Multus()], [], ["network-attachment-definitions.k8s.cni.cncf.io"]);
  const said: string[] = [];
  await uninstallFence(refused, { log: (l) => said.push(l) });
  assert.deepEqual(refused.deleted, []);
  assert.match(
    said[0]!,
    /^warning: jr2 cannot list the NetworkAttachmentDefinitions of the cluster \(Error from server \(Forbidden\)/,
  );
});

test("the removal warns when it cannot read the DaemonSet: the table is not removed in silence", async () => {
  const kube = cluster([], [], ["daemonset"]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.match(
    lines[0]!,
    /^warning: jr2 cannot read the DaemonSet jr2-system\/jr2-fence-node \(Error from server \(Forbidden\).*\), so it did not remove the rule table "inet jr2_fence" from the nodes\. On each node that keeps it, run `nft delete table inet jr2_fence` as root/,
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
