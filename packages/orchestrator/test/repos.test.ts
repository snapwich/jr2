// ensureRepos — the boot-time source-volume reconcile (ADR-0004/0009), against a fake git runner
// plus real temp dirs (the presence check is filesystem truth; only git itself is faked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepos, startRepoReconcile, type RepoSync } from "../src/repos.ts";

function fakeGit() {
  const calls: string[][] = [];
  return { calls, git: async (args: string[]) => void calls.push(args) };
}

/** A git that fails the named repos' NETWORK calls (clone/fetch), and only those — the pinning
 * still runs, exactly as it does against a real git that cannot reach a host. */
function brokenGit(broken: (args: string[]) => string | undefined) {
  const calls: string[][] = [];
  return {
    calls,
    git: async (args: string[]) => {
      const why = broken(args);
      if (why) throw new Error(why);
      calls.push(args);
    },
  };
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

test("one repo's failure is one repo's result — the pass reports per repo and never throws (ADR-0048)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-fail-"));
  // `app` cannot clone (an unregistered deploy key is exactly this); `infra` is fine.
  const { git } = brokenGit((args) =>
    args.includes("git@forge:me/app.git") ? "Permission denied (publickey)." : undefined,
  );

  const synced = await ensureRepos(
    {
      repos: [
        { name: "app", url: "git@forge:me/app.git" },
        { name: "infra", url: "https://forge/me/infra.git" },
      ],
    },
    dir,
    git,
  );

  assert.equal(synced.length, 2);
  const app = synced.find((s) => s.name === "app")!;
  assert.match(app.error!, /Permission denied \(publickey\)\./, "git's own error is carried, verbatim");
  assert.equal(app.action, undefined);
  // The unreachable repo does not take the reachable one with it — that is the whole claim.
  assert.equal(synced.find((s) => s.name === "infra")!.action, "cloned");
});

test("the reconcile boots past a failing repo, and keeps retrying it until it syncs (ADR-0048)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-retry-"));
  let attempts = 0;
  const { calls, git } = brokenGit((args) => {
    // Only `app`'s clone is broken, and only for its first two attempts — the git host comes back
    // (or the key is finally registered) on the third.
    if (!args.includes("git@forge:me/app.git")) return undefined;
    return ++attempts <= 2 ? "Could not read from remote repository." : undefined;
  });

  const announced: RepoSync[] = [];
  const waits: number[] = [];
  const reconcile = startRepoReconcile({
    config: {
      repos: [
        { name: "app", url: "git@forge:me/app.git" },
        { name: "infra", url: "https://forge/me/infra.git" },
      ],
    },
    reposDir: dir,
    git,
    onSync: (sync) => void announced.push(sync),
    minDelayMs: 10,
    maxDelayMs: 40,
    wait: async (ms) => void waits.push(ms),
  });

  await reconcile.first;
  // The boot does not wait for the retries: the first pass is settled, `app` is failed, and the
  // instance is already serving with `infra` usable.
  assert.deepEqual(
    reconcile.state().map((r) => `${r.name}:${r.synced}`),
    ["app:false", "infra:true"],
  );
  assert.match(reconcile.errorFor("app")!, /Could not read from remote repository\./);
  assert.equal(reconcile.errorFor("infra"), undefined);

  // …and the loop keeps going on its own until the repo syncs.
  await waitFor(() => reconcile.errorFor("app") === undefined);
  assert.deepEqual(reconcile.state(), [
    { name: "app", synced: true, action: "cloned" },
    { name: "infra", synced: true, action: "cloned" },
  ]);

  // Backoff doubles, capped — and it never gives up while a repo is still failing.
  assert.deepEqual(waits, [10, 20]);
  // Every attempt is announced, failures with git's own error (what reaches the pod log), and the
  // retry passes touch ONLY the failed repo: `infra` synced once and is never re-fetched.
  assert.deepEqual(
    announced.map((a) => `${a.name}:${a.action ?? "error"}`),
    ["app:error", "infra:cloned", "app:error", "app:cloned"],
  );
  assert.equal(calls.filter((c) => c.includes("https://forge/me/infra.git")).length, 1);
  reconcile.stop();
});

test("the reconcile's attempt count is what makes a slow backoff legible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-attempts-"));
  const { git } = brokenGit((args) => (args.includes("clone") ? "fatal: repository not found" : undefined));
  const reconcile = startRepoReconcile({
    config: { repos: [{ name: "app", url: "https://forge/me/gone.git" }] },
    reposDir: dir,
    git,
    minDelayMs: 1,
    maxDelayMs: 1,
    wait: async () => {},
  });
  await reconcile.first;
  await waitFor(() => (reconcile.state()[0]!.attempts ?? 0) >= 3);
  reconcile.stop();
  const [app] = reconcile.state();
  assert.equal(app!.synced, false);
  assert.match(app!.error!, /repository not found/);
  assert.ok((app!.attempts ?? 0) >= 3, "consecutive failures are counted, not collapsed");
});

test("stop() ends the retry loop — a closed instance leaves no git running behind it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-repos-stop-"));
  let passes = 0;
  const git = async (args: string[]) => {
    if (args.includes("clone")) {
      passes++;
      throw new Error("fatal: could not read Username");
    }
  };
  const reconcile = startRepoReconcile({
    config: { repos: [{ name: "app", url: "https://forge/me/private.git" }] },
    reposDir: dir,
    git,
    wait: async () => {},
  });
  await reconcile.first;
  reconcile.stop();
  const seen = passes;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(passes, seen, "no pass runs after stop()");
});

/** Poll a predicate the retry loop settles asynchronously (the loop owns its own scheduling). */
async function waitFor(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
