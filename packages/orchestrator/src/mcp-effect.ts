// The `mcp` Effect (ADR-0067, ADR-0079): call a tool of an MCP server, read one of its resources,
// or get one of its prompts, from the Instance Effector, with the server's secret that the Agent
// never reads. It has the shape of `http`, with a server and a tool in place of a url:
//
//   post: mcp.call("slack-acme", "post_message", { input: z.object({ channel: z.string(), text: z.string() }) })
//
// The server is a name of the `mcp` block of `jr2.config.ts`: its url and its secret are the
// config's, never a part and never a param. `jr2 up` places the secret in the Instance Effector as
// an Effect secret and writes the server into `effector.json`; the start names the server alone,
// so the Effector reads the url and the secret from what `jr2 up` wrote. An Agent's param reaches
// the tool's arguments only (or a prompt's), through the input.
//
// The driver is the Instance Effector's, shared with `http` (`instanceEffectLogic`): the
// write-ahead intent row, the restore rule (at most once unless the author marks it idempotent;
// the server's `idempotentHint` is not read), a forged answer, and D1.

import type { z } from "zod";
import type { Duration, EffectLogic, McpOp, McpParts, OpenMcpParts } from "./effect.ts";
import {
  createEffectorClient,
  MCP_SERVER,
  nodeEffectorTransport,
  type McpCallOutput,
  type McpReadOutput,
  type McpStartRequest,
} from "./effector-wire.ts";
import { instanceEffectLogic, type EffectorPortFactory } from "./http-effect.ts";
import { open } from "./open.ts";
import { effectBindingShape, openEffectLogic, openPartsOf, type OpenOf } from "./open-effect.ts";

/** The options of an `mcp` Effect. */
export type McpOptions<S extends z.ZodObject | undefined = undefined> = {
  /**
   * The zod schema of the input of the Effect: what the `input` of the `invoke`, or `fromPick`,
   * gives it. For `mcp.call` the parsed input is the tool's arguments; for `mcp.prompt`, the
   * prompt's arguments, each a string. jr2 parses the input with it before the call. When it
   * starts, input that does not agree with it makes the Effect fail (its `onError` route): `mcp
   * "<slot>": its input does not match the definition's input schema — <path>: <message>`. With no
   * schema, the input of the `invoke` is the arguments as it is, and `{}` when it has none.
   */
  input?: S;
  /**
   * How long jr2 waits for the answer: a number and a unit, such as `"30s"` or `"2m"`. Default:
   * the server's `timeout` in `jr2.config.ts` (60 seconds when it sets none). With no answer in
   * that time, the output is `unknown`. It refuses a value that is not a positive duration: `mcp:
   * timeout "<timeout>" is not a positive duration (like "30s", "2m")`.
   */
  timeout?: Duration;
  /**
   * The largest number of bytes of `text`, and of `structured` as JSON, that the output keeps.
   * Default 65536. Past it, jr2 cuts `text`, drops `structured`, and sets `truncated`. It refuses
   * a value that is not a positive whole number: `mcp({ maxBody }): a positive number of bytes`.
   */
  maxBody?: number;
  // The restore rule (ADR-0067): the author's mark alone. The server's `idempotentHint` is the
  // server's word, not the author's (ADR-0079).
  /**
   * `true` when it is safe to send the request two times: the tool only reads, or it has its own
   * idempotency key. Default `false`. After an Orchestrator restart, jr2 cannot always tell if the
   * request went out. Then it sends an idempotent one again, and gives any other the output
   * `unknown`. jr2 does not read the tool's `idempotentHint`.
   */
  idempotent?: boolean;
};

/** @internal */
export type McpInput<S> = S extends z.ZodObject ? z.infer<S> : void;

/** Which parts of an `mcp` Effect are Open, by the values the author wrote. @internal */
export type McpOpenParts<V, T> = (V extends typeof open ? "server" : never) | (T extends typeof open ? "tool" : never);

const DEFAULT_MAX_BODY = 65_536;

/** The definition of one `mcp` Effect, as the three constructors give it. */
type McpDefinition = {
  op: McpOp;
  server: string | typeof open;
  /** The tool (a call), the resource's uri (a read) or the prompt's name (a prompt). */
  name: string | typeof open;
  options: McpOptions<z.ZodObject | undefined>;
};

const WHAT: Record<McpOp, string> = { call: "tool", read: "uri", prompt: "prompt name" };

