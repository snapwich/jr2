// Steps for the @kind tier: assertions that reach past the orchestrator into the REAL cluster.
// Everything here is observed the way a user would — `kubectl` for the cluster, the `jr2` binary
// for the run — so the tier stays black-box (ADR-0010). Reading run status reuses the mechanics
// -tier steps; only the cluster-facing claims live here.
//
// The Sandbox is found by its `jr2.dev/run` LABEL, never by reconstructing its name: that label is
// the run↔workspace link ADR-0012 promises (what `jr2 ls` will group by), so looking it up this way
// asserts the promise instead of trusting the naming function.
//
// NOTHING HERE PLAYS THE AGENT (ADR-0013), and since ADR-0038 the reason has inverted. The pod
// runs the REAL `@jr2/harness`: it reads this state's Menu through the Custodian on localhost, and
// pi decides. What this file drives is the one thing still faked — the MODEL. "The Agent calls X"
// RELEASES the provider request this pod's Harness is parked on, answering it with a tool call;
// everything after that (the pick, the Custodian, the delivery, the Machine moving) happens inside
// the cluster. If this file delivered the pick itself, the pod would never originate it and the leg
// under test would not be tested.

import { After, AfterAll, Given, Then, When, type ITestCaseHookParameter } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  IMAGES_CONFIGMAP,
  IMAGES_KEY,
  INSTANCE_HARNESS_SERVICE,
  harnessToken,
  repoIdentity,
  repoKey,
  type RepoStatus,
} from "@jr2/orchestrator/internal";
import {
  ensureSeed,
  gpgRemoteCommit,
  pushRemoteTip,
  pushToSeed,
  seedKeys,
  SEED_URL,
  verifyOnPushRemote,
} from "./seed.ts";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** One entry of the Sandbox's standing per-Repo report (ADR-0053): what was asked of the node's
 * cache for that key, and which fetch answered it. Spelled here rather than imported because it is
 * the OPERATOR's shape — the CR is what a user reads, so the tier reads it the same way. */
type SandboxRepoStatus = { key: string; asked: string; fetched?: string; attempted?: string; error?: string };

type SandboxCR = {
  metadata: { name: string; annotations?: Record<string, string> };
  status?: { phase?: string; repos?: SandboxRepoStatus[] };
};

/** Run kubectl in the scenario's namespace (the isolation unit — ADR-0010/0019). */
async function kubectl(world: E2EWorld, args: string[]): Promise<string> {
  assert.ok(world.namespace, "a @kind scenario has its namespace set in setupKind");
  const { stdout } = await exec("kubectl", ["--namespace", world.namespace, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** kubectl with STDIN — how a secret reaches a probe without appearing in its argv or env. */
function kubectlInput(world: E2EWorld, args: string[], input: string): Promise<string> {
  assert.ok(world.namespace, "a @kind scenario has its namespace set in setupKind");
  return new Promise((resolve, reject) => {
    const child = execFile(
      "kubectl",
      ["--namespace", world.namespace!, ...args],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`kubectl ${args[0]}: ${stderr || err.message}`)) : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}

/** Port-forward a pod for the duration of one callback (the host's stand-in for pod-net access). */
async function withPodForward(
  world: E2EWorld,
  pod: string,
  port: number,
  fn: (localUrl: string) => Promise<void>,
): Promise<void> {
  assert.ok(world.namespace, "a @kind scenario has its namespace set");
  const child = spawn("kubectl", ["--namespace", world.namespace, "port-forward", `pod/${pod}`, `:${port}`]);
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

/**
 * The Harness bearer for one placement (ADR-0058), as this tier must present it: every Harness
 * route is gated, so reading a conversation over a port-forward is the Orchestrator's call to
 * make, made here with the Orchestrator's own derivation over the instance's signing key (read the
 * way the CLI reads the Instance token — over the kube API, RBAC the gate). `placement` is the
 * Sandbox's name, or `jr2-instance-harness`.
 */
async function harnessAuth(world: E2EWorld, placement: string): Promise<Record<string, string>> {
  const key = (
    await kubectl(world, ["get", "secret", "jr2-instance", "-o", "jsonpath={.data.JR2_SIGNING_KEY}"])
  ).trim();
  assert.ok(key, "the instance Secret carries the signing key `jr2 up` minted");
  const signingKey = Buffer.from(Buffer.from(key, "base64").toString("utf8"), "base64");
  return { authorization: `Bearer ${harnessToken(signingKey, placement)}` };
}

/** Scale the in-cluster orchestrator (deployed by `jr2 up`) — the @kind restart/stop lever. */
async function scaleOrchestrator(world: E2EWorld, replicas: 0 | 1): Promise<void> {
  await kubectl(world, ["scale", "deployment/jr2-orchestrator", `--replicas=${replicas}`]);
  if (replicas === 0) {
    await kubectl(world, ["wait", "--for=delete", "pod", "-l", "app=jr2-orchestrator", "--timeout=120s"]).catch(
      () => {},
    );
  } else {
    await kubectl(world, ["rollout", "status", "deployment/jr2-orchestrator", "--timeout=120s"]);
  }
}

/** Every Sandbox CR labeled with this run. */
async function sandboxesFor(world: E2EWorld): Promise<SandboxCR[]> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  const out = await kubectl(world, ["get", "sandbox", "-l", `jr2.dev/run=${world.runId}`, "-o", "json"]);
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
    `no Sandbox for run ${world.runId} reached Ready — \`jr2 up\` builds and loads every image ` +
      `itself (ADR-0038), so check the operator (kubectl -n jr2-system get pods) and the pod's ` +
      `own events: kubectl -n ${world.namespace} describe sandbox`,
  );
}

/** One live child machine under the run, as `jr2 status` reports it (context-free by construction). */
type RunChild = { id: string; value: unknown; children: RunChild[] };

/** The wrapper's own state + context — where the workspace endpoint and the body's output land. */
type WsStatus = {
  status: string;
  value: string;
  /** The RUN's own seed Instance ID (ADR-0033) — what names `task`'s default branch. It is not a
   * conversation address: jr2 mints those structurally (ADR-0057, {@link continuedIid}). */
  instanceId: string;
  context: { endpoint?: string; output?: { outcome?: string } };
  /** The body lives here: a wrapper's own `value` is only ever placing/provisioning/attaching/running. */
  children: RunChild[];
  /** The run's OPEN GATES, as `GET /runs/:id` lists them (ADR-0011) — the discovery listing a
   * human acts on, and the one `jr2 send --gate` names. Settled run → []. */
  gates?: OpenGate[];
};

/** One open Gate on the run, as the status listing reports it: the id `jr2 send --gate` takes, the
 * names it accepts, and the `meta` the invoking state published for callers to read. */
type OpenGate = { gate: string; accepts: Array<{ name: string }>; meta?: Record<string, unknown> };

async function wsStatus(world: E2EWorld): Promise<WsStatus> {
  const r = await world.runCli(["status", world.runId!]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
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
 * The Instance ID of a continued conversation, spelled the way jr2 mints it (ADR-0057):
 * `<runId>/<machine actor path>/<agent>` — the Agent's ONE conversation in one Machine instance,
 * whichever of that Machine's states asked for the Turn.
 *
 * `machine` is the actor path of the Machine that INVOKED the Agent, below the run's root:
 * `root` for a Machine a run STARTS with (`advised`), and `body` for the Machine a `workspace()`
 * invokes inside its Workspace — every other kind workflow, and the kit's `task`.
 *
 * Spelled out rather than discovered, because it IS the claim: a Turn that took a fresh
 * conversation lands at another address, and this one then answers 404 with the prompt nowhere on
 * the pod. It is also how a human finds a conversation —
 * `curl -H "authorization: Bearer <placement bearer>" localhost:8080/agents/<agent>/<iid>?view=history`
 * (ADR-0058: the wire is gated — `harnessAuth` below derives the bearer).
 */
const continuedIid = (runId: string, machine: "root" | "body", agent: string): string => `${runId}/${machine}/${agent}`;

/**
 * What the Harness itself says became of this instance's turns (`?view=history` — ADR-0027's wire;
 * the stock Harness serves the same shape the retired stub did, so this reader is unchanged).
 * Read from the pod over a port-forward: a settlement is invisible to the Orchestrator by
 * construction (ADR-0024 — the actor is stopped before the abort fires), so the only honest place
 * to observe the end of a turn is the Harness that ran it.
 */
/** One settled Submission, as the Harness's history view reports it (ADR-0027). */
type HarnessSettlement = { submissionId: string; outcome: string; error?: { type: string; message?: string } };

async function settlements(world: E2EWorld, iid: string): Promise<HarnessSettlement[]> {
  const pod = (await waitForReadySandbox(world)).metadata.name;
  const headers = await harnessAuth(world, pod);
  let found: HarnessSettlement[] = [];
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/coder/${encodeURIComponent(iid)}?view=history`, { headers });
    assert.equal(res.status, 200, "the Harness serves the conversation history");
    found = ((await res.json()) as { settlements?: HarnessSettlement[] }).settlements ?? [];
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

// 10 min: the FIRST converge of a session builds the Kit images (docker) and every converge stages
// and publishes the Assembly (pnpm deploy, then `PUT /assembly`, ADR-0069); later scenarios hit the
// content-hash skip and the docker cache for the images, and each fresh namespace takes its own
// publish.
Given("the kind instance is serving", { timeout: 600_000 }, async function (this: E2EWorld): Promise<void> {
  // The Repo the workflows bind must be reachable from the cluster before the Orchestrator boots
  // and the cache agent clones it (ADR-0051) — served in-cluster, once per suite (seed.ts).
  await ensureSeed();
  // The product's own path (ADR-0010/0019): converge the scenario's fresh namespace with `jr2 up`.
  // The workflows (incl. `sandboxed`) are committed in the kind instance and ride its Assembly,
  // which `jr2 up` publishes to the Orchestrator Kit image after every other layer (ADR-0069). A
  // restart boots from the Assembly's `current` pointer on the state volume.
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `jr2 up failed: ${r.stderr}`);
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
 * A PER-RUN Repo (ADR-0051): the `perrun` workflow's one slot is a mapper over its door, so the
 * url is run input — a ticket field, in the shape the fence exists for. Whether the url passes
 * `git.credentials` is decided at attach, by the Orchestrator, and the run either provisions a
 * Sandbox naming it or faults naming the list.
 */
When(
  "I start the {string} workflow with repo {string} detached",
  async function (this: E2EWorld, wf: string, repo: string): Promise<void> {
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ repo })]);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

/**
 * The model this pod's Harness talks to now answers with a tool call (ADR-0013/0038). The step
 * TEXT is unchanged and still true — the Agent calls the tool — but the mechanism inverted: the
 * submission was admitted by the Machine's own Agent slot, the pod's Harness has been parked on a
 * provider request ever since (which is exactly what "still thinking" looks like from the
 * Machine's side), and this releases it. Everything downstream is real and in-cluster: pi executes
 * `mcp__jr2__<tool>` as a delivery through the Custodian on localhost, which puts the Sandbox token
 * on it, and the Machine moves. Nothing on this side speaks the Menu routes or the Harness wire.
 *
 * The request is matched by the tool it was OFFERED, never by arrival order — see fake-provider.ts:
 * a request an earlier turn left parked can sit beside the next state's fresh one.
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
 * WORKING tool, which the Harness executes in its own container — the Sandbox Image itself, run
 * byte-for-byte with jr2's runtime mounted at /opt/jr2. No Menu tool is picked, so the Machine does
 * not move; what moves is the conversation. */
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
 * Orchestrator directly, and a NetworkPolicy could not tell it apart from the Custodian. Only the
 * token can. The address is no secret (the Service DNS is derivable), and the Agent sends the one
 * bearer its env holds: the Sandbox token's Stand-in (ADR-0059). That is worth nothing here — the
 * Custodian swaps it on its own three routes and nowhere else, and the Orchestrator refuses it.
 */
When(
  "the Harness container posts {string} straight to the Orchestrator",
  async function (this: E2EWorld, tool: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const iid = continuedIid(this.runId!, "body", "coder");
    const url = `http://jr2-orchestrator.${this.namespace}.svc:4000`;

    // node, not curl: it is what the image has, and it is what a bash Working tool would use.
    // Resolvable in an `exec` shell because the IMAGE carries it — the Harness's PATH append is a
    // process-level setting (startup.ts) that no exec inherits, and jr2 writes nothing into the
    // image's env (ADR-0037). The iid is ONE path segment on the wire, encoded as the Harness's
    // Menu encodes it (menu.ts): pasted raw, its slashes would miss the route and the 404 would be
    // the router's, not the refusal under test.
    const probe =
      `fetch(${JSON.stringify(`${url}/agents/${encodeURIComponent(iid)}/events`)},{method:"POST",` +
      `headers:{"content-type":"application/json",authorization:"Bearer "+process.env.JR2_SANDBOX_TOKEN},` +
      `body:${JSON.stringify(JSON.stringify({ type: tool, summary: "self-approved" }))}})` +
      `.then(r=>console.log("HTTP",r.status,process.env.JR2_SANDBOX_TOKEN)).catch(e=>console.log("ERR",e.message))`;
    this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e", probe]);
  },
);

// --- held secrets (ADR-0059) -------------------------------------------------------------------
//
// The kind instance's `harness.provider.apiKey` is a held secret: a per-scenario key the scripted
// model demands, bound to the model's own address. What the tier proves is the whole path — the
// Harness container holds a Stand-in and nothing else, the Custodian swaps it toward that host and
// nowhere else, and a request that carries no Stand-in never reaches the model. Every probe runs
// with `/opt/jr2/bin/node` (jr2's own Node, which honours NODE_USE_ENV_PROXY) inside the container,
// inheriting its env — the Agent's vantage point exactly.

/** The runtime's node, which every Harness container has at the same path (ADR-0037). */
const RUNTIME_NODE = "/opt/jr2/bin/node";

/**
 * The scan: every process's environment and every regular file under `/` but the kernel's trees,
 * for one secret — read from STDIN, so it is in neither the probe's argv nor its env, and the probe
 * cannot find the thing it looks for in itself.
 */
const KEY_SCAN =
  `const fs=require("fs"),path=require("path");const key=fs.readFileSync(0,"utf8").trim();const hits=[];` +
  `if(!key){console.log("NO KEY GIVEN");process.exit(0)}` +
  `for(const pid of fs.readdirSync("/proc")){if(!/^\\d+$/.test(pid))continue;` +
  `try{if(fs.readFileSync("/proc/"+pid+"/environ").includes(key))hits.push("/proc/"+pid+"/environ")}catch{}}` +
  `const skip=new Set(["/proc","/sys","/dev"]);` +
  `const walk=(d)=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}` +
  `for(const e of es){const p=path.join(d,e.name);if(skip.has(p))continue;` +
  `if(e.isDirectory())walk(p);else if(e.isFile()){try{if(fs.statSync(p).size>(64<<20))continue;` +
  `if(fs.readFileSync(p).includes(key))hits.push(p)}catch{}}}};walk("/");` +
  `console.log(hits.length?"FOUND "+hits.join(" "):"CLEAN")`;

Then(
  "the model provider received the provider key on every turn request",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    // The Sandbox's first turn is parked on the model by now, or soon: wait for it, so the claim is
    // about a request that happened, not a list that is merely empty.
    const deadline = Date.now() + 90_000;
    while (!this.provider.calls.some((c) => c.stream) && Date.now() < deadline) await sleep(500);
    assert.ok(
      this.provider.calls.some((c) => c.stream),
      "a turn request reached the model with the key",
    );
    const refused = this.provider.unauthorized.filter((u) => u.url.includes("chat/completions"));
    assert.deepEqual(refused, [], "no turn request arrived without the key");
  },
);

Then(
  "the Harness container's environment holds the stand-in for {string}",
  async function (this: E2EWorld, name: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const seen = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      RUNTIME_NODE,
      "-e",
      `console.log(process.env[${JSON.stringify(name)}])`,
    ]);
    assert.equal(seen.trim(), `jr2-held-${name}`);
  },
);

Then(
  "the provider key is nowhere in the Harness container's environment or files",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const out = await kubectlInput(
      this,
      ["exec", "-i", `pod/${pod}`, "-c", "harness", "--", RUNTIME_NODE, "-e", KEY_SCAN],
      this.providerKey ?? "",
    );
    assert.equal(out.trim(), "CLEAN", `the key is in the Harness container: ${out.trim()}`);
  },
);

