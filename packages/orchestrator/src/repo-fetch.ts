// The ask, and the wait on it (ADR-0053): how a fetch INSIDE a Sandbox reaches the remote.
//
// Nothing in the pod holds a git credential, and nothing in it may talk to a remote — the node's
// cache agent is the only thing that fetches (ADR-0051). So a `git fetch` in a pod is a program on
// the runtime volume (`jr2-upload-pack`, operator/cmd) asking the Adapter on localhost, the Adapter
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
// untrusted pod (ADR-0013), and a `git fetch` loop must not cost this process a kubectl per
// second per iteration.
//
// Freshness degrades, absence does not (ADR-0051/0053): a remote fetch that failed, or one that
// outran the budget, is answered as `stale` with what the cache holds — never as an error. The
// program writes one warning line and serves the cache anyway, so the caller is told and the fetch
// still succeeds. Only a Repo the Sandbox does not mount is a refusal: the Sandbox token's scope
// is the caches its own pod mounts (ADR-0013).
//
// Drives the Sandbox CR through `kubectl` exactly as the provision's Ready wait does
// (sandbox-kubectl.ts) — same process seam, injectable, so the mapping is unit-testable without a
// cluster; the kind e2e tier exercises the real thing.

import { askedAnnotation } from "./names.ts";
import { repoKeyOfIdentity } from "./repo-identity.ts";
import { defaultKubectlExec, type KubectlExec } from "./sandbox-kubectl.ts";

/** What one ask settles as. `fetched` is the landing's timestamp; `stale` is git's own words (or
 * this port's, when the budget ran out) beside the time the cache's objects are as of — `null`
 * when nothing has ever fetched it, which the program prints as "an unknown time". */
export type FetchAnswer = { fetched: string } | { stale: string; asOf: string | null };

/** The ask a Sandbox may make: a fetch of one Repo it mounts (ADR-0053). */
export interface RepoFetches {
  /** Ask the node cache to fetch `identity` for `sandbox`, and wait for the landing. Answers
   * `fetched` or `stale`; throws {@link UnmountedRepoError} when the Sandbox mounts no such Repo. */
  fetch(sandbox: string, identity: string): Promise<FetchAnswer>;
}

/** The one refusal: this Sandbox does not mount that Repo (or is gone). The scope check, not a
 * failure of the fetch — a caller may ask only for the caches its own pod holds. */
export class UnmountedRepoError extends Error {}

/** The cache agent's one on-demand number — what the agent gives a fetch before it gives up. */
const CACHE_BUDGET_MS = 60_000;
/** How many asks this Orchestrator will hold open at once, counting one per Sandbox and key. The
 * caller is inside a pod (ADR-0013: untrusted), an Agent that loops on `git fetch` is a mode this
 * codebase has already seen, and every open ask costs a `kubectl` per second in the one process
 * that serves every run in the instance. Past the cap an ask is answered the way a failed one is —
 * the cache, said out loud — so a pod that floods degrades its own fetches and nobody else's. */
const MAX_IN_FLIGHT = 16;
/** Watch slack on top of it: the agent's verdict has to reach the Repo CR, the operator has to
 * compute the Sandbox entry from it, and this port has to read it. The ADR's "nothing else owns a
 * timeout" holds — this is the agent's budget plus the round trip, not a second policy. */
const WATCH_SLACK_MS = 15_000;

export type KubectlRepoFetchesOptions = {
  /** The instance's namespace — the Sandboxes are here. */
  namespace: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** Process seam, injectable for tests. Defaults shell to the `kubectl` on PATH. */
  exec?: KubectlExec;
  /** The clock the ask is stamped from, and the budget measured with. Injectable for tests. */
  now?: () => Date;
  /** How often the Sandbox's status is re-read while waiting. Default 1s. */
  pollMs?: number;
  /** The whole wait. Default: the cache agent's on-demand budget plus watch slack. */
  budgetMs?: number;
  /** How many asks may be open at once. Default {@link MAX_IN_FLIGHT}. */
  maxInFlight?: number;
};

