// Steps for Steering messages (ADR-0002): a Caller's `jr2 steer`, the step boundary's surface read
// that carries the message to an open Turn, the Harness's acknowledgment, and the run's record of
// each message on its status. The steps play the Agent's Harness, as mechanics.steps.ts does.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { E2EWorld } from "./world.ts";

type Record = { agent: string; text: string; outcome: string; author: { kind: string; name?: string } };
type Held = { id: string; message: { text: string; author: { kind: string; name?: string } } };

/** The conversation of the `review` fixture's coder (ADR-0057): `continue`, in the root Machine. */
const coderIid = (world: E2EWorld): string => `${world.runId}/root/coder`;

/** The Steering message ids this scenario's surface reads reserved, for the acknowledgment. */
const reserved = new WeakMap<E2EWorld, string[]>();

Then(
  "jr2 steer lists the Agent slot {string} as open and steerable",
  async function (this: E2EWorld, slot: string): Promise<void> {
    const r = await this.runCli(["steer", this.runId!]);
    assert.equal(r.code, 0, `jr2 steer failed: ${r.stderr}`);
    const slots = this.resultJson<Array<{ agent: string; open: boolean; steerable: boolean }>>();
    assert.deepEqual(slots, [{ agent: slot, open: true, steerable: true }]);
  },
);

When("I steer {string} with {string}", async function (this: E2EWorld, slot: string, text: string): Promise<void> {
  await this.runCli(["steer", this.runId!, slot, text]);
});

Then("jr2 steer said the open Turn hears it at its next step boundary", function (this: E2EWorld): void {
  assert.equal(this.last?.code, 0, `jr2 steer failed: ${this.last?.stderr}`);
  assert.match(
    this.last?.stderr ?? "",
    /sent a Steering message to root\/coder on .*: its open Turn hears it at its next step boundary/,
  );
});

Then("jr2 steer fails naming the slot {string}", function (this: E2EWorld, slot: string): void {
  assert.equal(this.last?.code, 1, `expected a refusal: ${this.last?.stdout}`);
  assert.match(
    this.last?.stderr ?? "",
    new RegExp(`holds the Agent slot "coder" \\(its slots: ${slot.replace("/", "\\/")}\\)`),
  );
});

Then(
  "the agent's next surface read carries the Steering message {string} from the Caller {string}",
  async function (this: E2EWorld, text: string, name: string): Promise<void> {
    const res = await fetch(`${this.server?.url}/agents/${encodeURIComponent(coderIid(this))}/surface`, {
      headers: this.authHeaders(),
    });
    assert.equal(res.status, 200);
    const surface = (await res.json()) as { notices: unknown[]; steering?: Held[] };
    assert.deepEqual(
      (surface.steering ?? []).map((h) => [h.message.text, h.message.author.kind, h.message.author.name]),
      [[text, "caller", name]],
    );
    assert.deepEqual(surface.notices, [], "a message rides apart from the notices");
    reserved.set(
      this,
      (surface.steering ?? []).map((h) => h.id),
    );
  },
);

When("the agent's Harness acknowledges the Steering message", async function (this: E2EWorld): Promise<void> {
  const heard = reserved.get(this) ?? [];
  const res = await fetch(`${this.server?.url}/agents/${encodeURIComponent(coderIid(this))}/notices`, {
    method: "POST",
    headers: { "content-type": "application/json", ...this.authHeaders() },
    body: JSON.stringify({ heard }),
  });
  assert.deepEqual(await res.json(), { heard: heard.length });
});

Then(
  "the run records the Steering message {string} as {string}",
  async function (this: E2EWorld, text: string, outcome: string): Promise<void> {
    let last: Record[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await this.runCli(["status", this.runId!]);
      assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
      last = this.resultJson<{ steering?: Record[] }>().steering ?? [];
      if (last.some((m) => m.text === text && m.outcome === outcome)) return;
      await sleep(50);
    }
    throw new Error(`the run never recorded "${text}" as ${outcome} (last: ${JSON.stringify(last)})`);
  },
);
