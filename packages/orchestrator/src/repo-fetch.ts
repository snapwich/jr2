// The ask, and the wait on it (ADR-0053): how a fetch INSIDE a Sandbox reaches the remote.
//
// Nothing in the pod holds a git credential, and nothing in it may talk to a remote — the node's
// cache agent is the only thing that fetches (ADR-0051). So a `git fetch` in a pod is a program on
// the runtime volume (`jr2-upload-pack`, operator/cmd) asking the Custodian on localhost, the Custodian
// asking the Orchestrator with the Sandbox token it already holds, and this port marking the
// Sandbox CR: one annotation per Repo key, timestamp value. The operator copies the mark onto the
// pod, the agent reads its demand off pods alone, and the landing comes back on the Sandbox's
// status — one standing entry per key, computed against the later of the CR's creation and the
// ask. This port writes the mark and waits for that entry. That is the whole route home.
//
// The mark is a COALESCER, which is what makes the timestamps load-bearing: however many fetches
// are in flight before one lands, the remote is fetched once, and a fetch that STARTED before the
// ask does not satisfy it (the agent stamps `lastFetched` with the attempt's start). So the
// comparison here is `>= asked` on the entry, never "an entry exists" — and an ask is raised to
// the next whole second on every side, because a bar spelled finer than the stamps that answer it
// would count a fetch that began BEFORE the ask. The same coalescing happens one hop earlier, in
// this process: asks that raise the same bar for one Sandbox and key share one mark and one wait,
// and past a cap on how many waits may be open the answer is the cache — the caller is inside an
// untrusted pod (ADR-0013), and a `git fetch` loop must not cost this process a write per
// iteration.
//
// Freshness degrades, absence does not (ADR-0051/0053): a remote fetch that failed, or one that
// outran the budget, is answered as `stale` with what the cache holds — never as an error. The
// program writes one warning line and serves the cache anyway, so the caller is told and the fetch
// still succeeds. Only a Repo the Sandbox does not mount is a refusal: the Sandbox token's scope
// is the caches its own pod mounts (ADR-0013).
//
// An LFS ask (ADR-0053) takes the same route with an `lfs` part: the objects a smudge, a cut or an
// attach needs, by oid and size. It writes its own mark, `jr2.dev/lfs-<key>`, and never the fetch's
// `jr2.dev/asked-<key>`, so it causes no git fetch. The mark's `base`, whose `.lfsconfig` picks the
// LFS server, is the Binding's base that the Orchestrator recorded on the Sandbox CR
// (`jr2.dev/base-<key>`), never a base that the pod sends (ADR-0051): so an Agent cannot point the
// cache agent at an LFS server of its choice. Its line (one Sandbox and key) keeps the union of the
// objects of every open LFS ask, up to LFS_MAX_OBJECTS: an ask whose objects a mark holds joins its
// wait, an ask with new objects marks the union again with a later `at` (at most one mark each
// second), and an ask that would take the union past the cap waits until the open mark lands. A
// mark lands when the Sandbox's status says `lfs.answered` is at or after its `at`. The answer says
// only that the cache agent served the mark, with git-lfs's words when an object is still missing;
// the asker reads the objects off its own read-only mount. LFS lines have their own cap, and past
// it an ask waits for a line inside its budget: a checkout fails only for an object that the cache
// cannot get, never because this process was busy. For the same reason, a mark that the API server
// refuses for a time (a 5xx, a 429, a dropped connection) is sent again inside the asks' budget.
//
// The mark is a merge patch through the Orchestrator's own client, and the wait is the one
// Sandbox watch (ADR-0063): the watch event that carries the landing answers the ask. Both are
// injectable, so the mapping is unit-testable against a fake API server; the kind e2e tier
// exercises the real thing.

import { KubeError, SANDBOXES, kubeClient, type KubeClient } from "./kube-client.ts";
import { askedAnnotation, baseAnnotation, lfsAnnotation } from "./names.ts";
import { repoKeyOfIdentity } from "./repo-identity.ts";
import { watchSandboxes, type SandboxObject, type SandboxRepoStatus, type SandboxWatch } from "./sandbox-watch.ts";

