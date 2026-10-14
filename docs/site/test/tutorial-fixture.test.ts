// The tutorial fixture (tutorial/greet/) carries one deliberate bug: it does not trim the name.
// Get started pages 5 and 6 hand that bug to an Agent and have it find the bug from the failing
// test (ADR-0072). The pages are read at every release tag, so the bug must exist at every tag —
// and fail for that reason alone. A formatter pass, a tidy-up, or a "fix" in passing would make
// both pages lie without a test going red. This guard is that red test: the fixture fails with
// exactly the trim test, and the known one-line fix makes it pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../tutorial/greet/", import.meta.url));
const BUGGY = `const name = args.find((a) => !a.startsWith("-")) ?? "world";`;
const FIXED = `const name = args.find((a) => !a.startsWith("-"))?.trim() ?? "world";`;

// `node --test` in a child of this runner inherits NODE_TEST_CONTEXT and reports to this
// runner's protocol instead of running as its own; drop it so the child is a plain test run.
function nodeTest(cwd: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { cwd, env, encoding: "utf8" });
  const count = (key: string) => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(r.stdout)?.[1]);
  return {
    status: r.status,
    stdout: r.stdout,
    tests: count("tests"),
    fail: count("fail"),
    // Top-level results only: the fixture has no suites, so each test is one unindented line.
    failed: [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]),
  };
}

test("the fixture fails with exactly one test, the trim test", () => {
  const r = nodeTest(FIXTURE);
  assert.notEqual(r.status, 0, r.stdout);
  // A syntax error also exits non-zero, as one failed file; a test count pins that the tests ran.
  assert.ok(r.tests > 1, `the tests did not run:\n${r.stdout}`);
  assert.equal(r.fail, 1, r.stdout);
  assert.deepEqual(r.failed, ["trims the name"], r.stdout);
});

test("the known one-line fix makes the fixture pass", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-greet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(FIXTURE, dir, { recursive: true });

  const file = join(dir, "src/greet.js");
  const src = await readFile(file, "utf8");
  assert.equal(src.split(BUGGY).length, 2, `src/greet.js must hold the buggy line exactly once:\n${BUGGY}`);
  await writeFile(file, src.replace(BUGGY, FIXED));

  const r = nodeTest(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.fail, 0, r.stdout);
  assert.ok(r.tests > 1, r.stdout);
});
