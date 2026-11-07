// The attach (ADR-0063), run by the Harness in its own container: per Repo Slot a pod-local
// `git clone --shared` off the node cache, the fetch/push split, and `default/` on the Binding's base — the
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
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachFault, attacher, attachFault } from "../src/attach.ts";
import { deniedDir, testChildren } from "./support/children.ts";

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
  // The two LFS programs, stubbed: no file of this Repo is an LFS file, so git never starts git-lfs.
  // jr2-lfs records its arguments and what the checkout held when it ran, and prints `lfsAnswer`.
  const lfsCalls = join(root, "jr2-lfs.calls");
  const lfsAnswer = join(root, "jr2-lfs.answer");
  await writeFile(lfsAnswer, `${JSON.stringify({ pointers: 0, asked: 0, missing: [] })}\n`);
  await writeFile(
    join(runtime, "bin", "jr2-lfs"),
    `#!/bin/sh\nprintf '%s | %s | %s\\n' "$*" "$PWD" "$(ls -A | tr '\\n' ' ')" >> ${JSON.stringify(lfsCalls)}\ncat ${JSON.stringify(lfsAnswer)}\n`,
  );
  await chmod(join(runtime, "bin", "jr2-lfs"), 0o755);
  await writeFile(join(runtime, "bin", "git-lfs"), "#!/bin/sh\necho 'the stub git-lfs ran' >&2\nexit 9\n");
  await chmod(join(runtime, "bin", "git-lfs"), 0o755);
  const workRoot = join(root, "work");
  // Confined as in a pod (ADR-0076): the whole fixture is the children's TMPDIR, so the stubbed
  // runtime runs and the clone lands; the caches are read only.
  const children = testChildren({ tmp: root, repos: reposMount });
  const attach = attacher({
    children,
    paths: { workRoot, reposMount, runtime },
    env: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const lfsCallsOf = async (): Promise<string[]> =>
    existsSync(lfsCalls) ? (await readFile(lfsCalls, "utf8")).trim().split("\n") : [];
  return { root, src, git, workRoot, reposMount, runtime, stamped, globalConfig, attach, lfsAnswer, lfsCallsOf };
}

test("attach clones each slot off its cache, splits fetch from push, and cuts no Worktree", async () => {
  const l = await layout();
  const res = await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] });
  const dflt = join(l.workRoot, "app", "default");
  assert.deepEqual(res, { repos: { app: join(l.workRoot, "app") }, bases: { app: "main" } });
  assert.equal(l.git(dflt, "branch", "--show-current"), "main", "default/ stays on the real default branch");
  assert.equal(l.git(dflt, "worktree", "list", "--porcelain").split("worktree ").length, 2, "only the clone");
  assert.equal(l.git(dflt, "config", "gc.auto"), "0");
  assert.equal(l.git(dflt, "config", "maintenance.auto"), "false");
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
    slots: [
      { slot: "azure", url: URL_, identity: "dev.azure.com/org/My%20Project/_git/repo", key: KEY },
      { slot: "spaced", url: URL_, identity: "host/team space/app", key: KEY },
    ],
  });
  const origin = (slot: string) => l.git(join(l.workRoot, slot, "default"), "remote", "get-url", "origin");
  assert.equal(origin("azure"), `ext::${l.runtime}/bin/jr2-upload-pack %S dev.azure.com/org/My%%20Project/_git/repo`);
  assert.equal(origin("spaced"), `ext::${l.runtime}/bin/jr2-upload-pack %S host/team% space/app`);
});

test("a ref that IS the default branch keeps the branch attached", async () => {
  const l = await layout();
  const res = await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "main" }] });
  const dflt = join(l.workRoot, "app", "default");
  assert.equal(l.git(dflt, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(res.bases.app, "main");
});

test("a ref to another branch: default/ holds it, tracked, and the frozen default branch goes", async () => {
  const l = await layout();
  const res = await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "develop" }] });
  const dflt = join(l.workRoot, "app", "default");
  assert.equal(l.git(dflt, "symbolic-ref", "--short", "HEAD"), "develop");
  assert.equal(l.git(dflt, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "develop"));
  assert.equal(l.git(dflt, "branch", "--list", "main"), "", "a stale local main cannot answer a cut");
  assert.equal(res.bases.app, "develop");
});

