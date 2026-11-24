// jr2's admission policies of the Fence (ADR-0084): their objects, the read before the question, the
// apply at each converge, the dry-run check, and the removal. Through a fake API. The CEL itself runs
// against a real API server in the @kind tier (features/kind.feature).

import assert from "node:assert/strict";
import { test } from "node:test";
import { KIT_VERSION } from "../src/deploy.ts";
import {
  applyFenceGuard,
  ATTACHMENT_GUARD,
  attachmentGuardRefusal,
  auditFenceGuard,
  auditFenceGuardObjects,
  checkFenceGuard,
  fenceGuardObjects,
  GUARD_ATTACHMENTS,
  GUARD_PODS,
  planFenceGuard,
  POD_GUARD,
  podGuardRefusal,
  removeFenceGuard,
} from "../src/fence-guard.ts";

type Obj = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: Record<string, any>;
};

const objects = () => (fenceGuardObjects() as { items: Obj[] }).items;

test("the two policies and their bindings: Fail, Deny, each namespace, and the pods' rule on CREATE and on UPDATE also through pods/status, and on CREATE of a Binding", () => {
  const items = objects();
  assert.deepEqual(
    items.map((o) => `${o.kind}/${o.metadata.name}`),
    [
      `ValidatingAdmissionPolicy/${GUARD_PODS}`,
      `ValidatingAdmissionPolicyBinding/${GUARD_PODS}`,
      `ValidatingAdmissionPolicy/${GUARD_ATTACHMENTS}`,
      `ValidatingAdmissionPolicyBinding/${GUARD_ATTACHMENTS}`,
    ],
  );
  for (const o of items) {
    assert.deepEqual(o.metadata.labels, { "app.kubernetes.io/managed-by": "jr2", "jr2.dev/version": KIT_VERSION });
  }
  const [pods, podsBinding, nads, nadsBinding] = items as [Obj, Obj, Obj, Obj];
  for (const [policy, binding] of [
    [pods, podsBinding],
    [nads, nadsBinding],
  ] as const) {
    assert.equal(policy.spec.failurePolicy, "Fail");
    assert.deepEqual(binding.spec, { policyName: policy.metadata.name, validationActions: ["Deny"] });
  }
  assert.deepEqual(pods.spec.matchConstraints, {
    resourceRules: [
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["pods", "pods/status"] },
      // A Binding's annotations are merged into its pod.
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods/binding", "bindings"] },
    ],
  });
  assert.deepEqual(nads.spec.matchConstraints, {
    resourceRules: [
      {
        apiGroups: ["k8s.cni.cncf.io"],
        apiVersions: ["*"],
        operations: ["CREATE", "UPDATE"],
        resources: ["network-attachment-definitions"],
      },
    ],
  });
  // The variables are the clauses, in their order, so each one is named in the policy as here.
  assert.deepEqual(
    pods.spec.variables,
    Object.entries(POD_GUARD).map(([name, expression]) => ({ name, expression })),
  );
  assert.deepEqual(
    nads.spec.variables,
    Object.entries(ATTACHMENT_GUARD).map(([name, expression]) => ({ name, expression })),
  );
});

