// The attach (ADR-0063): the post-Ready step that puts a Workspace's Repos into `/work`
// (ADR-0004, ADR-0051), run HERE, in the Harness container, on `POST /attach`. It was a shell
// script the Orchestrator ran over `kubectl exec`. Per Repo Slot, in declaration order:
//
//   1. `mkdir <work>/<slot>` and stamp ADR-0005's default ACL on it (`work-acl`), BEFORE the clone
//      fills it: a default ACL is inherited at creation, never retrofitted.
//   2. `git clone --shared --no-checkout /repos/<key> <slot>/default` — pod-local, borrowing objects
//      from the node's read-only cache. Nothing is checked out yet.
//   3. origin's fetch url → the node cache program (ADR-0053), its push url → the real remote
//      (ADR-0005), `protocol.ext.allow user`, and `gc.auto=0` with `maintenance.auto=false`.
//   4. Git LFS (ADR-0053): git-lfs's filter and jr2's transfer agent in the clone's config, by
//      absolute path on the runtime volume, and git-lfs's four hooks where the clone has none.
//   5. Ask the node cache for the large files of the Binding's base (`jr2-lfs fetch`), and then
//      place `default/` on the base, one time. A Machine cuts every other Worktree with
//      `worktree()` (cut.ts).
//
// Every step is guarded or naturally idempotent, so a second attach (a restarted Orchestrator,
// ADR-0012) finds everything present and answers the same paths. As a child of the Harness it
// inherits the process's `umask 002` (startup.ts), which the exec'd script had to set itself.
// Each step runs its program directly, so a hostile ref or url is an argument, never syntax (the
// one shell, which writes a hook, gets the path and the text as arguments),
// and a failure names its slot, its step, and git's own stderr. Each step runs in the domain, with
// its env (`children.ts`, ADR-0076): a second attach runs git in a clone whose `.git/config` an
// Agent can write, and a filter or a hook there runs in git's process. The slot's folder is made in
// the domain too: the Harness process makes nothing under `/work`.

import { runIn, type ChildPolicy, type RunResult } from "./children.ts";
import { describeMissing, largeFilesMissing } from "./cut.ts";
import type { AttachRequest, AttachResponse, AttachSlot } from "./wire.ts";

/** Where the attach reads and writes, as the operator composes the pod (ADR-0004, ADR-0037,
 * ADR-0051): the work volume, the node caches' mount, and the runtime volume. `gitLfs` and `jr2Lfs`
 * are the two LFS programs (ADR-0053); each is under `<runtime>/bin` when it is not given. */
export type AttachPaths = { workRoot: string; reposMount: string; runtime: string; gitLfs?: string; jr2Lfs?: string };

/** The pod's paths. Seams for the tests only; the operator mounts exactly these. */
export const POD_PATHS: AttachPaths = { workRoot: "/work", reposMount: "/repos", runtime: "/opt/jr2" };

/** A step of the attach failed. `slot` names the Repo Slot it failed for, when it was one. */
export class AttachFault extends Error {
  readonly slot: string | undefined;
  constructor(message: string, slot?: string) {
    super(message);
    this.name = "AttachFault";
    this.slot = slot;
  }
}

/**
 * The attach, bound to its paths. Calls are serialized: two attaches racing on one clone would
 * each see it absent and the second `git clone` would fail on the first's directory. `children` is
 * how each step starts (ADR-0076); `env` is a seam for the tests (a sealed git config) over the
 * domain's env.
 */
export function attacher(opts: { children: ChildPolicy; paths?: AttachPaths; env?: NodeJS.ProcessEnv }) {
  const paths = opts.paths ?? POD_PATHS;
  const env: Env = { children: opts.children, env: { ...opts.children.env, ...opts.env } };
  let queue: Promise<unknown> = Promise.resolve();
  return (req: AttachRequest): Promise<AttachResponse> => {
    const run = queue.then(() => attach(req, paths, env));
    queue = run.catch(() => {});
    return run;
  };
}

