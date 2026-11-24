// jr2's admission policies of the Fence (ADR-0084, ADR-0019). Multus gives a pod each attachment
// that the pod's annotations name, of any namespace: `v1.multus-cni.io/default-network` and
// `k8s.v1.cni.cncf.io/networks`. So, without a guard, a pod of another namespace can name an
// attachment of an Instance and join the VLANs of its Sandboxes. jr2 does not depend on how a
// Multus is configured for this: `jr2 up` applies two ValidatingAdmissionPolicies, each with its
// binding, before any attachment of the Fence exists, and checks them with server-side dry runs.
//
//   jr2-fence-guard-pods         a pod (CREATE, and an UPDATE that changes one of the two
//                                annotations, also through pods/status), or a Binding (CREATE, of
//                                pods/binding or bindings: its annotations are merged into its
//                                pod), whose annotation holds the reserved prefix `jr2-fence-`, or
//                                a JSON escape `\u`, must be in an Instance's namespace (the label
//                                `jr2.dev/instance`, which `jr2 up` sets), and each network of that
//                                annotation must be
//                                `<its own namespace>/<name>[@<interface>]`, in a comma list: no
//                                JSON, no bare name, no space. So it cannot name another namespace.
//   jr2-fence-guard-attachments  a NetworkAttachmentDefinition (CREATE, UPDATE) whose config holds
//                                the bridge's name `jr2fence0`, or a JSON escape `\u`, must be in an
//                                Instance's namespace and have a name with the reserved prefix. So
//                                each attachment on the bridge falls under the first policy.
//
// A blunt rule, not a parse: an annotation or a config that can reach the Fence is one that names
// it in plain text, because the names are lowercase letters, digits and `-`, and only a JSON escape
// `\u` can spell those in another way. The policies judge a request only, so `jr2 up` also audits
// the pods and the attachments that are there (`auditFenceGuard`), with the same rules in
// TypeScript. Whom the guard holds against, and whom jr2 trusts, is ADR-0084's statement.

import {
  FENCE_ATTACHMENT_PREFIX,
  FENCE_DEFAULT_NETWORK_ANNOTATION,
  fenceSlotAttachment,
} from "@jr2/orchestrator/internal";
import { compareVersions, KIT_VERSION, LABEL_INSTANCE, LABEL_VERSION, OPERATOR_NAMESPACE } from "./deploy.ts";
import { FENCE_BRIDGE } from "./fence.ts";
import type { KubeAdmin } from "./kube.ts";

/** Multus's annotation of a pod's added networks. */
export const MULTUS_NETWORKS_ANNOTATION = "k8s.v1.cni.cncf.io/networks";
/** The policy (and its binding) of the pods. */
export const GUARD_PODS = "jr2-fence-guard-pods";
/** The policy (and its binding) of the NetworkAttachmentDefinitions. */
export const GUARD_ATTACHMENTS = "jr2-fence-guard-attachments";
export const GUARD_NAMES = [GUARD_PODS, GUARD_ATTACHMENTS] as const;
/** How long a new policy may take to be in force: the API server reads it from a watch. */
const GUARD_SETTLE_MS = 30_000;
const POLL_MS = 1_000;

type Json = Record<string, unknown>;

/** A DNS label, as an attachment's name and a namespace's name are. */
const LABEL = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";

/** The CEL of the pods' policy (ADR-0084). Each line is one clause; `fenceGuardObjects` names them. */
export const POD_GUARD = {
  annotations: "object.metadata.?annotations.orValue({})",
  before: "oldObject == null ? {} : oldObject.metadata.?annotations.orValue({})",
  // The Multus annotations that this request sets or changes, and that can name an attachment of the
  // Fence: they hold the reserved prefix, or a JSON escape, which can spell it.
  fence:
    `['${FENCE_DEFAULT_NETWORK_ANNOTATION}', '${MULTUS_NETWORKS_ANNOTATION}'].filter(k, ` +
    "k in variables.annotations && " +
    "!(k in variables.before && variables.before[k] == variables.annotations[k]) && " +
    `(variables.annotations[k].contains('${FENCE_ATTACHMENT_PREFIX}') || variables.annotations[k].contains(r'\\u')))`,
  instance: `'${LABEL_INSTANCE}' in namespaceObject.metadata.?labels.orValue({})`,
  // A comma list of `<this namespace>/<name>[@<interface>]`, and nothing else.
  own:
    `'^' + namespaceObject.metadata.name + '/${LABEL}(@[a-z0-9]+)?(,' + ` +
    `namespaceObject.metadata.name + '/${LABEL}(@[a-z0-9]+)?)*$'`,
} as const;

