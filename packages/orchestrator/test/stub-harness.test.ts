// Stub-Harness wire tests: the REAL `@flue/sdk`-backed port (`createFlueAgentRunClient`) talks
// to the stub over a real socket — proving "an endpoint is just a URL" (ADR-0011): the same
// single agentRun code path admits, checkpoints its baseline offset, and parks, exactly as it
// would against a silent real Harness. (A socket test, like http-mcp.test.ts — the stub IS wire.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlueAgentRunClient } from "../src/flue-client.ts";
import { startStubHarness } from "../src/stub-harness.ts";
import type { AgentToolCall } from "../src/actor.ts";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test("the real flue port admits against the stub, checkpoints the baseline, and parks", async () => {
  const stub = await startStubHarness({ longPollMs: 200 });
  try {
    const port = createFlueAgentRunClient({ baseUrl: stub.url });
    const calls: AgentToolCall[] = [];
    let settled = false;

    const admitP = port
      .admit({ agentName: "coder", instanceId: "iid-9", endpoint: stub.url, prompt: "hello", tools: [] }, (c) =>
        calls.push(c),
      )
      .then(() => (settled = true))
      .catch(() => (settled = true));

    // Admission reached the stub (prompt and identity intact) and the baseline offset fired —
    // the durable handle is persistable immediately (ADR-0002 baseline guarantee).
    await tick(100);
    assert.deepEqual(stub.admissions, [{ agentName: "coder", instanceId: "iid-9", message: "hello" }]);
    assert.deepEqual(
      calls.map((c) => c.offset),
      ["0_0"],
    );

    // The stub never acts: the run parks across long-poll cycles instead of settling.
    await tick(500);
    assert.equal(settled, false, "the run must stay parked against the silent stub");

    await port.cancel("iid-9");
    await admitP;
  } finally {
    await stub.close();
  }
});

test("unknown routes 404 (only the agents surface is stubbed)", async () => {
  const stub = await startStubHarness();
  try {
    const res = await fetch(`${stub.url}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await stub.close();
  }
});
