// The Orchestrator's notices (ADR-0062): what happened that the next Turn cannot find out for
// itself — a memory kill in its Workspace, a conversation that is new — kept as plain data in the
// run's persisted state (ADR-0007), beside the admission and epoch ledgers, and handed to the next
// admission in scope. The Harness writes every word; this is only the keeping.
//
// Delivered ONCE, and "delivered" means LEDGERED: a notice leaves the pending set in the same save
// that records the admission it rode. A restart before that save finds it still pending and the
// restored Turn's admission carries it again; a restart after it does not. Between `take` and that
// save the notice is RESERVED, in memory only, so a second admission in the same scope cannot carry
// it too — and a restart forgets reservations along with everything else in memory.

import type { Notice } from "./wire.ts";

/** Where an admission may hear notices: its continued conversation's base Instance ID (ADR-0057)
 * and its Workspace's Sandbox name. Either may be absent — a fresh Turn has no conversation to be
 * told about, and a Menu-only Agent works in no Workspace. `only`, when set, narrows the take to
 * the notices raised by these sources: what a nudge or a wake carries (ADR-0062). `except` leaves
 * out the notices raised by these: what a re-admission of the same Turn was told already;
 * `exceptPrefix` every notice whose source starts so — all guard kills, when that is not known. */
export type NoticeScope = {
  conversation?: string;
  workspace?: string;
  only?: readonly string[];
  except?: readonly string[];
  exceptPrefix?: string;
};

/** One pending notice: the notice, and the conversation or Workspace it goes to. `source` names
 * the event that raised it, so the same event raised twice — two Turns lost to one kernel kill, a
 * stream read replayed after a restore — is one notice. */
export type PendingNotice = { id: string; notice: Notice; to: string; source?: string };

/** The persisted form (`RunBlob.notices`). `seen` is every source ever raised, so a delivered
 * notice is not raised again by a late or replayed witness of the same event. */
export type NoticeLedgerState = { pending: PendingNotice[]; seen: string[] };

/** What one admission takes: the notices it carries, and their ids for the ledger write. */
export type TakenNotices = {
  ids: string[];
  notices: Notice[];
  /** Every notice taken, with the source it was raised with — what `restore` puts back when no
   * model heard the admission. */
  raised?: Array<{ notice: Notice; source?: string }>;
};

export class NoticeLedger {
  readonly #pending: PendingNotice[];
  readonly #seen: Set<string>;
  readonly #reserved = new Set<string>();
  readonly #newId: () => string;

  constructor(state: NoticeLedgerState | undefined, newId: () => string) {
    this.#pending = [...(state?.pending ?? [])];
    this.#seen = new Set(state?.seen ?? []);
    this.#newId = newId;
  }

  /** Raise a notice for `to` (a conversation's base id, or a Sandbox name — the notice's own
   * `scope` says which). `older` are the sources of earlier events that this one tells the same as —
   * a burst of guard kills, read at once: they are marked raised and give no notice of their own.
   * Answers whether anything changed — a notice pending, or a source marked — so the caller saves
   * only then. */
  raise(notice: Notice, to: string, source?: string, older: readonly string[] = []): boolean {
    let changed = false;
    for (const seen of older) {
      if (this.#seen.has(seen)) continue;
      this.#seen.add(seen);
      changed = true;
    }
    if (source !== undefined) {
      if (this.#seen.has(source)) return changed;
      this.#seen.add(source);
    } else {
      // A notice with no source is one notice with a pending twin that has none either. A notice
      // WITH a source keeps its own entry, so a take by source (`only`, `except`) finds it; equal
      // ones are one notice in the admission (`take`).
      const same = JSON.stringify(notice);
      if (this.#pending.some((p) => p.source === undefined && p.to === to && JSON.stringify(p.notice) === same)) {
        return changed;
      }
    }
    this.#pending.push({ id: this.#newId(), notice, to, ...(source === undefined ? {} : { source }) });
    return true;
  }

  /** Reserve every unreserved notice in this admission's scope, in the order raised. Equal notices —
   * two kills that tell the same thing — are said once, and every id is reserved. */
  take(scope: NoticeScope): TakenNotices {
    const taken = this.#pending.filter(
      (p) =>
        !this.#reserved.has(p.id) &&
        (scope.only === undefined || (p.source !== undefined && scope.only.includes(p.source))) &&
        (scope.except === undefined || p.source === undefined || !scope.except.includes(p.source)) &&
        (scope.exceptPrefix === undefined || p.source === undefined || !p.source.startsWith(scope.exceptPrefix)) &&
        (p.notice.scope === "conversation" ? p.to === scope.conversation : p.to === scope.workspace),
    );
    for (const p of taken) this.#reserved.add(p.id);
    const said = new Set<string>();
    const notices = taken.flatMap((p) => {
      const key = JSON.stringify(p.notice);
      if (said.has(key)) return [];
      said.add(key);
      return [p.notice];
    });
    return {
      ids: taken.map((p) => p.id),
      notices,
      raised: taken.map((p) => ({ notice: p.notice, ...(p.source === undefined ? {} : { source: p.source }) })),
    };
  }

  /** Put back a notice an admission carried that no model heard, with the source it was raised
   * with — `seen` already holds it, so a raise would drop it. Nothing changes when a notice with
   * that source is pending already. Answers whether anything changed. */
  restore(notice: Notice, to: string, source?: string): boolean {
    if (source === undefined) return this.raise(notice, to);
    if (this.#pending.some((p) => p.source === source && p.to === to)) return false;
    this.#seen.add(source);
    this.#pending.push({ id: this.#newId(), notice, to, source });
    return true;
  }

  /** The admission that carried them was ledgered: they are delivered. */
  delivered(ids: readonly string[]): void {
    for (const id of ids) {
      this.#reserved.delete(id);
      const at = this.#pending.findIndex((p) => p.id === id);
      if (at !== -1) this.#pending.splice(at, 1);
    }
  }

  /** The admission that carried them failed: they are pending again, for the next one. */
  release(ids: readonly string[]): void {
    for (const id of ids) this.#reserved.delete(id);
  }

  /** The persisted form — reserved notices included, because reserved is not delivered. */
  state(): NoticeLedgerState {
    return { pending: [...this.#pending], seen: [...this.#seen] };
  }
}