/** The definition's plain data, checked: every refusal names what to write instead. */
function mcpPartsOf(def: McpDefinition): OpenMcpParts {
  const { op, server, name, options } = def;
  if (server !== open && (typeof server !== "string" || !MCP_SERVER.test(server) || server === "jr2")) {
    throw new Error(
      `mcp.${op}(server): ${JSON.stringify(server)} is not a server name — a name of the mcp block of ` +
        'jr2.config.ts, lowercase letters, digits and -, not "jr2"; or `open`, which the composer binds (ADR-0079)',
    );
  }
  if (name === open && op !== "call") {
    throw new Error(`mcp.${op}(): its ${WHAT[op]} is the author's, never Open — only a call's tool is (ADR-0079)`);
  }
  if (name !== open && (typeof name !== "string" || name === "")) {
    throw new Error(`mcp.${op}(): the ${WHAT[op]} is a non-empty string`);
  }
  const maxBody = options.maxBody ?? DEFAULT_MAX_BODY;
  if (!Number.isInteger(maxBody) || maxBody <= 0) throw new Error("mcp({ maxBody }): a positive number of bytes");
  const timeoutMs = options.timeout === undefined ? undefined : parseDuration(options.timeout);
  const shape = (options.input as { shape?: unknown } | undefined)?.shape;
  if (op === "prompt" && shape && typeof shape === "object") {
    for (const [key, field] of Object.entries(shape)) {
      if (!isStringSchema(field)) {
        throw new Error(
          `mcp.prompt(${JSON.stringify(name)}): the input field "${key}" is not a string schema, and a prompt's ` +
            "arguments are strings (MCP's prompts/get)",
        );
      }
    }
  }
  return {
    kind: "mcp",
    op,
    server,
    ...(op === "call" ? { tool: name } : op === "read" ? { uri: name as string } : { prompt: name as string }),
    inputKeys: shape && typeof shape === "object" ? Object.keys(shape) : [],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    maxBody,
    idempotent: options.idempotent === true,
    secrets: [],
  };
}

/**
 * The wire request for one run: the server, the operation and its arguments.
 *
 * @internal
 */
export function mcpStartOf(parts: McpParts, args: Record<string, unknown>): McpStartRequest {
  const request =
    parts.op === "call"
      ? { call: { tool: parts.tool!, arguments: args } }
      : parts.op === "read"
        ? { read: { uri: parts.uri! } }
        : { prompt: { name: parts.prompt!, arguments: promptArguments(args) } };
  return {
    kind: "mcp",
    mcp: { server: parts.server, ...request },
    ...(parts.timeoutMs !== undefined ? { timeoutMs: parts.timeoutMs } : {}),
    maxBody: parts.maxBody,
  };
}

/** The schema types whose value is a string, and the wrappers that leave it one when present. */
const STRING_TYPES = new Set(["string", "enum", "literal", "template_literal"]);
const WRAPPERS = new Set(["optional", "default", "prefault", "catch", "readonly", "nonoptional"]);

/** Whether a zod field's value is a string (or absent): what a prompt's argument may be. */
function isStringSchema(field: unknown): boolean {
  let def = (field as { _zod?: { def?: { type?: string; innerType?: unknown; values?: unknown[] } } })?._zod?.def;
  while (def?.type !== undefined && WRAPPERS.has(def.type)) {
    def = (def.innerType as { _zod?: { def?: typeof def } } | undefined)?._zod?.def;
  }
  if (def?.type === undefined || !STRING_TYPES.has(def.type)) return false;
  return def.values === undefined || def.values.every((v) => typeof v === "string");
}

/** A prompt's arguments are strings (MCP's `prompts/get`): another value is a defect of the Machine. */
function promptArguments(args: Record<string, unknown>): Record<string, string> {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      throw new Error(`mcp.prompt: the argument "${key}" is ${typeof value}, and a prompt's arguments are strings`);
    }
  }
  return args as Record<string, string>;
}

/**
 * The slot logic of an `mcp` Effect over an injected port factory: the seam the constructors and
 * the unit tests share, as `httpWith` is for an http Effect.
 *
 * @internal
 */
export function mcpWith<O>(portFactory: EffectorPortFactory, def: McpDefinition): EffectLogic<unknown, O> {
  const parts = mcpPartsOf(def);
  const opened = openPartsOf(parts);
  if (opened.length > 0) {
    return openEffectLogic(parts, opened, (binding) => {
      const keys = Object.keys(binding).filter((k) => (binding as Record<string, unknown>)[k] !== undefined);
      if (keys.some((k) => k !== "server" && k !== "tool")) {
        throw new Error(
          `an mcp Effect's Open parts are its server and its tool — bind it with ${effectBindingShape(opened)}`,
        );
      }
      return mcpWith(portFactory, {
        ...def,
        ...(binding.server !== undefined ? { server: binding.server } : {}),
        ...(binding.tool !== undefined ? { name: binding.tool } : {}),
      }) as EffectLogic<unknown, unknown>;
    }) as unknown as EffectLogic<unknown, O>;
  }
  const bound = parts as McpParts;
  const target = bound.op === "call" ? `${bound.server}/${bound.tool}` : `${bound.server} ${bound.op}`;
  return instanceEffectLogic<unknown, O>(
    bound,
    {
      kind: "mcp",
      idempotent: bound.idempotent,
      label: `mcp ${target}`,
      request: (input, slot) => {
        let args: unknown = input ?? {};
        const schema = def.options.input;
        if (schema !== undefined) {
          const parsed = schema.safeParse(input);
          if (!parsed.success) {
            throw new Error(
              `mcp "${slot}": its input does not match the definition's input schema — ` +
                parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            );
          }
          args = parsed.data;
        }
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new Error(`mcp "${slot}": its input is the request's arguments, an object`);
        }
        return mcpStartOf(bound, args as Record<string, unknown>);
      },
    },
    portFactory,
  );
}

