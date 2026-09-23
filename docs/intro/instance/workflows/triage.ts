// The first workflow where a model CHOOSES — and the Machine drew every edge it can choose among.
// One Menu-only Agent (ADR-0031): `workspace: "none"` withholds every Working tool, so it can read
// and pick, nothing else, and it places each Turn on the Instance Harness — no Sandbox, no clone,
// no pod for the run. Filename `triage.ts` → workflow "triage":
//
//   jr2 run triage --input '{"request":"People keep asking what version they are running."}'
//
// Shape: `triaging` offers the Agent exactly three events — `accept`, `needs_info`, `reject` — and
// nothing else (ADR-0015 derives the Menu from this state's transitions; ADR-0029 narrows it to
// what the Machine will take). `accept` and `reject` end the run. `needs_info` parks at the
// `clarify` Gate, and the human's `answer` sends the Agent round again with that answer in hand:
//
//   jr2 send $RUN --gate clarify --event answer --input '{"info":"…"}'
//
// Every Turn CONTINUES one conversation (ADR-0057): the triager remembers the request and its own
// question, so the Turn after a Gate is framed with the human's answer alone. That works because
// ADR-0031 places a Menu-only Agent on the Instance Harness always, so a continue always lands on
// the Harness that holds the conversation. The Machine's context still keeps the whole exchange,
// because a conversation jr2 has faulted is buried and the next continue starts from nothing —
// that Turn gets the full brief again.

import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";

// The door (ADR-0033): what a run starts with. The Console renders its start form from this.
const door = z.object({
  request: z.string().describe("A feature request, in the requester's own words."),
});

// Vocabulary (ADR-0011): the Agent's three picks, and the human's one reply. `audience` keeps the
// two apart — no Agent state can ever offer `answer`, and no Gate can ever accept a pick.
const accept = defineEvent({
  name: "accept",
  description: "The request is clear enough to build: it names what to change, where, and how to tell it is done.",
  audience: "agent",
  input: z.object({ summary: z.string().describe("The request restated as one actionable sentence.") }),
});
const needsInfo = defineEvent({
  name: "needs_info",
  description: "The request could be built more than one way, or its outcome cannot be checked. Ask one question.",
  audience: "agent",
  input: z.object({ question: z.string().describe("The one question whose answer would make it buildable.") }),
});
const reject = defineEvent({
  name: "reject",
  description: "The request is not a change to software, or it asks for something harmful.",
  audience: "agent",
  input: z.object({ reason: z.string().describe("Why, in one sentence.") }),
});
const answer = defineEvent({
  name: "answer",
  description: "Answer the triager's question. It triages the request again with the answer in hand.",
  audience: "external",
  input: z.object({ info: z.string().describe("The answer, in prose.") }),
});

type Input = z.infer<typeof door>;
type Ctx = Input & {
  /** Every question asked and the answer it got, oldest first — the record a re-brief reads. */
  exchange: { question: string; info?: string }[];
  /** Turns COMPLETED on the conversation the next Turn lands on. Zero means that Turn is its first,
   * so it carries the full brief; after a fault it is zero again (task.ts counts the same way). */
  turns: number;
  /** Why the last Turn ended without a pick, when it did — the Gate shows it instead of a question. */
  fault?: string;
  /** The Agent's accepted restatement, or its reason to reject — what the run settles with. */
  summary?: string;
  reason?: string;
};
type Output = { outcome: "accepted"; summary: string } | { outcome: "rejected"; reason: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: Output },
  events: [accept, needsInfo, reject, answer],
  actors: {
    triager: agent({
      // `local` is the provider in jr2.config.ts; see task.ts for what the rest of the specifier is.
      model: "local/qwen3.6-35b-a3b",
      description: "Reads one feature request and decides whether it can be built as written.",
      workspace: "none",
      // One short Turn: a pick, not a plan.
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
  context: ({ input }) => ({ request: input.request, exchange: [], turns: 0 }),
  initial: "triaging",
  states: {
    triaging: {
      invoke: { src: "triager", input: ({ context }) => ({ prompt: prompt(context), continue: true }) },
      on: {
        accept: { target: "accepted", actions: assign({ summary: ({ event }) => event.summary }) },
        reject: { target: "rejected", actions: assign({ reason: ({ event }) => event.reason }) },
        needs_info: {
          target: "clarify",
          actions: assign({
            exchange: ({ context, event }) => [...context.exchange, { question: event.question }],
            turns: ({ context }) => context.turns + 1,
            fault: undefined,
          }),
        },
        // jr2 has already retried and rerolled (ADR-0016/0035), and buried the conversation
        // (ADR-0057). Park at the same Gate: the human's next `answer` retries on a new one, and
        // `turns: 0` has that Turn carry the full brief.
        "agent.fault": { target: "clarify", actions: assign({ fault: ({ event }) => event.reason, turns: 0 }) },
      },
    },
    // The human's seat. The Gate id derives from this state's key, so `--gate clarify` names it.
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
    accepted: {
      type: "final",
      output: ({ context }): Output => ({ outcome: "accepted", summary: context.summary! }),
    },
    rejected: {
      type: "final",
      output: ({ context }): Output => ({ outcome: "rejected", reason: context.reason! }),
    },
  },
  output: ({ event }) => (event as { output?: Output }).output as Output,
});

/** The Turn's prompt. A conversation's first Turn gets the request and every question and answer
 * so far; each Turn after it gets only the latest answer, since the triager remembers the rest. */
function prompt(context: Ctx): string {
  if (context.turns > 0) return `The requester answered: ${context.exchange.at(-1)!.info}`;
  const qa = context.exchange
    .filter((e) => e.info !== undefined)
    .map((e) => `\n\nYou asked: ${e.question}\nThe requester answered: ${e.info}`)
    .join("");
  return `Feature request:\n${context.request}${qa}`;
}
