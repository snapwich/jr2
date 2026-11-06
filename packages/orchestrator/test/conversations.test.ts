// The kept conversations (ADR-0023, ADR-0065): the store keeps each entry once, cuts a conversation
// at its cap with a marker, goes with its run, and the space guard deletes the conversations of
// ended runs, the oldest first. The routes: only the ledger's pod and slot write; `read` reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import {
  ConversationStore,
  CUT_KIND,
  deleteOrphanConversations,
  guardSpace,
  quantityBytes,
  type SentEntry,
} from "../src/conversations.ts";
import { createApp } from "../src/http.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import {
  callerTokenDigest,
  controlToken,
  createAuthenticator,
  mintCallerToken,
  mintInstanceToken,
} from "../src/tokens.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const entry = (seq: number, text = `line ${seq}`): SentEntry => ({
  id: `id-${seq}`,
  seq,
  at: "2026-11-05T00:00:00.000Z",
  kind: "text",
  text,
});

function memoryStore(capBytes?: number): ConversationStore {
  const store = new ConversationStore(":memory:", capBytes === undefined ? {} : { capBytes });
  store.init();
  return store;
}

test("an entry whose seq meets another entry's is kept after the last, because its id is new (ADR-0023)", () => {
  // A new record on a node whose clock is behind: its seqs fall inside the old range.
  const store = memoryStore();
  store.append("r1", "r1/root/coder", "coder", [entry(5), entry(6)]);
  const late: SentEntry = { ...entry(5, "a new record"), id: "new-5" };
  assert.deepEqual(store.append("r1", "r1/root/coder", "coder", [late]), { kept: 1, cut: false });
  assert.deepEqual(
    store.entries("r1/root/coder", -1, 100).map((e) => [e.seq, e.id, e.text]),
    [
      [5, "id-5", "line 5"],
      [6, "id-6", "line 6"],
      [7, "new-5", "a new record"],
    ],
  );
  store.close();
});

test("an entry is kept once by its id: a batch sent again adds nothing", () => {
  const store = memoryStore();
  assert.deepEqual(store.append("r1", "r1/root/coder", "coder", [entry(0), entry(1)]), { kept: 2, cut: false });
  assert.deepEqual(store.append("r1", "r1/root/coder", "coder", [entry(1), entry(0), entry(2)]), {
    kept: 1,
    cut: false,
  });
  const kept = store.entries("r1/root/coder", -1, 100);
  assert.deepEqual(
    kept.map((e) => [e.seq, e.agent, e.text]),
    [
      [0, "coder", "line 0"],
      [1, "coder", "line 1"],
      [2, "coder", "line 2"],
    ],
  );
  assert.deepEqual(
    store.entries("r1/root/coder", 0, 1).map((e) => e.seq),
    [1],
    "after and limit page the entries",
  );
  const [listed] = store.list("r1");
  assert.equal(listed?.instanceId, "r1/root/coder");
  assert.equal(listed?.agent, "coder");
  assert.equal(listed?.cut, false);
  assert.ok(listed!.bytes > 0);
  store.close();
});

test("the cap keeps the start of a conversation and one marker in place of the rest", () => {
  const one = Buffer.byteLength(
    JSON.stringify({
      id: "id-0",
      seq: 0,
      at: "2026-11-05T00:00:00.000Z",
      agent: "coder",
      kind: "text",
      text: "line 0",
    }),
  );
  const store = memoryStore(one * 2 + 5);
  const first = store.append("r1", "r1/root/coder", "coder", [entry(0), entry(1), entry(2), entry(3)]);
  assert.deepEqual(first, { kept: 2, cut: true });
  const kept = store.entries("r1/root/coder", -1, 100);
  assert.deepEqual(
    kept.map((e) => [e.seq, e.kind]),
    [
      [0, "text"],
      [1, "text"],
      [2, CUT_KIND],
    ],
  );
  assert.match(kept[2]!.text, /keeps no more of this conversation: it is at its cap/);
  // Every later entry is dropped, and the list says the conversation is cut.
  assert.deepEqual(store.append("r1", "r1/root/coder", "coder", [entry(4)]), { kept: 0, cut: true });
  assert.equal(store.entries("r1/root/coder", -1, 100).length, 3);
  assert.equal(store.list("r1")[0]?.cut, true);
  store.close();
});

