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
import { HANDOFF_LAND_MS, landHandoff, landingExecs, type LandOptions } from "../src/handoff-land.ts";
import { landedFolder } from "../src/handoff-land-main.ts";
import { HANDOFF_CARRY_MS, HANDOFF_CONTENT_TYPE } from "../src/wire.ts";
import type { ChildPolicy } from "../src/children.ts";
import type { SpawnHandlers, SpawnRequest, Spawned } from "../src/spawner.ts";
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

/** The domain's spawner, but each `rm` that it runs starts `ms` late: a removal that comes after the
 * next step of a land unless something waits for it. */
function slowRm(children: ChildPolicy, ms: number): ChildPolicy {
  const real = children.spawner;
  const spawn = (req: SpawnRequest, handlers?: SpawnHandlers): Spawned => {
    if (req.argv[0] !== "rm") return real.spawn(req, handlers);
    const later = new Promise((r) => setTimeout(r, ms)).then(() => real.spawn(req, handlers));
    return { exited: later.then((p) => p.exited) } as Spawned;
  };
  const spawner = new Proxy(real, {
    get(target, prop) {
      if (prop === "spawn") return spawn;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...children, spawner };
}

function world(t: TestContext, opts: { slowRmMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-land-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, "work");
  mkdirSync(work);
  const real = testChildren({ work });
  t.after(() => real.spawner.close());
  const children = opts.slowRmMs === undefined ? real : slowRm(real, opts.slowRmMs);
  const land = (bytes: Buffer | ReadableStream<Uint8Array>, opts: LandOptions = {}, id = ID) =>
    landHandoff(children, id, Buffer.isBuffer(bytes) ? streamOf(bytes) : bytes, { workRoot: work, ...opts });
  const folder = landedFolder(work, ID);
  const left = () =>
    existsSync(join(work, ".jr2", "handoffs")) ? readdirSync(join(work, ".jr2", "handoffs")).sort() : [];
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
});

/** A body whose first chunk is `head`, and which then waits: `fail` breaks it, `more` sends more. */
function held(head: Buffer) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(new Uint8Array(head));
    },
  });
  return {
    stream,
    fail: (e: Error) => ctl.error(e),
    more: (b: Buffer) => ctl.enqueue(new Uint8Array(b)),
    close: () => ctl.close(),
  };
}

