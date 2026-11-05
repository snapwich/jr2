// jr2's kinds, each against fixture bodies in the service's own shape (ADR-0078): what the service
// signed (checked with a real HMAC or Ed25519 signature over the bytes the kind gives), the
// handshake, the event key, the delivery id, `onBehalfOf`, the parse by the kind's schema, and the
// envelope of a text that a person reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import type { Delivery, Handshake, HookKind, HookRequest, Signed, Unsigned } from "@jr2/hooks";
import { hookRequest, schemaFor, signatureBytes, signedBytes } from "@jr2/hooks/door";
import { discord } from "@jr2/hooks/discord";
import { github } from "@jr2/hooks/github";
import { gitlab } from "@jr2/hooks/gitlab";
import { slack } from "@jr2/hooks/slack";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const request = (headers: Record<string, string>, text: string, strip?: string): HookRequest =>
  hookRequest(headers, enc(text), strip);

function signedOf(kind: HookKind, req: HookRequest): Signed {
  const v = kind.verify;
  const out: Signed | Unsigned =
    "mac" in v ? v.mac.signed(req) : "ed25519" in v ? v.ed25519.signed(req) : assert.fail();
  if ("unsigned" in out) assert.fail(`unsigned: ${out.unsigned}`);
  return out;
}

function unsignedOf(kind: HookKind, req: HookRequest): string {
  const v = kind.verify;
  const out = "mac" in v ? v.mac.signed(req) : "ed25519" in v ? v.ed25519.signed(req) : assert.fail();
  assert.ok("unsigned" in out, "the request is unsigned");
  return out.unsigned;
}

/** What the Instance Effector does for `mac`: an HMAC over the bytes, compared with the signature. */
function macMatches(kind: HookKind, secret: string, signed: Signed): boolean {
  assert.ok("mac" in kind.verify);
  const mac = createHmac(kind.verify.mac.alg, secret).update(signedBytes(signed)).digest();
  const sig = signatureBytes(signed);
  return sig !== undefined && Buffer.compare(mac, sig) === 0;
}

function delivery(kind: HookKind, req: HookRequest): Delivery {
  const out = kind.read(req);
  assert.ok(!("handshake" in out), "a delivery, not a handshake");
  return out;
}

function handshake(kind: HookKind, req: HookRequest): Handshake {
  const out = kind.read(req);
  assert.ok("handshake" in out, "a handshake");
  return out;
}

/** The door's parse: the schema of the key, then zod. */
function parse(kind: HookKind, d: Delivery): { success: boolean; data?: unknown } {
  const schema = schemaFor(kind, d.key);
  assert.ok(schema, `the ${kind.id} kind has a schema for ${d.key}`);
  return schema.safeParse(d.payload);
}

// ── github ────────────────────────────────────────────────────────────────────────────────────

const GH_SECRET = "It's a Secret to Everybody";
const review = JSON.stringify({
  action: "submitted",
  review: {
    id: 80,
    state: "approved",
    body: null,
    user: { login: "ada", id: 1 },
    commit_id: "9049f1265b7d61be4a8904a9a27120d2064dab3b",
  },
  pull_request: { number: 7, html_url: "https://github.com/acme/app/pull/7" },
  repository: { full_name: "acme/app" },
  sender: { login: "ada", id: 1 },
});
const ghHeaders = (event: string, text: string): Record<string, string> => ({
  "X-GitHub-Event": event,
  "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "X-Hub-Signature-256": `sha256=${createHmac("sha256", GH_SECRET).update(text).digest("hex")}`,
  "Content-Type": "application/json",
});

