// `jr2 run <wrapper>/<name>` starts a named Chart (ADR-0070): the name rides the path as one encoded
// segment. A Chart the door refuses is a 422 whose report the verb prints, line by line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { JR2Client, JR2HttpError } from "../src/client.ts";
import { refusalActivity } from "../src/commands/run.ts";
import type { Io } from "../src/output.ts";

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

test("a named Chart's name rides the start route as one encoded segment", async () => {
  const seen: string[] = [];
  const fetch: Io["fetch"] = async (url) => {
    seen.push(url);
    return Response.json({ runId: "r1", instanceId: "i1" }, { status: 201 });
  };
  const { io, out } = mkIo(fetch);
  assert.equal(await main(["run", "charted/loop", "--detach", "--input", '{"task":"t"}'], io), 0);
  assert.deepEqual(JSON.parse(out()), { runId: "r1" });
  assert.deepEqual(seen, ["http://test/workflows/charted%2Floop/runs"]);
});

test("the client encodes the slash on every Workflow route it builds", async () => {
  const seen: string[] = [];
  const client = new JR2Client("http://test", async (url) => {
    seen.push(url);
    return Response.json({ id: "m", root: {} });
  });
  await client.machine("charted/loop");
  await client.runMachine("charted/loop", "r1");
  assert.deepEqual(seen, [
    "http://test/workflows/charted%2Floop/machine",
    "http://test/workflows/charted%2Floop/runs/r1/machine",
  ]);
});

test("an unknown run's bound Machine is undefined, not a throw", async () => {
  const client = new JR2Client("http://test", async () => Response.json({ error: "no run" }, { status: 404 }));
  assert.equal(await client.runMachine("charted", "r1"), undefined);
});

test("a refused Chart prints the door's report line by line and exits 1", async () => {
  const report = ['states.draft.invoke.src: "linter" is not a lent actor; lent: coder', "states: no final state"];
  const fetch: Io["fetch"] = async () => Response.json({ error: "refused", report }, { status: 422 });
  const { io, out, err } = mkIo(fetch);
  assert.equal(await main(["run", "charted", "--input", '{"chart":{}}'], io), 1);
  assert.equal(out(), "", "nothing on stdout to be read as a result");
  assert.ok(err().includes(refusalActivity("charted", report)));
  assert.match(err(), /^ {2}states\.draft\.invoke\.src: "linter" is not a lent actor; lent: coder$/m);
});

test("the error keeps the report; an answer with none carries none", async () => {
  const refused = new JR2Client("http://test", async () =>
    Response.json({ error: "refused", report: ["a"] }, { status: 422 }),
  );
  await assert.rejects(refused.start("charted"), (e: unknown) => e instanceof JR2HttpError && e.report?.[0] === "a");
  const plain = new JR2Client("http://test", async () => Response.json({ error: "bad input" }, { status: 400 }));
  await assert.rejects(plain.start("charted"), (e: unknown) => e instanceof JR2HttpError && e.report === undefined);
});

/** A fetch that starts run `r1` and serves its feed as one `status` frame per given status, the
 * last one terminal. */
function feedOf(...frames: Array<Record<string, unknown>>): Io["fetch"] {
  return async (url) => {
    if (url.endsWith("/runs")) return Response.json({ runId: "r1", instanceId: "i1" }, { status: 201 });
    const body = frames
      .map(
        (s) =>
          `event: status\ndata: ${JSON.stringify({ runId: "r1", workflow: "w", instanceId: "i1", value: "x", context: {}, ...s })}\n\n`,
      )
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
}

test("jr2 run exits 0 only for done, and 1 for every other end (ADR-0073)", async () => {
  const ends: Array<[string, number]> = [
    ["done", 0],
    ["failed", 1],
    ["error", 1],
    ["cancelled", 1],
    ["lost", 1],
    ["drifted", 1],
  ];
  for (const [status, code] of ends) {
    const { io, out } = mkIo(feedOf({ status: "active" }, { status }));
    assert.equal(await main(["run", "w"], io), code, `status ${status}`);
    assert.equal(JSON.parse(out()).status, status, "the terminal status is the result on stdout");
  }
});

test("jr2 run with no workflow is a usage error: exit 2", async () => {
  const { io } = mkIo(async () => {
    throw new Error("no request is sent");
  });
  assert.equal(await main(["run"], io), 2);
});

test("a failed run prints its reason on stderr, and its Failure is the result's output", async () => {
  const output = { reason: "the tests did not pass", detail: { failed: 3 } };
  const { io, out, err } = mkIo(feedOf({ status: "failed", value: "failing", output }));
  assert.equal(await main(["run", "w"], io), 1);
  assert.match(err(), /→ failed "failing"/);
  assert.match(err(), /^failed: the tests did not pass$/m);
  assert.deepEqual(JSON.parse(out()).output, output);
});

test("jr2 run exits 1 for a run that was parked before it settled: a feed that ends in `gone` (ADR-0073)", async () => {
  const fetch: Io["fetch"] = async (url) => {
    if (url.endsWith("/runs")) return Response.json({ runId: "r1", instanceId: "i1" }, { status: 201 });
    const active = JSON.stringify({
      runId: "r1",
      workflow: "w",
      instanceId: "i1",
      status: "active",
      value: "x",
      context: {},
    });
    const body = `event: status\ndata: ${active}\n\nevent: gone\ndata: ${JSON.stringify({ runId: "r1" })}\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const { io, out, err } = mkIo(fetch);
  assert.equal(await main(["run", "w"], io), 1, "a parked run is not a success");
  assert.equal(out(), "", "nothing on stdout that a script could take for a result");
  assert.match(err(), /run r1 is parked: stopped before it settled/);
});
