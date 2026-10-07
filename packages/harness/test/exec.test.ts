// The exec (ADR-0067): a `command` Effect runs here, in the Harness container, as a child of the
// Harness process — so as the Agent's user, with the same Stand-ins — and never through a shell.
// Real processes, no sockets: `Execs` directly, then the routes through `app.request()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Execs } from "../src/exec.ts";
import { harnessApp } from "../src/app.ts";
import type { ExecRead } from "../src/wire.ts";

const node = process.execPath;

/** Read until settled, as the Orchestrator does: long-polls from offset 0, the stream collected. */
async function settled(execs: Execs, id: string): Promise<{ read: ExecRead; stream: string }> {
  let offset = 0;
  let stream = "";
  for (;;) {
    const read = await execs.read(id, { offset, waitMs: 1_000 });
    assert.ok(read, `exec ${id} is known`);
    stream += read.stream;
    offset = read.next;
    if (read.state === "settled") return { read, stream };
  }
}

test("argv is never shell text: a metacharacter stays inside its one argument", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const marker = join(dir, "pwned");
  const arg = `x; touch ${marker} && echo $(id) | cat`;
  execs.start("e1", {
    argv: [node, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", arg],
    timeoutMs: 10_000,
    tail: 4096,
  });
  const { read } = await settled(execs, "e1");
  assert.equal(read.output?.outcome, "exited");
  assert.deepEqual(JSON.parse(read.output!.tail), [arg], "one argument, byte for byte");
  assert.equal(existsSync(marker), false, "nothing interpreted it");
});

test("the exit code is the output; the tail is bounded and the full stream is read in order", async () => {
  const execs = new Execs();
  execs.start("e2", {
    argv: [node, "-e", "for (let i = 0; i < 50; i++) console.log('line ' + i); console.error('err'); process.exit(3)"],
    timeoutMs: 10_000,
    tail: 20,
  });
  const { read, stream } = await settled(execs, "e2");
  assert.deepEqual(read.output && { outcome: read.output.outcome, code: (read.output as { code?: number }).code }, {
    outcome: "exited",
    code: 3,
  });
  assert.ok(read.output!.tail.length <= 20, "the tail is bounded");
  assert.ok(read.output!.tail.endsWith("err\n"), "and is the end of the stream");
  assert.match(stream, /^line 0\n/);
  assert.match(stream, /line 49\n/);
  assert.match(stream, /err\n$/);
});

test("a command not found is output, exit 127 — an Agent's param can cause it", async () => {
  const execs = new Execs();
  execs.start("e3", { argv: ["jr2-no-such-program"], timeoutMs: 5_000, tail: 4096 });
  const { read } = await settled(execs, "e3");
  assert.equal(read.output?.outcome, "exited");
  assert.equal((read.output as { code: number }).code, 127);
  assert.match(read.output!.tail, /jr2-no-such-program/);
});

test("the timeout kills the process group, children included", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const pidFile = join(dir, "child.pid");
  // The top process starts a grandchild that would outlive it, then waits.
  const script = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  execs.start("e4", { argv: [node, "-e", script], timeoutMs: 300, tail: 4096 });
  const { read } = await settled(execs, "e4");
  assert.equal(read.output?.outcome, "timeout");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await sleep(50);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the grandchild is gone too");
});

test("kill ends the group and settles `killed`", async () => {
  const execs = new Execs();
  execs.start("e5", { argv: [node, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 60_000, tail: 4096 });
  await sleep(50);
  assert.equal(execs.kill("e5"), true);
  const { read } = await settled(execs, "e5");
  assert.deepEqual(read.output, { outcome: "killed", signal: "SIGKILL", tail: "" });
  assert.equal(execs.kill("e5"), false, "already settled: nothing to kill");
});

test("its top process exits: the group ends with it, a grandchild included", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const pidFile = join(dir, "child.pid");
  // The top process starts a grandchild that would outlive it, detached from its pipes, and exits.
  const script = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    "c.unref();",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
  ].join("\n");
  execs.start("e5b", { argv: [node, "-e", script], timeoutMs: 60_000, tail: 4096 });
  const { read } = await settled(execs, "e5b");
  assert.deepEqual(read.output, { outcome: "exited", code: 0, tail: "" });
  const pid = Number(readFileSync(pidFile, "utf8"));
  await sleep(50);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the grandchild did not outlive the exec");
});

test("a kill that arrives before its start: the start runs nothing (D1 holds a fast exit)", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const marker = join(dir, "ran");
  assert.equal(execs.kill("e5c"), true, "kept: this kill keeps it from running");
  const argv = [node, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  assert.equal(execs.start("e5c", { argv, timeoutMs: 5_000, tail: 100 }), "exists");
  const { read, stream } = await settled(execs, "e5c");
  assert.deepEqual(read.output, { outcome: "killed", signal: "SIGKILL", tail: "" });
  assert.match(stream, /killed before it started; nothing ran/);
  await sleep(100);
  assert.equal(existsSync(marker), false, "nothing ran");
});

test("one id runs once: a second start of the same id runs nothing", async () => {
  const execs = new Execs();
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const count = join(dir, "count");
  const argv = [node, "-e", `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'x')`];
  assert.equal(execs.start("e6", { argv, timeoutMs: 5_000, tail: 10 }), "started");
  assert.equal(execs.start("e6", { argv, timeoutMs: 5_000, tail: 10 }), "exists");
  await settled(execs, "e6");
  assert.equal(execs.start("e6", { argv, timeoutMs: 5_000, tail: 10 }), "exists", "settled, still known");
  assert.equal(readFileSync(count, "utf8"), "x");
});

