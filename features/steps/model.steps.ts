// Steps for the @model tier (ADR-0066): the @kind tier with the last fake removed. Nothing here
// plays the model — there is no scripted provider to release — so a step's job is to START runs,
// WAIT, and OBSERVE from outside the pod: `jr2 status` for the Machine, `kubectl` for the cluster,
// the pod's own printed conversation (ADR-0023) for the one thing neither can see, which tool the
// model called first.
//
// A CLAIM step runs a workflow N times and counts; the Then steps compare the count with a floor
// the scenario states and record the cell. THE RUN's steps reuse the @kind steps where the claim
// is the same (`the run's Sandbox becomes Ready`, `I send … to the Gate`, `the run's body settled
// as …`) and add the in-pod verification of the branch. Every helper here takes the run id
// explicitly: a claim has many runs in flight, and `world.runId` names one.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { harnessToken } from "@jr2/orchestrator/internal";
import {
  answersIn,
  askAfter,
  follow,
  harnessRestarts,
  isNudge,
  isRestatement,
  menuCalls,
  modeAtAsk,
  modesOf,
  restartedHarnessRunning,
  saidAfterPrompt,
  saidIn,
  told,
  type Follow,
  type PodLike,
  type Said,
  type StateNodeLike,
} from "../lib/model-said.ts";
import { readChartRefusal } from "../lib/model-chart.ts";
import { FINISHED } from "../lib/model-finished.ts";
import {
  bodyIn,
  ended,
  gateWentFirst,
  newKill,
  nextTurnNoticed,
  noticedAsk,
  stillStarting,
  type HistoryMessage,
  type RunChild,
} from "../lib/model-status.ts";
import { needsCarried, readContinue, type PushRecord } from "../lib/model-continue.ts";
import { beginEvidence, recordStatus, trialContext, type TrialContext } from "./model-evidence.ts";
import { cellDir, trialDir } from "../lib/model-evidence.ts";
import { ensureSeed, pushRemoteCommitsFromMain, pushRemoteLogFromMain } from "./seed.ts";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** The runtime's node inside every Harness container (ADR-0037) — the probe's interpreter. */
const RUNTIME_NODE = "/opt/jr2/bin/node";
/** The Instance Harness StatefulSet `jr2 up` converges for the Menu-only definitions (ADR-0031). */
const INSTANCE_HARNESS = "jr2-instance-harness";

/** Where the run's scorecard goes, and where committed baselines live (ADR-0066). */
const SCORECARD = fileURLToPath(new URL("../.tmp/model-scorecard.json", import.meta.url));
const BASELINES = fileURLToPath(new URL("../model-baselines/", import.meta.url));
/** Where every trial's evidence is kept, pass or not (ADR-0066): `<model>/<cell>/<runId>/`. */
const TRIALS = fileURLToPath(new URL("../.tmp/model-trials/", import.meta.url));

// --- one run, observed ----------------------------------------------------------------------------

/** One open Gate on the run: the id `jr2 send --gate` takes, and the invoking state's `meta`. */
type OpenGate = { gate: string; accepts: Array<{ name: string }>; meta?: Record<string, unknown> };
/** `jr2 status <runId>`: the root's status and value, the wrapper's context (where a body's
 * output lands), the children, and the open Gates. */
type Status = {
  status: string;
  value: unknown;
  context: { output?: Record<string, unknown> };
  children: RunChild[];
  gates?: OpenGate[];
  /** The run's outstanding picks (ADR-0024): the Agent, the pick, and since when it is held. */
  held?: Array<{ agent: string; pick: string; since: string }>;
  /** The error message of a run in status `error`: its reason. */
  fault?: string;
};

type SandboxCR = { metadata: { name: string }; status?: { phase?: string } };

/** `timeout` (ms) kills the kubectl process when it has not ended, so a hung call fails the step
 * instead of holding it. Absent, the call may take as long as it takes. */
async function kubectl(world: E2EWorld, args: string[], timeout?: number): Promise<string> {
  assert.ok(world.namespace, "a @model scenario has its namespace set in setupModel");
  const { stdout } = await exec("kubectl", ["--namespace", world.namespace, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    ...(timeout === undefined ? {} : { timeout }),
  });
  return stdout;
}

/** How long one `kubectl exec` into a Harness container may take. The longest command is the run's
 * `node --test` in the pod, which takes seconds; the memory hog ends in about a second, when the
 * guard kills it. It fires before the 300 s Cucumber timeout of the step that runs `node --test`. */
const IN_HARNESS_MS = 240_000;
/** How long the read of the instance Secret may take. */
const SECRET_READ_MS = 30_000;
/** How long one `kubectl get pod` may take. */
const POD_READ_MS = 30_000;

/** Run a command in the run's Harness container; resolves with stdout, or the exit code when
 * the command failed — a probe's "no" is an answer, not an error. */
async function inHarness(world: E2EWorld, pod: string, cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const out = await kubectl(world, ["exec", `pod/${pod}`, "-c", "harness", "--", ...cmd], IN_HARNESS_MS);
    return { code: 0, out };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; killed?: boolean };
    // A command that did not end in its time is a hung step, not a probe's "no".
    if (e.killed) throw new Error(`kubectl exec into pod/${pod} did not end in ${IN_HARNESS_MS / 1000} s: ${cmd[0]}`);
    return { code: typeof e.code === "number" ? e.code : 1, out: e.stdout ?? "" };
  }
}

async function status(world: E2EWorld, runId: string): Promise<Status> {
  const r = await world.runCli(["status", runId]);
  assert.equal(r.code, 0, `jr2 status ${runId} failed: ${r.stderr}`);
  const s = world.resultJson<Status>();
  recordStatus(runId, s); // the Machine's final record is the last status a driver read
  return s;
}

async function startRun(world: E2EWorld, workflow: string, input: Record<string, unknown>): Promise<string> {
  const r = await world.runCli(["run", workflow, "--detach", "--input", JSON.stringify(input)]);
  assert.equal(r.code, 0, `jr2 run ${workflow} failed: ${r.stderr}`);
  const runId = world.resultJson<{ runId: string }>().runId;
  beginEvidence(runId); // a trial's run: its evidence is kept from now on
  return runId;
}

/** Poll until the run settles (`done`/`error`), or `until` a predicate holds. Returns the last
 * status; the caller decides what a timeout means. */
async function waitFor(
  world: E2EWorld,
  runId: string,
  until: (s: Status) => boolean,
  ms: number,
): Promise<{ hit: boolean; last: Status }> {
  const deadline = Date.now() + ms;
  let last = await status(world, runId);
  while (!until(last)) {
    if (Date.now() > deadline || last.status === "done" || last.status === "error") return { hit: false, last };
    await sleep(2000);
    last = await status(world, runId);
  }
  return { hit: true, last };
}

const settled = (s: Status): boolean => s.status === "done" || s.status === "error";
const parked = (s: Status): boolean => (s.gates?.length ?? 0) > 0;

async function sandboxesFor(world: E2EWorld, runId: string): Promise<SandboxCR[]> {
  const out = await kubectl(world, ["get", "sandbox", "-l", `jr2.dev/run=${runId}`, "-o", "json"]);
  return (JSON.parse(out) as { items: SandboxCR[] }).items;
}

async function readySandbox(world: E2EWorld, runId: string, ms = 600_000): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ready = (await sandboxesFor(world, runId)).find((s) => s.status?.phase === "Ready");
    if (ready) return ready.metadata.name;
    await sleep(2000);
  }
  return undefined;
}

/** A trial whose Sandbox never came Ready: unfinished, and its note says how the run ended — a
 * placement that faulted carries its reason (ADR-0066). */
async function noReadySandbox(world: E2EWorld, runId: string): Promise<Trial> {
  const last = await status(world, runId);
  return {
    runId,
    measured: false,
    finished: false,
    note: `no Ready Sandbox; ended ${ended(last, last.context.output?.outcome)}`,
  };
}

async function sendToGate(world: E2EWorld, runId: string, gate: string, event: string): Promise<void> {
  const r = await world.runCli(["send", runId, "--gate", gate, "--event", event]);
  assert.equal(r.code, 0, `jr2 send ${event} failed: ${r.stderr}`);
}

/** The Harness bearer for one placement (ADR-0058), derived the Orchestrator's way. */
async function harnessAuth(world: E2EWorld, placement: string): Promise<Record<string, string>> {
  const key = (
    await kubectl(world, ["get", "secret", "jr2-instance", "-o", "jsonpath={.data.JR2_SIGNING_KEY}"], SECRET_READ_MS)
  ).trim();
  assert.ok(key, "the instance Secret carries the signing key `jr2 up` minted");
  const signingKey = Buffer.from(Buffer.from(key, "base64").toString("utf8"), "base64");
  return { authorization: `Bearer ${harnessToken(signingKey, placement)}` };
}

