// Steps for the @kind tier: assertions that reach past the orchestrator into the REAL cluster.
// Everything here is observed the way a user would — `kubectl` for the cluster, the `j2` binary
// for the run — so the tier stays black-box (ADR-0010). Reading run status reuses the mechanics
// -tier steps; only the cluster-facing claims live here.
//
// The Sandbox is found by its `j2.dev/run` LABEL, never by reconstructing its name: that label is
// the run↔workspace link ADR-0012 promises (what `j2 ls` will group by), so looking it up this way
// asserts the promise instead of trusting the naming function.
//
// NOTHING HERE PLAYS THE AGENT (ADR-0013), and since ADR-0038 the reason has inverted. The pod
// runs the REAL `@j2/harness`: it holds its own MCP connection to the Adapter on localhost, is
// served this state's Menu, and pi decides. What this file drives is the one thing still faked —
// the MODEL. "The Agent calls X" RELEASES the provider request this pod's Harness is parked on,
// answering it with a tool call; everything after that (the MCP call, the delivery, the Machine
// moving) happens inside the cluster. If this file opened an MCP client, the pod would never
// originate a connection and the leg under test would not be tested.

import { After, Given, Then, When, type ITestCaseHookParameter } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { IMAGES_CONFIGMAP, IMAGES_KEY } from "@j2/orchestrator";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

type SandboxCR = { metadata: { name: string }; status?: { phase?: string } };

/** Run kubectl in the scenario's namespace (the isolation unit — ADR-0010/0019). */
async function kubectl(world: E2EWorld, args: string[]): Promise<string> {
  assert.ok(world.kindNamespace, "a @kind scenario has its namespace set in setupKind");
  const { stdout } = await exec("kubectl", ["--namespace", world.kindNamespace, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Port-forward a pod for the duration of one callback (the host's stand-in for pod-net access). */
async function withPodForward(
  world: E2EWorld,
  pod: string,
  port: number,
  fn: (localUrl: string) => Promise<void>,
): Promise<void> {
  assert.ok(world.kindNamespace, "a @kind scenario has its namespace set");
  const child = spawn("kubectl", ["--namespace", world.kindNamespace, "port-forward", `pod/${pod}`, `:${port}`]);
  try {
    const local = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      child.on("close", (code) => reject(new Error(`port-forward pod/${pod} exited (${code})`)));
    });
    await fn(`http://127.0.0.1:${local}`);
  } finally {
    child.kill();
  }
}

/** Scale the in-cluster orchestrator (deployed by `j2 up`) — the @kind restart/stop lever. */
async function scaleOrchestrator(world: E2EWorld, replicas: 0 | 1): Promise<void> {
  await kubectl(world, ["scale", "deployment/j2-orchestrator", `--replicas=${replicas}`]);
  if (replicas === 0) {
    await kubectl(world, ["wait", "--for=delete", "pod", "-l", "app=j2-orchestrator", "--timeout=120s"]).catch(
      () => {},
    );
  } else {
    await kubectl(world, ["rollout", "status", "deployment/j2-orchestrator", "--timeout=120s"]);
  }
}

/** Every Sandbox CR labeled with this run. */
async function sandboxesFor(world: E2EWorld): Promise<SandboxCR[]> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  const out = await kubectl(world, ["get", "sandbox", "-l", `j2.dev/run=${world.runId}`, "-o", "json"]);
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
    `no Sandbox for run ${world.runId} reached Ready — \`j2 up\` builds and loads every image ` +
      `itself (ADR-0038), so check the operator (kubectl -n j2-system get pods) and the pod's ` +
      `own events: kubectl -n ${world.kindNamespace} describe sandbox`,
  );
}

/** One live child machine under the run, as `j2 status` reports it (context-free by construction). */
type RunChild = { id: string; value: unknown; children: RunChild[] };

