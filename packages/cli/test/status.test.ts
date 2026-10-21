// `jr2 status` with no run named (ADR-0069): one line per Assembly a live run holds, the current
// one first and so marked. A run holds the Assembly it started under, so a publish that reshapes a
// Workflow leaves the previous Assembly on the volume while a run still holds it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { boundActivity, dispatchedActivity, dispatchedLines, renderInstanceStatus } from "../src/commands/status.ts";
import type { Io } from "../src/output.ts";

const lines = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("assembly:"));

test("the held Assemblies print one line each, the current one first and marked", () => {
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", workflows: ["ping"] },
      // Listed out of order on purpose: the current line comes first whatever the server sends.
      held: [
        { hash: "aaaaaaaaaaaa", kitVersion: "0.3.0", runs: ["r1"] },
        { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", runs: [] },
        { hash: "cccccccccccc", kitVersion: "0.3.0", runs: ["r2", "r3"] },
      ],
    },
    dataPlane: false,
    repos: [],
  });
  assert.deepEqual(lines(out), [
    "assembly: bbbbbbbbbbbb (kit v0.3.0, current), 0 live runs hold it",
    "assembly: aaaaaaaaaaaa (kit v0.3.0), 1 live run holds it",
    "assembly: cccccccccccc (kit v0.3.0), 2 live runs hold it",
  ]);
});

test("the current Assembly prints even when no run holds it and `held` omits it", () => {
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", workflows: ["ping"] },
      held: [],
    },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), ["assembly: bbbbbbbbbbbb (kit v0.3.0, current), 0 live runs hold it"]);
});

test("with no current Assembly, the held ones still print after the `none` line", () => {
  // A boot with no current Assembly restores nothing; the Assemblies its waiting runs hold are still listed.
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: null,
      held: [{ hash: "aaaaaaaaaaaa", kitVersion: "0.3.0", runs: ["r1"] }],
    },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), [
    "assembly: none — `jr2 up` publishes",
    "assembly: aaaaaaaaaaaa (kit v0.3.0), 1 live run holds it",
  ]);
});

test("an Assembly answer that cannot be read is one line naming the reason", () => {
  const out = renderInstanceStatus({
    assembly: { error: "GET /assembly answered HTTP 500" },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), ["assembly: unknown — GET /assembly answered HTTP 500"]);
});

// `jr2 status <run>` (ADR-0070): a run that binds a Chart says so as `chart: bound`, with the route
// that draws its bound Machine; a run that binds none says nothing.

test("a bound run reads `chart: bound` with its Machine route; an unbound one prints no line", () => {
  const run = { runId: "r1", workflow: "charted/loop", instanceId: "i", status: "active", value: "x", context: {} };
  assert.equal(
    boundActivity({ ...run, bound: true }),
    "chart: bound — GET /workflows/charted%2Floop/runs/r1/machine draws the Machine this run binds",
  );
  assert.equal(boundActivity(run), undefined);
});

test("a drifted bound run says so: its Machine route may not draw the Chart", () => {
  const run = { runId: "r1", workflow: "charted", instanceId: "i", status: "drifted", value: "x", context: {} };
  assert.equal(
    boundActivity({ ...run, bound: true }),
    "chart: bound, drifted — GET /workflows/charted/runs/r1/machine names each Chart it cannot draw",
  );
});

// `jr2 status <run>` (ADR-0071): a dispatched run says who dispatched it beside the result.

test("a dispatched run reads `dispatched by:` with its caller, slot and depth; any other run prints no line", () => {
  const run = { runId: "r1", workflow: "review", instanceId: "i", status: "active", value: "x", context: {} };
  const by = { run: "caller-run", slot: "review", effect: "caller-run:review:1", depth: 1 };
  assert.equal(dispatchedActivity({ ...run, dispatchedBy: by }), "dispatched by: caller-run (review), depth 1");
  assert.equal(
    dispatchedActivity({ ...run, dispatchedBy: { ...by, depth: 2, instance: "ops" } }),
    "dispatched by: caller-run (review), depth 2, from Orchestrator ops",
  );
  assert.equal(dispatchedActivity(run), undefined);
});

test("a run that dispatched reads one `dispatched:` line per run it started, the oldest past ten counted", () => {
  const run = { runId: "r1", workflow: "watch", instanceId: "i", status: "active", value: "x", context: {} };
  assert.deepEqual(dispatchedLines(run), []);
  const two = [
    { slot: "intake", run: "c1", at: "2026-10-20T00:00:01Z" },
    { slot: "intake", run: "c2", at: "2026-10-20T00:00:02Z" },
  ];
  assert.deepEqual(dispatchedLines({ ...run, dispatched: two }), [
    "dispatched: c1 (intake)",
    "dispatched: c2 (intake)",
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({ slot: "intake", run: `c${i}`, at: `t${i}` }));
  const lines = dispatchedLines({ ...run, dispatched: many });
  assert.equal(lines.length, 11);
  assert.equal(lines[0], "dispatched: 2 older run(s); the result lists them all");
  assert.equal(lines.at(-1), "dispatched: c11 (intake)");
});

test("`jr2 status <run>` prints the result with `dispatchedBy` and `output`, and the line on stderr", async () => {
  const runId = "0b9c2f3e-1111-4222-8333-444455556666";
  const s = {
    runId,
    workflow: "review",
    instanceId: "i",
    status: "done",
    value: "done",
    context: {},
    dispatchedBy: { run: "caller-run", slot: "review", effect: "caller-run:review:1", depth: 1 },
    output: { verdict: "approve" },
  };
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (x) => out.push(x),
    stderr: (x) => err.push(x),
    env: { JR2_URL: "http://test" },
    cwd: "/",
    fetch: async (url) =>
      new URL(url).pathname === `/runs/${runId}` ? Response.json(s) : new Response("{}", { status: 404 }),
  };
  assert.equal(await main(["status", runId], io), 0);
  const printed = JSON.parse(out.join("")) as typeof s;
  assert.deepEqual(printed.dispatchedBy, s.dispatchedBy);
  assert.deepEqual(printed.output, { verdict: "approve" });
  assert.match(err.join(""), /^dispatched by: caller-run \(review\), depth 1$/m);
});
