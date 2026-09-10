// Stub-Harness wire tests: the REAL wire-backed port (`createHarnessAgentRunClient`) talks
// to the stub over a real socket — proving "an endpoint is just a URL" (ADR-0011): the same
// single Agent-actor code path admits, receives a durable admission, and parks in settle, exactly
// as it would against a silent real Harness. (A socket test — the stub IS wire.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarnessAgentRunClient } from "../src/harness-client.ts";
import { startStubHarness } from "../src/stub-harness.ts";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test("the real wire port admits against the stub, gets its admission, and parks in settle", async () => {
  const stub = await startStubHarness({ longPollMs: 200 });
  try {
    const port = createHarnessAgentRunClient({ baseUrl: stub.url });

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

    // The stub never acts: the stream stays empty, so the run parks across MULTIPLE long-poll
    // cycles (longPollMs 200, watched for 500) instead of settling — wait must keep polling,
    // never resolve an answerless stream.
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

test("abort ends every unsettled submission for the instance, and history says so (ADR-0024)", async () => {
  const stub = await startStubHarness();
  try {
    const port = createHarnessAgentRunClient({ baseUrl: stub.url });
    const input = { agentName: "coder", instanceId: "iid-9", endpoint: stub.url, prompt: "go", tools: [] };
    const first = await port.admit(input);
    // A second submission on the same instance — what `session: "continue"` produces, and what
    // flue queues rather than rejects. An abort ends the running one AND everything behind it.
    const queued = await port.admit(input);

    await port.abort("coder", "iid-9");

    const history = (await (await fetch(`${stub.url}/agents/coder/iid-9?view=history`)).json()) as {
      settlements: Array<{ submissionId: string; outcome: string }>;
    };
    assert.deepEqual(history.settlements, [
      { submissionId: first.submissionId, outcome: "aborted" },
      { submissionId: queued.submissionId, outcome: "aborted" },
    ]);

    // Aborting an idle instance is not an error — it is `{ aborted: false }`, nothing to end.
    const again = (await (await fetch(`${stub.url}/agents/coder/iid-9/abort`, { method: "POST" })).json()) as {
      aborted: boolean;
    };
    assert.equal(again.aborted, false);
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
