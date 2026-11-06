// `jr2 runs` (ADR-0009): the runs as JSON on stdout, the live ones by default. The Workflows that a
// run can start are `jr2 workflows` (workflows.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import type { Io } from "../src/output.ts";

/** One live run as `GET /runs` summarizes it. */
const R1 = { runId: "r1", workflow: "ping", status: "active", startedAt: "2026-11-05T10:00:00.000Z", openGates: 0 };

/** A fake Orchestrator: `GET /runs` answers one live run. */
function fakeFetch(seen: string[] = []): Io["fetch"] {
  return async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === "/runs") return Response.json({ runs: [R1] });
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

test("`jr2 runs` prints the live runs as the result, and reads no Workflow listing", async () => {
  const seen: string[] = [];
  const { io, out, err } = mkIo(fakeFetch(seen));
  assert.equal(await main(["runs"], io), 0);
  assert.deepEqual(
    (JSON.parse(out()) as Array<{ runId: string }>).map((r) => r.runId),
    ["r1"],
  );
  assert.deepEqual(seen, ["/runs"]);
  assert.doesNotMatch(err(), /workflows/);
});

// The filters go to `GET /runs` as its query, and the verb reads every page (ADR-0009).

test("`jr2 runs --status --workflow --since` sends the query, and reads each page to the end", async () => {
  const seen: string[] = [];
  const r2 = { ...R1, runId: "r2", status: "done", endedAt: "2026-11-05T11:00:00.000Z" };
  const fetch: Io["fetch"] = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/workflows") return Response.json([]);
    seen.push(u.search);
    return Response.json(u.searchParams.get("cursor") === "c1" ? { runs: [r2] } : { runs: [R1], next: "c1" });
  };
  const { io, out } = mkIo(fetch);
  assert.equal(await main(["runs", "--status", "all", "--workflow", "ping", "--since", "7d"], io), 0);
  assert.deepEqual(
    (JSON.parse(out()) as Array<{ runId: string }>).map((r) => r.runId),
    ["r1", "r2"],
  );
  assert.deepEqual(seen, ["?status=all&workflow=ping&since=7d", "?status=all&workflow=ping&since=7d&cursor=c1"]);
});

test("`jr2 runs` with no filter asks for the live runs, with no query", async () => {
  const seen: string[] = [];
  const fetch: Io["fetch"] = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/runs") seen.push(u.search);
    return Response.json(u.pathname === "/runs" ? { runs: [] } : []);
  };
  const { io } = mkIo(fetch);
  assert.equal(await main(["runs"], io), 0);
  assert.deepEqual(seen, [""]);
});

test("a refused query fails the verb with the Orchestrator's words", async () => {
  const fetch: Io["fetch"] = async (url) =>
    new URL(url).pathname === "/runs"
      ? Response.json({ error: 'status "parked" is not one jr2 lists' }, { status: 400 })
      : Response.json([]);
  const { io, err } = mkIo(fetch);
  assert.notEqual(await main(["runs", "--status", "parked"], io), 0);
  assert.match(err(), /status "parked" is not one jr2 lists/);
});

// A dispatched run (ADR-0071) carries `dispatchedBy` in `jr2 runs`, as the Orchestrator sends it.

test("`jr2 runs` prints a dispatched run's `dispatchedBy` as sent, and a plain run has none", async () => {
  const by = { run: "caller-run", slot: "review", effect: "caller-run:review:1", depth: 1 };
  const fetch: Io["fetch"] = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/workflows") return Response.json([]);
    return Response.json({
      runs: [
        { ...R1, workflow: "review", dispatchedBy: by },
        { ...R1, runId: "r2" },
      ],
    });
  };
  const { io, out } = mkIo(fetch);
  assert.equal(await main(["runs"], io), 0);
  const [dispatched, plain] = JSON.parse(out()) as Array<Record<string, unknown>>;
  assert.deepEqual(dispatched!.dispatchedBy, by);
  assert.equal("dispatchedBy" in plain!, false);
});
