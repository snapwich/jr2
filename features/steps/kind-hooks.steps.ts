// @kind: the Hook door against the real Instance Effector (ADR-0068, ADR-0078). The kind instance
// declares two Hooks with a `mac` verifier — `forge` (GitHub) and `chat` (Slack's protocol, with a
// follow-up host the tier serves, `kind-instance/workflows/_chat.ts`) — so `jr2 up` places their
// secrets in the Instance Effector, which checks each signature and sends the click's follow-up.
// It also declares `lab` (GitLab), whose verifier is `token`: `jr2 up` mounts only the digest of its
// secret into the Orchestrator (`jr2-hook-digests`), and the door compares a delivery's token with it.
// The steps send each delivery to the Orchestrator over a port-forward, as a service outside the
// cluster does, signed with the scenario's secret or with its token in the header.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { issueLeaf, kubectlKube } from "@jr2/cli";
import { ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@jr2/orchestrator/internal";
import { isSettled } from "../lib/run-settled.ts";
import { E2EWorld, fakeProviderCa, kindHostAddress } from "./world.ts";

/** What one scenario's Hook steps saw: the door's last answer, and each follow-up post. */
type HookSeen = { answer?: { status: number; text: string }; posts: Array<{ path: string; json: unknown }> };

const seen = new WeakMap<E2EWorld, HookSeen>();

function seenOf(world: E2EWorld): HookSeen {
  let s = seen.get(world);
  if (!s) {
    s = { posts: [] };
    seen.set(world, s);
  }
  return s;
}

/** POST one delivery to `POST /hooks/<name>` over a port-forward to the Orchestrator. */
async function deliver(world: E2EWorld, hook: string, headers: Record<string, string>, body: string): Promise<void> {
  assert.ok(world.namespace, "a @kind scenario has its namespace");
  const fwd = await kubectlKube.portForward({
    namespace: world.namespace,
    service: ORCHESTRATOR_SERVICE,
    port: ORCHESTRATOR_PORT,
  });
  try {
    const res = await fetch(`${fwd.url}/hooks/${hook}`, { method: "POST", headers, body });
    seenOf(world).answer = { status: res.status, text: await res.text() };
  } finally {
    fwd.close();
  }
}

/** A review on GitHub whose body is the run's marker, signed as GitHub signs it. */
async function githubReview(world: E2EWorld, secret: string): Promise<void> {
  const raw = JSON.stringify({
    action: "submitted",
    sender: { login: "octocat" },
    review: { state: "approved", body: world.marker, user: { login: "octocat" }, commit_id: "c0ffee" },
    pull_request: { html_url: "https://github.com/o/r/pull/1" },
  });
  const sig = createHmac("sha256", secret).update(raw).digest("hex");
  await deliver(
    world,
    "forge",
    {
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-event": "pull_request_review",
      "x-github-delivery": `gh-${randomBytes(6).toString("hex")}`,
      "content-type": "application/json",
    },
    raw,
  );
}

/** An approval on GitLab whose url is the run's marker, with `token` in the header as GitLab sends it. */
async function gitlabApproval(world: E2EWorld, token: string): Promise<void> {
  const raw = JSON.stringify({
    object_kind: "merge_request",
    user: { username: "ann" },
    object_attributes: { action: "approved", url: world.marker, last_commit: { id: "c0ffee" } },
  });
  await deliver(
    world,
    "lab",
    {
      "x-gitlab-token": token,
      "idempotency-key": `gl-${randomBytes(6).toString("hex")}`,
      "content-type": "application/json",
    },
    raw,
  );
}

/** One run's status off the Orchestrator API, polled until `ok` holds. */
async function runUntil(
  world: E2EWorld,
  ok: (run: { status: string; output?: unknown; gates?: unknown[] }) => boolean,
  what: string,
): Promise<{ status: string; output?: unknown }> {
  assert.ok(world.runId, "the scenario started a run");
  let last: unknown;
  for (let i = 0; i < 240; i++) {
    const run = (await world.readRun(world.runId)) as { status: string; output?: unknown; gates?: unknown[] };
    last = run;
    if (run && ok(run)) return run;
    await sleep(500);
  }
  throw new Error(`${what} never held (last: ${JSON.stringify(last)})`);
}

Then(
  "jr2 up converged the Instance Effector for the Hooks {string} and {string}",
  function (this: E2EWorld, a: string, b: string): void {
    const out = `${this.last?.stdout ?? ""}${this.last?.stderr ?? ""}`;
    const line = out.split("\n").find((l) => l.includes("instance effector: converging ("));
    assert.ok(line, `jr2 up printed the Instance Effector's converge line:\n${out}`);
    assert.ok(line.includes(`hook ${a}`) && line.includes(`hook ${b}`), line);
    assert.ok(line.includes("`GH_HOOK`") && line.includes("`CHAT_SIGNING`"), line);
  },
);

When(
  "I start the {string} workflow with a marker detached",
  async function (this: E2EWorld, wf: string): Promise<void> {
    this.marker = `m-${randomBytes(6).toString("hex")}`;
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ marker: this.marker })]);
    assert.equal(this.last?.code, 0, this.last?.stderr ?? "");
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

Then("the run's Gate is open", async function (this: E2EWorld): Promise<void> {
  await runUntil(this, (run) => (run.gates?.length ?? 0) > 0, "an open Gate");
});

When("GitHub sends a review of the run's marker signed with the Hook's secret", async function (this: E2EWorld) {
  assert.ok(this.ghHook, "setupKind made the forge Hook's secret");
  await githubReview(this, this.ghHook);
});

When("GitHub sends a review of the run's marker signed with another secret", async function (this: E2EWorld) {
  await githubReview(this, `forged-${randomBytes(12).toString("hex")}`);
});

