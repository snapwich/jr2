// The pod's guard kills (ADR-0061, ADR-0062). The guard polls from the Harness's start, so it can
// kill a process that an earlier Turn left running — a dev server, a watcher — while no Submission
// runs: the workflow waits at a Gate, or between two states. A kill while a Submission runs goes on
// that conversation's stream, but the Orchestrator reads a stream only while it waits on that
// Submission, and it stops when the Agent's state exits: a kill after that and before the abort
// lands is on a stream that no one reads. So EVERY kill is kept here, pod-scoped, with the
// conversations whose running `bash` call answered it (`told`), and `GET /memory-kills` answers the
// list. The Orchestrator reads it before it admits a Turn into the Workspace.
//
// One kill has one id: the same on every stream that carries it and here. The Orchestrator keys its
// notice on that id and keeps each id it raised in its notice ledger (`seen`, persisted with the
// run), so a kill read from a stream and again from this list is one notice, and a read again
// after a restart of either side raises nothing new. A read removes nothing, so a crash between a
// read and the save that keeps it loses nothing: the next read finds the kill. Bounded: the newest
// `KEPT_KILLS` kills. When more come between two admissions, the oldest is lost, and a newer kill tells
// the same thing.
//
// Written beside the conversations (ADR-0031), as `<root>/memory-kills.jsonl` — a file, so the
// conversation walk (`conversationDirs`, directories alone) never reads it as a conversation. A
// Sandbox Harness's root is the pod's emptyDir, so a kill outlives a restart of the Harness
// container and goes with the pod, whose loss is the Workspace's (ADR-0021). The Agent's uid can
// write the file, as it can the conversation records: what it could do there it can do to its
// own conversation.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveConversation, PodMemoryKill } from "./wire.ts";

/** How many kills the pod keeps. A guard kill is rare; a burst of them is one piece of news. */
export const KEPT_KILLS = 16;

/** The most conversations one kill's `told` holds: far more Agents than a Workspace runs, and a
 * bound on the file and on the answer of `GET /memory-kills`. */
export const MAX_TOLD = 32;

/** The file under the conversations' root. */
export const POD_KILLS_FILE = "memory-kills.jsonl";

let minted = 0;

/** A kill's id, unique for the pod's life: the time and a count, and a random tail, so a restarted
 * process that reads the same clock millisecond still mints a new id. */
export function killId(at: Date): string {
  return `k-${at.getTime().toString(36)}-${++minted}-${Math.random().toString(36).slice(2, 8)}`;
}

export class PodKills {
  readonly #kills: PodMemoryKill[];
  readonly #path: string | undefined;
  readonly #log: (line: string) => void;

  /** The pod's kills — read back from `root` when one is given, else in memory alone. */
  constructor(root: string | undefined, log: (line: string) => void = (line) => console.error(line)) {
    this.#path = root === undefined ? undefined : join(root, POD_KILLS_FILE);
    this.#log = log;
    this.#kills = this.#path === undefined ? [] : readKills(this.#path, log).slice(-KEPT_KILLS);
    // Cut to the kept kills at once, and with a torn last line gone, so the appends after this
    // start on a clean line.
    if (this.#path !== undefined && existsSync(this.#path)) this.#rewrite();
  }

  /** Keep one kill. */
  keep(kill: PodMemoryKill): void {
    this.#kills.push(kill);
    if (this.#kills.length > KEPT_KILLS) {
      this.#kills.splice(0, this.#kills.length - KEPT_KILLS);
      this.#rewrite();
    } else if (this.#path !== undefined) {
      try {
        appendFileSync(this.#path, `${JSON.stringify(kill)}\n`);
      } catch (err) {
        this.#fault(err);
      }
    }
  }

  /** A `bash` call returned this kill's verdict to its model: its conversation was told. A kill
   * the pod no longer keeps is not told again. */
  tell(id: string, owner: LiveConversation): void {
    const kill = this.#kills.find((k) => k.id === id);
    if (kill === undefined) return;
    if (kill.told.length >= MAX_TOLD) return;
    if (kill.told.some((t) => t.agent === owner.agent && t.instanceId === owner.instanceId)) return;
    kill.told.push({ agent: owner.agent, instanceId: owner.instanceId });
    this.#rewrite();
  }

  /** The kept kills, oldest first. */
  list(): PodMemoryKill[] {
    return [...this.#kills];
  }

  #rewrite(): void {
    if (this.#path === undefined) return;
    const tmp = `${this.#path}.tmp`;
    try {
      writeFileSync(tmp, this.#kills.map((kill) => `${JSON.stringify(kill)}\n`).join(""));
      renameSync(tmp, this.#path);
    } catch (err) {
      this.#fault(err);
    }
  }

  /** A write that failed keeps the kill in memory and says so. It does not end the process, as a
   * conversation record's fault does (ADR-0031): no Submission depends on the line, and a kill
   * this process still holds is answered until it restarts. */
  #fault(err: unknown): void {
    this.#log(
      `jr2 harness: cannot write ${this.#path}: ${err instanceof Error ? err.message : String(err)} — the memory kill is kept in memory alone (ADR-0061)`,
    );
  }
}

/** A size as the guard writes one (`formatBytes`: `1.9Gi`, `512Mi`), short. */
const SIZE = /^\d{1,6}(\.\d{1,3})?(Ki|Mi|Gi|Ti)$/;

/** The kills a previous process kept. A missing file is none; a line that does not parse — the
 * torn last write of a restart — is dropped, as is a kill with no id or time. The Agent's uid can
 * write the file, and `peak` and `limit` go into the next Agent's Briefing as they are: sizes that
 * are not the guard's shape are left out and said — the kill is kept, so a real one is never lost,
 * and the Orchestrator words a kill with no sizes. */
function readKills(path: string, log: (line: string) => void): PodMemoryKill[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const str = (v: unknown): v is string => typeof v === "string" && v.length <= 256;
  const size = (v: unknown): v is string => typeof v === "string" && v.length <= 16 && SIZE.test(v);
  const kills: PodMemoryKill[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let kill: Partial<PodMemoryKill>;
    try {
      kill = JSON.parse(line) as Partial<PodMemoryKill>;
    } catch {
      // A torn write: never acknowledged, so never read.
      continue;
    }
    if (!(str(kill.id) && str(kill.at))) continue;
    const sized = size(kill.peak) && size(kill.limit);
    // Absent sizes are a kill written without them — not a fault; wrong ones are.
    if (!sized && (kill.peak !== undefined || kill.limit !== undefined)) bad++;
    const told = (Array.isArray(kill.told) ? kill.told.slice(0, MAX_TOLD) : [])
      .filter((c: Partial<LiveConversation>) => str(c?.agent) && str(c?.instanceId))
      .map(({ agent, instanceId }: LiveConversation) => ({ agent, instanceId }));
    kills.push({
      id: kill.id,
      at: kill.at,
      ...(sized ? { peak: kill.peak as string, limit: kill.limit as string } : {}),
      told,
    });
  }
  if (bad > 0)
    log(
      `jr2 harness: ${path}: ${bad} memory kill(s) with sizes not in the guard's shape — kept without sizes (ADR-0062)`,
    );
  return kills;
}
