// Conformance (ADR-0027): the claims the socket-free tiers cannot see, driven through the REAL
// turn loop — pi at the exact pin, the real `@j2/adapter` over a real socket, a scripted
// OpenAI-compatible provider choosing each turn's shape. The flue-contract tier's role, re-owned:
// its claims are j2 requirements now, with the pinned-defect assertion INVERTED — an abort
// mid-stream must NOT erase the assistant message (the only witness is the message array the
// provider receives on the next turn). This suite runs in the default `test` gate (the opt-in
// existed only for the foreign pin) and is the canary for pi bumps.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hono } from "hono";
import type { Surface } from "@j2/adapter";
import { harnessApp } from "../src/app.ts";
import { dialFault, modelsFor, validateSpecModels } from "../src/provider.ts";
import type { AgentsSpec } from "../src/spec.ts";
import { runSubmissionFor } from "../src/turn.ts";
import type { HistoryView, Settlement, StreamEvent } from "../src/wire.ts";
import {
  severKeepAliveSockets,
  startAdapterOverFakeOrchestrator,
  startFakeProvider,
  until,
  type FakeProvider,
  type FakeSandbox,
} from "./support/rig.ts";

const AGENT = "reviewer";

/** One Menu of `ack` events, as the Orchestrator would register it (ADR-0013). */
function surfaceWith(...names: string[]): Surface {
  return {
    instanceId: "run-1/machine.reviewing/reviewer/s1",
    runId: "run-1",
    sandbox: "ws-1",
    accepts: names.map((name) => ({
      name,
      description: "Deliver it. Call it once, then stop.",
      input: {
        type: "object",
        properties: { verdict: { type: "string" }, notes: { type: "string" } },
        required: ["verdict"],
      },
      semantics: "ack" as const,
    })),
  };
}

let provider: FakeProvider;
let sandbox: FakeSandbox;
let app: Hono;
/** What each conversation printed (ADR-0023) — the pod log, keyed by iid. */
const printed = new Map<string, string>();
/** The would-be-fatal noise a clean turn end must not produce (ADR-0026). */
const rejections: unknown[] = [];
let stderrText = "";
let restoreStderr: () => void;
const onRejection = (reason: unknown) => rejections.push(reason);

before(async () => {
  provider = await startFakeProvider();
  sandbox = await startAdapterOverFakeOrchestrator(surfaceWith("review_verdict"));
  const spec: AgentsSpec = {
    agents: [
      {
        name: AGENT,
        definition: {
          model: "fake/model-x",
          instructions: "Review what you are handed, then answer through the menu.",
          cwd: tmpdir(),
        },
      },
    ],
    harness: {
      provider: {
        id: "fake",
        api: "openai-completions",
        baseUrl: provider.url,
        contextWindow: 200_000,
        maxTokens: 8192,
        models: { "model-x": {} },
      },
    },
  };
  const models = modelsFor(spec.harness, {});
  validateSpecModels(spec, models);
  app = harnessApp({
    spec,
    longPollMs: 250,
    // The real composition (`main.ts`): admission rejects a dial the turn could not run.
    checkDials: (dials) => dialFault(models, dials),
    runSubmissionFor: (seat) =>
      runSubmissionFor({
        spec,
        models,
        adapterUrl: sandbox.url,
        // No provider-stream retries: a scripted failure must settle on the first attempt.
        maxRetries: 0,
        printerOut: {
          write: (chunk) => printed.set(seat.instanceId, (printed.get(seat.instanceId) ?? "") + chunk),
        },
        ...seat,
      }),
  });
  process.on("unhandledRejection", onRejection);
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    stderrText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = write;
  };
});

after(async () => {
  process.off("unhandledRejection", onRejection);
  restoreStderr();
  // Client sockets first: each conversation's last Menu connection is open by design, and the
  // Adapter's close would otherwise wait out a keep-alive on sockets nothing will reuse.
  await severKeepAliveSockets();
  await sandbox.close();
  await provider.close();
});

function conversationPath(iid: string): string {
  return `/agents/${AGENT}/${encodeURIComponent(iid)}`;
}

