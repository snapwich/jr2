// The kept conversation's sender (ADR-0023, `keep.ts`): each body of the print is an entry, written
// locally first and sent in batches. A batch that fails is sent again with the same `seq`s, a
// restart sends what the Orchestrator did not take, and nothing a Turn does waits on a send.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Engine, EngineAdapter, EngineListener } from "../src/engine.ts";
import { ConversationKeeper, keepSendOver, type KeepAnswer, type KeptEntry } from "../src/keep.ts";
import { sendLastBatches } from "../src/app.ts";
import { printLines } from "../src/printer.ts";
import { modelsFor } from "../src/provider.ts";
import { openEnginePart } from "../src/transcript.ts";
import { runSubmissionFor } from "../src/turn.ts";
import { testChildren } from "./support/children.ts";

type Sent = { instanceId: string; slot: string; entries: KeptEntry[] };

/** A send that answers from a list, and records each batch. */
function scripted(answers: KeepAnswer[]) {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (instanceId: string, slot: string, entries: readonly KeptEntry[]): Promise<KeepAnswer> => {
      sent.push({ instanceId, slot, entries: [...entries] });
      return answers.shift() ?? "kept";
    },
  };
}

test("an entry is the body of a print line: its label is the kind, and the seq goes up from the clock", async () => {
  const { sent, send } = scripted([]);
  const keeper = new ConversationKeeper({ instanceId: "r/root/coder", send, now: () => 5 });
  keeper.slot = "root/coder";
  printLines({ write: () => {}, keep: (body) => keeper.add(body) }, "coder", "r/root/coder", [
    "[prompt] go\nnow",
    "[publish answer] receipt",
  ]);
  keeper.add("no label");
  await keeper.flush();
  assert.deepEqual(
    sent.flatMap((s) => s.entries.map((e) => [e.seq, e.kind, e.text])),
    [
      [5000, "prompt", "go\nnow"],
      [5001, "publish answer", "receipt"],
      [5002, "line", "no label"],
    ],
    "a body that spans lines is one entry",
  );
});

