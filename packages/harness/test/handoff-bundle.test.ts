// The bundle step of a Handoff (ADR-0080) against real git, in a real Landlock domain through the
// real spawner (`support/children.ts`): only the handed-off range is bundled, the Git LFS objects
// that it points to and that the clone holds go with it, and nothing that an Agent planted in the
// parent's clone steers or holds the step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bundleHandoff, handoffRequestFault, type BundleOptions } from "../src/handoff-bundle.ts";
import { pointerOf, rangeOf } from "../src/handoff-bundle-main.ts";
import { harnessApp } from "../src/app.ts";
import { HANDOFF_CONTENT_TYPE, type HandoffFrame } from "../src/wire.ts";
import type { Spawned } from "../src/spawner.ts";
import { testChildren } from "./support/children.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string, text: string, message: string): string => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A remote with `main`, and the slot `app`'s clone of it, as the attach clones; the coder's
 * Worktree `coder` on `feature` with two commits that the remote does not have. */
function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", remote]);
  const work = join(dir, "work");
  const clone = join(work, "app", "default");
  mkdirSync(join(work, "app"), { recursive: true });
  execFileSync("git", ["clone", "-q", remote, clone], { stdio: "ignore" });
  const base = commit(clone, "a.txt", "a\n", "base");
  git(clone, "push", "-q", "origin", "HEAD:main");
  git(clone, "fetch", "-q", "origin");
  const coder = join(work, "app", "coder");
  git(clone, "worktree", "add", "-q", "-b", "feature", coder, base);
  const c1 = commit(coder, "b.txt", "b\n", "one");
  const head = commit(coder, "c.txt", "c\n", "two");
  const children = testChildren({ work });
  t.after(() => children.spawner.close());
  const take = (h = head, opts: BundleOptions = {}) =>
    collect(bundleHandoff(children, { path: coder, head: h }, { workRoot: work, ...opts }));
  return { dir, remote, work, clone, coder, base, c1, head, children, take };
}

type Taken = { frames: HandoffFrame[]; parts: Map<string, Buffer>; ms: number; data: number };

/** Read the stream to its end: each frame but `data`, and each part's bytes by `bundle` or its oid.
 * A part's `data` frames must hold exactly its size before the next header. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Taken> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const all = Buffer.concat(chunks);
  const frames: HandoffFrame[] = [];
  const parts = new Map<string, Buffer>();
  let data = 0;
  let part: { key: string; size: number; got: Buffer[] } | undefined;
  const close = () => {
    if (part === undefined) return;
    const bytes = Buffer.concat(part.got);
    assert.equal(bytes.length, part.size, `the data of ${part.key} holds its size`);
    parts.set(part.key, bytes);
    part = undefined;
  };
  let at = 0;
  while (at < all.length) {
    const nl = all.indexOf(0x0a, at);
    assert.ok(nl >= 0, "each frame ends with a newline");
    const f = JSON.parse(all.subarray(at, nl).toString()) as HandoffFrame;
    at = nl + 1;
    if ("data" in f) {
      data += 1;
      assert.ok(part !== undefined, "data comes in a part");
      part.got.push(all.subarray(at, at + f.data));
      at += f.data;
      continue;
    }
    if ("refused" in f || "unknown" in f) part = undefined;
    else close();
    frames.push(f);
    if ("bundle" in f) part = { key: "bundle", size: f.bundle, got: [] };
    if ("lfs" in f) part = { key: f.lfs, size: f.size, got: [] };
  }
  return { frames, parts, ms: Date.now() - started, data };
}

const last = (t: Taken): HandoffFrame => t.frames.at(-1)!;

/** The step's folders that are left in the domain's TMPDIR. */
const leftIn = (children: { env: Record<string, string | undefined> }): string[] =>
  readdirSync(children.env.TMPDIR!).filter((n) => n.startsWith("jr2-handoff-"));

/** A folder with a `git` that runs `body` (sh) before the real git, which is `$REAL`. Put it first
 * on the domain's PATH: the step's git is then this one. */
