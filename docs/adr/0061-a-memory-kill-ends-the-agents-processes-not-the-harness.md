# A memory kill ends the Agent's processes, not the Harness

The Agent runs its programs (Playwright and its Chromium, `tsc`, `cargo`) through the `bash` Working tool, so they are
children of the Harness, in the Harness container's one cgroup (ADR-0005, ADR-0037). On cgroup v2 the kubelet sets
`memory.oom.group`, so when those programs pass the container's limit (ADR-0060) the kernel kills the whole container:
the Harness dies with them, its conversation with it, and the Turn faults as "conversation lost" (lab 2026-09-28; chaos
test T11). Worse, pi's bash tool reports a command killed by a signal as success — `exitCode: code ?? 0` in
pi-agent-core 0.82.1 — so when a program is killed the Agent sees its output stop partway and reads it as a pass.

**The Agent's processes** are every process in the Harness container except the Harness and its init: the tree of the
running `bash` call, anything the Agent left running from earlier calls (a dev server, a watcher), and a human's
`kubectl exec` session.

## Decision

Layers, each a backstop for the one before:

1. **A process killed by a signal is an error.** jr2 wraps pi's bash tool so a signal death reports the signal and never
   exit 0. A Harness conformance test holds it (ADR-0027).
2. **`tini` is PID 1 in the Harness container**, shipped on `/opt/jr2`, so killed trees leave no zombies. Not
   `shareProcessNamespace` — ADR-0005 keeps it off for good.
3. **The `bash` Working tool starts each command with `oom_score_adj=1000`**, inherited by its children. It needs no
   privilege, and on a node whose owner set the kubelet's `singleProcessOOMKill: true` the kernel then picks the Agent's
   process, not the Harness.
4. **The Harness guards its own cgroup.** Every 10–20 ms it reads anon + shmem from `memory.stat` against `memory.max`
   (never `memory.current`, which counts reclaimable page cache). Near the limit it kills all of the Agent's processes,
   checks usage again, clears `/dev/shm`, and the running `bash` call returns
   `killed: memory limit (peak X of Y); use fewer workers or a larger Size`. The Agent hears it in the same Turn and
   conversation, and can retry smaller.
5. **The kernel's group kill is the last backstop.** The Orchestrator reads `lastState.terminated.reason: OOMKilled` and
   the fault reason starts with the fixed prefix `memory limit`, not "conversation lost". The fault reaches the Machine
   (ADR-0016); the next Agent in that Workspace is told through the Briefing
   ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)), never through the Frame (ADR-0057). The
   kit's Machines pass the reason into their retry Turn as the example for authors.

The guard is best-effort and says so: a fast enough spike beats any poll. The lab won 35/35 on arm64 at 50 ms, 6/6 on
amd64 at 10 ms (0.8% of a core), and only half on amd64 at 50 ms; it fired at 90–96% of the limit. Layer 5 covers what
it misses.

**The planned successor is a child cgroup for the Agent's processes** (`memory.max` below the container's, its own
`oom.group`): exact, no race, the Harness always survives (lab: 3/3 on kind). It needs a writable cgroupfs, which today
only a node owner grants (containerd ≥ 2.1 `cgroup_writable` behind a RuntimeClass, not offered on managed clusters).
KEP-5474 adds `securityContext.cgroupOptions.mountMode: Writable` so the pod asks for it itself; it is alpha, targeted
at v1.38. When it is enabled by default, jr2 sets the field on the Harness container and the child cgroup replaces layer
4's polling.

## Considered options

- **Accept the group kill.** Rejected as the whole answer: every memory kill becomes a Turn fault, and the Agent never
  learns why, so a retry repeats it.
- **The Harness in its own container, with an exec server in the Sandbox Image's container running the Agent's
  processes.** A real cgroup edge, but it reverses "Working tools execute in the Harness container" (ADR-0037) for a
  problem layers 4 and the successor solve inside it.
- **Adopt the child cgroup now, used when detected.** Rejected: a path almost no cluster runs is a path nobody tests,
  and the guard must be solid on its own anyway.
- **MemoryQoS `memory.high`.** Rejected: the lab saw a stall of over 9 minutes with no kill and `kubectl exec` hung.
- **earlyoom, systemd-oomd, oomd.** Rejected: they read the host's `/proc/meminfo`, need systemd, or need PSI triggers,
  which a read-only cgroupfs refuses. The guard borrows their idea.
- **Kill only the running call's process group.** Rejected: `setsid` children escape it (lab), and a dev server left
  from an earlier call may hold the memory.
- **Raise Node's heap for the Agent's processes** (`NODE_OPTIONS`). Rejected in ADR-0060: it turns a readable V8 abort
  into a kernel kill.

## Consequences

- The guard's threshold comes from the Harness container's limit, so it needs ADR-0060's limits first; layer 1 does not
  and is fixed at once.
- The kill set includes a human's exec session open at that moment; the group kill would end it too.
- A memory fault is named in `jr2 status` and on the feed, not "conversation lost".
