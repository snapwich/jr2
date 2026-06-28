// REAL worktree-setup provider (ADR-0004) — fills the `setupWorktree` slot with
// genuine git, no Kubernetes or flue. It is the executable proof that the
// mock↔real swap is "just `provide()`": the same coding template runs with this
// substituted for `mockWorktree`.
//
// Per ADR-0004 each Sandbox gets its OWN `.git` via a local `git clone --shared`
// from a read-only canonical `default/` (borrowing objects for cheap setup,
// owning its own refs/locks → zero shared-lock contention), then takes branch
// worktrees off that per-Sandbox clone in the gwtmux layout:
//
//   <sandboxDir>/default/        the `git clone --shared --no-checkout` (.git here)
//   <sandboxDir>/<branch-dir>/   `git worktree add` siblings, one per branch
//
// `--no-checkout` skips the redundant `default/` working tree (work happens in
// the branch worktrees); `--shared` borrows objects from the source's store via
// `objects/info/alternates`. The canonical source is mounted read-only in
// production, which enforces the only invariant `--shared` needs (invariant 1).

import { fromPromise } from "xstate";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeHandle, SetupWorktreeInput } from "../slots.ts";

const exec = promisify(execFile);

export interface RealWorktreeConfig {
  /** Canonical read-only `default/` checkout to clone from (the object source). */
  defaultRepoSource: string;
  /** Root for each Sandbox's private clone (pod-local disk / emptyDir). */
  sandboxRoot: string;
}

/** Map a ref name (`feature/x`) to a filesystem-safe sibling dir name. */
function branchDir(branch: string): string {
  return branch.replace(/\//g, "-");
}

export function makeRealWorktree(cfg: RealWorktreeConfig) {
  return fromPromise<WorktreeHandle, SetupWorktreeInput>(async ({ input }) => {
    const sandboxDir = join(cfg.sandboxRoot, input.sandbox.id);
    const defaultRepo = join(sandboxDir, "default");
    const worktreePath = join(sandboxDir, branchDir(input.branch));

    await mkdir(sandboxDir, { recursive: true });
    // Private `.git`; objects borrowed from the read-only source; no checkout.
    await exec("git", ["clone", "--shared", "--no-checkout", cfg.defaultRepoSource, defaultRepo]);
    // A branch worktree sibling off the per-Sandbox clone — materializes files.
    await exec("git", ["-C", defaultRepo, "worktree", "add", worktreePath, "-b", input.branch]);

    return { path: worktreePath, defaultRepo, branch: input.branch };
  });
}

/** Best-effort teardown of a Sandbox's on-disk worktree tree (for the cleanup slot). */
export function makeRealWorktreeCleanup(cfg: RealWorktreeConfig) {
  return fromPromise<void, { sandbox: { id: string } }>(async ({ input }) => {
    const { rm } = await import("node:fs/promises");
    await rm(join(cfg.sandboxRoot, input.sandbox.id), { recursive: true, force: true });
  });
}
