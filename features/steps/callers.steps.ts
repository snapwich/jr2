// The Caller steps (ADR-0078): a named Caller token, declared in the instance's config and given to
// the orchestrator as a digest, and the `jr2` binary sent with that token's value through `--url`
// and `JR2_TOKEN`, as a CI job outside the cluster sends it. On @kind, `jr2 up` makes the token, and
// `jr2 caller token|rotate` read and rotate it over the kube API.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { kubectlKube } from "@jr2/cli";
import { ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@jr2/orchestrator/internal";
import { E2EWorld } from "./world.ts";

Given(
  "the instance declares the Caller token {string} that may start and read {string}",
  async function (this: E2EWorld, name: string, workflow: string): Promise<void> {
    await this.declareCallerToken(name, { start: [workflow], read: [workflow] });
  },
);

When(
  "the Caller {string} runs {string} with message {string}",
  async function (this: E2EWorld, caller: string, wf: string, message: string): Promise<void> {
    await this.runCli(["run", wf, "--input", JSON.stringify({ message })], { as: caller });
    // A blocking run prints its terminal status: carry its id for a later step.
    if (this.last?.code === 0) this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

Then("the run was started by the Caller {string}", function (this: E2EWorld, caller: string): void {
  // `jr2 status <run>` prints the run's status, which records its starter (ADR-0078).
  const [via, name] = caller.split("/");
  assert.deepEqual(this.resultJson<{ startedBy?: unknown }>().startedBy, { kind: "caller", via, name });
});

When(
  "the Caller {string} starts {string} with input {string}",
  async function (this: E2EWorld, caller: string, wf: string, input: string): Promise<void> {
    await this.runCli(["run", wf, "--detach", "--input", input], { as: caller });
  },
);

Then(
  "stderr says the Caller {string} needs the {string} scope for Workflow {string}",
  function (this: E2EWorld, caller: string, scope: string, wf: string): void {
    assert.match(
      this.last?.stderr ?? "",
      new RegExp(`the Caller ${caller} needs the "${scope}" scope for Workflow "${wf}"`),
    );
  },
);

// --- @kind: `jr2 up` makes the named tokens; the CLI reads, rotates and sends them (ADR-0078) ------

/** The value a scenario read before it rotated a token, by name: what must stop working. */
const rotatedFrom = new WeakMap<E2EWorld, Map<string, string>>();

/** A port-forward to this scenario's Orchestrator, for the steps that address it by url, as a CI job
 * outside the cluster does. */
async function forward<T>(world: E2EWorld, use: (url: string) => Promise<T>): Promise<T> {
  assert.ok(world.namespace, "a @kind scenario has its namespace");
  const fwd = await kubectlKube.portForward({
    namespace: world.namespace,
    service: ORCHESTRATOR_SERVICE,
    port: ORCHESTRATOR_PORT,
  });
  try {
    return await use(fwd.url);
  } finally {
    fwd.close();
  }
}

When("I ask who I am", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["whoami"]);
});

Then(
  "I am the Caller {string} on behalf of the kube user",
  async function (this: E2EWorld, caller: string): Promise<void> {
    assert.equal(this.last?.code, 0, this.last?.stderr ?? "no command ran");
    const [via, name] = caller.split("/");
    const me = this.resultJson<{ via: string; name: string; onBehalfOf?: string }>();
    assert.equal(`${me.via}/${me.name}`, `${via}/${name}`);
    // The claim is the name the API server gives this kubeconfig's credentials (ADR-0078).
    const user = await kubectlKube.selfSubject({});
    assert.ok(user, "the cluster answers a SelfSubjectReview");
    assert.equal(me.onBehalfOf, user);
  },
);

When("I read the Caller token {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const r = await this.runCli(["caller", "token", name]);
  assert.equal(r.code, 0, r.stderr);
  const value = r.stdout.trim();
  assert.match(value, /^jr2c_[A-Za-z0-9_-]{43}$/, "the value alone: jr2c_ and 32 bytes in base64url");
  this.callerTokens.set(name, value);
});

Then(
  "the Caller token {string} acts as {string}",
  async function (this: E2EWorld, name: string, caller: string): Promise<void> {
    const value = this.callerTokens.get(name);
    assert.ok(value, `the scenario read the Caller token "${name}"`);
    const r = await forward(this, (url) => this.runCli(["whoami"], { env: { JR2_URL: url, JR2_TOKEN: value } }));
    assert.equal(r.code, 0, r.stderr);
    const me = JSON.parse(r.stdout) as { via: string; name: string; onBehalfOf?: string };
    assert.equal(`${me.via}/${me.name}`, caller);
    assert.equal(me.onBehalfOf, undefined, "with --url the CLI claims no party");
  },
);

When("I rotate the Caller token {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const old = this.callerTokens.get(name);
  assert.ok(old, `the scenario read the Caller token "${name}" before it rotates it`);
  const map = rotatedFrom.get(this) ?? new Map<string, string>();
  map.set(name, old);
  rotatedFrom.set(this, map);
  const r = await this.runCli(["caller", "rotate", name]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "", "rotate prints no value");
});

Then(
  "the old value of the Caller token {string} is refused within {int} seconds",
  { timeout: 300_000 },
  async function (this: E2EWorld, name: string, seconds: number): Promise<void> {
    const old = rotatedFrom.get(this)?.get(name);
    assert.ok(old, `the scenario rotated the Caller token "${name}"`);
    // `jr2 caller rotate` returned only when the Orchestrator reported the new digest as loaded
    // (ADR-0078), so the old value is refused at once; the short bound only absorbs the forward.
    await forward(this, async (url) => {
      const deadline = Date.now() + seconds * 1000;
      let status = 0;
      for (;;) {
        const res = await fetch(`${url}/whoami`, { headers: { authorization: `Bearer ${old}` } });
        status = res.status;
        await res.body?.cancel();
        if (status === 401 || Date.now() > deadline) break;
        await sleep(3000);
      }
      assert.equal(status, 401, `the old value still answered ${status} after ${seconds}s`);
    });
  },
);
