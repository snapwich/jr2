// The Assembly's wire form (ADR-0069): one ustar archive, packed by `jr2 up` and unpacked at the
// door. The codec is in-process on both ends. No `tar` binary and no subprocess: the Kit image
// need not ship one, and the host and the door then read one format the same way.
//
// The archive is deterministic. Entries are in path order, every mtime is 0, every uid and gid is
// 0, and owner names are empty. So two packs of one tree are the same bytes. The content address
// is `assemblyHash` over the tree, not over these bytes, but a stable archive keeps a repeat
// publish cheap to compare and easy to debug.
//
// Modes are kept, so that the unpacked Assembly is a faithful copy of the staged tree. Nothing at
// the door reads them: not the Orchestrator, not `assemblyHash`, not `imageContextDigest`.
//
// Only three kinds of entry exist: directories, regular files, and symlinks with RELATIVE targets
// that stay inside the tree. An absolute target names host geography, and a target that escapes
// the tree reaches outside the Assembly. Both are refused, on pack and again on unpack. The door
// is the trust boundary, so unpack also refuses what pack can never write: a `..` segment, a
// leading `/`, a duplicate, an entry under a non-directory, a link that escapes through another
// link.
//
// A path that the ustar prefix+name split cannot hold, or a link target over 100 bytes, rides a
// POSIX pax extended header (typeflag `x`) with only `path` and `linkpath` records. Real npm
// packages ship such names (`@mistralai/mistralai` has a 130-byte file name). The pax header is
// deterministic too: sorted records, no time. Unpack accepts an `x` header only immediately before
// its entry, and checks its values as it checks any path and target. A global header (`g`) and the
// GNU long-name entries (`L`, `K`) are refused: pack never writes them.

import { chmod, lstat, mkdir, open, readdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";

/** What `unpackAssembly` reads: the whole archive, or a stream of it (an HTTP body, a file). */
export type AssemblyTarInput = Uint8Array | AsyncIterable<Uint8Array>;

/** A refusal of one entry, on pack or on unpack. `entry` is the entry's path in the archive, or
 * `""` when the refusal is of the archive as a whole (it ends too early), which names no entry. */
export class AssemblyTarRefusal extends Error {
  readonly entry: string;
  constructor(entry: string, reason: string) {
    super(
      entry === ""
        ? `the Assembly archive is refused: ${reason} (ADR-0069)`
        : `the Assembly entry ${JSON.stringify(entry)} is refused: ${reason} (ADR-0069)`,
    );
    this.name = "AssemblyTarRefusal";
    this.entry = entry;
  }
}

type EntryType = "dir" | "file" | "symlink";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const LINK_MAX = 100;
// The bounds of one pax value and one pax header. Linux's PATH_MAX, and room for two such records.
const PAX_VALUE_MAX = 4096;
const PAX_BODY_MAX = 16 * 1024;
// The keys pack writes, so the only keys unpack accepts.
const PAX_KEYS = new Set(["path", "linkpath"]);
// The size field is 11 octal digits: 8 GiB less one byte.
const SIZE_MAX = 0o77777777777;
// More expansions than this while a link target resolves is a loop. Linux stops at 40 too.
const LINK_EXPANSIONS_MAX = 40;

const TYPEFLAG: Record<EntryType, string> = { file: "0", dir: "5", symlink: "2" };

// ---------------------------------------------------------------------------------------------
// Paths

/** Byte order per segment, so a directory sorts before its children and the order holds in any
 * locale. */
function comparePaths(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const c = Buffer.compare(Buffer.from(as[i]!, "utf8"), Buffer.from(bs[i]!, "utf8"));
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

/** Refuse a path that is not a plain relative path inside the tree. */
function checkEntryPath(path: string): void {
  if (path === "") throw new AssemblyTarRefusal(path, "the path is empty");
  if (path.includes("\0")) throw new AssemblyTarRefusal(path, "the path holds a NUL byte");
  if (path.startsWith("/")) throw new AssemblyTarRefusal(path, "the path starts with '/'");
  const segments = path.split("/");
  if (segments.includes("..")) throw new AssemblyTarRefusal(path, "the path holds a '..' segment");
  if (segments.some((s) => s === "" || s === "."))
    throw new AssemblyTarRefusal(path, "the path holds an empty or '.' segment");
}

/** Refuse a symlink target that is absolute, or that is not a usable string. */
function checkLinkTarget(path: string, target: string): void {
  if (target === "") throw new AssemblyTarRefusal(path, "the symlink has an empty target");
  if (target.includes("\0")) throw new AssemblyTarRefusal(path, "the symlink target holds a NUL byte");
  if (target.startsWith("/"))
    throw new AssemblyTarRefusal(
      path,
      `the symlink target ${JSON.stringify(target)} is absolute; only relative targets travel`,
    );
  if (Buffer.byteLength(target, "utf8") > PAX_VALUE_MAX)
    throw new AssemblyTarRefusal(path, `the symlink target is longer than ${PAX_VALUE_MAX} bytes`);
}

/**
 * Refuse a symlink whose target resolves outside the tree. The walk follows every link the tree
 * holds, so a chain of links that are each inside cannot compose an escape (`s -> .` then
 * `l -> s/..`). A segment that names nothing in the tree is a dangling link, which is allowed.
 */
function checkLinkInside(path: string, links: Map<string, string>): void {
  const stack = path.split("/").slice(0, -1);
  let pending = (links.get(path) ?? "").split("/");
  let expansions = 0;
  while (pending.length > 0) {
    const seg = pending.shift()!;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) throw new AssemblyTarRefusal(path, "the symlink target resolves outside the Assembly");
      stack.pop();
      continue;
    }
    stack.push(seg);
    const target = links.get(stack.join("/"));
    if (target === undefined) continue;
    if (++expansions > LINK_EXPANSIONS_MAX) throw new AssemblyTarRefusal(path, "the symlink target is a loop");
    if (target.startsWith("/"))
      throw new AssemblyTarRefusal(path, "the symlink target resolves through an absolute link");
    stack.pop();
    pending = [...target.split("/"), ...pending];
  }
}

