// Which nodes are an Instance's Sandbox nodes (ADR-0052), read off the cluster's nodes with the
// scheduler's own rules: not cordoned, every label of `sandbox.nodeSelector` present, and every
// NoSchedule/NoExecute taint tolerated by `sandbox.tolerations`. No jr2 label exists — taints and
// cordons already say "not for ordinary work" for every workload, and jr2 reads them instead of
// asking for a second, jr2-only opt-in. The predicate is pure and mirrors what the Sandbox pod and
// the cache agent's DaemonSet carry, so the set `jr2 up` reports is the set the scheduler will use —
// at the moment of the read. The set moves (a pool autoscales, a node is cordoned), which is why an
// empty set is reported and never refused.

import type { SandboxPlacement, Toleration } from "@jr2/orchestrator";

/** A cluster node, read for the facts that decide placement and platform (ADR-0045/0052). */
export type NodeObject = {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean; taints?: readonly Taint[] };
  status?: { nodeInfo?: { architecture?: string } };
};

export type Taint = { key: string; value?: string; effect: string };

/** One node's exclusion, in the words a human acts on: the taint or label that kept it out. */
export type Excluded = { name: string; reason: string };

export type SandboxNodes = { nodes: NodeObject[]; excluded: Excluded[] };

/** The Sandbox nodes among `nodes`, and why each other one is not. */
export function sandboxNodes(nodes: readonly NodeObject[], placement: SandboxPlacement | undefined): SandboxNodes {
  const out: SandboxNodes = { nodes: [], excluded: [] };
  for (const node of nodes) {
    const reason = excludedBecause(node, placement);
    if (reason === undefined) out.nodes.push(node);
    else out.excluded.push({ name: node.metadata.name, reason });
  }
  return out;
}

/**
 * The nodes the build set is derived from (ADR-0045 as rewritten by ADR-0052): the union of the
 * nodes an ordinary pod lands on — the Orchestrator Deployment's own placement, no selector, no
 * tolerations — and the Sandbox nodes. A tainted pool no Sandbox reaches is never built for.
 */
export function buildNodes(nodes: readonly NodeObject[], placement: SandboxPlacement | undefined): NodeObject[] {
  return nodes.filter(
    (n) => excludedBecause(n, undefined) === undefined || excludedBecause(n, placement) === undefined,
  );
}

/** Why `node` is not a Sandbox node under `placement`, or undefined when it is. */
export function excludedBecause(node: NodeObject, placement: SandboxPlacement | undefined): string | undefined {
  if (node.spec?.unschedulable === true) return "cordoned (spec.unschedulable)";
  for (const [key, value] of Object.entries(placement?.nodeSelector ?? {})) {
    const has = node.metadata.labels?.[key];
    if (has !== value)
      return has === undefined
        ? `lacks the label ${key} that sandbox.nodeSelector requires`
        : `label ${key}=${has} is not the ${key}=${value} that sandbox.nodeSelector requires`;
  }
  for (const taint of node.spec?.taints ?? []) {
    if (taint.effect === "PreferNoSchedule") continue;
    if (!(placement?.tolerations ?? []).some((t) => tolerates(t, taint)))
      return `taint ${taint.key}${taint.value !== undefined && taint.value !== "" ? `=${taint.value}` : ""}:${taint.effect} is not tolerated by sandbox.tolerations`;
  }
  return undefined;
}

/** Kubernetes' own rule: an empty key with `Exists` matches every taint; an absent effect matches
 * every effect; `Equal` (the default) also compares the value. */
export function tolerates(t: Toleration, taint: Taint): boolean {
  if (t.effect !== undefined && t.effect !== taint.effect) return false;
  if (t.key === undefined || t.key === "") return t.operator === "Exists";
  if (t.key !== taint.key) return false;
  if (t.operator === "Exists") return true;
  return (t.value ?? "") === (taint.value ?? "");
}
