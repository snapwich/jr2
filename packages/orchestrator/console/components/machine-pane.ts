// The center pane: the selected workflow's Machine. The vdom renders the pane's chrome — the
// placeholder, the error/notice, the root-transition strip — and mounts one <svg> it then never
// looks inside: canvas.ts owns everything under that ref imperatively (ADR-0034 — the canvas is
// deliberately NOT vdom-ified; elk's layout is async and pan/zoom is a 60Hz transform).

import { h, type JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { docSeats, type GateCard, type HeldLine, type ObservedRun, type WaitingLine } from "../store.ts";
import {
  clearCanvas,
  initCanvas,
  updateCanvas,
  type MachineDoc,
  type MachineStateDoc,
  type MachineTransitionDoc,
} from "../canvas.ts";
import type { AppApi, MachineView } from "./app.ts";

export function MachinePane(props: {
  view: MachineView;
  run: ObservedRun | null;
  selectedNodeId: string | null;
  gates: GateCard[];
  waiting: WaitingLine[];
  held: HeldLine[];
  api: AppApi;
}): JSX.Element {
  const { view, run, selectedNodeId, gates, waiting, held, api } = props;
  const canvasRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Mount: hand the refs to the imperative island once. Declared first, so it runs before the
  // update effect below (same commit, declaration order).
  useEffect(() => {
    initCanvas(
      { canvas: canvasRef.current!, svg: svgRef.current! },
      {
        onSelectNode: (nodeId) => api.dispatch({ kind: "selectNode", nodeId }),
        onScale: api.onScale,
      },
    );
    // The canvas outlives every render and there is exactly one pane — no teardown to return.
  }, []);

  // Re-run the imperative render when its inputs move: the doc, the selected run's status (a new
  // object per frame), the node selection, the gate paths. `updateCanvas` re-lays out only when
  // the doc or the instance SET changed; everything else is a highlight pass (canvas.ts). No doc
  // means FORGET the diagram now — frames landing before the next doc arrives must not touch the
  // machine the reader just left.
  const gateKey = gates.map((g) => (g.path ?? []).join("/")).join(",");
  useEffect(() => {
    if (view.doc) updateCanvas(view.doc, run, selectedNodeId, gates);
    else clearCanvas();
  }, [view.doc, run, selectedNodeId, gateKey]);

  return h(
    "section",
    { id: "canvas", ref: canvasRef },
    h("div", { id: "placeholder", hidden: !view.placeholder }, view.placeholder ?? ""),
    h("div", { id: "error", hidden: !view.note, class: view.note?.notice ? "notice" : "" }, view.note?.text ?? ""),
    rootTransitionStrip(view.doc),
    seatsPanel(view.doc),
    waitingStrip(waiting),
    heldStrip(held),
    h("svg", { id: "machine-svg", ref: svgRef }),
  );
}

/** Machine-level transitions ("from any state") as the strip above the Machine — an edge from the
 *  root would lie, because the root has no box (it renders as the page). */
function rootTransitionStrip(doc: MachineDoc | null): JSX.Element {
  const transitions: MachineTransitionDoc[] = doc ? doc.transitions.filter((t) => t.source === doc.root.id) : [];
  const keyOf = new Map<string, string>();
  if (doc) {
    const index = (s: MachineStateDoc): void => {
      keyOf.set(s.id, s.key);
      s.states.forEach(index);
    };
    index(doc.root);
  }
  return h(
    "div",
    { id: "root-transitions" },
    transitions.map((t, i) => {
      const guard = t.guard ? ` [${t.guard}]` : "";
      const target = t.targets.length ? ` → ${t.targets.map((id) => keyOf.get(id) ?? id).join(", ")}` : "";
      return h("span", { key: i }, `on ${t.label}${guard}${target}`);
    }),
  );
}

/** Who may send what, per state, and the load warnings (ADR-0015) — what `jr2 up` prints, for the
 *  Machine and every Machine it composes. Structure, so tokenless too. Folded by default: the
 *  diagram keeps the pane, and a warning shows in the summary so it is not missed folded. */
function seatsPanel(doc: MachineDoc | null): JSX.Element | null {
  const { seats, warnings } = docSeats(doc);
  if (!seats.length && !warnings.length) return null;
  return h(
    "details",
    { id: "seats" },
    h(
      "summary",
      null,
      "who may send what",
      h("span", { class: "dim" }, ` · ${seats.length} seat${seats.length === 1 ? "" : "s"}`),
      warnings.length
        ? h("span", { class: "seats-warned" }, ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`)
        : null,
    ),
    h(
      "ul",
      { class: "seat-list" },
      seats.map((seat) =>
        h(
          "li",
          { key: `${seat.state} ${seat.party} ${seat.agent ?? ""}` },
          h("span", { class: "seat-state" }, seat.state),
          h("span", { class: "dim" }, seat.party === "agent" ? ` agent:${seat.agent}` : " gate"),
          h("span", { class: "seat-names" }, ` ${seat.names.length ? seat.names.join(", ") : "—"}`),
        ),
      ),
    ),
    warnings.length
      ? h(
          "ul",
          { class: "seat-warnings" },
          warnings.map((w) => h("li", { key: w }, w)),
        )
      : null,
  );
}

/** Why the selected run's Workspaces in `placing` wait (ADR-0064), one line each, in the
 *  scheduler's or the quota's own words. The diagram lights `placing` for every viewer; this reason
 *  is guarded, so it is here only with a live token. */
function waitingStrip(waiting: WaitingLine[]): JSX.Element {
  return h(
    "ul",
    { id: "waiting" },
    waiting.map((w) =>
      h(
        "li",
        { key: w.child },
        h(
          "span",
          { class: "waiting-head" },
          `${w.child || "Workspace"} waits for ${w.on === "quota" ? "quota" : "a node"}`,
        ),
        h("span", { class: "dim", title: w.since }, ` since ${new Date(w.since).toLocaleTimeString()}`),
        h("div", { class: "waiting-message" }, w.message),
      ),
    ),
  );
}

/** The selected run's outstanding picks (ADR-0024): the Agent, its pick, and since when it is held.
 *  A held Turn has no default time bound, so this is where a human sees one that waits too long.
 *  Guarded like the waiting strip: here only with a live token. */
function heldStrip(held: HeldLine[]): JSX.Element {
  return h(
    "ul",
    { id: "held" },
    held.map((line) =>
      h(
        "li",
        { key: `${line.agent} ${line.pick}` },
        h("span", { class: "held-head" }, `${line.agent || "Agent"}'s pick ${line.pick} runs`),
        h("span", { class: "dim", title: line.since }, ` held since ${new Date(line.since).toLocaleTimeString()}`),
      ),
    ),
  );
}
