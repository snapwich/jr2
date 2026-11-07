// The ask a pod makes when something inside it fetches (ADR-0053), both halves: the port that
// marks the Sandbox CR and waits on its status, and the route the Custodian reaches it through.
//
// What matters here is the TIMESTAMP discipline. The mark is a coalescer — however many fetches
// are in flight before one lands, the remote is fetched once — and the thing that makes a
// coalesced ask correct is that a fetch which STARTED before the ask does not satisfy it. So every
// verdict is `>= asked`, on a status that may still be the reconcile before the mark was seen.
//
// The other half is the stance ADR-0051 set and ADR-0053 keeps: freshness degrades, absence does
// not. A failed remote fetch and a budget that ran out are both `stale` with what the cache holds,
// answered 200, because the program falls through to the cache and warns. The one refusal is
// scope: a Sandbox may ask for the caches it mounts, and no others.
//
// Socket-free, like the neighbours: the fake API server (_fake-kube.ts) and the real watch for the
// port — the mark is a merge patch, the landing arrives as a watch event (ADR-0063) — and
// `app.request` for the route.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http.ts";
import { kubeClient } from "../src/kube-client.ts";
import {
  kubeRepoFetches,
  UnmountedRepoError,
  type FetchAnswer,
  type KubeRepoFetchesOptions,
  type LfsAsk,
} from "../src/repo-fetch.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { RunHost } from "../src/run-host.ts";
import { watchSandboxes } from "../src/sandbox-watch.ts";
import { createAuthenticator, mintInstanceToken, sandboxToken } from "../src/tokens.ts";
import { fakeKube } from "./_fake-kube.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const APP = repoIdentity("git@github.com:acme/app.git");
const OTHER = repoIdentity("https://example.test/infra.git");

/** A fixed instant to ask at, the second it is raised to (what the operator publishes as the
 * entry's own `asked`), and the two stamps that straddle it. */
const ASKED = "2026-09-13T12:00:00.500Z";
const ASKED_AT = "2026-09-13T12:00:01Z";
const BEFORE = "2026-09-13T11:55:00Z";
const AFTER = "2026-09-13T12:00:07Z";

type Entry = { key: string; asked?: string; fetched?: string; attempted?: string; error?: string };

/**
 * A cluster holding Sandbox `sb-1`: `spec.repos` fixed (what the pod mounts) and `initial` as its
 * standing status. Every status in `later` is published — one watch event each, in order — after
 * the port's mark lands, the way the operator answers an ask.
 */
function cluster(t: TestContext, mounts: string[], initial?: Entry[], later: Entry[][] = []) {
  const api = fakeKube();
  api.seed("sandboxes", {
    metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } },
    spec: { repos: mounts.map((key) => ({ key })) },
    ...(initial ? { status: { repos: initial } } : {}),
  } as never);
  const client = kubeClient({ baseUrl: "https://kube.test", fetch: api.fetch, token: async () => api.token });
  const watch = watchSandboxes(client, { namespace: "inst", backoffMs: 5 });
  t.after(() => watch.stop());
  const publish = (repos: Entry[]) => api.setStatus("sandboxes", "sb-1", { repos });
  let queue = [...later];
  api.onWrite((plural, obj) => {
    if (plural !== "sandboxes" || !obj.metadata.annotations) return;
    const script = queue;
    queue = [];
    // After the patch has answered: the landing arrives as watch events, never in the answer.
    void (async () => {
      for (const repos of script) {
        await new Promise((r) => setTimeout(r, 2));
        publish(repos);
      }
    })();
  });
  const marks = () => api.calls.filter((c) => c.method === "PATCH" && c.target === "sandboxes/sb-1").map((c) => c.body);
  const port = (opts: Partial<KubeRepoFetchesOptions> = {}) =>
    kubeRepoFetches({ namespace: "inst", client, watch, now: () => new Date(ASKED), ...opts });
  return { api, port, publish, marks };
}

