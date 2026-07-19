// ensureRepos — the boot-time source-volume reconcile (ADR-0004/0009), against a fake git runner
// plus real temp dirs (the presence check is filesystem truth; only git itself is faked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepos } from "../src/repos.ts";

function fakeGit() {
  const calls: string[][] = [];
  return { calls, git: async (args: string[]) => void calls.push(args) };
}

/** The ADR-0004 gc pinning every checkout gets — BEFORE any fetch can trigger `gc --auto`. */
const pin = (dir: string) => [
  ["-C", dir, "config", "gc.auto", "0"],
  ["-C", dir, "config", "gc.pruneExpire", "never"],
  ["-C", dir, "config", "maintenance.auto", "false"],
];

test("fresh repo → clone + pin (+ checkout when ref is pinned); existing repo → pin + fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-"));
  const { calls, git } = fakeGit();

  const existing = join(dir, "infra", "default");
  await mkdir(join(existing, ".git"), { recursive: true });

  const synced = await ensureRepos(
    {
      repos: [
        { name: "app", url: "git@forge:me/app.git", ref: "release" },
        { name: "infra", url: "../infra" },
      ],
    },
    dir,
    git,
  );

  assert.deepEqual(
    synced.map((s) => `${s.name}:${s.action}`),
    ["app:cloned", "infra:fetched"],
  );
  const app = join(dir, "app", "default");
  assert.deepEqual(calls, [
    ["clone", "git@forge:me/app.git", app],
    ...pin(app),
    ["-C", app, "checkout", "release"],
    ...pin(existing),
    ["-C", existing, "fetch", "--all", "--prune"],
  ]);
});

test("a checkout on disk without a config entry is ADOPTED: pinned + fetched, config optional", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-"));
  const { calls, git } = fakeGit();

  // The user's own `git clone` into the layout (ADR-0004: directory is the source of truth)…
  const manual = join(dir, "obsidian", "default");
  await mkdir(join(manual, ".git"), { recursive: true });
  // …a non-repo directory is not a catalog entry (no default/.git) and must be skipped…
  await mkdir(join(dir, "scratch"), { recursive: true });

  // …and `repos` may be omitted from the config entirely.
  const synced = await ensureRepos({}, dir, git);

  assert.deepEqual(
    synced.map((s) => `${s.name}:${s.action}`),
    ["obsidian:adopted"],
  );
  assert.deepEqual(calls, [...pin(manual), ["-C", manual, "fetch", "--all", "--prune"]]);
});

test("a configured repo is never double-synced by the adoption scan; missing repos/ dir is fine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-"));
  const { calls, git } = fakeGit();

  const existing = join(dir, "app", "default");
  await mkdir(join(existing, ".git"), { recursive: true });

  const synced = await ensureRepos({ repos: [{ name: "app", url: "git@forge:me/app.git" }] }, dir, git);
  assert.deepEqual(
    synced.map((s) => `${s.name}:${s.action}`),
    ["app:fetched"],
  );
  assert.equal(calls.filter((c) => c.includes("fetch")).length, 1);

  // An instance with no repos/ at all reconciles to nothing (workspace-less, or first boot).
  assert.deepEqual(await ensureRepos({}, join(dir, "absent"), git), []);
});

test("git creds (ADR-0019): an HTTPS token and a deploy key ride every network git call as -c config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-creds-"));
  const { calls, git } = fakeGit();

  await ensureRepos({ repos: [{ name: "app", url: "https://forge/me/app.git" }] }, dir, git, {
    tokenEnv: "J2_GIT_TOKEN",
    sshKeyPath: "/etc/j2/git-ssh/key",
  });

  const clone = calls.find((c) => c.includes("clone"))!;
  const helper = clone.join(" ");
  assert.match(helper, /credential\.helper/, "the token rides a credential helper");
  assert.match(helper, /J2_GIT_TOKEN/, "…that reads the ENV, so the token never lands in argv");
  assert.match(helper, /core\.sshCommand=ssh -i \/etc\/j2\/git-ssh\/key/, "the deploy key rides core.sshCommand");

  // Config-only calls (the gc pinning) carry no cred flags — they never touch the network.
  const pinCall = calls.find((c) => c.includes("gc.auto"))!;
  assert.ok(!pinCall.join(" ").includes("credential.helper"));
});
