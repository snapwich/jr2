// The child's half of a Handoff's transport (ADR-0080): `PUT /handoffs/<id>` lands the files that
// the Orchestrator carries in the folder of the cut's Effect id, through the land process in a real
// Landlock domain (the real spawner, `support/children.ts`). And the whole path on real git: the
// parent's bundle step, the land, and the child's cut.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessApp } from "../src/app.ts";
import { cut } from "../src/cut.ts";
import { bundleHandoff } from "../src/handoff-bundle.ts";
import { landHandoff, type LandOptions } from "../src/handoff-land.ts";
import { landedFolder } from "../src/handoff-land-main.ts";
import { HANDOFF_CONTENT_TYPE } from "../src/wire.ts";
import { testChildren } from "./support/children.ts";

const ID = "0b7c5e1a-4d2f-4c55-9a51-6f1d2e3c4b5a";
const OID_A = "a".repeat(64);
const OID_B = "b".repeat(64);

/** A body of frames: a header object, or the bytes of a part as `data` frames. */
function body(...parts: Array<Record<string, unknown> | Buffer | string>): Buffer {
  return Buffer.concat(
    parts.map((p) =>
      Buffer.isBuffer(p)
        ? Buffer.concat([Buffer.from(`${JSON.stringify({ data: p.length })}\n`), p])
        : Buffer.from(typeof p === "string" ? p : `${JSON.stringify(p)}\n`),
    ),
  );
}

/** A stream of `bytes` in chunks of `size`. */
function streamOf(bytes: Buffer, size = 7): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(new Uint8Array(bytes.subarray(at, at + size)));
      at += size;
    },
  });
}

function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-land-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, "work");
  mkdirSync(work);
  const children = testChildren({ work });
  t.after(() => children.spawner.close());
  const land = (bytes: Buffer | ReadableStream<Uint8Array>, opts: LandOptions = {}, id = ID) =>
    landHandoff(children, id, Buffer.isBuffer(bytes) ? streamOf(bytes) : bytes, { workRoot: work, ...opts });
  const folder = landedFolder(work, ID);
  const left = () => (existsSync(join(work, ".jr2-handoffs")) ? readdirSync(join(work, ".jr2-handoffs")).sort() : []);
  return { dir, work, children, land, folder, left };
}

test("PUT /handoffs/<id> lands the bundle and each Git LFS object in the folder of the cut, byte for byte", async (t) => {
  const w = world(t);
  const bundle = Buffer.from("a bundle\n".repeat(100));
  const answer = await w.land(
    body(
      { bundle: bundle.length },
      bundle.subarray(0, 300),
      bundle.subarray(300),
      { lfs: OID_A, size: 3 },
      Buffer.from("abc"),
      { lfs: OID_B, size: 1 },
      Buffer.from("z"),
      { end: true },
    ),
  );
  assert.deepEqual(answer, { landed: true });
  assert.deepEqual(readFileSync(join(w.folder, "bundle")), bundle);
  assert.equal(readFileSync(join(w.folder, "lfs", OID_A), "utf8"), "abc");
  assert.equal(readFileSync(join(w.folder, "lfs", OID_B), "utf8"), "z");
  assert.deepEqual(w.left(), [ID], "no part folder is left");
});

test("a second body for one id replaces the files of the first", async (t) => {
  const w = world(t);
  await w.land(body({ bundle: 3 }, Buffer.from("one"), { lfs: OID_A, size: 1 }, Buffer.from("a"), { end: true }));
  assert.deepEqual(await w.land(body({ bundle: 3 }, Buffer.from("two"), { end: true })), { landed: true });
  assert.equal(readFileSync(join(w.folder, "bundle"), "utf8"), "two");
  assert.equal(existsSync(join(w.folder, "lfs", OID_A)), false, "the first body's object is gone");
});