/** The ustar prefix+name split of `full` (a directory carries its trailing '/'), or undefined
 * when no split fits. The shortest prefix that fits wins, so the split is deterministic. */
function splitName(full: string): { prefix: Buffer; name: Buffer } | undefined {
  const bytes = Buffer.from(full, "utf8");
  if (bytes.length <= NAME_MAX) return { prefix: Buffer.alloc(0), name: bytes };
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x2f) continue;
    if (i > PREFIX_MAX) return undefined;
    const name = bytes.subarray(i + 1);
    // The name part after a trailing-'/' directory split must not be empty.
    if (name.length <= NAME_MAX && name.length > 0 && !(name.length === 1 && name[0] === 0x2f))
      return { prefix: bytes.subarray(0, i), name };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Pack

type PackEntry = { path: string; abs: string; type: EntryType; mode: number; target?: string };

async function collect(dir: string): Promise<PackEntry[]> {
  const out: PackEntry[] = [];
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    for (const name of await readdir(absDir)) {
      const path = relDir === "" ? name : `${relDir}/${name}`;
      const abs = join(absDir, name);
      const st = await lstat(abs);
      if (st.isDirectory()) {
        out.push({ path, abs, type: "dir", mode: st.mode & 0o7777 });
        await walk(abs, path);
      } else if (st.isFile()) {
        out.push({ path, abs, type: "file", mode: st.mode & 0o7777 });
      } else if (st.isSymbolicLink()) {
        out.push({ path, abs, type: "symlink", mode: 0o777, target: await readlink(abs) });
      } else {
        throw new AssemblyTarRefusal(path, "it is not a directory, a regular file or a symlink");
      }
    }
  };
  await walk(dir, "");
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

function writeOctal(b: Buffer, offset: number, length: number, value: number): void {
  const s = value.toString(8).padStart(length - 1, "0");
  b.write(`${s}\0`, offset, length, "latin1");
}

