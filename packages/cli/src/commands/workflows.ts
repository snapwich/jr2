// `jr2 workflows` (ADR-0009, ADR-0070): the Workflows that a run can start, from `GET /workflows`.
// One line per Workflow with its origin (`machine`, `chart file`, `chart`), a Chart wrapper's Charts
// indented under it, and `unrunnable` with its reason. `--json` prints the listing as the report.
// No verb puts or deletes a runtime Chart: `PUT`/`DELETE /workflows/<wrapper>/charts/<name>` is for
// an MCP or curl.

import { JR2Client, type WorkflowListing, type WorkflowOrigin } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";
import { parseCommand } from "../command-table.ts";

export async function workflows(args: string[], io: Io): Promise<number> {
  const { values } = parseCommand("workflows", args);
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const listing = await new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf).workflows();
    if (values.json === true) result(io, listing);
    else io.stdout(`${renderWorkflows(listing)}\n`);
    return 0;
  } finally {
    target.close?.();
  }
}

/** How a listing names an origin (ADR-0070): a runtime Chart is plainly a `chart`. */
const ORIGIN_LABEL: Record<WorkflowOrigin, string> = { machine: "machine", file: "chart file", runtime: "chart" };

/**
 * The Workflow listing as lines: each Workflow with its origin, a Chart wrapper's Open body and
 * whether its door takes a Chart one-shot, its Charts indented under it, and `unrunnable` with the
 * reason. A Chart the listing also gives at the top level (or whose wrapper it does not list) prints
 * once: under its wrapper when the wrapper is listed, else at the top level.
 */
export function renderWorkflows(listing: readonly WorkflowListing[]): string {
  const underWrapper = new Set<string>();
  for (const w of listing) for (const c of w.wrapper?.charts ?? []) underWrapper.add(chartFullName(w.name, c.name));
  const line = (indent: string, name: string, label: string, unrunnable?: string): string =>
    `${indent}${name} (${label})${unrunnable ? ` unrunnable: ${unrunnable}` : ""}`;
  const out: string[] = [];
  for (const w of listing) {
    if (w.origin !== "machine" && underWrapper.has(w.name)) continue;
    const wrapper = w.wrapper;
    const label = wrapper
      ? `${ORIGIN_LABEL[w.origin]}, Chart wrapper: body "${wrapper.body}"${wrapper.oneShot ? ", one-shot" : ""}`
      : ORIGIN_LABEL[w.origin];
    out.push(line("", w.name, label, w.unrunnable));
    for (const c of wrapper?.charts ?? []) {
      out.push(line("  ", chartFullName(w.name, c.name), ORIGIN_LABEL[c.origin], c.unrunnable));
    }
  }
  if (out.length === 0) out.push("none registered — `jr2 up` publishes the Assembly");
  return out.join("\n");
}

/** A Chart's Workflow name, `<wrapper>/<name>` (ADR-0070), whether the listing gives it short or whole. */
function chartFullName(wrapper: string, name: string): string {
  return name.includes("/") ? name : `${wrapper}/${name}`;
}
