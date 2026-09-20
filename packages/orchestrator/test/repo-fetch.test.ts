// The ask a pod makes when something inside it fetches (ADR-0053), both halves: the port that
// marks the Sandbox CR and waits on its status, and the route the Adapter reaches it through.
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
// Socket-free, like the neighbours: a fake kubectl seam for the port, `app.request` for the route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http.ts";
import {
  kubectlRepoFetches,
  UnmountedRepoError,
  type FetchAnswer,
  type KubectlRepoFetchesOptions,
} from "../src/repo-fetch.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { RunHost } from "../src/run-host.ts";
import type { KubectlExec } from "../src/sandbox-kubectl.ts";
import { createAuthenticator, mintInstanceToken, sandboxToken } from "../src/tokens.ts";
import { mkStore } from "./_fixtures.ts";

const APP = repoIdentity("git@github.com:acme/app.git");
const OTHER = repoIdentity("https://example.test/infra.git");

/** A fixed instant to ask at, the second it is raised to (what the operator publishes as the
 * entry's own `asked`), and the two stamps that straddle it. */
const ASKED = "2026-09-13T12:00:00.500Z";
const ASKED_AT = "2026-09-13T12:00:01Z";
const BEFORE = "2026-09-13T11:55:00Z";
const AFTER = "2026-09-13T12:00:07Z";

type Entry = { key: string; asked?: string; fetched?: string; attempted?: string; error?: string };
type Call = { args: string[] };

/**
 * A Sandbox as kubectl prints it, read `reads` times: `spec.repos` is fixed (what the pod mounts)
 * and each read takes the next status in the script, the last one repeating. Reads happen in
 * order: the scope check, the annotate (which prints the object it patched), then each poll.
 */
function fakeCluster(mounts: string[], script: Array<Entry[] | undefined>) {
  const calls: Call[] = [];
  let read = 0;
  const exec: KubectlExec = async (args) => {
    calls.push({ args });
    if (args[0] !== "get" && args[0] !== "annotate") throw new Error(`unexpected kubectl ${args[0]}`);
    const repos = script[Math.min(read++, script.length - 1)];
    return {
      stdout: JSON.stringify({
        spec: { repos: mounts.map((key) => ({ key })) },
        ...(repos ? { status: { repos } } : {}),
      }),
      stderr: "",
    };
  };
  return { exec, calls };
}

const mkPort = (exec: KubectlExec, opts: Partial<KubectlRepoFetchesOptions> = {}) =>
  kubectlRepoFetches({ namespace: "inst", exec, pollMs: 0, now: () => new Date(ASKED), ...opts });

/** A cluster whose status answers nothing until `land()` is called — so a test can hold an ask
 * open and make a second one while the first is still waiting. */
function heldCluster(mounts: string[], pending: Entry[], landed: Entry[]) {
  const calls: Call[] = [];
  let answering = false;
  const exec: KubectlExec = async (args) => {
    calls.push({ args });
    return {
      stdout: JSON.stringify({
        spec: { repos: mounts.map((key) => ({ key })) },
        status: { repos: answering ? landed : pending },
      }),
      stderr: "",
    };
  };
  const settled = () => new Promise((r) => setTimeout(r, 10));
  return {
    exec,
    calls,
    settled,
    land: () => {
      answering = true;
    },
  };
}

test("the ask marks the Sandbox CR per key, and the landing answers it", async () => {
  const { exec, calls } = fakeCluster(
    [APP.key],
    [undefined, [], [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }]],
  );
  assert.deepEqual(await mkPort(exec).fetch("sb-1", APP.identity), { fetched: AFTER });

  // The mark: one annotation, named by the KEY (the operator and the cache agent read it there),
  // valued with the instant of the ask — RFC3339 with milliseconds, because a second's truncation
  // is a whole coalescing window. `--overwrite` because a later ask replaces an earlier one.
  const annotate = calls.find((c) => c.args[0] === "annotate")!;
  assert.deepEqual(annotate.args.slice(0, 3), ["annotate", "sandbox", "sb-1"]);
  assert.ok(annotate.args.includes(`jr2.dev/asked-${APP.key}=${ASKED}`), annotate.args.join(" "));
  assert.ok(annotate.args.includes("--overwrite"));
  assert.deepEqual(annotate.args.slice(3, 5), ["--namespace", "inst"]);
  // And it prints the object it patched, so the first look at the status costs no second trip.
  assert.ok(annotate.args.includes("-o"), "the patch reads back");
});

