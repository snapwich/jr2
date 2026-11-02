// The Orchestrator's notices (ADR-0062): what happened that the next Turn cannot find out for
// itself — a memory kill in its Workspace, a conversation that is new — kept as plain data in the
// run's persisted state (ADR-0007), beside the admission and epoch ledgers, and handed to the next
// admission in scope, or to an open Turn at a step boundary. The Harness writes every word; this is
// only the keeping.
//
// A conversation notice reaches one conversation, so it leaves the pending set when it is heard. A
// Workspace notice goes to an AUDIENCE that the ledger fixes when it raises it — "an Agent hears a
// kill if it was there for it":
//
//   1. each conversation admitted in that Workspace before the kill that can still take a Turn: an
//      open Turn's, or a continued conversation's (`members`);
//   2. when the kill cut specific Turns, each one's Agent's NEXT Turn, fresh or continued (`retry`:
//      one kill can cut several Turns, and each Agent retries its own work);
//   3. minus each conversation whose own `bash` answer returned the kill's verdict (`told`). A
//      retry in a told conversation — the next Turn of a continued one — already has the verdict
//      in its context: it is the retry, and hears nothing.
//
// Each member hears it once (`heardBy`), and it RETIRES when every member and every retry has
// heard it. A conversation that starts after the kill, other than a retry, does not hear it. A
// fresh Turn that ends leaves the audience, because it can take no Turn again. "Before the kill"
// allows for the clocks (`AUDIENCE_SKEW_MS`): a kernel kill's time is the kubelet's, to the second.
//
// "Heard" means LEDGERED: a notice is heard by a conversation in the same save that records the
// admission it rode there, or the Harness's acknowledgment of a step boundary that appended it.
// Between `take` and that save the notice is RESERVED for the taking conversation, in memory only, so
// a second read in the same conversation cannot carry it too — and a restart forgets reservations
// along with everything else in memory. jr2 keeps no "handled" state: whether an Agent acted on a
// notice is not the ledger's concern.

import type { Notice } from "./wire.ts";

/** Where an admission, or a step boundary, may hear notices: its continued conversation's base
 * Instance ID (ADR-0057) and its Workspace's Sandbox name. Either may be absent — a fresh Turn has no
 * conversation to be told about, and a Menu-only Agent works in no Workspace. `taker` is the
 * conversation that takes a Workspace notice — the Instance ID the admission rides, which a fresh
 * Turn has too, as a new conversation; absent, `conversation` is the taker, and a scope with neither
 * takes no Workspace notice. `slot` is the taker's Agent (ADR-0076), and `turn` says this admission
 * starts a Turn: together they let a cut Turn's retry hear its kill. `only`, when set, narrows the
 * take to the notices raised by these sources: what a nudge or a wake carries (ADR-0062). `except`
 * leaves out the notices raised by these: what a re-admission of the same Turn was told already;
 * `exceptPrefix` every notice whose source starts so — all guard kills, when that is not known. */
export type NoticeScope = {
  conversation?: string;
  workspace?: string;
  taker?: string;
  slot?: string;
  turn?: boolean;
  only?: readonly string[];
  except?: readonly string[];
  exceptPrefix?: string;
};

/** A cut Turn's retry (D4 rule 2): the next Turn of `slot` — in any conversation, the cut Turn's
 * own `cut` included when it continues. `retried`: that Turn took it. */
export type NoticeRetry = { slot: string; cut?: string; retried?: true };

/** How far a member's first admission may come after a kill's time and still count as before it:
 * a kernel kill's time is the kubelet's `finishedAt`, which has whole seconds, and a guard kill's is
 * read on a stream; a member's is this process's clock. Two seconds holds the truncation and a
 * second of skew between the clocks. Wider is a notice to a conversation that started just after
 * the kill; narrower is a member that never hears it. */
export const AUDIENCE_SKEW_MS = 2_000;

/** One pending notice: the notice, and the conversation or Workspace it goes to. `source` names
 * the event that raised it, so the same event raised twice — two Turns lost to one kernel kill, a
 * stream read replayed after a restore — is one notice. On a Workspace notice: `audience`, the
 * conversations fixed at the raise; `retry`, each cut Turn's next Turn; `heardBy`, the
 * conversations it was delivered to, which do not take it again; `told`, the conversations whose
 * own `bash` answer told them. */
