// The cut against real git: a real remote, a real `git clone --shared` as the attach makes it, real
// Worktrees.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BRANCH_NAME, cut, pathFault, type CutAnswer, type CutRequest } from "../src/cut.ts";

const LOCK = ["flock", "-x", "0"];
const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A remote with `main` and `feature/auth`, and a slot `app` cloned from it, as the attach clones. */
function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cut-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", remote]);
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "a.txt"), "a\n");
  writeFileSync(join(seed, ".gitignore"), "node_modules\n");
  run(seed, "add", ".");
  run(seed, "commit", "-qm", "first");
  run(seed, "branch", "-M", "main");
  run(seed, "push", "-q", "origin", "main");
  run(seed, "switch", "-qc", "feature/auth");
  writeFileSync(join(seed, "auth.txt"), "auth\n");
  run(seed, "add", ".");
  run(seed, "commit", "-qm", "auth");
  run(seed, "push", "-q", "origin", "feature/auth");
  run(seed, "switch", "-q", "main");
  const workRoot = join(dir, "work");
  const clone = join(workRoot, "app", "default");
  mkdirSync(join(workRoot, "app"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--shared", remote, clone]);
  const paths = { workRoot, lock: LOCK };
  const path = (name: string) => join(workRoot, "app", name);
  let ids = 0;
  const go = (req: Omit<CutRequest, "id"> & { id?: string }) => cut({ id: `e${++ids}`, base: "main", ...req }, paths);
  return { dir, workRoot, clone, remote, seed, paths, path, go };
}

const ready = (a: CutAnswer) => {
  assert.equal(a.outcome, "ready", JSON.stringify(a));
  return a as Extract<CutAnswer, { outcome: "ready" }>;
};
const refusal = (a: CutAnswer): string => {
  assert.equal(a.outcome, "refused", JSON.stringify(a));
  return (a as { reason: string }).reason;
};
const refsOf = (clone: string) => run(clone, "for-each-ref", "--format=%(refname) %(objectname)");
const worktreesOf = (clone: string) => run(clone, "worktree", "list", "--porcelain");
const configOf = (clone: string) => readFileSync(join(clone, ".git", "config"), "utf8");
/** A refusal changed nothing: refs, Worktrees, the config. */
function unchanged(clone: string) {
  const before = [refsOf(clone), worktreesOf(clone), configOf(clone)];
  return () => assert.deepEqual([refsOf(clone), worktreesOf(clone), configOf(clone)], before);
}

// --- The name rule -----------------------------------------------------------------------------------

test("the branch rule: what a cut and a push both take, in both directions", () => {
  for (const good of ["fix", "fix/one", "feature/auth-2", "a.b", "v1.2", "UPPER_case"]) {
    assert.ok(BRANCH_NAME.test(good), good);
  }
  for (const bad of [
    "-f",
    "a/-b",
    "HEAD",
    "origin/x",
    "refs/heads/x",
    "x.lock",
    "x.lock/y",
    "a//b",
    "a..b",
    "/a",
    "a/",
    "a.",
    ".a",
    "a/.b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "@",
    "@{x}",
    "",
    "deadbeef",
    "a".repeat(0),
  ]) {
    assert.ok(!BRANCH_NAME.test(bad), JSON.stringify(bad));
  }
});

test("the path rule: exactly /work/<slot>/<name>", () => {
  assert.equal(pathFault("/work/app/fix", "/work"), undefined);
  for (const bad of [
    "/work/app",
    "/work/app/",
    "/work/app/a/b",
    "/work/app/default",
    "/work/app/.x",
    "/work/app/-x",
    "/work/app/../docs",
    "/work/../app/x",
    "/elsewhere/app/x",
    "work/app/x",
    7,
  ]) {
    assert.ok(pathFault(bad, "/work") !== undefined, String(bad));
  }
});

// --- The resolve order -------------------------------------------------------------------------------

test("a new branch: from the Orchestrator's base, no upstream, default/ stays", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("run"), branch: "fix/one" }));
  assert.equal(a.found, "none");
  assert.equal(a.branch, "fix/one", "the slash stays on the branch, and the folder is the constant word");
  assert.equal(a.path, w.path("run"));
  assert.throws(() => run(a.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "no upstream");
  assert.equal(run(w.clone, "symbolic-ref", "--short", "HEAD"), "main");
});

