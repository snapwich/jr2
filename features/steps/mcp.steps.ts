// MCP servers in the config, and the refusals a black-box CLI can see with no cluster (ADR-0079).
// `jr2 check` runs the Instance check that `jr2 up` runs before it stages the Assembly (ADR-0050),
// so each refusal here is `jr2 up`'s, with its text and exit code 1. The publish door runs the walk
// of the Agents' `mcp` lists too, so a publish that skipped `jr2 up` is refused there, and the old
// Assembly keeps serving (ADR-0069).
//
// What these steps cannot see is the live check of each allowlisted tool name: `jr2 up` reads the
// tool list from the check pod, through its Custodian (ADR-0019), and a host-booted fixture has no
// check pod. The @kind tier sees it (`kind-mcp.steps.ts`).
//
// The steps write the config and the workflows into the scenario's instance as source, so each
// scenario states the one entry it is about. The instance's own `tsc --noEmit` checks them first.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2EWorld, type PublishAnswer } from "./world.ts";

/** The secret every scenario's config holds: an MCP server's `secret` names an entry of `secrets`. */
const SECRET = "NOTES_TOKEN";

/** Per scenario: the door's answer to a refused publish, and the hash that was current before it. */
const refused = new WeakMap<E2EWorld, PublishAnswer>();
const before = new WeakMap<E2EWorld, string>();

/** The scenario's `jr2.config.ts`: the one secret, and the `mcp` block's entries as given. */
async function writeConfig(world: E2EWorld, entries: string): Promise<void> {
  const source = [
    'import { defineConfig } from "@jr2/orchestrator";',
    "",
    "export default defineConfig({",
    `  secrets: [{ name: "${SECRET}", value: "notes-token-for-the-e2e-check" }],`,
    `  mcp: {${entries.trim() ? `\n${indent(entries.trim(), 4)}\n  ` : ""}},`,
    "});",
    "",
  ].join("\n");
  await writeFile(join(world.dir, "jr2.config.ts"), source);
}

function indent(text: string, n: number): string {
  return text
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");
}

async function writeWorkflow(world: E2EWorld, name: string, source: string): Promise<void> {
  await mkdir(join(world.dir, "workflows"), { recursive: true });
  await writeFile(join(world.dir, "workflows", `${name}.ts`), source);
}

/** A workflow whose one Agent names MCP servers with `entries` (the source of its `mcp` list). */
function agentWorkflow(name: string, entries: string, workspace: "none" | "write"): string {
  return `import { z } from "zod";
import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";

const done = defineEvent({ name: "done", input: z.object({ summary: z.string() }) });

export const machine = jr2Setup({
  types: {} as { context: {}; input: {} },
  events: [done],
  actors: {
    clerk: agent({
      model: "anthropic/claude-haiku-5-5",
      description: "Answers questions about the team's notes.",
      workspace: "${workspace}",
      instructions: "You answer questions about the team's notes.",
      mcp: [${entries}],
    }),
  },
}).createMachine({
  id: "${name}",
  initial: "working",
  on: { "agent.fault": ".faulted" },
  states: {
    working: { invoke: { src: "clerk", input: { prompt: "Find the notes on the release." } }, on: { done: "finished" } },
    finished: { type: "final" },
    faulted: { type: "final" },
  },
});
`;
}

/**
 * A workflow whose one Agent works in a Sandbox and names MCP servers with `entries`, in a
 * workspace() with no Repo Slot (ADR-0051) whose `secrets` list grants `grant` (ADR-0059).
 */
function grantedWorkflow(name: string, entries: string, grant: string): string {
  return `import { z } from "zod";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";

const done = defineEvent({ name: "done", input: z.object({ summary: z.string() }) });
type BodyInput = Workspaced<HostInjectedInput, never>;

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [done],
  actors: {
    clerk: agent({
      model: "anthropic/claude-haiku-5-5",
      description: "Answers questions about the team's notes.",
      instructions: "You answer questions about the team's notes.",
      mcp: [${entries}],
    }),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "working",
  on: { "workspace.lost": ".faulted", "agent.fault": ".faulted" },
  states: {
    working: { invoke: { src: "clerk", input: { prompt: "Find the notes on the release." } }, on: { done: "finished" } },
    finished: { type: "final" },
    faulted: { type: "final" },
  },
});

export const machine = workspace(body, { secrets: [${JSON.stringify(grant)}] });
`;
}

