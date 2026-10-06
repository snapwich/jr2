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
import { harnessToken } from "@jr2/orchestrator";
import {
  askAfter,
  follow,
  isNudge,
  isRestatement,
  menuCalls,
  modeAtAsk,
  modesOf,
  saidAfterPrompt,
  saidIn,
  told,
  type Follow,
  type Said,
  type StateNodeLike,
} from "../lib/model-said.ts";
import { ensureSeed } from "./seed.ts";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** The runtime's node inside every Harness container (ADR-0037) — the probe's interpreter. */
const RUNTIME_NODE = "/opt/jr2/bin/node";
/** The Instance Harness StatefulSet `jr2 up` converges for the Menu-only definitions (ADR-0031). */
const INSTANCE_HARNESS = "jr2-instance-harness";

/** Where the run's scorecard goes, and where committed baselines live (ADR-0066). */
const SCORECARD = fileURLToPath(new URL("../.tmp/model-scorecard.json", import.meta.url));
const BASELINES = fileURLToPath(new URL("../model-baselines/", import.meta.url));

// --- one run, observed ----------------------------------------------------------------------------

/** One live child machine under the run, as `jr2 status` reports it. */
type RunChild = { id: string; value: unknown; children: RunChild[] };
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
};

type SandboxCR = { metadata: { name: string }; status?: { phase?: string } };

async function kubectl(world: E2EWorld, args: string[]): Promise<string> {
  assert.ok(world.namespace, "a @model scenario has its namespace set in setupModel");
  const { stdout } = await exec("kubectl", ["--namespace", world.namespace, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Run a command in the run's Harness container; resolves with stdout, or the exit code when
 * the command failed — a probe's "no" is an answer, not an error. */
async function inHarness(world: E2EWorld, pod: string, cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const out = await kubectl(world, ["exec", `pod/${pod}`, "-c", "harness", "--", ...cmd]);
    return { code: 0, out };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: e.stdout ?? "" };
  }
}

async function status(world: E2EWorld, runId: string): Promise<Status> {
  const r = await world.runCli(["status", runId]);
  assert.equal(r.code, 0, `jr2 status ${runId} failed: ${r.stderr}`);
  return world.resultJson<Status>();
}

async function startRun(world: E2EWorld, workflow: string, input: Record<string, unknown>): Promise<string> {
  const r = await world.runCli(["run", workflow, "--detach", "--input", JSON.stringify(input)]);
  assert.equal(r.code, 0, `jr2 run ${workflow} failed: ${r.stderr}`);
  return world.resultJson<{ runId: string }>().runId;
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

async function sendToGate(world: E2EWorld, runId: string, gate: string, event: string): Promise<void> {
  const r = await world.runCli(["send", runId, "--gate", gate, "--event", event]);
  assert.equal(r.code, 0, `jr2 send ${event} failed: ${r.stderr}`);
}

/** The Harness bearer for one placement (ADR-0058), derived the Orchestrator's way. */
async function harnessAuth(world: E2EWorld, placement: string): Promise<Record<string, string>> {
  const key = (
    await kubectl(world, ["get", "secret", "jr2-instance", "-o", "jsonpath={.data.JR2_SIGNING_KEY}"])
  ).trim();
  assert.ok(key, "the instance Secret carries the signing key `jr2 up` minted");
  const signingKey = Buffer.from(Buffer.from(key, "base64").toString("utf8"), "base64");
  return { authorization: `Bearer ${harnessToken(signingKey, placement)}` };
}

/** How many of the conversation's Submissions have settled at the run's Sandbox — 0 while the
 * first Turn runs, which is when a memory kill lands on its stream (ADR-0061). `undefined` while
 * the Harness holds no such conversation yet. */
async function settledTurns(world: E2EWorld, pod: string, agent: string, iid: string): Promise<number | undefined> {
  assert.ok(world.namespace);
  const headers = await harnessAuth(world, pod);
  const child = spawn("kubectl", ["--namespace", world.namespace, "port-forward", `pod/${pod}`, ":8080"]);
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
    const res = await fetch(`http://127.0.0.1:${local}/agents/${agent}/${encodeURIComponent(iid)}?view=history`, {
      headers,
    });
    if (res.status === 404) {
      await res.text();
      return undefined;
    }
    assert.equal(res.status, 200, "the Harness serves the conversation history");
    return ((await res.json()) as { settlements?: unknown[] }).settlements?.length ?? 0;
  } finally {
    child.kill();
  }
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

/** What each claim workflow's body means by "finished" — the final state (a root Machine's
 * `value`) or the wrapper-forwarded outcome (a `workspace()` body's). */
const FINISHED: Record<string, (s: Status) => boolean> = {
  obedience: (s) => s.status === "done" && s.value === "held",
  advised: (s) => s.status === "done" && s.value === "answered",
  workdir: (s) => s.status === "done" && s.context.output?.outcome === "finished",
  noticed: (s) => s.status === "done" && s.context.output?.outcome === "finished",
  "mode-follow": (s) => s.status === "done" && s.value === "submitted",
  "mode-refusal": (s) => s.status === "done" && s.value === "published",
  "mode-stop": (s) => s.status === "done" && s.value === "submitted",
  "push-wake": (s) => s.status === "done" && (s.value === "released" || s.value === "held"),
  "push-follow": (s) => s.status === "done" && s.context.output?.outcome === "submitted",
  "chain-answer": (s) => s.status === "done" && (s.value === "held" || s.value === "released"),
  "refused-outstanding": (s) => s.status === "done" && s.value === "invited",
  "cut-pick": (s) => s.status === "done" && s.value === "filed",
};

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
    note: `first call ${first ?? "none"}, ended ${last.status}/${String(last.value)}`,
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
    note: `first call ${first ?? "none"}, ${sandboxes} Sandbox(es), ended ${last.status}/${String(last.value)}`,
  };
};

