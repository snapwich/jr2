// @kind: an Agent's project context in a real pod (ADR-0062, ADR-0076). The `contexted` and
// `contexted-shared` workflows (`kind-instance/workflows/_contexted.ts`) cut a Worktree, have a
// command write context files in it, in the slot's folder, in `/work` and in jr2's fallback home,
// and then start one Agent, the reader. Its first provider request is parked at the scripted model,
// so each step reads what the model was given: the system prompt of that request, as the provider
// received it. The pod's Harness log says whether the child that loads the files failed.

import { Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { kubectl, waitForAttached, waitForReadySandbox } from "./kind.steps.ts";
import type { E2EWorld } from "./world.ts";

/** The system text of a request body as an OpenAI-compatible provider receives it. */
function systemTextOf(raw: string): string {
  const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    if (m.role !== "system" && m.role !== "developer") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content as Array<{ text?: unknown }>) if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

/** The system prompt of the reader's first request: the first turn request that offers `finish`. */
async function readerSystem(world: E2EWorld): Promise<string> {
  await waitForAttached(world);
  assert.ok(world.provider, "the scenario's scripted model is running (World.setupKind)");
  await world.provider.holding("finish");
  const call = world.provider.calls.find((c) => c.stream && c.tools.includes("mcp__jr2__finish"));
  assert.ok(call, "the reader's request reached the scripted model");
  return systemTextOf(call.raw);
}

const frameOf = (path: string, text: string) => `<project_instructions path="${path}">\n${text}\n`;

Then(
  "the reader's system prompt holds the context file {string} with {string} in pi's frame",
  { timeout: 360_000 },
  async function (this: E2EWorld, path: string, text: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(system.includes("<project_context>\nProject-specific instructions and guidelines:"), system);
    assert.ok(system.includes(frameOf(path, text)), `the frame of ${path}:\n${system}`);
  },
);

Then(
  "the reader's system prompt holds no text of {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, marker: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(!system.includes(marker), `no ${marker} in:\n${system}`);
  },
);

Then(
  "the reader's system prompt names no context file {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, path: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(!system.includes(`<project_instructions path="${path}">`), `no frame of ${path} in:\n${system}`);
  },
);

Then(
  "the reader's system prompt lists the skill {string} with {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, name: string, description: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(system.includes("<skills>\n"), system);
    assert.ok(system.includes(`<name>${name}</name>`) && system.includes(description), system);
    // The skills follow the files, and the Briefing's standing part is last (ADR-0062).
    assert.ok(system.indexOf("</project_context>") < system.indexOf("<skills>"), system);
    assert.ok(system.indexOf("</skills>") < system.indexOf("<jr2-briefing>"), system);
  },
);

Then(
  "the reader's system prompt holds {string} before {string} before {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, a: string, b: string, c: string): Promise<void> {
    const system = await readerSystem(this);
    const [ia, ib, ic] = [system.indexOf(a), system.indexOf(b), system.indexOf(c)];
    assert.ok(ia >= 0 && ib > ia && ic > ib, `the outermost first: ${a}, ${b}, ${c} in:\n${system}`);
  },
);

Then(
  "the domain wrote jr2's fallback home, and the Harness logged no failure to load a project context",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    // The command ran in the domain, as each of the Agent's programs does: it wrote the home.
    const home = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-c",
      'cat "$HOME/.pi/agent/AGENTS.md"',
    ]);
    assert.equal(home.trim(), "CTX-HOME-RULE");
    const log = await kubectl(this, ["logs", `pod/${pod}`, "-c", "harness"]);
    assert.doesNotMatch(
      log,
      /no project context/,
      log
        .split("\n")
        .filter((l) => /project context/.test(l))
        .join("\n"),
    );
    assert.doesNotMatch(log, /the image user's context in .* is read/, "jr2's fallback home is never the image's");
  },
);
