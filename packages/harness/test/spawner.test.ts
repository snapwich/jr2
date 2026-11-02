// The spawner's client (ADR-0076): the real `effector spawner`, confined by the real confiner, and
// fake spawners that break the contract. The claims: the domain cannot reach the channel; the
// domain's processes see and signal each other across calls; a frame that breaks the contract ends
// that spawner and never the Harness; a spawner that ends is started again, and what it started
// runs on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bashTool } from "../src/bash-tool.ts";
import { runIn } from "../src/children.ts";
import { Spawner, SpawnerGoneError } from "../src/spawner.ts";
import { deniedDir, testChildren } from "./support/children.ts";

const children = testChildren();

async function bash(command: string, cwd = children.env.TMPDIR!): Promise<string> {
  const first = (await bashTool({ cwd, children }).execute("call-1", { command })).content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a process of the domain cannot open the spawner's channel through /proc/<spawner>/fd/0 or fd/1", async () => {
  const pid = children.spawner.pid;
  assert.ok(pid !== undefined, "the spawner runs");
  for (const fd of [0, 1]) {
    const r = await runIn(children, ["sh", "-c", `echo '{"op":"spawn"}' > /proc/${pid}/fd/${fd}; echo "exit $?"`], {
      cwd: "/",
    });
    assert.match(r.stdout, /exit [1-9]/, `fd ${fd}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /Permission denied|No such device|Operation not permitted/, `fd ${fd}: ${r.stderr}`);
  }
  // The spawner still answers: nothing reached its channel.
  assert.equal((await runIn(children, ["echo", "still"], { cwd: "/" })).stdout, "still\n");
});

test("a later bash call finds a server that an earlier call started, reads its environ and cwd, and ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-spawner-server-"));
  const pidFile = join(dir, "server.pid");
  const started = await bash(
    `cd ${dir}; SERVER_MARK=here nohup sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}; echo started`,
  );
  assert.equal(started, "started\n");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(alive(pid), "the server runs after its call returned");
  const seen = await bash(
    `p=$(cat ${pidFile}); tr '\\0' '\\n' < /proc/$p/environ | grep '^SERVER_MARK='; readlink /proc/$p/cwd; kill $p && echo killed`,
  );
  assert.equal(seen, `SERVER_MARK=here\n${dir}\nkilled\n`);
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.ok(!alive(pid), "the later call ended it");
});

test("a spawner that ends is started again: an open call fails with a clear error, and what it started runs on", async () => {
  const domain = testChildren();
  const dir = mkdtempSync(join(tmpdir(), "jr2-spawner-restart-"));
  const pidFile = join(dir, "bg.pid");
  const r = await runIn(domain, ["sh", "-c", `sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const bg = Number(readFileSync(pidFile, "utf8").trim());
  const first = domain.spawner.pid!;
  const open = runIn(domain, ["sleep", "30"], { cwd: dir });
  await sleep(100);
  process.kill(first, "SIGKILL");
  const failed = await open;
  assert.ok(failed.error instanceof SpawnerGoneError, String(failed.error));
  assert.match(
    failed.error.message,
    /the spawner exited \(signal SIGKILL\) before the answer came; the process may still run/,
  );
  assert.ok(alive(bg), "the process the old spawner started runs on");
  const again = await runIn(domain, ["echo", "again"], { cwd: dir });
  assert.equal(again.stdout, "again\n");
  assert.notEqual(domain.spawner.pid, first, "a new spawner");
  process.kill(bg, "SIGKILL");
  domain.spawner.close();
});

/** A fake spawner: a node script that answers the first frame with `reply`, and counts its starts. */
function fake(reply: (frame: { id: string; op: string }) => string): { spawner: Spawner; starts: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "jr2-fake-spawner-"));
  const count = join(dir, "starts");
  const script = join(dir, "fake.mjs");
  writeFileSync(
    script,
    [
      `import { appendFileSync } from "node:fs";`,
      `import { createInterface } from "node:readline";`,
      `appendFileSync(${JSON.stringify(count)}, "x");`,
      `const reply = ${reply.toString()};`,
      `for await (const line of createInterface({ input: process.stdin })) process.stdout.write(reply(JSON.parse(line)));`,
    ].join("\n"),
  );
  const lines: string[] = [];
  const spawner = new Spawner({ argv: [process.execPath, script], log: (l) => lines.push(l), restartMs: 10 });
  return { spawner, starts: () => (existsSync(count) ? readFileSync(count, "utf8").length : 0) };
}

