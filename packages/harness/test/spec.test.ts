// What the Harness is handed (ADR-0018/0027/0049/0057), in its two pieces: the DEFINITION, which
// is identity, and this Turn's FRAME and DIALS, which are not. `definitionFault` must be LOUD
// about every definition that would otherwise become a silently thinner or mute turn — it is the
// per-admission check that replaced the retired boot-time roster sweep — `frameFault` is the same
// loudness for the Frame's `cwd`, `resolveDefinition` is the per-Submission read (the Frame's
// `cwd`, the Submission's dials and the `/work`/`write` defaults resolve here, at turn start), and
// `loadHarnessSpec` reads the one thing still mounted: what this instance can REACH.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  definitionFault,
  frameFault,
  loadHarnessSpec,
  mcpAdmissionFault,
  mcpServersFor,
  resolveDefinition,
  type AgentDefinition,
  type HarnessSpec,
} from "../src/spec.ts";

const coder: AgentDefinition = { instructions: "be the coder", model: "anthropic/claude-x" };

test("definitionFault: a complete definition passes", () => {
  assert.equal(definitionFault("coder", coder), undefined);
  assert.equal(definitionFault("coder", { ...coder, workspace: "none", thinkingLevel: "high" }), undefined);
});

test("definitionFault: `cwd` and `description` are no longer the definition's to judge (ADR-0057)", () => {
  // `cwd` belongs to the Turn's Frame — a worktree path exists only once a run does, so no
  // definition can name one — and `description` is Console material the Orchestrator strips
  // before admission. Neither reaches this check, so neither can fail it, whatever it carries.
  assert.equal(definitionFault("coder", { ...coder, cwd: 7, description: 9 }), undefined);
});

test("frameFault: a Frame `cwd` that is not a path is refused, and the message names the Frame (ADR-0057)", () => {
  assert.equal(frameFault("coder", { message: "go" }), undefined);
  assert.equal(frameFault("coder", { message: "go", cwd: "/work/target/feature" }), undefined);
  assert.equal(frameFault("coder", undefined), undefined);
  // Silently rooting at `/work` is the failure ADR-0057 was written for: the Turn would work in
  // the parent of every checkout and call itself done.
  assert.match(String(frameFault("coder", { message: "go", cwd: 7 })), /agent "coder".*Frame.*`cwd`/s);
  assert.match(String(frameFault("coder", { message: "go", cwd: "" })), /Frame/);
  // A RELATIVE path is the same incident wearing a path's clothes: it roots the Working tools at
  // whatever the Harness process happens to sit in, which no one named (ADR-0057).
  assert.match(String(frameFault("coder", { message: "go", cwd: "target/feature" })), /Frame.*absolute/s);
  assert.match(String(frameFault("coder", { message: "go", cwd: "./work" })), /Frame.*absolute/s);
});

test("definitionFault: NO definition on the admission is the loud one — the Turn carries it (ADR-0049)", () => {
  // The Harness holds no roster to fall back to, so this is not "unknown agent": it is an
  // admission that named a slot and brought nothing to run.
  assert.match(String(definitionFault("coder", undefined)), /agent "coder": the admission carries no definition/);
  assert.match(String(definitionFault("coder", "coder")), /carries no definition/);
});

test("definitionFault: instructions and model are both required, and the message names the slot", () => {
  assert.match(String(definitionFault("coder", { model: "anthropic/claude-x" })), /agent "coder".*no `instructions`/s);
  assert.match(String(definitionFault("coder", { instructions: "i" })), /agent "coder".*names no model/s);
  // No instance-wide model default has ever existed (ADR-0018) — the definition is where a model
  // is checkable, and now it arrives per Turn.
  assert.match(String(definitionFault("coder", { instructions: "i", model: "" })), /no instance-wide default/);
});

test("definitionFault: off-scale enums fail before pi ever sees them", () => {
  assert.match(String(definitionFault("coder", { ...coder, thinkingLevel: "max" })), /thinkingLevel "max"/);
  assert.match(String(definitionFault("coder", { ...coder, workspace: "rw" })), /workspace "rw"/);
});

test("resolveDefinition: the definition supplies the values; defaults apply", () => {
  assert.deepEqual(resolveDefinition({ instructions: "code", model: "anthropic/claude-x", thinkingLevel: "high" }), {
    model: "anthropic/claude-x",
    instructions: "code",
    cwd: "/work",
    workspace: "write",
    thinkingLevel: "high",
  });
  // `workspace` carries through resolution (ADR-0028) — it is the field the Working-tool assembly
  // filters by, so dropping it here would silently hand a reviewer the write/edit tools.
  assert.deepEqual(resolveDefinition({ instructions: "review", model: "vllm/q", workspace: "read" }), {
    model: "vllm/q",
    instructions: "review",
    cwd: "/work",
    workspace: "read",
  });
});

