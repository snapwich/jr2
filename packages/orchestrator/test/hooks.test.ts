// The Hook's door (ADR-0011, ADR-0078), in one process: the three verifiers (`token` against a
// digest, then the header removed; `ed25519` against a public key; `mac` through the injected check
// and the window), the handshakes, the parse before the repeat check, the repeat by id AND digest,
// `may.answer`, the fan-in to open Gates with the Hook as the Caller, the refusals that mark the
// feed and never fault the run, the outcome, the hook log, and the routes' bands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { defineHookKind, json } from "../src/hook-kinds/index.ts";
import { gitlab } from "../src/hook-kinds/gitlab.ts";
import { discord } from "../src/hook-kinds/discord.ts";
import { github } from "../src/hook-kinds/github.ts";
import { slack } from "../src/hook-kinds/slack.ts";
import { gate } from "../src/gate.ts";
import { jr2Setup } from "../src/setup.ts";
import { secret } from "../src/http-effect.ts";
import { RunHost, type RunFeedEvent } from "../src/run-host.ts";
import { hookDoor, HOOK_BODY_MAX, HOOK_WINDOW_S, type HookDoorOptions, type HookOutcome } from "../src/hooks.ts";
import { createApp, limitedBody } from "../src/http.ts";
import { createAuthenticator, mintInstanceToken } from "../src/tokens.ts";
import {
  createMacClient,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  MAC_PATH,
  responseMac,
  EffectorForged,
  type HookMac,
} from "../src/effector-wire.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const approve = defineEvent({ name: "approve", input: z.object({ by: z.string() }) });
const reject = defineEvent({ name: "reject", input: z.object({ by: z.string() }) });

const PR = "https://forge.example.com/pr/1";
const GL_SECRET = "gitlab-token-value";
const GH_SECRET = "github-hmac-secret";

/** The handlers' log: what each one saw, so a test can tell that a handler did not run. */
const seen: unknown[] = [];

/** A review Gate that hears three kinds. `reject` is in `delivers`, and the state takes it only
 * with a guard that is never true, so the run does not take it now. */
function reviewMachine(id = "pr") {
  const review = gate({
    meta: z.object({ pr: z.string() }),
    delivers: [approve, reject],
    hooks: {
      gitlab: {
        "merge_request.approved": ({ payload, meta }) => {
          seen.push(payload);
          return payload.object_attributes.url === meta.pr ? { type: "approve", by: payload.user.username } : undefined;
        },
        "note.MergeRequest": ({ payload }) => {
          if (payload.object_attributes.note === "throw") throw new Error("the note says throw");
          if (payload.object_attributes.note === "reject") return { type: "reject", by: payload.user.username };
          return { type: "bogus" } as never;
        },
      },
      discord: {
        "application_command.approve": ({ payload }) => ({ type: "approve", by: payload.member?.user.id ?? "dm" }),
      },
      github: {
        "pull_request_review.submitted": ({ payload, meta }) =>
          payload.pull_request.html_url === meta.pr ? { type: "approve", by: payload.review.user.login } : undefined,
      },
    },
    look: "none",
  });
  return jr2Setup({
    types: {} as { context: { pr: string }; input: { pr: string } },
    events: [approve, reject],
    actors: { review },
  }).createMachine({
    id,
    context: ({ input }) => ({ pr: input?.pr ?? PR }),
    initial: "inReview",
    states: {
      inReview: {
        invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr } }) },
        on: { approve: "merged", reject: { target: "merged", guard: () => false } },
      },
      merged: { type: "final" },
    },
  });
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const discordKeys = generateKeyPairSync("ed25519");
const DISCORD_PUBLIC = (discordKeys.publicKey.export({ format: "jwk" }) as { x: string }).x;
const discordPublicHex = Buffer.from(DISCORD_PUBLIC, "base64url").toString("hex");

/** The in-process `mac` check: the HMAC that the Instance Effector would compute. */
const macChecks: Array<{ secret: string; bytes: string }> = [];
const fakeMac: HookMac = async ({ secret: name, alg, bytes, signature }) => {
  macChecks.push({ secret: name, bytes: Buffer.from(bytes).toString("utf8") });
  const want = createHmac(alg, name === "GH_HOOK" ? GH_SECRET : "slack-secret")
    .update(bytes)
    .digest();
  return Buffer.compare(want, Buffer.from(signature)) === 0;
};