test("a remote branch with a slash: tracked", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("run"), branch: "feature/auth" }));
  assert.equal(a.found, "remote");
  assert.equal(run(a.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/auth");
  assert.ok(existsSync(join(a.path, "auth.txt")));
});

test("the fetch comes first: a branch pushed after the clone resolves as remote", async (t) => {
  const w = world(t);
  run(w.seed, "switch", "-qc", "late/one");
  run(w.seed, "push", "-q", "origin", "late/one");
  assert.equal(ready(await w.go({ path: w.path("run"), branch: "late/one" })).found, "remote");
});

test("a local branch resolves first, and `from` starts a new one", async (t) => {
  const w = world(t);
  run(w.clone, "branch", "mine", "origin/feature/auth");
  assert.equal(ready(await w.go({ path: w.path("a"), branch: "mine" })).found, "local");
  const b = ready(await w.go({ path: w.path("b"), branch: "other", from: "feature/auth" }));
  assert.equal(b.head, run(w.clone, "rev-parse", "origin/feature/auth"));
});

test("a base by origin first: the frozen local main is not the base (a remote that moved)", async (t) => {
  const w = world(t);
  writeFileSync(join(w.seed, "new.txt"), "n\n");
  run(w.seed, "add", ".");
  run(w.seed, "commit", "-qm", "moved");
  run(w.seed, "push", "-q", "origin", "main");
  const a = ready(await w.go({ path: w.path("run"), branch: "fresh" }));
  assert.ok(existsSync(join(a.path, "new.txt")));
  assert.equal(a.head, run(w.seed, "rev-parse", "main"));
});

test("a base that is a tag: a cut with no `from` works", async (t) => {
  const w = world(t);
  run(w.seed, "tag", "v3");
  run(w.seed, "push", "-q", "origin", "v3");
  const a = ready(await w.go({ path: w.path("run"), branch: "fix", base: "v3" }));
  assert.equal(a.head, run(w.seed, "rev-parse", "v3"));
});

test("a Binding's base is no branch name: a tag with `+`, a ref with `@`, a full ref", async (t) => {
  const w = world(t);
  run(w.seed, "tag", "v1.2.3+build");
  run(w.seed, "tag", "rel@2");
  run(w.seed, "push", "-q", "origin", "--tags");
  const sha = run(w.seed, "rev-parse", "main");
  const bases = ["v1.2.3+build", "rel@2", "refs/tags/v1.2.3+build"];
  for (const [i, base] of bases.entries()) {
    assert.equal(ready(await w.go({ path: w.path(`run${i}`), branch: `fix${i}`, base })).head, sha);
    assert.equal(ready(await w.go({ path: w.path(`look${i}`), detach: sha, base })).head, sha);
  }
  assert.match(refusal(await w.go({ path: w.path("bad"), branch: "fix+1" })), /not a branch name/);
  assert.match(refusal(await w.go({ path: w.path("bad"), branch: "bad", from: "v1.2.3+build" })), /for `from`/);
});

test("`from` a branch that a Worktree holds: its tip, not its last push; `main` stays by origin", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("run"), branch: "run" }));
  writeFileSync(join(a.path, "x.txt"), "x\n");
  run(a.path, "add", ".");
  run(a.path, "commit", "-qm", "pushed");
  run(a.path, "push", "-q", "origin", "run");
  writeFileSync(join(a.path, "y.txt"), "y\n");
  run(a.path, "add", ".");
  run(a.path, "commit", "-qm", "not pushed");
  const tip = run(a.path, "rev-parse", "HEAD");
  assert.equal(ready(await w.go({ path: w.path("next"), branch: "next", from: "run" })).head, tip);
  run(w.seed, "commit", "-q", "--allow-empty", "-m", "moved");
  run(w.seed, "push", "-q", "origin", "main");
  const moved = run(w.seed, "rev-parse", "HEAD");
  assert.equal(ready(await w.go({ path: w.path("from-main"), branch: "from-main", from: "main" })).head, moved);
});

