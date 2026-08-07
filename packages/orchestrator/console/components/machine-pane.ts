// The center pane: the selected workflow's Machine. The vdom renders the pane's chrome — the
// placeholder, the error/notice, the root-transition strip — and mounts one <svg> it then never
// looks inside: canvas.ts owns everything under that ref imperatively (ADR-0034 — the canvas is
// deliberately NOT vdom-ified; elk's layout is async and pan/zoom is a 60Hz transform).

import { h, type JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { GateCard, ObservedRun } from "../store.ts";
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
  api: AppApi;
}): JSX.Element {
  const { view, run, selectedNodeId, gates, api } = props;
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
