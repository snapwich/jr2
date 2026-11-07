// What the Harness is HANDED, in two pieces with two lifetimes (ADR-0049).
//
//   - The Agent DEFINITION rides every admission. A Machine carries its Agents as actor slots, so
//     the definition travels with the Turn that runs it (ADR-0049) and the Harness runs what it
//     was handed — re-read per Submission as before, now literally: the queued admission IS the
//     definition. There is no roster here, no `agents/` folder and no `JR2_AGENTS_JSON`: a flat
//     roster could not hold two Machines' `coder`s, and the pod would need a restart to learn a
//     definition the Orchestrator already knows.
//   - The harness CONFIG (`JR2_HARNESS_JSON`) is what this instance can REACH — the custom model
//     provider, and where pi's catalog providers send their calls (ADR-0018, ADR-0059). Deployment fact, not a Machine's, so it stays
//     mounted config (ADR-0050) and is read once at boot.
//
// Validation of a definition is per ADMISSION and LOUD: a definition that cannot run is a 400
// naming the slot, never a silently thinner turn. Shapes mirror `@jr2/orchestrator`'s
// `AgentDefinition` and `HarnessConfig` deliberately without importing them — the stock image
// carries no Orchestrator.

import { isAbsolute } from "node:path";

/** jr2's reasoning-effort scale (mirrors `@jr2/orchestrator`'s `ThinkingLevel`). A strict subset of
 * pi's — every value passes through to the runtime unmapped. A model can lack a level. Claude Sonnet
 * 5.5 has no `off`, and at `off` the Harness's request then sends effort `high`. The Harness does
 * not refuse such a level: it runs the Turn and prints the level that the model ran at (ADR-0023). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The scale as data — what an admission's `thinkingLevel` is checked against before pi ever
 * sees it (`mapThinkingLevel` is the second gate, on the resolved value). */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** What an Agent may DO to the Workspace (ADR-0028), as data — same reason. */
const WORKSPACE_ACCESS: readonly string[] = ["write", "read", "none"];

/** The plain-data Agent definition (ADR-0018), as the admission body carries it (ADR-0049) —
 * IDENTITY alone (ADR-0057). What a Turn is about and where it works is the Turn's Frame
 * ({@link TurnFrame}), how hard to run is its Dials ({@link TurnDials}), and the Agent's
 * `description` never arrives: it is Console material, which the Orchestrator strips before
 * admission. */
export type AgentDefinition = {
  /** Model specifier, `<provider>/<modelId>`. REQUIRED — there is no instance-wide default
   * (ADR-0018): an Agent is independently valid, and this is the only place a model is
   * checkable before a workflow names one. An invocation may override it (see {@link TurnDials}). */
  model: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Reasoning effort. Omitted → `off`. A model with no `off` runs at the level its provider
   * chooses; the printed conversation names it. */
  thinkingLevel?: ThinkingLevel;
  /** What the Agent may DO to the Workspace (ADR-0028): `"read"` withholds write/edit from the
   * Working tools; `"none"` withholds them all — the Menu-only Agent. Default `"write"`. */
  workspace?: "write" | "read" | "none";
  /** The MCP servers whose tools the Agent holds (ADR-0079), by the config's names, each with its
   * allowlist. The transport and the secret of each are the Instance's: {@link HarnessSpec}'s `mcp`.
   * `jr2 up` checked every rule (a declared name, a list only where jr2 can keep it); the Harness
   * checks the shape, and that each name is one it was given ({@link mcpServersFor}). */
  mcp?: AgentMcpEntry[];
};

/** One entry of an Agent's `mcp` list (mirrors `@jr2/orchestrator`'s `AgentMcpServer`). */
export type AgentMcpEntry = { server: string; tools?: string[] | "*" };

/** One MCP server of the Instance, as `jr2 up` publishes it (ADR-0079): a remote server's url and
 * the NAME of its Held secret — the Harness holds that name's Stand-in, and the Custodian the value
 * (ADR-0059) — or a stdio server's program, which the Harness starts through the spawner. The
 * config's `timeout`, resolved to milliseconds. */
export type McpServerSpec =
  | { url: string; secret?: string; timeoutMs: number }
  | { command: string; args: string[]; timeoutMs: number };

/** One server an Agent holds, resolved for its conversation: the transport, the Stand-in's name, the
 * allowlist (`"*"` for a stdio server, which takes no list), and the call timeout. */
export type AgentMcpServerSpec = {
  /** The config's name: the `<server>` of `mcp__<server>__<tool>`. */
  name: string;
  transport: { kind: "http"; url: string } | { kind: "stdio"; command: string; args: string[] };
  /** The Held secret's name: its Stand-in is `/run/jr2/standins/<secret>`. Absent: no credential. */
  secret?: string;
  tools: readonly string[] | "*";
  timeoutMs: number;
};