/** A workflow with one `mcp` Effect and no Agent: it calls `tool` of `server` with a query. */
function effectWorkflow(name: string, server: string, tool: string): string {
  return `import { z } from "zod";
import { jr2Setup, mcp } from "@jr2/orchestrator";

export const machine = jr2Setup({
  types: {} as { context: {}; input: {} },
  actors: { search: mcp.call(${JSON.stringify(server)}, ${JSON.stringify(tool)}, { input: z.object({ query: z.string() }) }) },
}).createMachine({
  id: "${name}",
  initial: "searching",
  states: {
    searching: { invoke: { src: "search", input: { query: "release" }, onDone: "finished" } },
    finished: { type: "final" },
  },
});
`;
}

Given("the instance's mcp block declares:", async function (this: E2EWorld, entries: string): Promise<void> {
  await writeConfig(this, entries);
});

Given("the instance's mcp block declares no server", async function (this: E2EWorld): Promise<void> {
  await writeConfig(this, "");
});

Given(
  "a workflow {string} whose Menu-only Agent has the MCP list [{}]",
  async function (this: E2EWorld, name: string, entries: string): Promise<void> {
    await writeWorkflow(this, name, agentWorkflow(name, entries, "none"));
  },
);

Given(
  "a workflow {string} whose Sandbox Agent has the MCP list [{}], in a workspace\\() that grants {string}",
  async function (this: E2EWorld, name: string, entries: string, grant: string): Promise<void> {
    await writeWorkflow(this, name, grantedWorkflow(name, entries, grant));
  },
);

Given(
  "a workflow {string} whose mcp Effect calls the tool {string} of the server {string}",
  async function (this: E2EWorld, name: string, tool: string, server: string): Promise<void> {
    await writeWorkflow(this, name, effectWorkflow(name, server, tool));
  },
);

When("I check the instance", { timeout: 120_000 }, async function (this: E2EWorld): Promise<void> {
  await this.runCli(["check"]);
});

/** Each refusal is one line, so each quoted part must be on the same line as the first. */
Then("the check refuses it with the line naming:", function (this: E2EWorld, table: { raw(): string[][] }): void {
  const r = this.last;
  assert.ok(r, "the check ran");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.code, 1, `jr2 check exits 1 on a refusal:\n${out}`);
  const parts = table.raw().map((row) => row[0]!);
  const line = out.split("\n").find((l) => parts.every((p) => l.includes(p)));
  assert.ok(line, `no one line of the check's output holds every part ${JSON.stringify(parts)}:\n${out}`);
});

Then("the check passes", function (this: E2EWorld): void {
  const r = this.last;
  assert.ok(r, "the check ran");
  assert.equal(r.code, 0, `jr2 check failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /check: passed/);
});

When("I publish the Assembly and the door refuses it", async function (this: E2EWorld): Promise<void> {
  const current = this.published?.body.hash;
  assert.ok(current, "the fixture published first");
  before.set(this, current);
  refused.set(this, await this.publish({ expectRefusal: true }));
});

Then(
  "the door's refusal names the MCP server {string} of the workflow {string}",
  function (this: E2EWorld, server: string, workflow: string): void {
    const answer = refused.get(this);
    assert.equal(answer?.status, 422, JSON.stringify(answer?.body));
    const report = (answer?.body.report ?? []).join("\n");
    assert.ok(
      report.includes(`workflow "${workflow}"`) && report.includes(`names the MCP server "${server}"`),
      `the door's report: ${report}`,
    );
  },
);

Then("the Orchestrator still serves the Assembly it served before the refusal", async function (this: E2EWorld) {
  const url = this.server?.url;
  assert.ok(url, "the orchestrator is serving");
  const res = await fetch(`${url.replace(/\/+$/, "")}/assembly`);
  const view = (await res.json()) as { current?: { hash: string } | null };
  assert.equal(view.current?.hash, before.get(this), "the refusal left the old Assembly current");
});
