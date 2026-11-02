// The sync after a push whose published commit is not the Agent's own (ADR-0067), driven through REAL git in a temp layout shaped like the
// pod's: the Agent's clone at `<slot>/default` and its branch Worktree beside it (ADR-0004). The
// "Effector" here is a second clone that copies the Agent's commits with a new committer — what a
// signing does to an id — and writes their bundle with the Agent's tip as its prerequisite, as the
// Sandbox Effector does. Every claim is about what the Agent's repository holds after the sync:
// one ref moved, and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFault, syncer } from "../src/sync.ts";
import { deniedDir, testChildren } from "./support/children.ts";

const AGENT = {
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.test",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.test",
};

async function pod() {
  const root = await mkdtemp(join(tmpdir(), "jr2-harness-sync-"));
  const globalConfig = join(root, "gitconfig");
  await writeFile(globalConfig, "");
  const env = { ...process.env, ...AGENT, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const work = join(root, "work");
  const clone = join(work, "app", "default");
  await mkdir(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  await writeFile(join(clone, "README.md"), "base\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "base");
  const tree = join(work, "app", "jr2-work");
  git(clone, "worktree", "add", "-q", "-b", "jr2/work", tree);
  const commit = async (msg: string, file: string, body: string) => {
    await writeFile(join(tree, file), body);
    git(tree, "add", file);
    git(tree, "commit", "-q", "-m", msg);
    return git(tree, "rev-parse", "HEAD");
  };
  // The signing, as the Effector does it: each commit after main copied with a new committer, in a
  // repository of its own; the bundle's prerequisite is the Agent's tip.
  const sign = (sha: string) => {
    const effector = join(root, `effector-${sha.slice(0, 8)}`);
    git(root, "clone", "-q", "--bare", clone, effector);
    git(effector, "fetch", "-q", clone, `${sha}:refs/jr2/agent`);
    const list = git(effector, "rev-list", "--reverse", sha, "--not", "main").split("\n").filter(Boolean);
    const mapped = new Map<string, string>();
    for (const c of list) {
      const raw = git(effector, "cat-file", "commit", c);
      const copy = raw
        .split("\n")
        .map((l) => {
          if (l.startsWith("parent ")) return `parent ${mapped.get(l.slice(7)) ?? l.slice(7)}`;
          if (l.startsWith("committer ")) return "committer jr2 bot <bot@example.test> 1800000000 +0000";
          return l;
        })
        .join("\n");
      const id = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
        cwd: effector,
        env,
        input: `${copy}\n`,
        encoding: "utf8",
      }).trim();
      mapped.set(c, id);
    }
    const published = mapped.get(sha)!;
    git(effector, "update-ref", "refs/jr2/out", published);
    const file = join(root, `${sha.slice(0, 8)}.bundle`);
    git(effector, "bundle", "create", "-q", file, "refs/jr2/out", "--not", sha);
    return { published, source: sha, bundle: execFileSync("base64", ["-w0", file], { encoding: "utf8" }).trim() };
  };
  // An unsigned squash, as the Effector makes it: one new commit on main with the Agent's tree, made
  // by the entry's committer, signed by nothing; the bundle's prerequisite is the Agent's tip.
  const squash = (sha: string) => {
    const effector = join(root, `squash-${sha.slice(0, 8)}`);
    git(root, "clone", "-q", "--bare", clone, effector);
    git(effector, "fetch", "-q", clone, `${sha}:refs/jr2/agent`);
    const published = execFileSync("git", ["commit-tree", `${sha}^{tree}`, "-p", "main", "-m", "one squashed commit"], {
      cwd: effector,
      env: { ...env, GIT_COMMITTER_NAME: "jr2 bot", GIT_COMMITTER_EMAIL: "bot@example.test" },
      encoding: "utf8",
    }).trim();
    git(effector, "update-ref", "refs/jr2/out", published);
    const file = join(root, `squash-${sha.slice(0, 8)}.bundle`);
    git(effector, "bundle", "create", "-q", file, "refs/jr2/out", "--not", sha);
    return { published, source: sha, bundle: execFileSync("base64", ["-w0", file], { encoding: "utf8" }).trim() };
  };
  const hooks: { beforeMove?: () => Promise<void> } = {};
  const sync = syncer({
    // Confined as in a pod (ADR-0076): the fixture is the children's TMPDIR.
    children: testChildren({ tmp: root }),
    env: { GIT_CONFIG_GLOBAL: globalConfig },
    beforeMove: () => hooks.beforeMove?.() ?? Promise.resolve(),
  });
  return { root, work, clone, tree, git, commit, sign, squash, sync, hooks };
}

test("an unsigned squash is synced as signed copies are: the sync reads no signature (ADR-0067)", async () => {
  const p = await pod();
  await p.commit("one", "a.txt", "a\n");
  const tip = await p.commit("two", "b.txt", "b\n");
  const squashed = p.squash(tip);
  assert.doesNotMatch(
    p.git(p.root, "--git-dir", join(p.root, `squash-${tip.slice(0, 8)}`), "cat-file", "commit", squashed.published),
    /gpgsig/,
  );
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...squashed });
  assert.equal(answer.sync, "synced", JSON.stringify(answer));
  assert.equal(p.git(p.tree, "rev-parse", "refs/heads/jr2/work"), squashed.published);
  assert.equal(p.git(p.tree, "rev-list", "--count", "jr2/work", "--not", "main"), "1", "one commit after main");
});