function gitWrapper(t: TestContext, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nREAL='${real}'\n${body}\nexec "$REAL" "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

/** The world's coder Worktree, with the step's git at `path`. */
function takeWith(t: TestContext, w: ReturnType<typeof world>, path: string, head = w.head) {
  const children = testChildren({ work: w.work, env: { PATH: path } });
  t.after(() => children.spawner.close());
  return collect(bundleHandoff(children, { path: w.coder, head }, { workRoot: w.work }));
}

/** The objects that a bundle's pack holds, unbundled into a folder of the test's own whose
 * alternates are the remote's objects (the bundle's prerequisites). */
function packOf(t: TestContext, bundle: Buffer, remote: string): { heads: string; objects: Set<string> } {
  const dir = mkdtempSync(join(tmpdir(), "handoff-unbundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "b.bundle");
  writeFileSync(file, bundle);
  const repo = join(dir, "r.git");
  execFileSync("git", ["init", "-q", "--bare", repo]);
  writeFileSync(join(repo, "objects/info/alternates"), `${remote}/objects\n`);
  const heads = git(repo, "bundle", "list-heads", file);
  git(repo, "bundle", "unbundle", file);
  const pack = join(repo, "objects/pack");
  const objects = new Set<string>();
  for (const idx of readdirSync(pack).filter((n) => n.endsWith(".idx"))) {
    for (const l of git(repo, "verify-pack", "-v", join(pack, idx)).split("\n")) {
      const sha = l.split(" ")[0]!;
      if (/^[0-9a-f]{40}$/.test(sha)) objects.add(sha);
    }
  }
  return { heads, objects };
}

/** A program that writes `marker` when it runs. */
function markerScript(dir: string, marker: string): string {
  const p = join(dir, "touch-marker");
  writeFileSync(p, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A FIFO that no one writes: a reader that opens it waits for ever. */
const fifo = (path: string) => execFileSync("mkfifo", [path]);

/** No process holds `path` open for reading: an open for write that does not wait fails ENXIO. */
function noReader(path: string): boolean {
  try {
    openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENXIO";
  }
}

/** Wait up to 5 s until no process holds `path` open for reading: the step's group is gone. */
async function readerGone(path: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (noReader(path)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const lfsPointer = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

/** Put `content` in the clone's LFS store under its oid, and commit its pointer in `cwd`. */
function lfsFile(clone: string, cwd: string, name: string, content: string, store = true) {
  const oid = createHash("sha256").update(content).digest("hex");
  const dir = join(clone, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4));
  if (store) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, oid), content);
  }
  const sha = commit(cwd, name, lfsPointer(oid, Buffer.byteLength(content)), `lfs ${name}`);
  return { oid, sha, file: join(dir, oid) };
}

// ---- the range ------------------------------------------------------------------------------------

test("the bundle holds the handed-off range alone: one ref at head, the remote's commits as prerequisites, and no other branch, stash or dangling object of the clone", async (t) => {
  const w = world(t);
  // An unpushed branch, a stash and dangling objects of the clone, beside the range.
  const other = join(w.work, "app", "other");
  git(w.clone, "worktree", "add", "-q", "-b", "other", other, w.base);
  const otherSha = commit(other, "o.txt", "other\n", "other");
  writeFileSync(join(w.coder, "c.txt"), "stashed\n");
  git(w.coder, "stash", "-q");
  const stash = git(w.clone, "rev-parse", "refs/stash");
  const dangling = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: w.clone, input: "dangling\n" })
    .toString()
    .trim();

  const got = await w.take();
  assert.deepEqual(last(got), { end: true });
  assert.equal(got.frames.length, 2, "a bundle, then the end: no Git LFS object");
  const { heads, objects } = packOf(t, got.parts.get("bundle")!, w.remote);
  assert.equal(heads, `${w.head} refs/heads/handoff`);
  assert.ok(objects.has(w.head) && objects.has(w.c1), "the range's commits");
  for (const [what, sha] of [
    ["the other branch", otherSha],
    ["the stash", stash],
    ["a dangling blob", dangling],
    ["the remote's commit", w.base],
  ] as const) {
    assert.ok(!objects.has(sha), `${what} is not in the bundle`);
  }
});

test("a second remote's commits travel in the bundle: the negatives are origin's alone, as the child's clone has only origin", async (t) => {
  // A coder that works as a fork's contributor does: it fetches another remote and builds on it.
  const w = world(t);
  const upstream = join(w.dir, "upstream.git");
  execFileSync("git", ["clone", "-q", "--bare", w.remote, upstream], { stdio: "ignore" });
  const side = join(w.dir, "side");
  execFileSync("git", ["clone", "-q", upstream, side], { stdio: "ignore" });
  const fork = commit(side, "f.txt", "fork\n", "fork");
  git(side, "push", "-q", "origin", "HEAD:main");
  git(w.clone, "remote", "add", "upstream", upstream);
  git(w.clone, "fetch", "-q", "upstream");
  const fix = join(w.work, "app", "fix");
  git(w.clone, "worktree", "add", "-q", "-b", "fix", fix, "upstream/main");
  const head = commit(fix, "g.txt", "fix\n", "fix");
  const got = await collect(bundleHandoff(w.children, { path: fix, head }, { workRoot: w.work }));
  assert.deepEqual(last(got), { end: true });
  const { objects } = packOf(t, got.parts.get("bundle")!, w.remote);
  assert.ok(objects.has(fork), "the fork's commit is in the bundle, not a prerequisite that the child lacks");
  assert.ok(objects.has(head));
  assert.ok(!objects.has(w.base), "origin's commit stays a prerequisite");
});

test("a remote-tracking ref of the clone at head leaves an empty range: nothing is carried", async (t) => {
  const w = world(t);
  git(w.clone, "update-ref", "refs/remotes/origin/feature", w.head);
  assert.deepEqual((await w.take()).frames, [{ nothing: true }]);
});

test("the range on git's stdin holds no option line, so a git before 2.42 takes it", async (t) => {
  // git before 2.42 refuses an option on stdin: "options not supported in --stdin mode". Debian
  // bookworm's git is 2.39.5, and a Sandbox Image can have it.
  const text = rangeOf("a".repeat(40), ["b".repeat(40), "c".repeat(40)]);
  assert.equal(text, `${"a".repeat(40)}\n^${"b".repeat(40)}\n^${"c".repeat(40)}\n`);
  assert.ok(
    text.split("\n").every((l) => !l.startsWith("-")),
    "no line is an option",
  );
  // The whole step, with a git that refuses an option line on stdin as git 2.39 does.
  const w = world(t);
  const old = gitWrapper(
    t,
    `for a in "$@"; do
  if [ "$a" = --stdin ]; then
    in=$(cat)
    if printf '%s\\n' "$in" | grep -q '^-'; then echo "fatal: options not supported in --stdin mode" >&2; exit 128; fi
    printf '%s\\n' "$in" | "$REAL" "$@"
    exit $?
  fi
done`,
  );
  const lfs = lfsFile(w.clone, w.coder, "one.bin", "a large file\n");
  const head = git(w.coder, "rev-parse", "HEAD");
  const got = await takeWith(t, w, old, head);
  assert.deepEqual(last(got), { end: true }, JSON.stringify(got.frames));
  const { objects } = packOf(t, got.parts.get("bundle")!, w.remote);
  assert.ok(objects.has(head) && !objects.has(w.base), "the range alone");
  assert.equal(got.parts.get(lfs.oid)?.toString(), "a large file\n");
});

test("the step removes its own folder before its last frame: after `end` and after `nothing`, the domain's TMPDIR holds none", async (t) => {
  const w = world(t);
  assert.deepEqual(last(await w.take()), { end: true });
  assert.deepEqual(leftIn(w.children), []);
  git(w.clone, "update-ref", "refs/remotes/origin/feature", w.head);
  assert.deepEqual((await w.take()).frames, [{ nothing: true }]);
  assert.deepEqual(leftIn(w.children), []);
});

test("a git call of the step that fails is refused, and the step does not go on with what git wrote", async (t) => {
  // Without the check, a failed read of the negatives bundles the whole history, and a failed read
  // of the blobs leaves out the Git LFS objects that the range points to.
  for (const [what, pattern] of [
    ["the negatives", "--batch-check=%(objectname) %(objecttype)"],
    ["the kinds of the range's objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    ["the small blobs", "--batch"],
    // Without the check, a failed rev-list says that the range is empty: the cut runs with no files.
    ["the first commit of the range", "rev-list"],
    ["the ref of head", "update-ref"],
    ["the bundle", "bundle"],
  ] as const) {
    const w = world(t);
    lfsFile(w.clone, w.coder, "one.bin", "a large file\n");
    const head = git(w.coder, "rev-parse", "HEAD");
    const broken = gitWrapper(
      t,
      `for a in "$@"; do if [ "$a" = '${pattern}' ]; then echo "fatal: it broke" >&2; exit 1; fi; done`,
    );
    const got = await takeWith(t, w, broken, head);
    assert.equal(got.frames.length, 1, `${what}: ${JSON.stringify(got.frames)}`);
    assert.match(String((got.frames[0] as { refused?: string }).refused), /: fatal: it broke$/, what);
  }
});

test("a remote-tracking ref of the clone at a blob or a missing object is left out, and the range stays", async (t) => {
  const w = world(t);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: w.clone, input: "x\n" }).toString().trim();
  git(w.clone, "update-ref", "refs/remotes/origin/blob", blob);
  writeFileSync(join(w.clone, ".git/refs/remotes/origin/gone"), `${"e".repeat(40)}\n`);
  const got = await w.take();
  assert.deepEqual(last(got), { end: true });
  assert.ok(packOf(t, got.parts.get("bundle")!, w.remote).objects.has(w.c1));
});

