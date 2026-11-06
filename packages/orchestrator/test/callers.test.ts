// The Caller seam and its scopes (ADR-0078, ADR-0014). One ordered list of authenticators makes a
// Caller from a bearer; the first that claims it decides, and a claimed bearer that is bad is 401
// and never falls through. Each guarded route needs one scope, for the Workflow of the run or the
// door it addresses, and a 403 names the scope and the Workflow. The principals inside the
// Orchestrator — the publish token, the control and fetch tokens — are never Callers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { configMapDigest } from "../src/mount-digest.ts";
import { DISPATCHED_BY_HEADER, KEY_ONLY_HEADER } from "../src/registration.ts";
import type { Scopes } from "../src/config.ts";
import {
  CALLER_TOKEN_PREFIX,
  callerTokenDigest,
  controlToken,
  createAuthenticator,
  instanceCaller,
  mintCallerToken,
  mintInstanceToken,
  namedTokens,
  sandboxToken,
  watchCallerDigests,
  type Caller,
  type NamedToken,
} from "../src/tokens.ts";
import { gatedDef, mkStore } from "./_fixtures.ts";
import { createMachine } from "xstate";
import type { WorkflowDef } from "../src/run-host.ts";

const KEY = Buffer.alloc(32, 7);
const INSTANCE = mintInstanceToken();

/** A second Workflow with no Gate, so a scope on one Workflow can be checked against the other. */
function quietDef(): WorkflowDef {
  return {
    name: "quiet",
    machine: createMachine({ id: "quiet", initial: "idle", states: { idle: {} } }),
    provide: () => ({}),
  };
}

/** A named token, its value and its entry. */
function named(name: string, may: Scopes): { value: string; entry: NamedToken } {
  const value = mintCallerToken();
  return { value, entry: { name, digest: callerTokenDigest(value), may } };
}

async function mkApp(
  tokens: NamedToken[],
  opts: { cors?: string[]; callers?: Parameters<typeof createAuthenticator>[0]["callers"] } = {},
) {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  host.register(quietDef());
  const auth = createAuthenticator({
    instanceToken: INSTANCE,
    signingKey: KEY,
    publishToken: "publish-token",
    namedTokens: () => tokens,
    ...(opts.callers ? { callers: opts.callers } : {}),
  });
  const app = createApp(host, auth, opts.cors ? { cors: () => opts.cors! } : {});
  return { host, app, auth };
}

const headers = (token?: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});
const get = (token?: string, extra?: Record<string, string>): RequestInit => ({ headers: headers(token, extra) });
const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: headers(token),
  body: JSON.stringify(body),
});

test("the Instance token is the Caller token/instance, with every scope for every Workflow", async () => {
  const { auth } = await mkApp([]);
  assert.deepEqual(await auth(INSTANCE), { kind: "caller", caller: instanceCaller() });
  assert.deepEqual(instanceCaller(), {
    via: "token",
    name: "instance",
    may: { start: "all", answer: "all", cancel: "all", read: "all", steer: "all" },
  });
});

test("a named token is its digest's entry; the value is jr2c_ and 32 bytes, and the Orchestrator keeps the digest", async () => {
  const ci = named("ci", { start: ["gated"] });
  const value = mintCallerToken();
  assert.ok(value.startsWith(CALLER_TOKEN_PREFIX));
  assert.equal(Buffer.from(value.slice(CALLER_TOKEN_PREFIX.length), "base64url").length, 32);
  assert.match(ci.entry.digest, /^[0-9a-f]{64}$/, "sha-256, hex");
  const { auth } = await mkApp([ci.entry]);
  assert.deepEqual(await auth(ci.value), {
    kind: "caller",
    caller: { via: "token", name: "ci", may: { start: ["gated"] } },
  });
});

