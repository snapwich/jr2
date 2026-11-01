// The attach (ADR-0063): the post-Ready step that puts a Workspace's Repos into `/work`
// (ADR-0004, ADR-0051), run HERE, in the Harness container, on `POST /attach`. It was a shell
// script the Orchestrator ran over `kubectl exec`; the effect is unchanged, step for step — per
// Repo Slot, in declaration order:
//
//   1. `mkdir <work>/<slot>` and stamp ADR-0005's default ACL on it (`work-acl`), BEFORE the clone
//      fills it: a default ACL is inherited at creation, never retrofitted.
//   2. `git clone --shared /repos/<key> <slot>/default` — pod-local, borrowing objects from the
//      node's read-only cache.
//   3. Place `default/` on the Binding's base, once. A Machine cuts every
//      other Worktree with `worktree()` (cut.ts).
//   4. origin's fetch url → the node cache program (ADR-0053), its push url → the real remote
//      (ADR-0005), `protocol.ext.allow user`, and `gc.auto=0` with `maintenance.auto=false`.
//
// Every step is guarded or naturally idempotent, so a second attach (a restarted Orchestrator,
// ADR-0012) finds everything present and answers the same paths. As a child of the Harness it
// inherits the process's `umask 002` (startup.ts), which the exec'd script had to set itself.
// Each step runs git directly — no shell — so a hostile ref or url is an argument, never syntax,
// and a failure names its slot, its step, and git's own stderr.

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import type { AttachRequest, AttachResponse, AttachSlot } from "./wire.ts";

/** Where the attach reads and writes, as the operator composes the pod (ADR-0004, ADR-0037,
 * ADR-0051): the work volume, the node caches' mount, and the runtime volume. */
export type AttachPaths = { workRoot: string; reposMount: string; runtime: string };

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
 * each see it absent and the second `git clone` would fail on the first's directory. `env` is a
 * seam for the tests (a sealed git config); production inherits the process's.
 */
export function attacher(opts: { paths?: AttachPaths; env?: NodeJS.ProcessEnv } = {}) {
  const paths = opts.paths ?? POD_PATHS;
  let queue: Promise<unknown> = Promise.resolve();
  return (req: AttachRequest): Promise<AttachResponse> => {
    const run = queue.then(() => attach(req, paths, opts.env));
    queue = run.catch(() => {});
    return run;
  };
}

async function attach(req: AttachRequest, paths: AttachPaths, env?: NodeJS.ProcessEnv): Promise<AttachResponse> {
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

    await mkdir(slotDir, { recursive: true });
    // On a filesystem without POSIX ACLs the helper warns and exits 0, degrading to the umask.
    await run("stamp the work ACL", s.slot, `${paths.runtime}/bin/work-acl`, [slotDir], env);
    if (!(await exists(`${dflt}/.git`))) {
      await git("git clone --shared", s.slot, ["clone", "--shared", "--", cache, dflt]);
    }
    // A guard, so that a second attach changes nothing: an Agent's edit in `default/`, or a fetch that
    // moved the remote-tracking refs, is no reason for a checkout here (SandboxPort: idempotent).
    bases[s.slot] = await placeDefault(dflt, s, env);
    // Fetch/push split (ADR-0005). The FETCH url is a command, not a path (ADR-0053): git's
    // built-in `ext::` transport runs the program on the runtime volume, which asks the node cache
    // to fetch the remote, waits for the landing, then serves the cache — so every fetch inside the
    // pod is a fetch of the remote's now. The url's argument is the Repo's IDENTITY, never the
    // cache key: that is the name a human reads in `git remote -v`. `git push` goes to the REAL
    // remote — the Binding's own spelling (ADR-0051). `--` keeps the url an operand.
    await git("set origin's fetch url", s.slot, ["-C", dflt, "remote", "set-url", "origin", "--", fetchUrl(s, paths)]);
    await git("set origin's push url", s.slot, ["-C", dflt, "remote", "set-url", "--push", "origin", "--", s.url]);
    // `ext` is on git's "known scary" list, default `never`. `user` allows a fetch a person or the
    // Agent runs and still refuses one git makes for itself (a submodule url), so a repository
    // cannot smuggle a program in through a url jr2 did not write (ADR-0053). Repo-level: the
    // linked worktrees share this config.
    await git("allow the ext transport", s.slot, ["-C", dflt, "config", "protocol.ext.allow", "user"]);
    // A fixed rule (ADR-0004): Agents share this clone, and a `gc` beside a cut or a commit prunes
    // what another Worktree needs. Every git in the pod reads the clone's config.
    await git("turn off gc", s.slot, ["-C", dflt, "config", "gc.auto", "0"]);
    await git("turn off maintenance", s.slot, ["-C", dflt, "config", "maintenance.auto", "false"]);
  }
  return { repos, bases };
}

/**
 * Put `default/` on the Binding's base, one time. The answer is the base that each cut sends (a
 * branch name, a tag or a commit), held in the clone's config, because an Agent can move HEAD.
 *
 * No `ref`, or a `ref` that IS the default branch: the clone's own attached branch, and nothing else.
 * Another branch: that branch, attached and tracked. A tag or a commit: detached there. In the last
 * two, the local default branch goes: it holds no work, nothing holds it, and it would freeze at the
 * clone, so a cut of it finds `origin/<default>` and tracks it.
 */
async function placeDefault(dflt: string, s: AttachSlot, env?: NodeJS.ProcessEnv): Promise<string> {
  const placed = await exec("git", ["-C", dflt, "config", "--local", "jr2.base"], env);
  if (placed.code === 0 && placed.stdout.trim() !== "") return placed.stdout.trim();
  const git = (step: string, args: string[]) => runGit(step, s.slot, ["-C", dflt, ...args], env);
  const head = await exec("git", ["-C", dflt, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], env);
  const dfltBranch = head.stdout.trim().replace(/^origin\//, "");
  const base = s.ref ?? dfltBranch;
  if (base !== dfltBranch) {
    const tracked = await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], env);
    if (tracked.code === 0) await git("check out the base", ["checkout", "--track", "-b", base, `origin/${base}`]);
    else await git("check out the base", ["checkout", "--detach", await baseOf(dflt, base, env)]);
    if (dfltBranch !== "") await git("drop the frozen default branch", ["branch", "-D", "--", dfltBranch]);
  }
  await git("record the base", ["config", "--local", "jr2.base", base]);
  return base;
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
async function baseOf(dflt: string, ref: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const remote = `refs/remotes/origin/${ref}`;
  const r = await exec("git", ["-C", dflt, "rev-parse", "--verify", "-q", remote], env);
  return r.code === 0 ? remote : ref;
}

/** A path is present — the old script's `[ -d … ] ||` guards. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function runGit(step: string, slot: string | undefined, args: string[], env?: NodeJS.ProcessEnv) {
  return run(step, slot, "git", args, env);
}

async function run(step: string, slot: string | undefined, file: string, args: string[], env?: NodeJS.ProcessEnv) {
  const r = await exec(file, args, env);
  if (r.code === 0) return;
  const said = r.stderr.trim() || r.stdout.trim() || r.error?.message || `exited ${r.code}`;
  const where = slot === undefined ? "the attach" : `the attach of slot "${slot}"`;
  throw new AttachFault(`${where} failed at ${step}: ${said}`, slot);
}

type ExecResult = { code: number | null; stdout: string; stderr: string; error?: Error };

function exec(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error == null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr, ...(error ? { error } : {}) });
    });
  });
}
