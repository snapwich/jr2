// The cut behind the REAL `jr2-upload-pack` program (ADR-0053), built from
// the operator module, on a real ext:: url, with a stand-in Custodian that answers as the Orchestrator
// does. Measures N cuts with the remote down: `JR2_CUT_MEASURE=1` for the real 60 s budget.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { cut, type CutAnswer, type CutRequest } from "../src/cut.ts";

const LOCK = ["flock", "-x", "0"];
const here = fileURLToPath(new URL(".", import.meta.url));
const operator = resolve(here, "../../../operator");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

let program: string | undefined;
function uploadPack(): string {
  if (program) return program;
  program = join(mkdtempSync(join(tmpdir(), "cut-bin-")), "jr2-upload-pack");
  execFileSync("go", ["build", "-o", program, "./cmd/jr2-upload-pack"], { cwd: operator, stdio: "ignore" });
  return program;
}

type Custodian = { url: string; asks: () => number; down: (ms: number) => void; up: () => void; close: () => void };

/** The Custodian's `POST /fetch`: `fetched`, or after the budget `stale`, as the route answers. */
function custodian(): Promise<Custodian> {
  let asks = 0;
  let budget: number | undefined;
  const server: Server = createServer((req, res) => {
    asks++;
    req.resume();
    const answer = () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          budget === undefined
            ? { fetched: new Date().toISOString() }
            : { stale: "fatal: could not read from remote repository", asOf: "2026-10-31T00:00:00Z" },
        ),
      );
    };
    setTimeout(answer, budget ?? 0);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        asks: () => asks,
        down: (ms) => (budget = ms),
        up: () => (budget = undefined),
        close: () => server.close(),
      }),
    ),
  );
}

async function world(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cut-ext-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "first");
  git(seed, "branch", "existing");
  const cache = join(dir, "cache.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, cache]);
  const workRoot = join(dir, "work");
  mkdirSync(join(workRoot, "app"), { recursive: true });
  const clone = join(workRoot, "app", "default");
  execFileSync("git", ["clone", "-q", "--shared", cache, clone]);
  const c = await custodian();
  t.after(() => c.close());
  git(clone, "remote", "set-url", "origin", `ext::${uploadPack()} %S example.test/app ${c.url}`);
  git(clone, "config", "protocol.ext.allow", "user");
  let ids = 0;
  const paths = { workRoot, lock: LOCK, env: { PATH: process.env.PATH } };
  const go = (req: Omit<CutRequest, "id">, staleWindowMs?: number) =>
    cut(
      { id: `e${++ids}`, base: "main", ...req },
      { ...paths, ...(staleWindowMs !== undefined ? { staleWindowMs } : {}) },
    );
  return { dir, workRoot, seed, cache, clone, c, go, path: (n: string) => join(workRoot, "app", n) };
}

const ready = (a: CutAnswer) => {
  assert.equal(a.outcome, "ready", JSON.stringify(a));
  return a as Extract<CutAnswer, { outcome: "ready" }>;
};

test("the real program, the remote up: no `stale`, and a fresh branch of the remote resolves", async (t) => {
  const w = await world(t);
  git(w.seed, "branch", "late");
  git(w.cache, "fetch", "-q", w.seed, "+refs/heads/*:refs/heads/*");
  assert.equal(ready(await w.go({ path: w.path("a"), branch: "late" })).found, "remote");
  const b = ready(await w.go({ path: w.path("b"), branch: "fresh" }));
  assert.equal(b.found, "none");
  assert.equal(b.stale, undefined);
});

test("the real program, the remote down: exit 0, and a warning: `stale`, never `none`", async (t) => {
  const w = await world(t);
  w.c.down(10);
  const a = ready(await w.go({ path: w.path("a"), branch: "existing" }));
  assert.equal(a.found, "remote");
  assert.match(a.stale ?? "", /could not read from remote repository.*as of 2026-10-31/);
  const b = await w.go({ path: w.path("b"), branch: "fresh" });
  assert.equal(b.outcome, "refused");
  assert.match((b as { reason: string }).reason, /may exist there/);
});

test("the custodian gone: the program warns, and it is `stale`, not a failure", async (t) => {
  const w = await world(t);
  w.c.close();
  git(w.clone, "remote", "set-url", "origin", `ext::${program} %S example.test/app http://127.0.0.1:9`);
  const a = ready(await w.go({ path: w.path("a"), branch: "existing" }));
  assert.ok(a.stale);
});

test("N cuts with the remote down: under the lock, the budget is paid once in the window", async (t) => {
  const measure = process.env.JR2_CUT_MEASURE === "1";
  const budget = measure ? 60_000 : 1_500;
  const n = 12;
  const w = await world(t);
  for (let i = 0; i < n; i++) git(w.clone, "branch", `k${i}`, "origin/main");
  w.c.down(budget);
  const at = performance.now();
  const answers = await Promise.all(
    Array.from({ length: n }, (_, i) => w.go({ path: w.path(`k${i}`), branch: `k${i}` })),
  );
  const memo = performance.now() - at;
  for (const a of answers) assert.ok(ready(a).stale);
  assert.equal(w.c.asks(), 2);
  console.log(`N=${n}, budget ${budget} ms, one memo: ${memo} ms for all, ${w.c.asks()} asks`);
  assert.ok(memo < 2 * budget + 8_000, `${memo} ms`);
});

test("with no memo, N cuts pay N budgets: why the memo is there", { timeout: 120_000 }, async (t) => {
  const budget = 300;
  const n = 6;
  const w = await world(t);
  for (let i = 0; i < n; i++) git(w.clone, "branch", `k${i}`, "origin/main");
  w.c.down(budget);
  const at = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => w.go({ path: w.path(`k${i}`), branch: `k${i}` }, 0)));
  const none = performance.now() - at;
  console.log(`N=${n}, budget ${budget} ms, no memo: ${none} ms, ${w.c.asks()} asks`);
  assert.equal(w.c.asks(), 2 * n);
  assert.ok(none >= 2 * n * budget);
});
