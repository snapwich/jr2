// An Effect's Open secret (ADR-0054, ADR-0067, ADR-0068): a packaged Machine names `secret(open)` in
// an http Effect's auth or a header, or in a command's env (its value or its `.path`), and the
// composer binds its name once with `customize(machine, { effects: { <slot>: { secret: "<name>" } } })`,
// alone or beside `{ url }` or `{ argv }` in one binding object.
//
// The claims, in order: each place takes it, a url refuses it, two refuse; customize() binds it alone,
// with a url and with an argv, refuses a wrong name, and gives the Effect a definition written with
// that name would give — placed as a named secret is, in that Effect's Effector alone; the walk
// reports one nothing bound with the `{ secret }` line, through `workspace()` and `pool()`, and reads
// a bound one as fixed; and a run of one nobody bound faults before anything is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { customize } from "../src/customize.ts";
import { commandWith, isEffect, placementOf, type EffectParts } from "../src/effect.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import { basic, bearer, file, httpWith, secret, text } from "../src/http-effect.ts";
import { open, partsOf, workspacePodsOf, customizeLine } from "../src/parts.ts";
import { pool, source } from "../src/pool.ts";
import { RunHost } from "../src/run-host.ts";
import { secretPlacementsOf } from "../src/secret-placement.ts";
import { httpFileWith } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { FakeEffector } from "./_effector.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const fake = new FakeEffector();
const ports = (target: { key: string | Buffer }) =>
  createEffectorClient({ key: target.key, transport: fake.transport });
const execs = new FakeHarnessExec();

const effectOf = (logic: unknown): EffectParts => {
  assert.ok(isEffect(logic));
  return logic.effect;
};
const slotAt = (machine: unknown, slot: string): unknown =>
  (machine as { implementations: { actors: Record<string, unknown> } }).implementations.actors[slot];
const machineOf = (actors: Record<string, unknown>) =>
  jr2Setup({ events: [], actors: actors as never }).createMachine({ id: "pkg", initial: "idle", states: { idle: {} } });

const repos = { app: "https://example.test/app.git" };
const spec = () => ({ branch: "feat-1" });

// --- the places that take it -------------------------------------------------------------------

test("secret(open) is taken by bearer, basic, a header value, and a command's env value or its .path", () => {
  const url = "https://hooks.example.com/api";
  const cases: Array<[string, unknown, string]> = [
    ["bearer", httpWith(ports, { method: "POST", url, auth: bearer(secret(open)) }), "instance"],
    ["basic's user", httpWith(ports, { method: "POST", url, auth: basic(secret(open), "x") }), "instance"],
    ["basic's password", httpWith(ports, { method: "POST", url, auth: basic("bot", secret(open)) }), "instance"],
    [
      "a header value",
      httpWith(ports, { method: "POST", url, headers: { "x-api-key": text`${secret(open)}` } }),
      "instance",
    ],
    [
      "a file-body http's header",
      httpFileWith(ports, {
        method: "PUT",
        url,
        headers: { "x-api-key": text`key ${secret(open)}` },
        body: file("out/report.pdf"),
      }),
      "sandbox",
    ],
    ["a command's env value", commandWith(execs.factory, ["deploy"], { env: { TOKEN: secret(open) } }), "sandbox"],
    ["a command's env .path", commandWith(execs.factory, ["deploy"], { env: { FILE: secret(open).path } }), "sandbox"],
  ];
  for (const [where, logic, placement] of cases) {
    const parts = effectOf(logic);
    assert.equal(parts.kind === "push" ? undefined : parts.openSecret, true, `${where}: the Open secret is carried`);
    assert.deepEqual(parts.secrets ?? [], [], `${where}: it names no secret until it is bound`);
    // A command that names an Open secret is a credentialed command already: its placement is known.
    assert.equal(placementOf(parts), placement, `${where}: placed by what it is, before the name is known`);
    const [carried] = partsOf([machineOf({ s: logic })]).effects;
    assert.deepEqual((carried as { open?: string[] }).open, ["secret"], `${where}: CarriedEffect's open reports it`);
  }
});

test("secret(open) in a url is refused at build, with the url rule", () => {
  for (const url of [
    text`https://hooks.example.com/services/${secret(open)}`,
    text`https://h.example.com/${secret(open)}/x`,
  ]) {
    assert.throws(
      () => httpWith(ports, { method: "POST", url }),
      /secret\(open\) in a url: a url's secret is not an Open part — leave the whole url Open \(`url: open`\)/,
    );
  }
});

