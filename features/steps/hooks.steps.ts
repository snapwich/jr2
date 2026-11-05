// The Hook's door (ADR-0011, ADR-0078), driven black-box: the instance's `jr2.config.ts` declares
// three Hooks, one for each verifier, and each step sends a service's request to
// `POST /hooks/<name>` as the service would.
//
// - `gitlab` (`token`): the server gets the digest of the token alone, in the file that
//   `JR2_HOOK_DIGESTS` names, as `jr2 up` mounts it.
// - `discord` (`ed25519`): a key pair made in the test; the config holds the public key.
// - `github` (`mac`): this tier has no Instance Effector, so the scenario serves a fake one that
//   speaks the signed wire (`JR2_INSTANCE_EFFECTOR`) and holds the secret. It checks the request's
//   signature, records the bytes that the Orchestrator built, and answers "match" or "no match".
// - `slack` (`mac`, through the same fake Effector): a command and a click, whose answer a person
//   reads. The fake Effector is also the stubbed follow-up transport: it takes the `http` call that
//   posts a click's reply (`POST /effects/<id>`), records it, and answers that it settled with 200.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  effectorKey,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIME,
  MAC_PATH,
  requestMac,
  responseMac,
} from "@jr2/orchestrator/internal";
import { E2EWorld } from "./world.ts";

/** What the scenario's Hooks hold, and what they saw. */
type HookFixture = {
  gitlabToken: string;
  githubSecret: string;
  discord: { privateKey: KeyObject; publicHex: string };
  /** The bytes each `mac` check asked about, in order, as UTF-8. */
  macBytes: string[];
  slackSecret: string;
  /** Each follow-up post that the fake Effector took: its url and its JSON body. */
  posts: Array<{ url: string; json: unknown }>;
  /** The last answer of the door. */
  answer?: { status: number; body: unknown };
};

const fixtures = new WeakMap<E2EWorld, HookFixture>();

