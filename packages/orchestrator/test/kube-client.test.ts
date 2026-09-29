// The Orchestrator's Kubernetes client and its one watch (ADR-0063), against the fake API server
// (_fake-kube.ts) — socket-free. What is pinned here are the rules ADR-0063 observed on a real
// cluster: the token is read on every request and a 401 re-reads it once; writes are capped; a
// watch resumes from the last bookmark's resourceVersion, treats fetch's body timeout as a resume,
// and re-lists on any ERROR event (410 arrives inside an HTTP 200); and a dropped watch tells a
// subscriber nothing.

import { getEventListeners } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPOS, SANDBOXES, SECRETS, KubeError, inClusterBaseUrl, kubeClient } from "../src/kube-client.ts";
import { watchSandboxes, type SandboxObject } from "../src/sandbox-watch.ts";
import { fakeKube } from "./_fake-kube.ts";
import { waitFor } from "./_fixtures.ts";

const NS = "inst";
const BASE = "https://kube.test";

const clientOf = (api: ReturnType<typeof fakeKube>, extra: { maxWrites?: number } = {}) =>
  kubeClient({ baseUrl: BASE, fetch: api.fetch, token: async () => api.token, ...extra });

const sandbox = (name: string, labels: Record<string, string> = { "jr2.dev/run": "r" }) => ({
  apiVersion: "core.jr2.dev/v1alpha1",
  kind: "Sandbox",
  metadata: { name, namespace: NS, labels },
});