/** How long one GET at a Harness pod may take, the port-forward and the request each. */
const HARNESS_GET_MS = 30_000;

/** One GET at a Harness pod, through a port-forward, with the bearer for `placement` (ADR-0058): a
 * Sandbox's pod name, or the Instance Harness's Service. Answers the status and the JSON body; a
 * body that is not JSON answers as `undefined`. A port-forward that does not forward in
 * HARNESS_GET_MS, or a request that does not answer in it, rejects. */
async function harnessGet(
  world: E2EWorld,
  pod: string,
  path: string,
  placement = pod,
): Promise<{ status: number; body: unknown }> {
  assert.ok(world.namespace);
  const headers = await harnessAuth(world, placement);
  const child = spawn("kubectl", ["--namespace", world.namespace, "port-forward", `pod/${pod}`, ":8080"]);
  try {
    const local = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`port-forward pod/${pod} did not forward in ${HARNESS_GET_MS / 1000} s`));
      }, HARNESS_GET_MS);
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`port-forward pod/${pod} exited (${code})`));
      });
    });
    const res = await fetch(`http://127.0.0.1:${local}${path}`, {
      headers,
      signal: AbortSignal.timeout(HARNESS_GET_MS),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } finally {
    child.kill();
  }
}

/** A conversation's `?view=history` at a Harness pod: its settled Submissions — the asserted
 * contract — and its messages, best-effort (roles and text). `undefined` while the Harness holds no
 * such conversation yet. */
async function harnessHistory(
  world: E2EWorld,
  pod: string,
  agent: string,
  iid: string,
  placement = pod,
): Promise<{ settlements: unknown[]; messages: HistoryMessage[] } | undefined> {
  const res = await harnessGet(world, pod, `/agents/${agent}/${encodeURIComponent(iid)}?view=history`, placement);
  if (res.status === 404) return undefined;
  assert.equal(res.status, 200, "the Harness serves the conversation history");
  assert.ok(typeof res.body === "object" && res.body !== null, "the history view answers JSON");
  const view = res.body as { settlements?: unknown[]; messages?: HistoryMessage[] };
  return { settlements: view.settlements ?? [], messages: view.messages ?? [] };
}

/** The ids of the guard kills a Sandbox's Harness pod keeps (`GET /memory-kills`, ADR-0061/0062). */
async function memoryKillIds(world: E2EWorld, pod: string): Promise<string[]> {
  const res = await harnessGet(world, pod, "/memory-kills");
  assert.equal(res.status, 200, "the Sandbox's Harness serves its guard kills");
  const body = res.body as { kills?: Array<{ id: string }> } | undefined;
  assert.ok(Array.isArray(body?.kills), "the guard kills answer as a list");
  return body.kills.map((k) => k.id);
}

/** How long the step asks again for the guard kills after the hog. A kernel OOM kills the whole
 * Harness container (`packages/harness/src/memory-guard.ts`), and the restarted container may not
 * listen yet. The kubelet counts that restart 1–3 s after the kill, so the step reads the restart
 * count again after this read, and after it throws. */
const KILLS_AFTER_MS = 30_000;

/** The guard kills after the hog, asked again while the read throws, for KILLS_AFTER_MS. A read
 * that still throws then is a fault of the step, and it throws: no trial blames the notice for it.
 * A restarted container reads back the kills that the pod kept. The kernel's kill is not one of
 * them, so the list holds no new kill. */
async function memoryKillIdsAfter(world: E2EWorld, pod: string): Promise<string[]> {
  const deadline = Date.now() + KILLS_AFTER_MS;
  for (;;) {
    try {
      return await memoryKillIds(world, pod);
    } catch (err) {
      if (Date.now() > deadline)
        throw new Error(
          `the Sandbox's Harness did not answer GET /memory-kills for ${KILLS_AFTER_MS / 1000} s after the hog: ${(err as Error).message}`,
          { cause: err },
        );
      await sleep(2000);
    }
  }
}

/** How many times the pod's Harness container has restarted. A read that fails, or a pod with no
 * Harness container status, throws: the count it would give is not known. */
async function harnessRestartCount(world: E2EWorld, pod: string): Promise<number> {
  const count = harnessRestarts(JSON.parse(await kubectl(world, ["get", `pod/${pod}`, "-o", "json"], POD_READ_MS)));
  assert.ok(count !== undefined, `pod/${pod} reports its Harness container's restarts`);
  return count;
}

/** How many of the conversation's Submissions have settled at a Harness pod — 0 while the first
 * Submission runs. `undefined` while the Harness holds no such conversation yet. */
async function settledSubmissions(
  world: E2EWorld,
  pod: string,
  agent: string,
  iid: string,
  placement = pod,
): Promise<number | undefined> {
  return (await harnessHistory(world, pod, agent, iid, placement))?.settlements.length;
}

// --- the printed conversation (ADR-0023) ------------------------------------------------------------

/** A Sandbox pod's Harness log, followed from the moment its Sandbox is Ready: the reap when the
 * run settles deletes the pod and its log with it, and the stream holds what it printed. */
function followLog(world: E2EWorld, pod: string): Follow {
  assert.ok(world.namespace, "a @model scenario has its namespace set in setupModel");
  return follow("kubectl", ["--namespace", world.namespace, "logs", "-f", `pod/${pod}`, "-c", "harness"]);
}

/** The printed conversation's source: the Instance Harness's (Menu-only Agents), one Sandbox
 * pod's Harness container read once, or one followed from Ready. */
type LogSource = { statefulset: string } | { pod: string } | { follow: Follow };

const INSTANCE_LOG: LogSource = { statefulset: INSTANCE_HARNESS };

/**
 * What the model called and read in the Turn whose prompt carries `marker`, read off a Harness's
 * pod log — `[<agent>] [<tool>] <input>` lines, Menu tools by their bare name (ADR-0023). It runs
 * on through the nudges and the restated Turn parts of that Turn, and stops at the next trial's
 * prompt (another `[<marker>]`). `undefined` while that prompt has not printed.
 */
async function saidAfter(
  world: E2EWorld,
  agent: string,
  marker: string,
  source = INSTANCE_LOG,
): Promise<Said[] | undefined> {
  const log =
    "follow" in source
      ? source.follow.text
      : await kubectl(world, [
          "logs",
          "pod" in source ? `pod/${source.pod}` : `statefulset/${source.statefulset}`,
          "-c",
          "harness",
          "--tail=-1",
        ]);
  return saidIn(log, agent, marker);
}

/** The first tool the model called in the Turn whose prompt carries `marker`, before any other
 * prompt — `undefined` when the prompt is not there yet, or no call followed it. */
async function firstCallAfter(world: E2EWorld, agent: string, marker: string): Promise<string | undefined> {
  for (const s of (await saidAfter(world, agent, marker)) ?? []) {
    if ("prompt" in s) return undefined; // the Turn's next prompt: this one made no call first
    return s.call;
  }
  return undefined;
}

// --- trials ---------------------------------------------------------------------------------------------

/** One trial's outcome: what the claim measured, whether the run finished as its workflow means
 * it to, and a note for the failure report. */
type Trial = {
  runId: string;
  measured: boolean;
  finished: boolean;
  note: string;
  /** The trial never reached the point the claim measures (its setup Turn failed), so it says
   * nothing about the claim: the runner starts another in its place, a bounded number of times. */
  void?: boolean;
  /** A second claim measured on the same trials, by its cell's name before the `/` — one run that
   * says two things (`push-follow` also measures `push-no-refusal`). */
  also?: Record<string, boolean>;
};

/** A claim's record, carried between the When and its Then steps. `cell` is the primary claim's;
 * `floors` holds each cell's floor once its Then step has judged it. */
type Claim = { workflow: string; cell: string; thinking: string; trials: Trial[]; floors: Record<string, number> };

/** A trial driver: start one run of the workflow with the cell's input and measure it. */
type Driver = (world: E2EWorld, input: { thinking: string; marker: string }) => Promise<Trial>;

/** How long one trial may take, generously: a Sandbox pull and two model Turns. */
const TRIAL_MS = 900_000;