function fixtureOf(world: E2EWorld): HookFixture {
  const f = fixtures.get(world);
  assert.ok(f, "the instance declares its Hooks first");
  return f;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A fake Instance Effector that answers `POST /mac` on the signed wire (ADR-0068). It reads the
 * instance's signing key when asked, because the server mints it at its first boot. */
async function fakeEffector(world: E2EWorld, f: HookFixture): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const signing = Buffer.from(await readFile(join(world.dir, ".jr2", "secret"), "utf8"), "base64");
        const key = effectorKey(signing, "instance");
        const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
        const header = (n: string): string => String(req.headers[n] ?? "");
        const want = requestMac(key, "POST", address, MAC_PATH, header(HEADER_TIME), header(HEADER_NONCE), body);
        const send = (status: number, answer: unknown): void => {
          const text = JSON.stringify(answer);
          res.writeHead(status, {
            "content-type": "application/json",
            [HEADER_SIGNATURE]: responseMac(key, status, "POST", MAC_PATH, header(HEADER_NONCE), text),
          });
          res.end(text);
        };
        const path = req.url ?? "";
        if (path.startsWith("/effects/")) {
          // The follow-up: one `http` call with no secret (ADR-0068).
          const wantEffect = requestMac(key, "POST", address, path, header(HEADER_TIME), header(HEADER_NONCE), body);
          const sendAt = (status: number, answer: unknown): void => {
            const text = JSON.stringify(answer);
            res.writeHead(status, {
              "content-type": "application/json",
              [HEADER_SIGNATURE]: responseMac(key, status, "POST", path, header(HEADER_NONCE), text),
            });
            res.end(text);
          };
          if (header(HEADER_SIGNATURE) !== wantEffect) return sendAt(400, { error: "not signed" });
          const start = JSON.parse(body) as { url: Array<{ text: string }>; body: { json: unknown } };
          f.posts.push({ url: start.url.map((p) => p.text).join(""), json: start.body.json });
          return sendAt(200, {
            effect: decodeURIComponent(path.slice("/effects/".length)),
            replica: { name: "fake", address },
            state: "settled",
            output: { outcome: "response", status: 200, headers: {}, contentType: "text/plain", size: 0 },
          });
        }
        if (path !== MAC_PATH || header(HEADER_SIGNATURE) !== want) return send(400, { error: "not signed" });
        const mac = JSON.parse(body) as { secret: string; alg: string; bytes: string; signature: string };
        const bytes = Buffer.from(mac.bytes, "base64");
        f.macBytes.push(bytes.toString("utf8"));
        const value = mac.secret === "GH_HOOK" ? f.githubSecret : mac.secret === "SLACK_SIGNING" ? f.slackSecret : "";
        const computed = createHmac(mac.alg, value).update(bytes).digest("base64");
        send(200, { match: value !== "" && computed === mac.signature });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

Given("the instance declares a Hook for each verifier", async function (this: E2EWorld): Promise<void> {
  const keys = generateKeyPairSync("ed25519");
  const publicHex = Buffer.from((keys.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString(
    "hex",
  );
  const f: HookFixture = {
    gitlabToken: randomBytes(16).toString("hex"),
    githubSecret: randomBytes(16).toString("hex"),
    discord: { privateKey: keys.privateKey, publicHex },
    macBytes: [],
    slackSecret: randomBytes(16).toString("hex"),
    posts: [],
  };
  fixtures.set(this, f);
  const config = join(this.dir, "jr2.config.ts");
  const text = await readFile(config, "utf8");
  const declared =
    'import { secret } from "@jr2/orchestrator";\n' +
    'import { discord } from "@jr2/hooks/discord";\n' +
    'import { github } from "@jr2/hooks/github";\n' +
    'import { gitlab } from "@jr2/hooks/gitlab";\n' +
    'import { slack } from "@jr2/hooks/slack";\n' +
    text.replace(
      "export default defineConfig({",
      "export default defineConfig({\n" +
        // Each Hook's secret is an entry of the list, or the publish is refused (ADR-0068, ADR-0078).
        "  secrets: [\n" +
        `    { name: "GH_HOOK", value: "${f.githubSecret}" },\n` +
        `    { name: "SLACK_SIGNING", value: "${f.slackSecret}" },\n` +
        `    { name: "GL_HOOK", value: "${f.gitlabToken}" },\n` +
        "  ],\n" +
        "  hooks: {\n" +
        '    gitlab: gitlab({ secret: secret("GL_HOOK") }),\n' +
        `    discord: discord({ publicKey: "${publicHex}" }),\n` +
        '    github: github({ secret: secret("GH_HOOK") }),\n' +
        '    slack: slack({ secret: secret("SLACK_SIGNING") }),\n' +
        '    elsewhere: gitlab({ secret: secret("GL_HOOK"), may: { answer: ["other"] } }),\n' +
        "  },",
    );
  assert.notEqual(declared.length, text.length);
  await writeFile(config, declared);
  // As `jr2 up` mounts it: the digest of the token Hook's secret, never its value.
  const digests = join(this.dir, ".jr2-hook-digests.json");
  await writeFile(digests, JSON.stringify({ GL_HOOK: sha256(f.gitlabToken) }));
  this.serverEnv.JR2_HOOK_DIGESTS = digests;
  const effector = await fakeEffector(this, f);
  this.closers.push(() => new Promise<void>((resolve) => effector.close(() => resolve())));
  this.serverEnv.JR2_INSTANCE_EFFECTOR = `127.0.0.1:${(effector.address() as AddressInfo).port}`;
});

When(
  "I start the {string} workflow for the pull request {string}",
  async function (this: E2EWorld, wf: string, pr: string): Promise<void> {
    const r = await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ pr })]);
    assert.equal(r.code, 0, `jr2 run failed: ${r.stderr}`);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

/** Send one request to the Hook's door, as the service does, and keep the answer. */
async function post(world: E2EWorld, name: string, headers: Record<string, string>, body: string): Promise<void> {
  assert.ok(world.server, "the orchestrator is serving");
  const res = await fetch(`${world.server.url}/hooks/${name}`, { method: "POST", headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // a text answer stays text
  }
  fixtureOf(world).answer = { status: res.status, body: parsed };
}

function gitlabBody(pr: string, by: string, complete = true): string {
  return JSON.stringify({
    object_kind: "merge_request",
    user: { username: by },
    object_attributes: complete
      ? { action: "approved", url: pr, last_commit: { id: "c0ffee" } }
      : { action: "approved" },
  });
}

When(
  "GitLab sends the delivery {string} that {string} approved {string} to the Hook {string}",
  async function (this: E2EWorld, id: string, by: string, pr: string, hook: string): Promise<void> {
    const f = fixtureOf(this);
    await post(
      this,
      hook,
      { "x-gitlab-token": f.gitlabToken, "idempotency-key": id, "content-type": "application/json" },
      gitlabBody(pr, by),
    );
  },
);

When(
  "GitLab sends the delivery {string} with a wrong token to the Hook {string}",
  async function (this: E2EWorld, id: string, hook: string): Promise<void> {
    await post(this, hook, { "x-gitlab-token": "not-the-token", "idempotency-key": id }, gitlabBody("x", "mallory"));
  },
);

When(
  "GitLab sends the delivery {string} with an approval that has no url to the Hook {string}",
  async function (this: E2EWorld, id: string, hook: string): Promise<void> {
    const f = fixtureOf(this);
    await post(this, hook, { "x-gitlab-token": f.gitlabToken, "idempotency-key": id }, gitlabBody("", "ann", false));
  },
);

/** A Discord interaction, signed over its timestamp and body. */
async function discordSend(world: E2EWorld, payload: unknown, opts: { ageS?: number; key?: KeyObject } = {}) {
  const f = fixtureOf(world);
  const at = String(Math.floor(Date.now() / 1000) - (opts.ageS ?? 0));
  const raw = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(at + raw), opts.key ?? f.discord.privateKey).toString("hex");
  await post(world, "discord", { "x-signature-ed25519": sig, "x-signature-timestamp": at }, raw);
}

const approveCommand = (id: string, pr: string, by: string) => ({
  type: 2,
  id,
  channel_id: "c-1",
  member: { user: { id: by } },
  data: { name: "approve", options: [{ name: "pr", value: pr }] },
});

When("Discord sends a PING", async function (this: E2EWorld): Promise<void> {
  await discordSend(this, { type: 1, id: "ping-1" });
});

When(
  "Discord sends the command {string} by {string} to approve {string}",
  async function (this: E2EWorld, id: string, by: string, pr: string): Promise<void> {
    await discordSend(this, approveCommand(id, pr, by));
  },
);

When(
  "Discord sends the command {string} signed by another key",
  async function (this: E2EWorld, id: string): Promise<void> {
    await discordSend(this, approveCommand(id, "x", "u"), { key: generateKeyPairSync("ed25519").privateKey });
  },
);

When(
  "Discord sends the command {string} signed {int} seconds ago",
  async function (this: E2EWorld, id: string, age: number): Promise<void> {
    await discordSend(this, approveCommand(id, "x", "u"), { ageS: age });
  },
);

/** A GitHub delivery, signed with `secret` over the raw body. */
async function githubSend(world: E2EWorld, event: string, id: string, payload: unknown, secret: string) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(raw).digest("hex");
  await post(
    world,
    "github",
    {
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-event": event,
      "x-github-delivery": id,
      "content-type": "application/json",
    },
    raw,
  );
}