test("the ask marks the Sandbox CR per key, and the landing answers it", async (t) => {
  const c = cluster(t, [APP.key], undefined, [
    [],
    [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
  ]);
  assert.deepEqual(await c.port().fetch("sb-1", APP.identity), { fetched: AFTER });

  // The mark: one annotation, named by the KEY (the operator and the cache agent read it there),
  // valued with the instant of the ask — RFC3339 with milliseconds, because a second's truncation
  // is a whole coalescing window. A merge patch, so a later ask replaces an earlier one.
  assert.deepEqual(c.marks(), [{ metadata: { annotations: { [`jr2.dev/asked-${APP.key}`]: ASKED } } }]);
  assert.equal(c.api.calls.find((x) => x.method === "PATCH")!.contentType, "application/merge-patch+json");
});

test("a landing already on the patched object answers at once, with no event to wait for", async (t) => {
  // The merge patch answers the object as it stands: a fetch that landed for an earlier ask in this
  // same second is already this ask's answer.
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]);
  assert.deepEqual(await c.port({ budgetMs: 60_000 }).fetch("sb-1", APP.identity), { fetched: AFTER });
});

test("a fetch that landed BEFORE the ask does not answer it", async (t) => {
  // The whole reason the agent stamps `lastFetched` with the attempt's START: a fetch already in
  // flight when the ask arrived says nothing about the remote's now. The status may also simply be
  // the reconcile before the mark was seen — same shape, same answer: keep waiting.
  const c = cluster(t, [APP.key], undefined, [
    [{ key: APP.key, asked: BEFORE, fetched: BEFORE, attempted: BEFORE }],
    [{ key: APP.key, asked: BEFORE, fetched: BEFORE, attempted: BEFORE }],
    [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
  ]);
  assert.deepEqual(await c.port().fetch("sb-1", APP.identity), { fetched: AFTER });
});

test("an entry from BEFORE the mark settles nothing, and a fetch begun in the ask's own second is not a landing", async (t) => {
  // Two readings the stamps have to get right.
  //
  // The status is republished on every reconcile, so the first look can be the reconcile before
  // the mark was seen: its `asked` is older than this one, and a landing it reports answers THAT
  // ask, not this. So the entry must carry an ask at least as new as ours before it is read at all.
  //
  // And the node stamps every attempt with its START, at the second — so the ask is raised to the
  // NEXT second, here and in the operator alike. A fetch that began at 12:00:00, half a second
  // before this ask, cannot hold what the ask is about; counting it would answer a `git fetch`
  // with the pushed commit still missing. The cost of rounding this way is one more fetch.
  const second = ASKED.replace(".500Z", "Z");
  const c = cluster(
    t,
    [APP.key],
    [{ key: APP.key, asked: BEFORE, fetched: AFTER, attempted: AFTER }],
    [
      [{ key: APP.key, asked: ASKED_AT, fetched: second, attempted: second }],
      [{ key: APP.key, asked: ASKED_AT, fetched: ASKED_AT, attempted: ASKED_AT }],
    ],
  );
  assert.deepEqual(await c.port().fetch("sb-1", APP.identity), { fetched: ASKED_AT });
});

test("a failed remote fetch is STALE with git's own words, never an error", async (t) => {
  // ADR-0051's stance, kept: the program falls through to the objects the cache holds and writes
  // one warning line. So this is a 200 with a verdict, not a refusal — and `asOf` is whatever the
  // status says the cache holds, relayed as-is.
  const c = cluster(t, [APP.key], undefined, [
    [{ key: APP.key, asked: ASKED_AT, attempted: AFTER, error: "fatal: Authentication failed" }],
  ]);
  assert.deepEqual(await c.port().fetch("sb-1", APP.identity), { stale: "fatal: Authentication failed", asOf: null });

  const older = cluster(t, [APP.key], undefined, [
    [{ key: APP.key, asked: ASKED_AT, fetched: BEFORE, attempted: AFTER, error: "fatal: no route to host" }],
  ]);
  assert.deepEqual(await older.port().fetch("sb-1", APP.identity), { stale: "fatal: no route to host", asOf: BEFORE });
});

test("an attempt that predates the ask is not this ask's verdict", async (t) => {
  // A standing error from the last interval must not settle a fetch asked after it — the caller
  // would be told the remote is unreachable on the strength of a minutes-old attempt.
  const c = cluster(
    t,
    [APP.key],
    [{ key: APP.key, asked: BEFORE, attempted: BEFORE, error: "fatal: Authentication failed" }],
    [[{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]],
  );
  assert.deepEqual(await c.port().fetch("sb-1", APP.identity), { fetched: AFTER });
});

test("the wait ends with the budget, and answers the cache — the ask never fails a fetch", async (t) => {
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT }]);
  assert.deepEqual(await c.port({ budgetMs: 5 }).fetch("sb-1", APP.identity), {
    stale: "timed out waiting for the node cache",
    asOf: null,
  });
});