test("an Effect takes one Open secret: a second is refused at build; one used in two places is one", () => {
  const url = "https://hooks.example.com/api";
  const second = /an Effect takes one Open secret/;
  assert.throws(
    () =>
      httpWith(ports, {
        method: "POST",
        url,
        auth: bearer(secret(open)),
        headers: { "x-team": text`${secret(open)}` },
      }),
    second,
  );
  assert.throws(() => httpWith(ports, { method: "POST", url, auth: basic(secret(open), secret(open)) }), second);
  assert.throws(
    () => commandWith(execs.factory, ["deploy"], { env: { A: secret(open), B: secret(open).path } }),
    second,
  );
  // One secret(open), named in two places — its value and its file — is one Open secret.
  const token = secret(open);
  const one = commandWith(execs.factory, ["deploy"], { env: { TOKEN: token, TOKEN_FILE: token.path } });
  assert.equal((effectOf(one) as { openSecret?: true }).openSecret, true);
});

// --- customize() binds it ----------------------------------------------------------------------

/** A package's Machine: an http Effect whose secret is Open, one whose url and secret are Open, and
 * a command whose argv and secret are Open. */
function notifier() {
  const token = secret(open);
  return jr2Setup({
    events: [],
    actors: {
      notify: httpWith(ports, {
        method: "POST",
        url: "https://hooks.example.com/api",
        auth: bearer(secret(open)),
        input: z.object({ body: z.string() }),
        request: ({ body }) => ({ json: { body } }),
      }),
      page: httpWith(ports, { method: "POST", url: open, headers: { "x-api-key": text`${secret(open)}` } }),
      release: commandWith(execs.factory, open, { env: { TOKEN: token, TOKEN_FILE: token.path } }),
    },
  }).createMachine({ id: "notifier", initial: "idle", states: { idle: {} } });
}

test("customize() binds an Open secret alone, beside a url, and beside an argv — one binding object", () => {
  const bound = customize(notifier(), {
    effects: {
      notify: { secret: "team-a-hook" },
      page: { url: "https://pager.example.com/v2/alert", secret: "team-a-pager" },
      release: { argv: ["./release.sh"], secret: "team-a-release" },
    },
  });
  const carried = partsOf([bound]);
  assert.deepEqual(carried.openEffects, []);
  const byName = Object.fromEntries(carried.effects.map((e) => [e.name, e]));
  assert.deepEqual((byName.notify as { secrets: string[] }).secrets, ["team-a-hook"]);
  assert.equal((byName.notify as { open?: unknown }).open, undefined, "bound: fixed from then on");
  assert.deepEqual((byName.page as { target?: unknown }).target, {
    scheme: "https",
    host: "pager.example.com",
    port: 443,
  });
  assert.deepEqual((byName.page as { secrets: string[] }).secrets, ["team-a-pager"]);
  assert.deepEqual((byName.release as { argv: string[] }).argv, ["./release.sh"]);
  assert.deepEqual((byName.release as { secrets?: string[] }).secrets, ["team-a-release"]);
  // The bound secret stands in every place secret(open) stood: the auth, the header, the env.
  const notify = effectOf(slotAt(bound, "notify"));
  assert.deepEqual(notify.kind === "http" && notify.auth, { bearer: { secret: "team-a-hook" } });
  const release = effectOf(slotAt(bound, "release"));
  assert.deepEqual(release.kind === "command" && release.env, {
    TOKEN: { secret: "team-a-release" },
    TOKEN_FILE: { secret: "team-a-release", path: true },
  });
});

test("a binding that leaves one of two Open parts unbound is still Open in it; that part binds later, once", () => {
  const loose = customize as (m: unknown, p: unknown) => ReturnType<typeof notifier>;
  const half = loose(notifier(), { effects: { page: { url: "https://pager.example.com" } } });
  assert.deepEqual(
    partsOf([half]).openEffects.find((o) => o.slot === "page"),
    { slot: "page", path: [], parts: ["secret"] },
  );
  const whole = loose(half, { effects: { page: { secret: "pager-key" } } });
  assert.equal(
    partsOf([whole]).openEffects.find((o) => o.slot === "page"),
    undefined,
  );
  // The url was bound once: it is no Open part of the half-bound Effect.
  assert.throws(
    () => loose(half, { effects: { page: { url: "https://other.example.com", secret: "k1234567" } } }),
    /leaves its secret Open — bind it with \{ secret: "<name>" \}/,
  );
});