test("a ref to a tag or a commit: default/ is detached there, and it is the base", async () => {
  const l = await layout();
  l.git(l.src, "tag", "v3", "develop");
  l.git(l.root, "-C", join(l.root, "repos", KEY), "fetch", "-q", l.src, "refs/tags/v3:refs/tags/v3");
  const res = await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "v3" }] });
  const dflt = join(l.workRoot, "app", "default");
  assert.equal(l.git(dflt, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "v3"));
  assert.equal(l.git(dflt, "branch", "--show-current"), "");
  assert.equal(res.bases.app, "v3");
});

test("a re-attach changes nothing: an Agent's edit, and a moved remote-tracking ref", async () => {
  const l = await layout();
  const req = { slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "develop" }] };
  const first = await l.attach(req);
  const dflt = join(l.workRoot, "app", "default");
  l.git(dflt, "update-ref", "refs/remotes/origin/develop", l.git(l.src, "rev-parse", "main"));
  await writeFile(join(dflt, "edit"), "an Agent's edit in default/");
  const second = await l.attach(req);
  assert.deepEqual(second, first);
  assert.ok(existsSync(join(dflt, "edit")));
  assert.equal(l.git(dflt, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "develop"));
});

test("attach is idempotent: a second attach finds everything present and answers the same paths", async () => {
  const l = await layout();
  const req = { slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] };
  const first = await l.attach(req);
  const dflt = join(l.workRoot, "app", "default");
  await writeFile(join(dflt, "work-in-progress"), "kept");
  const second = await l.attach(req);
  assert.deepEqual(second, first);
  assert.ok(existsSync(join(dflt, "work-in-progress")), "default/ is not reset");
});

