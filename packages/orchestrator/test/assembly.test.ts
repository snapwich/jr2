// The publish door and the current Assembly (ADR-0069): `PUT /assembly` behind the publish token,
// `GET /assembly`, `/healthz`'s hash, and which Assembly a boot loads. Each fixture Assembly is a
// real tree packed by the same codec `jr2 up` packs with, and hashed by the same function and salt.
// Driven over an ephemeral loopback port, like instance.test.ts. There is no folder boot: every
// Workflow here arrives through the door.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembliesDir, kitClosure } from "../src/assembly.ts";
import { packAssembly } from "../src/assembly-tar.ts";
import { KIT_VERSION } from "../src/config.ts";
import { assemblyHash } from "../src/content-hash.ts";
import { startInstance, type RunningInstance } from "../src/instance.ts";
import { serverMain } from "../src/server.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import {
  admitTree,
  chartedSrc,
  FIXTURE_ASSEMBLY,
  plainSrc,
  publishTree,
  reviewLoop,
  scratchInstance,
  stageTree,
} from "./_assembly.ts";

const KEY = Buffer.alloc(32, 5);
const XSTATE = JSON.stringify(import.meta.resolve("xstate"));
const INDEX = JSON.stringify(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts")).href,
);

/** A one-state Workflow, imported by absolute URL: a temp tree resolves no bare specifier. */
const machineSrc = (id: string) =>
  `import { setup } from ${XSTATE};\n` +
  `export const machine = setup({}).createMachine({ id: ${JSON.stringify(id)}, initial: "a", states: { a: {} } });\n`;

/** A Workflow that leaves a Repo Slot open: the walk refuses it (ADR-0051). */
const openSlotSrc =
  `import { setup } from ${XSTATE};\n` +
  `import { workspace, open } from ${INDEX};\n` +
  `const body = setup({}).createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
  `export const machine = workspace(body, { repos: { app: open }, spec: () => ({ branch: "b" }) });\n`;

type Packed = { tar: Buffer; hash: string; dir: string };

/** A tree with these files, its packed bytes, and its hash. */
async function mkAssembly(files: Record<string, string>): Promise<Packed> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-asm-src-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return { dir, tar: await packAssembly(dir), hash: await assemblyHash(dir) };
}

/** An empty instance folder. */
const mkInstance = () => mkdtemp(join(tmpdir(), "jr2-asm-inst-"));

async function boot(dir: string): Promise<RunningInstance> {
  return startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
}

/** Boot an empty instance and publish `echo` through the door: the old Assembly of each test. */
async function bootWithEcho(): Promise<{ inst: RunningInstance; dir: string; echo: Packed }> {
  const dir = await mkInstance();
  const inst = await boot(dir);
  const echo = await mkAssembly({ "workflows/echo.ts": machineSrc("echo") });
  const res = await put(inst, echo);
  assert.equal(res.status, 200, await res.text());
  return { inst, dir, echo };
}

function put(
  inst: RunningInstance,
  a: { tar: Buffer | Uint8Array | ReadableStream<Uint8Array>; hash: string },
  opts: { token?: string | null; kitVersion?: string } = {},
): Promise<Response> {
  const token = opts.token === undefined ? inst.publishToken : opts.token;
  const tar = a.tar;
  const streamed = tar instanceof ReadableStream;
  return fetch(`${inst.url}/assembly`, {
    method: "PUT",
    headers: {
      "content-type": "application/x-tar",
      "jr2-kit-version": opts.kitVersion ?? KIT_VERSION,
      "jr2-assembly-hash": a.hash,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: tar instanceof ReadableStream ? tar : new Uint8Array(tar),
    ...(streamed ? { duplex: "half" } : {}),
  } as RequestInit);
}

const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<T> =>
  (await (await res).json()) as T;

/** The names `GET /workflows` lists (ADR-0070: each entry is a listing; the names are what these
 * tests read). */
const workflowsOf = async (inst: RunningInstance): Promise<string[]> =>
  (await json<Array<{ name: string }>>(fetch(`${inst.url}/workflows`))).map((w) => w.name);

/**
 * A body that sends its first block and then stays open until `end()`. A door that answers while
 * it is still open did not read the body; `pulls` counts how far the reader went.
 */
function openBody(tar: Buffer): { stream: ReadableStream<Uint8Array>; pulls: () => number; end: () => void } {
  let pulls = 0;
  let end!: () => void;
  const ended = new Promise<void>((r) => (end = r));
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      pulls++;
      if (pulls === 1) {
        ctrl.enqueue(new Uint8Array(tar.subarray(0, 512)));
        return;
      }
      await ended;
      ctrl.close();
    },
  });
  return { stream, pulls: () => pulls, end };
}

const stagingLeft = async (dir: string) => (await readdir(assembliesDir(dir))).filter((n) => n.startsWith(".staging-"));

test("PUT /assembly: no token → 401; the Instance token → 403 naming the publish token", async () => {
  const { inst } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    assert.equal((await put(inst, a, { token: null })).status, 401);
    const res = await put(inst, a, { token: inst.instanceToken });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /publish token/);
    assert.deepEqual(await workflowsOf(inst), ["echo"]);
  } finally {
    await inst.close();
  }
});

test("the publish token opens no other route: starting a run with it → 403", async () => {
  const { inst } = await bootWithEcho();
  try {
    const res = await fetch(`${inst.url}/workflows/echo/runs`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${inst.publishToken}` },
    });
    assert.equal(res.status, 403);
    const runs = await fetch(`${inst.url}/runs`, { headers: { authorization: `Bearer ${inst.publishToken}` } });
    assert.equal(runs.status, 403);
  } finally {
    await inst.close();
  }
});