test("an Agent's checkout in default/ does not move the base", async (t) => {
  const w = world(t);
  run(w.clone, "checkout", "-q", "feature/auth");
  const a = ready(await w.go({ path: w.path("run"), branch: "fix" }));
  assert.ok(!existsSync(join(a.path, "auth.txt")), "the base is what the Orchestrator sent");
  run(w.clone, "checkout", "-q", "main");
  run(w.clone, "checkout", "-q", "-b", "rel-local", "origin/feature/auth");
  assert.equal(ready(await w.go({ path: w.path("b"), branch: "fix2" })).found, "none");
});

// --- `expect` ----------------------------------------------------------------------------------------

test("expect: new refuses an existing local or remote branch, and it is idempotent on its own path", async (t) => {
  const w = world(t);
  const same = unchanged(w.clone);
  assert.match(refusal(await w.go({ path: w.path("a"), branch: "feature/auth", expect: "new" })), /exists/);
  same();
  run(w.clone, "branch", "mine");
  assert.match(refusal(await w.go({ path: w.path("b"), branch: "mine", expect: "new" })), /exists/);
  const first = ready(await w.go({ path: w.path("c"), branch: "fresh", expect: "new" }));
  assert.equal(first.found, "none");
  const again = ready(await w.go({ path: w.path("c"), branch: "fresh", expect: "new" }));
  assert.equal(again.found, "held");
});

test("expect: existing refuses a typo, twice, because it makes nothing", async (t) => {
  const w = world(t);
  const same = unchanged(w.clone);
  assert.match(
    refusal(await w.go({ path: w.path("a"), branch: "feature/atuh", expect: "existing" })),
    /does not exist/,
  );
  assert.match(
    refusal(await w.go({ path: w.path("a"), branch: "feature/atuh", expect: "existing" })),
    /does not exist/,
  );
  same();
  assert.equal(ready(await w.go({ path: w.path("a"), branch: "feature/auth", expect: "existing" })).found, "remote");
});

// --- Idempotence, and `found` ---------------------------------------------------------------------------

test("idempotent: a second cut keeps the commits, and says held", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("run"), branch: "fix/one" }));
  writeFileSync(join(a.path, "b.txt"), "b\n");
  run(a.path, "add", ".");
  run(a.path, "commit", "-qm", "work");
  const head = run(a.path, "rev-parse", "HEAD");
  const b = ready(await w.go({ path: w.path("run"), branch: "fix/one" }));
  assert.equal(b.found, "held");
  assert.equal(b.head, head);
});

test("a re-send of one Effect answers the first `found`: a restart is not resumed work", async (t) => {
  const w = world(t);
  const first = ready(await w.go({ id: "same", path: w.path("run"), branch: "fix" }));
  const resent = ready(await w.go({ id: "same", path: w.path("run"), branch: "fix" }));
  assert.equal(first.found, "none");
  assert.equal(resent.found, "none");
  assert.equal(ready(await w.go({ id: "other", path: w.path("run"), branch: "fix" })).found, "held");
});

test("a re-cut with another `from` or branch is refused, and an existing branch not at `from`", async (t) => {
  const w = world(t);
  const sha0 = run(w.clone, "rev-parse", "origin/main");
  const auth = run(w.clone, "rev-parse", "origin/feature/auth");
  ready(await w.go({ path: w.path("rev"), branch: "rev", from: sha0 }));
  const same = unchanged(w.clone);
  assert.match(refusal(await w.go({ path: w.path("rev"), branch: "rev", from: auth })), /was cut from/);
  assert.match(refusal(await w.go({ path: w.path("rev"), branch: "other" })), /was cut for rev/);
  assert.match(refusal(await w.go({ path: w.path("hot"), branch: "feature/auth", from: sha0 })), /not at `from`/);
  same();
  ready(await w.go({ path: w.path("hot"), branch: "feature/auth", from: auth }));
});

test("`head` is the tip of the recorded branch, not HEAD", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("mov"), branch: "mov" }));
  run(a.path, "switch", "-qc", "elsewhere", "origin/feature/auth");
  const b = ready(await w.go({ path: w.path("mov"), branch: "mov" }));
  assert.equal(b.branch, "mov");
  assert.equal(b.head, a.head);
});

// --- An Agent's own Worktree ----------------------------------------------------------------------------