async function admit(
  iid: string,
  message: string,
  dials?: { model?: string; thinkingLevel?: string },
): Promise<{ offset: string; submissionId: string }> {
  const res = await app.request(conversationPath(iid), {
    method: "POST",
    body: JSON.stringify({ message, ...dials }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { offset: string; submissionId: string };
}

async function abort(iid: string): Promise<{ aborted: boolean }> {
  const res = await app.request(`${conversationPath(iid)}/abort`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await res.json()) as { aborted: boolean };
}

/** Long-poll the stream from the Admission's offset until its Submission settles — the wire's
 * only wait transport, exercised the way the Orchestrator's `wait` will drive it. */
async function settled(iid: string, admission: { offset: string; submissionId: string }): Promise<Settlement> {
  let offset = admission.offset;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await app.request(`${conversationPath(iid)}?offset=${offset}&live=long-poll`);
    offset = res.headers.get("stream-next-offset") ?? offset;
    if (res.status === 204) continue;
    assert.equal(res.status, 200);
    for (const event of (await res.json()) as StreamEvent[]) {
      if (event.type === "submission-settled" && event.submissionId === admission.submissionId) {
        return event;
      }
    }
  }
  throw new Error(`timed out waiting for ${admission.submissionId} to settle`);
}

async function history(iid: string): Promise<HistoryView> {
  const res = await app.request(`${conversationPath(iid)}?view=history`);
  assert.equal(res.status, 200);
  return (await res.json()) as HistoryView;
}

test("the Menu is listed fresh per Submission: a surface change lands on the next turn (ADR-0013)", async () => {
  provider.reset([{ text: "Looked." }, { text: "Looked again." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/menu";

  const first = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, first)).outcome, "completed");
  sandbox.setSurface(surfaceWith("submit_summary"));
  const second = await admit(iid, "Summarize.");
  assert.equal((await settled(iid, second)).outcome, "completed");

  const menus = provider.calls.map((call) => (call.tools ?? []).map((tool) => tool.function?.name));
  assert.ok(menus[0]?.includes("mcp__j2__review_verdict"), `turn 1 sees its Menu (got: ${menus[0]})`);
  assert.ok(!menus[0]?.includes("mcp__j2__submit_summary"), "turn 1 cannot see the next state's Menu");
  assert.ok(menus[1]?.includes("mcp__j2__submit_summary"), `turn 2 sees the NEW Menu (got: ${menus[1]})`);
  assert.ok(!menus[1]?.includes("mcp__j2__review_verdict"), "turn 2 no longer sees the exited state's Menu");
  for (const working of ["read", "write", "edit", "bash", "grep", "glob"]) {
    assert.ok(menus[0]?.includes(working), `the Working tools ride along (missing: ${working})`);
  }
});

test("a per-turn model dial reaches the wire, on the SAME conversation (ADR-0018 as amended)", async () => {
  provider.reset([{ text: "One." }, { text: "Two." }, { text: "Three." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/dials";

  // Three Submissions on one conversation — the `session: "continue"` shape, where the harness is
  // assembled once and later turns reconcile onto it (`setModel`). The definition's model, then a
  // dial, then back to the definition's when the dial is gone.
  const first = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, first)).outcome, "completed");
  const second = await admit(iid, "Review it harder.", { model: "fake/model-y", thinkingLevel: "xhigh" });
  assert.equal((await settled(iid, second)).outcome, "completed");
  const third = await admit(iid, "Back to normal.");
  assert.equal((await settled(iid, third)).outcome, "completed");

  assert.deepEqual(
    provider.calls.map((call) => call.model),
    ["model-x", "model-y", "model-x"],
    "the dial is per-SUBMISSION, not sticky on the conversation",
  );
  // The conversation itself survived the swap: turn 3 still sees turns 1-2 (one pi session, one
  // assembled harness — the dial reconciles onto it rather than rebuilding it).
  assert.ok(
    provider.calls[2]!.messages.length > provider.calls[0]!.messages.length,
    "the context accumulated across the model change",
  );
});

test("an unresolvable dial is a 400 at admission — the turn never starts", async () => {
  provider.reset([{ text: "Unreached." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const res = await app.request(conversationPath("conf/bad-dial"), {
    method: "POST",
    body: JSON.stringify({ message: "go", model: "ghost/x" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 0, "no provider request was ever made");
});

test("a Menu pick reaches the Orchestrator and its receipt reaches the model; the Submission settles completed", async () => {
  provider.reset([
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/leash";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "completed");

  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  const followUp = provider.calls[1]?.messages ?? [];
  const receipt = followUp.find((m) => m.role === "tool");
  assert.ok(
    JSON.stringify(receipt ?? {}).includes('Delivered \\"review_verdict\\"'),
    `the delivery receipt is the tool result the model reads (got: ${JSON.stringify(receipt)})`,
  );
});

test("INVERTED PINNED DEFECT: an abort mid-STREAM does not erase the assistant message", async () => {
  // The poison timing flue-contract pinned as broken: the abort lands while the model is still
  // STREAMING its pick. What the model had already committed to must survive into every later
  // turn — silent context loss is the defect ADR-0027 refused to keep waiting on.
  provider.reset([
    {
      text: "I have reviewed it and my verdict is approved.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", partial: true },
      stall: true,
    },
    { text: "Acknowledged." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/mid-stream";

  const admission = await admit(iid, "Review the diff.");
  await until(() => provider.stalled(), "the model to start streaming its pick");
  // `stalled` says the frames are on the wire, not that pi folded them into its partial message —
  // nothing observable marks that moment, and an abort that outruns the parser leaves nothing to
  // preserve (which is not this claim). Give the parser room.
  await sleep(300);
  // The j2 moment (ADR-0024): the state exits (registration gone), then the turn is aborted.
  sandbox.killSurface();
  assert.deepEqual(await abort(iid), { aborted: true });
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "aborted");
  assert.deepEqual(settlement.error, { type: "submission_aborted" });

  sandbox.reviveSurface();
  const next = await admit(iid, "Now summarize.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  const resumed = provider.calls.at(-1)?.messages ?? [];
  assert.ok(
    resumed.some((m) => m.role === "assistant" && JSON.stringify(m).includes("my verdict is approved")),
    `the interrupted assistant message survived into the next turn (got: ${JSON.stringify(resumed.map((m) => m.role))})`,
  );
});

test("an abort mid-TOOL-CALL keeps the turn in history: the loop writes its own result", async () => {
  // The benign timing, and the common one: the pick was delivered, so the state exited while the
  // MCP call was still open. The loop settles the tool call itself, so the assistant message
  // keeps its pair and survives into the next turn.
  provider.reset([
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "Acknowledged." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  sandbox.holdDeliveries();
  const iid = "conf/mid-call";

  const admission = await admit(iid, "Review the diff.");
  await until(() => sandbox.delivered.length > 0, "the pick to be delivered");
  sandbox.killSurface();
  await abort(iid);
  assert.equal((await settled(iid, admission)).outcome, "aborted");

  sandbox.reset(surfaceWith("review_verdict"));
  const next = await admit(iid, "Now summarize.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  const resumed = provider.calls.at(-1)?.messages ?? [];
  assert.ok(
    resumed.some((m) => m.role === "assistant" && JSON.stringify(m).includes("call_1")),
    `the delivered pick survived into the next turn (got: ${JSON.stringify(resumed.map((m) => m.role))})`,
  );
});

test("ending a turn logs no error: no 404 spam, no unhandled rejection (ADR-0026)", async () => {
  provider.reset([
    {
      text: "Verdict incoming.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", partial: true },
      stall: true,
    },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/turn-end";
  const stderrMark = stderrText.length;
  const rejectionsMark = rejections.length;

  const admission = await admit(iid, "Review the diff.");
  await until(() => provider.stalled(), "the model to start streaming its pick");
  sandbox.killSurface();
  await abort(iid);
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  await sleep(100); // a stray rejection surfaces on a later tick — give it room to land

  assert.deepEqual(
    rejections.slice(rejectionsMark),
    [],
    "a perfectly ordinary turn ending must not leave a rejection nothing awaits",
  );
  const logged = stderrText.slice(stderrMark) + (printed.get(iid) ?? "");
  assert.doesNotMatch(logged, /404/, "no 404 belongs in the happy path (ADR-0026)");
});

test("history settlements from the real loop match the wire contract: outcomes and exact counts", async () => {
  provider.reset([{ text: "First." }, { status: 500 }, { stall: true }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/settlements";

  const s1 = await admit(iid, "one");
  assert.equal((await settled(iid, s1)).outcome, "completed");
  const s2 = await admit(iid, "two");
  assert.equal((await settled(iid, s2)).outcome, "failed");
  const s3 = await admit(iid, "three");
  await until(() => provider.stalled(), "the third turn to start streaming");
  await abort(iid);
  await settled(iid, s3);

  const view = await history(iid);
  assert.equal(view.v, 1);
  assert.equal(view.conversationId, iid);
  assert.deepEqual(
    view.settlements.map((s) => ({ submissionId: s.submissionId, outcome: s.outcome, errorType: s.error?.type })),
    [
      { submissionId: s1.submissionId, outcome: "completed", errorType: undefined },
      { submissionId: s2.submissionId, outcome: "failed", errorType: "submission_failed" },
      { submissionId: s3.submissionId, outcome: "aborted", errorType: "submission_aborted" },
    ],
  );
  assert.ok(
    view.messages.some((m) => m.role === "assistant" && m.text === "First."),
    "the completed turn's text lands in the best-effort messages",
  );
});

test("the printer wrote the conversation: prompts, text, tool calls — results never (ADR-0023)", async () => {
  provider.reset([
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "All done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/printer";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "completed");

  const log = printed.get(iid) ?? "";
  const lines = log.split("\n");
  assert.ok(lines.includes(`[${AGENT}] [prompt] Review the diff.`), `no prompt line in:\n${log}`);
  assert.ok(lines.includes(`[${AGENT}] [text] Here is my verdict.`), `no assistant text line in:\n${log}`);
  assert.ok(
    lines.includes(`[${AGENT}] [review_verdict] {"verdict":"approved"}`),
    `no bare-named tool-call line in:\n${log}`,
  );
  assert.ok(lines.includes(`[${AGENT}] [text] All done.`), `no second-turn text line in:\n${log}`);
  assert.ok(!log.includes("Delivered"), "a tool RESULT is a boundary, never printed (ADR-0023)");
});
