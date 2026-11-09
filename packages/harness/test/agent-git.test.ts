// An Agent's git and a bare repository (ADR-0080): each process of the domain gets
// `safe.bareRepository=explicit` after the start env's own `GIT_CONFIG_*` entries. With it, a bare
// repository that a commit holds runs nothing of its config on a `git status` in its folder, and
// an Agent's ordinary git — a push, a clone and a fetch by path, `--git-dir` — works as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_CONFIG, childEnv, withGitConfig } from "../src/children.ts";

const dirs = { home: "/h", tmp: "/t" };

test("childEnv: an Agent's git gets safe.bareRepository=explicit as git config entry 0 when the start env sets none", () => {
  const env = childEnv({ PATH: "/usr/bin" }, new Map(), [], undefined, dirs);
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "safe.bareRepository");
  assert.equal(env.GIT_CONFIG_VALUE_0, "explicit");
  assert.deepEqual(AGENT_GIT_CONFIG, [["safe.bareRepository", "explicit"]]);
});

test("childEnv: jr2's entry goes after the image's own GIT_CONFIG_* entries, which stay (ADR-0076)", () => {
  const lines: string[] = [];
  const env = childEnv(
    {
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.sslVerify",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "safe.bareRepository",
      GIT_CONFIG_VALUE_1: "all",
    },
    new Map(),
    [],
    undefined,
    dirs,
    (line) => lines.push(line),
  );
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.sslVerify");
  assert.equal(env.GIT_CONFIG_VALUE_0, "true");
  assert.equal(env.GIT_CONFIG_KEY_1, "safe.bareRepository");
  assert.equal(env.GIT_CONFIG_VALUE_1, "all");
  assert.equal(env.GIT_CONFIG_KEY_2, "safe.bareRepository");
  assert.equal(env.GIT_CONFIG_VALUE_2, "explicit");
  assert.deepEqual(lines, [], "a count is no fault: nothing is logged");
  // git reads the last entry of a key: jr2's, after the image's `all`.
  const r = spawnSync("git", ["config", "--get", "safe.bareRepository"], { encoding: "utf8", env: gitEnv(env) });
  assert.equal(r.stdout.trim(), "explicit");
});

test("withGitConfig: a GIT_CONFIG_COUNT that is not a count is replaced, and one line says so", () => {
  for (const raw of ["", "two", "-1", "1e3", "9999999"]) {
    const lines: string[] = [];
    const env: Record<string, string> = { GIT_CONFIG_COUNT: raw };
    withGitConfig(env, AGENT_GIT_CONFIG, (line) => lines.push(line));
    assert.equal(env.GIT_CONFIG_COUNT, "1", raw);
    assert.equal(env.GIT_CONFIG_KEY_0, "safe.bareRepository", raw);
    assert.equal(lines.length, 1, raw);
    assert.match(lines[0]!, /GIT_CONFIG_COUNT .* is not a count.*ADR-0080/);
  }
});

/** The domain's env for a git run here: jr2's entry, and no config file of this host. */
function gitEnv(domain: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...domain,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: mkdtempSync(join(tmpdir(), "jr2-agent-git-home-")),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@example.com",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@example.com",
  };
}

function git(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

function ok(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  const r = git(env, cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository whose commit holds `vendor/evil`, a bare repository whose config names an
 * fsmonitor that writes `marker` (the spike's case, ADR-0080). */
function plantedClone(env: NodeJS.ProcessEnv): { root: string; evil: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "jr2-agent-git-"));
  const marker = join(root, "fsmonitor-ran");
  const hook = join(root, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`);
  chmodSync(hook, 0o755);
  const author = join(root, "author");
  mkdirSync(author);
  ok(env, author, "init", "-q", "-b", "main");
  const bare = join(author, "vendor", "evil");
  mkdirSync(join(bare, "objects"), { recursive: true });
  mkdirSync(join(bare, "refs"));
  writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(bare, "objects", ".keep"), "");
  writeFileSync(join(bare, "refs", ".keep"), "");
  writeFileSync(
    join(bare, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${hook}\n`,
  );
  ok(env, author, "add", "-f", "vendor");
  ok(env, author, "commit", "-qm", "vendor a folder");
  const clone = join(root, "clone");
  ok(env, root, "clone", "-q", author, clone);
  return { root, evil: join(clone, "vendor", "evil"), marker };
}

test("a bare repository in a commit runs its fsmonitor on `git status` in its folder without jr2's entry, and not with it (ADR-0080)", () => {
  const without = gitEnv({});
  const bare = plantedClone(without);
  git(without, bare.evil, "status", "--short");
  assert.ok(existsSync(bare.marker), "the case is real: git without the entry ran the planted fsmonitor");

  const agent = gitEnv(childEnv({ PATH: "/usr/bin" }, new Map(), [], undefined, dirs));
  const planted = plantedClone(agent);
  const r = git(agent, planted.evil, "status", "--short");
  assert.ok(!existsSync(planted.marker), `the planted fsmonitor ran: ${readMarker(planted.marker)}`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /safe\.bareRepository/, "git's refusal names the setting");
  // In the clone's root, git is the clone's own, as before.
  ok(agent, join(planted.evil, "..", ".."), "status", "--short");
  assert.ok(!existsSync(planted.marker));
});

test("with jr2's entry, a push, a clone and a fetch by path, and --git-dir, work on a bare repository (ADR-0080)", () => {
  const env = gitEnv(childEnv({ PATH: "/usr/bin" }, new Map(), [], undefined, dirs));
  const root = mkdtempSync(join(tmpdir(), "jr2-agent-git-ok-"));
  const remote = join(root, "remote.git");
  ok(env, root, "init", "-q", "--bare", "-b", "main", remote);
  const work = join(root, "work");
  mkdirSync(work);
  ok(env, work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a\n");
  ok(env, work, "add", "a.txt");
  ok(env, work, "commit", "-qm", "a");
  const head = ok(env, work, "rev-parse", "HEAD");
  ok(env, work, "push", "-q", remote, "main");
  ok(env, root, "clone", "-q", remote, join(root, "copy"));
  assert.equal(ok(env, join(root, "copy"), "rev-parse", "HEAD"), head);
  ok(env, join(root, "copy"), "fetch", "-q", remote, "main");
  assert.equal(ok(env, root, "--git-dir", remote, "rev-parse", "main"), head);
  // `git -C bare.git` is the one form that is refused, and the refusal names the setting.
  const r = git(env, remote, "rev-parse", "main");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /safe\.bareRepository/);
});

function readMarker(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
