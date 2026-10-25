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

/** A Machine whose `on` key names no listed event: `createMachine` refuses it when the module
 * loads, and the compiler does not see it. */
const UNDECLARED_EVENT =
  `export const machine = jr2Setup({ events: [] }).createMachine({\n` +
  `  id: "bad",\n  initial: "a",\n  states: { a: { on: { nope: "a" } } },\n});\n`;

/** A workflow that leaves its Repo Slot open: the walk refuses it, after the module loads. */
const OPEN_SLOT =
  `const body = jr2Setup({ events: [] })\n` +
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
    ping: `export const machine = jr2Setup({ events: [] }).createMachine({ id: "ping", initial: "done", states: { done: { type: "final" } } });\n`,
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

test("a module that refuses to load: the error of `jr2 up`, which `npm run typecheck` does not give", async () => {
  const root = await mkInstance({ bad: UNDECLARED_EVENT });
  const check = mkIo(root);
  const up = mkIo(root);
  assert.equal(await main(["check"], check.io), 1);
  assert.equal(await main(["up", "--yes"], up.io), 1);
  assert.deepEqual(why(check.err), why(up.err));
  assert.match(
    why(check.err).join("\n"),
    /^error: .*handles event "nope", which no def in jr2Setup\(\{ events \}\) declares/m,
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
