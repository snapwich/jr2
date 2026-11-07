// Git LFS in a real pod (ADR-0051, ADR-0053, ADR-0067, ADR-0075): the stock Harness, the real cache
// agent, jr2's transfer agent and the Sandbox Effector, against the seed's LFS server (`seed.ts`).
// Each scenario makes its own LFS repository on the seed at run time, so that no two scenarios share
// a cache's objects and the seed's own manifest does not change.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isSettled } from "../lib/run-settled.ts";
import {
  kubectl,
  sendGate,
  shell,
  startWt,
  toolResultWith,
  wsStatus,
  type OpenGate,
  type WsStatus,
} from "./kind.steps.ts";
import {
  ensureLfsServer,
  lfsObjectNobodyHolds,
  lfsSeedRepo,
  lfsServerHolds,
  makeLfsObjects,
  seedRepoTip,
  type LfsObject,
} from "./seed.ts";
import type { E2EWorld } from "./world.ts";

/** One cut's answer, as `worktree()` gives it. */
type CutOut = { outcome?: string; found?: string; reason?: string; head?: string };

/** What a scenario of this file carries from step to step. */
type LfsState = {
  name: string;
  url: string;
  branch: string;
  /** The large file of `main`'s tip, in default/. */
  base?: { path: string; object: LfsObject };
  /** The large file of the older commit on `main`. */
  older?: { path: string; object: LfsObject };
  /** The large file of the branch. */
  onBranch?: { path: string; object: LfsObject };
  /** The sha-256 of each file, read in the pod: default/'s after the attach, the Worktree's after the cut. */
  read?: { base?: string; cut?: string };
  out?: { first?: CutOut; second?: CutOut };
  times?: Record<string, number>;
  coldMiB?: number;
};

const states = new WeakMap<E2EWorld, LfsState>();

function lfsOf(world: E2EWorld): LfsState {
  const s = states.get(world);
  assert.ok(s, "a step made this scenario's LFS repository");
  return s;
}

/** A repository name of this scenario: a label, unique across workers. */
const nameFor = (what: string) => `lfs-${what}-${randomBytes(4).toString("hex")}`;

const MiB = 1 << 20;

// --- given -----------------------------------------------------------------------------------------

Given(
  "an LFS repository whose branch holds a large file that main does not",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await ensureLfsServer();
    const name = nameFor("cut");
    const [base, onBranch] = await makeLfsObjects(name, [256 * 1024, 512 * 1024]);
    const branch = `side-${name.slice(-8)}`;
    const { url } = await lfsSeedRepo(name, {
      main: [{ "assets/base.bin": base! }],
      branches: { [branch]: { "assets/side.bin": onBranch! } },
    });
    states.set(this, {
      name,
      url,
      branch,
      base: { path: "assets/base.bin", object: base! },
      onBranch: { path: "assets/side.bin", object: onBranch! },
    });
  },
);

Given(
  "an LFS repository whose branch names a large file that the LFS server does not hold",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await ensureLfsServer();
    const name = nameFor("gone");
    const [base] = await makeLfsObjects(name, [64 * 1024]);
    const missing = lfsObjectNobodyHolds();
    const branch = `gone-${name.slice(-8)}`;
    const { url } = await lfsSeedRepo(name, {
      main: [{ "assets/base.bin": base! }],
      branches: { [branch]: { "assets/missing.bin": missing } },
    });
    states.set(this, {
      name,
      url,
      branch,
      base: { path: "assets/base.bin", object: base! },
      onBranch: { path: "assets/missing.bin", object: missing },
    });
  },
);

Given(
  "an LFS repository with a large file in each of two commits on main",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await ensureLfsServer();
    const name = nameFor("old");
    const [older, base] = await makeLfsObjects(name, [300 * 1024, 200 * 1024]);
    const { url } = await lfsSeedRepo(name, { main: [{ "big.bin": older! }, { "big.bin": base! }] });
    states.set(this, {
      name,
      url,
      branch: `work-${name.slice(-8)}`,
      base: { path: "big.bin", object: base! },
      older: { path: "big.bin", object: older! },
    });
  },
);

Given(
  "an LFS repository over ssh with a large file on main",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await ensureLfsServer();
    const name = nameFor("push");
    const [base] = await makeLfsObjects(name, [128 * 1024]);
    const { url } = await lfsSeedRepo(name, { main: [{ "big.bin": base! }] }, "ssh");
    states.set(this, { name, url, branch: `up-${name.slice(-8)}`, base: { path: "big.bin", object: base! } });
  },
);