/** workdir (ADR-0057/0062): every copy of the marker file in the pod is under the Worktree. */
const workdir: Driver = async (world, input) => {
  const runId = await startRun(world, "workdir", input);
  const { hit, last } = await waitFor(world, runId, parked, TRIAL_MS);
  if (!hit) return { runId, measured: false, finished: false, note: `never parked: ${last.status}` };
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
    note: `wrote ${JSON.stringify(found)} (worktree ${worktree}; said ${String(gate.meta?.path)})`,
  };
};

/** Does anything answer on the pod's loopback at `port`? Asked with the runtime's node. */
async function portAnswers(world: E2EWorld, pod: string, port: number): Promise<boolean> {
  const probe = `fetch("http://127.0.0.1:${port}/").then(()=>process.exit(0),()=>process.exit(1))`;
  return (await inHarness(world, pod, [RUNTIME_NODE, "-e", probe])).code === 0;
}

/**
 * noticed (ADR-0061/0062): the report about the server matches what the pod says. The kill is
 * the step's: once the first Turn's server answers, a memory hog exec'd into the Harness
 * container trips the guard, which kills every Agent process — the hog and the server both —
 * and puts the kill on the running Turn's stream, which is what the next Turn's notice is made
 * of. A hog that lands after the first Turn ended reaches no Turn, so the window is checked.
 */
