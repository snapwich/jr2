// Steps for kept conversations (ADR-0023): the steps play the Harness of the pod that the run's
// admission ledger names, as it sends its conversation through its Custodian. The Custodian puts
// the pod's control token in place of the control Stand-in (ADR-0076), and the Harness states the
// slot in a header: so these steps send that token and that header to the Orchestrator. The reads
// are `GET /runs/:runId/conversations` and the real `jr2 logs`.

import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { controlToken, SLOT_HEADER } from "@jr2/orchestrator/internal";
import { E2EWorld } from "./world.ts";

type Entry = { id: string; seq: number; at: string; kind: string; text: string };
type Kept = { agent: string; instanceId: string; open: boolean; bytes: number; cut: boolean; slot?: string };

/** What each scenario holds: the signing key, the entries sent so far, the last batch, and the last
 * answer of the write route. */
type State = { key?: Buffer; sent: Entry[]; batch: Entry[]; answer?: { status: number; body: unknown } };
const states = new WeakMap<E2EWorld, State>();
const state = (world: E2EWorld): State => {
  let s = states.get(world);
  if (!s) states.set(world, (s = { sent: [], batch: [] }));
  return s;
};

/** The coder's conversation in the `review` fixture: `continue`, in the root Machine (ADR-0057). */
const coderIid = (world: E2EWorld): string => `${world.runId}/root/coder`;
const CODER_SLOT = "root/coder";

/** The next entries of the conversation, each with a later time and a larger `seq` than the last. */
function nextEntries(world: E2EWorld, rows: Array<{ kind: string; text: string }>): Entry[] {
  const s = state(world);
  const last = s.sent.at(-1);
  let seq = last ? last.seq + 1 : Date.now() * 1000;
  let at = last ? Date.parse(last.at) : Date.now();
  return rows.map(({ kind, text }) => ({ id: randomUUID(), seq: seq++, at: new Date(++at).toISOString(), kind, text }));
}

/** One batch to the write route, as the Harness's keeper sends it: a 409 (the run has not ledgered
 * the conversation yet) is sent again, as the Harness does. */
async function send(
  world: E2EWorld,
  iid: string,
  entries: Entry[],
  auth: { token: string; slot?: string },
): Promise<{ status: number; body: unknown }> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${world.server?.url}/agents/${encodeURIComponent(iid)}/conversation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
        ...(auth.slot === undefined ? {} : { [SLOT_HEADER]: auth.slot }),
      },
      body: JSON.stringify({ entries }),
    });
    const answer = { status: res.status, body: (await res.json()) as unknown };
    if (answer.status !== 409 || i >= 100) return answer;
    await sleep(50);
  }
}

/** The control token of `pod`, signed with the scenario's key: what that pod's Custodian sends. */
function podToken(world: E2EWorld, pod: string): string {
  const key = state(world).key;
  assert.ok(key, "the orchestrator signs with a key this scenario holds");
  return controlToken(key, pod);
}

Given("the orchestrator signs its tokens with a key that this scenario holds", function (this: E2EWorld): void {
  const key = randomBytes(32);
  state(this).key = key;
  this.serverEnv.JR2_SIGNING_KEY = key.toString("base64");
});

When(
  "I start the {string} workflow against the stub harness in the pod {string}",
  async function (this: E2EWorld, wf: string, pod: string): Promise<void> {
    const endpoint = await this.stubHarnessUrl();
    const r = await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ endpoint, sandbox: pod })]);
    assert.equal(r.code, 0, r.stderr);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

When(
  "the Harness of pod {string} sends the coder's entries:",
  async function (this: E2EWorld, pod: string, table: DataTable): Promise<void> {
    const s = state(this);
    s.batch = nextEntries(this, table.hashes() as Array<{ kind: string; text: string }>);
    s.answer = await send(this, coderIid(this), s.batch, { token: podToken(this, pod), slot: CODER_SLOT });
    assert.equal(s.answer.status, 200, JSON.stringify(s.answer.body));
    s.sent.push(...s.batch);
  },
);

When("the Harness of pod {string} sends the same batch again", async function (this: E2EWorld, pod: string) {
  const s = state(this);
  s.answer = await send(this, coderIid(this), s.batch, { token: podToken(this, pod), slot: CODER_SLOT });
  assert.equal(s.answer.status, 200, JSON.stringify(s.answer.body));
});

Then("the Orchestrator kept {int} entries", function (this: E2EWorld, n: number): void {
  assert.deepEqual(state(this).answer?.body, { kept: n, cut: false });
});

When("the Instance token sends a batch of the coder's conversation", async function (this: E2EWorld) {
  const s = state(this);
  s.answer = await send(this, coderIid(this), nextEntries(this, [{ kind: "text", text: "x" }]), {
    token: this.authHeaders().authorization!.slice("Bearer ".length),
  });
});

