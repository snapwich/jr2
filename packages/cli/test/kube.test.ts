// The check pod's failure message (ADR-0019). `kubectl run --attach` puts the POD's output on
// kubectl's stdout and kubectl's own verdict on stderr, and execFile's rejection carries only the
// latter — so a preflight that failed inside the pod reported nothing about why. These cases pin
// the pod's words into the message the converge throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kubeFloorRefusal,
  kubectlKube,
  REACH_BUDGET_MS,
  rolloutFailure,
  rolloutStatusArgs,
  type KubeAdmin,
  failedMount,
  podPending,
  podProgress,
  waitPodEnd,
  type PodEndPorts,
} from "../src/kube.ts";

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
    awaitPodEnd: async () => assert.fail("a diagnosis runs no pods") as never,
    serverVersion: async () => assert.fail("a diagnosis reads no version") as never,
    dryRunCreate: async () => assert.fail("a diagnosis dry-runs nothing") as never,
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

const target = { name: "jr2-orchestrator", namespace: "demo", selector: "app=jr2-orchestrator" };
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
    metadata: { name: "jr2-orchestrator-77d-abc" },
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
        image: "jr2-instance-demo:4a77b1-amd64",
        last: { reason: "StartError", exitCode: 128, message: "failed to create task: exec format error" },
      }),
    ],
    arch: { "kind-worker": "arm64" },
  });
  const err = await rolloutFailure(kube, timedOut, target);

  // The evidence is printed raw — the diagnosis below only interprets what is already there.
  assert.match(err.message, /exec format error/);
  assert.match(err.message, /image jr2-instance-demo:4a77b1-amd64/);
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
    pods: [crashPod({ reason: "ImagePullBackOff", image: "jr2-instance-demo:4a77b1-amd64" })],
    events: [
      {
        metadata: { name: "e1" },
        type: "Warning",
        reason: "Failed",
        message: 'Failed to pull image "jr2-instance-demo:4a77b1-amd64": not found',
        involvedObject: { name: "jr2-orchestrator-77d-abc" },
      },
    ],
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /event Warning Failed: Failed to pull image/);
  assert.match(err.message, /diagnosis: the kubelet could not pull jr2-instance-demo:4a77b1-amd64/);
  // The normalization trap, spelled out: a bare ref is a Docker Hub ref.
  assert.match(err.message, /resolves to docker\.io\/library\/jr2-instance-demo:4a77b1-amd64/);
  assert.match(err.message, /kind load/);
});

test("a pull failure of a registry ref does not invent a Docker Hub resolution", async () => {
  const kube = mkKube({ pods: [crashPod({ reason: "ErrImagePull", image: "registry.local:5000/jr2-harness:0.0.0" })] });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /resolves to registry\.local:5000\/jr2-harness:0\.0\.0/);
  assert.doesNotMatch(err.message, /docker\.io/);
});

