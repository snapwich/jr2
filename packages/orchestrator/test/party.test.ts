// One name for two parties (ADR-0015, ADR-0029), on the real RunHost: the payload-blind selection
// at delivery. An Agent's pick whose selection holds another party's writing is ANSWERED with
// `moved: false` and never reaches the Machine; a Gate's send the run would not take is refused 409
// with `acceptsNow`. The Allowed picks and `acceptsNow` ask the same question the same way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { NotTakenError } from "../src/registration.ts";
import type { AnyStateMachine } from "xstate";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { release, rooted } from "./_sent-by-author.ts";
import { partyHost, placeholder, post, receipt } from "./_party.ts";
import { payloadBelow, rootShape, s1, s2, s3, s4, s5, s8, twoGatesParallel, twoGatesPath } from "./_party-machines.ts";

test("S1 siblings: in review the Agent's approve is answered, not delivered; the reviewer's runs its own writing", async () => {
  const h = await partyHost((x) => s1(x.coder!));
  const r = await h.start();
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, ["approve", "ask_review"]);
  h.host.sendToAgent(r.iids.coder!, { type: "ask_review" });
  await r.until({ work: "review" });
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, [], "the Gate's approve is not the Agent's");
  const picks = h.feed.filter((e) => e.kind === "pick").length;
  const wrong = h.host.sendToAgent(r.iids.coder!, { type: "approve" });
  assert.deepEqual(receipt(wrong), { moved: false, turnComplete: false, allowed: [] });
  assert.equal(h.feed.filter((e) => e.kind === "pick").length, picks, "no pick marker: it never reached the Machine");
  assert.equal(await r.value(), JSON.stringify({ work: "review" }));
  assert.deepEqual((await r.context()).ran, []);
  h.host.sendToGate(r.runId, "review-1", { type: "approve" });
  await r.until("byReviewer");
  assert.deepEqual((await r.context()).ran, ["review"]);
});

test("S2 plain: the Agent's approve runs its own writing; the reviewer's is refused 409 while draft is active", async () => {
  const h = await partyHost((x) => s2(x.coder!, "plain"));
  const r = await h.start();
  assert.deepEqual(h.gateNow(r.runId), [{ gate: "review-1", accepts: ["approve", "tick"], acceptsNow: ["tick"] }]);
  const res = await post(h.app, `/runs/${r.runId}/gates/review-1/events`, { type: "approve" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error:
      `gate "review-1" is open, and the run does not take "approve" now: it would run the writing on ` +
      `"s2.release.work.draft", which is Agent "coder"'s — not delivered (takes now: tick)`,
    acceptsNow: ["tick"],
  });
  assert.deepEqual((await r.context()).ran, [], "the reviewer's send ran nothing — never (B)");
  const a = h.host.sendToAgent(r.iids.coder!, { type: "approve" });
  assert.deepEqual(receipt(a), { moved: true, turnComplete: true, allowed: [] });
  await r.until("doneB");
});

test("S2 marked (sentBy on the deeper writing): reviewer → (A), Agent → (B); in polishing the Agent's approve never runs (A)", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const r1 = await h.start();
  assert.deepEqual(h.gateNow(r1.runId), [
    { gate: "review-1", accepts: ["approve", "tick"], acceptsNow: ["approve", "tick"] },
  ]);
  h.host.sendToGate(r1.runId, "review-1", { type: "approve" });
  await r1.until("doneA");
  assert.deepEqual((await r1.context()).ran, ["A"]);

  const r2 = await h.start();
  assert.deepEqual(h.host.agentSurface(r2.iids.coder!)!.allowed, ["approve", "polish"]);
  const b = h.host.sendToAgent(r2.iids.coder!, { type: "approve" });
  assert.deepEqual(receipt(b), { moved: true, turnComplete: true, allowed: [] });
  await r2.until("doneB");
  assert.deepEqual((await r2.context()).ran, ["B"]);

  const r3 = await h.start();
  h.host.sendToAgent(r3.iids.coder!, { type: "polish" });
  await r3.until({ release: { work: "polishing" } });
  assert.deepEqual(h.host.agentSurface(r3.iids.coder!)!.allowed, ["revise"]);
  const p = h.host.sendToAgent(r3.iids.coder!, { type: "approve" });
  assert.deepEqual(receipt(p), { moved: false, turnComplete: false, allowed: ["revise"] });
  assert.deepEqual((await r3.context()).ran, [], "(A) is the Gate's: the Agent's approve never runs it");
});