async function attach(req: AttachRequest, paths: AttachPaths, env: Env): Promise<AttachResponse> {
  if (req.slots.length === 0) {
    throw new AttachFault(
      "the attach names no Repo Slot — nothing to attach (a Workspace with no Repo Slot skips the attach, ADR-0051)",
    );
  }
  const git = (step: string, slot: string | undefined, args: string[]) => runGit(step, slot, args, env);
  // The cache is written by the node's cache agent and read here as the Harness's unprivileged uid
  // (ADR-0001/0004/0051), so git's dubious-ownership guard would refuse the clone source.
  // safe.directory is only honored from global/system config (never `-c`), and inside the pod
  // every path is jr2-owned — trusting them all is the honest scope.
  await git("trust the pod's paths", undefined, ["config", "--global", "safe.directory", "*"]);

  const repos: Record<string, string> = {};
  const bases: Record<string, string> = {};
  for (const s of req.slots) {
    const slotDir = `${paths.workRoot}/${s.slot}`;
    const dflt = `${slotDir}/default`;
    const cache = `${paths.reposMount}/${s.key}`;
    repos[s.slot] = slotDir;

    // In the domain, as each other step (ADR-0076): `/work` is the domain's, and a link that Workspace
    // code put there names a folder that the Harness process can write and the domain cannot.
    await run("make the slot's folder", s.slot, "mkdir", ["-p", "--", slotDir], env);
    // On a filesystem without POSIX ACLs the helper warns and exits 0, degrading to the umask.
    await run("stamp the work ACL", s.slot, `${paths.runtime}/bin/work-acl`, [slotDir], env);
    if ((await exists(env, `${dflt}/.git`)) && !(await placedOrCheckedOut(dflt, env))) {
      await mendKilled(dflt, cache, s.slot, env);
    }
    if (!(await exists(env, `${dflt}/.git`))) {
      // `--no-checkout`: the base's large files come first (step 5), so that the checkout smudges each.
      await git("git clone --shared", s.slot, ["clone", "--shared", "--no-checkout", "--", cache, dflt]);
    }
    // Fetch/push split (ADR-0005). The FETCH url is a command, not a path (ADR-0053): git's
    // built-in `ext::` transport runs the program on the runtime volume, which asks the node cache
    // to fetch the remote, waits for the landing, then serves the cache — so every fetch inside the
    // pod is a fetch of the remote's now. The url's argument is the Repo's IDENTITY, never the
    // cache key: that is the name a human reads in `git remote -v`. `git push` goes to the REAL
    // remote — the Binding's own spelling (ADR-0051). `--` keeps the url an operand.
    // Each key is written only when its value is not already the one jr2 wants, so that a second
    // attach writes nothing: a kill in a write leaves `config.lock`, and an Agent's git works here.
    await removeStaleConfigLock(dflt, s.slot, env);
    if (!(await holds(dflt, "remote.origin.url", fetchUrl(s, paths), env))) {
      await git("set origin's fetch url", s.slot, [
        "-C",
        dflt,
        "remote",
        "set-url",
        "origin",
        "--",
        fetchUrl(s, paths),
      ]);
    }
    if (!(await holds(dflt, "remote.origin.pushurl", s.url, env))) {
      await git("set origin's push url", s.slot, ["-C", dflt, "remote", "set-url", "--push", "origin", "--", s.url]);
    }
    // `ext` is on git's "known scary" list, default `never`. `user` allows a fetch a person or the
    // Agent runs and still refuses one git makes for itself (a submodule url), so a repository
    // cannot smuggle a program in through a url jr2 did not write (ADR-0053). Repo-level: the
    // linked worktrees share this config.
    await setKey(dflt, s.slot, "allow the ext transport", "protocol.ext.allow", "user", env);
    // A fixed rule (ADR-0004): Agents share this clone, and a `gc` beside a cut or a commit prunes
    // what another Worktree needs. Every git in the pod reads the clone's config.
    await setKey(dflt, s.slot, "turn off gc", "gc.auto", "0", env);
    await setKey(dflt, s.slot, "turn off maintenance", "maintenance.auto", "false", env);
    for (const [key, value] of lfsConfig(paths)) await setKey(dflt, s.slot, `set ${key}`, key, value, env);
    await writeHooks(dflt, s.slot, paths, env);
    // A guard, so that a second attach changes nothing: an Agent's edit in `default/`, or a fetch that
    // moved the remote-tracking refs, is no reason for a checkout here (SandboxPort: idempotent).
    bases[s.slot] = await placeDefault(dflt, s, paths, env);
  }
  return { repos, bases };
}

