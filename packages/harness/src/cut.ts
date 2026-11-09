// The cut: one `worktree()` Effect, in the Harness container, as a child
// of the Harness on the `command` machinery (ADR-0067). This process runs once per Effect and prints
// one JSON line. Each thing an Agent's word can cause is a `refused` answer.
//
// The rules:
//
//   - A cut never removes a folder that a positive in-progress record in the clone does not name. A
//     folder with no record is an Agent's own: a cut reads it, or refuses it.
//   - A record is written BEFORE git changes anything, and it names what the cut made: a branch, an
//     upstream, a folder. `refused` runs that record backward, so `refused` changes nothing. A kill
//     leaves the record, and the next cut in the clone runs it backward (the `locked` file also).
//   - A done record is the Worktree's own: its branch, its `from`, the kind of cut. A re-cut that
//     disagrees with it is `refused`. A detached cut forces from it, whatever HEAD an Agent left.
//   - `head` is the tip of the recorded branch, never HEAD.
//   - `found: "held"` means that a cut made this Worktree earlier. A re-send of one Effect (a restart)
//     answers the first answer's `found`, so a cut that a restart sent twice never reads as resumed work.
//   - The Orchestrator sends the base on each cut: an Agent's checkout in `default/` cannot move it. A
//     name resolves by refs/remotes/origin first (the local `main` is frozen at the clone), then a tag.
//   - No hook runs: a cleared environment and sync.ts's config. No commit-graph and no
//     multi-pack-index is read: an Agent can forge either in the clone, and git 2.56 then checks out
//     another tree for a commit. The files of a Worktree come through a git folder of the cut's own
//     (`fill`), which takes only the clone's objects: no config, no index and no ignore or
//     attributes rule of the clone, of a config file or of the cut's HOME changes what is checked
//     out. A re-cut first removes each `.gitattributes` file that the last commit it wrote does not
//     have, so that only the commit's own attributes apply. It keeps each `.gitignore` and each file
//     that one ignores (ADR-0075).
//   - The one filter that a cut's checkout runs is jr2's own LFS filter, set by `-c` by the absolute
//     paths of the runtime volume, with jr2's transfer agent: no config of the Agent's chooses the
//     program (ADR-0053). It reads the large files from the clone's LFS store and the node cache's.
//     The agent asks for nothing there (`transfer --no-ask`): a file that no store holds at the
//     checkout makes the cut `refused`, naming the file.
//   - A cut gets its commit's large files first (ADR-0075). After the fetch and before git changes
//     anything, `jr2-lfs fetch <commit>` asks the node cache for each LFS object that no store holds.
//     A file whose object the cache cannot get makes the cut `refused`, naming the file. A remote that
//     is down with every object held is `ready` with `stale`. No submodule is fetched or checked out.
//   - The lock is a flock on a descriptor no child inherits, so nothing that outlives this process
//     can hold it. Node has no flock: a small program takes it on our descriptor, then exits.
//   - The fetch lock (jr2-upload-pack, ADR-0075) is a second lock with one rule: a fetch waits only
//     for a fetch. A cut's fetch can wait in that line under this lock, and no holder of that lock
//     waits for a cut, so the two cannot deadlock.
//   - `stale` reads ADR-0053's warning, never the exit code. A lock race with an Agent's fetch is
//     retried, because the remote is fine then. A warned fetch asks once more, and after that the
//     next cuts in the window skip the ask, so that N cuts on a dead remote do not each wait under the lock. A
//     name that is not known with a stale fetch is `refused`: it is never `none`.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The input of one cut. `id` is the Effect's id. `base` is where a new branch starts with no `from`:
 * the Binding's own ref, which no run can name, so the branch rule does not hold it. `timeoutMs` is the
 * Effect's timeout, which the Harness counts from the start of this process: the ask for the large
 * files gets the part of it that is left (`CUT_LFS_MARGIN_MS`). */
export type CutRequest = {
  id: string;
  path: string;
  branch?: string;
  from?: string;
  detach?: string;
  expect?: "new" | "existing";
  base?: string;
  timeoutMs?: number;
};

/** What a cut found at the path or under the name. */
export type CutFound = "held" | "local" | "remote" | "none" | "commit";

export type CutAnswer =
  | {
      outcome: "ready";
      slot: string;
      path: string;
      branch: string | null;
      head: string;
      found: CutFound;
      stale?: string;
    }
  | { outcome: "refused"; reason: string };

/** The seams of the tests. `lock`: the program that takes a flock on its stdin. `gitLfs` and
 * `jr2Lfs`: the two LFS programs (ADR-0053). `env`: added to the cleared environment.
 * `staleWindowMs`: how long a warned fetch answers for the next cuts. `tmp`: where the cut makes its
 * own folder; the default is TMPDIR. */
export type CutPaths = {
  workRoot: string;
  lock: readonly string[];
  gitLfs: string;
  jr2Lfs: string;
  env?: NodeJS.ProcessEnv;
  staleWindowMs?: number;
  tmp?: string;
};

export const POD_CUT_PATHS: CutPaths = {
  workRoot: "/work",
  lock: ["/opt/jr2/bin/cut-lock"],
  gitLfs: "/opt/jr2/bin/git-lfs",
  jr2Lfs: "/opt/jr2/bin/jr2-lfs",
};

// --- The shared rules ------------------------------------------------------------------------------

/**
 * A branch name jr2 cuts and pushes. The Effector's `ValidBranch` (wire.go), so that a name the push
 * cannot publish is refused before any work, and stricter: no `HEAD`, no `refs/`, no `origin/` (a
 * local branch of that name makes every `origin/x` ambiguous), no part that starts with `.` or `-`,
 * no part that ends in `.lock`, no `//`, and no name that reads as a commit. One pattern, because the
 * Orchestrator's `branchName` schema is the same pattern, and a pick's JSON schema carries it.
 */
export const BRANCH_NAME =
  /^(?!\/)(?!HEAD$)(?!refs\/)(?!origin\/)(?![0-9a-f]{7,40}$)(?!.*\.\.)(?!.*\/\/)(?!(?:.*\/)?[.-])(?!.*\.lock(?:\/|$))(?!.*[./]$)[A-Za-z0-9._/-]+$/;

