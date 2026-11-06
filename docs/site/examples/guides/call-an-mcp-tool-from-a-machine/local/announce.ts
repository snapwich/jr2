import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  answer,
  defineEvent,
  fail,
  fromPick,
  jr2Setup,
  mcp,
  type McpCallOutput,
  type McpReadOutput,
} from "@jr2/orchestrator";

// The writer's picks. Each one is a tool on its Menu, and the Machine makes the MCP call.
const findChannel = defineEvent({
  name: "find_channel",
  description: "Find a channel by a part of its name. The answer lists the channels that match.",
  input: z.object({ query: z.string().describe("A part of the channel's name.") }),
});
const postMessage = defineEvent({
  name: "post_message",
  description: "Post one message to a channel. A person approves it first. The answer tells if it went out.",
  input: z.object({ channel: z.string().describe("The channel id."), text: z.string().describe("The message.") }),
});
const finished = defineEvent({
  name: "finished",
  description: "Call this after the announcement went out.",
  input: z.object({}),
});

// The answers of the person at the Gate. The writer cannot send them.
const approve = defineEvent({ name: "approve", description: "Post this message.", input: z.object({}) });
const reject = defineEvent({
  name: "reject",
  description: "Do not post this message. Say why.",
  input: z.object({ reason: z.string().min(1) }),
});

const door = z.object({ version: z.string().describe("The version to announce, such as 1.4.0.") });

type Input = z.infer<typeof door>;
type Ctx = Input & { rules?: string; brief?: string; channel?: string; text?: string; posted: boolean };

// What the writer reads when the server did not answer as a tool does. `reason` says why.
const notReturned = (output: McpCallOutput): string =>
  output.outcome === "unknown"
    ? `jr2 cannot tell if the call acted: ${output.reason}. Do not call it again.`
    : `The call did not run: ${"reason" in output ? output.reason : output.outcome}`;

// The text of a read or a prompt, or undefined when the server did not give it.
const textOf = (output: McpReadOutput): string | undefined => (output.outcome === "returned" ? output.text : undefined);

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [findChannel, postMessage, finished, approve, reject],
  actors: {
    writer: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You write short release announcements for the team chat.",
      workspace: "none",
    }),
    // A resource and a prompt of the server: the Machine reads them before the writer starts.
    rules: mcp.read("slack-acme", "guide://announcements", { idempotent: true }),
    brief: mcp.prompt("slack-acme", "announcement", { input: z.object({ version: z.string() }), idempotent: true }),
    // A search changes nothing, so it is safe to send two times.
    search: mcp.call("slack-acme", "find_channel", { input: z.object({ query: z.string() }), idempotent: true }),
    // A post changes the channel, so jr2 sends it at most one time.
    post: mcp.call("slack-acme", "post_message", { input: z.object({ channel: z.string(), text: z.string() }) }),
    fail: fail(),
  },
}).createMachine({
  id: "announce",
  input: door,
  context: ({ input }) => ({ version: input.version, posted: false }),
  on: { "agent.fault": ".failed" },
  initial: "reading",
  states: {
    reading: {
      invoke: {
        src: "rules",
        onDone: [
          {
            guard: ({ event }) => textOf(event.output) !== undefined,
            target: "briefing",
            actions: assign({ rules: ({ event }) => textOf(event.output) }),
          },
          { target: "failed" },
        ],
      },
    },
    briefing: {
      invoke: {
        src: "brief",
        input: ({ context }) => ({ version: context.version }),
        onDone: [
          {
            guard: ({ event }) => textOf(event.output) !== undefined,
            target: "writing",
            actions: assign({ brief: ({ event }) => textOf(event.output) }),
          },
          { target: "failed" },
        ],
      },
    },
    // The writer's state. Its Turn lasts until `finished` leaves it.
    writing: {
      invoke: {
        src: "writer",
        input: ({ context }) => ({ prompt: `${context.brief}\n\nThe rules of the channel:\n${context.rules}` }),
      },
      on: { finished: { guard: ({ context }) => context.posted, target: "done" } },
      initial: "ready",
      states: {
        ready: {
          on: {
            find_channel: "searching",
            post_message: {
              target: "approving",
              actions: assign({ channel: ({ event }) => event.channel, text: ({ event }) => event.text }),
            },
          },
        },
        // The pick enters the Effect's state, so fromPick gives its `query` to the tool's arguments.
        searching: {
          invoke: {
            src: "search",
            input: fromPick(findChannel),
            onDone: {
              target: "ready",
              // The writer reads this text as the answer to its find_channel pick.
              actions: answer(({ event }) =>
                event.output.outcome === "returned" ? event.output.text : notReturned(event.output),
              ),
            },
          },
        },
        // A person approves the message. While the Gate is open, the post_message pick is outstanding.
        approving: {
          invoke: {
            src: "gate",
            input: ({ context }) => ({ meta: { channel: context.channel, text: context.text } }),
          },
          on: {
            approve: "posting",
            reject: { target: "ready", actions: answer(({ event }) => `The editor rejected it: ${event.reason}`) },
          },
        },
        // The Gate came between the pick and the Effect, so the input comes from the context.
        posting: {
          invoke: {
            src: "post",
            input: ({ context }) => ({ channel: context.channel!, text: context.text! }),
            onDone: [
              {
                guard: ({ event }) => event.output.outcome === "returned" && !event.output.isError,
                target: "ready",
                actions: [assign({ posted: true }), answer(() => "The message went out.")],
              },
              {
                target: "ready",
                actions: answer(({ event }) =>
                  event.output.outcome === "returned"
                    ? `The tool failed: ${event.output.text}`
                    : notReturned(event.output),
                ),
              },
            ],
          },
        },
      },
    },
    done: { type: "final" },
    // Not a final state: the run ends `failed`, with the reason.
    failed: { invoke: { src: "fail", input: { reason: "the announcement did not go out" } } },
  },
});