test("a full volume cuts the next entry of an open conversation with a marker that says so", () => {
  const store = memoryStore();
  store.append("r1", "r1/root/coder", "coder", [entry(0)]);
  store.full = true;
  assert.deepEqual(store.append("r1", "r1/root/coder", "coder", [entry(1)]), { kept: 0, cut: true });
  assert.match(store.entries("r1/root/coder", 0, 10)[0]!.text, /state volume is full/);
  store.close();
});

test("the file is incremental-vacuum, and the retention sweep deletes a run's conversations with its row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-conv-"));
  try {
    const path = join(dir, "conversations.db");
    const store = new ConversationStore(path);
    store.init();
    const big = "x".repeat(64 * 1024);
    store.append(
      "old",
      "old/root/coder",
      "coder",
      Array.from({ length: 40 }, (_, i) => entry(i, big)),
    );
    store.append("new", "new/root/coder", "coder", [entry(0)]);
    // The run rows: the old run ended long ago, the new one is live.
    const runs = new SqliteSnapshotStore(join(dir, "state.db"));
    await runs.init();
    await runs.save("old", {}, "done");
    await runs.save("new", {});
    const size = () => statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
    const before = size();
    const swept = await runs.sweep(new Date(Date.now() + 60_000));
    assert.deepEqual(swept, ["old"]);
    store.deleteRuns(swept);
    assert.deepEqual(store.list("old"), []);
    assert.equal(store.entries("old/root/coder", -1, 10).length, 0);
    assert.equal(store.list("new").length, 1, "a run that is kept keeps its conversations");
    assert.ok(size() < before / 2, `the incremental vacuum gives the pages back: ${before} → ${size()}`);
    store.close();
    await runs.close();
    const raw = new DatabaseSync(path);
    assert.equal((raw.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum, 2, "INCREMENTAL");
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sweep deletes the kept conversations whose run has no row, and keeps the others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-conv-"));
  try {
    const store = memoryStore();
    store.append("gone", "gone/root/coder", "coder", [entry(0)]);
    store.append("kept", "kept/root/coder", "coder", [entry(0)]);
    store.append("kept-2", "kept-2/root/coder", "coder", [entry(0)]);
    const runs = new SqliteSnapshotStore(join(dir, "state.db"));
    await runs.init();
    // "gone" has no row (the sweep deleted it and the process stopped before `deleteRuns`); a
    // longer id that shares its prefix does not keep it.
    await runs.save("gone-later", {});
    await runs.save("kept", {});
    await runs.save("kept-2", {}, "done");
    assert.deepEqual(await deleteOrphanConversations(store, runs), ["gone"]);
    assert.deepEqual(store.runIds(), ["kept", "kept-2"]);
    assert.equal(store.entries("gone/root/coder", -1, 10).length, 0);
    await runs.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the space guard deletes the conversations of ended runs, the oldest first, and never a live run's", async () => {
  const store = memoryStore();
  for (const run of ["a", "b", "c", "d"]) store.append(run, `${run}/root/coder`, "coder", [entry(0, "x".repeat(100))]);
  // 10 units on a volume of 10, each run's conversation 2 units: the guard must go below 8.
  let used = 10;
  const swept: string[] = [];
  const result = await guardSpace({
    conversations: store,
    used: () => used,
    capacity: () => 10,
    isLive: async (runId) => runId === "a",
    onSwept: (runId) => {
      swept.push(runId);
      used -= 2;
    },
  });
  assert.deepEqual(result, ["b", "c"], "a is live and is passed; b and c are the oldest ended runs");
  assert.deepEqual(swept, ["b", "c"]);
  assert.equal(store.full, false);
  assert.deepEqual(store.list("b"), [
    { agent: "coder", instanceId: "b/root/coder", bytes: 0, cut: false, swept: "no space" },
  ]);
  assert.equal(store.entries("b/root/coder", -1, 10).length, 0);
  assert.deepEqual(store.sweptRuns(["a", "b", "c", "d"]), new Set(["b", "c"]));
  // A swept conversation keeps nothing more.
  assert.deepEqual(store.append("b", "b/root/coder", "coder", [entry(1)]), { kept: 0, cut: false });

  // With only a live run's conversation left and the volume past 95%, no entry is kept.
  used = 9.9;
  const none = await guardSpace({
    conversations: store,
    used: () => used,
    capacity: () => 10,
    isLive: async (runId) => runId === "a",
  });
  assert.deepEqual(none, ["d"]);
  assert.equal(store.full, true);
  used = 5;
  await guardSpace({ conversations: store, used: () => used, capacity: () => 10, isLive: async () => true });
  assert.equal(store.full, false, "below the bound, entries are kept again");
  store.close();
});

test("quantityBytes reads a storage quantity", () => {
  assert.equal(quantityBytes("5Gi"), 5 * 2 ** 30);
  assert.equal(quantityBytes("500Mi"), 500 * 2 ** 20);
  assert.equal(quantityBytes("1G"), 1e9);
  assert.equal(quantityBytes("five"), undefined);
});

// ---- The routes ----------------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 7);
const INSTANCE = mintInstanceToken();
const READER = mintCallerToken();
const OTHER = mintCallerToken();
const finish = defineEvent({ name: "finish", input: z.object({}) });

async function rig(opts: { secret?: true } = {}) {
  const client = new MockFlueClient();
  const secretClient = new MockFlueClient();
  const machineWith = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({
      types: {} as { context: Record<string, never> },
      events: [finish],
      actors: { coder },
    }).createMachine({
      on: { "agent.fault": {} },
      id: "wf",
      context: {},
      initial: "work",
      states: {
        work: {
          invoke: { src: "coder", input: { prompt: "go", endpoint: "http://harness.invalid", sandbox: "ws-1" } },
          on: { finish: "#wf.done" },
        },
        done: { type: "final" },
      },
    });
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register({
    name: "kept",
    machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
    provide: () => ({ actors: { coder: agentActorWith(() => client, coderDefinition) } }),
  });
  if (opts.secret) {
    host.register({
      name: "secret",
      machine: machineWith(agentActorWith(() => new MockFlueClient(), coderDefinition)),
      provide: () => ({ actors: { coder: agentActorWith(() => secretClient, coderDefinition) } }),
    });
  }
  const conversations = memoryStore();
  const app = createApp(
    host,
    createAuthenticator({
      instanceToken: INSTANCE,
      signingKey: KEY,
      namedTokens: () => [
        { name: "reader", digest: callerTokenDigest(READER), may: { read: ["kept"] } },
        { name: "other", digest: callerTokenDigest(OTHER), may: { read: ["elsewhere"] } },
      ],
    }),
    { conversations, followGraceMs: 30, pingMs: 1_000 },
  );
  const { runId } = await host.start("kept");
  await waitFor(() => client.admits.length > 0);
  const iid = client.admits[0]!.instanceId;
  return { host, app, runId, iid, conversations, store, secretClient };
}

/** Wait for the ledger row of an admission. */
async function placed(host: RunHost, iid: string): Promise<void> {
  for (let i = 0; i < 100 && (await host.conversationPlace(iid))?.agent === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const batch = (entries: SentEntry[], token: string, slot = "root/coder"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-jr2-slot": slot },
  body: JSON.stringify({ entries }),
});
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

test("only the control token of the ledger's pod, for the ledger's slot, writes a conversation", async () => {
  const { app, iid, runId, conversations, host } = await rig();
  const path = `/agents/${encodeURIComponent(iid)}/conversation`;
  // Wait for the ledger row of the admission.
  for (let i = 0; i < 100 && (await host.conversationPlace(iid))?.agent === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const place = await host.conversationPlace(iid);
  assert.deepEqual(place, { runId, live: true, agent: "coder", sandbox: "ws-1", slot: "root/coder" });

  const ok = await app.request(path, batch([entry(0), entry(1)], controlToken(KEY, "ws-1")));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { kept: 2, cut: false });
  const again = await app.request(path, batch([entry(1)], controlToken(KEY, "ws-1")));
  assert.deepEqual(await again.json(), { kept: 0, cut: false }, "a resend adds nothing");

  assert.equal((await app.request(path, batch([entry(2)], controlToken(KEY, "ws-2")))).status, 403, "another pod");
  assert.equal(
    (await app.request(path, batch([entry(2)], controlToken(KEY, "ws-1"), "root/reviewer"))).status,
    403,
    "another slot",
  );
  assert.equal(
    (await app.request(path, batch([entry(2)], INSTANCE))).status,
    403,
    "the Instance token cannot write an Agent's kept conversation",
  );
  assert.equal((await app.request(path, batch([entry(2)], READER))).status, 403, "a Caller cannot");
  assert.equal(
    (await app.request(path, { ...batch([], controlToken(KEY, "ws-1")), body: '{"entries":[{"seq":"x"}]}' })).status,
    400,
  );
  // A conversation the live run's ledger does not name yet: send again.
  const early = `/agents/${encodeURIComponent(`${runId}/root/nobody`)}/conversation`;
  assert.equal((await app.request(early, batch([entry(0)], controlToken(KEY, "ws-1")))).status, 409);
  const unknown = `/agents/${encodeURIComponent("no-such-run/root/coder")}/conversation`;
  assert.equal((await app.request(unknown, batch([entry(0)], controlToken(KEY, "ws-1")))).status, 404);
  assert.equal(conversations.entries(iid, -1, 10).length, 2);
});

test("`read` lists and reads a run's conversations; another Workflow's reader is refused", async () => {
  const { app, iid, runId, host } = await rig();
  for (let i = 0; i < 100 && (await host.conversationPlace(iid))?.agent === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await app.request(
    `/agents/${encodeURIComponent(iid)}/conversation`,
    batch([entry(0), entry(1, "second")], controlToken(KEY, "ws-1")),
  );
  const list = await app.request(`/runs/${runId}/conversations`, bearer(READER));
  assert.equal(list.status, 200);
  const [row] = (await list.json()) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(row!), ["agent", "slot", "instanceId", "open", "bytes", "cut"]);
  assert.equal(row!.agent, "coder");
  assert.equal(row!.instanceId, iid);
  assert.equal(row!.open, true, "its Turn is registered");

  const read = await app.request(`/runs/${runId}/conversations/${encodeURIComponent(iid)}?after=0`, bearer(READER));
  assert.deepEqual(
    ((await read.json()) as Array<{ seq: number; text: string }>).map((e) => [e.seq, e.text]),
    [[1, "second"]],
  );
  assert.equal((await app.request(`/runs/${runId}/conversations`, bearer(OTHER))).status, 403);
  assert.equal(
    (await app.request(`/runs/${runId}/conversations/${encodeURIComponent(iid)}`, bearer(OTHER))).status,
    403,
  );
  assert.equal(
    (await app.request(`/runs/${runId}/conversations/${encodeURIComponent(iid)}?after=x`, bearer(READER))).status,
    400,
  );
  assert.equal((await app.request(`/runs/${runId}/conversations/nope`, bearer(READER))).status, 404);
  assert.equal((await app.request(`/runs/no-such/conversations`, bearer(READER))).status, 404);
});

test("the events route follows a conversation and ends when it is not open", async () => {
  const { app, iid, runId, host } = await rig();
  for (let i = 0; i < 100 && (await host.conversationPlace(iid))?.agent === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const write = (entries: SentEntry[]) =>
    app.request(`/agents/${encodeURIComponent(iid)}/conversation`, batch(entries, controlToken(KEY, "ws-1")));
  await write([entry(0)]);
  const res = await app.request(`/runs/${runId}/conversations/${encodeURIComponent(iid)}/events`, bearer(READER));
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  const readUntil = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  await readUntil('"seq":0');
  await write([entry(1)]);
  await readUntil('"seq":1');
  // The run ends: the conversation is not open, and the feed ends after its grace.
  await host.cancel(runId, { keep: false });
  await readUntil("event: end");
  assert.match(text, /event: end\ndata: \{"cut":false\}/);
});

test("a run whose conversations the guard swept says so in its status and in the list", async () => {
  const { app, iid, runId, conversations, host } = await rig();
  for (let i = 0; i < 100 && (await host.conversationPlace(iid))?.agent === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await app.request(`/agents/${encodeURIComponent(iid)}/conversation`, batch([entry(0)], controlToken(KEY, "ws-1")));
  await host.cancel(runId, { keep: false });
  conversations.sweepForSpace(runId);
  const status = (await (await app.request(`/runs/${runId}`, bearer(READER))).json()) as { swept?: string };
  assert.equal(status.swept, "conversation swept: no space");
  const page = (await (await app.request(`/runs?status=all`, bearer(READER))).json()) as {
    runs: Array<{ runId: string; swept?: string }>;
  };
  assert.equal(page.runs.find((r) => r.runId === runId)?.swept, "conversation swept: no space");
  const [row] = (await (await app.request(`/runs/${runId}/conversations`, bearer(READER))).json()) as Array<
    Record<string, unknown>
  >;
  assert.equal(row!.swept, "no space");
  assert.equal(row!.open, false);
});

test("a batch that comes after the run ended is placed by the stored run and kept", async () => {
  const { app, iid, runId, conversations, host } = await rig();
  await placed(host, iid);
  await host.cancel(runId, { keep: false });
  await waitFor(() => host.status(runId) === undefined);
  assert.deepEqual(await host.conversationPlace(iid), {
    runId,
    live: false,
    agent: "coder",
    sandbox: "ws-1",
    slot: "root/coder",
  });
  const path = `/agents/${encodeURIComponent(iid)}/conversation`;
  const late = await app.request(path, batch([entry(0), entry(1)], controlToken(KEY, "ws-1")));
  assert.equal(late.status, 200);
  assert.deepEqual(await late.json(), { kept: 2, cut: false });
  assert.equal(conversations.entries(iid, -1, 10).length, 2);
  assert.equal((await app.request(path, batch([entry(2)], INSTANCE))).status, 403, "the Instance token still cannot");
  const [row] = (await (await app.request(`/runs/${runId}/conversations`, bearer(READER))).json()) as Array<
    Record<string, unknown>
  >;
  assert.equal(row!.open, false);
});

test("a reader of one Workflow cannot follow another Workflow's conversation through its own run", async () => {
  const { app, runId, host, secretClient } = await rig({ secret: true });
  const { runId: secretRun } = await host.start("secret");
  await waitFor(() => secretClient.admits.length > 0);
  const secretIid = secretClient.admits[0]!.instanceId;
  await placed(host, secretIid);
  const sent = await app.request(
    `/agents/${encodeURIComponent(secretIid)}/conversation`,
    batch([entry(0, "the secret")], controlToken(KEY, "ws-1")),
  );
  assert.equal(sent.status, 200);
  assert.equal(host.agentRun(secretIid), secretRun, "the secret Turn is registered");
  for (const tail of ["", "/events"]) {
    const res = await app.request(
      `/runs/${runId}/conversations/${encodeURIComponent(secretIid)}${tail}`,
      bearer(READER),
    );
    assert.equal(res.status, 404, `GET …${tail || "/:instanceId"}`);
    assert.doesNotMatch(await res.text(), /the secret/);
  }
  assert.equal(
    (await app.request(`/runs/${secretRun}/conversations/${encodeURIComponent(secretIid)}/events`, bearer(READER)))
      .status,
    403,
  );
});

test("a follow of an open conversation ends when the host closes, so the server can close", async () => {
  const { app, iid, runId, host } = await rig();
  await placed(host, iid);
  await app.request(`/agents/${encodeURIComponent(iid)}/conversation`, batch([entry(0)], controlToken(KEY, "ws-1")));
  const res = await app.request(`/runs/${runId}/conversations/${encodeURIComponent(iid)}/events`, bearer(READER));
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"seq":0')) text += decoder.decode((await reader.read()).value);
  await host.close();
  const ended = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value);
    }
  })();
  // Well inside the 1 s tick: the close itself ends the stream.
  const out = await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r("open"), 500))]);
  assert.notEqual(out, "open", "the stream ended");
  assert.match(out, /event: end/);
});

test("a late batch of a conversation that a reroll ended is placed by the row of its invocation", async () => {
  const { iid, runId, host } = await rig();
  await placed(host, iid);
  // A runaway reroll stamps the new conversation on the row of the invocation (ADR-0035).
  const agents = (
    host as unknown as { runs: Map<string, { agents: Record<string, { instanceId?: string }> }> }
  ).runs.get(runId)!.agents;
  agents[iid]!.instanceId = `${iid}-r2`;
  for (const late of [iid, `${iid}-r1`, `${iid}-r2`]) {
    assert.equal((await host.conversationPlace(late))?.agent, "coder", late);
  }
  for (const other of [`${iid}-rx`, `${iid}-r`, `${iid}/1`]) {
    assert.equal((await host.conversationPlace(other))?.agent, undefined, other);
  }
});
