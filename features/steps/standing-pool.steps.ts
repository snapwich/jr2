// Steps for `standing-pool.feature` (ADR-0017): a Hook brings items to a standing Pool of runs.
// Deliveries go to `POST /hooks/<name>` as the services send them: the alert service with a shared
// token (`token`), Discord signed with a key pair that the scenario makes (`ed25519`). The runs are
// read black-box (`GET /runs`, `GET /runs/:id`); the count of runs started is read from the store
// file at the end, because a run that ended is no longer in `GET /runs`.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { E2EWorld } from "./world.ts";

type Run = {
  runId: string;
  workflow: string;
  status: string;
  startedBy?: { kind: string; why?: string };
  resumedBy?: { via: string; name: string };
  handedOverTo?: string;
  context?: Record<string, unknown>;
  dispatchedBy?: { key?: string; hook?: { name: string; delivery: string } };
};
type SourceLine = { verdict: string; key?: string; run?: string; reason?: string };
type Answer = { status: number; body: { seen?: boolean; sources?: SourceLine[] } };

type Pools = {
  token: string;
  discord: { privateKey: KeyObject };
  answer?: Answer;
  answers?: Answer[];
  /** The live runs that a step saw last. */
  remembered?: string[];
  /** The standing Pool's run that a step saw last. */
  poolRunId?: string;
  /** The fake issue API's open labeled issues. */
  issues?: Array<{ number: number; title: string }>;
  /** The most live runs of each Workflow at once, and each run id seen with its key. */
  sampler?: ReturnType<typeof setInterval>;
  maxLive: Map<string, number>;
  seen: Map<string, Map<string, string | undefined>>;
};
const states = new WeakMap<E2EWorld, Pools>();
const stateOf = (w: E2EWorld): Pools => {
  const s = states.get(w);
  assert.ok(s, "the instance declares its Hooks first");
  return s;
};

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function liveRuns(world: E2EWorld): Promise<Run[]> {
  const r = await world.api<Run[]>("GET", "/runs");
  assert.equal(r.status, 200);
  return r.body;
}
const ofWorkflow = (runs: Run[], workflow: string) => runs.filter((r) => r.workflow === workflow);

/** Read `GET /runs` every 20 ms: the most live runs of each Workflow at once. */
function startSampler(world: E2EWorld): void {
  const s = stateOf(world);
  if (s.sampler) return;
  s.sampler = setInterval(() => {
    liveRuns(world).then(
      (runs) => {
        const by = new Map<string, number>();
        for (const r of runs) {
          by.set(r.workflow, (by.get(r.workflow) ?? 0) + 1);
          let m = s.seen.get(r.workflow);
          if (!m) s.seen.set(r.workflow, (m = new Map()));
          m.set(r.runId, r.dispatchedBy?.key);
        }
        for (const [w, n] of by) s.maxLive.set(w, Math.max(s.maxLive.get(w) ?? 0, n));
      },
      () => {},
    );
  }, 20);
  world.closers.push(async () => clearInterval(s.sampler));
}

async function poll<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, tries = 400): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (ok(last)) return last;
    await sleep(25);
  }
  throw new Error(`${what}: never (last: ${JSON.stringify(last)})`);
}

async function poolRun(world: E2EWorld, workflow: string): Promise<Run> {
  const runs = await poll(
    `a live run of "${workflow}"`,
    () => liveRuns(world),
    (r) => ofWorkflow(r, workflow).length === 1,
  );
  return (await world.api<Run>("GET", `/runs/${ofWorkflow(runs, workflow)[0]!.runId}`)).body;
}
const heldOf = (run: Run): unknown[] => (run.context?.held as unknown[]) ?? [];

