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
 * told about, and a Menu-only Agent works in no Workspace. */
export type NoticeScope = { conversation?: string; workspace?: string };

/** One pending notice: the notice, and the conversation or Workspace it goes to. `source` names
 * the event that raised it, so the same event raised twice — two Turns lost to one kernel kill, a
 * stream read replayed after a restore — is one notice. */
export type PendingNotice = { id: string; notice: Notice; to: string; source?: string };

/** The persisted form (`RunBlob.notices`). `seen` is every source ever raised, so a delivered
 * notice is not raised again by a late or replayed witness of the same event. */
export type NoticeLedgerState = { pending: PendingNotice[]; seen: string[] };

/** What one admission takes: the notices it carries, and their ids for the ledger write. */
export type TakenNotices = { ids: string[]; notices: Notice[] };

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
   * `scope` says which). False when `source` was already raised, or the same notice is already
   * pending for `to`. */
  raise(notice: Notice, to: string, source?: string): boolean {
    if (source !== undefined) {
      if (this.#seen.has(source)) return false;
      this.#seen.add(source);
    }
    // The same news, still unheard, is one notice: the guard writes one kill to the stream of
    // every conversation running in the pod, and each Turn following one reads it.
    const same = JSON.stringify(notice);
    if (this.#pending.some((p) => p.to === to && JSON.stringify(p.notice) === same)) return false;
    this.#pending.push({ id: this.#newId(), notice, to, ...(source === undefined ? {} : { source }) });
    return true;
  }

  /** Reserve every unreserved notice in this admission's scope, in the order raised. */
  take(scope: NoticeScope): TakenNotices {
    const taken = this.#pending.filter(
      (p) =>
        !this.#reserved.has(p.id) &&
        (p.notice.scope === "conversation" ? p.to === scope.conversation : p.to === scope.workspace),
    );
    for (const p of taken) this.#reserved.add(p.id);
    return { ids: taken.map((p) => p.id), notices: taken.map((p) => p.notice) };
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