test("S3 the name only above: the Agent's Menu lacks it; the reviewer's runs (A)", async () => {
  const h = await partyHost((x) => s3(x.coder!));
  const r = await h.start();
  const surface = h.host.agentSurface(r.iids.coder!)!;
  assert.deepEqual(
    surface.menu.map((m) => m.name),
    ["revise"],
  );
  assert.deepEqual(surface.allowed, ["revise"]);
  assert.throws(() => h.host.sendToAgent(r.iids.coder!, { type: "approve" }), /does not accept "approve"/);
  h.host.sendToGate(r.runId, "review-1", { type: "approve" });
  await r.until("doneA");
});

test("S4 one party's nested override: unchanged — the mode's cancel runs", async () => {
  const h = await partyHost((x) => s4(x.coder!));
  const r = await h.start();
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, ["cancel"]);
  h.host.sendToAgent(r.iids.coder!, { type: "cancel" });
  await r.until("discarded");
  assert.deepEqual((await r.context()).ran, ["draft"]);
});

test("S5 parallel plain: each sender is refused — one send never moves both regions", async () => {
  const h = await partyHost((x) => s5(x.coder!, "plain"));
  const r = await h.start();
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, []);
  assert.deepEqual(h.gateNow(r.runId)[0]!.acceptsNow, []);
  assert.equal(h.host.sendToAgent(r.iids.coder!, { type: "go" }).moved, false);
  assert.throws(() => h.host.sendToGate(r.runId, "review-1", { type: "go" }), NotTakenError);
  assert.equal(await r.value(), JSON.stringify({ r1: "a", r2: "a" }));
});

test("S5 parallel marked: the Agent's go moves r1 only; the reviewer's go moves r2 only", async () => {
  const h = await partyHost((x) => s5(x.coder!, "marked"));
  const r = await h.start();
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, ["go"]);
  assert.deepEqual(h.gateNow(r.runId)[0]!.acceptsNow, ["go"]);
  h.host.sendToAgent(r.iids.coder!, { type: "go" });
  await r.until({ r1: "b", r2: "a" });
  h.host.sendToGate(r.runId, "review-1", { type: "go" });
  await r.until({ r1: "b", r2: "b" });
  assert.deepEqual((await r.context()).ran, ["r1", "r2"]);
});

test("S6 audience any: plain, the reviewer may send approve but cannot take (B); marked routes each sender", async () => {
  const plain = await partyHost((x) => s2(x.coder!, "plain", { any: true }));
  const rp = await plain.start();
  assert.deepEqual(plain.gateNow(rp.runId)[0]!.acceptsNow, ["tick"]);
  assert.throws(() => plain.host.sendToGate(rp.runId, "review-1", { type: "approve" }), NotTakenError);

  const h = await partyHost((x) => s2(x.coder!, "marked", { any: true }));
  const r1 = await h.start();
  h.host.sendToGate(r1.runId, "review-1", { type: "approve" });
  await r1.until("doneA");
  const r2 = await h.start();
  h.host.sendToAgent(r2.iids.coder!, { type: "approve" });
  await r2.until("doneB");
  // `any` gives (A) to the Agent too: in polishing its approve runs (A).
  const r3 = await h.start();
  h.host.sendToAgent(r3.iids.coder!, { type: "polish" });
  await r3.until({ release: { work: "polishing" } });
  assert.deepEqual(h.host.agentSurface(r3.iids.coder!)!.allowed, ["approve", "revise"]);
  h.host.sendToAgent(r3.iids.coder!, { type: "approve" });
  await r3.until("doneA");
});

test("S7 the Machine's own raise carries no sender: sentBy passes it, and (B) runs by xstate's rule", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked", { raiseOnPoke: true }));
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "poke" });
  await r.until("doneB");
  assert.deepEqual((await r.context()).ran, ["B"]);
});

