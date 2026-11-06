// `jr2 gates` prints the Gate inbox (ADR-0011): the open Gates of every live run that this Caller
// may answer, oldest first, as `GET /gates` gives them, with `--workflow` passed as the filter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import type { Io } from "../src/output.ts";

const ENTRY = {
  runId: "r1",
  workflow: "release",
  gate: "S-1",
  path: ["ship", "open"],
  accepts: [{ name: "ship_it", input: { type: "object" } }],
  acceptsNow: ["ship_it"],
  openedAt: "2026-11-05T10:00:00.000Z",
};

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

test("jr2 gates prints the inbox as the JSON result, and --workflow is the query", async () => {
  const seen: string[] = [];
  const { io, out } = mkIo(async (url) => {
    const u = new URL(url);
    seen.push(`${u.pathname}${u.search}`);
    return Response.json({ gates: [ENTRY] });
  });
  assert.equal(await main(["gates"], io), 0);
  assert.deepEqual(JSON.parse(out()), [ENTRY]);
  assert.equal(await main(["gates", "--workflow", "release"], io), 0);
  assert.deepEqual(seen, ["/gates", "/gates?workflow=release"]);
});

test("jr2 gates names the scope when the Caller has no answer scope", async () => {
  const { io, err } = mkIo(async () =>
    Response.json(
      { error: 'the Caller token/ci has no "answer" scope for any Workflow (ADR-0078)', scope: "answer" },
      { status: 403 },
    ),
  );
  assert.equal(await main(["gates"], io), 1);
  assert.match(err(), /no "answer" scope for any Workflow/);
});
