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
//   - No hook runs: a cleared environment and sync.ts's config. The files of a Worktree come through
//     a git folder of the cut's own (`fill`), which takes only the clone's objects: no config, no
//     attributes, no index and no ignore rule that an Agent wrote changes what is checked out.
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
import { closeSync, openSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The input of one cut. `id` is the Effect's id. `base` is where a new branch starts with no `from`:
 * the Binding's own ref, which no run can name, so the branch rule does not hold it. */
export type CutRequest = {
  id: string;
  path: string;
  branch?: string;
  from?: string;
  detach?: string;
  expect?: "new" | "existing";
  base?: string;
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

/** The seams of the tests. `lock`: the program that takes a flock on its stdin. `env`: added to the
 * cleared environment. `staleWindowMs`: how long a warned fetch answers for the next cuts. */
export type CutPaths = { workRoot: string; lock: readonly string[]; env?: NodeJS.ProcessEnv; staleWindowMs?: number };

export const POD_CUT_PATHS: CutPaths = { workRoot: "/work", lock: ["/opt/jr2/bin/cut-lock"] };

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

/** sync.ts's CLEAN, and `safe.directory`, because the cleared environment reads no global config. */
const CLEAN = [
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

type Git = { code: number; out: string; err: string };
type Runner = (cwd: string, args: readonly string[], maxBuffer?: number) => Promise<Git>;

/** git with the cleared environment, and `extra` added to it (`fill`'s own git folder). */
function runner(paths: CutPaths, home: string, extra: NodeJS.ProcessEnv = {}): Runner {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.JR2_CUSTODIAN_URL ? { JR2_CUSTODIAN_URL: process.env.JR2_CUSTODIAN_URL } : {}),
    ...paths.env,
    ...extra,
  };
  return (cwd, args, maxBuffer = 16 << 20) =>
    new Promise((resolve) => {
      execFile("git", ["-C", cwd, ...CLEAN, ...args], { env, maxBuffer }, (error, stdout, stderr) => {
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
  made: { folder?: boolean; branch?: boolean; upstream?: boolean };
};

type Clone = { clone: string; records: string; git: Runner; paths: CutPaths; home: string };

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

// --- The cut --------------------------------------------------------------------------------------------

const refused = (reason: string): CutAnswer => ({ outcome: "refused", reason: reason.slice(0, 1024) });

/** The cut, in this process. */
export async function cut(req: CutRequest, paths: CutPaths): Promise<CutAnswer> {
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
  const home = await mkdtemp(join(tmpdir(), "jr2-cut-"));
  try {
    const c: Clone = { clone, records: `${clone}/.git/jr2-cuts`, git: runner(paths, home), paths, home };
    return await locked(clone, paths, async () => {
      await recover(c);
      return cutLocked(req, slot, c, paths);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

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

/** Add the Worktree of a done record again: the folder is gone, and an entry can be left. `what` is
 * `["--detach", sha]` or `[branch]`, and `sha` the commit that the folder gets. */
async function addAgain(c: Clone, path: string, what: readonly string[], sha: string): Promise<string | undefined> {
  const admin = await adminOf(c, path);
  if (admin) await rm(admin, { recursive: true, force: true });
  await c.git(c.clone, ["worktree", "prune"]);
  const add = await steady(() =>
    c.git(c.clone, ["worktree", "add", "--no-checkout", ...what.slice(0, -1), "--", path, what[what.length - 1]!]),
  );
  if (add.code !== 0) return add.err;
  return fill(c, path, sha, { detach: what[0] === "--detach", again: false });
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
 * index whose stat data an Agent matched to a changed file, not a skip-worktree or assume-unchanged
 * bit, not a sparse checkout. Then the index is copied into the Worktree's admin folder, and a
 * detached Worktree's HEAD is set to `sha`.
 *
 * `again`: the folder holds an earlier cut's files. Its index is seeded from its HEAD, so a file
 * that the new commit removed goes, and `clean -ffd` removes what is not in the commit. Ignored
 * files stay, by the commit's own `.gitignore` files alone, because a reviewer runs the tests
 * (ADR-0028); an ignore rule of the clone's `info/exclude` or of an Agent's config keeps nothing. The
 * context files and skills that pi reads go also when the commit ignores them.
 *
 * It refuses a Worktree whose `.git` names another admin folder, and one whose own git would work
 * in another folder (a `core.worktree` in its config): each later git of an Agent there would read
 * that other folder. Returns the fault, or `undefined`.
 */
async function fill(
  c: Clone,
  path: string,
  sha: string,
  opts: { detach: boolean; again: boolean },
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
  await writeFile(join(own, "objects", "info", "alternates"), `${c.clone}/.git/objects\n`);
  await writeFile(join(own, "HEAD"), `${sha}\n`);
  await writeFile(
    join(own, "config"),
    sha.length === 64
      ? "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n"
      : "[core]\n\trepositoryformatversion = 0\n",
  );
  const git = runner(c.paths, c.home, { GIT_DIR: own, GIT_WORK_TREE: path });
  if (opts.again) {
    const old = await c.git(path, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    if (old.code === 0) await git(path, ["read-tree", old.out]);
  }
  const co = await git(path, ["checkout", "-q", "-f", "--detach", sha]);
  if (co.code !== 0) return co.err;
  if (opts.again) {
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
  if (req.detach !== undefined) {
    const sha = await commitOf(c, req.detach);
    if (sha === undefined) return refused(`no commit "${req.detach}" in this clone`);
    const fault = (await exists(req.path))
      ? await fill(c, req.path, sha, { detach: true, again: true })
      : await addAgain(c, req.path, ["--detach", sha], sha);
    if (fault !== undefined) return refused(fault);
    await writeRecord(c, { ...rec, id: req.id, detach: req.detach, found: "commit" });
    return ready(null, sha, "commit");
  }
  const branch = rec.branch!;
  const head = await refOf(c, `refs/heads/${branch}`);
  if (head === undefined) return refused(`the branch ${branch} of ${req.path} is gone`);
  if (!(await exists(req.path))) {
    // An Agent removed the folder. The branch keeps the commits, and only they come back.
    const fault = await addAgain(c, req.path, [branch], head);
    if (fault !== undefined) return refused(fault);
    await writeRecord(c, { ...rec, id: req.id, found: "local" });
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
  const fault = add.code !== 0 ? add.err : await fill(c, req.path, sha, { detach: true, again: false });
  if (fault !== undefined) {
    await undo(c, rec);
    return refused(fault);
  }
  await writeRecord(c, { ...rec, state: "done" });
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
  const fault = await fill(c, req.path, start, { detach: false, again: false });
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
    ...(process.env.JR2_CUT_STALE_MS ? { staleWindowMs: Number(process.env.JR2_CUT_STALE_MS) } : {}),
  });
}