test("S8 a nested Agent: plain, the outer Agent's submit is answered and runs nothing; marked routes each Agent", async () => {
  const plain = await partyHost((x) => s8(x.coder!, x.reviewer!, "plain"), ["coder", "reviewer"]);
  const rp = await plain.start();
  assert.deepEqual(plain.host.agentSurface(rp.iids.coder!)!.allowed, [], "its submit would select the reviewer's");
  assert.equal(plain.host.sendToAgent(rp.iids.coder!, { type: "submit" }).moved, false);
  assert.deepEqual((await rp.context()).ran, []);

  const h = await partyHost((x) => s8(x.coder!, x.reviewer!, "marked"), ["coder", "reviewer"]);
  const r1 = await h.start();
  for (const slot of ["coder", "reviewer"]) {
    const surface = h.host.agentSurface(r1.iids[slot]!)!;
    assert.deepEqual(
      surface.menu.map((m) => m.name),
      ["submit"],
      `${slot}'s Menu does not widen`,
    );
    assert.deepEqual(surface.allowed, ["submit"]);
  }
  h.host.sendToAgent(r1.iids.coder!, { type: "submit" });
  await r1.until("outerDone");
  const r2 = await h.start();
  h.host.sendToAgent(r2.iids.reviewer!, { type: "submit" });
  await r2.until("innerDone");
});

test("the root-writing shape: plain, the reviewer cannot cancel while the mode writes it; marked, its cancel runs the root writing", async () => {
  const plain = await partyHost((x) => rootShape(x.coder!, "plain"));
  const rp = await plain.start();
  assert.deepEqual(plain.gateNow(rp.runId)[0]!.acceptsNow, ["approve"]);

  const h = await partyHost((x) => rootShape(x.coder!, "marked"));
  const r1 = await h.start();
  assert.deepEqual(h.gateNow(r1.runId)[0]!.acceptsNow, ["cancel", "approve"]);
  h.host.sendToGate(r1.runId, "review-1", { type: "cancel" });
  await r1.until("cancelled");
  assert.deepEqual((await r1.context()).ran, ["root"]);
  const r2 = await h.start();
  h.host.sendToAgent(r2.iids.coder!, { type: "cancel" });
  await r2.until("discarded");
  assert.deepEqual((await r2.context()).ran, ["draft"]);
});

test("S9 the event an author's action reads is its own payload plus `sender`", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const r = await h.start();
  h.host.sendToGate(r.runId, "review-1", { type: "approve", note: "lgtm" });
  await r.until("doneA");
  assert.deepEqual((await r.context()).last, {
    type: "approve",
    note: "lgtm",
    sender: { party: "gate", id: "review-1" },
  });
  // The config keeps the author's guard object; jr2 added only the guard-map entry.
  const m = s2(placeholder("coder"), "marked");
  const draft = (
    m.config as {
      states: { release: { states: { work: { states: { draft: { on: { approve: { guard: unknown } } } } } } } };
    }
  ).states.release.states.work.states.draft;
  assert.deepEqual(draft.on.approve.guard, { type: "jr2.sentBy", params: { id: "coder" } });
});

