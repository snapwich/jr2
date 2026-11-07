// The attach and the cut with Git LFS (ADR-0053, ADR-0075), behind the REAL programs: git-lfs from the
// host, and `jr2-lfs` and `jr2-upload-pack` built from the operator module, as cut-ext.test.ts builds
// the second. A stand-in Custodian answers as the Orchestrator and the cache agent do together: a fetch
// ask lands at once, and an LFS ask copies each asked object from the remote's LFS store into the node
// cache's `lfs/objects`, then answers. It skips without git-lfs or Go.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { attacher } from "../src/attach.ts";
import { cut, type CutAnswer, type CutRequest } from "../src/cut.ts";
import { testChildren } from "./support/children.ts";

const LOCK = ["flock", "-x", "0"];
const here = fileURLToPath(new URL(".", import.meta.url));
const operator = resolve(here, "../../../operator");
const IDENTITY = "example.test/app";
const KEY = "example-test-app-0000";

const gitLfs = spawnSync("sh", ["-c", "command -v git-lfs"], { encoding: "utf8" }).stdout.trim();
const hasGo = spawnSync("go", ["version"]).status === 0;
const skip = gitLfs === "" ? "no git-lfs on this host" : !hasGo ? "no Go on this host" : false;

let bin: string | undefined;
/** jr2-lfs and jr2-upload-pack, built once, beside git-lfs and a stub work-acl: a runtime volume. */
function runtime(): string {
  if (bin) return bin;
  const root = mkdtempSync(join(tmpdir(), "cut-lfs-bin-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  for (const p of ["jr2-lfs", "jr2-upload-pack"]) {
    execFileSync("go", ["build", "-o", join(bin, p), `./cmd/${p}`], { cwd: operator, stdio: "ignore" });
  }
  symlinkSync(gitLfs, join(bin, "git-lfs"));
  writeFileSync(join(bin, "work-acl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

/** The git env of the fixture: no config of the developer's. */
function sealed(dir: string): NodeJS.ProcessEnv {
  const global = join(dir, "gitconfig");
  if (!existsSync(global)) writeFileSync(global, "");
  return { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: "/dev/null" };
}

const objectPath = (lfs: string, oid: string) => join(lfs, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);

type Custodian = {
  url: string;
  lfsAsks: () => number;
  /** Called at each LFS ask: what the world was like when it came. */
  probe: { at?: () => string; seen: string[] };
  fetchAsks: () => number;
  /** The remote is down: a fetch ask answers stale, and an LFS ask answers git-lfs's words. */
  down: () => void;
  close: () => void;
};

/** The Custodian's `POST /fetch`, with the Orchestrator and the cache agent behind it. */
function custodian(remoteLfs: string, cache: string): Promise<Custodian> {
  let lfsAsks = 0;
  let fetchAsks = 0;
  let isDown = false;
  const probe: Custodian["probe"] = { seen: [] };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += String(d)));
    req.on("end", () => {
      const ask = JSON.parse(body) as { identity: string; lfs?: { objects: Array<{ oid: string; size: number }> } };
      res.setHeader("content-type", "application/json");
      const at = new Date().toISOString();
      if (ask.lfs === undefined) {
        fetchAsks++;
        res.end(
          JSON.stringify(
            isDown
              ? { stale: "fatal: could not read from remote repository", asOf: "2026-11-01T00:00:00Z" }
              : { fetched: at },
          ),
        );
        return;
      }
      lfsAsks++;
      if (probe.at) probe.seen.push(probe.at());
      if (isDown) {
        res.end(JSON.stringify({ lfs: { answered: at, error: "batch request: dial tcp: connection refused" } }));
        return;
      }
      let missing = 0;
      for (const o of ask.lfs.objects) {
        const from = objectPath(remoteLfs, o.oid);
        if (!existsSync(from)) {
          missing++;
          continue;
        }
        const to = objectPath(join(cache, "lfs"), o.oid);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      res.end(
        JSON.stringify({
          lfs: { answered: at, ...(missing > 0 ? { error: "[404] Object does not exist on the server" } : {}) },
        }),
      );
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        lfsAsks: () => lfsAsks,
        probe,
        fetchAsks: () => fetchAsks,
        down: () => (isDown = true),
        close: () => server.close(),
      }),
    ),
  );
}

/**
 * A remote with `main` (an LFS file `big.bin` and a plain `a.txt`), `feature` (one more LFS file), and
 * `nolfs` (no LFS at all). Its LFS store is the seed's own. The node cache is a bare clone with an
 * empty `lfs/`. The slot `app` is attached by the real attach.
 */
async function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cut-lfs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = sealed(dir);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const b = runtime();
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed], { env });
  git(seed, "config", "filter.lfs.process", `${gitLfs} filter-process`);
  git(seed, "config", "filter.lfs.required", "true");
  writeFileSync(join(seed, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  const content = (name: string) => `${name}: ${"x".repeat(2000)}\n`;
  writeFileSync(join(seed, "big.bin"), content("big"));
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "first");
  git(seed, "switch", "-qc", "feature");
  writeFileSync(join(seed, "more.bin"), content("more"));
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "more");
  git(seed, "switch", "-q", "--orphan", "nolfs");
  rmSync(join(seed, "big.bin"), { force: true });
  rmSync(join(seed, "more.bin"), { force: true });
  rmSync(join(seed, ".gitattributes"), { force: true });
  writeFileSync(join(seed, "plain.txt"), "plain\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "plain");
  git(seed, "switch", "-q", "main");
  const remoteLfs = join(seed, ".git", "lfs");
  const reposMount = join(dir, "repos");
  const cache = join(reposMount, KEY);
  execFileSync("git", ["clone", "-q", "--bare", seed, cache], { env });
  mkdirSync(join(cache, "lfs"));

  const c = await custodian(remoteLfs, cache);
  t.after(() => c.close());
  const workRoot = join(dir, "work");
  const runtimeRoot = dirname(b);
  const attach = attacher({
    children: testChildren({ tmp: dir, repos: reposMount }),
    paths: { workRoot, reposMount, runtime: runtimeRoot },
    env: { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: "/dev/null", JR2_CUSTODIAN_URL: c.url },
  });
  const clone = join(workRoot, "app", "default");
  const paths = {
    workRoot,
    lock: LOCK,
    gitLfs: join(b, "git-lfs"),
    jr2Lfs: join(b, "jr2-lfs"),
    env: { PATH: process.env.PATH, JR2_CUSTODIAN_URL: c.url },
  };
  let ids = 0;
  const go = (req: Omit<CutRequest, "id">) => cut({ id: `e${++ids}`, base: "main", ...req }, paths);
  return {
    dir,
    seed,
    cache,
    clone,
    remoteLfs,
    c,
    git,
    attach: (ref?: string) =>
      attach({
        slots: [
          { slot: "app", url: "https://example.test/app.git", identity: IDENTITY, key: KEY, ...(ref ? { ref } : {}) },
        ],
      }),
    go,
    content,
    path: (n: string) => join(workRoot, "app", n),
  };
}