test("a commit that the clone does not hold is refused, and nothing is carried", async (t) => {
  const w = world(t);
  const got = await w.take("f".repeat(40));
  assert.deepEqual(got.frames, [{ refused: `the parent's clone does not hold the commit ${"f".repeat(40)}` }]);
});

// ---- what an Agent planted -------------------------------------------------------------------------

test("a config, hooks, attributes and filters that an Agent planted in the clone run nothing, and the range is bundled", async (t) => {
  // A guard for later changes: the step's git commands today run no hook, filter, textconv or
  // fsmonitor even without the cut's pinned config, which the FIFO tests below need. This test
  // keeps them so when the step gets another command.
  const w = world(t);
  const marker = join(w.dir, "marker");
  const script = markerScript(w.dir, marker);
  const hooks = join(w.dir, "hooks");
  mkdirSync(hooks);
  for (const hook of ["reference-transaction", "post-checkout", "pre-auto-gc", "post-index-change"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\n'${script}' ${hook}\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  for (const [k, v] of [
    ["core.hooksPath", hooks],
    ["core.fsmonitor", script],
    ["core.alternateRefsCommand", script],
    ["core.commitGraph", "true"],
    ["core.multiPackIndex", "true"],
    ["filter.evil.clean", script],
    ["filter.evil.smudge", script],
    ["filter.evil.process", script],
    ["diff.evil.textconv", script],
    ["uploadpack.packObjectsHook", script],
    ["core.sshCommand", script],
    ["gc.auto", "1"],
  ]) {
    git(w.clone, "config", k!, v!);
  }
  writeFileSync(join(w.clone, ".git/info/attributes"), "* filter=evil diff=evil\n");
  const got = await w.take();
  assert.deepEqual(last(got), { end: true });
  assert.ok(packOf(t, got.parts.get("bundle")!, w.remote).objects.has(w.head));
  assert.equal(existsSync(marker), false, "no program of the Agent's ran");
});

test("the domain's env reaches neither the step's node nor its git: a NODE_OPTIONS and a GIT_TRACE there do nothing", async (t) => {
  const w = world(t);
  const marker = join(w.dir, "marker");
  const preload = join(w.dir, "preload.cjs");
  writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "node\\n");\n`);
  const children = testChildren({
    work: w.work,
    env: { NODE_OPTIONS: `--require ${preload}`, GIT_TRACE: marker, GIT_OBJECT_DIRECTORY: join(w.dir, "nowhere") },
  });
  t.after(() => children.spawner.close());
  const got = await collect(bundleHandoff(children, { path: w.coder, head: w.head }, { workRoot: w.work }));
  assert.deepEqual(last(got), { end: true });
  assert.equal(existsSync(marker), false);
});

test("a FIFO in place of the clone's commit-graph or multi-pack-index holds nothing: the step reads neither", async (t) => {
  const w = world(t);
  git(w.clone, "repack", "-qad");
  fifo(join(w.clone, ".git/objects/info/commit-graph"));
  fifo(join(w.clone, ".git/objects/pack/multi-pack-index"));
  const got = await w.take(w.head, { deadlineMs: 20_000 });
  assert.deepEqual(last(got), { end: true });
  assert.ok(got.ms < 15_000);
});

test("a FIFO that holds git (an include.path of the clone's config) ends at the deadline, refused, and the step's process group is gone", async (t) => {
  const w = world(t);
  const pipe = join(w.dir, "held");
  fifo(pipe);
  git(w.clone, "config", "include.path", pipe);
  const got = await w.take(w.head, { deadlineMs: 2_000 });
  assert.deepEqual(got.frames, [{ refused: "the bundle step passed its deadline of 2 s" }]);
  assert.ok(got.ms < 10_000);
  assert.ok(await readerGone(pipe), "no process of the step holds the FIFO open");
});

test("an alternates file of the clone that is a FIFO ends at the deadline, refused, and the step's process group is gone", async (t) => {
  const w = world(t);
  const pipe = join(w.clone, ".git/objects/info/alternates");
  fifo(pipe);
  const got = await w.take(w.head, { deadlineMs: 2_000 });
  assert.deepEqual(got.frames, [{ refused: "the bundle step passed its deadline of 2 s" }]);
  // The spawner stays open until the kill took effect: a git of the step that still waited at the
  // FIFO when the test ended ran on for hours.
  assert.ok(await readerGone(pipe), "no process of the step holds the FIFO open");
});

test("an alternate of the clone with more objects puts none of them in the bundle", async (t) => {
  const w = world(t);
  const extra = join(w.dir, "extra.git");
  execFileSync("git", ["init", "-q", "--bare", extra]);
  const foreign = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: extra, input: "foreign\n" })
    .toString()
    .trim();
  writeFileSync(join(w.clone, ".git/objects/info/alternates"), `${extra}/objects\n`);
  const got = await w.take();
  assert.deepEqual(last(got), { end: true });
  assert.ok(!packOf(t, got.parts.get("bundle")!, w.remote).objects.has(foreign));
});

// ---- Git LFS objects --------------------------------------------------------------------------------

test("the Git LFS objects that the range points to and that the clone holds go after the bundle, each with its bytes", async (t) => {
  const w = world(t);
  // A pointer of the remote's commit: outside the range, so not carried.
  const old = lfsFile(w.clone, w.clone, "old.bin", "old large file\n");
  git(w.clone, "push", "-q", "origin", "HEAD:main");
  git(w.clone, "fetch", "-q", "origin");
  git(w.coder, "merge", "-q", "--no-edit", "origin/main");
  const one = lfsFile(w.clone, w.coder, "one.bin", "the first large file\n");
  const two = lfsFile(w.clone, w.coder, "two.bin", "the second large file, longer\n");
  const notHeld = lfsFile(w.clone, w.coder, "gone.bin", "no store holds this\n", false);
  const head = git(w.coder, "rev-parse", "HEAD");

  const got = await w.take(head);
  assert.deepEqual(last(got), { end: true });
  assert.ok("bundle" in got.frames[0]!, "the bundle is first");
  const carried = got.frames.filter((f): f is { lfs: string; size: number } => "lfs" in f).map((f) => f.lfs);
  assert.deepEqual(carried, [one.oid, two.oid].sort());
  assert.equal(got.parts.get(one.oid)!.toString(), "the first large file\n");
  assert.equal(got.parts.get(two.oid)!.toString(), "the second large file, longer\n");
  assert.ok(!carried.includes(old.oid), "an object of a commit outside the range stays");
  assert.ok(!carried.includes(notHeld.oid), "an object that the clone does not hold is left to the node cache");
});

test("a Git LFS object that is a link, a FIFO or of another size than its pointer says is left out, and holds nothing", async (t) => {
  const w = world(t);
  const linked = lfsFile(w.clone, w.coder, "linked.bin", "linked\n");
  const secret = join(w.dir, "secret");
  writeFileSync(secret, "linked\n");
  rmSync(linked.file);
  symlinkSync(secret, linked.file);
  const piped = lfsFile(w.clone, w.coder, "piped.bin", "piped\n");
  rmSync(piped.file);
  fifo(piped.file);
  const resized = lfsFile(w.clone, w.coder, "resized.bin", "resized\n");
  writeFileSync(resized.file, "resized, and longer now\n");
  const kept = lfsFile(w.clone, w.coder, "kept.bin", "kept\n");
  const head = git(w.coder, "rev-parse", "HEAD");
  const got = await w.take(head, { deadlineMs: 20_000 });
  assert.deepEqual(last(got), { end: true });
  assert.deepEqual(
    got.frames.filter((f) => "lfs" in f).map((f) => (f as { lfs: string }).lfs),
    [kept.oid],
  );
});

test("the bundle and its Git LFS objects together past the bound are refused before any part", async (t) => {
  const w = world(t);
  lfsFile(w.clone, w.coder, "big.bin", "x".repeat(4096));
  const head = git(w.coder, "rev-parse", "HEAD");
  const got = await w.take(head, { maxBytes: 3000 });
  assert.equal(got.frames.length, 1);
  assert.match(String((got.frames[0] as { refused: string }).refused), /more than the bound of 3000 bytes/);
});

test("the Git LFS objects past their number bound are refused before any part, and a pointer of no bytes names no object", async (t) => {
  const w = world(t);
  lfsFile(w.clone, w.coder, "one.bin", "one\n");
  lfsFile(w.clone, w.coder, "two.bin", "two\n");
  // A pointer of size 0, with an empty file in the store: git-lfs stores no empty object, and one of
  // no bytes would cost nothing against the byte bound.
  const empty = lfsFile(w.clone, w.coder, "empty.bin", "");
  const head = git(w.coder, "rev-parse", "HEAD");
  const refused = await w.take(head, { maxObjects: 1 });
  assert.equal(refused.frames.length, 1);
  assert.match(
    String((refused.frames[0] as { refused: string }).refused),
    /2 Git LFS objects, more than the bound of 1/,
  );
  const got = await w.take(head, { maxObjects: 2 });
  assert.deepEqual(last(got), { end: true });
  const carried = got.frames.filter((f) => "lfs" in f).map((f) => (f as { lfs: string }).lfs);
  assert.equal(carried.length, 2);
  assert.ok(!carried.includes(empty.oid), "the empty object is not carried");
});

test("a Git LFS pointer is read by its form", () => {
  const oid = "a".repeat(64);
  assert.deepEqual(pointerOf(lfsPointer(oid, 12)), { oid, size: 12 });
  assert.deepEqual(
    pointerOf(
      `version https://git-lfs.github.com/spec/v1\next-0-x sha256:${"b".repeat(64)}\noid sha256:${oid}\nsize 3\n`,
    ),
    {
      oid,
      size: 3,
    },
  );
  assert.equal(pointerOf("hello\n"), undefined);
  assert.equal(
    pointerOf(`version https://git-lfs.github.com/spec/v1\noid sha256:${"A".repeat(64)}\nsize 1\n`),
    undefined,
  );
  assert.equal(pointerOf(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`), undefined);
});

// ---- the stream's form: the step's output is data of the domain -------------------------------------

/** A step that writes `script`'s output: a program of the test, in place of the real step. */
function fakeStep(t: TestContext, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-fake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "step.mjs");
  writeFileSync(entry, body);
  return entry;
}

const COMMIT = "1".repeat(40);

async function takeFake(t: TestContext, body: string, opts: BundleOptions = {}): Promise<Taken> {
  const children = testChildren();
  t.after(() => children.spawner.close());
  return collect(
    bundleHandoff(children, { path: "/work/app/coder", head: COMMIT }, { entry: fakeStep(t, body), ...opts }),
  );
}

test("a step's output out of its form ends the stream refused: a header that is not JSON, out of order, too long, a part past the bound, an object twice, an object of no bytes, objects past their number", async (t) => {
  const cases: [string, string, RegExp][] = [
    ["not JSON", `process.stdout.write("hello\\n")`, /not JSON/],
    [
      "an object before the bundle",
      `process.stdout.write(JSON.stringify({ lfs: "${"a".repeat(64)}", size: 0 }) + "\\n")`,
      /out of its form/,
    ],
    ["an end before the bundle", `process.stdout.write('{"end":true}\\n')`, /out of its form/],
    ["a second bundle", `process.stdout.write('{"bundle":1}\\nx{"bundle":1}\\ny')`, /out of its form/],
    ["a long header", `process.stdout.write("x".repeat(5000))`, /longer than its form/],
    ["a part past the bound", `process.stdout.write('{"bundle":101}\\n')`, /bound of 100 bytes/],
    [
      "an object twice",
      `const h = JSON.stringify({ lfs: "${"a".repeat(64)}", size: 1 }); process.stdout.write('{"bundle":1}\\nx' + h + "\\ny" + h + "\\ny")`,
      /object a{64} twice/,
    ],
    ["an extra key", `process.stdout.write('{"bundle":1,"more":2}\\nx')`, /out of its form/],
    [
      "an object of no bytes",
      `process.stdout.write('{"bundle":1}\\nx' + JSON.stringify({ lfs: "${"a".repeat(64)}", size: 0 }) + "\\n")`,
      /out of its form/,
    ],
    [
      "objects past their number bound",
      `let s = '{"bundle":1}\\nx'; for (const c of "abc") s += JSON.stringify({ lfs: c.repeat(64), size: 1 }) + "\\ny"; process.stdout.write(s)`,
      /more than 2 Git LFS objects/,
    ],
  ];
  for (const [what, body, want] of cases) {
    const got = await takeFake(t, body, { maxBytes: 100, maxObjects: 2 });
    const end = last(got);
    assert.ok("refused" in end, `${what}: ${JSON.stringify(got.frames)}`);
    assert.match(end.refused, want, what);
  }
});

test("a step that ends before its last frame is refused, with its last stderr line; a part's bytes that do not all come are void", async (t) => {
  const got = await takeFake(
    t,
    `process.stdout.write('{"bundle":10}\\nabc'); process.stderr.write("it broke\\n"); process.exit(3)`,
  );
  assert.deepEqual(last(got), { refused: "the bundle step ended with exit 3 before its last frame: it broke" });
});

test("a step that does not start is unknown: the parent's files did not cause it", async (t) => {
  const children = testChildren();
  children.spawner.close();
  const got = await collect(bundleHandoff(children, { path: "/work/app/coder", head: COMMIT }));
  assert.equal(got.frames.length, 1);
  assert.match(String((got.frames[0] as { unknown: string }).unknown), /^the bundle step did not run: /);
});

test("the deadline counts the step's own time: a reader that holds the step paused past the deadline gets each byte and the end", async (t) => {
  const size = 4 << 20;
  const children = testChildren();
  t.after(() => children.spawner.close());
  const entry = fakeStep(
    t,
    `const n = ${size}; process.stdout.write('{"bundle":' + n + '}\\n'); process.stdout.write(Buffer.alloc(n, 7)); process.stdout.write('{"end":true}\\n')`,
  );
  const stream = bundleHandoff(
    children,
    { path: "/work/app/coder", head: COMMIT },
    { entry, highWaterMark: 64 << 10, maxBytes: size, deadlineMs: 1_500 },
  );
  // The reader takes the first chunk, then waits longer than the deadline: the step is paused.
  const reader = stream.getReader();
  const first = await reader.read();
  await new Promise((r) => setTimeout(r, 2_500));
  const rest = new ReadableStream<Uint8Array>({
    start(c) {
      if (!first.done) c.enqueue(first.value);
    },
    async pull(c) {
      const next = await reader.read();
      if (next.done) c.close();
      else c.enqueue(next.value);
    },
  });
  const got = await collect(rest);
  assert.deepEqual(last(got), { end: true }, JSON.stringify(got.frames.slice(-2)));
  assert.equal(got.parts.get("bundle")!.length, size);
});

test("a deadline that is not whole seconds is said as it is", async (t) => {
  const got = await takeFake(t, `setTimeout(() => {}, 60_000)`, { deadlineMs: 1_500 });
  assert.deepEqual(got.frames, [{ refused: "the bundle step passed its deadline of 1.5 s" }]);
});

/** testChildren whose spawner counts each spawn's pause and resume. */
function watched(t: TestContext) {
  const children = testChildren();
  t.after(() => children.spawner.close());
  const spawned: { proc: Spawned; pauses: number }[] = [];
  const real = children.spawner.spawn.bind(children.spawner);
  (children.spawner as { spawn: typeof real }).spawn = ((...args: Parameters<typeof real>) => {
    const proc = real(...args);
    const rec = { proc, pauses: 0 };
    const pause = proc.pause.bind(proc);
    (proc as { pause: () => void }).pause = () => {
      rec.pauses++;
      pause();
    };
    spawned.push(rec);
    return proc;
  }) as typeof real;
  return { children, spawned };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: not within ${ms} ms`)), ms).unref()),
  ]);