Then(
  "the provider key is nowhere in the Instance Harness's Harness container",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const out = await kubectlInput(
      this,
      ["exec", "-i", `statefulset/${INSTANCE_HARNESS_SERVICE}`, "-c", "harness", "--", RUNTIME_NODE, "-e", KEY_SCAN],
      this.providerKey ?? "",
    );
    assert.equal(out.trim(), "CLEAN", `the key is in the Instance Harness's container: ${out.trim()}`);
  },
);

Then(
  "the Custodian's log names {string} and never the key",
  { timeout: 60_000 },
  async function (this: E2EWorld, name: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    let log = "";
    // The start-up line names every secret the Custodian holds; an intercepted request names the
    // one it swapped once it COMPLETES (a parked turn request logs when it ends). The access log
    // flushes twice a second, so the line is waited for.
    const names = new RegExp(`jr2\\.custodian .*secrets?=\\S*\\b${name}\\b`);
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(500)) {
      log = await kubectl(this, ["logs", `pod/${pod}`, "-c", "custodian"]);
      if (names.test(log)) break;
    }
    assert.match(log, names);
    assert.ok(this.providerKey && !log.includes(this.providerKey), "the key is not in the Custodian's log");
  },
);

When(
  "the Harness container sends the stand-in for {string} to the unbound echo",
  async function (this: E2EWorld, name: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    assert.ok(this.echoUrl, "the scenario's unbound echo is running (World.setupKind)");
    // Through the container's own HTTPS_PROXY: the Custodian tunnels a target no secret is bound to,
    // untouched — and the echo's certificate is trusted because the tier's CA is the `caBundle`.
    const probe =
      `fetch(${JSON.stringify(this.echoUrl)},{headers:{authorization:"Bearer "+process.env[${JSON.stringify(name)}]}})` +
      `.then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR",e.message,e.cause?.code??""))`;
    this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", RUNTIME_NODE, "-e", probe]);
  },
);

Then("the unbound echo received the stand-in, and not the key", function (this: E2EWorld): void {
  assert.match(this.podSays ?? "", /HTTP 200/, `the echo answered (pod said: ${this.podSays?.trim()})`);
  const seen = this.provider?.echo.seen ?? [];
  assert.ok(
    seen.some((r) => r.headers.authorization === "Bearer jr2-held-JR2_PROVIDER_API_KEY"),
    `the echo received the Stand-in as sent (got: ${JSON.stringify(seen.map((r) => r.headers.authorization))})`,
  );
  assert.ok(!JSON.stringify(seen).includes(this.providerKey ?? "\u0000"), "the key never reached the echo");
});

When("the Harness container calls the model provider with no stand-in", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  assert.ok(this.providerUrl, "the scenario's scripted model is running (World.setupKind)");
  const probe =
    `fetch(${JSON.stringify(`${this.providerUrl}/models`)}).then(async r=>console.log("HTTP",r.status,await r.text()))` +
    `.catch(e=>console.log("ERR",e.message,e.cause?.code??""))`;
  this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", RUNTIME_NODE, "-e", probe]);
});

Then("the Custodian refuses it as missing the stand-in", function (this: E2EWorld): void {
  assert.match(
    this.podSays ?? "",
    /HTTP 403 jr2 custodian: \S+ needs the stand-in of JR2_PROVIDER_API_KEY/,
    `the Custodian refused a request carrying no Stand-in (pod said: ${this.podSays?.trim()})`,
  );
});

Then("the model provider received no request without the key", function (this: E2EWorld): void {
  assert.deepEqual(this.provider?.unauthorized ?? [], [], "every request the model received carried the key");
});

/**
 * The Agent's own Harness, driven the way a bash Working tool would (ADR-0058): `node` in the
 * Harness container, over loopback — no NetworkPolicy stands between a pod and itself, so the
 * refusal under test is the bearer's alone. It even knows the address of a live conversation (the
 * iids are derivable); what it lacks is the bearer, whose digest is all its env carries.
 */
When("the Harness container admits a Turn to its own Harness", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const iid = continuedIid(this.runId!, "body", "coder");
  const probe =
    `fetch(${JSON.stringify(`http://127.0.0.1:8080/agents/coder/${encodeURIComponent(iid)}`)},{method:"POST",` +
    `headers:{"content-type":"application/json"},` +
    `body:${JSON.stringify(JSON.stringify({ message: "call finish", definition: { model: "x/y", instructions: "i" } }))}})` +
    `.then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR",e.message))`;
  this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e", probe]);
});

Then("the Harness refuses it as unauthorized", function (this: E2EWorld): void {
  assert.match(
    this.podSays ?? "",
    /HTTP 401/,
    `the Harness must refuse a caller bearing no placement bearer (pod said: ${this.podSays?.trim()})`,
  );
});

/**
 * Lateral reach (ADR-0058): from the Agent's container to the Instance Harness's Service. With the
 * policy in force the connection never completes; without it the answer would be the bearer's 401
 * — so the assertion is on the TRANSPORT failing, never on a status, which is what tells the two
 * controls apart.
 */
When("the Harness container dials the Instance Harness", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const url = `http://${INSTANCE_HARNESS_SERVICE}.${this.namespace}.svc:8080/agents/advisor/probe?view=history`;
  const probe =
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)})` +
    `.then(r=>console.log("HTTP",r.status)).catch(e=>console.log("ERR",e.name,e.message))`;
  this.podSays = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e", probe]);
});

Then("the connection never completes", function (this: E2EWorld): void {
  assert.match(
    this.podSays ?? "",
    /^ERR TimeoutError/m,
    `a Sandbox must not reach the Instance Harness — the ingress policy admits the Orchestrator alone ` +
      `(pod said: ${this.podSays?.trim()})`,
  );
});

/**
 * The detached review worktree (ADR-0028), attached the way the attach step does: the same
 * idempotent git steps the Harness's `POST /attach` runs with a `reviewSha` (ADR-0063), exec'd in
 * the Harness container. Played from here rather than through a workflow because the Workspace-port verb
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
    `git -c user.email=probe@jr2 -c user.name=probe commit -m 'rogue probe'`,
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
 * `mcp__jr2__`-prefixed by `menu-tools.ts`) and exactly the Working tools the definition allows
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
      if (seen.some((tools) => tools.includes(`mcp__jr2__${tool}`))) break;
      await sleep(500);
    }
    const turn = seen.find((tools) => tools.includes(`mcp__jr2__${tool}`));
    assert.ok(turn, `no turn was offered "mcp__jr2__${tool}" (offered: ${JSON.stringify(seen)})`);
    assert.deepEqual(
      turn.filter((t) => t.startsWith("mcp__jr2__")),
      [`mcp__jr2__${tool}`],
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
 * ADR-0037's composition, proved in the pod it was assembled for — the only tier that can. Nothing
 * here is a build any more: the runtime is the kit's image mounted as a volume, the uid and
 * the home came from the pod spec, and the umask and PATH came from the Harness PROCESS. Each is a
 * separate silent failure: no `git` and every attach fails; no writable `$HOME` and the attach's
 * `git config --global` dies with `fatal: $HOME not set` INSIDE a turn; a relocated node that
 * cannot find its C++ runtime through $ORIGIN/../lib and the container never serves; no `rg` and
 * the grep Working tool degrades to plain `grep` with nobody the wiser.
 *
 * Two of the contracts are process-level settings of the Harness itself, made AFTER execve, so an
 * `exec` shell inherits neither and the image carries no jr2 `ENV` at all (ADR-0037). Each needs an
 * observation that can actually see it:
 *   - umask 002 is kernel state, so `/proc/<pid>/status` reports it live. The Harness is NOT PID 1:
 *     tini is (ADR-0061), and the Harness is its one child — found by its command line, which
 *     starts with the runtime's node (tini's own starts with tini). `shareProcessNamespace` stays
 *     off (ADR-0005), so these are the container's processes alone. Defence in depth
 *     behind the attach's default ACL: outside a repo tree only the umask keeps jr2's writes
 *     group-writable. The supplemental gid proves the ownership half (fsGroup) arrived.
 *   - PATH must be APPENDED, so the image's own toolchain wins and jr2's vendored bin is the
 *     fallback — prepending would silently shadow a toolchain someone pinned in their own image.
 *     `/proc/1/environ` CANNOT see this: it is frozen at execve and never reflects an in-process
 *     setenv. What the append exists for is inheritance — Working tools spawn with no env override
 *     — so the honest observation is a CHILD's: a scripted bash turn prints `$PATH`, and the tool
 *     result on the next provider request is what the child saw. (The append itself is
 *     unit-covered in `packages/harness/test/startup.test.ts`; this pins the inheritance leg.)
 * The uid and `$HOME` pin the no-`USER` fallback: images/default declares no user, so the pod must
 * supply uid 1000 and an emptyDir home — the one branch of the composition no image can prove
 * about itself.
 */
Then("the Harness container satisfies the injection contracts", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const script = [
    `git --version >/dev/null`,
    `[ "$(id -u)" = 1000 ]`,
    `[ "$HOME" = /home/jr2 ]`,
    `touch "$HOME/.jr2-home-probe"`,
    // The work group reached the pod as fsGroup, so every container process holds it (ADR-0005).
    `id -G | tr ' ' '\\n' | grep -qx 2000`,
    // Absolute, both of them: the vendored pair lives ONLY on the mounted volume, and this shell's
    // PATH is the image's own — which is exactly the point.
    `/opt/jr2/bin/node -e ''`,
    `/opt/jr2/bin/rg --version >/dev/null`,
    // tini is PID 1 (ADR-0061): it reaps what the memory guard's kill orphans.
    `[ "$(tr '\\0' ' ' </proc/1/cmdline | cut -d' ' -f1)" = /opt/jr2/bin/tini ]`,
    `harness=; for p in /proc/[0-9]*; do if tr '\\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q '^/opt/jr2/bin/node /opt/jr2/src/main.ts'; then harness="$p"; fi; done`,
    `[ -n "$harness" ]`,
    `printf 'umask=%s\\n' "$(sed -n 's/^Umask:[[:space:]]*//p' "$harness/status")"`,
    `printf 'node=%s\\n' "$(command -v node)"`,
  ].join("\n");
  const out = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", script]);
  const read = (key: string): string =>
    out
      .trim()
      .split("\n")
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";

  assert.equal(read("umask"), "0002", "the Harness runs at umask 002 — ADR-0005's defence in depth outside repo trees");

  const nodePath = read("node");
  assert.notEqual(
    nodePath,
    "/opt/jr2/bin/node",
    `the image's own node is what a shell resolves; resolved: ${nodePath}`,
  );
  assert.ok(nodePath, "the image's own node is on PATH");

  // The PATH append, observed where it exists: in a CHILD. The marker literal never appears in
  // the command itself (`%s` splits it), so the only place the regex can match is the tool
  // RESULT — the output of a bash Working tool the Harness spawned, env-inherited (ADR-0037).
  await waitForAttached(this); // the turn cannot exist before the workspace finished attaching
  assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
  const provider = this.provider;
  await provider.release("bash", { command: `printf 'jr2-path-%s\\n' "probe:$PATH"` });
  let childPath = "";
  for (let i = 0; i < 240 && !childPath; i++) {
    for (const c of provider.calls) {
      const m = c.stream ? /jr2-path-probe:([^"\\]+)/.exec(c.raw) : null;
      if (m) childPath = m[1]!;
    }
    if (!childPath) await sleep(500);
  }
  assert.ok(childPath, `no provider request ever carried the PATH probe (${provider.calls.length} recorded)`);
  assert.ok(
    childPath.endsWith(":/opt/jr2/bin"),
    `the Harness APPENDS /opt/jr2/bin and its tool children inherit it; the child saw "${childPath}"`,
  );
  assert.ok(
    !childPath.startsWith("/opt/jr2/bin"),
    `…and never prepends it — the image's toolchain must come first; the child saw "${childPath}"`,
  );
});

/**
 * ADR-0037/0005: `kubectl exec -c harness` hands a human the agent's tools, worktrees, and files —
 * and, because jr2 overrides the container's COMMAND and nothing else, the environment the image's
 * author built. images/default's WORKDIR is /srv/jr2-e2e, which the retired wrap could not have
 * produced (it forced /work), so where the shell lands is the assertion that the image ran
 * byte-for-byte.
 */
Then(
  "a human's shell in the Sandbox lands in {string} with the image's own toolchain",
  async function (this: E2EWorld, workdir: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    // No `-w`: the landing directory is the IMAGE's WORKDIR. It has no effect on the Agent — every
    // Working tool carries its own cwd — which is why the image is free to choose it.
    const out = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", "pwd && jr2-toolchain"]);
    const [landed, toolchain] = out.trim().split("\n");
    assert.equal(landed, workdir, "exec lands in the image's own WORKDIR — jr2 overrides only the command");
    assert.equal(toolchain, "jr2-toolchain-ok", "the human gets the Sandbox Image's own tools, not jr2's");
  },
);

/**
 * ADR-0005: the attach stamped a default ACL on the repo root before the clone filled it, and a
 * default ACL makes POSIX IGNORE the creating process's umask — so a file born under the most
 * hostile umask there is still lands 664, group-writable for the work group. This is the whole
 * "zero umask lines in any image" promise, and only a real filesystem can prove the inheritance.
 */
Then(
  "a file created under umask 077 in repo {string} branch {string} is group-writable",
  async function (this: E2EWorld, repo: string, branch: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const probe = `/work/${repo}/${branch}/.jr2-acl-probe`;
    const script = `umask 077; rm -f '${probe}'; touch '${probe}'; stat -c %a '${probe}'; rm -f '${probe}'`;
    const out = await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-ec", script]);
    assert.equal(out.trim(), "664", "the default ACL governs creation modes, not the writer's umask (ADR-0005)");
  },
);

Then("the run's Sandbox becomes Ready", async function (this: E2EWorld): Promise<void> {
  const sandbox = await waitForReadySandbox(this);
  this.sandboxBefore = sandbox.metadata.name;
});

/** The string is the Repo SLOT (ADR-0051) — the Machine's own word for the repository, which is
 * also the directory under `/work`. Every kind workflow binds its one slot, `app`, to the seed. */
Then(
  "the run's Sandbox has repo {string} checked out on branch {string}",
  async function (this: E2EWorld, slot: string, branch: string): Promise<void> {
    await waitForAttached(this); // attach is post-Ready — the pod being up is not the worktree being there
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const workdir = `/work/${slot}/${branch}`;
    // The attach contract (ADR-0004), read straight out of the pod: a worktree on the branch, whose
    // objects are BORROWED from the node's Repo cache — mounted read-only at `/repos/<key>`, the key
    // derived from the url exactly as the Orchestrator derives it — rather than copied.
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
      `/work/${slot}/default/.git/objects/info/alternates`,
    ]);
    assert.equal(alternates.trim(), `/repos/${repoKey(SEED_URL)}/objects`);
  },
);

