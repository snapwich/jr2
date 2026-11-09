// The bundle step's process (ADR-0080): it runs in the parent Agent's Landlock domain, started by
// the spawner (`handoff-bundle.ts`), and writes the files of one Handoff to its stdout as
// `HandoffFrame`s (wire.ts). The Harness kills its process group at the step's deadline, and
// counts its bytes against the bound. Everything that it reads is the parent Agents' (the clone,
// its refs, its objects and its LFS store), and it reads nothing that they cannot read.
//
// What it does:
//
//   1. A git folder of its own, in the domain's TMPDIR: no config, no hook, no ref but one, and the
//      clone's objects through its alternates (as the cut's `fill`, ADR-0075). git writes no bundle
//      for a bare commit id, so the one ref names `head` there.
//   2. The negatives: each commit that a remote-tracking ref of the clone names. A ref at an object
//      that is not there, or that is not a commit, is left out.
//   3. An empty range (`head` and `^<negative>` for each negative) is `{ nothing: true }`: git
//      refuses an empty bundle, and the child's clone gets `head` from the remote.
//   4. `git bundle create <file> --stdin`, in its own folder, with `refs/heads/handoff` and a
//      `^<negative>` line for each negative. Never a `--not` line: git takes an option on stdin
//      only from 2.42, and the Sandbox Image's git can be older (Debian bookworm has 2.39.5:
//      "options not supported in --stdin mode"). A `^` line is a revision, which every git takes.
//   5. The Git LFS objects: each blob of the range that is a Git LFS pointer names an object. The
//      object goes with the bundle when the clone's LFS store holds it as a regular file of the
//      pointer's size. Else the child asks the node cache for it.
//   6. The bounds: the bundle and the objects together, and the number of objects, or `{ refused }`
//      before the first part. A pointer of no bytes names no object: git-lfs stores no empty file.
//   7. The parts: each file is opened as a regular file only (no link, no FIFO, no device), and
//      exactly the bytes that its header says are written.
//   8. The step removes its own folder, and only then writes the last frame (`end` or `nothing`):
//      at the last frame, the Harness kills the step's process group.
//
// Each git call has the cut's pinned config (`CLEAN`, cut.ts) and a cleared env: no hook, no
// fsmonitor, no commit-graph, no multi-pack-index, no alternate-refs command, no global or system
// config. git still reads the clone's own config for the refs (step 2), as the cut does: a config
// there that holds git (an `include.path` at a FIFO) ends at the deadline.
//
// A refusal that comes before the first part is a `{ refused }` frame and exit 0. A fault after the
// first part is a non-zero exit with the reason on stderr: the Harness then ends the stream
// `refused`, because the header of a part promised bytes that did not come.

import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { mkdtemp, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { CLEAN } from "./cut.ts";
import { pointersOfRange, rangeOf } from "./lfs-pointer.ts";

export { pointerOf, rangeOf } from "./lfs-pointer.ts";

/** What the Harness gives the step, as its one argument (JSON). */
export type BundleStepInput = {
  /** The clone: `<root>/<slot>/default`. */
  clone: string;
  /** The commit to hand off: a full commit id. */
  head: string;
  /** The bound on the bundle and its Git LFS objects together. */
  maxBytes: number;
  /** The bound on the number of Git LFS objects. */
  maxObjects: number;
  /** Where the step makes its own folder: the domain's TMPDIR. */
  tmp: string;
  /** The PATH of its git: the domain's. */
  path: string;
};

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The name of the step's own folder starts with this and its pid: a later step removes each
 * folder of a step whose process is gone (a kill at the deadline leaves one). */
const PREFIX = "jr2-handoff-";

/** The one ref of the step's git folder, and so of the bundle. */
const REF = "refs/heads/handoff";

type Git = { code: number; out: Buffer; err: string };

/** git with the cleared env and the cut's config, in the domain. */
function gitOf(input: BundleStepInput, home: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: input.path,
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  return (args: readonly string[], stdin?: string): Promise<Git> =>
    new Promise((resolve) => {
      const child = execFile(
        "git",
        [...CLEAN, ...args],
        { env, encoding: "buffer", maxBuffer: 256 << 20 },
        (error, stdout, stderr) => {
          const code = error == null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, out: stdout, err: stderr.toString("utf8").trim() });
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin ?? "");
    });
}