test("S10 GET /runs/:id lists acceptsNow beside the whole accepts; the gates route answers { ok: true } only when the run took it", async () => {
  const h = await partyHost((x) => s2(x.coder!, "marked"));
  const r = await h.start();
  const run = (await (await h.app.request(`/runs/${r.runId}`)).json()) as {
    gates: Array<{ gate: string; accepts: Array<{ name: string }>; acceptsNow: string[] }>;
  };
  assert.deepEqual(
    run.gates.map((g) => ({ gate: g.gate, accepts: g.accepts.map((a) => a.name), acceptsNow: g.acceptsNow })),
    [{ gate: "review-1", accepts: ["approve", "tick"], acceptsNow: ["approve", "tick"] }],
  );
  const ok = await post(h.app, `/runs/${r.runId}/gates/review-1/events`, { type: "approve" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  await r.until("doneA");
});

test("a Gate send no writing would take with its payload is refused 409, never { ok: true, moved: false }", async () => {
  const hold = defineEvent({ name: "hold", input: z.object({ until: z.string().optional() }) });
  const release = defineEvent({ name: "release", input: z.object({}) });
  const h = await partyHost(
    () =>
      jr2Setup({ events: [hold, release] }).createMachine({
        id: "held",
        initial: "board",
        states: {
          board: {
            invoke: { src: "gate", id: "board" },
            on: { hold: { target: "done", guard: ({ event }) => event.until !== undefined }, release: "done" },
          },
          done: { type: "final" },
        },
      }),
    [],
  );
  const r = await h.start();
  const res = await post(h.app, `/runs/${r.runId}/gates/board/events`, { type: "hold" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error:
      `gate "board" is open, and the run does not take "hold" now: no writing of it would move the run with ` +
      `this payload — not delivered (takes now: hold, release)`,
    acceptsNow: ["hold", "release"],
  });
  assert.equal(await r.value(), JSON.stringify("board"));
  assert.equal((await post(h.app, `/runs/${r.runId}/gates/board/events`, { type: "hold", until: "noon" })).status, 200);
  await r.until("done");
});

test("a Gate's payload that turns selection outward to another party's writing is refused 409, naming that writing", async () => {
  // `review`'s writing reads the payload; for "hold" it declines, and selection moves out to
  // `work`'s writing, which is the Agent's.
  const h = await partyHost((x) => payloadBelow(x.coder!));
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "ask" });
  await r.until({ work: "review" });
  const res = await post(h.app, `/runs/${r.runId}/gates/review-1/events`, { type: "approve", note: "hold" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; acceptsNow: string[] };
  assert.match(
    body.error,
    /does not take "approve" now: it would run the writing on "fo\.work", which is Agent "coder"'s/,
  );
  assert.deepEqual(body.acceptsNow, ["approve"], "payload-blind: the name is taken now; this payload is not");
  assert.equal(await r.value(), JSON.stringify({ work: "review" }));
  h.host.sendToGate(r.runId, "review-1", { type: "approve", note: "ship" });
  await r.until("byGate");
});

test("S11 with sentBy each party's name maps to its own writings; the Agent cannot ship through the Gate's writing", async () => {
  // `work` (the Agent's) and its Gate child both write `approve`, the child's behind a payload guard.
  // The payload guard is UNKNOWN to the payload-blind selection, so the child's writing is
  // selected, and it is not the Agent's: not Allowed, and the Agent's approve with the Gate's
  // payload is answered, not delivered.
  const h = await partyHost((x) => payloadBelow(x.coder!));
  const r = await h.start();
  h.host.sendToAgent(r.iids.coder!, { type: "ask" });
  await r.until({ work: "review" });
  assert.deepEqual(h.host.agentSurface(r.iids.coder!)!.allowed, ["ask"]);
  const ship = h.host.sendToAgent(r.iids.coder!, { type: "approve", note: "ship" });
  assert.equal(ship.moved, false);
  assert.equal(await r.value(), JSON.stringify({ work: "review" }));
});

test("two Gates on one path: plain, the outer caller is refused while the inner Gate is open; marked routes each caller", async () => {
  const plain = await partyHost(() => twoGatesPath("plain"), []);
  const rp = await plain.start();
  assert.throws(() => plain.host.sendToGate(rp.runId, "outer", { type: "approve" }), /Gate "inner"'s/);

  const h = await partyHost(() => twoGatesPath("marked"), []);
  const r1 = await h.start();
  h.host.sendToGate(r1.runId, "outer", { type: "approve" });
  await r1.until("doneA");
  const r2 = await h.start();
  h.host.sendToGate(r2.runId, "inner", { type: "approve" });
  await r2.until("doneC");
});

test("two Gates in parallel regions: plain refuses both callers (one never moves both); marked moves each its own region", async () => {
  const plain = await partyHost(() => twoGatesParallel("plain"), []);
  const rp = await plain.start();
  assert.throws(() => plain.host.sendToGate(rp.runId, "left", { type: "approve" }), NotTakenError);
  assert.equal(await rp.value(), JSON.stringify({ left: "a", right: "a" }));

  const h = await partyHost(() => twoGatesParallel("marked"), []);
  const r = await h.start();
  h.host.sendToGate(r.runId, "left", { type: "approve" });
  await r.until({ left: "b", right: "a" });
  h.host.sendToGate(r.runId, "right", { type: "approve" });
  await r.until({ left: "b", right: "b" });
});

test("the walk's party warnings over the scenarios: each plain shape that shadows a seat warns; marked, none", () => {
  const party = (m: AnyStateMachine) => loadWarningsOf(m).filter((w) => w.includes("can be active together"));
  const coder = placeholder("coder");
  const reviewer = placeholder("reviewer");
  assert.deepEqual(
    {
      s1: party(s1(coder)).length,
      s2plain: party(s2(coder, "plain")).length,
      s2marked: party(s2(coder, "marked")).length,
      s3: party(s3(coder)).length,
      s4: party(s4(coder)).length,
      s5plain: party(s5(coder, "plain")).length,
      s5marked: party(s5(coder, "marked")).length,
      s6plain: party(s2(coder, "plain", { any: true })).length,
      s8plain: party(s8(coder, reviewer, "plain")).length,
      s8marked: party(s8(coder, reviewer, "marked")).length,
      rootPlain: party(rootShape(coder, "plain")).length,
      rootMarked: party(rootShape(coder, "marked")).length,
      twoGatesPath: party(twoGatesPath("plain")).length,
      twoGatesPathMarked: party(twoGatesPath("marked")).length,
      twoGatesParallel: party(twoGatesParallel("plain")).length,
      twoGatesParallelMarked: party(twoGatesParallel("marked")).length,
      payloadBelow: party(payloadBelow(coder)).length,
      author: party(release).length + party(rooted).length,
    },
    {
      s1: 0,
      s2plain: 1,
      s2marked: 0,
      s3: 0,
      s4: 0,
      s5plain: 2,
      s5marked: 0,
      s6plain: 1,
      s8plain: 1,
      s8marked: 0,
      rootPlain: 1,
      rootMarked: 0,
      twoGatesPath: 1,
      twoGatesPathMarked: 0,
      twoGatesParallel: 2,
      twoGatesParallelMarked: 0,
      payloadBelow: 1,
      author: 0,
    },
  );
  // S3 keeps ADR-0015's Gate-above warning: the Agent below cannot send the Gate's `approve`.
  assert.ok(
    loadWarningsOf(s3(coder)).some((w) => /Agent "coder" on "s3\.release\.work" cannot send "approve"/.test(w)),
  );
  assert.deepEqual(party(s2(coder, "plain")), [
    `"approve" on "s2.release" (Gate "review-1") and on "s2.release.work.draft" (Agent "coder") can be active ` +
      `together; Gate "review-1"'s "approve" would run Agent "coder"'s writing, so jr2 refuses it while both are ` +
      `active. Make the deeper writing decline other senders:\n` +
      `  draft: { on: { approve: { guard: sentBy("coder"), target: "#s2.doneB" } } }`,
  ]);
});

test("a Gate takes the writings of its state's plain children: they are in its accepts, and its caller's send runs them", async () => {
  const [approve, comment] = ["approve", "comment"].map((name) => defineEvent({ name, input: z.object({}) }));
  const h = await partyHost(
    () =>
      jr2Setup({ types: {} as { context: { ran: string[] } }, events: [approve!, comment!] }).createMachine({
        id: "rv",
        context: { ran: [] },
        initial: "review",
        states: {
          review: {
            invoke: { src: "gate", id: "board" },
            on: { approve: "done" },
            initial: "drafting",
            states: { drafting: { on: { comment: { target: "commented" } } }, commented: {} },
          },
          done: { type: "final" },
        },
      }),
    [],
  );
  const r = await h.start();
  assert.deepEqual(h.gateNow(r.runId), [
    { gate: "board", accepts: ["approve", "comment"], acceptsNow: ["approve", "comment"] },
  ]);
  h.host.sendToGate(r.runId, "board", { type: "comment" });
  await r.until({ review: "commented" });
  assert.deepEqual(h.gateNow(r.runId)[0]!.acceptsNow, ["approve"]);
});