/** The clone's config holds `value` as the one value of `key`. */
async function holds(dflt: string, key: string, value: string, env: Env): Promise<boolean> {
  const r = await exec("git", ["-C", dflt, "config", "--local", "--null", "--get-all", key], env);
  return r.code === 0 && r.stdout === `${value}\0`;
}

/**
 * Give `key` the one value `value`, when the clone does not hold it already. `--replace-all`: an Agent
 * can add a second value (`git config --add`), and a plain set then fails.
 */
async function setKey(dflt: string, slot: string, step: string, key: string, value: string, env: Env): Promise<void> {
  if (await holds(dflt, key, value, env)) return;
  await runGit(step, slot, ["-C", dflt, "config", "--replace-all", key, value], env);
}

/** A `config.lock` older than this is a kill's: git holds the lock for the time of one write. */
const STALE_LOCK_MS = 60_000;

/**
 * Remove a `config.lock` that a kill left in an earlier attach's write, so that no later write (the
 * attach's or an Agent's) fails on it. A lock that a live git holds is younger than `STALE_LOCK_MS`.
 */
async function removeStaleConfigLock(dflt: string, slot: string, env: Env): Promise<void> {
  const lock = `${dflt}/.git/config.lock`;
  const st = await env.children.spawner.stat(lock).catch(() => undefined);
  if (st === undefined || st.kind !== "file" || Date.now() - st.mtimeMs < STALE_LOCK_MS) return;
  await run("remove the config lock that a kill left", slot, "rm", ["-f", "--", lock], env);
}

/** The two LFS programs on the runtime volume (ADR-0053). */
export function lfsPrograms(paths: AttachPaths): { gitLfs: string; jr2Lfs: string } {
  return {
    gitLfs: paths.gitLfs ?? `${paths.runtime}/bin/git-lfs`,
    jr2Lfs: paths.jr2Lfs ?? `${paths.runtime}/bin/jr2-lfs`,
  };
}

/**
 * The clone's LFS config (ADR-0053): git-lfs's filter and jr2's transfer agent, each by absolute
 * path, because no seat has `/opt/jr2/bin` on PATH for certain (the User Container gets no PATH from
 * jr2). This is what `git lfs install` writes, in the clone's own config: nothing global or system.
 * The agent is standalone: git-lfs asks it, and no LFS server, for each object that neither store
 * holds. It serves downloads only (`direction`): the push of a large file is the push Effect's
 * (ADR-0067), and git-lfs does not start the agent for an upload.
 */
function lfsConfig(paths: AttachPaths): Array<[string, string]> {
  const { gitLfs, jr2Lfs } = lfsPrograms(paths);
  return [
    ["filter.lfs.process", `${gitLfs} filter-process`],
    ["filter.lfs.clean", `${gitLfs} clean -- %f`],
    ["filter.lfs.smudge", `${gitLfs} smudge -- %f`],
    ["filter.lfs.required", "true"],
    ["lfs.standalonetransferagent", "jr2"],
    ["lfs.customtransfer.jr2.path", jr2Lfs],
    ["lfs.customtransfer.jr2.args", "transfer"],
    ["lfs.customtransfer.jr2.concurrent", "true"],
    ["lfs.customtransfer.jr2.direction", "download"],
  ];
}

/** The hooks that git-lfs writes for itself, which call `git lfs` on PATH. */
const LFS_HOOKS = ["post-checkout", "post-commit", "post-merge", "pre-push"] as const;

/**
 * git-lfs's four hooks, each calling git-lfs by absolute path, written only where the clone has no
 * such hook. git-lfs writes its own hook where none exists, and that hook calls `git lfs` on PATH,
 * which fails in a seat with no git-lfs on PATH. git-lfs keeps a hook that exists, so a hook that a
 * user wrote stays. No `core.hooksPath` is set. Each file is written to a temp name and then moved,
 * so a kill leaves no half hook; a second attach finds the hook and writes nothing.
 */
async function writeHooks(dflt: string, slot: string, paths: AttachPaths, env: Env): Promise<void> {
  const { gitLfs } = lfsPrograms(paths);
  const hooks = `${dflt}/.git/hooks`;
  await run("make the hooks folder", slot, "mkdir", ["-p", "--", hooks], env);
  for (const hook of LFS_HOOKS) {
    const body = `#!/bin/sh\nexec ${shellQuote(gitLfs)} ${hook} "$@"\n`;
    await run(`write the ${hook} hook`, slot, "sh", ["-c", WRITE_IF_ABSENT, "sh", `${hooks}/${hook}`, body], env);
  }
}