/** The CEL of the attachments' policy (ADR-0084). */
export const ATTACHMENT_GUARD = {
  config: "object.?spec.?config.orValue('')",
  bridge: `variables.config.contains('${FENCE_BRIDGE}') || variables.config.contains(r'\\u')`,
  instance: POD_GUARD.instance,
} as const;

// ---- the same rules in TypeScript, for the audit of what the cluster has ---------------------------
// Each function below is the CEL above, clause by clause, as the API server applies it to a CREATE
// (no `oldObject`). Change the two together: the unit tests judge both with one table of cases, and
// the @kind scenario judges each row of its matrix with the API server and with these functions.

/** A namespace as the policies read it: its name and its labels. */
export type GuardNamespace = { name: string; labels?: Record<string, string> };

const ESCAPE = "\\u";
const instanceOf = (ns: GuardNamespace): boolean => LABEL_INSTANCE in (ns.labels ?? {});
const ownOf = (ns: GuardNamespace): RegExp =>
  new RegExp(`^${ns.name}/${LABEL}(@[a-z0-9]+)?(,${ns.name}/${LABEL}(@[a-z0-9]+)?)*$`);

/**
 * Why `jr2-fence-guard-pods` refuses a CREATE of an object with these annotations (a pod, or a
 * Binding) in `namespace`, or `undefined` when it admits it. The reason names the annotation.
 */
export function podGuardRefusal(
  annotations: Record<string, string> | undefined,
  namespace: GuardNamespace,
): { annotation: string; why: string } | undefined {
  const values = annotations ?? {};
  // fence
  const fence = [FENCE_DEFAULT_NETWORK_ANNOTATION, MULTUS_NETWORKS_ANNOTATION].filter(
    (k) => k in values && (values[k]!.includes(FENCE_ATTACHMENT_PREFIX) || values[k]!.includes(ESCAPE)),
  );
  if (fence.length === 0) return undefined;
  // the first validation: `variables.fence.size() == 0 || variables.instance`
  if (!instanceOf(namespace)) {
    return {
      annotation: fence[0]!,
      why: `the namespace ${namespace.name} is not the namespace of a jr2 Instance (it has no label ${LABEL_INSTANCE})`,
    };
  }
  // the second: `variables.fence.all(k, variables.annotations[k].matches(variables.own))`
  const own = ownOf(namespace);
  const wrong = fence.find((k) => !own.test(values[k]!));
  if (wrong === undefined) return undefined;
  return {
    annotation: wrong,
    why:
      `a network in it is not <namespace>/<name> or <namespace>/<name>@<interface> with the namespace of the ` +
      `pod, ${namespace.name}, in a comma list with no JSON and no space`,
  };
}

/**
 * Why `jr2-fence-guard-attachments` refuses a CREATE of a NetworkAttachmentDefinition with this
 * name and config in `namespace`, or `undefined` when it admits it.
 */
export function attachmentGuardRefusal(
  name: string,
  config: string | undefined,
  namespace: GuardNamespace,
): string | undefined {
  const text = config ?? "";
  // bridge
  if (!(text.includes(FENCE_BRIDGE) || text.includes(ESCAPE))) return undefined;
  // `!variables.bridge || (variables.instance && object.metadata.name.startsWith(prefix))`
  if (instanceOf(namespace) && name.startsWith(FENCE_ATTACHMENT_PREFIX)) return undefined;
  return (
    `its config holds ${FENCE_BRIDGE} or a JSON escape ${ESCAPE}, and it is not in the namespace of a jr2 ` +
    `Instance (the label ${LABEL_INSTANCE}) with a name that starts with ${FENCE_ATTACHMENT_PREFIX}`
  );
}