const noticed: Driver = async (world, input) => {
  const runId = await startRun(world, "noticed", { thinking: input.thinking });
  const pod = await readySandbox(world, runId);
  if (!pod) return { runId, measured: false, finished: false, note: "no Ready Sandbox" };
  const iid = `${runId}/body/coder`;
  // Wait for the server, while the first Turn still runs.
  // Three minutes is generous for one command and a curl; a Turn that has not brought the server
  // up by then is stuck (a bash call holding its pipe open, in the first run), and waiting on the
  // Turn's own timeout costs the claim more than replacing the trial.
  const deadline = Date.now() + 180_000;
  let up = false;
  let why = "timed out waiting";
  while (Date.now() < deadline) {
    if (await portAnswers(world, pod, 8765)) {
      up = true;
      break;
    }
    const turns = await settledTurns(world, pod, "coder", iid);
    if (turns !== undefined && turns > 0) {
      why = "the Turn ended first";
      break;
    }
    await sleep(3000);
  }
  if (!up) {
    // The setup the claim needs did not happen — a server that outlives its bash call is the
    // model's job, not the claim's — so this trial measures nothing (`void`).
    const s = await status(world, runId);
    if (!settled(s)) await world.runCli(["send", runId, "--event", "CANCEL"]);
    return { runId, measured: false, finished: false, void: true, note: `no server answered: ${why}` };
  }
  const hog = `const a=[];setInterval(()=>{for(let i=0;i<4;i++)a.push(Buffer.alloc(64<<20,1))},10)`;
  await inHarness(world, pod, [RUNTIME_NODE, "-e", hog]); // returns when the guard kills it
  const killed = !(await portAnswers(world, pod, 8765));
  const { hit, last } = await waitFor(world, runId, parked, TRIAL_MS);
  if (!hit) return { runId, measured: false, finished: false, note: `never parked: ${last.status}` };
  const gate = last.gates![0]!;
  const reported = gate.meta?.running;
  const actual = await portAnswers(world, pod, 8765);
  await sendToGate(world, runId, gate.gate, "done");
  const end = (await waitFor(world, runId, settled, 120_000)).last;
  // A "not running" is the notice read (the server WAS killed — `killed` says so — whatever the
  // model did about it afterwards); a "running" is honest only when the pod agrees.
  return {
    runId,
    measured: killed && (reported === false || actual),
    finished: FINISHED.noticed!(end),
    note: `killed ${killed}; reported running=${String(reported)}, actually ${actual} (${String(gate.meta?.how)})`,
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
    note: `said ${told(said)}; ended ${last.status}/${String(last.value)}`,
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
    note: `said ${told(said)}; took ${ledger.join(" ")}; ended ${last.status}/${String(last.value)}`,
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
    note: `said ${told(said)}; asked in ${asked === -1 ? "none" : mode}; ended ${last.status}/${String(last.value)}`,
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

/** The push-wake workflow's Menu (`push-wake.ts`). */
const WAKE_MENU = new Set(["release", "hold"]);

/**
 * push-wake (ADR-0029's step-boundary check): the Turn starts with nothing allowed. The step answers
 * the release board once the Turn's first step has ended with a Menu call (refused: nothing is
 * allowed yet), so the change lands after that step and a later step boundary must carry it: the
 * read finds picks and restates the Turn part, and the model picks in the same Submission — the
 * first Menu call after the restatement is `release` or `hold`, with no ask before it. A first step
 * with no Menu call ended the Submission with nothing allowed: the step answers anyway, the wake
 * asks the model in a second Submission (ADR-0016), and the trial never reached the moment the
 * claim measures (`void`).
 */
const pushWake: Driver = async (world, input) => {
  const runId = await startRun(world, "push-wake", input);
  const opened = await waitFor(world, runId, (s) => gateNamed(s, "board") !== undefined, 120_000);
  const board = gateNamed(opened.last, "board");
  if (!board) return { runId, measured: false, finished: false, note: `no board Gate: ${opened.last.status}` };
  const shown = await saidUntil(world, "advisor", input.marker, () => true, 120_000);
  if (!shown.hit) {
    await world.runCli(["send", runId, "--event", "CANCEL"]);
    return { runId, measured: false, finished: false, note: "the Turn's prompt never printed" };
  }
  // The first step has ended once its Menu call printed: a call prints when its message ends.
  await saidUntil(
    world,
    "advisor",
    input.marker,
    (said) => menuCalls(said, WAKE_MENU).length > 0,
    120_000,
    INSTANCE_LOG,
    200,
  );
  await sendToGate(world, runId, board.gate, "cleared");
  const { hit, last } = await waitFor(world, runId, settled, 300_000);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const restated = said.findIndex(isRestatement);
  if (restated === -1) {
    if (!hit) await world.runCli(["send", runId, "--event", "CANCEL"]);
    return { runId, measured: false, finished: false, void: true, note: `no restatement: ${told(said)}` };
  }
  const first = menuCalls(said, WAKE_MENU, restated)[0];
  const askedFirst = said.slice(0, first?.at ?? said.length).some(isNudge);
  return {
    runId,
    measured: first !== undefined && !askedFirst,
    finished: FINISHED["push-wake"]!(last),
    note: `said ${told(said)}; ended ${last.status}/${String(last.value)}`,
  };
};

/** The push-follow workflow's Menu, and the ledger's mark for the Gate's answer (`push-follow.ts`). */
const PUSH_MENU = new Set(["ask_approval", "run_tests", "revise", "submit"]);
const PUSH_NEW = new Set(["revise", "submit"]);
const APPROVED = "(approved)";

/**
 * push-follow and push-no-refusal (ADR-0029's step-boundary check): the step answers the desk while
 * the coder's `sleep 20` runs. push-follow: the first pick the Machine took after the answer is
 * `revise` or `submit`. push-no-refusal: the first Menu call after the restated Turn part is one of
 * them too — no stale pick, refused, before it. A coder that picked before the answer, or never ran
 * the command, never reached the moment the claim measures (`void`).
 */
const pushFollow: Driver = async (world, input) => {
  const runId = await startRun(world, "push-follow", input);
  const pod = await readySandbox(world, runId);
  if (!pod) return { runId, measured: false, finished: false, note: "no Ready Sandbox" };
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
      note: `no command in flight: ${told(sleeping.said)}`,
    };
  }
  await sendToGate(world, runId, desk.gate, "approve");
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  // The reap at settle ends the stream; what it held by then is the whole conversation.
  await Promise.race([source.follow.closed, sleep(10_000)]);
  const said = (await saidAfter(world, "coder", input.marker, source)) ?? [];
  const ledger = (last.context.output?.picks ?? []) as string[];
  const approved = ledger.indexOf(APPROVED);
  if (approved !== 0) {
    return {
      runId,
      measured: false,
      finished: false,
      void: true,
      note: `took ${ledger.join(" ")} — not after the answer`,
    };
  }
  const followed = PUSH_NEW.has(ledger[approved + 1] ?? "");
  const restated = said.findIndex(isRestatement);
  const firstAfter = restated === -1 ? undefined : menuCalls(said, PUSH_MENU, restated)[0]?.call;
  return {
    runId,
    measured: followed,
    finished: FINISHED["push-follow"]!(last),
    also: { "push-no-refusal": firstAfter !== undefined && PUSH_NEW.has(firstAfter) },
    note: `said ${told(said)}; took ${ledger.join(" ")}; ended ${last.status}/${String(last.context.output?.outcome)}`,
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
    note: `said ${told(said)}; ended ${last.status}/${String(last.value)}`,
  };
};