type Setup = {
  host: RunHost;
  store: SnapshotStore;
  door: ReturnType<typeof hookDoor>;
  runId: string;
  feed: RunFeedEvent[];
  clock: { now: number };
};

async function setup(over: Partial<HookDoorOptions> & { may?: readonly string[] } = {}): Promise<Setup> {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register({ name: "pr", machine: reviewMachine(), provide: () => ({}) });
  const may = over.may ? { answer: over.may } : undefined;
  const hooks = {
    gl: gitlab({ secret: secret("GL_HOOK"), ...(may ? { may } : {}) }),
    dc: discord({ publicKey: discordPublicHex }),
    gh: github({ secret: secret("GH_HOOK") }),
    sl: slack({ secret: secret("SLACK_SIGNING") }),
  };
  const clock = { now: Date.now() };
  const door = hookDoor({
    host,
    store,
    hooks: () => hooks,
    digests: () => ({ GL_HOOK: sha256(GL_SECRET) }),
    mac: fakeMac,
    now: () => clock.now,
    ...over,
  });
  const { runId } = await host.start("pr", { pr: PR });
  await waitFor(() => host.gates(runId).length === 1);
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => feed.push(e));
  return { host, store, door, runId, feed, clock };
}

const body = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

/** A GitLab delivery: `merge_request.approved` of `url` by `who`. */
function gitlabDelivery(id: string, url = PR, who = "ann", token = GL_SECRET) {
  const payload = {
    object_kind: "merge_request",
    user: { username: who },
    object_attributes: { action: "approved", url, last_commit: { id: "abc" }, n: id },
  };
  return {
    headers: new Headers({ "x-gitlab-token": token, "idempotency-key": id, "content-type": "application/json" }),
    body: body(payload),
  };
}

function discordDelivery(payload: unknown, at = Math.floor(Date.now() / 1000), key = discordKeys.privateKey) {
  const raw = JSON.stringify(payload);
  const sig = sign(null, Buffer.concat([Buffer.from(String(at)), Buffer.from(raw)]), key).toString("hex");
  return {
    headers: new Headers({ "x-signature-ed25519": sig, "x-signature-timestamp": String(at) }),
    body: body(raw),
  };
}

function githubDelivery(id: string, payload: unknown, secretValue = GH_SECRET) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", secretValue).update(raw).digest("hex");
  return {
    headers: new Headers({
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-event": "pull_request_review",
      "x-github-delivery": id,
    }),
    body: body(raw),
  };
}

const outcome = (b: unknown): HookOutcome => b as HookOutcome;

test("a token Hook: the digest matches, the run takes the event, and the Hook is its Caller", async () => {
  const { host, door, runId } = await setup();
  // The Gate inbox names the Hook kinds that the open Gate hears (ADR-0011).
  const [entry] = host.gateInbox(() => true);
  assert.deepEqual([entry?.gate, entry?.hook], ["inReview", ["discord", "github", "gitlab"]]);
  const d = gitlabDelivery("d-1");
  const answer = await door.deliver("gl", d.headers, d.body);
  assert.equal(answer.status, 200);
  const o = outcome(answer.body);
  assert.equal(o.delivery, "d-1");
  assert.equal(o.seen, false);
  assert.deepEqual(o.delivered, [{ run: runId, workflow: "pr", gate: "inReview", event: "approve" }]);
  assert.deepEqual(o.refused, []);
  const status = await host.read(runId);
  assert.equal(status?.status, "done");
  assert.deepEqual(
    status?.answers?.map((a) => ({ ...a, at: undefined })),
    [
      {
        gate: "inReview",
        type: "approve",
        at: undefined,
        answeredBy: { via: "hook", name: "gl", onBehalfOf: "ann" },
        delivery: "d-1",
      },
    ],
  );
  await host.close();
});

test("a token Hook refuses a wrong token and no token with 401, and logs nothing", async () => {
  const { host, door, store } = await setup();
  const wrong = gitlabDelivery("d-1", PR, "ann", "not-the-token");
  assert.equal((await door.deliver("gl", wrong.headers, wrong.body)).status, 401);
  const none = gitlabDelivery("d-2");
  none.headers.delete("x-gitlab-token");
  assert.equal((await door.deliver("gl", none.headers, none.body)).status, 401);
  assert.deepEqual(store.hookLog("gl", 10), []);
  await host.close();
});