/**
 * The Repo as the INSTANCE reports it (ADR-0048/0051): `jr2 status` with no run asks the
 * Orchestrator for every Repo resource and its per-node state, which is the cache agent's own
 * account. A Sandbox reached Ready only because the cache was present and fetched on its node, so
 * this is the same fact read from the other side — the side a human asks when a clone will not.
 * The string is the url; the report is keyed by the cache key derived from it.
 */
Then(
  "jr2 status reports repo {string} present on the node",
  async function (this: E2EWorld, url: string): Promise<void> {
    const key = repoKey(url);
    let last: RepoStatus | undefined;
    for (let i = 0; i < 60; i++) {
      const r = await this.runCli(["status", "--json"]);
      assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
      const { dataPlane, repos } = this.resultJson<{ dataPlane: boolean; repos: RepoStatus[] }>();
      assert.equal(dataPlane, true, "an instance whose Machines compose a Sandbox has a data plane");
      last = repos.find((repo) => repo.key === key);
      if (last?.nodes.some((n) => n.present)) return;
      await sleep(1000);
    }
    throw new Error(`no node reports Repo ${key} (${url}) present (last: ${JSON.stringify(last)})`);
  },
);

Then("the run's Sandbox runs the Custodian beside the Harness", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const names = (await kubectl(this, ["get", "pod", pod, "-o", "jsonpath={.spec.containers[*].name}"])).split(/\s+/);
  // ADR-0005's "the pod, not the container, is the isolation unit" has a second resident — and the
  // operator scheduled it without understanding it (ADR-0001: sidecars are opaque fragments).
  assert.ok(names.includes("harness"), `the Harness container is there (got: ${names.join(", ")})`);
  assert.ok(names.includes("custodian"), `the Custodian container is there (got: ${names.join(", ")})`);
});

Then("the delivery is refused as unauthorized", function (this: E2EWorld): void {
  assert.match(
    this.podSays ?? "",
    /HTTP 401 jr2-held-JR2_SANDBOX_TOKEN/,
    `the Orchestrator must refuse an Agent bearing only the Stand-in (pod said: ${this.podSays?.trim()})`,
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

// --- a command Effect in a real Sandbox (ADR-0067) -------------------------------------------------

/** Start a workflow with a run input, detached, and keep its id — the `commanded` workflow's mode. */
When(
  "I start the {string} workflow with input {string} detached",
  async function (this: E2EWorld, wf: string, input: string): Promise<void> {
    await this.runCli(["run", wf, "--detach", "--input", input]);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

/** The command's output, as the body routed on it and the wrapper forwarded it. */
async function commandOutput(world: E2EWorld): Promise<{ outcome?: string; code?: number; tail?: string }> {
  const settled = await waitSettled(world);
  assert.equal(settled.status, "done", `the run settled ${settled.status}`);
  return (settled.context.output ?? {}) as { outcome?: string; code?: number; tail?: string };
}

Then("the command exited with code {int}", async function (this: E2EWorld, code: number): Promise<void> {
  const output = await commandOutput(this);
  assert.equal(output.outcome, "exited");
  assert.equal(output.code, code, "the exit code is output, and the Machine routed on it");
});

Then("the command received {string} as one argument", async function (this: E2EWorld, text: string): Promise<void> {
  const output = await commandOutput(this);
  assert.equal(output.outcome, "exited");
  assert.deepEqual(JSON.parse(output.tail ?? "null"), [text], "argv, never shell text");
});

/** The `restart` command has run far enough to mark its run in the Worktree — so a restart from
 * here cuts a command that is surely running, not one whose request has yet to leave. */
Then("the command has started in the Sandbox", async function (this: E2EWorld): Promise<void> {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  for (let i = 0; i < 60; i++) {
    const out = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-c",
      "cat /work/*/*/.jr2-e2e-runs 2>/dev/null || true",
    ]).catch(() => "");
    if (out.includes("x")) return;
    await sleep(500);
  }
  throw new Error("the command never marked its run in the Worktree");
});

Then("the command's tail is {string}", async function (this: E2EWorld, tail: string): Promise<void> {
  const output = await commandOutput(this);
  assert.equal(output.tail?.trim(), tail);
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
    const iid = continuedIid(this.runId!, "body", "coder");
    let last: Array<{ outcome: string }> = [];
    for (let i = 0; i < 60; i++) {
      last = await settlements(this, iid);
      if (last.length === count) break;
      await sleep(500);
    }
    assert.equal(last.length, count, `settlements: ${JSON.stringify(last)}`);
    assert.ok(
      last.every((s) => s.outcome === outcome),
      `every settled Turn settled "${outcome}" (got: ${JSON.stringify(last)})`,
    );
  },
);

/**
 * The model is still writing its answer (ADR-0038): the Turn's request is parked at the scripted
 * model, which this step does not release. A state exit from here on can reach the Harness only as
 * the Orchestrator's abort.
 */
Then(
  "the scripted model is holding the Agent's request offering {string}",
  async function (this: E2EWorld, tool: string) {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.holding(tool);
  },
);

/**
 * The abort ended the request, not only the settlement (ADR-0024): `Conversation.abort()` settles
 * the Submission `aborted` at once, before the engine stops, so the settlement alone does not show
 * that the model's request was cut.
 */
Then(
  "the scripted model's request offering {string} was cut with no answer",
  async function (this: E2EWorld, tool: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.cut(tool);
  },
);

/**
 * The turn the Orchestrator's sweep ended for a cause other than the Agent's pick (ADR-0024): settled
 * `aborted` with the sweep's type and no message. A Turn that its own pick ended settles `ended`, and
 * a Turn whose Harness waited for a sweep that never came carries a message ("… no sweep came …"),
 * so this tells the sweep's `aborted` from both.
 */
Then(
  "the Harness reports the Agent's turn settled by the Orchestrator's abort",
  async function (this: E2EWorld): Promise<void> {
    const iid = continuedIid(this.runId!, "body", "coder");
    let last: HarnessSettlement[] = [];
    for (let i = 0; i < 60; i++) {
      last = await settlements(this, iid);
      if (last.length > 0) break;
      await sleep(500);
    }
    assert.deepEqual(
      last.map((s) => ({ outcome: s.outcome, error: s.error })),
      [{ outcome: "aborted", error: { type: "submission_aborted" } }],
      `settlements: ${JSON.stringify(last)}`,
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

// ADR-0059: a client-side apply copies a whole Secret, its values too, into this annotation. Every
// Secret `jr2 up` writes is applied server-side, so after a converge no Secret of the namespace has
// it. The template prints each name and a mark, never a value.
Then(
  "no Secret in the namespace has a last-applied-configuration annotation",
  async function (this: E2EWorld): Promise<void> {
    const template =
      '{{range .items}}{{.metadata.name}}{{"\\t"}}{{if .metadata.annotations}}' +
      '{{if index .metadata.annotations "kubectl.kubernetes.io/last-applied-configuration"}}annotated{{end}}' +
      '{{end}}{{"\\n"}}{{end}}';
    const rows = (await kubectl(this, ["get", "secrets", "-o", `go-template=${template}`]))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
    assert.ok(rows.length > 0, "the converge wrote Secrets");
    const annotated = rows.filter(([, mark]) => mark === "annotated").map(([name]) => name);
    assert.deepEqual(annotated, [], "a Secret with this annotation has its values in its metadata");
  },
);

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

/** containerd normalizes a local tag; every root spells it the short way (the CLI's `normalizeRef`).
 * A ref pinned by digest (the Custodian's, a Pinned image) is held as `repo@digest`: a pull that
 * names a digest records no tag, so the tag is dropped on both sides. */
const shortRef = (ref: string): string =>
  ref.replace(/^docker\.io\/library\//, "").replace(/:[^/@]+(@sha256:[0-9a-f]{64})$/, "$1");

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

/** Every ref this instance's image map names — the root that says what future Sandboxes will run.
 * The KEYS that hold refs are named, not discovered: the map also carries `sandboxUser` (built
 * images' `USER` strings, where `""` is data — "declares none", ADR-0037), and a shape-blind
 * flatten would read those as refs and demand the node hold an image named `""`. */
async function imageMapRefs(world: E2EWorld): Promise<string[]> {
  const out = await kubectl(world, ["get", "configmap", IMAGES_CONFIGMAP, "-o", "json"]);
  const raw = (JSON.parse(out) as { data?: Record<string, string> }).data?.[IMAGES_KEY];
  assert.ok(raw, `the ${IMAGES_CONFIGMAP} ConfigMap carries ${IMAGES_KEY} (ADR-0038)`);
  const parsed = JSON.parse(raw) as { harness?: string; custodian?: string; sandbox?: Record<string, string> };
  return [parsed.harness, parsed.custodian, ...Object.values(parsed.sandbox ?? {})].filter(
    (n): n is string => typeof n === "string" && n !== "",
  );
}

Given(
  "a labeled image no live root names is loaded onto every node",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const ref = `jr2-e2e-garbage:${randomBytes(6).toString("hex")}`;
    // A one-layer image from `scratch`: kilobytes, no base to pull, and a real image config to
    // carry the stamp. The layer's content is random, so the load is a real import every time
    // rather than a re-tag of an id the node already holds. The labels go on the COMMAND LINE,
    // never in the Dockerfile — the same rule `jr2 up` follows (ADR-0037/0039) — and `jr2.dev/kind`
    // is what makes the image jr2's to take at all.
    const dir = await mkdtemp(join(tmpdir(), "jr2-e2e-garbage-"));
    try {
      await writeFile(join(dir, "marker"), `${ref} ${randomBytes(16).toString("hex")}\n`);
      await writeFile(join(dir, "Dockerfile"), "FROM scratch\nCOPY marker /marker\n");
      await exec("docker", [
        "build",
        "-t",
        ref,
        "--label",
        "jr2.dev/kind=sandbox",
        "--label",
        `jr2.dev/instance=${this.namespace}`,
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
  // No `-n`: `jr2 gc` asks the whole cluster what it still needs, so it addresses no instance.
  const r = await this.runCli(["gc"], { namespaced: false });
  assert.equal(r.code, 0, `jr2 gc failed: ${r.stderr}`);
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

// --- the fetch inside the pod (ADR-0053) -----------------------------------------------------------
//
// `origin`'s fetch url is a PROGRAM on the runtime volume, not a path: git runs it, it asks the
// Custodian on localhost, the ask rides the Sandbox CR onto the pod, the node's cache agent fetches
// the remote, and only then does `git upload-pack` serve the cache. Every leg of that exists
// nowhere else — a static binary on a mounted volume, a loopback route, a CR annotation the
// operator copies onto the pod, a DaemonSet, and a real remote — so this is the one tier that can
// watch a commit pushed a moment ago arrive on the next `git fetch`.

/** How long a fetch inside the pod may take before it stops being evidence. The Orchestrator's own
 * wait is 60s plus slack, and the cache's refresh interval — the latency this decision deletes —
 * is 5 minutes; a fetch past this bound either fell through to the cache (which the ref assertion
 * catches first) or waited on something ADR-0053 budgeted for nobody. */
const IN_POD_FETCH_BUDGET_MS = 120_000;

/** The pod-local clone a Repo Slot's worktrees borrow from — where `origin` lives (ADR-0004). */
const clonePath = (slot: string): string => `/work/${slot}/default`;

/**
 * Run one `git fetch` in a named seat of the Sandbox, and time it. Both seats mount the SAME
 * `/work`, so both drive the same `origin` out of the same config — which is the point of the
 * User Container variant: the program, not the seat, is what makes a fetch reach the remote.
 *
 * The output is folded onto stdout and the exit code printed, rather than let `kubectl` throw:
 * ADR-0053's degrade path writes one warning line to stderr and STILL exits 0, so a fetch that
 * served stale objects looks exactly like a fresh one from the outside. Keeping both here puts
 * that line in the failure message of whichever assertion catches it.
 */
async function fetchInSeat(world: E2EWorld, seat: "harness" | "user", remote: string, slot: string): Promise<void> {
  await waitForAttached(world); // the clone cannot be fetched before the attach made it
  const pod = (await waitForReadySandbox(world)).metadata.name;
  const started = Date.now();
  world.podSays = await kubectl(world, [
    "exec",
    `pod/${pod}`,
    "-c",
    seat,
    "--",
    "sh",
    "-c",
    `git -C '${clonePath(slot)}' fetch ${remote} 2>&1; echo "jr2-fetch-exit=$?"`,
  ]);
  world.fetchMs = Date.now() - started;
  assert.match(
    world.podSays,
    /jr2-fetch-exit=0\b/,
    `\`git fetch ${remote}\` failed in the ${seat} seat — the program serves the cache even when the ` +
      `remote fetch fails (ADR-0053), so a NON-zero exit means git never reached the program at all: ` +
      `${world.podSays.trim()}`,
  );
}

/**
 * The remote moves (ADR-0053's concrete case: a human pushes a fix the Agent must have now). On a
 * branch of this scenario's own — the seed is one shared repository and the tier runs `--parallel`
 * — so what the pod must see is a ref no other scenario can touch.
 */
When(
  "a commit is pushed to the seed on a branch of its own",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    this.pushedBranch = `fresh-${randomBytes(4).toString("hex")}`;
    this.pushedSha = await pushToSeed(this.pushedBranch);
  },
);

/** The Agent's seat. `git fetch` is the verb — there is no jr2 verb for this, and nothing in the
 * Menu: a fetch is not something the Agent SAYS, it is something it does (ADR-0053). */
When(
  "the Harness container fetches {string} in repo {string}",
  { timeout: 180_000 },
  async function (this: E2EWorld, remote: string, slot: string): Promise<void> {
    await fetchInSeat(this, "harness", remote, slot);
  },
);

/** The human's seat (ADR-0005/0053): the same fetch, from an image with no jr2 knowledge, no env of
 * jr2's, and no credential of its own — reaching a remote it cannot address, through a static
 * program on a read-only mount. */
When(
  "the User Container fetches {string} in repo {string}",
  { timeout: 180_000 },
  async function (this: E2EWorld, remote: string, slot: string): Promise<void> {
    await fetchInSeat(this, "user", remote, slot);
  },
);

/**
 * The claim itself, and it is asserted with NO polling on purpose: one `git fetch` has returned,
 * and the commit pushed seconds ago is already the remote-tracking head. A cache that only
 * refreshed on its interval would answer the same fetch with the objects it happened to hold and
 * pass a polling version of this test five minutes later.
 *
 * Read from the HARNESS seat whichever seat did the fetching: `/work` is one volume, so the refs
 * the User Container updated are the Agent's refs too — one worktree, two seats (ADR-0005).
 */
Then(
  "the pushed commit is the head of that branch in repo {string}",
  async function (this: E2EWorld, slot: string): Promise<void> {
    assert.ok(this.pushedBranch && this.pushedSha, "a commit was pushed to the seed in a prior step");
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const head = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "git",
      "-C",
      clonePath(slot),
      "rev-parse",
      `refs/remotes/origin/${this.pushedBranch}`,
    ]);
    assert.equal(
      head.trim(),
      this.pushedSha,
      `the fetch served the remote's now, not the cache's last refresh (git said: ${this.podSays?.trim()})`,
    );
  },
);

/** What the decision is FOR: the latency of a fetch is a round trip through the node agent, not
 * the interval that used to be the only path from a remote into a pod. */
Then("the fetch cost seconds, not the cache's refresh interval", function (this: E2EWorld): void {
  assert.ok(this.fetchMs !== undefined, "a fetch inside the pod was timed in a prior step");
  assert.ok(
    this.fetchMs < IN_POD_FETCH_BUDGET_MS,
    `the fetch took ${this.fetchMs}ms — an ask is one remote round trip through the node agent ` +
      `(ADR-0053), and the 5-minute refresh interval is what it replaced`,
  );
});

/**
 * The trace the ask leaves, read off the CR the way a human would (ADR-0053). Two halves of one
 * mechanism: the Orchestrator's MARK — one annotation per Repo key, timestamp value, the Lease's
 * shape — and the operator's standing per-key entry saying which fetch answered it. The entry's
 * own `asked` is the later of the pod's birth and the mark, so it can never be older than the
 * annotation; `fetched` at or after it is the landing the program waited for.
 *
 * The annotation is SPELLED here rather than imported, for the reason `ROUTABILITY_MARKER` gives
 * below: the Orchestrator writes it in TypeScript and the operator reads it in Go, so no import
 * can enforce the agreement — and a literal on this side is the third witness that the two spell
 * it the same.
 */
Then(
  "the Sandbox's ask for repo {string} is answered by the fetch its status reports",
  async function (this: E2EWorld, url: string): Promise<void> {
    const key = repoKey(url);
    const name = (await waitForReadySandbox(this)).metadata.name;
    const cr = JSON.parse(await kubectl(this, ["get", "sandbox", name, "-o", "json"])) as SandboxCR;
    const mark = cr.metadata.annotations?.[`jr2.dev/asked-${key}`];
    assert.ok(
      mark,
      `the Sandbox carries jr2.dev/asked-${key} (annotations: ${JSON.stringify(cr.metadata.annotations)})`,
    );
    const entry = cr.status?.repos?.find((r) => r.key === key);
    assert.ok(entry, `the Sandbox reports a standing entry for ${key} (status: ${JSON.stringify(cr.status)})`);
    const at = (stamp: string | undefined): number => (stamp ? Date.parse(stamp) : Number.NaN);
    assert.ok(
      at(entry.asked) >= at(mark),
      `the entry's ask is the later of the pod's birth and the mark (asked ${entry.asked}, mark ${mark})`,
    );
    assert.ok(
      at(entry.fetched) >= at(entry.asked),
      `a fetch that started BEFORE the ask does not answer it (entry: ${JSON.stringify(entry)})`,
    );
  },
);

/** Escape one string for use inside a RegExp — the urls and identities below are full of dots. */
const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a human reads in `git remote -v` (ADR-0053). The fetch line is a COMMAND — git's built-in
 * `ext::` transport, the program's absolute path on the runtime volume, git's own `%S` service
 * substituted, and the Repo's IDENTITY. Never the cache key: a key is a derived directory name
 * (ADR-0004), not a name a human should have to read. The push line is untouched — the Binding's
 * own spelling, the caller's own credential, never the Agent's (ADR-0005).
 */
Then(
  "origin in repo {string} fetches through the program and pushes to {string}",
  async function (this: E2EWorld, slot: string, url: string): Promise<void> {
    await waitForAttached(this);
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const out = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "git",
      "-C",
      clonePath(slot),
      "remote",
      "-v",
    ]);
    const lines = out.trim().split("\n");
    const fetch = lines.find((l) => l.endsWith("(fetch)")) ?? "";
    const push = lines.find((l) => l.endsWith("(push)")) ?? "";
    const { identity, key } = repoIdentity(url);
    assert.match(
      fetch,
      new RegExp(`^origin\\s+ext::/opt/jr2/bin/jr2-upload-pack %S ${rx(identity)}\\s+\\(fetch\\)$`),
      `origin fetches through the program, named by identity (got: ${JSON.stringify(lines)})`,
    );
    assert.ok(!fetch.includes(key), `the url carries the identity, never the derived cache key ${key}`);
    assert.match(
      push,
      new RegExp(`^origin\\s+${rx(url)}\\s+\\(push\\)$`),
      "the push url is the Binding's own spelling",
    );
  },
);

/**
 * The seat's half of ADR-0053: `/opt/jr2` is there, holding the program, and it is READ-ONLY —
 * ADR-0005's `/repos` argument applied once more, not a second exception. Presence is asserted
 * first and for a reason: a seat with no mount at all would also refuse the write, and would then
 * pass a test that only watched the write fail.
 */
Then(
  "the User Container holds the program, on a read-only {string}",
  async function (this: E2EWorld, mount: string): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const out = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "user",
      "--",
      "sh",
      "-c",
      `[ -x /opt/jr2/bin/jr2-upload-pack ] && echo program=present; touch '${mount}/.jr2-ro-probe' 2>/dev/null && echo wrote=yes || echo wrote=no`,
    ]);
    assert.match(out, /program=present/, `the runtime volume reached the User Container (said: ${out.trim()})`);
    assert.match(out, /wrote=no/, `${mount} is mounted read-only in the User Container (said: ${out.trim()})`);
  },
);

// --- the Instance Harness (ADR-0031) ---------------------------------------------------------------
//
// A `workspace: "none"` Agent's Turn is admitted at the Instance Harness — the StatefulSet `jr2 up`
// converged because a registered Machine carries such a definition — and nowhere else, even when
// the Machine invoking it sits inside a `workspace()`. Where a conversation lives is a fact only
// the Harnesses themselves can answer (ADR-0024/0027: a settlement is invisible to the
// Orchestrator by construction), so both are asked the same question over the same wire: the
// Instance Harness must hold the conversation, the run's Sandbox must not.

/** The Instance Harness's StatefulSet/Service/pod-label name — spelled the way `kubectl get pods`
 * shows it (ADR-0010: a black-box step names what a user sees, and imports nothing from the kit
 * it tests at arm's length). */
const INSTANCE_HARNESS = "jr2-instance-harness";

/** The Instance Harness's Running pod in this scenario's namespace — converged by `jr2 up`
 * whenever a carried definition declares `workspace: "none"`, which the kind instance's `advisor`
 * does, so it is there in every scenario whether or not one uses it. */
async function instanceHarnessPod(world: E2EWorld): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const out = await kubectl(world, [
      "get",
      "pods",
      "-l",
      `app=${INSTANCE_HARNESS}`,
      "--field-selector=status.phase=Running",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ]);
    if (out.trim()) return out.trim();
    await sleep(1000);
  }
  throw new Error(
    `no Running ${INSTANCE_HARNESS} pod in ${world.namespace} — \`jr2 up\` converges it whenever a carried ` +
      `Agent definition declares workspace: "none" (ADR-0031); the kind instance's advisor does`,
  );
}

/** What a Harness answers when asked for one conversation: 200 with its history, or 404 — the
 * `?view=history` wire (ADR-0027), read over a port-forward to the pod, bearing the bearer of the
 * `placement` that pod is (ADR-0058). */
async function conversationStatus(
  world: E2EWorld,
  pod: string,
  placement: string,
  agent: string,
  iid: string,
): Promise<number> {
  const headers = await harnessAuth(world, placement);
  let status = 0;
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/${agent}/${encodeURIComponent(iid)}?view=history`, { headers });
    status = res.status;
    await res.text();
  });
  return status;
}

/** The RUN's own seed Instance ID, as `jr2 status` reports it (ADR-0033). It names the run and
 * nothing else — jr2 mints every Agent conversation id itself (ADR-0057) — so the one claim it
 * still serves here is `task`'s default branch, `jr2/task-<run id>`. */
async function runInstanceId(world: E2EWorld): Promise<string> {
  const r = await world.runCli(["status", world.runId!]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  const { instanceId } = world.resultJson<{ instanceId: string }>();
  assert.ok(instanceId, "the run reports its instance id");
  return instanceId;
}

/** The Machine an Agent's Turn was invoked from, as a step names it — `root` (the Machine the run
 * starts with) or `body` (the Machine a `workspace()` invokes inside its Workspace). It is the
 * middle segment of the Instance ID (ADR-0057), so the step text says out loud which conversation
 * it is asking about. */
function machineOf(word: string): "root" | "body" {
  assert.ok(
    word === "root" || word === "body",
    `a kind fixture invokes its Agents from "root" or "body", not "${word}"`,
  );
  return word;
}

/**
 * The scripted model answers a parked turn — whichever Harness parked it. The step for the
 * Sandbox's Agent waits for the workspace to attach first; this one does not, because the turn it
 * releases is admitted at the Instance Harness (ADR-0031) and there may be no Workspace at all.
 */
When(
  "the model answers {string} with summary {string}",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.release(tool, { summary });
  },
);

/**
 * The same release for a pick that takes no params: its Menu schema allows no property
 * (`additionalProperties: false`), and the engine refuses a call that carries one before it runs.
 */
When("the model answers {string} with no arguments", async function (this: E2EWorld, tool: string): Promise<void> {
  assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
  await this.provider.release(tool, {});
});

/**
 * ADR-0028's `"none"`, seen on the wire: the turn's request carries this state's one Menu tool and
 * NOT ONE of the Working tools — not read-only, not bash, nothing. The stock Harness under
 * `JR2_MENU_ONLY` is what withholds them, so this is the Instance Harness's own contract, asserted
 * off the request it actually sent.
 */
Then(
  "the model was offered {string} from the Menu and no Working tools",
  async function (this: E2EWorld, tool: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running");
    const provider = this.provider;
    let seen: string[][] = [];
    for (let i = 0; i < 240; i++) {
      seen = provider.calls.filter((c) => c.stream).map((c) => c.tools);
      if (seen.some((tools) => tools.includes(`mcp__jr2__${tool}`))) break;
      await sleep(500);
    }
    const turn = seen.find((tools) => tools.includes(`mcp__jr2__${tool}`));
    assert.ok(turn, `no turn was offered "mcp__jr2__${tool}" (offered: ${JSON.stringify(seen)})`);
    assert.deepEqual(
      turn.filter((t) => t.startsWith("mcp__jr2__")),
      [`mcp__jr2__${tool}`],
      "the turn sees this state's Menu and no other's (ADR-0015)",
    );
    const working = turn.filter((t) => WORKING_TOOLS.includes(t));
    assert.deepEqual(working, [], `a Menu-only Agent is offered no Working tool (ADR-0028); got ${turn.join(", ")}`);
  },
);

Then(
  "the Instance Harness holds the {string} conversation of the run's {word} Machine",
  { timeout: 180_000 },
  async function (this: E2EWorld, agent: string, machine: string): Promise<void> {
    const iid = continuedIid(this.runId!, machineOf(machine), agent);
    const pod = await instanceHarnessPod(this);
    let last = 0;
    for (let i = 0; i < 90; i++) {
      last = await conversationStatus(this, pod, INSTANCE_HARNESS_SERVICE, agent, iid);
      if (last === 200) return;
      await sleep(1000);
    }
    throw new Error(
      `the Instance Harness never held /agents/${agent}/${iid} (last HTTP ${last}) — a workspace: "none" ` +
        `Turn is admitted there and nowhere else (ADR-0031)`,
    );
  },
);

/** The other half of definition-wins: the run HAS a Sandbox, and its Harness never saw the
 * advisor's conversation. Asked after the Instance Harness answered 200 for the same (agent, iid),
 * so a 404 here is placement, not timing. */
Then(
  "the run's Sandbox holds no {string} conversation of the run's {word} Machine",
  async function (this: E2EWorld, agent: string, machine: string): Promise<void> {
    const iid = continuedIid(this.runId!, machineOf(machine), agent);
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const status = await conversationStatus(this, pod, pod, agent, iid);
    assert.equal(
      status,
      404,
      `the Sandbox's Harness answered ${status} for /agents/${agent}/${iid} — nearest-wins placement, which ADR-0031 rejects`,
    );
  },
);