/** A commit-ish a cut takes in `from` and `detach`: a commit id, or a name by the same rule. */
const SHA = /^[0-9a-f]{7,40}$/;

/** The path rule: exactly `<root>/<slot>/<name>`, one segment, not `default`, no leading `.` or `-`. */
export function pathFault(path: unknown, workRoot: string): string | undefined {
  if (typeof path !== "string") return "the path is not a string";
  const rest = path.startsWith(`${workRoot}/`) ? path.slice(workRoot.length + 1) : undefined;
  const parts = rest?.split("/");
  if (parts?.length !== 2 || parts[0] === "" || parts[1] === "") {
    return `"${path}" is not a Worktree path: ${workRoot}/<slot>/<name>, with one segment in <name>`;
  }
  const name = parts[1]!;
  if (name === "default") return `"${path}" is the clone: it stays as the attach left it; cut a sibling`;
  if (name.startsWith(".") || name.startsWith("-")) return `"${path}": a Worktree's name starts with neither . nor -`;
  if (parts[0] === "." || parts[0] === "..") return `"${path}" is not a Worktree path`;
  return undefined;
}

// --- git, with nothing of the Agent's in the way ------------------------------------------------------

/** sync.ts's CLEAN, and `safe.directory`, because the cleared environment reads no global config.
 * And no ignore or attributes file of a HOME: git reads `$HOME/.config/git/ignore` and `attributes`
 * (or the same files under `XDG_CONFIG_HOME`) when no config names another file, also with
 * `GIT_CONFIG_GLOBAL=/dev/null`. The cut's HOME is a folder in TMPDIR, which the Agents write. */
const CLEAN = [
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "core.alternateRefsCommand=true",
  "-c",
  "safe.directory=*",
  "-c",
  "core.filesRefLockTimeout=2000",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "checkout.guess=false",
];

/**
 * The LFS server url of `fill`'s git-lfs. No server is asked (the transfer agent is standalone), but
 * git-lfs reads `lfs.<url>.standalonetransferagent` before `lfs.standalonetransferagent`. With this
 * url and its own key pinned, no `lfs.<url>.*` key (of a `.lfsconfig` in the commit) chooses the agent.
 */
const PINNED_LFS_URL = "https://jr2-cut.invalid/lfs";

/** jr2's own LFS filter and transfer agent, by `-c` on `fill`'s git, so that the program that a
 * checkout starts is jr2's (ADR-0053). The keys are the attach's (attach.ts), but the agent is
 * `transfer --no-ask`: the cut asked for its commit's large files before (`askLargeFiles`), and
 * git-lfs reads them from the stores, so the agent refuses each object that it is asked for, and
 * the cut's refusal names the file (`smudgeFault`). `lfs.storage` is the clone's LFS store, where
 * git-lfs keeps what it gets: `fill`'s git folder is the cut's, and goes. */
function lfsPins(paths: CutPaths, clone: string): string[] {
  return [
    ["lfs.url", PINNED_LFS_URL],
    [`lfs.${PINNED_LFS_URL}.standalonetransferagent`, "jr2"],
    ["filter.lfs.process", `${paths.gitLfs} filter-process`],
    ["filter.lfs.clean", `${paths.gitLfs} clean -- %f`],
    ["filter.lfs.smudge", `${paths.gitLfs} smudge -- %f`],
    ["filter.lfs.required", "true"],
    ["lfs.standalonetransferagent", "jr2"],
    ["lfs.customtransfer.jr2.path", paths.jr2Lfs],
    ["lfs.customtransfer.jr2.args", "transfer --no-ask"],
    ["lfs.customtransfer.jr2.concurrent", "true"],
    ["lfs.customtransfer.jr2.direction", "download"],
    ["lfs.storage", `${clone}/.git/lfs`],
  ].flatMap(([k, v]) => ["-c", `${k}=${v}`]);
}

type Git = { code: number; out: string; err: string };
type Runner = (cwd: string, args: readonly string[], maxBuffer?: number) => Promise<Git>;

/** The cleared environment of each program that the cut starts. */
function cutEnv(paths: CutPaths, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.JR2_CUSTODIAN_URL ? { JR2_CUSTODIAN_URL: process.env.JR2_CUSTODIAN_URL } : {}),
    ...paths.env,
  };
}

/** git with the cleared environment, and `extra` added to it and `pins` after CLEAN (`fill`'s own
 * git folder and jr2's LFS filter). */
function runner(paths: CutPaths, home: string, extra: NodeJS.ProcessEnv = {}, pins: readonly string[] = []): Runner {
  const env: NodeJS.ProcessEnv = { ...cutEnv(paths, home), ...extra };
  return (cwd, args, maxBuffer = 16 << 20) =>
    new Promise((resolve) => {
      execFile("git", ["-C", cwd, ...CLEAN, ...pins, ...args], { env, maxBuffer }, (error, stdout, stderr) => {
        const code = error == null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, out: stdout.trim(), err: stderr.trim() });
      });
    });
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What another git process holds for a moment: an Agent's fetch or `git config` beside the cut. */
const LOCK_RACE =
  /cannot lock ref|could not lock config file|Unable to create .*\.lock|Another git process|File exists/;

/** Retry what a lock race fails, a bounded number of times. */
async function steady(run: () => Promise<Git>, tries = 8): Promise<Git> {
  for (let n = 1; ; n++) {
    const r = await run();
    if (r.code === 0 || n === tries || !LOCK_RACE.test(r.err)) return r;
    await sleep(25 * n + Math.random() * 50);
  }
}

// --- The lock --------------------------------------------------------------------------------------

/** The flock of one clone. The descriptor is this process's alone (O_CLOEXEC): the helper gets it as
 * stdin, takes the lock on the open file, and exits. The lock stays with the open file, and git, run
 * after, inherits nothing. It frees when this process ends, however it ends. */