test("the door removes a token's header before any code of the kind runs", async () => {
  const store = await mkStore();
  const host = new RunHost({ store });
  let heard: Record<string, string | undefined> | undefined;
  const probe = defineHookKind({
    api: 1,
    id: "probe",
    events: {},
    verify: { token: { header: "x-probe-token" } },
    read: (req) => {
      heard = { ...req.headers };
      return { key: "k", id: String((json(req) as { id: string }).id), payload: {} };
    },
  });
  const door = hookDoor({
    host,
    store,
    hooks: () => ({ p: probe({ secret: secret("PROBE") }) }),
    digests: () => ({ PROBE: sha256("t") }),
  });
  const answer = await door.deliver("p", new Headers({ "x-probe-token": "t", "x-other": "1" }), body({ id: "1" }));
  assert.equal(answer.status, 200);
  assert.deepEqual(heard, { "x-other": "1" });
  await host.close();
});

test("an ed25519 Hook: a signature by the key delivers; another key, or a time out of the window, is 401", async () => {
  const { host, door, runId, clock } = await setup();
  const command = {
    type: 2,
    id: "i-1",
    channel_id: "c",
    member: { user: { id: "u-7" } },
    data: { name: "approve" },
  };
  const other = generateKeyPairSync("ed25519").privateKey;
  const forged = discordDelivery(command, Math.floor(clock.now / 1000), other);
  assert.equal((await door.deliver("dc", forged.headers, forged.body)).status, 401);
  const old = discordDelivery(command, Math.floor(clock.now / 1000) - HOOK_WINDOW_S - 5);
  assert.equal((await door.deliver("dc", old.headers, old.body)).status, 401);
  const good = discordDelivery(command, Math.floor(clock.now / 1000));
  const answer = await door.deliver("dc", good.headers, good.body);
  assert.equal(answer.status, 200);
  // A person reads a Discord answer: the envelope, with the door's text (the Gate has no reply).
  assert.deepEqual(answer.body, {
    type: 4,
    data: { content: `pr ${runId}: inReview took "approve".`, flags: 64 },
  });
  assert.equal((await host.read(runId))?.answers?.[0]?.answeredBy.onBehalfOf, "u-7");
  await host.close();
});

test("a handshake comes after the verifier, reaches no handler, and the log keeps it", async () => {
  const { host, door, store, clock } = await setup();
  const ping = discordDelivery({ type: 1, id: "p" }, Math.floor(clock.now / 1000));
  const answer = await door.deliver("dc", ping.headers, ping.body);
  assert.deepEqual(answer, { status: 200, body: { type: 1 } });
  const unsigned = { headers: new Headers(), body: ping.body };
  assert.equal((await door.deliver("dc", unsigned.headers, unsigned.body)).status, 401);
  assert.deepEqual(
    store.hookLog("dc", 10).map((l) => l.kind),
    ["handshake"],
  );
  // Slack's url_verification: verified first (mac), then the challenge.
  const raw = JSON.stringify({ type: "url_verification", challenge: "c-1" });
  const ts = String(Math.floor(clock.now / 1000));
  const sig = createHmac("sha256", "slack-secret").update(`v0:${ts}:${raw}`).digest("hex");
  const slackAnswer = await door.deliver(
    "sl",
    new Headers({
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
      "content-type": "application/json",
    }),
    body(raw),
  );
  assert.deepEqual(slackAnswer, { status: 200, body: { challenge: "c-1" } });
  await host.close();
});

test("a mac Hook: the door builds the signed bytes and the Instance Effector's answer decides", async () => {
  const { host, door, runId } = await setup();
  macChecks.length = 0;
  const review = {
    action: "submitted",
    sender: { login: "bo" },
    review: { state: "approved", body: null, user: { login: "bo" }, commit_id: "abc" },
    pull_request: { html_url: PR },
  };
  const bad = githubDelivery("g-1", review, "another-secret");
  assert.equal((await door.deliver("gh", bad.headers, bad.body)).status, 401);
  const good = githubDelivery("g-2", review);
  const answer = await door.deliver("gh", good.headers, good.body);
  assert.equal(answer.status, 200);
  assert.equal(outcome(answer.body).delivered.length, 1);
  assert.deepEqual(macChecks.at(-1), { secret: "GH_HOOK", bytes: JSON.stringify(review) });
  assert.equal((await host.read(runId))?.status, "done");
  await host.close();
});

