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
// `between()` after a model answer's tool results and before the next request, and append what it
// returns as a user message (`turn.ts` does it through the seam, with a `step_boundary` listener and
// `steer`).
// An engine with no between-steps input never calls it, and the model learns at its next receipt.
//
// The same read returns the conversation's pending notices (ADR-0062), reserved for it. They are
// appended in the same block, ahead of any restated picks, and the Turn acknowledges them once the
// block is in the Turn (`turn.ts`); a reservation it does not acknowledge is released when the Turn
// ends, and the next admission carries the notice.

import { noticeText, restatedTurnPart } from "./briefing.ts";
import { readStep, type HeldNotice, type MenuOptions } from "./menu.ts";

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

/** What a step boundary appends: the text, and the ids of the notices in it, to acknowledge once
 * the text is in the Turn. */
export type Between = { text: string; heard: string[] };

/**
 * The step-boundary check: what to append, or `undefined` for nothing. Reads the surface once
 * (`readStep`: bounded, one attempt, every failure is silence — the next boundary asks again) and
 * says the new list only when it differs from the one the model read — then records it as read —
 * and each pending notice the read reserved.
 *
 * THE ASK-AGAIN RULE (ADR-0016) — the Orchestrator holds its other moments, the nudge and the wake:
 * while the Turn is open, a model that STOPS is asked again once its Allowed picks are not empty.
 * Here, inside its Submission, when the list changed since it last read it: an appended message
 * keeps the engine's loop going. So when the model answer had no tool call (`stopped`) and the list
 * is now EMPTY, nothing is said — a restatement there buys a request in which the model can pick
 * nothing. The Submission ends, and the Orchestrator's wake asks the model when a pick opens. A
 * model answer that ran tools goes on anyway, so any change is said there, an empty list included.
 * The rule holds for a notice too: a stopped model with nothing allowed is told nothing here, and
 * hears the notice at its next admission.
 */
export async function between(
  opts: MenuOptions,
  instanceId: string,
  told: ToldPicks,
  signal?: AbortSignal,
  boundary: { stopped?: boolean; briefings?: ReadonlyMap<string, string> } = {},
): Promise<Between | undefined> {
  const now = await readStep(opts, instanceId, signal);
  if (now === undefined) return undefined;
  if (boundary.stopped && now.allowed.length === 0) return undefined;
  const changed = told.differs(now.allowed);
  if (!changed && now.notices.length === 0) return undefined;
  if (changed) told.heard(now.allowed);
  return {
    text: steppedTurnPart(now.notices, changed ? now.allowed : undefined, opts.toolName, boundary.briefings),
    heard: now.notices.map((n) => n.id),
  };
}

/**
 * The block a step boundary appends (ADR-0062): each notice, then the Allowed picks restated when
 * they changed. Notices alone are a `<jr2-turn>` block of their own; with a change, the restatement
 * is the block's (`restatedTurnPart`) and the notices lead it.
 */
export function steppedTurnPart(
  notices: readonly HeldNotice[],
  allowed: string[] | undefined,
  toolName?: (name: string) => string,
  briefings?: ReadonlyMap<string, string>,
): string {
  const lines = notices.map((n) => noticeText(n.notice, toolName));
  if (allowed === undefined) return `<jr2-turn>\n${lines.join("\n")}\n</jr2-turn>`;
  const restated = restatedTurnPart(allowed, toolName, briefings);
  if (lines.length === 0) return restated;
  return restated.replace(/^<jr2-turn>\n/, `<jr2-turn>\n${lines.join("\n")}\n`);
}
