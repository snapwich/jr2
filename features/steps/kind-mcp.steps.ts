// @kind: MCP servers on a real cluster (ADR-0079). The fake remote server runs on the host
// (`fake-mcp.ts`), over HTTPS under the tier's CA, and takes two keys. The kind config declares it
// twice, as `lookup-a` and `lookup-b`, each with its own key, both bound to one host in one header
// (ADR-0059). Three paths reach it, and each step reads what reached it from outside the pod:
//
//   - the check pod of every converge lists its tools through the check pod's Custodian, and
//     `jr2 up` holds each Agent's allowlist to that list (ADR-0019);
//   - the `tooled` workflow's Agent, in a Sandbox, calls a tool of each server: the Harness is the
//     client, and the Sandbox's Custodian puts the value of each server's key on its own call;
//   - the `mcpcalled` workflow's `mcp` Effect calls `lookup-a` from the Instance Effector, which
//     holds that key as an Effect secret.
//
// The fake records the Authorization header of every request, so "the server saw the value and
// never a Stand-in" is a fact of its record: a request with any other bearer is refused 401 and
// recorded as refused.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { isSettled } from "../lib/run-settled.ts";
import { leakOf, waitForAttached } from "./kind.steps.ts";
import { ensureSeed } from "./seed.ts";
import { E2EWorld } from "./world.ts";

/** The servers of the kind config's `mcp` block, and the secret each names. */
const SECRET_OF: Record<string, string> = { "lookup-a": "MCP_A_KEY", "lookup-b": "MCP_B_KEY" };

/** The value of the secret that `server` names, this scenario's (`setupKind`). */
function keyOf(world: E2EWorld, server: string): string {
  const name = SECRET_OF[server];
  assert.ok(name, `the kind config declares no MCP server "${server}"`);
  const value = world.mcpKeys?.[name];
  assert.ok(value, `setupKind made the value of ${name}`);
  return value;
}

/** The MCP tool's name as the model reads it (ADR-0079). */
const modelName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

Given("the fake MCP server lists no tool {string}", function (this: E2EWorld, tool: string): void {
  assert.ok(this.mcp, "setupKind started the fake MCP server");
  this.mcp.listed.delete(tool);
});

// The converge that a scenario expects to be refused. The same command as "the kind instance is
// serving", which asserts success.
When("I converge the kind instance", { timeout: 600_000 }, async function (this: E2EWorld): Promise<void> {
  await ensureSeed();
  await this.runCli(["up", "--yes"]);
});

Then(
  "the converge listed the tools of {string} and {string} from a check pod",
  function (this: E2EWorld, a: string, b: string): void {
    const out = `${this.last?.stdout ?? ""}\n${this.last?.stderr ?? ""}`;
    for (const server of [a, b]) {
      assert.match(
        out,
        new RegExp(`mcp: "${server}" lists 1 tool\\(s\\); every allowlisted name is there`),
        `the converge checked the allowlists of "${server}" against its live list:\n${out}`,
      );
    }
    // Each listing came with the value of its own server's key: the check pod's Custodian chose it
    // by the Stand-in (ADR-0059). A listing with no key, or with a Stand-in, would be refused.
    const listings = (this.mcp?.requests ?? []).filter((r) => r.rpc === "tools/list");
    assert.ok(listings.length >= 2, `the fake MCP server was listed twice or more: ${JSON.stringify(listings)}`);
    for (const r of listings) assert.equal(r.refused, undefined, `a listing was refused: ${JSON.stringify(r)}`);
    const keys = new Set(listings.map((r) => r.authorization));
    for (const server of [a, b])
      assert.ok(
        keys.has(`Bearer ${keyOf(this, server)}`),
        `a listing of "${server}" carried that server's own key, not the key of the other server`,
      );
  },
);

Then(
  "the converge is refused, naming the tool {string} that {string} does not list",
  function (this: E2EWorld, tool: string, server: string): void {
    const r = this.last;
    assert.ok(r, "the converge ran");
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.code, 0, `jr2 up refuses a missing tool name:\n${out}`);
    assert.ok(
      out.includes(`allowlists the tool "${tool}", which "${server}" does not list`),
      `the refusal names the tool and the server:\n${out}`,
    );
  },
);

When(
  "the Agent in the Sandbox calls the MCP tool {string} of {string} with query {string}",
  async function (this: E2EWorld, tool: string, server: string, query: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await waitForAttached(this); // the Turn, and its tools/list, cannot exist before the attach
    await this.provider.release(modelName(server, tool), { query });
  },
);

// The same release for a Turn on the Instance Harness (ADR-0031): no Workspace to wait for.
When(
  "the model calls the MCP tool {string} of {string} with query {string}",
  async function (this: E2EWorld, tool: string, server: string, query: string): Promise<void> {
    assert.ok(this.provider, "the scenario's scripted model is running (World.setupKind)");
    await this.provider.release(modelName(server, tool), { query });
  },
);

