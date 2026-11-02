// jr2 requires Landlock on every Sandbox node (ADR-0077). The Repo cache agent is the detector: its
// DaemonSet has one pod on each Sandbox node, by the Sandboxes' own placement (ADR-0052), and on a
// node without Landlock, or with an ABI below 3, the agent exits at start with a termination
// message that names Landlock, the node and the probe's reason, which states the ABI it found
// (`operator/internal/repocache/landlock.go`). jr2's minimum is ABI 3: under ABI 1 no confined
// process can move a file into another folder, and under ABI 2 a confined process can truncate a
// file of jr2's that it may not write. That pod never gets Ready, so the cache agent's
// rollout never completes.
//
// `jr2 up` reads the DaemonSet's pods within the rollout wait it already makes, and refuses to
// converge while any of them reports no Landlock. It names each node, the reason, and the fix: keep
// the node out of the Sandbox nodes with `sandbox.nodeSelector` or a taint, or enable Landlock. There
// is no check pod, no node label and no flag to skip it. A run after the fix converges.

import { setTimeout as sleep } from "node:timers/promises";
import type { KubeAdmin, RolloutTarget } from "./kube.ts";

/** The start of the cache agent's termination message on a node without Landlock — the Go side's
 * `LandlockMessagePrefix`. The two change together. */
export const LANDLOCK_MESSAGE_PREFIX = "no Landlock on node ";

/** How often `awaitCacheAgent` reads the DaemonSet's pods while the rollout wait runs. */
const POLL_MS = 3000;

type Terminated = { message?: string };
type ContainerStatus = {
  state?: { terminated?: Terminated };
  lastState?: { terminated?: Terminated };
};
/** A cache agent pod, read for the node it runs on and its containers' termination messages. */
export type CacheAgentPod = {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: { containerStatuses?: ContainerStatus[] };
};

/** One Sandbox node whose cache agent reports no Landlock, and the probe's reason. */
export type NoLandlock = { node: string; reason: string };

// The node, then the reason up to the sentence the agent ends its message with. Not anchored: with
// `FallbackToLogsOnError` the message can be the agent's log line, which quotes it.
const MESSAGE = /no Landlock on node ([^\s:]+): (.+?) — jr2 needs Landlock/;

/** The Sandbox nodes whose cache agent reports no Landlock, each once, in node order. */
export function nodesWithoutLandlock(pods: readonly CacheAgentPod[]): NoLandlock[] {
  const found = new Map<string, string>();
  for (const pod of pods) {
    if (pod.metadata.deletionTimestamp) continue;
    for (const s of pod.status?.containerStatuses ?? []) {
      const message = s.state?.terminated?.message ?? s.lastState?.terminated?.message ?? "";
      const match = MESSAGE.exec(message);
      if (!match) continue;
      const node = pod.spec?.nodeName ?? match[1]!;
      if (!found.has(node)) found.set(node, match[2]!);
    }
  }
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([node, reason]) => ({ node, reason }));
}

/** The refusal (ADR-0077, ADR-0019): each node, its reason, and the fix. */
export function landlockRefusal(nodes: readonly NoLandlock[]): Error {
  return new Error(
    [
      `repo cache: ${nodes.length === 1 ? "a Sandbox node has" : `${nodes.length} Sandbox nodes have`} no Landlock, ` +
        "and jr2 needs it on every Sandbox node (ADR-0077):",
      ...nodes.map((n) => `  ${n.node}: ${n.reason}`),
      "Keep each such node out of the Sandbox nodes with sandbox.nodeSelector or a taint (ADR-0052), or enable " +
        "Landlock ABI 3 or later in its kernel (Linux 6.2 or later, or a kernel with a backport, with landlock in " +
        "its lsm= list). Then run `jr2 up` again.",
    ].join("\n"),
  );
}

/**
 * Wait for the cache agent's rollout, and refuse as soon as one of its pods reports no Landlock:
 * a pod that exits at start never gets Ready, so the wait alone would only time out. `rollout` is
 * the converge's own rollout wait (with its own diagnosis on failure); while it runs, the
 * DaemonSet's pods are read every few seconds, one list call each. A failed rollout is read once
 * more, so a Landlock refusal wins over the generic diagnosis.
 */
export async function awaitCacheAgent(
  kube: KubeAdmin,
  target: RolloutTarget,
  rollout: () => Promise<void>,
  opts: { pollMs?: number } = {},
): Promise<void> {
  const read = async (): Promise<NoLandlock[]> => {
    try {
      return nodesWithoutLandlock(
        await kube.listJson<CacheAgentPod>({
          kind: "pod",
          selector: target.selector,
          namespace: target.namespace,
          ...(target.context ? { context: target.context } : {}),
        }),
      );
    } catch {
      // A read that fails is no evidence: the rollout wait still decides.
      return [];
    }
  };
  const stop = new AbortController();
  const waited = rollout().then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  const polled = (async (): Promise<NoLandlock[] | undefined> => {
    for (;;) {
      try {
        await sleep(opts.pollMs ?? POLL_MS, undefined, { signal: stop.signal });
      } catch {
        return undefined;
      }
      const nodes = await read();
      if (nodes.length > 0) return nodes;
    }
  })();
  const first = await Promise.race([waited, polled.then((nodes) => ({ nodes }))]);
  stop.abort();
  if ("nodes" in first) {
    if (first.nodes) throw landlockRefusal(first.nodes);
    // The poll stops only when aborted, so the rollout settled first.
  }
  const result = await waited;
  if (result.ok) return;
  const nodes = await read();
  if (nodes.length > 0) throw landlockRefusal(nodes);
  throw result.err;
}