test("a claimed bearer that is bad is 401 and never falls through to the next authenticator", async () => {
  // A later authenticator that would claim every bearer: it must never see a jr2c_ value.
  const seen: string[] = [];
  const later = (bearer: string): Caller => {
    seen.push(bearer);
    return { via: "jwt", name: "anyone", may: { read: "all" } };
  };
  const { app, auth } = await mkApp([], { callers: [later] });
  const unknown = mintCallerToken();
  assert.equal(await auth(unknown), undefined);
  assert.equal((await app.request("/runs", get(unknown))).status, 401);
  assert.deepEqual(seen, [], "the named-token authenticator claimed it, so the next one never ran");
  // A bearer that no earlier authenticator claims reaches the later one, in order.
  assert.equal((await app.request("/runs", get("not-a-jr2-token"))).status, 200);
  assert.deepEqual(seen, ["not-a-jr2-token"]);
  // The Instance token is first: the later one never sees it either.
  assert.deepEqual(await auth(INSTANCE), { kind: "caller", caller: instanceCaller() });
  assert.deepEqual(seen, ["not-a-jr2-token"]);
});

test("the principals inside the Orchestrator are never Callers, whatever the seam holds", async () => {
  // A seam that would claim everything still never sees a publish, control or fetch token.
  const seen: string[] = [];
  const { app, auth } = await mkApp([], {
    callers: [
      (bearer) => {
        seen.push(bearer);
        return { via: "jwt", name: "anyone", may: { read: "all" } };
      },
    ],
  });
  assert.deepEqual(await auth("publish-token"), { kind: "publisher" });
  assert.equal((await auth(controlToken(KEY, "ws-1"), "root/coder"))?.kind, "agent");
  assert.equal((await auth(sandboxToken(KEY, "ws-1")))?.kind, "sandbox");
  assert.deepEqual(seen, []);
  for (const token of ["publish-token", sandboxToken(KEY, "ws-1")]) {
    assert.equal((await app.request("/runs", get(token))).status, 403);
    assert.equal((await app.request("/whoami", get(token))).status, 403);
  }
});

test("start: a 403 names the scope and the Workflow, and a scope on one Workflow starts it alone", async () => {
  const ci = named("ci", { start: ["gated"] });
  const { app, host } = await mkApp([ci.entry]);
  assert.equal((await app.request("/workflows/gated/runs", post({}, ci.value))).status, 201);
  const refused = await app.request("/workflows/quiet/runs", post({}, ci.value));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: 'the Caller token/ci needs the "start" scope for Workflow "quiet" (ADR-0078)',
    scope: "start",
    workflow: "quiet",
  });
  assert.equal(host.list().filter((s) => s.workflow === "quiet").length, 0, "nothing started");
  // A Caller with no `start` at all is refused by the band, before the Workflow is read.
  const reader = named("reader", { read: "all" });
  const { app: app2 } = await mkApp([reader.entry]);
  const none = await app2.request("/workflows/gated/runs", post({}, reader.value));
  assert.equal(none.status, 403);
  assert.match(((await none.json()) as { error: string }).error, /has no "start" scope for any Workflow/);
});

test("a key-only ask needs `start` on its Workflow, checked before the key is read (ADR-0071, ADR-0078)", async () => {
  const ci = named("ci", { start: ["gated"] });
  const reader = named("reader", { read: "all" });
  const { app, host } = await mkApp([ci.entry, reader.entry]);
  const asked: string[] = [];
  const dispatched = host.dispatched.bind(host);
  host.dispatched = (workflow, key) => {
    asked.push(`${workflow}:${key}`);
    return dispatched(workflow, key);
  };
  const ask = (workflow: string, token: string) =>
    app.request(`/workflows/${workflow}/runs`, {
      method: "POST",
      headers: headers(token, {
        [DISPATCHED_BY_HEADER]: JSON.stringify({ run: "r", slot: "s", effect: "k-1", depth: 1, instance: "ops" }),
        [KEY_ONLY_HEADER]: "true",
      }),
    });
  assert.equal((await ask("quiet", ci.value)).status, 403, "no `start` on this Workflow");
  assert.equal((await ask("gated", reader.value)).status, 403, "no `start` at all");
  assert.deepEqual(asked, [], "the key was never read");
  const allowed = await ask("gated", ci.value);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { existing: false });
  assert.deepEqual(asked, ["gated:k-1"]);
});

test("a Chart wrapper's name opens its named Charts; the Chart's own name opens it alone", async () => {
  const wrapper = named("wrapper", { start: ["plan"] });
  const one = named("one", { start: ["plan/weekly"] });
  const { app: app2 } = await mkApp([wrapper.entry, one.entry]);
  // No such Workflow is registered: 404 means the scope let the request through, 403 that it did not.
  assert.equal((await app2.request("/workflows/plan/charts/weekly/runs", post({}, wrapper.value))).status, 404);
  assert.equal((await app2.request("/workflows/plan/charts/daily/runs", post({}, wrapper.value))).status, 404);
  assert.equal((await app2.request("/workflows/plan/charts/weekly/runs", post({}, one.value))).status, 404);
  assert.equal((await app2.request("/workflows/plan/charts/daily/runs", post({}, one.value))).status, 403);
  assert.equal((await app2.request("/workflows/plan/runs", post({}, one.value))).status, 403);
});