test("another Kit version → 409 naming both numbers, before the body is read", async () => {
  const { inst } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    const open = openBody(a.tar);
    // The answer arrives while the body is still open: the door refused on the header alone.
    const res = await put(inst, { tar: open.stream, hash: a.hash }, { kitVersion: "0.0.0-other" });
    assert.ok(open.pulls() <= 2, `the door read the body (${open.pulls()} pulls)`);
    open.end();
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; kitVersion: { assembly: string; orchestrator: string } };
    assert.deepEqual(body.kitVersion, { assembly: "0.0.0-other", orchestrator: KIT_VERSION });
    assert.match(body.error, /0\.0\.0-other/);
    assert.ok(body.error.includes(KIT_VERSION));
  } finally {
    await inst.close();
  }
});

test("a body that hashes to another hash → 400, nothing published", async () => {
  const { inst, dir, echo } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    const res = await put(inst, { tar: a.tar, hash: "0123456789ab" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /hashes to/);
    assert.equal((await readFile(join(assembliesDir(dir), "current"), "utf8")).trim(), echo.hash);
    assert.deepEqual(await workflowsOf(inst), ["echo"]);
    assert.equal(existsSync(join(assembliesDir(dir), "0123456789ab")), false);
    assert.deepEqual(await stagingLeft(dir), [], "no staging is left behind");
  } finally {
    await inst.close();
  }
});

test("a truncated or empty body → 400 that names the archive, not an empty entry", async () => {
  const { inst, dir } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    for (const tar of [a.tar.subarray(0, 512), Buffer.alloc(0)]) {
      const res = await put(inst, { tar, hash: a.hash });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; entry?: string };
      assert.equal("entry" in body, false, JSON.stringify(body));
      assert.doesNotMatch(body.error, /entry ""/);
    }
    assert.deepEqual(await workflowsOf(inst), ["echo"]);
    assert.deepEqual(await stagingLeft(dir), []);
  } finally {
    await inst.close();
  }
});

test("a walk refusal → 422 with the report, and the old Assembly still serves", async () => {
  const { inst, dir } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/ws.ts": openSlotSrc });
    const res = await put(inst, a);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string; report: string[] };
    assert.equal(body.error, "refused");
    assert.equal(body.report.length, 1);
    assert.match(body.report[0]!, /workflow "ws" leaves Repo Slot "app" open/);
    assert.deepEqual(await workflowsOf(inst), ["echo"]);
    assert.equal(existsSync(join(assembliesDir(dir), a.hash)), false, "a refused tree does not stay");
  } finally {
    await inst.close();
  }
});

