// The Fence's prerequisites (ADR-0084, ADR-0019): what `jr2 up` reads from the cluster before it
// asks, each refusal, the question's text, the DaemonSet of the CNI plugins, the wait for it, and the
// install. Through a fake API; the plugins' script runs here against folders in a temp dir.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  awaitPlugins,
  CNI_VERSION,
  describeInstall,
  installFence,
  multusHostDirs,
  multusManifest,
  MULTUS_VERSION,
  planAsks,
  planFenceInstall,
  pluginsDaemonSet,
  PLUGINS_SCRIPT,
  selects,
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
  };
  return kube as typeof kube & Pick<KubeAdmin, "getJson" | "listJson" | "apply" | "waitRollout">;
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

const pluginsDs = (version = KIT_VERSION, image = "jr2-operator:1"): Obj => ({
  kind: "DaemonSet",
  metadata: {
    name: "jr2-cni-plugins",
    namespace: "jr2-system",
    labels: { app: "jr2-cni-plugins", "jr2.dev/version": version },
  },
  spec: { template: { spec: { containers: [{ image }] } } },
});

// ---- the read ------------------------------------------------------------------------------------------

test("a stock cluster: Multus and the plugins are installed, and the question names each with its version", async () => {
  const plan = await planFenceInstall(cluster(), { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "install", plugins: "install" });
  assert.equal(planAsks(plan), true);
  assert.equal(
    describeInstall(plan),
    "install the Fence's prerequisites: apply the DaemonSet jr2-system/jr2-cni-plugins, which writes the CNI " +
      "plugins bridge, static, tuning v1.10.0 into /opt/cni/bin on each node that has no file of that name (it " +
      "never replaces a file, and the files stay after jr2 down --all); and apply Multus v4.3.2 (thick, " +
      "namespaceIsolation, no global namespace) to kube-system, from the manifest that the CLI ships",
  );
});

test("a cluster that has jr2's Multus and the plugins: nothing to ask; another version of jr2's Multus is an update that asks", async () => {
  const plan = await planFenceInstall(cluster([jr2Multus(), pluginsDs()]), { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "jr2", plugins: "present" });
  assert.equal(planAsks(plan), false);
  assert.equal(describeInstall(plan), undefined);

  const older = await planFenceInstall(cluster([jr2Multus("v4.2.0-thick-1"), pluginsDs()]), { nodes: [] });
  assert.deepEqual(older, { multus: "upgrade", plugins: "present" });
  assert.equal(
    describeInstall(older),
    `install the Fence's prerequisites: update the Multus that jr2 installed in kube-system to ${MULTUS_VERSION}`,
  );
});

