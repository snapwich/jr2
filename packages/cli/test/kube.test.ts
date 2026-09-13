// The one-shot probe's failure message (ADR-0019). `kubectl run --attach` puts the POD's output on
// kubectl's stdout and kubectl's own verdict on stderr, and execFile's rejection carries only the
// latter — so a preflight that failed inside the pod reported nothing about why. These cases pin
// the pod's words into the message the converge throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { oneShotFailure, rolloutFailure, rolloutStatusArgs, type KubeAdmin } from "../src/kube.ts";

/** What `promisify(execFile)` rejects with: a message built from stderr, plus both streams. */
function execFileRejection(stdout: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: kubectl run …\n${stderr}`), { stdout, stderr });
}

test("the pod's own output leads, and kubectl's verdict follows", () => {
  const err = oneShotFailure(
    execFileRejection(
      "[TypeError: fetch failed] { cause: ENOTFOUND vllm.example }\n",
      "pod ns/j2-provider-preflight-1 terminated (Error)\n",
    ),
  );
  const lines = err.message.split("\n");
  assert.equal(lines[0], "[TypeError: fetch failed] { cause: ENOTFOUND vllm.example }");
  assert.match(err.message, /terminated \(Error\)/);
});

test("a failure that attached nothing is passed through unchanged", () => {
  const original = execFileRejection("", "error: timed out waiting for the condition\n");
  assert.equal(oneShotFailure(original), original);
});

test("whitespace-only attached output does not add an empty line", () => {
  const err = oneShotFailure(execFileRejection("\n  \n", "pod ns/probe terminated (Error)\n"));
  assert.doesNotMatch(err.message, /^\s*\n/);
});

test("a non-Error rejection still yields an Error", () => {
  const err = oneShotFailure("kubectl is not installed");
  assert.ok(err instanceof Error);
  assert.equal(err.message, "kubectl is not installed");
});

// --- the rollout wait's diagnosis (ADR-0046) ---------------------------------------------------
// Same philosophy one layer up: `kubectl rollout status` says "timed out waiting for the condition"
// and drops every fact, so `rolloutFailure` goes and reads the pods. These cases drive it through
// faked reads — the four named diagnoses, and the case no name matches, which must still carry the
// raw evidence. The rule under test throughout: a named diagnosis may only interpret text the
// message also prints raw.

type FakePod = {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { nodeName?: string; containers?: Array<{ name?: string; image?: string }> };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      image?: string;
      ready?: boolean;
      restartCount?: number;
      state?: {
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; exitCode?: number; message?: string };
      };
      lastState?: { terminated?: { reason?: string; exitCode?: number; message?: string } };
    }>;
  };
};

type FakeEvent = {
  metadata: { name: string };
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string;
  involvedObject?: { name?: string };
};

/** A cluster that answers only what a diagnosis asks it: pods by selector, the namespace's events,
 * one node's architecture, and a container's log tail. Everything else fails loudly — the scope
 * guard is part of the design (ADR-0046: the rollout wait only). */
function mkKube(opts: {
  pods?: FakePod[];
  events?: FakeEvent[];
  /** node name → architecture, as `.status.nodeInfo.architecture` reports it. */
  arch?: Record<string, string>;
  /** `"<pod>"` for the current container instance, `"<pod>:previous"` for the one before it. */
  logs?: Record<string, string>;
  /** `true` → the pod listing throws, as an unreachable API or a forbidden verb does. */
  podsFail?: boolean;
}): KubeAdmin & { logCalls: string[] } {
  const kube = {
    logCalls: [] as string[],
    context: async () => "kind-test",
    apply: async () => assert.fail("a diagnosis changes nothing"),
    label: async () => assert.fail("a diagnosis changes nothing"),
    deleteObject: async () => assert.fail("a diagnosis changes nothing"),
    deleteManifest: async () => assert.fail("a diagnosis changes nothing"),
    waitRollout: async () => assert.fail("the wait already failed"),
    runOneShot: async () => assert.fail("a diagnosis runs no pods") as never,
    getJson: async <T>(o: { kind: string; name: string }): Promise<T | undefined> => {
      assert.equal(o.kind, "node");
      const architecture = opts.arch?.[o.name];
      return architecture ? ({ status: { nodeInfo: { architecture } } } as T) : undefined;
    },
    listJson: async <T>(o: { kind: string }): Promise<T[]> => {
      if (o.kind === "pod") {
        if (opts.podsFail) throw new Error("Unable to connect to the server");
        return (opts.pods ?? []) as T[];
      }
      if (o.kind === "event") return (opts.events ?? []) as T[];
      return assert.fail(`unexpected read of ${o.kind}`);
    },
    logs: async (o: { pod: string; container?: string; previous?: boolean }): Promise<string> => {
      kube.logCalls.push(`${o.pod}/${o.container}${o.previous ? " --previous" : ""}`);
      return opts.logs?.[o.previous ? `${o.pod}:previous` : o.pod] ?? "";
    },
  };
  return kube;
}

const target = { name: "j2-orchestrator", namespace: "demo", selector: "app=j2-orchestrator" };
const timedOut = new Error("error: timed out waiting for the condition");

/** One crashing container, with whatever the kubelet said about it. */
function crashPod(over: {
  reason: string;
  message?: string;
  image?: string;
  node?: string;
  last?: { reason?: string; exitCode?: number; message?: string };
}): FakePod {
  return {
    metadata: { name: "j2-orchestrator-77d-abc" },
    spec: { nodeName: over.node ?? "kind-worker", containers: [{ name: "orchestrator", image: over.image }] },
    status: {
      phase: "Pending",
      containerStatuses: [
        {
          name: "orchestrator",
          ready: false,
          restartCount: 4,
          state: { waiting: { reason: over.reason, ...(over.message ? { message: over.message } : {}) } },
          ...(over.last ? { lastState: { terminated: over.last } } : {}),
        },
      ],
    },
  };
}

test("an exec format error names both platforms, and the way back", async () => {
  const kube = mkKube({
    pods: [
      crashPod({
        reason: "CrashLoopBackOff",
        message: "back-off 40s restarting failed container",
        image: "j2-instance-demo:4a77b1-amd64",
        last: { reason: "StartError", exitCode: 128, message: "failed to create task: exec format error" },
      }),
    ],
    arch: { "kind-worker": "arm64" },
  });
  const err = await rolloutFailure(kube, timedOut, target);

  // The evidence is printed raw — the diagnosis below only interprets what is already there.
  assert.match(err.message, /exec format error/);
  assert.match(err.message, /image j2-instance-demo:4a77b1-amd64/);
  assert.match(err.message, /diagnosis: .* built for another platform/);
  assert.match(err.message, /its tag names amd64/);
  assert.match(err.message, /kind-worker runs arm64/);
  assert.match(err.message, /--force/);
  assert.match(err.message, /`platforms`/);
  // One crash gets ONE name: the crash-loop entry yields to the cause that explains it.
  assert.doesNotMatch(err.message, /starts and exits/);
  // kubectl's verdict is kept, and kept last.
  assert.match(err.message, /timed out waiting for the condition$/);
});

test("a pre-ADR-0045 tag says it names no platform rather than guessing one", async () => {
  const kube = mkKube({
    pods: [
      crashPod({
        reason: "CrashLoopBackOff",
        image: "registry.example.com/some/tool:v3",
        last: { message: "standard_init_linux.go: exec format error" },
      }),
    ],
    arch: { "kind-worker": "arm64" },
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /its tag names no platform/);
});

test("a pull failure names the ref and the registry it resolves to", async () => {
  const kube = mkKube({
    pods: [crashPod({ reason: "ImagePullBackOff", image: "j2-instance-demo:4a77b1-amd64" })],
    events: [
      {
        metadata: { name: "e1" },
        type: "Warning",
        reason: "Failed",
        message: 'Failed to pull image "j2-instance-demo:4a77b1-amd64": not found',
        involvedObject: { name: "j2-orchestrator-77d-abc" },
      },
    ],
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /event Warning Failed: Failed to pull image/);
  assert.match(err.message, /diagnosis: the kubelet could not pull j2-instance-demo:4a77b1-amd64/);
  // The normalization trap, spelled out: a bare ref is a Docker Hub ref.
  assert.match(err.message, /resolves to docker\.io\/library\/j2-instance-demo:4a77b1-amd64/);
  assert.match(err.message, /kind load/);
});

test("a pull failure of a registry ref does not invent a Docker Hub resolution", async () => {
  const kube = mkKube({ pods: [crashPod({ reason: "ErrImagePull", image: "registry.local:5000/j2-harness:0.0.0" })] });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /resolves to registry\.local:5000\/j2-harness:0\.0\.0/);
  assert.doesNotMatch(err.message, /docker\.io/);
});

test("a crash loop leads with the log tail, which is the diagnosis", async () => {
  const kube = mkKube({
    pods: [crashPod({ reason: "CrashLoopBackOff", image: "j2-instance-demo:4a77b1-amd64" })],
    logs: { "j2-orchestrator-77d-abc:previous": "Error: J2_SIGNING_KEY is required\n    at boot\n" },
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /\| Error: J2_SIGNING_KEY is required/);
  assert.match(err.message, /diagnosis: .* starts and exits — the log tail above/);
  // The crashed instance is gone by the time anyone asks, so the read falls back to `--previous`.
  assert.deepEqual(kube.logCalls, [
    "j2-orchestrator-77d-abc/orchestrator",
    "j2-orchestrator-77d-abc/orchestrator --previous",
  ]);
});

test("a config error names the object the namespace does not hold", async () => {
  const kube = mkKube({
    pods: [
      crashPod({
        reason: "CreateContainerConfigError",
        message: 'secret "vllm-key" not found',
        image: "j2-instance-demo:4a77b1-amd64",
      }),
    ],
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /secret "vllm-key" not found/);
  assert.match(err.message, /diagnosis: the pod's env references secret "vllm-key"/);
});

test("evidence no name matches is still carried, with no diagnosis invented", async () => {
  const kube = mkKube({
    pods: [
      {
        metadata: { name: "j2-orchestrator-77d-abc" },
        spec: { containers: [{ name: "orchestrator", image: "j2-instance-demo:4a77b1-amd64" }] },
        status: { phase: "Pending" },
      },
    ],
    events: [
      {
        metadata: { name: "e1" },
        type: "Warning",
        reason: "FailedScheduling",
        message: "0/1 nodes are available: 1 Insufficient memory.",
        involvedObject: { name: "j2-orchestrator-77d-abc" },
      },
    ],
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /pod j2-orchestrator-77d-abc \(Pending\)/);
  assert.match(err.message, /1 Insufficient memory/);
  assert.match(err.message, /image j2-instance-demo:4a77b1-amd64/);
  assert.doesNotMatch(err.message, /diagnosis:/);
  assert.match(err.message, /timed out waiting for the condition$/);
});

test("a rollout whose ReplicaSet made no pod says so", async () => {
  const err = await rolloutFailure(mkKube({}), timedOut, target);
  assert.match(err.message, /no pod matches app=j2-orchestrator/);
  assert.match(err.message, /the ReplicaSet made none/);
  assert.match(err.message, /timed out waiting for the condition$/);

  // The cache agent is a DaemonSet (ADR-0051), and its pods are made by no ReplicaSet.
  const agent = await rolloutFailure(mkKube({}), timedOut, {
    kind: "daemonset",
    name: "j2-repo-cache",
    namespace: "demo",
    selector: "app=j2-repo-cache",
  });
  assert.match(agent.message, /^j2-repo-cache: rollout did not complete/);
  assert.match(agent.message, /the DaemonSet made none/);
});

// --- the rollout wait's argv ------------------------------------------------------------------
// `j2 up` waits on two workload kinds: every layer's Deployment, and the cache agent's DaemonSet
// (ADR-0051). The kind → `rollout status <kind>/<name>` mapping is the one thing the port adds.

test("a rollout wait is a Deployment's unless the kind says DaemonSet", () => {
  assert.deepEqual(rolloutStatusArgs({ name: "j2-orchestrator", namespace: "demo" }), [
    "--namespace",
    "demo",
    "rollout",
    "status",
    "deployment/j2-orchestrator",
    "--timeout=180s",
  ]);
  assert.deepEqual(
    rolloutStatusArgs({
      kind: "daemonset",
      name: "j2-repo-cache",
      namespace: "demo",
      context: "kind-j2",
      timeoutSeconds: 60,
    }),
    ["--context", "kind-j2", "--namespace", "demo", "rollout", "status", "daemonset/j2-repo-cache", "--timeout=60s"],
  );
});

test("a read that itself fails becomes a note, never a second failure", async () => {
  const err = await rolloutFailure(mkKube({ podsFail: true }), timedOut, target);
  assert.match(err.message, /could not be listed \(Unable to connect to the server\)/);
  assert.match(err.message, /timed out waiting for the condition$/);
});

test("a pod that never started outranks the ones that came up", async () => {
  // Only a handful of pods are worth printing, so which ones is a decision. A pod with NO container
  // statuses is the kubelet never getting as far as starting it — unschedulable, still Pending —
  // which is precisely what a failed rollout is about; it must not be sorted behind the replicas
  // that are running happily just because it has no container that said "not ready".
  const running = (name: string): FakePod => ({
    metadata: { name },
    spec: { nodeName: "kind-worker", containers: [{ name: "orchestrator", image: "j2-instance-demo:abc-amd64" }] },
    status: { phase: "Running", containerStatuses: [{ name: "orchestrator", ready: true }] },
  });
  const err = await rolloutFailure(
    mkKube({
      pods: [
        running("j2-orchestrator-old-1"),
        running("j2-orchestrator-old-2"),
        running("j2-orchestrator-old-3"),
        {
          metadata: { name: "j2-orchestrator-new-x" },
          spec: { containers: [{ name: "orchestrator", image: "j2-instance-demo:def-amd64" }] },
          status: { phase: "Pending" },
        },
      ],
      events: [
        {
          metadata: { name: "e1" },
          type: "Warning",
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient memory.",
          involvedObject: { name: "j2-orchestrator-new-x" },
        },
      ],
    }),
    timedOut,
    target,
  );
  assert.match(err.message, /pod j2-orchestrator-new-x \(Pending\)/, "the pod that did not come up is shown");
  assert.match(err.message, /Insufficient memory/, "…with the scheduler's own words about it");
  assert.match(err.message, /1 further pod\(s\) not shown/);
});
