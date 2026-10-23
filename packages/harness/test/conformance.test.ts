// Conformance (ADR-0027): the claims the socket-free tiers cannot see, driven through the REAL
// turn loop — pi at the exact pin, the Menu over a real socket to the Custodian's address, a scripted
// OpenAI-compatible provider choosing each turn's shape. The flue-contract tier's role, re-owned:
// its claims are jr2 requirements now, with the pinned-defect assertion INVERTED — an abort
// mid-stream must NOT erase the assistant message (the only witness is the message array the
// provider receives on the next turn). This suite runs in the default `test` gate (the opt-in
// existed only for the foreign pin) and is the canary for pi bumps.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hono } from "hono";
import { narrowedChartSchema } from "@jr2/orchestrator/internal";
import {
  cutPickResult,
  stalePickResult,
  turnOverResult,
  unreadAnswerResult,
  unrunResult,
  unsentPickResult,
  type Surface,
} from "../src/menu.ts";
import { harnessServer, type HarnessServer } from "../src/app.ts";
import { TURN_ENDED_MESSAGE } from "../src/conversation.ts";
import { noticeText } from "../src/briefing.ts";
import { menuToolName } from "../src/menu-tools.ts";
import { admissionFault, modelsFor } from "../src/provider.ts";
import type { AgentDefinition, HarnessSpec } from "../src/spec.ts";
import { runSubmissionFor } from "../src/turn.ts";
import type { HistoryView, Notice, Settlement, StreamEvent } from "../src/wire.ts";
import { startAnthropicGateway, type AnthropicGateway } from "./support/anthropic-gateway.ts";
import {
  SANDBOX_STAND_IN,
  severKeepAliveSockets,
  startFakeCustodian,
  startFakeProvider,
  until,
  type FakeProvider,
  type FakeSandbox,
} from "./support/rig.ts";

const AGENT = "reviewer";
/** The Menu-only persona (ADR-0028 `workspace: "none"`): picks from its Menu, nothing else. */
const DECISIONER = "decisioner";

/** One Menu of `ack` events, all of it allowed, as the Orchestrator would register it
 * (ADR-0013/0029). */
function surfaceWith(...names: string[]): Surface {
  return surfaceAllowing(names, names);
}

/** A Menu and the part of it this Turn may pick (ADR-0029). */
function surfaceAllowing(names: string[], allowed: string[]): Surface {
  return { ...surfaceFrom(names), menu: surfaceFrom(names).accepts!, accepts: undefined, allowed };
}

