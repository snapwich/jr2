// The seed Repo's init container (ADR-0051, ADR-0053): a node restart re-runs it on the same
// emptyDir, so it must succeed there and keep what scenarios pushed. Run with the host's git and sh,
// on temp dirs in place of `/srv` and `/tmp/w`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { makeRepoScript } from "../steps/seed.ts";

const exec = promisify(execFile);

test("the make-repo script runs again on the same volume, and keeps a branch a scenario pushed", async () => {
  const root = await mkdtemp(join(tmpdir(), "seed-"));
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
  const root = await mkdtemp(join(tmpdir(), "seed-"));
  const srv = join(root, "srv");
  await mkdir(join(srv, "app.git.new"), { recursive: true }); // the half-made clone of a cut run
  await exec("sh", ["-ec", makeRepoScript(srv, join(root, "w"))]);
  await exec("git", ["-C", join(srv, "app.git"), "rev-parse", "main"]);
});
