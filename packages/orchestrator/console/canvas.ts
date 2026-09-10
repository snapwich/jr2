// The Machine canvas — the Console's one imperative island (ADR-0034). elk's layout is async and
// pan/zoom is a 60Hz transform; neither wants a vdom, so this module keeps the hand-built SVG
// pipeline: machine doc -> elk graph -> nested <g> boxes, live-highlighted by the selected run,
// gate-pinned (ADR-0032), foldable per child-machine subgraph. A component
// (components/machine-pane.ts) owns the <svg> by ref, hands it over through `initCanvas` once, and
// re-runs `updateCanvas` in an effect; everything below that ref line is direct DOM.
//
// Working state only, never belief: the fold set, the viewport transform, and what is SHOWN live
// here — everything the page believes stays in store.ts and arrives as `updateCanvas` arguments.

import type { GateCard, ObservedRun } from "./store.ts";

// ---- The machine doc, as `GET /workflows/:name/machine` serves it -------------------------------
// Mirrors machine-doc.ts (the server's serializer) the way store.ts mirrors `RunObservation`: the
// Console typechecks as its own DOM project, so the wire shape is restated here rather than
// imported across the Node boundary.

/** One transition of the Machine, id-addressed at both ends — mirrors `MachineTransitionDoc`. */
export type MachineTransitionDoc = {
  source: string;
  /** Target state ids; empty = targetless (self/internal) transition. */
  targets: string[];
  event: string;
  label: string;
  guard?: string;
  kind: "event" | "always" | "after" | "done" | "error";
};

/** One state of the Machine; `states` nests in document order — mirrors `MachineStateDoc`. */
export type MachineStateDoc = {
  id: string;
  /** Relative key — the segment that appears in a run's `status.value`. */
  key: string;
  type: "atomic" | "compound" | "parallel" | "final" | "history";
  initial?: string;
  invoke: Array<{ id: string; src: string }>;
  tags: string[];
  description?: string;
  states: MachineStateDoc[];
  /** The child MACHINES this state runs — see {@link ChildMachineDoc}. */
  children: ChildMachineDoc[];
  opaqueActions?: boolean;
};

/** A child Machine reached from a state. `src` is the JOIN KEY: it matches a live `RunChild.src`
 *  exactly, which is how run state hangs under the right subgraph — mirrors `ChildMachineDoc`. */
export type ChildMachineDoc = {
  src: string;
  label: string;
  via: "invoke" | "spawn";
  /** The child's own structure. Absent iff `recursive`. */
  machine?: MachineBodyDoc;
  recursive?: true;
};

/** One event a Machine declares — its Vocabulary entry (ADR-0011) — mirrors `MachineEventDoc`. */
export type MachineEventDoc = {
  name: string;
  description?: string;
  audience: "agent" | "external" | "any";
  /** The def's input schema as JSON Schema. */
  input: unknown;
};

/** One Machine's structure, independent of what NAMES it — mirrors `MachineBodyDoc`. */
export type MachineBodyDoc = {
  id: string;
  root: MachineStateDoc;
  transitions: MachineTransitionDoc[];
  /** The events THIS Machine declares, and only this one (ADR-0049): a nested Machine's ride its
   *  own body doc, because event names are scoped to the Machine that declared them. */
  events: MachineEventDoc[];
};

/** The serialized structure of a workflow's Machine — mirrors `MachineDoc`. */
export type MachineDoc = MachineBodyDoc & {
  workflow: string;
  /** States whose child list may be incomplete (enqueueActions closures) — surfaced as a notice. */
  opaqueStates?: string[];
};

/** One live child actor as the observation band reports it — `ObservedRun.children`, deepened
 *  (store.ts keeps the field loose; the canvas is the one consumer that walks it). */
export type RunChild = {
  id: string;
  src: string;
  status: string;
  value: unknown;
  children: RunChild[];
};

// ---- elk (window.ELK — the UMD bundle the shell loads before this module) -----------------------

type ElkPoint = { x: number; y: number };
type ElkLabel = { text: string; width?: number; height?: number; x?: number; y?: number };
type ElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  /** Our own annotation, passed through the layout untouched. */
  kind: string;
  labels?: ElkLabel[];
  sections?: Array<{ startPoint: ElkPoint; bendPoints?: ElkPoint[]; endPoint: ElkPoint }>;
};
type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
};
/** A node as the layout returns it — every geometry field filled in. */
type LaidNode = ElkNode & { x: number; y: number; width: number; height: number };