/** Token limits for one model — properties of the MODEL, not the endpoint. */
export type ProviderModelLimits = { contextWindow?: number; maxTokens?: number };

/** A custom model provider (ADR-0018), as `jr2 up` publishes it — `apiKey` is deliberately absent:
 * it is a held secret, so this process holds `JR2_PROVIDER_API_KEY`'s Stand-in, read from its file, and
 * the Custodian puts the key on the wire (ADR-0059). */
export type ProviderSpec = {
  /** The provider id model specifiers use (`<id>/<model>`), e.g. `vllm`. */
  id: string;
  /** The wire protocol, e.g. `openai-completions`. */
  api: string;
  /** The endpoint — reachable from pods. */
  baseUrl: string;
  /** Endpoint-wide default token limits, for any model this provider serves. */
  contextWindow?: number;
  maxTokens?: number;
  /** Per-model limits, keyed by the model id AFTER the provider prefix. */
  models?: Record<string, ProviderModelLimits>;
};

/** Where one of pi's catalog providers sends its calls (ADR-0059): a gateway that serves the
 * provider's own API. The catalog keeps every model fact; this is the endpoint alone. */
export type CatalogReachSpec = { baseUrl: string };

/** The harness section: what this instance can REACH. Deliberately no model default — the config
 * declares providers, the definition makes the choice (ADR-0018) — and no Agents at all: they
 * ride the Turn (ADR-0049). */
export type HarnessSpec = {
  provider?: ProviderSpec;
  /** Catalog provider id → its gateway (`anthropic` → LiteLLM, ADR-0059). */
  catalog?: Record<string, CatalogReachSpec>;
  /** The Instance's MCP servers, by the config's name (ADR-0079). An Agent's definition names the
   * ones it holds. */
  mcp?: Record<string, McpServerSpec>;
};

/** What this Turn is ABOUT and WHERE it works — the Frame (ADR-0057). Neither identity nor a
 * Dial: a directory says where, which is the same kind of fact as the prompt, and a worktree path
 * (`/work/<slot>/<name>`) exists only once a Machine has cut it, so no definition can name one.
 * `message` is the prompt as the wire spells it; both ride the admit body, `cwd` beside the
 * prompt and the Dials. */
export type TurnFrame = {
  /** The prompt — this Turn's next user message on the conversation. */
  message: string;
  /** Where the Working tools are rooted. Absent → `/work` (ADR-0005), which is what a
   * stub-Harness run with no Workspace wants. */
  cwd?: string;
  /** Whose conversation this is (ADR-0076): the Agent's slot, the actor path of its Machine and
   * its agent name, as the Orchestrator registered it. The Harness states it on each control
   * request of this Turn. It is never read off an Instance ID: an actor id (a Pool item's) may
   * hold a `/`. */
  slot?: string;
};

/** What a Machine state may set for one Turn on top of the definition (ADR-0018) — the DIALS:
 * how hard to run. Never identity (`instructions`/`workspace`, which would make the Agent's name a
 * lie) and never the Frame (`message`/`cwd` — what the Turn is about and where it works, ADR-0057;
 * a directory is not a measure of effort). Rides the admit body per Submission, so one `continue`
 * conversation may queue Submissions at different settings. */
export type TurnDials = {
  model?: string;
  thinkingLevel?: ThinkingLevel;
};

/** One definition with its per-Submission resolution applied: the Submission's dials, the Frame's
 * `cwd` with its `/work` default (ADR-0057), and the `"write"` workspace default (ADR-0028) are
 * resolved here, so a turn works from concrete values. */
export type ResolvedDefinition = {
  model: string;
  instructions: string;
  cwd: string;
  workspace: "write" | "read" | "none";
  thinkingLevel?: ThinkingLevel;
  /** The definition's MCP servers (ADR-0079), as it names them: a Turn does not change them. */
  mcp?: AgentMcpEntry[];
};

/**
 * Why the definition on this admission cannot be run, or undefined when it can — the structural
 * half of the admission check (the model's resolvability is `provider.ts`'s half, which needs the
 * registry). Every message names the SLOT, because that is the name the author wrote and the one
 * the Orchestrator's error will quote back (ADR-0049).
 *
 * This is where the retired boot-time spec validation went: the same claims, made per admission,
 * which is the only moment a definition exists here now.
 */