test("the CEL names both annotations, the reserved prefix, the escape \\u, the Instance label, the bridge, and a comma list of the pod's own namespace", () => {
  assert.equal(
    POD_GUARD.fence,
    "['v1.multus-cni.io/default-network', 'k8s.v1.cni.cncf.io/networks'].filter(k, k in variables.annotations && " +
      "!(k in variables.before && variables.before[k] == variables.annotations[k]) && " +
      "(variables.annotations[k].contains('jr2-fence-') || variables.annotations[k].contains(r'\\u')))",
  );
  assert.equal(POD_GUARD.instance, "'jr2.dev/instance' in namespaceObject.metadata.?labels.orValue({})");
  assert.equal(
    POD_GUARD.own,
    "'^' + namespaceObject.metadata.name + '/[a-z0-9]([-a-z0-9]*[a-z0-9])?(@[a-z0-9]+)?(,' + " +
      "namespaceObject.metadata.name + '/[a-z0-9]([-a-z0-9]*[a-z0-9])?(@[a-z0-9]+)?)*$'",
  );
  assert.equal(ATTACHMENT_GUARD.bridge, "variables.config.contains('jr2fence0') || variables.config.contains(r'\\u')");
  const [pods, , nads] = objects() as [Obj, Obj, Obj];
  assert.deepEqual(
    pods.spec.validations.map((v: { expression: string }) => v.expression),
    [
      "variables.fence.size() == 0 || variables.instance",
      "variables.fence.all(k, variables.annotations[k].matches(variables.own))",
    ],
  );
  assert.deepEqual(
    nads.spec.validations.map((v: { expression: string }) => v.expression),
    ["!variables.bridge || (variables.instance && object.metadata.name.startsWith('jr2-fence-'))"],
  );
});

/** A fake API with the guard's objects at `version`, or none. */
function api(version: string | undefined, opts: { partial?: boolean; refuseApply?: boolean } = {}) {
  const made = (kind: string, name: string) => ({
    kind,
    metadata: { name, labels: version !== undefined ? { "jr2.dev/version": version } : {} },
  });
  const kube = {
    applied: [] as string[],
    deleted: [] as string[],
    async listJson<T>(o: { kind: string }): Promise<T[]> {
      if (version === undefined) return [];
      if (o.kind === "validatingadmissionpolicy") {
        return [made(o.kind, GUARD_PODS), made(o.kind, GUARD_ATTACHMENTS), made(o.kind, "other-policy")] as T[];
      }
      if (o.kind === "validatingadmissionpolicybinding") {
        return (
          opts.partial ? [made(o.kind, GUARD_PODS)] : [made(o.kind, GUARD_PODS), made(o.kind, GUARD_ATTACHMENTS)]
        ) as T[];
      }
      throw new Error(`unexpected ${o.kind}`);
    },
    async apply(o: { manifest: string }): Promise<void> {
      if (opts.refuseApply) {
        throw new Error(
          'kubectl apply exited (1): Error from server (Forbidden): validatingadmissionpolicies is forbidden: User "u" cannot create',
        );
      }
      kube.applied.push(o.manifest);
    },
    async deleteObject(o: { kind: string; name: string }): Promise<void> {
      kube.deleted.push(`${o.kind}/${o.name}`);
    },
  };
  return kube;
}

test("the read: all four objects are present, of any Kit; a missing one is an install, which asks", async () => {
  assert.equal(await planFenceGuard(api(KIT_VERSION)), "present");
  assert.equal(await planFenceGuard(api("0.0.1")), "present");
  assert.equal(await planFenceGuard(api(undefined)), "install");
  assert.equal(await planFenceGuard(api(KIT_VERSION, { partial: true })), "install");
});