test("a missing `export const machine` → 422 naming it, and the old Assembly still serves", async () => {
  const { inst, echo } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/bad.ts": `export const notAMachine = 1;\n` });
    const res = await put(inst, a);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { report: string[] };
    assert.match(body.report[0]!, /has no `machine` named export/);
    assert.deepEqual(await workflowsOf(inst), ["echo"]);
    assert.equal((await json<{ hash: string }>(fetch(`${inst.url}/healthz`))).hash, echo.hash);
  } finally {
    await inst.close();
  }
});

test("an Assembly that carries a Kit package → 422 naming it (ADR-0054, ADR-0069)", async () => {
  const closure = await kitClosure();
  assert.ok(closure.has("@jr2/orchestrator") && closure.has("xstate") && closure.has("zod"), [...closure].join());
  assert.equal(closure.has("@jr2/harness"), false, "a devDependency is not in the Kit image");
  const { inst, echo } = await bootWithEcho();
  try {
    const a = await mkAssembly({
      "workflows/next.ts": machineSrc("next"),
      "node_modules/xstate/package.json": `{"name":"xstate","version":"0.0.0"}\n`,
      "node_modules/left-pad/package.json": `{"name":"left-pad","version":"1.0.0"}\n`,
    });
    const res = await put(inst, a);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { report: string[] };
    assert.equal(body.report.length, 1, body.report.join("\n"));
    assert.match(body.report[0]!, /carries node_modules\/xstate, which the Kit image provides/);
    assert.equal((await json<{ hash: string }>(fetch(`${inst.url}/healthz`))).hash, echo.hash);
  } finally {
    await inst.close();
  }
});

test("a publish lands: current flips, the Workflows swap, GET /assembly and /healthz report it", async () => {
  const { inst, dir, echo } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next"), "workflows/other.ts": machineSrc("other") });
    const res = await put(inst, a);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      hash: a.hash,
      kitVersion: KIT_VERSION,
      workflows: ["next", "other"],
      held: [{ hash: a.hash, kitVersion: KIT_VERSION, runs: [] }],
      // The Assembly that was current, which no run holds, is let go (ADR-0069, ADR-0039).
      collected: [echo.hash],
    });
    assert.equal(existsSync(join(assembliesDir(dir), echo.hash)), false);
    // The volume: the tree under its hash, its record, and the pointer.
    assert.equal((await readFile(join(assembliesDir(dir), "current"), "utf8")).trim(), a.hash);
    assert.ok(existsSync(join(assembliesDir(dir), a.hash, "workflows", "next.ts")));
    const record = JSON.parse(await readFile(join(assembliesDir(dir), `${a.hash}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(record.hash, a.hash);
    assert.deepEqual(record.workflows, ["next", "other"]);
    // The process serves the new Assembly: `echo` went, `next` and `other` came.
    assert.deepEqual((await workflowsOf(inst)).sort(), ["next", "other"]);
    assert.deepEqual(await json(fetch(`${inst.url}/assembly`)), {
      kitVersion: KIT_VERSION,
      current: { hash: a.hash, kitVersion: KIT_VERSION, workflows: ["next", "other"] },
      held: [{ hash: a.hash, kitVersion: KIT_VERSION, runs: [] }],
    });
    assert.equal((await json<{ hash: string }>(fetch(`${inst.url}/healthz`))).hash, a.hash);
    // A run started now holds the new Assembly.
    const started = await json<{ runId: string }>(
      fetch(`${inst.url}/workflows/next/runs`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${inst.instanceToken}` },
      }),
    );
    const view = await json<{ held: Array<{ runs: string[] }> }>(fetch(`${inst.url}/assembly`));
    assert.deepEqual(view.held[0]!.runs, [started.runId]);

    // The same hash again is a no-op: the door answers before it reads the body.
    const open = openBody(a.tar);
    const again = await put(inst, { tar: open.stream, hash: a.hash });
    assert.ok(open.pulls() <= 2, `the door read the body (${open.pulls()} pulls)`);
    open.end();
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { unchanged?: boolean }).unchanged, true);

    // A publish leaves the run on the Assembly it started under, and holds that Assembly: `held`
    // lists every Assembly held, the current one first, on the answer and on `GET /assembly`.
    const b = await mkAssembly({ "workflows/next.ts": machineSrc("next-b") });
    const landed = await put(inst, b);
    assert.equal(landed.status, 200);
    const held = [
      { hash: b.hash, kitVersion: KIT_VERSION, runs: [] },
      { hash: a.hash, kitVersion: KIT_VERSION, runs: [started.runId] },
    ];
    const answer = (await landed.json()) as { held: unknown; collected: unknown };
    assert.deepEqual(answer.held, held);
    assert.deepEqual(answer.collected, [], "a run holds the Assembly that was current");
    assert.deepEqual((await json<{ held: unknown[] }>(fetch(`${inst.url}/assembly`))).held, held);
  } finally {
    await inst.close();
  }

  // A restart boots from the pointer.
  const restarted = await boot(dir);
  try {
    assert.deepEqual(restarted.workflows, ["next"]);
    assert.equal(restarted.assembly?.hash, (await readFile(join(assembliesDir(dir), "current"), "utf8")).trim());
  } finally {
    await restarted.close();
  }
});