export function definitionFault(agentName: string, definition: unknown): string | undefined {
  const named = `agent "${agentName}"`;
  if (typeof definition !== "object" || definition === null) {
    return (
      `${named}: the admission carries no definition — the Machine's Agent slot rides the Turn ` +
      `(ADR-0049), so \`definition: { model, instructions, … }\` is required on the admit body`
    );
  }
  const { model, instructions, thinkingLevel, workspace } = definition as Record<string, unknown>;
  if (typeof instructions !== "string" || instructions.length === 0) {
    return `${named}: the definition has no \`instructions\` — an Agent is its model plus its prompt (ADR-0018)`;
  }
  if (typeof model !== "string" || model.length === 0) {
    return `${named}: the definition names no model — a definition must name one, there is no instance-wide default (ADR-0018)`;
  }
  if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as string)) {
    return `${named}: thinkingLevel "${String(thinkingLevel)}" is not one of ${THINKING_LEVELS.join("|")}`;
  }
  if (workspace !== undefined && !WORKSPACE_ACCESS.includes(workspace as string)) {
    return `${named}: workspace "${String(workspace)}" is not one of ${WORKSPACE_ACCESS.join("|")} (ADR-0028)`;
  }
  const mcp = (definition as Record<string, unknown>).mcp;
  if (mcp !== undefined) {
    const shape = `each entry is { server, tools? }, where tools is a list of tool names or "*" (ADR-0079)`;
    if (!Array.isArray(mcp)) return `${named}: the definition's \`mcp\` is not a list — ${shape}`;
    const seen = new Set<string>();
    for (const [i, entry] of mcp.entries()) {
      const { server, tools } = (entry ?? {}) as Record<string, unknown>;
      const listed =
        tools === undefined || tools === "*" || (Array.isArray(tools) && tools.every((t) => typeof t === "string"));
      if (typeof entry !== "object" || entry === null || typeof server !== "string" || !listed) {
        return `${named}: mcp[${i}] is not { server, tools? } — ${shape}`;
      }
      if (seen.has(server)) return `${named}: mcp names the server "${server}" twice (ADR-0079)`;
      seen.add(server);
      if (Array.isArray(tools)) {
        const twice = tools.find((t, j) => tools.indexOf(t) !== j);
        if (twice !== undefined) {
          return `${named}: mcp lists the tool "${String(twice)}" of the server "${server}" twice — list each tool once (ADR-0079)`;
        }
      }
    }
  }
  return undefined;
}

/**
 * The MCP servers this definition holds, resolved against the Instance's servers (ADR-0079), or the
 * fault: a name that `spec.mcp` does not hold, a remote server with no list, or a stdio server with one. `jr2 up` refused that already; the fault is the
 * second fence, for a definition `jr2 up` never walked. Order: the definition's.
 */
export function mcpServersFor(
  definition: Pick<AgentDefinition, "mcp">,
  spec: HarnessSpec,
): { servers: AgentMcpServerSpec[] } | { fault: string } {
  const servers: AgentMcpServerSpec[] = [];
  for (const entry of definition.mcp ?? []) {
    const server = spec.mcp !== undefined && Object.hasOwn(spec.mcp, entry.server) ? spec.mcp[entry.server] : undefined;
    if (server === undefined) {
      const known = Object.keys(spec.mcp ?? {});
      return {
        fault:
          `the definition names the MCP server "${entry.server}", which this Instance does not ` +
          `declare — it declares ${known.length ? known.map((n) => `"${n}"`).join(", ") : "none"}; run \`jr2 up\` (ADR-0079)`,
      };
    }
    if ("command" in server) {
      // A stdio server takes no list (ADR-0079): a list would read as a limit, and guard nothing.
      if (entry.tools !== undefined) {
        return {
          fault:
            `the definition gives the stdio MCP server "${entry.server}" a tools list — a stdio server takes no ` +
            "list, and the Agent gets every tool of it (ADR-0079)",
        };
      }
      servers.push({
        name: entry.server,
        transport: { kind: "stdio", command: server.command, args: [...server.args] },
        tools: "*",
        timeoutMs: server.timeoutMs,
      });
    } else {
      // A remote server takes a list or "*" (ADR-0079): no list is not the widest grant.
      if (entry.tools === undefined || (Array.isArray(entry.tools) && entry.tools.length === 0)) {
        return {
          fault:
            `the definition names the remote MCP server "${entry.server}" with no tools — a ` +
            'remote server takes a list of tool names, or "*" (ADR-0079)',
        };
      }
      servers.push({
        name: entry.server,
        transport: { kind: "http", url: server.url },
        ...(server.secret !== undefined ? { secret: server.secret } : {}),
        tools: entry.tools,
        timeoutMs: server.timeoutMs,
      });
    }
  }
  return { servers };
}

/**
 * The MCP half of the admission check (ADR-0079), or undefined: the definition's servers are the
 * Instance's ({@link mcpServersFor}), and it names a stdio server only where this Harness has a
 * domain to start it in. The Instance Harness has none: a Menu-only Agent gets remote servers only.
 */