test("a reader behind the step pauses it, and the stream still carries each byte", async (t) => {
  // Without the pause, the Harness queues the whole output of the step (up to the bound) in memory.
  const size = 3 << 20;
  const { children, spawned } = watched(t);
  const entry = fakeStep(
    t,
    `const n = ${size}; process.stdout.write('{"bundle":' + n + '}\\n'); process.stdout.write(Buffer.alloc(n, 7)); process.stdout.write('{"end":true}\\n')`,
  );
  const stream = bundleHandoff(
    children,
    { path: "/work/app/coder", head: COMMIT },
    { entry, highWaterMark: 64 << 10, maxBytes: size },
  );
  const reader = stream.getReader();
  const first = await reader.read();
  await new Promise((r) => setTimeout(r, 1_500));
  assert.ok(spawned[0]!.pauses > 0, "the step was paused while the reader was behind");
  const got = await collect(
    new ReadableStream<Uint8Array>({
      start(c) {
        if (!first.done) c.enqueue(first.value);
      },
      async pull(c) {
        const next = await reader.read();
        if (next.done) c.close();
        else c.enqueue(next.value);
      },
    }),
  );
  assert.deepEqual(last(got), { end: true });
  assert.equal(got.parts.get("bundle")!.length, size);
  assert.ok(got.parts.get("bundle")!.every((b) => b === 7));
});

