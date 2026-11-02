// The tests' confiner and spawner (ADR-0076, ADR-0077): the real `effector` binary, built from this
// checkout with Go, so every test that starts a process of the Harness or does a file tool's I/O
// does it through the real spawner, in a Landlock domain on the host's kernel, as a pod does. There
// is no unconfined branch to test against: a host without Go or without Landlock fails these tests,
// loudly.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childPolicy, type ChildPolicy } from "../../src/children.ts";

const EFFECTOR_MODULE = join(dirname(fileURLToPath(import.meta.url)), "../../../../effector");

let built: string | undefined;

/** The effector binary, built once for this test process (Go's build cache makes a rebuild fast). */
export function testConfiner(): string {
  if (built !== undefined) return built;
  const dir = mkdtempSync(join(tmpdir(), "jr2-effector-"));
  const out = join(dir, "effector.tmp");
  try {
    execFileSync("go", ["build", "-o", out, "./cmd/effector"], {
      cwd: EFFECTOR_MODULE,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(
      `these tests need the Effector's confiner, built with Go from ${EFFECTOR_MODULE}: ${e.stderr?.toString() || e.message}`,
    );
  }
  renameSync(out, join(dir, "effector"));
  built = join(dir, "effector");
  return built;
}

let deniedRoot: string | undefined;

/**
 * A new folder for the domain to be denied, as `/run/jr2` is in a pod, NOT under the run's TMPDIR.
 * The rules give a right to each folder beside a denied path and beside each folder above it, as
 * they stand when the spawner starts (ADR-0076): a folder made later directly in a folder ABOVE a
 * denied path has no rule. The tests make their fixtures in TMPDIR all the time, so TMPDIR may not
 * be above a denied path. The folders are removed when the test process exits.
 */
export function deniedDir(prefix = "denied-"): string {
  if (deniedRoot === undefined) {
    deniedRoot = mkdtempSync(join(dirname(tmpdir()), `${basename(tmpdir())}-denied-`));
    const root = deniedRoot;
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  }
  return mkdtempSync(join(deniedRoot, prefix));
}

/**
 * A domain over a test's own folders: a HOME and a TMPDIR of its own unless it names them, and a
 * folder of its own that stands for `/run/jr2` (`deniedDir`), denied with each of `deny`. `standIns` and
 * `granted` are the held secrets and the `workspace()`'s grant; `control` the control Stand-in,
 * which the domain never gets; `env` more of the container's start env. `work` and `repos` are
 * made when the test names none, and need no rule: the domain reaches every path but the denied.
 */
export function testChildren(
  opts: {
    work?: string;
    repos?: string;
    home?: string;
    tmp?: string;
    standIns?: ReadonlyMap<string, string>;
    granted?: readonly string[];
    control?: string;
    deny?: readonly string[];
    env?: Record<string, string>;
  } = {},
): ChildPolicy {
  const root = mkdtempSync(join(tmpdir(), "jr2-children-"));
  const at = (name: string, given?: string) => {
    if (given !== undefined) return given;
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  at("work", opts.work);
  at("repos", opts.repos);
  return childPolicy({
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: at("home", opts.home),
      TMPDIR: at("tmp", opts.tmp),
      ...(opts.granted ? { JR2_GRANTED_SECRETS: opts.granted.join(",") } : {}),
      ...opts.env,
    },
    confiner: testConfiner(),
    standIns: opts.standIns ?? new Map(),
    control: opts.control,
    deny: [deniedDir("run-jr2-"), ...(opts.deny ?? [])],
  });
}
