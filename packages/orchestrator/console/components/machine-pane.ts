// The center pane: the selected workflow's Machine. The vdom renders the pane's chrome — the
// placeholder, the error/notice, the root-transition strip — and mounts one <svg> it then never
// looks inside: canvas.ts owns everything under that ref imperatively (ADR-0034 — the canvas is
// deliberately NOT vdom-ified; elk's layout is async and pan/zoom is a 60Hz transform).

import { h, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  dispatchStrip,
  dispatchedStrip as dispatchedStripText,
  docSeats,
  type GateCard,
  type HeldLine,
  type ObservedRun,
  type WaitingLine,
} from "../store.ts";
import {
  clearCanvas,
  initCanvas,
  updateCanvas,
  type MachineDoc,
  type MachineStateDoc,
  type MachineTransitionDoc,
} from "../canvas.ts";
import type { AgentLine, AppApi, MachineView } from "./app.ts";

export function MachinePane(props: {
  view: MachineView;
  run: ObservedRun | null;
  selectedNodeId: string | null;
  gates: GateCard[];
  waiting: WaitingLine[];
  held: HeldLine[];
  failure: string | null;
  /** Who started the selected run (ADR-0078), as one line; null when the page does not know it. */
  starter: string | null;
  /** The page's Caller may cancel the selected run, and it is live (ADR-0032). */
  canCancel: boolean;
  /** The page's Caller may steer the selected run's Agents, and it is live (ADR-0032). */
  canSteer: boolean;
  api: AppApi;
}): JSX.Element {
  const { view, run, selectedNodeId, gates, waiting, held, failure, starter, canCancel, canSteer, api } = props;
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
    dispatchedStrip(run),
    startedStrip(run),
    starterStrip(starter),
    run && (canCancel || canSteer)
      ? h(RunControls, { key: run.runId, runId: run.runId, canCancel, canSteer, api })
      : null,
    rootTransitionStrip(view.doc),
    seatsPanel(view.doc),
    failureStrip(failure),
    waitingStrip(waiting),
    heldStrip(held),
    h("svg", { id: "machine-svg", ref: svgRef }),
  );
}

/** Who dispatched the selected run (ADR-0071): its caller's run, slot and the chain's depth. Read
 *  off the open observation the pane already holds, so it shows for every viewer, with no fetch. */
function dispatchedStrip(run: ObservedRun | null): JSX.Element | null {
  const text = dispatchStrip(run);
  if (!text) return null;
  return h(
    "div",
    { id: "dispatched-by", class: "dim", style: { margin: "28px 28px 0", fontFamily: "var(--mono)" } },
    text,
  );
}

/** The runs the selected run dispatched (ADR-0071): the chain's other direction, off the same
 *  open observation, with no fetch. */
function startedStrip(run: ObservedRun | null): JSX.Element | null {
  const text = dispatchedStripText(run);
  if (!text) return null;
  return h("div", { id: "dispatched", class: "dim", style: { margin: "8px 28px 0", fontFamily: "var(--mono)" } }, text);
}

/** Who started the selected run (ADR-0078): a Caller, a run through a `dispatch`, or jr2. On the
 *  run's guarded status, so here only for a Caller with `read`. */
function starterStrip(text: string | null): JSX.Element | null {
  if (!text) return null;
  return h("div", { id: "started-by", class: "dim", style: { margin: "8px 28px 0", fontFamily: "var(--mono)" } }, text);
}

/**
 * The controls on the selected live run, each where the Caller's scopes open it (ADR-0032): cancel
 * with `cancel`, the Steering box with `steer` (ADR-0002). Keyed by run, so a new selection starts
 * clean. The Steering box reads the run's conversation list when it opens, so it offers only the
 * Agent slots the run has; a slot that is not steerable is shown and cannot be chosen. What the
 * person types is theirs (uncontrolled), and a refusal shows where they typed, as the forms do.
 */
function RunControls(props: { runId: string; canCancel: boolean; canSteer: boolean; api: AppApi }): JSX.Element {
  const { runId, canCancel, canSteer, api } = props;
  const [note, setNote] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentLine[] | null>(null);
  const [steering, setSteering] = useState(false);
  const [busy, setBusy] = useState(false);

  const cancel = (): void => {
    if (!confirm(`Cancel run ${runId.slice(0, 8)}?`)) return;
    setBusy(true);
    setNote(null);
    void api.cancelRun(runId).then((failure) => {
      setBusy(false);
      setNote(failure ? `cancel refused: ${failure}` : null);
    });
  };

  const openSteering = (): void => {
    if (steering) return setSteering(false);
    setSteering(true);
    setNote(null);
    void api.steerTargets(runId).then((answer) => {
      if (typeof answer === "string") setNote(`no conversation list: ${answer}`);
      else setAgents(answer);
    });
  };

  const send = (e: Event): void => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const agent = (form.elements.namedItem("agent") as HTMLSelectElement | null)?.value ?? "";
    const text = (form.elements.namedItem("text") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    if (!agent || !text) return setNote("choose an Agent and write the message");
    setBusy(true);
    setNote(null);
    void api.steer(runId, agent, text).then((failure) => {
      setBusy(false);
      if (failure) return setNote(`not sent: ${failure}`);
      (form.elements.namedItem("text") as HTMLTextAreaElement).value = "";
      setNote(`sent to ${agent}: it reads the message at its next step`);
    });
  };

  return h(
    "div",
    { id: "run-controls", style: { margin: "8px 28px 0", maxWidth: "720px" } },
    canCancel ? h("button", { id: "cancel-run", disabled: busy, onClick: cancel }, "cancel run") : null,
    canSteer
      ? h(
          "button",
          { id: "steer-open", onClick: openSteering, style: { marginLeft: canCancel ? "8px" : "0" } },
          "steer",
        )
      : null,
    canSteer && steering
      ? h(
          "form",
          { id: "steering-box", class: "schema-form", onSubmit: send },
          agents === null
            ? h("div", { class: "dim" }, "reading the run's Agents…")
            : agents.length === 0
              ? h("div", { class: "dim" }, "this run has no Agent slot")
              : h(
                  "label",
                  null,
                  h("span", null, "agent"),
                  h(
                    "select",
                    { name: "agent" },
                    agents.map((a) =>
                      h(
                        "option",
                        { key: a.agent, value: a.agent, disabled: !a.steerable },
                        `${a.agent}${a.open ? " · in a Turn" : ""}${a.steerable ? "" : " · not steerable"}`,
                      ),
                    ),
                  ),
                ),
          h("label", null, h("span", null, "message"), h("textarea", { name: "text", rows: 3 })),
          h("button", { type: "submit", disabled: busy || !agents?.length }, "send"),
        )
      : null,
    h(
      "div",
      { id: "run-controls-note", class: note?.startsWith("sent to ") ? "dim" : "form-error", hidden: note === null },
      note ?? "",
    ),
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

/** Why the selected run failed (ADR-0073): the reason that the Machine gave to `fail`, as `jr2 status`
 *  prints it. The rail colors a `failed` run for every viewer; the reason is in the run's output,
 *  which is guarded, so it is here only with a live token. */
function failureStrip(failure: string | null): JSX.Element {
  return h("div", { id: "failure", hidden: failure === null }, failure === null ? "" : `failed: ${failure}`);
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
