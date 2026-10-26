// `jr2 check` (ADR-0050): the Instance check of `jr2 up`, with no cluster. The claims are that it
// gives the answer of `jr2 up` — the same refusal lines from the same function — that it reads no
// kube context, and that it runs where `node` alone cannot load a workflow module: an installed
// Instance, whose kit sources are `.ts` files under `node_modules`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { main } from "../src/cli.ts";
import type { KubeAdmin } from "../src/kube.ts";
import type { Io } from "../src/output.ts";
import { linkKit } from "./_kit.ts";
import { mkInstalledInstance } from "./support/installed.ts";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "jr2.js");
const KIT_SRC = pathToFileURL(join(HERE, "..", "..", "orchestrator", "src", "index.ts")).href;

/** The zod that the kit uses, for a fixture's event schema: a temp Instance resolves no bare name. */
const ZOD = import.meta.resolve("zod");
/** The xstate that the kit uses, for a fixture that builds its Machine with xstate's `setup()`. */
const XSTATE = import.meta.resolve("xstate");

/** A Machine whose `on` key names an event that its list does not hold, next to one that it holds.
 * `tsc` accepts it, because `on` takes the listed names and also other keys. `createMachine` refuses
 * it when the module loads. (With no listed event, `tsc` refuses the key itself, TS2353.) */
const UNDECLARED_EVENT =
  `import { defineEvent } from ${JSON.stringify(KIT_SRC)};\nimport { z } from ${JSON.stringify(ZOD)};\n` +
  `const go = defineEvent({ name: "go", input: z.object({}) });\n` +
  `export const machine = jr2Setup({ events: [go] }).createMachine({\n` +
  `  id: "bad",\n  initial: "a",\n  states: { a: { on: { go: "a", nope: "a" } } },\n});\n`;

/** A Machine of xstate's own `setup()` with an `output` on a final state and none at the root
 * (ADR-0015). `tsc` accepts it, and no jr2 code runs when the module loads. The walk refuses it. */
const LOST_OUTPUT =
  `import { setup } from ${JSON.stringify(XSTATE)};\n` +
  `export const machine = setup({}).createMachine({\n` +
  `  id: "lost",\n  initial: "done",\n  states: { done: { type: "final", output: { outcome: "done" } } },\n});\n`;