test("the door imports the Assembly once, from assemblies/<hash>, never from staging", async () => {
  const { inst, dir } = await bootWithEcho();
  const seen = globalThis as { __jr2AssemblyImports?: string[] };
  seen.__jr2AssemblyImports = [];
  try {
    const a = await mkAssembly({
      "workflows/where.ts": `(globalThis.__jr2AssemblyImports ??= []).push(import.meta.url);\n` + machineSrc("where"),
    });
    assert.equal((await put(inst, a)).status, 200);
    assert.deepEqual(seen.__jr2AssemblyImports, [
      pathToFileURL(join(assembliesDir(dir), a.hash, "workflows", "where.ts")).href,
    ]);
  } finally {
    delete seen.__jr2AssemblyImports;
    await inst.close();
  }
});

test("a tree left under the hash that no longer hashes to it is replaced, not reused", async () => {
  const { inst, dir } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    // What a power loss can leave: the directory, with its file empty.
    await mkdir(join(assembliesDir(dir), a.hash, "workflows"), { recursive: true });
    await writeFile(join(assembliesDir(dir), a.hash, "workflows", "next.ts"), "");
    const res = await put(inst, a);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await assemblyHash(join(assembliesDir(dir), a.hash)), a.hash);
    assert.deepEqual(await workflowsOf(inst), ["next"]);
  } finally {
    await inst.close();
  }
});

test("admit on a copied fixture tree writes the real layout and the real pointer", async () => {
  const dir = await scratchInstance("admit");
  const inst = await boot(dir);
  try {
    const { staging, hash } = await stageTree(dir, FIXTURE_ASSEMBLY);
    const answer = await inst.admit(staging, { hash, kitVersion: KIT_VERSION });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.workflows, ["echo"]);
    assert.equal((await readFile(join(assembliesDir(dir), "current"), "utf8")).trim(), hash);
    assert.ok(existsSync(join(assembliesDir(dir), hash, "workflows", "echo.ts")));
    assert.ok(existsSync(join(assembliesDir(dir), `${hash}.json`)));
    assert.equal(existsSync(staging), false, "the staging directory is removed");
    assert.equal(inst.assembly?.hash, hash);

    // `admit` runs the same checks as a publish: another hash is refused.
    const other = await stageTree(dir, FIXTURE_ASSEMBLY);
    const refused = await inst.admit(other.staging, { hash: "0123456789ab", kitVersion: KIT_VERSION });
    assert.equal(refused.status, 400);
    assert.equal(existsSync(other.staging), false);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one publish at a time: a second PUT while one is in flight → 409", async () => {
  const { inst, dir } = await bootWithEcho();
  try {
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    const b = await mkAssembly({ "workflows/other.ts": machineSrc("other") });
    // The first body is held open until the second has its answer.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sent = false;
    const slow = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (!sent) {
          sent = true;
          ctrl.enqueue(new Uint8Array(a.tar.subarray(0, 512)));
          return;
        }
        await gate;
        ctrl.enqueue(new Uint8Array(a.tar.subarray(512)));
        ctrl.close();
      },
    });
    const first = put(inst, { tar: slow, hash: a.hash });
    // Wait until the first has reached staging.
    const staged = async () => existsSync(assembliesDir(dir)) && (await stagingLeft(dir)).length > 0;
    for (let i = 0; i < 400 && !(await staged()); i++) await new Promise((r) => setTimeout(r, 5));
    const second = await put(inst, b);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "a publish is in flight" });
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual(await workflowsOf(inst), ["next"]);
  } finally {
    await inst.close();
  }
});