const labels = (): Record<string, string> => ({
  "app.kubernetes.io/managed-by": "jr2",
  [LABEL_VERSION]: KIT_VERSION,
});

const binding = (name: string): Json => ({
  apiVersion: "admissionregistration.k8s.io/v1",
  kind: "ValidatingAdmissionPolicyBinding",
  metadata: { name, labels: labels() },
  // No matchResources: each namespace.
  spec: { policyName: name, validationActions: ["Deny"] },
});

const variables = (vars: Record<string, string>): Json[] =>
  Object.entries(vars).map(([name, expression]) => ({ name, expression }));

/** The two policies and their bindings, as one List. */
export function fenceGuardObjects(): Json {
  const pods = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicy",
    metadata: { name: GUARD_PODS, labels: labels() },
    spec: {
      failurePolicy: "Fail",
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: [""],
            apiVersions: ["v1"],
            operations: ["CREATE", "UPDATE"],
            // pods/status can change a pod's annotations too, and Multus reads them again when the
            // pod's network is made again.
            resources: ["pods", "pods/status"],
          },
          {
            // A Binding's annotations are merged into the pod that it binds, so a Binding can set an
            // annotation on a pod that was admitted with none. Here `object` is the Binding, and
            // `oldObject` is null, so each Multus annotation of the Binding is judged.
            apiGroups: [""],
            apiVersions: ["v1"],
            operations: ["CREATE"],
            resources: ["pods/binding", "bindings"],
          },
        ],
      },
      variables: variables(POD_GUARD),
      validations: [
        {
          expression: "variables.fence.size() == 0 || variables.instance",
          reason: "Forbidden",
          messageExpression:
            "'the annotation ' + variables.fence[0] + ' can name an attachment of the Fence (it holds " +
            `${FENCE_ATTACHMENT_PREFIX} or a JSON escape \\\\u), and the namespace ' + namespaceObject.metadata.name + ` +
            `' is not the namespace of a jr2 Instance (it has no label ${LABEL_INSTANCE}) (ADR-0084)'`,
        },
        {
          expression: "variables.fence.all(k, variables.annotations[k].matches(variables.own))",
          reason: "Forbidden",
          messageExpression:
            "'the annotation ' + variables.fence.filter(k, !variables.annotations[k].matches(variables.own))[0] + " +
            "' can name an attachment of the Fence, so each network in it must be <namespace>/<name> or " +
            "<namespace>/<name>@<interface> with the namespace of the pod, ' + namespaceObject.metadata.name + " +
            "', in a comma list with no JSON and no space (ADR-0084)'",
        },
      ],
    },
  };
  const attachments = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicy",
    metadata: { name: GUARD_ATTACHMENTS, labels: labels() },
    spec: {
      failurePolicy: "Fail",
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: ["k8s.cni.cncf.io"],
            apiVersions: ["*"],
            operations: ["CREATE", "UPDATE"],
            resources: ["network-attachment-definitions"],
          },
        ],
      },
      variables: variables(ATTACHMENT_GUARD),
      validations: [
        {
          expression: `!variables.bridge || (variables.instance && object.metadata.name.startsWith('${FENCE_ATTACHMENT_PREFIX}'))`,
          reason: "Forbidden",
          messageExpression:
            "'the NetworkAttachmentDefinition ' + object.metadata.name + ' can name the bridge " +
            `${FENCE_BRIDGE} of the Fence (its config holds that name or a JSON escape \\\\u), so it must be in the ` +
            `namespace of a jr2 Instance (the label ${LABEL_INSTANCE}) and its name must start with ` +
            `${FENCE_ATTACHMENT_PREFIX} (ADR-0084)'`,
        },
      ],
    },
  };
  return {
    apiVersion: "v1",
    kind: "List",
    items: [pods, binding(GUARD_PODS), attachments, binding(GUARD_ATTACHMENTS)],
  };
}

type Labeled = { metadata: { name: string; labels?: Record<string, string> } };
type Ctx = { context?: string };