test("a crash loop leads with the log tail, which is the diagnosis", async () => {
  const kube = mkKube({
    pods: [crashPod({ reason: "CrashLoopBackOff", image: "jr2-instance-demo:4a77b1-amd64" })],
    logs: { "jr2-orchestrator-77d-abc:previous": "Error: JR2_SIGNING_KEY is required\n    at boot\n" },
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /\| Error: JR2_SIGNING_KEY is required/);
  assert.match(err.message, /diagnosis: .* starts and exits — the log tail above/);
  // The crashed instance is gone by the time anyone asks, so the read falls back to `--previous`.
  assert.deepEqual(kube.logCalls, [
    "jr2-orchestrator-77d-abc/orchestrator",
    "jr2-orchestrator-77d-abc/orchestrator --previous",
  ]);
});

test("a config error names the object the namespace does not hold", async () => {
  const kube = mkKube({
    pods: [
      crashPod({
        reason: "CreateContainerConfigError",
        message: 'secret "vllm-key" not found',
        image: "jr2-instance-demo:4a77b1-amd64",
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
        metadata: { name: "jr2-orchestrator-77d-abc" },
        spec: { containers: [{ name: "orchestrator", image: "jr2-instance-demo:4a77b1-amd64" }] },
        status: { phase: "Pending" },
      },
    ],
    events: [
      {
        metadata: { name: "e1" },
        type: "Warning",
        reason: "FailedScheduling",
        message: "0/1 nodes are available: 1 Insufficient memory.",
        involvedObject: { name: "jr2-orchestrator-77d-abc" },
      },
    ],
  });
  const err = await rolloutFailure(kube, timedOut, target);
  assert.match(err.message, /pod jr2-orchestrator-77d-abc \(Pending\)/);
  assert.match(err.message, /1 Insufficient memory/);
  assert.match(err.message, /image jr2-instance-demo:4a77b1-amd64/);
  assert.doesNotMatch(err.message, /diagnosis:/);
  assert.match(err.message, /timed out waiting for the condition$/);
});

test("a rollout whose ReplicaSet made no pod says so", async () => {
  const err = await rolloutFailure(mkKube({}), timedOut, target);
  assert.match(err.message, /no pod matches app=jr2-orchestrator/);
  assert.match(err.message, /the ReplicaSet made none/);
  assert.match(err.message, /timed out waiting for the condition$/);

  // The cache agent is a DaemonSet (ADR-0051), and its pods are made by no ReplicaSet.
  const agent = await rolloutFailure(mkKube({}), timedOut, {
    kind: "daemonset",
    name: "jr2-repo-cache",
    namespace: "demo",
    selector: "app=jr2-repo-cache",
  });
  assert.match(agent.message, /^jr2-repo-cache: rollout did not complete/);
  assert.match(agent.message, /the DaemonSet made none/);
});

// --- the rollout wait's argv ------------------------------------------------------------------
// `jr2 up` waits on two workload kinds: every layer's Deployment, and the cache agent's DaemonSet
// (ADR-0051). The kind → `rollout status <kind>/<name>` mapping is the one thing the port adds.

test("a rollout wait is a Deployment's unless the kind says DaemonSet", () => {
  assert.deepEqual(rolloutStatusArgs({ name: "jr2-orchestrator", namespace: "demo" }), [
    "--namespace",
    "demo",
    "rollout",
    "status",
    "deployment/jr2-orchestrator",
    "--timeout=180s",
  ]);
  assert.deepEqual(
    rolloutStatusArgs({
      kind: "daemonset",
      name: "jr2-repo-cache",
      namespace: "demo",
      context: "kind-jr2",
      timeoutSeconds: 60,
    }),
    ["--context", "kind-jr2", "--namespace", "demo", "rollout", "status", "daemonset/jr2-repo-cache", "--timeout=60s"],
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
    spec: { nodeName: "kind-worker", containers: [{ name: "orchestrator", image: "jr2-instance-demo:abc-amd64" }] },
    status: { phase: "Running", containerStatuses: [{ name: "orchestrator", ready: true }] },
  });
  const err = await rolloutFailure(
    mkKube({
      pods: [
        running("jr2-orchestrator-old-1"),
        running("jr2-orchestrator-old-2"),
        running("jr2-orchestrator-old-3"),
        {
          metadata: { name: "jr2-orchestrator-new-x" },
          spec: { containers: [{ name: "orchestrator", image: "jr2-instance-demo:def-amd64" }] },
          status: { phase: "Pending" },
        },
      ],
      events: [
        {
          metadata: { name: "e1" },
          type: "Warning",
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient memory.",
          involvedObject: { name: "jr2-orchestrator-new-x" },
        },
      ],
    }),
    timedOut,
    target,
  );
  assert.match(err.message, /pod jr2-orchestrator-new-x \(Pending\)/, "the pod that did not come up is shown");
  assert.match(err.message, /Insufficient memory/, "…with the scheduler's own words about it");
  assert.match(err.message, /1 further pod\(s\) not shown/);
});

// The BOUND on target resolution (ADR-0019), against a real child process — the only fixture that
// can witness it, because an injected `KubePort` never reaches the `execFile` where the deadline
// lives. A shim `kubectl` that sleeps stands in for a cluster whose API server accepts the
// connection and then says nothing, which is the shape a dropped SYN or a dead VPN actually takes:
// not refused, just silent. Measured before this bound existed: `--request-timeout=5s` alone bought
// a 25s command, because kubectl retries API discovery five times behind it.
test("a kubectl that never answers is killed, and the wait is bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-kube-shim-"));
  try {
    await writeFile(join(dir, "kubectl"), "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
    // PREPENDED, not replaced: the shim must win over a real `kubectl`, while the shim itself still
    // finds `sleep`. Replacing PATH outright leaves the shim unable to run.
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ""}`;
    const started = performance.now();
    try {
      await assert.rejects(
        () => kubectlKube.readSecret({ namespace: "ns", name: "jr2-instance", key: "JR2_INSTANCE_TOKEN" }),
        /no answer after 10s/,
      );
    } finally {
      process.env.PATH = path;
    }
    const spent = Math.round(performance.now() - started);
    assert.ok(spent >= REACH_BUDGET_MS, `waited for the budget, not less (${spent}ms)`);
    assert.ok(spent < REACH_BUDGET_MS * 2, `gave up on the budget, not on the child's own clock (${spent}ms)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ADR-0037's Kubernetes floor: a Sandbox's /opt/jr2 is an `image` volume, on by default from 1.35.
// `jr2 up` reads the server's gitVersion and refuses below it — naming what it found and the floor
// (ADR-0046: the failure carries its diagnosis), never as a Sandbox stuck Pending on a volume type
// the kubelet does not know.
test("the Kubernetes floor: 1.35 and newer pass, whatever the distribution appends", () => {
  for (const v of ["v1.35.0", "v1.36.2", "v1.35.1-gke.1200", "v1.35.0+k3s1", "v1.40.0-eks-4f2c", "v2.0.0"]) {
    assert.equal(kubeFloorRefusal(v), undefined, v);
  }
});

test("below the floor, the refusal names the version found and the floor", () => {
  const said = kubeFloorRefusal("v1.34.2");
  assert.ok(said);
  assert.match(said, /v1\.34\.2/, "the version the server reported, verbatim");
  assert.match(said, /1\.35/, "the floor");
  assert.match(said, /image volume/, "why: the mechanism that needs it");
  assert.match(said, /ADR-0037/);
  assert.ok(kubeFloorRefusal("v1.9.11"), "numeric, not lexical: 9 < 35");
});

test("a version the floor cannot read is refused by name, never passed", () => {
  const said = kubeFloorRefusal("devel");
  assert.ok(said);
  assert.match(said, /"devel"/);
});

test("podProgress: a pod that cannot start stops the wait; a pulling one does not; the check container's start is seen", () => {
  const pod = (
    phase: string,
    init: Record<string, unknown>,
    main: Record<string, unknown>,
  ): Parameters<typeof podProgress>[0] => ({
    status: {
      phase,
      initContainerStatuses: [{ name: "custodian", ...init }],
      containerStatuses: [{ name: "check", ...main }],
    },
  });
  const pulling = podProgress(
    pod(
      "Pending",
      { state: { waiting: { reason: "PodInitializing" } } },
      { state: { waiting: { reason: "ContainerCreating" } } },
    ),
    "check",
    "custodian",
  );
  assert.deepEqual([pulling.phase, pulling.stuck, pulling.running], [undefined, undefined, false]);
  for (const reason of ["CreateContainerConfigError", "CrashLoopBackOff", "InvalidImageName"]) {
    const seen = podProgress(pod("Pending", {}, { state: { waiting: { reason } } }), "check", "custodian");
    assert.equal(seen.stuck, `check: ${reason}`);
  }
  // A pull is final only when the registry says the image, or the right to it, is not there.
  const waiting = (reason: string, message?: string) =>
    podProgress(
      pod("Pending", {}, { state: { waiting: { reason, ...(message ? { message } : {}) } } }),
      "check",
      "custodian",
    );
  for (const message of ["manifest unknown", "pull access denied", "401 Unauthorized", "not found"]) {
    assert.equal(waiting("ErrImagePull", message).stuck, "check: ErrImagePull", message);
  }
  for (const message of ["i/o timeout", "429 Too Many Requests", "context deadline exceeded"]) {
    assert.equal(
      waiting("ImagePullBackOff", message).stuck,
      undefined,
      `a slow or limited pull comes back: ${message}`,
    );
  }
  // CreateContainerError can pass by itself (a runtime that is slow to start a container).
  assert.equal(waiting("CreateContainerError").stuck, undefined);
  const restarted = podProgress(pod("Pending", { restartCount: 1, state: { running: {} } }, {}), "check", "custodian");
  assert.equal(restarted.stuck, "custodian: restarted", "the Custodian refused to start, and will again");
  const running = podProgress(
    pod("Running", { state: { running: {} } }, { state: { running: {} } }),
    "check",
    "custodian",
  );
  assert.deepEqual([running.stuck, running.running], [undefined, true]);
  assert.equal(podProgress(pod("Failed", {}, {}), "check", "custodian").phase, "Failed");
});

test("podProgress: a Custodian that restarted says how its run before ended", () => {
  const seen = podProgress(
    {
      status: {
        phase: "Pending",
        initContainerStatuses: [
          {
            name: "custodian",
            restartCount: 1,
            lastState: { terminated: { reason: "OOMKilled" } },
            state: { running: {} },
          },
        ],
      },
    },
    "check",
    "custodian",
  );
  assert.equal(seen.stuck, "custodian: restarted (last ended OOMKilled)");
  assert.ok(seen.reasons.includes("custodian: last ended OOMKilled"));
});

/** `waitPodEnd`'s ports over a scripted pod and a fake clock: each `pod()` read is the next state,
 * the last repeated, and each sleep moves the clock. */
function scripted(
  states: Array<Parameters<typeof podProgress>[0]>,
  logs: Record<string, string | string[]> = {},
  events: Array<{ reason?: string; message?: string }> = [],
) {
  let t = 0;
  let n = 0;
  const reads: string[] = [];
  const pending: string[] = [];
  const asked: Record<string, number> = {};
  const ports: PodEndPorts = {
    pod: async () => states[Math.min(n++, states.length - 1)],
    events: async () => events,
    pending: (line) => void pending.push(line),
    logs: async (container, opts) => {
      const key = `${container}${opts.previous ? " previous" : ""}`;
      reads.push(`${key} ${opts.tailLines}`);
      const answer = logs[key] ?? "";
      // A list answers each read in turn: a read that fails first, then one that does not.
      const i = (asked[key] = (asked[key] ?? -1) + 1);
      return Array.isArray(answer) ? (answer[Math.min(i, answer.length - 1)] ?? "") : answer;
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { ports, reads, pending, clock: () => t };
}

const statusOf = (check: Record<string, unknown>, phase = "Pending") => ({
  status: {
    phase,
    initContainerStatuses: [{ name: "custodian", state: { running: {} } }],
    containerStatuses: [{ name: "check", ...check }],
  },
});

test("waitPodEnd: the run bound starts when the check container runs, and its whole log is read", async () => {
  const pulling = statusOf({ state: { waiting: { reason: "ContainerCreating" } } });
  const running = statusOf({ state: { running: {} } }, "Running");
  const { ports, reads, clock } = scripted(
    [...Array(100).fill(pulling), running, statusOf({ state: { terminated: { reason: "Completed" } } }, "Succeeded")],
    { check: "jr2.preflight model=a/b ok" },
  );
  // 200 s of pulls is past no bound: the start bound is 300 s, and the run bound starts later.
  const end = await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 10 });
  assert.deepEqual([end.phase, end.started, end.output], ["Succeeded", true, "jr2.preflight model=a/b ok"]);
  assert.equal(clock(), 101 * 2000);
  assert.deepEqual(reads, ["check -1", "custodian 50"], "the whole check log, every model's line");
});

test("waitPodEnd: a pod that never starts times out at the start bound; one that runs too long at the run bound", async () => {
  const never = scripted([statusOf({ state: { waiting: { reason: "ContainerCreating" } } })]);
  const late = await waitPodEnd(never.ports, { container: "check", startSeconds: 10, runSeconds: 999 });
  assert.deepEqual([late.phase, late.started, never.clock()], ["timeout", false, 10_000]);
  const slow = scripted([statusOf({ state: { running: {} } }, "Running")]);
  const long = await waitPodEnd(slow.ports, { container: "check", startSeconds: 999, runSeconds: 6 });
  assert.deepEqual([long.phase, long.started, slow.clock()], ["timeout", true, 6000]);
});

test("waitPodEnd: a Custodian restart stops the wait at once, and its run before is read for the refusal", async () => {
  const restarted = {
    status: {
      phase: "Pending",
      initContainerStatuses: [
        { name: "custodian", restartCount: 1, state: { waiting: { reason: "PodInitializing" } } },
      ],
    },
  };
  const { ports, reads, clock } = scripted([restarted], {
    "custodian previous": "jr2.custodian refuse secret=ANTHROPIC_API_KEY reason=empty-value",
  });
  const end = await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 90 });
  assert.deepEqual([end.phase, end.stuck, clock()], ["stuck", "custodian: restarted", 0]);
  assert.match(end.custodian, /reason=empty-value/);
  assert.deepEqual(reads, ["check -1", "custodian previous 50", "custodian 50"]);
});

