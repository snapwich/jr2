// The kept conversation (ADR-0023): the Harness sends each conversation's entries to the
// Orchestrator while the Turn runs, so the conversation outlives the pod. An entry is one body of
// the print (printer.ts) — the same cut, so never a Working tool's result — with its label as `kind`
// and the rest as `text`. The print to stdout stays; this is a second reader of the same lines.
//
// Each entry is written locally first, in the conversation's record folder, and then sent in
// batches: when the Turn's model answers (before its picks run), at the Turn's end, on a short
// timer, and when the Harness drains. A send never blocks a Turn: `add` only appends a line and
// queues it, and the batches go on their own. A batch that fails stays and goes with the next one,
// later each time. The Orchestrator keeps each `seq` of a conversation once, so a batch sent again
// (after a failure, a timeout or a restart) adds nothing. If the pod dies, what is lost is at most
// what was not sent yet: the record folder of a Sandbox goes with its pod.
//
//   <conversation dir>/record/entries.jsonl   one entry per line, as sent
//   <conversation dir>/record/keep.json       { sent, slot }: the last seq the Orchestrator took,
//                                              and the slot the batches state (ADR-0076)

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { cutTornTail, type RecordFault } from "./record.ts";
import { SLOT_HEADER, type MenuReach } from "./menu.ts";

/** One entry, as the Harness sends it. The Orchestrator adds the Agent, from its ledger. */
export type KeptEntry = { id: string; seq: number; at: string; kind: string; text: string };

/** What a send came to: the Orchestrator took the batch, it asks for it again later (a failure, a
 * busy or restarting Orchestrator, a run that has not ledgered the conversation yet), it refused it
 * for good (a token that cannot write it, a run it does not know), or it keeps no more of this
 * conversation (`cut`: its cap, or a full volume). */
export type KeepAnswer = "kept" | "again" | "refused" | "cut";

/** How a batch reaches the Orchestrator. Never throws: a transport failure is `again`. */
export type KeepSend = (
  instanceId: string,
  slot: string,
  entries: readonly KeptEntry[],
  signal: AbortSignal,
) => Promise<KeepAnswer>;

/** The largest batch, in bytes of JSON: the Orchestrator takes at most 4 MiB. */
const BATCH_BYTES = 512 * 1024;
/** How long after an entry the timer sends it, when nothing sent it before. */
const INTERVAL_MS = 1_000;
/** The longest wait between two tries of a batch that fails. */
const MAX_BACKOFF_MS = 30_000;
/** How long one send may take before it is a failure. */
const SEND_TIMEOUT_MS = 10_000;
/** How many more failed tries a closed keeper makes for what is left. */
const CLOSED_TRIES = 3;
/** The longest text of one entry, in characters. A longer text is cut in its middle, as the print
 * cuts an answer (printer.ts), so that no entry alone is larger than the Orchestrator takes (each
 * character is at most 6 bytes of JSON). */
const ENTRY_CHARS = 64 * 1024;

/** The text of one entry under {@link ENTRY_CHARS}: its head and its end stay, and the cut says how
 * many characters it dropped. */
export function boundEntryText(text: string): string {
  if (text.length <= ENTRY_CHARS) return text;
  const half = ENTRY_CHARS / 2;
  return `${text.slice(0, half)}… [${text.length - 2 * half} characters cut] …${text.slice(-half)}`;
}

export type KeeperOptions = {
  instanceId: string;
  /** The conversation's folder (record.ts), or undefined: the entries are kept in memory only. */
  dir?: string;
  /** How a batch is sent. Omitted, nothing is sent: the entries are only written locally. */
  send?: KeepSend;
  /** What a local write that failed does: the record's own fault (record.ts). */
  fault?: RecordFault;
  /** Tests shorten these. */
  intervalMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Where the one line about a refused batch goes. Default: stderr. */
  log?: (line: string) => void;
  /** The clock of a new conversation's first `seq`. Tests pin it. */
  now?: () => number;
};

/**
 * One conversation's kept entries and their sender. `add` writes and queues; nothing it does
 * waits on the Orchestrator.
 */
