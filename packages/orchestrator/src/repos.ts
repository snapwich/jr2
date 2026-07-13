// The source-volume boot reconcile (ADR-0009): before any Workspace can attach, the instance's
// `repos/<name>/default` read-only checkouts must exist and match `config.repos` — the same
// reconcile discipline restore applies to Sandbox CRs, applied at orchestrator boot. This is
// orchestrator INFRASTRUCTURE, not a machine slot: the volume serves every workflow.
//
// One deliberate deviation from the ADR-0009 sketch: local-path repo urls are CLONED like any
// other url, not used in place. The repos dir is what kind's `extraMounts` exposes to the node
// (baked at cluster creation) — a working copy elsewhere on disk is simply not reachable from
// pods, and a same-filesystem `git clone` hardlinks objects, so the cost is negligible.
//
// The git runner is injectable so the reconcile logic is unit-testable without spawning git;
// the kind e2e tier runs the real one.

import { mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { J2Config } from "./config.ts";

/** Run one git invocation to completion (injectable seam). */
export type GitRunner = (args: string[]) => Promise<void>;

export type RepoSync = { name: string; dir: string; action: "cloned" | "fetched" };

/**
 * Ensure `<reposDir>/<name>/default` exists for every configured repo: clone it fresh, or
 * fetch to freshen an existing one (never mutate in place beyond fetch — in-use `--shared`
 * clones borrow these objects, and fetch only ADDS objects, which is what keeps ADR-0004's
 * no-`gc` invariant honest at this layer).
 */
export async function ensureRepos(
  config: J2Config,
  reposDir: string,
  git: GitRunner = defaultGit,
): Promise<RepoSync[]> {
  const synced: RepoSync[] = [];
  for (const repo of config.repos) {
    const dir = join(reposDir, repo.name, "default");
    if (await isRepo(dir)) {
      await git(["-C", dir, "fetch", "--all", "--prune"]);
      synced.push({ name: repo.name, dir, action: "fetched" });
    } else {
      await mkdir(dirname(dir), { recursive: true });
      await git(["clone", repo.url, dir]);
      if (repo.ref) await git(["-C", dir, "checkout", repo.ref]);
      synced.push({ name: repo.name, dir, action: "cloned" });
    }
  }
  return synced;
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

const defaultGit: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
