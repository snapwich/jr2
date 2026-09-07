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
// A repo that will not sync degrades that repo, never the boot (ADR-0048): a pass reports PER REPO
// — one unreachable url leaves every other checkout synced — and the failed ones are retried by a
// supervisor loop that outlives the boot, with git's own error carried out to the announce feed,
// `j2 status`, and any provision that needs the checkout. The single-writer/config-pinning
// invariants (ADR-0004) are untouched by that: the loop is the SAME one writer, running its passes
// strictly one at a time, and every pass still pins gc before it fetches.
//
// The git runner is injectable so the reconcile logic is unit-testable without spawning git;
// the kind e2e tier runs the real one.

import { mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { InstanceConfig } from "./config.ts";

/** Run one git invocation to completion (injectable seam). */
export type GitRunner = (args: string[]) => Promise<void>;

/** How a checkout reached its synced state — j2 cloned it, fetched it, or found it already there. */
export type RepoAction = "cloned" | "fetched" | "adopted";

/**
 * What ONE reconcile pass did with one repo. A failure carries git's own message and nothing
 * else: the reason a clone fails is the reason git printed (an unregistered deploy key, a wrong
 * url, a host outage), and j2 has nothing truer to say about it.
 */
export type RepoSync =
  | { name: string; dir: string; action: RepoAction; error?: never }
  | { name: string; dir: string; action?: never; error: string };

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
 *
 * One repo's failure is one repo's result (ADR-0048), never the pass's: the caller gets a row per
 * repo and decides what to do about the failed ones. `only` narrows the pass to the repos it names
 * — what the retry loop reconciles with, so a repo that already synced this boot is not re-fetched
 * (and not re-announced) every time an unrelated one is retried.
 */
export async function ensureRepos(
  config: InstanceConfig,
  reposDir: string,
  git: GitRunner = defaultGit,
  creds?: GitCreds,
  only?: ReadonlySet<string>,
): Promise<RepoSync[]> {
  const net = credArgs(creds);
  const synced: RepoSync[] = [];
  const configured = new Set<string>();
  const wanted = (name: string) => only === undefined || only.has(name);
  for (const repo of config.repos ?? []) {
    configured.add(repo.name);
    if (!wanted(repo.name)) continue;
    const dir = join(reposDir, repo.name, "default");
    try {
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
    } catch (err) {
      synced.push({ name: repo.name, dir, error: messageOf(err) });
    }
  }
  for (const name of await subdirs(reposDir)) {
    if (configured.has(name) || !wanted(name)) continue;
    const dir = join(reposDir, name, "default");
    if (!(await isRepo(dir))) continue;
    try {
      await pinGc(dir, git);
      await git([...net, "-C", dir, "fetch", "--all", "--prune"]);
      synced.push({ name, dir, action: "adopted" });
    } catch (err) {
      synced.push({ name, dir, error: messageOf(err) });
    }
  }
  return synced;
}

/** The reconcile's retry floor and ceiling. A failed sync is usually waiting on a HUMAN act with
 * no deadline (register the deploy key — ADR-0047), so the loop backs off to a slow poll and stays
 * there for as long as the process lives; it never gives up, because giving up would mean the
 * registration that finally happens never lands. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** What the reconcile knows about one repo right now — the row `j2 status` prints and the fact a
 * provision consults (ADR-0048). `synced` is about the LAST attempt: a repo that cloned at boot
 * and failed its next fetch reads as not synced, because that is what the announce feed said. */
export type RepoState = {
  name: string;
  synced: boolean;
  /** How the last successful sync happened. Absent until one succeeds. */
  action?: RepoAction;
  /** git's own error from the last failed attempt. Present exactly while `synced` is false. */
  error?: string;
  /** Consecutive failed attempts so far — what makes a slow backoff legible rather than a hang. */
  attempts?: number;
};

/** The supervised reconcile the entrypoint starts and never awaits (ADR-0048). */
export type RepoReconcile = {
  /** Every repo this boot has tried, by name — the status surface's payload. */
  state(): RepoState[];
  /** The last sync error for one repo, or undefined when its last attempt succeeded (or the name
   * is outside this instance's catalog, which is a different failure and not this one's to name). */
  errorFor(name: string): string | undefined;
  /** Resolves when the FIRST pass has finished, whatever it found. The boot does not await it —
   * tests and fixtures do, to observe a settled first pass rather than poll. */
  first: Promise<void>;
  /** Stop retrying. Idempotent; a pass already in flight finishes on its own. */
  stop(): void;
};

export type RepoReconcileOptions = {
  config: InstanceConfig;
  reposDir: string;
  git?: GitRunner;
  creds?: GitCreds;
  /** Called once per repo per pass, successes and failures alike — the announce feed's source
   * (ADR-0048: every failure is announced with git's own error). */
  onSync?: (result: RepoSync) => void;
  /** Retry backoff bounds. Defaults: 5s doubling to a 5m ceiling. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** The delay seam, so a test drives the retry loop without waiting real seconds. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * Start the source-volume reconcile and supervise it (ADR-0048). The first pass runs immediately;
 * repos that failed are retried with a doubling, capped backoff until they sync, and each attempt
 * — success or failure — is reported through `onSync`.
 *
 * The loop is the reconcile's ONE writer (ADR-0004): passes never overlap, so `git fetch` in a
 * `default/` is as serialized as it was when the boot awaited a single pass, and every pass pins
 * gc before it fetches. Nothing here re-reads the config: the catalog is what the process booted
 * with, and a changed catalog arrives the way every other config change does — a new converge.
 */
export function startRepoReconcile(opts: RepoReconcileOptions): RepoReconcile {
  const minDelayMs = opts.minDelayMs ?? RETRY_MIN_MS;
  const maxDelayMs = opts.maxDelayMs ?? RETRY_MAX_MS;
  const wait = opts.wait ?? sleep;
  const states = new Map<string, RepoState>();
  let stopped = false;
  let announceFirst!: () => void;
  const first = new Promise<void>((resolve) => (announceFirst = resolve));

  /** One pass, folded into the state map. Returns the repos still to retry. */
  const pass = async (only?: ReadonlySet<string>): Promise<Set<string>> => {
    const results = await ensureRepos(opts.config, opts.reposDir, opts.git, opts.creds, only);
    const failed = new Set<string>();
    for (const result of results) {
      if (result.error === undefined) {
        states.set(result.name, { name: result.name, synced: true, action: result.action });
      } else {
        failed.add(result.name);
        states.set(result.name, {
          name: result.name,
          synced: false,
          error: result.error,
          attempts: (states.get(result.name)?.attempts ?? 0) + 1,
        });
      }
      opts.onSync?.(result);
    }
    return failed;
  };

  void (async () => {
    let retry = await pass();
    announceFirst();
    let delay = minDelayMs;
    while (!stopped && retry.size > 0) {
      await wait(delay);
      if (stopped) return;
      retry = await pass(retry);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  })().catch((err) => {
    // The pass itself reports per repo, so reaching here means the reconcile's own machinery
    // failed (an unreadable repos dir). Say so and stop retrying — but never take the process
    // down: the whole point of ADR-0048 is that repos degrade and the daemon serves.
    announceFirst();
    console.error(`repo reconcile stopped: ${messageOf(err)}`);
  });

  return {
    state: () => [...states.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errorFor: (name) => states.get(name)?.error,
    first,
    stop: () => void (stopped = true),
  };
}

/** A timer that never holds the process open — a retry is not a reason to keep a pod alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
