// The Orchestrator's exec client (`createExecPort`, ADR-0067) against the Harness's own exec routes —
// the real `harnessApp`, its `fetch` handed to the client, so the two halves of the wire meet with no
// socket: start, read to the end, a 404 as "unknown to this Harness", a 4xx as a jr2 defect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessApp } from "@jr2/harness/app";
import { Execs } from "@jr2/harness/exec";
import { ExecRefused } from "../src/effect.ts";
import { createExecPort } from "../src/harness-client.ts";

function wired(checkBearer: (b: string | undefined) => boolean = (b) => b === "bearer") {
  const app = harnessApp({
    checkBearer,
    runSubmissionFor: () => async () => {},
    execs: new Execs(),
    longPollMs: 1_000,
  });
  const fetchImpl = ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch;
  return createExecPort({ baseUrl: "http://harness.invalid", token: "bearer", fetch: fetchImpl });
}

test("start, then read by offset to the end: the stream and the output", async () => {
  const port = wired();
  const signal = new AbortController().signal;
  await port.start(
    "e1",
    { argv: [process.execPath, "-e", "console.log('one'); console.log('two')"], timeoutMs: 5_000, tail: 100 },
    signal,
  );
  // Started again: the same id runs nothing.
  await port.start("e1", { argv: ["false"], timeoutMs: 5_000, tail: 100 }, signal);
  let offset = 0;
  let stream = "";
  for (;;) {
    const read = await port.read("e1", offset, signal);
    assert.ok(read);
    stream += read.stream;
    offset = read.next;
    if (read.state === "settled") {
      assert.deepEqual(read.output, { outcome: "exited", code: 0, tail: "one\ntwo\n" });
      break;
    }
  }
  assert.equal(stream, "one\ntwo\n");
  await port.forget("e1");
  assert.equal(await port.read("e1", 0, signal), undefined, "a forgotten exec reads as unknown");
});

test("an exec the Harness does not know reads undefined; a refused request is ExecRefused, never retried", async () => {
  const port = wired();
  const signal = new AbortController().signal;
  assert.equal(await port.read("nope", undefined, signal), undefined);
  await assert.rejects(
    () => port.start("bad", { argv: ["true"], cwd: "relative", timeoutMs: 1_000, tail: 0 }, signal),
    ExecRefused,
  );
  const refused = wired(() => false);
  await assert.rejects(() => refused.start("x", { argv: ["true"], timeoutMs: 1_000, tail: 0 }, signal), ExecRefused);
});
