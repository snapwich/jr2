// The child's cut takes a Handoff's files (ADR-0080): the bundle and the Git LFS objects that the
// Orchestrator carried from the parent Sandbox and the land process wrote to the folder of this cut
// (`handoff-land-main.ts`). Each of them is the parent Agents' data, so the cut takes from them only
// what these steps let through:
//
//   1. The bundle has exactly one ref, and it is at `head`.
//   2. A git folder of the cut's own, whose alternates are the clone's objects, checks the bundle's
//      prerequisites against the clone. A prerequisite that the clone does not hold (the remote was
//      force-pushed after the parent fetched, or the cut's fetch got no answer) is refused, and the
//      reason names it and what the fetch said.
//   3. The bundle is unbundled into that folder, and a ref there names `head`. The clone fetches
//      that ref over `file://` with `transfer.fsckObjects=true` (the folder's own config pins that its
//      upload-pack reads no commit-graph and no multi-pack-index): only `head`'s closure enters the
//      clone, and git checks each of its objects. git before about 2.46 runs no fsck on a fetch
//      from a bundle, so the cut never fetches from the bundle itself. The fetch writes no ref and no
//      `FETCH_HEAD`: the cut's branch is the one ref that names the commits.
//   4. A Git LFS object lands in the clone's LFS store only when a pointer of the handed-off range
//      (the commits that the fetch brought, so the blobs that the clone's refs do not reach) names
//      its oid with its size, and its sha256 is its oid. git-lfs checks only the size of an object
//      in the store. The cut leaves out each other object, and its usual ask of the node cache gets
//      the objects that the Handoff did not carry (ADR-0075).
//
// The git here is the cut's: a cleared env and the cut's pinned config (`CLEAN`), given by the cut.

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lastLine, pointersOfRange, rangeOf, type GitCall } from "./lfs-pointer.ts";

export type Take = {
  /** The folder of the landed files: `bundle` and `lfs/<oid>`. */
  folder: string;
  /** The clone: `<root>/<slot>/default`. */
  clone: string;
  /** The cut's own folder, where it makes its git folder. */
  home: string;
  /** The Handoff's commit, which the Orchestrator found in the run's ledger. */
  head: string;
  /** git with the cut's cleared env and its pinned config, and no `-C`. */
  git: GitCall;
  /** What the cut's fetch of `origin` said when the remote did not answer. Undefined: it answered. */
  stale?: string;
};

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OID = /^[0-9a-f]{64}$/;

/** The one ref of the cut's git folder, which the clone fetches. */
const REF = "refs/heads/handoff";

/** git's first `error:` line, else its last: index-pack's last line ("index-pack failed") names
 * nothing, and fsck names the object and the fault on an `error:` line. */
const firstError = (err: string): string =>
  (err.split("\n").find((l) => l.startsWith("error:")) ?? err.split("\n").at(-1) ?? "").slice(0, 300);

/**
 * Take the landed files of a Handoff into the clone. Returns the reason of a refusal, or undefined
 * when the clone holds `head`'s closure and the Git LFS objects that passed the checks.
 */