export type PendingNotice = {
  id: string;
  notice: Notice;
  to: string;
  source?: string;
  audience?: string[];
  retry?: NoticeRetry[];
  heardBy?: string[];
  told?: string[];
};

/** One conversation admitted in a Workspace (ADR-0062): who can be in a Workspace notice's audience.
 * `open`: a Turn of it is live. `continued`: it continues across Turns, so it can take another Turn
 * after this one ends. `since`: its first admission there, which a kill must come after. */
export type NoticeMember = { taker: string; slot: string; continued: boolean; open: boolean; since: string };

/** The persisted form (`RunBlob.notices`). `seen` is every source ever raised, so a delivered
 * notice is not raised again by a late or replayed witness of the same event. `members`: by
 * Workspace, the conversations admitted there that can still take a Turn. */
export type NoticeLedgerState = {
  pending: PendingNotice[];
  seen: string[];
  /** Each retry ever recorded, by source and slot: a replayed raise records it once. */
  retriesSeen?: string[];
  members?: Record<string, NoticeMember[]>;
};

/** What one admission takes: the notices it carries, and their ids for the ledger write. */
export type TakenNotices = {
  ids: string[];
  notices: Notice[];
  /** Every notice taken, in the order of `ids`, with the source it was raised with — what `restore`
   * puts back when no model heard the admission. */
  raised?: Array<{ notice: Notice; source?: string }>;
};

/** What a Workspace notice's raise knows of its kill: the cut Turn's retry, the conversations its
 * `bash` answer told, and when it happened — a conversation first admitted after it was not there. */
export type RaiseOptions = { retry?: NoticeRetry; told?: readonly string[]; at?: string };

/** A reservation: a conversation notice's id alone (it has one taker), a Workspace notice's id
 * with the conversation that took it (each conversation takes it once). */
const reservation = (p: PendingNotice, taker: string | undefined): string =>
  p.notice.scope === "workspace" ? `${p.id}\u0000${taker ?? ""}` : p.id;

/** The mark of a retry recorded for a source: a replayed raise records it once. */
const retryMark = (source: string, slot: string): string => `${source}\u0000retry\u0000${slot}`;

const copyRetry = (r: readonly NoticeRetry[] | undefined) =>
  r === undefined ? {} : { retry: r.map((x) => ({ ...x })) };

export class NoticeLedger {
  readonly #pending: PendingNotice[];
  readonly #seen: Set<string>;
  readonly #retriesSeen: Set<string>;
  readonly #members: Map<string, NoticeMember[]>;
  readonly #reserved = new Set<string>();
  /** The reservations a cut Turn's retry holds, by the slot it retries: delivering one marks that
   * retry `retried`. */
  readonly #asRetry = new Map<string, string>();
  readonly #newId: () => string;