test("a body that ends before its end frame, or is out of its form, keeps nothing", async (t) => {
  const w = world(t);
  const cases: Array<[string, Buffer, RegExp, LandOptions?]> = [
    ["no end", body({ bundle: 3 }, Buffer.from("one")), /ended before its end frame/],
    ["a part short of its size", body({ bundle: 3 }, Buffer.from("on")), /ended before its end frame/],
    [
      "end inside a part",
      body({ bundle: 3 }, Buffer.from("on"), { end: true }),
      /a part of the body ended before its size/,
    ],
    ["no bundle", body({ lfs: OID_A, size: 1 }, Buffer.from("a"), { end: true }), /out of its form/],
    ["end alone", body({ end: true }), /out of its form/],
    [
      "two bundles",
      body({ bundle: 1 }, Buffer.from("x"), { bundle: 1 }, Buffer.from("y"), { end: true }),
      /out of its form/,
    ],
    ["data past its part", body({ bundle: 1 }, Buffer.from("xy"), { end: true }), /out of its part/],
    ["data with no part", body({ data: 1 }, "x", { end: true }), /out of its part/],
    [
      "an object of no bytes",
      body({ bundle: 1 }, Buffer.from("x"), { lfs: OID_A, size: 0 }, { end: true }),
      /out of its form/,
    ],
    [
      "an oid that is not one",
      body({ bundle: 1 }, Buffer.from("x"), { lfs: "../x", size: 1 }, Buffer.from("a"), { end: true }),
      /out of its form/,
    ],
    [
      "an object twice",
      body(
        { bundle: 1 },
        Buffer.from("x"),
        { lfs: OID_A, size: 1 },
        Buffer.from("a"),
        { lfs: OID_A, size: 1 },
        Buffer.from("a"),
        { end: true },
      ),
      /came twice/,
    ],
    ["a header that is not JSON", body("not json\n"), /not JSON/],
    ["a header past its length", body(`{"bundle":1${" ".repeat(2000)}}\n`), /longer than its form/],
    ["bytes after the end", body({ bundle: 1 }, Buffer.from("x"), { end: true }, { end: true }), /after its end frame/],
    [
      "the byte bound",
      body({ bundle: 2 }, Buffer.from("xy"), { lfs: OID_A, size: 2 }, Buffer.from("ab"), { end: true }),
      /bound of 3 bytes/,
      { maxBytes: 3 },
    ],
    [
      "the object bound",
      body(
        { bundle: 1 },
        Buffer.from("x"),
        { lfs: OID_A, size: 1 },
        Buffer.from("a"),
        { lfs: OID_B, size: 1 },
        Buffer.from("b"),
        { end: true },
      ),
      /more than 1 Git LFS objects/,
      { maxObjects: 1 },
    ],
  ];
  for (const [what, bytes, why, opts] of cases) {
    const answer = await w.land(bytes, opts);
    assert.ok("fault" in answer, what);
    assert.match(answer.fault, why, what);
    assert.deepEqual(w.left(), [], `${what}: nothing is kept`);
  }
});

test("the Harness sends only a window ahead of what the land process took, and a body that breaks kills it and keeps nothing", async (t) => {
  const w = world(t);
  // 8 MiB in chunks of 64 KiB through a window of 128 KiB: every byte.
  const big = Buffer.alloc(8 << 20, 7);
  assert.deepEqual(
    await w.land(streamOf(body({ bundle: big.length }, big, { end: true }), 64 << 10), { window: 128 << 10 }),
    { landed: true },
  );
  assert.deepEqual(readFileSync(join(w.folder, "bundle")), big);

  // A land process that takes nothing: the Harness reads no more of the body than the window.
  const stall = join(w.dir, "stall.mjs");
  writeFileSync(stall, "setInterval(() => {}, 1000);\n");
  let pulled = 0;
  let fail!: (e: Error) => void;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += 16 << 10;
      c.enqueue(new Uint8Array(16 << 10));
    },
    start(c) {
      fail = (e) => c.error(e);
    },
  });
  const landing = w.land(endless, { window: 64 << 10, entry: stall });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(pulled <= (64 << 10) + 3 * (16 << 10), `the Harness read ${pulled} bytes of the body`);
  fail(new Error("the Orchestrator ended the carry"));
  const answer = await landing;
  assert.ok(
    "fault" in answer && /the body broke: the Orchestrator ended the carry/.test(answer.fault),
    JSON.stringify(answer),
  );

  // A real land process whose body breaks in a part: no folder is kept.
  let parts = 0;
  const broken = new ReadableStream<Uint8Array>({
    pull(c) {
      if (parts++ === 0) return c.enqueue(new Uint8Array(body({ bundle: 10 }, '{"data":10}\nabc')));
      c.error(new Error("the socket closed"));
    },
  });
  const other = await landHandoff(w.children, "other-id", broken, { workRoot: w.work });
  assert.ok("fault" in other && /the body broke/.test(other.fault));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(w.left(), [ID], "only the first landing; no part of the broken one");
});

test("a land process that does not run, or says something out of its form, is a fault", async (t) => {
  const w = world(t);
  const liar = join(w.dir, "liar.mjs");
  writeFileSync(
    liar,
    'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ landed: true, extra: 1 })));\n',
  );
  const said = await w.land(body({ bundle: 1 }, Buffer.from("x"), { end: true }), { entry: liar });
  assert.ok("fault" in said && /out of its form/.test(said.fault), JSON.stringify(said));
  const quiet = join(w.dir, "quiet.mjs");
  writeFileSync(quiet, "process.stdin.resume();\n");
  const none = await w.land(body({ bundle: 1 }, Buffer.from("x"), { end: true }), { entry: quiet });
  assert.ok("fault" in none && /the land process ended with exit 0/.test(none.fault), JSON.stringify(none));
  assert.deepEqual(await w.land(body({ end: true }), {}, "../escape"), { fault: '"../escape" is no Effect id' });
});