/** The wrapper's own state + context — where the workspace endpoint and the body's output land. */
type WsStatus = {
  status: string;
  value: string;
  /** The run's agent instance id — the iid the Harness is admitted under, and the Adapter's path. */
  instanceId: string;
  context: { endpoint?: string; output?: { outcome?: string } };
  /** The body lives here: a wrapper's own `value` is only ever provisioning/attaching/running. */
  children: RunChild[];
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

/** Is any child machine, at any depth, sitting in this state? (The body is one level down.) */
function anyChildIn(children: RunChild[], value: string): boolean {
  return children.some((c) => c.value === value || anyChildIn(c.children, value));
}

/**
 * What the Harness itself says became of this instance's turns (`?view=history` — ADR-0027's wire;
 * the stock Harness serves the same shape the retired stub did, so this reader is unchanged).
 * Read from the pod over a port-forward: a settlement is invisible to the Orchestrator by
 * construction (ADR-0024 — the actor is stopped before the abort fires), so the only honest place
 * to observe the end of a turn is the Harness that ran it.
 */
async function settlements(world: E2EWorld, iid: string): Promise<Array<{ submissionId: string; outcome: string }>> {
  const pod = (await waitForReadySandbox(world)).metadata.name;
  let found: Array<{ submissionId: string; outcome: string }> = [];
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/coder/${encodeURIComponent(iid)}?view=history`);
    assert.equal(res.status, 200, "the Harness serves the conversation history");
    found =
      ((await res.json()) as { settlements?: Array<{ submissionId: string; outcome: string }> }).settlements ?? [];
  });
  return found;
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

// 10 min: the FIRST converge of a session builds the instance image (pnpm deploy + docker);
// later scenarios hit the content-hash skip and the docker cache.
Given("the kind instance is serving", { timeout: 600_000 }, async function (this: E2EWorld): Promise<void> {
  // The product's own path (ADR-0010/0019): converge the scenario's fresh namespace with `j2 up`.
  // The workflows (incl. `sandboxed`) are committed in the kind instance and baked into its image.
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `j2 up failed: ${r.stderr}`);
});

// --- when ----------------------------------------------------------------------------------------

// Both restart steps wait for the workspace to be fully attached first: killing the orchestrator
// mid-`attaching` is a different (also legitimate) restore case, but it is not the one these
// scenarios are about, and racing it would make them flaky.
When("the orchestrator restarts", async function (this: E2EWorld): Promise<void> {
  this.sandboxBefore = (await waitForReadySandbox(this)).metadata.name;
  this.endpointBefore = (await waitForAttached(this)).context.endpoint;
  await scaleOrchestrator(this, 0);
  await scaleOrchestrator(this, 1);
});

When("the orchestrator stops", async function (this: E2EWorld): Promise<void> {
  this.sandboxBefore = (await waitForReadySandbox(this)).metadata.name;
  await waitForAttached(this);
  await scaleOrchestrator(this, 0);
});

When("the run's Sandbox is reaped behind its back", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.sandboxBefore, "the Sandbox name was captured while the orchestrator was up");
  // What an idle-timeout GC or a lost node does, done deterministically.
  await kubectl(this, ["delete", "sandbox", this.sandboxBefore, "--wait=true"]);
});

When("the orchestrator starts again", async function (this: E2EWorld): Promise<void> {
  await scaleOrchestrator(this, 1);
});

/**
 * The model this pod's Harness talks to now answers with a tool call (ADR-0013/0038). The step
 * TEXT is unchanged and still true — the Agent calls the tool — but the mechanism inverted: the
 * submission was admitted by the Machine's own `agentRun`, the pod's Harness has been parked on a
 * provider request ever since (which is exactly what "still thinking" looks like from the
 * Machine's side), and this releases it. Everything downstream is real and in-cluster: pi executes
 * `mcp__j2__<tool>` over its own MCP connection to the Adapter on localhost, the Adapter delivers,
 * the Machine moves. Nothing on this side speaks MCP or the Harness wire.
 *
 * The request is matched by the tool it was OFFERED, never by arrival order — see fake-provider.ts:
 * after a pick, the ended turn's post-tool-result request is parked beside the next state's fresh
 * one, and only the Menu tells them apart.
 */
When(
  "the Agent in the Sandbox calls {string} with summary {string}",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    await waitForAttached(this); // the turn cannot exist before the workspace finished attaching
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.release(tool, { summary });
  },
);

/** The Agent reaches for its own toolchain (ADR-0027/0037): the model answers with the `bash`
 * WORKING tool, which the Harness executes in its own container — which IS the wrapped Sandbox
 * Image. No Menu tool is picked, so the Machine does not move; what moves is the conversation. */
When(
  "the Agent runs {string} through its bash Working tool",
  async function (this: E2EWorld, command: string): Promise<void> {
    await waitForAttached(this);
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.release("bash", { command });
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
      await kubectl(this, [
        "get",
        "pod",
        pod,
        "-o",
        `jsonpath={.spec.containers[?(@.name=="adapter")].env[?(@.name=="J2_ORCHESTRATOR_URL")].value}`,
      ])
    ).trim();
    assert.ok(url, "the Adapter container carries the Orchestrator's address (the Harness does not)");

    // node, not curl: it is what the image has, and it is what a bash Working tool would use.
    // Still resolvable after the ADR-0037 wrap because PATH is APPENDED — the Sandbox Image's own
    // node answers here, and j2's relocated one at /opt/j2/bin is merely the fallback.
    const probe =
      `fetch(${JSON.stringify(`${url}/agents/${iid}/events`)},{method:"POST",` +
      `headers:{"content-type":"application/json"},` +
      `body:${JSON.stringify(JSON.stringify({ type: tool, summary: "self-approved" }))}})` +
      `.then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR",e.message))`;
    this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e", probe]);
  },
);

