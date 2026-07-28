// Unit tests for the real flue-backed AgentRunPort (ADR-0016/0024). The flue SDK client is FAKED
// (no Harness/cluster needed): the adapter depends only on `agents.send` + `agents.wait` +
// `agents.abort`, so a hand-driven fake exercises every mapping branch — fresh admit (admission =
// the durable handle), settle-as-wait, fault translation, abandon-by-signal, and remote abort.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FlueExecutionError } from "@flue/sdk";
import { flueAgentRunPort } from "../src/flue-client.ts";
import type { FlueAgentRunDep } from "../src/flue-client.ts";
import type { AgentAdmission, AgentRunInput } from "../src/actor.ts";

const admission: AgentAdmission = {
  streamUrl: "http://h/agents/coder/inst-1",
  offset: "off-admit",
  submissionId: "sub-1",
};

/** A fake flue SDK client: records sends, and settles/faults waits on command. */
function fakeFlue(
  behavior: { wait?: (adm: AgentAdmission, opts?: { signal?: AbortSignal }) => Promise<unknown> } = {},
) {
  const sent: Array<{ name: string; id: string; message: string; hasSignal: boolean }> = [];
  const waited: AgentAdmission[] = [];
  const aborted: Array<{ name: string; id: string }> = [];
  const dep = {
    sent,
    waited,
    aborted,
    agents: {
      async abort(name: string, id: string) {
        aborted.push({ name, id });
        return { aborted: true };
      },
      async send(name: string, id: string, options: { message: string; signal?: AbortSignal }) {
        sent.push({ name, id, message: options.message, hasSignal: !!options.signal });
        return admission;
      },
      async wait(adm: AgentAdmission, opts?: { signal?: AbortSignal }) {
        waited.push(adm);
        return behavior.wait ? await behavior.wait(adm, opts) : undefined;
      },
    } as unknown as FlueAgentRunDep["agents"],
  };
  return dep as typeof dep & FlueAgentRunDep;
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-1",
  endpoint: "http://harness.invalid", // the fake never dials; the real client is built from this
  prompt: "do the thing",
  tools: [],
};

test("admit sends the prompt and resolves with flue's admission — the durable handle, verbatim", async () => {
  const flue = fakeFlue();
  const port = flueAgentRunPort(flue);

  const adm = await port.admit(baseInput, { signal: new AbortController().signal });

  assert.deepEqual(flue.sent, [{ name: "coder", id: "inst-1", message: "do the thing", hasSignal: true }]);
  assert.deepEqual(adm, admission);
});

test("admit without a prompt is an error (re-attach rides input.attach, not this path)", async () => {
  const port = flueAgentRunPort(fakeFlue());
  await assert.rejects(() => port.admit({ ...baseInput, prompt: undefined }), /needs a prompt/);
});

test("settle waits on the admission; completed resolves", async () => {
  const flue = fakeFlue();
  const port = flueAgentRunPort(flue);

  await port.settle(admission);
  assert.deepEqual(flue.waited, [admission], "settle follows exactly the given admission");
});

test("a failed submission rejects as FlueRunFault so the actor surfaces an agent.fault", async () => {
  const flue = fakeFlue({
    wait: async () => {
      throw new FlueExecutionError({
        target: "agent_submission",
        targetId: "sub-1",
        failure: "failed",
        error: { message: "boom" },
      });
    },
  });
  const port = flueAgentRunPort(flue);

  await assert.rejects(() => port.settle(admission), /flue submission failed: boom/);
});

test("abort ends the submission remotely — the port's third verb (ADR-0024)", async () => {
  const flue = fakeFlue();
  const port = flueAgentRunPort(flue);

  await port.abort("coder", "inst-1");

  assert.deepEqual(flue.aborted, [{ name: "coder", id: "inst-1" }]);
});

test("a local abort propagates untranslated — abandon is not a fault", async () => {
  const controller = new AbortController();
  const abortErr = new DOMException("Aborted", "AbortError");
  const flue = fakeFlue({
    wait: () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(abortErr), { once: true });
      }),
  });
  const port = flueAgentRunPort(flue);

  const settleP = port.settle(admission, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => settleP,
    (err: unknown) => err === abortErr,
  );
});
