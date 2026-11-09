// The Handoff loop in real pods (ADR-0080): the `handoff` workflow (`kind-instance/workflows/handoff.ts`)
// against a per-scenario LFS repository of the seed over ssh, which both Workspaces bind and the
// deploy key pushes to. Each Agent is the scripted model: a coder and a quick reviewer in the
// parent's Sandbox, and a final reviewer in each nested Workspace. The coder and the quick reviewer
// share one Menu, so each release names the Agent by a phrase of its instructions.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { repoIdentity } from "@jr2/orchestrator/internal";
import { isSettled } from "../lib/run-settled.ts";
import { startWt, toolResultWith, wsStatus, type WsStatus } from "./kind.steps.ts";
import { ensureLfsServer, lfsSeedRepo, lfsServerHolds, makeLfsObjects, seedRepoTip, type LfsObject } from "./seed.ts";
import type { E2EWorld } from "./world.ts";

const CODER = "You are the coder.";
const QUICK = "You are the quick reviewer.";
const FINAL = "You are the final reviewer of one branch.";
/** A nested Workspace's first Turn comes after its Sandbox is up and its cut is done. */
const NESTED_MS = 600_000;

type Handoff = { slot: string; path: string; branch: string | null; head: string };
type PushOut = { outcome?: string; published?: string; reason?: string };
type FinalOut = { verdict: string; notes?: string; reason?: string; pushed?: PushOut };
type Output = { rounds?: Array<{ handoff: Handoff; out: FinalOut }>; pushed?: PushOut };

/** What a final reviewer's bash read of its Worktree. */
type View = {
  branch: string;
  upstream: string;
  head: string;
  remotes: string;
  fetchUrl: string;
  pushUrl: string;
  /** How many rounds' marks the clone held before this round's. */
  marks: string;
  refs: string[];
  log: string[];
  lfs: string;
  status: string;
};

type HandoffState = {
  name: string;
  url: string;
  branch: string;
  /** Does the remote have the branch before the run? */
  remoteBranch: boolean;
  main: string;
  /** The coder's large file. */
  big?: LfsObject;
  /** The LFS server held the coder's large file before any push. */
  heldBeforePush?: boolean;
  /** Each final reviewer's view, by round. */
  views: View[];
  /** The coder's last commit: in mode "forged" the one that it names, in mode "parent" the one after the review. */
  named?: string;
  settled?: WsStatus;
  out?: Output;
};

const states = new WeakMap<E2EWorld, HandoffState>();
function stateOf(world: E2EWorld): HandoffState {
  const s = states.get(world);
  assert.ok(s, "a step made this scenario's repository");
  return s;
}

async function makeRepo(world: E2EWorld, remoteBranch: boolean): Promise<void> {
  await ensureLfsServer();
  const name = `lfs-handoff-${randomBytes(4).toString("hex")}`;
  const [base, side] = await makeLfsObjects(name, [64 * 1024, 32 * 1024]);
  const branch = `fix-${name.slice(-8)}`;
  const { url, main } = await lfsSeedRepo(
    name,
    { main: [{ "big.bin": base! }], ...(remoteBranch ? { branches: { [branch]: { "side.bin": side! } } } : {}) },
    "ssh",
  );
  states.set(world, { name, url, branch, remoteBranch, main: main.at(-1)!, views: [] });
}

Given(
  "an LFS repository over ssh for the Handoff loop, whose branch the remote has",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await makeRepo(this, true);
  },
);

Given(
  "an LFS repository over ssh for the Handoff loop, whose branch the remote does not have",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    await makeRepo(this, false);
  },
);

// --- the Agents' moves -----------------------------------------------------------------------------

/** The coder commits a file, and on its first commit a new large file too. */
async function code(world: E2EWorld, subject: string, withBig = false): Promise<void> {
  const s = stateOf(world);
  const file = subject.replace(/ /g, "-");
  const marker = `coded-${file}`;
  await world.provider!.release(
    "bash",
    {
      command: [
        `printf '${subject}\\n' > ${file}.txt`,
        ...(withBig ? ["head -c 200000 /dev/urandom > new.bin", "git add new.bin"] : []),
        `git add ${file}.txt`,
        `git -c user.name=coder -c user.email=coder@jr2.test commit -qm '${subject}'`,
        `echo "${marker}-$(git rev-parse HEAD)-$(sha256sum new.bin | cut -c1-64)"`,
      ].join(" && "),
    },
    { saying: CODER },
  );
  const said = await toolResultWith(world, `${marker}-`);
  const m = new RegExp(`${marker}-([0-9a-f]{40})-([0-9a-f]{64})`).exec(said);
  assert.ok(m, `the coder's commit said what it made: ${said}`);
  if (withBig) {
    s.big = { oid: m[2]!, size: 200_000 };
    s.heldBeforePush = await lfsServerHolds(s.name, s.big);
  }
  s.named = m[1];
}