test("a .staging-* and a durable write's temp file left by a crash are ignored and removed at boot", async () => {
  const dir = await mkInstance();
  const first = await boot(dir);
  const echo = await mkAssembly({ "workflows/echo.ts": machineSrc("echo") });
  assert.equal((await put(first, echo)).status, 200);
  await first.close();
  const staging = join(assembliesDir(dir), ".staging-0123456789ab-dead");
  await mkdir(join(staging, "tree", "workflows"), { recursive: true });
  await writeFile(join(staging, "tree", "workflows", "half.ts"), machineSrc("half"));
  await writeFile(join(assembliesDir(dir), "current.tmp-deadbeef"), "0123456789ab\n");
  await writeFile(join(assembliesDir(dir), `${echo.hash}.json.tmp-0badf00d`), "{");
  const inst = await boot(dir);
  try {
    assert.deepEqual(inst.workflows, ["echo"]);
    assert.equal(existsSync(staging), false);
    assert.deepEqual(
      (await readdir(assembliesDir(dir))).filter((n) => n.includes(".tmp-")),
      [],
    );
  } finally {
    await inst.close();
  }
});

test("a pointer naming a missing tree: the boot announces why, and serves with no Workflows", async () => {
  const dir = await mkInstance();
  await mkdir(assembliesDir(dir), { recursive: true });
  await writeFile(join(assembliesDir(dir), "current"), "0123456789ab\n");
  const lines: string[] = [];
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", JR2_SIGNING_KEY: KEY.toString("base64") },
    announce: (line) => lines.push(line),
  });
  try {
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(line.assembly, null);
    assert.equal(line.kitVersion, KIT_VERSION);
    assert.equal(line.assemblyError, "current names 0123456789ab, which is not on the volume");
    assert.deepEqual(line.workflows, []);
    assert.deepEqual(await workflowsOf(inst), []);
    const view = await json<{ current: unknown }>(fetch(`${inst.url}/assembly`));
    assert.equal(view.current, null);
    assert.equal((await json<{ hash?: string }>(fetch(`${inst.url}/healthz`))).hash, undefined);
    // …and a publish from that state lands.
    const a = await mkAssembly({ "workflows/next.ts": machineSrc("next") });
    assert.equal((await put(inst, a)).status, 200);
    assert.deepEqual(await workflowsOf(inst), ["next"]);
  } finally {
    await inst.close();
  }
});

test("an Assembly published for another Kit version is not loaded, and is kept while `current` names it: the boot says why", async () => {
  const dir = await mkInstance();
  const hash = "abcdefabcdef";
  await mkdir(join(assembliesDir(dir), hash, "workflows"), { recursive: true });
  await writeFile(join(assembliesDir(dir), hash, "workflows", "old.ts"), machineSrc("old"));
  await writeFile(
    join(assembliesDir(dir), `${hash}.json`),
    JSON.stringify({ hash, kitVersion: "0.0.0-old", workflows: ["old"], publishedAt: "x" }),
  );
  await writeFile(join(assembliesDir(dir), "current"), `${hash}\n`);
  const inst = await boot(dir);
  try {
    assert.equal(inst.assembly, null);
    assert.match(inst.assemblyError ?? "", /published for Kit version 0\.0\.0-old/);
    assert.deepEqual(inst.workflows, []);
    assert.deepEqual(inst.restored, { reattached: [], lost: [], drifted: [], failed: [] });
    // `current` names it, so the collection keeps it for the image it was published for.
    assert.deepEqual(inst.collected, []);
    assert.ok(existsSync(join(assembliesDir(dir), hash)));
  } finally {
    await inst.close();
  }
});

