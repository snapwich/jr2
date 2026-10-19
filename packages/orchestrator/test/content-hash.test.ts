// The content addresses two ends compute over one tree (ADR-0038, ADR-0049, ADR-0069) must not
// depend on where they run. The host that runs `jr2 up` and the Kit image that runs the door can
// have different locales, so the walk order must be byte order, never a locale's collation: in
// `cs_CZ`, "ch" sorts after "h", so `chalk` would sort after `hono`. Each hash is computed here in
// child processes under several locales, and they must agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblyHash, byteOrder } from "../src/content-hash.ts";

const CONTENT_HASH = new URL("../src/content-hash.ts", import.meta.url).href;
const IMAGES = new URL("../src/images.ts", import.meta.url).href;

/** Names whose order differs between byte order and at least one of the locales below. */
const NAMES = ["chalk", "debug", "hono", "yaml", "zod", "aardvark", "ilk"];

async function tree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-hash-locale-"));
  for (const name of NAMES) {
    await mkdir(join(dir, "node_modules", name), { recursive: true });
    await writeFile(join(dir, "node_modules", name, "index.js"), `export const name = "${name}";\n`);
  }
  await writeFile(join(dir, "package.json"), "{}\n");
  return dir;
}

/** Runs `script` (an ES module body) in a child node under `locale`; prints its stdout. */
function under(locale: string, script: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    encoding: "utf8",
  }).trim();
}

const LOCALES = ["en_US.UTF-8", "cs_CZ.UTF-8", "lt_LT.UTF-8", "et_EE.UTF-8", "da_DK.UTF-8", "C"];

test("byteOrder is UTF-8 byte order, not a collation", () => {
  assert.deepEqual(["hono", "debug", "chalk", "Zed", "aa", "ab"].sort(byteOrder), [
    "Zed",
    "aa",
    "ab",
    "chalk",
    "debug",
    "hono",
  ]);
});

test("the test bites: under cs_CZ a locale sort puts chalk after hono", () => {
  // Without this, a Node without the locale's ICU data would pass the next tests vacuously.
  assert.equal(under("cs_CZ.UTF-8", `console.log("chalk".localeCompare("hono") > 0)`), "true");
});

test("contentHash gives one hash for one tree in every locale (ADR-0069's door check)", async () => {
  const dir = await tree();
  const script = `import { contentHash, ASSEMBLY_HASH_SALT } from ${JSON.stringify(CONTENT_HASH)};
    console.log(await contentHash([${JSON.stringify(dir)}], ASSEMBLY_HASH_SALT));`;
  const hashes = LOCALES.map((l) => under(l, script));
  for (const [i, h] of hashes.entries()) assert.equal(h, hashes[0], `${LOCALES[i]} hashes as en_US does`);
});

test("assemblyHash gives one hash for one tree in every locale (ADR-0069's door check)", async () => {
  const dir = await tree();
  const script = `import { assemblyHash } from ${JSON.stringify(CONTENT_HASH)};
    console.log(await assemblyHash(${JSON.stringify(dir)}));`;
  const hashes = LOCALES.map((l) => under(l, script));
  for (const [i, h] of hashes.entries()) assert.equal(h, hashes[0], `${LOCALES[i]} hashes as en_US does`);
});

/** A fresh tree from `files` (path -> content, or `{ link }` for a symlink, or `{ dir: true }`). */
async function make(files: Record<string, string | { link: string } | { dir: true }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-asmhash-"));
  for (const [rel, entry] of Object.entries(files)) {
    const p = join(dir, rel);
    if (typeof entry === "string") {
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, entry);
    } else if ("link" in entry) {
      await mkdir(join(p, ".."), { recursive: true });
      await symlink(entry.link, p);
    } else await mkdir(p, { recursive: true });
  }
  return dir;
}

test("assemblyHash: a changed symlink target is a changed Assembly", async () => {
  const v1 = await make({ "lib/v1/a.ts": "1", "lib/v2/a.ts": "2", "workflows/lib": { link: "../lib/v1" } });
  const v2 = await make({ "lib/v1/a.ts": "1", "lib/v2/a.ts": "2", "workflows/lib": { link: "../lib/v2" } });
  try {
    assert.notEqual(await assemblyHash(v1), await assemblyHash(v2));
  } finally {
    await Promise.all([rm(v1, { recursive: true }), rm(v2, { recursive: true })]);
  }
});

test("assemblyHash: records are framed, so one file cannot hash as two", async () => {
  const one = await make({ a: "X0:b\nY" });
  const two = await make({ a: "X", b: "Y" });
  try {
    assert.notEqual(await assemblyHash(one), await assemblyHash(two));
  } finally {
    await Promise.all([rm(one, { recursive: true }), rm(two, { recursive: true })]);
  }
});

test("assemblyHash: an empty directory counts; a mode does not; one tree hashes the same twice", async () => {
  const bare = await make({ "workflows/a.ts": "x" });
  const withEmpty = await make({ "workflows/a.ts": "x", "images/empty": { dir: true } });
  const again = await make({ "workflows/a.ts": "x" });
  try {
    assert.notEqual(await assemblyHash(bare), await assemblyHash(withEmpty));
    assert.equal(await assemblyHash(bare), await assemblyHash(again));
    await chmod(join(again, "workflows", "a.ts"), 0o755);
    assert.equal(await assemblyHash(bare), await assemblyHash(again), "nothing at the door reads a mode");
    assert.match(await assemblyHash(bare), /^[0-9a-f]{12}$/);
  } finally {
    await Promise.all([bare, withEmpty, again].map((d) => rm(d, { recursive: true })));
  }
});

test("imageContextDigest gives one digest for one context in every locale (ADR-0049)", async () => {
  const dir = await tree();
  const script = `import { imageContextDigest } from ${JSON.stringify(IMAGES)};
    console.log(await imageContextDigest(${JSON.stringify(dir)}));`;
  const digests = LOCALES.map((l) => under(l, script));
  for (const [i, d] of digests.entries()) assert.equal(d, digests[0], `${LOCALES[i]} digests as en_US does`);
});