export class ConversationKeeper {
  readonly instanceId: string;
  private readonly entriesPath?: string;
  private readonly statePath?: string;
  private readonly send?: KeepSend;
  private readonly fault: RecordFault;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly pendingEntries: KeptEntry[] = [];
  private nextSeq: number;
  private sent: number;
  private slotValue = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private closedTries: number | undefined;
  private refusedSaid = false;
  /** The Orchestrator cut this conversation: it keeps no more, so nothing more is sent. */
  private cutDone = false;

  constructor(opts: KeeperOptions) {
    this.instanceId = opts.instanceId;
    this.send = opts.send;
    this.fault =
      opts.fault ??
      ((err) => {
        throw err;
      });
    this.intervalMs = opts.intervalMs ?? INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    if (opts.dir !== undefined) {
      this.entriesPath = join(opts.dir, "record", "entries.jsonl");
      this.statePath = join(opts.dir, "record", "keep.json");
    }
    // A conversation's `seq` goes up for as long as its Instance ID is kept. A record that a boot
    // rebuilt goes on from its last entry. A new record starts at the clock (milliseconds × 1000),
    // not at 0: a conversation that the Harness lost (its pod went) starts again under the same
    // Instance ID, and the Orchestrator keeps each `seq` once, so the new entries must come after
    // the old ones, never in their place.
    const recorded = this.readEntries();
    const state = this.readState();
    this.slotValue = state?.slot ?? "";
    if (recorded.length > 0) {
      this.nextSeq = recorded[recorded.length - 1]!.seq + 1;
      this.sent = state?.sent ?? -1;
      this.pendingEntries.push(...recorded.filter((e) => e.seq > this.sent));
    } else {
      this.nextSeq = Math.floor((opts.now ?? Date.now)()) * 1000;
      this.sent = -1;
    }
    if (this.pendingEntries.length > 0) this.schedule(0);
  }

  /** The slot the batches state (ADR-0076): the admission's, set by each Submission. */
  get slot(): string {
    return this.slotValue;
  }
  set slot(slot: string) {
    if (slot === this.slotValue) return;
    this.slotValue = slot;
    this.writeState();
  }

  /** Whether the keeper sends nothing more: it has no send, or it is closed and has sent all or
   * its last tries failed. */
  get done(): boolean {
    if (!this.send) return true;
    return this.closedTries !== undefined && (this.pendingEntries.length === 0 || this.closedTries <= 0);
  }

  /** The entries not yet taken by the Orchestrator. */
  get pending(): number {
    return this.pendingEntries.length;
  }

  /** Keep one body of the print: `[<label>] <text>`. Written locally at once, sent later. */
  add(body: string): void {
    const m = /^\[([^\]\n]+)\] ?/.exec(body);
    const entry: KeptEntry = {
      id: randomUUID(),
      seq: this.nextSeq++,
      at: new Date().toISOString(),
      kind: m ? m[1]! : "line",
      text: boundEntryText(m ? body.slice(m[0].length) : body),
    };
    if (this.entriesPath !== undefined) {
      try {
        mkdirSync(dirname(this.entriesPath), { recursive: true });
        appendFileSync(this.entriesPath, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        this.fault(err, this.entriesPath);
      }
    }
    if (this.cutDone) return;
    this.pendingEntries.push(entry);
    this.schedule(this.intervalMs);
  }

  /** Send what is pending now, not at the timer. Returns at once. */
  kick(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.start();
  }

  /** Kick, and resolve when no send is in flight: for a test, and for nothing that a Turn waits on. */
  async flush(): Promise<void> {
    this.kick();
    while (this.inFlight) await this.inFlight;
  }

