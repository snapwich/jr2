// The answer that a person reads (ADR-0011): the join of the `reply` texts (Sources first, then
// Gates, by Workflow, then by run; empty texts and repeats dropped; a skip's text only alone), the
// door's own text, the cause of a 429 or a 503 in a 200, the cut to the kind's `maxText`, the kind's
// envelope, and the follow-up of a Slack click, which goes only to a url under the kind's `posts`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { discord } from "@jr2/hooks/discord";
import { gitlab } from "@jr2/hooks/gitlab";
import { slack } from "@jr2/hooks/slack";
import { dispatch } from "../src/dispatch-effect.ts";
import { gate } from "../src/gate.ts";
import { carry, pool, skip, source } from "../src/pool.ts";
import { jr2Setup } from "../src/setup.ts";
import { secret } from "../src/http-effect.ts";
import { RunHost, type HookFanIn, type HookReply, type WorkflowDef } from "../src/run-host.ts";
import {
  chatText,
  cutText,
  doorText,
  hookDoor,
  joinReplies,
  type HookDoorOptions,
  type HookOutcome,
  type HookPost,
} from "../src/hooks.ts";
import type { HookMac } from "../src/effector-wire.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

// --- The join, the door's text and the cut: pure -------------------------------------------------

const r = (target: "source" | "gate", workflow: string, run: string, text?: string, skipped?: true): HookReply => ({
  target,
  workflow,
  run,
  gate: target === "source" ? "source" : "review",
  ...(text !== undefined ? { text } : {}),
  ...(skipped ? { skipped } : {}),
});

const empty: HookOutcome = { delivery: "d", seen: false, delivered: [], refused: [], ignored: 0, sources: [] };

test("the join: Sources first, then Gates, each by Workflow and then by run; empty texts and repeats are dropped", () => {
  const text = joinReplies([
    r("gate", "ticket", "r-2", "ticket r-2: approved."),
    r("gate", "preview", "r-9", "preview r-9: approved."),
    r("gate", "ticket", "r-1", "ticket r-1: approved."),
    r("source", "fixes", "p-1", "fixes: held #12."),
    r("gate", "ticket", "r-3", ""),
    r("gate", "ticket", "r-4"),
    r("gate", "zeta", "r-5", "ticket r-1: approved."),
  ]);
  assert.equal(
    text,
    ["fixes: held #12.", "preview r-9: approved.", "ticket r-1: approved.", "ticket r-2: approved."].join("\n"),
  );
});

test("the join: a skip's text shows only when no other target gave a text", () => {
  const skipText = "I did nothing: try /jr2 fix 123.";
  assert.equal(
    joinReplies([r("source", "fixes", "p-1", skipText, true), r("gate", "ticket", "r-1", "ticket r-1: approved.")]),
    "ticket r-1: approved.",
  );
  assert.equal(joinReplies([r("source", "fixes", "p-1", skipText, true), r("gate", "ticket", "r-1")]), skipText);
  assert.equal(joinReplies([]), "");
});

test("the door's own text: a repeat, a refused payload, nothing reached, and what the fan-in did", () => {
  assert.match(doorText({ ...empty, seen: true }), /got this before/);
  assert.match(
    doorText({
      ...empty,
      payloadRefused: { kind: "slack", key: "slash_command./jr2", issues: [{ path: ["text"], message: "Required" }] },
    }),
    /the slack payload "slash_command\.\/jr2" is not in the form that jr2 knows \(text: Required\)/,
  );
  assert.equal(doorText(empty), "Nothing in jr2 waits for this now.");
  assert.equal(
    doorText({ ...empty, delivered: [{ run: "r-1", workflow: "pr", gate: "inReview", event: "approve" }] }),
    'pr r-1: inReview took "approve".',
  );
  assert.equal(
    doorText({ ...empty, sources: [{ pool: "p", workflow: "alerts", source: "source", verdict: "paused" }] }),
    "The Pool of alerts is paused, so it took nothing.",
  );
});