test("a Sandbox deleted while its ask waits is a refusal, not an invented verdict", async (t) => {
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT }]);
  const asked = c.port({ budgetMs: 60_000 }).fetch("sb-1", APP.identity);
  await waitFor(() => c.marks().length === 1);
  c.api.remove("sandboxes", "sb-1");
  await assert.rejects(asked, /is gone/);
});

test("a Repo the Sandbox does not mount is refused, and nothing is marked", async (t) => {
  // The Sandbox token's scope is the caches ITS pod mounts (ADR-0013/0053). Refused before the
  // mark, so an ask for someone else's Repo leaves no annotation behind on this CR.
  const c = cluster(t, [OTHER.key]);
  await assert.rejects(() => c.port().fetch("sb-1", APP.identity), UnmountedRepoError);
  assert.equal(c.marks().length, 0, "the refusal writes nothing");

  // The ask names the IDENTITY, and exactly: the url it was resolved from derives a different
  // string, so it derives a different key, and this Sandbox mounts no such Repo.
  const spelled = cluster(t, [APP.key]);
  await assert.rejects(() => spelled.port().fetch("sb-1", "git@github.com:acme/app.git"), /mounts no Repo/);
});

test("a Sandbox that is not there is refused, not waited on", async (t) => {
  const c = cluster(t, [APP.key]);
  await assert.rejects(() => c.port().fetch("sb-gone", APP.identity), UnmountedRepoError);
});

test("asks that raise the same bar share one mark and one wait", async (t) => {
  // The coalescer, one hop before the node's: the caller is inside an untrusted pod (ADR-0013),
  // and an Agent that loops on `git fetch` would otherwise cost this process one CR write and one
  // waiter per iteration — in the single process that serves every run in the instance. Two asks
  // that raise the same second cannot get different answers, so they get one answer.
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT }]);
  const port = c.port({ budgetMs: 60_000 });

  const first = port.fetch("sb-1", APP.identity);
  await waitFor(() => c.marks().length === 1);
  const second = port.fetch("sb-1", APP.identity);
  c.publish([{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]);

  assert.deepEqual(await first, { fetched: AFTER });
  assert.deepEqual(await second, { fetched: AFTER });
  assert.equal(c.marks().length, 1, "one ask, one mark");

  // And once it has answered, the seat is free: the next fetch is a new ask, with its own mark.
  assert.deepEqual(await port.fetch("sb-1", APP.identity), { fetched: AFTER });
  assert.equal(c.marks().length, 2);
});

test("an ask that raises a LATER bar waits on its own fetch", async (t) => {
  // Sharing is exact, not approximate: an ask a second later needs a fetch that began after IT,
  // which the wait already running cannot promise. So it marks the CR again and waits itself.
  let clock = ASKED;
  const later = "2026-09-13T12:00:02.000Z";
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT }]);
  const port = c.port({ now: () => new Date(clock), budgetMs: 60_000 });

  const first = port.fetch("sb-1", APP.identity);
  await waitFor(() => c.marks().length === 1);
  clock = later;
  const second = port.fetch("sb-1", APP.identity);
  await waitFor(() => c.marks().length === 2);
  c.publish([{ key: APP.key, asked: later, fetched: AFTER, attempted: AFTER }]);

  await Promise.all([first, second]);
  assert.deepEqual(c.marks()[1], { metadata: { annotations: { [`jr2.dev/asked-${APP.key}`]: later } } });
});