When("GitLab sends an approval of the run's marker with the Hook's token", async function (this: E2EWorld) {
  assert.ok(this.glHook, "setupKind made the lab Hook's secret");
  await gitlabApproval(this, this.glHook);
});

When("GitLab sends an approval of the run's marker with another token", async function (this: E2EWorld) {
  await gitlabApproval(this, `forged-${randomBytes(12).toString("hex")}`);
});

Then(
  "jr2 up gave the Orchestrator only the digest of the Hook {string}'s secret {string}",
  function (this: E2EWorld, hook: string, name: string): void {
    const out = `${this.last?.stdout ?? ""}${this.last?.stderr ?? ""}`;
    assert.ok(out.includes(`secret ${name}: a digest in the Orchestrator (hook ${hook})`), out);
    const effector = out.split("\n").find((l) => l.includes("instance effector: converging ("));
    assert.ok(effector && !effector.includes(`\`${name}\``), `the Instance Effector holds no ${name}: ${effector}`);
  },
);

Then("the Hook door answers {int}", function (this: E2EWorld, status: number): void {
  const answer = seenOf(this).answer;
  assert.equal(answer?.status, status, answer?.text ?? "no answer");
});

Then("the door delivered the event to the run's Gate", function (this: E2EWorld): void {
  const answer = seenOf(this).answer;
  assert.equal(answer?.status, 200, answer?.text ?? "no answer");
  const outcome = JSON.parse(answer!.text) as { delivered: Array<{ run: string; event: string }> };
  assert.deepEqual(
    outcome.delivered.map((d) => [d.run, d.event]),
    [[this.runId, "approve"]],
    answer!.text,
  );
});

Then("the run ends {string}, approved by {string}", async function (this: E2EWorld, status: string, by: string) {
  const run = await runUntil(this, (r) => isSettled(r.status), "the run's end");
  assert.equal(run.status, status, JSON.stringify(run));
  assert.deepEqual(run.output, { by });
});

Then("the run is still waiting at its Gate", async function (this: E2EWorld): Promise<void> {
  const run = await runUntil(this, () => true, "a read");
  assert.ok(!isSettled(run.status), JSON.stringify(run));
});

Then(
  "the run ends {string} with the items {string} and {string}",
  async function (this: E2EWorld, status: string, a: string, b: string): Promise<void> {
    const run = await runUntil(this, (r) => isSettled(r.status), "the run's end");
    assert.equal(run.status, status, JSON.stringify(run));
    const items = Object.keys((run.output as { items?: object } | undefined)?.items ?? {}).sort();
    assert.deepEqual(items, [a, b].sort(), JSON.stringify(run.output));
  },
);

// --- the chat Hook's follow-up -------------------------------------------------------------------

/**
 * The follow-up host of the chat kind, `https://follow/`: a Service of the scenario's namespace with
 * no selector, whose one endpoint is a server on this host (the address the pods reach the scripted
 * model at). The server holds a leaf of the tier's CA for the name `follow`, and the instance's
 * `caBundle` is that CA, which the Instance Effector trusts (ADR-0020). It records each post.
 */
Given("the chat kind's follow-up host answers in the scenario's namespace", async function (this: E2EWorld) {
  assert.ok(this.namespace, "a @kind scenario has its namespace");
  const s = seenOf(this);
  const address = await kindHostAddress();
  const tls = issueLeaf(await fakeProviderCa(), "follow");
  const server: Server = createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        json = undefined;
      }
      s.posts.push({ path: req.url ?? "", json });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  this.closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const meta = { name: "follow", namespace: this.namespace };
  await applyInNamespace(
    this.namespace,
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: meta,
          spec: { ports: [{ name: "https", port: 443, targetPort: port, protocol: "TCP" }] },
        },
        {
          apiVersion: "discovery.k8s.io/v1",
          kind: "EndpointSlice",
          metadata: { ...meta, labels: { "kubernetes.io/service-name": "follow" } },
          addressType: "IPv4",
          ports: [{ name: "https", port, protocol: "TCP" }],
          endpoints: [{ addresses: [address] }],
        },
      ],
    }),
  );
});

/** `kubectl apply -f -` in the scenario's namespace. */
function applyInNamespace(namespace: string, manifest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("kubectl", ["--namespace", namespace, "apply", "-f", "-"], (err, _out, stderr) =>
      err ? reject(new Error(`kubectl apply: ${stderr || err.message}`)) : resolve(),
    );
    child.stdin?.end(manifest);
  });
}

When("the chat Hook sends a click on the run's marker", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.chatSigning, "setupKind made the chat Hook's secret");
  const payload = {
    type: "block_actions",
    trigger_id: `t-${randomBytes(6).toString("hex")}`,
    user: { id: "U1" },
    actions: [{ action_id: "approve", value: this.marker }],
    response_url: `https://follow/actions/${this.marker}`,
  };
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", this.chatSigning).update(`v0:${ts}:${raw}`).digest("hex");
  await deliver(
    this,
    "chat",
    {
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
      "content-type": "application/x-www-form-urlencoded",
    },
    raw,
  );
});

Then("the follow-up host received the Gate's reply for the run, once", async function (this: E2EWorld): Promise<void> {
  const s = seenOf(this);
  for (let i = 0; i < 60 && s.posts.length === 0; i++) await sleep(500);
  // A moment more, so a second post would be seen.
  await sleep(2000);
  assert.equal(s.posts.length, 1, JSON.stringify(s.posts));
  assert.equal(s.posts[0]!.path, `/actions/${this.marker}`);
  assert.deepEqual(s.posts[0]!.json, {
    response_type: "ephemeral",
    replace_original: false,
    text: `approved ${this.runId}`,
  });
});