test("failedMount: the kubelet's texts for a missing Secret, Secret key or ConfigMap key, counted when said again", () => {
  const texts = [
    'MountVolume.SetUp failed for volume "custodian-values" : secret "team" not found',
    'MountVolume.SetUp failed for volume "custodian-values" : references non-existent secret key: anthropic',
    'MountVolume.SetUp failed for volume "config" : configmap references non-existent config key: harness.json',
  ];
  for (const message of texts) {
    const seen = new Map<string, string>();
    // The first sight, whatever its count: it can be a race with the objects of the same apply.
    assert.equal(failedMount([{ reason: "FailedMount", message, count: 3 }], seen), undefined, message);
    // The same event, not said again: still nothing.
    assert.equal(failedMount([{ reason: "FailedMount", message, count: 3 }], seen), undefined);
    // Said again: its count went up.
    assert.equal(failedMount([{ reason: "FailedMount", message, count: 4 }], seen), `FailedMount: ${message}`);
  }
  const seen = new Map<string, string>();
  const message = texts[0]!;
  failedMount([{ reason: "FailedMount", message, lastTimestamp: "2026-10-23T08:00:00Z" }], seen);
  assert.equal(
    failedMount([{ reason: "FailedMount", message, lastTimestamp: "2026-10-23T08:00:08Z" }], seen),
    `FailedMount: ${message}`,
    "or its lastTimestamp moved",
  );
  assert.equal(
    failedMount([{ reason: "FailedMount", message: "timed out waiting for the condition", count: 5 }], new Map()),
    undefined,
  );
});