export async function takeHandoff(t: Take): Promise<string | undefined> {
  const bundle = join(t.folder, "bundle");
  const st = await lstat(bundle).catch(() => undefined);
  if (st === undefined || !st.isFile()) return "the Handoff's bundle is not a regular file";

  const own = await mkdtemp(join(t.home, "handoff-"));
  const format = t.head.length === 64 ? "sha256" : "sha1";
  const made = await t.git(["init", "-q", "--bare", "--template=", `--object-format=${format}`, own]);
  if (made.code !== 0) return `the cut's git folder for the Handoff could not be made: ${lastLine(made)}`;
  await writeFile(join(own, "objects", "info", "alternates"), `${t.clone}/.git/objects\n`);
  // The clone's fetch starts upload-pack in this folder, and for a local transport git clears the
  // config that the cut gives by env (`CLEAN`). So this folder's own config pins what that
  // upload-pack reads: no commit-graph and no multi-pack-index, which an Agent can write in the
  // clone that the alternates name (ADR-0075).
  await appendFile(join(own, "config"), "[core]\n\tcommitGraph = false\n\tmultiPackIndex = false\n");
  const at = (args: readonly string[], stdin?: string) => t.git(["--git-dir", own, ...args], stdin);

  // 1. One ref, at head.
  const heads = await at(["bundle", "list-heads", bundle]);
  if (heads.code !== 0) return `the Handoff's bundle cannot be read: ${lastLine(heads)}`;
  const refs = heads.out.toString().trim().split("\n").filter(Boolean);
  if (refs.length !== 1) return `the Handoff's bundle has ${refs.length} refs, and a Handoff's bundle has one`;
  const tip = refs[0]!.split(" ")[0];
  if (tip !== t.head) return `the ref of the Handoff's bundle is at ${tip?.slice(0, 64)}, not at ${t.head}`;

  // 2. Its prerequisites, against the clone.
  const verify = await at(["bundle", "verify", bundle]);
  if (verify.code !== 0) {
    const lacks = /lacks these prerequisite commits/.test(verify.err)
      ? verify.err
          .split("\n")
          .map((l) => /^error: ([0-9a-f]{40}|[0-9a-f]{64})\b/.exec(l)?.[1])
          .filter((s): s is string => s !== undefined)
      : [];
    if (lacks.length > 0) {
      const named = lacks.slice(0, 5).join(", ") + (lacks.length > 5 ? `, and ${lacks.length - 5} more` : "");
      const it = lacks.length === 1 ? "it" : "them";
      const lacked = `this clone does not hold ${lacks.length === 1 ? "the commit" : "the commits"} ${named}, which the Handoff's bundle builds on`;
      // A fetch that did not answer may have missed what the remote holds: no force push is told.
      return t.stale !== undefined
        ? `${lacked}, and the remote did not answer, so it may hold ${it}: ${t.stale}`
        : `${lacked}: the remote may have lost ${it} (a force push) after the parent fetched`;
    }
    return `git refused the Handoff's bundle: ${lastLine(verify)}`;
  }

  // 3. Unbundle in the cut's own folder, and fetch head's closure from it, with fsck.
  const unbundled = await at(["bundle", "unbundle", bundle]);
  if (unbundled.code !== 0) return `git could not unbundle the Handoff's bundle: ${lastLine(unbundled)}`;
  const ref = await at(["update-ref", REF, t.head]);
  if (ref.code !== 0) return `the Handoff's bundle does not hold the commit ${t.head}: ${lastLine(ref)}`;
  const fetched = await t.git([
    "-C",
    t.clone,
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "protocol.file.allow=always",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    `file://${own}`,
    REF,
  ]);
  if (fetched.code !== 0) return `git refused the Handoff's commit ${t.head}: ${firstError(fetched.err)}`;

  // 4. The Git LFS objects that a pointer of the range names, with their bytes checked.
  const dir = join(t.folder, "lfs");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => OID.test(n));
  if (names.length === 0) return undefined;
  let pointers: Map<string, number>;
  try {
    pointers = await pointersOfRange(
      (args, stdin) => t.git(["--git-dir", `${t.clone}/.git`, ...args], stdin),
      rangeOf(t.head, await negativesOf(t)),
    );
  } catch (err) {
    return `the Git LFS pointers of the Handoff's commits could not be read: ${(err as Error).message}`;
  }
  for (const oid of names) {
    const size = pointers.get(oid);
    if (size !== undefined) await landObject(t.clone, join(dir, oid), oid, size);
  }
  return undefined;
}

/** The commits that the clone's refs name: the range's negatives. A ref at a missing object, or at
 * an object that is not a commit, is left out. */
async function negativesOf(t: Take): Promise<string[]> {
  const gitDir = `${t.clone}/.git`;
  const refs = await t.git(["--git-dir", gitDir, "for-each-ref", "--format=%(objectname)"]);
  if (refs.code !== 0) throw new Error(`the clone's refs could not be read: ${lastLine(refs)}`);
  const named = [
    ...new Set(
      refs.out
        .toString()
        .split("\n")
        .filter((l) => COMMIT.test(l)),
    ),
  ];
  if (named.length === 0) return [];
  const peeled = await t.git(
    ["--git-dir", gitDir, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
    named.map((s) => `${s}^{commit}\n`).join(""),
  );
  if (peeled.code !== 0) throw new Error(`the clone's refs could not be read: ${lastLine(peeled)}`);
  return [
    ...new Set(
      peeled.out
        .toString()
        .split("\n")
        .map((l) => l.split(" "))
        .filter(([sha, type]) => type === "commit" && COMMIT.test(sha ?? ""))
        .map(([sha]) => sha!),
    ),
  ];
}

/**
 * Copy one landed object into the clone's LFS store when its bytes are its oid: a regular file (no
 * link, no FIFO) of the pointer's size, whose sha256 is the oid. It is hashed as it is copied to the
 * store's `tmp`, and renamed into place only after the check. Else it is left out.
 */
async function landObject(clone: string, from: string, oid: string, size: number): Promise<boolean> {
  let src;
  try {
    src = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  const lfs = join(clone, ".git", "lfs");
  const tmp = join(lfs, "tmp", `jr2-handoff-${oid}-${randomBytes(4).toString("hex")}`);
  try {
    const st = await src.stat();
    if (!st.isFile() || st.size !== size) return false;
    await mkdir(join(lfs, "tmp"), { recursive: true });
    const dst = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    const hash = createHash("sha256");
    let at = 0;
    try {
      const buf = Buffer.alloc(Math.min(size, 1 << 20));
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, at);
        if (bytesRead === 0) break;
        const piece = buf.subarray(0, bytesRead);
        hash.update(piece);
        await dst.write(piece);
        at += bytesRead;
        if (at > size) break;
      }
    } finally {
      await dst.close();
    }
    if (at !== size || hash.digest("hex") !== oid) return false;
    const to = join(lfs, "objects", oid.slice(0, 2), oid.slice(2, 4));
    await mkdir(to, { recursive: true });
    await rename(tmp, join(to, oid));
    return true;
  } finally {
    await src.close();
    await rm(tmp, { force: true });
  }
}