test("a commit the Agent makes while the sync runs is never lost: the move is a compare-and-swap, tried again from the new tip", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  let raced = "";
  // Between the sync's read of the branch and its move, the Agent commits.
  p.hooks.beforeMove = async () => {
    if (raced) return;
    raced = await p.commit("made while the sync ran", "b.txt", "b\n");
  };
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "synced", JSON.stringify(answer));
  assert.equal((answer as { tries: number }).tries, 2, "the lost race is tried again");
  const now = p.git(p.tree, "rev-parse", "refs/heads/jr2/work");
  assert.equal(p.git(p.tree, "log", "-1", "--format=%s", now), "made while the sync ran", "the Agent's commit is kept");
  assert.equal(p.git(p.tree, "rev-parse", `${now}^`), signed.published, "on top of the signed commit");
  assert.equal(p.git(p.tree, "rev-parse", `${now}^{tree}`), p.git(p.tree, "rev-parse", `${raced}^{tree}`));
});

test("a sync moves the Agent's branch to the signed commits; files, index, HEAD and stash do not change", async () => {
  const p = await pod();
  await p.commit("one", "a.txt", "a\n");
  const tip = await p.commit("two", "b.txt", "b\n");
  await writeFile(join(p.tree, "a.txt"), "edited, not committed\n");
  await writeFile(join(p.tree, "staged.txt"), "staged\n");
  p.git(p.tree, "add", "staged.txt");
  const status = p.git(p.tree, "status", "--porcelain");
  const signed = p.sign(tip);
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "synced");
  assert.equal(p.git(p.tree, "rev-parse", "refs/heads/jr2/work"), signed.published);
  assert.equal(p.git(p.tree, "symbolic-ref", "HEAD"), "refs/heads/jr2/work", "HEAD still names the branch");
  assert.equal(p.git(p.tree, "status", "--porcelain"), status, "the files and the index did not change");
  assert.equal(await readFile(join(p.tree, "a.txt"), "utf8"), "edited, not committed\n");
  assert.match(p.git(p.tree, "reflog", "-1", "--format=%gs", "jr2/work"), /jr2 sync/, "the old tip is in the reflog");

  const again = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(again.sync, "already");
});

test("a commit the Agent made after the push is copied onto the signed tip, byte for byte but its parent", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  const after = await p.commit("three", "c.txt", "c\n");
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "synced");
  assert.equal(answer.sync === "synced" && answer.replayed, 1);
  const now = p.git(p.tree, "rev-parse", "jr2/work");
  assert.equal(p.git(p.tree, "rev-parse", `${now}^`), signed.published);
  assert.equal(p.git(p.tree, "rev-parse", `${now}^{tree}`), p.git(p.tree, "rev-parse", `${after}^{tree}`));
  assert.equal(
    p.git(p.tree, "log", "-1", "--format=%an %ae %at %cn %ce %ct %B", now),
    p.git(p.tree, "log", "-1", "--format=%an %ae %at %cn %ce %ct %B", after),
  );
});

test("a sync run again with no bundle uses the signed commits already in the store, and answers not-synced when there are none", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  const { bundle: _bundle, ...pair } = signed;
  const none = await p.sync({ worktree: p.tree, branch: "jr2/work", ...pair });
  assert.equal(none.sync, "not-synced");
  assert.equal(p.git(p.tree, "rev-parse", "jr2/work"), tip, "nothing moved");
  // A rebase was in progress at the first sync: the objects arrived, and the branch did not move.
  const rebase = join(p.clone, ".git", "worktrees", "jr2-work", "rebase-merge");
  await mkdir(rebase, { recursive: true });
  await writeFile(join(rebase, "head-name"), "refs/heads/jr2/work\n");
  const busy = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(busy.sync, "busy");
  assert.equal(p.git(p.tree, "rev-parse", "jr2/work"), tip, "nothing moved while busy");
  execFileSync("rm", ["-rf", rebase]);
  const later = await p.sync({ worktree: p.tree, branch: "jr2/work", ...pair });
  assert.equal(later.sync, "synced");
  assert.equal(p.git(p.tree, "rev-parse", "jr2/work"), signed.published);
});