/**
 * The detached review worktree (ADR-0028), attached the way the attach step will: the same
 * idempotent script lines `attachScript` emits with a `reviewSha`, exec'd in the Harness
 * container. Played from here rather than through a workflow because the Workspace-port verb
 * that requests it per review round is a later phase — what this tier pins is the containment
 * property of the worktree itself, on a real pod with the real shared clone.
 */
When(
  "a detached review worktree is attached for repo {string} at the head of branch {string}",
  async function (this: E2EWorld, repo: string, branch: string): Promise<void> {
    await waitForAttached(this); // attach is post-Ready — the branch worktree must exist first
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const dflt = `/work/${repo}/default`;
    const review = `/work/${repo}/${branch}-review`;
    this.branchHeadBefore = (
      await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "git", "-C", dflt, "rev-parse", branch])
    ).trim();
    this.reviewDir = review;
    const script = [
      `[ -d '${review}' ] || git -C '${dflt}' worktree add --detach '${review}' '${this.branchHeadBefore}'`,
      `[ "$(git -C '${review}' rev-parse HEAD)" = "$(git -C '${dflt}' rev-parse '${this.branchHeadBefore}^{commit}')" ]` +
        ` || git -C '${review}' checkout --detach -f '${this.branchHeadBefore}'`,
    ].join("\n");
    await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", script]);
  },
);

/** The rogue reviewer, run for real (ADR-0028's incident): a write, then a commit — from the
 * review worktree, where both must land on the detached HEAD and nowhere else. */
When("the review worktree gets a write probe and a commit", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.reviewDir, "the review worktree was attached in a prior step");
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const script = [
    `cd '${this.reviewDir}'`,
    `echo rogue > probe.txt`,
    `git add probe.txt`,
    `git -c user.email=probe@j2 -c user.name=probe commit -m 'rogue probe'`,
  ].join("\n");
  await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", script]);
});

// --- then ----------------------------------------------------------------------------------------

Then(
  "the branch ref of repo {string} branch {string} is unmoved",
  async function (this: E2EWorld, repo: string, branch: string): Promise<void> {
    assert.ok(this.branchHeadBefore, "the branch head was captured when the review worktree was attached");
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const head = (
      await kubectl(this, [
        "exec",
        `pod/${pod}`,
        "-c",
        "harness",
        "--",
        "git",
        "-C",
        `/work/${repo}/default`,
        "rev-parse",
        branch,
      ])
    ).trim();
    assert.equal(
      head,
      this.branchHeadBefore,
      "the rogue commit landed on a detached HEAD, never the branch (ADR-0028)",
    );
  },
);

