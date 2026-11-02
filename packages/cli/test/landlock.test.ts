// The Landlock detector's reading half (ADR-0077): `jr2 up` reads the cache agent's pods, finds the
// Sandbox nodes whose agent exited for want of Landlock, and refuses, naming each one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitCacheAgent, nodesWithoutLandlock, type CacheAgentPod } from "../src/landlock.ts";
import type { KubeAdmin, RolloutTarget } from "../src/kube.ts";

const message = (node: string, reason: string) =>
  `no Landlock on node ${node}: ${reason} — jr2 needs Landlock on every Sandbox node (ADR-0077)`;

const crashed = (
  name: string,
  node: string,
  msg: string,
  where: "state" | "lastState" = "lastState",
): CacheAgentPod => ({
  metadata: { name },
  spec: { nodeName: node },
  status: { containerStatuses: [{ [where]: { terminated: { message: msg } } }] },
});

test("the nodes whose cache agent reports no Landlock, each once, with the probe's reason", () => {
  const pods: CacheAgentPod[] = [
    crashed("b", "node-b", message("node-b", "the kernel has no Landlock (ENOSYS)")),
    crashed("a", "node-a", message("node-a", "the kernel has Landlock and it is not enabled (EOPNOTSUPP)"), "state"),
    // Its second pod during a rollout: the node is named once.
    crashed("b2", "node-b", message("node-b", "the kernel has no Landlock (ENOSYS)")),
    { metadata: { name: "ok" }, spec: { nodeName: "node-ok" }, status: { containerStatuses: [{}] } },
    // A pod on the way out is not what refused to come up.
    { ...crashed("gone", "node-z", message("node-z", "x")), metadata: { name: "gone", deletionTimestamp: "now" } },
    // Another exit is not a Landlock refusal.
    crashed("other", "node-c", "panic: something else"),
  ];
  assert.deepEqual(nodesWithoutLandlock(pods), [
    { node: "node-a", reason: "the kernel has Landlock and it is not enabled (EOPNOTSUPP)" },
    { node: "node-b", reason: "the kernel has no Landlock (ENOSYS)" },
  ]);
});

test("FallbackToLogsOnError: the message inside the agent's log line is read too", () => {
  const line = JSON.stringify({ level: "error", msg: "This node cannot run a Sandbox", error: message("n1", "why") });
  assert.deepEqual(nodesWithoutLandlock([crashed("p", "n1", line)]), [{ node: "n1", reason: "why" }]);
});

const target: RolloutTarget = { kind: "daemonset", name: "jr2-repo-cache", namespace: "ns", selector: "app=x" };

function kubeWith(pods: () => CacheAgentPod[]): KubeAdmin & { lists: number } {
  const kube = {
    lists: 0,
    async listJson() {
      kube.lists++;
      return pods();
    },
  };
  return kube as unknown as KubeAdmin & { lists: number };
}

test("a pod that reports no Landlock refuses the converge while the rollout wait still runs", async () => {
  const kube = kubeWith(() => [crashed("p", "bad", message("bad", "the kernel has no Landlock (ENOSYS)"))]);
  const never = () => new Promise<void>(() => {});
  await assert.rejects(
    () => awaitCacheAgent(kube, target, never, { pollMs: 5 }),
    /a Sandbox node has no Landlock[\s\S]*bad: the kernel has no Landlock \(ENOSYS\)[\s\S]*sandbox\.nodeSelector or a taint/,
  );
});

test("a node whose Landlock is below ABI 3 is refused like a node without it, and the fix names ABI 3 (ADR-0077)", async () => {
  // The cache agent's reason for an old kernel, as `operator/internal/repocache/landlock.go` says it.
  const reason = "the kernel offers Landlock ABI 2, and jr2 needs ABI 3 or later (Linux 6.2)";
  const kube = kubeWith(() => [crashed("p", "old", message("old", reason))]);
  const err = await awaitCacheAgent(kube, target, () => new Promise<void>(() => {}), { pollMs: 5 }).then(
    () => assert.fail("an ABI 2 node must refuse the converge"),
    (e: Error) => e,
  );
  assert.match(err.message, /^ {2}old: the kernel offers Landlock ABI 2, and jr2 needs ABI 3 or later/m);
  assert.match(err.message, /enable Landlock ABI 3 or later in its kernel \(Linux 6\.2 or later/);
  assert.doesNotMatch(err.message, /5\.19/, "ABI 2 (Linux 5.19) is not the minimum");
});

test("a rollout that completes converges, and its wait is not held up by the poll", async () => {
  const kube = kubeWith(() => []);
  const started = Date.now();
  await awaitCacheAgent(kube, target, async () => {}, { pollMs: 60_000 });
  assert.ok(Date.now() - started < 1000, "the poll's sleep is cancelled when the rollout settles");
});

test("a failed rollout is read once more: a Landlock refusal wins, else the rollout's own error stands", async () => {
  const bad = kubeWith(() => [crashed("p", "n", message("n", "r"))]);
  await assert.rejects(
    () => awaitCacheAgent(bad, target, async () => Promise.reject(new Error("timed out")), { pollMs: 60_000 }),
    /no Landlock[\s\S]*n: r/,
  );
  const plain = kubeWith(() => []);
  await assert.rejects(
    () => awaitCacheAgent(plain, target, async () => Promise.reject(new Error("timed out")), { pollMs: 60_000 }),
    /^Error: timed out$/,
  );
});

test("the Go agent and this reader agree on the message's start", async () => {
  const { readFile } = await import("node:fs/promises");
  const go = await readFile(new URL("../../../operator/internal/repocache/landlock.go", import.meta.url), "utf8");
  assert.match(go, /const LandlockMessagePrefix = "no Landlock on node "/);
  assert.match(go, /— jr2 needs Landlock on every Sandbox node \(ADR-0077\)/);
});