test("a reader that cancels kills the step, and a step that the reader holds paused ends too", async (t) => {
  // Not paused: the cancel's kill ends it. Paused: the kill comes with a resume, or the spawn's exit
  // never settles.
  for (const paused of [false, true]) {
    const { children, spawned } = watched(t);
    const size = 8 << 20;
    const entry = fakeStep(
      t,
      paused
        ? `const n = ${size}; process.stdout.write('{"bundle":' + n + '}\\n'); process.stdout.write(Buffer.alloc(n, 7)); setInterval(() => {}, 1000);`
        : `process.stdout.write('{"bundle":100}\\nabc'); setInterval(() => {}, 1000);`,
    );
    const stream = bundleHandoff(
      children,
      { path: "/work/app/coder", head: COMMIT },
      { entry, highWaterMark: 64 << 10, maxBytes: size, deadlineMs: 60_000 },
    );
    const reader = stream.getReader();
    await reader.read();
    if (paused) {
      await new Promise((r) => setTimeout(r, 1_000));
      assert.ok(spawned[0]!.pauses > 0, "paused before the cancel");
    }
    await reader.cancel();
    const exit = await within(spawned[0]!.proc.exited, 5_000, `the step's exit (paused: ${paused})`);
    assert.equal(exit.signal, "SIGKILL");
  }
});

