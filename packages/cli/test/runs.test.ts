// `jr2 runs` lists the Workflows a run can start beside the live runs (ADR-0070): each with its
// origin, a Chart wrapper's Charts indented under it, `unrunnable` with its reason. The result on
// stdout stays the live runs; the listing is activity on stderr, or the result with `--workflows`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { JR2Client, type WorkflowListing } from "../src/client.ts";
import { markListed, renderWorkflows, RUNS_USAGE } from "../src/commands/runs.ts";
import type { Io } from "../src/output.ts";

const LISTING: WorkflowListing[] = [
  { name: "ping", origin: "machine" },
  {
    name: "charted",
    origin: "machine",
    wrapper: {
      body: "body",
      oneShot: true,
      charts: [
        { name: "sample", origin: "file" },
        { name: "loop", origin: "runtime" },
        { name: "old", origin: "runtime", unrunnable: 'states.draft.invoke.src: "coder" is not lent' },
      ],
    },
  },
  { name: "planner", origin: "machine", wrapper: { body: "body", oneShot: false, charts: [] } },
];

/** A fake Orchestrator: `GET /workflows` answers `listing`, `GET /runs` one live run. */
function fakeFetch(listing: unknown, seen: string[] = []): Io["fetch"] {
  return async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === "/workflows") return Response.json(listing);
    if (path === "/runs") return Response.json([{ runId: "r1", workflow: "ping", status: "active", value: "x" }]);
    return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
  };
}

function mkIo(fetch: Io["fetch"]): { io: Io; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { JR2_URL: "http://test" },
    cwd: "/",
    fetch,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("each Workflow prints with its origin, and a Chart wrapper's Charts indent under it", () => {
  assert.deepEqual(renderWorkflows(LISTING).split("\n"), [
    "workflows:",
    "  ping (machine)",
    '  charted (machine, Chart wrapper: body "body", one-shot)',
    "    charted/sample (chart file)",
    "    charted/loop (chart)",
    '    charted/old (chart) unrunnable: states.draft.invoke.src: "coder" is not lent',
    '  planner (machine, Chart wrapper: body "body")',
  ]);
});

test("a Chart the listing also gives at the top level prints once, under its wrapper", () => {
  const listing: WorkflowListing[] = [
    ...LISTING,
    { name: "charted/loop", origin: "runtime" },
    { name: "gone/orphan", origin: "runtime", unrunnable: 'no Workflow "gone"' },
  ];
  const lines = renderWorkflows(listing).split("\n");
  assert.equal(lines.filter((l) => l.includes("charted/loop")).length, 1);
  assert.ok(lines.includes('  gone/orphan (chart) unrunnable: no Workflow "gone"'), "an orphan prints at the top");
});

test("an empty listing says none is registered", () => {
  assert.match(renderWorkflows([]), /none registered/);
});

test("`jr2 runs` keeps the live runs as the result and lists the Workflows on stderr", async () => {
  const { io, out, err } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["runs"], io), 0);
  const list = JSON.parse(out()) as Array<{ runId: string }>;
  assert.deepEqual(
    list.map((r) => r.runId),
    ["r1"],
  );
  assert.match(err(), /^ {4}charted\/loop \(chart\)$/m);
});

test("`jr2 runs --workflows` prints the listing as the result", async () => {
  const { io, out } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["runs", "--workflows"], io), 0);
  assert.deepEqual(JSON.parse(out()), LISTING);
});

test("a listing that cannot be read is one line, and the runs still print", async () => {
  const failing: Io["fetch"] = async (url) =>
    new URL(url).pathname === "/runs" ? Response.json([]) : new Response("{}", { status: 500 });
  const { io, out, err } = mkIo(failing);
  assert.equal(await main(["runs"], io), 0);
  assert.deepEqual(JSON.parse(out()), []);
  assert.match(err(), /^workflows: unknown — HTTP 500$/m);
});

test("an answer that is no listing reads as unknown, never as none registered", async () => {
  const { io, out, err } = mkIo(fakeFetch({ error: "a proxy page" }));
  assert.equal(await main(["runs"], io), 0);
  assert.equal(JSON.parse(out()).length, 1, "the runs still print");
  assert.match(err(), /^workflows: unknown — GET \/workflows: the answer is not a listing$/m);
  assert.doesNotMatch(err(), /none registered/);
});

test("an Orchestrator older than ADR-0070 answers bare names; each reads as a Machine", async () => {
  const client = new JR2Client("http://test", fakeFetch(["ping", "loop"]));
  assert.deepEqual(await client.workflows(), [
    { name: "ping", origin: "machine" },
    { name: "loop", origin: "machine" },
  ]);
});

test("the usage says no verb puts or deletes a runtime Chart", async () => {
  assert.match(RUNS_USAGE, /PUT or DELETE \/workflows\/<wrapper>\/charts\/<name>/);
  const { io, err } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["runs", "--help"], io), 0);
  assert.match(err(), /an MCP or curl/);
});

test("`jr2 --help` names the Workflow listing and `--workflows` under `runs`", async () => {
  const { io, err } = mkIo(fakeFetch(LISTING));
  await main(["--help"], io);
  assert.match(err(), /named Charts on stderr \(ADR-0070\)/);
  assert.match(err(), /\[--workflows\] +\.\.\.or print that listing as the result \(see "runs --help"\)/);
});

// A dispatched run (ADR-0071) carries `dispatchedBy` after its id in `jr2 runs`, as it is sent.

test("`jr2 runs` puts a dispatched run's `dispatchedBy` after its id, and a plain run has none", async () => {
  const by = { run: "caller-run", slot: "review", effect: "caller-run:review:1", depth: 1 };
  const fetch: Io["fetch"] = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/workflows") return Response.json([]);
    return Response.json([
      { runId: "r1", workflow: "review", status: "active", value: "x", dispatchedBy: by },
      { runId: "r2", workflow: "ping", status: "active", value: "x" },
    ]);
  };
  const { io, out } = mkIo(fetch);
  assert.equal(await main(["runs"], io), 0);
  const [dispatched, plain] = JSON.parse(out()) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(dispatched!).slice(0, 2), ["runId", "dispatchedBy"]);
  assert.deepEqual(dispatched!.dispatchedBy, by);
  assert.equal("dispatchedBy" in plain!, false);
});

test("a dispatched run in `placing` keeps both marks after its id", () => {
  const by = { run: "caller-run", slot: "review", effect: "caller-run:review:1", depth: 1 };
  const run = { runId: "r", workflow: "w", instanceId: "i", status: "active", value: "placing", context: {} };
  assert.deepEqual(Object.keys(markListed({ ...run, dispatchedBy: by })).slice(0, 3), [
    "runId",
    "dispatchedBy",
    "placing",
  ]);
});
