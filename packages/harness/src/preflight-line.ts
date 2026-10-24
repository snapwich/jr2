// The provider preflight's result lines (ADR-0019): what `provider-preflight.ts` writes, one per model, and
// what `jr2 up` reads off the check container's log. No import, so the CLI's test can load this
// file from beside it and hold its own parser to the same format.
//
//   jr2.preflight model=<specifier> start
//   jr2.preflight model=<specifier> ok
//   jr2.preflight model=<specifier> <fault|busy|warn>=<reason on one line>
//
// A `start` line comes before each model's check, so a reader of a pod that was stopped knows
// which model the check was on, and which it never reached.

/** How one model answered the check (`checkModel`): `ok` — it called the tool; `fault` — the
 * converge fails; `busy` — the provider refused the load after the retries, and so answered with
 * the key (ADR-0064); `warn` — it answered but did not call a tool it was not forced to call. */
export type PreflightVerdict = { kind: "ok" } | { kind: "fault" | "busy" | "warn"; reason: string };

export const PREFLIGHT_PREFIX = "jr2.preflight";

/** One result line. The reason goes on one line: the reader splits on newlines. */
export function preflightLine(specifier: string, verdict: PreflightVerdict): string {
  const said = verdict.kind === "ok" ? "ok" : `${verdict.kind}=${verdict.reason.replace(/\s+/g, " ").trim()}`;
  return `${PREFLIGHT_PREFIX} model=${specifier} ${said}`;
}

/** The line before a model's check. */
export function preflightStart(specifier: string): string {
  return `${PREFLIGHT_PREFIX} model=${specifier} start`;
}

/** Each model's whole budget in the check, in seconds: up to two calls, each up to 120 s to its
 * first event and 60 s of the gaps that follow. `provider-preflight.ts` stops a model at it, and
 * `jr2 up` gives the pod as long for each model; the CLI's test holds its own number to this one. */
export const PREFLIGHT_MODEL_BUDGET_SECONDS = 360;