/** The policies and the bindings of the guard that the cluster has, by kind. A read that fails throws. */
async function readGuard(
  kube: Pick<KubeAdmin, "listJson">,
  ctx: Ctx,
): Promise<{ policies: Labeled[]; bindings: Labeled[] }> {
  const ours = (items: Labeled[]) => items.filter((o) => (GUARD_NAMES as readonly string[]).includes(o.metadata.name));
  return {
    policies: ours(await kube.listJson<Labeled>({ kind: "validatingadmissionpolicy", ...ctx })),
    bindings: ours(await kube.listJson<Labeled>({ kind: "validatingadmissionpolicybinding", ...ctx })),
  };
}

/** `present` when the cluster has both policies and both bindings (of any Kit), `install` when not. */
export async function planFenceGuard(kube: Pick<KubeAdmin, "listJson">, ctx: Ctx = {}): Promise<"install" | "present"> {
  const { policies, bindings } = await readGuard(kube, ctx);
  return policies.length === GUARD_NAMES.length && bindings.length === GUARD_NAMES.length ? "present" : "install";
}

/**
 * Apply the policies and their bindings, at each converge of an Instance on the Fence whose Kit is
 * not older than theirs: an apply that changes nothing changes nothing, and a newer Kit changes them
 * with no question, as it changes the DaemonSet jr2-fence-node. A policy that the cluster refuses
 * stops the converge: no attachment of the Fence may exist without them.
 */
export async function applyFenceGuard(
  kube: Pick<KubeAdmin, "listJson" | "apply">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const { policies, bindings } = await readGuard(kube, ctx);
  const newer = [...policies, ...bindings].some((o) => {
    const v = o.metadata.labels?.[LABEL_VERSION];
    return v !== undefined && compareVersions(v, KIT_VERSION) > 0;
  });
  if (newer) return;
  if (policies.length < GUARD_NAMES.length || bindings.length < GUARD_NAMES.length) {
    opts.log(`fence: applying the admission policies ${GUARD_NAMES.join(" and ")}, each with its binding`);
  }
  try {
    await kube.apply({ manifest: JSON.stringify(fenceGuardObjects()), ...ctx });
  } catch (err) {
    throw new Error(
      `fence: jr2 cannot apply its admission policies ${GUARD_NAMES.join(" and ")} with their bindings ` +
        `(${firstLine(err)}). They keep a pod of another namespace from naming an attachment of the Instance, ` +
        "and no attachment of the Fence may exist without them (ADR-0084). Give the user of this context the " +
        "right to create and update ValidatingAdmissionPolicies and ValidatingAdmissionPolicyBindings " +
        "(cluster-wide), or ask the owner of the cluster to run `jr2 up` once; then run `jr2 up` again. No " +
        "attachment of the Fence was applied.",
    );
  }
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();

/** The pod of a dry run: one that each Pod Security level admits, in `namespace`, with `annotation`. */
export function guardProbePod(namespace: string, annotation: string, value: string): Json {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "jr2-fence-guard-check", namespace, annotations: { [annotation]: value } },
    spec: {
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "check",
          image: "registry.k8s.io/pause:3.10",
          resources: { requests: { cpu: "1m", memory: "1Mi" }, limits: { cpu: "1m", memory: "1Mi" } },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        },
      ],
    },
  };
}

/** The attachment of a dry run: on the bridge of the Fence, outside an Instance's namespace. */
export function guardProbeAttachment(namespace: string): Json {
  return {
    apiVersion: "k8s.cni.cncf.io/v1",
    kind: "NetworkAttachmentDefinition",
    metadata: { name: fenceSlotAttachment(0), namespace },
    spec: { config: JSON.stringify({ cniVersion: "1.0.0", name: "check", type: "bridge", bridge: FENCE_BRIDGE }) },
  };
}

/** The namespace of the dry runs: one that is not an Instance's. */
const probeNamespace = (instance: string): string => (instance === OPERATOR_NAMESPACE ? "default" : OPERATOR_NAMESPACE);

/**
 * Check the guard with server-side dry runs, which make nothing (ADR-0084): from a namespace that is
 * not an Instance's, a pod that names the Instance's slot attachment through each of the two
 * annotations, and a NetworkAttachmentDefinition on the bridge, must each be denied by jr2's
 * policy, and the denial must name it. A new policy can take a moment to be in force, so a dry run
 * that is admitted is tried again for up to `settleMs`. Then an admitted dry run, or a denial by
 * something else, refuses the converge.
 */