test("a mac Hook with no Instance Effector answers 503, and one that does not answer 503 too", async () => {
  const { host, door } = await setup({ mac: undefined });
  const d = githubDelivery("g-1", { action: "submitted" });
  assert.equal((await door.deliver("gh", d.headers, d.body)).status, 503);
  const failing = hookDoor({
    host,
    store: await mkStore(),
    hooks: () => ({ gh: github({ secret: secret("GH_HOOK") }) }),
    digests: () => ({}),
    mac: async () => {
      throw new Error("no replica");
    },
  });
  assert.equal((await failing.deliver("gh", d.headers, d.body)).status, 503);
  await host.close();
});

test("a payload that the parse refuses reaches no handler, is 200, and is parsed again when it comes again", async () => {
  const { host, door, store, runId } = await setup();
  seen.length = 0;
  const payload = {
    object_kind: "merge_request",
    user: { username: "ann" },
    object_attributes: { action: "approved" },
  };
  const send = () =>
    door.deliver("gl", new Headers({ "x-gitlab-token": GL_SECRET, "idempotency-key": "bad-1" }), body(payload));
  const first = await send();
  assert.equal(first.status, 200);
  const o = outcome(first.body);
  assert.equal(o.seen, false);
  assert.equal(o.payloadRefused?.kind, "gitlab");
  assert.equal(o.payloadRefused?.key, "merge_request.approved");
  assert.ok(o.payloadRefused?.issues.length);
  assert.equal(seen.length, 0, "no handler heard it");
  const again = outcome((await send()).body);
  assert.equal(again.seen, false, "a refused payload never claims its id");
  assert.ok(again.payloadRefused);
  assert.deepEqual(
    store.hookLog("gl", 10).map((l) => l.kind),
    ["payload-refused", "payload-refused"],
  );
  assert.equal((await host.read(runId))?.status, "active");
  await host.close();
});

test("a repeat by id, or by the body's digest, is seen and delivers nothing", async () => {
  const { host, door, store } = await setup();
  // Another PR's approval: the handler ignores it, and the Gate stays open.
  const d = gitlabDelivery("r-1", "https://forge.example.com/pr/9");
  const first = outcome((await door.deliver("gl", d.headers, d.body)).body);
  assert.equal(first.seen, false);
  assert.equal(first.ignored, 1);
  const byId = gitlabDelivery("r-1", "https://forge.example.com/pr/8");
  assert.equal(outcome((await door.deliver("gl", byId.headers, byId.body)).body).seen, true);
  const byDigest = { headers: new Headers(d.headers), body: d.body };
  byDigest.headers.set("idempotency-key", "r-2");
  assert.equal(outcome((await door.deliver("gl", byDigest.headers, byDigest.body)).body).seen, true);
  assert.deepEqual(
    store.hookLog("gl", 10).map((l) => l.kind),
    ["seen", "seen", "delivered"],
  );
  await host.close();
});

test("may.answer limits the Workflows a Hook reaches", async () => {
  const { host, door, runId } = await setup({ may: ["other"] });
  const d = gitlabDelivery("m-1");
  const o = outcome((await door.deliver("gl", d.headers, d.body)).body);
  assert.deepEqual(o.delivered, []);
  assert.equal(o.ignored, 0);
  assert.equal((await host.read(runId))?.status, "active");
  await host.close();
});

