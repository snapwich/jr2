// Declared run input (ADR-0033): a machine declares what a run of it is STARTED with —
// `createMachine({ input: z.object(...) })` — riding the machine object beside the vocabulary
// (ADR-0015's WeakMap pattern). A declared schema is enforced at the door with gate-delivery
// parity (400/EventValidationError naming what is accepted, the PARSED shape starts the run);
// no schema stays permissive (today's wire); a WRAPPER declares its own door — `workspace` via
// its options' `input`, `pool` via `PoolSpec.input` — because neither hands its child the run
// input as-is (a body also gets the injected `workspace` handles; a worker gets an item); and
// the schema is served as JSON Schema — structure, open band.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise } from "xstate";
import { z } from "zod";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { j2Setup } from "../src/setup.ts";
import { pool, source } from "../src/pool.ts";
import { workspace, type SandboxPort, type Workspaced } from "../src/workspace.ts";
import { inputSchemaOf, vocabularyOf } from "../src/vocabulary.ts";
import { EventValidationError } from "../src/registration.ts";
import type { WorkflowDef } from "../src/run-host.ts";
import { approveDef, gatedDef, mkStore } from "./_fixtures.ts";

const startInput = z.object({ title: z.string(), priority: z.number().default(1) });

/** Declares its door: a run starts with `{ title, priority? }`; the default proves the PARSED
 * shape (not the raw body) is what reaches the machine — gate-delivery parity. */
const titledTemplate = j2Setup({
  types: {} as { context: { title: string; priority: number }; input: { title: string; priority?: number } },
  events: [],
}).createMachine({
  id: "titled",
  input: startInput,
  context: ({ input }) => ({ title: input.title, priority: input.priority ?? 0 }),
  initial: "idle",
  states: { idle: {} },
});

function titledDef(): WorkflowDef {
  return { name: "titled", machine: titledTemplate, provide: () => ({}) };
}

/** A workspace BODY: no schema of its own (the door belongs to the wrapper), and its input is the
 * door plus the handles the wrapper injects — `Workspaced<…>`, the composition the wrapper's
 * declared door is checked against. */
const wsBody = j2Setup({
  types: {} as { context: { repo: string }; input: Workspaced<{ repo: string; branch: string }> },
  events: [approveDef],
}).createMachine({
  id: "wsbody",
  context: ({ input }) => ({ repo: input.repo }),
  initial: "idle",
  states: { idle: { on: { approve: "done" } }, done: { type: "final" } },
});

/** A Sandbox backend that never answers: the wrapper stays at `provisioning`, which is all this
 * suite needs — the resolved spec is already in its context, and no pod is anyone's business here. */
const parkedSandbox = (): SandboxPort => ({
  provision: () => new Promise(() => {}),
  attach: () => new Promise(() => {}),
  renew: async () => ({ present: true }),
  destroy: async () => {},
});

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("a declared schema is enforced at the door; the PARSED input starts the run", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(titledDef());

  // Refused at the door — the same error class a bad gate delivery throws, naming the workflow.
  await assert.rejects(
    host.start("titled", { priority: 3 }),
    (err: Error) => err instanceof EventValidationError && /invalid input for workflow "titled"/.test(err.message),
  );
  assert.deepEqual(host.list(), []); // nothing started, nothing tracked

  // Accepted: defaults applied and unknown keys stripped before the machine sees anything —
  // what lands is exactly the validated shape, as with gate deliveries.
  const { runId } = await host.start("titled", { title: "ship it", junk: "dropped" });
  const ctx = host.status(runId)?.context as { title: string; priority: number };
  assert.equal(ctx.title, "ship it");
  assert.equal(ctx.priority, 1); // the zod default, so the raw body demonstrably did not ride
});

test("POST /workflows/:name/runs 400s on a schema failure, naming the accepted shape", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(titledDef());
  const app = createApp(host);

  const bad = await app.request("/workflows/titled/runs", jsonPost({ priority: "high" }));
  assert.equal(bad.status, 400);
  const { error } = (await bad.json()) as { error: string };
  assert.match(error, /invalid input for workflow "titled"/);
  assert.match(error, /title/); // the zod issues name the missing/expected fields

  // An unknown workflow is still the 404 it always was — validation did not widen that hole.
  const unknown = await app.request("/workflows/nope/runs", jsonPost({ title: "x" }));
  assert.equal(unknown.status, 404);

  const good = await app.request("/workflows/titled/runs", jsonPost({ title: "ship it" }));
  assert.equal(good.status, 201);
});

test("no declared schema accepts anything — today's permissive door, unchanged", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const app = createApp(host);

  const res = await app.request("/workflows/gated/runs", jsonPost({ whatever: { nested: true } }));
  assert.equal(res.status, 201);
  assert.equal(host.inputSchema("gated"), null); // declared nothing: null, not a schema
});