test("PUT /handoffs/<id>: landed is 200, a fault 500, a bad id 400, another body type 415, the Instance Harness 403, none 501", async () => {
  const seen: string[] = [];
  const deps = { checkBearer: () => true, runSubmissionFor: () => () => new Promise<void>(() => {}) };
  const land = async (id: string, b: ReadableStream<Uint8Array> | null) => {
    seen.push(id);
    const text = b === null ? "" : await new Response(b).text();
    return text === "good" ? ({ landed: true } as const) : { fault: "out of its form" };
  };
  const app = harnessApp({ ...deps, land });
  const put = (a: ReturnType<typeof harnessApp>, id: string, text: string, type = HANDOFF_CONTENT_TYPE) =>
    a.request(`/handoffs/${id}`, { method: "PUT", body: text, headers: { "content-type": type } });
  const ok = await put(app, ID, "good");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { landed: true });
  const bad = await put(app, ID, "bad");
  assert.equal(bad.status, 500);
  assert.deepEqual(await bad.json(), { error: "out of its form" });
  assert.equal((await put(app, "a.b", "good")).status, 400);
  assert.equal((await put(app, ID, "good", "application/json")).status, 415);
  assert.equal((await put(harnessApp({ ...deps, menuOnly: true, land }), ID, "good")).status, 403);
  assert.equal((await put(harnessApp(deps), ID, "good")).status, 501);
  assert.deepEqual(seen, [ID, ID]);
});

// ---- the whole path ----------------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=Coder", "-c", "user.email=coder@example.test", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();

test("the whole path on real git: the parent's bundle step, the land in the child's domain, and the child's cut", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", remote]);
  // The parent Sandbox: its clone, and the coder's Worktree with two commits that the remote lacks.
  const parentWork = join(dir, "parent");
  const parentClone = join(parentWork, "app", "default");
  mkdirSync(join(parentWork, "app"), { recursive: true });
  execFileSync("git", ["clone", "-q", remote, parentClone], { stdio: "ignore" });
  writeFileSync(join(parentClone, "a.txt"), "a\n");
  git(parentClone, "add", ".");
  git(parentClone, "commit", "-qm", "base");
  git(parentClone, "push", "-q", "origin", "HEAD:main");
  git(parentClone, "fetch", "-q", "origin");
  const coder = join(parentWork, "app", "coder");
  git(parentClone, "worktree", "add", "-q", "-b", "fix/one", coder, "main");
  writeFileSync(join(coder, "fix.txt"), "the fix\n");
  git(coder, "add", ".");
  git(coder, "commit", "-qm", "the fix");
  const head = git(coder, "rev-parse", "HEAD");
  // The child Sandbox: its own clone of the real remote.
  const childWork = join(dir, "child");
  const childClone = join(childWork, "app", "default");
  mkdirSync(join(childWork, "app"), { recursive: true });
  execFileSync("git", ["clone", "-q", remote, childClone], { stdio: "ignore" });

  const parent = testChildren({ work: parentWork });
  const child = testChildren({ work: childWork });
  t.after(() => (parent.spawner.close(), child.spawner.close()));
  // The Orchestrator's pipe, without its checks: the source's frames end with `end`, as a body does.
  const source = bundleHandoff(parent, { path: coder, head }, { workRoot: parentWork });
  assert.deepEqual(await landHandoff(child, ID, source, { workRoot: childWork }), { landed: true });

  const jr2Lfs = join(dir, "jr2-lfs");
  writeFileSync(jr2Lfs, `#!/bin/sh\necho '{"pointers":0,"asked":0,"missing":[]}'\n`, { mode: 0o755 });
  const answer = await cut(
    { id: ID, path: join(childWork, "app", "final"), branch: "fix/one", handoff: head },
    { workRoot: childWork, lock: ["flock", "-x", "0"], gitLfs: "/nonexistent", jr2Lfs },
  );
  assert.equal(answer.outcome, "ready", JSON.stringify(answer));
  const final = join(childWork, "app", "final");
  assert.equal(git(final, "log", "-1", "--format=%H %an %s"), `${head} Coder the fix`);
  assert.equal(readFileSync(join(final, "fix.txt"), "utf8"), "the fix\n");
  assert.equal(git(childClone, "remote"), "origin");
  assert.equal(existsSync(join(childWork, ".jr2-handoffs")), false, "the cut removed the landed files");
});