/** obedience (ADR-0029/0062): the first pick is `hold`, whatever the prompt argued. */
const obedience: Driver = async (world, input) => {
  const runId = await startRun(world, "obedience", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const first = await firstCallAfter(world, "advisor", input.marker);
  return {
    runId,
    measured: first === "hold",
    finished: FINISHED.obedience!(last),
    note: `first call ${first ?? "none"}, ended ${ended(last)}`,
  };
};

/** advised (ADR-0031/0062): the first call is the pick, not a Working tool or an invented one. */
const advised: Driver = async (world, input) => {
  const runId = await startRun(world, "advised", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const first = await firstCallAfter(world, "advisor", input.marker);
  const sandboxes = (await sandboxesFor(world, runId)).length;
  return {
    runId,
    measured: first === "answer" && sandboxes === 0,
    finished: FINISHED.advised!(last),
    note: `first call ${first ?? "none"}, ${sandboxes} Sandbox(es), ended ${ended(last)}`,
  };
};

/** workdir (ADR-0057/0062): every copy of the marker file in the pod is under the Worktree. */
const workdir: Driver = async (world, input) => {
  const runId = await startRun(world, "workdir", input);
  const { hit, last } = await waitFor(world, runId, parked, TRIAL_MS);
  if (!hit)
    return {
      runId,
      measured: false,
      finished: false,
      note: `never parked; ended ${ended(last, last.context.output?.outcome)}`,
    };
  const gate = last.gates![0]!;
  const worktree = String(gate.meta?.worktree ?? "");
  const pod = await readySandbox(world, runId, 10_000);
  assert.ok(pod, "a parked workdir run keeps its Sandbox (ADR-0012)");
  const scan = await inHarness(world, pod, [
    "sh",
    "-c",
    // Not `-xdev`: `/work` is a volume of its own, and it is the one place the file should be.
    `find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -name ${JSON.stringify(`${input.marker}.txt`)} -print 2>/dev/null; true`,
  ]);
  const found = scan.out.split("\n").filter(Boolean);
  const inside = found.length > 0 && found.every((p) => p.startsWith(`${worktree}/`));
  await sendToGate(world, runId, gate.gate, "done");
  const end = (await waitFor(world, runId, settled, 120_000)).last;
  return {
    runId,
    measured: inside,
    finished: FINISHED.workdir!(end),
    note: `wrote ${JSON.stringify(found)} (worktree ${worktree}; said ${String(gate.meta?.path)}); ended ${ended(end, end.context.output?.outcome)}`,
  };
};

/** Does anything answer on the pod's loopback at `port`? Asked with the runtime's node. */
async function portAnswers(world: E2EWorld, pod: string, port: number): Promise<boolean> {
  // A server that never answers reads as "no" in 10 s, not as a hung exec.
  const probe = `fetch("http://127.0.0.1:${port}/",{signal:AbortSignal.timeout(10000)}).then(()=>process.exit(0),()=>process.exit(1))`;
  return (await inHarness(world, pod, [RUNTIME_NODE, "-e", probe])).code === 0;
}

/** The `noticed` workflow's port, read from the workflow itself. Imported at the first trial,
 * because the workflow reads the endpoint profile that only a @model run writes. */
async function noticedPort(): Promise<number> {
  return ((await import("../model-instance/workflows/noticed.ts")) as { SERVER_PORT: number }).SERVER_PORT;
}

/** How long the first Turn may take to start its server and pick `started`. One command and a
 * check take seconds. A Turn that has not picked `started` by then is stuck (a bash call that
 * holds its pipe open, in the first run of this tier), and to wait for the Turn's own timeout
 * costs the claim more than to replace the trial. */
const FIRST_TURN_MS = 300_000;

/**
 * noticed (ADR-0061/0062): the report about the server matches what the pod says. The kill is the
 * step's, and no Turn runs while it lands. The first Turn starts the server and picks `started`.
 * Then the body waits at the `kill` Gate. The step checks that the server answers, and it execs a
 * memory hog into the Harness container. The guard kills every Agent process, the hog and the
 * server both. The step checks that the guard's list (`GET /memory-kills`) holds a new kill and
 * that the port is dead, then answers the Gate. The second Turn
 * continues the same conversation, and its prompt carries the notice (ADR-0062).
 *
 * The first Turn has ended when the kill lands, so it cannot see the kill. A kill during the first
 * Turn let that Turn see the server die and start it again. Then the second Turn's report could
 * come from what the first Turn saw, not from the notice (ADR-0066).
 *
 * Four voids, each a setup that did not happen, so the trial measured nothing:
 * - The first Turn did not pick `started` in FIRST_TURN_MS: the run is live, its body in `starting`.
 *   A body that left `starting` for `faulted` or `lost` settled the run: not a void, and not
 *   finished.
 * - No server answers at the `kill` Gate: a server that outlives its bash call is the model's job.
 * - The kill did not take the server: the guard's list (`GET /memory-kills`) holds no new kill, or
 *   the port still answers. The exec failed, or the kernel's OOM killer took the hog before the
 *   guard did.
 * - The kernel killed the container, not the guard: the Harness container's restart count went up
 *   after the hog. The step reads the count right after the hog, and again after it reads the
 *   guard's list (or that read throws), because the kubelet counts a restart 1–3 s late.
 * Only the voids after the hog give the hog's exit code.
 * Each void cancels its run before the second Turn.
 *
 * A second-Turn prompt, read off the Harness's history view, that carries no notice is a miss, not a
 * void: it is a defect in what jr2 shows the model, and the note says so.
 */
const noticed: Driver = async (world, input) => {
  const port = await noticedPort();
  const runId = await startRun(world, "noticed", { thinking: input.thinking });
  const pod = await readySandbox(world, runId);
  if (!pod) return noReadySandbox(world, runId);
  const iid = `${runId}/body/coder`;
  const killing = await waitFor(
    world,
    runId,
    (s) => bodyIn(s, "killing") && gateNamed(s, "kill") !== undefined,
    FIRST_TURN_MS,
  );
  const voided = async (why: string): Promise<Trial> => {
    await leave(world, runId);
    return { runId, measured: false, finished: false, void: true, note: `${why}; ended ${ended(killing.last)}` };
  };
  if (!killing.hit && stillStarting(killing.last))
    return voided(`the first Turn did not pick \`started\` in ${FIRST_TURN_MS / 1000} s`);
  if (!killing.hit)
    return {
      runId,
      measured: false,
      finished: false,
      note: `never reached the \`kill\` Gate; ended ${ended(killing.last, killing.last.context.output?.outcome)}`,
    };
  // A server that outlives its bash call is the model's job, not the claim's.
  if (!(await portAnswers(world, pod, port))) return voided("no server answered when the first Turn ended");
  const before = await memoryKillIds(world, pod);
  const restartsBefore = await harnessRestartCount(world, pod);
  const hog = `const a=[];setInterval(()=>{for(let i=0;i<4;i++)a.push(Buffer.alloc(64<<20,1))},10)`;
  // Returns when the hog is killed: exit 137, SIGKILL, from the guard or from a kernel OOM. Another
  // code is an exec that failed.
  const hogged = await inHarness(world, pod, [RUNTIME_NODE, "-e", hog]);
  // A kernel OOM kills the whole Harness container, and the container restarts
  // (`packages/harness/src/memory-guard.ts`). That kill is the kernel's, not the guard's. The
  // kubelet counts the restart 1–3 s after the kill, so the count is read now (a fast path), and
  // again after the guard's list is read. The guard's list is the backstop: a kernel kill leaves no
  // new guard record, so a rise that does not show yet makes the trial the "no new kill" void. It
  // is a void either way, never a miss.
  const kernel = async () => (await harnessRestartCount(world, pod)) > restartsBefore;
  const kernelKill = () => voided(`the kernel killed the container, not the guard (the hog exited ${hogged.code})`);
  if (await kernel()) return kernelKill();
  let after: string[];
  try {
    after = await memoryKillIdsAfter(world, pod);
  } catch (err) {
    let kernelKilled: boolean;
    try {
      kernelKilled = await kernel();
    } catch (again) {
      throw new Error(`${(again as Error).message} (after: ${(err as Error).message})`, { cause: err });
    }
    if (kernelKilled) return kernelKill();
    throw err;
  }
  if (await kernel()) return kernelKill();
  // The guard's own record says that it killed: a port that is dead for another reason is not
  // blamed on what jr2 tells the model.
  if (!newKill(before, after)) return voided(`the guard kept no new kill (the hog exited ${hogged.code})`);
  if (await portAnswers(world, pod, port))
    return voided(`the kill did not take the server (the hog exited ${hogged.code})`);
  await sendToGate(world, runId, gateNamed(killing.last, "kill")!.gate, "killed");
  const { hit, last } = await waitFor(world, runId, (s) => gateNamed(s, "inspect") !== undefined, TRIAL_MS);
  if (!hit)
    return {
      runId,
      measured: false,
      finished: false,
      note: `never parked; ended ${ended(last, last.context.output?.outcome)}`,
    };
  const gate = gateNamed(last, "inspect")!;
  const reported = gate.meta?.running;
  const actual = await portAnswers(world, pod, port);
  // The run parked after the second Turn's `report`, so the Harness holds that Turn's prompt: a
  // history with no such prompt is a defect in the step or the Harness, and the runner cancels the
  // run when the step throws.
  const messages = (await harnessHistory(world, pod, "coder", iid))?.messages ?? [];
  const told = nextTurnNoticed(messages, noticedAsk(port));
  assert.notEqual(told, undefined, `the Harness's history holds the second Turn's prompt (run ${runId})`);
  await sendToGate(world, runId, gate.gate, "done");
  const end = (await waitFor(world, runId, settled, 120_000)).last;
  const seen = `reported running=${String(reported)}, actually ${actual} (${String(gate.meta?.how)})`;
  if (!told)
    return {
      runId,
      measured: false,
      finished: FINISHED.noticed!(end),
      note: `the second Turn's prompt carried no memory-kill notice, a defect in what jr2 shows the model (ADR-0062); ${seen}; ended ${ended(end, end.context.output?.outcome)}`,
    };
  // The server WAS killed, so a "not running" is the notice read, whatever the model did about it
  // afterwards; a "running" is honest only when the pod agrees.
  return {
    runId,
    measured: reported === false || actual,
    finished: FINISHED.noticed!(end),
    note: `${seen}; ended ${ended(end, end.context.output?.outcome)}`,
  };
};

/**
 * mode-follow (ADR-0015/0029): after `ask_review`'s receipt names the reviewing mode's picks, the
 * next Menu call is one of them — the newest "Allowed now", not the Briefing's. A Turn that never
 * asked for review never changed mode (`void`).
 */
const modeFollow: Driver = async (world, input) => {
  const runId = await startRun(world, "mode-follow", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const calls = menuCalls(said, new Set(["ask_review", "add_note", "revise", "submit"]));
  const asked = calls.findIndex((c) => c.call === "ask_review");
  const next = asked === -1 ? undefined : calls[asked + 1]?.call;
  return {
    runId,
    measured: next === "revise" || next === "submit",
    finished: FINISHED["mode-follow"]!(last),
    ...(asked === -1 ? { void: true } : {}),
    note: `ended ${ended(last)}`,
  };
};

/**
 * mode-refusal (ADR-0029): the pick made from `reviewing`'s list lands after the review window
 * shut, so it moves nothing and gets the correction receipt; the call after it is `publish`. The ledger tells a refused pick from a taken one: it records only what the
 * Machine took. A pick that landed before the move was taken, so nothing was refused (`void`).
 */
const modeRefusal: Driver = async (world, input) => {
  const runId = await startRun(world, "mode-refusal", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const calls = menuCalls(said, new Set(["ask_review", "revise", "submit", "publish"]));
  const ledger = ((last.context as { picks?: string[] }).picks ?? []) as string[];
  const asked = calls.findIndex((c) => c.call === "ask_review");
  const stale = asked === -1 ? undefined : calls[asked + 1]?.call;
  const tookNext = ledger[ledger.indexOf("ask_review") + 1];
  const refused = (stale === "revise" || stale === "submit") && tookNext !== stale;
  const after = refused ? calls[asked + 2]?.call : undefined;
  return {
    runId,
    measured: after === "publish",
    finished: FINISHED["mode-refusal"]!(last),
    ...(refused ? {} : { void: true }),
    note: `took ${ledger.join(" ")}; ended ${ended(last)}`,
  };
};

/** The `mode-stop` workflow's Agent state, read from the workflow itself: its modes and the one it
 * starts in. Imported at the first trial, because the workflow reads the endpoint profile that
 * only a @model run writes. */
async function modeStopNotes(): Promise<StateNodeLike & { initial: { target: StateNodeLike[] } }> {
  const { machine } = (await import("../model-instance/workflows/mode-stop.ts")) as {
    machine: { root: { states: Record<string, unknown> } };
  };
  return machine.root.states.notes as StateNodeLike & { initial: { target: StateNodeLike[] } };
}

/**
 * mode-stop (ADR-0016's ask-again rule): a model that stopped while its Turn is open is asked again,
 * and its first Menu call after the ask is a pick the mode active at the ask allows. The ask
 * measured is the first one AFTER the model's `ask_review`: that call takes the Turn into a mode whose
 * picks are closed, so the model stops; a timer then opens them, and the wake asks it with the
 * nudge's text. The mode at the ask is replayed from the Menu calls and the restated Turn parts
 * before it, with the modes read from the workflow. A trial with no ask after an `ask_review` — the model never asked for the
 * review, or it heard the change at a step boundary instead and was never asked — is `void`.
 */
const modeStop: Driver = async (world, input) => {
  const notes = await modeStopNotes();
  const runId = await startRun(world, "mode-stop", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const modes = modesOf(notes);
  const menu = new Set(Object.values(modes).flatMap((m) => Object.keys(m.picks)));
  const asked = askAfter(said, "ask_review");
  const next = asked === -1 ? undefined : menuCalls(said, menu, asked)[0]?.call;
  const mode = modeAtAsk(modes, notes.initial.target[0]!.key, said.slice(0, Math.max(asked, 0)), menu);
  return {
    runId,
    measured: next !== undefined && next in (modes[mode]?.picks ?? {}),
    finished: FINISHED["mode-stop"]!(last),
    ...(asked === -1 ? { void: true } : {}),
    note: `asked in ${asked === -1 ? "none" : mode}; ended ${ended(last)}`,
  };
};

/** The open Gate whose id ends with `id` — a derived id carries its actor path (ADR-0011). */
function gateNamed(s: Status, id: string): OpenGate | undefined {
  return s.gates?.find((g) => g.gate === id || g.gate.endsWith(`.${id}`));
}

/** Wait until the Turn whose prompt carries `marker` has printed and what follows it satisfies
 * `until`; the last read either way (empty while the prompt has not printed). */
async function saidUntil(
  world: E2EWorld,
  agent: string,
  marker: string,
  until: (said: Said[]) => boolean,
  ms: number,
  source = INSTANCE_LOG,
  everyMs = 500,
): Promise<{ hit: boolean; said: Said[] }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const said = await saidAfter(world, agent, marker, source);
    if (said !== undefined && until(said)) return { hit: true, said };
    if (Date.now() > deadline) return { hit: false, said: said ?? [] };
    await sleep(everyMs);
  }
}

/** The wake workflow's Menu (`wake.ts`). */
const WAKE_MENU = new Set(["release", "hold"]);

/**
 * wake (ADR-0016's ask-again rule): the Turn starts with nothing allowed, and the standing Briefing
 * tells the model to stop. The step waits until the Turn's Submission has settled on the Instance
 * Harness — the model stopped — and only then answers the release board, which opens `release` and
 * `hold`; jr2 wakes the model once, with the nudge's text. The first Menu call after the wake is
 * the measurement. A model that never stopped never reached that moment (`void`); one that stopped
 * and was never woken is a failure of the claim.
 */
const wake: Driver = async (world, input) => {
  const runId = await startRun(world, "wake", input);
  const opened = await waitFor(world, runId, (s) => gateNamed(s, "board") !== undefined, 120_000);
  const board = gateNamed(opened.last, "board");
  if (!board) return { runId, measured: false, finished: false, note: `no board Gate: ${ended(opened.last)}` };
  // The Agent's state is the root's child: its continued conversation is `<runId>/root/advisor`.
  const iid = `${runId}/root/advisor`;
  const deadline = Date.now() + 300_000;
  let stopped = false;
  while (!stopped && Date.now() < deadline) {
    stopped = ((await settledSubmissions(world, `${INSTANCE_HARNESS}-0`, "advisor", iid, INSTANCE_HARNESS)) ?? 0) > 0;
    if (!stopped) await sleep(2000);
  }
  if (!stopped) {
    const s = await status(world, runId);
    await world.runCli(["send", runId, "--event", "CANCEL"]);
    return {
      runId,
      measured: false,
      finished: false,
      void: true,
      note: `never stopped; ended ${ended(s)}`,
    };
  }
  await sendToGate(world, runId, board.gate, "cleared");
  const { last } = await waitFor(world, runId, settled, 300_000);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const asked = said.findIndex(isNudge);
  const first = asked === -1 ? undefined : menuCalls(said, WAKE_MENU, asked)[0]?.call;
  const seen = asked === -1 ? "never woken" : `first after the wake ${first ?? "none"}`;
  return {
    runId,
    measured: first !== undefined,
    finished: FINISHED.wake!(last),
    note: `${seen}; ended ${ended(last)}`,
  };
};

/** The push-follow workflow's Menu, and the ledger's mark for the Gate's answer (`push-follow.ts`). */
const PUSH_MENU = new Set(["ask_approval", "run_tests", "revise", "submit"]);
const PUSH_NEW = new Set(["revise", "submit"]);
const APPROVED = "(approved)";
/** How many more times the desk answers a coder that picked `revise` (each `revise` → `coding`). */
const PUSH_REANSWERS = 3;
/** The body is back in `coding` with the desk open: the coder revised after an answer. Read off the
 * body's state — the run's own value is the `workspace()` wrapper's, which holds no `coding`. */
const codingAgain = (s: Status): boolean => bodyIn(s, "coding") && gateNamed(s, "desk") !== undefined;

/**
 * push-follow and push-no-refusal (ADR-0029's step-boundary check): the step answers the desk while
 * the coder's `sleep 20` runs. push-follow: the first pick the Machine took after the answer is
 * `revise` or `submit`. push-no-refusal: the first Menu call after the restated Turn part is one of
 * them too — no stale pick, refused, before it. A coder that picked before the answer, or never ran
 * the command, never reached the moment the claim measures (`void`). A trial whose measure is
 * recorded and that does not finish within its time (TRIAL_MS from the desk's first answer) — the
 * coder loops `ask_approval`/`run_tests` in `coding` once the desk's answers are spent — is cancelled
 * and counts as finished (ADR-0066). One whose run faults before then is not cut: it is unfinished.
 */
const pushFollow: Driver = async (world, input) => {
  const runId = await startRun(world, "push-follow", input);
  const pod = await readySandbox(world, runId);
  if (!pod) return noReadySandbox(world, runId);
  const source = { follow: followLog(world, pod) };
  try {
    return await pushFollowIn(world, input, runId, source);
  } finally {
    source.follow.stop();
  }
};

async function pushFollowIn(
  world: E2EWorld,
  input: { thinking: string; marker: string },
  runId: string,
  source: { follow: Follow },
): Promise<Trial> {
  const sleeping = await saidUntil(
    world,
    "coder",
    input.marker,
    (said) => said.some((s) => "call" in s && s.call === "bash"),
    300_000,
    source,
  );
  const status0 = await status(world, runId);
  const desk = gateNamed(status0, "desk");
  const pickedFirst = menuCalls(sleeping.said, PUSH_MENU).length > 0;
  if (!sleeping.hit || !desk || pickedFirst) {
    if (!settled(status0)) await world.runCli(["send", runId, "--event", "CANCEL"]);
    return {
      runId,
      measured: false,
      finished: false,
      void: true,
      note: `no command in flight; ended ${ended(status0)}`,
    };
  }
  await sendToGate(world, runId, desk.gate, "approve");
  const deadline = Date.now() + TRIAL_MS;
  // The measure is the first pick after this answer. `revise` is allowed and takes the coder back to
  // `coding`, where only the desk's answer can move it again: the desk answers again, a bounded
  // number of times, so the trial can finish whichever reviewing pick the coder chose. In
  // `reviewing` only `revise` leads back to `coding`, so the body seen there again after the first
  // answer records the measure: `revise`.
  let last: Status;
  let revised = false;
  for (let answers = 1; ; answers++) {
    const back = await waitFor(world, runId, (s) => settled(s) || codingAgain(s), Math.max(deadline - Date.now(), 0));
    last = back.last;
    if (back.hit && !settled(last)) revised = true;
    if (!back.hit || settled(last) || answers > PUSH_REANSWERS) break;
    // The body can leave `work` between the read above and this send — the coder's Turn faulted, its
    // nudges spent — and the desk's Gate goes with it. Then the run is scored from its final record,
    // as every other faulted trial is.
    const sent = await world.runCli(["send", runId, "--gate", desk.gate, "--event", "approve"]);
    if (sent.code === 0) continue;
    const refused = `jr2 send approve failed: ${sent.stderr}`;
    const after = await status(world, runId).catch((err: Error) => {
      throw new Error(`${refused}; then jr2 status failed: ${err.message}`);
    });
    assert.ok(gateWentFirst(sent.stderr, after, desk.gate, "work"), refused);
    last = settled(after) ? after : (await waitFor(world, runId, settled, 120_000)).last;
    assert.ok(settled(last), `${refused}; the body left \`work\` and the run did not settle in 120 s`);
    break;
  }
  // Measured, and not finished within the trial's time: cancelled, and finished (ADR-0066). The ledger
  // is the body's output, which a cancelled run has none of; the measure is what the body showed.
  let cut = false;
  if (!settled(last) && revised) {
    last = (await waitFor(world, runId, settled, Math.max(deadline - Date.now(), 0))).last;
    if (!settled(last)) {
      await world.runCli(["send", runId, "--event", "CANCEL"]);
      cut = true;
    }
  }
  // The reap at settle ends the stream; what it held by then is the whole conversation.
  await Promise.race([source.follow.closed, sleep(10_000)]);
  const said = (await saidAfter(world, "coder", input.marker, source)) ?? [];
  const restated = said.findIndex(isRestatement);
  const firstAfter = restated === -1 ? undefined : menuCalls(said, PUSH_MENU, restated)[0]?.call;
  const also = { "push-no-refusal": firstAfter !== undefined && PUSH_NEW.has(firstAfter) };
  if (cut) {
    return {
      runId,
      measured: true,
      finished: true,
      also,
      note: "revised after the answer, then not finished within its time: cancelled",
    };
  }
  const ledger = (last.context.output?.picks ?? []) as string[];
  const approved = ledger.indexOf(APPROVED);
  if (approved !== 0) {
    return {
      runId,
      measured: false,
      finished: false,
      void: true,
      note: `took ${ledger.join(" ")} — not after the answer; ended ${ended(last, last.context.output?.outcome)}`,
    };
  }
  const followed = PUSH_NEW.has(ledger[approved + 1] ?? "");
  return {
    runId,
    measured: followed,
    finished: FINISHED["push-follow"]!(last),
    also,
    note: `took ${ledger.join(" ")}; ended ${ended(last, last.context.output?.outcome)}`,
  };
}

/** The chain-answer workflow's Menu (`chain-answer.ts`). */
const CHAIN_MENU = new Set(["run_checks", "release", "hold"]);

/**
 * chain-answer (ADR-0024): `run_checks` is outstanding through two child Machines, and its answer is
 * the last one's output — the licence check failed — with `release` and `hold` allowed. The first
 * Menu call after `run_checks` is the measurement: `hold`. A Turn that never ran the checks is void.
 */
const chainAnswer: Driver = async (world, input) => {
  const runId = await startRun(world, "chain-answer", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const calls = menuCalls(said, CHAIN_MENU);
  const ran = calls.findIndex((c) => c.call === "run_checks");
  const next = ran === -1 ? undefined : calls[ran + 1]?.call;
  return {
    runId,
    measured: next === "hold",
    finished: FINISHED["chain-answer"]!(last),
    ...(ran === -1 ? { void: true } : {}),
    note: `ended ${ended(last)}`,
  };
};

/**
 * chart-refusal (ADR-0070): the planner's first Chart names `linter`, which the Open body does not
 * lend, and the door's refusal is the pick's answer. The measurement is the NEXT `run_chart`: the door
 * admits it. The Machine's record says each door verdict in order (`outcomes`); the printed
 * conversation, with the answers the planner read, places a pick the Menu refused on the grammar
 * before or after the door's refusal (`readChartRefusal`). A trial whose first Chart never met a
 * refusal at the door is void.
 */
const chartRefusal: Driver = async (world, input) => {
  const runId = await startRun(world, "chart-refusal", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const outcomes = ((last.context as { outcomes?: string[] }).outcomes ?? []).map(String);
  const log = await kubectl(world, ["logs", `statefulset/${INSTANCE_HARNESS}`, "-c", "harness", "--tail=-1"]);
  const reading = readChartRefusal(outcomes, answersIn(log, input.marker));
  return {
    runId,
    measured: reading.measured,
    finished: FINISHED["chart-refusal"]!(last),
    ...(reading.void === undefined ? {} : { void: true }),
    note: `${reading.void ? `${reading.void}; ` : ""}${reading.note}, ended ${ended(last)}`,
  };
};

/** The cut-pick workflow's Menu (`cut-pick.ts`), and how jr2's re-admission prompt opens (actor.ts). */
const AUDIT_MENU = new Set(["run_audit", "file_report"]);
const READMITTED = "Your previous turn was cut";

/**
 * cut-pick (ADR-0031): once `run_audit` is outstanding, the step deletes the Instance Harness pod,
 * waits for the new one, and only then answers the auditor's Gate. jr2 re-admits the Agent on the
 * same conversation; the new pod's log begins at the restart, so the first re-admission prompt in it
 * is this trial's. The first Menu call after it is the measurement: `file_report` — not the cut
 * pick again. A Turn that had not picked when the step looked is void.
 */
const cutPick: Driver = async (world, input) => {
  const runId = await startRun(world, "cut-pick", input);
  const out = await waitFor(world, runId, (s) => (s.held ?? []).some((h) => h.pick === "run_audit"), 300_000);
  const gate = gateNamed(out.last, "auditor");
  if (!out.hit || !gate) {
    if (!settled(out.last)) await world.runCli(["send", runId, "--event", "CANCEL"]);
    return { runId, measured: false, finished: false, void: true, note: `never held: ${ended(out.last)}` };
  }
  await kubectl(world, ["delete", "pod", `${INSTANCE_HARNESS}-0`, "--wait=true"]);
  await kubectl(world, ["rollout", "status", `statefulset/${INSTANCE_HARNESS}`, "--timeout=300s"]);
  const r = await world.runCli([
    "send",
    runId,
    "--gate",
    gate.gate,
    "--event",
    "audited",
    "--input",
    JSON.stringify({ findings: "Two duplicate hotel claims of $412 each, and no receipt for a $96 taxi." }),
  ]);
  assert.equal(r.code, 0, `jr2 send audited failed: ${r.stderr}`);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const log = await kubectl(world, ["logs", `statefulset/${INSTANCE_HARNESS}`, "-c", "harness", "--tail=-1"]);
  const said = saidAfterPrompt(log, "advisor", READMITTED);
  if (said === undefined) {
    return {
      runId,
      measured: false,
      finished: FINISHED["cut-pick"]!(last),
      note: `no re-admission; ended ${ended(last)}`,
    };
  }
  const next = menuCalls(said, AUDIT_MENU)[0]?.call;
  return {
    runId,
    measured: next === "file_report",
    finished: FINISHED["cut-pick"]!(last),
    note: `after the re-admission said ${told(said)}; ended ${ended(last)}`,
  };
};

/**
 * answered (ADR-0067): `run_tests` runs the billing Repo's real suite, where one test fails, and
 * the pick's answer is its output.
 * The first pick the Machine took after `run_tests` is the measurement: `report_failure`. A Turn
 * that never ran the tests is void.
 */
const answered: Driver = async (world, input) => {
  const runId = await startRun(world, "answered", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const ledger = (last.context.output?.picks ?? []) as string[];
  const ran = ledger.indexOf("run_tests");
  return {
    runId,
    measured: ran !== -1 && ledger[ran + 1] === "report_failure",
    finished: FINISHED.answered!(last),
    ...(ran === -1 ? { void: true } : {}),
    note: `took ${ledger.join(" ")}; ended ${ended(last, last.context.output?.outcome)}`,
  };
};

/**
 * continue-after-signed-push (ADR-0067, ADR-0066): the coder publishes twice, signed. The setup is
 * a first push that published a signed copy (`pushed`, its published commit not its source) — the
 * answer that carries the paragraph after a signed push; without it the trial is void. The
 * measurement is the second push: `pushed`, because the Agent continued on its branch and left the
 * pushed commits as they were. When the setup holds and there is one push, the commits from `main`
 * to its published commit on push.git decide: two or more, and the model made both commits before
 * it read any post-push text, so the trial is void (`features/lib/model-continue.ts`); one, and a
 * trial that never published a second time is a miss.
 */
const continueAfterSignedPush: Driver = async (world, input) => {
  const runId = await startRun(world, "continue-after-signed-push", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const pushes = (last.context.output?.pushes ?? []) as PushRecord[];
  const carried = needsCarried(pushes) ? await pushRemoteCommitsFromMain(pushes[0]!.published!) : undefined;
  const reading = readContinue(pushes, carried);
  const seen = `pushes ${pushes.map((p) => p.outcome).join(" ") || "none"}; ended ${ended(last, last.context.output?.outcome)}`;
  return {
    runId,
    measured: reading.measured,
    finished: FINISHED["continue-after-signed-push"]!(last),
    ...(reading.void === undefined ? { note: seen } : { void: true, note: `${reading.void}; ${seen}` }),
  };
};

/** The allowed-after-route workflow's Menu (`allowed-after-route.ts`), and its Allowed picks after
 * the failing tests' route into `red`. */
const ROUTE_MENU = new Set(["run_tests", "ship", "open_issue"]);
const ALLOWED_IN_RED = new Set(["open_issue", "run_tests"]);

/**
 * allowed-after-route (ADR-0067, ADR-0029): the tests fail and the route moves the coder's state to
 * `red`, where `ship` is not allowed. The first Menu call after `run_tests`, off the printed
 * conversation — a refused `ship` never reaches the Machine — is the measurement: one of the
 * Allowed picks after the route. A Turn that never ran the tests is void.
 */
const allowedAfterRoute: Driver = async (world, input) => {
  const runId = await startRun(world, "allowed-after-route", input);
  const pod = await readySandbox(world, runId);
  if (!pod) return noReadySandbox(world, runId);
  const source = { follow: followLog(world, pod) };
  try {
    const { last } = await waitFor(world, runId, settled, TRIAL_MS);
    await Promise.race([source.follow.closed, sleep(10_000)]);
    const said = (await saidAfter(world, "coder", input.marker, source)) ?? [];
    const calls = menuCalls(said, ROUTE_MENU);
    const ran = calls.findIndex((c) => c.call === "run_tests");
    const next = ran === -1 ? undefined : calls[ran + 1]?.call;
    return {
      runId,
      measured: next !== undefined && ALLOWED_IN_RED.has(next),
      finished: FINISHED["allowed-after-route"]!(last),
      ...(ran === -1 ? { void: true } : {}),
      note: `ended ${ended(last, last.context.output?.outcome)}`,
    };
  } finally {
    source.follow.stop();
  }
};

/** The unknown-outcome workflow's Menu (`unknown-outcome.ts`). */
const DEPLOY_MENU = new Set(["deploy", "announce", "check_deploy"]);

/**
 * unknown-outcome (ADR-0067, ADR-0031): once `deploy` is outstanding, the step restarts the Sandbox's
 * Harness container — a second SIGTERM ends its drain at once — so the command dies with it, and jr2
 * settles the Effect `unknown`. The restart cut the coder's Turn, and jr2 re-admits it with the
 * answer; the restarted container's log begins at the restart. The container restarts in place, so
 * the reap when the run settles takes its log with the pod: the step follows that log from the
 * moment the restarted container runs. The first Menu call after the re-admission prompt is the
 * measurement: `check_deploy`. A Turn that had not picked `deploy` when the step looked, or whose
 * Harness the step did not see restart, is void.
 */
const unknownOutcome: Driver = async (world, input) => {
  const runId = await startRun(world, "unknown-outcome", input);
  const pod = await readySandbox(world, runId);
  if (!pod) return noReadySandbox(world, runId);
  const out = await waitFor(world, runId, (s) => (s.held ?? []).some((h) => h.pick === "deploy"), 300_000);
  if (!out.hit) {
    if (!settled(out.last)) await world.runCli(["send", runId, "--event", "CANCEL"]);
    return { runId, measured: false, finished: false, void: true, note: `never held: ${ended(out.last)}` };
  }
  const before = harnessRestarts(await podJson(world, pod)) ?? 0;
  await inHarness(world, pod, [
    RUNTIME_NODE,
    "-e",
    "process.kill(1, 'SIGTERM'); setTimeout(() => process.kill(1, 'SIGTERM'), 200)",
  ]).catch(() => ({ code: -1, out: "" }));
  if (!(await harnessRestarted(world, pod, before))) {
    const { last } = await waitFor(world, runId, settled, TRIAL_MS);
    return { runId, measured: false, finished: false, void: true, note: `no Harness restart; ended ${ended(last)}` };
  }
  const source = { follow: followLog(world, pod) };
  try {
    const { last } = await waitFor(world, runId, settled, TRIAL_MS);
    await Promise.race([source.follow.closed, sleep(10_000)]);
    const said = saidAfterPrompt(source.follow.text, "coder", READMITTED);
    if (said === undefined) {
      return {
        runId,
        measured: false,
        finished: FINISHED["unknown-outcome"]!(last),
        note: `no re-admission; ended ${ended(last, last.context.output?.outcome)}`,
      };
    }
    const next = menuCalls(said, DEPLOY_MENU)[0]?.call;
    return {
      runId,
      measured: next === "check_deploy",
      finished: FINISHED["unknown-outcome"]!(last),
      note: `after the re-admission said ${told(said)}; ended ${ended(last, last.context.output?.outcome)}`,
    };
  } finally {
    source.follow.stop();
  }
};

/** A pod as `kubectl get` has it; `{}` once it is gone. */
async function podJson(world: E2EWorld, pod: string): Promise<PodLike> {
  return JSON.parse(
    await kubectl(world, ["get", `pod/${pod}`, "-o", "json"], POD_READ_MS).catch(() => "{}"),
  ) as PodLike;
}

/** Wait until the pod's Harness container restarted past `before` and runs again; false when it
 * did not within two minutes. */
async function harnessRestarted(world: E2EWorld, pod: string, before: number): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (restartedHarnessRunning(await podJson(world, pod), before)) return true;
    await sleep(1000);
  }
  return false;
}

const DRIVERS: Record<string, Driver> = {
  obedience,
  advised,
  workdir,
  noticed,
  "mode-follow": modeFollow,
  "mode-refusal": modeRefusal,
  "mode-stop": modeStop,
  wake,
  "push-follow": pushFollow,
  "chain-answer": chainAnswer,
  "cut-pick": cutPick,
  answered,
  "continue-after-signed-push": continueAfterSignedPush,
  "allowed-after-route": allowedAfterRoute,
  "unknown-outcome": unknownOutcome,
  "chart-refusal": chartRefusal,
};

/** The Menu-only claims read one shared pod log, so their trials run one at a time. */
const SERIAL = new Set([
  "obedience",
  "advised",
  "mode-follow",
  "mode-refusal",
  "mode-stop",
  "wake",
  "chain-answer",
  "cut-pick",
  "chart-refusal",
]);

/** The claims whose trials push to the seed's push remote: their evidence logs what it holds. */
const PUSHES = new Set(["continue-after-signed-push"]);

/** What a trial's evidence is read with, bound to the scenario's namespace. */
function evidenceContext(world: E2EWorld, workflow: string, thinking: string, marker: string): TrialContext {
  assert.ok(world.namespace, "a @model scenario has its namespace set in setupModel");
  const model = modelKey(world);
  return {
    marker,
    sandbox: !SERIAL.has(workflow),
    push: PUSHES.has(workflow),
    since: new Date().toISOString(),
    dirFor: (runId) => trialDir(TRIALS, model, `${workflow}/${thinking}`, runId),
    probes: {
      namespace: world.namespace,
      kubectl: (args) => kubectl(world, args),
      auth: (placement) => harnessAuth(world, placement),
      pushLog: pushRemoteLogFromMain,
    },
  };
}

/**
 * Run `n` trials with at most `parallel` in flight. Every trial gets its own marker, and every
 * trial, pass or not, keeps its evidence (ADR-0066): its note opens with what the model called,
 * read off the conversation kept for it.
 */
async function runTrials(
  world: E2EWorld,
  workflow: string,
  driver: Driver,
  n: number,
  parallel: number,
  thinking: string,
) {
  const results: Trial[] = [];
  let next = 0;
  // A void trial is replaced, at most this many times over the whole claim: the claim measures a
  // later Turn, and a setup that never happened says nothing about it.
  let replacements = Math.ceil(n / 2);
  console.log(`trial evidence: ${cellDir(TRIALS, modelKey(world), `${workflow}/${thinking}`)}`);
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const marker = `t${i}-${randomBytes(3).toString("hex")}`;
      const ctx = evidenceContext(world, workflow, thinking, marker);
      let trial: Trial;
      try {
        trial = await trialContext.run(ctx, () => driver(world, { thinking, marker }));
      } catch (err) {
        const run = ctx.evidence ? ` (run ${ctx.evidence.runId})` : "";
        trial = { runId: "?", measured: false, finished: false, note: `threw: ${(err as Error).message}${run}` };
      }
      // A trial can end with its run still live: a driver that threw, a run that never parked, a
      // void. Such a run is cancelled, so no Sandbox stays parked into the next trial. The kept
      // record is the last status read, so this read makes it the run as the trial left it.
      if (ctx.evidence) await leave(world, ctx.evidence.runId).catch(() => undefined);
      // The note opens with what the model called; the driver's note, which says how the run ended, follows.
      if (ctx.evidence) trial = { ...trial, note: [await ctx.evidence.finish(), trial.note].join("; ") };
      if (trial.void && replacements > 0) {
        replacements--;
        next--; // run another in its place
        console.log(`trial ${trial.runId} void (${trial.note}); replaced`);
        continue;
      }
      results.push(trial);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, n)) }, worker));
  return results;
}

