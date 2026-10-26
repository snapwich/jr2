// What the @model tier keeps of every trial (ADR-0066), pinned without a cluster or a model: where a
// trial's evidence lands, the note's reading of what the model called, the conversation a trial's
// Harness history is asked for, the push remote's log command, and the follow that outlives a
// container restart and a pod's reap.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentsIn,
  containerRun,
  followAcross,
  historyIid,
  publishedCommits,
  pushRemoteLogScript,
  saidNote,
  segment,
  settledIn,
  streamPath,
  trialDir,
  cellDir,
  historyFile,
  unavailable,
} from "./model-evidence.ts";
import { follow } from "./model-said.ts";

test("a trial's evidence lands under model-trials/<model>/<cell>/<runId>, the cell's thinking a folder of its own", () => {
  assert.equal(
    trialDir("/r/.tmp/model-trials", "homelab--Qwen--Qwen3.6-35B-A3B", "obedience/off", "1a2b3c4d"),
    "/r/.tmp/model-trials/homelab--Qwen--Qwen3.6-35B-A3B/obedience/off/1a2b3c4d",
  );
});

test("a model id with a ':' or an '@' keeps its trials' evidence: the byte is spelled, never refused", () => {
  // Keeping evidence never fails a trial (ADR-0066), and the tier runs any endpoint profile.
  assert.equal(
    trialDir("/r", "ollama--qwen3:30b", "obedience/off", "1a2b"),
    "/r/ollama--qwen3%3A30b/obedience/off/1a2b",
  );
  assert.equal(
    trialDir("/r", "bedrock--us.anthropic.claude-sonnet-4-5-20250929-v1:0", "obedience/off", "r1"),
    "/r/bedrock--us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/obedience/off/r1",
  );
  assert.equal(trialDir("/r", "x--Llama-3.1-8B@q4", "a/b", "r1"), "/r/x--Llama-3.1-8B%40q4/a/b/r1");
  assert.equal(cellDir("/r", "ollama--qwen3:30b", "obedience/off"), "/r/ollama--qwen3%3A30b/obedience/off");
});

test("a path segment that could leave the folder is spelled so it stays in it", () => {
  for (const [model, cell, runId] of [
    ["..", "obedience/off", "r1"],
    ["m", "../off", "r1"],
    ["m", "obedience/off", "../../etc"],
    ["m", "obedience/off", "a/b"],
    ["m", "obedience/off", ""],
    ["m", "obedience/.", "r1"],
  ] as const) {
    const dir = trialDir("/r", model, cell, runId);
    assert.ok(dir.startsWith("/r/"), dir);
    assert.equal(dir.split("/").length, 6, `${model} ${cell} ${runId}: ${dir}`);
    assert.ok(
      !dir
        .split("/")
        .slice(1)
        .some((s) => s === "." || s === ".." || s === ""),
      dir,
    );
  }
  assert.equal(segment(".."), "%2E.");
  assert.equal(segment("a/b"), "a%2Fb");
  assert.equal(segment(""), "%");
  assert.equal(segment("é"), "%C3%A9");
});

test("a conversation's stream page gives its settlements, with the failure text of one that failed", () => {
  const events = [
    { type: "text-delta", conversationId: "r/body/coder", delta: "hi" },
    { type: "submission-settled", conversationId: "r/body/coder", submissionId: "s1", outcome: "completed" },
    {
      type: "submission-settled",
      submissionId: "s2",
      outcome: "failed",
      error: { message: "provider returned 500: upstream timeout" },
      position: { batch: 9, index: 0 },
    },
  ];
  assert.deepEqual(settledIn(events), [
    { submissionId: "s1", outcome: "completed" },
    { submissionId: "s2", outcome: "failed", error: { message: "provider returned 500: upstream timeout" } },
  ]);
  assert.deepEqual(settledIn({ error: "no conversation" }), []);
});

test("the stream is read as the Orchestrator reads it: long-polled from an offset, the iid encoded", () => {
  assert.equal(
    streamPath("coder", "r1/body/coder", "12"),
    "/agents/coder/r1%2Fbody%2Fcoder?offset=12&view=updates&live=long-poll",
  );
});

test("harness-history keeps a settlement the stream carried after the last view read: the one just before the reap", () => {
  const views = new Map([
    ["r/body/coder", 'read at T1\nHTTP 200\n{"v":1,"settlements":[{"submissionId":"s1","outcome":"completed"}]}\n'],
  ]);
  const s2 = { submissionId: "s2", outcome: "failed", error: { message: "runaway: the FINAL failure text" } };
  const settled = new Map([["r/body/coder", [{ submissionId: "s1", outcome: "completed" }, s2]]]);
  const file = historyFile(views, settled, "never read");
  assert.match(file, /^--- r\/body\/coder ---\nread at T1\nHTTP 200\n/);
  assert.match(file, /settled on the stream, not in the view above:\n.*"s2".*the FINAL failure text/);
  assert.doesNotMatch(file.slice(file.indexOf("settled on the stream")), /"s1"/);
});

test("harness-history with no view read keeps what the stream carried, and says why when it holds nothing", () => {
  const settled = new Map([["r/body/coder", [{ submissionId: "s1", outcome: "failed", error: "boom" }]]]);
  const file = historyFile(new Map(), settled, "never read");
  assert.match(file, /^--- r\/body\/coder ---\n<unavailable: no history view was read>\nsettled on the stream/);
  assert.match(file, /"boom"/);
  assert.equal(historyFile(new Map(), new Map(), "never read"), unavailable("never read"));
  // A view that is not a 200 holds no settlement: each one the stream carried is kept after it.
  const notOk = new Map([["i", "read at T\nHTTP 404\n{}\n"]]);
  assert.match(historyFile(notOk, new Map([["i", [{ submissionId: "s1", outcome: "completed" }]]]), "x"), /"s1"/);
});