test("a handler that throws, an event not in delivers, and one the run does not take now are refused and mark the feed", async () => {
  const { host, door, runId, feed } = await setup();
  const note = (id: string, text: string) => ({
    headers: new Headers({ "x-gitlab-token": GL_SECRET, "idempotency-key": id }),
    body: body({
      object_kind: "note",
      user: { username: "cy" },
      object_attributes: { noteable_type: "MergeRequest", note: text },
      merge_request: { url: PR },
    }),
  });
  for (const [id, text, reason] of [
    ["n-1", "throw", /its handler threw: the note says throw/],
    ["n-2", "bogus", /"bogus", which is not in the Gate's delivers/],
    ["n-3", "reject", /does not take "reject" now/],
  ] as const) {
    const d = note(id, text);
    const o = outcome((await door.deliver("gl", d.headers, d.body)).body);
    assert.equal(o.delivered.length, 0);
    assert.equal(o.refused.length, 1);
    assert.match(o.refused[0]!.reason, reason);
  }
  const marks = feed.filter((e) => e.kind === "hook-refused");
  assert.equal(marks.length, 3);
  assert.deepEqual(
    marks.map((m) => (m as { delivery: string }).delivery),
    ["n-1", "n-2", "n-3"],
  );
  assert.equal((await host.read(runId))?.status, "active", "a bad delivery never faults the run");
  await host.close();
});

test("a Gate that already took a delivery is passed over when the same delivery comes to it again", async () => {
  const { host, runId } = await setup();
  const d = {
    hook: "gl",
    kind: "gitlab",
    key: "note.MergeRequest",
    delivery: "x-1",
    payload: { user: { username: "a" }, object_attributes: { note: "reject" }, merge_request: { url: PR } },
    caller: { via: "hook" as const, name: "gl" },
    may: () => true,
  };
  // Seed the pair, as a restore would have it from the blob.
  const live = (host as unknown as { runs: Map<string, { answers: unknown[] }> }).runs.get(runId)!;
  live.answers.push({ gate: "inReview", type: "approve", at: "", answeredBy: d.caller, delivery: "x-1" });
  const fan = await host.deliverHook(d);
  assert.deepEqual(fan, { delivered: [], refused: [], ignored: 0, sources: [] });
  await host.close();
});

test("no current Assembly is 503; a name the config does not declare is 404", async () => {
  const { host, door } = await setup();
  const none = hookDoor({ host, store: await mkStore(), hooks: () => undefined, digests: () => ({}) });
  const d = gitlabDelivery("z-1");
  assert.equal((await none.deliver("gl", d.headers, d.body)).status, 503);
  assert.equal((await door.deliver("nope", d.headers, d.body)).status, 404);
  assert.equal((await door.deliver("constructor", d.headers, d.body)).status, 404);
  await host.close();
});

test("a body above 2 MiB is 413 before the verifier: the log keeps a too-large line that claims no id", async () => {
  const { host, door, store, runId } = await setup();
  const big = gitlabDelivery("big-1");
  const pad = new Uint8Array(HOOK_BODY_MAX + 1 - big.body.byteLength).fill(0x20);
  const oversize = new Uint8Array([...big.body, ...pad]);
  // A wrong token too: the size comes first, so the answer is 413, not 401.
  const wrong = gitlabDelivery("big-1", PR, "ann", "not-the-token");
  assert.equal((await door.deliver("gl", wrong.headers, oversize)).status, 413);
  const answer = await door.deliver("gl", big.headers, oversize);
  assert.equal(answer.status, 413);
  assert.match(JSON.stringify(answer.body), /larger than 2097152 bytes/);
  // A mac Hook sends nothing to the Instance Effector for it.
  const before = macChecks.length;
  assert.equal((await door.deliver("gh", new Headers(), oversize)).status, 413);
  assert.equal(macChecks.length, before);
  const lines = store.hookLog("gl", 10);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.status, l.delivery, l.digest]),
    [
      ["too-large", 413, undefined, undefined],
      ["too-large", 413, undefined, undefined],
    ],
  );
  // No id was claimed: the same delivery at a size the door reads is delivered.
  const ok = await door.deliver("gl", big.headers, big.body);
  assert.equal(ok.status, 200);
  assert.equal((ok.body as unknown as HookOutcome).delivered[0]?.run, runId);
  // A reader that says the body is too long is the same refusal.
  assert.equal((await door.deliver("gl", big.headers, async () => undefined)).status, 413);
  await host.close();
});

