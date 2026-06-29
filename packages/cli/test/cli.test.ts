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