/** Read the run's status, cancel the run when it has not settled, and read its status until it
 * settles (30 s at most). A run that has settled gets no CANCEL. */
async function leave(world: E2EWorld, runId: string): Promise<void> {
  if (!settled(await status(world, runId))) await world.runCli(["send", runId, "--event", "CANCEL"]);
  await waitFor(world, runId, settled, 30_000);
}

/** The scenario's claim in flight, kept on the World between its steps. */
const claims = new WeakMap<E2EWorld, Claim>();

function claimOf(world: E2EWorld): Claim {
  const claim = claims.get(world);
  assert.ok(claim, "a claim was run in a prior step");
  return claim;
}

/** Compare a count with the floor, naming every trial that fell short. Every trial's note is
 * printed first, whatever the count: a baseline is taken from a run that was read (ADR-0066), and a
 * miss at or above the floor is read too. A void trial kept past the bound of replacements counts
 * against the floor, and prints as a void, never as a miss. */
function atLeast(claim: Claim, floor: number, what: string, of: (t: Trial) => boolean, cell = claim.cell): void {
  claim.floors[cell] = floor;
  const verdict = (t: Trial) => (of(t) ? "pass" : t.void ? "void, past the bound of replacements" : "miss");
  for (const t of claim.trials) console.log(`trial ${t.runId} ${cell} ${verdict(t)}: ${t.note}`);
  const passed = claim.trials.filter(of).length;
  const failed = claim.trials.filter((t) => !of(t)).map((t) => `  ${t.runId} (${verdict(t)}): ${t.note}`);
  assert.ok(
    passed >= floor,
    `${what} in ${passed} of ${claim.trials.length} trials, below the floor of ${floor} (${cell}):\n${failed.join("\n")}`,
  );
}

