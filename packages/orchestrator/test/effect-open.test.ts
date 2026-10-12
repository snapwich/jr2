// An Effect's Open parts (ADR-0054, design 2): a packaged Machine leaves an http url, or a
// command's argv, `open`; the composer binds it once with `customize(machine, { effects })`, through
// `workspace()` and `pool()` as `agents` goes; `jr2 up`'s walk sees the bound part as one the author
// wrote — the placement, the secrets, the Effector's fence — and reports the part nothing bound.
//
// The claims, in order: an Open part is carried and reported, never guessed; binding builds the
// Effect again, whole, so every check of a written Effect holds for a bound one; the original is
// untouched; only an Open part is bound, to a value, once; the wrappers are transparent; the walk
// reads the bound host, the secrets its url names and the argv; the load walk's pick-param check
// runs again on a bound argv; and a run of an Effect nobody bound faults before anything is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { customize } from "../src/customize.ts";
import { arg, commandWith, isEffect } from "../src/effect.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import { bearer, file, httpWith, secret, text } from "../src/http-effect.ts";
import { binderOf } from "../src/open-effect.ts";
import { open, partsOf, workspacePodsOf, customizeLine } from "../src/parts.ts";
import { pool, source } from "../src/pool.ts";
import { fromPick } from "../src/pick.ts";
import { RunHost } from "../src/run-host.ts";
import { secretPlacementsOf } from "../src/secret-placement.ts";
import { httpFileWith } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { FakeHarnessExec } from "./_effects.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { agentActorWith } from "../src/actor.ts";

const fake = new FakeEffector();
const ports = (target: { key: string | Buffer }) =>
  createEffectorClient({ key: target.key, transport: fake.transport });
const execs = new FakeHarnessExec();

/** The http Effect a package ships: the host is the Instance's, so the url is Open. */
const comment = () =>
  httpWith(ports, {
    method: "POST",
    url: open,
    auth: bearer(secret("tracker-token")),
    input: z.object({ key: z.string(), body: z.string() }),
    request: ({ key, body }) => ({ path: [key, "comment"], json: { body } }),
  });

/** A package's Machine: one Open http Effect, one Open command, one fixed command. */
function notifier() {
  return jr2Setup({
    events: [],
    actors: {
      comment: comment(),
      deploy: commandWith(execs.factory, open),
      lint: commandWith(execs.factory, ["pnpm", "lint"]),
    },
  }).createMachine({ id: "notifier", initial: "idle", states: { idle: {} } });
}

const slotAt = (machine: unknown, slot: string): unknown =>
  (machine as { implementations: { actors: Record<string, unknown> } }).implementations.actors[slot];

const spec = () => ({ branch: "feat-1" });
const repos = { app: "https://example.test/app.git" };

test("an Open url or argv is carried with the sentinel, and the walk reports it — no target, no argv guessed", () => {
  const parts = partsOf([notifier()]);
  assert.deepEqual(parts.openEffects, [
    { slot: "comment", path: [], part: "url" },
    { slot: "deploy", path: [], part: "argv" },
  ]);
  const byName = Object.fromEntries(parts.effects.map((e) => [e.name, e]));
  // Placement is the kind's, so it is known before the part is bound; the secrets its auth names too.
  assert.deepEqual(byName.comment, {
    name: "comment",
    path: [],
    route: [],
    kind: "http",
    placement: "instance",
    method: "POST",
    open: "url",
    secrets: ["tracker-token"],
    idempotent: false,
    timeoutMs: 30_000,
  });
  assert.equal(byName.deploy?.kind, "command");
  assert.deepEqual((byName.deploy as { argv: string[] }).argv, ["<open>"]);
  assert.equal((byName.deploy as { open?: string }).open, "argv");
  assert.equal(byName.lint && "open" in byName.lint, false, "a part the author fixed is not reported");
});

test("binding builds the Effect again, whole: the bound host, its secrets, the bound argv — and the original is untouched", () => {
  const stock = notifier();
  const bound = customize(stock, {
    effects: {
      comment: { url: text`https://tracker.example.com/api/${secret("tracker-path")}/issue` },
      deploy: { argv: ["make", "deploy", arg("env")] },
    },
  });
  const byName = Object.fromEntries(partsOf([bound]).effects.map((e) => [e.name, e]));
  assert.deepEqual((byName.comment as { target?: unknown }).target, {
    scheme: "https",
    host: "tracker.example.com",
    port: 443,
  });
  // The secret the bound url names is a secret the Effect names: it joins the auth's.
  assert.deepEqual((byName.comment as { secrets: string[] }).secrets, ["tracker-path", "tracker-token"]);
  assert.deepEqual((byName.deploy as { argv: string[] }).argv, ["make", "deploy", "<env>"]);
  assert.deepEqual(partsOf([bound]).openEffects, []);
  // The fixed command keeps its very logic object: nothing is rebuilt that was not named.
  assert.equal(slotAt(bound, "lint"), slotAt(stock, "lint"));
  // The original still carries both Open parts: two customizations of one import are two Machines.
  assert.equal(partsOf([stock]).openEffects.length, 2);
  assert.equal(binderOf(slotAt(bound, "comment")), undefined, "a bound Effect has no binder: it is bound once");
});