export function mcpAdmissionFault(
  definition: Pick<AgentDefinition, "mcp">,
  spec: HarnessSpec,
  hasDomain: boolean,
): string | undefined {
  const servers = mcpServersFor(definition, spec);
  if ("fault" in servers) return servers.fault;
  const stdio = servers.servers.find((server) => server.transport.kind === "stdio");
  if (stdio !== undefined && !hasDomain) {
    return (
      `the definition names the stdio MCP server "${stdio.name}", and this Harness has no domain to start it in: ` +
      "a Menu-only Agent gets remote servers only (ADR-0079)"
    );
  }
  return undefined;
}

/**
 * Why this Turn's Frame cannot frame a Turn, or undefined when it can (ADR-0057) — the Frame's
 * half of the admission check, `cwd` alone. A missing `message` is an empty prompt, which is a
 * turn a model can still answer; a `cwd` that is not an absolute path is a turn that would root
 * its Working tools somewhere nobody named — `/work`, the parent of every checkout where grep and
 * find hit the pristine clone beside the worktree, or, for a relative path, wherever this process
 * happens to sit — and say nothing. That silence is what ADR-0057 was written for, so this is a
 * refusal, never a drop.
 */
export function frameFault(agentName: string, frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const { cwd } = frame as Record<string, unknown>;
  if (cwd === undefined) return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    return (
      `agent "${agentName}": the Turn's Frame carries a \`cwd\` that is not an absolute path — the Frame says ` +
      `WHERE this Turn works (ADR-0057), and a Turn rooted anywhere else would work in the wrong directory silently`
    );
  }
  return undefined;
}

/** The definition this Submission runs, defaults applied — the per-Submission read
 * (model/instructions/thinkingLevel resolve when the turn starts, ADR-0027; `cwd` comes from this
 * Turn's Frame, ADR-0057). `turn` is this Submission's Frame and Dials: the definition supplies
 * the identity and the default effort, the Turn says where it works and may turn the dials. */
export function resolveDefinition(
  definition: AgentDefinition,
  turn?: TurnDials & Pick<TurnFrame, "cwd">,
): ResolvedDefinition {
  const model = turn?.model ?? definition.model;
  const thinkingLevel = turn?.thinkingLevel ?? definition.thinkingLevel;
  return {
    model,
    instructions: definition.instructions,
    cwd: turn?.cwd ?? "/work",
    workspace: definition.workspace ?? "write",
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(definition.mcp !== undefined ? { mcp: definition.mcp } : {}),
  };
}

/**
 * Read + validate the mounted harness config from the environment (`JR2_HARNESS_JSON` — the
 * `jr2-harness` ConfigMap, written by `jr2 up`). ABSENT is valid and means "pi's own catalog
 * alone": an instance whose Agents name only built-in models declares no provider, and `jr2 up`
 * writes the key with no `provider` in it. Malformed is not — it throws into the pod log, because
 * a Harness that silently dropped its one reachable endpoint would fail every admission instead.
 */
export function loadHarnessSpec(env: Record<string, string | undefined>): HarnessSpec {
  const raw = env.JR2_HARNESS_JSON;
  if (!raw) return {};
  let spec: HarnessSpec;
  try {
    spec = JSON.parse(raw) as HarnessSpec;
  } catch (err) {
    throw new Error(`JR2_HARNESS_JSON is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof spec !== "object" || spec === null) throw new Error("JR2_HARNESS_JSON is not an object");
  const provider = spec.provider;
  if (provider && (!provider.id || !provider.api || !provider.baseUrl)) {
    throw new Error(
      `JR2_HARNESS_JSON's provider needs { id, api, baseUrl } — got ${JSON.stringify(provider)} (ADR-0018)`,
    );
  }
  // The catalog's SHAPE here; whether each id is one pi's catalog has is `modelsFor`'s, which holds
  // the registry — both at boot, both loud into the pod log.
  for (const [id, reach] of Object.entries(spec.catalog ?? {})) {
    if (typeof reach?.baseUrl !== "string" || !/^https:\/\//.test(reach.baseUrl)) {
      throw new Error(
        `JR2_HARNESS_JSON's catalog.${id} needs { baseUrl: "https://…" } — got ${JSON.stringify(reach)} (ADR-0059)`,
      );
    }
  }
  for (const [name, server] of Object.entries(spec.mcp ?? {})) {
    const s = server as Record<string, unknown>;
    const remote = typeof s?.url === "string" && (s.secret === undefined || typeof s.secret === "string");
    const stdio = typeof s?.command === "string" && Array.isArray(s.args) && s.args.every((a) => typeof a === "string");
    if ((!remote && !stdio) || typeof s.timeoutMs !== "number" || !(s.timeoutMs > 0)) {
      throw new Error(
        `JR2_HARNESS_JSON's mcp.${name} needs { url, secret?, timeoutMs } or { command, args, timeoutMs } — got ` +
          `${JSON.stringify(server)} (ADR-0079)`,
      );
    }
  }
  return spec;
}