/** What one ask settles as. `fetched` is the landing's timestamp; `stale` is git's own words (or
 * this port's, when the budget ran out) beside the time the cache's objects are as of — `null`
 * when nothing has ever fetched it, which the program prints as "an unknown time". */
export type FetchAnswer = { fetched: string } | { stale: string; asOf: string | null };

/** One LFS object, as a pointer file names it. */
export type LfsObject = { oid: string; size: number };

/** The `lfs` part of an ask (ADR-0053): the objects to get. A pod may also send a `base`; it is
 * ignored, because the Orchestrator names the base itself (ADR-0051). */
export type LfsAsk = { objects: LfsObject[] };

/** What an LFS ask settles as. `answered` is the `at` of the mark that the cache agent served;
 * `error` is git-lfs's words when an object is still missing, or this port's words when the wait
 * ran out (on the node cache, or for a free line past the Orchestrator's cap). The asker reads the
 * objects off its own mount, so the answer lists none. */
export type LfsAnswer = { lfs: { answered?: string; error?: string } };

/** The most objects one ask, and one mark, can name. A longer list is split into several asks. */
export const LFS_MAX_OBJECTS = 256;

/**
 * The `lfs` part of a fetch body, checked: the ask, or the words of a 400 that says what is wrong.
 * An oid is 64 lowercase hex characters, a size a safe integer of 0 or more. A `base` is accepted
 * and not read: a runtime that started before this rule still sends one (ADR-0037).
 */
export function parseLfsAsk(value: unknown): LfsAsk | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "lfs must be an object: { objects: [{ oid, size }] }";
  }
  const { objects } = value as { objects?: unknown };
  if (!Array.isArray(objects)) return "lfs.objects must be an array of { oid, size }";
  if (objects.length === 0) return "lfs.objects is empty: an ask names 1 to 256 objects";
  if (objects.length > LFS_MAX_OBJECTS) {
    return `lfs.objects holds ${objects.length} objects: an ask names at most ${LFS_MAX_OBJECTS}, so split the list`;
  }
  const out: LfsObject[] = [];
  for (const [i, o] of objects.entries()) {
    const { oid, size } = (typeof o === "object" && o !== null ? o : {}) as { oid?: unknown; size?: unknown };
    if (typeof oid !== "string" || !/^[0-9a-f]{64}$/.test(oid)) {
      return `lfs.objects[${i}].oid must be 64 lowercase hex characters`;
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return `lfs.objects[${i}].size must be an integer of 0 or more`;
    }
    out.push({ oid, size });
  }
  return { objects: out };
}

/**
 * Why a base cannot go in a mark, or undefined when it can: at most 255 BYTES of UTF-8, as the
 * operator's parser counts them (`len` in Go), with no NUL, no newline and no leading `-`, because
 * the cache agent gives it to git. A mark that the operator cannot parse would never land.
 */
export function lfsBaseFault(base: string): string | undefined {
  if (Buffer.byteLength(base, "utf8") > 255) return "is longer than 255 bytes";
  if (/[\0\n\r]/.test(base)) return "holds a NUL or a newline";
  if (base.startsWith("-")) return 'starts with "-"';
  return undefined;
}

/** The ask a Sandbox may make: a fetch of one Repo it mounts (ADR-0053). */
export interface RepoFetches {
  /** Ask the node cache to fetch `identity` for `sandbox`, and wait for the landing. Answers
   * `fetched` or `stale`; throws {@link UnmountedRepoError} when the Sandbox mounts no such Repo. */
  fetch(sandbox: string, identity: string): Promise<FetchAnswer>;
  /** Ask the node cache to get LFS objects of `identity` for `sandbox`, and wait until it served
   * the mark that holds them. Throws {@link UnmountedRepoError} as {@link fetch} does. */
  fetchLfs(sandbox: string, identity: string, lfs: LfsAsk): Promise<LfsAnswer>;
}

/** The one refusal: this Sandbox does not mount that Repo (or is gone). The scope check, not a
 * failure of the fetch — a caller may ask only for the caches its own pod holds. */
export class UnmountedRepoError extends Error {}

