// The Harness's output folder (ADR-0076, `output-folder.ts`): each `bash` call prunes it when it
// ends, oldest first, down to the bound, and keeps the newest file and the files of calls in flight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputFolder } from "../src/output-folder.ts";
import { pruning } from "../src/working-tools.ts";

/** A file of `size` bytes, last changed `ageMs` ago. */
function file(dir: string, name: string, size: number, ageMs: number): void {
  writeFileSync(join(dir, name), Buffer.alloc(size));
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(join(dir, name), at, at);
}

test("a call that ends removes the oldest files over the bound, and keeps the newest file even when it is over", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-output-"));
  file(dir, "pi-bash-a.log", 400, 40_000);
  file(dir, "pi-bash-b.log", 400, 30_000);
  file(dir, "pi-bash-c.log", 400, 20_000);
  const folder = new OutputFolder(dir, 1000);
  folder.call()();
  assert.deepEqual(readdirSync(dir).sort(), ["pi-bash-b.log", "pi-bash-c.log"]);
  file(dir, "pi-bash-d.log", 5000, 10_000);
  folder.prune();
  assert.deepEqual(readdirSync(dir).sort(), ["pi-bash-d.log"], "the newest stays, though it is over the bound");
});

test("a file that a call in flight can still use is not removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-output-"));
  file(dir, "old.log", 400, 60_000);
  const folder = new OutputFolder(dir, 100);
  const long = folder.call(); // started now: a file changed from now on can be its
  file(dir, "long-call.log", 400, -5_000);
  file(dir, "short-call.log", 400, -10_000);
  folder.call()();
  assert.deepEqual(readdirSync(dir).sort(), ["long-call.log", "short-call.log"]);
  long();
  assert.deepEqual(readdirSync(dir).sort(), ["short-call.log"]);
});

test("pruning wraps bash: the folder is pruned after the call, also after a call that throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-output-"));
  const folder = new OutputFolder(dir, 0);
  const calls: string[] = [];
  const bash = pruning(
    {
      name: "bash",
      description: "",
      parameters: {} as never,
      execute: async (_id, params) => {
        const n = (params as { n: number }).n;
        file(dir, `${String(n)}.log`, 10, n === 1 ? 2_000 : 0);
        calls.push("ran");
        if ((params as { n: number }).n === 2) throw new Error("exit 1");
        return { content: [] };
      },
    },
    folder,
  );
  file(dir, "0.log", 10, 60_000);
  await bash.execute("1", { n: 1 } as never);
  assert.deepEqual(readdirSync(dir), ["1.log"]);
  await assert.rejects(bash.execute("2", { n: 2 } as never), /exit 1/);
  assert.deepEqual(readdirSync(dir), ["2.log"]);
  assert.equal(calls.length, 2);
});
