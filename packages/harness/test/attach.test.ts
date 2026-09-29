// The attach (ADR-0063), run by the Harness in its own container: per Repo Slot a pod-local
// `git clone --shared` off the node cache, the fetch/push split, and the branch worktree — the
// same effect the Orchestrator's `kubectl exec` script had (ADR-0004, ADR-0051, ADR-0053). Driven
// through REAL git in a temp layout shaped like the pod's (`/repos/<key>` bare cache, `/work`,
// `/opt/jr2/bin/work-acl`), because every claim here is about what git ends up holding.
//
// The developer's own git config is sealed out: `GIT_CONFIG_SYSTEM=/dev/null`, and a temp file as
// the global config — the attach writes `safe.directory` there, so it must be a file, and never the
// developer's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachFault, attacher, attachFault } from "../src/attach.ts";

const URL_ = "https://example.test/acme/app.git";
const IDENTITY = "example.test/acme/app";
const KEY = "example-test-acme-app-12345678";

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "jr2-harness-attach-"));
  const globalConfig = join(root, "gitconfig");
  await writeFile(globalConfig, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const src = join(root, "src");
  await mkdir(src);
  git(src, "init", "-q", "-b", "main");
  const commit = (m: string) =>
    git(src, "-c", "user.email=t@jr2", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", m);
  commit("one");
  git(src, "branch", "develop");
  commit("two");
  const reposMount = join(root, "repos");
  await mkdir(reposMount);
  git(root, "clone", "-q", "--bare", src, join(reposMount, KEY));
  // The runtime volume's ACL helper, stubbed: it records each directory it was handed, so the
  // test sees the stamp land on the slot directory BEFORE the clone fills it.
  const runtime = join(root, "opt-jr2");
  await mkdir(join(runtime, "bin"), { recursive: true });
  const stamped = join(root, "stamped");
  await writeFile(
    join(runtime, "bin", "work-acl"),
    `#!/bin/sh\nprintf '%s %s\\n' "$1" "$(ls -A "$1" | wc -l)" >> ${JSON.stringify(stamped)}\n`,
  );
  await chmod(join(runtime, "bin", "work-acl"), 0o755);
  const workRoot = join(root, "work");
  const attach = attacher({ paths: { workRoot, reposMount, runtime }, env });
  return { root, src, git, workRoot, runtime, stamped, globalConfig, attach };
}

test("attach clones each slot off its cache, splits fetch from push, and cuts the branch worktree", async () => {
  const l = await layout();
  const res = await l.attach({ branch: "feat/x", slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] });
  const worktree = join(l.workRoot, "app", "feat-x");
  const dflt = join(l.workRoot, "app", "default");
  assert.deepEqual(res, { repos: { app: worktree } });
  assert.equal(l.git(worktree, "branch", "--show-current"), "feat/x", "the worktree is ON the new branch");
  assert.equal(l.git(worktree, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "main"), "cut from origin/HEAD");
  // `--shared`: the objects stay the cache's (ADR-0051).
  const alternates = await readFile(join(dflt, ".git", "objects", "info", "alternates"), "utf8");
  assert.match(alternates, new RegExp(`${KEY}/objects`));
  // Fetch through the node cache program, push to the real remote (ADR-0005, ADR-0053).
  assert.equal(l.git(dflt, "remote", "get-url", "origin"), `ext::${l.runtime}/bin/jr2-upload-pack %S ${IDENTITY}`);
  assert.equal(l.git(dflt, "remote", "get-url", "--push", "origin"), URL_);
  assert.equal(l.git(dflt, "config", "protocol.ext.allow"), "user");
  assert.equal(l.git(dflt, "config", "--global", "safe.directory"), "*");
  // The ACL stamp ran on the slot directory while it was still empty.
  assert.equal((await readFile(l.stamped, "utf8")).trim(), `${join(l.workRoot, "app")} 0`);
});

test("the fetch url escapes what git's ext:: transport would read as syntax", async () => {
  // Git splits an `ext::` url on spaces and reads `%` as a placeholder introducer, so an identity
  // carrying either is syntax unless it is escaped: a percent-encoded forge path (`My%20Project`,
  // Azure DevOps) dies with `fatal: Bad remote-ext placeholder '%2'` before the program runs, and a
  // literal space splits the identity in two. Git's own spellings are `%%` and `% `, and the program
  // receives the identity back exactly as written — which is what the Orchestrator derives the
  // cache key from. `%S` is git's placeholder, not an argument: it survives unescaped, once.
  // (Moved here from the Orchestrator's suite with the attach itself, ADR-0063.)
  const l = await layout();
  await l.attach({
    branch: "b",
    slots: [
      { slot: "azure", url: URL_, identity: "dev.azure.com/org/My%20Project/_git/repo", key: KEY },
      { slot: "spaced", url: URL_, identity: "host/team space/app", key: KEY },
    ],
  });
  const origin = (slot: string) => l.git(join(l.workRoot, slot, "default"), "remote", "get-url", "origin");
  assert.equal(origin("azure"), `ext::${l.runtime}/bin/jr2-upload-pack %S dev.azure.com/org/My%%20Project/_git/repo`);
  assert.equal(origin("spaced"), `ext::${l.runtime}/bin/jr2-upload-pack %S host/team% space/app`);
});