Then(
  "the coder's worktree for repo {string} branch {string} is untouched",
  async function (this: E2EWorld, repo: string, branch: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const worktree = `/work/${repo}/${branch}`;
    // Both halves of "untouched": nothing dirtied (status is empty) and the probe never appeared —
    // the write stayed inside the review worktree's own checkout.
    const status = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "git",
      "-C",
      worktree,
      "status",
      "--porcelain",
    ]);
    assert.equal(status.trim(), "", "the coder's worktree stayed clean (ADR-0028)");
    const probe = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-ec",
      `[ ! -e '${worktree}/probe.txt' ] && echo absent`,
    ]);
    assert.equal(probe.trim(), "absent", "the probe file never reached the coder's worktree");
  },
);

/** The six Working tools the default `workspace: "write"` leaves in place (ADR-0028). */
const WORKING_TOOLS = ["read", "write", "edit", "bash", "grep", "glob"];

/**
 * What the Harness OFFERED the model for this turn, asserted off the provider's recorded request —
 * which is free here, and stronger than the retired persona's `listTools()` call: it is the tool
 * set pi actually put on the wire. Two halves in one claim: this state's Menu (ADR-0015/0029,
 * `mcp__j2__`-prefixed by `menu.ts`) and exactly the Working tools the definition allows
 * (ADR-0028). "Exactly one Menu tool" is the sharp edge — a turn must not see another state's.
 */
Then(
  "the model was offered {string} from the Menu and its Working tools",
  async function (this: E2EWorld, tool: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running");
    const provider = this.provider;
    let seen: string[][] = [];
    for (let i = 0; i < 240; i++) {
      seen = provider.calls.filter((c) => c.stream).map((c) => c.tools);
      if (seen.some((tools) => tools.includes(`mcp__j2__${tool}`))) break;
      await sleep(500);
    }
    const turn = seen.find((tools) => tools.includes(`mcp__j2__${tool}`));
    assert.ok(turn, `no turn was offered "mcp__j2__${tool}" (offered: ${JSON.stringify(seen)})`);
    assert.deepEqual(
      turn.filter((t) => t.startsWith("mcp__j2__")),
      [`mcp__j2__${tool}`],
      "the turn sees this state's Menu and no other's (ADR-0015)",
    );
    for (const working of WORKING_TOOLS) {
      assert.ok(turn.includes(working), `the ${working} Working tool was offered (got: ${turn.join(", ")})`);
    }
  },
);

/**
 * The output of a Working tool, read where the model would read it: the NEXT provider request of
 * the same turn carries the tool result in its messages. That the string is there at all is the
 * ADR-0037 claim — the tool ran in the Sandbox Image, so it reached a binary only that image has.
 */
Then("the model was shown the tool result {string}", async function (this: E2EWorld, marker: string): Promise<void> {
  assert.ok(this.provider, "the scenario's scripted model is running");
  const provider = this.provider;
  for (let i = 0; i < 240; i++) {
    if (provider.calls.some((c) => c.stream && c.raw.includes(marker))) return;
    await sleep(500);
  }
  throw new Error(`no provider request ever carried "${marker}" (${provider.calls.length} recorded)`);
});

/**
 * ADR-0037's wrap, proved in the pod it was built for — the only tier that can. Each line is a
 * separate silent failure: no `git` and every attach fails; no writable `$HOME` and the attach's
 * `git config --global` dies with `fatal: $HOME not set` INSIDE a turn; a relocated node that
 * cannot find its C++ runtime and the container never serves; no `rg` and the grep Working tool
 * degrades to plain `grep` with nobody the wiser. PATH is the subtle one: it must be APPENDED, so
 * the USER's node wins and j2's is only the fallback — prepending would silently shadow a pinned
 * toolchain inside someone's own image.
 */
Then("the Harness container satisfies the wrap's contracts", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const script = [
    `git --version >/dev/null`,
    `[ "$HOME" = /home/j2 ]`,
    `touch "$HOME/.j2-home-probe"`,
    `/opt/j2/bin/node -e ''`,
    `rg --version >/dev/null`,
    `command -v node`,
  ].join("\n");
  const nodePath = (await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", script])).trim();
  assert.notEqual(
    nodePath,
    "/opt/j2/bin/node",
    `PATH is APPENDED, so the image's own node wins (ADR-0037); resolved: ${nodePath}`,
  );
  assert.ok(nodePath, "the image's own node is on PATH");
});

