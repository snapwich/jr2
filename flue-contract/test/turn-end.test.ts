// What flue actually does when j2 ends an Agent's turn (ADR-0024), at the version we pin.
//
// This tier exists because the other three cannot see any of it (ADR-0010). The stub Harness is a
// hand-written model of flue's WIRE; it holds no conversation, so it can answer "the turn settled
// aborted" without ever having had a turn to settle. Every claim below is about what the real
// runtime keeps, drops, or sends onward — and the only witness is the message array the provider
// receives on the NEXT turn.
//
// The moment reproduced in each test is one moment: the invoking state exits, so the Adapter's
// registration is destroyed and `agentRun`'s `abandon()` aborts the submission. What differs is
// WHERE the turn was when that landed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlueClient } from "@flue/sdk";
import type { Surface } from "@j2/adapter";
import {
  startAdapterOverFakeOrchestrator,
  startFakeProvider,
  startHarness,
  until,
  type Turn,
} from "../support/harness.ts";

const AGENT = "reviewer";
/** Hierarchical, like a minted iid (ADR-0015) — it travels URL-encoded to the Adapter. */
const IID = "run-1/machine.reviewing/reviewer/s1";

const SURFACE: Surface = {
  instanceId: IID,
  runId: "run-1",
  sandbox: "ws-1",
  accepts: [
    {
      name: "review_verdict",
      description: "Deliver the verdict. Call it once, then stop.",
      input: {
        type: "object",
        properties: { verdict: { type: "string" }, notes: { type: "string" } },
        required: ["verdict"],
      },
      semantics: "ack",
    },
  ],
};

/** Stand up provider + Adapter + Harness for one scenario, and tear all three down after. */
async function scenario(script: Turn[], body: (ctx: Awaited<ReturnType<typeof open>>) => Promise<void>) {
  const ctx = await open(script);
  try {
    await body(ctx);
  } finally {
    await ctx.harness.close();
    await ctx.sandbox.close();
    await ctx.provider.close();
  }
}

async function open(script: Turn[]) {
  const provider = await startFakeProvider(script);
  const sandbox = await startAdapterOverFakeOrchestrator(SURFACE);
  const harness = await startHarness({ providerUrl: provider.url, adapterUrl: sandbox.url });
  return { provider, sandbox, harness, client: createFlueClient({ baseUrl: harness.url }) };
}

/** The j2 moment: the state exits (registration gone), then `abandon()` aborts the submission. */
async function endTheTurn(ctx: Awaited<ReturnType<typeof open>>): Promise<void> {
  ctx.sandbox.killSurface();
  await ctx.client.agents.abort(AGENT, IID);
}

test("ending a turn does not make the Harness log an error (ADR-0026)", async () => {
  // flue re-runs the agent initializer to open the session it writes its `submission_aborted`
  // advisory through — AFTER the turn is over. The Adapter used to answer that with a 404, so a
  // perfectly ordinary turn ending produced a stack trace every single time. It now answers with
  // an empty menu, and the advisory records.
  await scenario(
    [
      {
        text: "Verdict incoming.",
        toolCall: { id: "call_1", name: "mcp__j2__review_verdict", partial: true },
        stall: true,
      },
    ],
    async (ctx) => {
      const admission = await ctx.client.agents.send(AGENT, IID, { message: "Review the diff." });
      const settled = ctx.client.agents.wait(admission).catch(() => {});
      await until(() => ctx.provider.stalled(), "the model to start streaming its pick");

      // The advisory is written BEFORE the settlement that rejects `wait()`, so by here it has
      // either landed or failed — no polling needed to know which.
      await endTheTurn(ctx);
      await settled;

      assert.doesNotMatch(
        ctx.harness.output(),
        /Failed to record abort advisory/,
        "the advisory needs a session, and opening one re-enters the Adapter — which must answer",
      );
      assert.doesNotMatch(ctx.harness.output(), /code: 404/, "no 404 belongs in the happy path");
    },
  );
});