test("customize() refuses a name secret() refuses, a name that is no string, and a key that is no Open part", () => {
  const loose = customize as (m: unknown, p: unknown) => unknown;
  for (const name of [".hidden", "a@b", "has space", ""]) {
    assert.throws(
      () => loose(notifier(), { effects: { notify: { secret: name } } }),
      /a secret's name is letters, digits, "\.", "_" and "-", and does not start with "\."/,
      name,
    );
  }
  assert.throws(() => loose(notifier(), { effects: { notify: { secret: 42 } } }), /bound to a secret's name, a string/);
  assert.throws(() => loose(notifier(), { effects: { notify: { secret: open } } }), /not `open` again/);
  assert.throws(
    () => loose(notifier(), { effects: { notify: { url: "https://x.example.com" } } }),
    /"notify" leaves its secret Open — bind it with \{ secret: "<name>" \}/,
  );
  assert.throws(
    () => loose(notifier(), { effects: { release: { url: "https://x.example.com" } } }),
    /leaves its argv and secret Open — bind it with \{ argv: \["<program>", "<arg>"\], secret: "<name>" \}/,
  );
});

test("the bound Effect is the one a definition written with that name gives: its parts, its placement", () => {
  const written = httpWith(ports, {
    method: "POST",
    url: "https://hooks.example.com/api",
    auth: bearer(secret("team-a-hook")),
    input: z.object({ body: z.string() }),
    request: ({ body }) => ({ json: { body } }),
  });
  const bound = customize(notifier(), { effects: { notify: { secret: "team-a-hook" } } });
  assert.deepEqual(effectOf(slotAt(bound, "notify")), effectOf(written));
  const writtenCommand = commandWith(execs.factory, ["./release.sh"], {
    env: { TOKEN: secret("rel-token"), TOKEN_FILE: secret("rel-token").path },
  });
  const boundCommand = customize(notifier(), { effects: { release: { argv: ["./release.sh"], secret: "rel-token" } } });
  assert.deepEqual(effectOf(slotAt(boundCommand, "release")), effectOf(writtenCommand));
});

test("a header or env key named bearer, basic or secret is the author's name, never a shape the binding reads", () => {
  const url = "https://hooks.example.com/api";
  // Each Effect names its Open secret in a record that also has a key a shape is named by.
  const machine = jr2Setup({
    events: [],
    actors: {
      hBearer: httpWith(ports, {
        method: "POST",
        url,
        headers: { bearer: "literal", "x-key": text`${secret(open)}` },
      }),
      hSecret: httpWith(ports, { method: "POST", url, headers: { secret: "literal", "x-key": text`${secret(open)}` } }),
      hBasic: httpWith(ports, { method: "POST", url, headers: { basic: text`k ${secret(open)}` } }),
      eBearer: commandWith(execs.factory, ["deploy"], { env: { bearer: secret("fixed-one"), TOKEN: secret(open) } }),
      eBasic: commandWith(execs.factory, ["deploy"], { env: { basic: secret(open).path } }),
      eSecret: commandWith(execs.factory, ["deploy"], { env: { secret: secret(open) } }),
    },
  }).createMachine({ id: "keys", initial: "idle", states: { idle: {} } });
  const bound = customize(machine, {
    effects: {
      hBearer: { secret: "team-key" },
      hSecret: { secret: "team-key" },
      hBasic: { secret: "team-key" },
      eBearer: { secret: "team-key" },
      eBasic: { secret: "team-key" },
      eSecret: { secret: "team-key" },
    },
  });
  assert.deepEqual(partsOf([bound]).openEffects, [], "every binding binds: none is still Open");
  const headersOf = (slot: string) => {
    const parts = effectOf(slotAt(bound, slot));
    assert.equal(parts.kind, "http");
    return parts.kind === "http" ? { headers: parts.headers, secrets: parts.secrets } : undefined;
  };
  assert.deepEqual(headersOf("hBearer"), {
    headers: { bearer: [{ text: "literal" }], "x-key": [{ secret: "team-key" }] },
    secrets: ["team-key"],
  });
  assert.deepEqual(headersOf("hSecret"), {
    headers: { secret: [{ text: "literal" }], "x-key": [{ secret: "team-key" }] },
    secrets: ["team-key"],
  });
  assert.deepEqual(headersOf("hBasic"), {
    headers: { basic: [{ text: "k " }, { secret: "team-key" }] },
    secrets: ["team-key"],
  });
  const envOf = (slot: string) => {
    const parts = effectOf(slotAt(bound, slot));
    assert.equal(parts.kind, "command");
    return parts.kind === "command" ? { env: parts.env, secrets: [...(parts.secrets ?? [])].sort() } : undefined;
  };
  assert.deepEqual(envOf("eBearer"), {
    env: { bearer: { secret: "fixed-one" }, TOKEN: { secret: "team-key" } },
    secrets: ["fixed-one", "team-key"],
  });
  assert.deepEqual(envOf("eBasic"), { env: { basic: { secret: "team-key", path: true } }, secrets: ["team-key"] });
  assert.deepEqual(envOf("eSecret"), { env: { secret: { secret: "team-key" } }, secrets: ["team-key"] });
});

// --- the walk ----------------------------------------------------------------------------------

test("the walk reports an Open secret nothing bound, with the { secret } line, through workspace() and pool()", () => {
  const body = jr2Setup({
    events: [],
    actors: {
      notify: httpWith(ports, { method: "POST", url: "https://hooks.example.com", auth: bearer(secret(open)) }),
      page: httpWith(ports, { method: "POST", url: open, headers: { "x-api-key": text`${secret(open)}` } }),
    },
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
  for (const machine of [body, wrapped, pooled]) {
    assert.deepEqual(partsOf([machine]).openEffects, [
      { slot: "notify", path: [], parts: ["secret"] },
      { slot: "page", path: [], parts: ["url", "secret"] },
    ]);
  }
  assert.equal(
    customizeLine("<import>", [], "notify", ["secret"]),
    'customize(<import>, { effects: { notify: { secret: "<name>" } } })',
  );
  assert.equal(
    customizeLine("<import>", ["tell"], "page", ["url", "secret"]),
    'customize(<import>, { actors: { tell: { effects: { page: { url: "https://<host>/<path>", secret: "<name>" } } } } })',
  );
  const bound = customize(pooled, {
    effects: { notify: { secret: "hook-key" }, page: { url: "https://pager.example.com", secret: "pager-key" } },
  });
  assert.deepEqual(partsOf([bound]).openEffects, [], "a bound secret reads as fixed");
});

test("the bound secret is placed as a named secret is: in that Effect's Effector alone, never a Custodian", () => {
  const body = jr2Setup({
    events: [],
    actors: {
      notify: httpWith(ports, { method: "POST", url: "https://hooks.example.com", auth: bearer(secret(open)) }),
      release: commandWith(execs.factory, ["./release.sh"], { env: { TOKEN: secret(open) } }),
    },
  }).createMachine({ id: "body", initial: "idle", states: { idle: {} } });
  const bound = customize(workspace(body, { repos, spec }), {
    effects: { notify: { secret: "hook-key" }, release: { secret: "release-key" } },
  });
  const config = {
    secrets: [
      { name: "hook-key", value: "hook-key-value" },
      { name: "release-key", value: "release-key-value" },
    ],
  };
  const walk = {
    effects: partsOf([bound]).effects.map((effect) => ({ workflow: "notify", effect })),
    workspaces: workspacePodsOf(bound).map((pod) => ({ workflow: "notify", pod })),
  };
  const placed = secretPlacementsOf(config, walk);
  assert.deepEqual(placed.instance?.targets, [
    { scheme: "https", host: "hooks.example.com", port: 443, secrets: ["hook-key"] },
  ]);
  assert.deepEqual(
    placed.sandbox.map((p) => [p.secrets.map((s) => s.name), p.commands]),
    [[["release-key"], true]],
  );
  for (const pod of placed.held) assert.deepEqual(pod.names, [], `${pod.label}: no Custodian holds it`);
});

test("a run of an Effect whose secret nobody bound faults before anything is sent, naming the { secret } line", async () => {
  const sent = fake.starts.length;
  const machine = jr2Setup({
    types: {} as { context: { fault?: string } },
    events: [],
    actors: {
      ws: fakeWorkspace(),
      notify: httpWith(ports, { method: "POST", url: "https://hooks.example.com", auth: bearer(secret(open)) }),
    },
  }).createMachine({
    id: "unbound",
    context: {},
    invoke: { src: "ws" },
    initial: "calling",
    states: {
      calling: {
        invoke: {
          src: "notify",
          onDone: "done",
          onError: {
            target: "faulted",
            actions: ({ context, event }) => {
              context.fault = (event.error as Error).message;
            },
          },
        },
      },
      done: {},
      faulted: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "unbound", machine, provide: () => ({}) });
  const { runId } = await host.start("unbound");
  await waitFor(() => host.status(runId)?.value === "faulted");
  assert.match(
    (host.status(runId)?.context as { fault: string }).fault,
    /http "notify" leaves its secret Open — nobody bound it; .*\{ effects: \{ notify: \{ secret: "<name>" \} \} \}/,
  );
  assert.equal(fake.starts.length, sent, "nothing reached an Effector");
  await host.stop(runId);
});