const reviewPayload = (pr: string, by: string) => ({
  action: "submitted",
  sender: { login: by },
  review: { state: "approved", body: null, user: { login: by }, commit_id: "c0ffee" },
  pull_request: { html_url: pr },
});

When("GitHub sends a ping", async function (this: E2EWorld): Promise<void> {
  await githubSend(this, "ping", "gh-ping", { zen: "Keep it logically awesome." }, fixtureOf(this).githubSecret);
});

When(
  "GitHub sends the delivery {string} that {string} approved {string}",
  async function (this: E2EWorld, id: string, by: string, pr: string): Promise<void> {
    await githubSend(this, "pull_request_review", id, reviewPayload(pr, by), fixtureOf(this).githubSecret);
  },
);

When(
  "GitHub sends the delivery {string} signed with another secret",
  async function (this: E2EWorld, id: string): Promise<void> {
    await githubSend(this, "pull_request_review", id, reviewPayload("x", "mallory"), "another-secret");
  },
);

/** A Slack request, signed as Slack signs it: `v0:<timestamp>:<raw body>`. */
async function slackSend(world: E2EWorld, form: Record<string, string>): Promise<void> {
  const f = fixtureOf(world);
  const raw = new URLSearchParams(form).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", f.slackSecret).update(`v0:${ts}:${raw}`).digest("hex");
  await post(
    world,
    "slack",
    {
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
      "content-type": "application/x-www-form-urlencoded",
    },
    raw,
  );
}

When(
  "Slack sends the command {string} by {string} with the text {string}",
  async function (this: E2EWorld, trigger: string, by: string, text: string): Promise<void> {
    await slackSend(this, { command: "/jr2", text, user_id: by, channel_id: "C1", trigger_id: trigger });
  },
);

When(
  "Slack sends the click {string} by {string} on approve {string} with the response url {string}",
  async function (this: E2EWorld, trigger: string, by: string, pr: string, url: string): Promise<void> {
    const payload = {
      type: "block_actions",
      trigger_id: trigger,
      user: { id: by },
      actions: [{ action_id: "approve", value: pr }],
      response_url: url,
    };
    await slackSend(this, { payload: JSON.stringify(payload) });
  },
);

