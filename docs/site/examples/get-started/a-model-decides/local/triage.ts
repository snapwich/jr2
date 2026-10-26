import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";

// The run input: what you give `jr2 run triage --input`. The Console makes its start form from it.
const door = z.object({
  request: z.string().describe("A feature request, in the requester's own words."),
});

// The Agent's three picks. Each one is a tool that the model can call.
const accept = defineEvent({
  name: "accept",
  description: "The request is clear enough to build: it names what to change, where, and how to tell it is done.",
  input: z.object({ summary: z.string().describe("The request restated as one actionable sentence.") }),
});
const needsInfo = defineEvent({
  name: "needs_info",
  description: "The request could be built more than one way, or its outcome cannot be checked. Ask one question.",
  input: z.object({ question: z.string().describe("The one question whose answer would make it buildable.") }),
});
const reject = defineEvent({
  name: "reject",
  description: "The request is not a change to software, or it asks for something harmful.",
  input: z.object({ reason: z.string().describe("Why, in one sentence.") }),
});
// Your one reply. Only a Gate takes it, so the Agent can never send it.
const answer = defineEvent({
  name: "answer",
  description: "Answer the triager's question. It triages the request again with the answer in hand.",
  input: z.object({ info: z.string().describe("The answer, in prose.") }),
});

type Ctx = z.infer<typeof door> & {
  // Each question that the Agent asked, and the answer that it got.
  exchange: { question: string; info?: string }[];
  // Why the last Turn ended with no pick, when it did.
  fault?: string;
  summary?: string;
  reason?: string;
};
// The output of the run: the decision. The job of a triage is the decision itself, so "rejected" is a
// correct answer: a final state, with the reason in the output, and not a Failure.
type Output = { outcome: "accepted"; summary: string } | { outcome: "rejected"; reason: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: z.infer<typeof door>; output: Output },
  events: [accept, needsInfo, reject, answer],
  actors: {
    triager: agent({
      // `local` is the provider id in jr2.config.ts. The rest is the name that the endpoint serves.
      model: "local/qwen3.6-35b-a3b",
      description: "Reads one feature request and decides whether it can be built as written.",
      // No Sandbox and no Working tools: the Agent can only read its prompt and pick.
      workspace: "none",
      thinkingLevel: "off",
      instructions: `You triage feature requests for a small software team. You read one request and
decide, by calling exactly one tool:

- accept — it names WHAT to change, WHERE (which command, screen, or file), and how to tell it
  is done.
- needs_info — any of those is missing. Ask the ONE question that would settle it. Never guess
  what the requester meant: if you would have to assume, ask.
- reject — it is not a change to software, or it asks for something harmful.

You have no tools but these three, and you MUST end your turn by calling one of them.`,
    }),
  },
}).createMachine({
  id: "triage",
  input: door,
  context: ({ input }) => ({ request: input.request, exchange: [] }),
  initial: "triaging",
  states: {
    // The Agent's Menu is the events that this state takes: accept, needs_info and reject.
    triaging: {
      invoke: { src: "triager", input: ({ context }) => ({ prompt: prompt(context) }) },
      on: {
        accept: { target: "accepted", actions: assign({ summary: ({ event }) => event.summary }) },
        reject: { target: "rejected", actions: assign({ reason: ({ event }) => event.reason }) },
        needs_info: {
          target: "clarify",
          actions: assign({
            exchange: ({ context, event }) => [...context.exchange, { question: event.question }],
            fault: undefined,
          }),
        },
        // The Turn failed, with no pick. Wait at the Gate, so that your answer starts a new Turn.
        "agent.fault": { target: "clarify", actions: assign({ fault: ({ event }) => event.reason }) },
      },
    },
    // The Gate. Its name is the name of this state, and it takes the events of this state: answer.
    clarify: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta:
            context.fault !== undefined ? { fault: context.fault } : { question: context.exchange.at(-1)!.question },
        }),
      },
      on: {
        answer: {
          target: "triaging",
          actions: assign({
            exchange: ({ context, event }) =>
              context.fault !== undefined
                ? context.exchange
                : [...context.exchange.slice(0, -1), { ...context.exchange.at(-1)!, info: event.info }],
            fault: undefined,
          }),
        },
      },
    },
    accepted: { type: "final", output: ({ context }): Output => ({ outcome: "accepted", summary: context.summary! }) },
    rejected: { type: "final", output: ({ context }): Output => ({ outcome: "rejected", reason: context.reason! }) },
  },
  // xstate reads only this root `output`. It gets the output of the final state as `event.output`.
  output: ({ event }) => event.output as Output,
});

// The prompt of each Turn: the request, then each question and its answer.
function prompt(context: Ctx): string {
  const answered = context.exchange
    .filter((e) => e.info !== undefined)
    .map((e) => `\n\nYou asked: ${e.question}\nThe requester answered: ${e.info}`)
    .join("");
  return `Feature request:\n${context.request}${answered}`;
}