/**
 * The deleted User Container's promise, now delivered by the image (ADR-0037/0005): `kubectl exec`
 * into the harness container lands a human in the worktree root and hands them the agent's tools
 * and the agent's files — the same container, so "human and agent see identical files" is not a
 * shared volume any more, it is an identity.
 */
Then(
  "a human's shell in the Sandbox lands in {string} with the image's own toolchain",
  async function (this: E2EWorld, workdir: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    // No `-w`: the landing directory is the image's WORKDIR, which is what the wrap sets for
    // exactly this reason (it has no effect on the Agent — every Working tool carries its own cwd).
    const out = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", "pwd && j2-toolchain"]);
    const [landed, toolchain] = out.trim().split("\n");
    assert.equal(landed, workdir, "exec lands in the wrap's WORKDIR — the worktree root");
    assert.equal(toolchain, "j2-toolchain-ok", "the human gets the Sandbox Image's own tools, not j2's");
  },
);

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
    const current = await kubectl(this, [
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
    const alternates = await kubectl(this, [
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
  const names = (await kubectl(this, ["get", "pod", pod, "-o", "jsonpath={.spec.containers[*].name}"])).split(/\s+/);
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

Then("the run's body is in {string}", async function (this: E2EWorld, value: string): Promise<void> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 120; i++) {
    last = await wsStatus(this);
    if (anyChildIn(last.children ?? [], value)) return;
    await sleep(500);
  }
  throw new Error(`the body never reached "${value}" (last: ${JSON.stringify(last?.children)})`);
});

/**
 * The turns this instance has ENDED, counted at the Harness (ADR-0024). The count is exact on
 * purpose: it is what tells an ordered abort from a racing one. Turn two's submissions must not be
 * in this set while the Machine is still in the state that asked for them — an abort that overtook
 * the next `send` would have settled them before they ran, and the Agent would simply never speak.
 */
Then(
  "the Harness reports {int} of the Agent's turns settled as {string}",
  async function (this: E2EWorld, count: number, outcome: string): Promise<void> {
    const iid = (await wsStatus(this)).instanceId;
    let last: Array<{ outcome: string }> = [];
    for (let i = 0; i < 60; i++) {
      last = await settlements(this, iid);
      if (last.length === count) break;
      await sleep(500);
    }
    assert.equal(last.length, count, `settlements: ${JSON.stringify(last)}`);
    assert.ok(
      last.every((s) => s.outcome === outcome),
      `every ended turn settled "${outcome}" (got: ${JSON.stringify(last)})`,
    );
  },
);

Then("the run's Sandbox is still there", async function (this: E2EWorld): Promise<void> {
  // The park that keeps the Workspace — ADR-0024's dangerous shape, where an un-ended turn would
  // be a live writer in a worktree the Machine believes is idle.
  assert.equal((await sandboxesFor(this)).length, 1, "a non-final park retains its Sandbox (ADR-0012)");
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

// --- the image sweep (ADR-0039) --------------------------------------------------------------------
//
// The one claim no socket-free test can make: a REAL node's image store got smaller. The other
// tiers stop at the plan or at a fake store, and a fake cannot reproduce what makes this store
// hard — `kind load` leaves an image held under THREE refs (its tag, an `import-<date>@<digest>`,
// and a bare `sha256:<id>`), and `crictl rmi` drops only the ones CRI knows while exiting 0. A
// removal that reclaimed nothing is therefore indistinguishable from a real one unless containerd
// itself is asked.
//
// So the scenario asks containerd, and it asks about EVERY ref the load added, not just the tag:
// the refs are diffed across the load and every one of them must be gone afterwards. Checking the
// tag alone would pass on a sweep that never reached `ctr` — which is the whole defect.

/** The kind cluster the current context addresses, derived the way the CLI derives it. */
async function kindClusterName(): Promise<string> {
  const { stdout } = await exec("kubectl", ["config", "current-context"]);
  const context = stdout.trim();
  assert.ok(context.startsWith("kind-"), `the @kind tier runs against a kind context (got "${context}")`);
  return context.slice("kind-".length);
}

/** The nodes of the tier's cluster. */
async function kindNodes(): Promise<string[]> {
  const { stdout } = await exec("kind", ["get", "nodes", "--name", await kindClusterName()]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** containerd normalizes a local tag; every root spells it the short way (the CLI's `normalizeRef`). */
const shortRef = (ref: string): string => ref.replace(/^docker\.io\/library\//, "");

/**
 * Every ref CONTAINERD holds on a node, verbatim. Containerd's own list, not CRI's, because CRI's
 * can outlive it: a removal that reaches `ctr` leaves the CRI image store still answering for an id
 * whose refs and content are gone (ADR-0039). `ctr images ls` is the truth about the node.
 */
async function nodeRefs(node: string): Promise<Set<string>> {
  const { stdout } = await exec("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "ls", "-q"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return new Set(
    stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Every ref CRI names an image by on a node — the list a human reads with `crictl images`. */
async function nodeCriRefs(node: string): Promise<Set<string>> {
  const { stdout } = await exec("docker", ["exec", node, "crictl", "images", "-o", "json"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const listed = (JSON.parse(stdout) as { images?: Array<{ repoTags?: string[] }> }).images ?? [];
  return new Set(listed.flatMap((i) => i.repoTags ?? []).map(shortRef));
}

/** Every ref this instance's image map names — the root that says what future Sandboxes will run. */
async function imageMapRefs(world: E2EWorld): Promise<string[]> {
  const out = await kubectl(world, ["get", "configmap", IMAGES_CONFIGMAP, "-o", "json"]);
  const raw = (JSON.parse(out) as { data?: Record<string, string> }).data?.[IMAGES_KEY];
  assert.ok(raw, `the ${IMAGES_CONFIGMAP} ConfigMap carries ${IMAGES_KEY} (ADR-0038)`);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.values(parsed).flatMap((v) =>
    typeof v === "string" ? [v] : Object.values(v as Record<string, string>).filter((n) => typeof n === "string"),
  );
}

Given(
  "a labeled image no live root names is loaded onto every node",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const ref = `j2-e2e-garbage:${randomBytes(6).toString("hex")}`;
    // A one-layer image from `scratch`: kilobytes, no base to pull, and a real image config to
    // carry the stamp. The layer's content is random, so the load is a real import every time
    // rather than a re-tag of an id the node already holds. The labels go on the COMMAND LINE,
    // never in the Dockerfile — the same rule `j2 up` follows (ADR-0037/0039) — and `j2.dev/kind`
    // is what makes the image j2's to take at all.
    const dir = await mkdtemp(join(tmpdir(), "j2-e2e-garbage-"));
    try {
      await writeFile(join(dir, "marker"), `${ref} ${randomBytes(16).toString("hex")}\n`);
      await writeFile(join(dir, "Dockerfile"), "FROM scratch\nCOPY marker /marker\n");
      await exec("docker", [
        "build",
        "-t",
        ref,
        "--label",
        "j2.dev/kind=sandbox",
        "--label",
        `j2.dev/instance=${this.kindNamespace}`,
        dir,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const nodes = await kindNodes();
    const before = new Map(
      await Promise.all(nodes.map(async (n): Promise<[string, Set<string>]> => [n, await nodeRefs(n)])),
    );
    await exec("kind", ["load", "docker-image", ref, "--name", await kindClusterName()]);
    this.plantedImage = ref;
    // What the load ADDED, per node — the tag plus the names only containerd knows. This is the
    // set the sweep has to take, and the reason the assertion is a diff and not a tag lookup.
    this.plantedRefs = {};
    for (const node of nodes) {
      const added = [...(await nodeRefs(node))].filter((r) => !before.get(node)!.has(r));
      assert.ok(
        added.some((r) => shortRef(r) === ref),
        `the planted image reached node ${node} before the sweep (added: ${added.join(", ")})`,
      );
      this.plantedRefs[node] = added;
    }
  },
);

When("I sweep the cluster's images", { timeout: 300_000 }, async function (this: E2EWorld): Promise<void> {
  // No `-n`: `j2 gc` asks the whole cluster what it still needs, so it addresses no instance.
  const r = await this.runCli(["gc"], { namespaced: false });
  assert.equal(r.code, 0, `j2 gc failed: ${r.stderr}`);
});

Then("no node holds the unreachable image any more", async function (this: E2EWorld): Promise<void> {
  const planted = this.plantedRefs;
  assert.ok(planted && this.plantedImage, "the planted image's refs were carried from the Given");
  for (const [node, refs] of Object.entries(planted)) {
    const held = await nodeRefs(node);
    const survivors = refs.filter((r) => held.has(r));
    assert.deepEqual(
      survivors,
      [],
      `node ${node} still holds ${survivors.join(", ")} — an \`import-…@digest\` survivor means the ` +
        `removal stopped at the names CRI knows, so \`crictl rmi\` exited 0 and reclaimed nothing`,
    );
    assert.ok(!(await nodeCriRefs(node)).has(this.plantedImage!), `node ${node} still names it in crictl's list`);
  }
});

Then("every node still holds the images this instance's map names", async function (this: E2EWorld): Promise<void> {
  const refs = await imageMapRefs(this);
  assert.ok(refs.length > 0, "the image map names at least one image");
  for (const node of await kindNodes()) {
    const held = new Set([...(await nodeRefs(node))].map(shortRef));
    for (const ref of refs) {
      assert.ok(held.has(shortRef(ref)), `the sweep took ${ref} off node ${node}, which this instance still needs`);
    }
  }
});

// --- failure diagnostics ---------------------------------------------------------------------------
//
// A @kind scenario's namespace is deleted the moment it ends, which takes the only witnesses with
// it: the pods' logs and — the one that names a cause — the Harness's own history view, where a
// Submission that settled `failed` carries the error message verbatim (ADR-0027). So a FAILED
// scenario dumps everything it can reach first. Reading, never mutating: the dump must not change
// what the next run does, and every probe swallows its own error, because a diagnostic that fails
// the teardown destroys the evidence it exists to collect.

/** Where a failed scenario's evidence lands (gitignored, beside the tier's temp instances). */
const FAILURE_DIR = fileURLToPath(new URL("../.tmp/kind-failures/", import.meta.url));

/** Run a probe and answer its output, or the reason it could not be taken. */
async function probe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    return `<unavailable: ${err instanceof Error ? err.message : String(err)}>\n`;
  }
}

/**
 * The Harness's own account of this conversation — the settlements, with the failure message on
 * any that settled `failed`. It answers the first question a lost turn poses: a 404 here means the
 * admission POST never landed at all (POST is what creates a conversation — ADR-0027), while a
 * `failed` settlement means the turn started and died on the pod, and says how.
 */
async function harnessHistory(world: E2EWorld, iid: string): Promise<string> {
  const pod = (await sandboxesFor(world)).find((s) => s.status?.phase === "Ready")?.metadata.name;
  if (!pod) return "<no Ready Sandbox to read the history from>\n";
  let body = "";
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/coder/${encodeURIComponent(iid)}?view=history`);
    body = `HTTP ${res.status}\n${await res.text()}\n`;
  });
  return body;
}

/** Every container of every pod in the namespace, timestamped. Named pod by pod rather than by
 * label: the Sandbox's pod carries the operator's labels, not the run's, and a selector that
 * silently matches nothing writes an empty file that reads exactly like a silent container. */
async function allPodLogs(world: E2EWorld): Promise<string> {
  const names = (await kubectl(world, ["get", "pods", "-o", "name"])).split("\n").filter(Boolean);
  const chunks = await Promise.all(
    names.map(async (pod) => {
      const log = await probe(() =>
        kubectl(world, ["logs", pod, "--all-containers", "--prefix", "--timestamps", "--tail=-1"]),
      );
      return `--- ${pod} ---\n${log}`;
    }),
  );
  return chunks.join("\n");
}

/** Everything a failed @kind scenario can still be asked, written to one folder. */
async function dumpKindDiagnostics(world: E2EWorld, scenarioName: string): Promise<void> {
  const slug = scenarioName.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
  const dir = join(FAILURE_DIR, `${world.kindNamespace}-${slug}`);
  await mkdir(dir, { recursive: true });

  const status = await probe(async () => (await world.runCli(["status", world.runId ?? ""])).stdout);
  // The iid the Harness is admitted under — read off `j2 status`, which is also the dump's copy.
  const iid = (() => {
    try {
      return (JSON.parse(status.trim().split("\n").pop() ?? "{}") as { instanceId?: string }).instanceId;
    } catch {
      return undefined;
    }
  })();

  // The provider's side, first: how many requests EVER reached this scenario's scripted model, and
  // whether any of them streamed. Zero streaming is the flake's signature — the pod's turn loop
  // never got as far as asking the model anything.
  const calls = world.provider?.calls ?? [];
  const files: Array<[string, Promise<string> | string]> = [
    [
      "provider-calls.txt",
      `${calls.length} request(s), ${calls.filter((c) => c.stream).length} streaming\n` +
        calls.map((c) => `#${c.seq} stream=${c.stream} model=${c.model ?? "?"} tools=${c.tools.join(",")}`).join("\n") +
        "\n",
    ],
    ["j2-status.json", status],
    ["harness-history.json", iid ? probe(() => harnessHistory(world, iid)) : "<no instanceId in j2 status>\n"],
    ["pods.txt", probe(() => kubectl(world, ["get", "pods", "-o", "wide"]))],
    ["sandboxes.yaml", probe(() => kubectl(world, ["get", "sandbox", "-o", "yaml"]))],
    ["events.txt", probe(() => kubectl(world, ["get", "events", "--sort-by=.metadata.creationTimestamp"]))],
    // The Service the Orchestrator dials the Harness through: `phase: Ready` is computed from the
    // POD's readiness, and the EndpointSlice behind the ClusterIP is programmed after that — so
    // what this shows is whether the address the run was handed had a backend at all (ADR-0042).
    ["endpointslices.yaml", probe(() => kubectl(world, ["get", "endpointslices", "-o", "yaml"]))],
    // `--timestamps` is not optional (inside `allPodLogs` too): the Harness's own log is the
    // ADR-0023 conversation projection and carries none of its own, so without them nothing can be
    // ordered against the Orchestrator's lines or the provider's arrival times.
    ["logs.txt", probe(() => allPodLogs(world))],
    [
      "logs-orchestrator.txt",
      probe(() => kubectl(world, ["logs", "--prefix", "--timestamps", "--tail=-1", "deployment/j2-orchestrator"])),
    ],
  ];
  for (const [name, content] of files) {
    await writeFile(join(dir, name), await content).catch(() => {});
  }
  console.error(`[kind] scenario failed — diagnostics in ${dir}`);
}

// Namespace deletion (World.cleanup) is the real teardown; this only unsticks a Sandbox whose
// finalizer might slow that deletion down after a failed scenario. Registered in this file, which
// Cucumber imports after `hooks.ts`, so (After hooks run in reverse) this runs BEFORE the namespace
// is deleted — which is what makes the diagnostics dump above possible at all.
After({ tags: "@kind" }, async function (this: E2EWorld, scenario: ITestCaseHookParameter): Promise<void> {
  if (scenario.result?.status === "FAILED") {
    await dumpKindDiagnostics(this, scenario.pickle.name).catch((err: unknown) => {
      console.error(`[kind] diagnostics dump failed:`, err);
    });
  }
  // A scenario that failed before (or during) the sweep leaves its planted image behind; the next
  // `j2 gc` collects it either way — a labeled image no root names is exactly what the sweep is
  // for — but the tier must not depend on that to stay clean. Every ref the load added goes, since
  // taking the tag alone is what leaves the bytes behind. `ctr images rm` is delete-if-present.
  if (this.plantedImage) await exec("docker", ["rmi", this.plantedImage]).catch(() => {});
  for (const [node, refs] of Object.entries(this.plantedRefs ?? {})) {
    if (refs.length === 0) continue;
    await exec("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "rm", ...refs]).catch(() => {});
  }
  if (!this.runId) return;
  await kubectl(this, ["delete", "sandbox", "-l", `j2.dev/run=${this.runId}`, "--ignore-not-found"]).catch(() => {});
});