Then("the person reads {string} in Slack's ephemeral answer", function (this: E2EWorld, text: string): void {
  const a = fixtureOf(this).answer;
  assert.equal(a?.status, 200, `the door answered ${JSON.stringify(a)}`);
  assert.deepEqual(a?.body, { response_type: "ephemeral", text });
});

Then("the person reads {string} in Discord's ephemeral answer", function (this: E2EWorld, text: string): void {
  const a = fixtureOf(this).answer;
  assert.equal(a?.status, 200, `the door answered ${JSON.stringify(a)}`);
  assert.deepEqual(a?.body, { type: 4, data: { content: text, flags: 64 } });
});

Then(
  "the Instance Effector posts {string} to {string}",
  async function (this: E2EWorld, text: string, url: string): Promise<void> {
    const f = fixtureOf(this);
    const a = f.answer;
    assert.equal(a?.status, 200, `the door answered ${JSON.stringify(a)}`);
    assert.equal(a?.body, null, "the answer to a click is an empty 200");
    for (let i = 0; i < 200 && f.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(f.posts, [{ url, json: { response_type: "ephemeral", replace_original: false, text } }]);
  },
);

Then("the door answers {int}", function (this: E2EWorld, status: number): void {
  const a = fixtureOf(this).answer;
  assert.equal(a?.status, status, `the door answered ${JSON.stringify(a)}`);
});

Then("the door answers {int} with the body {string}", function (this: E2EWorld, status: number, body: string): void {
  const a = fixtureOf(this).answer;
  assert.equal(a?.status, status, `the door answered ${JSON.stringify(a)}`);
  assert.deepEqual(a?.body, JSON.parse(body));
});

type Outcome = {
  delivery: string;
  seen: boolean;
  delivered: Array<{ run: string; gate: string; event: string }>;
  refused: unknown[];
  ignored: number;
  payloadRefused?: { kind: string; key: string; issues: unknown[] };
};

const outcomeOf = (world: E2EWorld): Outcome => {
  const a = fixtureOf(world).answer;
  assert.equal(a?.status, 200, `the door answered ${JSON.stringify(a)}`);
  return a!.body as Outcome;
};

Then("the outcome delivered {string} to the run", function (this: E2EWorld, event: string): void {
  const o = outcomeOf(this);
  assert.equal(o.seen, false);
  assert.deepEqual(
    o.delivered.map((d) => [d.run, d.event]),
    [[this.runId, event]],
  );
});

Then("the outcome delivered nothing", function (this: E2EWorld): void {
  const o = outcomeOf(this);
  assert.deepEqual(o.delivered, []);
  assert.equal(o.seen, false);
});

Then("the outcome says the delivery was seen", function (this: E2EWorld): void {
  const o = outcomeOf(this);
  assert.equal(o.seen, true);
  assert.deepEqual(o.delivered, []);
});

Then(
  "the outcome says the parse refused the {string} payload {string}",
  function (this: E2EWorld, kind: string, key: string): void {
    const o = outcomeOf(this);
    assert.equal(o.seen, false, "a refused payload never claims its id");
    assert.equal(o.payloadRefused?.kind, kind);
    assert.equal(o.payloadRefused?.key, key);
    assert.ok(o.payloadRefused?.issues.length, "the answer carries zod's issues");
  },
);

Then(
  "the run was answered by the Hook {string} on behalf of {string}",
  async function (this: E2EWorld, hook: string, by: string): Promise<void> {
    const r = await this.runCli(["status", this.runId!]);
    assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
    const status = this.resultJson<{ status: string; answers?: Array<{ answeredBy: unknown; delivery?: string }> }>();
    assert.equal(status.status, "done");
    assert.deepEqual(status.answers?.[0]?.answeredBy, { via: "hook", name: hook, onBehalfOf: by });
  },
);

Then("the Instance Effector checked the raw body of the review", function (this: E2EWorld): void {
  const f = fixtureOf(this);
  assert.ok(f.macBytes.length > 0, "the Orchestrator asked the Instance Effector");
  assert.match(f.macBytes.at(-1)!, /^\{"action":"submitted"/, "the bytes are the raw body, as GitHub signs it");
});

Then(
  "`jr2 hooks {word}` shows the lines {string}",
  async function (this: E2EWorld, hook: string, kinds: string): Promise<void> {
    const r = await this.runCli(["hooks", hook]);
    assert.equal(r.code, 0, `jr2 hooks failed: ${r.stderr}`);
    const log = this.resultJson<{ declared: boolean; lines: Array<{ kind: string }> }>();
    assert.equal(log.declared, true);
    assert.deepEqual(
      log.lines.map((l) => l.kind),
      kinds.split(",").map((k) => k.trim()),
    );
  },
);