/** A workflow that leaves its Repo Slot open: the walk refuses it, after the module loads. */
const OPEN_SLOT =
  `const body = jr2Setup()\n` +
  `  .createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
  `export const machine = workspace(body, { repos: { target: open }, spec: () => ({ branch: "b" }) });\n`;

async function mkInstance(workflows: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-check-"));
  await writeFile(join(root, "jr2.config.ts"), `export default { name: "myinst" };\n`);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "inst", version: "0.0.0" }));
  await linkKit(root);
  await mkdir(join(root, "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    await writeFile(
      join(root, "workflows", `${name}.ts`),
      `import { jr2Setup, open, workspace } from ${JSON.stringify(KIT_SRC)};\nvoid open; void workspace;\n${body}`,
    );
  }
  return root;
}

/** A kube surface that answers only `context` (which `jr2 up` reads before its check), and records
 * every other call. `jr2 check` must make none, not even `context`. */
function recordingKube(calls: string[]): KubeAdmin {
  return new Proxy({} as KubeAdmin, {
    get(_t, prop) {
      return async () => {
        calls.push(String(prop));
        if (prop === "context") return "kind-test";
        throw new Error(`kube.${String(prop)} was called`);
      };
    },
  });
}

function mkIo(root: string, over: Partial<Io> = {}): { io: Io; err: string[]; kube: string[] } {
  const err: string[] = [];
  const kube: string[] = [];
  const io: Io = {
    stdout: () => {},
    stderr: (s) => err.push(s),
    env: {},
    cwd: root,
    kitDir: root,
    kubeAdmin: recordingKube(kube),
    typecheck: async () => ({ ok: true, output: "" }),
    build: new Proxy({} as NonNullable<Io["build"]>, {
      get: (_t, prop) => () => Promise.reject(new Error(`build.${String(prop)} was called`)),
    }),
    ...over,
  };
  return { io, err, kube };
}

/** The lines that say why: each `refusing:` and `error:` line, and the compiler lines under them. */
function why(err: string[]): string[] {
  return err
    .join("")
    .split("\n")
    .filter((l) => /^(refusing|error):|^ {2}\S/.test(l));
}

test("a folder that compiles and loads passes, names its Workflows, and reads no kube context", async () => {
  const root = await mkInstance({
    ping: `export const machine = jr2Setup().createMachine({ id: "ping", initial: "done", states: { done: { type: "final" } } });\n`,
  });
  const w = mkIo(root);
  assert.equal(await main(["check"], w.io), 0);
  const said = w.err.join("");
  assert.match(said, /^jr2 check — instance "myinst" \(no cluster\)$/m);
  assert.match(said, /typecheck: tsc --noEmit \(the instance's own compiler\)/, "the gate of `jr2 up` ran");
  assert.match(said, /^check: passed — 1 workflow\(s\): ping;/m);
  assert.deepEqual(w.kube, [], "no kube call, not even the current context");
});

test("a type error: the refusal of `jr2 up`, line for line, and exit 1", async () => {
  const root = await mkInstance({});
  const output = "workflows/ping.ts(9,5): error TS2551: Property 'mesage' does not exist on type 'Input'.";
  const typecheck = async () => ({ ok: false, output });
  const check = mkIo(root, { typecheck });
  const up = mkIo(root, { typecheck });
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(why(check.err).join("\n"), /does not typecheck[\s\S]*TS2551/);
  assert.deepEqual(check.kube, []);
});

test("a module that the compiler accepts and the load refuses: the error of `jr2 up`", async () => {
  const root = await mkInstance({ bad: UNDECLARED_EVENT });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(
    why(check.err).join("\n"),
    /^error: .*handles event "nope", which no def in jr2Setup\(\{ events \}\) declares \(declared: go\)/m,
  );
  assert.deepEqual(check.kube, []);
});

test("a walk refusal (an Open Repo Slot): the lines of `jr2 up`, and nothing staged or built", async () => {
  const root = await mkInstance({ packaged: OPEN_SLOT });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(why(check.err).join("\n"), /^refusing: workflow "packaged" leaves Repo Slot "target" open/m);
  assert.deepEqual(up.kube, ["context"], "`jr2 up` read the context, and then the same check refused");
  assert.deepEqual(check.kube, []);
});

test("a lost final-state output in a Machine of xstate's `setup()`: the walk refuses it, with the error of `jr2 up`", async () => {
  const root = await mkInstance({ lost: LOST_OUTPUT });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(
    why(check.err).join("\n"),
    /^error: .*machine "lost": final state "lost\.done" declares an output, and the root has no output/m,
  );
  assert.deepEqual(check.kube, []);
});

test("a state that invokes an Agent with no agent.fault route, and a body state with no workspace.lost route: the refusals of `jr2 up` (ADR-0074)", async () => {
  const root = await mkInstance({
    coder:
      `import { agent } from ${JSON.stringify(KIT_SRC)};\n` +
      `export const machine = jr2Setup({ actors: { coder: agent({ model: "p/m", instructions: "i" }) } }).createMachine({\n` +
      `  id: "coder",\n  initial: "working",\n  states: { working: { invoke: { src: "coder", input: { prompt: "go" } } } },\n});\n`,
  });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(
    why(check.err).join("\n"),
    /^error: .*machine "coder": state "coder\.working" invokes an Agent, and no route for "agent\.fault" is on it or on a state above — .*route it on that state or on a state above it, as on: \{ "agent\.fault": "<the state that handles it>" \} \(ADR-0074\)/m,
  );

  const body = await mkInstance({
    bare:
      `const body = jr2Setup().createMachine({ id: "body", initial: "run", states: { run: {}, done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n`,
  });
  const lost = mkIo(body);
  assert.equal(await main(["check"], lost.io), 1);
  assert.match(
    why(lost.err).join("\n"),
    /^error: .*workspace\(\): the body "body" has a state "body\.run" that is not final, and no route for "workspace\.lost" is on it or on a state above — .*as on: \{ "workspace\.lost": "<the state that handles it>" \} \(ADR-0074\)/m,
  );
  assert.deepEqual([...check.kube, ...lost.kube], []);
});

test("each state that invokes a fail() slot is listed, a nested Machine's too, as `jr2 up` lists it (ADR-0073)", async () => {
  const root = await mkInstance({
    ticket:
      `import { fail } from ${JSON.stringify(KIT_SRC)};\n` +
      `const inner = jr2Setup({ actors: { giveUp: fail() } }).createMachine({\n` +
      `  id: "inner", initial: "stuck", states: { stuck: { invoke: { src: "giveUp", input: { reason: "r" } } } },\n});\n` +
      `export const machine = jr2Setup({ actors: { inner, fail: fail() } }).createMachine({\n` +
      `  id: "ticket", initial: "work",\n` +
      `  states: {\n` +
      `    work: { invoke: { src: "inner", onDone: "done" } },\n` +
      `    lost: { initial: "x", states: { x: { invoke: { src: "fail", input: { reason: "lost" } } } } },\n` +
      `    done: { type: "final" },\n  },\n});\n`,
  });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 0);
  const said = check.err.join("");
  assert.match(said, /^failures: workflow "ticket" — the states that fail the run \(ADR-0073\)$/m);
  assert.match(said, /^ {2}ticket\.lost\.x: invokes fail$/m);
  assert.match(said, /^ {2}inner\.stuck \(on "inner"\): invokes giveUp$/m);
  // `jr2 up` runs the same check: the same lines, before it would touch the cluster.
  await main(["up", "--yes"], up.io);
  const listed = (err: string[]): string[] =>
    err
      .join("")
      .split("\n")
      .filter((l) => /^failures:|^ {2}\S.*: invokes /.test(l));
  assert.deepEqual(listed(up.err), listed(check.err));
});

test("in an installed Instance, the `jr2` binary loads the kit from node_modules, where node alone does not strip types", async () => {
  // The installed shape: `@jr2/orchestrator` and `@jr2/cli` are copies under `node_modules`. The
  // checkout's `jr2` hands off to the Instance's own copy (ADR-0056), which checks with the
  // Instance's own compiler and imports each workflow, and with it the kit's `.ts` sources.
  const root = await mkInstalledInstance({ cli: true });
  const run = (args: string[]) =>
    exec(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1" } }).then(
      (r) => ({ code: 0, stderr: r.stderr }),
      (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
    );

  const passed = await run(["check"]);
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stderr, /^check: passed — 1 workflow\(s\): ping;/m);

  // Node alone refuses this import: the kit's sources are under node_modules.
  const bare = await exec(process.execPath, ["--input-type=module", "-e", `await import("./workflows/ping.ts")`], {
    cwd: root,
  }).then(
    () => "",
    (e: { stderr: string }) => e.stderr,
  );
  assert.match(bare, /Stripping types is currently unsupported for files under node_modules/);

  // A listed event that no state takes: the compiler passes it, and `createMachine` refuses it.
  await writeFile(
    join(root, "workflows", "bad.ts"),
    `import { defineEvent, jr2Setup } from "@jr2/orchestrator";\n` +
      `import { z } from "zod";\n` +
      `const go = defineEvent({ name: "go", audience: "external", input: z.object({}) });\n` +
      `export const machine = jr2Setup({ events: [go] }).createMachine({\n` +
      `  id: "bad",\n  initial: "a",\n  states: { a: {} },\n});\n`,
  );
  const refused = await run(["check"]);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(
    refused.stderr,
    /^error: .*declares "go", which no state handles/m,
    "the compiler passed it; the load refused it",
  );
});
