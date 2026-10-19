// Steps for ADR-0070 in the default tier: a Chart runs under the Chart wrapper that lends it its
// parts. No cluster: the Chart's Agents, lent and minted, admit against the stub Harness, and the
// steps play each Agent's Menu over `/agents/<iid>/*` as mechanics.steps.ts does.
//
// A Chart's Agent is invoked by the Machine compiled from the Chart, below the Open body, so its
// conversation id is not the root's `<runId>/root/coder`. The steps read it where the stub Harness
// wrote it down: the admission of the Turn, which names the Agent and the iid (ADR-0057).
//
// The routes a client of named Charts uses (`PUT`, `DELETE`, `GET /workflows`) have no verb in
// this step (ADR-0070), so the steps send them as an MCP or curl would, with the Instance token.
// Everything else goes through the real `jr2` binary.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { E2EWorld } from "./world.ts";

/** A child of the run as `jr2 status` shows it: its id, its state value, its own children. */
type Child = { id: string; value: unknown; children?: Child[] };
type Status = {
  runId: string;
  status: string;
  value: unknown;
  context: { output?: Record<string, unknown> };
  children?: Child[];
  bound?: true;
  reason?: string;
};
type Surface = { menu: Array<{ name: string }>; allowed: string[] };
/** A pick's receipt (ADR-0024): `outstanding` while the work it started runs; else it carries the
 * answer itself, as a pick whose work settled inside its own send does. */
type Receipt = { deliveryId?: string; outstanding?: true; error?: string } & Record<string, unknown>;
type Listing = {
  name: string;
  origin: string;
  wrapper?: { body: string; oneShot: boolean; charts: Array<{ name: string; origin: string; unrunnable?: string }> };
  unrunnable?: string;
};

/** Per scenario: the last HTTP answer a Chart step read, and the last pick's receipt. */
const answers = new WeakMap<E2EWorld, { status: number; body: Record<string, unknown> | null }>();
const picked = new WeakMap<E2EWorld, { iid: string; receipt: Receipt }>();

async function runStatus(world: E2EWorld): Promise<Status> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  const r = await world.runCli(["status", world.runId]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  return world.resultJson<Status>();
}