test("a failed step names its slot and carries git's own stderr", async () => {
  const l = await layout();
  const err = await l
    .attach({
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

test("attachFault refuses a slot that starts with a dot, and keeps a dot inside a name", () => {
  const slot = { slot: "app", url: "u", identity: "i", key: "k" };
  for (const name of [".jr2", ".hidden"]) {
    assert.match(
      attachFault({ slots: [{ ...slot, slot: name }] }) ?? "",
      /cannot start with "\.", because \/work\/\.jr2\/ is reserved for jr2 \(ADR-0075\)/,
    );
  }
  assert.equal(attachFault({ slots: [{ ...slot, slot: "v2.x" }] }), undefined);
});

test("attachFault refuses a body that is not an AttachRequest, naming what is wrong", () => {
  const slot = { slot: "app", url: URL_, identity: IDENTITY, key: KEY };
  assert.equal(attachFault({ slots: [slot] }), undefined);
  assert.equal(attachFault({ slots: [{ ...slot, ref: "main" }] }), undefined);
  assert.match(attachFault(undefined) ?? "", /AttachRequest/);
  assert.match(attachFault({ slots: [] }) ?? "", /names no Repo Slot/);
  assert.match(attachFault({ slots: [{ ...slot, key: undefined }] }) ?? "", /key/);
  assert.match(attachFault({ slots: [{ ...slot, ref: 3 }] }) ?? "", /ref/);
  // The slot and key are directory names under /work and /repos: never a path out of them.
  for (const bad of ["..", ".", "a/b", ""]) {
    assert.match(attachFault({ slots: [{ ...slot, slot: bad }] }) ?? "", /slot/, `slot ${bad}`);
    assert.match(attachFault({ slots: [{ ...slot, key: bad }] }) ?? "", /key/, `key ${bad}`);
  }
  assert.match(attachFault({ slots: [slot, slot] }) ?? "", /twice/);
});

// ADR-0076 (G2): jr2's own git for the attach runs confined. The cache's objects are moved to a
// store the policy denies, which the cache names in its `objects/info/alternates`: a git that ran
// unconfined would read them, and the clone would land; the confined one cannot, and the attach
// fails at its clone.
test("the attach's git runs confined: a store the cache names outside its reach is not read (ADR-0076)", async () => {
  const l = await layout();
  const cache = join(l.root, "repos", KEY);
  const denied = deniedDir("jr2-attach-denied-");
  execFileSync("cp", ["-a", join(cache, "objects"), join(denied, "objects")]);
  execFileSync("sh", ["-c", `cd "${join(cache, "objects")}" && rm -rf -- [0-9a-f][0-9a-f] pack/*`]);
  await writeFile(join(cache, "objects", "info", "alternates"), `${join(denied, "objects")}\n`);
  assert.ok(l.git(cache, "rev-parse", "main"), "unconfined, git reads the store");
  const attach = attacher({
    children: testChildren({ tmp: l.root, repos: join(l.root, "repos"), deny: [denied] }),
    paths: { workRoot: l.workRoot, reposMount: join(l.root, "repos"), runtime: l.runtime },
    env: { GIT_CONFIG_GLOBAL: l.globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  await assert.rejects(attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] }), AttachFault);
});

test("the slot's folder is made in the domain: a /work that links to a denied folder gets nothing there (ADR-0076)", async () => {
  const l = await layout();
  const denied = deniedDir("attach-work-");
  await symlink(denied, l.workRoot);
  const attach = attacher({
    children: testChildren({ tmp: l.root, repos: l.reposMount, deny: [denied] }),
    paths: { workRoot: l.workRoot, reposMount: l.reposMount, runtime: l.runtime },
    env: { GIT_CONFIG_GLOBAL: l.globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  await assert.rejects(
    attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] }),
    (err: unknown) => {
      assert.ok(err instanceof AttachFault);
      assert.match(err.message, /make the slot's folder/);
      return true;
    },
  );
  assert.deepEqual(await readdir(denied), [], "the Harness process made no folder through the link");
});

// --- Git LFS (ADR-0053) ----------------------------------------------------------------------------------

const LFS_HOOKS = ["post-checkout", "post-commit", "post-merge", "pre-push"];

test("the attach writes git-lfs's filter and jr2's transfer agent in the clone's config, by absolute path", async () => {
  const l = await layout();
  await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] });
  const dflt = join(l.workRoot, "app", "default");
  const bin = join(l.runtime, "bin");
  const local = (key: string) => l.git(dflt, "config", "--local", key);
  assert.equal(local("filter.lfs.process"), `${bin}/git-lfs filter-process`);
  assert.equal(local("filter.lfs.clean"), `${bin}/git-lfs clean -- %f`);
  assert.equal(local("filter.lfs.smudge"), `${bin}/git-lfs smudge -- %f`);
  assert.equal(local("filter.lfs.required"), "true");
  assert.equal(local("lfs.standalonetransferagent"), "jr2");
  assert.equal(local("lfs.customtransfer.jr2.path"), `${bin}/jr2-lfs`);
  assert.equal(local("lfs.customtransfer.jr2.args"), "transfer");
  assert.equal(local("lfs.customtransfer.jr2.concurrent"), "true");
  assert.equal(local("lfs.customtransfer.jr2.direction"), "download");
  // No `git lfs install`: nothing global, and no hooksPath anywhere.
  assert.equal((await readFile(l.globalConfig, "utf8")).includes("lfs"), false);
  assert.throws(() => l.git(dflt, "config", "core.hooksPath"));
});

test("the attach writes git-lfs's four hooks by absolute path, and only where the clone has none", async () => {
  const l = await layout();
  const dflt = join(l.workRoot, "app", "default");
  // A kill after the clone, and a hook that a user wrote before the next attach.
  await mkdir(join(l.workRoot, "app"), { recursive: true });
  l.git(l.root, "clone", "-q", "--shared", "--no-checkout", join(l.reposMount, KEY), dflt);
  const mine = "#!/bin/sh\necho mine\n";
  await writeFile(join(dflt, ".git", "hooks", "post-commit"), mine, { mode: 0o755 });
  await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] });
  const hooks = join(dflt, ".git", "hooks");
  assert.equal(await readFile(join(hooks, "post-commit"), "utf8"), mine, "a hook that a user wrote stays");
  for (const hook of LFS_HOOKS.filter((h) => h !== "post-commit")) {
    const text = await readFile(join(hooks, hook), "utf8");
    assert.equal(text, `#!/bin/sh\nexec '${join(l.runtime, "bin", "git-lfs")}' ${hook} "$@"\n`, hook);
    assert.ok(((await stat(join(hooks, hook))).mode & 0o111) !== 0, `${hook} is executable`);
  }
  assert.deepEqual(
    (await readdir(hooks)).filter((f) => f.includes("jr2-tmp")),
    [],
    "no temp file is left",
  );
});