test("a read with no offset starts at the end: a re-attach reads only what comes next", async () => {
  const execs = new Execs();
  execs.start("e7", {
    argv: [node, "-e", "console.log('before'); setTimeout(() => console.log('after'), 200)"],
    timeoutMs: 5_000,
    tail: 4096,
  });
  await sleep(100);
  const first = await execs.read("e7", { waitMs: 0 });
  assert.equal(first?.stream, "");
  let offset = first!.next;
  let stream = "";
  for (;;) {
    const read = (await execs.read("e7", { offset, waitMs: 1_000 }))!;
    stream += read.stream;
    offset = read.next;
    if (read.state === "settled") break;
  }
  assert.equal(stream, "after\n");
});

test("the child inherits the Harness's environment — the Agent's Stand-ins — and its cwd is the one asked", async () => {
  const execs = new Execs({ env: { ...process.env, JR2_SANDBOX_TOKEN: "stand-in" } });
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  execs.start("e8", {
    argv: [node, "-e", "process.stdout.write(process.env.JR2_SANDBOX_TOKEN + ' ' + process.cwd())"],
    cwd: dir,
    timeoutMs: 5_000,
    tail: 4096,
  });
  const { read } = await settled(execs, "e8");
  assert.equal(read.output?.tail, `stand-in ${dir}`);
});

test("forget drops a settled exec; a running one is not forgotten", async () => {
  const execs = new Execs();
  execs.start("e9", { argv: [node, "-e", "setTimeout(() => {}, 200)"], timeoutMs: 5_000, tail: 10 });
  assert.equal(execs.forget("e9"), false, "running");
  await settled(execs, "e9");
  assert.equal(execs.forget("e9"), true);
  assert.equal(await execs.read("e9", { waitMs: 0 }), undefined);
});

// ---- the routes -------------------------------------------------------------------------------

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});

test("the routes: start, read, kill, forget — and a relative cwd or a shell string is refused", async () => {
  const app = harnessApp({
    checkBearer: () => true,
    runSubmissionFor: () => async () => {},
    execs: new Execs(),
  });
  const bad = await app.request("/exec/r1", json("POST", { argv: "echo hi", timeoutMs: 1000, tail: 10 }));
  assert.equal(bad.status, 400, "argv is a list, never shell text");
  const relative = await app.request(
    "/exec/r1",
    json("POST", { argv: ["true"], cwd: "work", timeoutMs: 1000, tail: 10 }),
  );
  assert.equal(relative.status, 400);

  const started = await app.request(
    "/exec/r1",
    json("POST", { argv: [node, "-e", "console.log('hi')"], timeoutMs: 5_000, tail: 100 }),
  );
  assert.equal(started.status, 201);
  const again = await app.request("/exec/r1", json("POST", { argv: ["true"], timeoutMs: 1000, tail: 10 }));
  assert.equal(again.status, 200, "the same id: nothing runs again");

  let read: ExecRead;
  let offset = 0;
  let stream = "";
  do {
    const res = await app.request(`/exec/r1?offset=${offset}&live=long-poll`);
    assert.equal(res.status, 200);
    read = (await res.json()) as ExecRead;
    stream += read.stream;
    offset = read.next;
  } while (read.state !== "settled");
  assert.deepEqual(read.output, { outcome: "exited", code: 0, tail: "hi\n" });
  assert.equal(stream, "hi\n");

  assert.equal((await app.request("/exec/r1", json("DELETE"))).status, 204);
  assert.equal((await app.request("/exec/r1")).status, 404, "forgotten: unknown");
  // A kill is never 404: an id not seen yet is killed before its start, and that start runs nothing.
  const early = await app.request("/exec/r2/kill", json("POST"));
  assert.equal(early.status, 200);
  assert.deepEqual(await early.json(), { killed: true });
  const late = await app.request("/exec/r2", json("POST", { argv: ["true"], timeoutMs: 1000, tail: 10 }));
  assert.equal(late.status, 200, "known: the late start runs nothing");
});

test("the routes are gated on the bearer, like every other (ADR-0058)", async () => {
  const app = harnessApp({ checkBearer: () => false, runSubmissionFor: () => async () => {}, execs: new Execs() });
  assert.equal((await app.request("/exec/r1")).status, 401);
});

test("the Instance Harness holds no Workspace and refuses every exec route (ADR-0031)", async () => {
  const app = harnessApp({
    checkBearer: () => true,
    runSubmissionFor: () => async () => {},
    execs: new Execs(),
    menuOnly: true,
  });
  const dir = mkdtempSync(join(tmpdir(), "jr2-exec-"));
  const marker = join(dir, "ran");
  const argv = [node, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  const start = await app.request("/exec/i1", json("POST", { argv, timeoutMs: 5_000, tail: 10 }));
  assert.equal(start.status, 403);
  assert.match(((await start.json()) as { error: string }).error, /Instance Harness/);
  assert.equal((await app.request("/exec/i1")).status, 403);
  assert.equal((await app.request("/exec/i1/kill", json("POST"))).status, 403);
  assert.equal((await app.request("/exec/i1", json("DELETE"))).status, 403);
  await sleep(100);
  assert.equal(existsSync(marker), false, "nothing ran");
});

test("a Harness with no exec answers 501", async () => {
  const app = harnessApp({ checkBearer: () => true, runSubmissionFor: () => async () => {} });
  const res = await app.request("/exec/r1", json("POST", { argv: ["true"], timeoutMs: 1000, tail: 10 }));
  assert.equal(res.status, 501);
});
