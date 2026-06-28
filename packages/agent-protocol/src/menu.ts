// The control surface: a flat, named menu of picks a Machine state offers an Agent (ADR-0006).
//
// "Encode flat": a menu is just a list of allowed tool names. We deliberately avoid a strict
// `oneOf`/`const` union — that shape is unsatisfiable for some models (e.g. Qwen3-Coder). A
// state advertises its menu; `assertInMenu` is the guard that a received pick was on it.

export type Menu = readonly string[];

/** Throw if `pick` is not one of the menu's allowed entries. */
export function assertInMenu(menu: Menu, pick: string): void {
  if (!menu.includes(pick)) {
    throw new Error(`pick "${pick}" is not in the menu [${menu.join(", ")}]`);
  }
}

/**
 * The coder's per-turn picks — a subset of the callback toolset. `check_inbox` is a poll, not
 * an outcome the coder "picks" to end a turn, so it is excluded.
 */
export const DEFAULT_CODER_MENU = ["request_review", "request_approval", "report_blocked", "done"] as const;