test("github: the signature is an HMAC-SHA256 of the raw body", () => {
  const req = request(ghHeaders("pull_request_review", review), review);
  const signed = signedOf(github, req);
  assert.equal(signed.at, undefined, "GitHub signs no timestamp");
  assert.ok(macMatches(github, GH_SECRET, signed));
  assert.ok(!macMatches(github, "another secret", signed));
  // GitHub's own example from its docs: the secret and payload above give this signature.
  const doc = signedOf(
    github,
    request(
      {
        "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      },
      "Hello, World!",
    ),
  );
  assert.ok(macMatches(github, GH_SECRET, doc));
  assert.match(unsignedOf(github, request({ "x-hub-signature": "sha1=00" }, review)), /X-Hub-Signature-256/);
});

test("github: a review's key, id, onBehalfOf and parsed payload", () => {
  const d = delivery(github, request(ghHeaders("pull_request_review", review), review));
  assert.equal(d.key, "pull_request_review.submitted");
  assert.equal(d.id, "72d3162e-cc78-11e3-81ab-4c9367dc0958");
  assert.equal(d.onBehalfOf, "ada");
  assert.equal(d.readBy, undefined, "the service reads the answer");
  const parsed = parse(github, d);
  assert.ok(parsed.success);
  const p = parsed.data as { review: { state: string; id: number }; repository: unknown };
  assert.equal(p.review.state, "approved");
  assert.equal(p.review.id, 80, "a loose object keeps the fields that it does not name");
});

test("github: ping is a handshake, an event with no action is its name, and a bad body fails the parse", () => {
  assert.deepEqual(handshake(github, request(ghHeaders("ping", "{}"), '{"zen":"Keep it logically awesome."}')), {
    handshake: { body: null },
  });
  const push = '{"ref":"refs/heads/main","sender":{"login":"bo"}}';
  const d = delivery(github, request(ghHeaders("push", push), push));
  assert.equal(d.key, "push");
  assert.equal(schemaFor(github, d.key), undefined, "no schema: the door reaches nothing with it");
  const bad = JSON.stringify({ action: "submitted", review: { state: 1 }, sender: { login: "ada" } });
  assert.equal(parse(github, delivery(github, request(ghHeaders("pull_request_review", bad), bad))).success, false);
  assert.throws(() => github.read(request({ "x-github-event": "push" }, push)), /x-github-delivery/);
  assert.throws(() => github.read(request(ghHeaders("push", "x"), "payload=%7B%7D")), /not JSON/);
});

test("github: a comment on a pull request and a finished check suite parse", () => {
  const comment = JSON.stringify({
    action: "created",
    comment: { id: 5, body: "/retry", user: { login: "bo" }, author_association: "MEMBER" },
    issue: { number: 7, pull_request: { html_url: "https://github.com/acme/app/pull/7" } },
    sender: { login: "bo" },
  });
  const c = delivery(github, request(ghHeaders("issue_comment", comment), comment));
  assert.equal(c.key, "issue_comment.created");
  assert.ok(parse(github, c).success);
  const suite = JSON.stringify({
    action: "completed",
    check_suite: { head_sha: "9049f12", conclusion: "success", status: "completed" },
    sender: { login: "github-actions[bot]" },
  });
  const s = delivery(github, request(ghHeaders("check_suite", suite), suite));
  assert.equal(s.key, "check_suite.completed");
  assert.equal(s.onBehalfOf, "github-actions[bot]");
  assert.ok(parse(github, s).success);
});

// ── gitlab ────────────────────────────────────────────────────────────────────────────────────

const mrApproved = JSON.stringify({
  object_kind: "merge_request",
  event_type: "merge_request",
  user: { id: 1, name: "Ada", username: "ada" },
  object_attributes: {
    action: "approved",
    state: "opened",
    url: "https://gitlab.example.com/acme/app/-/merge_requests/7",
    last_commit: { id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7" },
  },
});
const glHeaders = {
  "X-Gitlab-Event": "Merge Request Hook",
  "X-Gitlab-Token": "the-shared-token",
  "X-Gitlab-Event-UUID": "13792a34-cac6-4fda-95a8-c58e00a3954e",
  "Idempotency-Key": "f7d1a7e5-0e66-4a1f-8d8c-2d4b8b6f1d2e",
  "Content-Type": "application/json",
};

test("gitlab: the token verifier names its header, and the door removes it before read", () => {
  assert.deepEqual(gitlab.verify, { token: { header: "x-gitlab-token" } });
  const req = request(glHeaders, mrApproved, gitlab.verify.token.header);
  assert.equal(req.headers["x-gitlab-token"], undefined);
  const d = delivery(gitlab, req);
  assert.ok(!JSON.stringify(d).includes("the-shared-token"));
});

test("gitlab: the key, the id (Idempotency-Key, else the event UUID) and onBehalfOf", () => {
  const d = delivery(gitlab, request(glHeaders, mrApproved, "x-gitlab-token"));
  assert.equal(d.key, "merge_request.approved");
  assert.equal(d.id, "f7d1a7e5-0e66-4a1f-8d8c-2d4b8b6f1d2e");
  assert.equal(d.onBehalfOf, "ada");
  assert.ok(parse(gitlab, d).success);
  const { "Idempotency-Key": _, ...older } = glHeaders;
  assert.equal(delivery(gitlab, request(older, mrApproved)).id, "13792a34-cac6-4fda-95a8-c58e00a3954e");
  const { "X-Gitlab-Event-UUID": __, ...none } = older;
  assert.throws(() => gitlab.read(request(none, mrApproved)), /Idempotency-Key/);
});

test("gitlab: a note's key is its noteable type, a pipeline's is its status", () => {
  const note = JSON.stringify({
    object_kind: "note",
    user: { username: "bo" },
    object_attributes: { note: "/retry", noteable_type: "MergeRequest", action: "create" },
    merge_request: { url: "https://gitlab.example.com/acme/app/-/merge_requests/7" },
  });
  const n = delivery(gitlab, request(glHeaders, note));
  assert.equal(n.key, "note.MergeRequest");
  assert.ok(parse(gitlab, n).success);
  const pipeline = JSON.stringify({
    object_kind: "pipeline",
    user: { username: "bo" },
    object_attributes: { sha: "da15608", status: "success" },
  });
  const p = delivery(gitlab, request(glHeaders, pipeline));
  assert.equal(p.key, "pipeline.success");
  assert.ok(parse(gitlab, p).success);
  const bare = '{"object_kind":"push"}';
  assert.equal(delivery(gitlab, request(glHeaders, bare)).key, "push");
  assert.throws(() => gitlab.read(request(glHeaders, "{}")), /object_kind/);
});

// ── slack ─────────────────────────────────────────────────────────────────────────────────────

const SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
function slackHeaders(text: string, contentType: string, ts = "1531420618"): Record<string, string> {
  const sig = createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${text}`).digest("hex");
  return { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": `v0=${sig}`, "Content-Type": contentType };
}
const FORM = "application/x-www-form-urlencoded";

const command =
  "token=gIkuvaNzQIHg97ATvDxqgjtO&team_id=T0001&team_domain=example&channel_id=C2147483705&channel_name=test" +
  "&user_id=U2147483697&user_name=Steve&command=%2Fjr2&text=fix+the+build" +
  "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1234%2F5678&trigger_id=13345224609.738474920.8088930838d88f008e0";

test("slack: the signature is an HMAC-SHA256 of v0:timestamp:body, and the timestamp is signed", () => {
  // Slack's own example from its docs (verifying requests from Slack).
  const doc =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V" +
    "&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=" +
    "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN" +
    "&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  const req = request(
    {
      "x-slack-request-timestamp": "1531420618",
      "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
      "content-type": FORM,
    },
    doc,
  );
  const signed = signedOf(slack, req);
  assert.equal(signed.at, 1531420618);
  assert.equal(new TextDecoder().decode(signedBytes(signed)), `v0:1531420618:${doc}`);
  assert.ok(macMatches(slack, SLACK_SECRET, signed));
  assert.match(unsignedOf(slack, request({ "x-slack-signature": "v0=00" }, doc)), /timestamp/);
  assert.match(
    unsignedOf(slack, request({ "x-slack-request-timestamp": "soon", "x-slack-signature": "v0=00" }, doc)),
    /timestamp/,
  );
});

test("slack: a slash command is a delivery that a person reads, keyed by its command", () => {
  const d = delivery(slack, request(slackHeaders(command, FORM), command));
  assert.equal(d.key, "slash_command./jr2");
  assert.equal(d.id, "13345224609.738474920.8088930838d88f008e0");
  assert.equal(d.onBehalfOf, "U2147483697");
  assert.equal(d.readBy, "person");
  const parsed = parse(slack, d);
  assert.ok(parsed.success);
  assert.equal((parsed.data as { text: string }).text, "fix the build");
  const noTrigger = command.replace(/&trigger_id=[^&]*/, "");
  assert.throws(() => slack.read(request(slackHeaders(noTrigger, FORM), noTrigger)), /trigger_id/);
});

const click = {
  type: "block_actions",
  trigger_id: "12466734323.1395872398",
  user: { id: "U0CA5", username: "ada", name: "ada" },
  channel: { id: "C2147483705" },
  message: { ts: "1548261231.000200" },
  response_url: "https://hooks.slack.com/actions/T0001/1234/abcd",
  actions: [{ type: "button", action_id: "approve", value: "run-1", block_id: "b1" }],
};

test("slack: a click is keyed by its action id, and its answer is an empty 200 and a post to its response_url", () => {
  const text = `payload=${encodeURIComponent(JSON.stringify(click))}`;
  const d = delivery(slack, request(slackHeaders(text, FORM), text));
  assert.equal(d.key, "block_actions.approve");
  assert.equal(d.id, "12466734323.1395872398");
  assert.equal(d.onBehalfOf, "U0CA5");
  assert.equal(d.readBy, "person");
  assert.ok(parse(slack, d).success);
  assert.deepEqual(slack.answer!("approved <run-1> & done", d), {
    body: null,
    then: {
      post: "https://hooks.slack.com/actions/T0001/1234/abcd",
      json: { response_type: "ephemeral", replace_original: false, text: "approved &lt;run-1&gt; &amp; done" },
    },
  });
  assert.ok(d.key.startsWith("block_actions.") && slack.posts!.some((p) => click.response_url.startsWith(p)));
  const elsewhere = { ...d, payload: { ...click, response_url: "https://evil.example.com/x" } };
  assert.deepEqual(slack.answer!("t", elsewhere), { body: null }, "no post to a host outside posts");
  const noUrl = { ...click, response_url: undefined };
  const t2 = `payload=${encodeURIComponent(JSON.stringify(noUrl))}`;
  assert.equal(parse(slack, delivery(slack, request(slackHeaders(t2, FORM), t2))).success, false);
});

test("slack: a command's answer is ephemeral, escaped text, cut by the door to the kind's limit", () => {
  const d = delivery(slack, request(slackHeaders(command, FORM), command));
  assert.deepEqual(slack.answer!("held <item> for a & b", d), {
    body: { response_type: "ephemeral", text: "held &lt;item&gt; for a &amp; b" },
  });
  assert.equal(slack.maxText, 4000);
  assert.deepEqual(slack.posts, ["https://hooks.slack.com/"]);
});

test("slack: url_verification is a handshake, and an event is a delivery that Slack reads", () => {
  const challenge = JSON.stringify({
    token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
    challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    type: "url_verification",
  });
  assert.deepEqual(handshake(slack, request(slackHeaders(challenge, "application/json"), challenge)), {
    handshake: { body: { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" } },
  });
  const mention = JSON.stringify({
    token: "z",
    team_id: "T0001",
    type: "event_callback",
    event_id: "Ev0PV52K21",
    event_time: 1531420618,
    event: {
      type: "app_mention",
      user: "U061F7AUR",
      text: "<@U0LAN0Z89> fix it",
      ts: "1515449522.000016",
      channel: "C0LAN2Q65",
    },
  });
  const d = delivery(slack, request(slackHeaders(mention, "application/json"), mention));
  assert.equal(d.key, "event_callback.app_mention");
  assert.equal(d.id, "Ev0PV52K21");
  assert.equal(d.onBehalfOf, "U061F7AUR");
  assert.equal(d.readBy, undefined, "Slack reads an event's answer, so a 503 stays a 503");
  assert.ok(parse(slack, d).success);
  const noId = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
  assert.throws(() => slack.read(request(slackHeaders(noId, "application/json"), noId)), /event_id/);
});

// ── discord ───────────────────────────────────────────────────────────────────────────────────

const keys = generateKeyPairSync("ed25519");
const publicHex = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");

function discordRequest(payload: unknown, ts = "1700000000"): HookRequest {
  const text = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(ts + text), keys.privateKey).toString("hex");
  return request({ "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts, "Content-Type": "application/json" }, text);
}

/** What the door does for `ed25519`: the signature over the bytes, against the public key. */
function edMatches(signed: Signed, hex: string): boolean {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]);
  const sig = signatureBytes(signed);
  return sig !== undefined && verify(null, signedBytes(signed), { key: der, format: "der", type: "spki" }, sig);
}

const commandInteraction = {
  type: 2,
  id: "1180000000000000001",
  application_id: "1170000000000000000",
  token: "interaction-token",
  channel_id: "1160000000000000000",
  guild_id: "1150000000000000000",
  member: { user: { id: "1140000000000000000", username: "ada" }, roles: [] },
  data: {
    id: "1130000000000000000",
    name: "jr2",
    type: 1,
    options: [{ name: "task", type: 3, value: "fix the build" }],
  },
};

test("discord: the signature is Ed25519 over timestamp + body, and the timestamp is signed", () => {
  const signed = signedOf(discord, discordRequest(commandInteraction));
  assert.equal(signed.at, 1700000000);
  assert.ok(edMatches(signed, publicHex));
  const other = generateKeyPairSync("ed25519");
  const otherHex = (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  assert.ok(!edMatches(signed, otherHex));
  assert.ok(discord({ publicKey: publicHex }), "a Discord Hook takes the public key as a literal");
  assert.match(unsignedOf(discord, request({ "x-signature-ed25519": "00" }, "{}")), /timestamp/);
});

test("discord: PING is a handshake that answers PONG", () => {
  assert.deepEqual(handshake(discord, discordRequest({ type: 1, id: "1", application_id: "2" })), {
    handshake: { body: { type: 1 } },
  });
});

test("discord: a command is keyed by its name, and its answer is an ephemeral message", () => {
  const d = delivery(discord, discordRequest(commandInteraction));
  assert.equal(d.key, "application_command.jr2");
  assert.equal(d.id, "1180000000000000001");
  assert.equal(d.onBehalfOf, "1140000000000000000");
  assert.equal(d.readBy, "person");
  assert.ok(parse(discord, d).success);
  assert.deepEqual(discord.answer!("held 1 item", d), {
    body: { type: 4, data: { content: "held 1 item", flags: 64 } },
  });
  assert.equal(discord.maxText, 2000);
  const dm = { ...commandInteraction, member: undefined, user: { id: "1100000000000000000" } };
  assert.equal(delivery(discord, discordRequest(dm)).onBehalfOf, "1100000000000000000", "a direct message");
});

test("discord: a component click is message_component; another type reaches nothing", () => {
  const click = {
    type: 3,
    id: "1180000000000000002",
    channel_id: "1160000000000000000",
    member: { user: { id: "1140000000000000000" } },
    message: { id: "1190000000000000000" },
    data: { custom_id: "approve:run-1", component_type: 2 },
  };
  const d = delivery(discord, discordRequest(click));
  assert.equal(d.key, "message_component");
  assert.ok(parse(discord, d).success);
  const auto = delivery(discord, discordRequest({ ...commandInteraction, type: 4 }));
  assert.equal(auto.key, "interaction.4");
  assert.equal(schemaFor(discord, auto.key), undefined);
  assert.throws(() => discord.read(discordRequest({ type: 2 })), /no id/);
});