/** `$1` gets the text `$2`, only when `$1` is not there (a link that names nothing counts as there). */
const WRITE_IF_ABSENT = `[ -e "$1" ] || [ -L "$1" ] || { printf '%s' "$2" > "$1.jr2-tmp" && chmod 755 "$1.jr2-tmp" && mv -f "$1.jr2-tmp" "$1"; }`;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Put `default/` on the Binding's base, one time. The answer is the base that each cut sends (a
 * branch name, a tag or a commit), held in the clone's config, because an Agent can move HEAD.
 *
 * No `ref`, or a `ref` that IS the default branch: the clone's own attached branch, and nothing else.
 * Another branch: that branch, attached and tracked. A tag or a commit: detached there. In the last
 * two, the local default branch goes: it holds no work, nothing holds it, and it would freeze at the
 * clone, so a cut of it finds `origin/<default>` and tracks it.
 *
 * The clone has no checkout yet. The base's large files come first, then a forced checkout, so a kill
 * at any step before the checkout leaves a clone that the next attach mends (`mendKilled`) and places
 * again. A kill after the checkout leaves an index, and the next attach only records the base. No
 * hook runs in this checkout: git-lfs's hooks are for the people and Agents that work in the clone.
 */
async function placeDefault(dflt: string, s: AttachSlot, paths: AttachPaths, env: Env): Promise<string> {
  const placed = await placedBase(dflt, env);
  if (placed !== undefined) return placed;
  const git = (step: string, args: string[]) => runGit(step, s.slot, ["-C", dflt, ...args], env);
  const checkout = (args: string[]) =>
    git("check out the base", ["-c", "core.hooksPath=/dev/null", "checkout", ...args]);
  const head = await exec("git", ["-C", dflt, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], env);
  const dfltBranch = head.stdout.trim().replace(/^origin\//, "");
  const base = s.ref ?? dfltBranch;
  const tracked =
    base !== dfltBranch &&
    (await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], env)).code === 0;
  const commit = base === dfltBranch ? "HEAD" : tracked ? `refs/remotes/origin/${base}` : await baseOf(dflt, base, env);
  // An empty Repo: no base commit, so nothing to check out (as before the LFS ask).
  const empty =
    base === dfltBranch &&
    (await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", "HEAD^{commit}"], env)).code !== 0;
  if (empty) {
    await git("record the base", ["config", "--local", "jr2.base", base]);
    return base;
  }
  if (await exists(env, `${dflt}/.git/index`)) {
    // The checkout ran (git writes the index last), and `jr2.base` is not there: a kill after the
    // checkout, or someone removed the key. People and Agents can work here, so nothing is forced. The
    // frozen default branch goes only when it holds no work of its own (`-d`, not `-D`).
    if (base !== dfltBranch && dfltBranch !== "") {
      await exec("git", ["-C", dflt, "branch", "-d", "--", dfltBranch], env);
    }
    await git("record the base", ["config", "--local", "jr2.base", base]);
    return base;
  }
  await askLargeFiles(dflt, s, base, commit, paths, env);
  if (base === dfltBranch) await checkout(["-f"]);
  else if (tracked) await checkout(["-f", "-B", base, "--track", `origin/${base}`]);
  else await checkout(["-f", "--detach", commit]);
  if (base !== dfltBranch && dfltBranch !== "") {
    const frozen = await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", `refs/heads/${dfltBranch}`], env);
    if (frozen.code === 0) await git("drop the frozen default branch", ["branch", "-D", "--", dfltBranch]);
  }
  await git("record the base", ["config", "--local", "jr2.base", base]);
  return base;
}

/**
 * The base that `default/` was placed on, or undefined when it was not placed yet. A key that is
 * there is a placement, also with the value "": an empty Repo's base, which has no commit yet.
 */
async function placedBase(dflt: string, env: Env): Promise<string | undefined> {
  const placed = await exec("git", ["-C", dflt, "config", "--local", "jr2.base"], env);
  return placed.code === 0 ? placed.stdout.trim() : undefined;
}