test("a 429 or a 503 that a person reads: the text says why, after the targets' texts", () => {
  const full: HookOutcome = {
    ...empty,
    sources: [{ pool: "p", workflow: "alerts", source: "source", verdict: "hold-full", key: "k" }],
  };
  assert.match(
    chatText(full, { status: 429, replies: [], waiting: [] }),
    /^jr2 cannot take this now: the Pool of alerts holds/,
  );
  const text = chatText(empty, {
    status: 503,
    replies: [r("gate", "pr", "r-1", "pr r-1: approved.")],
    waiting: ["alerts"],
  });
  assert.equal(text.split("\n")[0], "pr r-1: approved.");
  assert.match(text.split("\n")[1]!, /the Pool of alerts has no live run/);
});

test("the cut: at most maxText characters, an ellipsis last, and no character cut in two", () => {
  assert.equal(cutText("abc", 3), "abc");
  assert.equal(cutText("abcdef", 4), "abc…");
  assert.equal(cutText("😀😀😀", 2), "😀…");
  assert.equal(cutText("x".repeat(5000), undefined).length, 5000);
});

// --- Through the door ------------------------------------------------------------------------------

const approve = defineEvent({ name: "approve", input: z.object({ by: z.string() }) });
const PR = "https://forge.example.com/pr/1";

/** A review Gate that hears a Discord command and a Slack command and click. Its reply says what
 * the run did; `say: "throw"` makes the reply throw, and `say: "none"` gives no reply at all. */
function reviewMachine(id: string, say: "text" | "throw" | "none" = "text") {
  const review = gate({
    meta: z.object({ pr: z.string() }),
    delivers: [approve],
    hooks: {
      discord: {
        "application_command.approve": ({ payload, caller }) => {
          if (payload.channel_id === "throw") throw new Error("only a reviewer can approve");
          return { type: "approve", by: caller.onBehalfOf ?? "?" };
        },
      },
      slack: {
        "slash_command./jr2": ({ payload }) => ({ type: "approve", by: payload.user_id }),
        "block_actions.approve": ({ payload }) => ({ type: "approve", by: payload.user.id }),
      },
    },
    look: "none",
    reply: (o, { meta }) => {
      if (say === "none") return undefined;
      if (say === "throw") throw new Error("the reply broke");
      return o.state === "delivered"
        ? `${id} ${o.run}: ${meta.pr} approved by ${o.event.by} <ok>.`
        : `${id} ${o.run}: not taken (${o.reason}).`;
    },
  });
  return jr2Setup({
    types: {} as { context: { pr: string }; input: { pr: string } },
    events: [approve],
    actors: { review },
  }).createMachine({
    id,
    context: ({ input }) => ({ pr: input?.pr ?? PR }),
    initial: "inReview",
    states: {
      inReview: {
        invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr } }) },
        on: { approve: "merged" },
      },
      merged: { type: "final" },
    },
  });
}

const discordKeys = generateKeyPairSync("ed25519");
const discordPublicHex = Buffer.from(
  (discordKeys.publicKey.export({ format: "jwk" }) as { x: string }).x,
  "base64url",
).toString("hex");
const SLACK_SECRET = "slack-signing-secret";
const fakeMac: HookMac = async ({ alg, bytes, signature }) =>
  Buffer.compare(createHmac(alg, SLACK_SECRET).update(bytes).digest(), Buffer.from(signature)) === 0;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function discordCommand(id: string, by = "u-7", channel = "c-1") {
  const raw = JSON.stringify({
    type: 2,
    id,
    channel_id: channel,
    member: { user: { id: by } },
    data: { name: "approve" },
  });
  const at = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(at + raw), discordKeys.privateKey).toString("hex");
  return { headers: new Headers({ "x-signature-ed25519": sig, "x-signature-timestamp": at }), body: bytes(raw) };
}

function slackSigned(raw: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    headers: new Headers({
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: bytes(raw),
  };
}

const slackCommand = (trigger: string, text = "approve 1") =>
  slackSigned(
    new URLSearchParams({ command: "/jr2", text, user_id: "U1", channel_id: "C1", trigger_id: trigger }).toString(),
  );

const slackClick = (trigger: string, responseUrl: string) =>
  slackSigned(
    new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        trigger_id: trigger,
        user: { id: "U2" },
        actions: [{ action_id: "approve" }],
        response_url: responseUrl,
      }),
    }).toString(),
  );