  /** The conversation is freed: send what is left, batch after batch, and stop after a few failed
   * tries. */
  close(): void {
    // Its folder is going: nothing more is written there, or the folder would come back.
    this.closedTries ??= CLOSED_TRIES;
    this.kick();
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined || this.inFlight !== undefined || !this.send) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, ms);
    this.timer.unref?.();
  }

  private start(): void {
    if (this.inFlight || !this.send || this.pendingEntries.length === 0 || this.slotValue === "") return;
    if (this.closedTries !== undefined && this.closedTries <= 0) return;
    this.inFlight = this.sendOne().finally(() => {
      this.inFlight = undefined;
      if (this.pendingEntries.length === 0) return;
      if (this.failures === 0) this.start();
      else this.schedule(Math.min(this.maxBackoffMs, this.intervalMs * 2 ** (this.failures - 1)));
    });
  }

  private async sendOne(): Promise<void> {
    const batch: KeptEntry[] = [];
    let bytes = 0;
    for (const entry of this.pendingEntries) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (batch.length > 0 && bytes + size > BATCH_BYTES) break;
      batch.push(entry);
      bytes += size;
    }
    let answer: KeepAnswer;
    try {
      answer = await this.send!(this.instanceId, this.slotValue, batch, AbortSignal.timeout(this.timeoutMs));
    } catch {
      answer = "again";
    }
    if (answer === "again") {
      this.failures++;
      if (this.closedTries !== undefined) this.closedTries--;
      return;
    }
    if (answer === "refused" && !this.refusedSaid) {
      // Said once: sending it again would be refused again, so the batch is dropped. The print in
      // the pod log still has it.
      this.refusedSaid = true;
      this.log(
        `harness: the Orchestrator refused the kept conversation of ${this.instanceId}; its entries stay in the pod log only (ADR-0023)`,
      );
    }
    this.failures = 0;
    const last = batch[batch.length - 1]!.seq;
    // A cut keeps no later entry, so the rest is not sent: the local record and the print have it.
    this.pendingEntries.splice(0, answer === "cut" ? this.pendingEntries.length : batch.length);
    if (answer === "cut") this.cutDone = true;
    this.sent = Math.max(this.sent, last);
    this.writeState();
  }

  private readEntries(): KeptEntry[] {
    if (this.entriesPath === undefined) return [];
    let text: string;
    try {
      cutTornTail(this.entriesPath);
      text = readFileSync(this.entriesPath, "utf8");
    } catch {
      return [];
    }
    const entries: KeptEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as KeptEntry);
      } catch {
        // A line that does not parse is not sent; the print has it.
      }
    }
    return entries;
  }

  private readState(): { sent?: number; slot?: string } | undefined {
    if (this.statePath === undefined) return undefined;
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as { sent?: number; slot?: string };
    } catch {
      return undefined;
    }
  }

  /** Written whole, to a temporary name and then renamed. A failed write is not a fault: at worst a
   * restart sends a batch again, which adds nothing. */
  private writeState(): void {
    if (this.statePath === undefined || this.closedTries !== undefined) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(`${this.statePath}.tmp`, `${JSON.stringify({ sent: this.sent, slot: this.slotValue })}\n`);
      renameSync(`${this.statePath}.tmp`, this.statePath);
    } catch {
      // See above.
    }
  }
}

/**
 * The send over the Harness's control channel (ADR-0076): `POST /agents/<iid>/conversation` to the
 * Custodian's control socket, with the control Stand-in that this process alone holds and the
 * conversation's slot. The Custodian puts the pod's control token in the Stand-in's place.
 */
export function keepSendOver(reach: MenuReach): KeepSend {
  const base = reach.url.replace(/\/+$/, "");
  return async (instanceId, slot, entries, signal) => {
    try {
      const res = await (reach.fetch ?? globalThis.fetch)(
        `${base}/agents/${encodeURIComponent(instanceId)}/conversation`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${reach.token}`,
            [SLOT_HEADER]: slot,
          },
          body: JSON.stringify({ entries }),
          signal,
        },
      );
      if (res.ok && res.headers.get("x-jr2-custodian") !== "unreachable") {
        const answer = (await res.json().catch(() => undefined)) as { cut?: unknown } | undefined;
        return answer?.cut === true ? "cut" : "kept";
      }
      await res.body?.cancel();
      if (res.headers.get("x-jr2-custodian") === "unreachable") return "again";
      if (res.status >= 500 || [408, 409, 425, 429].includes(res.status)) return "again";
      return "refused";
    } catch {
      return "again";
    }
  };
}
