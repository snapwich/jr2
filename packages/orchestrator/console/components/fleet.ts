// The fleet rail: every registered workflow, each expandable to its runs — the master half of the
// master–detail shell (ADR-0032). Every row derives from store selectors (`fleetRuns`), never a
// component-local cache; the vdom's keyed diff is what keeps a half-typed start form alive under
// the status frames that used to demand main.js's hand-rolled `memo()`.
//
// A named Chart is a Workflow (ADR-0070): it lists under its Chart wrapper, indented, with its origin
// (`chart file` or `chart`) and, when a publish no longer admits it, `unrunnable` with the reason.

import { h, type JSX } from "preact";
import { dispatchBadge, fleetEntries, fleetRuns, type FleetEntry, type ObservedRun, type Store } from "../store.ts";
import { SchemaForm } from "./schema-form.ts";
import type { AppApi } from "./app.ts";

export function Fleet(props: { store: Store; schemas: ReadonlyMap<string, unknown>; api: AppApi }): JSX.Element {
  const { store, schemas, api } = props;
  const entries = fleetEntries(store.listing);
  return h(
    "aside",
    { id: "fleet" },
    h("div", { class: "sidebar-head" }, h("h2", null, "Fleet")),
    h(
      "ul",
      { id: "workflow-list" },
      entries.length
        ? entries.map((entry) => workflowItem(entry, store, schemas, api))
        : h("li", { class: "empty" }, "no workflows registered"),
    ),
  );
}

/** How the rail names an origin (ADR-0070); a Machine that is no Chart wrapper shows none. */
function originTag(entry: FleetEntry): string | null {
  if (entry.origin === "file") return "chart file";
  if (entry.origin === "runtime") return "chart";
  if (entry.wrapper) return entry.wrapper.oneShot ? "chart wrapper, one-shot" : "chart wrapper";
  return null;
}

function workflowItem(
  entry: FleetEntry,
  store: Store,
  schemas: ReadonlyMap<string, unknown>,
  api: AppApi,
): JSX.Element {
  const name = entry.name;
  const rows = fleetRuns(store, name);
  const tag = originTag(entry);
  return h(
    "li",
    {
      key: name,
      class: `${name === store.workflow ? "wf wf--selected" : "wf"}${entry.depth ? " wf--chart" : ""}`,
      // A Chart indents under its wrapper; the rail's stylesheet has no rule for depth yet.
      style: entry.depth ? { marginLeft: "14px" } : undefined,
    },
    h(
      "div",
      { class: "wf-head", onClick: () => void api.selectWorkflow(name, { push: true }) },
      h(
        "button",
        {
          class: "wf-caret",
          title: "fold this workflow's runs",
          onClick: (e: Event) => {
            e.stopPropagation();
            api.dispatch({ kind: "toggleWorkflow", workflow: name });
          },
        },
        store.expanded.has(name) ? "▾" : "▸",
      ),
      h("span", { class: "wf-name" }, name),
      tag ? h("span", { class: "wf-count wf-origin" }, tag) : null,
      entry.unrunnable ? h("span", { class: "wf-count wf-unrunnable", title: entry.unrunnable }, "unrunnable") : null,
      entry.shadows
        ? h(
            "span",
            { class: "wf-count wf-unrunnable", title: entry.shadows.unrunnable ?? "a Chart of this name is shadowed" },
            entry.shadows.origin === "runtime" ? "shadows a chart" : "shadows a chart file",
          )
        : null,
      h("span", { class: "wf-count" }, String(rows.filter((r) => !r.settled).length)),
      store.token === "live" && !entry.unrunnable
        ? h(
            "button",
            {
              class: "wf-start-btn",
              title: `start a ${name} run`,
              onClick: (e: Event) => {
                e.stopPropagation();
                void api.toggleStartForm(name);
              },
            },
            "start",
          )
        : null,
    ),
    store.startFormFor === name ? startForm(name, schemas, api) : null,
    store.expanded.has(name) ? runRows(name, rows, store, api) : null,
  );
}

/** The start-run form (ADR-0033), or its placeholder while the input schema is on the wire. */
function startForm(name: string, schemas: ReadonlyMap<string, unknown>, api: AppApi): JSX.Element {
  if (!schemas.has(name)) return h("div", { class: "start-form" }, "loading input schema…");
  return h(
    "div",
    { class: "start-form" },
    h(SchemaForm, {
      schema: schemas.get(name),
      submitLabel: "start run",
      onSubmit: (body) => api.startRun(name, body),
    }),
  );
}

function runRows(
  name: string,
  rows: Array<{ run: ObservedRun; settled: boolean }>,
  store: Store,
  api: AppApi,
): JSX.Element {
  return h(
    "ul",
    { class: "wf-runs" },
    rows.length
      ? rows.map(({ run, settled }) => runRow(name, run, settled, store, api))
      : h("li", { class: "empty" }, "no live runs"),
  );
}

function runRow(name: string, run: ObservedRun, settled: boolean, store: Store, api: AppApi): JSX.Element {
  const gates = store.gates.get(run.runId)?.gates.length ?? 0;
  const selected = name === store.workflow && run.runId === store.selectedRunId;
  // A dispatched run names its caller on the row (ADR-0071), off the open observation.
  const badge = dispatchBadge(run);
  return h(
    "li",
    {
      key: run.runId,
      class: `${settled ? "settled" : ""}${selected ? " selected" : ""}`.trim(),
      onClick: () => {
        if (name === store.workflow) api.dispatch({ kind: "selectRun", runId: run.runId });
        else void api.selectWorkflow(name, { push: true, runId: run.runId });
      },
    },
    h("span", { class: "run-id" }, run.runId.slice(0, 8)),
    badge && run.dispatchedBy
      ? h(
          "span",
          {
            class: "dispatch-badge dim",
            title: `dispatched by ${run.dispatchedBy.run} (${run.dispatchedBy.slot}), depth ${run.dispatchedBy.depth}`,
            style: { fontSize: "11px", marginRight: "6px" },
          },
          badge,
        )
      : null,
    gates
      ? h("span", { class: "gate-badge", title: `${gates} open gate${gates === 1 ? "" : "s"}` }, `⚑${gates}`)
      : null,
    h("span", { class: `run-status status--${run.status}` }, run.status),
  );
}