/** The real port: the Instance Effector's headless Service, over its signed wire. */
const instancePort: EffectorPortFactory = (target) =>
  createEffectorClient({ key: target.key, transport: nodeEffectorTransport(target.service) });

/** A duration as milliseconds, a whole number of 1 or more. */
function parseDuration(d: Duration): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(d);
  const ms = m === null ? 0 : Math.round(Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000));
  if (!(ms >= 1)) {
    throw new Error(`mcp: timeout "${d}" is not a positive duration (like "30s", "2m")`);
  }
  return ms;
}

/**
 * Call a tool of an MCP server: an Effect that the Machine runs, with no model. Put it in
 * `actors`, and invoke it by its key: `actors: { post: mcp.call("slack-acme", "post_message", {
 * input }) }`, then `invoke: { src: "post" }`.
 *
 * `server` is a name of the `mcp` block of `jr2.config.ts`: a remote server, whose url and secret
 * are the config's. The Effect runs in the Instance Effector, which holds that secret as an Effect
 * secret and sends it as `Authorization: Bearer <value>`. The Agent and the Orchestrator never read
 * it. `jr2 up` refuses a server that the `mcp` block does not declare, and a stdio server: an `mcp`
 * Effect calls a remote server only.
 *
 * `server` and `tool` can each be `open`: a packaged Machine that cannot know them leaves them
 * Open, and the composer binds them one time with `customize(machine, { effects: { <slot>: {
 * server, tool } } })`.
 *
 * Every outcome is output ({@link McpCallOutput}): `returned`, `refused`, `unreachable`,
 * `input-required` or `unknown`. A tool's own error is `returned` with `isError: true`. jr2 sends
 * the call at most one time, unless you mark it `idempotent`. When its state exits while the call
 * runs, jr2 stops waiting for it. The Effector can still send it.
 *
 * This is how an Agent's request gets an approval: the Agent picks, a Gate waits for a person,
 * and the Effect makes the call. The Effect's output is the pick's answer.
 *
 * @param server - A server name of the `mcp` block of `jr2.config.ts`, or `open`.
 * @param tool - The tool's name, or `open`.
 * @param options - The input schema, the timeout, the output bound, and `idempotent`.
 * @returns An Effect, for `actors`.
 *
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
function call<
  const V extends string | typeof open,
  const T extends string | typeof open,
  S extends z.ZodObject | undefined = undefined,
>(
  server: V,
  tool: T,
  options: McpOptions<S> = {},
): EffectLogic<McpInput<S>, McpCallOutput> & OpenOf<McpOpenParts<V, T>> {
  return mcpWith(instancePort, { op: "call", server, name: tool, options }) as EffectLogic<McpInput<S>, McpCallOutput> &
    OpenOf<McpOpenParts<V, T>>;
}

/**
 * Read a resource of an MCP server: an Effect that the Machine runs, with no model. `server` is
 * as {@link mcp}`.call` takes it, and can be `open`. `uri` is the author's, never Open and never a
 * param. The output is {@link McpReadOutput}: `text` joins the text of the resource's contents,
 * and `structured` is the `contents` list. jr2 sends it at most one time, unless you mark it
 * `idempotent`.
 *
 * @param server - A server name of the `mcp` block of `jr2.config.ts`, or `open`.
 * @param uri - The resource's uri.
 * @param options - The timeout, the output bound, and `idempotent`.
 * @returns An Effect, for `actors`.
 *
 * @see docs/concepts/effects.md
 */
function read<const V extends string | typeof open>(
  server: V,
  uri: string,
  options: Omit<McpOptions, "input"> = {},
): EffectLogic<void, McpReadOutput> & OpenOf<McpOpenParts<V, string>> {
  return mcpWith(instancePort, { op: "read", server, name: uri, options }) as EffectLogic<void, McpReadOutput> &
    OpenOf<McpOpenParts<V, string>>;
}