export async function checkFenceGuard(
  kube: Pick<KubeAdmin, "dryRunCreate">,
  opts: { namespace: string; context?: string; settleMs?: number; pollMs?: number; now?: () => number },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  const now = opts.now ?? Date.now;
  const other = probeNamespace(opts.namespace);
  const target = `${opts.namespace}/${fenceSlotAttachment(0)}`;
  const checks = [
    {
      what: `a pod in the namespace ${other} with ${FENCE_DEFAULT_NETWORK_ANNOTATION}: ${target}`,
      policy: GUARD_PODS,
      object: guardProbePod(other, FENCE_DEFAULT_NETWORK_ANNOTATION, target),
    },
    {
      what: `a pod in the namespace ${other} with ${MULTUS_NETWORKS_ANNOTATION}: ${target}`,
      policy: GUARD_PODS,
      object: guardProbePod(other, MULTUS_NETWORKS_ANNOTATION, target),
    },
    {
      what: `a NetworkAttachmentDefinition in the namespace ${other} on the bridge ${FENCE_BRIDGE}`,
      policy: GUARD_ATTACHMENTS,
      object: guardProbeAttachment(other),
    },
  ];
  const started = now();
  for (const check of checks) {
    for (;;) {
      let said: string;
      try {
        await kube.dryRunCreate({ manifest: JSON.stringify(check.object), ...ctx });
        said = "admitted";
      } catch (err) {
        said = err instanceof Error ? err.message : String(err);
      }
      if (said.includes(`ValidatingAdmissionPolicy '${check.policy}'`) && said.includes("denied request")) break;
      if (said === "admitted" && now() - started < (opts.settleMs ?? GUARD_SETTLE_MS)) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? POLL_MS));
        continue;
      }
      throw new Error(
        said === "admitted"
          ? `fence: the cluster admits ${check.what} (a server-side dry run, which makes nothing), so jr2's ` +
              `admission policy ${check.policy} is not in force, and a pod of another namespace can join the ` +
              "VLANs of the Instance (ADR-0084). Look at `kubectl get validatingadmissionpolicy,validatingadmissionpolicybinding " +
              `${check.policy}\`: the converge applied both. Then run \`jr2 up\` again. No attachment of the Fence was applied.`
          : `fence: jr2 cannot see its admission policy ${check.policy} in force: the server-side dry run of ` +
              `${check.what} was refused, but not by that policy (${firstLine(said).slice(0, 400)}) (ADR-0084). ` +
              "Fix what the message names, then run `jr2 up` again. No attachment of the Fence was applied.",
      );
    }
  }
}

/** The attachments' resource, as kubectl names it. */
const ATTACHMENTS_RESOURCE = "network-attachment-definitions.k8s.cni.cncf.io";
/** The audit names at most this many objects, and then a count of the others. */
const AUDIT_NAMED = 20;

type AuditPod = {
  metadata: { name: string; namespace: string; annotations?: Record<string, string> };
  status?: { phase?: string };
};
type AuditAttachment = { metadata: { name: string; namespace: string }; spec?: { config?: string } };

/**
 * Each pod and each NetworkAttachmentDefinition of the cluster that the policies would refuse now,
 * as one line each (ADR-0084). The policies judge a request, not an object that is there: a pod or
 * an attachment that was made while they were absent (before the first `jr2 up` with a Fence, or
 * after `jr2 down --all`) is not judged. And a pod that waits for its network gets it when the
 * attachment that it names is made: Multus reads the attachment at each CNI ADD. A pod that has
 * ended is named too: its annotation is the evidence of an attempt.
 */