/** The Open body's child `body`, at any depth below the run's root. */
function bodyOf(s: Status): Child | undefined {
  const find = (children: Child[]): Child | undefined => {
    for (const c of children) {
      if (c.id === "body") return c;
      const deeper = find(c.children ?? []);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return find(s.children ?? []);
}

/** Poll `jr2 status` until `until` holds; the last status is in the failure. */
async function waitForStatus(world: E2EWorld, until: (s: Status) => boolean, what: string): Promise<Status> {
  let last: Status | undefined;
  for (let i = 0; i < 100; i++) {
    last = await runStatus(world);
    if (until(last)) return last;
    await sleep(100);
  }
  throw new Error(`the run never ${what} (last: ${JSON.stringify(last)})`);
}

/**
 * The conversation of the Chart's Agent `agent` in this run (ADR-0057), from the stub Harness's
 * admissions: the newest Turn admitted for it. A Chart's Agent invokes say `continue`, so a second
 * Turn of the same Agent in the same Chart is the same conversation.
 */
async function chartIid(world: E2EWorld, agent: string): Promise<string> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  for (let i = 0; i < 100; i++) {
    const mine = world
      .stubAdmissions()
      .filter((a) => a.agentName === agent && a.instanceId.startsWith(`${world.runId}/`));
    const last = mine[mine.length - 1];
    if (last) return last.instanceId;
    await sleep(50);
  }
  throw new Error(`the stub Harness admitted no Turn of "${agent}" for run ${world.runId}`);
}

/** Every prompt the stub Harness was given for `agent` in this run, oldest first. */
function promptsTo(world: E2EWorld, agent: string): string[] {
  return world
    .stubAdmissions()
    .filter((a) => a.agentName === agent && a.instanceId.startsWith(`${world.runId}/`))
    .map((a) => a.message ?? "");
}

const names = (list: string): string[] =>
  list
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .sort();

/** Start a Workflow by `jr2 run --detach` with this input, and carry the run id. */
async function startDetached(world: E2EWorld, workflow: string, input: Record<string, unknown>): Promise<void> {
  const r = await world.runCli(["run", workflow, "--detach", "--input", JSON.stringify(input)]);
  assert.equal(r.code, 0, `jr2 run ${workflow} failed: ${r.stderr}`);
  world.runId = world.resultJson<{ runId: string }>().runId;
  assert.ok(world.runId, "run --detach printed a runId");
}

/** Deliver a pick to the Chart's Agent `agent`, and keep its receipt. */
async function pick(world: E2EWorld, agent: string, event: Record<string, unknown>): Promise<void> {
  const iid = await chartIid(world, agent);
  // The Turn's registration is made when its state is entered; wait for the pick to be allowed.
  for (let i = 0; i < 100; i++) {
    const surface = await world.api<Surface>("GET", `/agents/${encodeURIComponent(iid)}/surface`);
    if (surface.status === 200 && surface.body.allowed.includes(String(event.type))) break;
    await sleep(50);
  }
  const res = await world.api<Receipt>("POST", `/agents/${encodeURIComponent(iid)}/events`, event);
  assert.equal(res.status, 200, `the pick "${String(event.type)}" was accepted (got: ${JSON.stringify(res.body)})`);
  assert.ok(res.body.deliveryId, "a delivery answers with a receipt");
  picked.set(world, { iid, receipt: res.body });
}

async function workflows(world: E2EWorld): Promise<Listing[]> {
  const res = await world.api<Listing[]>("GET", "/workflows");
  assert.equal(res.status, 200, `GET /workflows answered ${res.status}`);
  return res.body;
}

// --- starting a Chart ----------------------------------------------------------------------------

When(
  "I start {string} against the stub harness with the {string} Chart",
  async function (this: E2EWorld, workflow: string, chart: string): Promise<void> {
    const endpoint = await this.stubHarnessUrl();
    await startDetached(this, workflow, { endpoint, task: "add a greeting", chart: await this.chartText(chart) });
  },
);

When(
  "I start {string} against the stub harness with a task",
  async function (this: E2EWorld, workflow: string): Promise<void> {
    await startDetached(this, workflow, { endpoint: await this.stubHarnessUrl(), task: "add a greeting" });
  },
);

When(
  "I start {string} by HTTP with the {string} Chart",
  async function (this: E2EWorld, workflow: string, chart: string): Promise<void> {
    const input = { endpoint: await this.stubHarnessUrl(), task: "add a greeting", chart: await this.chartText(chart) };
    const res = await this.api<Record<string, unknown>>(
      "POST",
      `/workflows/${encodeURIComponent(workflow)}/runs`,
      input,
    );
    answers.set(this, res);
  },
);

When(
  "I run {string} with the {string} Chart by the CLI",
  async function (this: E2EWorld, workflow: string, chart: string): Promise<void> {
    const input = { endpoint: await this.stubHarnessUrl(), task: "add a greeting", chart: await this.chartText(chart) };
    await this.runCli(["run", workflow, "--detach", "--input", JSON.stringify(input)]);
  },
);

// --- the Chart's Agents --------------------------------------------------------------------------

Then(
  "the Chart's {string} was admitted with a prompt naming {string}",
  async function (this: E2EWorld, agent: string, needle: string): Promise<void> {
    await chartIid(this, agent);
    let prompts: string[] = [];
    for (let i = 0; i < 100; i++) {
      prompts = promptsTo(this, agent);
      if (prompts.some((p) => p.includes(needle))) return;
      await sleep(50);
    }
    assert.fail(`no prompt to "${agent}" names "${needle}": ${JSON.stringify(prompts)}`);
  },
);

Then(
  "the Chart's {string} has the Allowed picks {string}",
  async function (this: E2EWorld, agent: string, picks: string): Promise<void> {
    const iid = await chartIid(this, agent);
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      const res = await this.api<Surface>("GET", `/agents/${encodeURIComponent(iid)}/surface`);
      last = res.body;
      if (res.status === 200 && JSON.stringify([...res.body.allowed].sort()) === JSON.stringify(names(picks))) return;
      await sleep(50);
    }
    assert.fail(`the Allowed picks of "${agent}" (${iid}) never were "${picks}": ${JSON.stringify(last)}`);
  },
);

