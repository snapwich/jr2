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
  trialDir,
  unavailable,
} from "./model-evidence.ts";
import { follow } from "./model-said.ts";

test("a trial's evidence lands under model-trials/<model>/<cell>/<runId>, the cell's thinking a folder of its own", () => {
  assert.equal(
    trialDir("/r/.tmp/model-trials", "homelab--Qwen--Qwen3.6-35B-A3B", "obedience/off", "1a2b3c4d"),
    "/r/.tmp/model-trials/homelab--Qwen--Qwen3.6-35B-A3B/obedience/off/1a2b3c4d",
  );
});

test("a path segment that could leave the folder is refused, never written", () => {
  for (const [model, cell, runId] of [
    ["..", "obedience/off", "r1"],
    ["m", "../off", "r1"],
    ["m", "obedience/off", "../../etc"],
    ["m", "obedience/off", "a/b"],
    ["m", "obedience/off", ""],
  ] as const) {
    assert.throws(() => trialDir("/r", model, cell, runId), /not a plain path segment/, `${model} ${cell} ${runId}`);
  }
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
