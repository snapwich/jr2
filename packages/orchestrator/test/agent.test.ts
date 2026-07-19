// Agent definitions (ADR-0018): discovery mirrors workflow discovery (filename = name, `_` and
// `.d.ts` ignored), and a file that is not a definition fails LOUDLY — a silently thinner Harness
// is the failure mode this guards against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent, loadAgents } from "../src/agent.ts";

async function mkInstance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-agents-"));
  await mkdir(join(dir, "agents"));
  return dir;
}

test("defineAgent is an identity passthrough", () => {
  const def = { model: "m", instructions: "i" };
  assert.equal(defineAgent(def), def);
});

test("loadAgents: filename discovery, sorted, helpers ignored", async () => {
  const dir = await mkInstance();
  const def = `export default { model: "m", instructions: "i" };\n`;
  await writeFile(join(dir, "agents", "reviewer.ts"), def);
  await writeFile(join(dir, "agents", "coder.ts"), def);
  await writeFile(join(dir, "agents", "_shared.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "agents", "types.d.ts"), "export type T = 1;\n");

  const agents = await loadAgents(dir);
  assert.deepEqual(
    agents.map((a) => a.name),
    ["coder", "reviewer"],
  );
  assert.equal(agents[0]!.definition.model, "m");
});

test("loadAgents: a definition may omit `model` — the instance's `harness.model` default applies at assembly (ADR-0018)", async () => {
  const dir = await mkInstance();
  await writeFile(join(dir, "agents", "coder.ts"), `export default { instructions: "i" };\n`);
  const agents = await loadAgents(dir);
  assert.equal(agents[0]!.definition.model, undefined);
  assert.equal(agents[0]!.definition.instructions, "i");
});

test("loadAgents: no agents/ dir is fine; a non-definition module throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-agents-"));
  assert.deepEqual(await loadAgents(dir), []);

  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "broken.ts"), "export const machine = 1;\n");
  await assert.rejects(() => loadAgents(dir), /not a definition/);
});

test("loadAgents: only ENOENT maps to empty — an unreadable agents/ path throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-agents-"));
  await writeFile(join(dir, "agents"), "not a directory\n");
  await assert.rejects(
    () => loadAgents(dir),
    (err: NodeJS.ErrnoException) => err.code === "ENOTDIR",
  );
});