test("an Agent's own Worktree survives: no record, no removal, whatever mark it writes", async (t) => {
  const w = world(t);
  const p = w.path("scratch");
  run(w.clone, "worktree", "add", "-q", "-b", "scratch", p, "origin/main");
  writeFileSync(join(p, "notes.txt"), "two hours of work, not committed\n");
  const a = ready(await w.go({ path: p, branch: "scratch" }));
  assert.equal(a.found, "held");
  assert.ok(existsSync(join(p, "notes.txt")));
  const q = w.path("other");
  run(w.clone, "worktree", "add", "-q", "-b", "other", q, "origin/main");
  writeFileSync(join(q, "notes.txt"), "x\n");
  assert.match(refusal(await w.go({ path: q, detach: a.head })), /forces only its own/);
  assert.match(refusal(await w.go({ path: q, branch: "nope" })), /holds other/);
  assert.ok(existsSync(join(q, "notes.txt")));
});

test("a folder with no Worktree in it is refused and kept", async (t) => {
  const w = world(t);
  mkdirSync(w.path("dir"));
  writeFileSync(join(w.path("dir"), "f"), "x\n");
  assert.match(refusal(await w.go({ path: w.path("dir"), branch: "x" })), /a folder and no Worktree/);
  assert.ok(existsSync(join(w.path("dir"), "f")));
});

test("an Agent removed the folder: the record brings the branch back; a stray entry does not block", async (t) => {
  const w = world(t);
  ready(await w.go({ path: w.path("gone"), branch: "gone" }));
  rmSync(w.path("gone"), { recursive: true });
  const a = ready(await w.go({ path: w.path("gone"), branch: "gone" }));
  assert.equal(a.found, "local");
  assert.ok(existsSync(join(a.path, "a.txt")));
  run(w.clone, "worktree", "add", "-q", "-b", "own", w.path("own"), "origin/main");
  rmSync(w.path("own"), { recursive: true });
  assert.equal(ready(await w.go({ path: w.path("own"), branch: "own" })).found, "local");
});

// --- A kill -----------------------------------------------------------------------------------------

/** What a kill leaves at a chosen step, written as the cut writes it. */
function dead(w: ReturnType<typeof world>, name: string, branch: string, made: Record<string, boolean>, start: string) {
  mkdirSync(join(w.clone, ".git", "jr2-cuts"), { recursive: true });
  writeFileSync(
    join(w.clone, ".git", "jr2-cuts", `${name}.json`),
    JSON.stringify({ state: "cutting", id: "dead", path: w.path(name), branch, found: "none", start, made }),
  );
}

test("a kill during `worktree add`: the locked entry, the folder and the branch go, and `found` stays true", async (t) => {
  const w = world(t);
  const sha = run(w.clone, "rev-parse", "origin/main");
  run(w.clone, "worktree", "add", "-q", "--no-checkout", "--no-track", "-b", "k", w.path("k"), "origin/main");
  const admin = run(w.path("k"), "rev-parse", "--absolute-git-dir");
  writeFileSync(join(admin, "locked"), "initializing\n");
  dead(w, "k", "k", { folder: true, branch: true }, sha);
  const a = ready(await w.go({ path: w.path("k"), branch: "k" }));
  assert.equal(a.found, "none", "nothing was resumed");
  assert.ok(existsSync(join(a.path, "a.txt")));
});

test("real kills, at random steps: the retry is always `none`, and the Worktree is whole", async (t) => {
  const w = world(t);
  const cutProgram = fileURLToPath(new URL("../src/cut.ts", import.meta.url));
  for (let i = 0; i < 12; i++) {
    const req = JSON.stringify({ id: `k${i}`, path: w.path(`k${i}`), branch: `k${i}`, base: "main" });
    const p = spawn(process.execPath, [cutProgram, req], {
      env: { ...process.env, JR2_CUT_WORK: w.workRoot, JR2_CUT_LOCK: JSON.stringify(LOCK) },
      stdio: "ignore",
    });
    const closed = new Promise((r) => p.on("close", r));
    await new Promise((r) => setTimeout(r, 60 + i * 12));
    p.kill("SIGKILL");
    await closed;
    const a = ready(await w.go({ path: w.path(`k${i}`), branch: `k${i}` }));
    // A kill that came after the record says done is a first cut that finished: `held` is true then.
    assert.ok(a.found === "none" || a.found === "held", a.found);
    assert.ok(existsSync(join(a.path, "a.txt")), `try ${i}`);
  }
});