test("past the cap an ask is answered with the cache, and nothing is marked", async (t) => {
  // The flood's answer is the decision's own stance: freshness degrades, absence does not. The
  // interval keeps refreshing the cache, so what the caller loses is the round trip, not the
  // objects — and it is told, because the program warns on a stale answer.
  const c = cluster(
    t,
    [APP.key, OTHER.key],
    [
      { key: APP.key, asked: ASKED_AT },
      { key: OTHER.key, asked: ASKED_AT, fetched: BEFORE },
    ],
  );
  const port = c.port({ maxInFlight: 1, budgetMs: 60_000 });

  const first = port.fetch("sb-1", APP.identity);
  await waitFor(() => c.marks().length === 1);
  assert.deepEqual(await port.fetch("sb-1", OTHER.identity), {
    stale: "the orchestrator is holding too many fetches at once",
    asOf: BEFORE,
  });
  assert.equal(c.marks().length, 1, "the refused ask marks nothing");
  c.publish([{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]);
  assert.deepEqual(await first, { fetched: AFTER });
});

// --- the LFS ask (ADR-0053) -------------------------------------------------------------------
//
// The same port with an `lfs` part. Its mark is `jr2.dev/lfs-<key>`, never the fetch's, and its
// seat keeps the union of the open asks. The landing is `status.repos[key].lfs.answered` at or
// after the ask's `at`, carried by a watch event.

const OID = (n: number) => n.toString(16).padStart(64, "0");
const objs = (...ns: number[]): LfsAsk => ({ base: "main", objects: ns.map((n) => ({ oid: OID(n), size: n })) });
const LFS_MARK = `jr2.dev/lfs-${APP.key}`;
type LfsMark = { at: string; base: string; objects: string[] };

/** Every LFS mark the port wrote, parsed, in order. */
const lfsMarks = (c: ReturnType<typeof cluster>): LfsMark[] =>
  c
    .marks()
    .map((b) => (b as { metadata: { annotations: Record<string, string> } }).metadata.annotations[LFS_MARK])
    .filter((v): v is string => v !== undefined)
    .map((v) => JSON.parse(v) as LfsMark);

/** The status the operator publishes once the cache agent served the mark `at`. */
const served = (at: string, error?: string): Entry[] =>
  [{ key: APP.key, lfs: { asked: at, answered: at, ...(error ? { error } : {}) } }] as unknown as Entry[];

test("an LFS ask marks jr2.dev/lfs-<key> with the objects, and the landing answers it", async (t) => {
  const c = cluster(t, [APP.key]);
  const asked = c.port({ lfsBudgetMs: 60_000 }).fetchLfs("sb-1", APP.identity, objs(1, 2));
  await waitFor(() => c.marks().length === 1);

  // One merge patch, one annotation: never the fetch's `asked-<key>`, so no git fetch.
  const [body] = c.marks() as Array<{ metadata: { annotations: Record<string, string> } }>;
  assert.deepEqual(Object.keys(body!.metadata.annotations), [LFS_MARK]);
  const [mark] = lfsMarks(c);
  assert.deepEqual(mark, { at: ASKED, base: "main", objects: [`${OID(1)} 1`, `${OID(2)} 2`] });

  // A landing for an EARLIER mark answers nothing.
  c.publish(served(BEFORE));
  await new Promise((r) => setTimeout(r, 10));
  c.publish(served(ASKED, "batch response: object not found"));
  assert.deepEqual(await asked, { lfs: { answered: ASKED, error: "batch response: object not found" } });
});

test("LFS asks open at the same time share one mark; a later ask with new objects marks the union again", async (t) => {
  const c = cluster(t, [APP.key]);
  const port = c.port({ lfsBudgetMs: 60_000 });

  const first = port.fetchLfs("sb-1", APP.identity, objs(1, 2));
  await waitFor(() => c.marks().length === 1);
  // Its objects are in the open mark: it joins the wait, and nothing is written.
  const joined = port.fetchLfs("sb-1", APP.identity, objs(2));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.marks().length, 1, "a held object writes nothing");

  // New objects: the union is marked again, with an `at` strictly later on the same clock.
  const later = port.fetchLfs("sb-1", APP.identity, objs(3));
  await waitFor(() => c.marks().length === 2);
  const [one, two] = lfsMarks(c);
  assert.ok(Date.parse(two!.at) > Date.parse(one!.at), "at increases strictly per seat");
  assert.deepEqual(two!.objects, [`${OID(1)} 1`, `${OID(2)} 2`, `${OID(3)} 3`]);

  // The first landing answers the asks of the first mark only; the second answers the rest.
  c.publish(served(one!.at));
  assert.deepEqual(await first, { lfs: { answered: one!.at } });
  assert.deepEqual(await joined, { lfs: { answered: one!.at } });
  c.publish(served(two!.at));
  assert.deepEqual(await later, { lfs: { answered: two!.at } });

  // The seat closed with its last ask; the next ask marks after every earlier `at`.
  const again = port.fetchLfs("sb-1", APP.identity, objs(1));
  await waitFor(() => c.marks().length === 3);
  const three = lfsMarks(c)[2]!;
  assert.ok(Date.parse(three.at) > Date.parse(two!.at));
  assert.deepEqual(three.objects, [`${OID(1)} 1`]);
  c.publish(served(three.at));
  assert.deepEqual(await again, { lfs: { answered: three.at } });
});