/** One pax record, `<length> <key>=<value>\n`, where `<length>` counts the whole record. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const restBytes = Buffer.byteLength(rest, "utf8");
  let length = restBytes + 1;
  while (String(length).length + restBytes !== length) length = String(length).length + restBytes;
  return `${length}${rest}`;
}

/** The blocks of one entry: a pax header first when the path or the target does not fit ustar. */
function header(path: string, type: EntryType, mode: number, size: number, target: string): Buffer[] {
  if (Buffer.byteLength(path, "utf8") > PAX_VALUE_MAX)
    throw new AssemblyTarRefusal(path, `the path is longer than ${PAX_VALUE_MAX} bytes`);
  if (size > SIZE_MAX) throw new AssemblyTarRefusal(path, "the file is larger than ustar can hold (8 GiB)");
  const full = type === "dir" ? `${path}/` : path;
  const fits = splitName(full);
  const longTarget = Buffer.byteLength(target, "utf8") > LINK_MAX;
  const out: Buffer[] = [];
  if (fits === undefined || longTarget) {
    // Records in key order, so the bytes are deterministic.
    const body = Buffer.from(
      (longTarget ? paxRecord("linkpath", target) : "") + (fits === undefined ? paxRecord("path", path) : ""),
      "utf8",
    );
    out.push(ustarBlock({ prefix: Buffer.alloc(0), name: Buffer.from("././@PaxHeader") }, "x", 0o644, body.length, ""));
    out.push(body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad > 0) out.push(Buffer.alloc(pad));
  }
  // The ustar fields then hold a truncated copy. A reader that knows pax ignores it.
  const split = fits ?? { prefix: Buffer.alloc(0), name: Buffer.from(full, "utf8").subarray(-NAME_MAX) };
  const linkField = longTarget ? Buffer.from(target, "utf8").subarray(0, LINK_MAX).toString("latin1") : target;
  out.push(ustarBlock(split, TYPEFLAG[type], mode, size, linkField, longTarget));
  return out;
}

function ustarBlock(
  split: { prefix: Buffer; name: Buffer },
  flag: string,
  mode: number,
  size: number,
  target: string,
  targetIsLatin1 = false,
): Buffer {
  const b = Buffer.alloc(BLOCK);
  split.name.copy(b, 0);
  writeOctal(b, 100, 8, mode);
  writeOctal(b, 108, 8, 0); // uid
  writeOctal(b, 116, 8, 0); // gid
  writeOctal(b, 124, 12, size);
  writeOctal(b, 136, 12, 0); // mtime
  b.fill(0x20, 148, 156); // the checksum field counts as spaces while the sum is taken
  b.write(flag, 156, 1, "latin1");
  Buffer.from(target, targetIsLatin1 ? "latin1" : "utf8").copy(b, 157);
  b.write("ustar\0", 257, 6, "latin1");
  b.write("00", 263, 2, "latin1");
  writeOctal(b, 329, 8, 0); // devmajor
  writeOctal(b, 337, 8, 0); // devminor
  split.prefix.copy(b, 345);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return b;
}

/**
 * Pack the tree at `dir` into one ustar archive (ADR-0069). The root itself is not an entry.
 * Refuses, naming the entry, anything the door would refuse: a special file, an absolute or
 * escaping symlink target, a path or a target longer than 4096 bytes.
 */