test("the door reads no more of a body than its limit: a content-length above it reads nothing, a stream is cut", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const req = new Request("http://x/hooks/gl", { method: "POST", body: endless, duplex: "half" } as RequestInit);
  assert.equal(await limitedBody(req)(HOOK_BODY_MAX), undefined);
  assert.ok(pulled <= HOOK_BODY_MAX + 4 * chunk.byteLength, `read ${pulled} bytes of an endless body`);

  let touched = false;
  const declared = new Request("http://x/hooks/gl", {
    method: "POST",
    headers: { "content-length": String(HOOK_BODY_MAX + 1) },
    body: new ReadableStream(
      {
        pull() {
          touched = true;
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: "half",
  } as RequestInit);
  assert.equal(await limitedBody(declared)(HOOK_BODY_MAX), undefined);
  assert.equal(touched, false, "a content-length above the limit reads nothing");

  const small = new Request("http://x/hooks/gl", { method: "POST", body: "hello" });
  assert.equal(new TextDecoder().decode(await limitedBody(small)(HOOK_BODY_MAX)), "hello");
});

test("the routes: POST takes no bearer and answers the door; GET is the Instance token's alone", async () => {
  const { host, door } = await setup();
  const instanceToken = mintInstanceToken();
  const app = createApp(host, createAuthenticator({ instanceToken, signingKey: Buffer.alloc(32, 1) }), {
    hooks: door,
  });
  const d = gitlabDelivery("h-1");
  const posted = await app.request("/hooks/gl", { method: "POST", headers: d.headers, body: d.body });
  assert.equal(posted.status, 200);
  assert.equal(((await posted.json()) as HookOutcome).delivered.length, 1);
  const bearerOnly = await app.request("/hooks/gl", {
    method: "POST",
    headers: { authorization: `Bearer ${instanceToken}` },
    body: "{}",
  });
  assert.equal(bearerOnly.status, 401, "the Instance token is not a Hook's credential");
  assert.equal((await app.request("/hooks/gl")).status, 401);
  const log = await app.request("/hooks/gl?limit=5", { headers: { authorization: `Bearer ${instanceToken}` } });
  assert.equal(log.status, 200);
  const read = (await log.json()) as { declared: boolean; lines: Array<{ kind: string; delivery?: string }> };
  assert.equal(read.declared, true);
  assert.deepEqual(
    read.lines.map((l) => [l.kind, l.delivery]),
    [["delivered", "h-1"]],
  );
  const badLimit = await app.request("/hooks/gl?limit=0", { headers: { authorization: `Bearer ${instanceToken}` } });
  assert.equal(badLimit.status, 400);
  const tooLarge = await app.request("/hooks/gl", {
    method: "POST",
    headers: d.headers,
    body: new Uint8Array(HOOK_BODY_MAX + 1),
  });
  assert.equal(tooLarge.status, 413, "the route reads the body through the door's limit");
  await host.close();
});

test("the mac client speaks the Instance Effector's signed wire, and refuses an answer it did not sign", async () => {
  const key = "effector-key";
  const sent: Array<{ path: string; body: string }> = [];
  const transport = (signWith: string) => ({
    replicas: async () => ["10.0.0.1:9000"],
    send: async (_address: string, _method: string, path: string, headers: Record<string, string>, b: string) => {
      sent.push({ path, body: b });
      const reqBody = JSON.parse(b) as { bytes: string; signature: string };
      const want = createHmac("sha256", "s").update(Buffer.from(reqBody.bytes, "base64")).digest("base64");
      const answer = JSON.stringify({ match: want === reqBody.signature });
      return {
        status: 200,
        headers: { [HEADER_SIGNATURE]: responseMac(signWith, 200, "POST", path, headers[HEADER_NONCE]!, answer) },
        body: answer,
      };
    },
  });
  const mac = createMacClient({ key, transport: transport(key) });
  const bytes = new TextEncoder().encode("signed");
  const good = createHmac("sha256", "s").update(bytes).digest();
  assert.equal(await mac({ secret: "S", alg: "sha256", bytes, signature: good }), true);
  assert.equal(await mac({ secret: "S", alg: "sha256", bytes, signature: new Uint8Array(32) }), false);
  assert.equal(sent[0]!.path, MAC_PATH);
  assert.deepEqual(Object.keys(JSON.parse(sent[0]!.body) as object), ["secret", "alg", "bytes", "signature"]);
  const forged = createMacClient({ key, transport: transport("another-key") });
  await assert.rejects(forged({ secret: "S", alg: "sha256", bytes, signature: good }), EffectorForged);
});
