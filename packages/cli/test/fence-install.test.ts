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

/** A cluster: objects by `<namespace>/<kind>/<name>`, the CRDs it has, and the lists it answers. */
function cluster(objects: Obj[] = [], crds: string[] = []) {
  const store = new Map<string, Obj>();
  const key = (ns: string | undefined, kind: string, name: string) => `${ns ?? ""}/${kind}/${name}`;
  for (const o of objects) store.set(key(o.metadata.namespace, String(o.kind).toLowerCase(), o.metadata.name), o);
  const kube = {
    applied: [] as string[],
    rollouts: [] as string[],
    reads: [] as string[],
    pods: [] as unknown[],
    events: [] as unknown[],
    async getJson<T = KubeObject>(o: { kind: string; name: string; namespace?: string }): Promise<T | undefined> {
      kube.reads.push(`get ${o.kind} ${o.namespace ?? ""}/${o.name}`);
      return store.get(key(o.namespace, o.kind, o.name)) as T | undefined;
    },
    async listJson<T>(o: {
      kind: string;
      selector?: string;
      fieldSelector?: string;
      allNamespaces?: boolean;
    }): Promise<T[]> {
      kube.reads.push(`list ${o.kind} ${o.selector ?? o.fieldSelector ?? ""}`);
      if (o.kind === "customresourcedefinition") {
        const name = o.fieldSelector!.replace("metadata.name=", "");
        return (crds.includes(name) ? [{ metadata: { name } }] : []) as T[];
      }
      if (o.kind === "pod") return kube.pods as T[];
      if (o.kind === "event") return kube.events as T[];
      const [k, v] = (o.selector ?? "").split("=");
      return [...store.values()].filter(
        (x) =>
          String(x.kind).toLowerCase() === o.kind &&
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

test("a stock cluster: Multus and the fence node are installed, and the question names each, the node's network, NET_ADMIN and the rule table", async () => {
  const plan = await planFenceInstall(cluster(), { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "install", node: "install" });
  assert.equal(planAsks(plan), true);
  assert.equal(
    describeInstall(plan),
    "install the Fence's prerequisites: apply the DaemonSet jr2-system/jr2-fence-node to each node. It runs on " +
      "the node's network with the capability NET_ADMIN (each other capability dropped), and at each start it " +
      "loads the rule table \"inet jr2_fence\" into the node's nftables, which keeps the node's own network stack " +
      "off the bridge jr2fence0; jr2 down --all removes the table. It also writes the CNI plugins bridge, static, " +
      "tuning v1.10.0 into /opt/cni/bin on each node that has no file of that name (it never replaces a file, and " +
      "the files stay after jr2 down --all); and apply Multus v4.3.2 (thick, namespaceIsolation, no global " +
      "namespace) to kube-system, from the manifest that the CLI ships",
  );
});

test("a cluster that has jr2's Multus and the fence node: nothing to ask; another version of jr2's Multus is an update that asks", async () => {
  const plan = await planFenceInstall(cluster([jr2Multus(), nodeDs()]), { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "jr2", node: "present" });
  assert.equal(planAsks(plan), false);
  assert.equal(describeInstall(plan), undefined);

  const older = await planFenceInstall(cluster([jr2Multus("v4.2.0-thick-1"), nodeDs()]), { nodes: [] });
  assert.deepEqual(older, { multus: "upgrade", node: "present" });
  assert.equal(
    describeInstall(older),
    `install the Fence's prerequisites: update the Multus that jr2 installed in kube-system to ${MULTUS_VERSION}`,
  );
});

test("a Multus that jr2 did not install, with namespaceIsolation and no global namespace, is accepted and left alone", async () => {
  const kube = cluster(thickMultus({ namespaceIsolation: true, globalNamespaces: "" }));
  const plan = await planFenceInstall(kube, { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "foreign", node: "install" });
  assert.doesNotMatch(describeInstall(plan)!, /Multus/);
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
  assert.equal(
    (await planFenceInstall(cluster([thin(["--namespace-isolation=true"])]), { nodes: [] })).multus,
    "foreign",
  );
});

test("refusal (a): a ConfigMap of the settings that jr2 cannot read refuses, and says what to read", async () => {
  const objects = thickMultus({ namespaceIsolation: true }).slice(0, 1);
  await assert.rejects(
    planFenceInstall(cluster(objects), { nodes: [] }),
    /jr2 cannot read the ConfigMap kube-system\/multus-daemon-config that holds its settings/,
  );
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
  const ciliumConfig = (value: string): Obj => ({
    kind: "ConfigMap",
    metadata: { name: "cilium-config", namespace: "kube-system" },
    data: { "cni-exclusive": value },
  });
  await assert.rejects(
    planFenceInstall(cluster([ciliumConfig("true")]), { nodes: [node("n1"), node("n2")] }),
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
  assert.equal((await planFenceInstall(cluster([ciliumConfig("false")]), { nodes: [node("n1")] })).multus, "install");

  const cnc = (name: string, value: string, selector: object): Obj => ({
    kind: "ciliumnodeconfigs.cilium.io",
    metadata: { name, namespace: "kube-system" },
    spec: { nodeSelector: selector, defaults: { "cni-exclusive": value } },
  });
  const crd = ["ciliumnodeconfigs.cilium.io"];
  // A CiliumNodeConfig that sets false for the Sandbox nodes overrides the ConfigMap's true.
  const sandbox = { matchLabels: { pool: "sandbox" } };
  await planFenceInstall(cluster([ciliumConfig("true"), cnc("sb", "false", sandbox)], crd), {
    nodes: [node("n1", { pool: "sandbox" })],
  });
  // One that sets true for a Sandbox node refuses and names it.
  await assert.rejects(
    planFenceInstall(cluster([ciliumConfig("false"), cnc("strict", "true", sandbox)], crd), {
      nodes: [node("n1", { pool: "sandbox" }), node("n2")],
    }),
    /cni-exclusive: "true" for the Sandbox node n1 in the CiliumNodeConfig kube-system\/strict.*Set "cni-exclusive": "false" in spec\.defaults of the CiliumNodeConfig kube-system\/strict/s,
  );
  // One for other nodes changes nothing here.
  await planFenceInstall(cluster([cnc("other", "true", { matchLabels: { pool: "gpu" } })], crd), {
    nodes: [node("n1", { pool: "sandbox" })],
  });
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
    "the table first: a node whose plugins fail still gets it",
  );
  const [rules, install] = spec.initContainers;
  assert.deepEqual(rules.securityContext, { ...RESTRICTED, capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] } });
  assert.deepEqual(rules.command, ["sh", "-c", RULES_SCRIPT]);
  assert.equal(rules.volumeMounts, undefined, "the rules container mounts nothing of the node");
  for (const c of [install, ...spec.containers]) assert.deepEqual(c.securityContext, RESTRICTED);
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

test("the rule table: four chains on the bridge jr2fence0 alone; notrack before conntrack and NAT; drop between the bridge and the node", () => {
  assert.match(FENCE_RULES, /^table inet jr2_fence \{\n/);
  const chains = [
    ...FENCE_RULES.matchAll(/chain (\w+) \{\n\s+type filter hook (\w+) priority (-?\d+); policy accept;\n([^}]*)\}/g),
  ];
  assert.deepEqual(
    chains.map((c) => [c[1], c[2], Number(c[3])]),
    [
      ["pre", "prerouting", -350],
      ["input", "input", -200],
      ["forward", "forward", -200],
      ["out", "output", -200],
    ],
  );
  const rules = chains.flatMap((c) =>
    c[4]!
      .trim()
      .split("\n")
      .map((l) => l.trim()),
  );
  assert.deepEqual(rules, [
    'iifname "jr2fence0" counter notrack',
    'iifname "jr2fence0" counter drop',
    'iifname "jr2fence0" oifname != "jr2fence0" counter drop',
    'iifname != "jr2fence0" oifname "jr2fence0" counter drop',
    'oifname "jr2fence0" counter drop',
  ]);
  // The policy of each chain accepts: the table changes nothing that does not touch the bridge.
  assert.equal((FENCE_RULES.match(/policy accept;/g) ?? []).length, 4);
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
  // Make it when it is missing, delete it, make it again: one transaction, so no window and no duplicate.
  assert.equal(load0, `table inet jr2_fence\ndelete table inet jr2_fence\n${FENCE_RULES}\n`);
  assert.equal(await readFile(join(nft.dir, "load-1"), "utf8"), load0);

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

/** Run the plugins' script with its folders under `dir` (the script's paths, rewritten). */
async function runScript(dir: string): Promise<{ code: number; message: string }> {
  const script = PLUGINS_SCRIPT.replaceAll("/host/", `${dir}/host/`).replace("SRC=/opt/jr2/cni/bin", `SRC=${dir}/src`);
  return runWith(script, dir);
}

async function nodeDirs(opts: { conf?: string[]; bin?: Record<string, string> }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-fence-node-"));
  roots.push(dir);
  await mkdir(join(dir, "host/opt/cni/bin"), { recursive: true });
  await mkdir(join(dir, "host/etc/cni/net.d"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  for (const p of ["bridge", "static", "tuning"]) await writeFile(join(dir, "src", p), plugin(p), { mode: 0o755 });
  for (const f of opts.conf ?? []) await writeFile(join(dir, "host/etc/cni/net.d", f), "{}");
  for (const [f, text] of Object.entries(opts.bin ?? {})) {
    await writeFile(join(dir, "host/opt/cni/bin", f), text, { mode: 0o755 });
  }
  return dir;
}

test("the plugins' script writes each missing plugin, executable, keeps each file of that name, and says which and the bridge's version", async () => {
  const dir = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { loopback: "x", static: "theirs" } });
  const run = await runScript(dir);
  assert.equal(run.code, 0);
  assert.equal(run.message.trim(), "jr2.fence-node ok wrote=bridge tuning kept=static bridge=v1.10.0");
  const bin = join(dir, "host/opt/cni/bin");
  assert.deepEqual((await readdir(bin)).sort(), ["bridge", "loopback", "static", "tuning"]);
  assert.equal(await readFile(join(bin, "static"), "utf8"), "theirs", "a file of that name is never replaced");
  assert.equal(await readFile(join(bin, "bridge"), "utf8"), plugin("bridge"));
  // A second run (a pod again on the node) keeps each.
  assert.equal(
    (await runScript(dir)).message.trim(),
    "jr2.fence-node ok wrote= kept=bridge static tuning bridge=v1.10.0",
  );
});

test(`the plugins' script refuses a bridge of the node older than v${BRIDGE_MIN_VERSION}, or one whose version it cannot read, and keeps it`, async () => {
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
        ? `jr2.fence-node ok wrote=static tuning kept=bridge bridge=${version}`
        : `jr2.fence-node fail bridge /opt/cni/bin/bridge is ${version}, older than v${BRIDGE_MIN_VERSION}`,
    );
    assert.equal(await readFile(join(dir, "host/opt/cni/bin/bridge"), "utf8"), plugin("bridge", version));
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

test("the plugins' script fails, and says why, on a node whose CNI folders are not the default ones", async () => {
  const noConf = await runScript(await nodeDirs({ conf: [], bin: { loopback: "x" } }));
  assert.equal(noConf.code, 1);
  assert.match(noConf.message, /^jr2\.fence-node fail folder no CNI configuration in \/etc\/cni\/net\.d on the node/);
  const noBin = await runScript(await nodeDirs({ conf: ["05-cilium.conflist"] }));
  assert.equal(noBin.code, 1);
  assert.match(noBin.message, /^jr2\.fence-node fail folder \/opt\/cni\/bin on the node is empty/);
});

const readyPod = (nodeName: string, install = "jr2.fence-node ok wrote=bridge static tuning kept= bridge=v1.10.0") => ({
  metadata: { name: `p-${nodeName}` },
  spec: { nodeName },
  status: {
    conditions: [{ type: "Ready", status: "True" }],
    initContainerStatuses: [
      { name: "rules", state: { terminated: { exitCode: 0, message: "jr2.fence-node ok rules=loaded\n" } } },
      { name: "install", state: { terminated: { exitCode: 0, message: install } } },
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

test("the wait: each Sandbox node's Ready pod, and its lines; a failed folder, bridge or rule table refuses with its node and advice; no pod in time refuses", async () => {
  const kube = cluster();
  kube.pods = [
    readyPod("a"),
    readyPod("b", "jr2.fence-node ok wrote= kept=bridge static tuning bridge=v1.9.1"),
    readyPod("x"),
  ];
  const got = await awaitFenceNodes(kube, { nodes: ["a", "b"] });
  assert.deepEqual(
    [...got],
    [
      ["a", "rules=loaded wrote=bridge static tuning kept= bridge=v1.10.0"],
      ["b", "rules=loaded wrote= kept=bridge static tuning bridge=v1.9.1"],
    ],
  );

  const failed = cluster();
  failed.pods = [
    readyPod("a"),
    failedPod("b", [
      { name: "rules", message: "jr2.fence-node ok rules=loaded" },
      { name: "install", message: "jr2.fence-node fail folder no CNI configuration in /etc" },
    ]),
    failedPod("c", [
      { name: "rules", message: "jr2.fence-node ok rules=loaded" },
      { name: "install", message: "jr2.fence-node fail bridge /opt/cni/bin/bridge is v1.7.1, older than v1.8.0" },
    ]),
    failedPod("d", [
      { name: "rules", message: "jr2.fence-node fail rules nft could not load the table inet jr2_fence: x" },
    ]),
  ];
  await assert.rejects(awaitFenceNodes(failed, { nodes: ["a", "b", "c", "d"], pollMs: 1 }), (e: Error) => {
    const lines = e.message.split("\n");
    assert.equal(lines[0], "fence: the DaemonSet jr2-system/jr2-fence-node failed on 3 Sandbox nodes (ADR-0084):");
    assert.equal(lines[1], "  b: no CNI configuration in /etc");
    assert.equal(lines[2], "  c: /opt/cni/bin/bridge is v1.7.1, older than v1.8.0");
    assert.equal(lines[3], "  d: nft could not load the table inet jr2_fence: x");
    assert.match(lines[4]!, /^jr2 puts the plugins bridge, static, tuning into \/opt\/cni\/bin, and the Fence needs/);
    assert.match(lines[5]!, /^jr2 never replaces a plugin file\. A bridge plugin older than v1\.8\.0 /);
    assert.match(
      lines[6]!,
      /^The node must have nftables with the inet family, and the pod needs the capability NET_ADMIN/,
    );
    assert.match(lines[7]!, /Then run `jr2 up` again\.$/);
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
    /no Ready pod of the DaemonSet jr2-system\/jr2-fence-node on the Sandbox node a in 300 s/,
  );
});

// ---- the install ----------------------------------------------------------------------------------------

test("the install: the fence node first, then Multus and its rollout, with a line for each; an empty plan prints one quiet line", async () => {
  const kube = cluster();
  kube.pods = [readyPod("n1")];
  const lines: string[] = [];
  const plan: FenceInstallPlan = { multus: "install", node: "install" };
  await installFence(kube, plan, { image: "jr2-operator:1", nodes: ["n1"], log: (l) => lines.push(l) });
  assert.equal(kube.applied.length, 2);
  assert.deepEqual(JSON.parse(kube.applied[0]!), fenceNodeDaemonSet("jr2-operator:1"));
  assert.equal(kube.applied[1], await multusManifest());
  assert.deepEqual(kube.rollouts, ["kube-system/daemonset/kube-multus-ds"]);
  assert.deepEqual(lines, [
    "fence: applying the DaemonSet jr2-system/jr2-fence-node (jr2-operator:1)",
    "fence: n1: rules=loaded wrote=bridge static tuning kept= bridge=v1.10.0",
    "fence: applying Multus v4.3.2 (thick, namespaceIsolation) to kube-system",
    "fence: Multus is ready on each node",
  ]);

  // A later converge: everything is there. The DaemonSet is applied again, which changes nothing
  // when it is the same, and puts back the template that an interrupted removal left; one line.
  const later = cluster([jr2Multus(), nodeDs(KIT_VERSION, "jr2-operator:1")]);
  later.pods = [readyPod("n1")];
  const quiet: string[] = [];
  await installFence(
    later,
    { multus: "jr2", node: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: (l) => quiet.push(l),
    },
  );
  assert.deepEqual(later.applied, [JSON.stringify(fenceNodeDaemonSet("jr2-operator:1"))]);
  assert.deepEqual(quiet, [
    "fence: prerequisites in place — jr2's Multus, and the rule table and the CNI plugins on 1 Sandbox node",
  ]);

  // A new Kit image updates the DaemonSet with no line of its own; a newer Kit's DaemonSet stays.
  const update = cluster([nodeDs(KIT_VERSION, "jr2-operator:0")]);
  update.pods = [readyPod("n1")];
  const updated: string[] = [];
  await installFence(
    update,
    { multus: "foreign", node: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: (l) => updated.push(l),
    },
  );
  assert.equal(update.applied.length, 1);
  assert.deepEqual(updated, [
    "fence: prerequisites in place — the cluster's Multus, and the rule table and the CNI plugins on 1 Sandbox node",
  ]);
  const newer = cluster([nodeDs("999.0.0", "jr2-operator:9")]);
  newer.pods = [readyPod("n1")];
  await installFence(
    newer,
    { multus: "foreign", node: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: () => {},
    },
  );
  assert.deepEqual(newer.applied, []);
});

// ---- jr2 down --all -------------------------------------------------------------------------------------

test("the removal: the removal form with the running image, its rollout, then the DaemonSet goes; jr2's Multus goes, another stays", async () => {
  const kube = cluster([nodeDs(KIT_VERSION, "jr2-operator:7"), jr2Multus()]);
  const lines: string[] = [];
  await uninstallFence(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.applied, [JSON.stringify(fenceNodeDaemonSet("jr2-operator:7", { remove: true }))]);
  assert.deepEqual(kube.rollouts, ["jr2-system/daemonset/jr2-fence-node"]);
  assert.deepEqual(kube.deleted, ["jr2-system/daemonset/jr2-fence-node", "manifest"]);
  assert.deepEqual(lines, [
    'removing the rule table "inet jr2_fence" from each node',
    "uninstalling the DaemonSet jr2-system/jr2-fence-node; the CNI plugins bridge, static, tuning stay in /opt/cni/bin on each node",
    "uninstalling Multus (kube-system), which jr2 installed",
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