const hosts: RunHost[] = [];
after(async () => {
  for (const h of hosts) {
    await h.close();
    for (const st of h.list()) await h.stop(st.runId);
  }
});

async function setup(machines: Array<[string, "text" | "throw" | "none"]>, over: Partial<HookDoorOptions> = {}) {
  const store = await mkStore();
  const host = new RunHost({ store });
  hosts.push(host);
  const runs: string[] = [];
  for (const [id, say] of machines) {
    host.register({ name: id, machine: reviewMachine(id, say), provide: () => ({}) });
    const { runId } = await host.start(id, { pr: PR });
    await waitFor(() => host.gates(runId).length === 1);
    runs.push(runId);
  }
  const door = hookDoor({
    host,
    store,
    hooks: () => ({
      dc: discord({ publicKey: discordPublicHex }),
      sl: slack({ secret: secret("SLACK_SIGNING") }),
    }),
    digests: () => ({}),
    mac: fakeMac,
    ...over,
  });
  return { host, store, door, runs };
}

test("a Discord command: 200 and the ephemeral envelope around the joined replies, by Workflow and then run", async () => {
  const { door, runs, store } = await setup([
    ["zulu", "text"],
    ["alpha", "text"],
  ]);
  const d = discordCommand("i-1");
  const answer = await door.deliver("dc", d.headers, d.body);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    type: 4,
    data: {
      content: `alpha ${runs[1]}: ${PR} approved by u-7 <ok>.\nzulu ${runs[0]}: ${PR} approved by u-7 <ok>.`,
      flags: 64,
    },
  });
  // The hook log keeps the outcome, not the envelope.
  const line = store.hookLog("dc", 1)[0]!;
  assert.equal(line.kind, "delivered");
  assert.equal((line.detail as HookOutcome).delivered.length, 2);
});

test("a refused delivery: the Gate's reply reads the reason; a reply that throws gives no text, and the log keeps it", async () => {
  const { door, runs, store } = await setup([
    ["alpha", "text"],
    ["beta", "throw"],
  ]);
  const d = discordCommand("i-2", "u-7", "throw");
  const answer = await door.deliver("dc", d.headers, d.body);
  const content = (answer.body as { data: { content: string } }).data.content;
  assert.equal(content, `alpha ${runs[0]}: not taken (its handler threw: only a reviewer can approve).`);
  const detail = store.hookLog("dc", 1)[0]!.detail as { replyErrors?: Array<{ run: string; error: string }> };
  assert.deepEqual(detail.replyErrors, [{ run: runs[1], gate: "inReview", error: "its reply threw: the reply broke" }]);
});

test("no reply, a repeat, and a delivery that reached nothing: the door writes the text", async () => {
  const { door, runs } = await setup([["alpha", "none"]]);
  const d = discordCommand("i-3");
  const first = await door.deliver("dc", d.headers, d.body);
  assert.equal(
    (first.body as { data: { content: string } }).data.content,
    `alpha ${runs[0]}: inReview took "approve".`,
  );
  const again = await door.deliver("dc", d.headers, d.body);
  assert.match((again.body as { data: { content: string } }).data.content, /got this before/);
  const other = discordCommand("i-4");
  const nothing = await door.deliver("dc", other.headers, other.body);
  assert.equal((nothing.body as { data: { content: string } }).data.content, "Nothing in jr2 waits for this now.");
});

test("a Slack command: the escaped text in an ephemeral answer, cut to the kind's limit", async () => {
  const { door, runs } = await setup([["alpha", "text"]]);
  const d = slackCommand("t-1");
  const answer = await door.deliver("sl", d.headers, d.body);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    response_type: "ephemeral",
    text: `alpha ${runs[0]}: ${PR} approved by U1 &lt;ok&gt;.`,
  });
  assert.equal(answer.after, undefined, "a command has no follow-up");
});

test("a Slack click: an empty 200, then the text goes to its response_url through the injected post", async () => {
  const posts: Array<{ url: string; json: unknown }> = [];
  const post: HookPost = async (req) => {
    posts.push(req);
  };
  const { door, runs } = await setup([["alpha", "text"]], { post });
  const d = slackClick("t-2", "https://hooks.slack.com/actions/T/1/abc");
  const answer = await door.deliver("sl", d.headers, d.body);
  assert.equal(answer.status, 200);
  assert.equal(answer.body, null);
  assert.equal(posts.length, 0, "the post goes after the answer");
  await answer.after!();
  assert.deepEqual(posts, [
    {
      url: "https://hooks.slack.com/actions/T/1/abc",
      json: {
        response_type: "ephemeral",
        replace_original: false,
        text: `alpha ${runs[0]}: ${PR} approved by U2 &lt;ok&gt;.`,
      },
    },
  ]);
});