test("read: GET /runs lists only the Caller's Workflows, and a run of another is 403 on each read route", async () => {
  const reader = named("reader", { read: ["gated"] });
  const { app, host } = await mkApp([reader.entry]);
  const gated = await host.start("gated");
  const quiet = await host.start("quiet");
  const { runs: list } = (await (await app.request("/runs", get(reader.value))).json()) as {
    runs: Array<{ runId: string }>;
  };
  assert.deepEqual(
    list.map((r) => r.runId),
    [gated.runId],
  );
  const { runs: full } = (await (await app.request("/runs", get(INSTANCE))).json()) as { runs: unknown[] };
  assert.equal(full.length, 2, "the Instance token's list is every run");
  // The history too: an ended run of another Workflow is left out of the Caller's list.
  await host.cancel(quiet.runId);
  await host.cancel(gated.runId);
  const ended = (await (await app.request("/runs?status=ended", get(reader.value))).json()) as {
    runs: Array<{ runId: string; status: string }>;
  };
  assert.deepEqual(
    ended.runs.map((r) => [r.runId, r.status]),
    [[gated.runId, "cancelled"]],
  );

  assert.equal((await app.request(`/runs/${gated.runId}`, get(reader.value))).status, 200);
  const other = await app.request(`/runs/${quiet.runId}`, get(reader.value));
  assert.equal(other.status, 403);
  assert.deepEqual(((await other.json()) as { workflow: string }).workflow, "quiet");
  const feed = await app.request(`/runs/${quiet.runId}/events`, get(reader.value));
  assert.equal(feed.status, 403);
  await feed.body?.cancel();
});

test("GET /runs/:id: `read` opens the status, `answer` the Gates, and `answer` alone never the context", async () => {
  const both = named("both", { read: "all", answer: "all" });
  const reader = named("reader", { read: "all" });
  const answerer = named("answerer", { answer: "all" });
  const { app, host } = await mkApp([both.entry, reader.entry, answerer.entry]);
  const { runId } = await host.start("gated");
  const view = async (token: string) =>
    (await (await app.request(`/runs/${runId}`, get(token))).json()) as Record<string, unknown>;

  const whole = await view(both.value);
  assert.ok("context" in whole && Array.isArray(whole.gates) && (whole.gates as unknown[]).length === 1);
  const read = await view(reader.value);
  assert.ok("context" in read, "read opens the status");
  assert.equal(read.gates, undefined, "and not the Gates");
  const answer = await view(answerer.value);
  assert.equal(answer.context, undefined, "answer alone never opens the context");
  assert.equal(answer.instanceId, undefined, "nor live infrastructure");
  assert.equal(answer.workflow, "gated");
  const gates = answer.gates as Array<{ gate: string; meta: unknown }>;
  assert.equal(gates[0]?.gate, "F-1");
  assert.deepEqual(gates[0]?.meta, { prUrl: "https://forge/pr/1" }, "the Gate's meta is for the person who answers");
});

test("answer: a Gate of a run of the Caller's Workflow takes its event; another Workflow's is 403", async () => {
  const bridge = named("bridge", { answer: ["gated"] });
  const other = named("other", { answer: ["quiet"] });
  const { app, host } = await mkApp([bridge.entry, other.entry]);
  const { runId } = await host.start("gated");
  const refused = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, other.value));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: 'the Caller token/other needs the "answer" scope for Workflow "gated" (ADR-0078)',
    scope: "answer",
    workflow: "gated",
  });
  assert.equal(host.status(runId)?.value, "review", "the Gate did not move");
  const taken = await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, bridge.value));
  assert.equal(taken.status, 200);
  assert.equal(host.status(runId)?.value, "approved");
});

