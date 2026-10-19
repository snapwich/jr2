// The Assembly's wire form (ADR-0069): the ustar codec `jr2 up` packs with and the door unpacks
// with. Socket-free. Three claims: a tree survives the round trip (directories, empty ones too,
// files with their modes, relative symlinks); two packs of one tree are the same bytes; and every
// entry the door must not accept is refused, naming the entry.
//
// The refusals of entries `packAssembly` can never write (a '..' segment, a leading '/', a link
// that escapes) are driven by archives this file writes byte by byte, with its own small ustar
// writer, so the reader is not checked against itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AssemblyTarRefusal, packAssembly, unpackAssembly } from "../src/assembly-tar.ts";
import { assemblyHash } from "../src/content-hash.ts";

const tmp = (tag: string) => mkdtemp(join(tmpdir(), `jr2-asmtar-${tag}-`));

/** A tree with every kind of entry the Assembly carries. */
async function fixtureTree(): Promise<string> {
  const dir = await tmp("src");
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "workflows", "ping.ts"), "export const machine = 1;\n");
  await writeFile(join(dir, "jr2.config.ts"), "export default {};\n");
  await mkdir(join(dir, "empty"));
  await mkdir(join(dir, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep", "lib"), { recursive: true });
  await writeFile(join(dir, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep", "lib", "index.js"), "x");
  await symlink(".pnpm/dep@1.0.0/node_modules/dep", join(dir, "node_modules", "dep"));
  await mkdir(join(dir, "images", "box"), { recursive: true });
  await writeFile(join(dir, "images", "box", "entry.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(dir, "images", "box", "entry.sh"), 0o755);
  // A dangling relative link inside the tree is still a link the tree holds.
  await symlink("nowhere", join(dir, "dangling"));
  // A file large enough to span several blocks and to need padding.
  await writeFile(join(dir, "big.bin"), Buffer.alloc(70_001, 7));
  return dir;
}

async function listTree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(join(dir, path));
    if (st.isSymbolicLink()) out.push(`L ${path} -> ${await readlink(join(dir, path))}`);
    else if (st.isDirectory()) {
      out.push(`D ${path} ${(st.mode & 0o7777).toString(8)}`);
      out.push(...(await listTree(dir, path)));
    } else
      out.push(`F ${path} ${(st.mode & 0o7777).toString(8)} ${(await readFile(join(dir, path))).toString("base64")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A hand ustar writer, for archives `packAssembly` refuses to write.

type Raw = {
  name: string;
  /** "0" file, "2" symlink, "5" dir, "x" pax, and the types the door refuses ("1", "g", "L"). */
  type: string;
  body?: string;
  link?: string;
  prefix?: string;
  /** A magic other than "ustar\0" + "00". */
  magic?: string;
  /** Write a checksum one off from the true sum. */
  badSum?: boolean;
};

/** A pax header body from records, as `packAssembly` writes it. */
function paxBody(records: Record<string, string>): string {
  let out = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let n = Buffer.byteLength(rest) + 1;
    while (String(n).length + Buffer.byteLength(rest) !== n) n = String(n).length + Buffer.byteLength(rest);
    out += `${n}${rest}`;
  }
  return out;
}

function rawHeader(e: Raw, size: number): Buffer {
  const b = Buffer.alloc(512);
  b.write(e.name, 0, 100, "utf8");
  const oct = (off: number, len: number, v: number) =>
    b.write(`${v.toString(8).padStart(len - 1, "0")}\0`, off, len, "latin1");
  oct(100, 8, e.type === "5" ? 0o755 : 0o644);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, 0);
  b.fill(0x20, 148, 156);
  b.write(e.type, 156, 1, "latin1");
  if (e.link) b.write(e.link, 157, 100, "utf8");
  b.write(e.magic ?? "ustar\0" + "00", 257, 8, "latin1");
  if (e.prefix) b.write(e.prefix, 345, 155, "utf8");
  let sum = e.badSum ? 1 : 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return b;
}

function rawTar(entries: Raw[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "", "utf8");
    parts.push(rawHeader(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function refusedOnUnpack(archive: Buffer, entry: string, reason: RegExp): Promise<void> {
  const out = join(await tmp("out"), "tree");
  await assert.rejects(unpackAssembly(archive, out), (err: unknown) => {
    assert.ok(err instanceof AssemblyTarRefusal, `expected a refusal, got ${String(err)}`);
    assert.equal(err.entry, entry);
    assert.match(err.message, reason);
    return true;
  });
}

async function refusedOnPack(dir: string, entry: string, reason: RegExp): Promise<void> {
  await assert.rejects(packAssembly(dir), (err: unknown) => {
    assert.ok(err instanceof AssemblyTarRefusal, `expected a refusal, got ${String(err)}`);
    assert.equal(err.entry, entry);
    assert.match(err.message, reason);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------

test("a tree survives the round trip: directories (an empty one too), files with modes, relative symlinks", async () => {
  const src = await fixtureTree();
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(await packAssembly(src), out);
  assert.deepEqual(await listTree(out), await listTree(src));
  assert.equal((await stat(join(out, "images", "box", "entry.sh"))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(out, "node_modules", "dep")), ".pnpm/dep@1.0.0/node_modules/dep");
  assert.equal(await readFile(join(out, "node_modules", "dep", "lib", "index.js"), "utf8"), "x");
  assert.deepEqual(await readdir(join(out, "empty")), []);
  // The door recomputes the Assembly hash over the unpacked tree; it must equal the host's.
  assert.equal(await assemblyHash(out), await assemblyHash(src));
});

test("unpack reads a stream as well as a buffer, in chunks that split headers and bodies", async () => {
  const src = await fixtureTree();
  const archive = await packAssembly(src);
  const chunks: Buffer[] = [];
  for (let i = 0; i < archive.length; i += 333) chunks.push(archive.subarray(i, i + 333));
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(Readable.from(chunks), out);
  assert.deepEqual(await listTree(out), await listTree(src));
});

test("two packs of one tree are the same bytes, in path order with mtime, uid and gid 0", async () => {
  const src = await fixtureTree();
  const a = await packAssembly(src);
  // A later mtime on every entry must not move one byte.
  const later = new Date(Date.now() + 86_400_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(join(src, "jr2.config.ts"), later, later);
  await utimes(join(src, "workflows"), later, later);
  const b = await packAssembly(src);
  assert.ok(a.equals(b));
  // A second tree with the same content, written in another order, packs to the same bytes.
  const other = await tmp("src2");
  await writeFile(join(other, "z"), "2");
  await writeFile(join(other, "a"), "1");
  const again = await tmp("src3");
  await writeFile(join(again, "a"), "1");
  await writeFile(join(again, "z"), "2");
  assert.ok((await packAssembly(other)).equals(await packAssembly(again)));
  // The first header is the first path in byte order, and a directory comes before its children.
  const names: string[] = [];
  for (let off = 0; off < a.length; ) {
    const h = a.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    names.push(h.toString("utf8", 0, 100).replace(/\0.*$/s, ""));
    assert.equal(h.toString("latin1", 136, 147), "00000000000", "mtime is 0");
    assert.equal(h.toString("latin1", 108, 115), "0000000", "uid is 0");
    assert.equal(h.toString("latin1", 116, 123), "0000000", "gid is 0");
    const size = parseInt(h.toString("latin1", 124, 135), 8);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names.slice(0, 4), ["big.bin", "dangling", "empty/", "images/"]);
  assert.ok(names.indexOf("node_modules/") < names.indexOf("node_modules/.pnpm/"));
});

test("a long path rides the ustar prefix split", async () => {
  const src = await tmp("long");
  const deep = join(src, "a".repeat(80), "b".repeat(80));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "file.txt"), "deep");
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(await packAssembly(src), out);
  assert.deepEqual(await listTree(out), await listTree(src));
});

test("pack refuses an absolute symlink target, naming the entry", async () => {
  const src = await tmp("abs");
  await mkdir(join(src, "node_modules"));
  await symlink("/etc/passwd", join(src, "node_modules", "evil"));
  await refusedOnPack(src, "node_modules/evil", /absolute/);
});

test("pack refuses a relative symlink that escapes the tree, naming the entry", async () => {
  const src = await tmp("esc");
  await symlink("../outside", join(src, "up"));
  await refusedOnPack(src, "up", /outside the Assembly/);
});

test("a name, a path or a link target that ustar cannot hold rides a pax header", async () => {
  const src = await tmp("pax");
  // A 120-byte file name (an npm package ships 130), a 300-byte path, a 150-byte link target, a
  // top-level directory name of exactly 100 bytes, and a multibyte name over the split.
  const long = "n".repeat(120);
  await writeFile(join(src, long), "long name");
  const deep = join(src, "d".repeat(100), "e".repeat(100));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "f".repeat(98)), "deep path");
  const target = `${"d".repeat(100)}/${"e".repeat(48)}`;
  await symlink(target, join(src, "far"));
  await mkdir(join(src, "g".repeat(100)));
  await writeFile(join(src, "\u00e9".repeat(60)), "multibyte");
  const tar = await packAssembly(src);
  assert.ok(tar.includes(Buffer.from(` path=${long}\n`)), "the long name is a pax path record");
  assert.ok(tar.includes(Buffer.from(` linkpath=${target}\n`)), "the long target is a pax linkpath record");
  assert.deepEqual(await packAssembly(src), tar, "a pax pack is deterministic too");
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(tar, out);
  assert.deepEqual(await listTree(out), await listTree(src));
  assert.equal(await readlink(join(out, "far")), target);
});

test("unpack applies a pax header to its entry only, and checks its values", async () => {
  // The pax path wins over the ustar name, for the next entry only.
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ path: "real" }) },
      { name: "truncated", type: "0", body: "a" },
      { name: "plain", type: "0", body: "b" },
    ]),
    out,
  );
  assert.deepEqual((await readdir(out)).sort(), ["plain", "real"]);
  // A pax path or linkpath meets the same checks as a ustar one.
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ path: "a/../../etc" }) },
      { name: "x", type: "0", body: "x" },
    ]),
    "a/../../etc",
    /'\.\.'/,
  );
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ linkpath: "/etc" }) },
      { name: "l", type: "2", link: "ok" },
    ]),
    "l",
    /absolute/,
  );
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ linkpath: "../../etc" }) },
      { name: "l", type: "2", link: "ok" },
    ]),
    "l",
    /outside the Assembly/,
  );
  // Two in a row, one at the end, an unknown key, a linkpath on a file.
  const pax = { name: "././@PaxHeader", type: "x", body: paxBody({ path: "p" }) };
  await refusedOnUnpack(rawTar([pax, pax, { name: "f", type: "0" }]), "p", /follows another pax header/);
  await refusedOnUnpack(rawTar([pax]), "p", /pax header is the last entry/);
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ mtime: "1" }) },
      { name: "f", type: "0" },
    ]),
    "././@PaxHeader",
    /pax key "mtime"/,
  );
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: paxBody({ linkpath: "t" }) },
      { name: "f", type: "0" },
    ]),
    "f",
    /not a symlink/,
  );
  await refusedOnUnpack(
    rawTar([
      { name: "././@PaxHeader", type: "x", body: "99 path=p\n" },
      { name: "f", type: "0" },
    ]),
    "././@PaxHeader",
    /length does not match/,
  );
});

test("unpack refuses a global pax header and the GNU long-name entries", async () => {
  await refusedOnUnpack(rawTar([{ name: "g", type: "g", body: paxBody({ path: "p" }) }]), "g", /entry type "g"/);
  await refusedOnUnpack(rawTar([{ name: "././@LongLink", type: "L", body: "x" }]), "././@LongLink", /entry type "L"/);
  await refusedOnUnpack(rawTar([{ name: "././@LongLink", type: "K", body: "x" }]), "././@LongLink", /entry type "K"/);
});

test("unpack refuses a bad checksum and a header that is not ustar", async () => {
  await refusedOnUnpack(rawTar([{ name: "f", type: "0", body: "x", badSum: true }]), "f", /checksum/);
  // GNU tar's old magic, "ustar " + " \0".
  await refusedOnUnpack(rawTar([{ name: "f", type: "0", body: "x", magic: "ustar  \0" }]), "f", /not ustar/);
});

test("unpack refuses an empty or '.' segment, and a body on a directory or a symlink", async () => {
  await refusedOnUnpack(rawTar([{ name: "a//b", type: "0", body: "x" }]), "a//b", /empty or '\.' segment/);
  await refusedOnUnpack(rawTar([{ name: "./b", type: "0", body: "x" }]), "./b", /empty or '\.' segment/);
  await refusedOnUnpack(rawTar([{ name: "d/", type: "5", body: "x" }]), "d", /carries a body/);
  await refusedOnUnpack(rawTar([{ name: "l", type: "2", link: "f", body: "x" }]), "l", /carries a body/);
});

test("unpack refuses a link loop, and an escape through an absolute or a climbing link", async () => {
  await refusedOnUnpack(
    rawTar([
      { name: "a", type: "2", link: "b/x" },
      { name: "b", type: "2", link: "a/y" },
    ]),
    "a",
    /loop/,
  );
  await refusedOnUnpack(
    rawTar([
      { name: "a", type: "2", link: "b/etc" },
      { name: "b", type: "2", link: "../../../" },
    ]),
    "a",
    /outside the Assembly/,
  );
  // The absolute link alone is refused first, by its own target check.
  await refusedOnUnpack(rawTar([{ name: "b", type: "2", link: "/etc" }]), "b", /absolute/);
});

test("pack refuses a special file, naming the entry", async (t) => {
  const src = await tmp("fifo");
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(src, "pipe")]);
  } catch {
    t.skip("no mkfifo on this host");
    return;
  }
  await refusedOnPack(src, "pipe", /not a directory, a regular file or a symlink/);
});

test("unpack refuses an entry with a '..' segment", async () => {
  await refusedOnUnpack(rawTar([{ name: "a/../../etc", type: "0", body: "x" }]), "a/../../etc", /'\.\.'/);
});

test("unpack refuses an entry with a leading '/'", async () => {
  await refusedOnUnpack(rawTar([{ name: "/etc/cron.d/x", type: "0", body: "x" }]), "/etc/cron.d/x", /starts with '\/'/);
});

test("unpack refuses an absolute symlink target", async () => {
  await refusedOnUnpack(rawTar([{ name: "l", type: "2", link: "/etc" }]), "l", /absolute/);
});

test("unpack refuses a symlink that escapes dir, directly or through another link", async () => {
  await refusedOnUnpack(rawTar([{ name: "l", type: "2", link: "../../etc" }]), "l", /outside the Assembly/);
  // Each link alone stays inside; together they escape.
  await refusedOnUnpack(
    rawTar([
      { name: "l", type: "2", link: "s/.." },
      { name: "s", type: "2", link: "." },
    ]),
    "l",
    /outside the Assembly/,
  );
});

test("unpack refuses an entry under a symlink, so no write goes through a link", async () => {
  await refusedOnUnpack(
    rawTar([
      { name: "s", type: "2", link: "d" },
      { name: "s/f", type: "0", body: "x" },
    ]),
    "s/f",
    /not a directory/,
  );
});

test("unpack refuses a duplicate path, an unknown entry type, and a truncated archive", async () => {
  await refusedOnUnpack(
    rawTar([
      { name: "f", type: "0", body: "1" },
      { name: "f", type: "0", body: "2" },
    ]),
    "f",
    /twice/,
  );
  await refusedOnUnpack(rawTar([{ name: "h", type: "1", link: "f" }]), "h", /entry type/);
  const whole = rawTar([{ name: "f", type: "0", body: "x".repeat(600) }]);
  await refusedOnUnpack(whole.subarray(0, 700), "f", /ends inside/);
  await refusedOnUnpack(whole.subarray(0, 0), "", /ends before/);
});

test("unpack reads the prefix field, and refuses a prefixed path that climbs", async () => {
  const out = join(await tmp("out"), "tree");
  await unpackAssembly(
    rawTar([
      { name: "p/", type: "5" },
      { name: "f", prefix: "p", type: "0", body: "ok" },
    ]),
    out,
  );
  assert.equal(await readFile(join(out, "p", "f"), "utf8"), "ok");
  await refusedOnUnpack(rawTar([{ name: "f", prefix: "..", type: "0", body: "x" }]), "../f", /'\.\.'/);
});

test("unpack refuses a non-empty target directory", async () => {
  const out = await tmp("full");
  await writeFile(join(out, "already"), "x");
  await assert.rejects(unpackAssembly(rawTar([]), out), /not empty/);
  await rm(out, { recursive: true });
});