test("the deadline's clock runs again when the reader catches up: a step that then hangs is refused at the deadline", async (t) => {
  const children = testChildren();
  t.after(() => children.spawner.close());
  const entry = fakeStep(
    t,
    `process.stdout.write('{"bundle":${8 << 20}}\\n'); process.stdout.write(Buffer.alloc(${4 << 20}, 7)); setInterval(() => {}, 1000);`,
  );
  const stream = bundleHandoff(
    children,
    { path: "/work/app/coder", head: COMMIT },
    { entry, highWaterMark: 64 << 10, maxBytes: 8 << 20, deadlineMs: 1_500 },
  );
  const reader = stream.getReader();
  await reader.read();
  await new Promise((r) => setTimeout(r, 2_500));
  const chunks: Buffer[] = [];
  const all = (async () => {
    for (;;) {
      const n = await reader.read();
      if (n.done) return Buffer.concat(chunks).toString("latin1");
      chunks.push(Buffer.from(n.value));
    }
  })();
  const text = await within(all, 15_000, "the stream's end");
  assert.match(text.slice(-200), /\{"refused":"the bundle step passed its deadline of 1\.5 s"\}\n$/);
});

test("a step that writes its part one byte at a time gives a few data frames, not one for each byte", async (t) => {
  // An Agent can trace the step and choose its chunks: each frame is work for the Orchestrator.
  const n = 3000;
  const got = await takeFake(
    t,
    `process.stdout.write('{"bundle":${n}}\\n'); let i = 0; const one = () => { if (i++ < ${n}) process.stdout.write("x", () => setImmediate(one)); else process.stdout.write('{"end":true}\\n'); }; one();`,
    { maxBytes: n },
  );
  assert.deepEqual(last(got), { end: true });
  assert.equal(got.parts.get("bundle")!.length, n);
  assert.ok(got.data <= 5, `${got.data} data frames for ${n} bytes`);
});