test("a branch the Agent rewrote is not-synced; an unsigned push is skipped; neither changes anything", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  p.git(p.tree, "commit", "-q", "--amend", "-m", "reworded");
  const amended = p.git(p.tree, "rev-parse", "jr2/work");
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "not-synced");
  assert.match(answer.sync === "not-synced" ? answer.reason : "", /amended, rebased or reset/);
  assert.equal(p.git(p.tree, "rev-parse", "jr2/work"), amended);
  const skipped = await p.sync({ worktree: p.tree, branch: "jr2/work", published: amended, source: amended });
  assert.equal(skipped.sync, "skipped");
});

test("no program the Agent's repository names runs in the sync: a planted reference-transaction hook and fsmonitor", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  const ran = join(p.root, "ran");
  const hooks = join(p.clone, ".git", "hooks");
  for (const hook of ["reference-transaction", "post-rewrite", "post-checkout"]) {
    await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(ran)}\n`);
    await chmod(join(hooks, hook), 0o755);
  }
  const monitor = join(p.root, "fsmonitor");
  await writeFile(monitor, `#!/bin/sh\necho fsmonitor >> ${JSON.stringify(ran)}\n`);
  await chmod(monitor, 0o755);
  p.git(p.clone, "config", "core.fsmonitor", monitor);
  p.git(p.clone, "config", "core.alternateRefsCommand", monitor);
  const answer = await p.sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "synced");
  assert.equal(existsSync(ran), false, `a planted program ran: ${existsSync(ran) ? await readFile(ran, "utf8") : ""}`);
});

test("a sync request names a Worktree under /work, a branch, and two full commit ids", () => {
  const ok = { worktree: "/work/app/jr2-work", branch: "jr2/work", published: "a".repeat(40), source: "b".repeat(40) };
  assert.equal(syncFault(ok), undefined);
  assert.match(syncFault({ ...ok, worktree: "/etc" })!, /under \/work/);
  assert.match(syncFault({ ...ok, worktree: "/work/../etc" })!, /under \/work/);
  assert.match(syncFault({ ...ok, branch: "a..b" })!, /branch/);
  assert.match(syncFault({ ...ok, published: "abc" })!, /published/);
});

// ADR-0076 (G2): jr2's own git runs confined — a filter, a textconv or an object store that the
// repository names is read by git's own process. Here the clone's objects are in a store the policy
// denies, named by the clone's `objects/info/alternates`: a git that ran unconfined would read them
// and sync; the confined one cannot, and the sync says the repository does not hold the commit.
test("the sync's git runs confined: a store the repository names outside its reach is not read (ADR-0076)", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  const denied = deniedDir("jr2-sync-denied-");
  const objects = join(p.clone, ".git", "objects");
  execFileSync("cp", ["-a", objects, join(denied, "objects")]);
  execFileSync("sh", ["-c", `cd "${objects}" && rm -rf -- [0-9a-f][0-9a-f] pack/*`]);
  await writeFile(join(objects, "info", "alternates"), `${join(denied, "objects")}\n`);
  assert.equal(p.git(p.tree, "rev-parse", "HEAD"), tip, "unconfined, git reads the store");
  const confined = syncer({ children: testChildren({ tmp: p.root, deny: [denied] }), env: {} });
  const answer = await confined({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.notEqual(answer.sync, "synced", JSON.stringify(answer));
  assert.equal(p.git(p.tree, "rev-parse", "refs/heads/jr2/work"), tip, "the branch did not move");
});

// ADR-0076: the Harness process touches no path of the Agent's. The linked worktrees' names under
// the repository's git dir, which git output names, are listed by the spawner, and the bundle in
// the domain's TMPDIR is removed by the spawner, so the kernel applies the domain's rules to each.
test("the sync lists the linked worktrees and removes its bundle through the spawner, in the domain (ADR-0076)", async () => {
  const p = await pod();
  const tip = await p.commit("one", "a.txt", "a\n");
  const signed = p.sign(tip);
  const children = testChildren({ tmp: p.root });
  const asked: string[] = [];
  const { readdir, unlink } = children.spawner;
  children.spawner.readdir = (path: string) => (asked.push(`readdir ${path}`), readdir.call(children.spawner, path));
  children.spawner.unlink = (path: string) => (asked.push(`unlink ${path}`), unlink.call(children.spawner, path));
  const sync = syncer({ children, env: { GIT_CONFIG_GLOBAL: join(p.root, "gitconfig") } });
  const answer = await sync({ worktree: p.tree, branch: "jr2/work", ...signed });
  assert.equal(answer.sync, "synced", JSON.stringify(answer));
  assert.ok(asked.includes(`readdir ${join(p.clone, ".git", "worktrees")}`), asked.join("\n"));
  const removed = asked.filter((a) => a.startsWith("unlink "));
  assert.equal(removed.length, 1, asked.join("\n"));
  assert.match(removed[0]!, new RegExp(`^unlink ${p.root}/jr2-sync-[0-9a-f-]+\\.bundle$`));
  assert.equal(existsSync(removed[0]!.slice("unlink ".length)), false, "the bundle is gone");
  children.spawner.close();
});