test("the Orchestrator never loads the folder it was started in", async () => {
  // A folder that holds `workflows/` and `jr2.config.ts`, and no pointer: nothing was published,
  // so nothing serves (ADR-0069). The way in is the door.
  const dir = await mkInstance();
  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(join(dir, "workflows", "echo.ts"), machineSrc("echo"));
  await writeFile(join(dir, "jr2.config.ts"), `export default { name: "folder" };\n`);
  const inst = await boot(dir);
  try {
    assert.equal(inst.assembly, null);
    assert.equal(inst.assemblyError, undefined, "no pointer: no reason to give");
    assert.deepEqual(inst.workflows, []);
    assert.deepEqual(await json(fetch(`${inst.url}/assembly`)), { kitVersion: KIT_VERSION, current: null, held: [] });
  } finally {
    await inst.close();
  }
});

test("admitTree refuses the same way a PUT does: a walk refusal through admit → 422", async () => {
  const dir = await scratchInstance("admit");
  const inst = await boot(dir);
  try {
    const answer = await admitTree(inst, dir, { "workflows/ws.ts": openSlotSrc });
    assert.equal(answer.status, 422);
    assert.equal(existsSync(join(assembliesDir(dir), "current")), false);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an `unchanged` answer whose held read fails is still 200, naming the current Assembly alone (ADR-0069)", async (t) => {
  const dir = await mkInstance();
  const store = new SqliteSnapshotStore(":memory:");
  const live = store.liveAssemblies.bind(store);
  let broken = false;
  store.liveAssemblies = async () => {
    if (broken) throw new Error("SQLITE_BUSY");
    return live();
  };
  const logged = t.mock.method(console, "error", () => {});
  const inst = await startInstance({ dir, store, signingKey: KEY });
  try {
    const echo = await mkAssembly({ "workflows/echo.ts": machineSrc("echo") });
    assert.equal((await put(inst, echo)).status, 200);
    broken = true;
    const again = await put(inst, echo);
    assert.equal(again.status, 200);
    const body = (await again.json()) as { unchanged?: boolean; held?: unknown };
    assert.equal(body.unchanged, true);
    assert.deepEqual(body.held, [{ hash: echo.hash, kitVersion: KIT_VERSION, runs: [] }]);
    assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes("SQLITE_BUSY")));
  } finally {
    await inst.close();
  }
});

// ---- Chart files and named Charts at the door (ADR-0070) ----------------------------------------

/** An empty instance under this package, booted. */
async function bootScratch(): Promise<{ inst: RunningInstance; dir: string }> {
  const dir = await scratchInstance("asm-charts");
  return { inst: await boot(dir), dir };
}

type ChartListing = Array<{
  name: string;
  origin: string;
  unrunnable?: string;
  wrapper?: { charts: Array<{ name: string; origin: string; unrunnable?: string }> };
}>;

