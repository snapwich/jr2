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

import type { Answered } from "./model-said.ts";

/** The trial's reading: measured, or not; `void` (a note) when it says nothing about the claim. */
export type ChartRefusalReading = { measured: boolean; void?: string; note: string };

/** A door verdict that admitted the Chart. */
const ADMITTED = new Set(["admitted", "errored"]);

/**
 * Read a trial from the Machine's door verdicts, in order, and the planner's `run_chart` calls with
 * the answers it read (`answersIn`), when the conversation printed.
 */
export function readChartRefusal(
  outcomes: readonly string[],
  answered: readonly Answered[] | undefined,
  pick = "run_chart",
): ChartRefusalReading {
  const calls = (answered ?? []).filter((a) => a.call === pick);
  const note = `Charts ${outcomes.join(" ") || "none"}, ${calls.length} ${pick} call(s)`;
  if (outcomes[0] !== "refused") {
    const why = outcomes.length ? "the first Chart the door saw admitted" : "no Chart reached the door";
    return { measured: false, void: `void: ${why}`, note };
  }
  const admitted = ADMITTED.has(outcomes[1] ?? "");
  if (answered === undefined) return { measured: admitted, note: `${note} (no conversation printed)` };
  // The calls that reached the door are those the Menu did not refuse: the first is the refused one.
  const door = calls.findIndex((c) => !c.error);
  const next = door === -1 ? undefined : calls[door + 1];
  return { measured: admitted && next !== undefined && !next.error, note };
}