export function auditFenceGuardObjects(
  namespaces: readonly GuardNamespace[],
  pods: readonly AuditPod[],
  attachments: readonly AuditAttachment[],
): string[] {
  const byName = new Map(namespaces.map((ns) => [ns.name, ns]));
  // A namespace that the list did not have (made after it) is judged with no label.
  const nsOf = (name: string): GuardNamespace => byName.get(name) ?? { name };
  const lines: string[] = [];
  for (const pod of pods) {
    const { name, namespace, annotations } = pod.metadata;
    const refused = podGuardRefusal(annotations, nsOf(namespace));
    if (refused === undefined) continue;
    const phase = pod.status?.phase !== undefined ? ` (${pod.status.phase})` : "";
    lines.push(
      `the pod ${namespace}/${name}${phase}, ${refused.annotation}: ${annotations![refused.annotation]} — ${refused.why}`,
    );
  }
  for (const nad of attachments) {
    const { name, namespace } = nad.metadata;
    const why = attachmentGuardRefusal(name, nad.spec?.config, nsOf(namespace));
    if (why !== undefined) lines.push(`the NetworkAttachmentDefinition ${namespace}/${name} — ${why}`);
  }
  return lines;
}

/**
 * Refuse the converge while the cluster has a pod or a NetworkAttachmentDefinition that jr2's
 * policies would refuse now (`auditFenceGuardObjects`). It runs after the dry runs of the guard
 * passed, so the policies judge each object that is made after the lists, and before the first
 * attachment of the Fence of this converge. A list that fails refuses the converge.
 */
export async function auditFenceGuard(kube: Pick<KubeAdmin, "listJson">, opts: { context?: string }): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  let lines: string[];
  try {
    const namespaces = await kube.listJson<{ metadata: { name: string; labels?: Record<string, string> } }>({
      kind: "namespace",
      ...ctx,
    });
    const pods = await kube.listJson<AuditPod>({ kind: "pod", allNamespaces: true, ...ctx });
    const attachments = await kube.listJson<AuditAttachment>({
      kind: ATTACHMENTS_RESOURCE,
      allNamespaces: true,
      ...ctx,
    });
    lines = auditFenceGuardObjects(
      namespaces.map((ns) => ({
        name: ns.metadata.name,
        ...(ns.metadata.labels !== undefined ? { labels: ns.metadata.labels } : {}),
      })),
      pods,
      attachments,
    );
  } catch (err) {
    throw new Error(
      `fence: jr2 cannot list the namespaces, the pods and the NetworkAttachmentDefinitions of the cluster ` +
        `(${firstLine(err)}), so it cannot see whether one was made while its admission policies were absent ` +
        "(ADR-0084). Give the user of this context the right to list them in each namespace, then run `jr2 up` " +
        "again. This converge applied no attachment of the Fence.",
    );
  }
  if (lines.length === 0) return;
  const named = lines.slice(0, AUDIT_NAMED).map((l) => `  - ${l}`);
  if (lines.length > AUDIT_NAMED) named.push(`  - and ${lines.length - AUDIT_NAMED} more`);
  throw new Error(
    "fence: the cluster has objects that jr2's admission policies refuse now. Each one was made while the " +
      "policies were absent, and each one can join the VLANs of an Instance (ADR-0084):\n" +
      `${named.join("\n")}\n` +
      "Delete each one (`kubectl delete pod -n <namespace> <name>`, " +
      "`kubectl delete network-attachment-definitions.k8s.cni.cncf.io -n <namespace> <name>`), then run " +
      "`jr2 up` again. A pod that has ended is named too: its annotation shows an attempt to join. This " +
      "converge applied no attachment of the Fence.",
  );
}

/** Delete the bindings and the policies (`jr2 down --all`). A delete that fails warns. */
export async function removeFenceGuard(
  kube: Pick<KubeAdmin, "deleteObject">,
  opts: { context?: string; log: (line: string) => void },
): Promise<void> {
  const ctx = opts.context !== undefined ? { context: opts.context } : {};
  opts.log(`uninstalling the admission policies ${GUARD_NAMES.join(" and ")} and their bindings`);
  for (const kind of ["validatingadmissionpolicybinding", "validatingadmissionpolicy"]) {
    for (const name of GUARD_NAMES) {
      try {
        await kube.deleteObject({ kind, name, ...ctx });
      } catch (err) {
        opts.log(`warning: jr2 could not delete the ${kind} ${name} (${firstLine(err)}); delete it with kubectl`);
      }
    }
  }
}