test("a ref is the base the branch is cut FROM, never the branch the Agent commits on", async () => {
  const l = await layout();
  const res = await l.attach({
    branch: "feat/x",
    slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "develop" }],
  });
  const worktree = res.repos.app!;
  assert.equal(l.git(worktree, "branch", "--show-current"), "feat/x");
  assert.equal(l.git(worktree, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "develop"));
  assert.equal(l.git(join(l.workRoot, "app", "default"), "branch", "--list", "develop"), "", "no base branch conjured");
});

test("attach is idempotent: a second attach finds everything present and answers the same paths", async () => {
  const l = await layout();
  const req = { branch: "b", slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] };
  const first = await l.attach(req);
  await writeFile(join(first.repos.app!, "work-in-progress"), "kept");
  const second = await l.attach(req);
  assert.deepEqual(second, first);
  assert.ok(existsSync(join(first.repos.app!, "work-in-progress")), "the branch worktree is not reset");
});

test("a reviewSha adds the detached review worktree, forced and cleaned on every attach (ADR-0028)", async () => {
  const l = await layout();
  const sha = l.git(l.src, "rev-parse", "develop");
  const req = { branch: "b", reviewSha: sha, slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] };
  const res = await l.attach(req);
  const review = join(l.workRoot, "app", "b-review");
  assert.deepEqual(res.review, { app: review });
  assert.equal(l.git(review, "rev-parse", "HEAD"), sha);
  assert.equal(l.git(review, "branch", "--show-current"), "", "detached");
  await writeFile(join(review, "rogue"), "x");
  await l.attach(req);
  assert.ok(!existsSync(join(review, "rogue")), "a previous round's leftovers do not survive");
});

test("a failed step names its slot and carries git's own stderr", async () => {
  const l = await layout();
  const err = await l
    .attach({
      branch: "b",
      slots: [
        { slot: "app", url: URL_, identity: IDENTITY, key: KEY },
        { slot: "infra", url: "https://example.test/infra.git", identity: "example.test/infra", key: "missing-key" },
      ],
    })
    .then(
      () => assert.fail("expected the attach to fail"),
      (e: unknown) => e,
    );
  assert.ok(err instanceof AttachFault);
  assert.equal(err.slot, "infra");
  assert.match(err.message, /slot "infra"/);
  assert.match(err.message, /git clone --shared/);
  assert.match(err.message, /missing-key/, "git's own words name the absent cache");
});

test("attachFault refuses a body that is not an AttachRequest, naming what is wrong", () => {
  const slot = { slot: "app", url: URL_, identity: IDENTITY, key: KEY };
  assert.equal(attachFault({ branch: "b", slots: [slot] }), undefined);
  assert.equal(attachFault({ branch: "b", reviewSha: "abc", slots: [{ ...slot, ref: "main" }] }), undefined);
  assert.match(attachFault(undefined) ?? "", /AttachRequest/);
  assert.match(attachFault({ branch: "b", slots: [] }) ?? "", /names no Repo Slot/);
  assert.match(attachFault({ branch: "", slots: [slot] }) ?? "", /branch/);
  assert.match(attachFault({ branch: "b", slots: [{ ...slot, key: undefined }] }) ?? "", /key/);
  assert.match(attachFault({ branch: "b", slots: [{ ...slot, ref: 3 }] }) ?? "", /ref/);
  // The slot and key are directory names under /work and /repos: never a path out of them.
  for (const bad of ["..", ".", "a/b", ""]) {
    assert.match(attachFault({ branch: "b", slots: [{ ...slot, slot: bad }] }) ?? "", /slot/, `slot ${bad}`);
    assert.match(attachFault({ branch: "b", slots: [{ ...slot, key: bad }] }) ?? "", /key/, `key ${bad}`);
  }
  assert.match(attachFault({ branch: "b", slots: [slot, slot] }) ?? "", /twice/);
});