async function locked<T>(clone: string, paths: CutPaths, work: () => Promise<T>): Promise<T> {
  const fd = openSync(`${clone}/.git/jr2-cut.lock`, "a");
  try {
    await new Promise<void>((resolve, reject) => {
      const [program, ...args] = paths.lock;
      const child = spawn(program!, args, { stdio: [fd, "ignore", "inherit"] });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the cut's lock program exited ${code}`))));
    });
    return await work();
  } finally {
    closeSync(fd);
  }
}

// --- The record --------------------------------------------------------------------------------------

/** A cut's positive record, in the clone. `cutting` is written before git changes anything; `made`
 * names what this cut made, and only that is ever undone. */
type CutRecord = {
  state: "cutting" | "done";
  id: string;
  path: string;
  branch?: string;
  detach?: string;
  from?: string;
  found: CutFound;
  /** The commit a branch that this cut made started at. */
  start?: string;
  /** The commit that the last fill of a detached Worktree wrote: the next re-cut starts its index
   * there, never at a HEAD that an Agent set. */
  sha?: string;
  /** A done record whose folder a cut is adding again (`addAgain`): a kill can leave a folder with
   * no index or no files. The next cut removes that folder, which the record names, and adds it
   * again. */
  adding?: boolean;
  made: { folder?: boolean; branch?: boolean; upstream?: boolean };
};

type Clone = {
  clone: string;
  records: string;
  git: Runner;
  paths: CutPaths;
  home: string;
  /** Ask for the large files of a commit: the words of a refusal, or undefined when each is held. */
  largeFiles: (commit: string) => Promise<string | undefined>;
};

const recordFile = (c: Clone, path: string): string => join(c.records, `${path.split("/").pop()!}.json`);

async function writeRecord(c: Clone, record: CutRecord): Promise<void> {
  await mkdir(c.records, { recursive: true });
  const file = recordFile(c, record.path);
  await writeFile(`${file}.tmp`, JSON.stringify(record));
  await rename(`${file}.tmp`, file);
}

const readRecord = async (c: Clone, path: string): Promise<CutRecord | undefined> => {
  const text = await readFile(recordFile(c, path), "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as CutRecord);
};

/** The admin folder of the Worktree at `path`, found by what it points at: a kill can leave it with
 * no folder, with `locked` in it, and then git neither prunes it nor adds over it. */
async function adminOf(c: Clone, path: string): Promise<string | undefined> {
  const root = `${c.clone}/.git/worktrees`;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const gitdir = await readFile(`${root}/${name}/gitdir`, "utf8").catch(() => "");
    if (gitdir.trim() === `${path}/.git`) return `${root}/${name}`;
  }
  return undefined;
}

/** Run a record backward: what this cut made, and nothing else. */
async function undo(c: Clone, rec: CutRecord): Promise<void> {
  if (rec.made.folder) {
    const admin = await adminOf(c, rec.path);
    if (admin) await rm(admin, { recursive: true, force: true });
    await rm(rec.path, { recursive: true, force: true });
  }
  await c.git(c.clone, ["worktree", "prune"]);
  if (rec.branch !== undefined && rec.made.upstream) {
    await steady(() => c.git(c.clone, ["config", "--remove-section", `branch.${rec.branch}`]));
  }
  if (rec.branch !== undefined && rec.made.branch) {
    const ref = `refs/heads/${rec.branch}`;
    const tip = await c.git(c.clone, ["rev-parse", "-q", "--verify", ref]);
    if (tip.code === 0 && tip.out === rec.start) await steady(() => c.git(c.clone, ["update-ref", "-d", ref, tip.out]));
  }
  await rm(recordFile(c, rec.path), { force: true });
}

/** A cut that a kill stopped: under the lock, no cut lives, so a `cutting` record is a dead one. */
async function recover(c: Clone): Promise<void> {
  for (const file of await readdir(c.records).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const rec = JSON.parse(await readFile(join(c.records, file), "utf8").catch(() => "{}")) as Partial<CutRecord>;
    if (rec.state === "cutting") await undo(c, rec as CutRecord);
  }
}

// --- What git holds ------------------------------------------------------------------------------------

type Listed = { path: string; branch?: string };

async function worktrees(c: Clone): Promise<Listed[]> {
  const r = await c.git(c.clone, ["worktree", "list", "--porcelain"]);
  const out: Listed[] = [];
  for (const block of r.out.split("\n\n")) {
    const path = block.match(/^worktree (.*)$/m)?.[1];
    if (path === undefined) continue;
    const branch = block.match(/^branch refs\/heads\/(.*)$/m)?.[1];
    out.push({ path, ...(branch !== undefined ? { branch } : {}) });
  }
  return out;
}

