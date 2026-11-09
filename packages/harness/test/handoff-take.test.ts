// The child's cut at a Handoff with files (ADR-0080), against real git: the parent's commits come in
// a bundle that the land process wrote to the folder of the cut's Effect id, and the cut takes only
// `head`'s closure, with fsck, into the child's clone. What git then shows the child's Agent is
// ordinary git: the real remote, an ordinary branch, the parent's commits.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { cut, type CutAnswer, type CutRequest } from "../src/cut.ts";
import { landedFolder } from "../src/handoff-land-main.ts";

const LOCK = ["flock", "-x", "0"];
const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string, text: string, message: string, author = "Coder <coder@example.test>") => {
  writeFileSync(join(cwd, file), text);
  run(cwd, "add", file);
  run(cwd, "commit", "-qm", message, `--author=${author}`);
  return run(cwd, "rev-parse", "HEAD");
};

/**
 * A remote with `main`; the parent's clone, whose `feature/auth` has two commits that the remote
 * does not have; and the child's slot `app`, cloned from the remote as the attach clones. `hand`
 * writes a bundle of the parent's range to the folder of an Effect id, as the land process does.
 */
function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-take-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", remote]);
  const parent = join(dir, "parent");
  execFileSync("git", ["clone", "-q", remote, parent], { stdio: "ignore" });
  const base = commit(parent, "a.txt", "a\n", "base");
  run(parent, "push", "-q", "origin", "HEAD:main");
  run(parent, "fetch", "-q", "origin");
  run(parent, "switch", "-qc", "feature/auth");
  const c1 = commit(parent, "b.txt", "b\n", "one");
  const head = commit(parent, "c.txt", "c\n", "two");
  const workRoot = join(dir, "work");
  const clone = join(workRoot, "app", "default");
  mkdirSync(join(workRoot, "app"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--shared", remote, clone]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const jr2Lfs = join(bin, "jr2-lfs");
  writeFileSync(jr2Lfs, `#!/bin/sh\necho '{"pointers":0,"asked":0,"missing":[]}'\n`);
  chmodSync(jr2Lfs, 0o755);
  const paths = { workRoot, lock: LOCK, gitLfs: "/nonexistent/git-lfs", jr2Lfs };
  const path = (name: string) => join(workRoot, "app", name);
  /** A bundle of the parent's `refs` (default: head as the bundle step names it), not the remote's. */
  const bundleOf = (refs: string[] = [], not = ["origin/main"]): Buffer => {
    if (refs.length === 0) {
      run(parent, "update-ref", "refs/heads/handoff", head);
      refs = ["refs/heads/handoff"];
    }
    const file = join(dir, `b-${Math.random().toString(36).slice(2)}.bundle`);
    run(parent, "bundle", "create", "-q", file, ...refs, "--not", ...not);
    return readFileSync(file);
  };
  const hand = (id: string, bundle: Buffer | null = bundleOf()): string => {
    const folder = landedFolder(workRoot, id);
    mkdirSync(join(folder, "lfs"), { recursive: true });
    if (bundle !== null) writeFileSync(join(folder, "bundle"), bundle);
    return folder;
  };
  const go = (req: Omit<CutRequest, "id"> & { id: string }) => cut({ base: "main", ...req }, paths);
  return { dir, remote, parent, base, c1, head, workRoot, clone, paths, path, bundleOf, hand, go };
}

const ready = (a: CutAnswer) => {
  assert.equal(a.outcome, "ready", JSON.stringify(a));
  return a as Extract<CutAnswer, { outcome: "ready" }>;
};
const refusal = (a: CutAnswer): string => {
  assert.equal(a.outcome, "refused", JSON.stringify(a));
  return (a as { reason: string }).reason;
};
const has = (clone: string, sha: string): boolean =>
  spawnSync("git", ["-C", clone, "cat-file", "-e", `${sha}^{object}`]).status === 0;
const refsOf = (clone: string) => run(clone, "for-each-ref", "--format=%(refname)");

test("a cut at a Handoff takes the bundle's commits, and git shows the child's Agent ordinary git", async (t) => {
  const w = world(t);
  assert.equal(has(w.clone, w.head), false, "the child's clone does not hold the parent's commits");
  const refsBefore = refsOf(w.clone);
  w.hand("e1");
  const a = ready(
    await w.go({ id: "e1", path: w.path("final"), branch: "feature/auth", handoff: w.head, expect: "new" }),
  );
  assert.deepEqual([a.branch, a.head, a.found], ["feature/auth", w.head, "handoff"]);
  // The branch has the parent's name, and git log shows the parent's commits, with their authors.
  assert.equal(run(a.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/auth");
  assert.equal(run(a.path, "log", "--format=%an %s"), "Coder two\nCoder one\nCoder base");
  assert.equal(readFileSync(join(a.path, "c.txt"), "utf8"), "c\n");
  assert.equal(run(a.path, "status", "--porcelain"), "", "a clean Worktree");
  // The real remote alone, and no ref but the branch that the cut made.
  assert.equal(run(w.clone, "remote"), "origin");
  assert.equal(run(w.clone, "remote", "get-url", "origin"), w.remote);
  assert.deepEqual(
    refsOf(w.clone).split("\n").sort(),
    [...refsBefore.split("\n"), "refs/heads/feature/auth"].sort(),
    "no refs/jr2, no bundle ref, no other remote",
  );
  assert.equal(existsSync(join(w.clone, ".git", "FETCH_HEAD")), false, "no FETCH_HEAD");
  // No upstream: the remote has no feature/auth.
  assert.equal(spawnSync("git", ["-C", a.path, "rev-parse", "--abbrev-ref", "@{upstream}"]).status, 128);
  // The landed files are gone, and so is their folder.
  assert.equal(existsSync(landedFolder(w.workRoot, "e1")), false);
  assert.equal(existsSync(join(w.workRoot, ".jr2", "handoffs")), false);
});

test("a cut at a Handoff on a branch that the remote has tracks origin/<branch>, and git status shows it ahead", async (t) => {
  const w = world(t);
  // The parent pushed one of its two commits: the remote's feature/auth is c1.
  run(w.parent, "push", "-q", "origin", `${w.c1}:refs/heads/feature/auth`);
  run(w.parent, "fetch", "-q", "origin");
  run(w.clone, "fetch", "-q", "origin");
  w.hand("e1", w.bundleOf([], ["origin/feature/auth"]));
  const a = ready(await w.go({ id: "e1", path: w.path("final"), branch: "feature/auth", handoff: w.head }));
  assert.equal(run(a.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/auth");
  assert.match(
    run(a.path, "status", "-sb").split("\n")[0]!,
    /^## feature\/auth\.\.\.origin\/feature\/auth \[ahead 1\]$/,
  );
});

test("the cut takes only head's closure: a bundle's object that head does not reach stays out of the clone", async (t) => {
  const w = world(t);
  run(w.parent, "switch", "-qc", "secret", w.base);
  const secret = commit(w.parent, "s.txt", "a secret\n", "secret");
  const blob = run(w.parent, "rev-parse", `${secret}:s.txt`);
  run(w.parent, "update-ref", "refs/heads/handoff", w.head);
  // A bundle of two refs, whose header then names only the first: its pack still holds the second.
  const two = w.bundleOf(["refs/heads/handoff", "refs/heads/secret"]);
  const text = two.toString("latin1");
  const line = `${secret} refs/heads/secret\n`;
  assert.ok(text.includes(line));
  w.hand("e1", Buffer.from(text.replace(line, ""), "latin1"));
  ready(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: w.head }));
  assert.equal(has(w.clone, w.head), true);
  assert.equal(has(w.clone, secret), false, "not the other commit");
  assert.equal(has(w.clone, blob), false, "not its blob");
});

test("a bundle with an object that fsck refuses is refused, and the object does not enter the clone", async (t) => {
  const w = world(t);
  // A commit whose author line has no date: git's fsck refuses it (badDate), and git bundle does not.
  const tree = run(w.parent, "rev-parse", `${w.head}^{tree}`);
  const raw = `tree ${tree}\nparent ${w.head}\nauthor Coder <coder@example.test> not-a-date\ncommitter Coder <coder@example.test> 1700000000 +0000\n\nforged\n`;
  const forged = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
    cwd: w.parent,
    input: raw,
    encoding: "utf8",
  }).trim();
  run(w.parent, "update-ref", "refs/heads/forged", forged);
  w.hand("e1", w.bundleOf(["refs/heads/forged"]));
  const before = refsOf(w.clone);
  const reason = refusal(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: forged }));
  assert.match(reason, new RegExp(`^git refused the Handoff's commit ${forged}: error: `));
  assert.equal(has(w.clone, forged), false, "the forged commit is not in the clone");
  assert.equal(has(w.clone, w.head), false, "nor its ancestors from the bundle");
  assert.equal(refsOf(w.clone), before);
  assert.equal(existsSync(w.path("final")), false);
  assert.equal(existsSync(landedFolder(w.workRoot, "e1")), false, "a refused cut removes the files too");
});

