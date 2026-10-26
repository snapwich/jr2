// The @model tier's scorecard and usage ledger (ADR-0066), written safely when more than one
// cucumber worker PROCESS records a cell at once. Socket-free, so a unit test pins each piece.
//
// The scorecard is one JSON file that every cell is merged into: a write takes a lock file
// (`O_EXCL`), reads, merges, writes a temp file and renames it over the scorecard, and releases.
// So no cell is lost to another worker's write, and a reader never sees a half-written file. The
// usage ledger is JSON lines, one small `O_APPEND` write per cell, so it needs no lock.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { addUsage, NO_USAGE, type Usage } from "./model-evidence.ts";

/** A cell's usage: the sum over its trials that had one, and how many trials had none to read. */
export type CellUsage = Usage & { unavailable?: number };

/** A cell's usage from each trial's (`undefined` when a trial's usage could not be read). */
export function cellUsage(spent: ReadonlyArray<Usage | undefined>): CellUsage {
  const read = spent.filter((u): u is Usage => u !== undefined);
  const unavailable = spent.length - read.length;
  return { ...read.reduce(addUsage, NO_USAGE), ...(unavailable > 0 ? { unavailable } : {}) };
}

export type Cell = { passed: number; trials: number; floor?: number; usage?: CellUsage; at: string };
export type Scorecard = Record<string, Record<string, Cell>>;

/** How long a lock may be held before another process takes it, whoever holds it, and how long a
 * writer waits for one. A merge holds it for milliseconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 25;

/** Whether the process `pid` lives on this host. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock file's owner is stale when its process is gone or the lock is older than `staleMs`. A lock
 * with no owner written yet is a process between its `open` and its write: stale only once the
 * file (`mtimeMs`) is older than `staleMs`, so a live owner's lock is never taken in that moment.
 */
export function staleOwner(content: string, mtimeMs: number, now: number, staleMs = LOCK_STALE_MS): boolean {
  const [pid, at] = content.trim().split(" ");
  const owner = Number(pid);
  const since = Number(at);
  if (!Number.isInteger(owner) || owner <= 0 || !Number.isFinite(since)) return now - mtimeMs > staleMs;
  return !alive(owner) || now - since > staleMs;
}

/**
 * Run `fn` while holding the lock file `lock`: created with `O_EXCL`, so one process holds it at a
 * time. Its content is `<pid> <ms> <nonce>`. A lock whose owner is stale (`staleOwner`) is removed
 * and taken; the content is read again just before the removal, so a lock another process took in
 * the meantime is left alone. Throws when no lock is had within `waitMs`.
 */
export async function withLock<T>(
  lock: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  const mine = `${process.pid} ${Date.now()} ${randomBytes(6).toString("hex")}\n`;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(mine);
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const held = await readFile(lock, "utf8").catch(() => undefined);
    const mtimeMs = (await stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now();
    if (held !== undefined && staleOwner(held, mtimeMs, Date.now(), opts.staleMs)) {
      if ((await readFile(lock, "utf8").catch(() => undefined)) === held) await unlink(lock).catch(() => {});
      continue;
    }
    if (Date.now() > deadline) throw new Error(`the lock ${lock} was not had in time (held by ${held?.trim()})`);
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => undefined)) === mine) await unlink(lock).catch(() => {});
  }
}

/** Read a scorecard: `{}` when there is none. One that does not parse is moved aside (`.unreadable`)
 * and read as `{}`, so the next write cannot fail on it; the answer names where it went. */
async function readCard(path: string): Promise<{ card: Scorecard; movedTo?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { card: {} };
    throw err;
  }
  try {
    const card = JSON.parse(text) as unknown;
    if (typeof card === "object" && card !== null && !Array.isArray(card)) return { card: card as Scorecard };
  } catch {
    // moved aside below
  }
  const movedTo = `${path}.unreadable-${Date.now()}`;
  await rename(path, movedTo);
  return { card: {}, movedTo };
}

/**
 * Merge one cell into the scorecard at `path` under its lock: read, set `card[model][cell]`, write a
 * temp file beside it, and rename it over the scorecard. Answers where an unreadable scorecard was
 * moved, when one was.
 */
export async function mergeCell(path: string, model: string, cell: string, value: Cell): Promise<string | undefined> {
  await mkdir(dirname(path), { recursive: true });
  return withLock(`${path}.lock`, async () => {
    const { card, movedTo } = await readCard(path);
    (card[model] ??= {})[cell] = value;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(card, null, 2)}\n`);
    await rename(temp, path);
    return movedTo;
  });
}

/** One line of the usage ledger (`model-usage.jsonl`): a cell's usage when it was recorded. */
export type UsageLine = { at: string; model: string; cell: string; usage: CellUsage };

/** Append one line to the usage ledger: one `O_APPEND` write, so lines from two processes never mix. */
export async function appendUsage(path: string, line: UsageLine): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, { flag: "a" });
}

/** The cost of every ledger line in the UTC calendar month of `now`. A line that does not parse,
 * or has no cost, adds nothing. */
export function monthToDate(ledger: string, now: Date): number {
  const month = now.toISOString().slice(0, 7);
  let sum = 0;
  for (const raw of ledger.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as Partial<UsageLine>;
      const cost = line.usage?.cost;
      if (typeof line.at === "string" && line.at.startsWith(month) && typeof cost === "number" && Number.isFinite(cost))
        sum += cost;
    } catch {
      // a torn or foreign line adds nothing
    }
  }
  return sum;
}

/** A cost in US dollars as the usage line prints it. */
export const dollars = (cost: number): string => `$${cost.toFixed(4)}`;