When(
  "the Harness of pod {string} sends a batch of the coder's conversation",
  async function (this: E2EWorld, pod: string): Promise<void> {
    const s = state(this);
    s.answer = await send(this, coderIid(this), nextEntries(this, [{ kind: "text", text: "x" }]), {
      token: podToken(this, pod),
      slot: CODER_SLOT,
    });
  },
);

When(
  "the Harness of pod {string} as {string} sends a batch of the coder's conversation",
  async function (this: E2EWorld, pod: string, slot: string): Promise<void> {
    const s = state(this);
    s.answer = await send(this, coderIid(this), nextEntries(this, [{ kind: "text", text: "x" }]), {
      token: podToken(this, pod),
      slot,
    });
  },
);

When(
  "the Harness of pod {string} sends a batch for the conversation {string}",
  async function (this: E2EWorld, pod: string, iid: string): Promise<void> {
    const s = state(this);
    s.answer = await send(this, iid, nextEntries(this, [{ kind: "text", text: "x" }]), {
      token: podToken(this, pod),
      slot: CODER_SLOT,
    });
  },
);

Then("the batch is refused with {int}", async function (this: E2EWorld, status: number): Promise<void> {
  const answer = state(this).answer;
  assert.equal(answer?.status, status, JSON.stringify(answer?.body));
  // Nothing of a refused batch is kept.
  const kept = await this.api<Kept[]>("GET", `/runs/${this.runId}/conversations`);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(kept.body, [], "a refused batch keeps no conversation");
});

Then(
  /^the run lists one conversation of "([^"]+)" in the slot "([^"]+)", (open|not open)$/,
  async function (this: E2EWorld, agent: string, slot: string, open: string): Promise<void> {
    // A conversation is open while its Turn is registered on a live run.
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      const kept = await this.api<Kept[]>("GET", `/runs/${this.runId}/conversations`);
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      last = kept.body;
      const [c] = kept.body;
      assert.equal(kept.body.length, 1, JSON.stringify(kept.body));
      assert.equal(c!.agent, agent);
      assert.equal(c!.slot, slot);
      assert.equal(c!.instanceId, coderIid(this));
      assert.equal(c!.cut, false);
      assert.ok(c!.bytes > 0);
      if (c!.open === (open === "open")) return;
      await sleep(50);
    }
    throw new Error(`the conversation is never ${open}: ${JSON.stringify(last)}`);
  },
);

When("I read the run's conversations with jr2 logs", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["logs", this.runId!]);
});

When(
  "I read the run's conversations of {string} with jr2 logs",
  async function (this: E2EWorld, agent: string): Promise<void> {
    await this.runCli(["logs", this.runId!, agent]);
  },
);

When(
  "the Caller {string} reads the run's conversations with jr2 logs",
  async function (this: E2EWorld, caller: string): Promise<void> {
    await this.runCli(["logs", this.runId!], { as: caller });
  },
);

/** Each kept entry as the Harness prints it (ADR-0023): `[<agent>] [<instance id>] [<label>] <text>`. */
Then("jr2 logs prints the coder's entries in order", function (this: E2EWorld): void {
  assert.equal(this.last?.code, 0, this.last?.stderr ?? "");
  const want = state(this)
    .sent.map((e) => `[coder] [${coderIid(this)}] [${e.kind}] ${e.text}\n`)
    .join("");
  assert.equal(this.last?.stdout, want);
});

When(
  "I follow the run's conversations with jr2 logs -f while the coder says {string} and the run ends",
  { timeout: 60_000 },
  async function (this: E2EWorld, text: string): Promise<void> {
    const following = this.startCli(["logs", this.runId!, "-f"]);
    const closed = new Promise<number>((resolve) => following.child.on("close", (c) => resolve(c ?? 0)));
    // The new entry goes after the first read has printed the kept ones, so it can come only from the follow.
    const first = state(this).sent[0]!.text;
    for (let i = 0; i < 200 && !following.output().stdout.includes(first); i++) await sleep(50);
    assert.ok(
      following.output().stdout.includes(first),
      `jr2 logs -f printed the kept entries: ${JSON.stringify(following.output())}`,
    );
    const s = state(this);
    s.batch = nextEntries(this, [{ kind: "text", text }]);
    const pod = "ws-review-0";
    s.answer = await send(this, coderIid(this), s.batch, { token: podToken(this, pod), slot: CODER_SLOT });
    assert.equal(s.answer.status, 200, JSON.stringify(s.answer.body));
    s.sent.push(...s.batch);
    await sleep(500);
    // The run ends: the Agent's pick, then the Gate's answer.
    const pick = await fetch(`${this.server?.url}/agents/${encodeURIComponent(coderIid(this))}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ type: "request_review", summary: "PR up" }),
    });
    assert.equal(pick.status, 200, await pick.text());
    for (let i = 0; i < 100; i++) {
      const res = await this.api("POST", `/runs/${this.runId}/gates/review-1/events`, { type: "approve" });
      if (res.status === 200) break;
      await sleep(50);
    }
    const code = await closed;
    this.last = { ...following.output(), code };
  },
);