test("a bundle whose prerequisite the clone does not hold is refused, and the reason names the commit", async (t) => {
  const w = world(t);
  // The parent built on a commit that the remote no longer has (a force push after its fetch).
  run(w.parent, "switch", "-qc", "gone", w.base);
  const lost = commit(w.parent, "l.txt", "l\n", "lost on the remote");
  const head = commit(w.parent, "d.txt", "d\n", "built on it");
  run(w.parent, "update-ref", "refs/heads/handoff", head);
  w.hand("e1", w.bundleOf(["refs/heads/handoff"], [lost]));
  const reason = refusal(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: head }));
  assert.match(
    reason,
    new RegExp(`^this clone does not hold the commit ${lost}, which the Handoff's bundle builds on`),
  );
  assert.match(reason, /force push/);
  assert.equal(has(w.clone, head), false);
});

test("the take's upload-pack reads no commit-graph of the clone: the reason names the fsck fault", async (t) => {
  const w = world(t);
  // An Agent writes a commit-graph in the child's clone (here one with a bad signature, so that a read
  // shows), and the Handoff holds a commit that fsck refuses.
  run(w.clone, "commit-graph", "write", "--reachable");
  const graph = join(w.clone, ".git", "objects", "info", "commit-graph");
  const bytes = readFileSync(graph);
  bytes.write("XXXX", 0, "latin1");
  chmodSync(graph, 0o644);
  writeFileSync(graph, bytes);
  const tree = run(w.parent, "rev-parse", `${w.head}^{tree}`);
  const raw = `tree ${tree}\nparent ${w.head}\nauthor Coder <coder@example.test> not-a-date\ncommitter Coder <coder@example.test> 1700000000 +0000\n\nforged\n`;
  const forged = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
    cwd: w.parent,
    input: raw,
    encoding: "utf8",
  }).trim();
  run(w.parent, "update-ref", "refs/heads/forged", forged);
  w.hand("e1", w.bundleOf(["refs/heads/forged"]));
  const reason = refusal(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: forged }));
  assert.doesNotMatch(reason, /commit-graph/, "no git of the take read the clone's commit-graph");
  assert.match(reason, new RegExp(`^git refused the Handoff's commit ${forged}: error: .*badDate`));
  assert.equal(has(w.clone, forged), false);
});

