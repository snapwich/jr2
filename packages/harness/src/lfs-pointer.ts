// Git LFS pointers as the Handoff reads them (ADR-0080): by their form, among the small blobs of a
// range of commits. Neither side of a Handoff reads a `.gitattributes`, which an Agent writes. The
// bundle step (`handoff-bundle-main.ts`) uses this to choose the objects that go with a bundle, and
// the child's cut (`handoff-take.ts`) to choose the objects that it lands.

const OID = /^[0-9a-f]{64}$/;

/** A blob that is longer than this is no Git LFS pointer (git-lfs reads no more). */
export const MAX_POINTER = 1024;

/** The oid and size of a Git LFS pointer, or undefined. */
export function pointerOf(text: string): { oid: string; size: number } | undefined {
  const lines = text.split("\n");
  if (lines[0] !== "version https://git-lfs.github.com/spec/v1") return undefined;
  let oid: string | undefined;
  let size: number | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith("oid sha256:")) oid = line.slice("oid sha256:".length);
    else if (/^size \d{1,15}$/.test(line)) size = Number(line.slice(5));
  }
  return oid !== undefined && OID.test(oid) && size !== undefined ? { oid, size } : undefined;
}

/** Each blob of `cat-file --batch`'s output, by its bytes. */
export function batchBlobs(out: Buffer): Buffer[] {
  const blobs: Buffer[] = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) break;
    const [, type, size] = out.subarray(at, nl).toString("latin1").split(" ");
    if (type === undefined || size === undefined) {
      at = nl + 1; // `<input> missing`
      continue;
    }
    const n = Number(size);
    if (type === "blob") blobs.push(out.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return blobs;
}

/** The stdin of a git `--stdin` call for a range: `tip`, then a `^<sha>` line for each negative. No
 * line is an option: git takes an option on stdin only from 2.42, and a Sandbox Image's git can be
 * older (Debian bookworm has 2.39.5). A `^` line is a revision, which every git takes. */
export function rangeOf(tip: string, negatives: readonly string[]): string {
  return `${tip}\n${negatives.map((n) => `^${n}\n`).join("")}`;
}

/** What a git call answered, with its stdout as bytes. */
export type GitBytes = { code: number; out: Buffer; err: string };

/** Run git with these arguments and this stdin. */
export type GitCall = (args: readonly string[], stdin?: string) => Promise<GitBytes>;

/**
 * The Git LFS pointers among the blobs of a range: the oid of each object and its size, of at least
 * one byte (git-lfs stores no empty file). `git` runs in a git folder that holds the range's
 * objects; `range` is `rangeOf`'s text. Throws with git's words when a call fails.
 */
export async function pointersOfRange(git: GitCall, range: string): Promise<Map<string, number>> {
  const objects = await git(["rev-list", "--objects", "--stdin"], range);
  if (objects.code !== 0) throw new Error(`the objects could not be listed: ${lastLine(objects)}`);
  const shas = objects.out
    .toString()
    .split("\n")
    .map((l) => l.split(" ")[0] ?? "")
    .filter((s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s));
  const kinds = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    shas.map((s) => `${s}\n`).join(""),
  );
  if (kinds.code !== 0) throw new Error(`the objects could not be read: ${lastLine(kinds)}`);
  const small = kinds.out
    .toString()
    .split("\n")
    .map((l) => l.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) <= MAX_POINTER)
    .map(([sha]) => sha!);
  const pointers = new Map<string, number>();
  if (small.length === 0) return pointers;
  const blobs = await git(["cat-file", "--batch"], small.map((s) => `${s}\n`).join(""));
  if (blobs.code !== 0) throw new Error(`the small blobs could not be read: ${lastLine(blobs)}`);
  for (const blob of batchBlobs(blobs.out)) {
    const p = pointerOf(blob.toString("utf8"));
    if (p !== undefined && p.size > 0) pointers.set(p.oid, p.size);
  }
  return pointers;
}

/** git's last line, bounded: an Agent's file names can be in it. */
export const lastLine = (r: GitBytes): string => (r.err.split("\n").at(-1) ?? "").slice(0, 300);