test("a batch that fails is sent again with the same entries, later, and then it is taken", async () => {
  const { sent, send } = scripted(["again", "kept"]);
  const keeper = new ConversationKeeper({ instanceId: "r/root/coder", send, intervalMs: 5, now: () => 7 });
  keeper.slot = "root/coder";
  keeper.add("[prompt] go");
  keeper.add("[text] done");
  await keeper.flush();
  // The failure scheduled the next try; wait for it.
  for (let i = 0; i < 100 && keeper.pending > 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(keeper.pending, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.entries, sent[1]!.entries, "the same entries, the same seqs");
  assert.deepEqual(
    sent[1]!.entries.map((e) => [e.seq, e.kind, e.text]),
    [
      [7000, "prompt", "go"],
      [7001, "text", "done"],
    ],
  );
  assert.equal(sent[1]!.slot, "root/coder");
});

test("no send goes before the slot is known; a refused batch is said once and dropped", async () => {
  const lines: string[] = [];
  const { sent, send } = scripted(["refused"]);
  const keeper = new ConversationKeeper({ instanceId: "r/root/coder", send, intervalMs: 1, log: (l) => lines.push(l) });
  keeper.add("[prompt] go");
  await keeper.flush();
  assert.equal(sent.length, 0, "a slot is stated on every send (ADR-0076)");
  keeper.slot = "root/coder";
  await keeper.flush();
  assert.equal(sent.length, 1);
  assert.equal(keeper.pending, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /refused the kept conversation of r\/root\/coder/);
});

test("written locally first: a restart sends what the Orchestrator did not take, and the seq goes on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-keep-"));
  try {
    const first = scripted(["kept", "again"]);
    const keeper = new ConversationKeeper({
      instanceId: "r/root/coder",
      dir,
      send: first.send,
      intervalMs: 60_000,
      now: () => 1,
    });
    keeper.slot = "root/coder";
    keeper.add("[prompt] go");
    await keeper.flush();
    keeper.add("[text] half");
    await keeper.flush();
    assert.equal(keeper.pending, 1, "the second batch failed and waits");
    assert.equal(
      readFileSync(join(dir, "record", "entries.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      2,
    );

    // A new process over the same folder: the slot and the last seq taken are on disk.
    const second = scripted([]);
    const rebuilt = new ConversationKeeper({ instanceId: "r/root/coder", dir, send: second.send, intervalMs: 5 });
    assert.equal(rebuilt.slot, "root/coder");
    for (let i = 0; i < 100 && rebuilt.pending > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      second.sent.flatMap((s) => s.entries.map((e) => [e.seq, e.text])),
      [[1001, "half"]],
    );
    rebuilt.add("[text] more");
    await rebuilt.flush();
    assert.deepEqual(
      second.sent.at(-1)!.entries.map((e) => e.seq),
      [1002],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the send over the control socket states the Stand-in and the slot, and reads the answer", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const answers = [
    new Response("{}", { status: 200 }),
    new Response("{}", { status: 409 }),
    new Response("{}", { status: 200, headers: { "x-jr2-custodian": "unreachable" } }),
    new Response("{}", { status: 403 }),
  ];
  const send = keepSendOver({
    url: "http://jr2-custodian/",
    token: "stand-in",
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return answers.shift()!;
    }) as typeof fetch,
  });
  const entries: KeptEntry[] = [{ id: "a", seq: 0, at: "t", kind: "text", text: "x" }];
  const signal = new AbortController().signal;
  assert.equal(await send("r/root/coder", "root/coder", entries, signal), "kept");
  assert.equal(await send("r/root/coder", "root/coder", entries, signal), "again");
  assert.equal(await send("r/root/coder", "root/coder", entries, signal), "again");
  assert.equal(await send("r/root/coder", "root/coder", entries, signal), "refused");
  assert.equal(seen[0]!.url, "http://jr2-custodian/agents/r%2Froot%2Fcoder/conversation");
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer stand-in");
  assert.equal(headers["x-jr2-slot"], "root/coder");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { entries });
  const failing = keepSendOver({
    url: "http://jr2-custodian",
    token: "t",
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(await failing("r/root/coder", "root/coder", entries, signal), "again");
});