export function kubectlRepoFetches(opts: KubectlRepoFetchesOptions): RepoFetches {
  const exec = opts.exec ?? defaultKubectlExec;
  const now = opts.now ?? (() => new Date());
  const pollMs = opts.pollMs ?? 1_000;
  const budgetMs = opts.budgetMs ?? CACHE_BUDGET_MS + WATCH_SLACK_MS;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  const base = ["--namespace", opts.namespace, ...(opts.context ? ["--context", opts.context] : [])];
  // The asks this port is holding open, one per Sandbox and key, each with the second its mark was
  // raised to. The mark is a COALESCER on the node; this is the same coalescing one hop earlier,
  // and it is exact rather than approximate: every stamp that can answer an ask is kept at the
  // second (askedAt below), so two asks that raise the same bar CANNOT get different answers.
  // Sharing one wait between them spares the CR a second write and this process a second poll.
  const openAsks = new Map<string, { until: number; answer: Promise<FetchAnswer> }>();

  const get = async (sandbox: string): Promise<SandboxItem | undefined> => {
    try {
      const { stdout } = await exec(["get", "sandbox", sandbox, ...base, "-o", "json"]);
      return JSON.parse(stdout) as SandboxItem;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  };

  return {
    async fetch(sandbox, identity) {
      // The scope check FIRST, against `spec.repos` — the keys this pod actually mounts. The ask
      // names the identity, so the key is derived here (repo-identity.ts) and never sent; a
      // spelling that is not an identity derives a key nothing mounts, which is the same refusal.
      const key = repoKeyOfIdentity(identity);
      const found = await get(sandbox);
      if (!found) throw new UnmountedRepoError(`no Sandbox "${sandbox}" in namespace "${opts.namespace}"`);
      if (!(found.spec?.repos ?? []).some((r) => r.key === key)) {
        throw new UnmountedRepoError(`Sandbox "${sandbox}" mounts no Repo for "${identity}"`);
      }
      const asked = now().toISOString();
      const until = askedAt(asked);
      const seat = `${sandbox}\u0000${key}`;
      // An ask whose bar is already being waited on is the same ask: one mark, one wait, one
      // answer. A LATER bar is not — it is a fetch that must begin after this ask — so it opens
      // its own wait and takes the seat, and the wait it displaced still answers whoever joined
      // it.
      const held = openAsks.get(seat);
      if (held && held.until >= until) return held.answer;
      if (!held && openAsks.size >= maxInFlight) {
        // Nothing is marked and nothing is waited on: the cache as it stands is the honest answer,
        // and the interval keeps refreshing it (ADR-0051). Freshness degrades, absence does not.
        return { stale: "the orchestrator is holding too many fetches at once", asOf: fetchedOf(found, key) };
      }
      const mine: { until: number; answer: Promise<FetchAnswer> } = {
        until,
        answer: undefined as unknown as Promise<FetchAnswer>,
      };
      mine.answer = wait(sandbox, key, asked).finally(() => {
        if (openAsks.get(seat) === mine) openAsks.delete(seat);
      });
      openAsks.set(seat, mine);
      return mine.answer;
    },
  };

  /** The mark and the wait on it, for one Sandbox and key. Every ask that shares the mark's second
   * shares this one promise. */
  async function wait(sandbox: string, key: string, asked: string): Promise<FetchAnswer> {
    // The mark. ONE call writes it and prints the object as it stands afterwards (the lease's
    // trick, sandbox-kubectl.ts), so the first look at the status costs no second round trip —
    // and a fetch that already landed since an earlier ask answers immediately.
    const { stdout } = await exec([
      "annotate",
      "sandbox",
      sandbox,
      ...base,
      `${askedAnnotation(key)}=${asked}`,
      "--overwrite",
      "-o",
      "json",
    ]);
    const deadline = now().getTime() + budgetMs;
    let item = JSON.parse(stdout) as SandboxItem;
    for (;;) {
      const answer = verdict(item, key, asked);
      if (answer) return answer;
      if (now().getTime() >= deadline) {
        // The budget is the cache agent's, and this is what running past it looks like from
        // here: the agent may still be at it (its next interval will land), so what the caller
        // gets is the cache, said out loud.
        return { stale: "timed out waiting for the node cache", asOf: fetchedOf(item, key) };
      }
      await sleep(pollMs);
      const next = await get(sandbox);
      // The Sandbox went while we waited: the pod that asked is gone, so there is nothing left
      // to answer for. The caller is inside that pod, so this is nearly unreachable — and a
      // refusal beats inventing a verdict on a resource that no longer exists.
      if (!next) throw new UnmountedRepoError(`Sandbox "${sandbox}" is gone`);
      item = next;
    }
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
function verdict(item: SandboxItem, key: string, asked: string): FetchAnswer | undefined {
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
function fetchedOf(item: SandboxItem, key: string): string | null {
  return entryOf(item, key)?.fetched ?? null;
}

function entryOf(item: SandboxItem, key: string): SandboxRepoStatus | undefined {
  return (item.status?.repos ?? []).find((r) => r.key === key);
}

/** An RFC3339 stamp as a number; `undefined` for absent or unparseable — a value nothing can be
 * concluded from is the same as no value. */
function at(stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A `Sandbox` resource as `kubectl get -o json` prints it — the fields this port reads. */
type SandboxItem = {
  spec?: { repos?: Array<{ key?: string }> };
  status?: { repos?: SandboxRepoStatus[] };
};

/** The operator's standing per-key Repo entry on a Sandbox (ADR-0053). */
type SandboxRepoStatus = {
  key: string;
  asked?: string;
  fetched?: string;
  attempted?: string;
  error?: string;
};

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /NotFound|not found/i.test(err.message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