  constructor(state: NoticeLedgerState | undefined, newId: () => string) {
    this.#pending = (state?.pending ?? []).map((p) => ({
      ...p,
      ...(p.audience === undefined ? {} : { audience: [...p.audience] }),
      ...copyRetry(p.retry),
      ...(p.heardBy === undefined ? {} : { heardBy: [...p.heardBy] }),
      ...(p.told === undefined ? {} : { told: [...p.told] }),
    }));
    this.#seen = new Set(state?.seen ?? []);
    this.#retriesSeen = new Set(state?.retriesSeen ?? []);
    this.#members = new Map(Object.entries(state?.members ?? {}).map(([ws, ms]) => [ws, ms.map((m) => ({ ...m }))]));
    this.#newId = newId;
  }

  /** Raise a notice for `to` (a conversation's base id, or a Sandbox name — the notice's own
   * `scope` says which). `older` are the sources of earlier events that this one tells the same as —
   * a burst of guard kills, read at once: they are marked raised and give no notice of their own.
   * A Workspace notice's audience is fixed here, from `opts`. Answers whether anything changed — a
   * notice pending, or a source marked — so the caller saves only then. */
  raise(notice: Notice, to: string, source?: string, older: readonly string[] = [], opts: RaiseOptions = {}): boolean {
    let changed = false;
    for (const seen of older) {
      if (this.#seen.has(seen)) continue;
      this.#seen.add(seen);
      changed = true;
    }
    if (source !== undefined) {
      // A second witness of one kill: a Turn it cut that the first did not name still retries.
      if (this.#seen.has(source)) return this.#addRetry(notice, to, source, opts.retry) || changed;
      this.#seen.add(source);
      if (opts.retry !== undefined) this.#retriesSeen.add(retryMark(source, opts.retry.slot));
      changed = true;
    }
    const workspace = notice.scope === "workspace";
    const audience = workspace ? this.#audienceOf(to, opts) : undefined;
    if (source === undefined) {
      // A notice with no source is one notice with a pending twin that has none either — while no
      // conversation has heard or reserved that twin: a later event is news to each conversation
      // the first one reached. A notice WITH a source keeps its own entry, so a take by source
      // (`only`, `except`) finds it; equal ones are one notice in the admission (`take`).
      const twin = this.#twin(notice, to);
      if (twin !== undefined) {
        if (audience === undefined) return changed;
        const before = twin.audience?.length ?? 0;
        twin.audience = [...new Set([...(twin.audience ?? []), ...audience])];
        const retried = opts.retry !== undefined && !(twin.retry ?? []).some((r) => r.slot === opts.retry!.slot);
        if (retried) twin.retry = [...(twin.retry ?? []), { ...opts.retry! }];
        return changed || twin.audience.length !== before || retried;
      }
    }
    // A Workspace notice no one was there for, and that no Turn retries, tells no one.
    if (audience !== undefined && audience.length === 0 && opts.retry === undefined) return changed;
    this.#pending.push({
      id: this.#newId(),
      notice,
      to,
      ...(source === undefined ? {} : { source }),
      ...(audience === undefined ? {} : { audience }),
      ...(opts.retry === undefined ? {} : { retry: [{ ...opts.retry }] }),
      ...(workspace && opts.told !== undefined && opts.told.length > 0 ? { told: [...opts.told] } : {}),
    });
    return true;
  }

  /** A raise of a seen source that names a cut Turn: its retry joins the notice, or is pending on a
   * notice of its own when the first witness gave none or every member has heard it. Once for each
   * slot and source, so a replayed read adds nothing. */
  #addRetry(notice: Notice, to: string, source: string, retry: NoticeRetry | undefined): boolean {
    if (retry === undefined || notice.scope !== "workspace") return false;
    const mark = retryMark(source, retry.slot);
    if (this.#retriesSeen.has(mark)) return false;
    this.#retriesSeen.add(mark);
    const pending = this.#pending.find((p) => p.source === source && p.to === to);
    if (pending !== undefined) {
      pending.retry = [...(pending.retry ?? []), { ...retry }];
      return true;
    }
    this.#pending.push({ id: this.#newId(), notice, to, source, audience: [], retry: [{ ...retry }] });
    return true;
  }

  /** Reserve every notice in this scope that this conversation may hear and has neither heard nor
   * reserved, in the order raised. Equal notices — two kills that tell the same thing — are said
   * once, and every id is reserved. */
  take(scope: NoticeScope): TakenNotices {
    const taker = scope.taker ?? scope.conversation;
    this.#retryTold(scope, taker);
    const taken = this.#eligible(scope, taker);
    for (const p of taken) {
      const key = reservation(p, taker);
      this.#reserved.add(key);
      const retry = this.#retryFor(p, scope, taker);
      if (retry !== undefined) this.#asRetry.set(key, retry.slot);
    }
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

  /** What {@link take} would reserve in this scope, reserving nothing: a step boundary asks first
   * whether a guard kill is among them, and so whether it must learn who was told. */
  peek(scope: NoticeScope): Array<{ id: string; notice: Notice; source?: string }> {
    return this.#eligible(scope, scope.taker ?? scope.conversation).map((p) => ({
      id: p.id,
      notice: p.notice,
      ...(p.source === undefined ? {} : { source: p.source }),
    }));
  }

  /** Put back a notice an admission carried that no model heard, with the source it was raised
   * with — `seen` already holds it, so a raise would drop it. A Workspace notice is still pending
   * for the other conversations: it is pending again for `taker`, the conversation that did not hear
   * it, which is a member of its audience again. Nothing changes when the notice is pending for that
   * conversation already. Answers whether anything changed. */
  restore(notice: Notice, to: string, source?: string, taker?: string): boolean {
    const pending =
      source === undefined
        ? notice.scope === "workspace" && taker !== undefined
          ? this.#equal(notice, to, taker)
          : this.#twin(notice, to)
        : this.#pending.find((p) => p.source === source && p.to === to);
    if (pending !== undefined) {
      if (pending.notice.scope !== "workspace" || taker === undefined) return false;
      const heardBy = pending.heardBy ?? [];
      const inAudience = pending.audience === undefined || pending.audience.includes(taker);
      if (!heardBy.includes(taker) && inAudience) return false;
      pending.heardBy = heardBy.filter((c) => c !== taker);
      if (!inAudience) pending.audience = [...(pending.audience ?? []), taker];
      return true;
    }
    if (source !== undefined) this.#seen.add(source);
    if (notice.scope === "workspace") {
      // Retired, or never pending for anyone else: pending again for the one that did not hear it.
      if (taker === undefined) return false;
      this.#pending.push({
        id: this.#newId(),
        notice,
        to,
        ...(source === undefined ? {} : { source }),
        audience: [taker],
      });
      return true;
    }
    if (source === undefined) return this.raise(notice, to);
    this.#pending.push({ id: this.#newId(), notice, to, source });
    return true;
  }

  /** The admission that carried them, in `taker`'s conversation, was ledgered — or the Harness
   * acknowledged the step boundary that appended them: they are heard there. A conversation notice
   * leaves the pending set; a Workspace notice stays for the rest of its audience, and `taker` does
   * not hear it again. It retires once every member has heard it. */
  delivered(ids: readonly string[], taker?: string): void {
    for (const id of ids) {
      const at = this.#pending.findIndex((p) => p.id === id);
      const p = this.#pending[at];
      if (p === undefined) {
        this.#reserved.delete(id);
        continue;
      }
      const key = reservation(p, taker);
      this.#reserved.delete(key);
      if (p.notice.scope !== "workspace") {
        this.#pending.splice(at, 1);
        continue;
      }
      const slot = this.#asRetry.get(key);
      if (slot !== undefined) {
        this.#asRetry.delete(key);
        for (const r of p.retry ?? []) if (r.slot === slot) r.retried = true;
      }
      if (taker !== undefined && !(p.heardBy ?? []).includes(taker)) p.heardBy = [...(p.heardBy ?? []), taker];
      this.#retireIfHeard(p);
    }
  }

  /** The Harness acknowledged the step boundary that appended these (ADR-0062): each one that
   * `taker` holds a reservation on is heard there. Answers how many were. */
  acknowledge(ids: readonly string[], taker: string): number {
    const mine = ids.filter((id) => {
      const p = this.#pending.find((q) => q.id === id);
      return p !== undefined && this.#reserved.has(reservation(p, taker));
    });
    this.delivered(mine, taker);
    return mine.length;
  }

  /** The admission that carried them, in `taker`'s conversation, failed — or the Turn ended with a
   * step boundary's notices unacknowledged: they are pending again there, for the next one. */
  release(ids: readonly string[], taker?: string): void {
    for (const id of ids) {
      const p = this.#pending.find((q) => q.id === id);
      const key = p === undefined ? id : reservation(p, taker);
      this.#reserved.delete(key);
      this.#asRetry.delete(key);
    }
  }

  /** A conversation was admitted in `workspace` (ADR-0062): it is there for every kill from now on,
   * while it can take a Turn. Answers whether anything changed. */
  admitted(workspace: string, member: Omit<NoticeMember, "open">): boolean {
    const members = this.#members.get(workspace) ?? [];
    const known = members.find((m) => m.taker === member.taker);
    if (known !== undefined) {
      if (known.open && known.continued === member.continued) return false;
      known.open = true;
      known.continued = member.continued;
      return true;
    }
    members.push({ ...member, open: true });
    this.#members.set(workspace, members);
    return true;
  }

  /** A Turn of these conversations in `workspace` ended. A continued one can take another Turn and
   * stays a member; a fresh one cannot, so it leaves every audience it has not heard yet — which can
   * retire a notice. Answers whether anything changed. */
  ended(workspace: string, takers: readonly string[]): boolean {
    let changed = false;
    const members = this.#members.get(workspace) ?? [];
    for (const taker of takers) {
      const at = members.findIndex((m) => m.taker === taker);
      const m = members[at];
      if (m === undefined) continue;
      changed = true;
      if (m.continued) {
        m.open = false;
        continue;
      }
      members.splice(at, 1);
      this.#leave(taker, workspace);
    }
    if (members.length === 0) this.#members.delete(workspace);
    return changed;
  }

  /** A conversation that can take no Turn again — a continued one jr2 burned (ADR-0057): it leaves
   * every Workspace and every audience. Answers whether anything changed. */
  forget(taker: string): boolean {
    let changed = false;
    for (const [workspace, members] of this.#members) {
      const at = members.findIndex((m) => m.taker === taker);
      if (at < 0) continue;
      members.splice(at, 1);
      if (members.length === 0) this.#members.delete(workspace);
      this.#leave(taker, workspace);
      changed = true;
    }
    return changed;
  }

  /** The conversations whose own `bash` answer returned the verdict of the kill `source` raised
   * (D4 rule 3): that answer told them, so they leave its audience. Answers whether anything
   * changed. */
  told(source: string, takers: readonly string[]): boolean {
    if (takers.length === 0) return false;
    const p = this.#pending.find((q) => q.source === source);
    if (p === undefined || p.audience === undefined) return false;
    const before = p.audience.length;
    const toldBefore = p.told?.length ?? 0;
    p.told = [...new Set([...(p.told ?? []), ...takers])];
    p.audience = p.audience.filter((t) => !takers.includes(t) || (p.heardBy ?? []).includes(t));
    if (p.audience.length === before && p.told.length === toldBefore) return false;
    this.#retireIfHeard(p);
    return true;
  }

  /** The persisted form — reserved notices included, because reserved is not delivered. */
  state(): NoticeLedgerState {
    return {
      pending: this.#pending.map((p) => ({
        ...p,
        ...(p.audience === undefined ? {} : { audience: [...p.audience] }),
        ...copyRetry(p.retry),
        ...(p.heardBy === undefined ? {} : { heardBy: [...p.heardBy] }),
        ...(p.told === undefined ? {} : { told: [...p.told] }),
      })),
      seen: [...this.#seen],
      ...(this.#retriesSeen.size === 0 ? {} : { retriesSeen: [...this.#retriesSeen] }),
      ...(this.#members.size === 0
        ? {}
        : { members: Object.fromEntries([...this.#members].map(([ws, ms]) => [ws, ms.map((m) => ({ ...m }))])) }),
    };
  }

  /** The notices this scope may take for `taker`, unreserved and unheard, in the order raised. */
  #eligible(scope: NoticeScope, taker: string | undefined): PendingNotice[] {
    return this.#pending.filter(
      (p) =>
        !this.#reserved.has(reservation(p, taker)) &&
        (scope.only === undefined || (p.source !== undefined && scope.only.includes(p.source))) &&
        (scope.except === undefined || p.source === undefined || !scope.except.includes(p.source)) &&
        (scope.exceptPrefix === undefined || p.source === undefined || !p.source.startsWith(scope.exceptPrefix)) &&
        (p.notice.scope === "conversation"
          ? p.to === scope.conversation
          : taker !== undefined &&
            p.to === scope.workspace &&
            !(p.heardBy ?? []).includes(taker) &&
            (p.audience === undefined || p.audience.includes(taker) || this.#retryFor(p, scope, taker) !== undefined)),
    );
  }

  /** The cut Turn's retry that this take is (D4 rule 2), or undefined: a Turn's admission of the cut
   * Agent's slot, in any conversation that its own `bash` answer did not tell — the cut Turn's own,
   * when it continues, too. */
  #retryFor(p: PendingNotice, scope: NoticeScope, taker: string | undefined): NoticeRetry | undefined {
    if (scope.turn !== true || taker === undefined || (p.told ?? []).includes(taker)) return undefined;
    return (p.retry ?? []).find((r) => r.retried !== true && r.slot === scope.slot);
  }

  /** A Turn of a retried slot in a conversation that its `bash` answer told: the next Turn of a
   * continued conversation, which has the verdict in its context. It is the retry, and hears
   * nothing more — so the notice can retire. */
  #retryTold(scope: NoticeScope, taker: string | undefined): void {
    if (scope.turn !== true || taker === undefined || scope.workspace === undefined) return;
    for (const p of [...this.#pending]) {
      if (p.to !== scope.workspace || !(p.told ?? []).includes(taker)) continue;
      let changed = false;
      for (const r of p.retry ?? []) {
        if (r.retried === true || r.slot !== scope.slot) continue;
        r.retried = true;
        changed = true;
      }
      if (changed) this.#retireIfHeard(p);
    }
  }

  /** Who of a Workspace's members is there for a kill now: each that can take a Turn, first
   * admitted before the kill, and not told by its own `bash` answer. */
  #audienceOf(workspace: string, opts: RaiseOptions): string[] {
    const at = opts.at === undefined ? undefined : Date.parse(opts.at);
    return (this.#members.get(workspace) ?? [])
      .filter((m) => m.open || m.continued)
      .filter((m) => at === undefined || Number.isNaN(at) || Date.parse(m.since) <= at + AUDIENCE_SKEW_MS)
      .map((m) => m.taker)
      .filter((t) => !(opts.told ?? []).includes(t));
  }

  /** `taker` can hear no more in `workspace`: it leaves each audience there it has not heard. */
  #leave(taker: string, workspace: string): void {
    for (const p of [...this.#pending]) {
      if (p.notice.scope !== "workspace" || p.to !== workspace || p.audience === undefined) continue;
      if ((p.heardBy ?? []).includes(taker) || !p.audience.includes(taker)) continue;
      p.audience = p.audience.filter((t) => t !== taker);
      this.#retireIfHeard(p);
    }
  }

  /** A Workspace notice every member has heard, and every retry has, is done. */
  #retireIfHeard(p: PendingNotice): void {
    if (p.notice.scope !== "workspace" || p.audience === undefined) return;
    const heard = p.heardBy ?? [];
    if (!p.audience.every((t) => heard.includes(t))) return;
    if ((p.retry ?? []).some((r) => r.retried !== true)) return;
    const at = this.#pending.indexOf(p);
    if (at >= 0) this.#pending.splice(at, 1);
  }

  /** The pending notice with no source that tells the same as `notice`, to the same place, and
   * that a new event of the same words can fold into: a conversation notice always, a Workspace
   * notice only while no conversation has heard or reserved it. */
  #twin(notice: Notice, to: string): PendingNotice | undefined {
    return this.#sameAs(notice, to).find(
      (p) => p.notice.scope !== "workspace" || ((p.heardBy ?? []).length === 0 && !this.#reservedByAny(p)),
    );
  }

  /** The pending Workspace notice with no source that tells the same as `notice` and that `taker`
   * restores: one still pending for it — then nothing changes — or else the last one it heard. */
  #equal(notice: Notice, to: string, taker: string): PendingNotice | undefined {
    const same = this.#sameAs(notice, to);
    return (
      same.find(
        (p) => !(p.heardBy ?? []).includes(taker) && (p.audience === undefined || p.audience.includes(taker)),
      ) ?? same.at(-1)
    );
  }

  #sameAs(notice: Notice, to: string): PendingNotice[] {
    const same = JSON.stringify(notice);
    return this.#pending.filter((p) => p.source === undefined && p.to === to && JSON.stringify(p.notice) === same);
  }

  /** Whether any conversation holds a reservation on this notice. */
  #reservedByAny(p: PendingNotice): boolean {
    for (const key of this.#reserved) if (key === p.id || key.startsWith(`${p.id}\u0000`)) return true;
    return false;
  }
}
