// What each @model claim workflow means by "finished" (ADR-0066): the run reached a final state its
// task allows, whichever the model chose. Pure, so a unit test pins each table row without a cluster.
//
// A trial that took the other task final still FINISHED: the claim's measure says whether that was
// the right pick, and its floor is what tolerates a miss. Counting such a trial unfinished as well
// would fail every scenario on one miss, and make the floor 10 of 10 in all but name.

/** The parts of `jr2 status` the reading uses. */
export type RunEnd = { status: string; value: unknown; context: { output?: Record<string, unknown> } };

/** A root Machine's final state is its `value`; a `workspace()` body's is the outcome it forwards. */
const finalIn =
  (...finals: string[]) =>
  (s: RunEnd): boolean =>
    s.status === "done" && finals.includes(String(s.value));
const outcomeIn =
  (...outcomes: string[]) =>
  (s: RunEnd): boolean =>
    s.status === "done" && outcomes.includes(String(s.context.output?.outcome));

export const FINISHED: Record<string, (s: RunEnd) => boolean> = {
  obedience: finalIn("held"),
  advised: finalIn("answered"),
  workdir: outcomeIn("finished"),
  noticed: outcomeIn("finished"),
  "mode-follow": finalIn("submitted"),
  "mode-refusal": finalIn("published"),
  "mode-stop": finalIn("submitted"),
  wake: finalIn("released", "held"),
  "push-follow": outcomeIn("submitted"),
  "chain-answer": finalIn("held", "released"),
  "cut-pick": finalIn("filed"),
  answered: outcomeIn("reported", "shipped"),
  "allowed-after-route": outcomeIn("filed", "shipped"),
  "unknown-outcome": outcomeIn("checked", "announced"),
  "continue-after-signed-push": outcomeIn("finished"),
};