/** The final reviewer of round `round` reads its Worktree with ordinary git. */
async function look(world: E2EWorld, round: number): Promise<View> {
  const s = stateOf(world);
  const p = `view-r${round}`;
  await world.provider!.release(
    "bash",
    {
      command: [
        `echo "${p} branch=$(git branch --show-current)"`,
        `echo "${p} upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo none)"`,
        `echo "${p} head=$(git rev-parse HEAD)"`,
        `echo "${p} remotes=$(git remote | tr '\\n' ' ')"`,
        `echo "${p} fetchurl=$(git remote get-url origin)"`,
        `echo "${p} pushurl=$(git remote get-url --push origin)"`,
        // A mark in the clone: a new Sandbox has a new clone, so no round finds the mark of the last.
        `echo "${p} marks=$(ls "$(git rev-parse --git-common-dir)"/e2e-round-* 2>/dev/null | wc -l)"`,
        `touch "$(git rev-parse --git-common-dir)/e2e-round-${round}"`,
        `git for-each-ref --format='${p} ref %(refname)'`,
        `git log --format='${p} log %an %s' origin/main..HEAD`,
        `echo "${p} lfs=$(sha256sum new.bin 2>&1 | cut -c1-64)"`,
        `echo "${p} status=$(git status --porcelain | wc -l)"`,
        `echo "${p} end"`,
      ].join("; "),
    },
    { saying: FINAL, ms: NESTED_MS },
  );
  const said = await toolResultWith(world, `${p} end`);
  const lines = said
    .split("\n")
    .filter((l) => l.startsWith(`${p} `))
    .map((l) => l.slice(p.length + 1));
  const one = (key: string) =>
    lines
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() ?? "";
  const view: View = {
    branch: one("branch"),
    upstream: one("upstream"),
    head: one("head"),
    remotes: one("remotes"),
    fetchUrl: one("fetchurl"),
    pushUrl: one("pushurl"),
    marks: one("marks"),
    refs: lines.filter((l) => l.startsWith("ref ")).map((l) => l.slice(4)),
    log: lines.filter((l) => l.startsWith("log ")).map((l) => l.slice(4)),
    lfs: one("lfs"),
    status: one("status"),
  };
  s.views[round - 1] = view;
  return view;
}

async function settle(world: E2EWorld): Promise<void> {
  const s = stateOf(world);
  let last: WsStatus | undefined;
  for (const deadline = Date.now() + 900_000; Date.now() < deadline; await sleep(1000)) {
    last = await wsStatus(world);
    if (isSettled(last.status)) break;
  }
  assert.ok(last && isSettled(last.status), `the run did not settle: ${JSON.stringify(last)}`);
  assert.equal(last.status, "done", JSON.stringify(last));
  s.settled = last;
  s.out = last.context.output as Output;
}

/** The coder makes its first commit, the quick reviewer asks for one change, and then passes it. */
async function quickLoop(world: E2EWorld): Promise<void> {
  const provider = world.provider!;
  await code(world, "fix one", true);
  await provider.release("finished", {}, { saying: CODER });
  await provider.release("fix_this", { notes: "name the fix in a second file" }, { saying: QUICK });
  await code(world, "fix two");
  await provider.release("finished", {}, { saying: CODER });
  await provider.release("looks_good", {}, { saying: QUICK });
}

When(
  "the coder and the quick reviewer loop, a final reviewer asks for changes, a new final reviewer passes the new commit, and the coder commits again",
  { timeout: 2_400_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    const provider = this.provider!;
    await startWt(this, "handoff", { repo: s.url, branch: s.branch, mode: "parent" });
    await quickLoop(this);
    await look(this, 1);
    await provider.release("revise", { notes: "round-one-notes: add a test" }, { saying: FINAL });
    await code(this, "add a test");
    await provider.release("finished", {}, { saying: CODER });
    await provider.release("looks_good", {}, { saying: QUICK });
    await look(this, 2);
    await provider.release("pass", {}, { saying: FINAL });
    // After the review, the coder commits once more: the pin publishes the reviewed commit, not this one.
    await code(this, "after the review");
    await provider.release("finished", {}, { saying: CODER });
    await settle(this);
  },
);

