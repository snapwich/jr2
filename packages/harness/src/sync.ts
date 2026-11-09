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
//
// The repository is the Agent's, so every git call also runs in the domain (`children.ts`,
// ADR-0076): a filter or a textconv that the shared `.git/config` names runs in git's process, and
// that process never reaches the control Stand-in. The bundle is written and removed, and the
// repository's git dirs are listed and their state files read, by the spawner too, so the kernel
// applies the domain's rules to each path. The Harness process touches no path of the Agent's.

import { randomUUID } from "node:crypto";
import { runIn, type ChildPolicy } from "./children.ts";
import type { FileOps } from "./spawner.ts";
import { isAbsolute, join, resolve } from "node:path";
import type { SyncAnswer, SyncRequest } from "./wire.ts";

/** The config every sync git call gets: nothing the Agent's repository names runs, and no index of
 * commits or objects that an Agent can write changes what git reads. A commit-graph gives each
 * commit its tree, its parents and its generation, and a multi-pack-index gives each object its
 * place in a pack; git 2.56 reads both without a check of the object's hash, so a forged file in
 * `objects/info` or `objects/pack` gives a commit another tree. With them off, git reads each commit
 * from its object. */
const CLEAN = [
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
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

/** A full commit id: sha-1 or sha-256, as the Effector's pairs are. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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
 * its ref. `children` is the domain, where its git runs (ADR-0076).
 */
export function syncer(opts: SyncSeams & { children: ChildPolicy }) {
  let queue: Promise<unknown> = Promise.resolve();
  return (req: SyncRequest): Promise<SyncAnswer> => {
    const run = queue.then(() => sync(req, opts));
    queue = run.catch(() => {});
    return run;
  };
}

async function sync(req: SyncRequest, seams: SyncSeams & { children: ChildPolicy }): Promise<SyncAnswer> {
  if (req.published === req.source)
    return { sync: "skipped", reason: "the push published your own commit: nothing to move" };
  // The bundle is in the domain's TMPDIR, written and at the end removed by the spawner, and its git
  // reads it there (ADR-0076). Its git reads no global config (`GIT_CONFIG_GLOBAL`), so its HOME is
  // the domain's own.
  let bundle: string | undefined;
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: seams.children.env.HOME ?? "/nonexistent",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...seams.env,
    };
    const git = (args: string[], input?: string) => run(seams.children, req.worktree, env, [...CLEAN, ...args], input);
    const ref = `refs/heads/${req.branch}`;

    if (req.bundle !== undefined) {
      const file = join(seams.children.env.TMPDIR ?? "/tmp", `jr2-sync-${randomUUID()}.bundle`);
      bundle = file;
      try {
        await seams.children.spawner.write(file, Buffer.from(req.bundle, "base64"));
      } catch {
        return { sync: "not-synced", reason: "the published commits' bundle could not be written in your TMPDIR" };
      }
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
    const busy = await busyWith(req, git, seams.children.spawner);
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
    // An unlink removes the name, never what a link there names.
    if (bundle !== undefined) await seams.children.spawner.unlink(bundle).catch(() => {});
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
 * worktree whose HEAD is it. Listed and read as files in the repository's git dirs, by the
 * spawner: the Harness touches no path there itself. */
async function busyWith(
  req: SyncRequest,
  git: (args: string[]) => Promise<{ code: number; out: string }>,
  files: FileOps,
): Promise<string | undefined> {
  const common = resolve(req.worktree, (await git(["rev-parse", "--git-common-dir"])).out);
  const dirs = [common];
  try {
    for (const name of await files.readdir(join(common, "worktrees"))) dirs.push(join(common, "worktrees", name));
  } catch {
    // no linked worktree
  }
  const ref = `refs/heads/${req.branch}`;
  const read = async (p: string) => (await files.read(p).catch(() => Buffer.alloc(0))).toString("utf8").trim();
  const exists = (p: string) =>
    files.stat(p).then(
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

async function run(
  children: ChildPolicy,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): Promise<{ code: number; out: string; raw: string }> {
  const r = await runIn(children, ["git", ...args], {
    cwd,
    env,
    maxBuffer: 64 << 20,
    timeoutMs: 120_000,
    encoding: "latin1",
    ...(input !== undefined ? { input: Buffer.from(input, "latin1") } : {}),
  });
  const code = r.error === undefined ? 0 : typeof r.code === "number" ? r.code : 1;
  return { code, out: r.stdout.trim(), raw: r.stdout };
}
