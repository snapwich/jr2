// Steps for the @kind tier: assertions that reach past the orchestrator into the REAL cluster.
// Everything here is observed the way a user would — `kubectl` for the cluster, the `j2` binary
// for the run — so the tier stays black-box (ADR-0010). Reading run status reuses the mechanics
// -tier steps; only the cluster-facing claims live here.
//
// The Sandbox is found by its `j2.dev/run` LABEL, never by reconstructing its name: that label is
// the run↔workspace link ADR-0012 promises (what `j2 ls` will group by), so looking it up this way
// asserts the promise instead of trusting the naming function.
//
// NOTHING HERE PLAYS THE AGENT (ADR-0013). "The Agent calls X" submits to the HARNESS — the flue
// wire, over the port-forward the orchestrator already holds — and the persona inside the pod then
// does the calling, over MCP, to the Adapter on localhost. That indirection is the entire point:
// if this file opened an MCP client, the pod would never originate a connection and the leg under
// test would not be tested. (Faithful to flue, too: `defineAgent` is an initializer that re-runs
// on every submission, so a submission IS how a turn begins.)

import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

type SandboxCR = { metadata: { name: string }; status?: { phase?: string } };

/** Run kubectl and return stdout (the same command a human debugging the cluster would type). */
async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await exec("kubectl", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Every Sandbox CR labeled with this run. */
async function sandboxesFor(world: E2EWorld): Promise<SandboxCR[]> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  const out = await kubectl(["get", "sandbox", "-l", `j2.dev/run=${world.runId}`, "-o", "json"]);
  return (JSON.parse(out) as { items: SandboxCR[] }).items;
}

/** Poll the cluster until this run's Sandbox reports `phase: Ready` (a real pod, really pulling). */
async function waitForReadySandbox(world: E2EWorld): Promise<SandboxCR> {
  for (let i = 0; i < 120; i++) {
    const ready = (await sandboxesFor(world)).find((s) => s.status?.phase === "Ready");
    if (ready) return ready;
    await sleep(1000);
  }
  throw new Error(
    `no Sandbox for run ${world.runId} reached Ready. Is the operator running (\`just operator-run\`), ` +
      `and was the image loaded (\`just e2e-kind-up\`)?`,
  );
}

/** The wrapper's own state + context — where the workspace endpoint and the body's output land. */
type WsStatus = {
  status: string;
  value: string;
  /** The run's agent instance id — the iid the Harness is admitted under, and the Adapter's path. */
  instanceId: string;
  context: { endpoint?: string; output?: { outcome?: string } };
};

async function wsStatus(world: E2EWorld): Promise<WsStatus> {
  const r = await world.runCli(["status", world.runId!]);
  assert.equal(r.code, 0, `j2 status failed: ${r.stderr}`);
  return world.resultJson<WsStatus>();
}

/**
 * Poll until the WRAPPER is in `running` — i.e. `attaching` is done and the handles exist. A CR at
 * `phase: Ready` is NOT enough: attach happens post-Ready (ADR-0004), so anything that inspects the
 * worktree has to wait for the wrapper, not just the pod.
 */
async function waitForAttached(world: E2EWorld): Promise<WsStatus> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 120; i++) {
    last = await wsStatus(world);
    if (last.value === "running") return last;
    await sleep(500);
  }
  throw new Error(`the workspace never finished attaching (last: ${JSON.stringify(last)})`);
}

/** Poll until the run settles (done/error) — restore + teardown are asynchronous. */
async function waitSettled(world: E2EWorld): Promise<WsStatus> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 120; i++) {
    last = await wsStatus(world);
    if (last.status === "done" || last.status === "error") return last;
    await sleep(500);
  }
  throw new Error(`run never settled (last: ${JSON.stringify(last)})`);
}

// --- given ---------------------------------------------------------------------------------------

Given("the kind instance is serving", async function (this: E2EWorld): Promise<void> {
  await this.addFixtureWorkflow("sandboxed");
  await this.startDev();
});

// --- when ----------------------------------------------------------------------------------------

// Both restart steps wait for the workspace to be fully attached first: killing the orchestrator
// mid-`attaching` is a different (also legitimate) restore case, but it is not the one these
// scenarios are about, and racing it would make them flaky.
When("the orchestrator restarts", async function (this: E2EWorld): Promise<void> {
  this.sandboxBefore = (await waitForReadySandbox(this)).metadata.name;
  this.endpointBefore = (await waitForAttached(this)).context.endpoint;
  await this.restartDev();
});

When("the orchestrator stops", async function (this: E2EWorld): Promise<void> {
  this.sandboxBefore = (await waitForReadySandbox(this)).metadata.name;
  await waitForAttached(this);
  await this.stopDev();
});

When("the run's Sandbox is reaped behind its back", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.sandboxBefore, "the Sandbox name was captured while the orchestrator was up");
  // What an idle-timeout GC or a lost node does, done deterministically.
  await kubectl(["delete", "sandbox", this.sandboxBefore, "--wait=true"]);
});

When("the orchestrator starts again", async function (this: E2EWorld): Promise<void> {
  await this.startDev();
});

/**
 * Give the Agent a turn, and a script for it (ADR-0013). This is a SUBMISSION on the Harness's flue
 * wire — the same POST the Machine's own `agentRun` makes, at the endpoint the run reports — so
 * what happens next happens entirely inside the pod: the persona re-initializes for this turn,
 * connects MCP to the Adapter on localhost, is served the invoking state's menu, and calls from it.
 * The Machine moves because the POD asked it to. Nothing on this side speaks MCP.
 */
