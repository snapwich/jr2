// An Effect's Open parts (ADR-0054, design 2): a packaged Machine leaves an http url, or a
// command's argv, `open`; the composer binds it once with `customize(machine, { effects })`, through
// `workspace()` and `pool()` as `agents` goes; `jr2 up`'s walk sees the bound part as one the author
// wrote — the placement, the secrets, the Effector's fence — and reports the part nothing bound.
//
// The claims, in order: an Open part is carried and reported, never guessed; binding builds the
// Effect again, whole, so every check its constructor runs holds for a bound one; the other parts of
// an Open Effect are checked at build; a bound argv's slot the invoke does not supply faults at run;
// the original is untouched; only an Open part is bound, to a value, once; the wrappers are transparent; the walk
// reads the bound host, the secrets its url names and the argv; the load walk's pick-param check
// runs again on a bound argv; and a run of an Effect nobody bound faults before anything is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { customize } from "../src/customize.ts";
import { arg, commandWith, isEffect, type CommandOutput, type EffectLogic } from "../src/effect.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import { bearer, file, httpWith, secret, text } from "../src/http-effect.ts";
import { binderOf } from "../src/open-effect.ts";
import { open, partsOf, workspacePodsOf, customizeLine } from "../src/parts.ts";
import { pool, source } from "../src/pool.ts";
import { fromPick } from "../src/pick.ts";
import { RunHost } from "../src/run-host.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { secretPlacementsOf } from "../src/secret-placement.ts";
import { httpFileWith } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { machineBodies, serializeMachine } from "../src/machine-doc.ts";
import { workspace } from "../src/workspace.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
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

test("an Open Effect's other parts are checked when it is built, as a written one's are: the method, a header, the env, pin", () => {
  // ADR-0054: everything else the definition says stays the package's and is checked at build. The
  // Open form must refuse each with the very message the written form gives — not later, at bind.
  const url = "https://t.example.com/api";
  const cases: Array<[string, (part: unknown) => unknown]> = [
    ["an http method", (u) => httpWith(ports, { method: "BOGUS" as never, url: u as never })],
    [
      "an http header that routes the request",
      (u) => httpWith(ports, { method: "GET", url: u as never, headers: { host: "x" } }),
    ],
    [
      "a file-body http header that frames the request",
      (u) =>
        httpFileWith(ports, {
          method: "PUT",
          url: u as never,
          headers: { "content-length": "1" },
          body: file("out/report.pdf"),
        }),
    ],
    [
      "a command env name the Effector owns",
      (a) => commandWith(execs.factory, a as never, { env: { PATH: secret("path-secret") } }),
    ],
    ["a command `pin` with no secret", (a) => commandWith(execs.factory, a as never, { pin: true })],
  ];
  for (const [what, build] of cases) {
    const written = what.startsWith("a command") ? ["make", "deploy"] : url;
    const message = (part: unknown): string => {
      try {
        build(part);
      } catch (err) {
        return (err as Error).message;
      }
      return "ACCEPTED";
    };
    const refused = message(written);
    assert.notEqual(refused, "ACCEPTED", `${what}: the written form is refused`);
    assert.equal(message(open), refused, `${what}: the Open form is refused at build, with the same message`);
  }
});

test("a bound argv's slot the invoke does not supply is no refusal at customize(): the run faults when the Effect starts, nothing run", async () => {
  // ADR-0054/0067: an Open argv's input is one string per key, so the compiler checks no slot of the
  // argv a composer binds, and neither does customize(). The Effect's fault is the one fence.
  const ran = execs.starts.length;
  const machine = jr2Setup({
    types: {} as { context: { fault?: string } },
    events: [],
    actors: { ws: fakeWorkspace(), deploy: commandWith(execs.factory, open) },
  }).createMachine({
    id: "unsupplied",
    context: {},
    invoke: { src: "ws" },
    initial: "calling",
    states: {
      calling: {
        invoke: {
          src: "deploy",
          input: { env: "prod" },
          onDone: "done",
          onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
        },
      },
      done: {},
      faulted: {},
    },
  });
  const bound = customize(machine, { effects: { deploy: { argv: ["make", arg("env"), arg("target")] } } });
  assert.deepEqual(loadWarningsOf(bound), loadWarningsOf(machine), "customize() adds no finding for it");
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "unsupplied", machine: bound, provide: () => ({}) });
  const { runId } = await host.start("unsupplied");
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match(
    (host.status(runId)?.context as { fault: string }).fault,
    /command "deploy": argv slot <target> has no string value in its input/,
  );
  assert.equal(execs.starts.length, ran, "nothing reached the Harness exec");
  await host.stop(runId);
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