Then("no Sandbox was provisioned for the run", async function (this: E2EWorld): Promise<void> {
  assert.deepEqual(await sandboxesFor(this), [], "a Menu-only workflow composes no Sandbox and provisions none");
});

// --- a Repo that cannot sync (ADR-0048) ------------------------------------------------------------

/**
 * The instance's own report of a Repo whose every attempt fails: `jr2 status` with no run lists
 * the resource with the cache agent's per-node entry — absent (no clone), not synced, and git's
 * words as `lastError` — and spells the same on stderr, the line a human acts on. Polled, because
 * the boot states the resource and the agent's probe lands a moment later.
 */
Then(
  "jr2 status reports repo {string} absent with git's error",
  { timeout: 180_000 },
  async function (this: E2EWorld, url: string): Promise<void> {
    const key = repoKey(url);
    let last: RepoStatus | undefined;
    for (let i = 0; i < 90; i++) {
      const r = await this.runCli(["status", "--json"]);
      assert.equal(r.code, 0, `jr2 status must still answer with a degraded Repo (ADR-0048): ${r.stderr}`);
      const { repos } = this.resultJson<{ repos: RepoStatus[] }>();
      last = repos.find((repo) => repo.key === key);
      const failed = last?.nodes.find((n) => !n.present && !n.synced && n.lastError);
      if (failed) {
        // The table a human reads (ADR-0009 as amended: a report verb) spells the node out with
        // git's own error — the same fact the object above carries as `lastError`.
        const table = await this.runCli(["status"]);
        assert.equal(table.code, 0, `jr2 status failed: ${table.stderr}`);
        assert.match(
          table.stdout,
          new RegExp(`^repo ${rx(key)} \\(${rx(url)}\\)`, "m"),
          "the Repo heads its block in the table",
        );
        assert.match(
          table.stdout,
          new RegExp(`^  node ${rx(failed.node)}: absent — `, "m"),
          "the failing node is spelled out in the table with git's own error",
        );
        assert.match(failed.lastError ?? "", /not found/i, `git's own words name the cause: ${failed.lastError}`);
        return;
      }
      await sleep(1000);
    }
    throw new Error(`no node ever reported Repo ${key} (${url}) absent with an error (last: ${JSON.stringify(last)})`);
  },
);

/**
 * The moment the degradation bites is the moment it is reported, to the run that owns the
 * consequence (ADR-0048): the operator holds the Sandbox on its Repo, the cache agent's clone onto
 * the pod's node fails, and the provision fails BY NAME — the Repo, the node, git's words — rather
 * than burning the Repo budget. The fault is the run's, readable through `jr2 status <runId>`.
 */
Then(
  "the run faults naming repo {string} and git's error",
  { timeout: 300_000 },
  async function (this: E2EWorld, url: string): Promise<void> {
    const key = repoKey(url);
    let last: WsStatus & { fault?: string } = await wsStatus(this);
    for (let i = 0; i < 240 && last.status !== "error"; i++) {
      await sleep(1000);
      last = await wsStatus(this);
    }
    assert.equal(last.status, "error", `the run never faulted (last: ${JSON.stringify(last)})`);
    const fault = last.fault ?? "";
    assert.match(
      fault,
      new RegExp(`Repo "${rx(key)}" could not be cloned onto node \\S+: `),
      `the fault names the Repo and the node (fault: ${fault})`,
    );
    assert.match(fault, /not found/i, `…and carries git's own error (fault: ${fault})`);
  },
);

// --- the Repo sweep (ADR-0051) ---------------------------------------------------------------------
//
// `jr2 gc --repo-ttl` deletes the RESOURCE; the bytes on each node are the cache agent's to
// reclaim, once nothing there mounts them. Both halves are asserted, and the second on the node
// itself: a sweep whose narration says "swept 1" but whose bare clone stays on disk is the
// defect this scenario exists to see. The TTL is one minute rather than `0`, and the sweep is
// repeated until the Repo is that old: the sweep is cluster-wide and the tier runs `--parallel`,
// so a zero TTL would take another scenario's per-run Repo out from under its live Sandbox.

/** One Repo's bare clone on a node (ADR-0051): `<hostPath>/<namespace>/repos/<key>`, read on the
 * kind node itself — the layout `jr2 status`'s runbook names for a human with node access. */
const cacheDirOn = (namespace: string, key: string): string => `/var/lib/jr2/${namespace}/repos/${key}`;