Then(
  "the stub Harness admitted the Chart's {string} {int} time(s)",
  async function (this: E2EWorld, agent: string, times: number): Promise<void> {
    // A restore re-attaches a Turn to its Submission (ADR-0016): it never admits it again.
    await sleep(200);
    const admitted = promptsTo(this, agent);
    assert.equal(admitted.length, times, `admissions of "${agent}": ${JSON.stringify(admitted)}`);
  },
);

When("the Chart's {string} picks {string}", async function (this: E2EWorld, agent: string, type: string) {
  await pick(this, agent, { type });
});

When(
  "the Chart's {string} picks {string} with notes {string}",
  async function (this: E2EWorld, agent: string, type: string, notes: string) {
    await pick(this, agent, { type, notes });
  },
);

When(
  "the planner picks {string} with the {string} Chart",
  async function (this: E2EWorld, type: string, chart: string): Promise<void> {
    await pick(this, "planner", { type, chart: await this.chartText(chart) });
  },
);

Then("the pick's answer names {string}", async function (this: E2EWorld, needle: string): Promise<void> {
  const last = picked.get(this);
  assert.ok(last, "a pick was made in a prior step");
  const receipt = last.receipt.outstanding
    ? await this.deliveryAnswer(last.iid, last.receipt.deliveryId!)
    : last.receipt;
  // The refusal is the body's OUTPUT (D-A), so it is a link the pick's answer carries: read that
  // link, not the whole receipt, so a payload the receipt echoes can never satisfy the step.
  const text = JSON.stringify(receipt);
  const answered = receipt as {
    answered?: boolean;
    answer?: { kind?: string; output?: { outcome?: string; report?: unknown } };
  };
  assert.equal(answered.answered, true, `the pick is answered: ${text}`);
  assert.equal(answered.answer?.kind, "output", `the answer is the body's output: ${text}`);
  assert.equal(answered.answer?.output?.outcome, "refused", `the answer carries the refused outcome: ${text}`);
  const report = answered.answer?.output?.report;
  assert.ok(Array.isArray(report), `the refused output carries its report: ${text}`);
  assert.ok(
    report.some((line) => typeof line === "string" && line.includes(needle) && line.includes("lent:")),
    `a report line names "${needle}" and what the Open body lends: ${text}`,
  );
});

// --- the run -------------------------------------------------------------------------------------

Then("the run's body is in state {string}", async function (this: E2EWorld, value: string): Promise<void> {
  await waitForStatus(this, (s) => JSON.stringify(bodyOf(s)?.value) === JSON.stringify(value), `had body ${value}`);
});

Then("the run is back in {string}", async function (this: E2EWorld, value: string): Promise<void> {
  const s = await waitForStatus(
    this,
    (st) => JSON.stringify(st.value).includes(`"${value}"`) && bodyOf(st) === undefined,
    `came back to ${value}`,
  );
  assert.equal(s.status, "active");
});

Then(
  "the run settles at {string} with the Chart's output {string}",
  async function (this: E2EWorld, value: string, output: string): Promise<void> {
    const s = await waitForStatus(this, (st) => st.status !== "active", "settled");
    assert.equal(s.status, "done", JSON.stringify(s));
    assert.equal(s.value, value);
    assert.deepEqual(s.context.output, { outcome: "done", output: JSON.parse(output) });
  },
);