async function post(world: E2EWorld, name: string, headers: Record<string, string>, body: string): Promise<Answer> {
  assert.ok(world.server, "the orchestrator is serving");
  startSampler(world);
  const res = await fetch(`${world.server.url.replace(/\/+$/, "")}/hooks/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function alert(world: E2EWorld, id: string, level: string, delivery: string, token?: string): Promise<Answer> {
  const body = JSON.stringify({
    action: "created",
    // A service sends each delivery with its own time, so a second delivery of one alert is a
    // body of its own: the repeat check finds it by its id alone.
    sent: delivery,
    data: { issue: { id, title: `TypeError in checkout ${id}`, level } },
  });
  return post(
    world,
    "sentry",
    {
      "x-alerts-token": token ?? stateOf(world).token,
      "x-alerts-resource": "issue",
      "x-alerts-delivery": delivery,
    },
    body,
  );
}

/** A Discord command, signed over its timestamp and body. */
function discordCommand(world: E2EWorld, id: string, name: string): Promise<Answer> {
  const at = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ type: 2, id, channel_id: "c-1", member: { user: { id: "u-7" } }, data: { name } });
  const sig = sign(null, Buffer.from(at + raw), stateOf(world).discord.privateKey).toString("hex");
  return post(world, "discord", { "x-signature-ed25519": sig, "x-signature-timestamp": at }, raw);
}

// --- Given ---------------------------------------------------------------------------------------

Given(
  "the instance declares the alert service's Hook and a Discord Hook",
  async function (this: E2EWorld): Promise<void> {
    const keys = generateKeyPairSync("ed25519");
    const publicHex = Buffer.from((keys.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString(
      "hex",
    );
    const token = randomBytes(16).toString("hex");
    states.set(this, { token, discord: { privateKey: keys.privateKey }, maxLive: new Map(), seen: new Map() });
    // The alert service's kind is a module of the Instance; the `_` keeps it from being a Workflow.
    await mkdir(join(this.dir, "workflows"), { recursive: true });
    await copyFile(
      fileURLToPath(new URL("../fixtures/_alerts.ts", import.meta.url)),
      join(this.dir, "workflows", "_alerts.ts"),
    );
    const config = join(this.dir, "jr2.config.ts");
    const text = await readFile(config, "utf8");
    const declared =
      'import { secret } from "@jr2/orchestrator";\n' +
      'import { discord } from "@jr2/hooks/discord";\n' +
      'import { alerts } from "./workflows/_alerts.ts";\n' +
      text.replace(
        "export default defineConfig({",
        "export default defineConfig({\n" +
          // A `token` Hook's secret is an entry of the list, or the publish is refused (ADR-0078).
          `  secrets: [{ name: "ALERTS_HOOK", value: "${token}" }],\n` +
          "  hooks: {\n" +
          '    sentry: alerts({ secret: secret("ALERTS_HOOK") }),\n' +
          `    discord: discord({ publicKey: "${publicHex}" }),\n` +
          "  },",
      );
    assert.notEqual(declared.length, text.length);
    await writeFile(config, declared);
    // As `jr2 up` mounts it: the digest of the token Hook's secret, never its value.
    const digests = join(this.dir, ".jr2-hook-digests.json");
    await writeFile(digests, JSON.stringify({ ALERTS_HOOK: sha256(token) }));
    this.serverEnv.JR2_HOOK_DIGESTS = digests;
  },
);

Given("the fake issue API has no issues", async function (this: E2EWorld): Promise<void> {
  const s = stateOf(this);
  const issues: Array<{ number: number; title: string }> = [];
  s.issues = issues;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.startsWith("/issues") ? issues : []));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  this.closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await writeFile(join(this.dir, "issues-api.url"), `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

// Nobody starts a standing run: jr2 started it at the publish that added it (ADR-0017).
Given("the standing Pool {string} runs", async function (this: E2EWorld, workflow: string): Promise<void> {
  const run = await poolRun(this, workflow);
  assert.deepEqual(run.startedBy, { kind: "jr2", why: "publish" });
  stateOf(this).poolRunId = run.runId;
});

// --- When ----------------------------------------------------------------------------------------

When(
  "the alert service sends the alert {string} at level {string} as delivery {string}",
  async function (this: E2EWorld, id: string, level: string, delivery: string): Promise<void> {
    stateOf(this).answer = await alert(this, id, level, delivery);
  },
);

When(
  "the alert service sends the alert {string} with a wrong token",
  async function (this: E2EWorld, id: string): Promise<void> {
    stateOf(this).answer = await alert(this, id, "error", `bad-${id}`, "not-the-token");
  },
);

When("the alert service sends {int} different alerts", async function (this: E2EWorld, n: number): Promise<void> {
  const answers: Answer[] = [];
  for (let i = 1; i <= n; i++) answers.push(await alert(this, `a${i}`, "error", `d-${i}`));
  for (const a of answers) assert.equal(a.status, 200, JSON.stringify(a.body));
  stateOf(this).answers = answers;
});

When(
  "the alert service sends {int} different alerts in about one second",
  async function (this: E2EWorld, n: number): Promise<void> {
    // One delivery every 20 ms, none awaiting another: a burst, not a queue in this step.
    const sent: Array<Promise<Answer>> = [];
    const started = Date.now();
    for (let i = 1; i <= n; i++) {
      sent.push(alert(this, `b${i}`, "error", `burst-${i}`));
      await sleep(1000 / n);
    }
    stateOf(this).answers = await Promise.all(sent);
    const took = Date.now() - started;
    assert.ok(took < 5000, `the burst took ${took} ms`);
  },
);

When(
  "Discord sends the command {string} as interaction {string}",
  async function (this: E2EWorld, name: string, id: string): Promise<void> {
    stateOf(this).answer = await discordCommand(this, id, name);
  },
);

When(
  "the fake issue API has open labeled issues {int}, {int} and {int}",
  function (this: E2EWorld, a: number, b: number, c: number): void {
    for (const n of [a, b, c]) stateOf(this).issues!.push({ number: n, title: `issue ${n}` });
  },
);

async function finishRun(world: E2EWorld, runId: string): Promise<void> {
  const r = await world.api("POST", `/runs/${runId}/gates/finish/events`, { type: "finish" });
  assert.ok(r.status < 300, `finish ${runId}: ${r.status} ${JSON.stringify(r.body)}`);
}

When("{int} of the live {string} runs finish", async function (this: E2EWorld, n: number, workflow: string) {
  const runs = ofWorkflow(await liveRuns(this), workflow).slice(0, n);
  assert.equal(runs.length, n);
  for (const r of runs) await finishRun(this, r.runId);
});

When(
  "the live {string} run with the key {string} finishes",
  async function (this: E2EWorld, workflow: string, key: string): Promise<void> {
    const run = ofWorkflow(await liveRuns(this), workflow).find((r) => r.dispatchedBy?.key === key);
    assert.ok(run, `a live ${workflow} run with the key ${key}`);
    await finishRun(this, run.runId);
  },
);

// --- Then ----------------------------------------------------------------------------------------

Then(
  "the answer is {int} and the Source verdict is {string} with key {string}",
  function (this: E2EWorld, status: number, verdict: string, key: string): void {
    const a = stateOf(this).answer!;
    assert.equal(a.status, status, JSON.stringify(a.body));
    assert.deepEqual(
      a.body.sources?.map((s) => [s.verdict, s.key]),
      [[verdict, key]],
      JSON.stringify(a.body),
    );
  },
);

Then(
  "the answer is {int} and the Source verdict is {string}",
  function (this: E2EWorld, status: number, verdict: string): void {
    const a = stateOf(this).answer!;
    assert.equal(a.status, status, JSON.stringify(a.body));
    assert.deepEqual(
      a.body.sources?.map((s) => s.verdict),
      [verdict],
      JSON.stringify(a.body),
    );
  },
);

Then("the person reads {string} in the Discord answer", function (this: E2EWorld, text: string): void {
  const a = stateOf(this).answer!;
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body, { type: 4, data: { content: text, flags: 64 } });
});

Then("the Hook's answer is {int}", function (this: E2EWorld, status: number): void {
  assert.equal(stateOf(this).answer!.status, status, JSON.stringify(stateOf(this).answer!.body));
});

Then("the answer says that the delivery was seen before", function (this: E2EWorld): void {
  const a = stateOf(this).answer!;
  assert.equal(a.status, 200);
  assert.equal(a.body.seen, true, JSON.stringify(a.body));
  assert.deepEqual(a.body.sources, []);
});

Then(
  "every answer is {int} with the Source verdict {string}",
  function (this: E2EWorld, status: number, verdict: string): void {
    for (const a of stateOf(this).answers!) {
      assert.equal(a.status, status, JSON.stringify(a.body));
      assert.equal(a.body.sources?.[0]?.verdict, verdict, JSON.stringify(a.body));
    }
  },
);

Then(
  "the live {string} runs have the keys {string}",
  async function (this: E2EWorld, workflow: string, keys: string): Promise<void> {
    const want = keys === "" ? [] : keys.split(",").sort();
    const read = async () =>
      ofWorkflow(await liveRuns(this), workflow)
        .map((r) => r.dispatchedBy?.key)
        .sort();
    await poll(
      `live ${workflow} runs with the keys ${keys}`,
      read,
      (got) => JSON.stringify(got) === JSON.stringify(want),
    );
    // Stable: nothing more starts a moment later.
    await sleep(250);
    assert.deepEqual(await read(), want);
  },
);

Then(
  "the {string} run with the key {string} names the delivery {string} of the Hook {string}",
  async function (this: E2EWorld, workflow: string, key: string, delivery: string, hook: string): Promise<void> {
    const run = ofWorkflow(await liveRuns(this), workflow).find((r) => r.dispatchedBy?.key === key);
    assert.ok(run, `a live ${workflow} run with the key ${key}`);
    assert.deepEqual(
      [run.dispatchedBy?.hook?.name, run.dispatchedBy?.hook?.delivery],
      [hook, delivery],
      JSON.stringify(run.dispatchedBy),
    );
  },
);

Then(
  "{int} {string} runs are live and the {string} Pool holds {int} items",
  async function (this: E2EWorld, n: number, workflow: string, poolName: string, held: number): Promise<void> {
    await poll(
      `${n} live ${workflow} runs and ${held} held`,
      async () => [ofWorkflow(await liveRuns(this), workflow).length, heldOf(await poolRun(this, poolName)).length],
      ([live, h]) => live === n && h === held,
    );
    stateOf(this).remembered = ofWorkflow(await liveRuns(this), workflow)
      .map((r) => r.runId)
      .sort();
  },
);

Then(
  "the same {int} {string} runs are live and the {string} Pool holds {int} items",
  async function (this: E2EWorld, n: number, workflow: string, poolName: string, held: number): Promise<void> {
    const pool = await poolRun(this, poolName);
    // Give a restored Pool time to (wrongly) start something.
    await sleep(500);
    const live = ofWorkflow(await liveRuns(this), workflow)
      .map((r) => r.runId)
      .sort();
    assert.equal(live.length, n);
    assert.deepEqual(live, stateOf(this).remembered, "the same runs: none lost, none started again");
    assert.equal(heldOf((await this.api<Run>("GET", `/runs/${pool.runId}`)).body).length, held);
  },
);

Then(
  "all {int} {string} runs end, one for each key, with never more than {int} live at once",
  async function (this: E2EWorld, n: number, workflow: string, cap: number): Promise<void> {
    await poll(
      `${n} settled`,
      () => poolRun(this, "burst"),
      (p) => Object.keys((p.context?.items as object) ?? {}).length === n,
      800,
    );
    const pool = await poolRun(this, "burst");
    assert.deepEqual([pool.context!.held, pool.context!.active], [[], []]);
    const s = stateOf(this);
    assert.ok((s.maxLive.get(workflow) ?? 0) <= cap, `at most ${cap} live at once, saw ${s.maxLive.get(workflow)}`);
    assert.ok((s.maxLive.get(workflow) ?? 0) > 0, "the sampler saw the runs");
    const seen = [...(s.seen.get(workflow) ?? new Map()).values()];
    assert.equal(new Set(seen).size, seen.length, "no key on two runs");
  },
);

Then(
  "the store holds exactly {int} {string} runs, one for each key",
  async function (this: E2EWorld, n: number, workflow: string): Promise<void> {
    // The store file: an ended run is not in `GET /runs`, and no verb lists it.
    await sleep(200);
    const db = new DatabaseSync(join(this.dir, ".jr2", "state.db"), { readOnly: true });
    try {
      const rows = db
        .prepare(`SELECT run_id, dispatch_effect AS key FROM machine_snapshots WHERE dispatch_workflow = ?`)
        .all(workflow) as Array<{ run_id: string; key: string }>;
      assert.equal(rows.length, n, JSON.stringify(rows));
      assert.equal(new Set(rows.map((r) => r.key)).size, n, `one run per key: ${JSON.stringify(rows)}`);
    } finally {
      db.close();
    }
  },
);

// --- jr2 keeps the standing run (ADR-0017) -------------------------------------------------------

/** The live run of a standing Pool other than `old`. */
async function nextPoolRun(world: E2EWorld, workflow: string, old: string): Promise<Run> {
  const runs = await poll(
    `a new live run of "${workflow}"`,
    () => liveRuns(world),
    (r) => ofWorkflow(r, workflow).length === 1 && ofWorkflow(r, workflow)[0]!.runId !== old,
  );
  return (await world.api<Run>("GET", `/runs/${ofWorkflow(runs, workflow)[0]!.runId}`)).body;
}

When("another Workflow is published beside it", async function (this: E2EWorld): Promise<void> {
  // Another Assembly: one hash for the whole tree, so the standing run is handed over.
  await this.addFixtureWorkflow("quick");
  const answer = await this.publish();
  assert.notEqual(answer.body.unchanged, true);
});

Then(
  "jr2 handed the {string} run over: the old run ended done, and the new run was started for a {string}",
  async function (this: E2EWorld, workflow: string, why: string): Promise<void> {
    const s = stateOf(this);
    const old = s.poolRunId!;
    const next = await nextPoolRun(this, workflow, old);
    assert.deepEqual(next.startedBy, { kind: "jr2", why });
    const ended = (await this.api<Run>("GET", `/runs/${old}`)).body;
    assert.equal(ended.status, "done");
    assert.equal(ended.handedOverTo, next.runId);
    s.poolRunId = next.runId;
  },
);

When("the {string} run is cancelled", async function (this: E2EWorld, workflow: string): Promise<void> {
  const run = await poolRun(this, workflow);
  const r = await this.runCli(["send", run.runId, "--event", "CANCEL"]);
  assert.equal(r.code, 0, `jr2 send CANCEL failed: ${r.stderr}`);
  stateOf(this).poolRunId = run.runId;
  await poll(
    `no live run of "${workflow}"`,
    () => liveRuns(this),
    (runs) => ofWorkflow(runs, workflow).length === 0,
  );
});

Then(
  "`jr2 status` prints the {string} Pool as paused with {int} held items",
  async function (this: E2EWorld, workflow: string, held: number): Promise<void> {
    const r = await this.runCli(["status"]);
    assert.equal(r.code, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => l.startsWith(`standing ${workflow} → `));
    assert.ok(line, r.stdout);
    assert.match(line, new RegExp(`paused \\(a cancel\\), ${held} held items in run ${stateOf(this).poolRunId}`));
  },
);

When("`jr2 run alerts` resumes the Pool", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["run", "alerts"]);
  assert.equal(r.code, 0, `jr2 run alerts failed: ${r.stderr}`);
  const out = this.resultJson<{ runId: string; resumed?: boolean }>();
  assert.equal(out.resumed, true);
});

Then(
  "the new {string} run was started for a {string}, names the Caller that resumed it, and holds {int} items",
  async function (this: E2EWorld, workflow: string, why: string, held: number): Promise<void> {
    const s = stateOf(this);
    const next = await nextPoolRun(this, workflow, s.poolRunId!);
    assert.deepEqual(next.startedBy, { kind: "jr2", why });
    assert.equal(next.resumedBy?.via, "token", JSON.stringify(next.resumedBy));
    assert.equal(heldOf(next).length, held);
    s.poolRunId = next.runId;
  },
);

Then("`jr2 run alerts` is refused while the Pool is live", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["run", "alerts"]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /standing Workflow/);
});
