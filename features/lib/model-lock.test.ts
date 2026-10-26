// The lock on the @model instance's profile (ADR-0066), pinned without a cluster or a model.

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { suiteOf, takeProfileLock, type ProfileLock } from "./model-lock.ts";

const lockPath = async () => join(await mkdtemp(join(tmpdir(), "model-lock-")), "model-endpoint.lock");
const held = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ProfileLock;
const live = (pids: number[]) => (pid: number) => pids.includes(pid);

test("the first suite takes the lock, and the workers of that suite share it", async () => {
  const path = await lockPath();
  const want = { profile: "homelab", suite: "100-1", pid: 100 };
  await takeProfileLock(path, want, live([100]));
  await takeProfileLock(path, want, live([100]));
  assert.deepEqual(await held(path), want);
});

test("a second live suite with another profile fails at once, naming the other profile and the fix", async () => {
  const path = await lockPath();
  await takeProfileLock(path, { profile: "homelab", suite: "100-1", pid: 100 }, live([100, 200]));
  await assert.rejects(
    takeProfileLock(path, { profile: "anthropic-haiku", suite: "200-1", pid: 200 }, live([100, 200])),
    (err: Error) => /"homelab"/.test(err.message) && /two worktrees/.test(err.message),
  );
  assert.equal((await held(path)).profile, "homelab", "the refused suite leaves the lock as it was");
});

test("a second live suite with the same profile fails at once too, and says to wait or use another worktree", async () => {
  const path = await lockPath();
  await takeProfileLock(path, { profile: "homelab", suite: "100-1", pid: 100 }, live([100, 200]));
  await assert.rejects(
    takeProfileLock(path, { profile: "homelab", suite: "200-1", pid: 200 }, live([100, 200])),
    (err: Error) => /same endpoint profile "homelab"/.test(err.message) && /another worktree/.test(err.message),
  );
  assert.equal((await held(path)).suite, "100-1", "the refused suite leaves the lock as it was");
});

test("a lock whose owner is gone is taken over, whatever profile it names", async () => {
  const path = await lockPath();
  await takeProfileLock(path, { profile: "homelab", suite: "100-1", pid: 100 }, live([100]));
  const want = { profile: "anthropic-sonnet", suite: "300-1", pid: 300 };
  await takeProfileLock(path, want, live([300]));
  assert.deepEqual(await held(path), want);
});

test("a lock file that does not parse is taken over", async () => {
  const path = await lockPath();
  await writeFile(path, "not json");
  const want = { profile: "homelab", suite: "100-1", pid: 100 };
  await takeProfileLock(path, want, live([100]));
  assert.deepEqual(await held(path), want);
});

test("the suite is the recipe's when it set one, else the cucumber process", () => {
  const self = { pid: 50 };
  assert.deepEqual(suiteOf({ JR2_MODEL_SUITE: "123-1730000000" }, self), { suite: "123-1730000000", pid: 123 });
  assert.deepEqual(suiteOf({}, self), { suite: "50", pid: 50 }, "in-process: this process");
  assert.deepEqual(
    suiteOf({ CUCUMBER_WORKER_ID: "2" }, self),
    { suite: "50", pid: 50 },
    "a worker thread: the same process",
  );
  assert.deepEqual(suiteOf({ JR2_MODEL_SUITE: "nonsense" }, self), { suite: "50", pid: 50 });
});