/** The cache agent's one on-demand number — what the agent gives a fetch before it gives up. */
const CACHE_BUDGET_MS = 60_000;
/** The cache agent's LFS budget (`defaultLFSTimeout`): what it gives one batch of objects. */
const LFS_BUDGET_MS = 600_000;
/** How many fetch asks this Orchestrator will hold open at once, counting one per Sandbox and key.
 * The caller is inside a pod (ADR-0013: untrusted), an Agent that loops on `git fetch` is a mode
 * this codebase has already seen, and every open ask costs a write and a waiter in the one process
 * that serves every run in the instance. Past the cap an ask is answered the way a failed one is —
 * the cache, said out loud — so a pod that floods degrades its own fetches and nobody else's. LFS
 * asks have their own cap ({@link MAX_LFS_LINES}), so a long LFS wait never turns a fetch stale. */
const MAX_IN_FLIGHT = 16;
/** How many LFS lines (one Sandbox and key each) may mark and wait at once. Past it an LFS ask
 * waits, first come first served, for a line to close, inside its own budget: a checkout must not
 * fail because this process was busy (ADR-0053), and a waiting ask costs a waiter and no write. */
const MAX_LFS_LINES = 16;
/** How many LFS asks one Sandbox may hold open at once. git-lfs asks for at most a few batches at
 * a time, so only a pod that floods reaches it, and past it the pod's own asks are refused. */
const MAX_LFS_ASKS_PER_SANDBOX = 256;
/** The shortest time between two marks of one line, as for a fetch mark (one each second): a pod
 * that sends new oids without a pause costs one write each second, not one each ask. */
const LFS_MARK_GAP_MS = 1_000;
/** The first wait before a mark that the API server refused for a time is sent again. It doubles
 * up to {@link MARK_RETRY_MAX_MS}; the asks' own budget ends the tries. */
const MARK_RETRY_MS = 500;
const MARK_RETRY_MAX_MS = 8_000;
/** Watch slack on top of it: the agent's verdict has to reach the Repo CR, the operator has to
 * compute the Sandbox entry from it, and the watch has to carry it here. The ADR's "nothing else owns a
 * timeout" holds — this is the agent's budget plus the round trip, not a second policy. */
const WATCH_SLACK_MS = 15_000;

export type KubeRepoFetchesOptions = {
  /** The instance's namespace — the Sandboxes are here. */
  namespace: string;
  /** The Kubernetes client (ADR-0063), shared with the Sandbox port. Default: the in-cluster one. */
  client?: KubeClient;
  /** The one Sandbox watch, shared with the Sandbox port. Default: one started on first use. */
  watch?: SandboxWatch;
  /** The clock the ask is stamped from. Injectable for tests. */
  now?: () => Date;
  /** The whole wait. Default: the cache agent's on-demand budget plus watch slack. */
  budgetMs?: number;
  /** The whole wait of an LFS ask, a wait for a line included. Default: the cache agent's LFS
   * budget plus watch slack. */
  lfsBudgetMs?: number;
  /** How many fetch asks may be open at once. Default {@link MAX_IN_FLIGHT}. */
  maxInFlight?: number;
  /** How many LFS lines may be open at once. Default {@link MAX_LFS_LINES}. */
  maxLfsLines?: number;
  /** The shortest time between two marks of one LFS line. Default {@link LFS_MARK_GAP_MS}. */
  lfsMarkGapMs?: number;
  /** The first wait before a refused mark is sent again. Default {@link MARK_RETRY_MS}. */
  markRetryMs?: number;
};

const TOO_MANY = "the orchestrator is holding too many fetches at once";
const TOO_MANY_LFS = "the orchestrator is holding too many LFS asks at once";
const TIMED_OUT = "timed out waiting for the node cache";

/** One LFS ask while it waits. It waits for a line, then for room in its line, then in the next
 * mark (`next`), then on the sent mark `at`. */
type LfsAsker = {
  name: string;
  sandbox: string;
  key: string;
  found: SandboxObject;
  entries: string[];
  /** In the line's next mark, which has not gone out yet. */
  next: boolean;
  /** The `at` of the sent mark that holds its objects. */
  at?: number;
  settle: (answer: LfsAnswer) => void;
  fail: (err: Error) => void;
};