test("a bound url meets every check a written one meets: a literal host, no secret in its query", () => {
  assert.throws(
    () => customize(notifier(), { effects: { comment: { url: text`https://${secret("host")}/api` } } }),
    /scheme and host are literal/,
  );
  assert.throws(
    () => customize(notifier(), { effects: { comment: { url: text`https://t.example.com/x?k=${secret("k")}` } } }),
    /query or fragment/,
  );
  assert.throws(() => customize(notifier(), { effects: { deploy: { argv: [] } } }), /argv is a non-empty list/);
});

test("only an Open part is bound, to a value, once — a fixed part, a wrong key, `open` again and a mapper are refused", () => {
  const loose = customize as (m: unknown, p: unknown) => unknown;
  assert.throws(
    () => loose(notifier(), { effects: { lint: { argv: ["pnpm", "test"] } } }),
    /"lint" of machine "notifier" leaves nothing Open — its parts are fixed in its definition/,
  );
  assert.throws(
    () => loose(notifier(), { effects: { comment: { argv: ["x"] } } }),
    /leaves its url Open — bind it with \{ url: "https:\/\/<host>\/<path>" \}/,
  );
  assert.throws(
    () => loose(notifier(), { effects: { comment: { url: () => "https://per-run.example.com" } } }),
    /bound once, to a value — not a function of the run/,
  );
  assert.throws(() => loose(notifier(), { effects: { comment: { url: open } } }), /not `open` again/);
  assert.throws(
    () => loose(notifier(), { effects: { nope: { url: "https://x.example.com" } } }),
    /no Effect slot "nope"/,
  );
  // Bound once: a second customize of the bound Machine finds nothing Open there.
  const once = customize(notifier(), { effects: { comment: { url: "https://a.example.com" } } });
  assert.throws(() => loose(once, { effects: { comment: { url: "https://b.example.com" } } }), /leaves nothing Open/);
});

test("workspace() and pool() are transparent: an Effect in the body is bound without naming `body` or `worker`", () => {
  const body = jr2Setup({
    events: [],
    actors: { deploy: commandWith(execs.factory, open, {}), comment: comment() },
  }).createMachine({ id: "body", initial: "idle", states: { idle: {} } });
  const wrapped = workspace(body, { repos, spec });
  const wake = defineEvent({ name: "work_ready", input: z.object({}) });
  const pooled = pool(wrapped, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake,
    }),
    itemId: (i) => i.id,
  });

  for (const machine of [wrapped, pooled]) {
    assert.deepEqual(
      partsOf([machine]).openEffects.map((o) => [o.slot, o.path, o.part]),
      [
        ["deploy", [], "argv"],
        ["comment", [], "url"],
      ],
      "the route omits the wrappers, as customize() omits them",
    );
    const bound = customize(machine, {
      effects: { deploy: { argv: ["./release.sh"] }, comment: { url: "https://t.example.com/api" } },
    });
    const carried = partsOf([bound]);
    assert.deepEqual(carried.openEffects, []);
    assert.deepEqual(
      carried.effects.map((e) => (e.kind === "command" ? e.argv : e.kind === "http" ? e.target?.host : undefined)),
      [["./release.sh"], "t.example.com"],
    );
  }
});

test("a composed Machine's Open part is reported on its route, and the fix line nests through actors", () => {
  const top = jr2Setup({ events: [], actors: { tell: notifier() } }).createMachine({
    id: "top",
    initial: "idle",
    states: { idle: { invoke: { src: "tell" } } },
  });
  const open1 = partsOf([top]).openEffects;
  assert.deepEqual(open1, [
    { slot: "comment", path: ["tell"], part: "url" },
    { slot: "deploy", path: ["tell"], part: "argv" },
  ]);
  assert.equal(
    customizeLine("<import>", ["tell"], "comment", "url"),
    'customize(<import>, { actors: { tell: { effects: { comment: { url: "https://<host>/<path>" } } } } })',
  );
  assert.equal(
    customizeLine("<import>", [], "deploy", "argv"),
    'customize(<import>, { effects: { deploy: { argv: ["<program>", "<arg>"] } } })',
  );
  const bound = customize(top, {
    actors: { tell: { effects: { comment: { url: "https://t.example.com" }, deploy: { argv: ["true"] } } } },
  });
  assert.deepEqual(partsOf([bound]).openEffects, []);
});