const ready = (a: CutAnswer) => {
  assert.equal(a.outcome, "ready", JSON.stringify(a));
  return a as Extract<CutAnswer, { outcome: "ready" }>;
};
const refusal = (a: CutAnswer): string => {
  assert.equal(a.outcome, "refused", JSON.stringify(a));
  return (a as { reason: string }).reason;
};

test("the attach gets the base's large files, and default/ holds their content", { skip }, async (t) => {
  const w = await world(t);
  await w.attach();
  assert.equal(readFileSync(join(w.clone, "big.bin"), "utf8"), w.content("big"), "the content, not the pointer");
  assert.equal(w.git(w.clone, "status", "--porcelain"), "", "git status is clean");
  assert.equal(w.c.lfsAsks(), 1, "one ask, for the base's one object");
  // The hooks call git-lfs by absolute path: a commit in default/ with no git-lfs on PATH runs its hook.
  const onlyGit = join(w.dir, "only-git");
  mkdirSync(onlyGit);
  symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), join(onlyGit, "git"));
  const commit = spawnSync(
    join(onlyGit, "git"),
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
    { cwd: w.clone, env: { ...sealed(w.dir), PATH: onlyGit }, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  assert.doesNotMatch(commit.stderr, /not found/, commit.stderr);
});

test("the attach of a base whose large file the cache cannot get fails, naming the file", { skip }, async (t) => {
  const w = await world(t);
  rmSync(join(w.remoteLfs, "objects"), { recursive: true, force: true });
  await assert.rejects(w.attach(), (err: Error) => {
    assert.match(err.message, /slot "app"/);
    assert.match(err.message, /big\.bin/);
    assert.match(err.message, /Object does not exist on the server/);
    return true;
  });
  assert.deepEqual(readdirSync(w.clone), [".git"], "nothing is checked out");
});