const refOf = async (c: Clone, ref: string): Promise<string | undefined> => {
  const r = await c.git(c.clone, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  return r.code === 0 ? r.out : undefined;
};

/** A commit-ish: a commit id, a full ref (only a Binding's base can be one), or a name by
 * refs/remotes/origin (the local default branch is frozen at the clone), a tag, then a local branch.
 * A branch that a Worktree beside `default/` holds is work in this Sandbox, so its tip comes first:
 * `origin/<name>` is only its last push. */
async function commitOf(c: Clone, name: string): Promise<string | undefined> {
  if (SHA.test(name) || name.startsWith("refs/")) return refOf(c, name);
  const worked = (await worktrees(c)).some((w) => w.branch === name && w.path !== c.clone);
  const local = `refs/heads/${name}`;
  for (const ref of [...(worked ? [local] : []), `refs/remotes/origin/${name}`, `refs/tags/${name}`, local]) {
    const sha = await refOf(c, ref);
    if (sha !== undefined) return sha;
  }
  return undefined;
}

const nameFault = (what: string, name: string): string | undefined =>
  BRANCH_NAME.test(name) || (what !== "branch" && SHA.test(name))
    ? undefined
    : `"${name}" is not a ${what === "branch" ? "branch name" : `name or commit for \`${what}\``}`;

// --- The fetch ----------------------------------------------------------------------------------------

/** ADR-0053's one line: the ask never fails a fetch, so this is the only sign of a dead remote. */
const WARNED = /^warning: jr2: remote fetch failed \((.*)\); serving the cache as of (.*)$/m;

const STALE_WINDOW_MS = 120_000;

type Memo = { at: number; stale: string };

/** The memo in `file`. One that does not parse is no memo: it only saves an ask. */
async function readMemo(file: string): Promise<Memo | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Memo | null;
  } catch {
    return null;
  }
}

/** Fetch, and say if the answer is stale. Undefined: the remote answered. */
async function fetched(c: Clone, paths: CutPaths): Promise<string | undefined> {
  const file = `${c.clone}/.git/jr2-cut-stale.json`;
  const window = paths.staleWindowMs ?? STALE_WINDOW_MS;
  const memo = await readMemo(file);
  if (memo !== null && Date.now() - memo.at < window) return memo.stale;
  const say = async (stale: string): Promise<string> => {
    await writeFile(`${file}.tmp`, JSON.stringify({ at: Date.now(), stale } satisfies Memo));
    await rename(`${file}.tmp`, file);
    return stale;
  };
  let asks = 1;
  for (let tries = 1; ; tries++) {
    const r = await c.git(c.clone, [
      "fetch",
      "--prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "origin",
    ]);
    const warned = r.err.match(WARNED);
    // One ask more: a cache that was slow lands before a second budget ends. Measured in a pod on a
    // loaded node: 2 of about 90 first cuts of a new name met "timed out waiting for the node cache"
    // with the remote fine. A dead remote pays two budgets, once in the window.
    if (warned && asks < 2) {
      asks++;
      continue;
    }
    if (warned) return say(`${warned[1]}; the clone is as of ${warned[2]}`);
    if (r.code === 0) {
      await rm(file, { force: true });
      return undefined;
    }
    // An Agent's fetch moved a ref under this one: the remote is fine, and a second fetch lands.
    if (LOCK_RACE.test(r.err) && tries < 6) {
      await sleep(40 * tries + Math.random() * 80);
      continue;
    }
    // Not a memo: a lock race says nothing of the remote, and a broken transport says it at once.
    const line = r.err.split("\n").find((l) => /^(fatal|error):/.test(l)) ?? r.err.split("\n")[0];
    return (line || "the fetch failed").slice(0, 400);
  }
}

// --- The large files ------------------------------------------------------------------------------------

/** One LFS file of a commit whose object no store holds, as `jr2-lfs fetch` prints it. */
export type MissingFile = { path: string; oid: string; reason: string };

/** The `missing` list of `jr2-lfs fetch`'s one JSON line, or undefined when the output is not one. */
export function largeFilesMissing(stdout: string): MissingFile[] | undefined {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as { missing?: unknown } | null;
    return Array.isArray(parsed?.missing) ? (parsed.missing as MissingFile[]) : undefined;
  } catch {
    return undefined;
  }
}

/** At most this many files are named when large files cannot be had. */
const NAMED_FILES = 5;

/** The words for large files that cannot be had: each file (at most a few) and the cache's reason. */
export function describeMissing(missing: readonly MissingFile[], of: string): string {
  const named = missing
    .slice(0, NAMED_FILES)
    .map((m) => `${m.path} (${String(m.oid).slice(0, 12)}): ${m.reason}`)
    .join("; ");
  const more = missing.length > NAMED_FILES ? `; and ${missing.length - NAMED_FILES} more` : "";
  const files = missing.length === 1 ? "the large file" : `${missing.length} large files`;
  return `the node cache cannot get ${files} of ${of}: ${named}${more}`;
}

/**
 * What the cut keeps of its Effect's timeout after the ask for the large files: the checkout that
 * copies them out of the cache, and the answer. The ask gets the rest, so a cut whose large files do
 * not come in time ends `refused`, naming the files, and not at the Effect's timeout (ADR-0075).
 * With `worktree()`'s default of 10 minutes, a fetch that spends its two budgets (2 × 75 s) leaves the
 * ask 10 min − 150 s − 60 s = 6.5 minutes. The node cache's own LFS budget is 10 minutes, so an
 * object that comes later is in the cache for the next cut.
 */
export const CUT_LFS_MARGIN_MS = 60_000;

/** The config of `jr2-lfs fetch` in the cut, by `GIT_CONFIG_COUNT`: CLEAN's keys that its git reads. */
export const LARGE_FILES_PINS: ReadonlyArray<readonly [string, string]> = [
  ["safe.directory", "*"],
  ["core.commitGraph", "false"],
  ["core.multiPackIndex", "false"],
  ["core.attributesFile", "/dev/null"],
];

/** `pins` as git's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`. */
function configEnv(pins: ReadonlyArray<readonly [string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pins.length) };
  pins.forEach(([k, v], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  return env;
}

/**
 * Ask the node cache for the LFS objects of `commit` (ADR-0053, ADR-0075): `jr2-lfs fetch` asks for
 * each object that no store holds, waits for the landing, and names each file whose object is still
 * missing. A commit with no LFS file makes no ask. When the Effect's timeout left no time for the
 * ask (`budgetMs` of zero or less), jr2-lfs sends none, and the refusal names each file that no
 * store holds. jr2-lfs runs no program of the clone's config. It gets the cut's pins by env
 * (`LARGE_FILES_PINS`), and pins the same itself: `safe.directory`, because the cleared environment
 * reads no global config, and no commit-graph, no multi-pack-index and no attributes file of the
 * cut's HOME, which the Agents write (ADR-0075).
 */
async function askLargeFiles(
  paths: CutPaths,
  home: string,
  clone: string,
  commit: string,
  budgetMs: number | undefined,
): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...cutEnv(paths, home), ...configEnv(LARGE_FILES_PINS) };
  const args = [
    "fetch",
    ...(budgetMs !== undefined ? ["--budget", `${Math.max(0, Math.floor(budgetMs))}ms`] : []),
    "--",
    commit,
  ];
  const r = await new Promise<Git>((resolve) => {
    execFile(paths.jr2Lfs, args, { cwd: clone, env, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      const code = error == null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: stdout.trim(), err: stderr.trim() || (error?.message ?? "") });
    });
  });
  if (r.code !== 0) return `cannot ask for the large files of ${commit}: ${r.err || r.out || `exit ${r.code}`}`;
  const missing = largeFilesMissing(r.out);
  if (missing === undefined)
    return `jr2-lfs printed no result for the large files of ${commit}: ${r.out.slice(0, 200)}`;
  if (missing.length === 0) return undefined;
  if (budgetMs !== undefined && budgetMs <= 0) return describeNoTime(missing, commit);
  return describeMissing(missing, commit);
}