test("jr2 up places what a bound part names: the Instance Effector's fence is the bound host, and a credentialed command's Workspace keeps its Sandbox Effector", () => {
  const body = jr2Setup({
    events: [],
    actors: {
      comment: comment(),
      release: commandWith(execs.factory, open, { env: { TOKEN: secret("release-token") } }),
    },
  }).createMachine({ id: "body", initial: "idle", states: { idle: {} } });
  const bound = customize(workspace(body, { repos, spec }), {
    effects: {
      comment: { url: "https://tracker.example.com:8443/api" },
      release: { argv: ["./release.sh", "--prod"] },
    },
  });
  // The credentialed command was placed in the Sandbox Effector before it was bound: naming a
  // secret is the placement, and the argv names none.
  const before = workspacePodsOf(workspace(body, { repos, spec }));
  assert.deepEqual(
    before[0]!.effects.map((e) => [e.name, e.placement]),
    [["release", "sandbox"]],
  );
  const config = {
    secrets: [
      { name: "tracker-token", value: "tracker-token-value" },
      { name: "release-token", value: "release-token-value" },
    ],
  };
  const walk = {
    effects: partsOf([bound]).effects.map((effect) => ({ workflow: "notify", effect })),
    workspaces: workspacePodsOf(bound).map((pod) => ({ workflow: "notify", pod })),
  };
  const placed = secretPlacementsOf(config, walk);
  assert.deepEqual(placed.instance?.targets, [
    { scheme: "https", host: "tracker.example.com", port: 8443, secrets: ["tracker-token"] },
  ]);
  assert.deepEqual(
    placed.sandbox.map((p) => [p.secrets.map((s) => s.name), p.commands]),
    [[["release-token"], true]],
  );
});

test("the pick-param check runs again on a bound argv: a param the composer's argv does not read is refused", () => {
  const ship = defineEvent({ name: "ship", input: z.object({ env: z.string() }) });
  const finish = defineEvent({ name: "finish", input: z.object({}) });
  const deploy = commandWith(execs.factory, open);
  const coder = agentActorWith(() => new MockFlueClient(), coderDefinition);
  const machine = jr2Setup({ events: [ship, finish], actors: { coder, deploy } }).createMachine({
    id: "shipper",
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, shipping: { invoke: { src: "deploy", input: fromPick(ship), onDone: "rest" } } },
        on: { ship: ".shipping", finish: "done" },
      },
      done: { type: "final" },
    },
  });
  // At build the argv's slots are unknown: every param counts as read, and nothing is refused.
  assert.ok(machine);
  assert.ok(customize(machine, { effects: { deploy: { argv: ["make", arg("env")] } } }));
  assert.throws(
    () => customize(machine, { effects: { deploy: { argv: ["make", "deploy"] } } }),
    /customize\(\): machine "shipper": pick "ship" enters .* "env" is no key of the Effect's input/,
  );
});

test("a run of an Effect nobody bound faults before anything is sent, naming the customize line", async () => {
  const before = fake.starts.length;
  const machine = jr2Setup({
    types: {} as { context: { fault?: string } },
    events: [],
    actors: { comment: comment() },
  }).createMachine({
    id: "unbound",
    context: {},
    initial: "calling",
    states: {
      calling: {
        invoke: {
          src: "comment",
          input: { key: "K-1", body: "hi" },
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      faulted: {},
    },
  });
  const effector = () => ({ placement: "instance" as const, service: "svc:8082", key: EFFECTOR_KEY });
  const host = new RunHost({ store: await mkStore(), effector });
  host.register({ name: "unbound", machine, provide: () => ({}) });
  const { runId } = await host.start("unbound");
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match(
    (host.status(runId)?.context as { fault: string }).fault,
    /http "comment" leaves its url Open — nobody bound it; .*customize\(<machine>, \{ effects: \{ comment: \{ url: "https:\/\/<host>\/<path>" \} \} \}\).*nothing was sent \(ADR-0054\)/,
  );
  assert.equal(fake.starts.length, before, "nothing reached the Effector");
});

test("an http whose body is a Worktree file may leave its url Open too, and binds the same way", () => {
  const report = httpFileWith(ports, { method: "PUT", url: open, body: file("out/report.pdf") });
  assert.ok(isEffect(report));
  const m = jr2Setup({ events: [], actors: { report } }).createMachine({
    id: "up",
    initial: "idle",
    states: { idle: {} },
  });
  const wrapped = workspace(m, { repos, spec });
  assert.deepEqual(partsOf([wrapped]).openEffects, [{ slot: "report", path: [], part: "url" }]);
  const bound = customize(wrapped, { effects: { report: { url: "https://files.example.com/upload" } } });
  const [effect] = partsOf([bound]).effects;
  assert.equal(effect?.kind, "http");
  assert.equal((effect as { file?: true }).file, true, "a file body keeps it in the Sandbox Effector");
  assert.deepEqual((effect as { target?: unknown }).target, { scheme: "https", host: "files.example.com", port: 443 });
});