/**
 * Get a prompt of an MCP server: an Effect that the Machine runs, with no model. `server` is as
 * {@link mcp}`.call` takes it, and can be `open`. `name` is the author's. The input is the
 * prompt's arguments, each a string. The output is {@link McpReadOutput}: `text` joins the text of
 * the prompt's messages, and `structured` is the `messages` list.
 *
 * @param server - A server name of the `mcp` block of `jr2.config.ts`, or `open`.
 * @param name - The prompt's name.
 * @param options - The input schema, the timeout, the output bound, and `idempotent`.
 * @returns An Effect, for `actors`.
 *
 * @see docs/concepts/effects.md
 */
function prompt<const V extends string | typeof open, S extends z.ZodObject | undefined = undefined>(
  server: V,
  name: string,
  options: McpOptions<S> = {},
): EffectLogic<McpInput<S>, McpReadOutput> & OpenOf<McpOpenParts<V, string>> {
  return mcpWith(instancePort, { op: "prompt", server, name, options }) as EffectLogic<McpInput<S>, McpReadOutput> &
    OpenOf<McpOpenParts<V, string>>;
}

/**
 * The `mcp` Effects (ADR-0067, ADR-0079): `mcp.call(server, tool, { input })` calls a tool,
 * `mcp.read(server, uri)` reads a resource, and `mcp.prompt(server, name, { input })` gets a
 * prompt. Each one is an Effect that the Machine runs, with no model, in the Instance Effector.
 * Put it in `actors`, and invoke it by its key.
 *
 * `server` is a name of the `mcp` block of `jr2.config.ts`: a remote server, whose url and secret
 * are the config's. The Instance Effector holds that secret as an Effect secret, and sends it as
 * `Authorization: Bearer <value>`. The Agent and the Orchestrator never read it. `jr2 up` refuses
 * a server that the `mcp` block does not declare, and a stdio server. `server`, and a call's
 * `tool`, can each be `open`: the composer binds them one time with `customize(machine, { effects:
 * { <slot>: { server, tool } } })`.
 *
 * Every outcome is output ({@link McpCallOutput}, {@link McpReadOutput}): `returned`, `refused`,
 * `unreachable`, `input-required` or `unknown`. jr2 sends the request at most one time, unless you
 * mark it `idempotent`. jr2 does not read the tool's `idempotentHint`.
 *
 * An Agent that holds a server's tools (its `mcp` list) calls them with no approval. When a call
 * needs an approval, the Machine makes it: the Agent picks, a Gate waits for a person, and the
 * Effect makes the call. The Effect's output is the pick's answer.
 *
 * @example
 * ```ts
 * import { assign } from "xstate";
 * import { z } from "zod";
 * import { agent, defineEvent, fail, gate, jr2Setup, mcp } from "@jr2/orchestrator";
 *
 * const postMessage = defineEvent({
 *   name: "post_message",
 *   description: "Post one message to the team's channel. A person approves it first.",
 *   input: z.object({ text: z.string() }),
 * });
 * const approve = defineEvent({ name: "approve", input: z.object({ by: z.string() }) });
 * const reject = defineEvent({ name: "reject", input: z.object({ by: z.string() }) });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: { text: string } },
 *   events: [postMessage, approve, reject],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You write the release note for the team.",
 *       workspace: "none",
 *     }),
 *     // A person answers it, in the Console or with `jr2 answer`.
 *     approval: gate({ meta: z.object({ text: z.string() }), delivers: [approve, reject], look: "none" }),
 *     // "slack-acme" is a remote server of the mcp block of jr2.config.ts.
 *     post: mcp.call("slack-acme", "post_message", {
 *       input: z.object({ channel: z.string(), text: z.string() }),
 *     }),
 *     fail: fail(),
 *   },
 * }).createMachine({
 *   id: "release-note",
 *   context: { text: "" },
 *   on: { "agent.fault": ".failed" },
 *   initial: "writing",
 *   states: {
 *     writing: {
 *       invoke: { src: "writer", input: { prompt: "Write the release note, then post it." } },
 *       initial: "ready",
 *       states: {
 *         ready: {
 *           on: {
 *             post_message: { target: "approving", actions: assign({ text: ({ event }) => event.text }) },
 *           },
 *         },
 *         approving: {
 *           invoke: { src: "approval", input: ({ context }) => ({ meta: { text: context.text } }) },
 *           on: { approve: "posting", reject: "ready" },
 *         },
 *         posting: {
 *           invoke: {
 *             src: "post",
 *             input: ({ context }) => ({ channel: "#releases", text: context.text }),
 *             // On another outcome, the Agent reads the output as the answer to its pick.
 *             onDone: [
 *               { guard: ({ event }) => event.output.outcome === "returned" && !event.output.isError, target: "#posted" },
 *               { target: "ready" },
 *             ],
 *           },
 *         },
 *       },
 *     },
 *     posted: { id: "posted", type: "final" },
 *     failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md
 */
export const mcp: { readonly call: typeof call; readonly read: typeof read; readonly prompt: typeof prompt } =
  Object.freeze({ call, read, prompt });