test("a missing prerequisite when the remote did not answer names what the fetch said, not a force push", async (t) => {
  const w = world(t);
  // The child's clone holds its own objects, not the remote's through `--shared`.
  run(w.clone, "repack", "-qad");
  rmSync(join(w.clone, ".git", "objects", "info", "alternates"));
  // The remote's main moves on, and the parent builds on it; then the child's fetch gets no answer.
  const other = join(w.dir, "other");
  execFileSync("git", ["clone", "-q", w.remote, other], { stdio: "ignore" });
  const moved = commit(other, "m.txt", "m\n", "main moves on");
  run(other, "push", "-q", "origin", "HEAD:main");
  run(w.parent, "fetch", "-q", "origin");
  run(w.parent, "switch", "-qc", "on-moved", "origin/main");
  const head = commit(w.parent, "e.txt", "e\n", "built on the moved main");
  run(w.parent, "update-ref", "refs/heads/handoff", head);
  w.hand("e1", w.bundleOf(["refs/heads/handoff"], ["origin/main"]));
  run(w.clone, "remote", "set-url", "origin", join(w.dir, "no-such-remote.git"));
  const reason = refusal(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: head }));
  assert.match(
    reason,
    new RegExp(
      `^this clone does not hold the commit ${moved}, which the Handoff's bundle builds on, and the remote did not answer, so it may hold it: .*no-such-remote`,
    ),
  );
  assert.doesNotMatch(reason, /force push/);
});