test("a bound argv carries the warnings the same Machine written with that argv carries, and the Open one keeps its own", () => {
  // A pick param nothing the walk can run reads, beside an action it does not run: a warning, not
  // a refusal (design 8). Written with the argv, the build attaches it; bound, customize() must too.
  // The helper takes either argv form; the slot is typed as the fromPick input, so the bindings
  // below are untyped calls (`as never`), as customize.test.ts writes them.
  const shipper = (deploy: unknown) => {
    const ship = defineEvent({ name: "ship", input: z.object({ env: z.string() }) });
    const finish = defineEvent({ name: "finish", input: z.object({}) });
    const coder = agentActorWith(() => new MockFlueClient(), coderDefinition);
    return jr2Setup({
      events: [ship, finish],
      actors: { coder, deploy: deploy as EffectLogic<{ env: string }, CommandOutput> },
      actions: { noop: () => {} },
    }).createMachine({
      id: "shipper",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "p", endpoint: "http://harness.invalid" } },
          initial: "rest",
          states: { rest: {}, shipping: { invoke: { src: "deploy", input: fromPick(ship), onDone: "rest" } } },
          on: { ship: { target: ".shipping", actions: "noop" }, finish: "done" },
        },
        done: { type: "final" },
      },
    });
  };
  const written = shipper(commandWith(execs.factory, ["make", "deploy"]));
  const unread = loadWarningsOf(written).filter((w) => /nothing the walk can run reads "env"/.test(w));
  assert.equal(unread.length, 1, "the written Machine carries the warning");

  const openMachine = shipper(commandWith(execs.factory, open));
  const openWarnings = loadWarningsOf(openMachine);
  const bound = customize(openMachine, { effects: { deploy: { argv: ["make", "deploy"] } } } as never);
  assert.deepEqual(loadWarningsOf(bound), loadWarningsOf(written));
  assert.deepEqual(serializeMachine("shipper", bound).warnings, loadWarningsOf(written), "the doc jr2 up prints");
  assert.deepEqual(loadWarningsOf(openMachine), openWarnings, "the Open Machine is untouched");
  // An argv that reads the param warns of nothing more than the same Machine written with it.
  assert.deepEqual(
    loadWarningsOf(customize(openMachine, { effects: { deploy: { argv: ["make", arg("env")] } } } as never)),
    loadWarningsOf(shipper(commandWith(execs.factory, ["make", arg("env")]))),
  );
  // Through workspace(), the body's doc carries the bound warnings; a later customize() keeps them.
  const wrapped = customize(workspace(openMachine, { repos, spec }), {
    effects: { deploy: { argv: ["make", "deploy"] } },
  } as never);
  const docs = machineBodies(serializeMachine("shipper", wrapped));
  assert.ok(docs.some((d) => d.id === "shipper" && d.warnings.some((w) => unread.includes(w))));
  const retuned = customize(bound, { agents: { coder: { instructions: "Ship it." } } });
  assert.deepEqual(loadWarningsOf(retuned), loadWarningsOf(written));
});

// A run of an Effect nobody bound, per kind: the second fence (ADR-0054). Each faults with the
// customize line, and nothing reaches the Effector or the Harness exec, and the ledger keeps no row.
const unbound = [
  { what: "an http", kind: "http", slot: "comment", part: "url", effect: () => comment() },
  { what: "a command", kind: "command", slot: "deploy", part: "argv", effect: () => commandWith(execs.factory, open) },
  {
    what: "a file-body http",
    kind: "http",
    slot: "report",
    part: "url",
    effect: () => httpFileWith(ports, { method: "PUT", url: open, body: file("out/report.pdf") }),
  },
] as const;

for (const { what, kind, slot, part, effect } of unbound) {
  test(`a run of ${what} Effect nobody bound faults before anything is sent, with no ledger row, naming the customize line`, async () => {
    const sent = fake.starts.length;
    const ran = execs.starts.length;
    const machine = jr2Setup({
      types: {} as { context: { fault?: string } },
      events: [],
      actors: { ws: fakeWorkspace(), [slot]: effect() },
    }).createMachine({
      id: "unbound",
      context: {},
      invoke: { src: "ws" },
      initial: "calling",
      states: {
        calling: {
          invoke: {
            src: slot,
            input: { key: "K-1", body: "hi", path: "out/report.pdf" } as never,
            onError: { target: "faulted", actions: assign({ fault: ({ event }) => (event.error as Error).message }) },
          },
        },
        faulted: {},
      },
    });
    const effector = () => ({ placement: "instance" as const, service: "svc:8082", key: EFFECTOR_KEY });
    const store = await mkStore();
    const host = new RunHost({ store, effector });
    host.register({ name: "unbound", machine, provide: () => ({}) });
    const { runId } = await host.start("unbound");
    await waitFor(() => host.status(runId)?.value === "faulted");
    const line =
      part === "url" ? `\\{ url: "https:\\/\\/<host>\\/<path>" \\}` : `\\{ argv: \\["<program>", "<arg>"\\] \\}`;
    assert.match(
      (host.status(runId)?.context as { fault: string }).fault,
      new RegExp(
        `${kind} "${slot}" leaves its ${part} Open — nobody bound it; .*customize\\(<machine>, \\{ effects: \\{ ${slot}: ${line} \\} \\}\\).*nothing was sent \\(ADR-0054\\)`,
      ),
    );
    assert.equal(fake.starts.length, sent, "nothing reached the Effector");
    assert.equal(execs.starts.length, ran, "nothing reached the Harness exec");
    // The save that carries the fault is on disk, and it holds no Effect row: no intent was written.
    await until(async () => (await saved(store, runId))?.value === "faulted");
    assert.deepEqual((await saved(store, runId))?.effects ?? {}, {}, "no ledger row");
    await host.stop(runId);
  });
}

/** The run's saved blob: the snapshot's state value and the Effect ledger beside it. */
async function saved(store: SnapshotStore, runId: string) {
  const blob = (await store.load(runId))?.snapshot as
    | { snapshot?: { value?: unknown }; effects?: Record<string, unknown> }
    | undefined;
  return blob && { value: blob.snapshot?.value, effects: blob.effects };
}

/** Wait for an async condition (a store read), polling. */
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("the condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
