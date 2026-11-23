// jr2's admission policies of the Fence (ADR-0084): their objects, the read before the question, the
// apply at each converge, the dry-run check, and the removal. Through a fake API. The CEL itself runs
// against a real API server in the @kind tier (features/kind.feature).

import assert from "node:assert/strict";
import { test } from "node:test";
import { KIT_VERSION } from "../src/deploy.ts";
import {
  applyFenceGuard,
  ATTACHMENT_GUARD,
  checkFenceGuard,
  fenceGuardObjects,
  GUARD_ATTACHMENTS,
  GUARD_PODS,
  planFenceGuard,
  POD_GUARD,
  removeFenceGuard,
} from "../src/fence-guard.ts";

type Obj = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: Record<string, any>;
};

const objects = () => (fenceGuardObjects() as { items: Obj[] }).items;

test("the two policies and their bindings: Fail, Deny, each namespace, and the pods' rule on CREATE and on UPDATE also through pods/status", () => {
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