test("the in-cluster base URL is the API Service the kubelet injects; absent, a named refusal", () => {
  assert.equal(
    inClusterBaseUrl({ KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" }),
    "https://10.96.0.1:443",
  );
  assert.equal(inClusterBaseUrl({ KUBERNETES_SERVICE_HOST: "fd00::1" }), "https://[fd00::1]:443");
  assert.throws(() => inClusterBaseUrl({}), /KUBERNETES_SERVICE_HOST is unset/);
});

test("the token is read on EVERY request, never cached", async () => {
  const api = fakeKube();
  let reads = 0;
  const client = kubeClient({
    baseUrl: BASE,
    fetch: api.fetch,
    token: async () => (reads++, api.token),
  });
  await client.get(SANDBOXES, NS, "a");
  api.token = "t1"; // the kubelet rotated the file
  await client.get(SANDBOXES, NS, "a");
  assert.equal(reads, 2);
  assert.deepEqual(
    api.calls.map((c) => c.token),
    ["t0", "t1"],
  );
});

test("a 401 re-reads the token and retries ONCE; a second 401 is the answer", async () => {
  const api = fakeKube();
  const client = clientOf(api);
  api.refuseAuth(1);
  assert.equal(await client.get(SANDBOXES, NS, "a"), undefined, "retried, and the retry was answered");
  assert.equal(api.calls.length, 2);

  api.refuseAuth(2);
  await assert.rejects(
    () => client.get(SANDBOXES, NS, "a"),
    (err: unknown) => err instanceof KubeError && err.status === 401,
  );
  assert.equal(api.calls.length, 4, "once, not forever");
});

test("REST for jr2's kinds: create (409 on a second), get, list by label, merge patch, apply, delete", async () => {
  const api = fakeKube();
  const client = clientOf(api);

  const made = await client.create(REPOS, NS, {
    apiVersion: "core.jr2.dev/v1alpha1",
    kind: "Repo",
    metadata: { name: "k" },
  });
  assert.ok(made.metadata?.uid);
  await assert.rejects(
    () => client.create(REPOS, NS, { metadata: { name: "k" } }),
    (err: unknown) => err instanceof KubeError && err.status === 409 && err.reason === "AlreadyExists",
  );
  assert.equal((await client.get(REPOS, NS, "k"))?.metadata?.name, "k");
  assert.equal(await client.get(REPOS, NS, "absent"), undefined);

  await client.create(SANDBOXES, NS, sandbox("a"));
  await client.create(SANDBOXES, NS, sandbox("b", { other: "x" }));
  const listed = await client.list(SANDBOXES, NS, { labelSelector: "jr2.dev/run" });
  assert.deepEqual(
    listed.items.map((i) => i.metadata?.name),
    ["a"],
  );
  assert.ok(listed.resourceVersion);

  const patched = await client.patch(SANDBOXES, NS, "a", { metadata: { annotations: { x: "1" } } });
  assert.equal(patched.metadata?.annotations?.x, "1", "a merge patch answers the object as it stands");
  const patch = api.calls.at(-1)!;
  assert.equal(patch.contentType, "application/merge-patch+json");

  await client.patch(SANDBOXES, NS, "a", { status: { phase: "Ready" } }, { status: true });
  assert.equal(api.calls.at(-1)!.target, "sandboxes/a/status");

  const applied = await client.apply(SECRETS, NS, { apiVersion: "v1", kind: "Secret", metadata: { name: "s" } });
  assert.ok(applied.metadata?.uid, "the apply answers the object, uid included");
  const apply = api.calls.at(-1)!;
  assert.equal(apply.method, "PATCH");
  assert.equal(apply.contentType, "application/apply-patch+yaml");
  assert.deepEqual(apply.query, { fieldManager: "jr2", force: "true" });

  assert.equal(await client.delete(SECRETS, NS, "s"), true);
  assert.equal(await client.delete(SECRETS, NS, "s"), false, "absent is not an error");
});

test("a refusal carries the Status body's reason and words", async () => {
  const api = fakeKube();
  api.refuse((c) =>
    c.method === "POST" ? api.status(403, "Forbidden", 'sandboxes is forbidden: User "x"') : undefined,
  );
  await assert.rejects(
    () => clientOf(api).create(SANDBOXES, NS, sandbox("a")),
    (err: unknown) =>
      err instanceof KubeError && err.status === 403 && /Forbidden.*sandboxes is forbidden/.test(err.message),
  );
});

test("writes are capped: 40 at once never put more than the cap in flight", async () => {
  const api = fakeKube();
  const client = clientOf(api, { maxWrites: 8 });
  const release = api.holdWrites();
  const all = Array.from({ length: 40 }, (_, i) => client.create(SECRETS, NS, { metadata: { name: `s${i}` } }));
  await waitFor(() => api.inFlight === 8);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(api.inFlight, 8, "the rest queue in the client, not at the server");
  release();
  await Promise.all(all);
  assert.equal(api.maxInFlight, 8);
  // Reads are not writes: they never queue behind them.
  const hold = api.holdWrites();
  const blocked = client.create(SECRETS, NS, { metadata: { name: "late" } });
  assert.equal(await client.get(SECRETS, NS, "s0").then((o) => o?.metadata?.name), "s0");
  hold();
  await blocked;
});

// --- the watch ------------------------------------------------------------------------------

/** Everything a subscriber heard, per name: the object's rv, or "gone". */
function recorder(watch: ReturnType<typeof watchSandboxes>, name: string) {
  const heard: string[] = [];
  watch.subscribe(name, (o?: SandboxObject) => heard.push(o ? `rv${o.metadata?.resourceVersion}` : "gone"));
  return heard;
}

test("the first list is the reconcile: every waiting subscriber hears it, present or not", async (t) => {
  const api = fakeKube();
  api.seed("sandboxes", sandbox("here"));
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 5 });
  t.after(() => watch.stop());
  const here = recorder(watch, "here");
  const gone = recorder(watch, "gone-before-restart");
  await watch.synced();
  await waitFor(() => here.length === 1 && gone.length === 1);
  assert.match(here[0]!, /^rv\d+$/);
  assert.deepEqual(gone, ["gone"], "absent from the list is an answer: gone");
  // A subscriber after the sync hears what the cache holds, at once.
  const late: string[] = [];
  watch.subscribe("here", (o) => late.push(o ? "present" : "gone"));
  await waitFor(() => late.length === 1);
  assert.deepEqual(late, ["present"]);
});

test("events reach the subscriber: MODIFIED, then DELETED as gone", async (t) => {
  const api = fakeKube();
  api.seed("sandboxes", sandbox("a"));
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 5 });
  t.after(() => watch.stop());
  await watch.synced();
  const heard: Array<string | undefined> = [];
  watch.subscribe("a", (o) => heard.push(o?.status?.phase ?? (o ? "none" : "gone")));
  await waitFor(() => api.openWatches === 1);
  api.setStatus("sandboxes", "a", { phase: "Ready" });
  api.remove("sandboxes", "a");
  await waitFor(() => heard.length === 3);
  assert.deepEqual(heard, ["none", "Ready", "gone"]);
  assert.equal(watch.get("a"), undefined);
});