/** Every node of the cluster that still holds this Repo's cache directory. */
async function nodesHoldingCache(world: E2EWorld, key: string): Promise<string[]> {
  assert.ok(world.namespace, "a @kind scenario has its namespace set");
  const dir = cacheDirOn(world.namespace, key);
  const holding: string[] = [];
  for (const node of await kindNodes()) {
    const { stdout } = await exec("docker", ["exec", node, "sh", "-c", `[ -d '${dir}' ] && echo yes || echo no`]);
    if (stdout.trim() === "yes") holding.push(node);
  }
  return holding;
}

Then("a node still holds the cache of repo {string}", async function (this: E2EWorld, url: string): Promise<void> {
  const key = repoKey(url);
  const holding = await nodesHoldingCache(this, key);
  assert.ok(
    holding.length > 0,
    `no node holds ${cacheDirOn(this.namespace!, key)} — the run's clone should outlive the run`,
  );
});

When(
  "I sweep Repos no run attached within {string}, once repo {string} is that old",
  { timeout: 300_000 },
  async function (this: E2EWorld, ttl: string, url: string): Promise<void> {
    const key = repoKey(url);
    for (let i = 0; i < 24; i++) {
      // No `-n`: `jr2 gc` reads every instance namespace on the cluster (ADR-0039/0051).
      const r = await this.runCli(["gc", "--repo-ttl", ttl], { namespaced: false });
      assert.equal(r.code, 0, `jr2 gc failed: ${r.stderr}`);
      const left = await kubectl(this, ["get", "repos.core.jr2.dev", key, "--ignore-not-found", "-o", "name"]);
      if (!left.trim()) {
        assert.match(r.stderr, /repos: swept \d+ Repo resource\(s\)/, "the sweep narrates what it took");
        return;
      }
      await sleep(10_000);
    }
    throw new Error(`Repo ${key} was never swept under --repo-ttl ${ttl} (last gc said: ${this.last?.stderr})`);
  },
);

Then("jr2 status no longer lists repo {string}", async function (this: E2EWorld, url: string): Promise<void> {
  const key = repoKey(url);
  const r = await this.runCli(["status", "--json"]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  const { repos } = this.resultJson<{ repos: RepoStatus[] }>();
  assert.ok(!repos.some((repo) => repo.key === key), `Repo ${key} is still listed after the sweep`);
});

Then("jr2 status still lists repo {string} as bound", async function (this: E2EWorld, url: string): Promise<void> {
  const key = repoKey(url);
  const r = await this.runCli(["status", "--json"]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  const { repos } = this.resultJson<{ repos: RepoStatus[] }>();
  const bound = repos.find((repo) => repo.key === key);
  assert.equal(
    bound?.bound,
    true,
    `the Repo a Machine binds is never on the sweep's clock (got: ${JSON.stringify(bound)})`,
  );
});

Then(
  "no node holds the cache of repo {string} any more",
  { timeout: 180_000 },
  async function (this: E2EWorld, url: string): Promise<void> {
    const key = repoKey(url);
    let holding: string[] = [];
    for (let i = 0; i < 150; i++) {
      holding = await nodesHoldingCache(this, key);
      if (holding.length === 0) return;
      await sleep(1000);
    }
    throw new Error(
      `${holding.join(", ")} still hold ${cacheDirOn(this.namespace!, key)} — the resource is gone and no pod ` +
        `mounts the cache, so the cache agent owes its removal (ADR-0051)`,
    );
  },
);

// --- a shipped Machine, registered the way a consumer registers it (ADR-0054) ----------------------
//
// `@jr2/machines` ships Machines for END USERS, and the only proof one works in jr2 is the stock
// Harness driving it in a real Sandbox — so every Machine the kit ships owns a scenario here, over
// `workflows/task.ts`, which is one `customize` line and nothing else. What these steps read is the
// Machine's own surface: the Gate it parks at, the `meta` it publishes there, the branch it chose,
// and the ONE conversation its coder keeps across the round trip.
//
// Only two steps know they are about `task`: its conversation address and its default branch. The
// rest is how a human works any parked run — find the Gate by asking the run, deliver with
// `jr2 send`, read the branch off the Gate's own meta.

/**
 * Where `task`'s coder conversation lives on the pod (ADR-0054/0057). The Machine writes
 * `continue: true` and nothing else, so jr2 mints the structural id and every Turn of the run
 * lands on that one conversation. `task`'s Agent is invoked from the body the `workspace()` runs
 * inside the Workspace, which is the `body` segment.
 */
const taskCoderIid = (runId: string): string => continuedIid(runId, "body", "coder");

/** A conversation as its Harness reports it (`?view=history` — ADR-0027): `settlements` is the
 * asserted contract, `messages` the best-effort record of what was said. Read over a port-forward
 * to the run's Sandbox, the only place either is true. */
type Conversation = { messages: Array<{ role: string; text: string }>; settlements: Array<{ outcome: string }> };

/** The conversation at `iid`, or `undefined` when this Harness holds none. A 404 is a real answer
 * here, not a failure: it is what a Machine that started a SECOND conversation leaves behind at
 * the address the first one pinned. */
async function conversationOf(world: E2EWorld, agent: string, iid: string): Promise<Conversation | undefined> {
  const pod = (await waitForReadySandbox(world)).metadata.name;
  const headers = await harnessAuth(world, pod);
  let found: Conversation | undefined;
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/${agent}/${encodeURIComponent(iid)}?view=history`, { headers });
    if (res.status === 404) {
      await res.text();
      return;
    }
    assert.equal(res.status, 200, "the Harness serves the conversation history");
    const body = (await res.json()) as Partial<Conversation>;
    found = { messages: body.messages ?? [], settlements: body.settlements ?? [] };
  });
  return found;
}

/**
 * The run's ONE open Gate, read off `jr2 status` — the discovery listing (ADR-0011), which is where
 * a human learns the id `jr2 send --gate` wants. Polled, because parking is a transition like any
 * other; "exactly one" is asserted because a second live Gate would make `jr2 send` ambiguous for
 * the human too.
 */
async function openGate(world: E2EWorld): Promise<OpenGate> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 240; i++) {
    last = await wsStatus(world);
    const gates = last.gates ?? [];
    if (gates.length === 1) return gates[0]!;
    assert.ok(gates.length <= 1, `the run has more than one open Gate: ${JSON.stringify(gates)}`);
    await sleep(500);
  }
  throw new Error(`the run never opened a Gate (last: ${JSON.stringify(last)})`);
}

/** The shipped Machine's door (ADR-0054): one prompt, and everything else defaulted — which is
 * what makes the branch assertion below meaningful. */
When(
  "I start the {string} workflow with prompt {string} detached",
  async function (this: E2EWorld, wf: string, prompt: string): Promise<void> {
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ prompt })]);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

/**
 * The caller's prose reached the model — the whole reason `task` has a door. Asserted off the
 * provider's own recorded request, so what is checked is the text pi put on the wire, not what the
 * Machine believed it sent: between the two sit the input mapper, the admission, the Harness's
 * prompt handling and the engine part.
 */
Then("the model's first turn carries the prompt {string}", async function (this: E2EWorld, prompt: string) {
  assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
  const provider = this.provider;
  for (let i = 0; i < 240; i++) {
    if (provider.calls.some((c) => c.stream && c.raw.includes(prompt))) return;
    await sleep(500);
  }
  throw new Error(
    `no turn request ever carried the door's prompt (${provider.calls.filter((c) => c.stream).length} turn ` +
      `request(s) recorded of ${provider.calls.length})`,
  );
});

/**
 * The park that IS the Machine (ADR-0054): the human's decision, as an addressable resource. The
 * Gate id is checked by its LEAF only — it derives from the actor path, so the prefix is the
 * composition's business and pinning it whole would break the moment `task` were composed under
 * something else. The accepted set is derived from the state's external transitions (ADR-0015), so
 * asserting it here is asserting the derivation, not a literal the Machine wrote down.
 */
Then(
  "the run parks at the {string} Gate, with summary {string}",
  { timeout: 300_000 },
  async function (this: E2EWorld, state: string, summary: string): Promise<void> {
    const gate = await openGate(this);
    assert.match(gate.gate, new RegExp(`${rx(state)}$`), "the Gate id derives from the state key (ADR-0011)");
    assert.deepEqual(
      gate.accepts.map((a) => a.name).sort(),
      ["approve", "request_changes"],
      "the accepted set derives from the state's external transitions (ADR-0015)",
    );
    assert.equal(gate.meta?.summary, summary, "the coder's own account of the turn, where a human reads it");
  },
);

/**
 * The default branch (ADR-0054): `jr2/task-<run id>`, where the id is the run's seed Instance ID —
 * the one `jr2 status` reports, and the only per-run id a door mapper can see. Two concurrent runs
 * of the same Workflow therefore cut two branches and neither owns the other's.
 *
 * The `worktree` beside it — the first slot's, `task`'s own convention — is what makes the Gate an INSPECTION window rather than a notification:
 * a human execs into the still-live pod (parking is retention, ADR-0012), reads that directory,
 * pushes the branch if the work should outlive the run, and only then answers. So the claim is not
 * that the Machine published two strings — it is that the directory it named holds the branch it
 * named, in the pod, right now.
 */
Then(
  // The `/` is escaped because a bare one opens an alternation in a Cucumber expression; the step
  // reads unescaped in the .feature, which is where it has to be readable.
  "the Gate names the branch jr2\\/task-<run id> and the worktree it was cut in",
  async function (this: E2EWorld): Promise<void> {
    const gate = await openGate(this);
    const instanceId = await runInstanceId(this);
    assert.equal(gate.meta?.branch, `jr2/task-${instanceId}`, "the branch is named for the run (ADR-0054)");
    const workdir = String(gate.meta?.worktree ?? "");
    assert.ok(workdir, `the Gate carries the worktree a human execs into (got: ${JSON.stringify(gate.meta)})`);
    const pod = (await waitForReadySandbox(this)).metadata.name;
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
    assert.equal(current.trim(), gate.meta?.branch, "the directory the Gate names holds the branch it names");
  },
);

/**
 * ADR-0024, on this Machine: the pick that moved it out of `working` ended the turn behind it, at
 * the Harness. Waited for rather than merely noted, because the next `request_changes` starts a
 * turn on the SAME conversation — so an abort still in flight would leave the previous turn's
 * request parked at the scripted model beside the new one, and the tier's release matches on the
 * offered Menu, which both share here.
 */
Then("the turn behind it is over at the Harness", { timeout: 180_000 }, async function (this: E2EWorld) {
  const iid = taskCoderIid(this.runId!);
  for (let i = 0; i < 90; i++) {
    const conversation = await conversationOf(this, "coder", iid);
    if ((conversation?.settlements.length ?? 0) >= 1) return;
    await sleep(1000);
  }
  throw new Error(`no turn of /agents/coder/${iid} ever settled — the state exit owes the submission an end`);
});

/** The human's half of the loop, through the surface a human has (ADR-0011/0013): `jr2 send` into
 * the Gate the run listed. An Agent cannot reach this route at all — a Sandbox token is refused
 * here unconditionally, which is the line between reporting an outcome and approving one's own
 * work. */
When("I send {string} to the Gate with notes {string}", async function (this: E2EWorld, event: string, notes: string) {
  const gate = await openGate(this);
  const r = await this.runCli([
    "send",
    this.runId!,
    "--gate",
    gate.gate,
    "--event",
    event,
    "--input",
    JSON.stringify({ notes }),
  ]);
  assert.equal(r.code, 0, `jr2 send ${event} failed: ${r.stderr}`);
});

When("I send {string} to the Gate", async function (this: E2EWorld, event: string): Promise<void> {
  const gate = await openGate(this);
  const r = await this.runCli(["send", this.runId!, "--gate", gate.gate, "--event", event]);
  assert.equal(r.code, 0, `jr2 send ${event} failed: ${r.stderr}`);
});

/**
 * CONTINUITY, not a second request (ADR-0054). One human steering one Agent wants the Agent to
 * remember what it did, so `request_changes` continues the pinned conversation instead of briefing
 * a fresh one — and the Harness's own history is the only place that is observable: the
 * Orchestrator sees two invokes either way.
 *
 * Three things at ONE address: the door's prompt, framed as the first Turn; a settled turn behind
 * it; and the human's notes as a LATER user message. A `task` that started over would derive a
 * different iid — which is what a terminal fault does on purpose, since it burns the conversation
 * and the next `continue` mints `<iid>/<epoch>` (ADR-0057) — and this address would hold the notes
 * alone, or nothing at all.
 */
Then(
  "the coder's conversation carries the prompt {string} and then the notes {string}",
  { timeout: 300_000 },
  async function (this: E2EWorld, prompt: string, notes: string): Promise<void> {
    const iid = taskCoderIid(this.runId!);
    let last: Conversation | undefined;
    for (let i = 0; i < 150; i++) {
      last = await conversationOf(this, "coder", iid);
      const said = last?.messages ?? [];
      const first = said.findIndex((m) => m.role === "user" && m.text.includes(prompt));
      const later = said.findIndex((m) => m.role === "user" && m.text.includes(notes));
      if (first >= 0 && later > first) {
        assert.ok(
          (last?.settlements.length ?? 0) >= 1,
          "the turn the notes answer is part of the same conversation's record",
        );
        return;
      }
      await sleep(1000);
    }
    throw new Error(
      `/agents/coder/${iid} does not hold the prompt and then the notes (${last === undefined ? "no such conversation — the second Turn started a new one" : JSON.stringify(last.messages)})`,
    );
  },
);

// --- the Frame's cwd, where only a real pod can answer (ADR-0057) ---------------------------------
//
// The incident these steps play: a model that writes a RELATIVE path. Every Working tool resolves
// one against the Turn's `cwd` — the Frame — so where the bytes land is the whole claim, and it is
// invisible from the Orchestrator, which sees a turn that finished either way.

/** The model answers with the `write` WORKING tool at a bare filename. No Menu tool is picked, so
 * the Machine does not move; what moves is the file — somewhere. */
When(
  "the Agent writes {string} through its write Working tool",
  async function (this: E2EWorld, path: string): Promise<void> {
    await waitForAttached(this); // the Worktree the Frame names exists only once attach is done
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.release("write", { path, content: "written by the coder\n" });
  },
);

/** The directories between a Worktree and `/work`, inclusive of `/work` — every place a relative
 * path could have landed instead. `/work` is the last of them, and is where a definition-level
 * `cwd` could only ever have pointed: the parent of every checkout (ADR-0057). */
function above(worktree: string): string[] {
  const dirs: string[] = [];
  for (let dir = worktree; dir.length > "/work".length; ) {
    dir = dir.slice(0, dir.lastIndexOf("/"));
    dirs.push(dir);
  }
  return dirs;
}

/**
 * The regression, inverted into an assertion (ADR-0057): the bare filename the model wrote
 * resolved INSIDE the Worktree the Gate names, and no directory above it holds a copy. The probe
 * REPORTS every place the name exists rather than asserting each absence, so a failure says where
 * the work actually went — which is the one thing the incident could not tell anybody.
 */
Then(
  "the file {string} is in the Worktree the Gate names and in no directory above it",
  async function (this: E2EWorld, name: string): Promise<void> {
    const gate = await openGate(this);
    const worktree = String(gate.meta?.worktree ?? "");
    assert.ok(worktree, `the Gate carries the worktree (got: ${JSON.stringify(gate.meta)})`);
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const script = [worktree, ...above(worktree)]
      .map((dir) => `[ -e '${dir}/${name}' ] && echo '${dir}/${name}'`)
      .join("\n");
    const found = (await kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "sh", "-c", `${script}\nexit 0`]))
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(
      found,
      [`${worktree}/${name}`],
      `a relative path must resolve at the Turn's Frame and nowhere else — /work is where a ` +
        `definition-level cwd would have put it (ADR-0057)`,
    );
  },
);

/** …and the commit the model made with a bare `git add` is the branch's tip, in that same
 * Worktree. The Frame roots bash too, so a Turn that worked in the wrong directory would have had
 * nothing to add and no branch to move. */