test("an LFS ask that would take the union past 256 objects waits until the open mark lands", async (t) => {
  const c = cluster(t, [APP.key]);
  const port = c.port({ lfsBudgetMs: 60_000 });
  const range = (from: number, n: number) => objs(...Array.from({ length: n }, (_, i) => from + i));

  const full = port.fetchLfs("sb-1", APP.identity, range(1, 200));
  await waitFor(() => c.marks().length === 1);
  const over = port.fetchLfs("sb-1", APP.identity, range(1000, 100));
  // A later ask that the open mark holds still joins, even behind a waiting ask.
  const held = port.fetchLfs("sb-1", APP.identity, range(1, 3));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.marks().length, 1, "the ask past the cap marks nothing while the mark is open");

  const one = lfsMarks(c)[0]!;
  c.publish(served(one.at));
  assert.deepEqual(await full, { lfs: { answered: one.at } });
  assert.deepEqual(await held, { lfs: { answered: one.at } });

  // The landing closed the union: the waiting ask marks its own objects alone.
  await waitFor(() => c.marks().length === 2);
  const two = lfsMarks(c)[1]!;
  assert.equal(two.objects.length, 100);
  assert.ok(Date.parse(two.at) > Date.parse(one.at));
  c.publish(served(two.at));
  assert.deepEqual(await over, { lfs: { answered: two.at } });
});

test("an LFS ask for another base waits until the open mark lands", async (t) => {
  // One mark names one base, whose .lfsconfig names the LFS server.
  const c = cluster(t, [APP.key]);
  const port = c.port({ lfsBudgetMs: 60_000 });
  const first = port.fetchLfs("sb-1", APP.identity, objs(1));
  await waitFor(() => c.marks().length === 1);
  const other = port.fetchLfs("sb-1", APP.identity, { ...objs(1), base: "release" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.marks().length, 1);
  c.publish(served(lfsMarks(c)[0]!.at));
  await first;
  await waitFor(() => c.marks().length === 2);
  const two = lfsMarks(c)[1]!;
  assert.equal(two.base, "release");
  c.publish(served(two.at));
  assert.deepEqual(await other, { lfs: { answered: two.at } });
});

test("an LFS ask's wait ends with its budget, said in its answer", async (t) => {
  const c = cluster(t, [APP.key]);
  assert.deepEqual(await c.port({ lfsBudgetMs: 5 }).fetchLfs("sb-1", APP.identity, objs(1)), {
    lfs: { error: "timed out waiting for the node cache" },
  });
});

test("a Sandbox deleted while an LFS ask waits is a refusal; an unmounted Repo is refused and marks nothing", async (t) => {
  const c = cluster(t, [APP.key]);
  const asked = c.port({ lfsBudgetMs: 60_000 }).fetchLfs("sb-1", APP.identity, objs(1));
  await waitFor(() => c.marks().length === 1);
  c.api.remove("sandboxes", "sb-1");
  await assert.rejects(asked, /is gone/);

  const other = cluster(t, [OTHER.key]);
  await assert.rejects(() => other.port().fetchLfs("sb-1", APP.identity, objs(1)), UnmountedRepoError);
  assert.equal(other.marks().length, 0);
});

test("a fetch ask and an LFS ask on one key do not touch each other's mark or answer", async (t) => {
  const c = cluster(t, [APP.key], [{ key: APP.key, asked: ASKED_AT }]);
  const port = c.port({ budgetMs: 60_000, lfsBudgetMs: 60_000 });
  const fetched = port.fetch("sb-1", APP.identity);
  const lfs = port.fetchLfs("sb-1", APP.identity, objs(1));
  await waitFor(() => c.marks().length === 2);
  const keys = (c.marks() as Array<{ metadata: { annotations: Record<string, string> } }>).map((b) =>
    Object.keys(b.metadata.annotations),
  );
  assert.deepEqual(keys.sort(), [[`jr2.dev/asked-${APP.key}`], [LFS_MARK]]);

  // A git fetch landing answers the fetch alone; the LFS landing answers the LFS ask alone.
  const at = lfsMarks(c)[0]!.at;
  c.publish([{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]);
  assert.deepEqual(await fetched, { fetched: AFTER });
  let settled = false;
  void lfs.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  c.publish([
    { key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER, lfs: { asked: at, answered: at } },
  ] as never);
  assert.deepEqual(await lfs, { lfs: { answered: at } });
});

test("LFS seats count toward the cap on open asks", async (t) => {
  const c = cluster(t, [APP.key, OTHER.key], [{ key: OTHER.key, asked: ASKED_AT, fetched: BEFORE }]);
  const port = c.port({ maxInFlight: 1, lfsBudgetMs: 60_000 });
  const lfs = port.fetchLfs("sb-1", APP.identity, objs(1));
  await waitFor(() => c.marks().length === 1);
  assert.deepEqual(await port.fetch("sb-1", OTHER.identity), {
    stale: "the orchestrator is holding too many fetches at once",
    asOf: BEFORE,
  });
  assert.deepEqual(await port.fetchLfs("sb-1", OTHER.identity, objs(1)), {
    lfs: { error: "the orchestrator is holding too many fetches at once" },
  });
  assert.equal(c.marks().length, 1);
  c.publish(served(lfsMarks(c)[0]!.at));
  await lfs;
});

// --- the route (`POST /sandboxes/:name/fetch`) ------------------------------------------------

const KEY = Buffer.alloc(32, 7);
const INSTANCE_TOKEN = mintInstanceToken();

async function mkApp(fetchRepo?: (sandbox: string, identity: string) => Promise<FetchAnswer>) {
  const host = new RunHost({ store: await mkStore() });
  const auth = createAuthenticator({ instanceToken: INSTANCE_TOKEN, signingKey: KEY });
  return createApp(host, auth, fetchRepo ? { fetchRepo } : {});
}

const ask = (identity: string, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ identity }),
});

