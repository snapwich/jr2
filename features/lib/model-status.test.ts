import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bodyIn,
  ended,
  newKill,
  MEMORY_KILL_NOTICE,
  nextTurnNoticed,
  noticedAsk,
  stillStarting,
} from "./model-status.ts";

test("a workspace() body's state is read off the children `jr2 status` reports, never the run's own value", () => {
  // push-follow's body, back in `coding` after a `revise`: the run's own value is the wrapper's.
  const status = {
    status: "active",
    value: { running: "body" },
    children: [
      {
        id: "body",
        value: { work: "coding" },
        children: [{ id: "coder", value: "running", children: [] }],
      },
    ],
  };
  assert.equal(/"coding"/.test(JSON.stringify(status.value)), false, "the wrapper's value holds no body state");
  assert.equal(bodyIn(status, "coding"), true);
  assert.equal(bodyIn(status, "reviewing"), false);
  assert.equal(bodyIn({ children: [] }, "coding"), false);
  assert.equal(bodyIn({}, "coding"), false, "a status with no children");
});

test("noticed's setup void is a live run whose body never left `starting`; a settled run is never one", () => {
  const at = (status: string, value: unknown) => ({
    status,
    children: [{ id: "body", value, children: [{ id: "coder", value: "running", children: [] }] }],
  });
  assert.equal(stillStarting(at("active", "starting")), true, "the first Turn did not pick `started`");
  // A body that went starting -> faulted (agent.fault) or -> lost (workspace.lost) settled the run.
  assert.equal(stillStarting(at("done", "faulted")), false, "a fault is no void");
  assert.equal(stillStarting(at("done", "lost")), false, "a lost Workspace is no void");
  assert.equal(stillStarting({ status: "done", children: [] }), false, "a settled run holds no body");
  assert.equal(stillStarting(at("error", "starting")), false, "an errored run is settled");
  assert.equal(stillStarting(at("active", "asking")), false, "the first Turn picked `started`");
});

test("a trial's note prints a faulted, lost or errored run's final output, and nothing more for the others", () => {
  const faulted = { status: "done", value: "faulted", context: { output: { outcome: "faulted", reason: "r" } } };
  assert.equal(ended(faulted), 'done/faulted {"outcome":"faulted","reason":"r"}', "a root Machine's fault");
  const lost = { status: "done", value: "done", context: { output: { outcome: "lost", reason: "gone" } } };
  assert.equal(ended(lost, lost.context.output.outcome), 'done/lost {"outcome":"lost","reason":"gone"}', "a body");
  const error = { status: "error", value: "drafting", context: {} };
  assert.equal(ended(error), 'error/drafting "drafting"', "an errored run with no output prints its value");
  const errored = { ...error, fault: 'invoked gate "x" is not in the manifest' };
  assert.equal(
    ended(errored),
    'error/drafting "drafting" fault: invoked gate "x" is not in the manifest',
    "an errored run prints its fault: the reason",
  );
  const submitted = { status: "done", value: "submitted", context: { output: { outcome: "submitted" } } };
  assert.equal(ended(submitted), "done/submitted", "a finished run prints as before");
  const other = { status: "done", value: "shipped", context: { output: { outcome: "shipped" } } };
  assert.equal(ended(other, other.context.output.outcome), "done/shipped", "the other task final prints as before");
  const live = { status: "active", value: { notes: "reviewing" }, context: {} };
  assert.equal(ended(live), 'active/{"notes":"reviewing"}', "a run still live at its deadline prints its state");
});

// The rule the failure list depends on (ADR-0066): a trial that did not finish says how its run
// ended. Read off the drivers' source, so a new note that leaves it out fails here, not in a tier
// run whose namespace is gone. A void is no exception: one kept past the bound of replacements is
// in the list. A trial counted finished is in no such list; a driver that threw names no run.
test("every note of a trial that did not finish says how its run ended", () => {
  const lines = readFileSync(new URL("../steps/model.steps.ts", import.meta.url), "utf8").split("\n");
  const missing: string[] = [];
  lines.forEach((line, i) => {
    if (!/\bnote: [`"]/.test(line)) return;
    const around = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    // A void is listed too, once it is kept past the bound of replacements, so it says how its run
    // ended as every other trial does. A finished trial's note is never in the list.
    if (/finished: true/.test(around) || /threw: /.test(line)) return;
    if (/\bended\(/.test(line) || /note: seen\b/.test(line)) return;
    missing.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(missing, [], "these notes do not say how the run ended");
});

test("noticed's second-Turn prompt is read with the workflow's own port and words", () => {
  // The workflow reads the endpoint profile at load, which only a @model run writes, so its source
  // is read here, as the Briefing's is below: a changed prompt fails here, not as a void in every
  // trial of a tier run.
  const source = readFileSync(new URL("../model-instance/workflows/noticed.ts", import.meta.url), "utf8");
  const port = Number(/export const SERVER_PORT = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(port), "the workflow exports its port");
  assert.equal(noticedAsk(port), `Is the server you started on port ${port} still answering?`);
  assert.ok(
    source.includes("prompt: `Is the server you started on port ${SERVER_PORT} still answering?"),
    "the second Turn's prompt opens with noticedAsk's words",
  );
});

test("noticed's second Turn was told of the kill only when its prompt carries the kill's notice", () => {
  const ask = noticedAsk(8765);
  const first = { role: "user", text: "Start a small HTTP server on port 8765 in the background." };
  const said = { role: "assistant", text: "Started." };
  const notice = `Notice: the Sandbox's processes were killed at its memory limit (peak 1.9Gi of 2Gi) during \`coder\`'s Turn; /dev/shm was cleared.`;
  assert.equal(
    nextTurnNoticed([first, said, { role: "user", text: `${ask} Call \`report\`.\n\n${notice}` }], ask),
    true,
    "the notice in the Turn part",
  );
  assert.equal(
    nextTurnNoticed([first, said, { role: "user", text: `${ask} Call \`report\`.` }], ask),
    false,
    "no notice: a defect in what jr2 shows the model",
  );
  assert.equal(nextTurnNoticed([first, said], ask), undefined, "the second Turn has not started");
  assert.equal(
    nextTurnNoticed([{ role: "assistant", text: `${ask} ${notice}` }], ask),
    undefined,
    "only a user message is a prompt",
  );
  // The words are the Briefing's (packages/harness/src/briefing.ts `noticeText`): a black-box tier
  // cannot import them, so this pins the copy against the source.
  const briefing = readFileSync(new URL("../../packages/harness/src/briefing.ts", import.meta.url), "utf8");
  assert.ok(briefing.includes(MEMORY_KILL_NOTICE), "the Briefing still writes the notice's words");
});

test("noticed's kill is a guard kill that was not on the pod's list before the hog ran", () => {
  assert.equal(newKill([], ["k1"]), true, "the first kill");
  assert.equal(newKill(["k1"], ["k1", "k2"]), true, "a kill after an older one");
  assert.equal(newKill(["k1"], ["k1"]), false, "no new kill");
  assert.equal(newKill([], []), false, "no kill at all");
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `k${from + i}`);
  assert.equal(newKill(ids(1, 16), ids(2, 17)), true, "a list that keeps the newest kills dropped k1 and took k17");
  assert.equal(newKill(ids(1, 16), ids(1, 16)), false, "a full list with no new kill");
});
