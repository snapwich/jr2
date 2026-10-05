// The step-boundary check (ADR-0029, ADR-0016): the Turn part restated INSIDE a running Turn when
// the Allowed picks changed since the model last read them — a Gate's answer, an outside event, a
// child's invoke that settled — while the Agent works with its Working tools and picks nothing.
//
// Level, not edge. The Harness keeps the last Allowed-picks list the model READ — the Briefing's
// Turn part, then every receipt and refusal (`MenuOptions.onAllowed`) — and at each step boundary
// compares it, as a set, with the surface's list NOW. So "did the Agent's own pick cause this?" is
// never asked: a pick's receipt already told the model its new list, and that list is what is
// compared. A change that came and went between two boundaries is no change; a change the model
// already read is never said twice.
//
// Engine-neutral: nothing here knows the engine. The engine's part is one placement — call
// `between()` after a step's tool results and before its next model request, and append what it
// returns as a user message (`turn.ts` does it for pi, with a `turn_end` subscriber and `steer`).
// An engine with no between-steps input never calls it, and the model learns at its next receipt.

import { restatedTurnPart } from "./briefing.ts";
import { readAllowed, type MenuOptions } from "./menu.ts";

/** The last Allowed-picks list the model read, as a set. One per conversation. */
export class ToldPicks {
  #told: string | undefined;

  /** The model read this list (the Turn part, a receipt, a refusal, or a restatement). */
  heard(allowed: readonly string[]): void {
    this.#told = key(allowed);
  }

  /** Does `now` differ from what the model last read? Order-blind: a set, not a sentence. Before
   * anything was heard, nothing differs — a Turn always starts by reading its Turn part. */
  differs(now: readonly string[]): boolean {
    return this.#told !== undefined && this.#told !== key(now);
  }
}

function key(allowed: readonly string[]): string {
  return JSON.stringify([...new Set(allowed)].sort());
}

/**
 * The step-boundary check: the text to append, or `undefined` for nothing. Reads the surface once
 * (`readAllowed`: bounded, one attempt, every failure is silence — the next boundary asks again) and
 * says the new list only when it differs from the one the model read — then records it as read.
 *
 * THE ASK-AGAIN RULE (ADR-0016) — the Orchestrator holds its other moments, the nudge and the
 * wake: while the Turn is open, a model that STOPS is asked again once its Allowed picks are not
 * empty. Here, inside its Submission, when the list changed since it last read it: an appended
 * message keeps the engine's loop going. So when the step ended with no tool call (`stopped`) and
 * the list is now EMPTY, nothing is said — a restatement there buys a request in which the model
 * can pick nothing. The Submission ends, and the Orchestrator's wake asks the model when a pick
 * opens. A step that ran tools goes on anyway, so any change is said there, an empty list included.
 */
export async function between(
  opts: MenuOptions,
  instanceId: string,
  told: ToldPicks,
  signal?: AbortSignal,
  step: { stopped?: boolean } = {},
): Promise<string | undefined> {
  const now = await readAllowed(opts, instanceId, signal);
  if (now === undefined || !told.differs(now)) return undefined;
  if (step.stopped && now.length === 0) return undefined;
  told.heard(now);
  return restatedTurnPart(now, opts.toolName);
}
