import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNodes, excludedBecause, sandboxNodes, tolerates, type NodeObject } from "../src/nodes.ts";

const node = (name: string, over: Partial<NodeObject> = {}): NodeObject => ({
  metadata: { name, ...(over.metadata ?? {}) },
  ...(over.spec ? { spec: over.spec } : {}),
  status: { nodeInfo: { architecture: "arm64" } },
});
const cp = node("cp", { spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] } });
const gpu = node("gpu", {
  metadata: { name: "gpu", labels: { "nvidia.com/gpu.present": "true" } },
  spec: { taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] },
});
const worker = node("worker");
const cordoned = node("old", { spec: { unschedulable: true } });
const soft = node("soft", { spec: { taints: [{ key: "spot", effect: "PreferNoSchedule" }] } });

test("a Sandbox node is where an ordinary pod lands: not cordoned, no untolerated taint — no j2 label (ADR-0052)", () => {
  const { nodes, excluded } = sandboxNodes([cp, gpu, worker, cordoned, soft], undefined);
  assert.deepEqual(
    nodes.map((n) => n.metadata.name),
    ["worker", "soft"],
    "a PreferNoSchedule taint is a preference, not an exclusion",
  );
  assert.deepEqual(excluded, [
    {
      name: "cp",
      reason: "taint node-role.kubernetes.io/control-plane:NoSchedule is not tolerated by sandbox.tolerations",
    },
    { name: "gpu", reason: "taint gpu=true:NoSchedule is not tolerated by sandbox.tolerations" },
    { name: "old", reason: "cordoned (spec.unschedulable)" },
  ]);
});

test("`sandbox.tolerations` admits a tainted node and `sandbox.nodeSelector` narrows to a labeled one", () => {
  const placement = {
    nodeSelector: { "nvidia.com/gpu.present": "true" },
    tolerations: [{ key: "gpu", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const }],
  };
  const { nodes, excluded } = sandboxNodes([cp, gpu, worker], placement);
  assert.deepEqual(
    nodes.map((n) => n.metadata.name),
    ["gpu"],
  );
  assert.deepEqual(excluded, [
    { name: "cp", reason: "lacks the label nvidia.com/gpu.present that sandbox.nodeSelector requires" },
    { name: "worker", reason: "lacks the label nvidia.com/gpu.present that sandbox.nodeSelector requires" },
  ]);
  assert.equal(
    excludedBecause(
      node("wrong", { metadata: { name: "wrong", labels: { "nvidia.com/gpu.present": "false" } } }),
      placement,
    ),
    "label nvidia.com/gpu.present=false is not the nvidia.com/gpu.present=true that sandbox.nodeSelector requires",
  );
});

test("tolerates follows the scheduler's matching rules", () => {
  const taint = { key: "gpu", value: "true", effect: "NoSchedule" };
  assert.ok(tolerates({ operator: "Exists" }, taint), "empty key + Exists matches everything");
  assert.ok(tolerates({ key: "gpu", operator: "Exists" }, taint), "Exists ignores the value");
  assert.ok(tolerates({ key: "gpu", value: "true" }, taint), "Equal is the default operator");
  assert.ok(tolerates({ key: "gpu", value: "true", effect: "NoSchedule" }, taint));
  assert.ok(!tolerates({ key: "gpu", value: "false" }, taint));
  assert.ok(!tolerates({ key: "gpu", value: "true", effect: "NoExecute" }, taint), "an effect named must match");
  assert.ok(!tolerates({ key: "other", operator: "Exists" }, taint));
  assert.ok(!tolerates({}, taint), "an empty toleration with the default Equal matches nothing");
});

test("the build set is the union of ordinary-pod nodes and Sandbox nodes (ADR-0045 as rewritten)", () => {
  const tolerateGpu = { tolerations: [{ key: "gpu", operator: "Exists" as const }] };
  assert.deepEqual(
    buildNodes([cp, gpu, worker, cordoned], undefined).map((n) => n.metadata.name),
    ["worker"],
    "a tainted pool no Sandbox reaches is not built for",
  );
  assert.deepEqual(
    buildNodes([cp, gpu, worker, cordoned], tolerateGpu).map((n) => n.metadata.name),
    ["gpu", "worker"],
    "admitting the pool for Sandboxes adds it to the build set",
  );
  assert.deepEqual(
    buildNodes([cp, gpu, worker], { nodeSelector: { "nvidia.com/gpu.present": "true" }, ...tolerateGpu }).map(
      (n) => n.metadata.name,
    ),
    ["gpu", "worker"],
    "a selector narrows the Sandbox nodes, never the Orchestrator's own",
  );
});