test("a Sandbox token asks for its OWN pod, and for no other", async () => {
  const asked: Array<[string, string]> = [];
  const app = await mkApp(async (sandbox, identity) => {
    asked.push([sandbox, identity]);
    return { fetched: AFTER };
  });
  const token = sandboxToken(KEY, "ws-1");

  const mine = await app.request("/sandboxes/ws-1/fetch", ask(APP.identity, token));
  assert.equal(mine.status, 200);
  assert.deepEqual(await mine.json(), { fetched: AFTER });
  assert.deepEqual(asked, [["ws-1", APP.identity]]);

  // The check that keeps one feature's Sandbox from spending the cluster's credential on another's.
  const theirs = await app.request("/sandboxes/ws-2/fetch", ask(APP.identity, token));
  assert.equal(theirs.status, 403);
  assert.equal(asked.length, 1, "and nothing was asked");

  // No token drives nothing here either — knowing a Sandbox's name is not holding its token.
  assert.equal((await app.request("/sandboxes/ws-1/fetch", ask(APP.identity))).status, 401);
  assert.equal((await app.request("/sandboxes/ws-1/fetch", ask(APP.identity, "ws-1"))).status, 401);

  // The Instance token may, on the same grounds it may deliver to any agent surface: it is the
  // operator, and it is never inside a pod (ADR-0013).
  assert.equal((await app.request("/sandboxes/ws-1/fetch", ask(APP.identity, INSTANCE_TOKEN))).status, 200);
});

test("the verdict is relayed unchanged — stale is a 200, because the program serves the cache", async () => {
  const app = await mkApp(async () => ({ stale: "fatal: Authentication failed", asOf: BEFORE }));
  const res = await app.request("/sandboxes/ws-1/fetch", ask(APP.identity, sandboxToken(KEY, "ws-1")));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stale: "fatal: Authentication failed", asOf: BEFORE });
});

test("a Repo this Sandbox does not mount is a 404 naming the identity; a body with no identity is a 400", async () => {
  const app = await mkApp(async (sandbox, identity) => {
    throw new UnmountedRepoError(`Sandbox "${sandbox}" mounts no Repo for "${identity}"`);
  });
  const token = sandboxToken(KEY, "ws-1");

  const missing = await app.request("/sandboxes/ws-1/fetch", ask(OTHER.identity, token));
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /mounts no Repo for "example\.test\/infra"/);

  const empty = await app.request("/sandboxes/ws-1/fetch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  assert.equal(empty.status, 400);
});

test("an instance with no data plane has no cache to ask", async () => {
  // Nothing composes a Sandbox, so nothing holds a Repo cache — and the answer says which, rather
  // than hanging on a cluster the process is not in.
  const app = await mkApp();
  const res = await app.request("/sandboxes/ws-1/fetch", ask(APP.identity, sandboxToken(KEY, "ws-1")));
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /no Workspace/);
});