Then(
  "the run settles at {string} with the body's {string} ceiling",
  async function (this: E2EWorld, value: string, ceiling: string): Promise<void> {
    const s = await waitForStatus(this, (st) => st.status !== "active", "settled");
    assert.equal(s.status, "done", JSON.stringify(s));
    assert.equal(s.value, value);
    assert.equal(s.context.output?.outcome, "ceiling", JSON.stringify(s.context.output));
    assert.equal(s.context.output?.ceiling, ceiling);
    assert.match(String(s.context.output?.detail), new RegExp(ceiling === "turns" ? "Agent Turns" : ceiling));
  },
);

Then("`jr2 status` says the run binds a Chart", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["status", this.runId!]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  assert.equal(this.resultJson<Status>().bound, true, "the RunStatus says `bound`");
  assert.match(r.stderr, /^chart: bound — GET \/workflows\/charted\/runs\/\S+\/machine/m);
});

Then(
  "the run's Machine lists the Chart's states {string}, and the wrapper's Machine does not",
  async function (this: E2EWorld, states: string): Promise<void> {
    const run = await this.api("GET", `/workflows/charted/runs/${this.runId}/machine`);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const template = await this.api("GET", `/workflows/charted/machine`);
    assert.equal(template.status, 200);
    for (const state of names(states)) {
      assert.ok(JSON.stringify(run.body).includes(`"${state}"`), `the run's Machine has "${state}"`);
      assert.ok(!JSON.stringify(template.body).includes(`"${state}"`), `the wrapper's Machine has no "${state}"`);
    }
  },
);

// --- refusals ------------------------------------------------------------------------------------

Then("the start is refused with 422 and a report naming {string}", function (this: E2EWorld, needle: string): void {
  const res = answers.get(this);
  assert.ok(res, "a start was sent in a prior step");
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body?.error, "refused");
  const report = (res.body?.report as string[] | undefined) ?? [];
  assert.ok(
    report.some((line) => line.includes(needle)),
    `a report line names ${JSON.stringify(needle)}: ${report.join("\n")}`,
  );
});

Then(
  "stderr says the door refused the Chart for {string} naming {string}",
  function (this: E2EWorld, workflow: string, needle: string): void {
    assert.equal(this.last?.code, 1, this.last?.stderr ?? "");
    assert.equal(this.last?.stdout, "", "a refused start prints no result");
    assert.match(this.last?.stderr ?? "", new RegExp(`^error: the door refused the Chart for "${workflow}"$`, "m"));
    assert.ok(this.last?.stderr.includes(needle), this.last?.stderr);
  },
);

// --- named Charts --------------------------------------------------------------------------------

When(
  "I put the {string} Chart as {string}",
  async function (this: E2EWorld, chart: string, name: string): Promise<void> {
    const [wrapper, short] = name.split("/") as [string, string];
    answers.set(this, await this.api("PUT", `/workflows/${wrapper}/charts/${short}`, await this.chartText(chart)));
  },
);

When("I delete the Chart {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const [wrapper, short] = name.split("/") as [string, string];
  answers.set(this, await this.api("DELETE", `/workflows/${wrapper}/charts/${short}`));
});

Then("the answer is {int}", function (this: E2EWorld, status: number): void {
  assert.equal(answers.get(this)?.status, status, JSON.stringify(answers.get(this)?.body));
});

Then("the answer is {int} naming {string}", function (this: E2EWorld, status: number, needle: string): void {
  const res = answers.get(this);
  assert.equal(res?.status, status, JSON.stringify(res?.body));
  assert.ok(JSON.stringify(res?.body).includes(needle), `the answer names "${needle}": ${JSON.stringify(res?.body)}`);
});

Then("the put answers {int} with origin {string}", function (this: E2EWorld, status: number, origin: string): void {
  const res = answers.get(this);
  assert.equal(res?.status, status, JSON.stringify(res?.body));
  assert.equal(res?.body?.origin, origin);
  assert.match(String(res?.body?.hash), /^[0-9a-f]{12}$/, "the answer names the Chart's hash");
});