test("resolveDefinition: `cwd` resolves from this Turn's Frame (ADR-0057)", () => {
  const definition: AgentDefinition = { instructions: "code", model: "anthropic/claude-x" };
  // Where the Turn works is the Frame's to say — the worktree this run made, which no definition
  // could have named.
  assert.equal(resolveDefinition(definition, { cwd: "/work/target/feature" }).cwd, "/work/target/feature");
  // A Frame with no `cwd` keeps `/work` (ADR-0005) — the stub-Harness run with no Workspace.
  assert.equal(resolveDefinition(definition, {}).cwd, "/work");
  assert.equal(resolveDefinition(definition).cwd, "/work");
  // And the definition has no say: a `cwd` on it is not the Harness's field any more (ADR-0057).
  assert.equal(resolveDefinition({ ...definition, cwd: "/elsewhere" } as AgentDefinition).cwd, "/work");
});

test("resolveDefinition: this Submission's dials win over the definition (ADR-0018)", () => {
  const definition: AgentDefinition = { instructions: "code", model: "anthropic/claude-x", thinkingLevel: "low" };
  assert.deepEqual(resolveDefinition(definition, { model: "vllm/big", thinkingLevel: "xhigh" }), {
    model: "vllm/big",
    instructions: "code",
    cwd: "/work",
    workspace: "write",
    thinkingLevel: "xhigh",
  });
  // One dial at a time: the other keeps the definition's value.
  assert.equal(resolveDefinition(definition, { thinkingLevel: "xhigh" }).model, "anthropic/claude-x");
  assert.equal(resolveDefinition(definition, { model: "vllm/big" }).thinkingLevel, "low");
  // Dials are the ONLY overridable fields — identity is definition-only (ADR-0028's `workspace`
  // above all: per-invocation escalation would void its containment claim).
  assert.equal(resolveDefinition(definition, { model: "vllm/big" }).instructions, "code");
});

test("loadHarnessSpec: the provider round-trips", () => {
  const spec = loadHarnessSpec({
    JR2_HARNESS_JSON: JSON.stringify({ provider: { id: "vllm", api: "openai-completions", baseUrl: "https://v/v1" } }),
  });
  assert.equal(spec.provider?.id, "vllm");
});

test("loadHarnessSpec: absent is valid — an instance may name only built-in models", () => {
  assert.deepEqual(loadHarnessSpec({}), {});
  // And it carries no Agents to be absent (ADR-0049): the roster this env var replaced is gone.
  assert.equal("agents" in loadHarnessSpec({ JR2_HARNESS_JSON: "{}" }), false);
});

test("loadHarnessSpec: malformed fails loudly, naming the env var", () => {
  assert.throws(() => loadHarnessSpec({ JR2_HARNESS_JSON: "{nope" }), /JR2_HARNESS_JSON is not JSON/);
  assert.throws(() => loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ provider: { id: "vllm" } }) }), /baseUrl/);
});

test("loadHarnessSpec: the catalog round-trips, and an entry that is not an https baseUrl fails at boot (ADR-0059)", () => {
  const catalog = { anthropic: { baseUrl: "https://litellm.corp.example" } };
  assert.deepEqual(loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ catalog }) }).catalog, catalog);
  assert.throws(
    () => loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ catalog: { anthropic: { baseUrl: "http://x" } } }) }),
    /catalog\.anthropic needs \{ baseUrl: "https:\/\/…" \}/,
  );
});

// MCP (ADR-0079): the definition names servers and allowlists; the mounted spec holds each server's
// transport, its secret's NAME and its timeout. The Harness joins them per conversation.
test("definitionFault: an mcp list is { server, tools? } entries, each server once", () => {
  assert.equal(
    definitionFault("coder", { ...coder, mcp: [{ server: "slack", tools: ["post"] }, { server: "notes" }] }),
    undefined,
  );
  assert.equal(definitionFault("coder", { ...coder, mcp: [{ server: "slack", tools: "*" }] }), undefined);
  assert.match(definitionFault("coder", { ...coder, mcp: { slack: ["post"] } }) ?? "", /`mcp` is not a list/);
  assert.match(
    definitionFault("coder", { ...coder, mcp: [{ server: "slack", tools: "post" }] }) ?? "",
    /mcp\[0\] is not/,
  );
  assert.match(definitionFault("coder", { ...coder, mcp: [{ tools: "*" }] }) ?? "", /mcp\[0\] is not/);
  assert.match(
    definitionFault("coder", { ...coder, mcp: [{ server: "a", tools: "*" }, { server: "a" }] }) ?? "",
    /names the server "a" twice/,
  );
});

