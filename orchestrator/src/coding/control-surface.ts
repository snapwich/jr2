// The agent control surface (ADR-0006).
//
// Each agent-driving Machine state advertises a FLAT, NAMED menu of the events
// the Agent may emit from that state. The Agent picks ONE; the Machine owns the
// transition table — the Agent answers within a frame, it never steers the
// workflow. "Encode flat" (ADR-0006 / PoC #5b): a menu is a plain list of names,
// never a nested `oneOf`/`anyOf` union (unsatisfiable for Qwen3-Coder).
//
// The coder reuses the FROZEN control-plane events (`control-plane.ts`'s
// `ControlEvent`) verbatim. The reviewer verdict (`approve` / `request_changes`)
// is modeled here at the TEMPLATE layer — the reviewer is a mock in #8, so the
// frozen control plane is left untouched; this is the seed of the shared
// contract package ADR-0006 anticipates.

import type { ControlEvent } from "../control-plane.ts";

/** A flat, named menu of allowed agent-event kinds for one state. */
export type Menu = readonly string[];

/** Coding state — what a coder Agent may emit (maps to frozen `ControlEvent`). */
export const CODER_MENU = ["request_review", "done", "report_blocked", "request_approval"] as const;
export type CoderPick = (typeof CODER_MENU)[number];

/** Reviewing state — the reviewer's verdict menu (template-level, ADR-0006). */
export const REVIEWER_MENU = ["approve", "request_changes"] as const;
export type ReviewerPick = (typeof REVIEWER_MENU)[number];

/** The reviewer's verdict, raised UP to the Workspace Machine. */
export type ReviewVerdictEvent =
  | { type: "agent.approve"; instanceId: string }
  | { type: "agent.requestChanges"; instanceId: string; notes: string };

/** Every agent up-event the inner code/review loop reacts to. */
export type InnerLoopEvent = ControlEvent | ReviewVerdictEvent;

/**
 * Guard a pick against the state's menu — the ADR-0006 invariant, enforced.
 * Mock agents call this before emitting; tests assert it never throws, proving
 * "the Agent picks from the menu the state allows."
 */
export function assertInMenu(menu: Menu, pick: string): void {
  if (!menu.includes(pick)) {
    throw new Error(`control-surface: "${pick}" is not in the advertised menu [${menu.join(", ")}]`);
  }
}
