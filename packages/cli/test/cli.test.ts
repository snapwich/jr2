// `main` dispatch + output discipline (ADR-0009), end-to-end through the verbs against a socket-free
// app (injected via `io.fetch` + `JR2_URL`). Asserts the stdout=result / stderr=activity split, exit
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
  // cwd "/" has no jr2.config.ts above it, and no --url/JR2_URL → resolveBaseUrl throws.
  const { io, err } = mkIo({ cwd: "/", env: {} });
  assert.equal(await main(["runs"], io), 1);
  assert.match(err(), /error:/);
});

test("run attaches: terminal RunStatus on stdout, activity on stderr", async () => {
  const { app } = await mkHarness();
  const { io, out, err } = mkIo({
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
    env: { JR2_URL: "http://test" },
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
  assert.match(err(), /full run id|jr2 up/, "a way out, before a rollout they may not want now");
  assert.equal(out(), "", "an unresolved id prints no result");
});

test("a prefix under the floor is a usage error; an unmatched one is a runtime error", async () => {
  const { app } = await mkHarness();
  const mk = () =>
    mkIo({ env: { JR2_URL: "http://test" }, fetch: (url, init) => Promise.resolve(app.request(url, init)) });

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
    mkIo({ env: { JR2_URL: "http://test" }, fetch: (url, init) => Promise.resolve(app.request(url, init)) });

  // `host.stop()` returns silently for an unknown run, so before resolution this reported success.
  const bogus = mk();
  assert.equal(await main(["send", "abcdef12", "--event", "CANCEL"], bogus.io), 1);
  assert.match(bogus.err(), /no run/);
  assert.equal(host.status(runId)?.status, "active", "and the real run is untouched");

  const real = mk();
  assert.equal(await main(["send", runId.slice(0, 8), "--event", "CANCEL"], real.io), 0);
  assert.match(real.err(), new RegExp(`sent CANCEL to ${runId}`), "the message names the run it actually hit");
});

test("`jr2 status` with no run reports the data plane and every Repo, failing nodes with git's own error", async () => {
  // ADR-0048's third claim on ADR-0051's shape: the cache agent degrades a Repo on one node instead
  // of the daemon, so the way to learn a clone never landed is to ask the instance — not to tail
  // pod logs. Per NODE, because that is where a cache lives. A REPORT verb (ADR-0009 as amended):
  // the table is stdout, and `--json` swaps in the object.
  const repos = [
    {
      key: "app-0123abcd",
      url: "git@github.com:acme/app.git",
      identity: "github.com/acme/app",
      bound: true,
      nodes: [
        { node: "kind-worker", present: false, synced: false, lastError: "Permission denied (publickey)." },
        { node: "kind-worker2", present: true, synced: true },
      ],
    },
    { key: "infra-89abcdef", url: "https://example.test/infra.git", bound: false, nodes: [] },
  ];
  const staleOnly = [
    {
      key: "app-0123abcd",
      url: "git@github.com:acme/app.git",
      bound: true,
      nodes: [{ node: "kind-worker", present: true, synced: false, lastError: "Could not resolve host: github.com" }],
    },
  ];
  const asked: string[] = [];
  const { io, out, err } = mkIo({
    env: { JR2_URL: "http://test" },
    fetch: (url) => {
      asked.push(String(url));
      return Promise.resolve(Response.json({ dataPlane: true, repos }));
    },
  });

  assert.equal(await main(["status"], io), 0, "a degraded Repo is a report, not a failure of asking");
  assert.ok(
    asked.some((u) => u.endsWith("/repos")),
    "no run named → the instance's own status",
  );
  assert.match(out(), /^data plane: yes$/m);
  assert.match(out(), /^repo app-0123abcd \(git@github\.com:acme\/app\.git\)  bound$/m);
  assert.match(
    out(),
    /^  node kind-worker: absent — Permission denied \(publickey\)\.$/m,
    "a cold clone that failed: the cache is absent on that node, with git's own error",
  );
  assert.match(out(), /^  node kind-worker2: present, synced$/m, "every node is a line in the table");
  assert.match(out(), /^repo infra-89abcdef/m, "a Repo no node has tried yet is still listed");
  assert.match(out(), /keeps retrying/, "…and the way out: register the key, the cache agent closes the window");
  assert.match(
    out(),
    /absent: Workspaces needing that cache on that node wait/,
    "absence parks the provision (ADR-0051)",
  );
  assert.doesNotMatch(out(), /stale:/, "no warm cache failed a fetch, so no stale line");
  assert.doesNotMatch(out(), /no data plane/);
  assert.equal(err(), "→ http://test\n", "stderr carries the target line and nothing of the table");

  // `--json`: the object, nothing else.
  const json = mkIo({
    env: { JR2_URL: "http://test" },
    fetch: () => Promise.resolve(Response.json({ dataPlane: true, repos })),
  });
  assert.equal(await main(["status", "--json"], json.io), 0);
  assert.deepEqual(
    JSON.parse(json.out().trim()),
    { dataPlane: true, repos },
    "the switch and the Repos, as one object",
  );
  assert.equal(json.err(), "→ http://test\n");

  // Freshness degrades, absence does not (ADR-0004/0051): a fetch that fails on a WARM cache is
  // stale, and an attach proceeds on what the cache holds — the hint must not claim Workspaces wait.
  const warm = mkIo({
    env: { JR2_URL: "http://test" },
    fetch: () => Promise.resolve(Response.json({ dataPlane: true, repos: staleOnly })),
  });
  assert.equal(await main(["status"], warm.io), 0);
  assert.match(warm.out(), /node kind-worker: stale — Could not resolve host: github\.com/);
  assert.match(warm.out(), /stale: attaches proceed on what the cache holds/);
  assert.doesNotMatch(warm.out(), /wait until/, "a stale cache parks nothing");
  assert.doesNotMatch(warm.out(), /absent/);

  // No data plane is an answer, not an empty list (ADR-0051).
  const none = mkIo({
    env: { JR2_URL: "http://test" },
    fetch: () => Promise.resolve(Response.json({ dataPlane: false, repos: [] })),
  });
  assert.equal(await main(["status"], none.io), 0);
  assert.match(none.out(), /no data plane \(no registered Machine composes a Sandbox\)/);
});

test("`jr2 version` is a report verb: a table on stdout, `--json` the object, exit 0 either way", async () => {
  const { app } = await mkHarness();
  const table = mkIo({
    cwd: "/",
    env: { JR2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });
  assert.equal(await main(["version"], table.io), 0);
  assert.match(table.out(), /^cli:\s+\d+\.\d+\.\d+/m, "the copy that runs, first");
  assert.match(table.out(), /^instance:\s+none/m, "cwd / is inside no Instance");
  assert.match(
    table.out(),
    /^orchestrator:\s+\d+\.\d+\.\d+/m,
    "--url reaches the orchestrator's /healthz all the same",
  );
  assert.equal(table.err(), "→ http://test\n", "the target line is activity; the table is not");

  const json = mkIo({ cwd: "/", env: {} });
  assert.equal(await main(["--version", "--json"], json.io), 0, "`--version` is the conventional spelling");
  const report = JSON.parse(json.out().trim()) as { cli: { version: string }; deployed?: unknown; skew: string };
  assert.match(report.cli.version, /^\d+\.\d+\.\d+/);
  assert.equal(report.deployed, undefined, "no Instance and no --url: nothing to address");
  assert.equal(report.skew, "unknown");
});