test("the apply: at each converge whose Kit is not older; a newer Kit's policies stay; a refused apply stops the converge with what to grant", async () => {
  const lines: string[] = [];
  const fresh = api(undefined);
  await applyFenceGuard(fresh, { log: (l) => lines.push(l) });
  assert.deepEqual(fresh.applied, [JSON.stringify(fenceGuardObjects())]);
  assert.deepEqual(lines, [
    "fence: applying the admission policies jr2-fence-guard-pods and jr2-fence-guard-attachments, each with its binding",
  ]);
  // Present: applied again with no line (an apply that changes nothing changes nothing).
  const again = api(KIT_VERSION);
  const quiet: string[] = [];
  await applyFenceGuard(again, { log: (l) => quiet.push(l) });
  assert.equal(again.applied.length, 1);
  assert.deepEqual(quiet, []);
  const newer = api("999.0.0");
  await applyFenceGuard(newer, { log: () => {} });
  assert.deepEqual(newer.applied, []);
  await assert.rejects(applyFenceGuard(api(undefined, { refuseApply: true }), { log: () => {} }), (e: Error) => {
    assert.match(
      e.message,
      /^fence: jr2 cannot apply its admission policies jr2-fence-guard-pods and jr2-fence-guard-attachments with their bindings \(kubectl apply exited \(1\): Error from server \(Forbidden\)/,
    );
    assert.match(e.message, /no attachment of the Fence may exist without them \(ADR-0084\)/);
    assert.match(e.message, /create and update ValidatingAdmissionPolicies and ValidatingAdmissionPolicyBindings/);
    return true;
  });
});

/** A fake of server-side dry runs: `answer` says what the API server does with each object. */
function dryRuns(answer: (o: any, call: number) => "admit" | string) {
  const seen: any[] = [];
  return {
    seen,
    async dryRunCreate({ manifest }: { manifest: string }): Promise<{ spec?: { resources?: unknown } }> {
      const o = JSON.parse(manifest);
      seen.push(o);
      const said = answer(o, seen.length);
      if (said === "admit") return {};
      throw new Error(`kubectl create --dry-run=server exited (1): ${said}`);
    },
  };
}
const denial = (policy: string) =>
  `Error from server (Forbidden): pods "x" is forbidden: ValidatingAdmissionPolicy '${policy}' with binding '${policy}' denied request: no`;
const byPolicy = (o: any) => denial(o.kind === "Pod" ? GUARD_PODS : GUARD_ATTACHMENTS);

test("the check: three server-side dry runs from a namespace that is not an Instance's, each denied by jr2's policy", async () => {
  const kube = dryRuns(byPolicy);
  await checkFenceGuard(kube, { namespace: "inst" });
  assert.deepEqual(
    kube.seen.map((o) => [o.kind, o.metadata.namespace, o.metadata.annotations ?? o.spec.config]),
    [
      ["Pod", "jr2-system", { "v1.multus-cni.io/default-network": "inst/jr2-fence-0" }],
      ["Pod", "jr2-system", { "k8s.v1.cni.cncf.io/networks": "inst/jr2-fence-0" }],
      [
        "NetworkAttachmentDefinition",
        "jr2-system",
        '{"cniVersion":"1.0.0","name":"check","type":"bridge","bridge":"jr2fence0"}',
      ],
    ],
  );
  // The probe pod passes each Pod Security level, so only jr2's policy can deny it there.
  const pod = kube.seen[0];
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  // An Instance in jr2-system: the dry runs go to default.
  const other = dryRuns(byPolicy);
  await checkFenceGuard(other, { namespace: "jr2-system" });
  assert.equal(other.seen[0].metadata.namespace, "default");
});

test("the check: a policy that is not in force yet is asked again; one that admits past the bound, or a denial by something else, refuses with what it saw", async () => {
  let t = 0;
  const settling = dryRuns((o, call) => (call <= 2 ? "admit" : byPolicy(o)));
  await checkFenceGuard(settling, { namespace: "inst", pollMs: 1, now: () => (t += 1_000) });
  assert.equal(settling.seen.length, 5);

  t = 0;
  await assert.rejects(
    checkFenceGuard(
      dryRuns((o) => (o.kind === "Pod" ? byPolicy(o) : "admit")),
      { namespace: "inst", pollMs: 1, now: () => (t += 10_000) },
    ),
    (e: Error) => {
      assert.match(
        e.message,
        /^fence: the cluster admits a NetworkAttachmentDefinition in the namespace jr2-system on the bridge jr2fence0 \(a server-side dry run, which makes nothing\), so jr2's admission policy jr2-fence-guard-attachments is not in force/,
      );
      assert.match(e.message, /No attachment of the Fence was applied\.$/);
      return true;
    },
  );
  await assert.rejects(
    checkFenceGuard(
      dryRuns(() => 'Error from server (Forbidden): pods "x" is forbidden: violates PodSecurity "restricted:latest"'),
      { namespace: "inst" },
    ),
    /fence: jr2 cannot see its admission policy jr2-fence-guard-pods in force: the server-side dry run of a pod in the namespace jr2-system with v1\.multus-cni\.io\/default-network: inst\/jr2-fence-0 was refused, but not by that policy \(kubectl create --dry-run=server exited \(1\): Error from server \(Forbidden\): pods "x" is forbidden: violates PodSecurity/,
  );
});

test("the removal: the bindings, then the policies; a delete that fails warns", async () => {
  const kube = api(KIT_VERSION);
  const lines: string[] = [];
  await removeFenceGuard(kube, { log: (l) => lines.push(l) });
  assert.deepEqual(kube.deleted, [
    `validatingadmissionpolicybinding/${GUARD_PODS}`,
    `validatingadmissionpolicybinding/${GUARD_ATTACHMENTS}`,
    `validatingadmissionpolicy/${GUARD_PODS}`,
    `validatingadmissionpolicy/${GUARD_ATTACHMENTS}`,
  ]);
  assert.deepEqual(lines, [
    "uninstalling the admission policies jr2-fence-guard-pods and jr2-fence-guard-attachments and their bindings",
  ]);
  const failing = {
    async deleteObject(): Promise<void> {
      throw new Error("Error from server (Forbidden): cannot delete");
    },
  };
  const warned: string[] = [];
  await removeFenceGuard(failing, { log: (l) => warned.push(l) });
  assert.equal(warned.length, 5);
  assert.match(
    warned[1]!,
    /^warning: jr2 could not delete the validatingadmissionpolicybinding jr2-fence-guard-pods \(Error from server \(Forbidden\): cannot delete\)/,
  );
});

// ---- the rules in TypeScript, for the audit -------------------------------------------------------------
// One table for the pods' rule and one for the attachments' rule. The @kind scenario judges each row of
// its matrix with the API server (the CEL) and with these functions, so the two cannot drift apart.

const own = { name: "inst", labels: { "jr2.dev/instance": "default" } };
const peer = { name: "inst-b", labels: { "jr2.dev/instance": "b" } };
const plain = { name: "other" };
const DN = "v1.multus-cni.io/default-network";
const NW = "k8s.v1.cni.cncf.io/networks";

test("the pods' rule in TypeScript admits and refuses as the CEL does", () => {
  const cases: Array<[typeof own | typeof plain, Record<string, string> | undefined, "admit" | string]> = [
    [own, { [DN]: "inst/jr2-fence-3" }, "admit"],
    [own, { [NW]: "inst/jr2-fence-uplink@net1" }, "admit"],
    [own, { [NW]: "inst/jr2-fence-1,inst/x@net2" }, "admit"],
    [own, undefined, "admit"],
    [own, { other: "inst-b/jr2-fence-3" }, "admit"],
    [own, { [NW]: "other/macvlan" }, "admit"],
    [plain, { [NW]: "other/macvlan" }, "admit"],
    [plain, { [DN]: "kube-system/calico" }, "admit"],
    [plain, { [NW]: '[{"name":"macvlan"}]' }, "admit"],
    [own, { [DN]: "jr2-fence-3" }, `own ${DN}`],
    [own, { [NW]: "jr2-fence-3" }, `own ${NW}`],
    [own, { [DN]: "inst-b/jr2-fence-3" }, `own ${DN}`],
    [own, { [NW]: "inst/jr2-fence-1,inst-b/jr2-fence-1" }, `own ${NW}`],
    [own, { [NW]: '[{"name":"jr2-fence-3","namespace":"inst"}]' }, `own ${NW}`],
    [own, { [NW]: "inst/jr2-fence-1, inst/jr2-fence-2" }, `own ${NW}`],
    [own, { [NW]: " inst/jr2-fence-1" }, `own ${NW}`],
    [own, { [NW]: "inst/jr2-fence-1\n" }, `own ${NW}`],
    [own, { [DN]: "inst/x", [NW]: "inst-b/jr2-fence-1" }, `own ${NW}`],
    [peer, { [DN]: "inst/jr2-fence-3" }, `own ${DN}`],
    [plain, { [DN]: "inst/jr2-fence-3" }, `instance ${DN}`],
    [plain, { [NW]: "inst/jr2-fence-3@net1" }, `instance ${NW}`],
    [plain, { [NW]: '[{"name":"jr2\\u002dfence-3","namespace":"inst"}]' }, `instance ${NW}`],
    [plain, { [NW]: "other/jr2-fence-3" }, `instance ${NW}`],
    [plain, { [NW]: "other/x\\u0041" }, `instance ${NW}`],
  ];
  const wrong: string[] = [];
  for (const [ns, annotations, want] of cases) {
    const r = podGuardRefusal(annotations, ns);
    const got = r === undefined ? "admit" : `${r.why.startsWith("the namespace") ? "instance" : "own"} ${r.annotation}`;
    if (got !== want) wrong.push(`${ns.name} ${JSON.stringify(annotations)}: ${got}, not ${want}`);
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(podGuardRefusal({ [DN]: "inst/jr2-fence-3" }, plain), {
    annotation: DN,
    why: "the namespace other is not the namespace of a jr2 Instance (it has no label jr2.dev/instance)",
  });
});

test("the attachments' rule in TypeScript admits and refuses as the CEL does", () => {
  const bridge = (name: string) => JSON.stringify({ cniVersion: "1.0.0", name: "c", type: "bridge", bridge: name });
  const cases: Array<[typeof own | typeof plain, string, string | undefined, "admit" | "deny"]> = [
    [own, "jr2-fence-check", bridge("jr2fence0"), "admit"],
    [own, "jr2-fence-check", bridge("br0"), "admit"],
    [own, "check", bridge("br0"), "admit"],
    [plain, "check", bridge("br0"), "admit"],
    [plain, "check", undefined, "admit"],
    [own, "check", bridge("jr2fence0"), "deny"],
    [plain, "jr2-fence-check", bridge("jr2fence0"), "deny"],
    [plain, "check", JSON.stringify({ type: "macvlan", master: "jr2fence0" }), "deny"],
    [plain, "check", '{"type":"bridge","bridge":"jr2\\u0066ence0"}', "deny"],
    [own, "check", '{"type":"bridge","bridge":"jr2\\u0066ence0"}', "deny"],
  ];
  const wrong: string[] = [];
  for (const [ns, name, config, want] of cases) {
    const got = attachmentGuardRefusal(name, config, ns) === undefined ? "admit" : "deny";
    if (got !== want) wrong.push(`${ns.name}/${name} ${config}: ${got}, not ${want}`);
  }
  assert.deepEqual(wrong, []);
});

test("the audit names each pod and each attachment that the policies refuse now, also a pod that has ended", () => {
  const pod = (namespace: string, name: string, annotations?: Record<string, string>, phase?: string) => ({
    metadata: { name, namespace, ...(annotations !== undefined ? { annotations } : {}) },
    ...(phase !== undefined ? { status: { phase } } : {}),
  });
  const lines = auditFenceGuardObjects(
    [own, peer, plain],
    [
      pod("inst", "harness", { [DN]: "inst/jr2-fence-0" }, "Running"),
      pod("other", "plain", { [NW]: "other/macvlan" }, "Running"),
      pod("other", "waits", { [DN]: "inst/jr2-fence-0" }, "Pending"),
      pod("other", "done", { [NW]: "inst/jr2-fence-uplink@net1" }, "Succeeded"),
      pod("inst-b", "cross", { [DN]: "inst/jr2-fence-0" }),
      // A namespace that the list did not have is judged with no label.
      pod("new", "late", { [DN]: "inst/jr2-fence-1" }, "Pending"),
    ],
    [
      { metadata: { name: "jr2-fence-0", namespace: "inst" }, spec: { config: '{"bridge":"jr2fence0"}' } },
      { metadata: { name: "evil", namespace: "other" }, spec: { config: '{"bridge":"jr2fence0"}' } },
      { metadata: { name: "fine", namespace: "other" }, spec: { config: '{"bridge":"br0"}' } },
    ],
  );
  assert.deepEqual(lines, [
    "the pod other/waits (Pending), v1.multus-cni.io/default-network: inst/jr2-fence-0 — the namespace other is not the namespace of a jr2 Instance (it has no label jr2.dev/instance)",
    "the pod other/done (Succeeded), k8s.v1.cni.cncf.io/networks: inst/jr2-fence-uplink@net1 — the namespace other is not the namespace of a jr2 Instance (it has no label jr2.dev/instance)",
    "the pod inst-b/cross, v1.multus-cni.io/default-network: inst/jr2-fence-0 — a network in it is not <namespace>/<name> or <namespace>/<name>@<interface> with the namespace of the pod, inst-b, in a comma list with no JSON and no space",
    "the pod new/late (Pending), v1.multus-cni.io/default-network: inst/jr2-fence-1 — the namespace new is not the namespace of a jr2 Instance (it has no label jr2.dev/instance)",
    "the NetworkAttachmentDefinition other/evil — its config holds jr2fence0 or a JSON escape \\u, and it is not in the namespace of a jr2 Instance (the label jr2.dev/instance) with a name that starts with jr2-fence-",
  ]);
});

test("the audit lists the namespaces, the pods and the attachments of each namespace; it refuses with each one named and what to do; a list that fails refuses", async () => {
  const lists: string[] = [];
  const kube = (pods: unknown[], fail?: string) => ({
    async listJson<T>(o: { kind: string; allNamespaces?: boolean }): Promise<T[]> {
      lists.push(`${o.kind}${o.allNamespaces ? " (all)" : ""}`);
      if (o.kind === fail) throw new Error("kubectl get exited (1): Error from server (Forbidden): cannot list");
      if (o.kind === "namespace")
        return [{ metadata: { name: "inst", labels: own.labels } }, { metadata: { name: "other" } }] as T[];
      if (o.kind === "pod") return pods as T[];
      return [] as T[];
    },
  });
  await auditFenceGuard(
    kube([{ metadata: { name: "h", namespace: "inst", annotations: { [DN]: "inst/jr2-fence-0" } } }]),
    {},
  );
  assert.deepEqual(lists, ["namespace", "pod (all)", "network-attachment-definitions.k8s.cni.cncf.io (all)"]);
  const many = Array.from({ length: 22 }, (_, i) => ({
    metadata: { name: `p${i}`, namespace: "other", annotations: { [DN]: "inst/jr2-fence-0" } },
    status: { phase: "Pending" },
  }));
  await assert.rejects(auditFenceGuard(kube(many), {}), (e: Error) => {
    const lines = e.message.split("\n");
    assert.equal(
      lines[0],
      "fence: the cluster has objects that jr2's admission policies refuse now. Each one was made while the policies were absent, and each one can join the VLANs of an Instance (ADR-0084):",
    );
    assert.match(
      lines[1]!,
      /^ {2}- the pod other\/p0 \(Pending\), v1\.multus-cni\.io\/default-network: inst\/jr2-fence-0 — /,
    );
    assert.equal(lines[21], "  - and 2 more");
    assert.match(lines[22]!, /^Delete each one \(`kubectl delete pod -n <namespace> <name>`, /);
    assert.match(lines[22]!, /This converge applied no attachment of the Fence\.$/);
    return true;
  });
  await assert.rejects(
    auditFenceGuard(kube([], "network-attachment-definitions.k8s.cni.cncf.io"), {}),
    /fence: jr2 cannot list the namespaces, the pods and the NetworkAttachmentDefinitions of the cluster \(kubectl get exited \(1\): Error from server \(Forbidden\): cannot list\)/,
  );
});