/** The refusal of a cut whose Effect's timeout left no time to ask for its large files. */
function describeNoTime(missing: readonly MissingFile[], of: string): string {
  const named = missing
    .slice(0, NAMED_FILES)
    .map((m) => `${m.path} (${String(m.oid).slice(0, 12)})`)
    .join("; ");
  const more = missing.length > NAMED_FILES ? `; and ${missing.length - NAMED_FILES} more` : "";
  const files = missing.length === 1 ? "the large file" : `${missing.length} large files`;
  return `the Effect's timeout left no time to ask the node cache for ${files} of ${of}: ${named}${more}`;
}

// --- The cut --------------------------------------------------------------------------------------------

const refused = (reason: string): CutAnswer => ({ outcome: "refused", reason: reason.slice(0, 1024) });

/** The cut, in this process. */
export async function cut(req: CutRequest, paths: CutPaths): Promise<CutAnswer> {
  const started = Date.now();
  const bad = pathFault(req.path, paths.workRoot);
  if (bad !== undefined) return refused(bad);
  if ((req.branch === undefined) === (req.detach === undefined)) return refused("a cut names a branch or a commit");
  if (req.detach !== undefined && req.from !== undefined) return refused("a detached cut takes no `from`");
  if (req.detach !== undefined && req.expect !== undefined) return refused("a detached cut takes no `expect`");
  const fault =
    (req.branch !== undefined ? nameFault("branch", req.branch) : undefined) ??
    (req.from !== undefined ? nameFault("from", req.from) : undefined) ??
    (req.detach !== undefined ? nameFault("detach", req.detach) : undefined);
  if (fault !== undefined) return refused(fault);

  const slot = req.path.slice(paths.workRoot.length + 1).split("/")[0]!;
  const clone = `${paths.workRoot}/${slot}/default`;
  if (!(await exists(`${clone}/.git`))) return refused(`no Repo Slot "${slot}" in this Workspace`);
  return locked(clone, paths, async () => {
    // A cut that a kill stopped leaves its folder, with an index of the Worktree's files in it. Under
    // the lock no other cut of this clone lives, so each folder of this clone's name is a dead one.
    const tmp = paths.tmp ?? tmpdir();
    const prefix = tmpPrefix(clone);
    for (const name of await readdir(tmp).catch(() => [] as string[])) {
      if (name.startsWith(prefix)) await rm(join(tmp, name), { recursive: true, force: true });
    }
    const home = await mkdtemp(join(tmp, prefix));
    try {
      // The ask's budget is what is left of the Effect's timeout, counted from the start, less the margin.
      const ends = typeof req.timeoutMs === "number" ? started + req.timeoutMs - CUT_LFS_MARGIN_MS : undefined;
      const largeFiles = (commit: string) =>
        askLargeFiles(paths, home, clone, commit, ends === undefined ? undefined : ends - Date.now());
      const c: Clone = { clone, records: `${clone}/.git/jr2-cuts`, git: runner(paths, home), paths, home, largeFiles };
      await recover(c);
      return await cutLocked(req, slot, c, paths);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

/** The name of a cut's own folder in TMPDIR starts with this, one for each clone: so the sweep of one
 * clone's cut, under that clone's lock, removes no folder of a live cut of another clone. */
const tmpPrefix = (clone: string): string =>
  `jr2-cut-${createHash("sha256").update(clone).digest("hex").slice(0, 12)}-`;

type Ready = Extract<CutAnswer, { outcome: "ready" }>;
type ReadyOf = (branch: string | null, head: string, found: CutFound, stale?: string) => Ready;

async function cutLocked(req: CutRequest, slot: string, c: Clone, paths: CutPaths): Promise<CutAnswer> {
  const ready: ReadyOf = (branch, head, found, stale) => ({
    outcome: "ready",
    slot,
    path: req.path,
    branch,
    head,
    found,
    ...(stale !== undefined ? { stale } : {}),
  });
  const rec = await readRecord(c, req.path);
  if (rec !== undefined) return recut(req, rec, c, ready);
  if (await exists(req.path)) return adopt(req, c, ready);
  // A folder an Agent removed leaves an entry behind; a kill can leave it `locked`.
  const stray = await adminOf(c, req.path);
  if (stray) await rm(stray, { recursive: true, force: true });
  await c.git(c.clone, ["worktree", "prune"]);
  return req.detach !== undefined ? firstDetach(req, c, paths, ready) : firstBranch(req, c, paths, ready);
}

/** A path with no record: an Agent's own folder. It is never removed. */
async function adopt(req: CutRequest, c: Clone, ready: ReadyOf): Promise<CutAnswer> {
  const listed = (await worktrees(c)).find((w) => w.path === req.path);
  if (listed === undefined) {
    return refused(`${req.path} is a folder and no Worktree: a cut removes nothing it did not make`);
  }
  if (req.detach !== undefined) {
    return refused(`${req.path} is a Worktree no cut made, and a detached cut forces only its own`);
  }
  if (listed.branch !== req.branch) {
    return refused(`${req.path} holds ${listed.branch ?? "a detached HEAD"}, not ${req.branch}, and no cut made it`);
  }
  const fault = expectFault(req, true);
  if (fault !== undefined) return refused(fault);
  const head = await refOf(c, `refs/heads/${req.branch!}`);
  if (head === undefined) return refused(`${req.path} holds ${req.branch}, which has no commit yet`);
  if (req.from !== undefined && (await commitOf(c, req.from)) !== head) {
    return refused(`${req.branch} is not at \`from\` "${req.from}": \`from\` starts a new branch and moves no branch`);
  }
  await writeRecord(c, {
    state: "done",
    id: req.id,
    path: req.path,
    branch: req.branch!,
    ...(req.from !== undefined ? { from: req.from } : {}),
    found: "held",
    made: {},
  });
  return ready(req.branch!, head, "held");
}

/** `expect` on a name that is there (`there`) or not. */
function expectFault(req: CutRequest, there: boolean): string | undefined {
  if (req.expect === "new" && there) return `${req.branch} exists, and this cut makes only a new branch`;
  if (req.expect === "existing" && !there) return `${req.branch} does not exist, and this cut makes nothing`;
  return undefined;
}

/**
 * Add the Worktree of a done record again: the folder is gone, and an entry can be left. `what` is
 * `["--detach", sha]` or `[branch]`, and `sha` the commit that the folder gets. The record says
 * `adding` before git changes anything, and is written again with `sha` after the fill: a kill
 * between the two leaves a folder that has a HEAD and no index or no files, which a `held` answer
 * would give back as it is, and `git commit -a` there commits the removal of each file.
 */
async function addAgain(
  c: Clone,
  rec: CutRecord,
  what: readonly string[],
  sha: string,
  next: Pick<CutRecord, "id" | "found" | "detach">,
): Promise<string | undefined> {
  const { adding: _, ...done } = rec;
  await writeRecord(c, { ...done, adding: true });
  const admin = await adminOf(c, rec.path);
  if (admin) await rm(admin, { recursive: true, force: true });
  await c.git(c.clone, ["worktree", "prune"]);
  const add = await steady(() =>
    c.git(c.clone, ["worktree", "add", "--no-checkout", ...what.slice(0, -1), "--", rec.path, what[what.length - 1]!]),
  );
  if (add.code !== 0) {
    // git made no folder: a folder that is there now is not the cut's.
    await writeRecord(c, done);
    return add.err;
  }
  const fault = await fill(c, rec.path, sha, { detach: what[0] === "--detach" });
  if (fault !== undefined) return fault;
  await writeRecord(c, { ...done, ...next, ...(what[0] === "--detach" ? { sha } : {}) });
  return undefined;
}

/** What a merge or a rebase left is not a commit, and a forced checkout leaves it. So is a lock that
 * a kill left: under the cut's lock, in a seat that this cut forces, no git of ours is alive there. */
const HALF_DONE = [
  "index.lock",
  "HEAD.lock",
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "MERGE_MSG",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "sequencer",
];

/** The files whose rules change the bytes that a checkout writes. A re-cut removes each one that is
 * not in the commit that it last wrote, before the checkout (ADR-0075). A `.gitignore` stays: a
 * folder that ignores itself (`.venv`, `.pytest_cache`) is the reviewer's tools. */
const ATTRIBUTES_PATHSPECS = [":(glob)**/.gitattributes"];

/**
 * The files that pi-coding-agent reads into an Agent's system prompt from a folder of a Worktree
 * (ADR-0062), at the pin: the context file names of `loadProjectContextFiles`, and what is in a
 * `.pi/skills` folder (`loadSkills`), in each folder of the Worktree. As git pathspecs: `**` also
 * matches the Worktree's root. git does not go into a nested repo that is ignored.
 */
export const CONTEXT_PATHSPECS = [
  ...["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].map((name) => `:(glob)**/${name}`),
  ":(glob)**/.pi/skills/**",
];

/** Two paths are one folder: git answers real paths, and a test's root can be a link. */
const samePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Put the files of `sha` in the Worktree at `path` (ADR-0075), through a git folder of the cut's
 * own: its HEAD, its index and its config are the cut's, and it takes the clone's objects by
 * `alternates`. So nothing that an Agent wrote in the clone or the Worktree changes what is checked
 * out: not a filter or `core.worktree` in any config file or include, not `info/attributes`, not an
 * ignore or attributes file in the cut's HOME, not an index whose stat data an Agent matched to a
 * changed file, not a skip-worktree or assume-unchanged bit, not a sparse checkout, not a commit-graph
 * or a multi-pack-index that an Agent forged (CLEAN), and (below) not a `.gitattributes` in the work
 * tree that the commit does not have. Then the index is copied into the Worktree's admin folder, and
 * a detached Worktree's HEAD is set to `sha`. The one filter that runs is jr2's LFS filter (`lfsPins`),
 * which reads the large files that the cut asked for first from the clone's LFS store and, by the
 * alternates, the node cache's (`alternatesOf`). A known limit: a pack index (`.idx`) that an Agent
 * forged in the clone can give a commit the bytes of another object, because git 2.56 reads a pack
 * without a check of the object's hash and no config turns a pack index off.
 *
 * `again`: the folder holds the files of the commit that the cut last wrote there, `again`, and an
 * Agent's changes. The index is seeded from that commit (the record's, never a HEAD that an Agent
 * set), so a file that the new commit removed goes. Then each `.gitattributes` that is not in that
 * commit goes, before the checkout, because it changes the bytes that a checkout writes (`eol`,
 * `working-tree-encoding`, `ident`). After the checkout, `clean -ffd` removes what is not in the
 * commit. Ignored files stay, by each `.gitignore` in the work tree, because a reviewer runs the
 * tests and a folder that ignores itself (`.venv`) is the reviewer's tools (ADR-0028). So a
 * `.gitignore` that an Agent wrote also keeps what it ignores: a known limit, which a domain for each
 * Agent closes (ADR-0075). An ignore rule of the clone's `info/exclude` or of a config keeps nothing.
 * The context files and skills that pi reads go also when they are ignored.
 *
 * It refuses a Worktree whose `.git` names another admin folder, and one whose own git would work
 * in another folder (a `core.worktree` in its config): each later git of an Agent there would read
 * that other folder. Returns the fault, or `undefined`.
 */
async function fill(
  c: Clone,
  path: string,
  sha: string,
  opts: { detach: boolean; again?: string },
): Promise<string | undefined> {
  const admin = await adminOf(c, path);
  if (admin === undefined) return `${path} has no admin folder in the clone`;
  const gitDir = await c.git(path, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.code !== 0) return `${path} is a folder and no longer a Worktree: ${gitDir.err}`;
  if (!samePath(gitDir.out, admin)) return `${path}'s .git names ${gitDir.out}, not its own admin folder ${admin}`;
  const top = await c.git(path, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !samePath(top.out, path)) {
    return `git in ${path} works in ${top.code === 0 ? top.out : `no folder (${top.err})`}: a core.worktree in its config moves it`;
  }
  for (const state of HALF_DONE) await rm(`${admin}/${state}`, { recursive: true, force: true });
  const own = await mkdtemp(join(c.home, "fill-"));
  await mkdir(join(own, "objects", "info"), { recursive: true });
  await mkdir(join(own, "refs"));
  await writeFile(join(own, "objects", "info", "alternates"), await alternatesOf(c.clone));
  await writeFile(join(own, "HEAD"), `${sha}\n`);
  await writeFile(
    join(own, "config"),
    sha.length === 64
      ? "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n"
      : "[core]\n\trepositoryformatversion = 0\n",
  );
  const git = runner(c.paths, c.home, { GIT_DIR: own, GIT_WORK_TREE: path }, lfsPins(c.paths, c.clone));
  if (opts.again !== undefined) {
    const seed = await git(path, ["read-tree", opts.again]);
    if (seed.code !== 0) return seed.err;
    const attributes = await git(path, ["clean", "-ffdxq", "--", ...ATTRIBUTES_PATHSPECS]);
    if (attributes.code !== 0) return attributes.err;
  }
  const co = await git(path, ["checkout", "-q", "-f", "--detach", sha]);
  if (co.code !== 0) return smudgeFault(co.err, sha) ?? co.err;
  if (opts.again !== undefined) {
    // `-ff`: a nested repo goes too. No `-x`: a reviewer runs the tests (ADR-0028).
    const clean = await git(path, ["clean", "-ffdq"]);
    if (clean.code !== 0) return clean.err;
    const context = await git(path, ["clean", "-ffdxq", "--", ...CONTEXT_PATHSPECS]);
    if (context.code !== 0) return context.err;
  }
  await copyFile(join(own, "index"), `${admin}/index.jr2-cut`);
  await rename(`${admin}/index.jr2-cut`, `${admin}/index`);
  if (opts.detach) {
    const head = await steady(() => c.git(path, ["update-ref", "--no-deref", "HEAD", sha]));
    if (head.code !== 0) return head.err;
  }
  return undefined;
}

/**
 * The refusal of a checkout that git-lfs could not smudge: the file, from git's last line
 * (`fatal: <path>: smudge filter lfs failed`), and jr2's line, from the agent. A large file that the
 * cut asked for and that went from the stores before the checkout comes here. Undefined for another
 * fault.
 */
export function smudgeFault(err: string, sha: string): string | undefined {
  const file = /^fatal: (.+): smudge filter lfs failed$/m.exec(err)?.[1];
  if (file === undefined) return undefined;
  const why = /jr2: (.+?)(?:\s*$)/m.exec(err)?.[1];
  return `the checkout of ${sha} cannot get the large file ${file}${why !== undefined ? `: ${why}` : ""}`;
}

/**
 * The alternates of `fill`'s git folder: the node cache's object stores that the clone borrows from,
 * first, then the clone's objects. git reads alternates of alternates, but git-lfs reads only the
 * first level, beside each one (`<objects>/../lfs/objects`): so the cache's large files are found by
 * a cache line here (ADR-0053). A line that names no folder is passed over by git and git-lfs alike.
 */
async function alternatesOf(clone: string): Promise<string> {
  const objects = `${clone}/.git/objects`;
  const text = await readFile(`${objects}/info/alternates`, "utf8").catch(() => "");
  const borrowed = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => (l.startsWith('"') || isAbsolute(l) ? l : join(objects, l)));
  return `${[...borrowed, objects].join("\n")}\n`;
}

/** A path a cut made. The record says what it is, and a re-cut agrees with it or is refused. */
async function recut(req: CutRequest, rec: CutRecord, c: Clone, ready: ReadyOf): Promise<CutAnswer> {
  if (rec.branch !== undefined && req.branch !== rec.branch) {
    return refused(`${req.path} was cut for ${rec.branch}, not ${req.branch ?? "a detached commit"}`);
  }
  if (rec.detach !== undefined && req.detach === undefined) {
    return refused(`${req.path} was cut detached, not for ${req.branch}`);
  }
  if (req.from !== undefined && req.from !== rec.from) {
    return refused(`${req.path} was cut from ${rec.from ?? "the base"}, not ${req.from}`);
  }
  if (rec.adding) {
    // A kill stopped an add of this folder again: what is there is the cut's, half made.
    const admin = await adminOf(c, req.path);
    if (admin) await rm(admin, { recursive: true, force: true });
    await rm(req.path, { recursive: true, force: true });
  }
  if (req.detach !== undefined) {
    const sha = await commitOf(c, req.detach);
    if (sha === undefined) return refused(`no commit "${req.detach}" in this clone`);
    const lfs = await c.largeFiles(sha);
    if (lfs !== undefined) return refused(lfs);
    const next = { id: req.id, detach: req.detach, found: "commit" as const };
    if (await exists(req.path)) {
      const fault = await fill(c, req.path, sha, { detach: true, again: rec.sha ?? sha });
      if (fault !== undefined) return refused(fault);
      await writeRecord(c, { ...rec, ...next, sha });
    } else {
      const fault = await addAgain(c, rec, ["--detach", sha], sha, next);
      if (fault !== undefined) return refused(fault);
    }
    return ready(null, sha, "commit");
  }
  const branch = rec.branch!;
  const head = await refOf(c, `refs/heads/${branch}`);
  if (head === undefined) return refused(`the branch ${branch} of ${req.path} is gone`);
  if (!(await exists(req.path))) {
    // An Agent removed the folder. The branch keeps the commits, and only they come back.
    const lfs = await c.largeFiles(head);
    if (lfs !== undefined) return refused(lfs);
    const fault = await addAgain(c, rec, [branch], head, { id: req.id, found: "local" });
    if (fault !== undefined) return refused(fault);
    return ready(branch, head, "local");
  }
  const again = rec.id === req.id;
  if (!again) await writeRecord(c, { ...rec, id: req.id, found: "held" });
  return ready(branch, head, again ? rec.found : "held");
}

async function firstDetach(req: CutRequest, c: Clone, paths: CutPaths, ready: ReadyOf): Promise<CutAnswer> {
  let sha = await commitOf(c, req.detach!);
  let stale: string | undefined;
  if (sha === undefined) {
    stale = await fetched(c, paths);
    sha = await commitOf(c, req.detach!);
  }
  if (sha === undefined) {
    return refused(`no commit "${req.detach}" in this clone${stale ? `, and the fetch said: ${stale}` : ""}`);
  }
  const lfs = await c.largeFiles(sha);
  if (lfs !== undefined) return refused(lfs);
  const rec: CutRecord = {
    state: "cutting",
    id: req.id,
    path: req.path,
    detach: req.detach!,
    found: "commit",
    made: { folder: true },
  };
  await writeRecord(c, rec);
  const add = await steady(() => c.git(c.clone, ["worktree", "add", "--no-checkout", "--detach", "--", req.path, sha]));
  const fault = add.code !== 0 ? add.err : await fill(c, req.path, sha, { detach: true });
  if (fault !== undefined) {
    await undo(c, rec);
    return refused(fault);
  }
  await writeRecord(c, { ...rec, state: "done", sha });
  return ready(null, sha, "commit");
}

async function firstBranch(req: CutRequest, c: Clone, paths: CutPaths, ready: ReadyOf): Promise<CutAnswer> {
  const branch = req.branch!;
  const holder = (await worktrees(c)).find((w) => w.branch === branch);
  if (holder !== undefined) return refused(`${holder.path} holds ${branch}: read it there, or cut another branch`);
  // The name is decided on the remote's now.
  const stale = await fetched(c, paths);
  const local = await refOf(c, `refs/heads/${branch}`);
  const remote = local === undefined ? await refOf(c, `refs/remotes/origin/${branch}`) : undefined;
  const there = local !== undefined || remote !== undefined;
  // `new` is the one answer a stale fetch cannot give: the name may be on the remote.
  if (!there && stale !== undefined) {
    return refused(`${branch} is not in this clone, and the remote did not answer, so it may exist there: ${stale}`);
  }
  const expected = expectFault(req, there);
  if (expected !== undefined) return refused(expected);
  if (req.from !== undefined && there && (await commitOf(c, req.from)) !== (local ?? remote)) {
    return refused(
      `${branch} exists, and it is not at \`from\` "${req.from}": \`from\` starts a new branch and moves no branch`,
    );
  }
  const found: CutFound = local !== undefined ? "local" : remote !== undefined ? "remote" : "none";
  const named = req.from ?? req.base;
  const start =
    local ?? remote ?? (named !== undefined ? await commitOf(c, named) : await refOf(c, "refs/remotes/origin/HEAD"));
  if (start === undefined) return refused(`no commit "${named ?? "origin/HEAD"}" in this clone`);
  const lfs = await c.largeFiles(start);
  if (lfs !== undefined) return refused(lfs);

  const rec: CutRecord = {
    state: "cutting",
    id: req.id,
    path: req.path,
    branch,
    ...(req.from !== undefined ? { from: req.from } : {}),
    found,
    start,
    made: {
      folder: true,
      ...(local === undefined ? { branch: true } : {}),
      ...(found === "remote" ? { upstream: true } : {}),
    },
  };
  await writeRecord(c, rec);
  const failed = async (r: Git): Promise<CutAnswer> => {
    await undo(c, rec);
    return refused(r.err);
  };
  if (local === undefined) {
    const made = await steady(() =>
      c.git(c.clone, ["update-ref", `refs/heads/${branch}`, start, "0000000000000000000000000000000000000000"]),
    );
    if (made.code !== 0) return failed(made);
  }
  if (found === "remote") {
    for (const [key, value] of [
      [`branch.${branch}.remote`, "origin"],
      [`branch.${branch}.merge`, `refs/heads/${branch}`],
    ] as const) {
      const set = await steady(() => c.git(c.clone, ["config", key, value]));
      if (set.code !== 0) return failed(set);
    }
  }
  const add = await steady(() => c.git(c.clone, ["worktree", "add", "--no-checkout", "--", req.path, branch]));
  if (add.code !== 0) return failed(add);
  const fault = await fill(c, req.path, start, { detach: false });
  if (fault !== undefined) return failed({ code: 1, out: "", err: fault });
  await writeRecord(c, { ...rec, state: "done" });
  return ready(branch, start, found, stale);
}

/** Read the request, cut, and print one JSON line. A fault here is no outcome: a non-zero exit, which
 * the Orchestrator settles `unknown`. */
export async function main(argv: readonly string[], paths: CutPaths = POD_CUT_PATHS): Promise<void> {
  const answer = await cut(JSON.parse(argv[0] ?? "{}") as CutRequest, paths);
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

// `node cut.ts <json>`, on the runtime volume. Nothing else runs this file as a program.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
) {
  void main(process.argv.slice(2), {
    ...POD_CUT_PATHS,
    ...(process.env.JR2_CUT_LOCK ? { lock: JSON.parse(process.env.JR2_CUT_LOCK) as string[] } : {}),
    ...(process.env.JR2_CUT_WORK ? { workRoot: process.env.JR2_CUT_WORK } : {}),
    ...(process.env.JR2_CUT_GIT_LFS ? { gitLfs: process.env.JR2_CUT_GIT_LFS } : {}),
    ...(process.env.JR2_CUT_JR2_LFS ? { jr2Lfs: process.env.JR2_CUT_JR2_LFS } : {}),
    ...(process.env.JR2_CUT_STALE_MS ? { staleWindowMs: Number(process.env.JR2_CUT_STALE_MS) } : {}),
  });
}