test("the declared schema is exposed as JSON Schema; unknown workflow is undefined", async () => {
  const host = new RunHost({ store: await mkStore() });
  host.register(titledDef());

  const schema = host.inputSchema("titled") as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(schema?.properties?.title);
  assert.deepEqual(schema?.required, ["title"]); // priority has a default — not required
  assert.equal(host.inputSchema("nope"), undefined);
});

test("workspace(): the body's schema is NOT the door — the wrapper declares its own via `input`", async () => {
  // The body is fed the run input PLUS the injected `workspace` handles, so its contract is the
  // door plus a field no caller can send. Propagating it would 400 every valid start.
  const bare = workspace(wsBody, {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" }),
  });
  assert.equal(inputSchemaOf(bare), undefined);
  // Nor does the VOCABULARY propagate (ADR-0049): the body's names stay the body's, because the
  // gates and menus that use them resolve against the Machine that invoked them.
  assert.equal(vocabularyOf(bare), undefined);
  assert.ok(vocabularyOf(wsBody)?.has("approve"));

  const door = z.object({ repo: z.string(), branch: z.string().default("feat-1") });
  const declared = workspace(wsBody, {
    input: door,
    // `input` is inferred from the schema — nothing here annotates a shape by hand.
    spec: ({ input }) => ({ repos: [{ name: input.repo, baseRef: "main" }], branch: input.branch }),
  });
  assert.equal(inputSchemaOf(declared), door);

  // Through the door for real: the wrapper's schema is what `GET /workflows/:name` serves and
  // what `start` enforces, and the PARSED input is what reaches the spec mapper.
  const host = new RunHost({ store: await mkStore(), sandbox: parkedSandbox() });
  host.register({ name: "wsdoor", machine: declared, provide: () => ({}) });

  const schema = host.inputSchema("wsdoor") as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(schema?.properties?.repo);
  assert.deepEqual(schema?.required, ["repo"]); // branch has a default — not required at the door
  assert.ok(!schema?.properties?.workspace, "the door never asks for the injected handles");

  await assert.rejects(
    host.start("wsdoor", {}),
    (err: Error) => err instanceof EventValidationError && /invalid input for workflow "wsdoor"/.test(err.message),
  );
  const { runId } = await host.start("wsdoor", { repo: "app" });
  const ctx = host.status(runId)?.context as { spec: { repos: Array<{ name: string }>; branch: string } };
  assert.deepEqual(ctx.spec, { repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" });
});

test("workspace(): wrapping a body that declares its own input fails loudly, naming the fix", () => {
  // A schema on the body is a DEAD declaration: the wrapper serves its own door, so nothing would
  // ever validate against this one — and what the body is actually fed (the door plus the handles)
  // is not what it describes. Silence would leave an author trusting a contract that does not
  // exist, which is the exact drift ADR-0033 closes.
  assert.throws(
    () => workspace(titledTemplate, { spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "b" }) }),
    (err: Error) =>
      /declares its own run input/.test(err.message) && /workspace\(body, \{ input, spec \}\)/.test(err.message),
  );
});

test("pool(): the worker's schema is NOT the door — the pool declares its own via `spec.input`", async () => {
  const worker = j2Setup({ events: [approveDef] }).createMachine({
    id: "worker",
    input: startInput,
    initial: "one",
    states: { one: { on: { approve: "done" } }, done: { type: "final" } },
  });
  // Workers are fed per-ITEM, never the run body, so the worker's contract describes nothing a
  // starter sends. Propagating it (as workspace does for its body) would 400 valid pool starts.
  const parked = source({ next: fromPromise<null, { active: string[] }>(() => new Promise(() => {})) });
  const bare = pool(worker, { source: parked, itemId: () => "i" });
  assert.equal(inputSchemaOf(bare), undefined);
  // Nor the vocabulary (ADR-0049): a source-less pool declares nothing, and `approve` is the
  // WORKER's word — resolved against the worker, where its gate lives.
  assert.equal(vocabularyOf(bare), undefined);
  assert.ok(vocabularyOf(worker)?.has("approve"));

  const poolInput = z.object({ maxWorkers: z.number().default(2) });
  const capped = pool(worker, {
    input: poolInput,
    source: parked,
    itemId: () => "i",
    // Inferred from the declared schema, like `workspace()`'s spec mapper — nothing casts here.
    cap: ({ input }) => input.maxWorkers,
  });
  assert.equal(inputSchemaOf(capped), poolInput);

  // An actual start through the door: a body with no worker fields is valid, the pool-level field
  // survives parsing (not stripped as an unknown key) and reaches `cap`.
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "capped", machine: capped, provide: () => ({}) });
  const { runId } = await host.start("capped", { maxWorkers: 4 });
  assert.equal((host.status(runId)?.context as { cap: number }).cap, 4);
});

test("the schema never reaches the xstate config: no `input` key for fingerprint/doc paths", () => {
  assert.equal((titledTemplate.config as { input?: unknown }).input, undefined);
});