// --- `refused` changes nothing ------------------------------------------------------------------------

test("a held config.lock: a tracked cut retries, is refused, and keeps no branch; the retry is `remote`", async (t) => {
  const w = world(t);
  writeFileSync(join(w.clone, ".git", "config.lock"), "");
  const same = unchanged(w.clone);
  const r = refusal(await w.go({ path: w.path("run"), branch: "feature/auth" }));
  assert.match(r, /lock/);
  same();
  rmSync(join(w.clone, ".git", "config.lock"));
  const a = ready(await w.go({ path: w.path("run"), branch: "feature/auth" }));
  assert.equal(a.found, "remote");
  assert.equal(run(a.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/auth");
});

test("a lock that goes away during the cut: the cut waits it out", async (t) => {
  const w = world(t);
  const lock = join(w.clone, ".git", "config.lock");
  writeFileSync(lock, "");
  setTimeout(() => rmSync(lock), 150);
  assert.equal(ready(await w.go({ path: w.path("run"), branch: "feature/auth" })).found, "remote");
});

test("a D/F conflict: `run` then `run/a` is refused, and changes nothing", async (t) => {
  const w = world(t);
  ready(await w.go({ path: w.path("target"), branch: "run" }));
  const same = unchanged(w.clone);
  const r = refusal(await w.go({ path: w.path("one"), branch: "run/a" }));
  assert.match(r, /run/);
  same();
});

test("one bad word damages nothing", async (t) => {
  const w = world(t);
  const same = unchanged(w.clone);
  for (const branch of ["-f", "HEAD", "origin/main", "x.lock", "bad..name", "a//b", "--orphan"]) {
    assert.match(refusal(await w.go({ path: w.path("x"), branch })), /not a branch name/, branch);
  }
  assert.match(refusal(await w.go({ path: w.path("x"), branch: "x", from: "--orphan" })), /for `from`/);
  assert.match(refusal(await w.go({ path: w.path("x"), detach: "--orphan" })), /for `detach`/);
  assert.match(refusal(await w.go({ path: w.path("x"), detach: "" })), /for `detach`/);
  assert.match(refusal(await w.go({ path: w.path("x"), branch: "" })), /not a branch name/);
  assert.match(refusal(await w.go({ path: w.path("x") })), /names a branch or a commit/);
  assert.match(refusal(await w.go({ path: w.path("x"), branch: "b", detach: "main" })), /names a branch or a commit/);
  assert.match(refusal(await w.go({ path: w.path("x"), detach: "main", from: "main" })), /takes no `from`/);
  assert.match(refusal(await w.go({ path: w.path("default"), branch: "x" })), /the clone/);
  assert.match(refusal(await w.go({ path: join(w.workRoot, "nope", "x"), branch: "x" })), /no Repo Slot/);
  assert.match(refusal(await w.go({ path: w.path("x"), branch: "main" })), /holds main/);
  assert.match(refusal(await w.go({ path: w.path("x"), branch: "b", from: "nope" })), /no commit/);
  same();
  run(w.clone, "branch", "origin/main");
  ready(await w.go({ path: w.path("honest"), branch: "honest" }));
});

test("two Worktrees cannot hold one branch: the refusal names the holder", async (t) => {
  const w = world(t);
  ready(await w.go({ path: w.path("a"), branch: "one" }));
  assert.match(refusal(await w.go({ path: w.path("b"), branch: "one" })), /holds one/);
});

// --- A detached cut ------------------------------------------------------------------------------------

test("a detached cut is forced from its own record, whatever HEAD an Agent left", async (t) => {
  const w = world(t);
  const coder = ready(await w.go({ path: w.path("fix"), branch: "fix" }));
  writeFileSync(join(coder.path, "b.txt"), "b\n");
  run(coder.path, "add", ".");
  run(coder.path, "commit", "-qm", "round 1");
  const r1 = run(coder.path, "rev-parse", "HEAD");
  const first = ready(await w.go({ path: w.path("review"), detach: r1 }));
  assert.equal(first.branch, null);
  assert.equal(first.found, "commit");
  run(first.path, "switch", "-qc", "look-around");
  writeFileSync(join(first.path, "rogue.txt"), "x\n");
  writeFileSync(join(first.path, "a.txt"), "changed\n");
  writeFileSync(coder.path + "/c.txt", "c\n");
  run(coder.path, "add", ".");
  run(coder.path, "commit", "-qm", "round 2");
  const r2 = run(coder.path, "rev-parse", "HEAD");
  const next = ready(await w.go({ path: w.path("review"), detach: r2 }));
  assert.equal(next.head, r2);
  assert.ok(!existsSync(join(first.path, "rogue.txt")));
  assert.equal(run(first.path, "status", "--porcelain"), "");
  assert.throws(() => run(first.path, "symbolic-ref", "-q", "HEAD"), "detached");
  run(first.path, "checkout", "-q", "--detach", `${r2}~1`);
  assert.equal(ready(await w.go({ path: w.path("review"), detach: r2 })).head, r2);
});

test("a kill left a lock in a forced seat: the next cut still forces it", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("rev"), detach: "main" }));
  writeFileSync(join(run(a.path, "rev-parse", "--absolute-git-dir"), "index.lock"), "");
  assert.equal(ready(await w.go({ path: w.path("rev"), detach: "main" })).head, a.head);
});

