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
import { admissionFault, modelsFor } from "../src/provider.ts";
import type { AgentDefinition, HarnessSpec } from "../src/spec.ts";
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
/** The Menu-only persona (ADR-0028 `workspace: "none"`): picks from its Menu, nothing else. */
const DECISIONER = "decisioner";

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

/** The Agents this suite runs, as the Machines that carry them would hand them over — every
 * admission below carries one (ADR-0049); this process holds no roster. */
const definitions: Record<string, AgentDefinition> = {
  [AGENT]: {
    model: "fake/model-x",
    instructions: "Review what you are handed, then answer through the menu.",
    cwd: tmpdir(),
  },
  // No cwd on purpose — it is moot for `workspace: "none"` (only Working tools consume it), so
  // the /work default resolving to a directory that does not exist must not matter.
  [DECISIONER]: {
    model: "fake/model-x",
    instructions: "Read the inputs, then pick the next event from the menu.",
    workspace: "none",
  },
};

let provider: FakeProvider;
let sandbox: FakeSandbox;
let app: Hono;
/** The same composition under a toy step budget (ADR-0035) — proving `exceeded 256 steps` at the
 * shipped bound would run 256 provider rounds. The knob is a test seam, never an author surface. */
let boundedApp: Hono;
/** The same composition under a toy retained tail (ADR-0036). The threshold needs no seam —
 * fabricated usage crosses it — but the CUT does: at the shipped 20000 a scripted transcript of a
 * few hundred characters never reaches the retention budget, so pi keeps everything and summarizes
 * nothing, and no test could see a context shrink. */
let compactApp: Hono;
/** Both toy bounds at once — the only way to watch a Compaction and a Runaway share one turn. */
let boundedCompactApp: Hono;
/** Small enough that the cut lands near the tail of a scripted transcript. */
const KEEP_RECENT = 12;
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
  const harness: HarnessSpec = {
    provider: {
      id: "fake",
      api: "openai-completions",
      baseUrl: provider.url,
      contextWindow: 200_000,
      maxTokens: 8192,
      // `model-zero` declares no window of its own (per-model 0 beats the provider default,
      // `provider.ts`) — the shape ADR-0036 requires compaction to stay OFF for.
      models: { "model-x": {}, "model-zero": { contextWindow: 0, maxTokens: 8192 } },
    },
  };
  const models = modelsFor(harness, {});
  const appWith = (seams?: { stepBudget?: number; identicalCallLimit?: number; keepRecentTokens?: number }): Hono =>
    harnessApp({
      longPollMs: 250,
      // The real composition (`main.ts`): admission rejects a definition (or dial) the turn
      // could not run.
      checkAdmission: (resolved) => admissionFault(models, resolved),
      runSubmissionFor: (seat) =>
        runSubmissionFor({
          models,
          adapterUrl: sandbox.url,
          // No provider-stream retries: a scripted failure must settle on the first attempt.
          maxRetries: 0,
          printerOut: {
            write: (chunk) => printed.set(seat.instanceId, (printed.get(seat.instanceId) ?? "") + chunk),
          },
          ...seams,
          ...seat,
        }),
    });
  app = appWith();
  boundedApp = appWith({ stepBudget: 3 });
  compactApp = appWith({ keepRecentTokens: KEEP_RECENT });
  boundedCompactApp = appWith({ stepBudget: 3, keepRecentTokens: KEEP_RECENT });
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

function conversationPath(iid: string, agent = AGENT): string {
  return `/agents/${agent}/${encodeURIComponent(iid)}`;
}