test("a Turn never waits on the sender: a send that never answers, and the Turn still settles", async () => {
  let sends = 0;
  const keeper = new ConversationKeeper({
    instanceId: "i",
    // A send that never answers.
    send: () => {
      sends++;
      return new Promise<KeepAnswer>(() => {});
    },
    intervalMs: 1,
  });
  const adapter: EngineAdapter = {
    loop: "harness",
    open: (seat, first) => openEnginePart(seat, "fake", first),
    make: (): Engine => {
      const listeners: EngineListener[] = [];
      const emit = async (event: Parameters<EngineListener>[0]) => {
        for (const listener of listeners) await listener(event, new AbortController().signal);
      };
      return {
        async run(run) {
          await emit({ type: "message_end", message: { role: "user", content: run.prompt, timestamp: 1 } });
          const answer: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: run.model.api,
            provider: run.model.provider,
            model: run.model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          };
          await emit({ type: "message_end", message: answer });
          await emit({ type: "step_boundary", message: answer, toolResults: [] });
        },
        steer: () => {},
        abort: () => {},
        subscribe(listener) {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      };
    },
  };
  const printed: string[] = [];
  const turn = runSubmissionFor({
    models: modelsFor(
      { provider: { id: "fake", api: "openai-completions", baseUrl: "http://unused.invalid", models: { m: {} } } },
      {},
    ),
    menu: {
      url: "http://custodian.invalid",
      token: "t",
      fetch: (async () =>
        new Response(JSON.stringify({ instanceId: "i", runId: "r", menu: [], allowed: [] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    },
    children: testChildren({ tmp: tmpdir() }),
    agentName: "coder",
    instanceId: "i",
    appendMessage: () => {},
    printerOut: { write: (chunk: string) => void printed.push(chunk) },
    engineAdapter: adapter,
    keep: keeper,
  });
  const settled = await Promise.race([
    turn(
      { message: "go", cwd: "/w", slot: "root/coder", definition: { model: "fake/m", instructions: "be brief" } },
      new AbortController().signal,
    ).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("blocked"), 2_000)),
  ]);
  assert.equal(settled, "settled");
  assert.ok(sends >= 1, "a send started, and never answered");
  assert.equal(keeper.slot, "root/coder", "the Submission's slot");
  assert.equal(keeper.pending, 2, "the prompt and the model's text wait for a send");
  assert.match(printed.join(""), /\[coder\] \[i\] \[text\] done/, "the print is unchanged");
});

test("a closed keeper sends every batch that is left, and stops only after a few failed tries", async () => {
  const { sent, send } = scripted([]);
  const keeper = new ConversationKeeper({ instanceId: "i", send, intervalMs: 60_000 });
  keeper.slot = "root/coder";
  // About 2.5 MiB: five batches, more than the three tries a closed keeper had for all of them.
  for (let n = 0; n < 40; n++) keeper.add(`[text] ${"x".repeat(64 * 1024)}`);
  keeper.close();
  for (let i = 0; i < 200 && keeper.pending > 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(keeper.pending, 0);
  assert.ok(sent.length >= 5, `${sent.length} batches`);
  assert.ok(keeper.done);

  const failing = scripted(["again", "again", "again", "again", "again"]);
  const stuck = new ConversationKeeper({ instanceId: "j", send: failing.send, intervalMs: 1, maxBackoffMs: 1 });
  stuck.slot = "root/coder";
  stuck.add("[text] lost");
  stuck.close();
  for (let i = 0; i < 200 && !stuck.done; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(stuck.done, "it stops");
  assert.equal(failing.sent.length, 3, "three failed tries after the close");
});

test("an entry larger than a batch is cut in its middle, so no body is too large to take", async () => {
  const { sent, send } = scripted([]);
  const keeper = new ConversationKeeper({ instanceId: "i", send });
  keeper.slot = "root/coder";
  keeper.add(`[text] ${"a".repeat(100)}${"\u0001".repeat(1024 * 1024)}${"z".repeat(100)}`);
  await keeper.flush();
  const [entry] = sent[0]!.entries;
  assert.match(entry!.text, /^a{100}/);
  assert.match(entry!.text, /z{100}$/);
  assert.match(entry!.text, /… \[\d+ characters cut\] …/);
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) < 4 * 1024 * 1024);
});

test("a drain sends the last batches, also one in backoff, and its wait is bounded", async () => {
  // The first try fails, and the keeper's own retry would wait a minute.
  const answers: KeepAnswer[] = ["again"];
  const sent: KeptEntry[][] = [];
  const keeper = new ConversationKeeper({
    instanceId: "i",
    send: async (_iid, _slot, entries) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push([...entries]);
      return answers.shift() ?? "kept";
    },
    intervalMs: 60_000,
    maxBackoffMs: 60_000,
  });
  keeper.slot = "root/coder";
  keeper.add("[text] the end of the Turn");
  keeper.kick();
  await keeper.flush();
  assert.equal(keeper.pending, 1, "in backoff");
  await sendLastBatches([keeper], 2_000);
  assert.equal(keeper.pending, 0, "sent before the drain returns");
  assert.equal(sent.length, 2);

  const never = new ConversationKeeper({ instanceId: "j", send: () => new Promise<KeepAnswer>(() => {}) });
  never.slot = "root/coder";
  never.add("[text] never");
  const started = Date.now();
  await sendLastBatches([never], 50);
  assert.ok(Date.now() - started < 1_000, "the wait is bounded");
});

test("after the Orchestrator cuts the conversation, the keeper sends nothing more", async () => {
  const { sent, send } = scripted(["cut"]);
  const keeper = new ConversationKeeper({ instanceId: "r/root/coder", send, now: () => 3 });
  keeper.slot = "root/coder";
  keeper.add("[prompt] go");
  await keeper.flush();
  keeper.add("[text] more");
  await keeper.flush();
  assert.equal(sent.length, 1, "one send, the one the cut answered");
  assert.equal(keeper.pending, 0);
});