export async function packAssembly(dir: string): Promise<Buffer> {
  const entries = await collect(dir);
  const links = new Map<string, string>();
  for (const e of entries) if (e.type === "symlink") links.set(e.path, e.target!);
  const parts: Buffer[] = [];
  for (const e of entries) {
    checkEntryPath(e.path);
    if (e.type === "symlink") {
      checkLinkTarget(e.path, e.target!);
      checkLinkInside(e.path, links);
      parts.push(...header(e.path, "symlink", e.mode, 0, e.target!));
    } else if (e.type === "dir") {
      parts.push(...header(e.path, "dir", e.mode, 0, ""));
    } else {
      const body = await readFile(e.abs);
      parts.push(...header(e.path, "file", e.mode, body.length, ""), body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Unpack

/** Exact-length reads over a chunked source. */
class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private done = false;
  private readonly it: AsyncIterator<Uint8Array>;

  constructor(input: AssemblyTarInput) {
    const source: AsyncIterable<Uint8Array> =
      input instanceof Uint8Array
        ? (async function* () {
            yield input;
          })()
        : input;
    this.it = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      const b = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
      if (b.length === 0) continue;
      this.chunks.push(b);
      this.length += b.length;
    }
  }

  private take(n: number): Buffer {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.chunks[0]!;
      if (head.length <= need) {
        out.push(head);
        this.chunks.shift();
        need -= head.length;
      } else {
        out.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        need = 0;
      }
    }
    this.length -= n;
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  /** `n` bytes, or undefined when the source ends first. */
  async read(n: number): Promise<Buffer | undefined> {
    await this.fill(n);
    return this.length >= n ? this.take(n) : undefined;
  }

  /** At most `max` bytes (at least one), or undefined at the end of the source. */
  async readSome(max: number): Promise<Buffer | undefined> {
    await this.fill(1);
    if (this.length === 0) return undefined;
    return this.take(Math.min(max, this.chunks[0]!.length));
  }
}

function field(b: Buffer, offset: number, length: number): Buffer {
  const raw = b.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return nul === -1 ? raw : raw.subarray(0, nul);
}

function readOctal(b: Buffer, offset: number, length: number, path: string, what: string): number {
  const s = field(b, offset, length).toString("latin1").trim();
  if (!/^[0-7]+$/.test(s)) throw new AssemblyTarRefusal(path, `the header's ${what} is not an octal number`);
  return parseInt(s, 8);
}

type Parsed = { path: string; type: EntryType | "pax"; mode: number; size: number; target: string };

/** The values a pax header carries for the next entry. */
type Pax = { path?: string; linkpath?: string };

/** Parse a pax header's body. Only `path` and `linkpath`, once each, as pack writes them. */
function parsePax(body: Buffer, at: string): Pax {
  const pax: Pax = {};
  let rest = body;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    const lengthText = space > 0 ? rest.toString("latin1", 0, space) : "";
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new AssemblyTarRefusal(at, "a pax record has no length");
    const length = Number(lengthText);
    if (length > rest.length || rest[length - 1] !== 0x0a)
      throw new AssemblyTarRefusal(at, "a pax record's length does not match its bytes");
    const record = rest.subarray(space + 1, length - 1).toString("utf8");
    rest = rest.subarray(length);
    const eq = record.indexOf("=");
    const key = eq > 0 ? record.slice(0, eq) : record;
    if (!PAX_KEYS.has(key))
      throw new AssemblyTarRefusal(at, `the pax key ${JSON.stringify(key)} is not one an Assembly carries`);
    if (pax[key as keyof Pax] !== undefined) throw new AssemblyTarRefusal(at, `the pax key ${key} comes twice`);
    pax[key as keyof Pax] = record.slice(eq + 1);
  }
  return pax;
}

function parseHeader(b: Buffer, pax?: Pax): Parsed {
  const name = field(b, 0, 100).toString("utf8");
  const prefix = field(b, 345, 155).toString("utf8");
  let path = pax?.path ?? (prefix === "" ? name : `${prefix}/${name}`);
  if (b.toString("latin1", 257, 263) !== "ustar\0" || b.toString("latin1", 263, 265) !== "00")
    throw new AssemblyTarRefusal(path, "the header is not ustar");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i]!;
  if (readOctal(b, 148, 8, path, "checksum") !== sum)
    throw new AssemblyTarRefusal(path, "the header checksum does not match");
  const flag = b.toString("latin1", 156, 157);
  let type: Parsed["type"];
  if (flag === "x") type = "pax";
  else if (flag === "0" || flag === "\0") type = "file";
  else if (flag === "5") type = "dir";
  else if (flag === "2") type = "symlink";
  else
    throw new AssemblyTarRefusal(
      path,
      `the entry type ${JSON.stringify(flag)} is not a directory, a regular file or a symlink`,
    );
  if (type === "dir" && path.endsWith("/")) path = path.slice(0, -1);
  const size = readOctal(b, 124, 12, path, "size");
  if (type === "pax") {
    if (pax !== undefined) throw new AssemblyTarRefusal(path, "a pax header follows another pax header");
    if (size > PAX_BODY_MAX) throw new AssemblyTarRefusal(path, `the pax header is larger than ${PAX_BODY_MAX} bytes`);
  } else if (type !== "file" && size !== 0) {
    throw new AssemblyTarRefusal(path, "a directory or symlink entry carries a body");
  }
  if (pax?.linkpath !== undefined && type !== "symlink")
    throw new AssemblyTarRefusal(path, "a pax linkpath names an entry that is not a symlink");
  return {
    path,
    type,
    mode: readOctal(b, 100, 8, path, "mode"),
    size,
    target: pax?.linkpath ?? field(b, 157, 100).toString("utf8"),
  };
}