/** git's last line, bounded: an Agent's file names can be in it. */
const said = (r: Git): string => (r.err.split("\n").at(-1) ?? "").slice(0, 300);

class Refused extends Error {}

/** Write `data` to stdout, and wait while the pipe is full. */
function emit(data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.stdout.write(data, (err) => (err ? reject(err) : undefined))) return resolve();
    process.stdout.once("drain", resolve);
  });
}

const frame = (f: Record<string, unknown>): Promise<void> => emit(`${JSON.stringify(f)}\n`);

/** Open `path` as a regular file only: a link, a FIFO or a device is undefined. O_NONBLOCK, so an
 * open of a FIFO does not wait for a writer. */
async function openRegular(path: string): Promise<{ fh: FileHandle; size: number } | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  const st = await fh.stat().catch(() => undefined);
  if (st === undefined || !st.isFile()) {
    await fh.close();
    return undefined;
  }
  return { fh, size: st.size };
}

/** Write exactly `size` bytes of `fh`, from its start. A file that is shorter now throws. */
async function pour(fh: FileHandle, size: number): Promise<void> {
  const buf = Buffer.alloc(Math.min(size, 1 << 20) || 1);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
    if (bytesRead === 0) throw new Error(`the file became shorter while the step read it (${at} of ${size} bytes)`);
    await emit(Buffer.from(buf.subarray(0, bytesRead)));
    at += bytesRead;
  }
}

