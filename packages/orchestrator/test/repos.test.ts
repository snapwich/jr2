// ensureRepos — the boot-time source-volume reconcile (ADR-0009), against a fake git runner
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

test("fresh repo → clone (+ checkout when ref is pinned); existing repo → fetch", async () => {
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
  assert.deepEqual(calls, [
    ["clone", "git@forge:me/app.git", join(dir, "app", "default")],
    ["-C", join(dir, "app", "default"), "checkout", "release"],
    ["-C", existing, "fetch", "--all", "--prune"],
  ]);
});