/** The same events as an Orchestrator from before ADR-0029 serves them: `accepts` alone. */
function surfaceFrom(names: string[]): Surface {
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
 * admission below carries one (ADR-0049); this process holds no roster. Identity only: where each
 * Turn works rides its Frame (`frameCwd` below, ADR-0057). */
const definitions: Record<string, AgentDefinition> = {
  [AGENT]: {
    model: "fake/model-x",
    instructions: "Review what you are handed, then answer through the menu.",
  },
  [DECISIONER]: {
    model: "fake/model-x",
    instructions: "Read the inputs, then pick the next event from the menu.",
    workspace: "none",
  },
};

/** The Frame's `cwd` each Agent's Turns carry (ADR-0057) — a real directory for the Agent whose
 * bash calls run in one. The Menu-only Agent has none on purpose: it is moot for
 * `workspace: "none"` (only Working tools consume a cwd), so the `/work` default resolving to a
 * directory that does not exist must not matter. */
const frameCwd: Record<string, string | undefined> = { [AGENT]: tmpdir() };

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
/** The same composition persisting under a directory (ADR-0031) — a second one over the same
 * directory is the Harness after a restart. */
let appOver: (conversationsDir: string) => Hono;
/** The same, with the drain a SIGTERM runs (ADR-0031). */
let serverOver: (conversationsDir: string) => HarnessServer;
/** The same composition with the Harness's own provider retries (no `maxRetries` seam): what
 * production runs (ADR-0016, ADR-0064). */
let retryApp: Hono;
/** The same custom provider reached at a base URL that names `openrouter.ai`, where pi-ai would
 * add its attribution headers. */
let openRouterApp: Hono;
/** The same custom provider, with pi's catalog `anthropic` moved to a fake Anthropic gateway
 * (ADR-0059): a Turn on a catalog model that runs through the Anthropic adapter. */
let gatewayApp: Hono;
let anthropicGateway: AnthropicGateway;
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
  sandbox = await startFakeCustodian(surfaceWith("review_verdict"));
  const harness: HarnessSpec = {
    provider: {
      id: "fake",
      api: "openai-completions",
      baseUrl: provider.url,
      contextWindow: 200_000,
      maxTokens: 8192,
      // `model-zero` declares no window of its own (per-model 0 beats the provider default,
      // `provider.ts`) — the shape ADR-0036 requires compaction to stay OFF for.
      // `model-unlimited` declares neither limit: its Turns must send none (`unlimitedPayload`).
      models: {
        "model-x": {},
        "model-zero": { contextWindow: 0, maxTokens: 8192 },
        "model-unlimited": { contextWindow: 0, maxTokens: 0 },
      },
    },
  };
  const models = modelsFor(harness, {});
  type Seams = { stepBudget?: number; identicalCallLimit?: number; keepRecentTokens?: number; retries?: "harness" };
  const serverWith = (seams?: Seams, conversationsDir?: string, registry = models): HarnessServer =>
    harnessServer({
      ...(conversationsDir ? { conversationsDir } : {}),
      longPollMs: 250,
      // The turn loop is under test here; the wire's gate is `auth.test.ts`'s (ADR-0058).
      checkBearer: () => true,
      // The real composition (`main.ts`): admission rejects a definition (or dial) the turn
      // could not run.
      checkAdmission: (resolved) => admissionFault(registry, resolved),
      runSubmissionFor: (seat) => {
        const { retries, ...turnSeams } = seams ?? {};
        return runSubmissionFor({
          models: registry,
          menu: { url: sandbox.url, token: SANDBOX_STAND_IN, retryWindowMs: 50, retryInitialMs: 1 },
          // No provider-stream retries: a scripted failure must settle on the first attempt. The
          // `retries` seam leaves the Harness's own number in place.
          ...(retries === "harness" ? {} : { maxRetries: 0 }),
          printerOut: {
            write: (chunk) => printed.set(seat.instanceId, (printed.get(seat.instanceId) ?? "") + chunk),
          },
          ...turnSeams,
          ...seat,
        });
      },
    });
  const appWith = (seams?: Seams, conversationsDir?: string): Hono => serverWith(seams, conversationsDir).app;
  app = appWith();
  boundedApp = appWith({ stepBudget: 3 });
  compactApp = appWith({ keepRecentTokens: KEEP_RECENT });
  boundedCompactApp = appWith({ stepBudget: 3, keepRecentTokens: KEEP_RECENT });
  appOver = (conversationsDir) => appWith(undefined, conversationsDir);
  serverOver = (conversationsDir) => serverWith(undefined, conversationsDir);
  retryApp = appWith({ retries: "harness" });
  const openRouter = modelsFor(
    { provider: { ...harness.provider!, baseUrl: `${provider.url.replace(/\/v1$/, "")}/openrouter.ai/v1` } },
    {},
  );
  openRouterApp = serverWith(undefined, undefined, openRouter).app;
  anthropicGateway = await startAnthropicGateway();
  const gatewayModels = modelsFor({ ...harness, catalog: { anthropic: { baseUrl: anthropicGateway.url } } }, {});
  gatewayApp = serverWith(undefined, undefined, gatewayModels).app;
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
  // Client sockets first: the fake's close would otherwise wait out a keep-alive on sockets
  // nothing will reuse.
  await severKeepAliveSockets();
  await sandbox.close();
  await provider.close();
  await anthropicGateway.close();
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
  frame?: { cwd: string },
): Promise<{ offset: string; submissionId: string }> {
  const cwd = frame ? frame.cwd : frameCwd[agent];
  const res = await via.request(conversationPath(iid, agent), {
    method: "POST",
    // The definition rides every admission (ADR-0049) — the real turn loop reads the one it was
    // handed, so this suite hands it the same one the Machine's slot would — and the Frame rides
    // beside it (ADR-0057): the prompt, and where this Turn works.
    body: JSON.stringify({ message, ...(cwd ? { cwd } : {}), definition: definitions[agent], ...dials }),
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

/** The newest user message of a request — where the Briefing's Turn part rides (ADR-0062). */
function lastUserText(call: { messages: Array<Record<string, unknown>> } | undefined): string {
  const user = (call?.messages ?? []).filter((m) => m.role === "user").at(-1);
  const content = user?.content;
  if (typeof content === "string") return content;
  // pi sends a user message as text parts.
  return ((content ?? []) as Array<{ type?: string; text?: string }>)
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("");
}

function systemText(call: { messages: Array<Record<string, unknown>> } | undefined): string {
  return String((call?.messages ?? []).find((m) => m.role === "system")?.content ?? "");
}

test("the Menu is fixed for a conversation: two Submissions with different Allowed picks send a BYTE-IDENTICAL tools block (ADR-0029)", async () => {
  // A continued conversation changes state by design (ADR-0057): a coder in `implement` may
  // `finish`, the same coder in `fix` may `finish` or `dispute`. The tools lead the provider's
  // prefix cache, so the tools block — and the system prompt behind it — must not move.
  provider.reset([{ text: "Implemented." }, { text: "Fixed." }]);
  sandbox.reset(surfaceAllowing(["dispute", "finish"], ["finish"]));
  const iid = "conf/fixed-menu";

  const first = await admit(iid, "Implement it.");
  assert.equal((await settled(iid, first)).outcome, "completed");
  sandbox.setSurface(surfaceAllowing(["dispute", "finish"], ["dispute", "finish"]));
  const second = await admit(iid, "Fix it.");
  assert.equal((await settled(iid, second)).outcome, "completed");

  const [one, two] = provider.calls;
  assert.ok(one?.tools && two?.tools);
  assert.equal(JSON.stringify(two.tools), JSON.stringify(one.tools), "the tools block is byte-identical");
  const names = one.tools.map((tool) => tool.function?.name);
  assert.ok(names.includes("mcp__jr2__dispute") && names.includes("mcp__jr2__finish"), `the whole Menu: ${names}`);
  for (const working of ["read", "write", "edit", "bash", "grep", "glob"]) {
    assert.ok(names.includes(working), `the Working tools ride along (missing: ${working})`);
  }
  assert.equal(systemText(two), systemText(one), "the system prompt — instructions and standing part — is too");

  // What moved is the Turn part, after each Turn's prompt (ADR-0062).
  assert.match(
    lastUserText(one),
    /^Implement it\.\n\n<jr2-turn>\n[\s\S]*Allowed now: `mcp__jr2__finish`\.\n<\/jr2-turn>$/,
  );
  assert.match(
    lastUserText(two),
    /^Fix it\.\n\n<jr2-turn>\n[\s\S]*Allowed now: `mcp__jr2__dispute`, `mcp__jr2__finish`\.\n<\/jr2-turn>$/,
  );
  // …and the first Turn's part is still in the history the second one sent, unchanged.
  assert.ok(JSON.stringify(two.messages).includes("Allowed now: `mcp__jr2__finish`.\\n</jr2-turn>"));
});

test("the Briefing: the standing part follows the instructions; the Turn part names the working directory and the notices (ADR-0062)", async () => {
  provider.reset([{ text: "Looked." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/briefing";
  const cwd = await mkdtemp(join(tmpdir(), "conf-briefing-"));

  const res = await app.request(conversationPath(iid), {
    method: "POST",
    body: JSON.stringify({
      message: "Carry on.",
      cwd,
      definition: definitions[AGENT],
      notices: [
        { kind: "memory-limit", scope: "workspace", agent: "tester", peak: "1.9Gi", limit: "2Gi" },
        { kind: "conversation-new", scope: "conversation", reason: "the last one was lost" },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(
    (await settled(iid, (await res.json()) as { offset: string; submissionId: string })).outcome,
    "completed",
  );

  const system = systemText(provider.calls[0]);
  assert.ok(system.startsWith(`${definitions[AGENT]!.instructions}\n\n<jr2-briefing>\n`), system);
  assert.doesNotMatch(system, /review_verdict/, "no Menu names in the standing part");
  // The one pick line, as the model reads it through the real turn loop.
  assert.ok(
    system.includes(
      "- You act on the workflow by picking from your Menu: a call to one of the workflow's tools that the newest " +
        '"Allowed now" lists. Each pick\'s answer says if your Turn is over. If it is over, stop and call no other ' +
        "tool. If it is not, continue. If nothing is allowed, stop: the workflow prompts you again when something is.",
    ),
    system,
  );
  assert.doesNotMatch(system, /exactly one pick|Some picks move the workflow/, "both earlier lines are gone");
  const turn = lastUserText(provider.calls[0]);
  assert.ok(turn.startsWith("Carry on.\n\n<jr2-turn>\n"), turn);
  assert.ok(turn.includes(`Working directory: ${cwd}`), turn);
  assert.match(turn, /killed at its memory limit \(peak 1\.9Gi of 2Gi\) during `tester`'s Turn/);
  assert.match(turn, /This conversation is new; earlier context is gone \(the last one was lost\)/);
});

test("an older Orchestrator's surface still runs: its `accepts` is the tools and the Allowed picks (ADR-0029 skew)", async () => {
  provider.reset([{ text: "Looked." }]);
  sandbox.reset(surfaceFrom(["review_verdict"]));
  const iid = "conf/skew";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "completed");
  const names = (provider.calls[0]?.tools ?? []).map((tool) => tool.function?.name);
  assert.ok(names.includes("mcp__jr2__review_verdict"), `the accepts are the tools: ${names}`);
  assert.match(lastUserText(provider.calls[0]), /Allowed now: `mcp__jr2__review_verdict`\./);
});

test("a Turn that is over before it starts is never prompted: settled aborted, nothing written (ADR-0026)", async () => {
  provider.reset([{ text: "never reached" }, { text: "Resumed." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  sandbox.killSurface();
  const iid = "conf/over-at-start";

  const admission = await admit(iid, "Review the diff.");
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "aborted", "nothing is wrong — the state exited, so the Turn is over");
  assert.equal(settlement.error?.type, "submission_aborted");
  assert.equal(provider.calls.length, 0, "the model was never asked");
  assert.deepEqual((await history(iid)).messages, [], "nothing was written to the conversation");

  // The conversation is not poisoned: its next live Turn runs, and carries no dead prompt.
  sandbox.reviveSurface();
  const next = await admit(iid, "Now summarize.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  assert.ok(
    !JSON.stringify(provider.calls[0]?.messages).includes("Review the diff."),
    "the dead prompt is not history",
  );
});

test("a stopping Orchestrator's 503 is waited out: the surface read re-asks, and the Turn runs (ADR-0026/0042)", async () => {
  provider.reset([{ text: "Looked." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  sandbox.stopFor(2);
  const iid = "conf/stopping";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "completed");
  // …then the one step boundary's read: nothing changed, nothing said.
  assert.equal(sandbox.reads(), 4, "two 503s, the live surface, then the step boundary");
  assert.equal(provider.calls.length, 1);
});

test("a Menu read the Orchestrator cannot answer fails the turn before the model is ever asked", async () => {
  provider.reset([{ text: "never reached" }]);
  sandbox.reset(surfaceWith("review_verdict"));
  // Not a 404 (that is ADR-0026's turn-is-over, settled `aborted`) and not a 503 (a stopping
  // Orchestrator, re-asked): the Orchestrator answered the Menu read with a fault.
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
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/menu-only";

  const admission = await admit(iid, "Decide.", undefined, DECISIONER);
  assert.equal((await settled(iid, admission, DECISIONER)).outcome, "aborted");

  // The Menu is the whole toolset: on every request the model saw its Menu and NOTHING else —
  // no read/write/edit/bash/grep/glob was offered, so none was executable (ADR-0028).
  for (const call of provider.calls) {
    assert.deepEqual(
      (call.tools ?? []).map((tool) => tool.function?.name),
      ["mcp__jr2__review_verdict"],
      "a Menu-only turn offers the Menu alone",
    );
  }
  // Its standing part says so, and its Turn part names no directory it has no tools to use.
  assert.match(systemText(provider.calls[0]), /<jr2-briefing>[\s\S]*no Working tools[\s\S]*<\/jr2-briefing>$/);
  assert.doesNotMatch(lastUserText(provider.calls[0]), /Working directory/);
  // …and the pick alone is what settled the turn: it reached the Orchestrator as a delivery.
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // Both the read and the pick carried the Stand-in: the token itself is the Custodian's (ADR-0059).
  assert.ok(sandbox.bearers.length >= 2 && sandbox.bearers.every((b) => b === `Bearer ${SANDBOX_STAND_IN}`));
});

test("the Frame's cwd is re-read per Submission: two turns of one conversation work in different directories (ADR-0057)", async () => {
  // The one claim the old identity cwd could never make — it was fixed when the harness was
  // assembled, so it could not go stale. A `continue` conversation that moves to a second worktree
  // depends on each Submission building its Working tools rooted at that Submission's Frame cwd; if
  // the tools were ever built once at assembly, the second turn would list the FIRST worktree and
  // say nothing. That is what this canary watches.
  const dirA = await mkdtemp(join(tmpdir(), "conf-frame-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "conf-frame-b-"));
  await writeFile(join(dirA, "MARK_ALPHA"), "");
  await writeFile(join(dirB, "MARK_BRAVO"), "");
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"ls"}' } },
    { text: "Listed the first worktree." },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"ls"}' } },
    { text: "Listed the second worktree." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/frame-cwd";

  const first = await admit(iid, "Look around.", undefined, AGENT, app, { cwd: dirA });
  assert.equal((await settled(iid, first)).outcome, "completed");
  const second = await admit(iid, "Look around again.", undefined, AGENT, app, { cwd: dirB });
  assert.equal((await settled(iid, second)).outcome, "completed");

  // The tool result is the last message of the request that FOLLOWS each bash call.
  const resultAfter = (index: number): string => JSON.stringify(provider.calls[index]?.messages.at(-1) ?? {});
  assert.match(resultAfter(1), /MARK_ALPHA/, "turn 1 ran bash in the cwd ITS Frame named");
  const afterSecond = resultAfter(3);
  assert.match(afterSecond, /MARK_BRAVO/, "turn 2 ran bash in the cwd the SECOND Frame named");
  assert.ok(!afterSecond.includes("MARK_ALPHA"), "turn 2 did not stay rooted where turn 1 was");
});

test("a bash command killed by a signal reaches the model as an error naming the signal, never a pass (ADR-0061)", async () => {
  // pi-agent-core 0.82.1 reports a signal death as `exitCode: code ?? 0`, so the model read a
  // killed Playwright run — output stopped partway — as success. The wrapped tool (bash-tool.ts)
  // is what the real turn loop hands pi; this is the canary for a pi bump that changes the seam.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: JSON.stringify({ command: "echo started; sh -c 'kill -9 $$'" }) } },
    { text: "The command was killed." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/bash-signal";
  const admission = await admit(iid, "Run the tests.", undefined, AGENT, app, { cwd: tmpdir() });
  assert.equal((await settled(iid, admission)).outcome, "completed");
  const result = JSON.stringify(provider.calls[1]?.messages.at(-1) ?? {});
  assert.match(result, /started/);
  assert.match(result, /Command killed by signal SIGKILL \(exit 137\)/);
});

test("a per-turn model dial reaches the wire, on the SAME conversation (ADR-0018)", async () => {
  provider.reset([{ text: "One." }, { text: "Two." }, { text: "Three." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/dials";

  // Three Submissions on one conversation — the `session: "continue"` shape, where the pi `Agent`
  // is assembled once and each later turn sets its model on it. The definition's model, then a
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
  // The conversation itself survived the swap: turn 3 still sees turns 1-2 (one engine part, one
  // assembled `Agent` — the dial is set on it rather than rebuilding it).
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

/** One Menu-only conversation's first Turn, on a Harness persisting under a fresh directory: the
 * model says something only it said, then picks. Answers the directory, for a restart over it. */
async function firstTurnPersisted(iid: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-conversations-"));
  provider.reset([
    {
      text: "The inputs say alpha.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", args: '{"verdict":"alpha"}' },
    },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const before = appOver(dir);
  const first = await admit(iid, "Decide the first thing.", undefined, DECISIONER, before);
  assert.equal((await settled(iid, first, DECISIONER, before)).outcome, "aborted");
  return dir;
}

/** The restarted Harness's next Turn on the conversation: what the model was sent. */
async function nextTurnAfterRestart(iid: string, dir: string): Promise<Array<Record<string, unknown>>> {
  provider.reset([
    { toolCall: { id: "call_2", name: "mcp__jr2__review_verdict", args: '{"verdict":"beta"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const after = appOver(dir);
  const next = await admit(iid, "Decide the second thing.", undefined, DECISIONER, after);
  assert.equal((await settled(iid, next, DECISIONER, after)).outcome, "aborted");
  return provider.calls[0]?.messages ?? [];
}

test("a conversation survives the Harness's restart: the engine part reopens (ADR-0031)", async () => {
  const iid = "conf/restart";
  const dir = await firstTurnPersisted(iid);
  const sent = await nextTurnAfterRestart(iid, dir);
  const text = JSON.stringify(sent);
  // The whole first Turn, as pi carried it — the tool call and its receipt too, which only the
  // engine part keeps (the record keeps what was said).
  assert.match(text, /Decide the first thing\./);
  assert.match(text, /The inputs say alpha\./);
  assert.ok(
    sent.some((m) => m.role === "tool"),
    "the first Turn's tool traffic came back with the engine part",
  );
  assert.match(lastUserText(provider.calls[0]), /Decide the second thing\./);
});

test("an engine part that does not open: the conversation continues from the record's messages (ADR-0031)", async () => {
  const iid = "conf/restart-unreadable";
  const dir = await firstTurnPersisted(iid);
  // Another engine's part, or another version's: nothing this Harness reads as a transcript.
  const engineDir = join(dir, DECISIONER, encodeURIComponent(iid), "engine", "pi");
  for (const entry of await readdir(engineDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await writeFile(join(entry.parentPath, entry.name), "not a transcript\n");
  }
  const stderrMark = stderrText.length;
  const sent = await nextTurnAfterRestart(iid, dir);
  // The pod log says why, in jr2's words.
  assert.match(
    stderrText.slice(stderrMark),
    /harness: the engine part at .*engine\/pi does not open \(line 1 does not parse\) — continuing from the record's messages \(ADR-0031\)/,
  );
  // The words, as the record kept them — and no tool traffic, which the record never had.
  const said = sent.filter((m) => m.role === "user" || m.role === "assistant").map((m) => JSON.stringify(m.content));
  assert.ok(
    said.some((content) => content.includes("Decide the first thing.")),
    JSON.stringify(said),
  );
  assert.ok(
    said.some((content) => content.includes("The inputs say alpha.")),
    JSON.stringify(said),
  );
  assert.ok(!sent.some((m) => m.role === "tool"), "the record keeps no tool traffic");
  assert.match(lastUserText(provider.calls[0]), /Decide the second thing\./);
});

test("a restart that cut a Turn mid-tool-call: the next Turn sends every tool call with its result (ADR-0031)", async () => {
  // The case the persistence exists for: the process dies while a tool call is open, so the
  // engine part ends in an assistant tool call with no result. A provider refuses a dangling call, so
  // the conversation's next Turn must not send one.
  const iid = "conf/restart-mid-call";
  const dir = await mkdtemp(join(tmpdir(), "jr2-conversations-"));
  provider.reset([
    { text: "Deciding.", toolCall: { id: "call_cut", name: "mcp__jr2__review_verdict", args: '{"verdict":"alpha"}' } },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  sandbox.holdDeliveries();
  const before = appOver(dir);
  await admit(iid, "Decide the first thing.", undefined, DECISIONER, before);
  await until(() => sandbox.delivered.length > 0, "the pick to be in flight");
  // The process is gone here: nothing settles the open call. (The abandoned app stays parked on
  // the held delivery until the suite closes the fake.)

  const sent = await nextTurnAfterRestart(iid, dir);
  const calls = sent.flatMap((m) =>
    m.role === "assistant" ? ((m.tool_calls ?? []) as Array<{ id: string }>).map((c) => c.id) : [],
  );
  const results = new Set(sent.flatMap((m) => (m.role === "tool" ? [String(m.tool_call_id)] : [])));
  // The cut call comes back with the engine part (pi answers an orphaned call with a result of its own
  // when it sends the history), so the model reads what it began and the request is well-formed.
  assert.ok(calls.includes("call_cut"), `the cut Turn's call came back: ${JSON.stringify(sent)}`);
  for (const id of calls) {
    assert.ok(results.has(id), `tool call ${id} is sent with its result: ${JSON.stringify(sent)}`);
  }
  // The cut call's result is jr2's words, never pi's "No result provided" — a failed pick invites a
  // second one, and the workflow does not run a pick twice (ADR-0031).
  const cut = sent.find((m) => m.role === "tool" && m.tool_call_id === "call_cut");
  assert.match(JSON.stringify(cut), /This pick reached the workflow, but its answer did not reach you/);
  assert.doesNotMatch(JSON.stringify(cut), /No result provided/);
  assert.match(lastUserText(provider.calls[0]), /Decide the second thing\./);
});

test("in-Turn modes: ONE Submission walks two modes — the tools block never moves, each receipt names the mode's Allowed picks (ADR-0029)", async () => {
  // The Orchestrator's side is scripted (what `sendToAgent` answers for a Machine whose Agent state
  // has child states coding / reviewing — the orchestrator's in-turn-modes test drives that half).
  // What this asserts is the model's side, through the real loop: what it reads after each pick.
  const menu = ["ask_review", "revise", "run_tests", "submit"];
  provider.reset([
    { text: "Submitting.", toolCall: { id: "c1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
    { text: "Asking for review.", toolCall: { id: "c2", name: "mcp__jr2__ask_review", args: '{"verdict":"x"}' } },
    { text: "Submitting now.", toolCall: { id: "c3", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(menu, ["ask_review", "run_tests"]));
  let mode: "coding" | "reviewing" = "coding";
  sandbox.answerWith((event) => {
    if (mode === "coding" && event.type === "ask_review") {
      mode = "reviewing";
      return { moved: true, turnComplete: false, allowed: ["revise", "submit"] };
    }
    if (mode === "reviewing" && event.type === "submit") {
      sandbox.killSurface(); // the pick left the Agent's state: the Turn is over (ADR-0024/0026)
      return { moved: true, turnComplete: true, allowed: [] };
    }
    return {
      moved: false,
      turnComplete: false,
      allowed: mode === "coding" ? ["ask_review", "run_tests"] : ["revise", "submit"],
    };
  });
  const iid = "conf/modes";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["submit", "ask_review", "submit"],
  );

  const calls = provider.calls;
  assert.equal(calls.length, 3, "the pick that ended the Turn ended the run");
  for (const call of calls)
    assert.equal(JSON.stringify(call.tools), JSON.stringify(calls[0]!.tools), "byte-identical tools");
  // The Briefing's Turn part is written once, at the Submission's start, and never rewritten.
  assert.match(lastUserText(calls[0]), /Allowed now: `mcp__jr2__ask_review`, `mcp__jr2__run_tests`\.\n<\/jr2-turn>$/);
  const results = pickAnswers(iid);
  assert.equal(results.length, 3);
  assert.match(results[0]!, /did NOT act on it: `mcp__jr2__submit` is not allowed in the workflow's current state/);
  assert.match(results[0]!, /Allowed now: `mcp__jr2__ask_review`, `mcp__jr2__run_tests`\./);
  assert.match(results[1]!, /Your turn is not over\. Allowed now: `mcp__jr2__revise`, `mcp__jr2__submit`\./);
  assert.match(results[2]!, /your turn is over/);
});

// ─── the step boundary: the Turn part restated (ADR-0029, ADR-0016) ─────────────────────────────
// A modes Machine (coding / testing / reviewing), its Orchestrator side scripted by surface read:
// read 1 is the Submission's start, read n+1 the boundary after model answer n.
// A change made by SOMETHING ELSE (a Gate's answer, an external event) is a surface that differs
// from read k on — no pick of the Agent's made it.

const MODES_MENU = ["abandon", "ask_review", "revise", "run_tests", "submit"];
const CODING = ["abandon", "ask_review", "run_tests"];
const REVIEWING = ["abandon", "revise", "submit"];
const PUSH_MARK = "The workflow's state changed since you last read the Allowed picks.";

/** Every request message, as one string — what the model was sent. */
function sentText(call: { messages: Array<Record<string, unknown>> } | undefined): string {
  return JSON.stringify(call?.messages ?? []);
}

/** How many restatements a request carries. */
function pushesIn(call: { messages: Array<Record<string, unknown>> } | undefined): number {
  return sentText(call).split(PUSH_MARK).length - 1;
}

/** Each pick's answer as the log printed it (ADR-0023): the text the model read on that call, its
 * label first (`[submit answer] …`, `[submit error] …`). A pick that ends the Turn ends the run
 * (ADR-0024), so no later request carries its answer: the log is where a test reads it. */
function pickAnswers(iid: string, agent = AGENT): string[] {
  const answers: string[] = [];
  let open = false;
  for (const line of (printed.get(iid) ?? "").split("\n")) {
    if (!line.startsWith(`[${agent}] `)) continue;
    const text = line.slice(`[${agent}] `.length);
    if (/^\[[^\]]+ (answer|error)\] /.test(text)) {
      answers.push(text);
      open = true;
    } else if (/^\[/.test(text)) open = false;
    else if (open) answers[answers.length - 1] += `\n${text}`;
  }
  return answers;
}

/** The receipt of a pick that left the Agent's state: the Turn is over, so the surface is gone
 * (ADR-0024/0026) — as the real Orchestrator answers it. */
function endsTurn(): Record<string, unknown> {
  sandbox.killSurface();
  return { moved: true, turnComplete: true, allowed: [] };
}

const bashCall = (id: string, command: string) => ({
  toolCall: { id, name: "bash", args: JSON.stringify({ command }) },
});

test("step boundary: a Gate's answer during a run of Working-tool calls is restated at the next step boundary — once, after the tool result, the tools block unmoved", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    bashCall("w2", "echo two"),
    bashCall("w3", "echo three"),
    bashCall("w4", "echo four"),
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  // The human answered the Gate during model answer 2: reads 1-2 coding, from read 3 on reviewing.
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 2 ? CODING : REVIEWING));
  sandbox.answerWith(endsTurn);
  const iid = "conf/push-gate";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");

  const calls = provider.calls;
  assert.equal(calls.length, 5, "one request per scripted model answer: the restatement is not a request of its own");
  for (const call of calls)
    assert.equal(JSON.stringify(call.tools), JSON.stringify(calls[0]!.tools), "tools byte-identical");
  assert.equal(systemText(calls[4]), systemText(calls[0]), "and the system prompt");
  // Not before the change, and exactly once after it — in every later request, the SAME one.
  assert.deepEqual(calls.map(pushesIn), [0, 0, 1, 1, 1]);
  // Its position in request 3: the newest message, right after model answer 2's tool result.
  const third = calls[2]!.messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  assert.equal(third.at(-2)?.role, "tool");
  assert.equal(third.at(-2)?.tool_call_id, "w2");
  assert.equal(third.at(-1)?.role, "user");
  assert.equal(
    lastUserText(calls[2]),
    "<jr2-turn>\nThe workflow's state changed since you last read the Allowed picks. " +
      "Allowed now: `mcp__jr2__abandon`, `mcp__jr2__revise`, `mcp__jr2__submit`.\n</jr2-turn>",
  );
  // The request before it is byte-for-byte a prefix of the request after it: appended, never
  // rewritten — what a prefix cache needs.
  const two = calls[1]!.messages;
  assert.equal(JSON.stringify(third.slice(0, two.length)), JSON.stringify(two), "request 2 is a prefix of request 3");
  // The history view and the printed conversation (ADR-0023) both carry it, once.
  const said = (await history(iid)).messages.filter((m) => m.text.includes(PUSH_MARK));
  assert.equal(said.length, 1);
  assert.equal(said[0]!.role, "user");
  assert.equal(printed.get(iid)!.split(PUSH_MARK).length - 1, 1, "printed once");
  assert.match(printed.get(iid)!, /\[reviewer\] \[prompt\] <jr2-turn>\n\[reviewer\] The workflow's state changed/);
});

test("step boundary: the Agent's OWN pick changed the mode — its receipt said so, and nothing is restated", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    { toolCall: { id: "p1", name: "mcp__jr2__ask_review", args: '{"verdict":"x"}' } },
    bashCall("w2", "echo two"),
    bashCall("w3", "echo three"),
    { toolCall: { id: "p2", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  let mode: "coding" | "reviewing" = "coding";
  // The Orchestrator: the surface follows the mode, and so does every receipt.
  sandbox.surfaceByRead(() => surfaceAllowing(MODES_MENU, mode === "coding" ? CODING : REVIEWING));
  sandbox.answerWith((event) => {
    if (event.type === "ask_review") {
      mode = "reviewing";
      return { moved: true, turnComplete: false, allowed: REVIEWING };
    }
    return endsTurn();
  });
  const iid = "conf/push-own-pick";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.equal(provider.calls.length, 5);
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0, 0, 0, 0], "no restatement: the receipt was the news");
  assert.ok(sandbox.reads() >= 5, `the boundaries still asked (${sandbox.reads()} reads)`);
});

test("step boundary: a change that came and went between two boundaries is no change — and a flapping guard is said at most once per step", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    bashCall("w2", "echo two"),
    bashCall("w3", "echo three"),
    bashCall("w4", "echo four"),
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  // Read 2 coding (whatever happened in between came back), read 3 reviewing, read 4 coding,
  // read 5 coding: the guard flapped across model answers 2-3.
  const served = [CODING, CODING, REVIEWING, CODING, CODING, CODING, CODING];
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, served[read - 1] ?? CODING));
  sandbox.answerWith(endsTurn);
  const iid = "conf/push-flap";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.equal(provider.calls.length, 5);
  const last = sentText(provider.calls[4]);
  // Two restatements — to reviewing, and back — each at its own boundary; none for read 2.
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0, 1, 2, 2]);
  assert.match(last, /Allowed now: `mcp__jr2__abandon`, `mcp__jr2__revise`, `mcp__jr2__submit`/);
});

test("step boundary: a change that races a pick of the old mode — the refusal names the new Allowed picks, and nothing is restated after it", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    // Composed against coding; the Gate moved the Machine to reviewing before it arrived.
    { toolCall: { id: "p1", name: "mcp__jr2__run_tests", args: '{"verdict":"x"}' } },
    { toolCall: { id: "p2", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  let gateAnswered = false;
  sandbox.surfaceByRead(() => surfaceAllowing(MODES_MENU, gateAnswered ? REVIEWING : CODING));
  sandbox.answerWith((event) => {
    if (event.type === "run_tests") {
      gateAnswered = true; // the human's answer landed while the model was composing
      return { moved: false, turnComplete: false, allowed: REVIEWING };
    }
    return endsTurn();
  });
  const iid = "conf/push-race";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.equal(provider.calls.length, 3);
  const refusal = (provider.calls[2]!.messages as Array<{ role: string; content?: unknown }>).at(-1);
  assert.equal(refusal?.role, "tool", "the refusal is the newest message: no restatement after it");
  assert.match(String(refusal?.content), /`mcp__jr2__run_tests` is not allowed in the workflow's current state/);
  assert.match(String(refusal?.content), /Allowed now: `mcp__jr2__abandon`, `mcp__jr2__revise`, `mcp__jr2__submit`\./);
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0, 0]);
});

test("step boundary: a model that stopped with no pick while the list changed is asked again INSIDE the Submission — pi's loop runs on for a steered message", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    { text: "I have nothing to pick yet." }, // would end the Submission: a no-signal (ADR-0016)
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 2 ? CODING : REVIEWING));
  sandbox.answerWith(endsTurn);
  const iid = "conf/push-after-stop";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.equal(provider.calls.length, 3, "asked again after the text-only answer");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["submit"],
  );
  const third = provider.calls[2]!.messages as Array<{ role: string }>;
  assert.deepEqual(
    third.slice(-2).map((m) => m.role),
    ["assistant", "user"],
    "the restatement follows the text-only answer",
  );
  assert.equal((await history(iid)).settlements.length, 1, "one Submission: no nudge was needed");
});

test("ask-again rule: a model that stopped while the list became EMPTY is not asked again inside the Submission", async () => {
  // The Orchestrator's half reads the same list after the settle: empty, it asks nothing yet, and
  // its wake asks once a pick opens (ADR-0016). One rule.
  provider.reset([bashCall("w1", "echo one"), { text: "Waiting for the review." }]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 2 ? CODING : []));
  const iid = "conf/ask-again-empty";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "completed");
  assert.equal(provider.calls.length, 2, "not asked again: nothing is allowed");
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0]);
});

/** The Orchestrator's nudge (ADR-0016), word for word: the wake asks with the same text. */
const NUDGE =
  "Your previous turn ended, and the workflow is still waiting for your pick. " +
  "You MUST end your turn by calling exactly one of the workflow tools allowed below. " +
  "Pick the one that matches the true state of your work and call it now.";

test("ask-again rule: stop, wake, a pick back out of the mode and into it again, stop, a second wake, then the pick that ends the Turn — each stop completes, the ending pick settles aborted, nothing refused (ADR-0016, ADR-0024, ADR-0029)", async () => {
  // The `@model` mode-stop sequence: drafting allows `ask_review`; `reviewing` allows nothing until
  // a targetless timer marks the review read, then `revise` and `submit`. The Orchestrator's half
  // (the wake, its budget) is scripted here as it answers: two wakes, each a fresh Submission of the
  // nudge's text on the SAME conversation. What this asserts is the Harness's half.
  const menu = ["ask_review", "revise", "submit"];
  let mode: "drafting" | "reviewing" = "drafting";
  let read = false;
  const allowed = () => (mode === "drafting" ? ["ask_review"] : read ? ["revise", "submit"] : []);
  provider.reset([
    { toolCall: { id: "s1", name: "mcp__jr2__ask_review", args: '{"verdict":"x"}' } },
    { text: "Waiting for the reviewer's answer." },
    { toolCall: { id: "s2", name: "mcp__jr2__revise", args: '{"verdict":"x"}' } },
    { toolCall: { id: "s3", name: "mcp__jr2__ask_review", args: '{"verdict":"x"}' } },
    { text: "Waiting for the reviewer again." },
    { toolCall: { id: "s4", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(menu, allowed()));
  sandbox.surfaceByRead(() => surfaceAllowing(menu, allowed()));
  sandbox.answerWith((event) => {
    if (mode === "drafting" && event.type === "ask_review") {
      mode = "reviewing";
      read = false; // `reviewing`'s entry
      return { moved: true, turnComplete: false, allowed: allowed() };
    }
    if (mode === "reviewing" && read && event.type === "revise") {
      mode = "drafting";
      return { moved: true, turnComplete: false, allowed: allowed() };
    }
    if (mode === "reviewing" && read && event.type === "submit") return endsTurn();
    return { moved: false, turnComplete: false, allowed: allowed() };
  });
  const iid = "conf/mode-stop";

  const first = await admit(iid, "Ask for a review, then wait for the reviewer's answer.");
  assert.equal((await settled(iid, first)).outcome, "completed", "stopped in reviewing: nothing allowed");
  read = true; // the timer: the picks open where they are
  const wake1 = await admit(iid, NUDGE);
  assert.equal((await settled(iid, wake1)).outcome, "completed", "stopped in reviewing again");
  assert.deepEqual(allowed(), [], "the second stop is a correct one: nothing allowed");
  read = true;
  const wake2 = await admit(iid, NUDGE);
  assert.equal((await settled(iid, wake2)).outcome, "aborted");

  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["ask_review", "revise", "ask_review", "submit"],
    "every pick delivered once",
  );
  const results = pickAnswers(iid);
  assert.equal(results.length, 4);
  assert.ok(
    results.every((r) => !/did NOT act on it/.test(r)),
    `no pick refused:\n${results.join("\n")}`,
  );
  assert.match(results[1]!, /Allowed now: `mcp__jr2__ask_review`\./, "revise took the Turn back to drafting");
  assert.match(results[3]!, /your turn is over/);
  // Each wake's request states the Allowed picks last, in a fresh Turn part.
  assert.match(lastUserText(provider.calls[2]), /Allowed now: `mcp__jr2__revise`, `mcp__jr2__submit`\.\n<\/jr2-turn>$/);
  assert.match(lastUserText(provider.calls[5]), /Allowed now: `mcp__jr2__revise`, `mcp__jr2__submit`\.\n<\/jr2-turn>$/);
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0, 0, 0, 0, 0], "nothing restated: each list change was a pick's");
  assert.deepEqual(
    (await history(iid)).settlements.map((s) => s.outcome),
    ["completed", "completed", "aborted"],
  );
  // What the tier's note reads off the printed conversation, here with its end.
  const said = (printed.get(iid) ?? "")
    .split("\n")
    .flatMap((line) => {
      const m = /^\[reviewer\] \[([^\]]+)\] ?(.*)$/.exec(line);
      if (!m) return [];
      if (m[1] === "prompt") return m[2]!.startsWith("Your previous turn ended") ? ["(nudge)"] : [];
      return /^[a-z][a-z0-9_]*$/.test(m[1]!) && menu.includes(m[1]!) ? [m[1]!] : [];
    })
    .join(" ");
  assert.equal(said, "ask_review (nudge) revise ask_review (nudge) submit");
});

test("step boundary: nothing is said once the Turn is over — the surface is gone, and the run ends (ADR-0024/0026)", async () => {
  provider.reset([
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
    bashCall("w1", "echo after"), // a model that would not stop (ADR-0024): never asked
    { text: "Done." },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.answerWith(() => {
    sandbox.killSurface(); // the state that asked for the Turn exited
    return endsTurn();
  });
  const iid = "conf/push-over";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.deepEqual(provider.calls.map(pushesIn), [0], "no request after the pick that ended the Turn");
});

test("step boundary: nothing is read, said or asked after a pick's receipt ended the Turn — even while the address answers for the NEXT Turn (`continue: true`)", async () => {
  // Under `continue: true` the next state re-registers the SAME address before the abort lands: the
  // surface stays live and serves the next Turn's Allowed picks. The receipt's `turnComplete` is the
  // Harness's own fact that this Turn is over; a read after it would steer the next Turn's picks
  // into this Submission and mark the next Turn's notices as read. The run ends at the step
  // boundary (`endsRun`), with no abort from the Orchestrator: the provider sees no request after
  // the pick.
  provider.reset([
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
    { text: "Done." },
    { text: "Still here." },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  let reads = 0;
  sandbox.surfaceByRead((read) => {
    reads = read;
    return surfaceAllowing(MODES_MENU, read <= 1 ? CODING : REVIEWING);
  });
  sandbox.answerWith(() => ({ moved: true, turnComplete: true, allowed: [] }));
  const iid = "conf/push-over-live";

  const admission = await admit(iid, "Fix the ticket.");
  // No abort came from the Orchestrator, and still the Submission settles `aborted` (ADR-0024).
  const settlement = await settled(iid, admission);
  assert.deepEqual(
    { outcome: settlement.outcome, error: settlement.error },
    { outcome: "aborted", error: { type: "submission_aborted", message: TURN_ENDED_MESSAGE } },
  );
  assert.equal(provider.calls.length, 1, "no model request after the Turn-ending receipt");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["submit"],
  );
  assert.equal(reads, 1, "the Turn's own read only: no boundary read after the receipt");
});

test("step boundary: an abort that lands during the boundary read says nothing — and nothing stale rides into the next Submission (ADR-0024)", async () => {
  provider.reset([bashCall("w1", "echo one"), { stall: true }]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  const iid = "conf/push-abort";
  sandbox.surfaceByRead(async (read) => {
    // The state that asked for the Turn exited while this read was in flight: its abort lands
    // BEFORE the read answers — with the changed list, so only the abort check can stay silent.
    if (read === 2) await app.request(`${conversationPath(iid)}/abort`, { method: "POST" });
    return surfaceAllowing(MODES_MENU, read === 1 ? CODING : REVIEWING);
  });
  const first = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, first)).outcome, "aborted");
  const asked = provider.calls.length;

  provider.reset([{ text: "Next." }]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  const next = await admit(iid, "Next Turn.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  assert.equal(pushesIn(provider.calls[0]), 0, `no restatement, then or now (first Turn made ${asked} requests)`);
  assert.match(lastUserText(provider.calls[0]), /^Next Turn\.\n\n<jr2-turn>/);
});

test("step boundary: an Orchestrator that is restarting answers a boundary 503 — silence that step, the change said at the next", async () => {
  provider.reset([
    bashCall("w1", "echo one"),
    bashCall("w2", "echo two"),
    bashCall("w3", "echo three"),
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  // Read 2: the Orchestrator is stopping (503). Read 3: the restored one serves the Machine as it
  // was saved — moved on by a Gate answered across the restart.
  sandbox.surfaceByRead((read) =>
    read === 1 ? surfaceAllowing(MODES_MENU, CODING) : read === 2 ? 503 : surfaceAllowing(MODES_MENU, REVIEWING),
  );
  sandbox.answerWith(endsTurn);
  const iid = "conf/push-orchestrator-restart";

  const admission = await admit(iid, "Fix the ticket.");
  assert.equal((await settled(iid, admission)).outcome, "aborted", "a failed boundary read never fails the Turn");
  assert.deepEqual(provider.calls.map(pushesIn), [0, 0, 1, 1]);
});

test("step boundary: a restatement is not a step and breaks no streak — the Runaway guard counts tool calls alone (ADR-0035)", async () => {
  // Under a step budget of 3: three tool calls with a restatement between them is a healthy Turn.
  provider.reset([
    bashCall("w1", "true"),
    bashCall("w2", "true"),
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 1 ? CODING : REVIEWING));
  sandbox.answerWith(endsTurn);
  const healthy = await admit("conf/push-budget", "Fix the ticket.", undefined, AGENT, boundedApp);
  assert.equal((await settled("conf/push-budget", healthy, AGENT, boundedApp)).outcome, "aborted");
  assert.deepEqual(provider.calls.map(pushesIn), [0, 1, 1]);

  // K=4 identical calls with a restatement in the middle still trip: it neither resets nor adds.
  const repeated = { name: "bash", args: '{"command":"true"}' };
  provider.reset([1, 2, 3, 4, 5].map((n) => ({ toolCall: { id: `r${n}`, ...repeated } })));
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 2 ? CODING : REVIEWING));
  const looping = await admit("conf/push-streak", "Fix the ticket.");
  const end = await settled("conf/push-streak", looping);
  assert.equal(end.outcome, "failed");
  assert.equal(end.error?.type, "runaway");
  assert.match(end.error?.message ?? "", /repeated an identical tool call 4 times/);
  assert.equal(provider.calls.length, 4, "the 4th identical call trips, as with no restatement");
});

test("step boundary: across a Harness restart the restatement stays in the conversation once, and no stale one rides into the next Turn (ADR-0031)", async () => {
  const iid = "conf/push-harness-restart";
  const dir = await mkdtemp(join(tmpdir(), "jr2-conversations-"));
  provider.reset([
    bashCall("w1", "echo one"),
    // The Turn is cut mid-pick: the process dies with this delivery in flight.
    { toolCall: { id: "p1", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 1 ? CODING : REVIEWING));
  sandbox.holdDeliveries();
  const before = appOver(dir);
  await admit(iid, "Fix the ticket.", undefined, AGENT, before);
  await until(() => sandbox.delivered.length > 0, "the pick to be in flight");

  provider.reset([{ toolCall: { id: "p2", name: "mcp__jr2__submit", args: '{"verdict":"y"}' } }]);
  sandbox.reset(surfaceAllowing(MODES_MENU, REVIEWING));
  const after = appOver(dir);
  const next = await admit(iid, "Continue.", undefined, AGENT, after);
  assert.equal((await settled(iid, next, AGENT, after)).outcome, "aborted");
  // The next Turn reopened the engine part: the cut Turn's restatement is in it, exactly once, and
  // the next Turn's own Turn part is the newest statement.
  assert.equal(pushesIn(provider.calls[0]), 1);
  assert.match(
    lastUserText(provider.calls[0]),
    /^Continue\.\n\n<jr2-turn>\n[\s\S]*Allowed now: `mcp__jr2__abandon`, `mcp__jr2__revise`, `mcp__jr2__submit`\.\n<\/jr2-turn>$/,
  );
  assert.deepEqual(provider.calls.map(pushesIn), [1], "nothing new: the Turn part already said it");
});

test("a Menu pick reaches the Orchestrator and its receipt reaches the model; the Submission that the pick ended settles aborted (ADR-0024)", async () => {
  provider.reset([
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' },
    },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/leash";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");

  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // Both the read and the pick carried the Stand-in: the token itself is the Custodian's (ADR-0059).
  assert.ok(sandbox.bearers.length >= 2 && sandbox.bearers.every((b) => b === `Bearer ${SANDBOX_STAND_IN}`));
  // The receipt ended the Turn, so the run asked nothing more: the log holds what the model read.
  assert.equal(provider.calls.length, 1);
  const [receipt] = pickAnswers(iid);
  assert.ok(
    receipt?.startsWith('[review_verdict answer] Delivered "review_verdict"'),
    `the delivery receipt is the tool result the model reads (got: ${receipt})`,
  );
});

test("a pick whose parameters are the Chart grammar (recursive `$ref`s) is offered, filled and delivered (ADR-0070)", async () => {
  // The planner's pick `{ chart }` (ADR-0070): the grammar narrowed to an Open body, whose states,
  // invokes and transitions are recursive, so the tool's parameters carry `$defs` and `$ref`s.
  const grammar = narrowedChartSchema({
    lends: { agents: ["summarizer"] },
    allows: { models: ["fake/model-x"], workspace: ["none"] },
    ceilings: { turns: 4, wallClock: "5m", transitions: 200, fanOut: 2, size: 65536 },
  });
  const { $defs, $schema: _schema, ...chartField } = grammar as { $defs: unknown; $schema?: unknown };
  const input = { type: "object", properties: { chart: chartField }, required: ["chart"], $defs };
  const chart = {
    initial: "summarize",
    events: { done: { input: { type: "object", properties: {} } } },
    states: {
      summarize: {
        invoke: { src: "summarizer", input: { prompt: "Summarize {{input.change}}" } },
        on: { done: "end" },
      },
      end: { type: "final" },
    },
  };
  provider.reset([
    { text: "", toolCall: { id: "call_1", name: "mcp__jr2__run_chart", args: JSON.stringify({ chart }) } },
    { text: "Done." },
  ]);
  const event = { name: "run_chart", description: "Run this Chart.", input, semantics: "ack" as const };
  sandbox.reset({ ...surfaceAllowing([], []), menu: [event], allowed: ["run_chart"] });
  const iid = "conf/chart-pick";

  const admission = await admit(iid, "Write a Chart and run it.");
  assert.equal((await settled(iid, admission)).outcome, "aborted");

  const tool = provider.calls[0]?.tools?.find((t) => t.function?.name === "mcp__jr2__run_chart");
  const offered = JSON.stringify(tool ?? {});
  assert.match(offered, /\$ref/, "the recursive grammar reaches the provider with its references");
  assert.match(offered, /"enum":\["summarizer"\]/, "narrowed: the lent names are an enum");
  assert.deepEqual(sandbox.delivered, [{ type: "run_chart", chart }]);
});

test("the instructions reach a custom provider as `system`, never `developer`: a chat template knows only the first", async () => {
  // vLLM renders the model's own chat template, and Qwen's refuses `developer` with a 400
  // ("Unexpected message role."). pi sends `developer` for a reasoning model on a host it does not
  // recognise, and every custom-provider model is a reasoning model (provider.ts), so the compat
  // flag is what keeps a self-hosted endpoint answering at all.
  provider.reset([{ text: "Done." }]);
  sandbox.reset(surfaceWith("ack"));
  const iid = "conf/system-role";

  const admission = await admit(iid, "Review the diff.");
  assert.equal((await settled(iid, admission)).outcome, "completed");

  const roles = (provider.calls[0]?.messages ?? []).map((m) => m.role);
  assert.equal(roles[0], "system", `the instructions lead as system (got: ${JSON.stringify(roles)})`);
  assert.ok(!roles.includes("developer"), `no developer message (got: ${JSON.stringify(roles)})`);
});

test("INVERTED PINNED DEFECT: an abort mid-STREAM does not erase the assistant message", async () => {
  // The poison timing flue-contract pinned as broken: the abort lands while the model is still
  // STREAMING its pick. What the model had already committed to must survive into every later
  // turn — silent context loss is the defect ADR-0027 refused to keep waiting on.
  provider.reset([
    {
      text: "I have reviewed it and my verdict is approved.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", partial: true },
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
  // The jr2 moment (ADR-0024): the state exits (registration gone), then the turn is aborted.
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

test("a Menu call an abort cut while the model was still writing it is answered as one that never reached the workflow, and the answer prints once before the next prompt (ADR-0031, ADR-0023)", async () => {
  // The abort lands mid-STREAM: pi runs no call of a message the model did not finish, so the pick
  // was never delivered. The history answers the call on every later request with jr2's text — not
  // the restart's "reached the workflow" — and the log shows that answer once, in the process that
  // continues the conversation, before its prompt; a process after it prints it no more.
  const iid = "conf/mid-stream-unsent";
  const dir = await mkdtemp(join(tmpdir(), "jr2-conversations-"));
  const unsent = unsentPickResult("mcp__jr2__review_verdict");
  provider.reset([
    {
      text: "I have reviewed it and my verdict is approved.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", partial: true },
      stall: true,
    },
    { text: "Acknowledged." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const first = appOver(dir);
  const admission = await admit(iid, "Review the diff.", undefined, AGENT, first);
  await until(() => provider.stalled(), "the model to start streaming its pick");
  // Room for pi to fold the streamed frames into its partial message (see the mid-STREAM test).
  await sleep(300);
  sandbox.killSurface();
  const res = await first.request(`${conversationPath(iid)}/abort`, { method: "POST" });
  assert.deepEqual(await res.json(), { aborted: true });
  assert.equal((await settled(iid, admission, AGENT, first)).outcome, "aborted");
  assert.deepEqual(sandbox.delivered, [], "the call never reached the workflow");

  // The same process continues the conversation.
  sandbox.reviveSurface();
  const next = await admit(iid, "Now summarize.", undefined, AGENT, first);
  assert.equal((await settled(iid, next, AGENT, first)).outcome, "completed");
  const sent = provider.calls.at(-1)?.messages ?? [];
  const answered = sent.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  assert.equal(JSON.stringify(answered?.content ?? ""), JSON.stringify(unsent), JSON.stringify(answered));
  assert.doesNotMatch(JSON.stringify(sent), /This pick reached the workflow/);

  const answerLine = `[${AGENT}] [review_verdict answer] ${unsent}`;
  const lines = () => (printed.get(iid) ?? "").split("\n");
  const call = lines().findIndex((l) => l.startsWith(`[${AGENT}] [review_verdict] `));
  const answer = lines().indexOf(answerLine);
  const prompt = lines().findIndex((l) => l.startsWith(`[${AGENT}] [prompt] Now summarize.`));
  assert.ok(
    call !== -1 && call < answer && answer < prompt,
    `call, its answer, then the prompt:\n${lines().join("\n")}`,
  );
  const answers = () => lines().filter((l) => l.startsWith(`[${AGENT}] [review_verdict answer]`));
  assert.deepEqual(answers(), [answerLine], "printed once");

  // A process after it: the history still answers the call with the same text, and nothing prints.
  provider.reset([{ text: "Again." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const second = appOver(dir);
  const later = await admit(iid, "And now?", undefined, AGENT, second);
  assert.equal((await settled(iid, later, AGENT, second)).outcome, "completed");
  const resent = (provider.calls[0]?.messages ?? []).find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  assert.equal(JSON.stringify(resent?.content ?? ""), JSON.stringify(unsent), JSON.stringify(resent));
  assert.deepEqual(answers(), [answerLine], "still printed once");
});

test("a provider error after a partial Menu call: the next request carries no result for that call, and the model calls again (ADR-0031)", async () => {
  // The stream breaks while the model is still writing its pick: pi ends the message with
  // stopReason `error`, runs none of its calls and drops it from every later request. So jr2 adds
  // no answer for the call — one would be a tool result with no call before it — and the pick,
  // never delivered, is free to be made again.
  provider.reset([
    {
      text: "I have reviewed it and my verdict is approved.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", partial: true },
      broken: true,
    },
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_2", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/provider-error-mid-call";

  const first = await settled(iid, await admit(iid, "Review the diff."));
  assert.equal(first.outcome, "failed", JSON.stringify(first));
  assert.deepEqual(sandbox.delivered, [], "the call never reached the workflow");

  const next = await admit(iid, "Try again.");
  assert.equal((await settled(iid, next)).outcome, "aborted");
  const sent = provider.calls[1]?.messages ?? [];
  assert.ok(
    !sent.some((m) => m.role === "tool" && m.tool_call_id === "call_1"),
    `no result for the cut call: ${JSON.stringify(sent)}`,
  );
  assert.ok(!JSON.stringify(sent).includes("call_1"), `the errored message is not replayed: ${JSON.stringify(sent)}`);
  assert.doesNotMatch(JSON.stringify(sent), /This pick reached the workflow|did not reach the workflow/);
  for (const m of sent.filter((m) => m.role === "tool")) {
    const id = String(m.tool_call_id);
    assert.ok(
      sent.some((a) => a.role === "assistant" && JSON.stringify(a.tool_calls ?? []).includes(id)),
      `every tool result follows its call: ${JSON.stringify(sent)}`,
    );
  }
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }], "the call made again ran");
});

test("an abort mid-TOOL-CALL keeps the turn in history: the loop writes its own result", async () => {
  // The benign timing, and the common one: the pick was delivered, so the state exited while the
  // MCP call was still open. The loop settles the tool call itself, so the assistant message
  // keeps its pair and survives into the next turn.
  provider.reset([
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' },
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

test("a Turn-ending pick the Orchestrator took, whose Turn's abort lands before its answer: the model never reads that it did not reach the Orchestrator (ADR-0002)", async () => {
  // Measured (real Haiku 5.5 and Qwen, `noticed`, 2026-10-22): the run moved on the pick, and the
  // model read "the pick never reached the Orchestrator … — try it again", then said the call failed.
  provider.reset([
    {
      toolCalls: [
        { id: "call_b", name: "bash", args: JSON.stringify({ command: "true" }) },
        { id: "call_s", name: "mcp__jr2__started", args: '{"verdict":"up"}' },
      ],
    },
  ]);
  sandbox.reset(surfaceWith("started", "report"));
  sandbox.holdDeliveries();
  const iid = "conf/taken-then-aborted";
  const admission = await admit(iid, "Start it, then call started.");
  await until(() => sandbox.delivered.length > 0, "the pick to be taken");
  // The Orchestrator took it, the state exited, and its abort lands before the receipt.
  sandbox.killSurface();
  await abort(iid);
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["started"],
  );

  // The next Turn, with the pick's answer as its notice (ADR-0062).
  provider.reset([{ text: "Reporting." }]);
  sandbox.reset(surfaceAllowing(["started", "report"], ["report"]));
  const notice = {
    kind: "pick-answer",
    scope: "conversation",
    pick: "started",
    cut: false,
    answer: { kind: "output", actor: "server", output: "ok" },
  };
  const res = await app.request(conversationPath(iid), {
    method: "POST",
    body: JSON.stringify({
      message: "Is the server still answering? Call `report`.",
      cwd: tmpdir(),
      definition: definitions[AGENT],
      notices: [notice],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  const next = (await res.json()) as { offset: string; submissionId: string };
  assert.equal((await settled(iid, next)).outcome, "completed");
  const read = toolResultText(provider.calls[0], "call_s");
  assert.doesNotMatch(read, /never reached/);
  assert.match(
    read,
    /^It is not known whether this pick reached the workflow: your turn ended while the call to `mcp__jr2__started` waited for the workflow's answer \(/,
  );
  assert.doesNotMatch(printed.get(iid) ?? "", /never reached/);
  // An answer, not an error: an error reads as a failed pick (ADR-0002).
  assert.match(printed.get(iid) ?? "", /\[started answer\] It is not known whether this pick reached the workflow/);
  assert.ok(
    lastUserText(provider.calls[0]).includes(noticeText(notice as Notice, menuToolName)),
    lastUserText(provider.calls[0]),
  );

  // An outstanding pick whose poll the Turn's abort cuts: it reached the workflow, and only its
  // answer went unread.
  provider.reset([{ toolCall: { id: "call_o", name: "mcp__jr2__started", args: '{"verdict":"up"}' } }]);
  sandbox.reset(surfaceWith("started", "report"));
  sandbox.answerWith(outstandingReceipt);
  sandbox.pollWith(() => new Promise<never>(() => {}));
  const held = "conf/outstanding-then-aborted";
  const heldAdmission = await admit(held, "Start it, then call started.");
  await until(() => sandbox.polls.length > 0, "the pick's answer to be polled");
  await app.request(`${conversationPath(held)}/abort`, { method: "POST" });
  assert.equal((await settled(held, heldAdmission)).outcome, "aborted");
  provider.reset([{ text: "Reporting." }]);
  sandbox.reset(surfaceWith("started", "report"));
  assert.equal((await settled(held, await admit(held, "Call `report`."))).outcome, "completed");
  assert.equal(toolResultText(provider.calls[0], "call_o"), unreadAnswerResult("mcp__jr2__started"));
  assert.ok((printed.get(held) ?? "").includes(`[started answer] ${unreadAnswerResult("mcp__jr2__started")}`));
});

test("ending a turn logs no error: no 404 spam, no unhandled rejection (ADR-0026)", async () => {
  provider.reset([
    {
      text: "Verdict incoming.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", partial: true },
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
  // The Turn part prints the cwd, under a temp folder whose name holds the pid: a pid with 404 in it
  // is not a 404.
  const logged = (stderrText.slice(stderrMark) + (printed.get(iid) ?? "")).replaceAll(tmpdir(), "<tmp>");
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

test('a provider that refuses the load is named: the failed settlement reads "provider limit" (ADR-0064)', async () => {
  // With `maxRetries: 0` the first refusal is the one left after the Harness's retries. Quota
  // exhaustion is the same 429 status, but pi does not call it retryable, so it keeps its own words.
  provider.reset([
    { status: 429, errorMessage: "Rate limit reached for requests" },
    { status: 429, errorMessage: "You exceeded your current quota: insufficient_quota" },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/provider-limit";

  const limited = await settled(iid, await admit(iid, "one"));
  assert.equal(limited.outcome, "failed");
  assert.equal(limited.error?.type, "submission_failed", "an infra fault, not a new class (ADR-0016)");
  assert.match(limited.error?.message ?? "", /^provider limit \(fake\/model-x\): 429\b.*Rate limit reached/);

  const quota = await settled(iid, await admit(iid, "two"));
  assert.equal(quota.outcome, "failed");
  assert.doesNotMatch(quota.error?.message ?? "", /provider limit/);
  assert.match(quota.error?.message ?? "", /insufficient_quota/);
});

test("the printer wrote the conversation: prompts, text, tool calls, each pick's answer — a Working tool's result never (ADR-0023)", async () => {
  provider.reset([
    // The command prints; what it printed does not (the call's input does not hold it).
    { toolCall: { id: "call_0", name: "bash", args: '{"command":"echo V09SS0lORy1SRVNVTFQ= | base64 -d"}' } },
    {
      text: "Here is my verdict.",
      toolCall: { id: "call_1", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' },
    },
    { text: "All done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  // The pick leaves the Turn open, so the model is asked again and its text prints.
  sandbox.answerWith(() => ({ moved: true, turnComplete: false, allowed: ["review_verdict"] }));
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
  // The pick's answer prints after its call, the text the model read back (the provider saw it).
  const answer = lines.find((line) => line.startsWith(`[${AGENT}] [review_verdict answer] `));
  assert.ok(answer, `no answer line in:\n${log}`);
  const text = answer.slice(`[${AGENT}] [review_verdict answer] `.length);
  assert.match(text, /^Delivered "review_verdict" to the workflow/);
  assert.ok(JSON.stringify(provider.calls).includes(JSON.stringify(text).slice(1, -1)), "the text the model read");
  assert.ok(
    lines.indexOf(answer) > lines.indexOf(`[${AGENT}] [review_verdict] {"verdict":"approved"}`),
    "after its call",
  );
  assert.ok(lines.includes(`[${AGENT}] [bash] echo V09SS0lORy1SRVNVTFQ= | base64 -d`), `no bash line in:\n${log}`);
  assert.ok(JSON.stringify(provider.calls).includes("WORKING-RESULT"), "the command ran, and the model read it");
  assert.ok(!log.includes("WORKING-RESULT"), "a Working tool's RESULT is a boundary, never printed (ADR-0023)");
});

test('K byte-identical tool calls are a Runaway: the Harness ends the turn, typed "runaway" (ADR-0035)', async () => {
  // The production shape: the model collapses into the same call forever. K=4 is the jr2-owned
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

test("a turn compacts MID-flight: the cut lands between two requests of ONE Submission (ADR-0036)", async () => {
  // The claim that distinguishes ADR-0036 from flue's turn-boundary split, and the failure it was
  // written for: run `588b0f5e` filled its window at step ~161 of a single turn. Request 4's response
  // reports a context past the reserve (window 200000 − max(16384, 8192) = 183616), so the cut
  // must happen inside the turn, and the very next provider request must already carry it.
  provider.reset([
    { toolCall: { id: "call_1", name: "bash", args: '{"command":"echo 1"}' } },
    { toolCall: { id: "call_2", name: "bash", args: '{"command":"echo 2"}' } },
    { toolCall: { id: "call_3", name: "bash", args: '{"command":"echo 3"}' } },
    { toolCall: { id: "call_4", name: "bash", args: '{"command":"echo 4"}' }, usage: { prompt_tokens: 190_000 } },
    { toolCall: { id: "call_5", name: "bash", args: '{"command":"echo 5"}' } },
    // The pick ends the Turn, and so the run: it is the script's last request (ADR-0024).
    { toolCall: { id: "call_6", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' } },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-midturn";

  const admission = await admit(iid, "Find the flag.", undefined, AGENT, compactApp);
  const settlement = await settled(iid, admission, AGENT, compactApp);
  assert.equal(settlement.outcome, "aborted");

  assert.equal(provider.summaries.length, 1, "one cut, one summarizer call");
  assert.equal(provider.calls.length, 6, "the summarizer is not a scripted request: the turn ran its script");
  // MID-flight: the summary was fetched AFTER the request that crossed and BEFORE the next one.
  assert.ok(
    provider.calls[3]!.seq < provider.summaries[0]!.seq && provider.summaries[0]!.seq < provider.calls[4]!.seq,
    `the cut landed between two requests (calls ${provider.calls.map((c) => c.seq)}, summary ${provider.summaries[0]!.seq})`,
  );
  // …and the request that NOTICED is already compacted — no round-trip is spent on a full window.
  assert.ok(!carriesSummary(provider.calls[3]), "the pre-cut requests carried no summary");
  assert.ok(carriesSummary(provider.calls[4]), "the request after the cut carries the summary");
  assert.ok(
    provider.calls[4]!.messages.length < provider.calls[3]!.messages.length,
    `the context SHRANK (${provider.calls[3]!.messages.length} → ${provider.calls[4]!.messages.length})`,
  );
  // …and it KEEPS carrying it. This is the pi-bump canary ADR-0036 names: the mechanism is pi's
  // loop keeping the context that `prepareRequest` returned for the rest of the run — behavior pi
  // documents in types but does not promise as a caller contract.
  assert.ok(carriesSummary(provider.calls[5]), "the NEXT request kept the cut context too");
  // The turn went on to its pick: a compacted turn still concludes (ADR-0006).
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // Both the read and the pick carried the Stand-in: the token itself is the Custodian's (ADR-0059).
  assert.ok(sandbox.bearers.length >= 2 && sandbox.bearers.every((b) => b === `Bearer ${SANDBOX_STAND_IN}`));
  // One Submission, one settlement — the cut settles nothing, and it leaves no history entry: jr2
  // records what was SAID, and Compaction changes only what the model sees (ADR-0036).
  const view = await history(iid, compactApp);
  assert.deepEqual(
    view.settlements.map((s) => s.outcome),
    ["aborted"],
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
  // request hook (`prepareRequest`) fires before a turn's FIRST request too, so the nudge compacts
  // before it asks.
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
  // VERBATIM, and the next cut must be able to reach that work — a compaction entry that carried
  // its tail on the ENTRY would stop the next cut's boundary walk at it, so the tail would be
  // neither summarized nor kept (the engine part's entry stores no tail for this reason). Silent amnesia of the most recent
  // work is the exact failure this ADR exists to prevent, so it is pinned end-to-end: every mark
  // the agent produced must survive somewhere the model can still read it.
  const marks = ["MARKAAA", "MARKBBB", "MARKCCC", "MARKDDD", "MARKEEE", "MARKFFF"];
  provider.reset([
    ...marks.map((mark, i) => ({
      toolCall: { id: `call_${i + 1}`, name: "bash", args: `{"command":"echo ${mark}"}` },
      // Responses 3 and 6 cross the reserve, so two cuts land inside ONE Submission.
      ...(i === 2 || i === 5 ? { usage: { prompt_tokens: 190_000 } } : {}),
    })),
    { toolCall: { id: "call_7", name: "bash", args: '{"command":"echo done"}' } },
    // The pick ends the Turn, and so the run: it is the script's last request (ADR-0024).
    { toolCall: { id: "call_8", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' } },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/compact-twice";

  const admission = await admit(iid, "Find the flag.", undefined, AGENT, compactApp);
  assert.equal((await settled(iid, admission, AGENT, compactApp)).outcome, "aborted");

  assert.equal(provider.summaries.length, 2, "two cuts, in ONE Submission");
  assert.equal(provider.calls.length, 8, "neither summarizer call is a scripted request");
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

test("a Turn on a custom model with no token limit at all sends none — not pi-ai's max_completion_tokens: 1 (ADR-0018)", async () => {
  provider.reset([{ text: "Done." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/unlimited";
  const admission = await admit(iid, "Answer.", { model: "fake/model-unlimited" }, AGENT);
  assert.equal((await settled(iid, admission, AGENT)).outcome, "completed");
  const body = provider.calls.at(-1)! as unknown as Record<string, unknown>;
  assert.equal(body.model, "model-unlimited");
  assert.equal("max_completion_tokens" in body || "max_tokens" in body, false, JSON.stringify(body).slice(0, 300));
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
  // it. ADR-0035's trip ends the run at the step boundary (`finishTurn`), so the loop makes no
  // other request and takes no pass through the request hook. A cut there would spend a
  // full-window summarization, and an unbounded wait on it, for a request that is never sent — and
  // would leave a compaction entry and a `[compacted]` line making a killed turn read as a healthy
  // one.
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
    { toolCall: { id: "call_5", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/runaway-healthy";

  const admission = await admit(iid, "Review the diff.");
  const settlement = await settled(iid, admission);
  // The pick ended the Turn (ADR-0024): no Runaway.
  assert.deepEqual(settlement.error, { type: "submission_aborted", message: TURN_ENDED_MESSAGE });
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // Both the read and the pick carried the Stand-in: the token itself is the Custodian's (ADR-0059).
  assert.ok(sandbox.bearers.length >= 2 && sandbox.bearers.every((b) => b === `Bearer ${SANDBOX_STAND_IN}`));
});

// ─── the outstanding pick (ADR-0024, ADR-0013) ─────────────────────────────────────────────────────

/** The Orchestrator's answer to a pick the workflow runs: at once, with a delivery id. */
const outstandingReceipt = (event: Record<string, unknown>) => ({
  moved: true,
  turnComplete: false,
  allowed: [],
  outstanding: true,
  event: event.type,
});

/** A poll's answer: the workflow is back at Rest. */
const answeredReceipt = (deliveryId: string, extra: Record<string, unknown> = {}) => ({
  delivered: true,
  event: "run_tests",
  deliveryId,
  moved: true,
  turnComplete: false,
  answered: true,
  allowed: ["run_tests", "finish"],
  ...extra,
});

test("an outstanding pick through the real loop: ONE tool call long-polls the answer, and the model reads it", async () => {
  provider.reset([
    { toolCall: { id: "call_t", name: "mcp__jr2__run_tests", args: '{"verdict":"go"}' } },
    { text: "Tests pass." },
  ]);
  sandbox.reset(surfaceWith("run_tests", "finish"));
  sandbox.answerWith(outstandingReceipt);
  sandbox.pollWith((poll, deliveryId) =>
    poll < 3
      ? { delivered: true, deliveryId, ...outstandingReceipt({ type: "run_tests" }) }
      : answeredReceipt(deliveryId, {
          allowed: ["finish"],
          answer: { kind: "output", actor: "tests", output: { passed: 3 } },
        }),
  );
  const iid = "conf/held";
  const admission = await admit(iid, "Run the tests.");
  assert.equal((await settled(iid, admission)).outcome, "completed");

  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["run_tests"],
    "one pick, delivered once",
  );
  assert.equal(sandbox.polls.length, 3, "polled until answered, all inside one tool call");
  const result = JSON.stringify((provider.calls[1]?.messages ?? []).find((m) => m.role === "tool"));
  assert.match(result, /The workflow took it and is back in the state that asked for this turn/);
  assert.match(result, /Its answer: the output of `tests`: \{\\"passed\\":3\}/);
  assert.match(result, /Allowed now: `mcp__jr2__finish`/);
  assert.equal(provider.calls.length, 2, "the model was asked once more, after the answer — never mid-wait");
});

test("two picks in ONE message: the first is delivered, and the second does not run — `finish` included (ADR-0024)", async () => {
  // The model wrote the second pick before it read the first one's answer, so the Harness never
  // sends it: the Orchestrator gets the first pick alone, and the model reads why.
  for (let trial = 0; trial < 5; trial++) {
    provider.reset([
      {
        toolCalls: [
          { id: "call_a", name: "mcp__jr2__run_tests", args: '{"verdict":"go"}' },
          { id: "call_b", name: "mcp__jr2__finish", args: '{"verdict":"done"}' },
        ],
      },
      { text: "Waiting on the answer." },
    ]);
    sandbox.reset(surfaceWith("run_tests", "finish"));
    sandbox.answerWith(outstandingReceipt);
    sandbox.pollWith(async (_poll, deliveryId) => {
      await sleep(20);
      return answeredReceipt(deliveryId, { allowed: ["finish"] });
    });
    const iid = `conf/second-pick-${trial}`;
    assert.equal((await settled(iid, await admit(iid, "Do both."))).outcome, "completed");
    assert.deepEqual(
      sandbox.delivered.map((e) => e.type),
      ["run_tests"],
      `trial ${trial}: only the first pick of the message reached the Orchestrator`,
    );
    assert.equal(toolResultText(provider.calls[1], "call_b"), stalePickResult("mcp__jr2__run_tests"));
    assert.match(toolResultText(provider.calls[1], "call_a"), /^Delivered "run_tests"/);
  }
});

test("a call the engine never prepared is no first pick: an unknown tool or invalid arguments ahead of a pick leave the pick to run (ADR-0024)", async () => {
  // pi answers a call of an unknown tool, or one whose arguments do not validate, with its own error
  // and asks the Harness nothing: the pick after it is the first pick of the answer.
  for (const [n, ahead] of [
    { id: "call_x", name: "mcp__jr2__nope", args: '{"verdict":"x"}' },
    { id: "call_x", name: "mcp__jr2__review_verdict", args: "{}" },
  ].entries()) {
    provider.reset([
      { toolCalls: [ahead, { id: "call_v", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' }] },
    ]);
    sandbox.reset(surfaceWith("review_verdict"));
    const iid = `conf/unprepared-first-${n}`;
    await settled(iid, await admit(iid, "Review it."));
    assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
    assert.ok(!(printed.get(iid) ?? "").includes("This pick did not run"), printed.get(iid) ?? "");
  }
});

test("every call that starts is a step: an invalid pick and a blocked second pick both count, so a model that repeats them is a Runaway (ADR-0035)", async () => {
  // The watch counts at `tool_start`, which the engine sends for every call before it checks the
  // tool. On main a call that pi rejected was no step, so a model that repeated it never tripped.
  const notMoved = () => ({ moved: false, turnComplete: false, allowed: ["run_tests", "review_verdict"] });
  const repeat = (times: number, calls: Array<{ name: string; args: string }>) =>
    Array.from({ length: times }, (_, n) => ({ toolCalls: calls.map((call, i) => ({ id: `c${n}_${i}`, ...call })) }));
  const runaway = async (iid: string, via: Hono) =>
    (await settled(iid, await admit(iid, "Review it.", undefined, AGENT, via), AGENT, via)).error;

  // A call of a tool that is not on the Menu, repeated: the 4th identical call trips.
  provider.reset(repeat(6, [{ name: "mcp__jr2__nope", args: '{"verdict":"x"}' }]));
  sandbox.reset(surfaceWith("run_tests", "review_verdict"));
  assert.deepEqual(await runaway("conf/step-invalid", app), {
    type: "runaway",
    message: "repeated an identical tool call 4 times",
  });
  assert.equal(provider.calls.length, 4);

  // An unknown tool and a pick, repeated, under a toy budget of 3: the pick of answer 2 is step 4.
  provider.reset(
    repeat(4, [
      { name: "mcp__jr2__nope", args: '{"verdict":"x"}' },
      { name: "mcp__jr2__review_verdict", args: '{"verdict":"x"}' },
    ]),
  );
  sandbox.reset(surfaceWith("run_tests", "review_verdict"));
  sandbox.answerWith(notMoved);
  assert.deepEqual(await runaway("conf/step-unknown-and-pick", boundedApp), {
    type: "runaway",
    message: "exceeded 3 steps",
  });
  assert.equal(provider.calls.length, 2);
  assert.equal(sandbox.delivered.length, 1, "the tripping pick did not run");

  // Two picks, repeated: the blocked second pick of answer 2 is step 4.
  provider.reset(
    repeat(4, [
      { name: "mcp__jr2__run_tests", args: '{"verdict":"x"}' },
      { name: "mcp__jr2__review_verdict", args: '{"verdict":"y"}' },
    ]),
  );
  sandbox.reset(surfaceWith("run_tests", "review_verdict"));
  sandbox.answerWith(notMoved);
  assert.deepEqual(await runaway("conf/step-two-picks", boundedApp), { type: "runaway", message: "exceeded 3 steps" });
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["run_tests", "run_tests"],
  );
});

/** The printed lines of one conversation (ADR-0023) whose label is in `labels`, without the Agent
 * prefix: the order a reader of the log, and the `@model` tier's `answersIn`, rely on. */
function printedOrder(iid: string, agent: string, labels: RegExp): string[] {
  return (printed.get(iid) ?? "")
    .split("\n")
    .filter((line) => line.startsWith(`[${agent}] [`))
    .map((line) => line.slice(`[${agent}] `.length))
    .filter((line) => labels.test(line));
}

test("the print order (ADR-0023): a message's pick answers print in the order of its calls, and each before the prompt that follows them", async () => {
  // (a) Two calls of one pick in ONE message: the first is outstanding and answers after a poll,
  // the second does not run. Each answer prints in the order of its call (`answersIn`'s rule).
  provider.reset([
    {
      toolCalls: [
        { id: "call_a", name: "mcp__jr2__run_tests", args: '{"verdict":"one"}' },
        { id: "call_b", name: "mcp__jr2__run_tests", args: '{"verdict":"two"}' },
      ],
    },
    { text: "Waiting on the answer." },
  ]);
  sandbox.reset(surfaceWith("run_tests", "finish"));
  sandbox.answerWith(outstandingReceipt);
  sandbox.pollWith(async (_poll, deliveryId) => {
    await sleep(20);
    return answeredReceipt(deliveryId, { allowed: ["finish"] });
  });
  const twice = "conf/print-order-one-message";
  assert.equal((await settled(twice, await admit(twice, "Run them."))).outcome, "completed");
  const lines = printedOrder(twice, AGENT, /^\[(prompt|run_tests|run_tests answer|run_tests error)\] /);
  assert.deepEqual(
    lines.map((l) => l.replace(/\] .*$/s, "]")),
    ["[prompt]", "[run_tests]", "[run_tests]", "[run_tests answer]", "[run_tests error]", "[prompt]"],
    lines.join("\n"),
  );
  assert.equal(lines[1], '[run_tests] {"verdict":"one"}');
  assert.equal(lines[2], '[run_tests] {"verdict":"two"}');
  assert.match(lines[3]!, /^\[run_tests answer\] Delivered "run_tests"/);
  assert.match(printed.get(twice) ?? "", /The workflow took it and is back in the state that asked for this turn/);
  assert.equal(lines[4], `[run_tests error] ${stalePickResult("mcp__jr2__run_tests")}`);
  assert.equal(lines[5], "[prompt] <jr2-turn>", "the restated Turn part prints after both answers");

  // (b) A pick whose answer leaves the Turn open, and a Gate's answer before the next step: the
  // pick's answer prints before the restated Turn part, as the model read them.
  provider.reset([
    { toolCall: { id: "p1", name: "mcp__jr2__run_tests", args: '{"verdict":"x"}' } },
    { toolCall: { id: "p2", name: "mcp__jr2__submit", args: '{"verdict":"x"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read <= 1 ? CODING : REVIEWING));
  sandbox.answerWith((event) =>
    event.type === "run_tests" ? { moved: true, turnComplete: false, allowed: CODING } : endsTurn(),
  );
  const steered = "conf/print-order-restated";
  assert.equal((await settled(steered, await admit(steered, "Fix the ticket."))).outcome, "aborted");
  assert.deepEqual(
    printedOrder(steered, AGENT, /^\[(prompt|run_tests|run_tests answer|submit|submit answer)\] /).map((l) =>
      l.replace(/ .*$/s, ""),
    ),
    ["[prompt]", "[run_tests]", "[run_tests", "[prompt]", "[submit]", "[submit"],
  );
  assert.ok(
    printedOrder(steered, AGENT, /^\[prompt\] /).at(-1) === "[prompt] <jr2-turn>",
    "the second prompt is the restated Turn part",
  );
});

test("an outstanding pick's answer resets the identical-call streak: the same pick, answered each time, is no Runaway (ADR-0035)", async () => {
  const call = { name: "mcp__jr2__run_tests", args: '{"verdict":"go"}' };
  provider.reset([
    { toolCall: { id: "c1", ...call } },
    { toolCall: { id: "c2", ...call } },
    { toolCall: { id: "c3", ...call } },
    { toolCall: { id: "c4", ...call } },
    { text: "Flaky, but done." },
  ]);
  sandbox.reset(surfaceWith("run_tests", "finish"));
  sandbox.answerWith(outstandingReceipt);
  sandbox.pollWith((_poll, deliveryId) =>
    answeredReceipt(deliveryId, { answer: { kind: "output", actor: "tests", output: "1 failed" } }),
  );
  const iid = "conf/held-streak";
  const admission = await admit(iid, "Run the tests until they pass.");
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "completed", JSON.stringify(settlement));
  assert.equal(sandbox.delivered.length, 4, "four identical picks, each answered by the world");
});

test("a guard straight back resets no streak: nothing ran, so the same pick four times is a Runaway (ADR-0035)", async () => {
  // The run host's guard-back receipt: answered on the POST, never outstanding, no reply. The
  // state value did not change, so the 4th identical call is the same question again.
  const call = { name: "mcp__jr2__run_tests", args: '{"verdict":"go"}' };
  provider.reset([1, 2, 3, 4, 5].map((n) => ({ toolCall: { id: `g${n}`, ...call } })));
  sandbox.reset(surfaceWith("run_tests", "finish"));
  sandbox.answerWith((event) => ({
    moved: true,
    turnComplete: false,
    answered: true,
    straightBack: true,
    allowed: ["run_tests", "finish"],
    event: event.type,
  }));
  const iid = "conf/guard-back-streak";
  const admission = await admit(iid, "Run the tests.");
  const settlement = await settled(iid, admission);
  assert.equal(settlement.outcome, "failed", JSON.stringify(settlement));
  assert.equal(settlement.error?.type, "runaway");
  assert.match(settlement.error?.message ?? "", /repeated an identical tool call 4 times/);
  assert.equal(sandbox.delivered.length, 3, "the 4th identical call trips before it leaves");
  assert.equal(sandbox.polls.length, 0, "nothing was outstanding, so nothing was polled");
  const result = JSON.stringify((provider.calls[1]?.messages ?? []).find((m) => m.role === "tool"));
  assert.match(result, /It moved the workflow, and nothing ran: the workflow is back in the state/);
});

// ─── a stopping Harness (ADR-0031) ───────────────────────────────────────────────────────────────────

/** The answer a Gate gave, as the Orchestrator's re-admission carries it (ADR-0024, ADR-0062). */
const auditedNotice = {
  kind: "pick-answer",
  scope: "conversation",
  pick: "run_audit",
  cut: true,
  answer: { kind: "event", event: "audited", sender: { party: "gate", id: "auditor" }, payload: { findings: "f" } },
};

test("a stopping Harness cuts at once a Turn that waits only on its pick's answer; the re-admission continues the conversation with the answer (ADR-0031)", async () => {
  const iid = "conf/drain-cut";
  const dir = await mkdtemp(join(tmpdir(), "jr2-conversations-"));
  provider.reset([
    {
      text: "Asking the auditor.",
      toolCall: { id: "call_audit", name: "mcp__jr2__run_audit", args: '{"verdict":"go"}' },
    },
  ]);
  sandbox.reset(surfaceWith("run_audit", "file_report"));
  sandbox.answerWith(outstandingReceipt);
  // A Gate: the answer waits on a human, often the one who is stopping the Harness.
  sandbox.pollWith(() => new Promise<never>(() => {}));
  const before = serverOver(dir);
  const admission = await admit(iid, "Audit the expenses.", undefined, DECISIONER, before.app);
  await until(() => sandbox.polls.length > 0, "the pick's answer to be polled");

  const started = performance.now();
  await before.drain();
  assert.ok(performance.now() - started < 2_000, "cut at once: no grace period for a pick's answer");
  const settlement = await settled(iid, admission, DECISIONER, before.app);
  assert.deepEqual(
    { outcome: settlement.outcome, type: settlement.error?.type },
    { outcome: "failed", type: "harness_restarted" },
    "settled as a restart: the Orchestrator re-admits it, and raises no agent.fault",
  );
  await until(() => sandbox.pollsGone() === 1, "the poll to end unanswered, so its answer stays unread");
  assert.equal(provider.calls.length, 1, "the model was asked nothing after the cut");

  // The replacement, once the workflow is back at Rest: the Orchestrator re-admits the same
  // conversation with the answer as a notice.
  provider.reset([
    { toolCall: { id: "call_report", name: "mcp__jr2__file_report", args: '{"verdict":"filed"}' } },
    { text: "Filed." },
  ]);
  sandbox.reset(surfaceWith("run_audit", "file_report"));
  const after = appOver(dir);
  const res = await after.request(conversationPath(iid, DECISIONER), {
    method: "POST",
    body: JSON.stringify({
      message: "Your previous turn was cut: the process that ran you restarted while the workflow was busy.",
      definition: definitions[DECISIONER],
      notices: [auditedNotice],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  const readmitted = (await res.json()) as { offset: string; submissionId: string };
  assert.equal((await settled(iid, readmitted, DECISIONER, after)).outcome, "aborted");
  const sent = provider.calls[0]?.messages ?? [];
  const cut = sent.find((m) => m.role === "tool" && m.tool_call_id === "call_audit");
  assert.match(JSON.stringify(cut), /This pick reached the workflow, but its answer did not reach you/);
  assert.match(lastUserText(provider.calls[0]), /Your previous turn was cut/);
  assert.match(lastUserText(provider.calls[0]), /`mcp__jr2__run_audit` that was cut from your last turn/);
  assert.match(lastUserText(provider.calls[0]), /`audited` from Gate `auditor`/);

  // The printed conversation (ADR-0023): the cut call's answer is jr2's text in the rebuilt
  // history, and it prints once, after the call and before the re-admission's prompt — the text
  // the model read on that call.
  const cutAnswer = `[${DECISIONER}] [run_audit answer] ${cutPickResult("mcp__jr2__run_audit")}`;
  const answerLines = () =>
    (printed.get(iid) ?? "").split("\n").filter((l) => l.startsWith(`[${DECISIONER}] [run_audit `));
  const lines = (printed.get(iid) ?? "").split("\n");
  const call = lines.indexOf(`[${DECISIONER}] [run_audit] {"verdict":"go"}`);
  const answer = lines.indexOf(cutAnswer);
  const prompt = lines.findIndex((l) => l.startsWith(`[${DECISIONER}] [prompt] Your previous turn was cut`));
  assert.ok(call !== -1 && call < answer && answer < prompt, `call, its answer, then the prompt:\n${lines.join("\n")}`);
  assert.ok(JSON.stringify(cut).includes(JSON.stringify(cutPickResult("mcp__jr2__run_audit")).slice(1, -1)));
  assert.deepEqual(answerLines(), [cutAnswer], "printed once");

  // The rebuilt history answers the call on every later request too, and it does not print again:
  // not on the next Submission of the same process, nor in a process after it.
  provider.reset([{ text: "Nothing more." }]);
  sandbox.reset(surfaceWith("run_audit", "file_report"));
  const again = await admit(iid, "Anything else?", undefined, DECISIONER, after);
  assert.equal((await settled(iid, again, DECISIONER, after)).outcome, "completed");
  provider.reset([{ text: "Still nothing." }]);
  sandbox.reset(surfaceWith("run_audit", "file_report"));
  const third = appOver(dir);
  const later = await admit(iid, "And now?", undefined, DECISIONER, third);
  assert.equal((await settled(iid, later, DECISIONER, third)).outcome, "completed");
  const resent = (provider.calls[0]?.messages ?? []).find((m) => m.role === "tool" && m.tool_call_id === "call_audit");
  assert.match(
    JSON.stringify(resent),
    /This pick reached the workflow/,
    "the third process's request still answers it",
  );
  assert.deepEqual(answerLines(), [cutAnswer], "still printed once");
});

test("a stopping Harness keeps the graceful wait for a Turn that is running a tool — before a polled pick too (ADR-0031)", async () => {
  // A tool running alone: the Turn finishes, and settles completed.
  {
    const iid = "conf/drain-tool";
    provider.reset([bashCall("b1", "sleep 0.6"), { text: "Slept." }]);
    sandbox.reset(surfaceWith("review_verdict"));
    const server = serverOver(await mkdtemp(join(tmpdir(), "jr2-conversations-")));
    const admission = await admit(iid, "Sleep, then stop.", undefined, AGENT, server.app);
    await until(() => provider.calls.length === 1, "the bash call to be made");
    await server.drain();
    assert.equal((await settled(iid, admission, AGENT, server.app)).outcome, "completed");
    assert.equal(provider.calls.length, 2, "the model read the tool's result: nothing was cut");
  }
  // A tool, then a pick in the same model answer: the wait holds while the tool runs and while
  // nothing runs between the two calls; then the pick's poll is all that is left, and the Turn is
  // cut.
  {
    const iid = "conf/drain-tool-and-pick";
    provider.reset([
      {
        toolCalls: [
          { id: "b2", name: "bash", args: JSON.stringify({ command: "sleep 0.6" }) },
          { id: "p1", name: "mcp__jr2__run_audit", args: '{"verdict":"go"}' },
        ],
      },
    ]);
    sandbox.reset(surfaceWith("run_audit", "file_report"));
    sandbox.answerWith(outstandingReceipt);
    sandbox.pollWith(() => new Promise<never>(() => {}));
    const server = serverOver(await mkdtemp(join(tmpdir(), "jr2-conversations-")));
    const admission = await admit(iid, "Sleep and audit.", undefined, AGENT, server.app);
    await until(() => provider.calls.length === 1, "the two calls to be made");
    const started = performance.now();
    await server.drain();
    assert.ok(performance.now() - started >= 300, "the drain waited for the running tool");
    // The cut comes as the pick starts to poll: its first poll may not leave.
    assert.deepEqual(
      sandbox.delivered.map((e) => e.type),
      ["run_audit"],
      "the pick after the tool was delivered before the cut",
    );
    const settlement = await settled(iid, admission, AGENT, server.app);
    assert.deepEqual(
      { outcome: settlement.outcome, type: settlement.error?.type },
      { outcome: "failed", type: "harness_restarted" },
    );
    assert.equal(provider.calls.length, 1, "the model was asked nothing after the cut");
  }
});

// ─── pi 1.x: what the Harness owns now ───────────────────────────────────────

/** The text of the tool result for `toolCallId` in a request. */
function toolResultText(call: { messages: Array<Record<string, unknown>> } | undefined, toolCallId: string): string {
  const result = (call?.messages ?? []).find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
  const content = result?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
}

test("the Harness states its provider retries: a 503, a 503, then the answer completes, with no retry seam (I-1, ADR-0064)", async () => {
  // pi-ai retries only when told how often (`maxRetries ?? 0`), and production never said it, so a
  // production Turn made no provider retry at all. The Harness says 2.
  const busy = { status: 503, errorMessage: "Service Unavailable: overloaded", headers: { "retry-after-ms": "1" } };
  provider.reset([busy, busy, { text: "Recovered." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/provider-retries";
  assert.equal(
    (await settled(iid, await admit(iid, "one", undefined, AGENT, retryApp), AGENT, retryApp)).outcome,
    "completed",
  );
  assert.equal(provider.calls.length, 3, "two retries, then the answer");
});

test("a server that asks for a delay over 60 s is not waited for: one request, and pi-ai's words in the settlement (I-1)", async () => {
  provider.reset([{ status: 429, errorMessage: "Rate limit reached for requests", headers: { "retry-after": "120" } }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/provider-retry-after";
  const settlement = await settled(iid, await admit(iid, "one", undefined, AGENT, retryApp), AGENT, retryApp);
  assert.equal(provider.calls.length, 1);
  assert.equal(settlement.outcome, "failed");
  // The text names the delay, and it is still a load the provider refused (ADR-0064).
  assert.match(
    settlement.error?.message ?? "",
    /^provider limit \(fake\/model-x\): Server requested 120s retry delay \(max: 60s\)\. 429\b.*Rate limit reached/,
  );
});

test("a quota 429 is retried by its status like any 429, and still keeps its own words (ADR-0064)", async () => {
  // pi-ai's provider retry follows the SDKs' policy: it reads the status, not the message, so
  // quota exhaustion is asked again. The settlement still is not a provider limit: pi does not
  // call quota exhaustion retryable (`isRetryableAssistantError`).
  const quota = {
    status: 429,
    errorMessage: "You exceeded your current quota: insufficient_quota",
    headers: { "retry-after-ms": "1" },
  };
  provider.reset([quota, quota, quota]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/provider-quota";
  const settlement = await settled(iid, await admit(iid, "one", undefined, AGENT, retryApp), AGENT, retryApp);
  assert.equal(provider.calls.length, 3);
  assert.doesNotMatch(settlement.error?.message ?? "", /provider limit/);
  assert.match(settlement.error?.message ?? "", /insufficient_quota/);
});

test("a trip ends the run at the step boundary: no further request, and no empty aborted message in the engine part (I-5)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conf-trip-part-"));
  const via = appOver(dir);
  const repeated = { name: "bash", args: '{"command":"true"}' };
  provider.reset([1, 2, 3, 4].map((n) => ({ toolCall: { id: `call_${n}`, ...repeated } })));
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/trip-part";
  const settlement = await settled(iid, await admit(iid, "Find the flag.", undefined, AGENT, via), AGENT, via);
  assert.equal(settlement.error?.type, "runaway");
  assert.equal(provider.calls.length, 4, "no request after the trip");
  const transcript = join(dir, AGENT, encodeURIComponent(iid), "engine", "pi", "transcript.jsonl");
  const { readFileSync } = await import("node:fs");
  const messages = readFileSync(transcript, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { message?: { role: string; stopReason?: string } })
    .flatMap((entry) => (entry.message ? [entry.message] : []));
  assert.equal(messages.filter((m) => m.role === "assistant" && m.stopReason === "aborted").length, 0);
  // The tripping call reads `Operation aborted`, as on pi 0.82.1.
  const last = messages.at(-1) as unknown as { role: string; content: Array<{ text: string }> };
  assert.equal(last.role, "toolResult");
  assert.equal(last.content[0]!.text, "Operation aborted");
});

test("no system message reaches the engine part, and a changed instruction REPLACES the system prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conf-no-system-"));
  const via = appOver(dir);
  provider.reset([{ text: "First." }, { text: "Second." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/no-system";
  const send = async (message: string, instructions: string) => {
    const res = await via.request(conversationPath(iid), {
      method: "POST",
      body: JSON.stringify({ message, cwd: tmpdir(), definition: { ...definitions[AGENT], instructions } }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 200);
    return settled(iid, (await res.json()) as { offset: string; submissionId: string }, AGENT, via);
  };
  assert.equal((await send("one", "Instructions one.")).outcome, "completed");
  assert.equal((await send("two", "Instructions two.")).outcome, "completed");
  const systems = provider.calls[1]!.messages.filter((m) => m.role === "system");
  assert.equal(systems.length, 1, "one system message, leading");
  assert.ok(systemText(provider.calls[1]).startsWith("Instructions two."), "the new instructions replaced the old");
  assert.ok(!sentText(provider.calls[1]).includes("Instructions one."));
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(join(dir, AGENT, encodeURIComponent(iid), "engine", "pi", "transcript.jsonl"), "utf8");
  assert.ok(!text.includes('"role":"system"'), "the transcript holds no system message");
});

test("the thinking level line: a level the model lacks names the level the Harness sent; a level it has prints none (ADR-0023)", async () => {
  provider.reset([{ text: "Deep." }, { text: "High." }, { status: 500, errorMessage: "boom" }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/thinking-line";
  // The custom provider's model has no `xhigh`: the OpenAI-completions adapter clamps it to `high`.
  assert.equal((await settled(iid, await admit(iid, "one", { thinkingLevel: "xhigh" }))).outcome, "completed");
  assert.equal(provider.calls[0]!.reasoning_effort, "high");
  assert.match(
    printed.get(iid) ?? "",
    /\[reviewer\] \[thinking level\] fake\/model-x has no level "xhigh"; the Harness sent "high"\n\[reviewer\] \[text\] Deep\./,
  );
  const before = (printed.get(iid) ?? "").length;
  assert.equal((await settled(iid, await admit(iid, "two", { thinkingLevel: "high" }))).outcome, "completed");
  assert.ok(!(printed.get(iid) ?? "").slice(before).includes("[thinking level]"), "a level the model has prints none");
  // A Submission whose only assistant message is a failure with nothing spent says nothing of a level.
  const failed = (printed.get(iid) ?? "").length;
  assert.equal((await settled(iid, await admit(iid, "three", { thinkingLevel: "xhigh" }))).outcome, "failed");
  assert.ok(!(printed.get(iid) ?? "").slice(failed).includes("[thinking level]"));
});

test("the thinking level line: Claude Sonnet 5.5 at off names the effort that the Harness's request sent (ADR-0023)", async () => {
  // jr2's default level is `off`, which this model lacks. The Anthropic adapter then sends its
  // default effort, `high`, and sets the word from that request: the line gives the choice to the
  // Harness, not to the provider.
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/thinking-line-sonnet-5-5";
  const before = anthropicGateway.seen.length;
  // A catalog provider's key comes from the ambient env (`modelsFor`).
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "x";
  try {
    const dials = { model: "anthropic/claude-sonnet-5-5" };
    const settlement = await settled(iid, await admit(iid, "one", dials, AGENT, gatewayApp), AGENT, gatewayApp);
    assert.equal(settlement.outcome, "completed", JSON.stringify(settlement));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  const sent = anthropicGateway.seen.slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body.output_config, { effort: "high" });
  assert.match(
    printed.get(iid) ?? "",
    /\[reviewer\] \[thinking level\] anthropic\/claude-sonnet-5-5 has no level "off"; the Harness sent effort "high"\n\[reviewer\] \[text\] pong/,
  );
});

test("M9: a null optional argument is dropped before validation — the call runs (pi-ai 1.4)", async () => {
  // On pi 0.82.1 the null became a value that failed: `Invalid timeout: must be a finite number of
  // seconds`. pi-ai 1.4 deletes a null optional field first.
  provider.reset([
    { toolCall: { id: "call_n", name: "bash", args: '{"command":"echo hi","timeout":null}' } },
    { text: "Ran." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/null-argument";
  assert.equal((await settled(iid, await admit(iid, "Run it."))).outcome, "completed");
  assert.equal(toolResultText(provider.calls[1], "call_n"), "hi\n");
});

test("M10: argument text that does not parse is refused, and the call does not run (pi-ai 1.4)", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "conf-malformed-")), "ran");
  const args = `{"command":"touch ${marker}"`;
  provider.reset([{ toolCall: { id: "call_m", name: "bash", args } }, { text: "Noted." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/malformed-argument";
  assert.equal((await settled(iid, await admit(iid, "Run it."))).outcome, "completed");
  const text = toolResultText(provider.calls[1], "call_m");
  assert.ok(text.startsWith('Invalid arguments for tool "bash": '), text);
  assert.ok(text.endsWith(`\n\nReceived arguments:\n${args}`), text);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the call did not run");
});

test("M11: another model's thinking is not sent after a model Dial change (pi-ai 1.4)", async () => {
  provider.reset([{ reasoning: "Model x thought this.", text: "One." }, { text: "Two." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/dial-thinking";
  assert.equal((await settled(iid, await admit(iid, "one"))).outcome, "completed");
  assert.equal((await settled(iid, await admit(iid, "two", { model: "fake/model-y" }))).outcome, "completed");
  assert.equal(provider.calls[1]!.model, "model-y");
  assert.ok(!sentText(provider.calls[1]).includes("Model x thought this."), "no thinking of model-x in any form");
});

test("M12: a request that a provider error ended steers nothing, and the next Submission ends with its prompt (I-7)", async () => {
  provider.reset([{ status: 500, errorMessage: "boom" }, { text: "Next." }]);
  sandbox.reset(surfaceAllowing(MODES_MENU, CODING));
  // Read 1 starts the first Submission; any read after it sees the list changed.
  sandbox.surfaceByRead((read) => surfaceAllowing(MODES_MENU, read === 1 ? CODING : REVIEWING));
  const iid = "conf/error-no-restate";
  assert.equal((await settled(iid, await admit(iid, "Fix the ticket."))).outcome, "failed");
  assert.equal(sandbox.reads(), 1, "the failed request read no Menu");
  const next = await admit(iid, "Next Turn.");
  assert.equal((await settled(iid, next)).outcome, "completed");
  const last = provider.calls[1]!.messages.at(-1);
  assert.equal(last?.role, "user");
  assert.match(lastUserText(provider.calls[1]), /^Next Turn\.\n\n<jr2-turn>/);
  assert.equal(pushesIn(provider.calls[1]), 0, "no restatement rides into the next Submission");
});

test("M6: a trip in the middle of a model answer: the calls before it ran, and the calls after it do not run", async () => {
  // The engine runs one model answer's calls in order (ADR-0027). On pi's parallel default, the
  // call before the trip was prepared and did not start: it answered `Operation aborted`.
  const dir = await mkdtemp(join(tmpdir(), "conf-behind-trip-"));
  const before = join(dir, "before");
  const behind = join(dir, "behind");
  provider.reset([
    bashCall("call_1", "echo 1"),
    bashCall("call_2", "echo 2"),
    {
      toolCalls: [
        { id: "call_3", name: "bash", args: JSON.stringify({ command: `touch ${before}` }) },
        { id: "call_4", name: "bash", args: JSON.stringify({ command: "echo 4" }) },
        { id: "call_5", name: "bash", args: JSON.stringify({ command: `touch ${behind}` }) },
      ],
    },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/behind-trip";
  // A toy budget of 3: the 4th call trips.
  const settlement = await settled(
    iid,
    await admit(iid, "Keep busy.", undefined, AGENT, boundedApp),
    AGENT,
    boundedApp,
  );
  assert.deepEqual(settlement.error, { type: "runaway", message: "exceeded 3 steps" });
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(before), true, "the call before the trip ran");
  assert.equal(existsSync(behind), false, "the call after the trip did not run");
});

test("the calls of one model answer run in the model's order: a read sees what the bash call before it wrote (ADR-0027)", async () => {
  // The bash call writes its file only after a sleep. On pi's parallel default the read starts at
  // once and finds no file.
  const file = join(await mkdtemp(join(tmpdir(), "conf-in-order-")), "out.txt");
  provider.reset([
    {
      toolCalls: [
        { id: "call_w", name: "bash", args: JSON.stringify({ command: `sleep 0.3 && echo written > ${file}` }) },
        { id: "call_r", name: "read", args: JSON.stringify({ path: file }) },
      ],
    },
    { text: "Read it." },
  ]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/in-order-working";
  assert.equal((await settled(iid, await admit(iid, "Write, then read."))).outcome, "completed");
  assert.match(toolResultText(provider.calls[1], "call_r"), /^written\b/);
});

test("the calls of one model answer run in the model's order: a pick leaves after the bash call before it ends (ADR-0027)", async () => {
  // The measured defect (real Anthropic API, Haiku 5.5, 2026-10-22): `bash` with `git commit` and
  // the pick `publish` in one model answer, and `publish` pushed before the commit was made.
  const marker = join(await mkdtemp(join(tmpdir(), "conf-in-order-pick-")), "committed");
  const { existsSync } = await import("node:fs");
  provider.reset([
    {
      toolCalls: [
        { id: "call_c", name: "bash", args: JSON.stringify({ command: `sleep 0.3 && touch ${marker}` }) },
        { id: "call_p", name: "mcp__jr2__publish", args: '{"verdict":"go"}' },
      ],
    },
  ]);
  sandbox.reset(surfaceWith("publish"));
  let committedFirst: boolean | undefined;
  sandbox.answerWith(() => {
    committedFirst = existsSync(marker);
    return { moved: true, turnComplete: true, allowed: [] };
  });
  const iid = "conf/in-order-pick";
  assert.equal((await settled(iid, await admit(iid, "Commit, then publish."))).outcome, "aborted");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["publish"],
  );
  assert.equal(committedFirst, true, "the commit was made before the pick reached the Orchestrator");
});

test("a call after a pick that ended the Turn, in the same model answer, does not run: not a Working tool, not a pick (ADR-0024, ADR-0027)", async () => {
  // The surface stays live, as under `continue: true` when the next state registers the SAME
  // address: a pick that left after the Turn was over would reach the NEXT Turn.
  const marker = join(await mkdtemp(join(tmpdir(), "conf-after-over-")), "ran");
  provider.reset([
    {
      toolCalls: [
        { id: "call_p", name: "mcp__jr2__publish", args: '{"verdict":"go"}' },
        { id: "call_b", name: "bash", args: JSON.stringify({ command: `touch ${marker}` }) },
        { id: "call_f", name: "mcp__jr2__finish", args: '{"verdict":"done"}' },
      ],
    },
    { text: "Stopped." },
  ]);
  sandbox.reset(surfaceWith("publish", "finish"));
  sandbox.answerWith(() => ({ moved: true, turnComplete: true, allowed: [] }));
  const iid = "conf/after-turn-over";
  const dir = await mkdtemp(join(tmpdir(), "conf-after-over-part-"));
  const via = appOver(dir);
  assert.equal(
    (await settled(iid, await admit(iid, "Publish, then more.", undefined, AGENT, via), AGENT, via)).outcome,
    "aborted",
  );
  assert.equal(provider.calls.length, 1, "the run ended at the step boundary: no request after the Turn ended");
  assert.deepEqual(
    sandbox.delivered.map((e) => e.type),
    ["publish"],
    "the pick after the Turn ended never left",
  );
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the Working-tool call after the Turn ended did not run");
  // What the model would read for each blocked call: the engine part's results.
  const { readFileSync } = await import("node:fs");
  const results = readFileSync(join(dir, AGENT, encodeURIComponent(iid), "engine", "pi", "transcript.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { message?: { role: string; toolCallId?: string; content?: Array<{ text: string }> } },
    )
    .flatMap((entry) => (entry.message?.role === "toolResult" ? [entry.message] : []));
  for (const id of ["call_b", "call_f"]) {
    assert.equal(results.find((m) => m.toolCallId === id)?.content?.[0]?.text, turnOverResult());
  }
});

test("an abort between two calls of one model answer: the call after it never starts, and the history says so — for a pick too (ADR-0027)", async () => {
  // The engine gives a call it never started no result. With none, pi-ai would answer the pick
  // with "No result provided", and `settleCutPicks` with "This pick reached the workflow".
  const marker = join(await mkdtemp(join(tmpdir(), "conf-abort-between-")), "ran");
  provider.reset([
    {
      toolCalls: [
        { id: "call_s", name: "bash", args: JSON.stringify({ command: "sleep 2" }) },
        { id: "call_t", name: "bash", args: JSON.stringify({ command: `touch ${marker}` }) },
        { id: "call_f", name: "mcp__jr2__finish", args: '{"verdict":"done"}' },
      ],
    },
  ]);
  sandbox.reset(surfaceWith("finish"));
  const iid = "conf/abort-between";
  const admission = await admit(iid, "Sleep, then finish.");
  await until(() => provider.calls.length === 1, "the model answer with three calls");
  await sleep(200);
  assert.deepEqual(await abort(iid), { aborted: true });
  assert.equal((await settled(iid, admission)).outcome, "aborted");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the call after the abort did not run");
  assert.deepEqual(sandbox.delivered, [], "the pick after the abort never left");

  provider.reset([{ text: "Next." }]);
  sandbox.reset(surfaceWith("finish"));
  assert.equal((await settled(iid, await admit(iid, "Next Turn."))).outcome, "completed");
  for (const id of ["call_t", "call_f"]) assert.equal(toolResultText(provider.calls[0], id), unrunResult());
  // A Working tool's result is never printed (ADR-0023); the pick's answer prints once.
  const answers = (printed.get(iid) ?? "").split("\n").filter((line) => line.includes(unrunResult()));
  assert.deepEqual(answers, [`[${AGENT}] [finish error] ${unrunResult()}`], printed.get(iid) ?? "");
});

test("jr2 is not pi: a request names no attribution, even to a base URL that pi-ai reads as OpenRouter", async () => {
  provider.reset([{ text: "Hello." }]);
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/no-attribution";
  assert.equal(
    (await settled(iid, await admit(iid, "one", undefined, AGENT, openRouterApp), AGENT, openRouterApp)).outcome,
    "completed",
  );
  const headers = provider.calls[0]!.headers ?? {};
  assert.equal(headers["http-referer"], undefined);
  assert.equal(headers["x-openrouter-title"], undefined);
  assert.equal(headers["x-title"], undefined);
});

test("an abort that lands after the step boundary asks for no summary, and the run ends (I-10)", async () => {
  // The request hook runs once more after such an abort, over a full window. It asks for no summary
  // then. This test cannot tell jr2's own check from pi-ai's: a summary call on an aborted signal
  // sends nothing either. It pins the outcome — no summary request, and a run that ends; the check
  // itself is pinned socket-free in `compaction.test.ts`, by a count of the summary calls.
  provider.reset([{ ...bashCall("call_1", "echo 1"), usage: { prompt_tokens: 190_000 } }, { text: "Unreached." }]);
  provider.summarize({ stall: true });
  sandbox.reset(surfaceWith("review_verdict"));
  const iid = "conf/abort-no-summary";
  sandbox.surfaceByRead(async (read) => {
    // The boundary read after the step: the abort lands while it is out.
    if (read === 2) await compactApp.request(`${conversationPath(iid)}/abort`, { method: "POST" });
    return surfaceWith("review_verdict");
  });
  const settlement = await settled(iid, await admit(iid, "Find it.", undefined, AGENT, compactApp), AGENT, compactApp);
  provider.summarize({});
  assert.equal(settlement.outcome, "aborted");
  assert.equal(provider.summaries.length, 0, "an ended run buys no summarizer round-trip");
});