test("a failed follow-up, and one with no Instance Effector, are lines in the hook log", async () => {
  const failing: HookPost = async () => {
    throw new Error("the post got 404");
  };
  const { door, store } = await setup([["alpha", "text"]], { post: failing });
  const d = slackClick("t-3", "https://hooks.slack.com/actions/T/1/def");
  await (
    await door.deliver("sl", d.headers, d.body)
  ).after!();
  assert.deepEqual(
    store.hookLog("sl", 2).map((l) => [l.kind, (l.detail as { error?: string }).error]),
    [
      ["follow-up", "the post got 404"],
      ["delivered", undefined],
    ],
  );
  const bare = await setup([["alpha", "text"]]);
  const e = slackClick("t-4", "https://hooks.slack.com/actions/T/1/ghi");
  await (
    await bare.door.deliver("sl", e.headers, e.body)
  ).after!();
  assert.match(String((bare.store.hookLog("sl", 1)[0]!.detail as { error: string }).error), /no Instance Effector/);
});

test("the door refuses a follow-up to a url outside the kind's posts", async () => {
  const posts: unknown[] = [];
  const { door, store, host } = await setup([["alpha", "text"]], {
    post: async (req) => {
      posts.push(req);
    },
  });
  // A kind whose envelope gives a url of another host: the door posts nothing.
  const { defineHookKind, json } = await import("@jr2/hooks");
  const rogue = defineHookKind({
    api: 1,
    id: "rogue",
    events: { cmd: z.looseObject({}) },
    verify: { token: { header: "x-rogue-token" } },
    read: (req) => ({ key: "cmd", id: String((json(req) as { id: string }).id), payload: {}, readBy: "person" }),
    answer: (t) => ({ body: null, then: { post: "https://evil.example.com/x", json: { t } } }),
    posts: ["https://hooks.slack.com/"],
  });
  const door2 = hookDoor({
    host,
    store,
    hooks: () => ({ rg: rogue({ secret: secret("RG") }) }),
    digests: () => ({ RG: createHash("sha256").update("t").digest("hex") }),
    post: async (req) => {
      posts.push(req);
    },
  });
  void door;
  const answer = await door2.deliver("rg", new Headers({ "x-rogue-token": "t" }), bytes(JSON.stringify({ id: "1" })));
  assert.equal(answer.status, 200);
  assert.equal(answer.after, undefined);
  assert.equal(posts.length, 0);
  const line = store.hookLog("rg", 1)[0]!;
  assert.equal(line.kind, "follow-up");
  assert.match(String((line.detail as { error: string }).error), /outside its posts/);
});

test("a person reads 200 where the rules give 429 or 503, and the log keeps the rules' status", async () => {
  const store = await mkStore();
  let fan: HookFanIn = { delivered: [], refused: [], ignored: 0, sources: [] };
  const host = { deliverHook: async () => fan } as unknown as RunHost;
  const door = hookDoor({
    host,
    store,
    hooks: () => ({ dc: discord({ publicKey: discordPublicHex }) }),
    digests: () => ({}),
  });
  fan = {
    delivered: [],
    refused: [],
    ignored: 0,
    sources: [{ pool: "p-1", workflow: "alerts", source: "source", verdict: "hold-full", key: "k" }],
    replies: [],
  };
  const d1 = discordCommand("i-10");
  const full = await door.deliver("dc", d1.headers, d1.body);
  assert.equal(full.status, 200);
  assert.match((full.body as { data: { content: string } }).data.content, /the Pool of alerts holds as many items/);
  fan = { delivered: [], refused: [], ignored: 0, sources: [], waiting: ["alerts"], replies: [] };
  const d2 = discordCommand("i-11");
  const waiting = await door.deliver("dc", d2.headers, d2.body);
  assert.equal(waiting.status, 200);
  assert.match((waiting.body as { data: { content: string } }).data.content, /the Pool of alerts has no live run/);
  assert.deepEqual(
    store.hookLog("dc", 2).map((l) => [l.kind, l.status]),
    [
      ["no-live-run", 503],
      ["hold-full", 429],
    ],
  );
  // A forge still gets the rules' status and the outcome.
  const token = "glpat";
  const forge = hookDoor({
    host,
    store,
    hooks: () => ({ gl: gitlab({ secret: secret("GL") }) }),
    digests: () => ({ GL: createHash("sha256").update(token).digest("hex") }),
  });
  const answer = await forge.deliver(
    "gl",
    new Headers({ "x-gitlab-token": token, "idempotency-key": "g-1" }),
    bytes(JSON.stringify({ object_kind: "pipeline", object_attributes: { sha: "s", status: "failed" }, user: {} })),
  );
  assert.equal(answer.status, 503);
  assert.equal((answer.body as HookOutcome).delivery, "g-1");
});