Then("`jr2 runs` lists {string} under its wrapper", async function (this: E2EWorld, line: string): Promise<void> {
  const r = await this.runCli(["runs"]);
  assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(r.stderr, new RegExp(`^    ${escaped}$`, "m"), `the listing on stderr:\n${r.stderr}`);
});

Then("`jr2 runs` does not list {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const r = await this.runCli(["runs"]);
  assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
  assert.ok(!r.stderr.includes(name), `the listing on stderr names no "${name}":\n${r.stderr}`);
});

Then(
  "the listing shows {string} inside its wrapper's entry, not beside it",
  async function (this: E2EWorld, name: string): Promise<void> {
    const listing = await workflows(this);
    const [wrapper, short] = name.split("/") as [string, string];
    const entry = listing.find((w) => w.name === wrapper);
    assert.ok(entry?.wrapper, `"${wrapper}" is listed as a Chart wrapper: ${JSON.stringify(listing)}`);
    assert.equal(entry.wrapper.body, "body");
    assert.equal(entry.wrapper.oneShot, true);
    assert.ok(
      entry.wrapper.charts.some((c) => c.name === short || c.name === name),
      `"${name}" is inside the entry: ${JSON.stringify(entry)}`,
    );
    assert.ok(!listing.some((w) => w.name === name), `"${name}" is not beside it: ${JSON.stringify(listing)}`);
  },
);

Then(
  "the listing shows {string} unrunnable, naming {string}",
  async function (this: E2EWorld, name: string, needle: string): Promise<void> {
    const listing = await workflows(this);
    const [wrapper, short] = name.split("/") as [string, string];
    const charts = listing.find((w) => w.name === wrapper)?.wrapper?.charts ?? [];
    const found = charts.find((c) => c.name === short || c.name === name) ?? listing.find((w) => w.name === name);
    assert.ok(found, `"${name}" is listed: ${JSON.stringify(listing)}`);
    assert.ok(found.unrunnable?.includes(needle), `unrunnable, naming "${needle}": ${JSON.stringify(found)}`);
  },
);

When("I start {string} by HTTP with a task", async function (this: E2EWorld, workflow: string): Promise<void> {
  const [wrapper, short] = workflow.split("/") as [string, string];
  const input = { endpoint: await this.stubHarnessUrl(), task: "add a greeting" };
  answers.set(this, await this.api("POST", `/workflows/${wrapper}/charts/${short}/runs`, input));
});

// --- Chart files and publishes -------------------------------------------------------------------

When(
  "I add the {string} Chart as the Chart file {string} and publish",
  async function (this: E2EWorld, chart: string, name: string): Promise<void> {
    const [wrapper, short] = name.split("/") as [string, string];
    await this.addChartFile(chart, wrapper, short);
    await this.publish();
  },
);

When("I remove the Chart file {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const [wrapper, short] = name.split("/") as [string, string];
  await this.removeChartFile(wrapper, short);
});

Then("the publish lists {string}", function (this: E2EWorld, name: string): void {
  assert.equal(this.published?.status, 200);
  assert.ok(this.published?.body.workflows?.includes(name), JSON.stringify(this.published?.body));
});

/** The `charted` fixture's lends, as its source spells them: what an edit to the wrapper drops. */
const LENDS = 'lends: { agents: ["coder"], guards: ["underLimit"] }';
const LENDS_WITHOUT: Record<string, string> = {
  coder: 'lends: { guards: ["underLimit"] }',
  underLimit: 'lends: { agents: ["coder"] }',
};

const CHARTED_FIXTURE = fileURLToPath(new URL("../fixtures/charted.ts", import.meta.url));