test("a Chart file is published with its Assembly, listed inside its wrapper as `file`, and named in the answer", async () => {
  const { inst, dir } = await bootScratch();
  try {
    const text = JSON.stringify(await reviewLoop());
    const answer = await admitTree(inst, dir, {
      "workflows/charted.ts": chartedSrc(),
      "workflows/charted/sample.chart.json": text,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.charts, undefined, "no named Chart is unrunnable, so the answer adds nothing");
    assert.ok((answer.body.workflows as string[]).includes("charted/sample"));
    const listing = await json<ChartListing>(fetch(`${inst.url}/workflows`));
    assert.deepEqual(
      listing.find((w) => w.name === "charted")?.wrapper?.charts.map((c) => [c.name, c.origin]),
      [["sample", "file"]],
    );
    assert.deepEqual(inst.charts, { files: 1, runtime: 0, unrunnable: [] });
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Chart file under a Workflow that is no Chart wrapper refuses the publish, naming the file", async () => {
  const { inst, dir } = await bootScratch();
  try {
    const answer = await admitTree(inst, dir, {
      "workflows/plain.ts": plainSrc("plain"),
      "workflows/plain/loop.chart.json": JSON.stringify(await reviewLoop()),
    });
    assert.equal(answer.status, 422);
    const report = answer.body.report as string[];
    assert.equal(report.length, 1, report.join("\n"));
    assert.match(report[0]!, /^workflows\/plain\/loop\.chart\.json: workflow "plain" is no Chart wrapper/);
    assert.equal(inst.assembly, null, "nothing landed");
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a publish that stops lending a slot refuses a Chart file that uses it, and marks a runtime Chart unrunnable, kept", async () => {
  const { inst, dir } = await bootScratch();
  try {
    const text = await reviewLoop();
    await publishTree(inst, dir, { "workflows/charted.ts": chartedSrc() });
    const put = await fetch(`${inst.url}/workflows/charted/charts/loop`, {
      method: "PUT",
      body: JSON.stringify(text),
      headers: { authorization: `Bearer ${inst.instanceToken}` },
    });
    assert.equal(put.status, 201, await put.clone().text());

    // The Chart file is the Instance's own: it refuses the publish.
    const refused = await admitTree(inst, dir, {
      "workflows/charted.ts": chartedSrc({ lendCoder: false }),
      "workflows/charted/sample.chart.json": JSON.stringify(text),
    });
    assert.equal(refused.status, 422);
    const report = refused.body.report as string[];
    assert.ok(report.length >= 1);
    assert.ok(
      report.every((l) => l.startsWith("workflows/charted/sample.chart.json: Chart refused: ")),
      report.join("\n"),
    );
    assert.match(report.join("\n"), /coder/);

    // With the file gone, the publish lands; the runtime Chart is someone else's, so it is marked.
    const landed = await admitTree(inst, dir, { "workflows/charted.ts": chartedSrc({ lendCoder: false }) });
    assert.equal(landed.status, 200, JSON.stringify(landed.body));
    const charts = landed.body.charts as { unrunnable: Array<{ name: string; reason: string }> };
    assert.equal(charts.unrunnable.length, 1);
    assert.equal(charts.unrunnable[0]!.name, "charted/loop");
    assert.match(charts.unrunnable[0]!.reason, /coder/);
    assert.ok(existsSync(join(dir, ".jr2", "charts", "charted", "loop.chart.json")), "never deleted");
    const listing = await json<ChartListing>(fetch(`${inst.url}/workflows`));
    assert.match(
      listing.find((w) => w.name === "charted")?.wrapper?.charts.find((c) => c.name === "loop")?.unrunnable ?? "",
      /coder/,
    );
    assert.ok(!inst.host.workflows().includes("charted/loop"), "no run starts it");

    // The wrapper lends `coder` again: the Chart runs again, from the volume.
    const back = await admitTree(inst, dir, { "workflows/charted.ts": chartedSrc() });
    assert.equal(back.status, 200);
    assert.equal(back.body.charts, undefined);
    assert.ok(inst.host.workflows().includes("charted/loop"));
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a publish's own answer names the Charts it left unrunnable, though a second publish starts meanwhile", async () => {
  const dir = await scratchInstance("asm-charts");
  // A second publish that starts inside the first one's `activate`, before its answer is built.
  let second: Promise<unknown> | undefined;
  let armed = false;
  const inst: RunningInstance = await startInstance({
    dir,
    store: new SqliteSnapshotStore(":memory:"),
    signingKey: KEY,
    onPublish: () => {
      if (!armed) return;
      armed = false;
      // Refused at its Kit version, before it reads the staging directory: it needs none.
      second = inst.admit(join(dir, "no-staging"), { hash: "0".repeat(12), kitVersion: "0.0.0-other" });
    },
  });
  try {
    await publishTree(inst, dir, { "workflows/charted.ts": chartedSrc() });
    const put = await fetch(`${inst.url}/workflows/charted/charts/loop`, {
      method: "PUT",
      body: JSON.stringify(await reviewLoop()),
      headers: { authorization: `Bearer ${inst.instanceToken}` },
    });
    assert.equal(put.status, 201);
    // The runtime Chart is no part of the Assembly: GET /assembly names the Assembly's own.
    const view = await json<{ current: { workflows: string[] } }>(fetch(`${inst.url}/assembly`));
    assert.deepEqual(view.current.workflows, ["charted"]);

    armed = true;
    const answer = await admitTree(inst, dir, { "workflows/charted.ts": chartedSrc({ lendCoder: false }) });
    assert.equal(((await second) as { status: number }).status, 409, "the second publish ran, and was refused");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const charts = answer.body.charts as { unrunnable: Array<{ name: string }> } | undefined;
    assert.deepEqual(
      charts?.unrunnable.map((u) => u.name),
      ["charted/loop"],
      "the first publish's answer keeps its own report",
    );
    assert.deepEqual(answer.body.workflows, ["charted"], "the answer names the Assembly's own Workflows");
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the announce line names the named Charts when any exists: files, runtime, and the unrunnable ones", async () => {
  const dir = await scratchInstance("asm-announce");
  const first = await boot(dir);
  try {
    await publishTree(first, dir, {
      "workflows/charted.ts": chartedSrc(),
      "workflows/charted/sample.chart.json": JSON.stringify(await reviewLoop()),
    });
  } finally {
    await first.close();
  }
  // A runtime Chart left on the volume whose wrapper the Assembly does not hold.
  await mkdir(join(dir, ".jr2", "charts", "gone"), { recursive: true });
  await writeFile(join(dir, ".jr2", "charts", "gone", "loop.chart.json"), JSON.stringify(await reviewLoop()));
  const lines: string[] = [];
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", JR2_SIGNING_KEY: KEY.toString("base64") },
    announce: (line) => lines.push(line),
  });
  try {
    const line = JSON.parse(lines[0]!) as { charts?: { files: number; runtime: number; unrunnable: unknown[] } };
    assert.equal(line.charts?.files, 1);
    assert.equal(line.charts?.runtime, 1);
    assert.deepEqual(
      (line.charts?.unrunnable as Array<{ name: string }>).map((u) => u.name),
      ["gone/loop"],
    );
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a docker context a registered Machine names beside its module is not named as ignored, at the door or at the boot (ADR-0037, ADR-0049, ADR-0070)", async (t) => {
  // `import.meta.resolve("./python")` in workflows/pytest.ts is workflows/python/, the folder the
  // Chart discovery also reads as a wrapper's directory. jr2 builds that folder, so jr2 reads it:
  // the door and the boot give the discovery the contexts of the Machines they loaded.
  const warned = t.mock.method(console, "warn", () => {});
  const ignored = () =>
    warned.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("workflows/python/"));
  const dir = await scratchInstance("asm-context");
  const first = await boot(dir);
  try {
    await publishTree(first, dir, {
      "workflows/pytest.ts":
        `import { setup } from ${XSTATE};\n` +
        `import { workspace } from ${INDEX};\n` +
        `const body = setup({}).createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
        `export const machine = workspace(body, {\n` +
        `  repos: { app: { url: "https://e.test/a.git" } },\n` +
        `  image: import.meta.resolve("./python"),\n` +
        `  spec: () => ({ branch: "b" }),\n` +
        `});\n`,
      "workflows/python/Dockerfile": "FROM node:24-slim\n",
      "workflows/python/requirements.txt": "pytest\n",
    });
    assert.deepEqual(ignored(), [], "the publish door");
  } finally {
    await first.close();
  }
  const second = await boot(dir);
  try {
    assert.deepEqual(second.workflows, ["pytest"], "the boot loaded the Assembly");
    assert.deepEqual(ignored(), [], "the boot");
  } finally {
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