// ---- the route --------------------------------------------------------------------------------------

test("POST /handoff streams the step's frames; a malformed body is 400 and runs nothing; the Instance Harness refuses it; a Harness without it is 501", async () => {
  const seen: unknown[] = [];
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from('{"nothing":true}\n'));
        c.close();
      },
    });
  const deps = {
    checkBearer: () => true,
    runSubmissionFor: () => () => new Promise<void>(() => {}),
  };
  const app = harnessApp({ ...deps, handoff: (req) => (seen.push(req), stream()) });
  const post = (a: ReturnType<typeof harnessApp>, body: unknown) =>
    a.request("/handoff", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  const good = { path: "/work/app/coder", head: COMMIT };
  const res = await post(app, { ...good, extra: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), HANDOFF_CONTENT_TYPE);
  assert.equal(await res.text(), '{"nothing":true}\n');
  assert.deepEqual(seen, [good], "only the path and the head go to the step");
  for (const bad of [
    { ...good, head: "abc" },
    { ...good, path: "/etc/x" },
    { ...good, path: "/work/app/default" },
    "x",
  ]) {
    assert.equal((await post(app, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(seen.length, 1);
  const instance = harnessApp({ ...deps, menuOnly: true, handoff: (req) => (seen.push(req), stream()) });
  assert.equal((await post(instance, good)).status, 403);
  assert.equal((await post(harnessApp(deps), good)).status, 501);
  assert.equal(seen.length, 1);
  assert.equal(handoffRequestFault(good), undefined);
});