/** Wait until `ok` is true, or fail after about 10 s. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(ok(), what);
}

test("a real land process whose body breaks after it wrote a part: the Harness removes the part folder in the domain", async (t) => {
  const w = world(t);
  // An earlier body for the id landed: the broken body of the same id keeps nothing of either.
  await w.land(body({ bundle: 3 }, Buffer.from("one"), { end: true }));
  const part = `${w.folder}.part`;
  const b = held(body({ bundle: 10 }, '{"data":10}\nabcde'));
  const landing = w.land(b.stream);
  // The land process took the first chunk: it made `<id>.part` and wrote into it.
  await until(
    () => existsSync(join(part, "bundle")) && readFileSync(join(part, "bundle"), "utf8") === "abcde",
    "the part is written",
  );
  b.fail(new Error("the socket closed"));
  const answer = await landing;
  assert.ok("fault" in answer && /the body broke: the socket closed/.test(answer.fault), JSON.stringify(answer));
  assert.deepEqual(w.left(), [], "no part folder, and no landed folder, is kept");
});

test("a land has a time of its own, above the Orchestrator's carry: past it, the land ends and keeps nothing", async (t) => {
  assert.ok(HANDOFF_LAND_MS > HANDOFF_CARRY_MS, "the Orchestrator ends its carry first");
  const w = world(t);
  const part = `${w.folder}.part`;
  // The Orchestrator's node is gone: the body neither comes nor breaks.
  const b = held(body({ bundle: 10 }, '{"data":10}\nabcde'));
  const landing = w.land(b.stream, { timeMs: 1000 });
  await until(() => existsSync(join(part, "bundle")), "the part is written");
  const answer = await landing;
  assert.ok("fault" in answer && /the land passed its time of 1 s/.test(answer.fault), JSON.stringify(answer));
  assert.deepEqual(w.left(), []);
});

test("the lands of one id run one at a time: a newer body stops the land before it, which removes its part first", async (t) => {
  const w = world(t);
  const part = `${w.folder}.part`;
  const first = held(body({ bundle: 10 }, '{"data":10}\nabcde'));
  const one = w.land(first.stream);
  await until(() => existsSync(join(part, "bundle")), "the first body's part is written");
  // The Orchestrator gave up the first body, which no longer comes, and carries again; it gives up
  // that body too before its land starts, and carries a third time.
  const waiting = w.land(held(body({ bundle: 3 })).stream);
  const two = w.land(body({ bundle: 3 }, Buffer.from("two"), { end: true }));
  for (const ended of [await one, await waiting]) {
    assert.ok("fault" in ended && /a newer body for the same id came/.test(ended.fault), JSON.stringify(ended));
  }
  assert.deepEqual(await two, { landed: true });
  assert.equal(readFileSync(join(w.folder, "bundle"), "utf8"), "two", "the removal of the first missed the second");
  assert.deepEqual(w.left(), [ID]);
});

test("a newer land waits until the land before it removed what it left: a slow removal never hits the newer land's files", async (t) => {
  const w = world(t, { slowRmMs: 800 });
  // An earlier body of the id landed, so the older land's removal finds `<id>` as well as its part.
  assert.deepEqual(await w.land(body({ bundle: 3 }, Buffer.from("one"), { end: true })), { landed: true });
  const first = held(body({ bundle: 10 }, '{"data":10}\nabcde'));
  const one = w.land(first.stream);
  await until(() => existsSync(join(`${w.folder}.part`, "bundle")), "the first body's part is written");
  const two = await w.land(body({ bundle: 3 }, Buffer.from("two"), { end: true }));
  assert.ok("fault" in (await one));
  assert.deepEqual(two, { landed: true });
  // Past the time at which a removal that nothing waited for would come.
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(readFileSync(join(w.folder, "bundle"), "utf8"), "two", "the newer land's files are there");
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
  assert.equal(existsSync(join(childWork, ".jr2", "handoffs")), false, "the cut removed the landed files");
});

test("the files landed for a cut go when its exec settles, also when the Effect's timeout kills it, and when a kill comes before its start", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "handoff-drop-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const children = testChildren({ work });
  t.after(() => children.spawner.close());
  // The Execs that `main.ts` serves.
  const execs = landingExecs(children, work);
  const plant = (id: string) => {
    const folder = landedFolder(work, id);
    mkdirSync(join(folder, "lfs"), { recursive: true });
    writeFileSync(join(folder, "bundle"), "the parent's bytes");
    mkdirSync(`${folder}.part`, { recursive: true });
    return folder;
  };
  // The cut hangs, and its timeout kills its group: no `finally` of the cut runs.
  const hung = plant(ID);
  execs.start(ID, { argv: ["sleep", "30"], cwd: work, timeoutMs: 200, tail: 100 });
  await until(() => !existsSync(hung) && !existsSync(`${hung}.part`), "the landed folder is gone");
  // A kill before the start: the carry landed the files, and the cut's state exited.
  const early = "1d2e3c4b-0b7c-4c55-9a51-6f1d2e3c4b5a";
  const folder = plant(early);
  execs.kill(early);
  await until(() => !existsSync(folder) && !existsSync(`${folder}.part`), "the files of the killed id are gone");
});

test("a kill of an id whose land still runs stops that land first, so the land cannot rename its part into place after the removal looked", async (t) => {
  const w = world(t, { slowRmMs: 800 });
  const execs = landingExecs(w.children, w.work);
  const b = held(body({ bundle: 10 }, '{"data":10}\nabcde'));
  const landing = w.land(b.stream);
  await until(() => existsSync(join(`${w.folder}.part`, "bundle")), "the part is written");
  // The Orchestrator's carry ended after the child got the whole body: it kills the id.
  execs.kill(ID);
  await new Promise((r) => setTimeout(r, 100));
  try {
    b.more(Buffer.from(`fghij${JSON.stringify({ end: true })}\n`));
    b.close();
  } catch {
    // The land was stopped, and its body cancelled.
  }
  const answer = await landing;
  assert.ok("fault" in answer && /its exec settled/.test(answer.fault), JSON.stringify(answer));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(w.left(), [], "no landed folder is kept");
});
