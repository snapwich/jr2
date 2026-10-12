// The sync (ADR-0067): after every push whose published commit is not the Agent's own, the Agent's
// branch moves to the published commits, HERE, in the Harness container, on `POST /sync`. The
// Sandbox Effector re-created the Agent's commits — as signed copies, or as one squashed commit,
// signed or not — and pushed them; their bundle travels to this container through the
// Orchestrator, never through a shared volume (the Worktree stays read-only on the credentialed
// side). The sync reads no signature. The procedure:
//
//   0. `published == source`: the push published the Agent's own commit — `skipped`, nothing
//      changes.
//   1. The bundle, when the request carries one: `git bundle verify`, then `git bundle unbundle`
//      (objects only; no ref of the bundle is written).
//   2. `published` is a commit, and its tree is `source`'s — else `not-synced`.
//   3. A rebase whose branch is this one, or a merge, cherry-pick, revert or sequence in a worktree
//      whose HEAD is this branch: `busy`, and nothing changes.
//   4. T, the branch now: T is `published`, or `published` is in T's history — `already`. `source`
//      is not in T's history — `not-synced` (the Agent rewrote; the next push decides). Else every
//      commit after `source` is copied as its raw object with only its parent lines changed
//      (`source` → `published`, an earlier copy → its new id), an old `gpgsig` dropped.
//   5. The new tip's tree is T's — else `not-synced`.
//   6. `git update-ref refs/heads/<branch> <new> <T>`: a compare-and-swap, so a commit made while
//      the sync ran is never lost; on a lost race, again from 4, at most 3 times.
//
// So the files, the index, HEAD and the stash never change: one ref moves, and commit objects are
// written. Every git call runs under a cleared environment and a config that names no hook, no
// fsmonitor, no alternate-refs command and no maintenance (measured: with them, a planted
// reference-transaction hook moved the branch back after a "synced"). The answer is a report, not a
// fact: the Agent owns the repository and can move the branch at any time, so the next push trusts
// none of it and derives everything again from the remote and the Agent's objects.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SyncAnswer, SyncRequest } from "./wire.ts";

/** The config every sync git call gets: nothing the Agent's repository names runs. */
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
  "core.logAllRefUpdates=always",
  "-c",
  "core.alternateRefsCommand=true",
];

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

/** What `POST /sync` refuses before anything runs: a body that is not a sync request. */
export function syncFault(body: unknown, workRoot = "/work"): string | undefined {
  if (typeof body !== "object" || body === null) return "a sync request is an object";
  const b = body as Record<string, unknown>;
  if (typeof b.worktree !== "string" || !isAbsolute(b.worktree) || !resolve(b.worktree).startsWith(`${workRoot}/`)) {
    return `worktree must be an absolute path under ${workRoot}`;
  }
  if (typeof b.branch !== "string" || !BRANCH.test(b.branch) || b.branch.includes("..")) {
    return "branch is not a branch name the sync moves";
  }
  if (typeof b.published !== "string" || !SHA.test(b.published)) return "published is not a full commit id";
  if (typeof b.source !== "string" || !SHA.test(b.source)) return "source is not a full commit id";
  if (b.bundle !== undefined && typeof b.bundle !== "string") return "bundle is base64 text";
  return undefined;
}

/** The tests' seams: an env beside the cleared one, and a call just before each compare-and-swap
 * (where a test commits, as the Agent can while the sync runs). Production sets neither. */
type SyncSeams = { env?: NodeJS.ProcessEnv; beforeMove?: () => Promise<void> };

/**
 * The sync, bound to the work root. Calls are serialized: two syncs of one branch would race on
 * its ref.
 */
export function syncer(opts: SyncSeams = {}) {
  let queue: Promise<unknown> = Promise.resolve();
  return (req: SyncRequest): Promise<SyncAnswer> => {
    const run = queue.then(() => sync(req, opts));
    queue = run.catch(() => {});
    return run;
  };
}

