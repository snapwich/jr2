// The Agent as a slot (ADR-0049): `agent(definition)` brands its logic with the definition, and
// `isAgent` is how everything else — the menu walk above all — recognizes one.
//
// `loadAgents` is the TEMPORARY roster the deployed Harness still reads (`J2_AGENTS_JSON`): its
// discovery mirrors workflow discovery (filename = name, `_` and `.d.ts` ignored), and a file that
// is not a definition fails LOUDLY — a silently thinner Harness is the failure mode it guards
// against. It retires with the `agents/` folder when the definition rides the Turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromCallback } from "xstate";
import { isAgent, loadAgents, type AgentDefinition } from "../src/agent.ts";
import { agent } from "../src/harness-client.ts";

async function mkInstance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-agents-"));
  await mkdir(join(dir, "agents"));
  return dir;
}

test("agent(def) is actor logic BRANDED with its definition — the whole slot mechanism (ADR-0049)", () => {
  const definition: AgentDefinition = { model: "m", instructions: "i", workspace: "none" };
  const logic = agent(definition);

  assert.ok(isAgent(logic), "the menu walk recognizes it by the brand, not by a reserved src name");
  assert.equal((logic as unknown as { definition: AgentDefinition }).definition, definition, "the same object");
  // Two slots over ONE definition are two DISTINCT logics: the closure is per-slot, which is what
  // lets two Machines each carry their own `coder`.
  assert.notEqual(agent(definition), logic);
});

test("isAgent rejects everything that is not a slot — a provide() fake included", () => {
  assert.equal(isAgent(fromCallback(() => {})), false, "the unit-test seam's fake is not an Agent");
  assert.equal(isAgent(undefined), false);
  assert.equal(isAgent({ definition: { model: "m" } }), false, "a definition needs BOTH fields");
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

test("loadAgents: a definition omitting `model` fails — there is no instance-wide default (ADR-0018)", async () => {
  const dir = await mkInstance();
  await writeFile(join(dir, "agents", "coder.ts"), `export default { instructions: "i" };\n`);
  await assert.rejects(() => loadAgents(dir), /agent "coder".*BOTH are required/s);
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