When(
  "the Agent in the Sandbox calls {string} with summary {string}",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    const ws = await waitForAttached(this);
    assert.ok(ws.context.endpoint, "the workspace reported its Harness endpoint");
    // "coder" is the agent name the `sandboxed` fixture admits under (flue: /agents/:name/:id).
    const res = await fetch(`${ws.context.endpoint}/agents/coder/${ws.instanceId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `call ${tool} ${JSON.stringify({ summary })}` }),
    });
    assert.equal(res.status, 200, "the Harness admitted the turn");
  },
);

/**
 * The attack ADR-0013 exists to stop, run for real: `local()` tools give the Agent code execution
 * in the HARNESS container, which shares the pod's network namespace — so it can reach the
 * Orchestrator directly, and a NetworkPolicy could not tell it apart from the Adapter. Only the
 * token can. We even hand it the address (read off the Adapter's own env) to make the point that
 * secrecy is not the control: what it cannot get is the credential, which lands in the Adapter
 * container alone.
 */
When(
  "the Harness container posts {string} straight to the Orchestrator",
  async function (this: E2EWorld, tool: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const iid = (await wsStatus(this)).instanceId;
    const url = (
      await kubectl([
        "get",
        "pod",
        pod,
        "-o",
        `jsonpath={.spec.containers[?(@.name=="adapter")].env[?(@.name=="J2_ORCHESTRATOR_URL")].value}`,
      ])
    ).trim();
    assert.ok(url, "the Adapter container carries the Orchestrator's address (the Harness does not)");

    // node, not curl: it is what the image has, and it is what a `local()` tool would use.
    const probe =
      `fetch(${JSON.stringify(`${url}/agents/${iid}/events`)},{method:"POST",` +
      `headers:{"content-type":"application/json"},` +
      `body:${JSON.stringify(JSON.stringify({ type: tool, summary: "self-approved" }))}})` +
      `.then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR",e.message))`;
    this.podSays = await kubectl(["exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e", probe]);
  },
);

// --- then ----------------------------------------------------------------------------------------

Then("the run's Sandbox becomes Ready", async function (this: E2EWorld): Promise<void> {
  const sandbox = await waitForReadySandbox(this);
  this.sandboxBefore = sandbox.metadata.name;
});

Then(
  "the run's Sandbox has repo {string} checked out on branch {string}",
  async function (this: E2EWorld, repo: string, branch: string): Promise<void> {
    await waitForAttached(this); // attach is post-Ready — the pod being up is not the worktree being there
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const workdir = `/work/${repo}/${branch}`;
    // The attach contract (ADR-0004), read straight out of the pod: a worktree on the branch, whose
    // objects are BORROWED from the read-only repos volume rather than copied.
    const current = await kubectl([
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "git",
      "-C",
      workdir,
      "branch",
      "--show-current",
    ]);
    assert.equal(current.trim(), branch);
    const alternates = await kubectl([
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "cat",
      `/work/${repo}/default/.git/objects/info/alternates`,
    ]);
    assert.equal(alternates.trim(), `/repos/${repo}/default/.git/objects`);
  },
);

Then("the run's Sandbox runs the Adapter beside the Harness", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const names = (await kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.containers[*].name}"])).split(/\s+/);
  // ADR-0005's "the pod, not the container, is the isolation unit" now has a third resident — and
  // the operator scheduled it without understanding it (ADR-0001: sidecars are opaque fragments).
  assert.ok(names.includes("harness"), `the Harness container is there (got: ${names.join(", ")})`);
  assert.ok(names.includes("adapter"), `the Adapter container is there (got: ${names.join(", ")})`);
});

Then("the delivery is refused as unauthorized", function (this: E2EWorld): void {
  assert.match(
    this.podSays ?? "",
    /HTTP 401/,
    `the Orchestrator must refuse an Agent bearing no Sandbox token (pod said: ${this.podSays?.trim()})`,
  );
});

Then("the run has not settled", async function (this: E2EWorld): Promise<void> {
  const s = await wsStatus(this);
  assert.equal(s.status, "active", "the refused delivery moved nothing");
});

Then("the run's Sandbox is the same one, at the same endpoint", async function (this: E2EWorld): Promise<void> {
  const after = await waitForReadySandbox(this);
  assert.equal(after.metadata.name, this.sandboxBefore, "restore re-attached to the SAME Sandbox CR");
  assert.equal((await wsStatus(this)).context.endpoint, this.endpointBefore, "and at the same endpoint");
});

Then("the run's body settled as {string}", async function (this: E2EWorld, outcome: string): Promise<void> {
  const settled = await waitSettled(this);
  assert.equal(settled.status, "done");
  assert.equal(settled.context.output?.outcome, outcome, "the wrapper forwards the body's output verbatim");
});

Then("the run's Sandbox is destroyed", async function (this: E2EWorld): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await sandboxesFor(this)).length === 0) return;
    await sleep(500);
  }
  throw new Error(`the Sandbox for run ${this.runId} outlived the body reaching final`);
});

Then("no Sandbox was re-provisioned for the run", async function (this: E2EWorld): Promise<void> {
  assert.deepEqual(await sandboxesFor(this), [], "a lost workspace is reported, never silently re-created");
});

// Belt and braces: a scenario that fails mid-run leaves a Sandbox behind (its body never reached
// final), and the next scenario should not inherit it.
After({ tags: "@kind" }, async function (this: E2EWorld): Promise<void> {
  if (!this.runId) return;
  await kubectl(["delete", "sandbox", "-l", `j2.dev/run=${this.runId}`, "--ignore-not-found"]).catch(() => {});
});