test("a closed watch resumes from the LAST BOOKMARK's resourceVersion, not the list's", async (t) => {
  const api = fakeKube();
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 5 });
  t.after(() => watch.stop());
  await watch.synced();
  await waitFor(() => api.openWatches === 1);
  const first = api.watchCalls()[0]!;
  assert.equal(first.query.allowWatchBookmarks, "true");
  assert.equal(first.query.timeoutSeconds, "240");
  assert.equal(first.query.labelSelector, "jr2.dev/run", "this Instance's Sandboxes only");

  const marked = api.bookmark("sandboxes");
  await new Promise((r) => setTimeout(r, 5));
  api.closeWatches(); // the server's timeoutSeconds
  await waitFor(() => api.watchCalls().length === 2);
  assert.equal(api.watchCalls()[1]!.query.resourceVersion, marked, "resumed from the bookmark");
  assert.equal(api.listCalls("sandboxes").length, 1, "a resume is not a re-list");
});

test("fetch's body timeout (UND_ERR_BODY_TIMEOUT) is a resume, not a failure", async (t) => {
  const api = fakeKube();
  const lines: string[] = [];
  const watch = watchSandboxes(clientOf(api), { namespace: NS, log: (l) => lines.push(l), backoffMs: 60_000 });
  t.after(() => watch.stop());
  await watch.synced();
  await waitFor(() => api.openWatches === 1);
  const rv = api.watchCalls()[0]!.query.resourceVersion;
  api.stallWatches();
  // backoffMs is a minute: resuming at once proves it was not treated as a failure.
  await waitFor(() => api.watchCalls().length === 2);
  assert.equal(api.watchCalls()[1]!.query.resourceVersion, rv);
  assert.equal(api.listCalls("sandboxes").length, 1);
  assert.deepEqual(lines, [], "nothing to report");
});

test("an ERROR event with code 410 inside an HTTP 200 → re-list, and the cache is the new list", async (t) => {
  const api = fakeKube();
  api.seed("sandboxes", sandbox("a"));
  api.seed("sandboxes", sandbox("b"));
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 5 });
  t.after(() => watch.stop());
  await watch.synced();
  await waitFor(() => api.openWatches === 1);
  const b = recorder(watch, "b");
  await waitFor(() => b.length === 1);

  // While the watch was away, b went. The resume is too old: the server says so with ERROR 410.
  api.closeWatches();
  api.remove("sandboxes", "b");
  api.compact();
  await waitFor(() => api.listCalls("sandboxes").length === 2);
  await waitFor(() => b.length === 2);
  assert.equal(b[1], "gone", "the re-list is authoritative: gone is gone");
  assert.ok(watch.get("a"), "unchanged names stay");
});

test("ANY error event re-lists, not only 410", async (t) => {
  const api = fakeKube();
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 5 });
  t.after(() => watch.stop());
  await watch.synced();
  await waitFor(() => api.openWatches === 1);
  api.errorWatches(500);
  await waitFor(() => api.listCalls("sandboxes").length === 2);
});

test("a dropped watch tells a subscriber NOTHING — unknown is never loss", async (t) => {
  const api = fakeKube();
  api.seed("sandboxes", sandbox("a"));
  let down = false;
  api.refuse(() => (down ? new Response("connection refused", { status: 503 }) : undefined));
  const lines: string[] = [];
  const watch = watchSandboxes(clientOf(api), { namespace: NS, backoffMs: 1, log: (l) => lines.push(l) });
  t.after(() => watch.stop());
  await watch.synced();
  const a = recorder(watch, "a");
  await waitFor(() => a.length === 1);
  down = true;
  api.closeWatches();
  await waitFor(() => lines.length >= 3);
  assert.deepEqual(a.length, 1, "the API server is away; nothing was said about the Sandbox");
  assert.ok(watch.get("a"), "the cache keeps the last word");
  down = false;
  await waitFor(() => api.openWatches === 1);
});

test("a back-off leaves no listener behind on the loop's signal", async (t) => {
  // A watch the server closes at once with nothing said: the loop beats (a sleep) and resumes, over
  // and over. Each sleep must take its abort listener with it, or a long outage grows them unbounded.
  let signal: AbortSignal | undefined;
  let watches = 0;
  const client = {
    list: async () => ({ items: [], resourceVersion: "1" }),
    watch: (_plural: unknown, _ns: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal;
      watches++;
      return (async function* () {})();
    },
  } as unknown as Parameters<typeof watchSandboxes>[0];
  const watch = watchSandboxes(client, { namespace: NS, backoffMs: 1 });
  t.after(() => watch.stop());
  await waitFor(() => watches >= 30);
  assert.ok(getEventListeners(signal!, "abort").length <= 1, "one sleep's listener at most, never one per back-off");
});
