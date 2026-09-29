// The memory guard (ADR-0061, layer 4): the decision, with injected cgroup readers and recorded
// effects — no real cgroup, no real kill. The process-killing side is thin on purpose (read
// `cgroup.procs`, SIGKILL all but PID 1 and the Harness, empty `/dev/shm`) and gets one test of
// its own against a temp directory shaped like the cgroupfs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPids,
  cgroupReader,
  clearShm,
  formatBytes,
  MEMORY_LIMIT_KILLED,
  MemoryGuard,
} from "../src/memory-guard.ts";

const Mi = 1024 * 1024;
const Gi = 1024 * Mi;

/** A guard over a scripted cgroup: `usage` is read in order (the last value repeats). */
function rig(limit: number | undefined, usage: Array<number | undefined>) {
  const effects: string[] = [];
  let i = 0;
  const guard = new MemoryGuard(
    {
      limit: () => limit,
      usage: () => usage[Math.min(i++, usage.length - 1)],
    },
    {
      killAgentProcesses: () => void effects.push("kill"),
      clearShm: () => void effects.push("clear-shm"),
      log: () => {},
    },
    { autoPoll: false },
  );
  return { guard, effects };
}

test("below the threshold the guard does nothing", () => {
  const { guard, effects } = rig(2 * Gi, [Math.floor(1.7 * Gi)]);
  const watch = guard.watch();
  guard.check();
  watch.end();
  assert.deepEqual(effects, []);
  assert.equal(watch.verdict(), undefined);
});

test("near the limit it kills the Agent's processes, checks again, clears /dev/shm, and names the peak", () => {
  const { guard, effects } = rig(2 * Gi, [Math.floor(1.9 * Gi), 200 * Mi]);
  const watch = guard.watch();
  guard.check();
  watch.end();
  assert.deepEqual(effects, ["kill", "clear-shm"]);
  assert.equal(watch.verdict(), `${MEMORY_LIMIT_KILLED} (peak 1.9Gi of 2Gi); use fewer workers or a larger Size`);
  assert.match(watch.verdict() ?? "", /^killed: memory limit \(peak /);
});

test("usage still near the limit after the kill is killed again — a fork raced the first list", () => {
  const { guard, effects } = rig(2 * Gi, [Math.floor(1.95 * Gi), Math.floor(1.9 * Gi), 100 * Mi]);
  guard.watch();
  guard.check();
  assert.deepEqual(effects, ["kill", "kill", "clear-shm"]);
});

test("every running bash call hears the verdict; a call that started after it does not", () => {
  const { guard } = rig(1 * Gi, [Gi, 0, 0]);
  const a = guard.watch();
  const b = guard.watch();
  guard.check();
  a.end();
  b.end();
  const later = guard.watch();
  guard.check();
  later.end();
  assert.ok(a.verdict() && b.verdict());
  assert.equal(later.verdict(), undefined);
});

test("the guard is off when memory.max is `max` or unreadable, or memory.stat is", () => {
  for (const [limit, usage] of [
    [undefined, 10 * Gi],
    [1 * Gi, undefined],
  ] as const) {
    const { guard, effects } = rig(limit, [usage]);
    const watch = guard.watch();
    guard.check();
    assert.deepEqual(effects, []);
    assert.equal(watch.verdict(), undefined);
  }
});

test("the guard polls only while a bash call runs", async () => {
  let reads = 0;
  const guard = new MemoryGuard(
    { limit: () => 1 * Gi, usage: () => (reads++, 0) },
    { killAgentProcesses: () => {}, clearShm: () => {}, log: () => {} },
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads, 0, "no call, no poll");
  const watch = guard.watch();
  await new Promise((r) => setTimeout(r, 80));
  watch.end();
  const polled = reads;
  assert.ok(polled >= 2, `polled ${polled} times in 80ms`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads, polled, "the last call ended, the poll stopped");
});

test("the cgroup reader takes anon + shmem from memory.stat and memory.max, never memory.current", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-cgroup-"));
  await writeFile(join(root, "memory.max"), "2147483648\n");
  await writeFile(join(root, "memory.current"), "9999999999\n");
  await writeFile(join(root, "memory.stat"), "anon 1000\nfile 5000000\nkernel 7\nshmem 234\nfile_mapped 1\n");
  const read = cgroupReader(root);
  assert.equal(read.limit(), 2 * Gi);
  assert.equal(read.usage(), 1234);
  await writeFile(join(root, "memory.max"), "max\n");
  assert.equal(read.limit(), undefined, "no limit, no guard");
  assert.equal(cgroupReader(join(root, "absent")).limit(), undefined);
  assert.equal(cgroupReader(join(root, "absent")).usage(), undefined);
});

test("the kill set is every process in the cgroup but PID 1 (tini) and the Harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-cgroup-"));
  await writeFile(join(root, "cgroup.procs"), `1\n${process.pid}\n42\n43\n`);
  assert.deepEqual(agentPids(root), [42, 43]);
});

test("clearShm empties /dev/shm and leaves the directory", async () => {
  const shm = await mkdtemp(join(tmpdir(), "jr2-shm-"));
  await writeFile(join(shm, "chromium-seg"), "x");
  await mkdir(join(shm, "nested"));
  await writeFile(join(shm, "nested", "f"), "x");
  clearShm(shm);
  assert.deepEqual(await readdir(shm), []);
  clearShm(join(shm, "absent")); // no /dev/shm at all is not an error
});

test("sizes read the way a Size is written", () => {
  assert.equal(formatBytes(2 * Gi), "2Gi");
  assert.equal(formatBytes(Math.floor(1.9 * Gi)), "1.9Gi");
  assert.equal(formatBytes(512 * Mi), "512Mi");
});