test("waitPodEnd: a volume that cannot mount stops the wait once the kubelet says it again", async () => {
  const creating = statusOf({ state: { waiting: { reason: "ContainerCreating" } } });
  const message =
    'MountVolume.SetUp failed for volume "custodian-values" : references non-existent secret key: anthropic';
  let polls = 0;
  const { ports, clock } = scripted([creating]);
  ports.events = async () => [{ reason: "FailedMount", message, count: ++polls > 2 ? 2 : 1 }];
  const end = await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 90 });
  assert.equal(end.phase, "stuck");
  assert.match(end.stuck ?? "", /^FailedMount: .*non-existent secret key/);
  assert.equal(clock(), 4000, "two polls of the same count, then the poll on which it went up");
});

test("waitPodEnd: each new reason a pod gives for not running is said once, for the person who waits", async () => {
  const unscheduled = {
    status: {
      phase: "Pending",
      conditions: [
        { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available" },
      ],
    },
  };
  const creating = statusOf({ state: { waiting: { reason: "ContainerCreating" } } });
  const { ports, pending } = scripted([unscheduled, unscheduled, creating, statusOf({}, "Succeeded")], {
    check: "jr2.preflight model=a/b ok",
  });
  await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 90 });
  assert.deepEqual(pending, ["Unschedulable: 0/3 nodes are available", "check: ContainerCreating"]);
});

