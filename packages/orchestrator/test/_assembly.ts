// Publishing a fixture Assembly in-process (ADR-0069). The door is the one way in: there is no
// folder boot, so a test copies a tree into a staging directory and calls the door's `admit`,
// which writes the real layout and the real pointer. A tree that imports bare names must sit
// under this package, where `xstate` and `@jr2/orchestrator` resolve: `scratchInstance` makes
// such a folder, outside tsconfig's `src`/`test` globs.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnyStateMachine } from "xstate";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembliesDir, type PublishAnswer } from "../src/assembly.ts";
import { KIT_VERSION } from "../src/config.ts";
import { assemblyHash } from "../src/content-hash.ts";
import type { RunningInstance } from "../src/instance.ts";

/** This package's root: a scratch folder here resolves the package's own dependencies. */
export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The bootstrap suite's fixture tree (`workflows/echo.ts`). */
export const FIXTURE_ASSEMBLY = join(PKG_DIR, "test", "fixtures", "instance");

/** A fresh instance folder under this package, named `.<prefix>-*`. */
export function scratchInstance(prefix = "inst"): Promise<string> {
  return mkdtemp(join(PKG_DIR, `.${prefix}-`));
}

/** A tree as a source folder, or as files by relative path. */
export type TreeSource = string | Record<string, string>;

/** Copy `src` into a new staging directory of `dir`'s Assembly store, as an unpack would leave it:
 * `<staging>/tree`. Returns the staging directory and the tree's hash. */
export async function stageTree(dir: string, src: TreeSource): Promise<{ staging: string; hash: string }> {
  const staging = join(assembliesDir(dir), `.staging-test-${randomBytes(4).toString("hex")}`);
  const tree = join(staging, "tree");
  await mkdir(tree, { recursive: true });
  if (typeof src === "string") await cp(src, tree, { recursive: true });
  else {
    for (const [rel, text] of Object.entries(src)) {
      await mkdir(dirname(join(tree, rel)), { recursive: true });
      await writeFile(join(tree, rel), text);
    }
  }
  return { staging, hash: await assemblyHash(tree) };
}

/** Admit `src` through `inst`'s door. Returns the door's answer. */
export async function admitTree(inst: RunningInstance, dir: string, src: TreeSource): Promise<PublishAnswer> {
  const { staging, hash } = await stageTree(dir, src);
  return inst.admit(staging, { hash, kitVersion: KIT_VERSION });
}

/** Admit `src` and require it to land. Returns its hash. */
export async function publishTree(inst: RunningInstance, dir: string, src: TreeSource): Promise<string> {
  const answer = await admitTree(inst, dir, src);
  assert.equal(answer.status, 200, `the fixture Assembly was refused: ${JSON.stringify(answer.body)}`);
  return answer.body.hash as string;
}

/** What the volume holds for one hash (ADR-0069): its tree, and its record `<hash>.json`. */
export function onVolume(dir: string, hash: string): { tree: boolean; record: boolean } {
  return {
    tree: existsSync(join(assembliesDir(dir), hash)),
    record: existsSync(join(assembliesDir(dir), `${hash}.json`)),
  };
}

/** The Assembly hashes on the volume, by tree or record, sorted. Never the pointer or staging. */
export async function hashesOnVolume(dir: string): Promise<string[]> {
  const names = await readdir(assembliesDir(dir)).catch(() => [] as string[]);
  const hashes = new Set(names.map((n) => n.replace(/\.json$/, "")).filter((n) => /^[0-9a-f]{12}$/.test(n)));
  return [...hashes].sort();
}

// ---- Chart wrappers (ADR-0070) ------------------------------------------------------------------

/** The absolute URL of a module of this package's `src/`, for a tree that resolves no bare name. */
const srcUrl = (file: string): string => JSON.stringify(pathToFileURL(join(PKG_DIR, "src", file)).href);

/** The fixture Chart the grammar seam wrote: `draft` invokes the lent `coder`, `review` a minted
 * `reviewer`, `revise` routes through the lent guard `underLimit`. */
export const REVIEW_LOOP = join(PKG_DIR, "test", "fixtures", "charts", "review-loop.chart.json");

/** The review-loop Chart's text. */
export async function reviewLoop(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(REVIEW_LOOP, "utf8")) as Record<string, unknown>;
}

/**
 * The source of a Chart wrapper `workflows/<name>.ts` (ADR-0070): a door `{ endpoint, task, chart }`
 * (`chart` is `chartSchema`, so it is a one-shot door), a lent Agent `coder` and a lent guard
 * `underLimit`, and an Open body `body` that allows the stub model with `"none"` or `"write"`.
 * `lendCoder: false` drops `coder` from the lent set, as a publish that stops lending it does;
 * `door: false` leaves the door with no Chart field. Every import is an absolute URL, so the tree
 * may sit anywhere.
 */
export function chartedSrc(opts: { id?: string; lendCoder?: boolean; door?: boolean } = {}): string {
  const lends =
    opts.lendCoder === false ? `{ guards: ["underLimit"] }` : `{ agents: ["coder"], guards: ["underLimit"] }`;
  const door =
    opts.door === false
      ? `z.object({ endpoint: z.string(), task: z.string() })`
      : `z.object({ endpoint: z.string(), task: z.string(), chart: chartSchema })`;
  return (
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` +
    `import { jr2Setup } from ${srcUrl("setup.ts")};\n` +
    `import { agent } from ${srcUrl("harness-client.ts")};\n` +
    `import { openBody } from ${srcUrl("open-body.ts")};\n` +
    `import { chartSchema } from ${srcUrl("chart.ts")};\n` +
    `export const machine = jr2Setup({\n` +
    `  events: [],\n` +
    `  actors: {\n` +
    `    coder: agent({ model: "stub/model", instructions: "You write code." }),\n` +
    `    body: openBody({ lends: ${lends}, allows: { models: ["stub/model"], workspace: ["none", "write"] },\n` +
    `      ceilings: { turns: 6, wallClock: "10m", transitions: 500, fanOut: 2, size: 65536 } }),\n` +
    `  },\n` +
    `  guards: { underLimit: () => true },\n` +
    `}).createMachine({\n` +
    `  id: ${JSON.stringify(opts.id ?? "charted")},\n` +
    `  input: ${door},\n` +
    `  context: ({ input }) => ({ ...input }),\n` +
    `  initial: "running",\n` +
    `  states: {\n` +
    `    running: { invoke: { id: "body", src: "body", input: ({ context }) => context, onDone: "done" } },\n` +
    `    done: { type: "final" },\n` +
    `  },\n` +
    `});\n`
  );
}

/** A plain Workflow: one state, no Open body. */
export function plainSrc(id: string): string {
  return (
    `import { setup } from ${JSON.stringify(import.meta.resolve("xstate"))};\n` +
    `export const machine = setup({}).createMachine({ id: ${JSON.stringify(id)}, initial: "a", states: { a: {} } });\n`
  );
}

/** Import a Workflow source as its Machine, from a file of its own under the temp root. */
export async function machineOf(src: string): Promise<AnyStateMachine> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-machine-"));
  const file = join(dir, "workflow.ts");
  await writeFile(file, src);
  return ((await import(pathToFileURL(file).href)) as { machine: AnyStateMachine }).machine;
}