for (const [name, reply] of [
  ["a frame that is not JSON", () => "this is not json\n"],
  ["a frame that is not an object", () => "[1,2]\n"],
  ["a frame with no id", () => `{"op":"ok"}\n`],
  ["a frame for no open call", () => `{"id":"nobody","op":"ok"}\n`],
  [
    "output before its process started",
    (f: { id: string }) => `{"id":"${f.id}","op":"out","stream":"stdout","data":"aGk="}\n`,
  ],
  ["a started frame with no pid", (f: { id: string }) => `{"id":"${f.id}","op":"started","pid":"1; rm -rf /"}\n`],
  [
    "an error frame with a wrong code",
    (f: { id: string }) => `{"id":"${f.id}","op":"error","code":"<b>","message":"x"}\n`,
  ],
  ["a frame longer line by line, with no newline", () => "x".repeat(100_000)],
] as const) {
  test(`the Harness survives ${name}: the open call fails, the spawner is stopped and started again`, async () => {
    const { spawner, starts } = fake(reply as (f: { id: string; op: string }) => string);
    const call = spawner.spawn({ argv: ["echo"], env: {}, cwd: "/" });
    if (name.startsWith("a frame longer")) {
      // No newline: the frame is not over. The read answers nothing, and the spawner is closed.
      const read = spawner.read("/x");
      await sleep(200);
      spawner.close();
      await assert.rejects(read, SpawnerGoneError);
      await assert.rejects(call.exited, SpawnerGoneError);
      return;
    }
    await assert.rejects(
      call.exited,
      (err: Error) => err instanceof SpawnerGoneError && /the spawner sent/.test(err.message),
    );
    // A new call starts a new spawner, which breaks again: still no throw out of the Harness.
    await assert.rejects(spawner.stat("/"), SpawnerGoneError);
    for (let i = 0; i < 100 && starts() < 2; i++) await sleep(10);
    assert.ok(starts() >= 2, `the spawner was started again (${starts()})`);
    spawner.close();
  });
}

test("a stat answer that is not an absolute real path breaks the contract", async () => {
  const { spawner } = fake(
    (f) => `{"id":"${f.id}","op":"ok","kind":"file","size":1,"mtimeMs":1,"realpath":"relative"}\n`,
  );
  await assert.rejects(spawner.stat("/x"), /the spawner sent a stat answer with wrong fields/);
  spawner.close();
});

for (const [what, reply] of [
  ["a name with a slash", (f: { id: string }) => `{"id":"${f.id}","op":"ok","names":["ok","../../run/jr2"]}\n`],
  ["the name ..", (f: { id: string }) => `{"id":"${f.id}","op":"ok","names":[".."]}\n`],
  ["an empty name", (f: { id: string }) => `{"id":"${f.id}","op":"ok","names":[""]}\n`],
  ["a name that is not a string", (f: { id: string }) => `{"id":"${f.id}","op":"ok","names":[7]}\n`],
  ["no names", (f: { id: string }) => `{"id":"${f.id}","op":"ok"}\n`],
] as const) {
  test(`a readdir answer with ${what} breaks the contract`, async () => {
    const { spawner } = fake(reply);
    await assert.rejects(spawner.readdir("/x"), /the spawner sent a readdir answer with wrong names/);
    spawner.close();
  });
}

test("readdir and unlink run in the domain: the names under the denied folder list, and nothing there is removed (ADR-0076)", async () => {
  const denied = deniedDir("ops-denied-");
  writeFileSync(join(denied, "standin"), "a Stand-in");
  const domain = testChildren({ deny: [denied] });
  assert.deepEqual(await domain.spawner.readdir(denied), ["standin"]);
  await assert.rejects(domain.spawner.unlink(join(denied, "standin")), { code: "EACCES", syscall: "unlink" });
  assert.equal(readFileSync(join(denied, "standin"), "utf8"), "a Stand-in");
  const dir = mkdtempSync(join(tmpdir(), "jr2-spawner-ops-"));
  writeFileSync(join(dir, "b"), "");
  writeFileSync(join(dir, "a"), "");
  assert.deepEqual(await domain.spawner.readdir(dir), ["a", "b"]);
  await domain.spawner.unlink(join(dir, "a"));
  assert.deepEqual(await domain.spawner.readdir(dir), ["b"]);
  await assert.rejects(domain.spawner.unlink(dir), { code: "EISDIR" });
  await assert.rejects(domain.spawner.readdir(join(dir, "none")), { code: "ENOENT" });
  domain.spawner.close();
});

test("an answer of the right shape is taken", async () => {
  const { spawner } = fake((f) => `{"id":"${f.id}","op":"ok","data":"aGVsbG8="}\n`);
  assert.equal((await spawner.read("/x")).toString(), "hello");
  spawner.close();
});

test("/dev/shm is emptied in the domain: a link there to a denied folder empties nothing in it (ADR-0076)", async () => {
  const { clearShmInDomain } = await import("../src/memory-guard.ts");
  const { mkdirSync, readdirSync, symlinkSync } = await import("node:fs");
  const denied = deniedDir("shm-denied-");
  writeFileSync(join(denied, "record.json"), "a conversation");
  const domain = testChildren({ deny: [denied] });
  const shm = mkdtempSync(join(tmpdir(), "jr2-shm-"));
  mkdirSync(join(shm, "sem.d"));
  writeFileSync(join(shm, "sem.d", "x"), "x");
  writeFileSync(join(shm, "y"), "y");
  symlinkSync(denied, join(shm, "to-denied"));
  await clearShmInDomain(domain, shm);
  assert.deepEqual(readdirSync(shm), []);
  assert.equal(readFileSync(join(denied, "record.json"), "utf8"), "a conversation");
  domain.spawner.close();
});