test("loadHarnessSpec reads the mcp servers, and refuses one it cannot run", () => {
  const mcp = {
    slack: { url: "https://mcp.slack.example/mcp", secret: "SLACK_TOKEN", timeoutMs: 60_000 },
    notes: { command: "notes-mcp", args: ["--root", "/work"], timeoutMs: 90_000 },
  };
  assert.deepEqual(loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ mcp }) }).mcp, mcp);
  for (const bad of [{ url: "https://x" }, { command: "x", timeoutMs: 1 }, { url: 3, timeoutMs: 1 }, "x"]) {
    assert.throws(
      () => loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ mcp: { a: bad } }) }),
      /JR2_HARNESS_JSON's mcp\.a needs \{ url, secret\?, timeoutMs \} or \{ command, args, timeoutMs \}/,
    );
  }
});

test("mcpServersFor joins the definition's list to the Instance's servers, in the definition's order", () => {
  const spec: HarnessSpec = {
    mcp: {
      slack: { url: "https://mcp.slack.example/mcp", secret: "SLACK_TOKEN", timeoutMs: 60_000 },
      open: { url: "http://mcp.lan/mcp", timeoutMs: 5_000 },
      notes: { command: "notes-mcp", args: [], timeoutMs: 90_000 },
    },
  };
  const def = {
    mcp: [{ server: "notes" }, { server: "slack", tools: ["post"] }, { server: "open", tools: "*" as const }],
  };
  assert.deepEqual(mcpServersFor(def, spec), {
    servers: [
      { name: "notes", transport: { kind: "stdio", command: "notes-mcp", args: [] }, tools: "*", timeoutMs: 90_000 },
      {
        name: "slack",
        transport: { kind: "http", url: "https://mcp.slack.example/mcp" },
        secret: "SLACK_TOKEN",
        tools: ["post"],
        timeoutMs: 60_000,
      },
      { name: "open", transport: { kind: "http", url: "http://mcp.lan/mcp" }, tools: "*", timeoutMs: 5_000 },
    ],
  });
  assert.deepEqual(mcpServersFor({}, spec), { servers: [] });
  const missing = mcpServersFor({ mcp: [{ server: "jira", tools: "*" }] }, spec);
  assert.ok("fault" in missing);
  assert.match(
    missing.fault,
    /^the definition names the MCP server "jira", which this Instance does not declare — it declares "slack", "open", "notes"/,
  );
  // An inherited key is no server.
  const inherited = mcpServersFor({ mcp: [{ server: "constructor", tools: "*" }] }, spec);
  assert.ok("fault" in inherited && /"constructor", which this Instance does not declare/.test(inherited.fault));
  // A remote server with no list, or an empty one, is no grant: the second fence of ADR-0079's rule.
  for (const entry of [{ server: "slack" }, { server: "slack", tools: [] }]) {
    const none = mcpServersFor({ mcp: [entry] }, spec);
    assert.ok("fault" in none, JSON.stringify(entry));
    assert.match(none.fault, /names the remote MCP server "slack" with no tools — a remote server takes a list/);
  }
  // A stdio server takes no list: the Harness does not widen a list that `jr2 up` did not see.
  const listed = mcpServersFor({ mcp: [{ server: "notes", tools: ["read"] }] }, spec);
  assert.ok("fault" in listed && /gives the stdio MCP server "notes" a tools list/.test(listed.fault));
});

test("mcpAdmissionFault: a stdio server is admitted only where the Harness has a domain (ADR-0079)", () => {
  const spec: HarnessSpec = {
    mcp: {
      slack: { url: "https://mcp.slack.example/mcp", secret: "SLACK_TOKEN", timeoutMs: 60_000 },
      notes: { command: "notes-mcp", args: [], timeoutMs: 90_000 },
    },
  };
  const remote = { mcp: [{ server: "slack", tools: ["post"] }] };
  const stdio = { mcp: [{ server: "slack", tools: ["post"] }, { server: "notes" }] };
  assert.equal(mcpAdmissionFault(remote, spec, false), undefined);
  assert.equal(mcpAdmissionFault(remote, spec, true), undefined);
  assert.equal(mcpAdmissionFault(stdio, spec, true), undefined);
  assert.equal(
    mcpAdmissionFault(stdio, spec, false),
    'the definition names the stdio MCP server "notes", and this Harness has no domain to start it in: ' +
      "a Menu-only Agent gets remote servers only (ADR-0079)",
  );
  // mcpServersFor's fault comes first, with or without a domain.
  assert.match(
    mcpAdmissionFault({ mcp: [{ server: "jira", tools: "*" }] }, spec, false)!,
    /"jira", which this Instance/,
  );
});

test("definitionFault: a tool listed twice for one server is refused (ADR-0079)", () => {
  assert.equal(
    definitionFault("coder", { ...coder, mcp: [{ server: "slack", tools: ["post", "read", "post"] }] }),
    'agent "coder": mcp lists the tool "post" of the server "slack" twice — list each tool once (ADR-0079)',
  );
  assert.equal(definitionFault("coder", { ...coder, mcp: [{ server: "slack", tools: ["post", "read"] }] }), undefined);
});
