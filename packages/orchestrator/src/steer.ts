// The Machine's Steering message (ADR-0002): free text to one Agent of the Machine, which the Agent
// hears once, at a step boundary of its open Turn or at its next Turn's admission. The run's notice
// ledger keeps it (ADR-0062); this module is only the action an author writes.

import type { ActionFunction, EventObject, MachineContext, ParameterizedObject, ProvidedActor } from "xstate";
import type { Sender } from "@jr2/agent-protocol";
import { boundRun } from "./registration.ts";

/** The most text one Steering message carries, in UTF-8 bytes: the bound of
 * `POST /runs/:runId/steering`, whose larger text is 413. The `steer` action cuts a longer text. */
export const STEERING_TEXT_MAX = 16 * 1024;

/** What `steer` adds to the end of a text that it cut at {@link STEERING_TEXT_MAX}. */
const CUT_MARK = "\n[jr2 cut this message at 16 KiB]";

/** A text, cut to {@link STEERING_TEXT_MAX} UTF-8 bytes with the cut mark when it is longer. */
export function boundSteeringText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= STEERING_TEXT_MAX) return text;
  const room = STEERING_TEXT_MAX - new TextEncoder().encode(CUT_MARK).length;
  // `fatal: false` drops a character that the cut split in two.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, room)).replace(/�$/, "");
  return `${head}${CUT_MARK}`;
}

/** The arguments a `steer` text or `from` function gets: the Machine's context and the event that
 * the transition takes. */
type SteerArgs<TContext, TEvent> = { context: TContext; event: TEvent };

/**
 * Send a Steering message to one Agent of this Machine: an action for a transition. The Agent hears
 * the text once, without an interrupt. When a Turn of the Agent is open, its Harness adds the text
 * at the Turn's next step boundary. Otherwise the text waits for the Agent's next Turn in this
 * Machine instance. When this Machine instance ends first, the message is not delivered.
 *
 * A Steering message is not an event: no guard reads it, and no Gate takes it. The Agent decides
 * what to do with it, and acts on the workflow only by its picks.
 *
 * Use it to relay what one Agent says to another. Give `from` the Sender of the event (the
 * `sender` field that the Orchestrator writes on it): the Agent then reads the text as the word of
 * a peer, not as an order. When the Sender is a Gate, the Agent reads the text as what the Gate
 * received, not as an order. With no `from`, the Agent reads the text as the workflow's own.
 *
 * `agent` is the name of an Agent in this Machine's `actors`. A text longer than 16 KiB is cut.
 * The Machine can steer an Agent whose definition says `steerable: false`: that refuses Callers
 * only.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, jr2Setup, steer } from "@jr2/orchestrator";
 *
 * const done = defineEvent({ name: "done", description: "The draft is ready.", input: z.object({}) });
 * const note = defineEvent({
 *   name: "note",
 *   description: "Send the draft back to the writer, with what to change.",
 *   input: z.object({ text: z.string().min(1) }),
 * });
 *
 * export const machine = jr2Setup({
 *   events: [done, note],
 *   actors: {
 *     writer: agent({ model: "anthropic/claude-haiku-5-5", instructions: "You write.", workspace: "none" }),
 *     reviewer: agent({ model: "anthropic/claude-haiku-5-5", instructions: "You review.", workspace: "none" }),
 *   },
 * }).createMachine({
 *   initial: "writing",
 *   states: {
 *     writing: {
 *       invoke: { src: "writer", input: { prompt: "Write the notes.", continue: true } },
 *       on: { done: "reviewing" },
 *     },
 *     reviewing: {
 *       invoke: { src: "reviewer", input: { prompt: "Review the notes." } },
 *       on: {
 *         // The writer's next Turn hears the note as the reviewer's word, not as an order.
 *         note: {
 *           target: "writing",
 *           actions: steer("writer", ({ event }) => event.text, { from: ({ event }) => event.sender }),
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @see docs/guides/steer-an-agent.md
 * @see docs/concepts/agents-and-turns.md
 * @see docs/reference/decisions/0002-duplex-streaming-actor.md
 */
export function steer<
  TContext extends MachineContext,
  TExpressionEvent extends EventObject,
  TParams extends ParameterizedObject["params"] | undefined,
  TEvent extends EventObject,
  TActor extends ProvidedActor,
>(
  agent: string,
  text: string | ((args: SteerArgs<TContext, TExpressionEvent>) => string),
  opts: { from?: Sender | ((args: SteerArgs<TContext, TExpressionEvent>) => Sender | undefined) } = {},
): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, TActor, never, never, never, never> {
  return ({ context, event, self }) => {
    const binding = boundRun(self.system);
    // Outside a RunHost there is no ledger, and no Agent to hear it.
    if (binding?.steer === undefined) return;
    const said = typeof text === "function" ? text({ context, event }) : text;
    if (typeof said !== "string" || said.length === 0) return;
    const from = typeof opts.from === "function" ? opts.from({ context, event }) : opts.from;
    binding.steer(self, agent, boundSteeringText(said), from);
  };
}