test("a detached cut keeps ignored files, removes a nested repo, and leaves no half merge", async (t) => {
  const w = world(t);
  const sha = run(w.clone, "rev-parse", "origin/main");
  const a = ready(await w.go({ path: w.path("review"), detach: sha }));
  mkdirSync(join(a.path, "node_modules"));
  writeFileSync(join(a.path, "node_modules", "x.js"), "x\n");
  execFileSync("git", ["init", "-q", join(a.path, "rogue")]);
  writeFileSync(join(a.path, "rogue", "file"), "rogue\n");
  run(join(a.path, "rogue"), "add", ".");
  run(join(a.path, "rogue"), "commit", "-qm", "r");
  const admin = run(a.path, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(admin, "rebase-merge"));
  writeFileSync(join(admin, "MERGE_HEAD"), `${sha}\n`);
  ready(await w.go({ path: w.path("review"), detach: sha }));
  assert.ok(existsSync(join(a.path, "node_modules", "x.js")), "a reviewer runs the tests");
  assert.ok(!existsSync(join(a.path, "rogue")));
  assert.ok(!existsSync(join(admin, "rebase-merge")));
  assert.ok(!existsSync(join(admin, "MERGE_HEAD")));
});

test("a detached cut of a commit this clone lacks fetches; a commit nobody has is refused", async (t) => {
  const w = world(t);
  writeFileSync(join(w.seed, "n.txt"), "n\n");
  run(w.seed, "add", ".");
  run(w.seed, "commit", "-qm", "n");
  run(w.seed, "push", "-q", "origin", "main");
  const sha = run(w.seed, "rev-parse", "HEAD");
  assert.equal(ready(await w.go({ path: w.path("r"), detach: sha })).head, sha);
  assert.match(refusal(await w.go({ path: w.path("q"), detach: "f".repeat(40) })), /no commit/);
});

// --- No hook, no filter, no held lock ---------------------------------------------------------------

