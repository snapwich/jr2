// `jr2 logs` prints a run's kept conversations in the Harness's printed form (ADR-0023, ADR-0009),
// every Agent interleaved by time or one Agent slot; `-f` follows. `jr2 watch` prints the lines that
// `jr2 run` prints while it is attached, or with `--json` each status as JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { logs, printedLines } from "../src/commands/logs.ts";
import type { Io } from "../src/output.ts";

const RUN = "0b6c2f1e-1111-4222-8333-444455556666";

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

const CONVERSATIONS = [
  { agent: "coder", slot: "root.ws/coder", instanceId: `${RUN}/ws/coder`, open: false, bytes: 10, cut: false },
  { agent: "planner", slot: "root/planner", instanceId: `${RUN}/planner`, open: false, bytes: 10, cut: false },
];
const ENTRIES: Record<string, unknown[]> = {
  [`${RUN}/planner`]: [
    { id: "p1", seq: 1, at: "2026-11-06T10:00:00.000Z", agent: "planner", kind: "prompt", text: "plan it" },
    { id: "p2", seq: 2, at: "2026-11-06T10:00:02.000Z", agent: "planner", kind: "text", text: "one\ntwo" },
  ],
  [`${RUN}/ws/coder`]: [{ id: "c1", seq: 1, at: "2026-11-06T10:00:01.000Z", agent: "coder", kind: "bash", text: "ls" }],
};

function server(seen: string[] = []): Io["fetch"] {
  return async (url) => {
    const u = new URL(url);
    seen.push(`${u.pathname}${u.search}`);
    if (u.pathname === `/runs/${RUN}/conversations`) return Response.json(CONVERSATIONS);
    const m = /^\/runs\/[^/]+\/conversations\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const after = Number(u.searchParams.get("after"));
      const all = (ENTRIES[decodeURIComponent(m[1]!)] ?? []) as { seq: number }[];
      return Response.json(all.filter((e) => e.seq > after));
    }
    if (u.pathname === `/runs/${RUN}`) return Response.json({ runId: RUN, workflow: "w", status: "done" });
    return Response.json({ error: "no" }, { status: 404 });
  };
}

test("a kept entry prints as the Harness printed it: the lines of the Harness's printLines", () => {
  const entry = { id: "x", seq: 1, at: "t", agent: "coder", kind: "text", text: "line one\nline two" };
  // What `printLines(out, "coder", "iid", ["[text] line one\nline two"])` writes (harness printer.ts):
  // the label on the first line, the prefix on each. A package's test does not import another's source.
  assert.equal(printedLines("iid", entry), "[coder] [iid] [text] line one\n[coder] [iid] line two\n");
  // A body that kept no label prints its text alone.
  assert.equal(printedLines("iid", { ...entry, kind: "line", text: "bare" }), "[coder] [iid] bare\n");
});

test("jr2 logs interleaves every Agent's conversation by time", async () => {
  const { io, out } = mkIo(server());
  assert.equal(await main(["logs", RUN], io), 0);
  assert.equal(
    out(),
    [
      `[planner] [${RUN}/planner] [prompt] plan it`,
      `[coder] [${RUN}/ws/coder] [bash] ls`,
      `[planner] [${RUN}/planner] [text] one`,
      `[planner] [${RUN}/planner] two`,
      "",
    ].join("\n"),
  );
});

test("jr2 logs <run> <agent> keeps one Agent: by its slot, or by its name", async () => {
  for (const agent of ["root.ws/coder", "coder"]) {
    const { io, out } = mkIo(server());
    assert.equal(await main(["logs", RUN, agent], io), 0);
    assert.equal(out(), `[coder] [${RUN}/ws/coder] [bash] ls\n`);
  }
  const { io, err } = mkIo(server());
  assert.equal(await main(["logs", RUN, "reviewer"], io), 1);
  assert.match(err(), /keeps no conversation of "reviewer" — its Agents: root\.ws\/coder, root\/planner/);
});

test("jr2 logs -f follows each conversation from its last printed entry, and ends with the run", async () => {
  const seen: string[] = [];
  const base = server(seen);
  const fetch: Io["fetch"] = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/events")) {
      seen.push(`${u.pathname}${u.search}`);
      const late = { id: "p3", seq: 3, at: "2026-11-06T10:00:05.000Z", agent: "planner", kind: "text", text: "late" };
      const body = u.pathname.includes("planner")
        ? `event: entry\ndata: ${JSON.stringify(late)}\n\nevent: end\ndata: {}\n\n`
        : "event: end\ndata: {}\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return base!(url, init);
  };
  const { io, out } = mkIo(fetch);
  assert.equal(await logs([RUN, "-f"], io, { pollMs: 1 }), 0);
  assert.match(out(), new RegExp(`\\[planner\\] \\[${RUN}/planner\\] \\[text\\] late\\n$`));
  assert.ok(seen.includes(`/runs/${RUN}/conversations/${encodeURIComponent(`${RUN}/planner`)}/events?after=2`));
  assert.ok(seen.includes(`/runs/${RUN}/conversations/${encodeURIComponent(`${RUN}/ws/coder`)}/events?after=1`));
});

function feed(frames: string): NonNullable<Io["fetch"]> {
  return async () => new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

const FRAMES =
  `event: status\ndata: ${JSON.stringify({ runId: RUN, workflow: "w", status: "active", value: "a" })}\n\n` +
  `event: emit\ndata: ${JSON.stringify({ type: "progress", n: 1 })}\n\n` +
  `event: status\ndata: ${JSON.stringify({ runId: RUN, workflow: "w", status: "done", value: "b" })}\n\n`;

test("jr2 watch prints jr2 run's attached lines on stdout, to the run's end", async () => {
  const { io, out } = mkIo(feed(FRAMES));
  assert.equal(await main(["watch", RUN], io), 0);
  assert.equal(out(), `run ${RUN} (w) — attached\n  → active "a"\n  emit {"type":"progress","n":1}\n  → done "b"\n`);
  // The same lines, in the same form, as `jr2 run` prints them while it is attached.
  const started: Io["fetch"] = async (url, init) =>
    new URL(url).pathname === "/workflows/w/runs" && init?.method === "POST"
      ? Response.json({ runId: RUN })
      : feed(FRAMES)(url, init);
  const ran = mkIo(started);
  assert.equal(await main(["run", "w"], ran.io), 0);
  assert.ok(ran.err().endsWith(out()), `jr2 run printed:\n${ran.err()}`);
});

test("jr2 watch --json prints each status as JSON on stdout, and the rest on stderr", async () => {
  const { io, out, err } = mkIo(feed(FRAMES));
  assert.equal(await main(["watch", RUN, "--json"], io), 0);
  const lines = out()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { status: string });
  assert.deepEqual(
    lines.map((s) => s.status),
    ["active", "done"],
  );
  assert.match(err(), /emit \{"type":"progress","n":1\}/);
});

test("jr2 watch prints a failed run's reason after its last status, as jr2 run does", async () => {
  const failed = `event: status\ndata: ${JSON.stringify({ runId: RUN, workflow: "w", status: "failed", value: "x", output: { reason: "no tests" } })}\n\n`;
  const plain = mkIo(feed(failed));
  assert.equal(await main(["watch", RUN], plain.io), 0);
  assert.match(plain.out(), /  → failed "x"\nfailed: no tests\n$/);
  const json = mkIo(feed(failed));
  assert.equal(await main(["watch", RUN, "--json"], json.io), 0);
  assert.equal(JSON.parse(json.out().trim()).status, "failed");
  assert.match(json.err(), /failed: no tests/);
});
