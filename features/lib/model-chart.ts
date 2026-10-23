// How the chart-refusal claim reads one trial (ADR-0066, ADR-0070). Pure, so a unit test pins the
// void rule and the measured pick without a cluster or a model.
//
// The claim measures the `run_chart` pick that comes after the door refused the planner's Chart.
// Its setup is that refusal: a trial whose first Chart that reached the door admitted, or whose
// Charts never reached the door at all, never saw one, and is void. A pick the Menu refused on the
// grammar (its answer is an error) never reached the door, so it is not the setup; one that comes
// after the door's refusal is the measured pick, and it is a miss. The Machine's `outcomes` say
// each door verdict in order: `refused`, `admitted`, or `errored` (the door admitted the Chart and
// its body then failed, which is still an admission).
//
// Two Harness answers say a call is not a door verdict (ADR-0002, ADR-0024). A second pick of one
// model answer did not run (`STALE`): it is no call the model made of the door, so it is skipped.
// And a pick whose answer was lost says the Harness does not know whether it reached the workflow
// (`NOT_KNOWN`, no error): the calls can then no longer be paired with the door's verdicts, so a
// trial with one at or after the door's refusal is void.

import type { Answered } from "./model-said.ts";

/** The trial's reading: measured, or not; `void` (a note) when it says nothing about the claim. */
export type ChartRefusalReading = { measured: boolean; void?: string; note: string };

/** A door verdict that admitted the Chart. */
const ADMITTED = new Set(["admitted", "errored"]);

/** The start of the Harness's answer to a second pick of one model answer (`stalePickResult`). */
const STALE = "This pick did not run: you sent it before you read the answer to ";

/** The start of the Harness's answer to a pick it may have delivered (`unknownPickResult`). */
const NOT_KNOWN = "It is not known whether this pick reached the workflow";

/**
 * Read a trial from the Machine's door verdicts, in order, and the planner's `run_chart` calls with
 * the answers it read (`answersIn`), when the conversation printed.
 */
export function readChartRefusal(
  outcomes: readonly string[],
  answered: readonly Answered[] | undefined,
  pick = "run_chart",
): ChartRefusalReading {
  const calls = (answered ?? []).filter((a) => a.call === pick && !a.answer?.startsWith(STALE));
  const note = `Charts ${outcomes.join(" ") || "none"}, ${calls.length} ${pick} call(s)`;
  if (outcomes[0] !== "refused") {
    const why = outcomes.length ? "the first Chart the door saw admitted" : "no Chart reached the door";
    return { measured: false, void: `void: ${why}`, note };
  }
  const admitted = ADMITTED.has(outcomes[1] ?? "");
  if (answered === undefined) return { measured: admitted, note: `${note} (no conversation printed)` };
  // The calls that reached the door are those the Menu did not refuse: the first is the refused one.
  const door = calls.findIndex((c) => !c.error);
  if (door !== -1 && calls.slice(door).some((c) => c.answer?.startsWith(NOT_KNOWN))) {
    return {
      measured: false,
      void: "void: a run_chart answer was lost, so a call cannot be paired with a verdict",
      note,
    };
  }
  const next = door === -1 ? undefined : calls[door + 1];
  return { measured: admitted && next !== undefined && !next.error, note };
}