declare const ELK: new () => {
  layout(graph: ElkNode): Promise<ElkNode & { width: number; height: number }>;
};

// ---- The component seam -------------------------------------------------------------------------

/** What the canvas reports OUT: a box click (selection is the store's), and the zoom readout. */
export type CanvasHooks = {
  onSelectNode(nodeId: string): void;
  onScale(pct: number): void;
};

// Set once by `initCanvas`, before anything below can run — the owning component mounts first.
let canvasEl: HTMLElement;
let svg: SVGSVGElement;
let hooks: CanvasHooks;

/** Take ownership of the mounted elements and wire the direct navigation. Called once, on mount. */
export function initCanvas(els: { canvas: HTMLElement; svg: SVGSVGElement }, canvasHooks: CanvasHooks): void {
  canvasEl = els.canvas;
  svg = els.svg;
  hooks = canvasHooks;
  wireCanvasNavigation();
  addEventListener("resize", () => {
    if (fitting) fitToWidth();
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (parent) parent.appendChild(el);
  return el;
}

// ---- Sizing (monospace estimate; generous so labels never clip) --------------------------------

const CHAR_W = 7.5;
const ROW_H = 16;
const textW = (s: string): number => s.length * CHAR_W;

/** A display row inside a state box. */
type Row = { text: string; cls: string };

/** A guard's suffix. An anonymous guard has no name to show (the doc reports it as "inline"), and
 * nine characters of nothing is real width — an edge label's width is layer spacing. Mark it. */
const guardSuffix = (guard: string | undefined): string => (guard ? (guard === "inline" ? " [?]" : ` [${guard}]`) : "");

/** An invoke's display name. A `src` is the JOIN KEY, not a name: an anonymous actor gets xstate's
 * generated key (`xstate.invoke.0.wrapper.running`), which names the STATE — which is the box the
 * row is already sitting in. Only a setup() actor has a name of its own, which since ADR-0049 is
 * every actor j2's own wrappers run (`provision`, `body`, `lease`, `worker`, …). */
const actorName = (src: string): string => (src.startsWith("xstate.invoke.") ? "inline" : src);

/** The display rows inside a state box: invokes, targetless self-transitions, tags. A child MACHINE
 * renders as a nested subgraph, so its invoke row would only say the same thing twice. */
function stateRows(state: MachineStateDoc, selfTransitions: MachineTransitionDoc[]): Row[] {
  const nested = new Set(state.children.map((c) => c.src));
  const rows: Row[] = [];
  for (const inv of state.invoke) {
    if (!nested.has(inv.src)) rows.push({ text: `⚙ ${actorName(inv.src)}`, cls: "state-row--invoke" });
  }
  for (const t of selfTransitions) {
    rows.push({ text: `↺ ${t.label}${guardSuffix(t.guard)}`, cls: "state-row--self" });
  }
  if (state.tags.length) {
    rows.push({ text: state.tags.map((t) => `#${t}`).join(" "), cls: "state-row--tags" });
  }
  return rows;
}

// ---- Machine doc -> elk input -------------------------------------------------------------------
//
// SCOPES. A node's elk (and SVG) id is `${scope}${state.id}`. The root machine's scope is "", and
// every child-machine subgraph opens a new one. That is the whole trick behind rendering the same
// child machine several times over: with three features in flight, `featureWorkspace` appears three
// times, under scopes "F-1/", "F-2/", "F-3/", and each copy highlights from its OWN snapshot.
//
// A child machine with nothing running gets ONE subgraph under a "~src/" scope, dimmed — the
// structure is the point, and it is exactly as true with no run as with three.
//
// The machine doc says which state runs which `src`; the run's `RunChild` tree says which instances
// exist. They meet on `src` and nowhere else.

/** Which subgraph scopes the reader has folded shut (a wide fan-out gets unreadable fast). */
const collapsed = new Set<string>();

/** What the renderer knows about one elk node beyond its geometry. */
type NodeMeta = {
  state?: MachineStateDoc;
  child?: { label: string; template: boolean; scope?: string };
  rows: Row[];
};

function buildElkGraph(doc: MachineBodyDoc, live: RunChild[]): { meta: Map<string, NodeMeta>; graph: ElkNode } {
  const meta = new Map<string, NodeMeta>();
  const edges: ElkEdge[] = [];

  /** One machine level: the boxes for its root's states, and its own transitions as edges. */
  const machineChildren = (body: MachineBodyDoc, scope: string, instances: RunChild[]): ElkNode[] => {
    const nodes = body.root.states.map((state) => toElkNode(state, scope, body, instances));
    if (body.root.initial) nodes.push(initialDot(body.root, scope));
    body.transitions.forEach((t, i) => {
      // Machine-level transitions (source = the root, which has no box) fire from ANY state, so an
      // edge would lie. At the root they render as a strip above the Machine; in a child, as rows.
      if (t.source === body.root.id) return;
      t.targets.forEach((target, j) => {
        const label = `${t.label}${guardSuffix(t.guard)}`;
        edges.push({
          id: `${scope}t${i}.${j}`,
          sources: [scope + t.source],
          targets: [scope + target],
          kind: t.kind,
          labels: [{ text: label, width: textW(label) + 4, height: 14 }],
        });
      });
    });
    return nodes;
  };

  const initialDot = (node: MachineStateDoc, scope: string): ElkNode => {
    edges.push({
      id: `${scope}${node.id}::initial-edge`,
      sources: [`${scope}${node.id}::initial`],
      targets: [scope + node.initial!],
      kind: "initial",
    });
    return { id: `${scope}${node.id}::initial`, width: 12, height: 12 };
  };

  /** A container box: header rows on top, laid-out children below.
   *
   * `nodeSize.minimum` is honoured for a LEAF but not for a compound node — elk sizes those from
   * their children, so a box can come back narrower than its own header asked for. The renderer
   * clips the text to the box it lands in ({@link fitText}) rather than let it hang over the edge. */
  const container = (id: string, title: string, rows: Row[], children: ElkNode[]): ElkNode => {
    const headerW = Math.max(textW(title) + 28, ...rows.map((r) => textW(r.text) + 28), 76);
    const headerH = 26 + rows.length * ROW_H;
    if (!children.length) return { id, width: headerW, height: Math.max(headerH + 10, 40) };
    return {
      id,
      children,
      layoutOptions: {
        "elk.padding": `[top=${headerH + 8},left=16,bottom=16,right=16]`,
        "elk.spacing.nodeNode": "26",
        "elk.layered.spacing.nodeNodeBetweenLayers": "48",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${headerW},${headerH + 24})`,
      },
    };
  };

  /** The subgraphs for one child machine: one per live instance, or a lone template when none. */
  const childMachineNodes = (cm: ChildMachineDoc, scope: string, live: RunChild[]): ElkNode[] => {
    if (!cm.machine) {
      // Recursive: the body is an ancestor of this point, so it is already on screen above.
      const id = `${scope}~${cm.src}`;
      meta.set(id, { child: { label: `▣ ${cm.label} ⟲ recursive`, template: true }, rows: [] });
      return [container(id, `▣ ${cm.label} ⟲ recursive`, [], [])];
    }
    const instances = live.filter((c) => c.src === cm.src);
    if (!instances.length) return [childMachineNode(cm, `~${cm.src}/`, scope, null)];
    const nodes = instances.map((inst) => childMachineNode(cm, `${inst.id}/`, scope, inst));
    // Instances of one child machine have no edges between them, and edgeless peers land in the
    // SAME layer — which a DOWN layout spreads across the width. Six features would be six columns.
    // A layout-only edge (never drawn) puts each instance in the layer below the last, so fan-out
    // grows the axis the page scrolls and the diagram's width does not depend on how many are live.
    for (let i = 1; i < nodes.length; i++) {
      edges.push({
        id: `${scope}~stack.${cm.src}.${i}`,
        sources: [nodes[i - 1]!.id],
        targets: [nodes[i]!.id],
        kind: "stack",
      });
    }
    return nodes;
  };

  const childMachineNode = (
    cm: ChildMachineDoc,
    segment: string,
    parentScope: string,
    inst: RunChild | null,
  ): ElkNode => {
    const scope = parentScope + segment;
    const body = cm.machine!;
    const id = scope + body.root.id;
    // An INVOKED child's spawn id is its invoke id, so naming the instance would just stutter
    // ("body · body"). A SPAWNED one's id is the workflow's own label for the work ("F-1").
    const named = inst && inst.id !== cm.label;
    const title = `▣ ${cm.label}${named ? ` · ${inst.id}` : ""}`;

    const rows: Row[] = [];
    if (!inst) rows.push({ text: "no live instances", cls: "state-row--dim" });
    if (inst && inst.status !== "active") rows.push({ text: inst.status, cls: "state-row--tags" });
    if (cm.via === "spawn") rows.push({ text: "spawned — outlives this state", cls: "state-row--dim" });
    for (const t of body.transitions) {
      if (t.source === body.root.id) rows.push({ text: `↺ ${t.label}`, cls: "state-row--self" });
    }

    meta.set(id, { child: { label: title, template: !inst, scope }, rows });
    const folded = collapsed.has(scope);
    return container(id, title, rows, folded ? [] : machineChildren(body, scope, inst?.children ?? []));
  };

  const toElkNode = (state: MachineStateDoc, scope: string, body: MachineBodyDoc, live: RunChild[]): ElkNode => {
    const selfT = body.transitions.filter((t) => t.source === state.id && t.targets.length === 0);
    const rows = stateRows(state, selfT);
    meta.set(scope + state.id, { state, rows });

    const children = state.states.map((child) => toElkNode(child, scope, body, live));
    if (state.initial) children.push(initialDot(state, scope));
    // The state that RUNS a child machine is the state that CONTAINS it. `discover` is atomic and
    // still grows a subgraph per feature it spawned — that is the point of the diagram.
    for (const cm of state.children) children.push(...childMachineNodes(cm, scope, live));

    const title = state.type === "history" ? `⟲ ${state.key}` : state.key;
    return container(scope + state.id, title, rows, children);
  };

  // The root machine has no box of its own — it renders as the page. Its states are the top level.
  const rootChildren = machineChildren(doc, "", live);
  meta.set(doc.root.id, { state: doc.root, rows: [] });

  return {
    meta,
    graph: {
      id: "::root",
      layoutOptions: {
        "elk.algorithm": "layered",
        // DOWN, because a Machine's chains are its long axis and nesting stacks them: `discover` ⊃
        // `featureWorkspace` ⊃ `running` ⊃ `body` ⊃ its whole pipeline, all pointing one way under
        // INCLUDE_CHILDREN's single layering. RIGHT spent that on width (7000px for `coding`, in a
        // 950px-tall page); DOWN spends it on the axis a browser scrolls.
        "elk.direction": "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        // Report every edge's coordinates root-relative; the default (CONTAINER) is relative to the
        // edge's deepest common ancestor, which the flat edge pass below doesn't track.
        "elk.json.edgeCoords": "ROOT",
        "elk.spacing.nodeNode": "30",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.spacing.edgeLabel": "4",
        "elk.edgeLabels.placement": "CENTER",
      },
      children: rootChildren,
      edges,
    },
  };
}

// ---- Layouted elk graph -> SVG ------------------------------------------------------------------

const stateEls = new Map<string, SVGGElement>(); // elk node id (scope + state id) -> <g>

/** Write text into a box, cut to the width the box actually got (elk sizes a compound node from its
 * children, so the header it asked for is not always the header it gets). The whole string stays
 * reachable on hover. */
function fitText(el: SVGTextElement, text: string, boxWidth: number): void {
  const max = Math.max(3, Math.floor((boxWidth - 20) / CHAR_W));
  el.textContent = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  if (text.length > max) svgEl("title", {}, el).textContent = text;
}

/** The header + rows shared by a state box and a child-machine subgraph. Clicking any box selects
 *  it — outline only, one node at a time, the behavior itself RESERVED (brief: nothing else hangs
 *  off it yet). `stopPropagation`, or a click on a leaf would select its every ancestor in turn and
 *  the deepest dispatch would win by accident rather than by choice. */
function renderBox(node: LaidNode, title: string, rows: Row[], parent: SVGElement, cls: string): SVGGElement {
  const g = svgEl("g", { class: cls, transform: `translate(${node.x},${node.y})` }, parent);
  stateEls.set(node.id, g);
  svgEl("rect", { width: node.width, height: node.height, rx: 6 }, g);
  fitText(svgEl("text", { class: "state-title", x: 12, y: 18 }, g), title, node.width);
  rows.forEach((row, i) => {
    const r = svgEl("text", { class: `state-row ${row.cls}`, x: 12, y: 18 + (i + 1) * ROW_H }, g);
    fitText(r, row.text, node.width);
  });
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.onSelectNode(node.id);
  });
  return g;
}

function renderState(node: LaidNode, meta: Map<string, NodeMeta>, parent: SVGElement): void {
  if (node.id.endsWith("::initial")) {
    const g = svgEl("g", { transform: `translate(${node.x},${node.y})` }, parent);
    svgEl("circle", { class: "initial-dot", cx: 6, cy: 6, r: 5.5 }, g);
    return;
  }
  const { state, child, rows } = meta.get(node.id)!;

  // A child machine: its own subgraph, one per live instance (or a dimmed template). The ⊞/⊟ icon
  // in its top-right corner folds it — a `maxConcurrent` of 6 is six copies of the same diagram
  // otherwise. The icon and NOT the box: the box body is the click-to-select surface like any other
  // node's, and a reader inspecting a subgraph must not collapse it under their own cursor.
  if (child) {
    const cls = `state child-machine${child.template ? " child-machine--template" : ""}${
      child.scope && collapsed.has(child.scope) ? " child-machine--collapsed" : ""
    }`;
    const g = renderBox(node, child.label, rows, parent, cls);
    for (const c of (node.children ?? []) as LaidNode[]) renderState(c, meta, g);
    if (child.scope) renderFoldIcon(g, node, child.scope);
    return;
  }

  const title = state!.type === "history" ? `⟲ ${state!.key}` : state!.key;
  const g = renderBox(node, title, rows, parent, `state state--${state!.type}`);
  if (state!.type === "final") {
    svgEl("rect", { class: "final-inner", x: 3, y: 3, rx: 4, width: node.width - 6, height: node.height - 6 }, g);
  }
  for (const c of (node.children ?? []) as LaidNode[]) renderState(c, meta, g);
}

/** How much of a child-machine box's top-right corner the fold icon owns (the gate pin yields). */
const FOLD_ICON_W = 26;

/** The ⊞/⊟ fold control in a child-machine box's top-right corner. Appended after the subgraph's
 *  children so nothing paints over it; `stopPropagation`, or folding would also select the box. */
function renderFoldIcon(g: SVGGElement, node: LaidNode, scope: string): void {
  const folded = collapsed.has(scope);
  const icon = svgEl("g", { class: "fold-icon", transform: `translate(${node.width - 21},5)` }, g);
  svgEl("rect", { width: 16, height: 16, rx: 3 }, icon);
  const glyph = svgEl("text", { x: 8, y: 12.5, "text-anchor": "middle" }, icon);
  glyph.textContent = folded ? "⊞" : "⊟";
  svgEl("title", {}, icon).textContent = folded ? "unfold this child machine" : "fold this child machine";
  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    folded ? collapsed.delete(scope) : collapsed.add(scope);
    void refresh();
  });
}

function renderEdges(layout: ElkNode, parent: SVGElement): void {
  for (const edge of layout.edges ?? []) {
    if (edge.kind === "stack") continue; // layout-only: it stacks sibling instances, it is not a transition
    const kind = edge.kind ?? "event";
    const g = svgEl("g", { class: `edge edge--${kind}` }, parent);
    for (const s of edge.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      svgEl("path", { d, "marker-end": `url(#arrow-${kind})` }, g);
    }
    for (const label of edge.labels ?? []) {
      const t = svgEl("text", { class: "edge-label", x: label.x ?? 0, y: (label.y ?? 0) + 11 }, g);
      t.textContent = label.text;
    }
  }
}

function renderArrowDefs(target: SVGSVGElement): void {
  const defs = svgEl("defs", {}, target);
  for (const kind of ["event", "always", "after", "done", "error", "initial"]) {
    const m = svgEl(
      "marker",
      {
        id: `arrow-${kind}`,
        class: `arrow--${kind}`,
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
      },
      defs,
    );
    svgEl("path", { d: "M0,0 L10,5 L0,10 z" }, m);
  }
}

let layoutSize = { width: 0, height: 0 };
/** The viewport: the diagram draws `scale`d with its origin at (panX, panY), as one transform on
 * the root <g> the renderer mounts. A TRANSFORM, not a scroll container — scrolling cannot move a
 * diagram that happens to fit its pane, and a diagram pane must pan regardless. */
let scale = 1;
let panX = 0;
let panY = 0;
/** Fit the Machine's width to the canvas, and keep fitting it as the diagram grows — until the
 * reader takes the view into their own hands, after which it is theirs. */
let fitting = true;
/** The <g> the current render mounted — the transform target; each re-render swaps it in and
 * re-applies the view, so a relayout never resets where the reader was looking. */
let viewportG: SVGGElement | undefined;

/** Breathing room a fresh fit leaves around the diagram. */
const FIT_PAD = 28;

function applyView(): void {
  viewportG?.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
  hooks.onScale(Math.round(scale * 100)); // the nav readout follows every path
}

/** Scale so the whole width lands in the pane, centered. Never magnifies — a small Machine stays
 * 1:1. */
function fitToWidth(): void {
  if (!layoutSize.width || svg.clientWidth <= 0) return applyView();
  scale = Math.min(1, Math.max(0.2, (svg.clientWidth - FIT_PAD * 2) / layoutSize.width));
  panX = Math.max(FIT_PAD, (svg.clientWidth - layoutSize.width * scale) / 2);
  panY = FIT_PAD;
  applyView();
}

/** Re-scale about an anchor (svg px; the pane's center when none, for the nav buttons): the
 * diagram point under the anchor stays under it. */
function setScale(next: number, anchor?: { x: number; y: number }): void {
  fitting = false;
  const a = anchor ?? { x: svg.clientWidth / 2, y: svg.clientHeight / 2 };
  const clamped = Math.min(4, Math.max(0.25, next));
  panX = a.x - ((a.x - panX) / scale) * clamped;
  panY = a.y - ((a.y - panY) / scale) * clamped;
  scale = clamped;
  applyView();
}

// The nav's zoom controls — thin verbs over the viewport, exported for the components.
export function zoomIn(): void {
  setScale(scale * 1.2);
}
export function zoomOut(): void {
  setScale(scale / 1.2);
}
export function zoomReset(): void {
  setScale(1);
}
export function zoomFit(): void {
  fitting = true;
  fitToWidth();
}

// ---- Direct navigation: drag pans, wheel zooms --------------------------------------------------
//
// Both are writes to the viewport transform above. View state like the zoom buttons — none of it
// is belief, none reaches the store.

/** How far a pressed pointer may wander and still be a click on a node, not a pan. */
const PAN_NUDGE_PX = 4;

/** Set when a pan just ended: the browser fires a click at the release point, and that click must
 * not select (or fold) whatever box the drag happened to end on. Cleared by the very next click or
 * press, so a pan that ends off-window cannot eat an unrelated later click. */
let squelchClick = false;

function wireCanvasNavigation(): void {
  addEventListener(
    "click",
    (e) => {
      if (!squelchClick) return;
      squelchClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  canvasEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault(); // the wheel zooms here; travel is the drag's job
      const perLine = e.deltaMode === 1 ? 16 : 1; // Firefox reports lines, not pixels
      const rect = svg.getBoundingClientRect();
      setScale(scale * Math.exp(-e.deltaY * perLine * 0.0015), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    { passive: false },
  );

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    squelchClick = false;
    const from = { x: e.clientX, y: e.clientY, panX, panY };
    let panned = false;
    const move = (ev: PointerEvent): void => {
      if (!panned && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < PAN_NUDGE_PX) return;
      if (!panned) {
        panned = true;
        fitting = false; // the reader took the view into their own hands
        canvasEl.classList.add("panning");
        canvasEl.setPointerCapture(e.pointerId);
      }
      panX = from.panX + (ev.clientX - from.x);
      panY = from.panY + (ev.clientY - from.y);
      applyView();
    };
    const up = (): void => {
      canvasEl.removeEventListener("pointermove", move);
      canvasEl.removeEventListener("pointerup", up);
      canvasEl.removeEventListener("pointercancel", up);
      canvasEl.classList.remove("panning");
      squelchClick = panned;
    };
    canvasEl.addEventListener("pointermove", move);
    canvasEl.addEventListener("pointerup", up);
    canvasEl.addEventListener("pointercancel", up);
  });
}

async function renderMachine(doc: MachineBodyDoc, live: RunChild[]): Promise<void> {
  const { graph, meta } = buildElkGraph(doc, live);
  const layout = await new ELK().layout(graph);
  // The selection may have moved while elk worked (`clearCanvas` ran, or a newer doc landed):
  // painting now would put the machine the reader LEFT into the pane they arrived at. Bail before
  // touching the svg — whatever should be there has its own refresh queued behind this one.
  if (shown.doc !== doc) return;
  svg.textContent = "";
  layoutSize = { width: layout.width + 4, height: layout.height + 4 };
  renderArrowDefs(svg);
  const rootG = svgEl("g", {}, svg);
  stateEls.clear();
  stateEls.set(doc.root.id, rootG);
  for (const child of (layout.children ?? []) as LaidNode[]) renderState(child, meta, rootG);
  // INCLUDE_CHILDREN reports every edge's coordinates relative to the root — draw them all here,
  // never inside a state group.
  renderEdges(layout, rootG);
  // The fresh <g> becomes the viewport, wearing the view the reader already had (or a fit).
  viewportG = rootG;
  fitting ? fitToWidth() : applyView();
}

// ---- Live runs ----------------------------------------------------------------------------------

/**
 * Every elk id a run currently has lit: the root machine's active states, and each live child
 * instance's, inside that instance's own scope.
 *
 * Two walks, because they answer different questions. The VALUE walk descends the state tree by key
 * and lights what is active. The INSTANCE walk visits every state, active or not, because a spawned
 * child outlives the state that spawned it — `coding` is parked in `settling` while three
 * `featureWorkspace`s it spawned back in `discover` are still going.
 */
function activeIds(
  body: MachineBodyDoc,
  value: unknown,
  scope: string,
  live: RunChild[],
  ids = new Set<string>(),
): Set<string> {
  ids.add(scope + body.root.id);

  const byValue = (state: MachineStateDoc, v: unknown): void => {
    if (v == null) return;
    const keys = typeof v === "string" ? [v] : Object.keys(v);
    for (const key of keys) {
      const child = state.states.find((s) => s.key === key);
      if (!child) continue;
      ids.add(scope + child.id);
      if (typeof v !== "string") byValue(child, (v as Record<string, unknown>)[key]);
    }
  };
  byValue(body.root, value);

  const byInstance = (state: MachineStateDoc): void => {
    for (const cm of state.children) {
      if (!cm.machine) continue;
      for (const inst of live.filter((c) => c.src === cm.src)) {
        activeIds(cm.machine, inst.value, `${scope}${inst.id}/`, inst.children, ids);
      }
    }
    state.states.forEach(byInstance);
  };
  byInstance(body.root);

  return ids;
}

// ---- The gate pin (ADR-0032) --------------------------------------------------------------------
// `GateView.path` is the invoking state's actor path below the run root (registration.ts's
// `actorPath`, carried precisely so no caller ever parses a gate ID): every segment but the last is
// a child-machine actor id — the SAME ids the renderer mints its scopes from — and the last is the
// gate's own invoke id, which `deriveMenus` names with the invoking state's key path ("waiting.
// approval"). So the path resolves against the same two structures the diagram is drawn from, the
// machine doc and the live child tree, and lands on an elk node id with no third vocabulary.

/** The elk node id `path` names, or null when it does not resolve (an authored invoke id, a
 *  recursive child's elided body, an instance the run no longer has). Resolution is BEST-EFFORT by
 *  design: the leaf descends the state tree key by key and pins the deepest match, so a
 *  disambiguating ordinal suffix (two unnamed gates in one state) still finds its state, and a leaf
 *  that matches nothing still pins the child-machine box whose scope the earlier segments reached. */
function gateNodeId(doc: MachineBodyDoc, live: RunChild[], path: string[]): string | null {
  if (!path.length) return null;
  let body = doc;
  let scope = "";
  let children = live;
  for (const seg of path.slice(0, -1)) {
    const inst = children.find((c) => c.id === seg);
    if (!inst) return null;
    const cm = findChildMachine(body.root, inst.src);
    if (!cm?.machine) return null;
    scope += `${inst.id}/`;
    body = cm.machine;
    children = inst.children;
  }
  let node = body.root;
  for (const key of path[path.length - 1]!.split(".")) {
    const child = node.states.find((s) => s.key === key);
    if (!child) break;
    node = child;
  }
  // A machine root: in a child scope that is the subgraph's own box; at the run root there is no
  // box to pin (the root machine renders as the page).
  return node === body.root && !scope ? null : scope + node.id;
}

/** The `ChildMachineDoc` running `src`, anywhere under `state` — the doc side of the join key. */
function findChildMachine(state: MachineStateDoc, src: string): ChildMachineDoc | null {
  for (const cm of state.children) if (cm.src === src) return cm;
  for (const child of state.states) {
    const hit = findChildMachine(child, src);
    if (hit) return hit;
  }
  return null;
}

/** The deepest RENDERED box for a node id — the id itself, or (when its subgraph is folded shut)
 *  the ancestor the key-path spells, stripped a ".key" at a time down to the subgraph's own box.
 *  The pin surfaces on whatever the fold left visible instead of vanishing with the fold. */
function nearestRendered(id: string | null): string | null {
  let cur = id ?? "";
  while (cur && !stateEls.has(cur)) {
    const dot = cur.lastIndexOf(".");
    if (dot <= cur.lastIndexOf("/")) return null;
    cur = cur.slice(0, dot);
  }
  return cur || null;
}

/** Put the ⚑ on a box, or take it off. The glyph is managed here and not in `renderBox` because it
 *  outlives no re-layout but must move on every `gates` frame — a class plus a lazily-added element
 *  keeps pin churn out of the layout path entirely. */
function setGatePin(g: SVGGElement, on: boolean): void {
  const pin = g.querySelector(":scope > .gate-pin");
  g.classList.toggle("gated", on);
  if (!on) return pin?.remove();
  if (pin) return;
  const rect = g.querySelector(":scope > rect");
  if (!rect) return;
  const x = Number(rect.getAttribute("width")) - (g.classList.contains("child-machine") ? FOLD_ICON_W + 8 : 8);
  const t = svgEl("text", { class: "gate-pin", x, y: 18, "text-anchor": "end" }, g);
  t.textContent = "⚑";
  svgEl("title", {}, t).textContent = "open gate — this run is waiting for external input here";
}

function highlight(): void {
  if (!shown.doc) return;
  const active = activeIds(shown.doc, shown.status?.value, "", shown.live);
  // The pins are a VIEW over the store (selected run × its inbox card), recomputed whole on every
  // pass — a `gates` frame re-runs `updateCanvas`, so a delivered gate's pin leaves with its card.
  const pinned = new Set<string>();
  for (const view of shown.gates) {
    const target = nearestRendered(gateNodeId(shown.doc, shown.live, view.path ?? []));
    if (target) pinned.add(target);
  }
  for (const [id, el] of stateEls) {
    el.classList.toggle("active", active.has(id));
    el.classList.toggle("selected", id === shown.selectedNodeId);
    setGatePin(el, pinned.has(id));
  }
}

/** The identity of the live child TREE — which instances of what, not where they are. Layout hangs
 * on this and nothing else, so a transition inside a child is a class toggle, never a re-layout. */
function instanceKey(children: RunChild[]): string {
  return children.map((c) => `${c.src}#${c.id}(${instanceKey(c.children)})`).join(",");
}

/** What the canvas has painted (or queued): the render pipeline's working state, updated as one
 *  value so a fold's `refresh` re-runs against exactly what the last `updateCanvas` was handed. */
type Shown = {
  doc: MachineDoc | null;
  live: RunChild[];
  key: string | null;
  status: ObservedRun | null;
  selectedNodeId: string | null;
  gates: GateCard[];
};
let shown: Shown = { doc: null, live: [], key: null, status: null, selectedNodeId: null, gates: [] };
let queue: Promise<void> = Promise.resolve(); // serializes re-layouts against a burst of status frames

/** Re-lay out the Machine, then restore the highlight the new boxes should be wearing. */
function refresh(): Promise<void> {
  queue = queue
    .then(async () => {
      if (!shown.doc) return; // cleared while queued — nothing left to lay out
      await renderMachine(shown.doc, shown.live);
      highlight();
    })
    // The chain must settle fulfilled: every later refresh() chains onto `queue`, so one rejected
    // link would silently kill re-layout until reload.
    .catch((err: unknown) => console.error("machine layout failed", err));
  return queue;
}

/**
 * The component's effect lands here on every input move: re-lay out only if the DOC or the
 * instance SET changed (a spawn or a stop); everything else — a transition, a node selection, a
 * `gates` frame — is a highlight pass over the boxes already on screen.
 */
export function updateCanvas(
  doc: MachineDoc,
  status: ObservedRun | null,
  selectedNodeId: string | null,
  gates: GateCard[],
): void {
  const live = (status?.children ?? []) as RunChild[];
  const key = instanceKey(live);
  const relayout = doc !== shown.doc || key !== shown.key;
  shown = { doc, live, key, status, selectedNodeId, gates };
  if (relayout) void refresh();
  else highlight();
}

/** Forget the diagram NOW (the selection moved): frames landing before the next doc is in hand
 *  must not re-layout — or highlight — the machine the reader just left. */
export function clearCanvas(): void {
  shown = { doc: null, live: [], key: null, status: null, selectedNodeId: null, gates: [] };
  stateEls.clear();
  viewportG = undefined;
  svg.textContent = "";
}
