// `jr2 workflows` lists the Workflows that a run can start (ADR-0070): each with its origin, a
// Chart wrapper's Charts indented under it, `unrunnable` with its reason. `--json` prints the listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { JR2Client, type WorkflowListing } from "../src/client.ts";
import { renderWorkflows } from "../src/commands/workflows.ts";
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

/** A fake Orchestrator: `GET /workflows` answers `listing`. */
function fakeFetch(listing: unknown): Io["fetch"] {
  return async (url) =>
    new URL(url).pathname === "/workflows"
      ? Response.json(listing)
      : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
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
    "ping (machine)",
    'charted (machine, Chart wrapper: body "body", one-shot)',
    "  charted/sample (chart file)",
    "  charted/loop (chart)",
    '  charted/old (chart) unrunnable: states.draft.invoke.src: "coder" is not lent',
    'planner (machine, Chart wrapper: body "body")',
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
  assert.ok(lines.includes('gone/orphan (chart) unrunnable: no Workflow "gone"'), "an orphan prints at the top");
});

test("an empty listing says none is registered", () => {
  assert.match(renderWorkflows([]), /none registered/);
});

test("`jr2 workflows` prints the tree on stdout", async () => {
  const { io, out } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["workflows"], io), 0);
  assert.match(out(), /^ {2}charted\/loop \(chart\)$/m);
});

test("`jr2 workflows --json` prints the listing as the report", async () => {
  const { io, out } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["workflows", "--json"], io), 0);
  assert.deepEqual(JSON.parse(out()), LISTING);
});

test("a listing that cannot be read fails the verb with the reason", async () => {
  const { io, err } = mkIo(async () => new Response("{}", { status: 500 }));
  assert.notEqual(await main(["workflows"], io), 0);
  assert.match(err(), /HTTP 500/);
});

test("an answer that is no listing fails the verb, never prints none registered", async () => {
  const { io, out, err } = mkIo(fakeFetch({ error: "a proxy page" }));
  assert.notEqual(await main(["workflows"], io), 0);
  assert.match(err(), /GET \/workflows: the answer is not a listing/);
  assert.doesNotMatch(out(), /none registered/);
});

test("an Orchestrator older than ADR-0070 answers bare names; each reads as a Machine", async () => {
  const client = new JR2Client("http://test", fakeFetch(["ping", "loop"]));
  assert.deepEqual(await client.workflows(), [
    { name: "ping", origin: "machine" },
    { name: "loop", origin: "machine" },
  ]);
});

test("the usage says no verb puts or deletes a runtime Chart", async () => {
  const { io, err } = mkIo(fakeFetch(LISTING));
  assert.equal(await main(["workflows", "--help"], io), 0);
  assert.match(err(), /PUT or DELETE \/workflows\/<wrapper>\/charts\/<name>/);
  assert.match(err(), /an MCP or curl/);
});

test("`jr2 --help` names `workflows`, and `runs` no longer takes `--workflows`", async () => {
  const { io, err } = mkIo(fakeFetch(LISTING));
  await main(["--help"], io);
  assert.match(err(), /^ {2}workflows \[--json\]/m);
  assert.match(err(), /^ {2}runs \[--status <s>\] \[--workflow <name>\] \[--since <when>\]$/m);
});