When(
  "the coder and the quick reviewer loop, and the final reviewer passes the commit in the nested Workspace, which pushes it",
  { timeout: 2_400_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    await startWt(this, "handoff", { repo: s.url, branch: s.branch, mode: "child" });
    await quickLoop(this);
    await look(this, 1);
    await this.provider!.release("pass", {}, { saying: FINAL });
    await settle(this);
  },
);

When(
  "the coder names a commit that no cut read, and the parent hands off that head, and then the branch main",
  { timeout: 2_400_000 },
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    const provider = this.provider!;
    await startWt(this, "handoff", { repo: s.url, branch: s.branch, mode: "forged" });
    await code(this, "fix one", true);
    await provider.release("finished", {}, { saying: CODER });
    await provider.release("looks_good", {}, { saying: QUICK });
    // After the read, the coder commits once more and names that commit in its pick.
    await code(this, "after the read");
    await provider.release("finished", { head: s.named }, { saying: CODER });
    await settle(this);
  },
);

// --- then ------------------------------------------------------------------------------------------

/** Each ref of a final reviewer's clone is a branch of the Handoff or of the remote, or a tag. */
function assertOrdinary(s: HandoffState, view: View, handoff: Handoff, round: number): void {
  const at = `round ${round}: ${JSON.stringify(view)}`;
  assert.equal(view.branch, s.branch, `the branch has the parent's name: ${at}`);
  assert.equal(view.head, handoff.head, `the Worktree is at the Handoff's commit: ${at}`);
  assert.equal(view.remotes, "origin", `origin is the only remote: ${at}`);
  // origin is the real remote: it fetches through the node cache, by the Binding's identity, and pushes to the url.
  assert.equal(
    view.fetchUrl,
    `ext::/opt/jr2/bin/jr2-upload-pack %S ${repoIdentity(s.url).identity}`,
    `origin fetches through the node cache: ${at}`,
  );
  assert.equal(view.pushUrl, s.url, `origin pushes to the remote: ${at}`);
  assert.equal(view.status, "0", `the Worktree is clean: ${at}`);
  const allowed = new RegExp(`^refs/(heads/(main|${s.branch})|remotes/origin/(HEAD|main|${s.branch})|tags/.+)$`);
  const stray = view.refs.filter((r) => !allowed.test(r));
  assert.deepEqual(stray, [], `no stray refs: ${at}`);
  assert.ok(view.refs.includes(`refs/heads/${s.branch}`), `the branch is a local branch: ${at}`);
  assert.ok(
    view.log.some((l) => l === "coder fix one") && view.log.some((l) => l === "coder fix two"),
    `git log shows the parent's commits with their author: ${at}`,
  );
}

Then(
  "each final reviewer saw ordinary git: the parent's branch, tracking origin's, at the Handoff's commit, with the parent's commits and only origin",
  function (this: E2EWorld): void {
    const s = stateOf(this);
    const rounds = s.out?.rounds ?? [];
    assert.equal(rounds.length, 2, JSON.stringify(s.out));
    rounds.forEach((r, i) => {
      assertOrdinary(s, s.views[i]!, r.handoff, i + 1);
      assert.equal(
        s.views[i]!.upstream,
        `origin/${s.branch}`,
        `the branch tracks origin's: ${JSON.stringify(s.views[i])}`,
      );
    });
    assert.ok(s.views[1]!.log.includes("coder add a test"), JSON.stringify(s.views[1]));
  },
);

Then(
  "the final reviewer saw ordinary git: the parent's branch with no upstream, at the Handoff's commit, with the parent's commits and only origin",
  function (this: E2EWorld): void {
    const s = stateOf(this);
    const rounds = s.out?.rounds ?? [];
    assert.equal(rounds.length, 1, JSON.stringify(s.out));
    assertOrdinary(s, s.views[0]!, rounds[0]!.handoff, 1);
    assert.equal(s.views[0]!.upstream, "none", `the remote has no such branch: ${JSON.stringify(s.views[0])}`);
  },
);