/** `charted`'s source with one lent part dropped from its Open body's declaration. */
async function chartedWithout(source: string, part: string): Promise<string> {
  const text = await readFile(source, "utf8");
  assert.ok(text.includes(LENDS), `${source} declares ${LENDS}`);
  const without = LENDS_WITHOUT[part];
  assert.ok(without, `the step drops one of: ${Object.keys(LENDS_WITHOUT).join(", ")}`);
  return text.replace(LENDS, without);
}

When(
  "I publish {string} lending no {string}",
  async function (this: E2EWorld, workflow: string, part: string): Promise<void> {
    assert.equal(workflow, "charted", "the step edits the charted fixture");
    // Edited from the fixture each time, so two edits in one scenario each drop one part.
    await writeFile(join(this.dir, "workflows", "charted.ts"), await chartedWithout(CHARTED_FIXTURE, part));
    await this.publish({ expectRefusal: true });
  },
);

Then("the publish is refused naming {string}", function (this: E2EWorld, needle: string): void {
  const answer = this.published;
  assert.equal(answer?.status, 422, JSON.stringify(answer?.body));
  assert.equal(answer?.body.error, "refused");
  const report = (answer?.body.report ?? []).join("\n");
  assert.ok(report.includes(needle), `the report names "${needle}":\n${report}`);
});

Then("the publish lands and names {string} unrunnable", function (this: E2EWorld, name: string): void {
  const answer = this.published;
  assert.equal(answer?.status, 200, JSON.stringify(answer?.body));
  const charts = answer?.body.charts as { unrunnable?: Array<{ name: string; reason: string }> } | undefined;
  assert.ok(
    charts?.unrunnable?.some((c) => c.name === name),
    `the publish answer names "${name}" unrunnable: ${JSON.stringify(answer?.body)}`,
  );
});

// --- restore -------------------------------------------------------------------------------------

/**
 * Edit the Assembly the run holds, on the volume, while the orchestrator is down, and boot it.
 * A publish would not do: a live run restores under the Assembly it started under (ADR-0069), so a
 * new Assembly never takes a lent part from it. Only a volume edited by hand (or a Kit change) can.
 * The step depends on boot reading the held tree as it is, without a check against its hash: no
 * ADR states that property, so a boot that checks the hash later fails this step before restore.
 */
When(
  "the orchestrator stops, the held Assembly's {string} lends no {string}, and it boots",
  async function (this: E2EWorld, workflow: string, part: string): Promise<void> {
    assert.equal(workflow, "charted", "the step edits the charted fixture");
    const held = this.currentHash;
    assert.ok(held, "the fixture published an Assembly");
    await this.stopServer();
    const file = join(this.assemblyPaths(held).tree, "workflows", "charted.ts");
    await writeFile(file, await chartedWithout(file, part));
    await this.bootServer();
  },
);

Then(
  "the run's drift reason names the body {string} and {string}",
  async function (this: E2EWorld, slot: string, needle: string): Promise<void> {
    const s = await runStatus(this);
    assert.equal(s.status, "drifted", JSON.stringify(s));
    assert.match(s.reason ?? "", new RegExp(`under body "${slot}"`), s.reason ?? "no reason");
    assert.ok(s.reason?.includes(needle), `the reason names "${needle}": ${s.reason}`);
  },
);

Then(
  "the run's Machine names the body {string} as a Chart it cannot draw, naming {string}",
  async function (this: E2EWorld, slot: string, needle: string): Promise<void> {
    assert.ok(this.runId, "a runId was carried from a prior step");
    const res = await this.api<{ chartsNotDrawn?: Array<{ path: string; src: string; reason: string }> }>(
      "GET",
      `/workflows/charted/runs/${encodeURIComponent(this.runId)}/machine`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = res.body.chartsNotDrawn?.find((c) => c.src === slot);
    assert.ok(entry, `the doc names body "${slot}" as not drawn: ${JSON.stringify(res.body.chartsNotDrawn)}`);
    assert.ok(entry.reason.includes(needle), `the reason names "${needle}": ${entry.reason}`);
  },
);
