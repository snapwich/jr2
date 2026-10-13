// The output a command-Effect claim's model reads is setup (ADR-0066): it must be a real failure of
// a test the Worktree holds, with nothing else in the Worktree to fix. The `answered` claim once ran
// a fixed command that named `auth.test.ts`, a file its Worktree did not hold, and two of ten trials
// went to fix the tests the output did not name. These run the claims' suite against the seed's
// billing project, with the host's git and node on temp dirs, and hold both claims to it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { billing, suite } from "../model-instance/workflows/_seed.ts";
import { makeRepoScript } from "../steps/seed.ts";

const exec = promisify(execFile);
const workflows = fileURLToPath(new URL("../model-instance/workflows/", import.meta.url));

/** The bound Repo as the Worktree holds it: a clone of the seed's repository at the Binding's ref. */
async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "model-seed-"));
  const srv = join(root, "srv");
  await mkdir(srv);
  await exec("sh", ["-ec", makeRepoScript(srv, join(root, "w"))]);
  const work = join(root, "work");
  await exec("git", ["clone", "-q", "--branch", billing.ref, join(srv, basename(billing.url)), work]);
  return work;
}

test("the claims' suite fails one test of the bound Repo, and its output names only files the Worktree holds", async () => {
  const work = await worktree();
  const files = (await exec("git", ["-C", work, "ls-files"])).stdout.split("\n").filter(Boolean).sort();
  assert.deepEqual(files, ["billing.js", "billing.test.js", "package.json"], "the Worktree holds nothing else");

  const [program, ...args] = suite;
  // As the pod runs it: not as a child of this test runner, which would take its report.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const ran = await exec(program, args, { cwd: work, env }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
  assert.equal(ran.code, 1, ran.out);
  assert.match(ran.out, /ℹ pass 1\n/);
  assert.match(ran.out, /ℹ fail 1\n/);
  assert.match(ran.out, /✖ a total rounds to the nearest cent/);
  assert.match(ran.out, /2148 !== 2149/);
  const named = [...new Set([...ran.out.matchAll(/[\w-]+\.test\.[cm]?[jt]s\b/g)].map((m) => m[0]))];
  assert.deepEqual(named, ["billing.test.js"], "the output names the failing test's file and no other");
  for (const file of named) assert.ok(files.includes(file), `the output names ${file}, which the Worktree holds`);
});

test("answered and allowed-after-route bind the billing Repo and run its suite, and no other command", async () => {
  for (const claim of ["answered", "allowed-after-route"]) {
    const source = await readFile(join(workflows, `${claim}.ts`), "utf8");
    assert.match(source, /import \{ billing, suite \} from "\.\/_seed\.ts";/, claim);
    assert.deepEqual(
      [...source.matchAll(/\bcommand\(([^)]*)\)/g)].map((m) => m[1]),
      ["suite"],
      claim,
    );
    assert.match(source, /repos: \{ app: billing \}/, claim);
  }
});