Then(
  "the Worktree the Gate names has the commit {string} on its branch",
  async function (this: E2EWorld, subject: string): Promise<void> {
    const gate = await openGate(this);
    const worktree = String(gate.meta?.worktree ?? "");
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const git = (args: string[]): Promise<string> =>
      kubectl(this, ["exec", `pod/${pod}`, "-c", "harness", "--", "git", "-C", worktree, ...args]);
    assert.equal((await git(["branch", "--show-current"])).trim(), gate.meta?.branch, "on the branch, not detached");
    assert.equal((await git(["log", "-1", "--pretty=%s"])).trim(), subject, "the coder's commit is the branch's tip");
  },
);

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
  const headers = await harnessAuth(world, pod);
  let body = "";
  await withPodForward(world, pod, 8080, async (localUrl) => {
    const res = await fetch(`${localUrl}/agents/coder/${encodeURIComponent(iid)}?view=history`, { headers });
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

// --- The routability budget (ADR-0042) -------------------------------------------------------
//
// The two calls a turn starts with retry a Service that is not routable yet, and ADR-0016 says
// that retry is ABSORBED: no event, no budget on the authoring surface. Right — and it leaves this
// tier benefiting from a window it cannot see. If routability got twice as slow tomorrow, all 88
// scenarios would still pass, a little slower, in silence, until one day the 90s window closed and
// the suite went red as a fresh mystery. Being unseeable is how this class survived three sessions,
// so the fix must not be shipped unwatched.
//
// So the product emits one line per retry that COST something, and the tier holds a budget against
// it. What is asserted is not "the retry worked" — the scenarios already assert that — but how much
// of the window it is spending. That converts 90s from a number read off two GitHub issues into a
// measurement of THIS cluster, with a regression test around it.

/** The marker the product emits. A contract: `@jr2/orchestrator`'s wire client and `@jr2/harness`'s
 * Menu both format it, and neither import can enforce the agreement — the tests on each side quote this
 * exact shape, and a rename made in only one place checks nothing while still passing. */
const ROUTABILITY_MARKER = "jr2.routability";

/**
 * TWO budgets, because a Service refuses in two ways that cost differently — and the first live
 * reading is what proved one number insufficient.
 *
 * A REJECT (kube-proxy, no ready backend) fails instantly, so it spends ATTEMPTS and almost no
 * time. A dropped SYN sits on undici's 10s connect timeout, so it spends TIME and almost no
 * attempts. Both have now been measured here, one per run: `2 attempts / 10667ms` (a drop) and
 * `3 attempts / 502ms / ECONNREFUSED` (a reject). Neither meter sees the other's mode, so an
 * attempts-only budget would have waved ~40s of a 90s window through without a word, and a
 * ms-only budget would let a Service reject for fifteen seconds unremarked.
 *
 * The two are calibrated to trip at about the same severity, which is what keeps them from being
 * one meter written twice. Against a 250ms→5s jittered ladder, 8 attempts is ~9–18s of refusal;
 * 30s is a third of the window, or three connect timeouts. Both sit far enough above what this
 * cluster actually does (3 attempts, 10.7s) to be a signal rather than a coin flip — the first
 * draft budgeted 4 attempts against an observed 3, which is not a budget, it is a flake.
 */
const ROUTABILITY_BUDGET_ATTEMPTS = 8;
const ROUTABILITY_BUDGET_MS = 30_000;

type RoutabilityRetry = {
  seat: string;
  attempts: number;
  ms: number;
  /** The final errno — `ECONNREFUSED` for a REJECT, `UND_ERR_CONNECT_TIMEOUT` for a drop. */
  last: string;
  url: string;
  scenario: string;
};

/** Every retry this WORKER's scenarios paid for. Under `--parallel` each worker is its own process
 * and so keeps its own list, which is right: any worker over budget fails the run. */
const routabilityObserved: RoutabilityRetry[] = [];

/** Pull the marker's `k=v` tail out of a log line, whatever `kubectl` prefixed it with. `url` is
 * split on the FIRST `=` so a query string survives intact. */
function parseRoutability(text: string, scenario: string): RoutabilityRetry[] {
  const found: RoutabilityRetry[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf(ROUTABILITY_MARKER);
    if (at < 0) continue;
    const fields = new Map(
      line
        .slice(at + ROUTABILITY_MARKER.length)
        .trim()
        .split(/\s+/)
        .filter((pair) => pair.includes("="))
        .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const),
    );
    found.push({
      seat: fields.get("seat") ?? "?",
      attempts: Number(fields.get("attempts") ?? 0),
      ms: Number(fields.get("ms") ?? 0),
      last: fields.get("last") ?? "?",
      url: fields.get("url") ?? "?",
      scenario,
    });
  }
  return found;
}

/** Read this scenario's retries out of the cluster, before the namespace goes. */
async function collectRoutability(world: E2EWorld, scenario: string): Promise<void> {
  // ONE source, not two: `allPodLogs` already enumerates every pod in the namespace — the
  // Orchestrator's, which owns the admission seat, and the Sandbox's, whose Harness container owns
  // the surface seat. Adding `deployment/jr2-orchestrator` beside it would count admissions twice.
  routabilityObserved.push(...parseRoutability(await probe(() => allPodLogs(world)), scenario));
}

/** Everything a failed @kind scenario can still be asked, written to one folder. */
async function dumpKindDiagnostics(world: E2EWorld, scenarioName: string): Promise<void> {
  const slug = scenarioName.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
  const dir = join(FAILURE_DIR, `${world.namespace}-${slug}`);
  await mkdir(dir, { recursive: true });

  const status = await probe(async () => (await world.runCli(["status", world.runId ?? ""])).stdout);
  // The conversation the pod's Harness holds, derived (ADR-0057) rather than read off the status:
  // `jr2 status` reports the RUN's id, which names no conversation. Every kind workflow with a
  // Sandbox invokes its coder from the `workspace()`'s body, so one spelling covers the dump.
  const iid = world.runId ? continuedIid(world.runId, "body", "coder") : undefined;

  // The provider's side, first: how many requests EVER reached this scenario's scripted model, and
  // whether any of them streamed. Zero streaming is the flake's signature — the pod's turn loop
  // never got as far as asking the model anything.
  // A @model scenario has none: a real endpoint answers it (ADR-0066).
  const calls = world.provider?.calls ?? [];
  const files: Array<[string, Promise<string> | string]> = [
    [
      "provider-calls.txt",
      world.provider === undefined
        ? "<unavailable: no scripted provider in this scenario>\n"
        : `${calls.length} request(s), ${calls.filter((c) => c.stream).length} streaming\n` +
          calls
            .map((c) => `#${c.seq} stream=${c.stream} model=${c.model ?? "?"} tools=${c.tools.join(",")}`)
            .join("\n") +
          "\n",
    ],
    ["jr2-status.json", status],
    [
      "harness-history.json",
      iid ? probe(() => harnessHistory(world, iid)) : "<no runId to derive a conversation from>\n",
    ],
    ["pods.txt", probe(() => kubectl(world, ["get", "pods", "-o", "wide"]))],
    ["sandboxes.yaml", probe(() => kubectl(world, ["get", "sandbox", "-o", "yaml"]))],
    // The other side of an ask (ADR-0051/0053): the cache agent writes its per-node verdict here —
    // when it last fetched, when it last attempted, and git's own words when that failed. A
    // Sandbox entry that never answered an ask is explained on this resource and nowhere else.
    ["repos.yaml", probe(() => kubectl(world, ["get", "repo", "-o", "yaml"]))],
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
      probe(() => kubectl(world, ["logs", "--prefix", "--timestamps", "--tail=-1", "deployment/jr2-orchestrator"])),
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
// is deleted — and the failure dump's hook, registered after it, runs before this one.
After({ tags: "@kind" }, async function (this: E2EWorld, scenario: ITestCaseHookParameter): Promise<void> {
  // Every scenario, not only the failures: the point of the budget is to see the window being
  // spent while everything still passes. Read-only, and it swallows its own errors — a diagnostic
  // that fails the teardown destroys the evidence it exists to collect.
  await collectRoutability(this, scenario.pickle.name).catch(() => {});
  // The held key is in no log of the namespace — the Custodians' access logs, the Harnesses'
  // printed conversations, the Orchestrator's (ADR-0059). Checked in every scenario, not only the
  // held-secret Rule's: every turn in this tier crosses a Custodian with the key.
  const key = this.providerKey;
  if (key) {
    const logs = await allPodLogs(this).catch(() => "");
    assert.ok(!logs.includes(key), "the provider key reached a pod log in this namespace");
  }
  // A scenario that failed before (or during) the sweep leaves its planted image behind; the next
  // `jr2 gc` collects it either way — a labeled image no root names is exactly what the sweep is
  // for — but the tier must not depend on that to stay clean. Every ref the load added goes, since
  // taking the tag alone is what leaves the bytes behind. `ctr images rm` is delete-if-present.
  if (this.plantedImage) await exec("docker", ["rmi", this.plantedImage]).catch(() => {});
  for (const [node, refs] of Object.entries(this.plantedRefs ?? {})) {
    if (refs.length === 0) continue;
    await exec("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "rm", ...refs]).catch(() => {});
  }
  if (!this.runId) return;
  await kubectl(this, ["delete", "sandbox", "-l", `jr2.dev/run=${this.runId}`, "--ignore-not-found"]).catch(() => {});
});

// The failure dump, for @model scenarios too (ADR-0066): their namespace goes at teardown the same
// way. Registered after the hook above, so (After hooks run in reverse) it reads the cluster before
// that hook deletes the run's Sandboxes, and before `hooks.ts` deletes the namespace. A failed
// @model scenario's dump lands where a @kind one does.
After({ tags: "@kind or @model" }, async function (this: E2EWorld, scenario: ITestCaseHookParameter): Promise<void> {
  if (scenario.result?.status !== "FAILED") return;
  await dumpKindDiagnostics(this, scenario.pickle.name).catch((err: unknown) => {
    console.error(`[kind] diagnostics dump failed:`, err);
  });
});

/**
 * The budget, judged once for the whole worker.
 *
 * Deliberately NOT thrown from the `After` hook above. That hook is what unsticks Sandboxes and
 * removes planted images before the namespace goes, and a throw partway through it would trade a
 * leaked cluster for a clearer error message. Here nothing is left to tear down, the whole
 * distribution is in hand rather than one scenario's slice, and Cucumber still exits non-zero.
 *
 * Empty is the expected result and says nothing: no line means no call ever had to retry.
 */
AfterAll(function (): void {
  if (routabilityObserved.length === 0) return;
  const slowest = routabilityObserved.reduce((a, b) => (b.ms > a.ms ? b : a));
  const busiest = routabilityObserved.reduce((a, b) => (b.attempts > a.attempts ? b : a));
  console.error(
    `[kind] routability: ${routabilityObserved.length} retried call(s), worst ${slowest.ms}ms / ` +
      `${busiest.attempts} attempts\n` +
      routabilityObserved
        .map((r) => `  ${r.seat} attempts=${r.attempts} ms=${r.ms} last=${r.last} — ${r.scenario}`)
        .join("\n"),
  );
  const over =
    (slowest.ms > ROUTABILITY_BUDGET_MS && {
      r: slowest,
      was: `${slowest.ms}ms`,
      budget: `${ROUTABILITY_BUDGET_MS}ms`,
    }) ||
    (busiest.attempts > ROUTABILITY_BUDGET_ATTEMPTS && {
      r: busiest,
      was: `${busiest.attempts} attempts`,
      budget: `${ROUTABILITY_BUDGET_ATTEMPTS} attempts`,
    });
  if (over) {
    throw new Error(
      `routability budget exceeded: the ${over.r.seat} seat spent ${over.was} (budget ${over.budget}, ` +
        `last errno ${over.r.last}) reaching ${over.r.url}. Every scenario may well have PASSED — ADR-0042's ` +
        `retry absorbs this, and a suite that only notices when the 90s window finally closes notices as a ` +
        `mystery. Either this cluster got slower or something upstream of the Service is taking longer to ` +
        `become routable; the window is the last line of defence, not the measurement.`,
    );
  }
});

// --- an http Effect in the Instance Effector (ADR-0068) -------------------------------------------

const ECHO_NAMESPACE = "jr2-e2e-seed";
const INSTANCE_EFFECTOR = "jr2-instance-effector";

/** Every form ADR-0068 scrubs for one value: exact, base64 (both alphabets, padded and not), percent, JSON. */
function formsOf(value: string): string[] {
  const raw = Buffer.from(value);
  return [
    value,
    raw.toString("base64"),
    raw.toString("base64").replace(/=+$/, ""),
    raw.toString("base64url"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ];
}

/**
 * Where a value leaked into `seen`, or undefined. The value's own forms are not enough: what the
 * Effector BUILT from it — `Bearer <value>`, `bot:<value>`, `/bot<value>/send/…`, `Key <value>` —
 * the echo returns in base64, and base64 of a longer string holds no base64 form of the value
 * alone. So every base64 run in `seen` is decoded, in both alphabets, and every percent-encoded run
 * is decoded, and each result is searched the same way — twice deep, for the echo's base64 of the
 * `Basic <base64(user:password)>` header.
 */
function leakOf(seen: string, value: string, depth = 0): string | undefined {
  const direct = formsOf(value).find((form) => seen.includes(form));
  if (direct !== undefined) return `a form of it (${direct.length} chars)`;
  if (depth > 2) return undefined;
  const decodedPct = percentDecoded(seen);
  if (decodedPct !== seen) {
    const inner = leakOf(decodedPct, value, depth + 1);
    if (inner) return `percent-encoded: ${inner}`;
  }
  for (const run of seen.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const inner = leakOf(decoded, value, depth + 1);
    if (inner) return `base64 (${run.length} chars) of ${inner}`;
  }
  return undefined;
}

function percentDecoded(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Start `called` in a mode, with a marker of this scenario's own that the echo counts. */
When(
  "I start the {string} workflow in mode {string} detached",
  async function (this: E2EWorld, wf: string, mode: string): Promise<void> {
    this.marker = `m-${randomBytes(6).toString("hex")}`;
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ mode, marker: this.marker })]);
    this.runId = this.resultJson<{ runId: string }>().runId;
  },
);

/** The run's final output — the http Effect's — waited for long enough to outlast a slow call and
 * a restart or a rollout under it. */
async function httpOutput(world: E2EWorld): Promise<Record<string, unknown>> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 360; i++) {
    last = await wsStatus(world);
    if (last.status === "done" || last.status === "error") break;
    await sleep(500);
  }
  assert.equal(last?.status, "done", `the run settled ${last?.status} (${JSON.stringify(last?.context)})`);
  return (last!.context.output ?? {}) as Record<string, unknown>;
}

Then("the http Effect's answer is a response from the echo", async function (this: E2EWorld): Promise<void> {
  const output = await httpOutput(this);
  assert.equal(output.outcome, "response", JSON.stringify(output));
  assert.equal(output.status, 200);
  assert.equal(typeof output.body, "string", "a text body comes back, bounded and scrubbed");
});

/**
 * The scrubbing proof (ADR-0068): the echo returned every header and the url in every encoding, and not one form of the
 * value is in what came back — the run's snapshot (`jr2 status`), its feed, the answer's headers.
 * What came back names the secret instead.
 */