test("a fetch that landed BEFORE the ask does not answer it", async () => {
  // The whole reason the agent stamps `lastFetched` with the attempt's START: a fetch already in
  // flight when the ask arrived says nothing about the remote's now. The status may also simply be
  // the reconcile before the mark was seen — same shape, same answer: keep waiting.
  const { exec, calls } = fakeCluster(
    [APP.key],
    [
      undefined,
      [{ key: APP.key, asked: BEFORE, fetched: BEFORE, attempted: BEFORE }],
      [{ key: APP.key, asked: BEFORE, fetched: BEFORE, attempted: BEFORE }],
      [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
    ],
  );
  assert.deepEqual(await mkPort(exec).fetch("sb-1", APP.identity), { fetched: AFTER });
  assert.ok(calls.filter((c) => c.args[0] === "get").length >= 2, "it kept looking");
});

test("an entry from BEFORE the mark settles nothing, and a fetch begun in the ask's own second is not a landing", async () => {
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
  const { exec } = fakeCluster(
    [APP.key],
    [
      undefined,
      [{ key: APP.key, asked: BEFORE, fetched: AFTER, attempted: AFTER }],
      [{ key: APP.key, asked: ASKED_AT, fetched: second, attempted: second }],
      [{ key: APP.key, asked: ASKED_AT, fetched: ASKED_AT, attempted: ASKED_AT }],
    ],
  );
  assert.deepEqual(await mkPort(exec).fetch("sb-1", APP.identity), { fetched: ASKED_AT });
});

test("a failed remote fetch is STALE with git's own words, never an error", async () => {
  // ADR-0051's stance, kept: the program falls through to the objects the cache holds and writes
  // one warning line. So this is a 200 with a verdict, not a refusal — and `asOf` is whatever the
  // status says the cache holds, relayed as-is.
  const { exec } = fakeCluster(
    [APP.key],
    [undefined, [{ key: APP.key, asked: ASKED_AT, attempted: AFTER, error: "fatal: Authentication failed" }]],
  );
  assert.deepEqual(await mkPort(exec).fetch("sb-1", APP.identity), {
    stale: "fatal: Authentication failed",
    asOf: null,
  });

  const older = fakeCluster(
    [APP.key],
    [
      undefined,
      [{ key: APP.key, asked: ASKED_AT, fetched: BEFORE, attempted: AFTER, error: "fatal: no route to host" }],
    ],
  );
  assert.deepEqual(await mkPort(older.exec).fetch("sb-1", APP.identity), {
    stale: "fatal: no route to host",
    asOf: BEFORE,
  });
});

test("an attempt that predates the ask is not this ask's verdict", async () => {
  // A standing error from the last interval must not settle a fetch asked after it — the caller
  // would be told the remote is unreachable on the strength of a minutes-old attempt.
  const { exec } = fakeCluster(
    [APP.key],
    [
      undefined,
      [{ key: APP.key, asked: BEFORE, attempted: BEFORE, error: "fatal: Authentication failed" }],
      [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
    ],
  );
  assert.deepEqual(await mkPort(exec).fetch("sb-1", APP.identity), { fetched: AFTER });
});

test("the wait ends with the budget, and answers the cache — the ask never fails a fetch", async () => {
  const { exec } = fakeCluster([APP.key], [undefined, [{ key: APP.key, asked: ASKED_AT }]]);
  assert.deepEqual(await mkPort(exec, { budgetMs: 0 }).fetch("sb-1", APP.identity), {
    stale: "timed out waiting for the node cache",
    asOf: null,
  });
});

test("a Repo the Sandbox does not mount is refused, and nothing is marked", async () => {
  // The Sandbox token's scope is the caches ITS pod mounts (ADR-0013/0053). Refused before the
  // mark, so an ask for someone else's Repo leaves no annotation behind on this CR.
  const { exec, calls } = fakeCluster([OTHER.key], [undefined]);
  await assert.rejects(() => mkPort(exec).fetch("sb-1", APP.identity), UnmountedRepoError);
  assert.equal(calls.filter((c) => c.args[0] === "annotate").length, 0, "the refusal writes nothing");

  // The ask names the IDENTITY, and exactly: the url it was resolved from derives a different
  // string, so it derives a different key, and this Sandbox mounts no such Repo.
  const spelled = fakeCluster([APP.key], [undefined]);
  await assert.rejects(() => mkPort(spelled.exec).fetch("sb-1", "git@github.com:acme/app.git"), /mounts no Repo/);
});

test("a Sandbox that is not there is refused, not waited on", async () => {
  const exec: KubectlExec = async (args) => {
    if (args[0] === "get") throw new Error('Error from server (NotFound): sandboxes "sb-gone" not found');
    throw new Error(`unexpected kubectl ${args[0]}`);
  };
  await assert.rejects(() => mkPort(exec).fetch("sb-gone", APP.identity), UnmountedRepoError);
});

test("asks that raise the same bar share one mark and one wait", async () => {
  // The coalescer, one hop before the node's: the caller is inside an untrusted pod (ADR-0013),
  // and an Agent that loops on `git fetch` would otherwise cost this process one CR write and one
  // `kubectl` per second per iteration — in the single process that serves every run in the
  // instance. Two asks that raise the same second cannot get different answers, so they get one
  // answer.
  const held = heldCluster(
    [APP.key],
    [{ key: APP.key, asked: ASKED_AT }],
    [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
  );
  const port = mkPort(held.exec);

  const first = port.fetch("sb-1", APP.identity);
  await held.settled();
  const second = port.fetch("sb-1", APP.identity);
  held.land();

  assert.deepEqual(await first, { fetched: AFTER });
  assert.deepEqual(await second, { fetched: AFTER });
  assert.equal(held.calls.filter((c) => c.args[0] === "annotate").length, 1, "one ask, one mark");

  // And once it has answered, the seat is free: the next fetch is a new ask, with its own mark.
  assert.deepEqual(await port.fetch("sb-1", APP.identity), { fetched: AFTER });
  assert.equal(held.calls.filter((c) => c.args[0] === "annotate").length, 2);
});

test("an ask that raises a LATER bar waits on its own fetch", async () => {
  // Sharing is exact, not approximate: an ask a second later needs a fetch that began after IT,
  // which the wait already running cannot promise. So it marks the CR again and waits itself.
  let clock = ASKED;
  const later = "2026-09-13T12:00:02.000Z";
  const held = heldCluster(
    [APP.key],
    [{ key: APP.key, asked: ASKED_AT }],
    [{ key: APP.key, asked: later, fetched: AFTER, attempted: AFTER }],
  );
  const port = mkPort(held.exec, { now: () => new Date(clock) });

  const first = port.fetch("sb-1", APP.identity);
  await held.settled();
  clock = later;
  const second = port.fetch("sb-1", APP.identity);
  held.land();

  await Promise.all([first, second]);
  const marks = held.calls.filter((c) => c.args[0] === "annotate");
  assert.equal(marks.length, 2, "a later ask is its own ask");
  assert.ok(marks[1]!.args.includes(`jr2.dev/asked-${APP.key}=${later}`), marks[1]!.args.join(" "));
});

test("past the cap an ask is answered with the cache, and nothing is marked", async () => {
  // The flood's answer is the decision's own stance: freshness degrades, absence does not. The
  // interval keeps refreshing the cache, so what the caller loses is the round trip, not the
  // objects — and it is told, because the program warns on a stale answer.
  const held = heldCluster(
    [APP.key, OTHER.key],
    [
      { key: APP.key, asked: ASKED_AT },
      { key: OTHER.key, asked: ASKED_AT, fetched: BEFORE },
    ],
    [{ key: APP.key, asked: ASKED_AT, fetched: AFTER, attempted: AFTER }],
  );
  const port = mkPort(held.exec, { maxInFlight: 1 });

  const first = port.fetch("sb-1", APP.identity);
  await held.settled();
  assert.deepEqual(await port.fetch("sb-1", OTHER.identity), {
    stale: "the orchestrator is holding too many fetches at once",
    asOf: BEFORE,
  });
  assert.equal(held.calls.filter((c) => c.args[0] === "annotate").length, 1, "the refused ask marks nothing");
  held.land();
  assert.deepEqual(await first, { fetched: AFTER });
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