/**
 * The measurement's repository: `JR2_LFS_COLD_MB` MiB of large files on `main` (64 by default), in
 * files of at most 256 MiB, because git holds a whole smudged file in memory and the tier's Sandbox
 * has 1 GiB; and a branch with one more file of `JR2_LFS_CUT_MB` MiB (16 by default).
 */
Given(
  "an LFS repository whose base holds large files of the size that JR2_LFS_COLD_MB names",
  { timeout: 1_800_000 },
  async function (this: E2EWorld): Promise<void> {
    await ensureLfsServer();
    const coldMiB = Number(process.env.JR2_LFS_COLD_MB ?? 64);
    const cutMiB = Number(process.env.JR2_LFS_CUT_MB ?? 16);
    assert.ok(coldMiB > 0 && cutMiB > 0, "JR2_LFS_COLD_MB and JR2_LFS_CUT_MB are sizes in MiB");
    const pieces: number[] = [];
    for (let left = coldMiB; left > 0; left -= 256) pieces.push(Math.min(left, 256) * MiB);
    const name = nameFor("cold");
    const made = Date.now();
    const objects = await makeLfsObjects(name, [...pieces, cutMiB * MiB]);
    const onBranch = objects.pop()!;
    const branch = `side-${name.slice(-8)}`;
    const files = Object.fromEntries(objects.map((o, i) => [`data/part-${i}.bin`, o]));
    const { url } = await lfsSeedRepo(name, { main: [files], branches: { [branch]: { "data/side.bin": onBranch } } });
    states.set(this, {
      name,
      url,
      branch,
      base: { path: "data/part-0.bin", object: objects[0]! },
      onBranch: { path: "data/side.bin", object: onBranch },
      coldMiB,
      times: { madeSeconds: (Date.now() - made) / 1000 },
    });
  },
);

// --- when ------------------------------------------------------------------------------------------

/** The run's one open Gate, waited for up to `ms`: a cold attach of large files takes minutes. */
async function gateWithin(world: E2EWorld, ms: number, sandboxReady?: (at: number) => void): Promise<OpenGate> {
  let last: WsStatus | undefined;
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) {
    last = await wsStatus(world);
    // The wrapper attaches once its Sandbox is Ready (ADR-0004).
    if (sandboxReady !== undefined && (last.value === "attaching" || last.value === "running")) {
      sandboxReady(Date.now());
      sandboxReady = undefined;
    }
    const gates = last.gates ?? [];
    if (gates.length === 1) return gates[0]!;
    assert.ok(!isSettled(last.status), `the run settled before its Gate opened: ${JSON.stringify(last)}`);
  }
  throw new Error(`the run opened no Gate in ${ms} ms (last: ${JSON.stringify(last)})`);
}

/** The run's settled status, waited for up to `ms`. */
async function settledWithin(world: E2EWorld, ms: number): Promise<WsStatus> {
  let last: WsStatus | undefined;
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) {
    last = await wsStatus(world);
    if (isSettled(last.status)) return last;
  }
  throw new Error(`the run did not settle in ${ms} ms (last: ${JSON.stringify(last)})`);
}

/** The sha-256 of a file in the pod, or what the pod said when it could not read one. */
async function shaInPod(world: E2EWorld, file: string): Promise<string> {
  const out = await shell(world, `sha256sum '${file}' 2>&1 | cut -c1-64`);
  return out.trim();
}

/** One LFS ask of the run's Sandbox, as its status showed it: the ask's mark, and when it was answered. */
type AskSeen = { asked: string; answeredSeenAt?: number; error?: string };

/**
 * Watch the run's Sandbox status for LFS asks until `stop` resolves (ADR-0053). `asked` is the time of
 * the Orchestrator's mark, and the answer is seen when `answered` reaches it: the time between the two
 * is the ask's way through the operator and the cache agent, to within one poll. The kind node and this
 * host share one clock.
 */