test("a cut of a commit with an LFS file smudges it in the Worktree", { skip }, async (t) => {
  const w = await world(t);
  await w.attach();
  const hooks = readdirSync(join(w.clone, ".git", "hooks")).sort();
  const asks = w.c.lfsAsks();
  w.c.probe.at = () => (existsSync(w.path("f")) ? "the Worktree was there" : "before the Worktree");
  const a = ready(await w.go({ path: w.path("f"), branch: "feature" }));
  assert.deepEqual(w.c.probe.seen, ["before the Worktree"], "the cut asked before git changed anything");
  assert.equal(a.found, "remote");
  assert.equal(readFileSync(join(a.path, "more.bin"), "utf8"), w.content("more"));
  assert.equal(readFileSync(join(a.path, "big.bin"), "utf8"), w.content("big"));
  assert.equal(w.c.lfsAsks(), asks + 1, "one ask, for the one object that no store held");
  assert.equal(w.git(a.path, "status", "--porcelain"), "");
  assert.deepEqual(readdirSync(join(w.clone, ".git", "hooks")).sort(), hooks, "git-lfs wrote no hook");
  // A detached cut of the same commit: every object is held, so no ask.
  const d = ready(await w.go({ path: w.path("d"), detach: a.head }));
  assert.equal(readFileSync(join(d.path, "more.bin"), "utf8"), w.content("more"));
  assert.equal(w.c.lfsAsks(), asks + 1);
});

test("a cut whose large file cannot be had is refused, names the file, and leaves nothing", { skip }, async (t) => {
  const w = await world(t);
  await w.attach();
  // A commit pushed after the attach, whose object the remote's LFS server does not hold.
  w.git(w.seed, "switch", "-qc", "broken");
  writeFileSync(join(w.seed, "lost.bin"), w.content("lost"));
  w.git(w.seed, "add", ".");
  w.git(w.seed, "commit", "-qm", "lost");
  const oid = w.git(w.seed, "lfs", "ls-files", "--long").match(/^([0-9a-f]{64}) [-*] lost\.bin$/m)?.[1];
  assert.ok(oid);
  rmSync(objectPath(w.remoteLfs, oid), { force: true });
  w.git(w.cache, "fetch", "-q", w.seed, "+refs/heads/*:refs/heads/*");
  const reason = refusal(await w.go({ path: w.path("b"), branch: "broken" }));
  assert.match(reason, /^the node cache cannot get the large file of [0-9a-f]{40}: lost\.bin \([0-9a-f]{12}\): /);
  assert.match(reason, /Object does not exist on the server/);
  assert.equal(existsSync(w.path("b")), false, "no folder");
  assert.equal(existsSync(join(w.clone, ".git", "jr2-cuts", "b.json")), false, "no record");
  assert.equal(
    spawnSync("git", ["-C", w.clone, "rev-parse", "-q", "--verify", "refs/heads/broken"]).status,
    1,
    "no branch",
  );
  assert.doesNotMatch(w.git(w.clone, "worktree", "list", "--porcelain"), /\/b$/m);
  // A detached cut of it is refused the same way.
  const sha = w.git(w.seed, "rev-parse", "HEAD");
  assert.match(refusal(await w.go({ path: w.path("bd"), detach: sha })), /lost\.bin/);
  assert.equal(existsSync(w.path("bd")), false);
});

test("a dead remote with every object held: `ready` with `stale`", { skip }, async (t) => {
  const w = await world(t);
  await w.attach();
  // The feature's objects land in the cache first, by a detached cut of its commit.
  const sha = w.git(w.seed, "rev-parse", "feature");
  ready(await w.go({ path: w.path("first"), detach: sha }));
  w.c.down();
  const asks = w.c.lfsAsks();
  const a = ready(await w.go({ path: w.path("again"), branch: "feature" }));
  assert.equal(a.found, "remote");
  assert.ok(a.stale, "the fetch was stale");
  assert.equal(w.c.lfsAsks(), asks, "every object was held: no LFS ask");
  assert.equal(readFileSync(join(a.path, "more.bin"), "utf8"), w.content("more"));
});

test("a Repo with no LFS makes no ask", { skip }, async (t) => {
  const w = await world(t);
  await w.attach("nolfs");
  assert.equal(w.c.lfsAsks(), 0);
  const a = ready(await w.go({ path: w.path("p"), branch: "p2", from: "nolfs" }));
  assert.ok(existsSync(join(a.path, "plain.txt")));
  assert.equal(w.c.lfsAsks(), 0);
});

test("the Agent's config chooses no program of the cut's checkout", { skip }, async (t) => {
  const w = await world(t);
  await w.attach();
  const marker = join(w.dir, "ran");
  const evil = join(w.dir, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const included = join(w.dir, "included");
  writeFileSync(included, `[filter "lfs"]\n\tprocess = ${evil}\n`);
  for (const [k, v] of [
    ["filter.lfs.process", evil],
    ["filter.lfs.smudge", evil],
    ["lfs.standalonetransferagent", "evil"],
    ["lfs.customtransfer.evil.path", evil],
    ["lfs.customtransfer.jr2.path", evil],
    ["include.path", included],
  ]) {
    w.git(w.clone, "config", "--add", k!, v!);
  }
  const a = ready(await w.go({ path: w.path("f"), branch: "feature" }));
  assert.equal(readFileSync(join(a.path, "more.bin"), "utf8"), w.content("more"));
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
});