async function admit(
  iid: string,
  message: string,
  dials?: { model?: string; thinkingLevel?: string },
  agent = AGENT,
  via: Hono = app,
): Promise<{ offset: string; submissionId: string }> {
  const res = await via.request(conversationPath(iid, agent), {
    method: "POST",
    // The definition rides every admission (ADR-0049) — the real turn loop reads the one it was
    // handed, so this suite hands it the same one the Machine's slot would.
    body: JSON.stringify({ message, definition: definitions[agent], ...dials }),
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
async function settled(
  iid: string,
  admission: { offset: string; submissionId: string },
  agent = AGENT,
  via: Hono = app,
): Promise<Settlement> {
  let offset = admission.offset;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await via.request(`${conversationPath(iid, agent)}?offset=${offset}&live=long-poll`);
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

async function history(iid: string, via: Hono = app): Promise<HistoryView> {
  const res = await via.request(`${conversationPath(iid)}?view=history`);
  assert.equal(res.status, 200);
  return (await res.json()) as HistoryView;
}

/** How a Compaction shows on the wire: pi renders its compaction entry as a USER message under
 * this prefix (`COMPACTION_SUMMARY_PREFIX`), so a request carrying one is a request the cut
 * already reached. */
const SUMMARY_MARK = "The conversation history before this point was compacted";

function carriesSummary(call: { messages: Array<Record<string, unknown>> } | undefined): boolean {
  return JSON.stringify(call?.messages ?? []).includes(SUMMARY_MARK);
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

test("a Menu read the Adapter cannot answer fails the turn before the model is ever asked", async () => {
  provider.reset([{ text: "never reached" }]);
  sandbox.reset(surfaceWith("review_verdict"));
  // Not a 404 (that is ADR-0026's empty menu, and a turn still runs): the Orchestrator answered
  // the Adapter with a fault, which is what a blip on the pod→Orchestrator hop looks like.
  sandbox.faultSurface();
  const iid = "conf/menu-fault";

  const admission = await admit(iid, "Review the diff.");
  const settlement = await settled(iid, admission);

  assert.equal(settlement.outcome, "failed", "a turn that cannot see its Menu settles failed (ADR-0027)");
  assert.equal(
    provider.calls.length,
    0,
    "the Menu is fetched BEFORE the model is asked, so this turn never reached the provider",
  );
});

test('workspace "none" is the Menu-only shape: no Working tools offered, settled by pick alone (ADR-0028/0031)', async () => {
  provider.reset([
    {
      text: "Read the inputs; approving.",
      toolCall: { id: "call_1", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/menu-only";

  const admission = await admit(iid, "Decide.", undefined, DECISIONER);
  assert.equal((await settled(iid, admission, DECISIONER)).outcome, "completed");

  // The Menu is the whole toolset: on every request the model saw its Menu and NOTHING else —
  // no read/write/edit/bash/grep/glob was offered, so none was executable (ADR-0028).
  for (const call of provider.calls) {
    assert.deepEqual(
      (call.tools ?? []).map((tool) => tool.function?.name),
      ["mcp__j2__review_verdict"],
      "a Menu-only turn offers the Menu alone",
    );
  }
  // …and the pick alone is what settled the turn: it reached the Orchestrator as a delivery.
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
});

test("a per-turn model dial reaches the wire, on the SAME conversation (ADR-0018)", async () => {
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

test('K byte-identical tool calls are a Runaway: the Harness ends the turn, typed "runaway" (ADR-0035)', async () => {
  // The production shape: the model collapses into the same call forever. K=4 is the j2-owned
  // default — no knob injected here, the shipped bound is the claim. The tripping call is the
  // 4th, and it never executes, so no 5th provider round-trip exists.
  const repeated = { name: "bash", args: '{"command":"true"}' };
  provider.reset([
    { text: "Searching.", toolCall: { id: "call_1", ...repeated } },
    { toolCall: { id: "call_2", ...repeated } },
    { toolCall: { id: "call_3", ...repeated } },
    { toolCall: { id: "call_4", ...repeated } },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/runaway-identical";
  const rejectionsMark = rejections.length;

  const admission = await admit(iid, "Find the flag.");
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "failed", 'a runaway settles FAILED — "aborted" stays the sweep\'s word (ADR-0024)');
  assert.deepEqual(settlement.error, { type: "runaway", message: "repeated an identical tool call 4 times" });
  assert.equal(provider.calls.length, 4, "the 4th identical call trips before executing — no 5th round-trip");

  // The self-abort is clean (ADR-0026) and the conversation is not poisoned at the wire level: a
  // later Submission on the same conversation still runs and completes (the reroll's fresh
  // conversation is the Agent actor's policy, not a Harness constraint).
  await sleep(100); // a stray rejection surfaces on a later tick — give it room to land
  assert.deepEqual(rejections.slice(rejectionsMark), [], "the self-abort leaves no rejection nothing awaits");
  const next = await admit(iid, "Answer in text.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  assert.deepEqual(
    (await history(iid)).settlements.map((s) => ({ outcome: s.outcome, errorType: s.error?.type })),
    [
      { outcome: "failed", errorType: "runaway" },
      { outcome: "completed", errorType: undefined },
    ],
  );
});

test('the step budget is the unconditional backstop: varied calls past the bound settle "runaway" (ADR-0035)', async () => {
  // Honest dithering that never repeats — only the budget catches it. Every command differs, so
  // the identical-call trigger stays quiet; the call past the budget (the 4th, over this app's
  // toy bound of 3) trips without executing.
  provider.reset(
    Array.from({ length: 4 }, (_, i) => ({
      toolCall: { id: `call_${i + 1}`, name: "bash", args: `{"command":"echo ${i}"}` },
    })),
  );
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/runaway-budget";

  const admission = await admit(iid, "Keep busy.", undefined, AGENT, boundedApp);
  const settlement = await settled(iid, admission, AGENT, boundedApp);
  assert.equal(settlement.outcome, "failed");
  assert.deepEqual(settlement.error, { type: "runaway", message: "exceeded 3 steps" });
  assert.equal(provider.calls.length, 4, "the call past the budget trips before executing — no further round-trip");
});

test("a turn compacts MID-flight: the cut lands between two steps of ONE Submission (ADR-0036)", async () => {
  // The claim that distinguishes ADR-0036 from flue's turn-boundary split, and the failure it was
  // written for: run `588b0f5e` filled its window at step ~161 of a single turn. Step 4's response
  // reports a context past the reserve (window 200000 − max(16384, 8192) = 183616), so the cut
  // must happen inside the turn, and the very next provider request must already carry it.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo 1"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo 2"}' } },
    { toolCall: { id: "call_3", name: "bash", args: '{"command":"echo 3"}' } },
    { toolCall: { id: "call_4", name: "bash", args: '{"command":"echo 4"}' }, usage: { prompt_tokens: 190_000 } },
    { toolCall: { id: "call_5", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-midturn";

  const admission = await admit(iid, "Find the flag.", undefined, AGENT, compactApp);
  const settlement = await settled(iid, admission, AGENT, compactApp);
  assert.equal(settlement.outcome, "completed");

  assert.equal(provider.summaries.length, 1, "one cut, one summarizer call");
  assert.equal(provider.calls.length, 6, "the summarizer is not a step: the turn ran its script");
  // MID-flight: the summary was fetched AFTER the request that crossed and BEFORE the next one.
  assert.ok(
    provider.calls[3]!.seq < provider.summaries[0]!.seq && provider.summaries[0]!.seq < provider.calls[4]!.seq,
    `the cut landed between two steps (calls ${provider.calls.map((c) => c.seq)}, summary ${provider.summaries[0]!.seq})`,
  );
  // …and the request that NOTICED is already compacted — no round-trip is spent on a full window.
  assert.ok(!carriesSummary(provider.calls[3]), "the pre-cut steps carried no summary");
  assert.ok(carriesSummary(provider.calls[4]), "the step after the cut carries the summary");
  assert.ok(
    provider.calls[4]!.messages.length < provider.calls[3]!.messages.length,
    `the context SHRANK (${provider.calls[3]!.messages.length} → ${provider.calls[4]!.messages.length})`,
  );
  // …and it KEEPS carrying it. This is the pi-bump canary ADR-0036 names: the mechanism is
  // `prepareNextTurn` rebuilding the loop's context from the Session at every step boundary, and
  // `buildContext` replaying from the latest compaction entry — behavior pi documents in types but
  // does not promise as a caller contract.
  assert.ok(carriesSummary(provider.calls[5]), "the NEXT step rebuilt from the cut Session too");
  // The turn went on to its pick: a compacted turn still concludes (ADR-0006).
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // One Submission, one settlement — the cut settles nothing, and it leaves no history entry: j2
  // records what was SAID, and Compaction changes only what the model sees (ADR-0036).
  const view = await history(iid, compactApp);
  assert.deepEqual(
    view.settlements.map((s) => s.outcome),
    ["completed"],
  );
  assert.ok(!JSON.stringify(view.messages).includes(SUMMARY_MARK), "the summary is not history");
  // Visible in the pod log, and only there (ADR-0023).
  const log = printed.get(iid) ?? "";
  const compacted = log.split("\n").filter((line) => line.includes("[compacted]"));
  assert.equal(compacted.length, 1, `exactly one Compaction line in:\n${log}`);
  const numbers = new RegExp(
    `^\\[${AGENT}\\] \\[compacted\\] context (\\d+) → ~(\\d+) tokens \\(window 200000\\)$`,
  ).exec(compacted[0]!);
  assert.ok(numbers, `the Compaction line's shape in:\n${log}`);
  assert.match(numbers[1]!, /^190\d{3}$/, "before is the provider count that crossed the reserve");
  // The RELATION, not just the shape. The line reports what REMAINS, so measuring it with
  // `estimateContextTokens` would re-read the retained tail's surviving pre-cut usage and print a
  // cut that changed nothing (`compaction.ts` says why) — a line that reads healthy while reporting
  // a no-op. The bound is loose on purpose: the two numbers are mixed units (a provider count
  // against a character heuristic) and a pi bump may drift the heuristic; an order of magnitude is
  // what a reader of 161 tool calls needs, and it is what a no-op cut cannot fake.
  assert.ok(
    Number(numbers[2]) < Number(numbers[1]) / 10,
    `the cut reports a SMALLER context (${numbers[1]} → ${numbers[2]})`,
  );
});

test("a fresh Submission compacts BEFORE it asks: the nudge ladder's rescue (ADR-0016/0036)", async () => {
  // ADR-0016's no-signal ladder continues the SAME conversation, so at a full window every nudge
  // was structurally futile — the regression that took run `588b0f5e` to a humanReview park. The
  // `context` hook fires before a turn's FIRST request too, so the nudge compacts before it asks.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo a"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo b"}' } },
    { text: "Investigated.", usage: { prompt_tokens: 190_000 } },
    { text: "Summarized." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-nudge";

  const first = await admit(iid, "Investigate the crash.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, first, AGENT, compactApp)).outcome, "completed");
  assert.equal(provider.summaries.length, 0, "the turn ended with room to spare — nothing to cut yet");
  assert.equal(provider.calls.length, 3);

  // The nudge shape: a fresh admission on a conversation that is already over the threshold. Its
  // dials differ from the definition's ON PURPOSE — see the summarizer assertions below.
  const nudge = await admit(iid, "Now summarize.", { model: "fake/model-y", thinkingLevel: "high" }, AGENT, compactApp);
  assert.equal((await settled(iid, nudge, AGENT, compactApp)).outcome, "completed");

  assert.equal(provider.calls.length, 4);
  assert.equal(provider.summaries.length, 1);
  assert.ok(
    provider.calls[2]!.seq < provider.summaries[0]!.seq && provider.summaries[0]!.seq < provider.calls[3]!.seq,
    "the cut happened between the two Submissions, not during the first",
  );
  assert.ok(carriesSummary(provider.calls[3]), "the nudge's FIRST request already carries the cut");

  // The summarizer is THIS Turn's model and THIS Turn's thinking level (ADR-0036) — mechanism
  // inherits from the Dials, so a separate compaction model never needs its own provider entry,
  // its own boot validation, or its own unresolvable-model failure at the moment context is
  // already full. The dial is what makes the claim falsifiable: Submission 1 ran the definition's
  // `model-x` at no thinking level, and the cut is taken by Submission 2, so a hardcoded id or a
  // seat captured at the FIRST Submission would both name `model-x` here.
  assert.equal(provider.summaries[0]!.model, "model-y", "the summarizer ran the Turn's dialled model");
  assert.equal(provider.summaries[0]!.reasoning_effort, "high", "…at the Turn's dialled thinking level");
  assert.equal(provider.calls[3]!.model, "model-y", "and the Turn itself ran on the same one");
});

test("a SECOND cut in one Submission keeps the first cut's retained tail (ADR-0036)", async () => {
  // ADR-0036's own workload cuts more than once: the 161-step turn on a 131k window fills the
  // window repeatedly. Every cut retains up to `keepRecentTokens` of the most recent work
  // VERBATIM, and the next cut must be able to reach that work — pi's compaction entry may carry
  // its tail on the ENTRY, and then the next cut's boundary walk cannot find the entry on a path
  // truncated at it, so the tail is neither summarized nor kept. Silent amnesia of the most recent
  // work is the exact failure this ADR exists to prevent, so it is pinned end-to-end: every mark
  // the agent produced must survive somewhere the model can still read it.
  const marks = ["MARKAAA", "MARKBBB", "MARKCCC", "MARKDDD", "MARKEEE", "MARKFFF"];
  provider.reset([
    ...marks.map((mark, i) => ({
      toolCall: { id: `call_${i + 1}`, name: "bash", args: `{"command":"echo ${mark}"}` },
      // Responses 3 and 6 cross the reserve, so two cuts land inside ONE Submission.
      ...(i === 2 || i === 5 ? { usage: { prompt_tokens: 190_000 } } : {}),
    })),
    { toolCall: { id: "call_7", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-twice";

  const admission = await admit(iid, "Find the flag.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, admission, AGENT, compactApp)).outcome, "completed");

  assert.equal(provider.summaries.length, 2, "two cuts, in ONE Submission");
  assert.equal(provider.calls.length, 8, "neither summarizer call is a step");
  // Nothing was deleted. A mark is either in a summarizer's input (it was summarized) or in the
  // last request (it is still verbatim in the context) — a mark in NEITHER is work the model can
  // no longer see and no summary describes.
  const survived = JSON.stringify(provider.summaries) + JSON.stringify(provider.calls.at(-1));
  for (const mark of marks) {
    assert.ok(survived.includes(mark), `${mark} was summarized or retained, not dropped by the second cut`);
  }
  // …and the second cut is a real one, not a re-summary of the first cut's summary alone.
  assert.ok(
    JSON.stringify(provider.summaries[1]!.messages).includes("MARKCCC"),
    "the second cut summarized the work the FIRST cut had retained",
  );
  const compacted = (printed.get(iid) ?? "").split("\n").filter((line) => line.includes("[compacted]"));
  assert.equal(compacted.length, 2, `two Compaction lines in:\n${printed.get(iid) ?? ""}`);
});

test("a cut followed by a request that FAILS does not cut again on the stale reading (ADR-0036)", async () => {
  // pi's estimate reads the last VALID assistant usage, and a cut deliberately RETAINS recent
  // assistant messages — so the reading that triggered a cut survives it. A request that ends
  // `error` contributes no usage of its own, leaving that stale number the newest one: without the
  // latch the next Submission on this conversation cuts AGAIN, spending a summarizer round-trip
  // and a second summary on a context nothing has grown since.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo MARK_ONE"}' } },
    {
      toolCall: { id: "call_2", name: "bash", args: '{"command":"echo MARK_TWO"}' },
      usage: { prompt_tokens: 190_000 },
    },
    // The post-cut request contributes no valid usage; with `maxRetries: 0` it settles on the first
    // attempt.
    { status: 500 },
    { text: "Recovered." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-stale";

  const first = await admit(iid, "Find the flag.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, first, AGENT, compactApp)).outcome, "failed");
  assert.equal(provider.summaries.length, 1, "the crossing bought exactly one cut");

  const next = await admit(iid, "Try again.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, next, AGENT, compactApp)).outcome, "completed");
  assert.equal(provider.summaries.length, 1, "the stale reading did not buy a second cut");
  // The content assertion is the one that bites: it fails on loss, not on a summarizer count, so it
  // survives a refactor that merely moves the latch.
  assert.ok(
    JSON.stringify(provider.calls.at(-1)!.messages).includes("MARK_TWO"),
    "the first cut's retained tail is still in the context",
  );
});

test("a model with no declared contextWindow does not compact — inert is said out loud (ADR-0036)", async () => {
  // `contextWindow` is a fact about an endpoint, not a knob: a provider spec that omits it
  // resolves to 0, and compaction is OFF rather than firing on every request.
  provider.reset([{ text: "Filled the window.", usage: { prompt_tokens: 190_000 } }, { text: "Still filled." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-inert";
  const dial = { model: "fake/model-zero" };

  const first = await admit(iid, "Read everything.", dial, AGENT, compactApp);
  assert.equal((await settled(iid, first, AGENT, compactApp)).outcome, "completed");
  const second = await admit(iid, "Read more.", dial, AGENT, compactApp);
  assert.equal((await settled(iid, second, AGENT, compactApp)).outcome, "completed");

  assert.equal(provider.summaries.length, 0, "no window declared, no cut — and no cut on EVERY request either");
  assert.ok(!carriesSummary(provider.calls[1]), "the second turn saw its whole context");
  assert.equal((printed.get(iid) ?? "").includes("[compacted]"), false);
});

test("ADR-0035's counters do not reset on Compaction, and the cut is not a step", async () => {
  // The watch counts tool calls per Submission; Compaction is a fact about tokens. A turn that
  // compacts and continues is still spending its one step budget — so on this app's toy bound of
  // 3, the 4th tool call trips even though a cut happened in between.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo 0"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo 1"}' }, usage: { prompt_tokens: 190_000 } },
    { toolCall: { id: "call_3", name: "bash", args: '{"command":"echo 2"}' } },
    { toolCall: { id: "call_4", name: "bash", args: '{"command":"echo 3"}' } },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-runaway";

  const admission = await admit(iid, "Keep busy.", undefined, AGENT, boundedCompactApp);
  const settlement = await settled(iid, admission, AGENT, boundedCompactApp);
  assert.equal(settlement.outcome, "failed");
  assert.deepEqual(settlement.error, { type: "runaway", message: "exceeded 3 steps" });
  assert.equal(provider.summaries.length, 1, "the cut happened — and did not buy the turn a fourth step");
  assert.equal(provider.calls.length, 4, "the call past the budget trips before executing");
});

test("a runaway trip on the CROSSING response takes no cut at all (ADR-0035/0036)", async () => {
  // The trip and the crossing on the SAME response — the ordinary shape, since the estimate reads
  // the previous response's usage, so a crossing at response k has had no earlier pass to act on
  // it. ADR-0035's trip aborts pi's OWN controller, and pi has no signal check between a blocked
  // tool batch and the next request, so the loop takes one more pass through the `context` hook —
  // where the Submission's signal (all this seat can see) has not fired. A cut there would spend a
  // full-window summarization, and an unbounded wait on it, for a request that is aborted before
  // it is sent — and would leave a compaction entry and a `[compacted]` line making a killed turn
  // read as a healthy one.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo 0"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo 1"}' } },
    { toolCall: { id: "call_3", name: "bash", args: '{"command":"echo 2"}' } },
    // The 4th call is over this app's toy budget of 3, and its response is also the one that
    // crosses the reserve.
    { toolCall: { id: "call_4", name: "bash", args: '{"command":"echo 3"}' }, usage: { prompt_tokens: 190_000 } },
  ]);
  // A summarizer that never answers: if the dead turn took a cut, this Submission would never
  // settle at all, which is precisely the liveness ADR-0035's watch exists to guarantee.
  provider.summarize({ stall: true });
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-runaway-trip";

  const admission = await admit(iid, "Keep busy.", undefined, AGENT, boundedCompactApp);
  const settlement = await settled(iid, admission, AGENT, boundedCompactApp);
  provider.summarize({});
  assert.equal(settlement.outcome, "failed");
  assert.deepEqual(settlement.error, { type: "runaway", message: "exceeded 3 steps" });
  assert.equal(provider.summaries.length, 0, "an ended turn buys no summarizer round-trip");
  assert.equal(provider.calls.length, 4, "the call past the budget trips before executing");
  assert.equal((printed.get(iid) ?? "").includes("[compacted]"), false, "a killed turn does not read as a healthy one");
});

test("a Compaction that fails settles the Submission failed — an ADR-0016 infra fault, no new class", async () => {
  // A legible compaction failure beats walking into an overflow that surfaces as truncation. The
  // summarizer answers 500; with this composition's `maxRetries: 0` there is no second attempt.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo a"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo b"}' }, usage: { prompt_tokens: 190_000 } },
    { text: "Unreached." },
  ]);
  provider.summarize({ status: 500 });
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-failure";
  const rejectionsMark = rejections.length;

  const admission = await admit(iid, "Review the diff.", undefined, AGENT, compactApp);
  const settlement = await settled(iid, admission, AGENT, compactApp);
  assert.equal(settlement.outcome, "failed");
  assert.equal(settlement.error?.type, "submission_failed", "infra, not a new fault class");
  // …and legible: the reason reaches the settlement, which is the whole point of failing here
  // rather than walking into an overflow that surfaces as truncation.
  assert.match(settlement.error?.message ?? "", /summarization failed/i);
  assert.equal(provider.summaries.length, 1);
  assert.equal(provider.calls.length, 2, "the turn never made the request it could not fit");

  await sleep(100); // a stray rejection surfaces on a later tick — give it room to land
  assert.deepEqual(rejections.slice(rejectionsMark), [], "a failing cut leaves no rejection nothing awaits");
  // The conversation is not poisoned: a later Submission still runs (the summarizer is healthy
  // again, and this one has room).
  provider.summarize({});
  const next = await admit(iid, "Answer in text.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, next, AGENT, compactApp)).outcome, "completed");
});

test("a healthy turn is untouched: varied calls, a sub-K repeat, then the pick (ADR-0035)", async () => {
  // The watch counts CONSECUTIVE identical calls, and any different call resets the run — the
  // read → edit → read shape the ADR keeps legitimate. Two identical, a break, one more: never K.
  provider.reset([
    { text: "Looking.", toolCall: { id: "call_1", name: "bash", args: '{"command":"echo a"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo a"}' } },
    { toolCall: { id: "call_3", name: "bash", args: '{"command":"echo b"}' } },
    { toolCall: { id: "call_4", name: "bash", args: '{"command":"echo a"}' } },
    { toolCall: { id: "call_5", name: "mcp__j2__review_verdict", args: '{"verdict":"approved"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/runaway-healthy";

  const admission = await admit(iid, "Review the diff.");
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "completed");
  assert.equal(settlement.error, undefined);
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
});