/**
 * Unpack an Assembly archive into `dir` (ADR-0069). `dir` must be absent or empty. Directories and
 * files land as they come; symlinks land last, after every target has been checked to stay inside
 * `dir`, so no entry is ever written through a link. A refusal names the entry and leaves `dir`
 * partly written: the caller owns `dir` and removes it (the door unpacks into its staging).
 */
export async function unpackAssembly(input: AssemblyTarInput, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new Error(`unpackAssembly: ${dir} is not empty`);
  const reader = new ByteReader(input);
  const seen = new Map<string, EntryType>();
  const links = new Map<string, string>();
  const dirModes: { abs: string; mode: number }[] = [];
  let pax: Pax | undefined;
  for (;;) {
    const block = await reader.read(BLOCK);
    if (block === undefined) throw new AssemblyTarRefusal("", "the archive ends before its end-of-archive blocks");
    if (block.every((byte) => byte === 0)) {
      if (pax !== undefined) throw new AssemblyTarRefusal(pax.path ?? "", "a pax header is the last entry");
      break;
    }
    const e = parseHeader(block, pax);
    pax = undefined;
    if (e.type === "pax") {
      const body = await reader.read(e.size + ((BLOCK - (e.size % BLOCK)) % BLOCK));
      if (body === undefined) throw new AssemblyTarRefusal(e.path, "the archive ends inside a pax header");
      pax = parsePax(body.subarray(0, e.size), e.path);
      continue;
    }
    checkEntryPath(e.path);
    if (seen.has(e.path)) throw new AssemblyTarRefusal(e.path, "the archive holds the path twice");
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : undefined;
    if (parent !== undefined && seen.get(parent) !== "dir")
      throw new AssemblyTarRefusal(
        e.path,
        `its parent ${JSON.stringify(parent)} is not a directory earlier in the archive`,
      );
    seen.set(e.path, e.type);
    const abs = join(dir, ...e.path.split("/"));
    if (e.type === "dir") {
      await mkdir(abs, { mode: 0o700 });
      dirModes.push({ abs, mode: e.mode & 0o7777 });
    } else if (e.type === "symlink") {
      checkLinkTarget(e.path, e.target);
      links.set(e.path, e.target);
    } else {
      const fh = await open(abs, "wx", 0o600);
      try {
        let left = e.size;
        while (left > 0) {
          const chunk = await reader.readSome(left);
          if (chunk === undefined) throw new AssemblyTarRefusal(e.path, "the archive ends inside the file's body");
          await fh.write(chunk);
          left -= chunk.length;
        }
      } finally {
        await fh.close();
      }
      await chmod(abs, e.mode & 0o7777);
      const pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
      if (pad > 0 && (await reader.read(pad)) === undefined)
        throw new AssemblyTarRefusal(e.path, "the archive ends inside the file's padding");
    }
  }
  for (const path of [...links.keys()].sort(comparePaths)) {
    checkLinkInside(path, links);
    await symlink(links.get(path)!, join(dir, ...path.split("/")));
  }
  // Directory modes land last, deepest first, so a read-only directory does not block its own
  // children.
  for (const { abs, mode } of dirModes.reverse()) await chmod(abs, mode);
}