/**
 * `default/` was placed, or its checkout ran. Only a clone with neither is one that a kill left in
 * the first attach, before any person or Agent worked in it, and only that clone is mended. The
 * marker is in config that an Agent can write, so the index is a second sign: a clone with no
 * checkout has no index.
 */
async function placedOrCheckedOut(dflt: string, env: Env): Promise<boolean> {
  return (await placedBase(dflt, env)) !== undefined || (await exists(env, `${dflt}/.git/index`));
}

/**
 * Mend a clone that a kill left before `default/` was placed or checked out. Attaches are serialized,
 * and no Agent works in `default/` before its checkout, so no git of anyone else is alive in it.
 *
 * A clone that a kill cut short has no `origin/HEAD` or no HEAD commit while the cache has a HEAD
 * commit: it goes, and the attach clones again. Another clone keeps its objects and its refs, and
 * only the locks that a killed git left go, because each later step would fail on a lock.
 */
async function mendKilled(dflt: string, cache: string, slot: string, env: Env): Promise<void> {
  const resolves = async (where: string[], rev: string) =>
    (await exec("git", [...where, "rev-parse", "--verify", "-q", rev], env)).code === 0;
  // The cache is a bare repository, which the domain's git finds only by `--git-dir` (ADR-0080).
  const cacheHead = await resolves(["--git-dir", cache], "HEAD^{commit}");
  const originHead =
    (await exec("git", ["-C", dflt, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], env)).code === 0;
  if (cacheHead && (!originHead || !(await resolves(["-C", dflt], "HEAD^{commit}")))) {
    await run("remove a clone that a kill cut short", slot, "rm", ["-rf", "--", dflt], env);
    return;
  }
  const git = `${dflt}/.git`;
  await run(
    "remove the locks that a kill left",
    slot,
    "rm",
    ["-f", "--", ...KILLED_LOCKS.map((l) => `${git}/${l}`)],
    env,
  );
  await run(
    "remove the ref locks that a kill left",
    slot,
    "find",
    [`${git}/refs`, "-name", "*.lock", "-type", "f", "-delete"],
    env,
  );
}

/** The locks that a git killed in the attach's steps can leave in the clone's git folder. */
const KILLED_LOCKS = ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock"];

/**
 * Ask the node cache for the Git LFS objects of the base's commit (ADR-0053), before the checkout
 * smudges them: `jr2-lfs fetch` asks for each object that no store holds, waits for the landing, and
 * names each file whose object is still missing. A commit with no LFS file makes no ask. A commit
 * that does not resolve makes no ask either: the checkout then fails in git's own words.
 */
async function askLargeFiles(
  dflt: string,
  s: AttachSlot,
  base: string,
  commit: string,
  paths: AttachPaths,
  env: Env,
): Promise<void> {
  const sha = await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", `${commit}^{commit}`], env);
  if (sha.code !== 0) return;
  const step = "get the base's large files";
  const { jr2Lfs } = lfsPrograms(paths);
  const r = await exec(jr2Lfs, ["fetch", "--identity", s.identity, "--", sha.stdout.trim()], env, dflt);
  if (r.code !== 0) {
    const said = r.stderr.trim() || r.stdout.trim() || r.error?.message || `exited ${r.code}`;
    throw new AttachFault(`the attach of slot "${s.slot}" failed at ${step}: ${said}`, s.slot);
  }
  const missing = largeFilesMissing(r.stdout);
  if (missing === undefined) {
    throw new AttachFault(
      `the attach of slot "${s.slot}" failed at ${step}: jr2-lfs printed no result: ${r.stdout.trim().slice(0, 400)}`,
      s.slot,
    );
  }
  if (missing.length > 0) {
    throw new AttachFault(
      `the attach of slot "${s.slot}" failed at ${step}: ${describeMissing(missing, base)}`,
      s.slot,
    );
  }
}

/**
 * Why a body is not an `AttachRequest`, or undefined when it is. The slot and the key become
 * directory names under `/work` and `/repos`, so neither may be a path out of them. A slot cannot
 * start with `.`, so that it cannot reach `/work/.jr2/`.
 */