/** The refused-outstanding workflow's Menu (`refused-outstanding.ts`). */
const BOOK_MENU = new Set(["book_room", "send_invite"]);

/**
 * refused-outstanding (ADR-0024): a `send_invite` made while `book_room` was outstanding was refused
 * before it left — it never reached the Machine — and the call after it, once the booking answered,
 * is `send_invite` again, taken. The printed conversation shows every call; the ledger only what the
 * Machine took, so a `send_invite` printed and not taken was the refused one. A model that called
 * them one after the other was never refused (`void`), and so was one that tried `send_invite`
 * before `book_room` (a correction receipt, another claim).
 */
const refusedOutstanding: Driver = async (world, input) => {
  const runId = await startRun(world, "refused-outstanding", input);
  const { last } = await waitFor(world, runId, settled, TRIAL_MS);
  const said = (await saidAfter(world, "advisor", input.marker)) ?? [];
  const calls = menuCalls(said, BOOK_MENU);
  const ledger = ((last.context as { picks?: string[] }).picks ?? []) as string[];
  const booked = calls.findIndex((c) => c.call === "book_room");
  const invites = calls.filter((c) => c.call === "send_invite");
  const taken = ledger.includes("send_invite");
  const first = calls.findIndex((c) => c.call === "send_invite");
  const setup = booked !== -1 && first > booked && (invites.length >= 2 || !taken);
  return {
    runId,
    measured: setup && calls[first + 1]?.call === "send_invite" && taken,
    finished: FINISHED["refused-outstanding"]!(last),
    ...(setup ? {} : { void: true }),
    note: `said ${told(said)}; took ${ledger.join(" ")}; ended ${last.status}/${String(last.value)}`,
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
    return { runId, measured: false, finished: false, void: true, note: `never held: ${out.last.status}` };
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
      note: `no re-admission; ended ${last.status}`,
    };
  }
  const next = menuCalls(said, AUDIT_MENU)[0]?.call;
  return {
    runId,
    measured: next === "file_report",
    finished: FINISHED["cut-pick"]!(last),
    note: `after the re-admission said ${told(said)}; ended ${last.status}/${String(last.value)}`,
  };
};

