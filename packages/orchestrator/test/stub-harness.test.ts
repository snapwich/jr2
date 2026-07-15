// Stub-Harness wire tests: the REAL `@flue/sdk`-backed port (`createFlueAgentRunClient`) talks
// to the stub over a real socket — proving "an endpoint is just a URL" (ADR-0011): the same
// single agentRun code path admits, receives a durable admission, and parks in settle, exactly
// as it would against a silent real Harness. (A socket test — the stub IS wire.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlueAgentRunClient } from "../src/flue-client.ts";
import { startStubHarness } from "../src/stub-harness.ts";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test("the real flue port admits against the stub, gets its admission, and parks in settle", async () => {
  const stub = await startStubHarness({ longPollMs: 200 });
  try {
    const port = createFlueAgentRunClient({ baseUrl: stub.url });

    // Admission reaches the stub (prompt and identity intact) and answers the durable handle —
    // persistable immediately (the ledger's write happens before settlement — ADR-0016).
    const admission = await port.admit({
      agentName: "coder",
      instanceId: "iid-9",
      endpoint: stub.url,
      prompt: "hello",
      tools: [],
    });
    assert.deepEqual(stub.admissions, [{ agentName: "coder", instanceId: "iid-9", message: "hello" }]);
    assert.equal(admission.offset, "0_0");
    assert.ok(admission.streamUrl.includes("/agents/coder/iid-9"));
    assert.ok(admission.submissionId);

    // The stub never acts: the run parks across long-poll cycles instead of settling.
    const controller = new AbortController();
    let settled = false;
    const settleP = port
      .settle(admission, { signal: controller.signal })
      .then(() => (settled = true))
      .catch(() => {});
    await tick(500);
    assert.equal(settled, false, "the run must stay parked against the silent stub");

    controller.abort(); // local abandon — exactly what actor stop does
    await settleP;
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