test("no hook and no smudge filter runs; a background hook holds no lock", async (t) => {
  const w = world(t);
  const hooks = join(w.clone, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const seen = join(w.dir, "ran");
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${seen}\n(sleep 6) &\nexit 0\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  run(w.clone, "config", "filter.evil.smudge", `sh -c 'echo smudge >> ${seen}; cat'`);
  run(w.clone, "config", "filter.evil.required", "true");
  writeFileSync(join(w.seed, ".gitattributes"), "*.txt filter=evil\n");
  run(w.seed, "add", ".");
  run(w.seed, "commit", "-qm", "attrs");
  run(w.seed, "push", "-q", "origin", "main");
  const at = Date.now();
  ready(await w.go({ path: w.path("h1"), branch: "h1" }));
  ready(await w.go({ path: w.path("h2"), branch: "h2" }));
  assert.ok(Date.now() - at < 4000, "a hook held nothing");
  assert.ok(!existsSync(seen), `ran: ${existsSync(seen) ? readFileSync(seen, "utf8") : ""}`);
});

// --- `stale`, through a real ext:: program ---------------------------------------------------------------

/** The program behind `origin`'s fetch url, as ADR-0053 has it: it warns, exits 0 by way of the
 * cache, and takes `wait` seconds for the ask. A file turns the remote down. */
function extRemote(w: ReturnType<typeof world>, wait = 0) {
  const down = join(w.dir, "down");
  const asks = join(w.dir, "asks");
  const program = join(w.dir, "fake-upload-pack");
  writeFileSync(
    program,
    `#!/bin/sh
echo ask >> ${asks}
if [ -e ${down} ]; then
  sleep ${wait}
  echo "warning: jr2: remote fetch failed (could not read from remote); serving the cache as of 2026-10-31T00:00:00Z" >&2
fi
unset GIT_DIR
case "$1" in git-upload-pack) exec git upload-pack ${w.remote} ;; esac
`,
  );
  chmodSync(program, 0o755);
  run(w.clone, "remote", "set-url", "origin", `ext::${program} %S github.com/acme/app`);
  run(w.clone, "config", "protocol.ext.allow", "user");
  return {
    down: () => writeFileSync(down, ""),
    up: () => rmSync(down),
    asks: () => (existsSync(asks) ? readFileSync(asks, "utf8").trim().split("\n").length : 0),
  };
}

test("a remote that is up: no `stale`, through the ext:: transport", async (t) => {
  const w = world(t);
  extRemote(w);
  const a = ready(await w.go({ path: w.path("run"), branch: "fix" }));
  assert.equal(a.found, "none");
  assert.equal(a.stale, undefined);
});

test("a dead remote exits 0 with a warning: an unknown name is refused, never `none`", async (t) => {
  const w = world(t);
  const remote = extRemote(w);
  remote.down();
  const same = unchanged(w.clone);
  const r = refusal(await w.go({ path: w.path("run"), branch: "fix" }));
  assert.match(r, /may exist there/);
  assert.match(r, /could not read from remote/);
  assert.match(refusal(await w.go({ path: w.path("run"), branch: "fix", expect: "existing" })), /may exist there/);
  same();
});

test("a dead remote: a known name resolves, and says stale", async (t) => {
  const w = world(t);
  const remote = extRemote(w);
  remote.down();
  const a = ready(await w.go({ path: w.path("run"), branch: "feature/auth" }));
  assert.equal(a.found, "remote");
  assert.match(a.stale ?? "", /could not read from remote.*as of 2026/);
});

test("N cuts on a dead remote ask once in the window, and a remote that came back is asked after it", async (t) => {
  const w = world(t);
  const remote = extRemote(w, 1);
  remote.down();
  run(w.clone, "branch", "k0", "origin/main");
  for (let i = 0; i < 6; i++) run(w.clone, "branch", `k${i + 1}`, "origin/main");
  const at = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => w.go({ path: w.path(`k${i}`), branch: `k${i}` })));
  const took = Date.now() - at;
  assert.equal(remote.asks(), 2, "one fetch and one more, under the lock, for all six");
  assert.ok(took < 5000, `${took} ms`);
  const short = { ...w.paths, staleWindowMs: 0 };
  remote.up();
  const a = ready(await cut({ id: "after", path: w.path("after"), branch: "after", base: "main" }, short));
  assert.equal(a.stale, undefined);
  assert.equal(a.found, "none");
  assert.equal(remote.asks(), 3);
});

for (const [what, text] of [
  ["empty", ""],
  ["broken", '{"at":'],
] as const) {
  test(`a stale memo that a kill left ${what} is no memo: the cut asks the remote`, async (t) => {
    const w = world(t);
    const memo = join(w.clone, ".git", "jr2-cut-stale.json");
    writeFileSync(memo, text);
    const a = ready(await w.go({ path: w.path("run"), branch: "fix" }));
    assert.equal(a.found, "none");
    assert.equal(a.stale, undefined);
    assert.ok(!existsSync(memo), "the fetch that answered removes it");
  });
}