/** The step's folders that a step whose process is gone left. */
async function sweep(tmp: string): Promise<void> {
  for (const name of await readdir(tmp).catch(() => [] as string[])) {
    const pid = /^jr2-handoff-(\d+)-/.exec(name)?.[1];
    if (pid === undefined || Number(pid) === process.pid) continue;
    try {
      process.kill(Number(pid), 0);
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    await rm(join(tmp, name), { recursive: true, force: true }).catch(() => {});
  }
}

/** The step, in this process: it writes the parts, and returns the last frame, which `main`
 * writes after the step's folder is gone. */
export async function bundleStep(input: BundleStepInput): Promise<{ end: true } | { nothing: true }> {
  if (!COMMIT.test(input.head)) throw new Refused(`a Handoff's commit is a full commit id, not ${input.head}`);
  await sweep(input.tmp);
  const dir = await mkdtemp(join(input.tmp, `${PREFIX}${process.pid}-`));
  try {
    const git = gitOf(input, dir);
    const own = join(dir, "git");
    const format = input.head.length === 64 ? "sha256" : "sha1";
    const made = await git(["init", "-q", "--bare", "--template=", `--object-format=${format}`, own]);
    if (made.code !== 0) throw new Error(`the bundle step's git folder could not be made: ${said(made)}`);
    await writeFile(join(own, "objects/info/alternates"), `${input.clone}/.git/objects\n`);
    const at = (args: readonly string[], stdin?: string) => git(["--git-dir", own, ...args], stdin);

    if ((await at(["cat-file", "-t", input.head])).out.toString().trim() !== "commit") {
      throw new Refused(`the parent's clone does not hold the commit ${input.head}`);
    }

    // The clone's remote-tracking refs, as commits. A ref at a missing object, or at a blob, is out.
    const refs = await git([
      "--git-dir",
      `${input.clone}/.git`,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/remotes/",
    ]);
    if (refs.code !== 0)
      throw new Refused(`the parent's clone's remote-tracking refs could not be read: ${said(refs)}`);
    const named = [
      ...new Set(
        refs.out
          .toString()
          .split("\n")
          .filter((l) => COMMIT.test(l)),
      ),
    ];
    const peeled = await at(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      named.map((s) => `${s}^{commit}\n`).join(""),
    );
    if (peeled.code !== 0)
      throw new Refused(`the parent's clone's remote-tracking refs could not be read: ${said(peeled)}`);
    const negatives = [
      ...new Set(
        peeled.out
          .toString()
          .split("\n")
          .map((l) => l.split(" "))
          .filter(([sha, type]) => type === "commit" && COMMIT.test(sha ?? ""))
          .map(([sha]) => sha!),
      ),
    ];
    const range = (tip: string) => rangeOf(tip, negatives);

    const first = await at(["rev-list", "-n", "1", "--stdin"], range(input.head));
    if (first.code !== 0) throw new Refused(`the commits of ${input.head} could not be listed: ${said(first)}`);
    if (first.out.toString().trim() === "") return { nothing: true };

    const ref = await at(["update-ref", REF, input.head]);
    if (ref.code !== 0) throw new Refused(`the ref of ${input.head} could not be set: ${said(ref)}`);
    const file = join(dir, "handoff.bundle");
    const bundled = await at(["bundle", "create", "-q", file, "--stdin"], range(REF));
    if (bundled.code !== 0) throw new Refused(`git did not write the bundle of ${input.head}: ${said(bundled)}`);

    // The Git LFS objects: the pointers among the range's small blobs.
    const pointers = await pointersOfRange(at, range(input.head)).catch((err: Error) => {
      throw new Refused(`the Handoff of ${input.head}: ${err.message}`);
    });
    const store = `${input.clone}/.git/lfs/objects`;
    const lfs: { oid: string; size: number }[] = [];
    for (const [oid, size] of [...pointers].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const held = await openRegular(join(store, oid.slice(0, 2), oid.slice(2, 4), oid));
      if (held === undefined) continue;
      await held.fh.close();
      if (held.size === size) lfs.push({ oid, size });
    }

    const bundle = await openRegular(file);
    if (bundle === undefined) throw new Refused("the bundle is not a regular file");
    try {
      if (lfs.length > input.maxObjects) {
        throw new Refused(
          `the Handoff's files hold ${lfs.length} Git LFS objects, more than the bound of ${input.maxObjects}`,
        );
      }
      const total = lfs.reduce((n, o) => n + o.size, bundle.size);
      if (total > input.maxBytes) {
        throw new Refused(
          `the Handoff's files are ${total} bytes (the bundle and ${lfs.length} Git LFS objects), more than the bound of ${input.maxBytes} bytes`,
        );
      }
      await frame({ bundle: bundle.size });
      await pour(bundle.fh, bundle.size);
    } finally {
      await bundle.fh.close();
    }
    for (const { oid, size } of lfs) {
      // Opened again: a file that is no longer a regular file of that size is left out, before its header.
      const held = await openRegular(join(store, oid.slice(0, 2), oid.slice(2, 4), oid));
      if (held === undefined) continue;
      try {
        if (held.size !== size) continue;
        await frame({ lfs: oid, size });
        await pour(held.fh, size);
      } finally {
        await held.fh.close();
      }
    }
    return { end: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run the step and end the stream. A refusal before the first part is a frame; any other fault is
 * a non-zero exit, with the reason on stderr. */
export async function main(argv: readonly string[]): Promise<void> {
  try {
    await frame(await bundleStep(JSON.parse(argv[0] ?? "{}") as BundleStepInput));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (err instanceof Refused) {
      await frame({ refused: why.slice(0, 1024) });
      return;
    }
    process.stderr.write(`${why.slice(0, 1024)}\n`);
    process.exitCode = 3;
  }
}

// `node handoff-bundle-main.ts <json>`, started by the Harness through the spawner.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
) {
  void main(process.argv.slice(2));
}