async function watchAsks(world: E2EWorld, stop: Promise<unknown>): Promise<AskSeen[]> {
  const seen = new Map<string, AskSeen>();
  let done = false;
  void stop.finally(() => (done = true));
  while (!done) {
    const out = await kubectl(world, ["get", "sandbox", "-l", `jr2.dev/run=${world.runId}`, "-o", "json"]).catch(
      () => '{"items":[]}',
    );
    const now = Date.now();
    type Item = { status?: { repos?: Array<{ lfs?: { asked: string; answered?: string; error?: string } }> } };
    for (const item of (JSON.parse(out) as { items: Item[] }).items) {
      for (const r of item.status?.repos ?? []) {
        if (!r.lfs?.asked) continue;
        const a = seen.get(r.lfs.asked) ?? { asked: r.lfs.asked };
        if (a.answeredSeenAt === undefined && r.lfs.answered && Date.parse(r.lfs.answered) >= Date.parse(a.asked)) {
          a.answeredSeenAt = now;
          a.error = r.lfs.error;
        }
        seen.set(a.asked, a);
      }
    }
    await sleep(200);
  }
  return [...seen.values()];
}

/** The seconds from each ask's mark to its answer, for each ask that `watchAsks` saw answered. */
const askSeconds = (asks: AskSeen[]): number[] =>
  asks.filter((a) => a.answeredSeenAt !== undefined).map((a) => (a.answeredSeenAt! - Date.parse(a.asked)) / 1000);

When(
  "the {string} workflow cuts the branch",
  { timeout: 2_400_000 },
  async function (this: E2EWorld, wf: string): Promise<void> {
    const s = lfsOf(this);
    const t: Record<string, number> = { ...s.times };
    const started = Date.now();
    let ready = started;
    await startWt(this, wf, { repo: s.url, branch: s.branch });
    // The attach gets the base's large files before it checks out default/, and only then does the
    // body open its first Gate.
    const attach = gateWithin(this, 1_500_000, (at) => (ready = at));
    const attachAsks = await watchAsks(
      this,
      attach.catch(() => undefined),
    );
    await attach;
    const attached = Date.now();
    t.attachAskMarkToAnswerSeconds = askSeconds(attachAsks).reduce((a, b) => a + b, 0);
    t.runToAttachedSeconds = (attached - started) / 1000;
    t.readyToAttachedSeconds = (attached - ready) / 1000;
    s.read = { base: await shaInPod(this, `/work/app/default/${s.base!.path}`) };
    const go = Date.now();
    await sendGate(this, "go");
    const cut = gateWithin(this, 900_000);
    const asks = await watchAsks(
      this,
      cut.catch(() => undefined),
    );
    await cut;
    t.cutWithAskSeconds = (Date.now() - go) / 1000;
    t.cutAskMarkToAnswerSeconds = Math.max(0, ...askSeconds(asks.filter((a) => Date.parse(a.asked) >= go)));
    s.read.cut = await shaInPod(this, `/work/app/lfs/${s.onBranch!.path}`);
    const look = Date.now();
    await sendGate(this, "look");
    const settled = await settledWithin(this, 900_000);
    t.cutWithNoAskSeconds = (Date.now() - look) / 1000;
    assert.equal(settled.status, "done", JSON.stringify(settled));
    s.out = (settled.context.output ?? {}) as LfsState["out"];
    s.times = t;
    console.log(`lfs timings (${s.name}): ${JSON.stringify(t)}`);
  },
);

When(
  "the Agent checks out the older commit in its Worktree",
  { timeout: 600_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = lfsOf(this);
    await startWt(this, "lfs-agent", { repo: s.url, branch: s.branch });
    await this.provider!.release("bash", {
      command: `git checkout -q --detach HEAD~1 && echo "smudged-$(sha256sum big.bin | cut -c1-64)"`,
    });
    const said = await toolResultWith(this, "smudged-");
    s.read = { cut: said.match(/smudged-([0-9a-f]{64})/)?.[1] ?? said };
    await this.provider!.release("finished", {});
    const settled = await settledWithin(this, 300_000);
    assert.equal(settled.status, "done", JSON.stringify(settled));
  },
);