test("a slow cache: the second ask lands, and a new name is `none`, not refused", async (t) => {
  const w = world(t);
  const remote = extRemote(w);
  remote.down();
  setTimeout(() => remote.up(), 0);
  // The first ask warns while `down` stands; the program reads it at its start, so turn it off after.
  const flip = join(w.dir, "flip");
  writeFileSync(flip, "");
  const program = (await import("node:fs")).readFileSync(join(w.dir, "fake-upload-pack"), "utf8");
  writeFileSync(
    join(w.dir, "fake-upload-pack"),
    program.replace(
      "fi\nunset GIT_DIR",
      `fi\nif [ -e ${flip} ]; then rm ${flip}; echo "warning: jr2: remote fetch failed (timed out waiting for the node cache); serving the cache as of now" >&2; fi\nunset GIT_DIR`,
    ),
  );
  const a = ready(await w.go({ path: w.path("run"), branch: "brand-new" }));
  assert.equal(a.found, "none");
  assert.equal(a.stale, undefined);
});

test("a lock race is not a dead remote: a cut retries beside an Agent's fetches, on a moving remote", async (t) => {
  const w = world(t);
  let stale = 0;
  let failed = 0;
  for (let r = 0; r < 12; r++) {
    run(w.seed, "commit", "-q", "--allow-empty", "-m", `m${r}`);
    run(w.seed, "push", "-q", "origin", "main");
    const agents = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((done) => {
          spawn("git", ["-C", w.clone, "fetch", "-q", "origin"], { stdio: "ignore" }).on("close", () => done());
        }),
    );
    const a = await w.go({ path: w.path(`c${r}`), branch: `c${r}` });
    await Promise.all(agents);
    if (a.outcome !== "ready") failed++;
    else if (a.stale) stale++;
  }
  assert.equal(stale, 0, "a remote that is fine is never stale");
  assert.equal(failed, 0);
});

// --- Serialized, across real processes ---------------------------------------------------------------

test("eight cuts at once, as eight processes: serialized, and all whole", async (t) => {
  const w = world(t);
  const cutProgram = fileURLToPath(new URL("../src/cut.ts", import.meta.url));
  const one = (i: number) =>
    new Promise<CutAnswer>((resolve) => {
      const req = JSON.stringify({ id: `p${i}`, path: w.path(`p${i}`), branch: `crew/${i}`, base: "main" });
      const p = spawn(process.execPath, [cutProgram, req], {
        env: { ...process.env, JR2_CUT_WORK: w.workRoot, JR2_CUT_LOCK: JSON.stringify(LOCK) },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      p.stdout.on("data", (d) => (out += String(d)));
      p.on("close", () => resolve(JSON.parse(out.trim()) as CutAnswer));
    });
  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
  for (const a of answers) assert.ok(existsSync(join(ready(a).path, "a.txt")));
});

test("two cuts of one path at once: one Worktree, and neither fails", async (t) => {
  const w = world(t);
  const [a, b] = await Promise.all([
    w.go({ path: w.path("run"), branch: "shared" }),
    w.go({ path: w.path("run"), branch: "shared" }),
  ]);
  assert.deepEqual([ready(a).found, ready(b).found].sort(), ["held", "none"]);
});

test("commits in two Worktrees at once: each lands, and a merge needs no fetch", async (t) => {
  const w = world(t);
  const a = ready(await w.go({ path: w.path("a"), branch: "crew/a" }));
  const b = ready(await w.go({ path: w.path("b"), branch: "crew/b" }));
  const c = ready(await w.go({ path: w.path("c"), branch: "merge" }));
  writeFileSync(join(a.path, "a2.txt"), "1\n");
  writeFileSync(join(b.path, "b2.txt"), "2\n");
  run(a.path, "add", ".");
  run(b.path, "add", ".");
  run(a.path, "commit", "-qm", "a");
  run(b.path, "commit", "-qm", "b");
  run(c.path, "merge", "--no-edit", "crew/a");
  run(c.path, "merge", "--no-edit", "crew/b");
  assert.ok(existsSync(join(c.path, "a2.txt")) && existsSync(join(c.path, "b2.txt")));
});

test("the lock program's flock frees when the cut dies", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const file = join(dir, "l");
  writeFileSync(file, "");
  const r = spawnSync("sh", ["-c", `flock -x 0 < ${file}; flock -n -x 0 < ${file}; echo $?`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "0");
  rmSync(dir, { recursive: true, force: true });
});