test("a bundle whose one ref is not at head, with two refs, not a bundle, or a link is refused", async (t) => {
  const w = world(t);
  w.hand("e1");
  assert.match(
    refusal(await w.go({ id: "e1", path: w.path("f1"), branch: "r1", handoff: w.c1 })),
    new RegExp(`^the ref of the Handoff's bundle is at ${w.head}, not at ${w.c1}$`),
  );
  run(w.parent, "update-ref", "refs/heads/other", w.c1);
  w.hand("e2", w.bundleOf(["refs/heads/handoff", "refs/heads/other"]));
  w.bundleOf(); // refs/heads/handoff at head
  assert.match(
    refusal(await w.go({ id: "e2", path: w.path("f2"), branch: "r2", handoff: w.head })),
    /^the Handoff's bundle has 2 refs, and a Handoff's bundle has one$/,
  );
  w.hand("e3", Buffer.from("not a bundle\n"));
  assert.match(
    refusal(await w.go({ id: "e3", path: w.path("f3"), branch: "r3", handoff: w.head })),
    /^the Handoff's bundle cannot be read: /,
  );
  const folder = w.hand("e4", null);
  writeFileSync(join(w.dir, "elsewhere.bundle"), w.bundleOf());
  symlinkSync(join(w.dir, "elsewhere.bundle"), join(folder, "bundle"));
  assert.match(
    refusal(await w.go({ id: "e4", path: w.path("f4"), branch: "r4", handoff: w.head })),
    /^the Handoff's bundle is not a regular file$/,
  );
  for (const id of ["e1", "e2", "e3", "e4"]) assert.equal(existsSync(landedFolder(w.workRoot, id)), false, id);
  assert.equal(has(w.clone, w.head), false);
});

test("a cut at a Handoff with no files takes the commit from the remote, and refuses one that it lacks", async (t) => {
  const w = world(t);
  assert.match(
    refusal(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: w.head })),
    new RegExp(`^this clone does not hold the Handoff's commit ${w.head}$`),
  );
  run(w.parent, "push", "-q", "origin", "feature/auth");
  const a = ready(await w.go({ id: "e2", path: w.path("final"), branch: "feature/auth", handoff: w.head }));
  assert.equal(a.head, w.head);
});

test("a held re-cut does not read the files, and removes them", async (t) => {
  const w = world(t);
  w.hand("e1");
  const a = ready(await w.go({ id: "e1", path: w.path("final"), branch: "review", handoff: w.head }));
  w.hand("e2", Buffer.from("not a bundle\n"));
  const held = ready(await w.go({ id: "e2", path: w.path("final"), branch: "review", handoff: w.head }));
  assert.deepEqual([held.found, held.head], ["held", a.head]);
  assert.equal(existsSync(landedFolder(w.workRoot, "e2")), false);
});

test("an id that names no folder reads no landed files", async (t) => {
  const w = world(t);
  // A bundle at `<root>/.jr2/handoffs/../x` would be read by an id of `../x`: no such id is read.
  const outside = join(w.workRoot, "x");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "bundle"), w.bundleOf());
  assert.match(
    refusal(await w.go({ id: "../x", path: w.path("final"), branch: "review", handoff: w.head })),
    /does not hold the Handoff's commit/,
  );
  assert.equal(existsSync(join(outside, "bundle")), true, "nothing outside the landed folder is removed");
});