/** What a cell counts: the primary claim's measure, or a second claim measured on the same trials. */
function measureOf(claim: Claim, cell: string): (t: Trial) => boolean {
  if (cell === claim.cell) return (t) => t.measured;
  const name = cell.slice(0, cell.indexOf("/"));
  return (t) => t.also?.[name] === true;
}

// --- scorecard ------------------------------------------------------------------------------------------

type Cell = { passed: number; trials: number; floor?: number; at: string };
type Scorecard = Record<string, Record<string, Cell>>;

/** The model's key in the scorecard and its baseline file name: `<id>--<model>`, `/` spelled `--`. */
function modelKey(world: E2EWorld): string {
  const p = world.modelProfile;
  assert.ok(p, "the endpoint profile was read in setupModel");
  return `${p.id}--${p.model.replaceAll("/", "--")}`;
}

/** Record one cell; fail nothing here — the floor was judged by the step before. Drift below a
 * committed baseline is REPORTED on the step's output (ADR-0066). */
async function recordCell(world: E2EWorld, cell: string, passed: number, trials: number, floor?: number) {
  const key = modelKey(world);
  await mkdir(fileURLToPath(new URL("../.tmp/", import.meta.url)), { recursive: true });
  const card: Scorecard = JSON.parse(await readFile(SCORECARD, "utf8").catch(() => "{}")) as Scorecard;
  (card[key] ??= {})[cell] = {
    passed,
    trials,
    ...(floor === undefined ? {} : { floor }),
    at: new Date().toISOString(),
  };
  await writeFile(SCORECARD, `${JSON.stringify(card, null, 2)}\n`);
  const baseline = JSON.parse(await readFile(`${BASELINES}${key}.json`, "utf8").catch(() => "null")) as Record<
    string,
    { passed: number; trials: number }
  > | null;
  const base = baseline?.[cell];
  let line = `${key} ${cell}: ${passed}/${trials}`;
  if (base) {
    const drift = passed / trials - base.passed / base.trials;
    line += drift < 0 ? ` — BELOW baseline ${base.passed}/${base.trials}` : ` (baseline ${base.passed}/${base.trials})`;
  } else line += " (no baseline)";
  console.log(`scorecard: ${line}`);
}

