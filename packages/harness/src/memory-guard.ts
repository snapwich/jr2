// The memory guard (ADR-0061, layer 4): the Harness guards its own cgroup, so a memory spike
// ends the Agent's processes and not the Harness. On cgroup v2 the kubelet sets
// `memory.oom.group`, and a kernel OOM in the Harness container kills the whole container — the
// Harness and its conversation with it. The guard gets there first: from the Harness's start it
// reads anon + shmem from `memory.stat` against `memory.max` every few milliseconds — with or
// without a `bash` call running, since the Agent's processes include a dev server left from an
// earlier call and a human's exec session — and near the limit it kills every process in the
// container except PID 1 (tini) and the Harness, checks usage again, clears `/dev/shm`, and the
// running `bash` calls, if any, answer
// `killed: memory limit (peak X of Y); use fewer workers or a larger Size` — in the same Turn and
// conversation, so the Agent can retry smaller.
//
// Never `memory.current`: it counts reclaimable page cache, and a `cargo build` would read as near
// the limit with nothing to kill. Best-effort and said so: a fast enough spike beats any poll, and
// the kernel's group kill stays the last backstop (layer 5). The planned successor is a child
// cgroup for the Agent's processes (KEP-5474), which replaces this polling.
//
// The decision (`MemoryGuard`) takes its reads and its effects injected; the process side
// (`cgroupReader`, `killAgentProcesses`, `clearShm`) is thin on purpose.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** How often the guard reads the cgroup. The lab won 6/6 on amd64 at
 * 10 ms (0.8% of a core) and only half at 50 ms (ADR-0061). Turn mechanics, not an author dial. */
const POLL_MS = 15;

/** The fraction of `memory.max` at which the guard fires. The lab's guard fired at 90–96%. */
const THRESHOLD = 0.9;

/** The fixed prefix of a memory kill's text — the same prefix the Orchestrator's fault reason for
 * an `OOMKilled` Harness starts with (ADR-0061, layer 5), so both read as one kind of fault. */
export const MEMORY_LIMIT_KILLED = "killed: memory limit";

/** The cgroup, as the guard reads it. `undefined` is "unreadable or unlimited": the guard is off. */
export type CgroupRead = {
  /** `memory.max` in bytes; undefined when it is `max` or cannot be read. */
  limit(): number | undefined;
  /** anon + shmem from `memory.stat`, in bytes; undefined when it cannot be read. */
  usage(): number | undefined;
};

/** What the guard does when it fires. */
export type GuardEffects = {
  /** Returns how many processes it signalled. */
  killAgentProcesses(): number;
  clearShm(): void;
  /** The pod log. */
  log(line: string): void;
};

/** One `bash` call under the guard: `end()` when it settles, then `verdict()` — the kill text
 * when the guard fired while it ran. */
export type GuardWatch = { end(): void; verdict(): string | undefined };

/** One kill, as the updates stream reports it (ADR-0062): sizes written the way a Size is. */
export type GuardKill = { peak: string; limit: string };