test("the attach asks for the base's large files before the checkout, and then checks out the base", async () => {
  const l = await layout();
  await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "develop" }] });
  const dflt = join(l.workRoot, "app", "default");
  const calls = await l.lfsCallsOf();
  assert.equal(calls.length, 1, calls.join("\n"));
  const [args, cwd, held] = calls[0]!.split(" | ");
  assert.equal(args, `fetch --identity ${IDENTITY} --base develop -- ${l.git(l.src, "rev-parse", "develop")}`);
  assert.equal(cwd, dflt);
  assert.equal(held?.trim(), ".git", "nothing was checked out when jr2-lfs ran");
  assert.equal(l.git(dflt, "status", "--porcelain"), "", "the checkout is whole");
  assert.equal(l.git(dflt, "symbolic-ref", "--short", "HEAD"), "develop");
});

test("a kill between the clone and the checkout: the next attach places default/ on the base", async () => {
  const l = await layout();
  const dflt = join(l.workRoot, "app", "default");
  await mkdir(join(l.workRoot, "app"), { recursive: true });
  l.git(l.root, "clone", "-q", "--shared", "--no-checkout", join(l.reposMount, KEY), dflt);
  const res = await l.attach({ slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] });
  assert.equal(res.bases.app, "main");
  assert.equal(l.git(dflt, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(l.git(dflt, "rev-parse", "HEAD"), l.git(l.src, "rev-parse", "main"));
  assert.equal(l.git(dflt, "status", "--porcelain"), "", "default/ holds the base's files");
  // A kill after a checkout of another base, before the base was recorded.
  const other = await layout();
  const req = { slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY, ref: "develop" }] };
  const oDflt = join(other.workRoot, "app", "default");
  await mkdir(join(other.workRoot, "app"), { recursive: true });
  other.git(other.root, "clone", "-q", "--shared", "--no-checkout", join(other.reposMount, KEY), oDflt);
  other.git(oDflt, "checkout", "-q", "--track", "-b", "develop", "origin/develop");
  other.git(oDflt, "branch", "-D", "main");
  assert.deepEqual((await other.attach(req)).bases, { app: "develop" });
  assert.equal(other.git(oDflt, "symbolic-ref", "--short", "HEAD"), "develop");
  assert.equal(other.git(oDflt, "status", "--porcelain"), "");
});

test("a large file that the node cache cannot get fails the attach, naming the slot, the file and the reason", async () => {
  const l = await layout();
  const missing = [
    { path: "assets/logo.png", oid: "a".repeat(64), reason: "batch response: Repository or object not found" },
  ];
  await writeFile(l.lfsAnswer, `${JSON.stringify({ pointers: 1, asked: 1, missing })}\n`);
  const req = { slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] };
  const err = await l.attach(req).then(
    () => assert.fail("expected the attach to fail"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof AttachFault);
  assert.equal(err.slot, "app");
  assert.match(err.message, /slot "app"/);
  assert.match(err.message, /assets\/logo\.png/);
  assert.match(err.message, /Repository or object not found/);
  const dflt = join(l.workRoot, "app", "default");
  assert.deepEqual(await readdir(dflt), [".git"], "nothing is checked out");
  assert.throws(() => l.git(dflt, "config", "--local", "jr2.base"), "the base is not recorded");
  // The cache gets the object later: the next attach places default/.
  await writeFile(l.lfsAnswer, `${JSON.stringify({ pointers: 1, asked: 1, missing: [] })}\n`);
  assert.deepEqual((await l.attach(req)).bases, { app: "main" });
  assert.equal(l.git(dflt, "status", "--porcelain"), "");
});

test("a second attach asks for no large file: the base is placed", async () => {
  const l = await layout();
  const req = { slots: [{ slot: "app", url: URL_, identity: IDENTITY, key: KEY }] };
  await l.attach(req);
  await l.attach(req);
  assert.equal((await l.lfsCallsOf()).length, 1);
});
