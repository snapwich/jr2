// The source-volume boot reconcile (ADR-0004/0009): before any Workspace can attach, the
// instance's `repos/<name>/default` read-only checkouts must exist, be gc-pinned, and be fresh.
// The catalog is the UNION of `config.repos` (entries j2 materializes from a url) and whatever
// checkouts already sit under `repos/` — the directory is the source of truth; a config entry is
// only needed when j2 must clone. This is orchestrator INFRASTRUCTURE, not a machine slot: the
// volume serves every workflow.
//
// Every checkout — cloned, fetched, or adopted — gets the gc pinning (ADR-0004): Sandboxes borrow
// objects from these checkouts via `--shared` alternates, so deleting an object here corrupts
// them. The read-only pod mount makes Sandboxes structurally unable to gc; the host side is the
// one writer, and `git fetch` itself triggers `gc --auto` — which past the loose-object threshold
// prunes unreachable objects (force-pushed-away commits a live clone may still borrow). Pinning
// `gc.auto=0` / `gc.pruneExpire=never` / `maintenance.auto=false` runs BEFORE the fetch, every
// boot, so a manually-dropped checkout gets the safety for free and no git use in the checkout —
// ours or a human's — can delete objects.
//
// Local-path repo urls are CLONED like any other url, not used in place (ADR-0004): the repos dir
// is what reaches the cluster (kind's `extraMounts` / the deployed volume) — a working copy
// elsewhere on disk is simply not reachable from pods, and a same-filesystem `git clone`
// hardlinks objects, so the cost is negligible.
//
// The git runner is injectable so the reconcile logic is unit-testable without spawning git;
// the kind e2e tier runs the real one.

import { mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { J2Config } from "./config.ts";

/** Run one git invocation to completion (injectable seam). */
export type GitRunner = (args: string[]) => Promise<void>;

export type RepoSync = { name: string; dir: string; action: "cloned" | "fetched" | "adopted" };

/** Git credentials for the in-cluster reconcile (ADR-0019): an HTTPS token read from ENV (never
 * argv — `ps` in any container must not see it) and/or the `j2-git-ssh` deploy key's mount path. */
export type GitCreds = {
  /** Name of the env var holding an HTTPS token (e.g. `J2_GIT_TOKEN`, from the instance Secret). */
  tokenEnv?: string;
  /** Path of the mounted deploy-key private key (the `j2-git-ssh` Secret). */
  sshKeyPath?: string;
};

/** The `-c` config flags that carry creds on NETWORK git calls (clone/fetch — never the pinning). */
function credArgs(creds?: GitCreds): string[] {
  const args: string[] = [];
  if (creds?.tokenEnv) {
    // An inline helper that echoes the env var at ask time: the token reaches git without ever
    // appearing in an argument list. x-access-token is the username GitHub/GitLab expect for PATs.
    args.push("-c", `credential.helper=!f() { echo username=x-access-token; echo "password=$${creds.tokenEnv}"; }; f`);
  }
  if (creds?.sshKeyPath) {
    args.push(
      "-c",
      `core.sshCommand=ssh -i ${creds.sshKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    );
  }
  return args;
}

/**
 * Ensure every catalog checkout exists at `<reposDir>/<name>/default`, is gc-pinned, and is
 * fresh: clone configured entries that are missing, fetch the rest (never mutate beyond fetch —
 * in-use `--shared` clones borrow these objects, and fetch only ADDS objects), and ADOPT any
 * checkout found on disk without a config entry — same pinning, same fetch, so `git clone` into
 * the layout by hand is a fully supported way to add a repo.
 */
export async function ensureRepos(
  config: J2Config,
  reposDir: string,
  git: GitRunner = defaultGit,
  creds?: GitCreds,
): Promise<RepoSync[]> {
  const net = credArgs(creds);
  const synced: RepoSync[] = [];
  const configured = new Set<string>();
  for (const repo of config.repos ?? []) {
    configured.add(repo.name);
    const dir = join(reposDir, repo.name, "default");
    if (await isRepo(dir)) {
      await pinGc(dir, git);
      await git([...net, "-C", dir, "fetch", "--all", "--prune"]);
      synced.push({ name: repo.name, dir, action: "fetched" });
    } else {
      await mkdir(dirname(dir), { recursive: true });
      await git([...net, "clone", repo.url, dir]);
      await pinGc(dir, git);
      if (repo.ref) await git(["-C", dir, "checkout", repo.ref]);
      synced.push({ name: repo.name, dir, action: "cloned" });
    }
  }
  for (const name of await subdirs(reposDir)) {
    if (configured.has(name)) continue;
    const dir = join(reposDir, name, "default");
    if (!(await isRepo(dir))) continue;
    await pinGc(dir, git);
    await git([...net, "-C", dir, "fetch", "--all", "--prune"]);
    synced.push({ name, dir, action: "adopted" });
  }
  return synced;
}

/** The three lines that make fetch-in-place safe for `--shared` borrowers (ADR-0004): no
 * auto-gc, no post-fetch auto-maintenance, and even an explicit `git gc` prunes nothing. */
async function pinGc(dir: string, git: GitRunner): Promise<void> {
  await git(["-C", dir, "config", "gc.auto", "0"]);
  await git(["-C", dir, "config", "gc.pruneExpire", "never"]);
  await git(["-C", dir, "config", "maintenance.auto", "false"]);
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no repos/ dir yet — an instance with no catalog at all
  }
}

const defaultGit: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