test("an abort mid-TOOL-CALL keeps the turn in history: the loop writes its own result", async () => {
  // The benign timing, and the common one: the pick was delivered, so the state exited while the
  // MCP call was still open. flue's loop catches the AbortError and settles the tool call itself,
  // so the assistant message keeps its pair and survives into the next turn.
  await scenario(
    [
      {
        text: "Here is my verdict.",
        toolCall: { id: "call_1", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' },
      },
      { text: "Acknowledged." },
    ],
    async (ctx) => {
      const admission = await ctx.client.agents.send(AGENT, IID, { message: "Review the diff." });
      const settled = ctx.client.agents.wait(admission).catch(() => {});
      await until(() => ctx.sandbox.delivered.length > 0, "the pick to be delivered");

      await endTheTurn(ctx);
      await settled;

      ctx.sandbox.reviveSurface();
      const next = await ctx.client.agents.send(AGENT, IID, { message: "Now summarize." });
      await ctx.client.agents.wait(next).catch(() => {});
      await until(() => ctx.provider.calls.length >= 2, "the next turn to reach the provider");

      const resumed = ctx.provider.calls[ctx.provider.calls.length - 1]!.messages;
      assert.ok(
        resumed.some((m) => m.role === "assistant" && JSON.stringify(m).includes("call_1")),
        `the delivered pick survived into the next turn (got: ${JSON.stringify(resumed.map((m) => m.role))})`,
      );
    },
  );
});

test("PINNED DEFECT: an abort mid-STREAM erases the assistant message from every later turn", async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // THIS TEST ASSERTS BROKEN BEHAVIOUR ON PURPOSE, and it is green because the
  // behaviour is still broken. When it FAILS, flue has fixed the defect: invert
  // the assertion and bump the pin. Do not "repair" it by loosening it.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // The poison timing: the abort lands while the model is still STREAMING the tool call, before
  // flue dispatches it. The assistant part stays `input-available` forever, and beta.9's
  // conversation projection emits an assistant message with tool calls only if the batch is
  // complete — so it drops the whole message, the pick AND the text it carried. No error is
  // raised: flue never puts an unpaired tool call on a provider wire, it deletes the message.
  //
  // beta.9 does ship the repair (`repairTrailingPartialToolBatch`), but it only inspects the
  // conversation after the new input's cut point, and the input is appended first — so the
  // stranded call is always already behind it. flue's unreleased line settles abandoned trailing
  // state BEFORE appending, which is the fix this test is waiting for.
  //
  // The window is not exotic. It is most of a real turn: a reviewer spends its wall clock
  // streaming a `notes` paragraph into exactly this tool call.
  await scenario(
    [
      {
        text: "I have reviewed it and my verdict is approved.",
        toolCall: { id: "call_1", name: "mcp__j2__review_verdict", partial: true },
        stall: true,
      },
      { text: "Acknowledged." },
    ],
    async (ctx) => {
      const admission = await ctx.client.agents.send(AGENT, IID, { message: "Review the diff." });
      const settled = ctx.client.agents.wait(admission).catch(() => {});
      await until(() => ctx.provider.stalled(), "the model to start streaming its pick");

      await endTheTurn(ctx);
      await settled;

      ctx.sandbox.reviveSurface();
      const next = await ctx.client.agents.send(AGENT, IID, { message: "Now summarize." });
      await ctx.client.agents.wait(next).catch(() => {});
      await until(() => ctx.provider.calls.length >= 2, "the next turn to reach the provider");

      // The turn itself is fine — this is silent context loss, not a fault. `session: "continue"`
      // works; it just works on an amnesiac transcript.
      const resumed = ctx.provider.calls[ctx.provider.calls.length - 1]!.messages;
      assert.ok(
        !resumed.some((m) => m.role === "assistant"),
        `beta.9 drops the interrupted assistant message. If this failed, flue FIXED IT — see the ` +
          `banner above (got: ${JSON.stringify(resumed.map((m) => m.role))})`,
      );
      assert.ok(
        !JSON.stringify(resumed).includes("my verdict is approved"),
        "the erased content includes the text the model had already committed to",
      );
    },
  );
});