// --- given ------------------------------------------------------------------------------------------------

Given("the model instance is serving", { timeout: 900_000 }, async function (this: E2EWorld): Promise<void> {
  await ensureSeed();
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `jr2 up failed: ${r.stderr}`);
});

// --- claims -----------------------------------------------------------------------------------------------

When(
  "I run the {string} workflow {int} times with thinking {word}",
  { timeout: 7_200_000 },
  async function (this: E2EWorld, workflow: string, n: number, thinking: string): Promise<void> {
    const driver = DRIVERS[workflow];
    assert.ok(driver, `no trial driver for workflow "${workflow}" (have: ${Object.keys(DRIVERS).join(", ")})`);
    const parallel = SERIAL.has(workflow) ? 1 : (this.modelProfile?.parallel ?? 2);
    const trials = await runTrials(this, workflow, driver, n, parallel, thinking);
    claims.set(this, { workflow, cell: `${workflow}/${thinking}`, thinking, trials, floors: {} });
  },
);

Then("the first pick was allowed in at least {int} trials", function (this: E2EWorld, floor: number): void {
  atLeast(claimOf(this), floor, "the first pick was allowed", (t) => t.measured);
});

Then(
  "every file the Agent wrote lies under the Worktree in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "every file lay under the Worktree", (t) => t.measured);
  },
);