Then(
  "the coder's large file reached each nested Workspace with its bytes, while no LFS server held it",
  function (this: E2EWorld): void {
    const s = stateOf(this);
    assert.ok(s.big, "the coder committed a large file");
    assert.equal(s.heldBeforePush, false, "the LFS server did not hold the coder's large file");
    for (const [i, view] of s.views.entries()) {
      assert.equal(
        view.lfs,
        s.big.oid,
        `round ${i + 1}: new.bin holds the large file's bytes: ${JSON.stringify(view)}`,
      );
    }
  },
);

Then(
  "the second round ran in a new Sandbox, at a new Handoff, with the first round's notes",
  function (this: E2EWorld): void {
    const s = stateOf(this);
    const [one, two] = s.out!.rounds!;
    assert.equal(one!.out.verdict, "revise", JSON.stringify(one));
    assert.equal(two!.out.verdict, "pass", JSON.stringify(two));
    assert.notEqual(two!.handoff.head, one!.handoff.head, "the second round has the coder's new commit");
    // The two rounds' Sandboxes have one name (the invoke's actor path), and the second is new.
    assert.deepEqual(
      s.views.map((v) => v.marks),
      ["0", "0"],
      "each round's clone is new: no round finds the mark of the last",
    );
    const notes = this.provider!.calls.filter(
      (c) => c.stream && c.raw.includes(FINAL) && c.raw.includes("Your notes of round 1"),
    );
    assert.ok(
      notes.some((c) => c.raw.includes("round-one-notes: add a test")),
      "the second final reviewer's prompt holds the first round's notes",
    );
  },
);

Then(
  "the parent pushed exactly the reviewed commit and not the coder's later commit, and the LFS server holds the large file",
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    const reviewed = s.out!.rounds!.at(-1)!.handoff.head;
    const pushed = s.out!.pushed;
    assert.ok(s.named && s.named !== reviewed, `the coder committed after the review: ${s.named}`);
    assert.equal(pushed?.outcome, "pushed", JSON.stringify(s.out));
    assert.equal(pushed.published, reviewed, "the pin published the reviewed commit");
    assert.equal(
      await seedRepoTip(s.name, s.branch),
      reviewed,
      "the remote's branch is at the reviewed commit, not at the coder's later commit",
    );
    assert.ok(await lfsServerHolds(s.name, s.big!), "the push uploaded the large file");
  },
);

Then(
  "the nested Workspace pushed the Handoff's commit, and the LFS server holds the large file",
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    const round = s.out!.rounds![0]!;
    assert.equal(round.out.verdict, "pass", JSON.stringify(round));
    assert.equal(round.out.pushed?.outcome, "pushed", JSON.stringify(round));
    assert.equal(round.out.pushed.published, round.handoff.head, "the nested push published the Handoff's commit");
    assert.equal(s.out!.pushed, undefined, "the parent pushed nothing");
    assert.equal(await seedRepoTip(s.name, s.branch), round.handoff.head, "the remote's branch is at the commit");
    assert.ok(await lfsServerHolds(s.name, s.big!), "the nested push uploaded the large file from its own clone");
  },
);

Then(
  "each nested cut is refused with its reason, the nested body routes it, and main on the remote did not move",
  async function (this: E2EWorld): Promise<void> {
    const s = stateOf(this);
    const rounds = s.out?.rounds ?? [];
    assert.equal(rounds.length, 2, JSON.stringify(s.out));
    const [byHead, byBranch] = rounds;
    assert.equal(byHead!.handoff.head, s.named, "the first forged Handoff names the coder's word");
    assert.equal(byHead!.out.verdict, "refused", JSON.stringify(byHead));
    assert.match(byHead!.out.reason ?? "", /no ready cut of this run made that commit at that path/);
    assert.equal(byBranch!.handoff.branch, "main", JSON.stringify(byBranch));
    assert.equal(byBranch!.out.verdict, "refused", JSON.stringify(byBranch));
    assert.ok(byBranch!.out.reason?.includes(`the cut made it on ${s.branch}, not on main`), JSON.stringify(byBranch));
    assert.equal(await seedRepoTip(s.name, "main"), s.main, "main on the remote did not move");
    assert.equal(await seedRepoTip(s.name, s.branch), "", "nothing published the branch");
  },
);
