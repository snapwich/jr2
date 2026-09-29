// The memory guard (ADR-0061, layer 4): the Harness guards its own cgroup, so a memory spike
// ends the Agent's processes and not the Harness. On cgroup v2 the kubelet sets
// `memory.oom.group`, and a kernel OOM in the Harness container kills the whole container — the
// Harness and its conversation with it. The guard gets there first: while any `bash` call runs, it
// reads anon + shmem from `memory.stat` against `memory.max` every few milliseconds, and near the
// limit it kills every process in the container except PID 1 (tini) and the Harness, checks usage
// again, clears `/dev/shm`, and the running `bash` calls answer
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

/** How often the guard reads the cgroup while a `bash` call runs. The lab won 6/6 on amd64 at
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
  killAgentProcesses(): void;
  clearShm(): void;
  /** The pod log. */
  log(line: string): void;
};

/** One `bash` call under the guard: `end()` when it settles, then `verdict()` — the kill text
 * when the guard fired while it ran. */
export type GuardWatch = { end(): void; verdict(): string | undefined };

export class MemoryGuard {
  readonly #read: CgroupRead;
  readonly #effects: GuardEffects;
  readonly #autoPoll: boolean;
  readonly #active = new Set<{ verdict?: string }>();
  #timer: ReturnType<typeof setInterval> | undefined;

  /** `autoPoll: false` is a seam for the tests, which drive `check()` themselves. */
  constructor(read: CgroupRead, effects: GuardEffects, opts: { autoPoll?: boolean } = {}) {
    this.#read = read;
    this.#effects = effects;
    this.#autoPoll = opts.autoPoll ?? true;
  }

  /** Watch one `bash` call. The poll runs while at least one call is watched, and only then. */
  watch(): GuardWatch {
    const call: { verdict?: string } = {};
    this.#active.add(call);
    if (this.#autoPoll && this.#timer === undefined) {
      this.#timer = setInterval(() => this.check(), POLL_MS);
      this.#timer.unref();
    }
    return {
      end: () => {
        this.#active.delete(call);
        if (this.#active.size === 0 && this.#timer !== undefined) {
          clearInterval(this.#timer);
          this.#timer = undefined;
        }
      },
      verdict: () => call.verdict,
    };
  }

  /** One poll: read, and fire when usage is near the limit. */
  check(): void {
    const limit = this.#read.limit();
    const peak = this.#read.usage();
    if (limit === undefined || peak === undefined || peak < limit * THRESHOLD) return;
    this.#effects.killAgentProcesses();
    // Checked again: a process forked between the list and the kill escapes the first pass. A
    // second pass catches it; memory the kernel is still freeing reads below the line already.
    const after = this.#read.usage();
    if (after !== undefined && after >= limit * THRESHOLD) this.#effects.killAgentProcesses();
    // shm files outlive the processes that wrote them and stay charged to the cgroup (ADR-0060).
    this.#effects.clearShm();
    const verdict = `${MEMORY_LIMIT_KILLED} (peak ${formatBytes(peak)} of ${formatBytes(limit)}); use fewer workers or a larger Size`;
    this.#effects.log(`jr2 harness: ${verdict} — killed the Agent's processes and cleared /dev/shm (ADR-0061)`);
    for (const call of this.#active) call.verdict ??= verdict;
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

function killAgentProcesses(root = CGROUP): void {
  for (const pid of agentPids(root)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already — it exited between the list and the kill.
    }
  }
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