When(
  "the Agent commits a new large file and the Machine pushes it",
  { timeout: 600_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = lfsOf(this);
    await startWt(this, "lfs-push", { repo: s.url, branch: s.branch });
    const size = 200_000;
    await this.provider!.release("bash", {
      command: [
        `head -c ${size} /dev/urandom > new.bin`,
        `git add new.bin`,
        `git -c user.name=e -c user.email=e@e commit -qm 'a new large file'`,
        `echo "added-$(sha256sum new.bin | cut -c1-64)-pointer-$(git cat-file -p HEAD:new.bin | grep -c '^oid sha256:')"`,
      ].join(" && "),
    });
    const said = await toolResultWith(this, "added-");
    const m = said.match(/added-([0-9a-f]{64})-pointer-(\d+)/);
    assert.ok(m, `the Agent's commit said what it added: ${said}`);
    assert.equal(m[2], "1", "the commit holds the large file's pointer, so the clean filter ran");
    s.onBranch = { path: "new.bin", object: { oid: m[1]!, size } };
    assert.equal(await lfsServerHolds(s.name, s.onBranch.object), false, "the server lacks the object before the push");
    await this.provider!.release("finished", {});
    const settled = await settledWithin(this, 300_000);
    assert.equal(settled.status, "done", JSON.stringify(settled));
    s.out = settled.context.output as LfsState["out"];
  },
);

// --- then ------------------------------------------------------------------------------------------

Then("the attach smudged the base's large file in default\\/", function (this: E2EWorld): void {
  const s = lfsOf(this);
  assert.equal(s.read?.base, s.base!.object.oid, `default/${s.base!.path} holds the object's bytes`);
});

Then(
  "the cut is ready, and its Worktree holds the large file's bytes and not its pointer",
  function (this: E2EWorld): void {
    const s = lfsOf(this);
    assert.equal(s.out?.first?.outcome, "ready", JSON.stringify(s.out));
    assert.equal(s.out?.first?.found, "remote", JSON.stringify(s.out));
    assert.equal(s.read?.cut, s.onBranch!.object.oid, `the Worktree's ${s.onBranch!.path} holds the object's bytes`);
    assert.equal(s.out?.second?.outcome, "ready", JSON.stringify(s.out));
  },
);

Then("the cut is refused, and its reason names the file", function (this: E2EWorld): void {
  const s = lfsOf(this);
  const first = s.out?.first;
  assert.equal(first?.outcome, "refused", JSON.stringify(s.out));
  assert.match(first?.reason ?? "", /the node cache cannot get the large file of [0-9a-f]{40}/, JSON.stringify(first));
  const named = `${s.onBranch!.path} (${s.onBranch!.object.oid.slice(0, 12)})`;
  assert.ok(first?.reason?.includes(named), `the reason names ${named}: ${first?.reason}`);
  // A refused cut changes no git: the next cut, of the base, is ready.
  assert.equal(s.out?.second?.outcome, "ready", JSON.stringify(s.out));
});

Then("the Agent's Worktree holds the older large file's bytes", function (this: E2EWorld): void {
  const s = lfsOf(this);
  assert.equal(s.read?.cut, s.older!.object.oid, "the checkout smudged the older commit's large file");
});

Then(
  "the push is pushed, the remote holds the branch, and the LFS server holds the object",
  async function (this: E2EWorld): Promise<void> {
    const s = lfsOf(this);
    const pushed = (s.out as { pushed?: { outcome?: string; published?: string; reason?: string } } | undefined)
      ?.pushed;
    assert.equal(pushed?.outcome, "pushed", JSON.stringify(s.out));
    assert.equal(await seedRepoTip(s.name, s.branch), pushed.published, "the remote holds the pushed commit");
    assert.ok(await lfsServerHolds(s.name, s.onBranch!.object), "the LFS server holds the new object");
  },
);

Then("the cold attach and the cut's ask are reported", async function (this: E2EWorld): Promise<void> {
  const s = lfsOf(this);
  assert.equal(s.read?.base, s.base!.object.oid, "the attach smudged the base's large files");
  assert.equal(s.out?.first?.outcome, "ready", JSON.stringify(s.out));
  assert.equal(s.read?.cut, s.onBranch!.object.oid, "the cut smudged the branch's large file");
  const node = (await kubectl(this, ["get", "pods", "-o", "jsonpath={.items[*].spec.nodeName}"])).split(" ")[0];
  const report = {
    coldMiB: s.coldMiB,
    cutMiB: Number(process.env.JR2_LFS_CUT_MB ?? 16),
    pieces: Math.ceil((s.coldMiB ?? 0) / 256),
    node,
    ...s.times,
  };
  mkdirSync(".tmp", { recursive: true });
  writeFileSync(`.tmp/lfs-measure-${s.coldMiB}.json`, JSON.stringify(report, null, 2));
  console.log(`lfs measure: ${JSON.stringify(report)}`);
});
