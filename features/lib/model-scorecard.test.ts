// The @model tier's scorecard and usage ledger (ADR-0066), pinned without a cluster or a model: a
// cell's usage summed over its trials, the scorecard merged under its lock by more than one
// process with no cell lost and no half-written file read, the lock's stale-owner rule, and the
// month's cost read off the ledger.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  appendUsage,
  cellUsage,
  dollars,
  mergeCell,
  monthToDate,
  staleOwner,
  withLock,
  type Cell,
  type Scorecard,
} from "./model-scorecard.ts";

const exec = promisify(execFile);
const SCORECARD_MODULE = fileURLToPath(new URL("./model-scorecard.ts", import.meta.url));

const cell = (passed: number): Cell => ({ passed, trials: 10, at: "2026-10-25T00:00:00.000Z" });

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "model-scorecard-"));
}

test("a cell's usage is the sum over its trials, and says how many trials had none to read", () => {
  const a = { input: 100, output: 20, cacheRead: 60, cacheWrite: 0, cost: 0.25 };
  const b = { input: 50, output: 30, cacheRead: 90, cacheWrite: 10, cost: 0.5 };
  assert.deepEqual(cellUsage([a, b]), { input: 150, output: 50, cacheRead: 150, cacheWrite: 10, cost: 0.75 });
  assert.deepEqual(cellUsage([a, undefined, undefined]), { ...a, unavailable: 2 });
  assert.deepEqual(cellUsage([undefined]), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    unavailable: 1,
  });
});

test("merging cells keeps every model's and every cell's, and leaves no temp file or lock", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "nested", "model-scorecard.json");
    await mergeCell(path, "m1", "obedience/off", cell(9));
    await mergeCell(path, "m1", "advised/off", cell(8));
    await mergeCell(path, "m2", "obedience/off", cell(7));
    await mergeCell(path, "m1", "obedience/off", cell(10)); // a cell run again replaces its own
    const card = JSON.parse(await readFile(path, "utf8")) as Scorecard;
    assert.deepEqual(Object.keys(card).sort(), ["m1", "m2"]);
    assert.equal(card.m1!["obedience/off"]!.passed, 10);
    assert.equal(card.m1!["advised/off"]!.passed, 8);
    assert.equal(card.m2!["obedience/off"]!.passed, 7);
    assert.deepEqual(await readdir(join(dir, "nested")), ["model-scorecard.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two worker processes merging at once lose no cell, and every read parses", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "model-scorecard.json");
    const worker = (name: string) =>
      exec(process.execPath, [
        "--input-type=module",
        "-e",
        `const { mergeCell } = await import(${JSON.stringify(SCORECARD_MODULE)});
         await Promise.all(Array.from({ length: 15 }, (_, i) =>
           mergeCell(${JSON.stringify(path)}, ${JSON.stringify(name)}, "cell-" + i, { passed: i, trials: 15, at: "t" })));`,
      ]);
    // A reader beside the writers: a half-written scorecard would throw here.
    let reading = true;
    let reads = 0;
    const reader = (async () => {
      while (reading) {
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text !== undefined) {
          JSON.parse(text);
          reads++;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await Promise.all([worker("w1"), worker("w2")]);
    reading = false;
    await reader;
    const card = JSON.parse(await readFile(path, "utf8")) as Scorecard;
    assert.equal(Object.keys(card.w1 ?? {}).length, 15);
    assert.equal(Object.keys(card.w2 ?? {}).length, 15);
    assert.ok(reads > 0, "the reader saw the scorecard");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scorecard that does not parse is moved aside, and the merge writes a new one", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "model-scorecard.json");
    await writeFile(path, '{"m1": {"obedience/off": ');
    const movedTo = await mergeCell(path, "m1", "advised/off", cell(8));
    assert.ok(movedTo?.startsWith(`${path}.unreadable-`), String(movedTo));
    assert.equal(await readFile(movedTo!, "utf8"), '{"m1": {"obedience/off": ');
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { m1: { "advised/off": cell(8) } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock's owner is stale when its process is gone or the lock is too old; a lock with no owner yet only by its age", () => {
  const now = Date.now();
  assert.equal(staleOwner(`${process.pid} ${now} n\n`, now, now), false, "a live owner, just now");
  assert.equal(staleOwner(`${process.pid} ${now - 60_000} n\n`, now, now, 30_000), true, "a live owner, too long");
  assert.equal(staleOwner(`2147483646 ${now} n\n`, now, now), true, "an owner that is gone");
  assert.equal(staleOwner("", now - 1_000, now, 30_000), false, "an owner between its open and its write");
  assert.equal(staleOwner("", now - 60_000, now, 30_000), true, "an empty lock left long ago");
});

test("a stale lock is taken; a live one is waited for, and the wait ends with an error", async () => {
  const dir = await scratch();
  try {
    const lock = join(dir, "x.lock");
    await writeFile(lock, `2147483646 ${Date.now()} gone\n`);
    assert.equal(await withLock(lock, async () => "ran"), "ran");
    await assert.rejects(readFile(lock), { code: "ENOENT" }, "the lock is released");

    await writeFile(lock, `${process.pid} ${Date.now()} held\n`);
    await assert.rejects(
      withLock(lock, async () => "ran", { waitMs: 100 }),
      /was not had in time/,
    );
    assert.match(await readFile(lock, "utf8"), /held/, "a live owner's lock is left as it was");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the month to date sums the cost of this UTC month's ledger lines, and a torn line adds nothing", async () => {
  const dir = await scratch();
  try {
    const path = join(dir, "model-usage.jsonl");
    const usage = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost });
    await appendUsage(path, { at: "2026-09-30T23:59:59.000Z", model: "m", cell: "a/off", usage: usage(5) });
    await appendUsage(path, { at: "2026-10-01T00:00:00.000Z", model: "m", cell: "a/off", usage: usage(0.25) });
    await appendUsage(path, { at: "2026-10-25T12:00:00.000Z", model: "n", cell: "b/on", usage: usage(0.5) });
    const ledger = `${await readFile(path, "utf8")}{"at":"2026-10-25T13:00:00.000Z","usage":{"co\n`;
    assert.equal(ledger.split("\n").filter(Boolean).length, 4, "one line per cell, and the torn one");
    assert.equal(monthToDate(ledger, new Date("2026-10-31T23:00:00.000Z")), 0.75);
    assert.equal(monthToDate(ledger, new Date("2026-09-15T00:00:00.000Z")), 5);
    assert.equal(dollars(0.75), "$0.7500");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
