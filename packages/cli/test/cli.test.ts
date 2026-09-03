// `main` dispatch + output discipline (ADR-0009), end-to-end through the verbs against a socket-free
// app (injected via `io.fetch` + `J2_URL`). Asserts the stdout=result / stderr=activity split, exit
// codes, and that `run` streams then prints the terminal RunStatus as the one stdout line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import type { Io } from "../src/output.ts";
import { mkHarness } from "./_fixtures.ts";

type Captured = { io: Io; out: () => string; err: () => string };

function mkIo(over: Partial<Io>): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/", ...over };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("unknown command → exit 2 with a notice on stderr", async () => {
  const { io, err } = mkIo({});
  assert.equal(await main(["frobnicate"], io), 2);
  assert.match(err(), /unknown command/);
});

test("help → exit 0", async () => {
  const { io } = mkIo({});
  assert.equal(await main(["--help"], io), 0);
});

test("a run-control verb with no orchestrator → exit 1 error on stderr", async () => {
  // cwd "/" has no j2.config.ts above it, and no --url/J2_URL → resolveBaseUrl throws.
  const { io, err } = mkIo({ cwd: "/", env: {} });
  assert.equal(await main(["runs"], io), 1);
  assert.match(err(), /error:/);
});

test("run attaches: terminal RunStatus on stdout, activity on stderr", async () => {
  const { app } = await mkHarness();
  const { io, out, err } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });

  assert.equal(await main(["run", "feed"], io), 0);

  const lines = out().trim().split("\n");
  const terminal = JSON.parse(lines[lines.length - 1] ?? "{}") as { status: string };
  assert.equal(terminal.status, "done", "the one stdout line is the terminal RunStatus");
  assert.match(err(), /→ done/, "status deltas stream to stderr");
});

test("run --detach prints only the runId on stdout", async () => {
  const { app } = await mkHarness();
  const { io, out } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });

  assert.equal(await main(["run", "loop", "--detach"], io), 0);
  const printed = JSON.parse(out().trim()) as { runId?: string };
  assert.ok(printed.runId, "detach prints the runId");
});

test("runs lists live runs as JSON on stdout", async () => {
  const { app, client } = await mkHarness();
  const { runId } = await client.start("loop");
  const { io, out } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });

  assert.equal(await main(["runs"], io), 0);
  const list = JSON.parse(out().trim()) as Array<{ runId: string }>;
  assert.ok(list.some((r) => r.runId === runId));
});

// ---- Abbreviated run ids (ADR-0009) -------------------------------------------------------------
// Git's short-hash affordance on every verb that takes a run id. Prefix only; ambiguity FAILS rather
// than guessing, which is what makes it safe to put in front of `send`'s writes.

test("status resolves an abbreviated run id", async () => {
  const { app, host } = await mkHarness();
  const { runId } = await host.start("loop");
  const { io, out } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });

  assert.equal(await main(["status", runId.slice(0, 8)], io), 0);
  assert.equal((JSON.parse(out()) as { runId: string }).runId, runId, "the full run, off a prefix");
});

test("a full run id is used as-is — no resolution round trip", async () => {
  const { app, host } = await mkHarness();
  const { runId } = await host.start("loop");
  const seen: string[] = [];
  const { io } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => {
      seen.push(String(url));
      return Promise.resolve(app.request(url, init));
    },
  });

  assert.equal(await main(["status", runId], io), 0);
  assert.ok(
    !seen.some((u) => u.includes("/runs/resolve")),
    "the fast path keeps scripted pipelines on exactly the traffic they issue today",
  );
});

test("an ambiguous prefix fails and lists the candidates", async () => {
  const { app, store } = await mkHarness();
  await store.save("beef1111-0000-0000-0000-000000000000", {});
  await store.save("beef2222-0000-0000-0000-000000000000", {});
  const { io, out, err } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });

  assert.equal(await main(["status", "beef"], io), 1);
  assert.match(err(), /ambiguous/);
  assert.match(err(), /beef1111-0000-0000-0000-000000000000/);
  assert.match(err(), /beef2222-0000-0000-0000-000000000000/);
  assert.equal(out(), "", "an unresolved id prints no result");
});