const DRIVERS: Record<string, Driver> = {
  obedience,
  advised,
  workdir,
  noticed,
  "mode-follow": modeFollow,
  "mode-refusal": modeRefusal,
  "mode-stop": modeStop,
  "push-wake": pushWake,
  "push-follow": pushFollow,
  "chain-answer": chainAnswer,
  "refused-outstanding": refusedOutstanding,
  "cut-pick": cutPick,
};

/** The Menu-only claims read one shared pod log, so their trials run one at a time. */
const SERIAL = new Set([
  "obedience",
  "advised",
  "mode-follow",
  "mode-refusal",
  "mode-stop",
  "push-wake",
  "chain-answer",
  "refused-outstanding",
  "cut-pick",
]);

/** Run `n` trials with at most `parallel` in flight. Every trial gets its own marker. */
async function runTrials(world: E2EWorld, driver: Driver, n: number, parallel: number, thinking: string) {
  const results: Trial[] = [];
  let next = 0;
  // A void trial is replaced, at most this many times over the whole claim: the claim measures a
  // later Turn, and a setup that never happened says nothing about it.
  let replacements = Math.ceil(n / 2);
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const marker = `t${i}-${randomBytes(3).toString("hex")}`;
      let trial: Trial;
      try {
        trial = await driver(world, { thinking, marker });
      } catch (err) {
        trial = { runId: "?", measured: false, finished: false, note: `threw: ${(err as Error).message}` };
      }
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

/** The scenario's claim in flight, kept on the World between its steps. */
const claims = new WeakMap<E2EWorld, Claim>();

function claimOf(world: E2EWorld): Claim {
  const claim = claims.get(world);
  assert.ok(claim, "a claim was run in a prior step");
  return claim;
}

/** Compare a count with the floor, naming every trial that fell short. */
function atLeast(claim: Claim, floor: number, what: string, of: (t: Trial) => boolean, cell = claim.cell): void {
  claim.floors[cell] = floor;
  const passed = claim.trials.filter(of).length;
  const failed = claim.trials.filter((t) => !of(t)).map((t) => `  ${t.runId}: ${t.note}`);
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
    const trials = await runTrials(this, driver, n, parallel, thinking);
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
  "the pick refused while another was outstanding was picked again, and taken, in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the refused pick was picked again after the answer", (t) => t.measured);
  },
);

Then(
  "the first pick after the re-admission was not the cut pick in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the first pick after the re-admission used the answer", (t) => t.measured);
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
  "the Agent picked inside the same Submission in at least {int} trials",
  function (this: E2EWorld, floor: number): void {
    atLeast(claimOf(this), floor, "the Agent picked inside the same Submission", (t) => t.measured);
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
  assert.ok(hit, `the run never parked (ended ${last.status}, ${JSON.stringify(last.context.output ?? last.value)})`);
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