test("cancel: only a Caller with `cancel` on the run's Workflow ends it", async () => {
  const reader = named("reader", { read: "all", cancel: ["quiet"] });
  const ops = named("ops", { cancel: ["gated"] });
  const { app, host } = await mkApp([reader.entry, ops.entry]);
  const { runId } = await host.start("gated");
  const refused = await app.request(`/runs/${runId}/events`, post({ type: "CANCEL" }, reader.value));
  assert.equal(refused.status, 403);
  assert.equal(host.status(runId)?.status, "active");
  assert.equal((await app.request(`/runs/${runId}/events`, post({ type: "CANCEL" }, ops.value))).status, 200);
});

test("GET /runs/resolve answers any Caller, for the Workflows in any of its scopes", async () => {
  const bridge = named("bridge", { answer: ["gated"] });
  const { app, host } = await mkApp([bridge.entry]);
  const gated = await host.start("gated");
  const quiet = await host.start("quiet");
  const ids = async (token: string, prefix: string) =>
    ((await (await app.request(`/runs/resolve?prefix=${prefix}`, get(token))).json()) as { runIds: string[] }).runIds;
  assert.deepEqual(await ids(bridge.value, gated.runId.slice(0, 8)), [gated.runId]);
  assert.deepEqual(await ids(bridge.value, quiet.runId.slice(0, 8)), [], "a run of another Workflow is not named");
  assert.deepEqual(await ids(INSTANCE, quiet.runId.slice(0, 8)), [quiet.runId]);
});

test("GET /whoami gives the Caller record, with the onBehalfOf claim, to any Caller", async () => {
  const ci = named("ci", {});
  const { app } = await mkApp([ci.entry]);
  const me = await app.request("/whoami", get(ci.value, { "jr2-on-behalf-of": "alice" }));
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { via: "token", name: "ci", may: {}, onBehalfOf: "alice" });
  assert.deepEqual(await (await app.request("/whoami", get(INSTANCE))).json(), instanceCaller());
  assert.equal((await app.request("/whoami")).status, 401);
  const long = await app.request("/whoami", get(ci.value, { "jr2-on-behalf-of": "x".repeat(257) }));
  assert.equal(long.status, 400);
});

test("cors: a listed origin gets the CORS headers and a preflight; any other origin gets none", async () => {
  const { app } = await mkApp([], { cors: ["https://ops.example.com"] });
  const preflight = (origin: string) =>
    app.request("/runs", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
  const ok = await preflight("https://ops.example.com");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://ops.example.com");
  assert.match(ok.headers.get("access-control-allow-headers") ?? "", /authorization/);
  const other = await preflight("https://evil.example.com");
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const read = await app.request("/runs", get(INSTANCE, { origin: "https://ops.example.com" }));
  assert.equal(read.headers.get("access-control-allow-origin"), "https://ops.example.com");
  // No list: no origin is allowed. The Console is same-origin and sends no preflight.
  const { app: closed } = await mkApp([]);
  const none = await closed.request("/runs", get(INSTANCE, { origin: "https://ops.example.com" }));
  assert.equal(none.headers.get("access-control-allow-origin"), null);
});

test("a named token reaches no Instance-only route, whatever its scopes", async () => {
  const every = named("every", { start: "all", answer: "all", cancel: "all", read: "all", steer: "all" });
  const { app } = await mkApp([every.entry]);
  assert.equal((await app.request("/repos", get(every.value))).status, 403);
  assert.equal((await app.request("/repos", get(INSTANCE))).status, 200);
});

test("namedTokens joins the config's names with the digests: no digest, no token; no name, nothing", () => {
  const joined = namedTokens(
    { ci: { may: { start: "all" } }, later: { may: { read: "all" } } },
    { ci: "d1", gone: "d2" },
  );
  assert.deepEqual(joined, [{ name: "ci", digest: "d1", may: { start: "all" } }]);
  assert.deepEqual(namedTokens(undefined, { ci: "d1" }), []);
});

test("the digests file is read again when it changes, so a rotation needs no restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-callers-"));
  const path = join(dir, "digests.json");
  const watched = watchCallerDigests(path, { intervalMs: 10 });
  try {
    assert.deepEqual(watched.current(), {}, "an absent file is no digest");
    const old = mintCallerToken();
    await writeFile(path, JSON.stringify({ ci: callerTokenDigest(old) }));
    watched.reload();
    const tokens = () => namedTokens({ ci: { may: { read: "all" } } }, watched.current());
    const auth = createAuthenticator({ instanceToken: INSTANCE, signingKey: KEY, namedTokens: tokens });
    assert.equal((await auth(old))?.kind, "caller");

    // A rotation, as the kubelet writes it: a new file swapped into place.
    const next = mintCallerToken();
    await writeFile(join(dir, "next.json"), JSON.stringify({ ci: callerTokenDigest(next) }));
    await rename(join(dir, "next.json"), path);
    for (let i = 0; i < 200 && (await auth(next)) === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await auth(next))?.kind, "caller", "the poll read the new digest");
    assert.equal(await auth(old), undefined, "and the old value stopped working");
  } finally {
    watched.stop();
  }
});