test("an instance predating /runs/resolve is reported as skew, not as a run named 'resolve'", async () => {
  // The pre-a09b362 orchestrator: no static `/runs/resolve`, so the request falls through to
  // `/runs/:runId`, which captures the literal "resolve" and 404s naming it. The CLI must not
  // repeat that back — the user asked about "beef1234", not about a run called "resolve".
  const { io, out, err } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url) => {
      if (String(url).includes("/healthz")) {
        return Promise.resolve(Response.json({ ok: true, version: "0.0.9", hash: "c0ffee123456" }));
      }
      return Promise.resolve(Response.json({ error: 'no run "resolve"' }, { status: 404 }));
    },
  });

  assert.equal(await main(["status", "beef1234"], io), 1);
  assert.doesNotMatch(err(), /no run "resolve"/, "the old server's message must not be echoed verbatim");
  assert.match(err(), /does not support abbreviated run ids/);
  assert.match(err(), /beef1234/, "the id the user actually typed");
  assert.match(err(), /0\.0\.9 \(c0ffee123456\)/, "what the deployed instance says it is");
  assert.match(err(), /full run id|j2 up/, "a way out, before a rollout they may not want now");
  assert.equal(out(), "", "an unresolved id prints no result");
});

test("a prefix under the floor is a usage error; an unmatched one is a runtime error", async () => {
  const { app } = await mkHarness();
  const mk = () =>
    mkIo({ env: { J2_URL: "http://test" }, fetch: (url, init) => Promise.resolve(app.request(url, init)) });

  const short = mk();
  assert.equal(await main(["status", "ab"], short.io), 2, "a malformed argument is usage");
  assert.match(short.err(), /too short/);

  const missing = mk();
  assert.equal(await main(["status", "abcdef12"], missing.io), 1, "a well-formed id that matches nothing is runtime");
  assert.match(missing.err(), /no run/);
});

test("send resolves before it writes — an unresolvable id never reaches CANCEL", async () => {
  const { app, host } = await mkHarness();
  const { runId } = await host.start("loop");
  const mk = () =>
    mkIo({ env: { J2_URL: "http://test" }, fetch: (url, init) => Promise.resolve(app.request(url, init)) });

  // `host.stop()` returns silently for an unknown run, so before resolution this reported success.
  const bogus = mk();
  assert.equal(await main(["send", "abcdef12", "--event", "CANCEL"], bogus.io), 1);
  assert.match(bogus.err(), /no run/);
  assert.equal(host.status(runId)?.status, "active", "and the real run is untouched");

  const real = mk();
  assert.equal(await main(["send", runId.slice(0, 8), "--event", "CANCEL"], real.io), 0);
  assert.match(real.err(), new RegExp(`sent CANCEL to ${runId}`), "the message names the run it actually hit");
});

test("`j2 status` with no run reports the instance's repos, unsynced ones with git's own error", async () => {
  // ADR-0048's third claim: the reconcile degrades a repo instead of the daemon, so the way to
  // learn a repo never synced is to ask the instance — not to tail pod logs for a boot line.
  const repos = [
    { name: "app", synced: false, error: "git clone failed: Permission denied (publickey).", attempts: 4 },
    { name: "infra", synced: true, action: "fetched" },
  ];
  const asked: string[] = [];
  const { io, out, err } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url) => {
      asked.push(String(url));
      return Promise.resolve(Response.json(repos));
    },
  });

  assert.equal(await main(["status"], io), 0, "a degraded repo is a report, not a failure of asking");
  assert.ok(
    asked.some((u) => u.endsWith("/repos")),
    "no run named → the instance's own status",
  );
  assert.deepEqual(JSON.parse(out().trim()), { repos }, "an object on stdout: the instance has more to say later");
  assert.match(err(), /repo "app" is not synced \(attempt 4\)/);
  assert.match(err(), /Permission denied \(publickey\)\./, "git's own error, verbatim");
  assert.doesNotMatch(err(), /"infra"/, "a synced repo needs no line");
  assert.match(err(), /keeps retrying/, "…and the way out: register the key, the reconcile closes the window");
});