Then("the Turn's first call was its pick in at least {int} trials", function (this: E2EWorld, floor: number): void {
  atLeast(claimOf(this), floor, "the first call was the pick", (t) => t.measured);
});

Then(
  "the first pick after the checks answered was the one their last result called for in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the pick after the answer followed its last link", (t) => t.measured);
  },
);

Then(
  "the pick after the door's refusal admitted in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the pick after the refusal admitted", (t) => t.measured);
  },
);

Then(
  "the first pick after the re-admission was not the cut pick in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the first pick after the re-admission used the answer", (t) => t.measured);
  },
);

Then(
  "the first pick after the command answered was the one its output called for in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the pick after the command's answer followed its output", (t) => t.measured);
  },
);

Then(
  "the push after a signed push was published in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the next push after a signed push published", (t) => t.measured);
  },
);

Then(
  "the first call after the command answered was allowed after its route in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(
      claimOf(this),
      floor,
      "the call after the answer was one of the Allowed picks after the route",
      (t) => t.measured,
    );
  },
);

Then(
  "the first pick after an unknown outcome checked before it announced in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the pick after an unknown outcome was the check", (t) => t.measured);
  },
);

Then(
  "the second Turn reported truthfully whether its server survived in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the report matched the pod", (t) => t.measured);
  },
);

