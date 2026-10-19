// The `--test-global-setup` of every `node --test` script in the workspace. A unit test makes its
// fixtures under `tmpdir()`, and many do not remove them, so each `pnpm -r test` left thousands of
// directories in /tmp. This module gives the run one root of its own instead: setup points TMPDIR
// at it, every test file's process inherits that, and teardown removes the root whole. A test
// that cleans up after itself still does; one that does not can leak nothing past its run.
//
// A run that is killed never reaches teardown, so setup also removes the root of any earlier run
// whose process is gone. The pid in the name is how it knows; a reused pid only keeps a root longer.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "jr2-test-";
let root: string | undefined;

export function globalSetup(): void {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (pid && !alive(pid)) rmSync(join(base, name), { recursive: true, force: true });
  }
  root = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
  process.env.TMPDIR = root;
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