// --- A Source's reply ------------------------------------------------------------------------------

const fixDoor = z.object({ n: z.number() });
const finish = defineEvent({ name: "finish", input: z.object({}) });
const fix = jr2Setup({ types: {} as { context: { body: unknown } }, events: [finish] }).createMachine({
  id: "fix",
  input: fixDoor,
  context: ({ input }) => ({ body: input }),
  initial: "waiting",
  states: { waiting: { invoke: { src: "gate", id: "ctl" }, on: { finish: "done" } }, done: { type: "final" } },
});

/** A standing Pool that carries `/jr2 fix <n>` from Slack, and skips any other text. */
const fixes = pool(dispatch("fix", { input: fixDoor, wait: true }), {
  id: "fixes",
  standing: true,
  source: source({
    item: z.object({ n: z.number() }),
    hooks: {
      slack: {
        "slash_command./jr2": ({ payload }) => {
          const m = /^fix (\d+)$/.exec(payload.text);
          return m ? carry({ n: Number(m[1]) }) : skip(`"${payload.text}" is not "fix <number>"`);
        },
      },
    },
    reply: (v) =>
      v.verdict === "held" || v.verdict === "existing"
        ? `fixes: #${v.item.n} is ${v.verdict === "held" ? "taken" : "already in work"}.`
        : v.verdict === "skipped"
          ? `fixes: I did nothing (${v.reason}). Try /jr2 fix 123.`
          : undefined,
  }),
  itemId: (i: { n: number }) => `fix-${i.n}`,
  cap: 1,
  itemInput: (i: { n: number }) => ({ n: i.n }),
});

test("a Source's reply reads its verdict and the item; its skip shows only when no Gate spoke", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  hosts.push(host);
  const defs: WorkflowDef[] = [
    { name: "fixes", machine: fixes as never, provide: () => ({}), assembly: "a" },
    { name: "fix", machine: fix as never, provide: () => ({}), assembly: "a" },
    { name: "alpha", machine: reviewMachine("alpha") as never, provide: () => ({}), assembly: "a" },
  ];
  for (const d of defs) host.register(d);
  await host.keepStanding("boot");
  const door = hookDoor({
    host,
    store,
    hooks: () => ({ sl: slack({ secret: secret("SLACK_SIGNING") }) }),
    digests: () => ({}),
    mac: fakeMac,
  });
  const text = async (trigger: string, said: string): Promise<string> => {
    const d = slackCommand(trigger, said);
    return ((await door.deliver("sl", d.headers, d.body)).body as { text: string }).text;
  };
  assert.equal(await text("t-1", "fix 12"), "fixes: #12 is taken.");
  // Nothing else is open: the skip's text shows alone.
  assert.equal(
    await text("t-2", "approve 1"),
    'fixes: I did nothing ("approve 1" is not "fix &lt;number&gt;"). Try /jr2 fix 123.',
  );
  // A Gate opens and takes the command: the skip's text is not shown.
  const { runId } = await host.start("alpha", { pr: PR });
  await waitFor(() => host.gates(runId).length === 1);
  assert.equal(await text("t-3", "approve 1"), `alpha ${runId}: ${PR} approved by U1 &lt;ok&gt;.`);
});