test("a probe that could not be taken writes why, in the dump's form", () => {
  assert.equal(unavailable("no Sandbox for the run was seen"), "<unavailable: no Sandbox for the run was seen>\n");
});

test("the note says what the model called, in the Menu-only notes' form, or why the conversation was not read", () => {
  const kept =
    "[advisor] [prompt] [t0-a] Go.\n[advisor] [bash] ls\n[advisor] [prompt] <jr2-turn>\n[advisor] [submit] {}";
  assert.equal(saidNote(kept, "t0-a", "no reason"), "said bash (restated) submit");
  assert.equal(saidNote("[advisor] [prompt] [t0-a] Go.", "t0-a", "no reason"), "said nothing");
  assert.equal(
    saidNote(
      "[coder] [prompt] [t0-a] Go.\n[coder] [bash] ls\n[run] [status] running\n[run] [emit] done\n[run] [status] done",
      "t0-a",
      "x",
    ),
    "said bash",
    "the run narrative echo is not what the model called",
  );
  assert.equal(
    saidNote("", "t0-a", "container harness is waiting to start"),
    "said <unread: container harness is waiting to start>",
  );
  assert.equal(
    saidNote(unavailable("no Sandbox for the run was seen"), "t0-a", "ignored"),
    "said <unread: no Sandbox for the run was seen>",
  );
});

test("the Agents of a kept conversation are the ones whose prompt printed, in order, once each", () => {
  const kept = [
    "2026-10-13T10:00:00Z [planner] [prompt] [t0-a] Plan.",
    "2026-10-13T10:00:01Z [planner] [plan] {}",
    "2026-10-13T10:00:02Z [coder] [prompt] Code.",
    "2026-10-13T10:00:03Z [planner] [prompt] again",
  ].join("\n");
  assert.deepEqual(agentsIn(kept), ["planner", "coder"]);
  assert.deepEqual(agentsIn("nothing printed"), []);
});

test("a claim Agent's conversation is its continued one: the workspace body's in a Sandbox, the root's on the Instance Harness", () => {
  assert.equal(historyIid("r1", true, "coder"), "r1/body/coder");
  assert.equal(historyIid("r1", false, "advisor"), "r1/root/advisor");
});

test("a push claim's published commits come off the Machine's final record, in push order, each once", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const record = {
    context: { output: { pushes: [{ outcome: "pushed", published: a }, { outcome: "diverged" }, { published: b }] } },
  };
  assert.deepEqual(publishedCommits(record), [a, b]);
  assert.deepEqual(publishedCommits({ context: { output: { pushes: [{ published: a }, { published: a }] } } }), [a]);
  assert.deepEqual(publishedCommits({ context: {} }), []);
  assert.deepEqual(publishedCommits(undefined), []);
  assert.deepEqual(publishedCommits({ context: { output: { pushes: [{ published: "HEAD; rm -rf /" }] } } }), []);

  // A failed trial carries its pushes in the Failure's detail (ADR-0073).
  const failed = { status: "failed", context: {}, output: { reason: "r", detail: { pushes: [{ published: b }] } } };
  assert.deepEqual(publishedCommits(failed), [b]);
  assert.deepEqual(publishedCommits({ status: "failed", context: {}, output: { reason: "r" } }), []);
});

test("the push remote's log from main to a published commit: read-only git in push.git, the commit checked", () => {
  const c = "c".repeat(40);
  assert.equal(
    pushRemoteLogScript(c),
    `git -c safe.directory='*' -C /srv/push.git log --format='%H %an <%ae> | %cn <%ce> | %s' main..${c}`,
  );
  assert.throws(() => pushRemoteLogScript("main; rm -rf /srv"), /a commit id/);
});

test("a container's run is its pod's uid and its restart count: a new one is a new log to follow", () => {
  const pod = (uid: string, restarts: number) => ({
    metadata: { uid },
    spec: { containers: [{ name: "harness" }, { name: "effector" }] },
    status: { containerStatuses: [{ name: "harness", restartCount: restarts }] },
  });
  assert.equal(containerRun(pod("u1", 0), "harness"), "u1/0");
  assert.equal(containerRun(pod("u1", 1), "harness"), "u1/1", "restarted in place");
  assert.equal(containerRun(pod("u2", 0), "harness"), "u2/0", "a pod deleted and made again");
  assert.equal(containerRun(pod("u1", 0), "effector"), "u1/0", "listed, no status yet");
  assert.equal(containerRun(pod("u1", 0), "sidecar"), undefined, "no such container");
  assert.equal(containerRun({}, "harness"), undefined, "the pod is gone");
});

test("followAcross keeps what each follow printed and follows again while the source says so", async () => {
  const lines = ["first container", "second container"];
  let opened = 0;
  const kept = followAcross(
    () => follow(process.execPath, ["-e", `console.log(${JSON.stringify(lines[opened++])})`]),
    async () => opened < lines.length,
    { pauseMs: 0 },
  );
  await kept.closed;
  assert.equal(opened, 2);
  assert.equal(kept.text, "first container\n--- followed again: the container restarted ---\nsecond container\n");
});

test("followAcross records why a follow printed nothing, and stops when asked", async () => {
  const kept = followAcross(
    () => follow(process.execPath, ["-e", "console.error('is waiting to start'); setTimeout(() => {}, 60_000)"]),
    async () => true,
    { pauseMs: 0 },
  );
  for (let i = 0; i < 100 && !kept.why; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(kept.why ?? "", /is waiting to start/);
  await kept.stop();
  await kept.closed;
  assert.equal(kept.text, "");
});