export class MemoryGuard {
  readonly #read: CgroupRead;
  readonly #effects: GuardEffects;
  readonly #active = new Set<{ verdict?: string }>();
  readonly #listeners = new Set<(kill: GuardKill) => void>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(read: CgroupRead, effects: GuardEffects) {
    this.#read = read;
    this.#effects = effects;
  }

  /** Start polling, at the Harness's start. Only where `memory.max` is a number: no limit, no
   * guard (a host run). Returns whether the guard is on. */
  start(): boolean {
    if (this.#timer !== undefined) return true;
    if (this.#read.limit() === undefined) return false;
    this.#timer = setInterval(() => this.check(), POLL_MS);
    this.#timer.unref();
    return true;
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Watch one `bash` call, for its verdict alone — the poll does not depend on it. */
  watch(): GuardWatch {
    const call: { verdict?: string } = {};
    this.#active.add(call);
    return { end: () => void this.#active.delete(call), verdict: () => call.verdict };
  }

  /** Hear every kill — how the conversations whose Submissions run put it on their streams, so
   * the Orchestrator keeps a workspace notice for the next Agent (ADR-0062). Returns the
   * unsubscribe. */
  onKill(listener: (kill: GuardKill) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** One poll: read, and fire when usage is near the limit. */
  check(): void {
    const limit = this.#read.limit();
    const peak = this.#read.usage();
    if (limit === undefined || peak === undefined || peak < limit * THRESHOLD) return;
    const killed = this.#effects.killAgentProcesses();
    if (killed === 0) {
      // Nothing of the Agent's runs: the memory is the Harness's own, or shm left behind. Clear
      // shm and say nothing — a log line every poll would bury the pod log.
      this.#effects.clearShm();
      return;
    }
    // Checked again: a process forked between the list and the kill escapes the first pass. A
    // second pass catches it; memory the kernel is still freeing reads below the line already.
    const after = this.#read.usage();
    if (after !== undefined && after >= limit * THRESHOLD) this.#effects.killAgentProcesses();
    // shm files outlive the processes that wrote them and stay charged to the cgroup (ADR-0060).
    this.#effects.clearShm();
    const verdict = `${MEMORY_LIMIT_KILLED} (peak ${formatBytes(peak)} of ${formatBytes(limit)}); use fewer workers or a larger Size`;
    this.#effects.log(`jr2 harness: ${verdict} — killed the Agent's processes and cleared /dev/shm (ADR-0061)`);
    for (const call of this.#active) call.verdict ??= verdict;
    const kill = { peak: formatBytes(peak), limit: formatBytes(limit) };
    for (const listener of this.#listeners) listener(kill);
  }
}

/** The guard for this process's own cgroup (cgroup v2, read-only at `/sys/fs/cgroup`). */
export function podMemoryGuard(): MemoryGuard {
  return new MemoryGuard(cgroupReader(), {
    killAgentProcesses: () => killAgentProcesses(),
    clearShm: () => clearShm(),
    log: (line) => console.error(line),
  });
}

const CGROUP = "/sys/fs/cgroup";

/** The cgroup's memory files. Read synchronously: a cgroupfs read is microseconds, and the poll
 * must not queue behind the event loop's other work. */
export function cgroupReader(root = CGROUP): CgroupRead {
  return {
    limit: () => {
      const raw = readOr(join(root, "memory.max"))?.trim();
      if (raw === undefined || raw === "max") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    },
    usage: () => {
      const stat = readOr(join(root, "memory.stat"));
      if (stat === undefined) return undefined;
      let anon: number | undefined;
      let shmem: number | undefined;
      for (const line of stat.split("\n")) {
        const [key, value] = line.split(" ");
        if (key === "anon") anon = Number(value);
        else if (key === "shmem") shmem = Number(value);
      }
      return anon === undefined && shmem === undefined ? undefined : (anon ?? 0) + (shmem ?? 0);
    },
  };
}

/** The Agent's processes (ADR-0061): every process in the container's cgroup except PID 1 — tini,
 * whose reaping keeps a killed tree from leaving zombies — and the Harness itself. */
export function agentPids(root = CGROUP): number[] {
  const procs = readOr(join(root, "cgroup.procs")) ?? "";
  return procs
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
}

function killAgentProcesses(root = CGROUP): number {
  let killed = 0;
  for (const pid of agentPids(root)) {
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {
      // Gone already — it exited between the list and the kill.
    }
  }
  return killed;
}

/** Empty `/dev/shm`, keeping the directory (the pod's memory-backed emptyDir, ADR-0060). Absent
 * or unreadable is not an error: the guard and the start both call this best-effort. */
export function clearShm(dir = "/dev/shm"): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      // Another uid's file (a User Container's, ADR-0005): not ours to free.
    }
  }
}

/** A byte count the way a Size is written: `2Gi`, `1.9Gi`, `512Mi`. */
export function formatBytes(bytes: number): string {
  const gi = bytes / 1024 ** 3;
  if (gi >= 1) return `${Number(gi.toFixed(1))}Gi`;
  return `${Math.round(bytes / 1024 ** 2)}Mi`;
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
