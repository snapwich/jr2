// The `--test-global-setup` of every `node --test` script in the workspace. A unit test makes its
// fixtures under `tmpdir()`, and many do not remove them, so each `pnpm -r test` left thousands of
// directories in /tmp. This module gives the run one root of its own instead: setup points TMPDIR
// at it, every test file's process inherits that, and teardown removes the root whole. A test
// that cleans up after itself still does; one that does not can leak nothing past its run.
//
// A run that is killed never reaches teardown, so setup also removes the root of any earlier run
// whose process is gone. The pid in the name is how it knows; a reused pid only keeps a root longer.
//
// Setup also removes git's repository-local variables (`git rev-parse --local-env-vars`) from the
// run's env. git sets them for a hook and for `git rebase -x`, and a test's git then works on that
// repository and not on the fixture the test made: under `rebase -x` the harness's sync and attach
// tests made commits, branches and a worktree in the developer's own repository.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "jr2-test-";
/** `git rev-parse --local-env-vars` (git 2.5x), plus the `-c` pairs that `GIT_CONFIG_COUNT` counts. */
const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];
let root: string | undefined;

export function globalSetup(): void {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (pid && !alive(pid)) rmSync(join(base, name), { recursive: true, force: true });
  }
  root = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
  process.env.TMPDIR = root;
  for (const name of Object.keys(process.env)) {
    if (GIT_LOCAL_ENV.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
  }
}

export function globalTeardown(): void {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