Then(
  "the fake MCP server got the call of {string} with query {string} with that server's key",
  function (this: E2EWorld, server: string, query: string): void {
    assert.ok(this.mcp, "setupKind started the fake MCP server");
    const calls = this.mcp.requests.filter((r) => r.rpc === "tools/call" && r.args?.query === query);
    assert.equal(calls.length, 1, `one call of ${server}'s lookup with query ${query}: ${JSON.stringify(calls)}`);
    assert.equal(
      calls[0]!.authorization,
      `Bearer ${keyOf(this, server)}`,
      `the call through "${server}" carried that server's own key: the Instance Harness's Custodian holds it`,
    );
    assert.deepEqual(
      this.mcp.requests.filter((r) => r.refused),
      [],
      "every request carried the value of a key, never a Stand-in or nothing",
    );
  },
);

Then(
  "the model was offered the MCP tools after the Working tools and before the Menu",
  function (this: E2EWorld): void {
    assert.ok(this.provider, "the scenario's scripted model is running");
    const turn = this.provider.calls.find((c) => c.stream && c.tools.includes(modelName("lookup-a", "lookup")));
    assert.ok(turn, "a Turn was offered the MCP tools");
    const tools = turn.tools;
    const mcp = tools.filter((t) => t.startsWith("mcp__") && !t.startsWith("mcp__jr2__"));
    // The allowlisted tools, sorted by name (ADR-0079), and no other tool of the server.
    assert.deepEqual(mcp, [modelName("lookup-a", "lookup"), modelName("lookup-b", "lookup")]);
    const firstMcp = tools.indexOf(mcp[0]!);
    const lastMcp = tools.indexOf(mcp[mcp.length - 1]!);
    const working = tools.filter((t) => !t.startsWith("mcp__"));
    const menu = tools.filter((t) => t.startsWith("mcp__jr2__"));
    assert.ok(working.length > 0 && menu.length > 0, `the Turn has Working tools and a Menu: ${tools.join(", ")}`);
    assert.ok(
      working.every((t) => tools.indexOf(t) < firstMcp) && menu.every((t) => tools.indexOf(t) > lastMcp),
      `the tools block is the Working tools, then the MCP tools, then the Menu (ADR-0029): ${tools.join(", ")}`,
    );
  },
);

Then(
  "the fake MCP server got each call with its own server's key, and no request without a key",
  function (this: E2EWorld): void {
    assert.ok(this.mcp, "setupKind started the fake MCP server");
    const requests = this.mcp.requests;
    const refused = requests.filter((r) => r.refused);
    assert.deepEqual(refused, [], "every request carried the value of a key, never a Stand-in or nothing");
    for (const [server, query] of [
      ["lookup-a", "alpha"],
      ["lookup-b", "beta"],
    ] as const) {
      const calls = requests.filter((r) => r.rpc === "tools/call" && r.args?.query === query);
      assert.equal(calls.length, 1, `one call of ${server}'s lookup with query ${query}: ${JSON.stringify(calls)}`);
      assert.equal(calls[0]!.tool, "lookup");
      assert.equal(
        calls[0]!.authorization,
        `Bearer ${keyOf(this, server)}`,
        `the call through "${server}" carried that server's own key: the Custodian chose it by the Stand-in`,
      );
    }
  },
);

/** The run's output once it has settled, read off `jr2 status`. */
async function settledOutput(world: E2EWorld): Promise<{ status: string; output: Record<string, unknown> }> {
  let last: { status: string; context?: { output?: Record<string, unknown> } } | undefined;
  for (let i = 0; i < 240; i++) {
    const r = await world.runCli(["status", world.runId!]);
    assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
    const read: { status: string; context?: { output?: Record<string, unknown> } } = world.resultJson();
    last = read;
    if (isSettled(read.status)) break;
    await sleep(500);
  }
  assert.ok(last && isSettled(last.status), `the run never settled: ${JSON.stringify(last)}`);
  return { status: last.status, output: last.context?.output ?? {} };
}

Then("the mcp Effect's answer is the tool's result for the run's marker", async function (this: E2EWorld) {
  const { status, output } = await settledOutput(this);
  assert.equal(status, "done", JSON.stringify(output));
  assert.equal(output.outcome, "returned", JSON.stringify(output));
  assert.equal(output.isError, false);
  assert.equal(output.text, `lookup-ok:${this.marker}`);
  assert.deepEqual(output.structured, { query: this.marker, found: true }, "the tool's structuredContent");
});

Then(
  "the fake MCP server got the Effect's call with the key of {string}, and no form of the key reached the run",
  async function (this: E2EWorld, server: string): Promise<void> {
    assert.ok(this.mcp, "setupKind started the fake MCP server");
    const key = keyOf(this, server);
    const calls = this.mcp.requests.filter((r) => r.rpc === "tools/call" && r.args?.query === this.marker);
    assert.equal(calls.length, 1, `the Effect called the tool once: ${JSON.stringify(calls)}`);
    assert.equal(calls[0]!.authorization, `Bearer ${key}`, "the Instance Effector sent the key's value");
    // The Effect's session: its handshake and its call each carried the key (ADR-0079).
    const refused = this.mcp.requests.filter((r) => r.refused);
    assert.deepEqual(refused, [], "every request carried the value of a key");
    const status = await this.runCli(["status", this.runId!]);
    const logs = await this.runCli(["logs", this.runId!]);
    for (const [where, seen] of [
      ["the run's record", status.stdout],
      ["the run's log", logs.stdout + logs.stderr],
    ] as const) {
      const leak = leakOf(seen, key);
      assert.equal(leak, undefined, `a form of the key (${leak}) is in ${where}`);
    }
  },
);