Then(
  "no form of the echo token reached the run, and the answer names it {string}",
  async function (this: E2EWorld, named: string): Promise<void> {
    assert.ok(this.echoToken, "setupKind made this scenario's echo token");
    const output = await httpOutput(this);
    const status = await this.runCli(["status", this.runId!]);
    const seen = JSON.stringify(output) + status.stdout;
    const leak = leakOf(seen, this.echoToken);
    assert.equal(leak, undefined, `the echo token reached the run: ${leak}`);
    assert.ok(String(output.body).includes(named), `the answer names the secret ${named}: ${String(output.body)}`);
    const headers = (output.headers ?? {}) as Record<string, string>;
    assert.ok(
      !headers["x-echo-authorization"]?.includes(this.echoToken),
      "the echoed Authorization header is scrubbed",
    );
  },
);

/** The run's feed as `jr2 logs` replays it (ADR-0009): what an operator reads after the run. */
Then("the run's feed carries no form of the echo token", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.echoToken);
  const feed = await this.runCli(["logs", this.runId!]);
  assert.equal(feed.code, 0, `jr2 logs failed: ${feed.stderr}`);
  const leak = leakOf(feed.stdout + feed.stderr, this.echoToken);
  assert.equal(leak, undefined, `the echo token reached the feed: ${leak}`);
});

/** The Agent's half of the scrubbing proof: the tool result the MODEL read on the next request carries the named
 * secret and no form of its value. */
Then(
  "the model was shown the echo's answer with the token named {string} and no form of its value",
  async function (this: E2EWorld, named: string): Promise<void> {
    assert.ok(this.provider && this.echoToken);
    const provider = this.provider;
    for (let i = 0; i < 240 && !provider.calls.some((c) => c.stream && c.raw.includes(named)); i++) await sleep(500);
    assert.ok(
      provider.calls.some((c) => c.stream && c.raw.includes(named)),
      `no provider request carried ${named}`,
    );
    for (const call of provider.calls) {
      const leak = leakOf(call.raw, this.echoToken);
      assert.equal(leak, undefined, `the echo token reached the model: ${leak}`);
    }
  },
);

/** How many requests carrying this scenario's marker the echo received — asked inside its pod. */
async function echoCount(world: E2EWorld): Promise<number> {
  const { stdout } = await exec("kubectl", [
    "--namespace",
    ECHO_NAMESPACE,
    "exec",
    "deploy/echo",
    "--",
    "wget",
    "-qO-",
    `http://127.0.0.1:8080/count/${world.marker}`,
  ]);
  return Number(stdout.trim());
}

Then("the echo has received the run's call", async function (this: E2EWorld): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await echoCount(this)) >= 1) return;
    await sleep(500);
  }
  throw new Error(`the echo never received a request for ${this.marker}`);
});

Then("the echo received the run's call exactly once", async function (this: E2EWorld): Promise<void> {
  assert.equal(await echoCount(this), 1, "one send, across what restarted");
});

/** An Open secret bound by the composer (ADR-0054): the echo answers each header it received, and the
 * Effector scrubs out of the answer the Authorization value it built from the bound secret, whole
 * (ADR-0068) — so an Authorization line that is `[secret:echo-token]`, raw, is the header that
 * carried that very secret: the `Bearer` it wrote is inside what was replaced. A header the Effector
 * did not build from it would come back as it was. */
Then(
  "the echo received the bound secret as the Bearer in its Authorization header",
  async function (this: E2EWorld): Promise<void> {
    const output = await httpOutput(this);
    assert.match(
      String(output.body),
      /^header authorization raw \[secret:echo-token\]$/m,
      `the echo saw the bound secret as the Bearer: ${String(output.body)}`,
    );
    assert.equal(await echoCount(this), 1, "one send");
  },
);

/** The other half of "a secret reaches only the pods that name it" (ADR-0068): the bound secret is
 * no file and no env of the Sandbox's Harness container — the Agent's — read while the run is live. */
Then(
  "the echo token is nowhere in the Sandbox's Harness container",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.echoToken, "setupKind made this scenario's echo token");
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const out = await kubectlInput(
      this,
      ["exec", "-i", `pod/${pod}`, "-c", "harness", "--", RUNTIME_NODE, "-e", KEY_SCAN],
      this.echoToken,
    );
    assert.equal(out.trim(), "CLEAN", `the echo token is in the Harness container: ${out.trim()}`);
  },
);

Then(
  "the echo token is nowhere in the Instance Harness's Harness container",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.echoToken, "setupKind made this scenario's echo token");
    const pod = await instanceHarnessPod(this);
    const out = await kubectlInput(
      this,
      ["exec", "-i", `pod/${pod}`, "-c", "harness", "--", RUNTIME_NODE, "-e", KEY_SCAN],
      this.echoToken,
    );
    assert.equal(out.trim(), "CLEAN", `the echo token is in the Instance Harness's container: ${out.trim()}`);
  },
);

Given("the Instance Effector runs {int} replicas", async function (this: E2EWorld, n: number): Promise<void> {
  // No replica count in config yet: the tier scales the Deployment `jr2 up` converged.
  await kubectl(this, ["scale", `deployment/${INSTANCE_EFFECTOR}`, `--replicas=${n}`]);
  await kubectl(this, ["rollout", "status", `deployment/${INSTANCE_EFFECTOR}`, "--timeout=180s"]);
  const pods = await kubectl(this, ["get", "pods", "-l", `app=${INSTANCE_EFFECTOR}`, "-o", "name"]);
  assert.equal(pods.trim().split("\n").filter(Boolean).length, n);
});

/** An Orchestrator restart with no Sandbox to capture first: the Effect runs in the Effector. */
When("the orchestrator restarts while the Effect runs", async function (this: E2EWorld): Promise<void> {
  await scaleOrchestrator(this, 0);
  await scaleOrchestrator(this, 1);
});

/** A rollout of the Instance Effector: the new pod starts beside the old one (surge), and the old
 * one finishes the Effect in flight before it stops. Not waited on here: the run's answer is
 * what the scenario reads. */
When("the Instance Effector rolls out", async function (this: E2EWorld): Promise<void> {
  await kubectl(this, ["rollout", "restart", `deployment/${INSTANCE_EFFECTOR}`]);
});

Then("the Instance Effector's rollout completes", async function (this: E2EWorld): Promise<void> {
  await kubectl(this, ["rollout", "status", `deployment/${INSTANCE_EFFECTOR}`, "--timeout=300s"]);
});

// --- a dispatch from the Instance Effector (ADR-0071) ----------------------------------------------

/** A run as `jr2 status` and `jr2 runs` print it, with what ADR-0071 adds. */
type DispatchRun = {
  runId: string;
  workflow: string;
  status: string;
  output?: Record<string, unknown>;
  dispatchedBy?: { run: string; slot: string; effect?: string; depth: number; instance?: string };
};

/** The run the `dispatched` workflow started, once a step has found it. */
const dispatchedCallee = new WeakMap<E2EWorld, string>();

/**
 * The scenario's namespace holds the `jr2-instance` Secret before `jr2 up`, with the Instance token
 * set to this scenario's `self-token` (`kind-instance/jr2.config.ts`): `jr2 up` keeps a token it
 * finds and mints the rest, so the token the `dispatched` workflow's target names IS this
 * Instance's. Created, not applied: `jr2 up` writes the Secret whole after this, and owns it.
 */
Given("this scenario's self-token is the Instance token", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.namespace && this.selfToken, "setupKind made this scenario's namespace and self-token");
  const objects = {
    apiVersion: "v1",
    kind: "List",
    items: [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: this.namespace } },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "jr2-instance", namespace: this.namespace },
        data: { JR2_INSTANCE_TOKEN: Buffer.from(this.selfToken).toString("base64") },
      },
    ],
  };
  await kubectlInput(this, ["create", "-f", "-"], JSON.stringify(objects));
});

/** The callee is live while its slow call runs, and names its caller: the run, the slot, the depth,
 * and an Instance the callee's Orchestrator could not verify, because the start came by its door. */
Then("the dispatched run names its caller from another Instance", async function (this: E2EWorld): Promise<void> {
  let found: DispatchRun | undefined;
  for (let i = 0; i < 120 && !found; i++) {
    const r = await this.runCli(["runs"]);
    assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
    const mine = this.resultJson<DispatchRun[]>().filter((run) => run.dispatchedBy?.run === this.runId);
    assert.ok(mine.length <= 1, `one dispatch is one run: ${JSON.stringify(mine)}`);
    found = mine[0];
    if (!found) await sleep(500);
  }
  assert.ok(found, `no live run names ${this.runId} as its dispatcher`);
  assert.equal(found.workflow, "called");
  assert.equal(found.dispatchedBy?.slot, "call");
  assert.equal(found.dispatchedBy?.depth, 1, "the caller sent its own depth, and the host added one");
  assert.ok(found.dispatchedBy?.instance, "a start by the door names the caller's Instance, as opaque text");
  dispatchedCallee.set(this, found.runId);
});

Then(
  "the dispatch settled with the dispatched run, which ended {string}",
  { timeout: 300_000 },
  async function (this: E2EWorld, status: string): Promise<void> {
    const callee = dispatchedCallee.get(this);
    assert.ok(callee, "the dispatched run was found before the restart");
    let caller: DispatchRun | undefined;
    for (let i = 0; i < 480; i++) {
      const r = await this.runCli(["status", this.runId!]);
      assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
      caller = this.resultJson<DispatchRun>();
      if (caller.status !== "active" && caller.status !== "live") break;
      await sleep(500);
    }
    assert.equal(caller?.status, "done", `the caller settled ${caller?.status}: ${JSON.stringify(caller)}`);
    const output = caller.output ?? {};
    assert.equal(output.outcome, "settled", JSON.stringify(output));
    assert.equal(output.run, callee, "the poll followed the run the start began, across the restart");
    assert.equal(output.status, status, "the callee's status, in the store's words");
    assert.equal(
      (output.output as { outcome?: string } | undefined)?.outcome,
      "response",
      "the callee Machine's output — its http Effect's answer — came back through the poll",
    );
  },
);

// --- the Sandbox Effector (ADR-0067, ADR-0068) ----------------------------------------------------

/** The run's Sandbox pod has an `effector` container, and the Harness container mounts none of its
 * volumes — read off the pod the operator made from the CR the provision wrote. */
Then("the run's Sandbox pod has a Sandbox Effector beside the Agent", async function (this: E2EWorld): Promise<void> {
  let podName: string | undefined;
  for (let i = 0; i < 120 && podName === undefined; i++) {
    const ready = (await sandboxesFor(this)).find((sb) => sb.status?.phase === "Ready");
    podName = (ready?.status as { podRef?: { name?: string } } | undefined)?.podRef?.name;
    if (podName === undefined) await sleep(500);
  }
  assert.ok(podName, "the run's Sandbox never reported its pod");
  const pod = JSON.parse(await kubectl(this, ["get", "pod", podName, "-o", "json"])) as {
    spec: { containers: Array<{ name: string; volumeMounts?: Array<{ name: string }> }> };
  };
  const names = pod.spec.containers.map((c) => c.name);
  assert.ok(names.includes("effector"), `no effector container: ${names.join(", ")}`);
  const harness = pod.spec.containers[0]!;
  for (const m of harness.volumeMounts ?? []) assert.ok(!m.name.startsWith("effector"), `the Harness mounts ${m.name}`);
});

Then(
  "the file-body http's answer is a response from the echo, whose body is the committed file",
  async function (this: E2EWorld): Promise<void> {
    const output = await httpOutput(this);
    assert.equal(output.outcome, "response", JSON.stringify(output));
    assert.equal(output.status, 200);
    assert.match(String(output.body), /\nbody report of the run\n/, "the Worktree file was the body");
    assert.ok(this.echoToken);
    assert.equal(leakOf(JSON.stringify(output), this.echoToken), undefined, "the answer holds no form of the token");
  },
);

Then(
  "the credentialed command read its secret from env and from its file, and its output names it",
  async function (this: E2EWorld): Promise<void> {
    const output = (await httpOutput(this)) as { outcome?: string; code?: number; tail?: string; dirty?: boolean };
    assert.equal(output.outcome, "exited", JSON.stringify(output));
    assert.equal(output.code, 0);
    assert.match(output.tail ?? "", /env=\[secret:echo-token\]\nfile=\[secret:echo-token\]\n/);
    assert.ok(this.echoToken);
    assert.equal(leakOf(JSON.stringify(output), this.echoToken), undefined, "no form of the token came back");
    const feed = await this.runCli(["logs", this.runId!]);
    assert.equal(leakOf(feed.stdout + feed.stderr, this.echoToken), undefined, "the feed holds no form of it");
  },
);

Then(
  "the credentialed command saw the commit and not the edit, and says dirty",
  async function (this: E2EWorld): Promise<void> {
    const output = (await httpOutput(this)) as { outcome?: string; tail?: string; dirty?: boolean };
    assert.equal(output.outcome, "exited", JSON.stringify(output));
    assert.match(output.tail ?? "", /report of the run\n$/, "the pinned commit's file");
    assert.doesNotMatch(output.tail ?? "", /edited, not committed/);
    assert.equal(output.dirty, true);
  },
);

/** The Effector's key of this run's Sandbox, read from the Secret the provision wrote for it
 * (`<sandbox>-effector`) WHILE the run is live: the Secret is owned by the Sandbox CR, and the
 * wrapper's teardown deletes the CR before the run is `done`, so the Secret is gone by then. */
async function liveEffectorKey(world: E2EWorld): Promise<string> {
  for (let i = 0; i < 360; i++) {
    const sandbox = (await sandboxesFor(world))[0]?.metadata?.name;
    if (sandbox !== undefined) {
      const data = await kubectl(world, [
        "get",
        "secret",
        `${sandbox}-effector`,
        "-o",
        "jsonpath={.data.key}",
        "--ignore-not-found",
      ]).catch(() => "");
      if (data.trim() !== "") return Buffer.from(data.trim(), "base64").toString("utf8");
    }
    const { status } = await wsStatus(world);
    if (status === "done" || status === "error") break;
    await sleep(250);
  }
  throw new Error(`the Effector's key of run ${world.runId}'s Sandbox was never read while the run was live`);
}

/** The child of the child read `/run/jr2/effector/key` and Landlock refused it (ADR-0068). The key is
 * read from the Secret the provision wrote for this Sandbox, while the run is live, so the check
 * looks for its value and its encodings, not only for the scrubber's mark. */
Then(
  "the credentialed command's child was denied the Effector's key, and the answer holds no form of it",
  async function (this: E2EWorld): Promise<void> {
    const key = await liveEffectorKey(this);
    assert.ok(key.length >= 32, "the Effector's key was read");
    const output = (await httpOutput(this)) as { outcome?: string; code?: number; tail?: string };
    assert.equal(output.outcome, "exited", JSON.stringify(output));
    assert.notEqual(output.code, 0, JSON.stringify(output));
    assert.match(output.tail ?? "", /Permission denied/, JSON.stringify(output));
    assert.equal(leakOf(JSON.stringify(output), key), undefined, "the answer holds no form of the key");
    const feed = await this.runCli(["logs", this.runId!]);
    assert.equal(leakOf(feed.stdout + feed.stderr, key), undefined, "the feed holds no form of it");
  },
);

// --- a push from the Sandbox Effector (ADR-0067, ADR-0068) -----------------------------------------

/**
 * The scenario's namespace holds the two Secrets the push remote's `git.credentials` entry names
 * (`kind-instance/jr2.config.ts`): the deploy key the seed's sshd authorizes, with its known_hosts
 * line, and the signing key. Written before `jr2 up`, which then finds the deploy key and
 * generates none; read from the seed, which made them in-cluster.
 */
Given("the seed's push remote trusts this scenario's keys", async function (this: E2EWorld): Promise<void> {
  await ensureSeed();
  const keys = await seedKeys();
  assert.ok(this.namespace, "a @kind scenario has its namespace set in setupKind");
  const objects = {
    apiVersion: "v1",
    kind: "List",
    items: [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: this.namespace } },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "jr2-e2e-push-key", namespace: this.namespace },
        stringData: { identity: keys.deploy, "identity.pub": keys.deployPub, known_hosts: keys.knownHosts },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "jr2-e2e-sign-key", namespace: this.namespace },
        stringData: { identity: keys.sign, "identity.pub": keys.signPub },
      },
    ],
  };
  await kubectlInput(this, ["apply", "-f", "-"], JSON.stringify(objects));
});