test("a Multus that jr2 did not install, with namespaceIsolation and no global namespace, is accepted and left alone", async () => {
  const kube = cluster(thickMultus({ namespaceIsolation: true, globalNamespaces: "" }));
  const plan = await planFenceInstall(kube, { nodes: [node("n1")] });
  assert.deepEqual(plan, { multus: "foreign", plugins: "install" });
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

// ---- the plugins' DaemonSet ---------------------------------------------------------------------------

test("the plugins' DaemonSet: the operator image, root with no capability, no host namespace, the two CNI folders only, on each node", () => {
  const ds = pluginsDaemonSet("ghcr.io/snapwich/jr2-operator:9.9.9") as Record<string, any>;
  assert.equal(ds.metadata.namespace, "jr2-system");
  assert.equal(ds.metadata.labels["jr2.dev/version"], KIT_VERSION);
  const spec = ds.spec.template.spec;
  for (const key of ["hostNetwork", "hostPID", "hostIPC", "serviceAccountName", "priorityClassName"]) {
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
  for (const c of [...spec.initContainers, ...spec.containers]) {
    assert.equal(c.image, "ghcr.io/snapwich/jr2-operator:9.9.9");
    assert.deepEqual(c.securityContext, {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    assert.equal(c.securityContext.privileged, undefined);
  }
  assert.deepEqual(spec.initContainers[0].volumeMounts, [
    { name: "cni-bin", mountPath: "/host/opt/cni/bin" },
    { name: "cni-conf", mountPath: "/host/etc/cni/net.d", readOnly: true },
  ]);
  assert.equal(spec.containers[0].volumeMounts, undefined, "the idle container mounts nothing of the node");
});

/** Run the plugins' script with its folders under `dir` (the script's paths, rewritten). */
async function runScript(dir: string): Promise<{ code: number; message: string }> {
  const script = PLUGINS_SCRIPT.replaceAll("/host/", `${dir}/host/`)
    .replace("SRC=/opt/jr2/cni/bin", `SRC=${dir}/src`)
    .replaceAll("/dev/termination-log", `${dir}/message`);
  const code = await exec("sh", ["-c", script]).then(
    () => 0,
    (e: { code?: number }) => e.code ?? 1,
  );
  return { code, message: await readFile(join(dir, "message"), "utf8").catch(() => "") };
}

async function nodeDirs(opts: { conf?: string[]; bin?: Record<string, string> }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-cni-plugins-"));
  roots.push(dir);
  await mkdir(join(dir, "host/opt/cni/bin"), { recursive: true });
  await mkdir(join(dir, "host/etc/cni/net.d"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  for (const p of ["bridge", "static", "tuning"]) await writeFile(join(dir, "src", p), `jr2 ${p}\n`);
  for (const f of opts.conf ?? []) await writeFile(join(dir, "host/etc/cni/net.d", f), "{}");
  for (const [f, text] of Object.entries(opts.bin ?? {})) await writeFile(join(dir, "host/opt/cni/bin", f), text);
  return dir;
}

test("the plugins' script writes each missing plugin, executable, keeps each file of that name, and says which", async () => {
  const dir = await nodeDirs({ conf: ["10-kindnet.conflist"], bin: { loopback: "x", static: "theirs" } });
  const run = await runScript(dir);
  assert.equal(run.code, 0);
  assert.equal(run.message.trim(), "jr2.cni-plugins ok wrote=bridge tuning kept=static");
  const bin = join(dir, "host/opt/cni/bin");
  assert.deepEqual((await readdir(bin)).sort(), ["bridge", "loopback", "static", "tuning"]);
  assert.equal(await readFile(join(bin, "static"), "utf8"), "theirs", "a file of that name is never replaced");
  assert.equal(await readFile(join(bin, "bridge"), "utf8"), "jr2 bridge\n");
  await chmod(join(bin, "bridge"), 0o755);
  // A second run (a pod again on the node) keeps each.
  assert.equal((await runScript(dir)).message.trim(), "jr2.cni-plugins ok wrote= kept=bridge static tuning");
});

test("the plugins' script fails, and says why, on a node whose CNI folders are not the default ones", async () => {
  const noConf = await runScript(await nodeDirs({ conf: [], bin: { loopback: "x" } }));
  assert.equal(noConf.code, 1);
  assert.match(noConf.message, /^jr2\.cni-plugins fail no CNI configuration in \/etc\/cni\/net\.d on the node/);
  const noBin = await runScript(await nodeDirs({ conf: ["05-cilium.conflist"] }));
  assert.equal(noBin.code, 1);
  assert.match(noBin.message, /^jr2\.cni-plugins fail \/opt\/cni\/bin on the node is empty/);
});

const readyPod = (nodeName: string, message = "jr2.cni-plugins ok wrote=bridge static tuning kept=") => ({
  metadata: { name: `p-${nodeName}` },
  spec: { nodeName },
  status: {
    conditions: [{ type: "Ready", status: "True" }],
    initContainerStatuses: [{ state: { terminated: { exitCode: 0, message } } }],
  },
});

test("the wait: each Sandbox node's Ready pod, and its line; a failed init container or a failed mount refuses (c); no pod in time refuses", async () => {
  const kube = cluster();
  kube.pods = [readyPod("a"), readyPod("b", "jr2.cni-plugins ok wrote= kept=bridge static tuning"), readyPod("x")];
  const got = await awaitPlugins(kube, { nodes: ["a", "b"] });
  assert.deepEqual(
    [...got],
    [
      ["a", "ok wrote=bridge static tuning kept="],
      ["b", "ok wrote= kept=bridge static tuning"],
    ],
  );

  const failed = cluster();
  failed.pods = [
    readyPod("a"),
    {
      metadata: { name: "p-b" },
      spec: { nodeName: "b" },
      status: {
        initContainerStatuses: [
          {
            state: { waiting: { reason: "CrashLoopBackOff" } },
            lastState: { terminated: { exitCode: 1, message: "jr2.cni-plugins fail no CNI configuration in /etc" } },
          },
        ],
      },
    },
  ];
  await assert.rejects(awaitPlugins(failed, { nodes: ["a", "b"], pollMs: 1 }), (e: Error) => {
    const lines = e.message.split("\n");
    assert.equal(lines[0], "fence: the CNI plugins bridge, static, tuning cannot go onto a Sandbox node (ADR-0084):");
    assert.equal(lines[1], "  b: no CNI configuration in /etc");
    assert.match(lines[2]!, /^jr2 puts the plugins into \/opt\/cni\/bin, and the Fence needs nodes whose/);
    return true;
  });

  const mount = cluster();
  mount.pods = [{ metadata: { name: "p-a" }, spec: { nodeName: "a" }, status: { phase: "Pending" } }];
  mount.events = [{ reason: "FailedMount", message: "hostPath type check failed: /opt/cni/bin is not a directory" }];
  let t = 0;
  await assert.rejects(
    awaitPlugins(mount, { nodes: ["a"], pollMs: 1, now: () => (t += 10_000) }),
    /\n {2}a: the kubelet cannot mount a CNI folder: hostPath type check failed: \/opt\/cni\/bin is not a directory\n/,
  );

  const none = cluster();
  t = 0;
  await assert.rejects(
    awaitPlugins(none, { nodes: ["a"], pollMs: 1, now: () => (t += 60_000) }),
    /no Ready pod of the DaemonSet jr2-system\/jr2-cni-plugins on the Sandbox node a in 300 s/,
  );
});

// ---- the install ----------------------------------------------------------------------------------------

test("the install: the plugins first, then Multus and its rollout, with a line for each; an empty plan prints one quiet line", async () => {
  const kube = cluster();
  kube.pods = [readyPod("n1")];
  const lines: string[] = [];
  const plan: FenceInstallPlan = { multus: "install", plugins: "install" };
  await installFence(kube, plan, { image: "jr2-operator:1", nodes: ["n1"], log: (l) => lines.push(l) });
  assert.equal(kube.applied.length, 2);
  assert.match(kube.applied[0]!, /"name":"jr2-cni-plugins"/);
  assert.equal(kube.applied[1], await multusManifest());
  assert.deepEqual(kube.rollouts, ["kube-system/daemonset/kube-multus-ds"]);
  assert.deepEqual(lines, [
    "fence: applying the DaemonSet jr2-system/jr2-cni-plugins (jr2-operator:1)",
    "fence: n1: CNI plugins ok wrote=bridge static tuning kept=",
    "fence: applying Multus v4.3.2 (thick, namespaceIsolation) to kube-system",
    "fence: Multus is ready on each node",
  ]);

  // A later converge: everything is there, with this image. Nothing is applied, and one line.
  const later = cluster([jr2Multus(), pluginsDs(KIT_VERSION, "jr2-operator:1")]);
  later.pods = [readyPod("n1")];
  const quiet: string[] = [];
  await installFence(
    later,
    { multus: "jr2", plugins: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: (l) => quiet.push(l),
    },
  );
  assert.deepEqual(later.applied, []);
  assert.deepEqual(quiet, ["fence: prerequisites in place — jr2's Multus, and the CNI plugins on 1 Sandbox node"]);

  // A new Kit image updates the DaemonSet with no line of its own; a newer Kit's DaemonSet stays.
  const update = cluster([pluginsDs(KIT_VERSION, "jr2-operator:0")]);
  update.pods = [readyPod("n1")];
  const updated: string[] = [];
  await installFence(
    update,
    { multus: "foreign", plugins: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: (l) => updated.push(l),
    },
  );
  assert.equal(update.applied.length, 1);
  assert.deepEqual(updated, [
    "fence: prerequisites in place — the cluster's Multus, and the CNI plugins on 1 Sandbox node",
  ]);
  const newer = cluster([pluginsDs("999.0.0", "jr2-operator:9")]);
  newer.pods = [readyPod("n1")];
  await installFence(
    newer,
    { multus: "foreign", plugins: "present" },
    {
      image: "jr2-operator:1",
      nodes: ["n1"],
      log: () => {},
    },
  );
  assert.deepEqual(newer.applied, []);
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
