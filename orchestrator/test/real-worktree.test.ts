// The executable mock↔real swap (ADR-0003 + ADR-0004). The SAME coding template
// runs with the REAL git worktree provider substituted for the mock — no k8s, no
// flue, just local git. Proves provider injection is the whole composability
// mechanism, and that the real provider produces the ADR-0004 layout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "xstate";

import { assembleCodingMachine } from "../src/coding/index.ts";
import { InMemoryWorkSource } from "../src/coding/testing/mock-work-source.ts";
import {
  mockCodingProviders,
  newTracker,
  type CoderScript,
  type ReviewerScript,
} from "../src/coding/testing/mock-providers.ts";
import { makeRealWorktree, makeRealWorktreeCleanup } from "../src/coding/providers/real-worktree.ts";

const exec = promisify(execFile);
const exists = (p: string) =>
  stat(p)
    .then(() => true)
    .catch(() => false);

async function until(pred: () => boolean, msg: string, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${msg}`);
}

test("real worktree provider drives the same template (ADR-0004 layout)", async () => {
  const root = await mkdtemp(join(tmpdir(), "j2-poc8-wt-"));
  try {
    // 1. A canonical read-only `default/` source repo with one committed file.
    const source = join(root, "canonical");
    await mkdir(source, { recursive: true });
    const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
    await exec("git", ["init", "-q", "-b", "main", source]);
    await git("config", "user.email", "poc8@j2.dev");
    await git("config", "user.name", "poc8");
    await writeFile(join(source, "README.md"), "canonical default\n");
    await git("add", "README.md");
    await git("commit", "-q", "-m", "seed");

    // 2. The coding template, with ONLY the worktree slot swapped to real.
    const ws = new InMemoryWorkSource([{ id: "F1", tasks: ["t0"] }]);
    const tracker = newTracker();
    const sandboxRoot = join(root, "sandboxes");
    const cfg = { defaultRepoSource: source, sandboxRoot };
    const coder: CoderScript = () => [{ emit: "done" }];
    const reviewer: ReviewerScript = () => ({ emit: "approve" });

    const providers = {
      ...mockCodingProviders({ source: ws, tracker, coder, reviewer }),
      setupWorktree: makeRealWorktree(cfg), // ← the real swap
      cleanupSandbox: makeRealWorktreeCleanup(cfg),
    };
    const actor = createActor(assembleCodingMachine(providers), { input: { maxConcurrent: 1 } });
    actor.start();

    await until(() => ws.allFeaturesDone(), "feature completed via real worktree");
    actor.stop();

    // 3. Assert the ADR-0004 on-disk shape. Sandbox id = `sbx-F1`, branch
    //    `feature/F1` → dir `feature-F1`. (Cleanup ran, so re-create to inspect
    //    one fresh.)
    const handle = await makeRealWorktreeProbe(cfg);
    assert.ok(await exists(join(handle.defaultRepo, ".git")), "per-Sandbox private .git exists");

    // `--shared`: objects borrowed from the source via alternates.
    const alternates = await readFile(join(handle.defaultRepo, ".git", "objects", "info", "alternates"), "utf8");
    assert.ok(alternates.includes(source), "alternates points at the read-only source");

    // `--no-checkout`: default/ has no working tree, but the branch worktree
    // materialized the committed files.
    assert.equal(await exists(join(handle.defaultRepo, "README.md")), false, "default/ not checked out");
    assert.ok(await exists(join(handle.path, "README.md")), "branch worktree materialized files");
    assert.equal((await readFile(join(handle.path, "README.md"), "utf8")).trim(), "canonical default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Run the real provider once directly to inspect its output handle/layout.
async function makeRealWorktreeProbe(cfg: { defaultRepoSource: string; sandboxRoot: string }) {
  const actor = createActor(makeRealWorktree(cfg), {
    input: { sandbox: { id: "probe", endpoint: "x" }, featureId: "F1", branch: "feature/F1" },
  });
  return await new Promise<{ path: string; defaultRepo: string; branch: string }>((resolve, reject) => {
    actor.subscribe({
      complete: () => resolve(actor.getSnapshot().output as any),
      error: reject,
    });
    actor.start();
  });
}