/** One Sandbox and key's LFS asks: the union of the open marks, and every waiting ask in the order
 * it came. */
type LfsLine = {
  name: string;
  sandbox: string;
  key: string;
  /** The Binding's base, off the Sandbox CR: every mark of the line names it. */
  base: string;
  /** The objects of the open marks and of the next one, as `"<oid> <size>"`. Empty: no mark is open. */
  union: Set<string>;
  /** The objects of the latest sent mark. */
  sent: Set<string>;
  /** The `at` of the latest sent mark, in ms. */
  markAt: number;
  /** The floor of the next `at`: it increases strictly. */
  lastAt: number;
  /** When the latest mark went out, on the process clock, for the gap between marks. */
  sentAt: number;
  /** The next mark, while it waits for the gap. */
  due?: ReturnType<typeof setTimeout>;
  askers: Set<LfsAsker>;
  unsubscribe: () => void;
};

export function kubeRepoFetches(opts: KubeRepoFetchesOptions): RepoFetches {
  const now = opts.now ?? (() => new Date());
  const budgetMs = opts.budgetMs ?? CACHE_BUDGET_MS + WATCH_SLACK_MS;
  const lfsBudgetMs = opts.lfsBudgetMs ?? LFS_BUDGET_MS + WATCH_SLACK_MS;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  const maxLfsLines = opts.maxLfsLines ?? MAX_LFS_LINES;
  const lfsMarkGapMs = opts.lfsMarkGapMs ?? LFS_MARK_GAP_MS;
  const markRetryMs = opts.markRetryMs ?? MARK_RETRY_MS;
  let client: KubeClient | undefined = opts.client;
  const kube = () => (client ??= kubeClient());
  let watch: SandboxWatch | undefined = opts.watch;
  const sandboxes = () => (watch ??= watchSandboxes(kube(), { namespace: opts.namespace }));
  // The asks this port is holding open, one per Sandbox and key, each with the second its mark was
  // raised to. The mark is a COALESCER on the node; this is the same coalescing one hop earlier,
  // and it is exact rather than approximate: every stamp that can answer an ask is kept at the
  // second (askedAt below), so two asks that raise the same bar CANNOT get different answers.
  // Sharing one wait between them spares the CR a second write and this process a second waiter.
  const openAsks = new Map<string, { until: number; answer: Promise<FetchAnswer> }>();

  /** The Sandbox as the watch holds it; the API server itself for one the watch has not seen (or
   * before its first list has landed). */
  const get = async (sandbox: string): Promise<SandboxObject | undefined> => {
    return sandboxes().get(sandbox) ?? (await kube().get<SandboxObject>(SANDBOXES, opts.namespace, sandbox));
  };

  // The LFS lines, one per Sandbox and key, each while it has an ask open; the asks that wait for
  // a line, in the order they came; and how many asks each Sandbox holds open.
  const lfsLines = new Map<string, LfsLine>();
  const lineQueue: LfsAsker[] = [];
  const lfsAsksOf = new Map<string, number>();
  // The marks of one Sandbox and key go out one after another, also across lines: a line that closed
  // can still have a mark in flight, and a later line's mark must not land under it.
  const markChains = new Map<string, Promise<void>>();

  /** The scope check FIRST, against `spec.repos` — the keys this pod actually mounts. The ask
   * names the identity, so the key is derived here (repo-identity.ts) and never sent; a spelling
   * that is not an identity derives a key nothing mounts, which is the same refusal. */
  const scope = async (sandbox: string, identity: string): Promise<{ key: string; found: SandboxObject }> => {
    const key = repoKeyOfIdentity(identity);
    const found = await get(sandbox);
    if (!found) throw new UnmountedRepoError(`no Sandbox "${sandbox}" in namespace "${opts.namespace}"`);
    if (!(found.spec?.repos ?? []).some((r) => r.key === key)) {
      throw new UnmountedRepoError(`Sandbox "${sandbox}" mounts no Repo for "${identity}"`);
    }
    return { key, found };
  };

  return {
    async fetch(sandbox, identity) {
      const { key, found } = await scope(sandbox, identity);
      const asked = now().toISOString();
      const until = askedAt(asked);
      const pair = `${sandbox}\u0000${key}`;
      // An ask whose bar is already being waited on is the same ask: one mark, one wait, one
      // answer. A LATER bar is not — it is a fetch that must begin after this ask — so it opens
      // its own wait and takes the pair's place, and the wait it displaced still answers whoever
      // joined it.
      const held = openAsks.get(pair);
      if (held && held.until >= until) return held.answer;
      if (!held && openAsks.size >= maxInFlight) {
        // Nothing is marked and nothing is waited on: the cache as it stands is the honest answer,
        // and the interval keeps refreshing it (ADR-0051). Freshness degrades, absence does not.
        return { stale: TOO_MANY, asOf: fetchedOf(found, key) };
      }
      const mine: { until: number; answer: Promise<FetchAnswer> } = {
        until,
        answer: undefined as unknown as Promise<FetchAnswer>,
      };
      mine.answer = wait(sandbox, key, asked).finally(() => {
        if (openAsks.get(pair) === mine) openAsks.delete(pair);
      });
      openAsks.set(pair, mine);
      return mine.answer;
    },

    async fetchLfs(sandbox, identity, lfs) {
      const { key, found } = await scope(sandbox, identity);
      // The Orchestrator's own record of the Binding's base. A base that the pod sent is not read.
      const base = baseOf(found, key);
      const fault = lfsBaseFault(base);
      if (fault !== undefined) return { lfs: { error: `the Binding's base ${JSON.stringify(base)} ${fault}` } };
      const open = lfsAsksOf.get(sandbox) ?? 0;
      if (open >= MAX_LFS_ASKS_PER_SANDBOX) {
        return { lfs: { error: `Sandbox "${sandbox}" holds ${open} LFS asks open at once` } };
      }
      lfsAsksOf.set(sandbox, open + 1);
      return new Promise<LfsAnswer>((resolve, reject) => {
        let ended = false;
        const end = (fn: () => void) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          const left = (lfsAsksOf.get(sandbox) ?? 1) - 1;
          if (left > 0) lfsAsksOf.set(sandbox, left);
          else lfsAsksOf.delete(sandbox);
          const queued = lineQueue.indexOf(asker);
          if (queued >= 0) lineQueue.splice(queued, 1);
          const line = lfsLines.get(asker.name);
          if (line?.askers.delete(asker) && line.askers.size === 0) closeLine(line);
          fn();
        };
        const asker: LfsAsker = {
          name: `${sandbox}\u0000${key}`,
          sandbox,
          key,
          found,
          entries: [...new Set(lfs.objects.map((o) => `${o.oid} ${o.size}`))],
          next: false,
          settle: (answer) => end(() => resolve(answer)),
          fail: (err) => end(() => reject(err)),
        };
        // The budget counts from the ask, so a wait for a line, and for room in it, is inside it.
        // An ask that never got a line says so.
        const timer = setTimeout(
          () => asker.settle({ lfs: { error: lineQueue.includes(asker) ? TOO_MANY_LFS : TIMED_OUT } }),
          lfsBudgetMs,
        );
        enter(asker);
      });
    },
  };

  /** Into its line, or into the wait for one: first come, first served, so an ask for a new line
   * never passes one that waits. An ask whose line is open joins it at once. */
  function enter(asker: LfsAsker): boolean {
    const line = lfsLines.get(asker.name);
    if (line) {
      join(line, asker);
      return true;
    }
    if (lineQueue.length > 0 || lfsLines.size >= maxLfsLines) {
      if (!lineQueue.includes(asker)) lineQueue.push(asker);
      return false;
    }
    join(openLine(asker), asker);
    return true;
  }

  /** The asks that wait for a line, in the order they came, after a line closed. */
  function pumpLines(): void {
    const waiting = lineQueue.splice(0);
    for (const a of waiting) enter(a);
  }

  /** A line for one Sandbox and key, on the one watch. The first `at` is after the mark the CR
   * already carries, so a landing for an earlier line answers nothing here. */
  function openLine(asker: LfsAsker): LfsLine {
    const current = sandboxes().get(asker.sandbox) ?? asker.found;
    const line: LfsLine = {
      name: asker.name,
      sandbox: asker.sandbox,
      key: asker.key,
      base: baseOf(current, asker.key),
      union: new Set(),
      sent: new Set(),
      markAt: 0,
      lastAt: Math.max(lfsMarkAt(current, asker.key) ?? 0, lfsMarkAt(asker.found, asker.key) ?? 0),
      sentAt: -Infinity,
      askers: new Set(),
      unsubscribe: () => {},
    };
    lfsLines.set(line.name, line);
    line.unsubscribe = sandboxes().subscribe(line.sandbox, (item) => land(line, item));
    return line;
  }

  function closeLine(line: LfsLine): void {
    line.unsubscribe();
    clearTimeout(line.due);
    if (lfsLines.get(line.name) === line) lfsLines.delete(line.name);
    pumpLines();
  }

  /** FIFO in the line: an ask that comes while others wait for room waits behind them, unless a
   * mark already holds its objects. */
  function join(line: LfsLine, asker: LfsAsker): void {
    const behind = [...line.askers].some((a) => waitsForRoom(a));
    line.askers.add(asker);
    place(line, asker, behind);
  }

  function waitsForRoom(a: LfsAsker): boolean {
    return a.at === undefined && !a.next;
  }

  /** Join the sent mark, join the next mark, or wait for room. Answers whether the ask has a mark. */
  function place(line: LfsLine, asker: LfsAsker, behind: boolean): boolean {
    const open = line.union.size > 0;
    if (open) {
      if (asker.entries.every((e) => line.sent.has(e))) {
        asker.at = line.markAt;
        return true;
      }
      if (line.due !== undefined && asker.entries.every((e) => line.union.has(e))) {
        asker.next = true;
        return true;
      }
    }
    if (behind) return false;
    if (open) {
      let size = line.union.size;
      for (const e of asker.entries) if (!line.union.has(e)) size++;
      if (size > LFS_MAX_OBJECTS) return false;
    }
    for (const e of asker.entries) line.union.add(e);
    asker.next = true;
    schedule(line);
    return true;
  }

  /** The next mark: now, or when the gap since the last one has passed. */
  function schedule(line: LfsLine): void {
    if (line.due !== undefined) return;
    const wait = line.sentAt + lfsMarkGapMs - performance.now();
    if (wait <= 0) return send(line);
    line.due = setTimeout(() => {
      line.due = undefined;
      send(line);
    }, wait);
  }

  /** One mark: the union, with an `at` later than every earlier one of this line. */
  function send(line: LfsLine): void {
    const at = Math.max(now().getTime(), line.lastAt + 1);
    line.lastAt = at;
    line.markAt = at;
    line.sentAt = performance.now();
    line.sent = new Set(line.union);
    for (const a of line.askers) {
      if (!a.next) continue;
      a.next = false;
      a.at = at;
    }
    const value = JSON.stringify({ at: new Date(at).toISOString(), base: line.base, objects: [...line.union] });
    const chain = (markChains.get(line.name) ?? Promise.resolve())
      .then(() => mark(line, at, value))
      // The merge patch answers the object as it stands afterwards: a landing on it answers now.
      .then(
        (marked) => land(line, marked),
        (err: unknown) => refused(line, at, err as Error),
      );
    markChains.set(line.name, chain);
    void chain.then(() => {
      if (markChains.get(line.name) === chain) markChains.delete(line.name);
    });
  }

  /** One mark's PATCH. A refusal for a time (a 5xx, a 429, no answer) is sent again with a wait that
   * doubles, while the mark is still the latest of an open line with asks on it: the asks' budget
   * ends the tries, and a later mark holds this one's objects. */
  async function mark(line: LfsLine, at: number, value: string): Promise<SandboxObject> {
    for (let wait = markRetryMs; ; wait = Math.min(wait * 2, MARK_RETRY_MAX_MS)) {
      try {
        return await kube().patch<SandboxObject>(SANDBOXES, opts.namespace, line.sandbox, {
          metadata: { annotations: { [lfsAnnotation(line.key)]: value } },
        });
      } catch (err) {
        const live = lfsLines.get(line.name) === line && line.markAt === at && line.askers.size > 0;
        if (!transient(err) || !live) throw err;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** The mark `at` did not go. Its asks move to a later sent mark that holds their objects; the
   * rest are told why. A mark that went before it is on the CR and can still land, so its asks
   * keep their wait. When it was the latest mark, the union and the sent objects are again those of
   * the asks that wait on a mark that went, so the next mark holds them too (it replaces the
   * annotation, and its landing answers them), and the asks that wait for room mark again. */
  function refused(line: LfsLine, at: number, err: Error): void {
    if (lfsLines.get(line.name) !== line) return;
    const later = line.markAt > at;
    for (const a of [...line.askers]) {
      if (a.at !== at) continue;
      if (later && a.entries.every((e) => line.sent.has(e))) a.at = line.markAt;
      else a.fail(err);
    }
    if (later || lfsLines.get(line.name) !== line) return;
    const held = [...line.askers].filter((a) => a.at !== undefined);
    line.sent = new Set(held.flatMap((a) => a.entries));
    line.union = new Set(line.sent);
    line.markAt = held.reduce((max, a) => Math.max(max, a.at!), 0);
    clearTimeout(line.due);
    line.due = undefined;
    for (const a of line.askers) a.next = false;
    drain(line);
  }

  /** A Sandbox event (or a patch's answer) for one line. */
  function land(line: LfsLine, item: SandboxObject | undefined): void {
    if (lfsLines.get(line.name) !== line) return;
    if (!item) {
      const gone = new UnmountedRepoError(`Sandbox "${line.sandbox}" is gone`);
      for (const a of [...line.askers]) a.fail(gone);
      return;
    }
    const status = entryOf(item, line.key)?.lfs;
    const answered = at(status?.answered);
    if (answered === undefined) return;
    const done = [...line.askers].filter((a) => a.at !== undefined && answered >= a.at);
    // The latest mark landed and no next mark waits: the union is closed, and the asks that waited
    // for room mark now — before the answered asks leave, so the line stays open for them.
    if (line.union.size > 0 && answered >= line.markAt && line.due === undefined) {
      line.union.clear();
      line.sent.clear();
      drain(line);
    }
    const answer: LfsAnswer = {
      lfs: { answered: status!.answered!, ...(status!.error ? { error: status!.error } : {}) },
    };
    for (const a of done) a.settle(answer);
  }

  /** The asks that waited for room, in the order they came, until one must wait again. */
  function drain(line: LfsLine): void {
    for (const a of line.askers) {
      if (!waitsForRoom(a)) continue;
      if (!place(line, a, false)) return;
    }
  }

  /** The mark and the wait on it, for one Sandbox and key. Every ask that shares the mark's second
   * shares this one promise. */
  async function wait(sandbox: string, key: string, asked: string): Promise<FetchAnswer> {
    // The mark. The merge patch answers the object as it stands afterwards, so a fetch that
    // already landed since an earlier ask answers at once, with no event to wait for.
    const marked = await kube().patch<SandboxObject>(SANDBOXES, opts.namespace, sandbox, {
      metadata: { annotations: { [askedAnnotation(key)]: asked } },
    });
    const first = verdict(marked, key, asked);
    if (first) return first;
    // Then the watch: the event that carries the landing is the answer (ADR-0063). The budget is
    // the cache agent's, and running past it looks like this from here: the agent may still be at
    // it (its next interval will land), so what the caller gets is the cache, said out loud.
    return new Promise<FetchAnswer>((resolve, reject) => {
      let last: SandboxObject = marked;
      const done = (fn: () => void) => {
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const timer = setTimeout(
        () => done(() => resolve({ stale: "timed out waiting for the node cache", asOf: fetchedOf(last, key) })),
        budgetMs,
      );
      const unsubscribe = sandboxes().subscribe(sandbox, (item) => {
        // The Sandbox went while we waited: the pod that asked is gone, so there is nothing left
        // to answer for. The caller is inside that pod, so this is nearly unreachable — and a
        // refusal beats inventing a verdict on a resource that no longer exists.
        if (!item) return done(() => reject(new UnmountedRepoError(`Sandbox "${sandbox}" is gone`)));
        last = item;
        const answer = verdict(item, key, asked);
        if (answer) done(() => resolve(answer));
      });
    });
  }
}

/**
 * One Sandbox status entry read as an answer, or `undefined` while the ask is still outstanding.
 *
 * Two comparisons, and both are load-bearing. First the entry must have been computed with THIS
 * ask in hand: the operator republishes `asked` as the later of the pod's creation and the mark,
 * so an entry whose `asked` predates ours is a reconcile from before the mark was seen, and
 * anything it reports settles an older ask, not this one. Then the landing is read against the
 * ENTRY's own ask, which is the same bar raised the same way — the operator and the node both
 * raise an ask to the next whole second, because that is the granularity every stamp that can
 * answer one is kept at, and rounding the other way would count a fetch that BEGAN before the ask
 * as answering it. That is the coalescer's one rule, and it is why the stamps are the attempt's
 * start.
 *
 * `error` is the other verdict, and the operator scopes it to an attempt made for that same ask.
 */
function verdict(item: SandboxObject, key: string, asked: string): FetchAnswer | undefined {
  const entry = entryOf(item, key);
  if (!entry) return undefined;
  const entryAsked = at(entry.asked);
  if (entryAsked === undefined || entryAsked < askedAt(asked)) return undefined;
  const fetched = entry.fetched;
  if (fetched !== undefined && (at(fetched) ?? -Infinity) >= entryAsked) return { fetched };
  const attempted = at(entry.attempted);
  if (entry.error && attempted !== undefined && attempted >= entryAsked) {
    return { stale: entry.error, asOf: fetchedOf(item, key) };
  }
  return undefined;
}

/** This ask raised to the next whole second — the bar a fetch must clear to answer it, spelled
 * exactly as the operator and the cache agent spell it (`AskedAt`, operator/api). The mark carries
 * milliseconds so two asks in one second stay distinguishable to a human reading the CR; nothing
 * that answers one records them, so the comparison rounds UP: a fetch that began under a second
 * BEFORE the ask cannot hold what the ask is about. */
function askedAt(stamp: string): number {
  return Math.ceil(Date.parse(stamp) / 1000) * 1000;
}

/** What the cache holds, whenever it last landed anything — `null` when it has never landed a
 * fetch at all, which is what the program prints as "an unknown time". This is the `asOf` of a
 * stale answer: the fetch it names did NOT answer the ask, and saying when the objects are from is
 * the whole of what a degraded answer can offer (ADR-0053). */
function fetchedOf(item: SandboxObject, key: string): string | null {
  return entryOf(item, key)?.fetched ?? null;
}

/** A refusal of the API server that can pass: a 5xx, a 429, or no answer at all. */
function transient(err: unknown): boolean {
  return !(err instanceof KubeError) || err.status >= 500 || err.status === 429;
}

/** The Binding's base that the Orchestrator recorded on the Sandbox CR for `key` (ADR-0051), or ""
 * for the Repo's default branch: the cache agent then reads `.lfsconfig` at the cache's HEAD. */
function baseOf(item: SandboxObject, key: string): string {
  return item.metadata?.annotations?.[baseAnnotation(key)] ?? "";
}

/** The `at` of the LFS mark the Sandbox CR carries for `key`, in ms; `undefined` for none. */
function lfsMarkAt(item: SandboxObject, key: string): number | undefined {
  const raw = item.metadata?.annotations?.[lfsAnnotation(key)];
  if (raw === undefined) return undefined;
  try {
    return at((JSON.parse(raw) as { at?: string }).at);
  } catch {
    return undefined;
  }
}

function entryOf(item: SandboxObject, key: string): SandboxRepoStatus | undefined {
  return (item.status?.repos ?? []).find((r) => r.key === key);
}

/** An RFC3339 stamp as a number; `undefined` for absent or unparseable — a value nothing can be
 * concluded from is the same as no value. */
function at(stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : ms;
}