export function attachFault(body: unknown): string | undefined {
  const b = body as Partial<AttachRequest> | undefined;
  if (b === null || typeof b !== "object") return "the attach body must be an AttachRequest { slots } (ADR-0063)";
  if (!Array.isArray(b.slots) || b.slots.length === 0) {
    return "the attach names no Repo Slot — nothing to attach (a Workspace with no Repo Slot skips the attach, ADR-0051)";
  }
  const seen = new Set<string>();
  for (const s of b.slots as Array<Partial<Record<keyof AttachSlot, unknown>>>) {
    if (s === null || typeof s !== "object") return "each attach slot must be { slot, url, identity, key, ref? }";
    if (!isName(s.slot)) return `attach slot ${JSON.stringify(s.slot)}: the slot must be a plain directory name`;
    if (s.slot.startsWith(".")) {
      return `attach slot "${s.slot}": a Repo Slot name cannot start with ".", because /work/.jr2/ is reserved for jr2 (ADR-0075)`;
    }
    if (seen.has(s.slot)) return `attach slot "${s.slot}" is named twice`;
    seen.add(s.slot);
    for (const field of ["url", "identity"] as const) {
      if (typeof s[field] !== "string" || s[field] === "") return `attach slot "${s.slot}" has no ${field}`;
    }
    if (!isName(s.key)) return `attach slot "${s.slot}": the key must be a plain directory name`;
    if (s.ref !== undefined && (typeof s.ref !== "string" || s.ref === "")) {
      return `attach slot "${s.slot}": ref must be a non-empty string`;
    }
  }
  return undefined;
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v !== "" && v !== "." && v !== ".." && !v.includes("/");
}

/**
 * `origin`'s fetch url for one Repo (ADR-0053): the `ext::` transport, the program's absolute path
 * on the runtime volume, the service git asks for (`%S`), and the Repo's identity in git's own
 * escaping — git splits the url on spaces and reads `%` as a placeholder introducer, so a
 * percent-encoded forge path or a literal space is spelled `%%` / `% `, and the program receives
 * the identity back exactly as written.
 */
function fetchUrl(s: AttachSlot, paths: AttachPaths): string {
  const arg = s.identity.replace(/%/g, "%%").replace(/ /g, "% ");
  return `ext::${paths.runtime}/bin/jr2-upload-pack %S ${arg}`;
}

/**
 * The commit-ish a Binding's `ref` names inside the pod-local clone: the remote-tracking branch
 * `refs/remotes/origin/<ref>` when the clone has one, else `<ref>` as written (a tag, a sha). A
 * fresh clone holds ONE local branch, so git's "worktree add" DWIM on a bare branch name would
 * create the BASE branch and discard `-b` — the Agent would commit on the base it was meant to
 * branch FROM. Naming the remote-tracking ref outright leaves nothing to guess.
 */
async function baseOf(dflt: string, ref: string, env: Env): Promise<string> {
  const remote = `refs/remotes/origin/${ref}`;
  const r = await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", remote], env);
  return r.code === 0 ? remote : ref;
}

/** A path is present — the old script's `[ -d … ] ||` guards. Asked in the domain, as git sees it. */
async function exists(env: Env, path: string): Promise<boolean> {
  return env.children.spawner.stat(path).then(
    () => true,
    () => false,
  );
}

async function runGit(step: string, slot: string | undefined, args: string[], env: Env) {
  return run(step, slot, "git", args, env);
}

async function run(step: string, slot: string | undefined, file: string, args: string[], env: Env) {
  const r = await exec(file, args, env);
  if (r.code === 0) return;
  const said = r.stderr.trim() || r.stdout.trim() || r.error?.message || `exited ${r.code}`;
  const where = slot === undefined ? "the attach" : `the attach of slot "${slot}"`;
  throw new AttachFault(`${where} failed at ${step}: ${said}`, slot);
}

type ExecResult = RunResult;

/** How a step starts: the domain, and the env the step runs with. */
type Env = { children: ChildPolicy; env: NodeJS.ProcessEnv };

function exec(file: string, args: string[], env: Env, cwd = "/"): Promise<ExecResult> {
  // From `/`: each step names its paths, and the Harness's own folder is no repository of the step's.
  // jr2-lfs is the exception: it reads the clone that it runs in.
  return runIn(env.children, [file, ...args], { cwd, env: env.env, maxBuffer: 8 * 1024 * 1024 });
}