test("waitPodEnd: a log read that answers nothing after the pod ended is read again", async () => {
  const { ports, reads } = scripted([statusOf({}, "Succeeded")], { check: ["", "", "jr2.preflight model=a/b ok"] });
  const end = await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 90 });
  assert.equal(end.output, "jr2.preflight model=a/b ok");
  assert.deepEqual(
    reads.filter((r) => r.startsWith("check")),
    ["check -1", "check -1", "check -1"],
  );
});

test("waitPodEnd: while the check container runs, its log goes to `log` on each poll", async () => {
  const running = statusOf({ state: { running: {} } }, "Running");
  const { ports } = scripted([running, running, statusOf({}, "Succeeded")], { check: "jr2.preflight model=a/b ok" });
  const logs: string[] = [];
  ports.log = (output) => void logs.push(output);
  await waitPodEnd(ports, { container: "check", startSeconds: 300, runSeconds: 90 });
  assert.deepEqual(logs, ["jr2.preflight model=a/b ok", "jr2.preflight model=a/b ok"]);
});

test('podPending: a pod that runs with no container waiting says nothing — not "not running yet"', () => {
  assert.equal(
    podPending({
      status: { phase: "Running", initContainerStatuses: [{ name: "custodian", state: { running: {} } }] },
    }),
    undefined,
  );
  assert.equal(podPending({ status: { phase: "Pending" } }), "Pending");
  assert.equal(
    podPending({
      status: {
        phase: "Pending",
        containerStatuses: [{ name: "check", state: { waiting: { reason: "PodInitializing" } } }],
      },
    }),
    "check: PodInitializing",
  );
});
