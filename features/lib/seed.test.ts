// The seed Repo's init container (ADR-0051, ADR-0053): a node restart re-runs it on the same
// emptyDir, so it must succeed there and keep what scenarios pushed. Run with the host's git and sh,
// on temp dirs in place of `/srv` and `/tmp/w`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { lfsPointer, lfsRepoScript, makeRepoScript, type LfsRepoSpec } from "../steps/seed.ts";

const exec = promisify(execFile);

/** Every temp dir a test made, removed once the file's tests are done. */
const roots: string[] = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seed-"));
  roots.push(root);
  return root;
}

test("the make-repo script runs again on the same volume, and keeps a branch a scenario pushed", async () => {
  const root = await tempRoot();
  const srv = join(root, "srv");
  await mkdir(srv);
  const script = makeRepoScript(srv, join(root, "w"));

  await exec("sh", ["-ec", script]);
  const main = (await exec("git", ["-C", join(srv, "app.git"), "rev-parse", "main"])).stdout.trim();
  await exec("git", ["-C", join(srv, "app.git"), "branch", "pushed", main]);

  // A node restart: the init container runs again over the same emptyDir.
  await exec("sh", ["-ec", script]);
  assert.equal((await exec("git", ["-C", join(srv, "app.git"), "rev-parse", "main"])).stdout.trim(), main);
  assert.equal((await exec("git", ["-C", join(srv, "app.git"), "rev-parse", "pushed"])).stdout.trim(), main);
  await exec("git", ["-C", join(srv, "other.git"), "rev-parse", "main"]);
  // The push remote (ADR-0067): app's content, its own repository.
  await exec("git", ["-C", join(srv, "push.git"), "rev-parse", "main"]);
  // The GPG push remote (ADR-0068): the same content, its own repository.
  await exec("git", ["-C", join(srv, "gpg.git"), "rev-parse", "main"]);
});

test("a run cut halfway leaves nothing a second run mistakes for done", async () => {
  const root = await tempRoot();
  const srv = join(root, "srv");
  await mkdir(join(srv, "app.git.new"), { recursive: true }); // the half-made clone of a cut run
  await exec("sh", ["-ec", makeRepoScript(srv, join(root, "w"))]);
  await exec("git", ["-C", join(srv, "app.git"), "rev-parse", "main"]);
});

test("an LFS repository holds canonical pointers on main and its branches, and names the seed's LFS server", async () => {
  const root = await tempRoot();
  const srv = join(root, "srv");
  await mkdir(srv);
  const a = { oid: "a".repeat(64), size: 10 };
  const b = { oid: "b".repeat(64), size: 2048 };
  const c = { oid: "c".repeat(64), size: 7 };
  const spec: LfsRepoSpec = {
    main: [{ "big.bin": a }, { "big.bin": b, "d/other.bin": c }],
    branches: { side: { "big.bin": c } },
  };
  // The seed's git has no git-lfs filter; the host's global config may have one, which would smudge.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  await exec("sh", ["-ec", lfsRepoScript(srv, join(root, "w"), "lfs-x", spec)], { env });
  const repo = join(srv, "lfs-x.git");
  const show = async (spec: string) => (await exec("git", ["-C", repo, "show", spec])).stdout;
  assert.equal(await show("main~1:big.bin"), lfsPointer(a));
  assert.equal(await show("main:big.bin"), lfsPointer(b));
  assert.equal(await show("main:d/other.bin"), lfsPointer(c));
  assert.equal(await show("side:big.bin"), lfsPointer(c));
  assert.equal((await exec("git", ["-C", repo, "rev-list", "--count", "main"])).stdout.trim(), "3");
  assert.match(await show("main:.gitattributes"), /^\*\.bin filter=lfs diff=lfs merge=lfs -text$/m);
  const url = await exec("git", ["config", "--blob", "main:.lfsconfig", "lfs.url"], { cwd: repo });
  assert.equal(url.stdout.trim(), "http://lfs.jr2-e2e-seed.svc/lfs-x/info/lfs");
  // git-lfs reads each one as a pointer, when the host has git-lfs.
  const lfs = await exec("git", ["lfs", "version"]).catch(() => undefined);
  if (lfs !== undefined) {
    const listed = await exec("git", ["lfs", "ls-files", "--long", "main"], { cwd: repo });
    assert.match(listed.stdout, new RegExp(`${b.oid} [-*] big.bin`));
    assert.match(listed.stdout, new RegExp(`${c.oid} [-*] d/other.bin`));
  }
  // The dumb HTTP protocol reads the refs that update-server-info wrote.
  assert.match((await exec("cat", [join(repo, "info", "refs")])).stdout, /refs\/heads\/side/);
});