type PushOut = {
  outcome?: string;
  published?: string;
  source?: string;
  via?: string;
  newCommits?: number;
  sync?: string;
  syncReason?: string;
  reason?: string;
};
type PushedRun = {
  first: PushOut | null;
  second: PushOut | null;
  before: { tail?: string } | null;
  after: { tail?: string } | null;
};

Then(
  "the signed push published signed copies on the remote, which verify with the signer's key",
  async function (this: E2EWorld): Promise<void> {
    const run = (await httpOutput(this)) as unknown as PushedRun;
    const first = run.first;
    assert.equal(first?.outcome, "pushed", JSON.stringify(run));
    assert.ok(first.published && first.source && first.published !== first.source, "a signed copy, a new id");
    // Counted against the remote's branch and the node's Repo cache (ADR-0067): the signed copy is new.
    assert.ok((first.newCommits ?? 0) >= 1, `the push says a new commit went out: ${JSON.stringify(first)}`);
    assert.equal(await pushRemoteTip(`pushed-${this.marker}`), first.published, "the remote holds the signed commit");
    const verified = await verifyOnPushRemote(first.published);
    assert.ok(verified.verified, `the commit does not verify with the allowed signer: ${verified.out}`);
    assert.equal(
      verified.who,
      "jr2 e2e <e2e@jr2.test>|jr2 e2e signer <signer@jr2.test>",
      "author the Agent's, committer the signer's",
    );
  },
);

/** The sync (ADR-0067): the Agent's branch is the signed commit now, and the Worktree it looks at
 * is as it was — the same status, the same files, HEAD still the branch. */
Then(
  "the sync moved the Agent's branch to the signed commit, and its files, index and HEAD did not change",
  async function (this: E2EWorld): Promise<void> {
    const run = (await httpOutput(this)) as unknown as PushedRun;
    assert.equal(run.first?.sync, "synced", JSON.stringify(run.first));
    const [statusBefore, filesBefore] = (run.before?.tail ?? "").split("--\n");
    const [statusAfter, filesAfter, headAfter] = (run.after?.tail ?? "").split("--\n");
    assert.ok(
      statusBefore && statusBefore.includes("notes.txt"),
      `the edit and the untracked file were there: ${run.before?.tail}`,
    );
    assert.equal(statusAfter, statusBefore, "git status did not change");
    assert.equal(filesAfter, filesBefore, "the files did not change");
    const [head, symbolic] = (headAfter ?? "").trim().split("\n");
    assert.equal(head, run.first?.published, "HEAD resolves to the signed commit");
    assert.equal(symbolic, `refs/heads/pushed-${this.marker}`, "HEAD is still the branch");
  },
);

Then(
  "the push after the rewrite is diverged, and the remote still holds the first push",
  async function (this: E2EWorld): Promise<void> {
    const run = (await httpOutput(this)) as unknown as PushedRun;
    assert.equal(run.first?.outcome, "pushed", JSON.stringify(run));
    assert.equal(run.second?.outcome, "diverged", JSON.stringify(run.second));
    assert.equal(await pushRemoteTip(`pushed-${this.marker}`), run.first?.published, "nothing was pushed");
  },
);

// --- the port takeover (ADR-0068) --------------------------------------------------------------------------

/** What a process the Agent can start does with the Effector's port: bind it the moment it is
 * free, write down every request it gets, and answer each with a signature it cannot make. A poll
 * is answered after a few seconds, as a long poll is: the step reads the log while the run is
 * live, since the wrapper reaps the Sandbox, and the log with it, once the Effect settles. */
const TAKEOVER = [
  String.raw`const net=require("net"),fs=require("fs");const dir="/work/takeover";fs.mkdirSync(dir,{recursive:true});`,
  String.raw`const answer=(c)=>{const b='{"state":"running"}';c.end("HTTP/1.1 202 Accepted\r\nX-Jr2-Signature: forged\r\n`,
  String.raw`Content-Type: application/json\r\nContent-Length: "+Buffer.byteLength(b)+"\r\nConnection: close\r\n\r\n"+b);};`,
  String.raw`const serve=(c)=>{let buf=Buffer.alloc(0);c.on("error",()=>{});c.on("data",(d)=>{buf=Buffer.concat([buf,d]);`,
  String.raw`const h=buf.indexOf("\r\n\r\n");if(h<0)return;const m=/content-length:\s*(\d+)/i.exec(buf.subarray(0,h).toString());`,
  String.raw`const want=h+4+(m?Number(m[1]):0);if(buf.length<want)return;`,
  String.raw`const req=buf.subarray(0,want).toString();fs.appendFileSync(dir+"/requests.log",req+"\n=====\n");buf=Buffer.alloc(0);`,
  String.raw`if(req.startsWith("GET "))setTimeout(()=>answer(c),3000);else answer(c);});};`,
  String.raw`const bind=()=>{const s=net.createServer(serve);s.once("error",()=>setTimeout(bind,20));`,
  String.raw`s.listen(8082,"0.0.0.0",()=>fs.writeFileSync(dir+"/bound",String(Date.now())));};bind();`,
].join("");

async function sandboxPodOf(world: E2EWorld): Promise<string> {
  let podName: string | undefined;
  for (let i = 0; i < 240 && podName === undefined; i++) {
    const ready = (await sandboxesFor(world)).find((sb) => sb.status?.phase === "Ready");
    podName = (ready?.status as { podRef?: { name?: string } } | undefined)?.podRef?.name;
    if (podName === undefined) await sleep(500);
  }
  assert.ok(podName, "the run's Sandbox never reported its pod");
  return podName;
}

When(
  "a process in the Harness container takes the Sandbox Effector's port while the Effector is down",
  { timeout: 180_000 },
  async function (this: E2EWorld): Promise<void> {
    // The body holds on its Gate: the Workspace is attached and its Effector is up.
    await openGate(this);
    const pod = await sandboxPodOf(this);
    await kubectlInput(
      this,
      ["exec", "-i", `pod/${pod}`, "-c", "harness", "--", "sh", "-c", "cat > /work/takeover.js"],
      TAKEOVER,
    );
    await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-c",
      "setsid node /work/takeover.js > /work/takeover.out 2>&1 < /dev/null &",
    ]);
    // The Effector stops (SIGTERM: it drains and exits); its container restarts into a port taken.
    await kubectl(this, ["exec", `pod/${pod}`, "-c", "effector", "--", "sh", "-c", "kill -TERM 1"]);
    for (let i = 0; i < 120; i++) {
      const bound = await kubectl(this, [
        "exec",
        `pod/${pod}`,
        "-c",
        "harness",
        "--",
        "sh",
        "-c",
        "cat /work/takeover/bound 2>/dev/null || true",
      ]);
      if (bound.trim()) return;
      await sleep(500);
    }
    throw new Error("the takeover never bound the Effector's port");
  },
);

/** Releases the file-body http the body holds on its `hold` Gate. */
async function releaseHeld(world: E2EWorld): Promise<void> {
  const gate = await openGate(world);
  const r = await world.runCli(["send", world.runId!, "--gate", gate.gate, "--event", "go"]);
  assert.equal(r.code, 0, `jr2 send failed: ${r.stderr}`);
}

When("the held Effect is released", async function (this: E2EWorld): Promise<void> {
  await releaseHeld(this);
});

/** Releases the held file-body http, then reads what the takeover was sent WHILE the run is live: once the
 * Effect settles, the wrapper deletes the Sandbox CR, and the pod's `/work` goes with it. */
When(
  "the held Effect is released, and the takeover writes down its start",
  async function (this: E2EWorld): Promise<void> {
    const pod = await sandboxPodOf(this);
    await releaseHeld(this);
    for (let i = 0; i < 120; i++) {
      const seen = await kubectl(this, [
        "exec",
        `pod/${pod}`,
        "-c",
        "harness",
        "--",
        "sh",
        "-c",
        "cat /work/takeover/requests.log 2>/dev/null || true",
      ]).catch(() => "");
      if (/^POST \/effects\/[\s\S]*\n=====\n/m.test(seen)) {
        this.takeoverSeen = seen;
        return;
      }
      await sleep(250);
    }
    throw new Error("the takeover never wrote down a start");
  },
);

Then(
  "the takeover got a signed start that carries no secret, and the Effect failed closed",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const output = (await httpOutput(this)) as { outcome?: string; reason?: string; tail?: string };
    assert.equal(output.outcome, "unknown", JSON.stringify(output));
    assert.match(output.reason ?? "", /not the Sandbox Effector's/);
    const seen = this.takeoverSeen;
    assert.ok(seen, "what the takeover was sent was read while the run was live");
    assert.match(seen, /^POST \/effects\//m, "it received the start");
    assert.match(seen, /x-jr2-signature:/i, "the start was signed");
    assert.match(seen, /"secret":"echo-token"/, "it names the secret");
    assert.ok(this.echoToken);
    assert.equal(leakOf(seen, this.echoToken), undefined, "no form of the secret reached it");
    assert.equal(leakOf(JSON.stringify(output), this.echoToken), undefined);
  },
);

// --- a stopped state stops its credentialed command (ADR-0067) --------------------------------

/** The processes of the Sandbox Effector container whose argv is the `effected` workflow's
 * `sleep 7213`. The pattern is `721[3]`, so the grep that reads `/proc` never matches itself. */
async function lingering(world: E2EWorld, pod: string): Promise<string[]> {
  const out = await kubectl(world, [
    "exec",
    `pod/${pod}`,
    "-c",
    "effector",
    "--",
    "sh",
    "-c",
    "grep -l '721[3]' /proc/[0-9]*/cmdline 2>/dev/null || true",
  ]);
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** Waits until the run's open Gate is the named one (the state before it has exited), and answers its
 * id as the run lists it: a Gate invoked in a child Machine is listed under that child's id
 * (`body.cut`), and `jr2 send` takes that id. */
async function gateOpen(world: E2EWorld, gate: string): Promise<string> {
  let last: WsStatus | undefined;
  for (let i = 0; i < 240; i++) {
    last = await wsStatus(world);
    const open = (last.gates ?? []).find((g) => g.gate === gate || g.gate.endsWith(`.${gate}`));
    if (open) return open.gate;
    await sleep(500);
  }
  throw new Error(`the run never opened Gate ${gate} (last: ${JSON.stringify(last)})`);
}

Then("the credentialed command is running in the Sandbox Effector", async function (this: E2EWorld): Promise<void> {
  await gateOpen(this, "cut");
  const pod = await sandboxPodOf(this);
  for (let i = 0; i < 120; i++) {
    if ((await lingering(this, pod)).length > 0) return;
    await sleep(500);
  }
  throw new Error("the credentialed command never ran in the Sandbox Effector");
});

When("the state that runs the credentialed command exits", async function (this: E2EWorld): Promise<void> {
  const cut = await gateOpen(this, "cut");
  const r = await this.runCli(["send", this.runId!, "--gate", cut, "--event", "go"]);
  assert.equal(r.code, 0, `jr2 send failed: ${r.stderr}`);
  await gateOpen(this, "after");
});

Then(
  "the credentialed command's process is gone from the Sandbox Effector",
  async function (this: E2EWorld): Promise<void> {
    const pod = await sandboxPodOf(this);
    // SIGTERM ends `sleep` at once; the grace before SIGKILL is 5 s.
    let left: string[] = [];
    for (let i = 0; i < 60; i++) {
      left = await lingering(this, pod);
      if (left.length === 0) break;
      await sleep(500);
    }
    assert.deepEqual(left, [], "the stopped command still runs in the Sandbox Effector");
    const after = await gateOpen(this, "after");
    const r = await this.runCli(["send", this.runId!, "--gate", after, "--event", "go"]);
    assert.equal(r.code, 0, `jr2 send failed: ${r.stderr}`);
  },
);

// --- a GPG-signed push beside a credentialed command (ADR-0068) -------------------------------

/** An armored GPG secret key with no passphrase, made on the host for this scenario alone. */
async function scenarioGpgKey(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "jr2-e2e-gpg-"));
  const gpg = (args: string[]) => promisify(execFile)("gpg", ["--batch", "--homedir", home, ...args]);
  try {
    await gpg([
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      // Made a day ago: gpg refuses to sign with a key created after its clock reads, and a key made
      // at the host's clock now is one once that clock steps back (a host's clock sync).
      "--faked-system-time",
      `${Math.floor(Date.now() / 1000) - 86_400}!`,
      "--ignore-time-conflict",
      "--quick-gen-key",
      "jr2 e2e signer <signer@jr2.test>",
      "ed25519",
      "sign",
      "never",
    ]);
    const { stdout } = await gpg(["--armor", "--export-secret-keys", "signer@jr2.test"]);
    return stdout;
  } catch (err) {
    throw new Error(`this scenario makes its GPG key with the host's gpg, which failed: ${(err as Error).message}`);
  } finally {
    // The host's agent for this home leaves no socket directory under /run/user/<uid>/gnupg.
    await promisify(execFile)("gpgconf", ["--homedir", home, "--kill", "all"]).catch(() => undefined);
    await promisify(execFile)("gpgconf", ["--homedir", home, "--remove-socketdir"]).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * The scenario's namespace holds the two Secrets the GPG push remote's `git.credentials` entry
 * names (`kind-instance/jr2.config.ts`): the deploy key the seed's sshd authorizes, with its
 * known_hosts line, and a GPG signing key (`private.asc`, no passphrase), made on the host now.
 */
Given("the seed's GPG push remote trusts this scenario's keys", async function (this: E2EWorld): Promise<void> {
  await ensureSeed();
  const keys = await seedKeys();
  assert.ok(this.namespace, "a @kind scenario has its namespace set in setupKind");
  const objects = {
    apiVersion: "v1",
    kind: "List",
    items: [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: this.namespace } },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "jr2-e2e-push-key", namespace: this.namespace },
        stringData: { identity: keys.deploy, "identity.pub": keys.deployPub, known_hosts: keys.knownHosts },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "jr2-e2e-gpg-key", namespace: this.namespace },
        stringData: { "private.asc": await scenarioGpgKey() },
      },
    ],
  };
  await kubectlInput(this, ["apply", "-f", "-"], JSON.stringify(objects));
});

Then(
  "the credentialed command and the GPG-signed push both completed, and the remote holds the GPG-signed commit",
  async function (this: E2EWorld): Promise<void> {
    const run = (await httpOutput(this)) as {
      command?: { outcome?: string; code?: number; tail?: string } | null;
      push?: PushOut | null;
    };
    assert.equal(run.command?.outcome, "exited", JSON.stringify(run));
    assert.equal(run.command.code, 0, JSON.stringify(run));
    assert.match(run.command.tail ?? "", /deployed with \[secret:echo-token\]/, "the command ran, scrubbed");
    assert.equal(run.push?.outcome, "pushed", JSON.stringify(run));
    assert.ok(run.push.published && run.push.published !== run.push.source, "a signed copy, a new id");
    const { tip, raw } = await gpgRemoteCommit(`gpgsigned-${this.marker}`);
    assert.equal(tip, run.push.published, "the remote holds the signed commit");
    assert.match(raw, /^gpgsig -----BEGIN PGP SIGNATURE-----/m, `a GPG signature: ${raw}`);
    assert.match(raw, /^committer jr2 e2e signer <signer@jr2\.test> /m, "the committer is the signer");
    assert.match(raw, /^author jr2 e2e <e2e@jr2\.test> /m, "the author is the Agent's");
  },
);