test("the digests watcher reports the content it loaded, as `jr2 up` digests what it applied, and keeps it through a bad write (ADR-0078)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-callers-"));
  const path = join(dir, "digests.json");
  const watched = watchCallerDigests(path, { intervalMs: 60_000 });
  try {
    assert.equal(watched.loaded(), undefined, "no file read: nothing loaded");
    const text = JSON.stringify({ ci: callerTokenDigest(mintCallerToken()) });
    await writeFile(path, text);
    // Not read yet: the report is what the authenticator holds, not what the file holds.
    assert.equal(watched.loaded(), undefined);
    watched.reload();
    // The same form as a Secret's `stringData`, keyed by the file's name.
    assert.equal(watched.loaded(), configMapDigest({ "digests.json": text }));

    // A write seen half done keeps the digests read last, and so the digest of their content.
    await writeFile(path, "{ half");
    watched.reload();
    assert.equal(watched.loaded(), configMapDigest({ "digests.json": text }));

    await rm(path);
    watched.reload();
    assert.equal(watched.loaded(), undefined, "an absent file holds no digest");
  } finally {
    watched.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- The Caller recorded on each act (ADR-0078) -------------------------------------------------

test("the run records the Caller of each act on a guarded route: startedBy, answeredBy, cancelledBy — and the open band none", async () => {
  const ci = named("ci", { start: "all", read: "all" });
  const bridge = named("bridge", { answer: ["gated"] });
  const ops = named("ops", { cancel: "all", read: "all" });
  const { host, app } = await mkApp([ci.entry, bridge.entry, ops.entry]);

  const started = await app.request("/workflows/gated/runs", {
    method: "POST",
    headers: headers(ci.value, { "jr2-on-behalf-of": "alice" }),
    body: "{}",
  });
  assert.equal(started.status, 201);
  const { runId } = (await started.json()) as { runId: string };
  const full = (await (await app.request(`/runs/${runId}`, get(ci.value))).json()) as Record<string, unknown>;
  assert.deepEqual(full.startedBy, { kind: "caller", via: "token", name: "ci", onBehalfOf: "alice" });

  // Never on the open projection, nor to a Caller with `answer` alone (ADR-0014).
  const open = (await (await app.request("/workflows/gated/runs")).json()) as Array<Record<string, unknown>>;
  assert.equal(open.length, 1);
  for (const field of ["startedBy", "cancelledBy", "answers"]) assert.equal(field in open[0]!, false, field);
  const answerOnly = (await (await app.request(`/runs/${runId}`, get(bridge.value))).json()) as Record<string, unknown>;
  assert.equal("startedBy" in answerOnly, false);

  assert.equal(
    (await app.request(`/runs/${runId}/gates/F-1/events`, post({ type: "approve" }, bridge.value))).status,
    200,
  );
  const answered = (await host.read(runId))!;
  assert.deepEqual(
    answered.answers?.map(({ gate, type, answeredBy }) => ({ gate, type, answeredBy })),
    [{ gate: "F-1", type: "approve", answeredBy: { via: "token", name: "bridge" } }],
  );

  const second = await app.request("/workflows/gated/runs", post({}, ci.value));
  const other = ((await second.json()) as { runId: string }).runId;
  assert.equal((await app.request(`/runs/${other}/events`, post({ type: "CANCEL" }, ops.value))).status, 200);
  const cancelled = (await (await app.request(`/runs/${other}`, get(ops.value))).json()) as Record<string, unknown>;
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.cancelledBy, { via: "token", name: "ops" });
  assert.deepEqual(cancelled.startedBy, { kind: "caller", via: "token", name: "ci" });
});