async function sync(req: SyncRequest, seams: SyncSeams): Promise<SyncAnswer> {
  if (req.published === req.source)
    return { sync: "skipped", reason: "the push published your own commit: nothing to move" };
  const home = await mkdtemp(join(tmpdir(), "jr2-sync-"));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...seams.env,
    };
    const git = (args: string[], input?: string) => run(req.worktree, env, [...CLEAN, ...args], input);
    const ref = `refs/heads/${req.branch}`;

    if (req.bundle !== undefined) {
      const file = join(home, "sync.bundle");
      await writeFile(file, Buffer.from(req.bundle, "base64"));
      if ((await git(["bundle", "verify", "-q", file])).code !== 0) {
        return { sync: "not-synced", reason: "the published commits' bundle did not verify against your repository" };
      }
      if ((await git(["bundle", "unbundle", file])).code !== 0) {
        return { sync: "not-synced", reason: "the published commits could not be read from their bundle" };
      }
    }
    if ((await git(["cat-file", "-t", req.published])).out !== "commit") {
      return { sync: "not-synced", reason: "your repository does not hold the published commit" };
    }
    const tree = async (c: string) => (await git(["rev-parse", `${c}^{tree}`])).out;
    if ((await tree(req.published)) !== (await tree(req.source))) {
      return { sync: "not-synced", reason: "the published commit's files are not your commit's" };
    }
    const busy = await busyWith(req, git);
    if (busy) return { sync: "busy", reason: busy };

    for (let tries = 1; tries <= 3; tries++) {
      const t = (await git(["rev-parse", "-q", "--verify", ref])).out;
      if (!SHA.test(t)) return { sync: "not-synced", reason: `your repository has no branch ${req.branch}` };
      const isAncestor = async (a: string, b: string) => (await git(["merge-base", "--is-ancestor", a, b])).code === 0;
      if (t === req.published || (await isAncestor(req.published, t))) return { sync: "already" };
      if (!(await isAncestor(req.source, t))) {
        return {
          sync: "not-synced",
          reason: "your branch no longer holds the pushed commit: it was amended, rebased or reset",
        };
      }
      const list = (await git(["rev-list", "--reverse", "--topo-order", t, "--not", req.source])).out;
      const mapped = new Map<string, string>([[req.source, req.published]]);
      for (const c of list ? list.split("\n") : []) {
        const raw = await git(["cat-file", "commit", c]);
        if (raw.code !== 0) return { sync: "not-synced", reason: `commit ${c.slice(0, 12)} could not be read` };
        const copy = await git(["hash-object", "-t", "commit", "-w", "--stdin"], rewrite(raw.raw, mapped));
        if (!SHA.test(copy.out)) return { sync: "not-synced", reason: `commit ${c.slice(0, 12)} could not be copied` };
        mapped.set(c, copy.out);
      }
      const next = mapped.get(t) ?? req.published;
      if ((await tree(next)) !== (await tree(t))) {
        return { sync: "not-synced", reason: "the moved branch would not hold your files — a jr2 defect" };
      }
      await seams.beforeMove?.();
      const moved = await git(["update-ref", "-m", `jr2 sync to ${req.published}`, ref, next, t]);
      if (moved.code !== 0) continue; // the Agent committed while the sync ran: again, from its new tip
      const now = (await git(["rev-parse", ref])).out;
      return { sync: "synced", from: t, to: now, replayed: list ? list.split("\n").length : 0, tries };
    }
    return { sync: "not-synced", reason: "your branch kept moving while jr2 moved it" };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** One raw commit object with only its parent lines changed, and an old signature dropped. */
function rewrite(raw: string, mapped: Map<string, string>): string {
  const cut = raw.indexOf("\n\n");
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? "" : raw.slice(cut);
  const out: string[] = [];
  let inSig = false;
  for (const line of head.split("\n")) {
    if (inSig && line.startsWith(" ")) continue;
    inSig = false;
    if (line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 ")) {
      inSig = true;
      continue;
    }
    if (line.startsWith("parent ")) {
      const p = line.slice("parent ".length);
      out.push(`parent ${mapped.get(p) ?? p}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n") + body;
}

/** Why the branch cannot move now, or undefined: a rebase of it, or an operation in progress in a
 * worktree whose HEAD is it. Read as files in the repository's git dirs. */
async function busyWith(
  req: SyncRequest,
  git: (args: string[]) => Promise<{ code: number; out: string }>,
): Promise<string | undefined> {
  const common = resolve(req.worktree, (await git(["rev-parse", "--git-common-dir"])).out);
  const dirs = [common];
  try {
    for (const name of await readdir(join(common, "worktrees"))) dirs.push(join(common, "worktrees", name));
  } catch {
    // no linked worktree
  }
  const ref = `refs/heads/${req.branch}`;
  const read = async (p: string) => (await readFile(p, "utf8").catch(() => "")).trim();
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );
  for (const dir of dirs) {
    for (const rebase of ["rebase-merge", "rebase-apply"]) {
      if ((await read(join(dir, rebase, "head-name"))) === ref) return "a rebase of your branch is in progress";
    }
    if ((await read(join(dir, "HEAD"))) !== `ref: ${ref}`) continue;
    for (const op of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
      if (await exists(join(dir, op))) return `a ${opName(op)} is in progress on your branch`;
    }
  }
  return undefined;
}

function opName(op: string): string {
  return op === "MERGE_HEAD"
    ? "merge"
    : op === "CHERRY_PICK_HEAD"
      ? "cherry-pick"
      : op === "REVERT_HEAD"
        ? "revert"
        : "sequence";
}

function run(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): Promise<{ code: number; out: string; raw: string }> {
  return new Promise((done) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, maxBuffer: 64 << 20, timeout: 120_000, encoding: "latin1" },
      (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 1
          : 0;
        done({ code, out: stdout.trim(), raw: stdout });
      },
    );
    if (input !== undefined) child.stdin?.end(Buffer.from(input, "latin1"));
  });
}
