// The content address jr2 takes of a tree (ADR-0038, ADR-0069). It lives here, not in the CLI,
// because two ends compute it over one Assembly: `jr2 up` hashes the staged tree, and the door
// recomputes the hash over the unpacked tree before it accepts a publish. One implementation, so
// the two ends cannot drift.

import { createHash } from "node:crypto";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/** The salt of an Assembly's hash (ADR-0069). The host and the door both hash with it. */
export const ASSEMBLY_HASH_SALT = "assembly";

/**
 * The name of an Assembly (ADR-0069): a hash over every entry the Assembly's archive carries. The
 * host names its staged tree with it, and the door recomputes it over the unpacked tree. The door
 * then trusts "one hash names one Assembly" three times: `jr2 up` skips a publish whose hash is
 * current, the door answers `unchanged`, and the door reuses an `assemblies/<hash>/` it already
 * holds. So the hash covers what the archive carries, and nothing can change under one hash:
 *
 * - Each directory is a record, so an empty one counts.
 * - Each symlink is a record with its target. `contentHash` skips links (an image tag must not see
 *   pnpm's store links twice), but an Assembly's links travel, and a changed target is a changed
 *   Assembly.
 * - Each record is framed: a type, then every field as its byte length and its bytes. Without the
 *   frame, a file `a` that holds `X0:b\nY` hashes as the files `a` = `X` and `b` = `Y`.
 *
 * The walk is in byte order (`byteOrder`). Modes are not in the hash: nothing at the door reads
 * them, and an umask must not move an Assembly's name. Other entry types (a socket, a FIFO) are not
 * records: the archive refuses them, so they never reach the door. Nothing is excluded: the hash
 * names every byte the archive carries.
 */
export async function assemblyHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  h.update(`salt:${ASSEMBLY_HASH_SALT}\n`);
  const field = (bytes: Buffer): void => {
    h.update(`${bytes.length}:`);
    h.update(bytes);
  };
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => byteOrder(a.name, b.name));
    for (const e of entries) {
      const p = join(d, e.name);
      const path = Buffer.from(rel === "" ? e.name : `${rel}/${e.name}`, "utf8");
      if (e.isSymbolicLink()) {
        h.update("l");
        field(path);
        field(Buffer.from(await readlink(p), "utf8"));
      } else if (e.isDirectory()) {
        h.update("d");
        field(path);
        await walk(p, path.toString("utf8"));
      } else if (e.isFile()) {
        h.update("f");
        field(path);
        field(await readFile(p));
      }
    }
  };
  await walk(dir, "");
  return h.digest("hex").slice(0, 12);
}

/**
 * The order a content address walks a directory in: UTF-8 byte order of the entry names, never a
 * locale's collation. `localeCompare` reads the ICU locale from `LANG`/`LC_ALL`, and the two ends
 * of a hash run in different locales: in `cs_CZ`, "ch" sorts after "h", so a host there would
 * hash `node_modules/chalk` after `hono` while the Kit image hashes it first, and every publish
 * would fail the door's check. The Assembly's tar orders its entries by the same rule.
 */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * A short content hash over `paths` (files and/or directories, sorted walk), salted with `salt`.
 * Symlinks are skipped rather than followed: in a pnpm bundle `node_modules/<pkg>` links into the
 * virtual store, whose real files the walk already visits — following would hash the same bytes
 * twice. Each path contributes its entries under its own index prefix, so two directories that
 * happen to hold the same relative filenames stay distinguishable.
 */
export async function contentHash(paths: string[], salt: string, exclude: Set<string> = new Set()): Promise<string> {
  const h = createHash("sha256");
  h.update(`salt:${salt}\n`);
  const walk = async (root: string, d: string, index: number): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => byteOrder(a.name, b.name));
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(root, p, index);
      else if (e.isFile()) {
        h.update(`${index}:${relative(root, p)}\n`);
        h.update(await readFile(p));
      }
    }
  };
  for (const [index, p] of paths.entries()) {
    const st = await stat(p);
    if (st.isDirectory()) await walk(p, p, index);
    else {
      h.update(`${index}:${basename(p)}\n`);
      h.update(await readFile(p));
    }
  }
  return h.digest("hex").slice(0, 12);
}