Then(
  "the first pick after the mode changed was allowed in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the first pick after the mode changed was allowed", (t) => t.measured);
  },
);

Then(
  "the call after the correction receipt was allowed in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the call after the correction receipt was allowed", (t) => t.measured);
  },
);

Then("the first pick after the nudge was allowed in at least {int} trials", function (this: E2EWorld, floor: number) {
  atLeast(claimOf(this), floor, "the first pick after the nudge was allowed", (t) => t.measured);
});

Then(
  "the first pick after the Gate's answer was allowed in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the first pick after the Gate's answer was allowed", (t) => t.measured);
  },
);

Then("no stale pick followed the restatement in at least {int} trials", function (this: E2EWorld, floor: number): void {
  const claim = claimOf(this);
  const cell = `push-no-refusal/${claim.thinking}`;
  atLeast(claim, floor, "no stale pick followed the restatement", measureOf(claim, cell), cell);
});

Then(
  "the first Menu call after the wake was an allowed pick in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the first Menu call after the wake was an allowed pick", (t) => t.measured);
  },
);

Then("no Sandbox was provisioned in any trial", async function (this: E2EWorld): Promise<void> {
  for (const t of claimOf(this).trials) {
    if (t.runId === "?") continue;
    assert.deepEqual(await sandboxesFor(this, t.runId), [], `run ${t.runId} composed a Sandbox (ADR-0031)`);
  }
});

Then("every trial finished", function (this: E2EWorld): void {
  const claim = claimOf(this);
  const unfinished = claim.trials.filter((t) => !t.finished).map((t) => `  ${t.runId}: ${t.note}`);
  assert.equal(unfinished.length, 0, `trials that did not finish (${claim.cell}):\n${unfinished.join("\n")}`);
});

Then("the cell {string} is written to the scorecard", async function (this: E2EWorld, cell: string): Promise<void> {
  const claim = claims.get(this);
  if (claim) {
    const second = cell.endsWith(`/${claim.thinking}`) && claim.trials.some((t) => t.also !== undefined);
    assert.ok(cell === claim.cell || second, `the scenario names a cell it ran (${claim.cell})`);
    const measure = measureOf(claim, cell);
    await recordCell(this, cell, claim.trials.filter(measure).length, claim.trials.length, claim.floors[cell]);
    return;
  }
  // The run: one trial, measured by the steps before this one reaching here.
  await recordCell(this, cell, 1, 1, 1);
});

// --- the run ------------------------------------------------------------------------------------------------

When(
  "I start the {string} workflow with thinking {word} detached",
  async function (this: E2EWorld, workflow: string, thinking: string): Promise<void> {
    this.runId = await startRun(this, workflow, { thinking });
  },
);

/** The run's whole path to its Gate, bounded in time: three seats, a bounded reject loop. */
Then("the run parks at the {string} Gate", { timeout: 3_600_000 }, async function (this: E2EWorld, state: string) {
  assert.ok(this.runId, "a runId was carried from a prior step");
  const { hit, last } = await waitFor(this, this.runId, parked, 3_000_000);
  assert.ok(hit, `the run never parked (ended ${ended(last, last.context.output?.outcome)})`);
  const gate = last.gates![0]!;
  assert.match(gate.gate, new RegExp(`${state}$`), `the Gate id derives from the state key (got ${gate.gate})`);
});

Then(
  "the pick ledger runs {string} first and ends {string} then {string}",
  async function (this: E2EWorld, first: string, beforeLast: string, last: string): Promise<void> {
    const s = await status(this, this.runId!);
    const picks = (s.gates?.[0]?.meta?.picks ?? []) as string[];
    assert.ok(picks.length >= 3, `the ledger holds the run's picks (got ${JSON.stringify(picks)})`);
    assert.equal(picks[0], first, `the ledger opens with ${first}: ${JSON.stringify(picks)}`);
    assert.equal(picks[picks.length - 1], last, `the ledger ends with ${last}: ${JSON.stringify(picks)}`);
    assert.equal(picks[picks.length - 2], beforeLast, `${last} follows ${beforeLast}: ${JSON.stringify(picks)}`);
  },
);

/** One Turn across every mode (ADR-0015, ADR-0024): the coder's state was entered once, so its
 * invoke never restarted — what the model did inside the Turn is its own. */
Then("the coder's state was entered once", async function (this: E2EWorld): Promise<void> {
  const s = await status(this, this.runId!);
  const entries = s.gates?.[0]?.meta?.entries;
  assert.equal(entries, 1, `the coder's state was entered ${String(entries)} times`);
});

/**
 * The witness, in the pod (ADR-0012: parking is retention): the branch is ahead of `main`, its
 * head is the commit the coder named, the tree is clean, and the project's test passes when THIS
 * step runs it — with the image's own node, in the Worktree the Gate names.
 */
Then(
  "the branch in the pod is ahead of main, at the named commit, and its test passes",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = await status(this, this.runId!);
    const meta = s.gates?.[0]?.meta ?? {};
    const worktree = String(meta.worktree ?? "");
    const commit = String(meta.commit ?? "");
    assert.ok(worktree && commit, `the Gate names the worktree and the commit (got ${JSON.stringify(meta)})`);
    const pod = await readySandbox(this, this.runId!, 10_000);
    assert.ok(pod, "a parked run keeps its Sandbox (ADR-0012)");
    const git = (...args: string[]) => inHarness(this, pod, ["git", "-C", worktree, ...args]);
    const ahead = Number((await git("rev-list", "--count", "main..HEAD")).out.trim());
    assert.ok(ahead > 0, "the branch is ahead of main");
    const head = (await git("rev-parse", "HEAD")).out.trim();
    assert.ok(head.startsWith(commit), `HEAD ${head} is the commit the coder named (${commit})`);
    const dirty = (await git("status", "--porcelain")).out.trim();
    assert.equal(dirty, "", `the worktree is clean at the named commit:\n${dirty}`);
    const test = await inHarness(this, pod, ["sh", "-c", `cd ${JSON.stringify(worktree)} && node --test 2>&1`]);
    assert.equal(test.code, 0, `node --test passes at ${head}:\n${test.out}`);
  },
);
