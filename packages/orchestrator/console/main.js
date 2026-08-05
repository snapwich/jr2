// The j2 Console — one shell, master–detail (ADR-0032). The left rail is the FLEET (every
// registered workflow, each expandable to its runs); the center is the selected workflow's Machine,
// fetched from GET /workflows/:name/machine, laid out with elkjs (loaded as a UMD script ->
// window.ELK), rendered as nested SVG and live-highlighted by the selected run; the right drawer is
// Attention (the gate inbox) and Activity (the emit log).
//
// The ADDRESS carries the selection: `/` and `/workflows/:name` serve these same bytes, the path
// says which workflow is selected, pushState moves it on click and popstate restores it. ONE
// EventSource, ever, and it belongs to the SELECTION (GET /workflows/:name/events — ADR-0022);
// the rest of the fleet is REST snapshots on an interval and on tab focus. Selecting a RUN is a
// local act: it re-renders from state already in hand and touches no socket. `onerror` means
// "retrying", never "give up" — EventSource reconnects on its own, and the level-triggered feed
// makes reattach convergent with no cursor (store.js folds every frame idempotently).
//
// The page as SERVED is ADR-0014's observer: open structure and observation, no credential in the
// bytes. Control is EARNED per tab: the human types the Instance token into the nav (sessionStorage
// — survives a reload, dies with the tab, never a cookie), and only then does the page speak on the
// guarded surface: POST /workflows/:name/runs (start), GET /runs/:id (gate discovery, re-fetched on
// each frame), POST /runs/:id/gates/:gate/events (delivery). Any later 401 drops the whole page
// back to observer mode. That is ADR-0032 end to end — the bands themselves never moved.
//
// STORE-FIRST: everything the page believes lives in the pure reducer (store.js) and arrives there
// as frames — wire frames and page facts alike. This file is a painter over one `store` value plus
// the render pipeline's own working state (`shown`, layout scale, fold set), and owns nothing else.

/* global ELK */

import {
  applyFrame,
  emptyStore,
  fleetRuns,
  gateCount,
  runList,
  selectedRun,
  selectedRunGates,
  visibleGates,
} from "/assets/store.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// ---- Sizing (monospace estimate; generous so labels never clip) --------------------------------

const CHAR_W = 7.5;
const ROW_H = 16;
const textW = (s) => s.length * CHAR_W;

/** A guard's suffix. An anonymous guard has no name to show (the doc reports it as "inline"), and
 * nine characters of nothing is real width — an edge label's width is layer spacing. Mark it. */
const guardSuffix = (guard) => (guard ? (guard === "inline" ? " [?]" : ` [${guard}]`) : "");

/** An invoke's display name. A `src` is the JOIN KEY, not a name: an anonymous actor gets xstate's
 * generated key (`xstate.invoke.0.workspace.provisioning`), which names the STATE — which is the box
 * the row is already sitting in. Only a setup() actor has a name of its own. */
const actorName = (src) => (src.startsWith("xstate.invoke.") ? "inline" : src);

/** The display rows inside a state box: invokes, targetless self-transitions, tags. A child MACHINE
 * renders as a nested subgraph, so its invoke row would only say the same thing twice. */
function stateRows(state, selfTransitions) {
  const nested = new Set(state.children.map((c) => c.src));
  const rows = [];
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
const collapsed = new Set();

function buildElkGraph(doc, live) {
  const meta = new Map(); // elk node id -> { state, rows } | { child, rows }
  const edges = [];

  /** One machine level: the boxes for its root's states, and its own transitions as edges. */
  const machineChildren = (body, scope, instances) => {
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

  const initialDot = (node, scope) => {
    edges.push({
      id: `${scope}${node.id}::initial-edge`,
      sources: [`${scope}${node.id}::initial`],
      targets: [scope + node.initial],
      kind: "initial",
    });
    return { id: `${scope}${node.id}::initial`, width: 12, height: 12 };
  };

  /** A container box: header rows on top, laid-out children below.
   *
   * `nodeSize.minimum` is honoured for a LEAF but not for a compound node — elk sizes those from
   * their children, so a box can come back narrower than its own header asked for. The renderer
   * clips the text to the box it lands in ({@link fitText}) rather than let it hang over the edge. */
  const container = (id, title, rows, children) => {
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
  const childMachineNodes = (cm, scope, live) => {
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
        sources: [nodes[i - 1].id],
        targets: [nodes[i].id],
        kind: "stack",
      });
    }
    return nodes;
  };

  const childMachineNode = (cm, segment, parentScope, inst) => {
    const scope = parentScope + segment;
    const body = cm.machine;
    const id = scope + body.root.id;
    // An INVOKED child's spawn id is its invoke id, so naming the instance would just stutter
    // ("body · body"). A SPAWNED one's id is the workflow's own label for the work ("F-1").
    const named = inst && inst.id !== cm.label;
    const title = `▣ ${cm.label}${named ? ` · ${inst.id}` : ""}`;

    const rows = [];
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

  const toElkNode = (state, scope, body, live) => {
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

const stateEls = new Map(); // elk node id (scope + state id) -> <g>

/** Write text into a box, cut to the width the box actually got (elk sizes a compound node from its
 * children, so the header it asked for is not always the header it gets). The whole string stays
 * reachable on hover. */
function fitText(el, text, boxWidth) {
  const max = Math.max(3, Math.floor((boxWidth - 20) / CHAR_W));
  el.textContent = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  if (text.length > max) svgEl("title", {}, el).textContent = text;
}

/** The header + rows shared by a state box and a child-machine subgraph. Clicking any box selects
 *  it — outline only, one node at a time, the behavior itself RESERVED (brief: nothing else hangs
 *  off it yet). `stopPropagation`, or a click on a leaf would select its every ancestor in turn and
 *  the deepest dispatch would win by accident rather than by choice. */
function renderBox(node, title, rows, parent, cls) {
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
    dispatch({ kind: "selectNode", nodeId: node.id });
  });
  return g;
}

function renderState(node, meta, parent) {
  if (node.id.endsWith("::initial")) {
    const g = svgEl("g", { transform: `translate(${node.x},${node.y})` }, parent);
    svgEl("circle", { class: "initial-dot", cx: 6, cy: 6, r: 5.5 }, g);
    return;
  }
  const { state, child, rows } = meta.get(node.id);

  // A child machine: its own subgraph, one per live instance (or a dimmed template). The ⊞/⊟ icon
  // in its top-right corner folds it — a `maxConcurrent` of 6 is six copies of the same diagram
  // otherwise. The icon and NOT the box: the box body is the click-to-select surface like any other
  // node's, and a reader inspecting a subgraph must not collapse it under their own cursor.
  if (child) {
    const cls = `state child-machine${child.template ? " child-machine--template" : ""}${
      collapsed.has(child.scope) ? " child-machine--collapsed" : ""
    }`;
    const g = renderBox(node, child.label, rows, parent, cls);
    for (const c of node.children ?? []) renderState(c, meta, g);
    if (child.scope) renderFoldIcon(g, node, child.scope);
    return;
  }

  const title = state.type === "history" ? `⟲ ${state.key}` : state.key;
  const g = renderBox(node, title, rows, parent, `state state--${state.type}`);
  if (state.type === "final") {
    svgEl("rect", { class: "final-inner", x: 3, y: 3, rx: 4, width: node.width - 6, height: node.height - 6 }, g);
  }
  for (const c of node.children ?? []) renderState(c, meta, g);
}

/** How much of a child-machine box's top-right corner the fold icon owns (the gate pin yields). */
const FOLD_ICON_W = 26;

/** The ⊞/⊟ fold control in a child-machine box's top-right corner. Appended after the subgraph's
 *  children so nothing paints over it; `stopPropagation`, or folding would also select the box. */
function renderFoldIcon(g, node, scope) {
  const folded = collapsed.has(scope);
  const icon = svgEl("g", { class: "fold-icon", transform: `translate(${node.width - 21},5)` }, g);
  svgEl("rect", { width: 16, height: 16, rx: 3 }, icon);
  const glyph = svgEl("text", { x: 8, y: 12.5, "text-anchor": "middle" }, icon);
  glyph.textContent = folded ? "⊞" : "⊟";
  svgEl("title", {}, icon).textContent = folded ? "unfold this child machine" : "fold this child machine";
  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    folded ? collapsed.delete(scope) : collapsed.add(scope);
    refresh();
  });
}

function renderEdges(layout, parent) {
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
      const t = svgEl("text", { class: "edge-label", x: label.x, y: label.y + 11 }, g);
      t.textContent = label.text;
    }
  }
}

function renderArrowDefs(svg) {
  const defs = svgEl("defs", {}, svg);
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
let viewportG;

/** Breathing room a fresh fit leaves around the diagram. */
const FIT_PAD = 28;

function applyView() {
  viewportG?.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
  $("zoom-reset").textContent = `${Math.round(scale * 100)}%`; // the nav readout follows every path
}

/** Scale so the whole width lands in the pane, centered. Never magnifies — a small Machine stays
 * 1:1. */
function fitToWidth() {
  const svg = $("machine-svg");
  if (!layoutSize.width || svg.clientWidth <= 0) return applyView();
  scale = Math.min(1, Math.max(0.2, (svg.clientWidth - FIT_PAD * 2) / layoutSize.width));
  panX = Math.max(FIT_PAD, (svg.clientWidth - layoutSize.width * scale) / 2);
  panY = FIT_PAD;
  applyView();
}

/** Re-scale about an anchor (svg px; the pane's center when none, for the nav buttons): the
 * diagram point under the anchor stays under it. */
function setScale(next, anchor) {
  fitting = false;
  const svg = $("machine-svg");
  const a = anchor ?? { x: svg.clientWidth / 2, y: svg.clientHeight / 2 };
  const clamped = Math.min(4, Math.max(0.25, next));
  panX = a.x - ((a.x - panX) / scale) * clamped;
  panY = a.y - ((a.y - panY) / scale) * clamped;
  scale = clamped;
  applyView();
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

function wireCanvasNavigation() {
  const canvas = $("canvas");

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

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault(); // the wheel zooms here; travel is the drag's job
      const perLine = e.deltaMode === 1 ? 16 : 1; // Firefox reports lines, not pixels
      const rect = $("machine-svg").getBoundingClientRect();
      setScale(scale * Math.exp(-e.deltaY * perLine * 0.0015), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    { passive: false },
  );

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    squelchClick = false;
    const from = { x: e.clientX, y: e.clientY, panX, panY };
    let panned = false;
    const move = (ev) => {
      if (!panned && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < PAN_NUDGE_PX) return;
      if (!panned) {
        panned = true;
        fitting = false; // the reader took the view into their own hands
        canvas.classList.add("panning");
        canvas.setPointerCapture(e.pointerId);
      }
      panX = from.panX + (ev.clientX - from.x);
      panY = from.panY + (ev.clientY - from.y);
      applyView();
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.classList.remove("panning");
      squelchClick = panned;
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  });
}

/** Render machine-level transitions ("from any state") as a strip above the Machine. */
function renderRootTransitions(doc, rootTransitions) {
  const strip = $("root-transitions");
  strip.textContent = "";
  if (!rootTransitions.length) return;
  const keyOf = new Map();
  const index = (s) => {
    keyOf.set(s.id, s.key);
    s.states.forEach(index);
  };
  index(doc.root);
  for (const t of rootTransitions) {
    const span = document.createElement("span");
    const guard = t.guard ? ` [${t.guard}]` : "";
    const target = t.targets.length ? ` → ${t.targets.map((id) => keyOf.get(id) ?? id).join(", ")}` : "";
    span.textContent = `on ${t.label}${guard}${target}`;
    strip.appendChild(span);
  }
}

async function renderMachine(doc, live) {
  const { graph, meta } = buildElkGraph(doc, live);
  renderRootTransitions(
    doc,
    doc.transitions.filter((t) => t.source === doc.root.id),
  );
  const layout = await new ELK().layout(graph);
  const svg = $("machine-svg");
  svg.textContent = "";
  layoutSize = { width: layout.width + 4, height: layout.height + 4 };
  renderArrowDefs(svg);
  const rootG = svgEl("g", {}, svg);
  stateEls.clear();
  stateEls.set(doc.root.id, rootG);
  for (const child of layout.children ?? []) renderState(child, meta, rootG);
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
function activeIds(body, value, scope, live, ids = new Set()) {
  ids.add(scope + body.root.id);

  const byValue = (state, v) => {
    if (v == null) return;
    const keys = typeof v === "string" ? [v] : Object.keys(v);
    for (const key of keys) {
      const child = state.states.find((s) => s.key === key);
      if (!child) continue;
      ids.add(scope + child.id);
      if (typeof v !== "string") byValue(child, v[key]);
    }
  };
  byValue(body.root, value);

  const byInstance = (state) => {
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
function gateNodeId(doc, live, path) {
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
  for (const key of path[path.length - 1].split(".")) {
    const child = node.states.find((s) => s.key === key);
    if (!child) break;
    node = child;
  }
  // A machine root: in a child scope that is the subgraph's own box; at the run root there is no
  // box to pin (the root machine renders as the page).
  return node === body.root && !scope ? null : scope + node.id;
}

/** The `ChildMachineDoc` running `src`, anywhere under `state` — the doc side of the join key. */
function findChildMachine(state, src) {
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
function nearestRendered(id) {
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
function setGatePin(g, on) {
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

function highlight(doc, status) {
  const live = status?.children ?? [];
  const active = activeIds(doc, status?.value, "", live);
  // The pins are a VIEW over the store (selected run × its inbox card), recomputed whole on every
  // pass — a `gates` frame re-paints, so a delivered gate's pin leaves when its card does.
  const pinned = new Set();
  for (const view of selectedRunGates(store)) {
    const target = nearestRendered(gateNodeId(doc, live, view.path ?? []));
    if (target) pinned.add(target);
  }
  for (const [id, el] of stateEls) {
    el.classList.toggle("active", active.has(id));
    el.classList.toggle("selected", id === store.selectedNodeId);
    setGatePin(el, pinned.has(id));
  }
}

/** The identity of the live child TREE — which instances of what, not where they are. Layout hangs
 * on this and nothing else, so a transition inside a child is a class toggle, never a re-layout. */
function instanceKey(children) {
  return children.map((c) => `${c.src}#${c.id}(${instanceKey(c.children)})`).join(",");
}

let store = emptyStore();
let shown = { doc: null, live: [], key: null, status: null };
let queue = Promise.resolve(); // serializes re-layouts against a burst of status frames

/** Re-lay out the Machine, then restore the highlight the new boxes should be wearing. */
function refresh() {
  queue = queue.then(async () => {
    await renderMachine(shown.doc, shown.live);
    highlight(shown.doc, shown.status);
  });
  return queue;
}

/** A status frame landed: re-lay out only if the instance SET changed (a spawn or a stop). */
function apply(doc, status) {
  const live = status?.children ?? [];
  const key = instanceKey(live);
  const relayout = key !== shown.key;
  shown = { doc, live, key, status };
  return relayout ? refresh() : Promise.resolve(highlight(doc, status));
}

/** Say so when the diagram is knowingly incomplete: a child spawned inside an `enqueueActions`
 *  closure cannot be found by the static walk, so those states may be missing children entirely.
 *  Computed server-side (`MachineDoc.opaqueStates`) and surfaced HERE, where the reader is. */
function showOpaqueNotice(doc) {
  const opaque = doc.opaqueStates ?? [];
  if (!opaque.length) return;
  const el = $("error");
  el.hidden = false;
  el.classList.add("notice");
  el.textContent = `${opaque.join(", ")} ${opaque.length === 1 ? "runs" : "run"} an enqueueActions closure — any child machine spawned inside one is NOT shown in this diagram (keep \`spawnChild\` a top-level action to see it).`;
}

// ---- The store's one door, and memoized painting ------------------------------------------------

/** Fold one frame and repaint. Every state change in this file goes through here — a painter that
 *  writes anywhere else is a painter with a private belief, which is the bug class store.js exists
 *  to end. */
function dispatch(frame) {
  store = applyFrame(store, frame);
  paint();
}

/** Rebuild an element's children only when its inputs changed. The rails and cards hold live FORM
 *  fields, and a status frame lands every few seconds — rebuilding on each would eat the reader's
 *  half-typed input. The key says exactly what a container's DOM depends on; same key, same DOM. */
const paintKeys = new Map(); // element -> last built key
function memo(el, key, build) {
  if (paintKeys.get(el) === key) return;
  paintKeys.set(el, key);
  el.textContent = "";
  build(el);
}

function paint() {
  paintNav();
  paintRail();
  paintDrawer();
  paintDiagram();
}

function paintDiagram() {
  if (!shown.doc) return; // nothing selected (or the doc is still loading) — the canvas says so
  void apply(shown.doc, selectedRun(store));
}

// ---- The token (ADR-0032) -----------------------------------------------------------------------
// The VALUE lives here (sessionStorage) and rides only in Authorization headers; the store holds
// its STATE. Entry is validated with the cheapest guarded read (`GET /runs`), whose response also
// happens to be the full run list — which seeds the gate inbox without waiting for a frame.

const TOKEN_KEY = "j2.console.token";
const token = () => sessionStorage.getItem(TOKEN_KEY) ?? "";

/** A guarded fetch. The ONE place a 401 is turned into observer mode — every control widget calls
 *  through here, so none of them needs its own fallback story. */
async function gfetch(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token()}` },
  });
  if (res.status === 401) {
    dispatch({ kind: "token", state: "invalid" });
    return null;
  }
  return res;
}

/** Which token entry is CURRENT. Two quick edits launch two unsequenced validations, and without
 *  this the older response could dispatch last and leave the badge (and inbox seed) speaking for a
 *  token the reader already replaced. Bumped by every entry AND by clearing, so an in-flight
 *  validation can never overwrite "none". */
let tokenSerial = 0;

async function validateToken() {
  const serial = ++tokenSerial;
  dispatch({ kind: "token", state: "checking" });
  let res;
  try {
    res = await fetch("/runs", { headers: { authorization: `Bearer ${token()}` } });
  } catch {
    res = null; // network trouble reads as invalid; re-entering the token retries
  }
  if (serial !== tokenSerial) return; // a newer entry owns the badge — this answer is nobody's
  if (!res?.ok) return dispatch({ kind: "token", state: "invalid" });
  dispatch({ kind: "token", state: "live" });
  const runs = await res.json();
  if (serial !== tokenSerial) return;
  for (const r of runs) void refreshGates(r.runId, r.workflow);
}

function setToken(value) {
  if (!value) {
    tokenSerial++; // strand any in-flight validation of the token this just cleared
    sessionStorage.removeItem(TOKEN_KEY);
    dispatch({ kind: "token", state: "none" });
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, value);
  void validateToken();
}

// ---- Gate discovery (frame-triggered — ADR-0032) ------------------------------------------------

/** Per-run re-fetch serials — fetch bookkeeping like `docs`, not belief. The browser runs these
 *  requests on parallel connections, so answers can land out of ORDER: a re-fetch triggered by the
 *  delivery's own transition frame (gates now empty) can resolve before the one an earlier frame
 *  launched (gate still open), and folding the straggler would resurrect a card the server already
 *  emptied — pinning the ⚑ and inviting a second delivery until the run's next frame, which a run
 *  parked in a long agent step may not land for minutes. Only the latest-STARTED re-fetch may
 *  speak for a run; superseded answers are dropped before they reach the store. */
const gateFetchSerial = new Map();

/** Re-read one run's open gates off the guarded surface and fold the WHOLE answer in. Called on
 *  every frame that touches the run — that is the synchronization: a gate opens with a state entry
 *  and closes with its exit, and every entry/exit lands a frame. A delivery's success is the next
 *  re-fetch coming back empty; nothing here concludes anything on its own. */
async function refreshGates(runId, workflow) {
  if (store.token !== "live") return; // observer mode: the inbox does not exist
  const serial = (gateFetchSerial.get(runId) ?? 0) + 1;
  gateFetchSerial.set(runId, serial);
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}`);
  if (!res) return; // 401 already dropped the page to observer
  const gates = res.ok ? ((await res.json()).gates ?? []) : []; // !ok: settled + evicted
  if (gateFetchSerial.get(runId) !== serial) return; // superseded — a newer re-fetch owns the answer
  dispatch({ kind: "gates", runId, workflow, gates });
}

// ---- The shared form renderer (start-run + gate delivery — ADR-0033) ----------------------------

/**
 * One form for both writes the Console makes: a flat object schema becomes typed inputs
 * (string/number/boolean/enum, required marked), no schema becomes a raw JSON textarea. `onSubmit`
 * returns an error string to render inline (the server's 400 names the accepted shape — that text
 * IS the UI) or null when the write landed.
 */
function schemaForm(schema, submitLabel, onSubmit) {
  const form = document.createElement("form");
  form.className = "schema-form";
  const props = schema && typeof schema === "object" ? (schema.properties ?? {}) : null;
  const fields = [];
  if (props === null) {
    const ta = document.createElement("textarea");
    ta.placeholder = "{ }  — raw JSON: this workflow declares no input schema";
    ta.rows = 3;
    form.appendChild(ta);
    fields.push({ raw: ta });
  } else {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, prop] of Object.entries(props)) {
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = required.has(key) ? `${key} *` : key;
      let input;
      if (Array.isArray(prop.enum)) {
        // Options carry the value's INDEX, not its string: a numeric enum must round-trip as a
        // number or the server 400s a form no input could ever satisfy. An optional enum gets an
        // "(omit)" first option — a <select> always holds something, so absence needs a row.
        input = document.createElement("select");
        if (!required.has(key)) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "(omit)";
          input.appendChild(opt);
        }
        prop.enum.forEach((v, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = typeof v === "string" ? v : JSON.stringify(v);
          input.appendChild(opt);
        });
      } else if (prop.type === "boolean") {
        if (required.has(key)) {
          input = document.createElement("input");
          input.type = "checkbox";
        } else {
          // A checkbox always answers (unchecked reads as false), which would override a server
          // default the schema marked optional — an optional boolean must be OMISSIBLE.
          input = document.createElement("select");
          for (const [value, text] of [
            ["", "(omit)"],
            ["true", "true"],
            ["false", "false"],
          ]) {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = text;
            input.appendChild(opt);
          }
        }
      } else if (prop.type === "number" || prop.type === "integer") {
        input = document.createElement("input");
        input.type = "number";
        input.step = "any";
      } else {
        input = document.createElement("input");
        input.type = "text";
      }
      if (prop.description) label.title = prop.description;
      label.append(name, input);
      form.appendChild(label);
      fields.push({ key, prop, input });
    }
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = submitLabel;
  const err = document.createElement("div");
  err.className = "form-error";
  err.hidden = true;
  form.append(submit, err);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    err.hidden = true;
    let body;
    try {
      body = collectFields(fields);
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex instanceof Error ? ex.message : String(ex);
      return;
    }
    submit.disabled = true;
    void onSubmit(body)
      .catch((ex) => String(ex))
      .then((failure) => {
        submit.disabled = false;
        if (failure) {
          err.hidden = false;
          err.textContent = failure; // the server's 400 body, inline where the reader typed
        }
      });
  });
  return form;
}

/** The submit body. Typed fields: empty optional inputs are ABSENT, not "" — the server's schema is
 *  the authority on required-ness and says so in its 400. The raw textarea must parse to an object. */
function collectFields(fields) {
  const body = {};
  for (const f of fields) {
    if (f.raw) {
      const text = f.raw.value.trim();
      if (!text) return {};
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("the body must be a JSON object");
      }
      return parsed;
    }
    if (f.input.type === "checkbox") {
      body[f.key] = f.input.checked; // a required boolean: always an answer, by design
      continue;
    }
    const value = f.input.value;
    if (value === "") continue;
    if (Array.isArray(f.prop.enum)) {
      body[f.key] = f.prop.enum[Number(value)]; // the option held the index — the VALUE keeps its type
      continue;
    }
    if (f.prop.type === "boolean") {
      body[f.key] = value === "true"; // the optional-boolean select
      continue;
    }
    body[f.key] = f.prop.type === "number" || f.prop.type === "integer" ? Number(value) : value;
  }
  return body;
}

// ---- Nav ----------------------------------------------------------------------------------------

const TOKEN_BADGES = { none: "", checking: "…", live: "live", invalid: "invalid" };

function paintNav() {
  $("workflow-name").textContent = store.workflow ?? "";
  $("crumb-sep").hidden = !store.workflow;
  const conn = $("connection");
  conn.textContent = store.workflow ? store.connection : "idle";
  conn.className = `conn conn--${store.workflow ? store.connection : "idle"}`;
  const state = $("token-state");
  state.textContent = TOKEN_BADGES[store.token];
  state.className = `token-state token-state--${store.token}`;
  const count = gateCount(store);
  $("attention-badge").hidden = store.token !== "live" || count === 0;
  $("attention-count").textContent = String(count);
}

// ---- The fleet rail -----------------------------------------------------------------------------

/** The workflow-detail input schemas (`GET /workflows/:name` JSON — ADR-0033), fetched when a
 *  start form first opens. `null` is a real answer (no declared input → raw JSON textarea). */
const inputSchemas = new Map();

/** Everything the rail's DOM depends on — see {@link memo}. Deliberately not run `value`s: the rail
 *  shows status chips, so a transition inside a run must not rebuild it under a half-typed form. */
function railKey() {
  return JSON.stringify([
    store.workflows,
    store.workflow,
    [...store.expanded],
    store.token,
    store.startFormFor,
    store.startFormFor ? inputSchemas.has(store.startFormFor) : null,
    store.selectedRunId,
    store.workflows.map((name) =>
      fleetRuns(store, name).map(({ run, settled }) => [
        run.runId,
        run.status,
        settled,
        store.gates.get(run.runId)?.gates.length ?? 0,
      ]),
    ),
  ]);
}

function paintRail() {
  memo($("workflow-list"), railKey(), (list) => {
    if (!store.workflows.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "no workflows registered";
      list.appendChild(li);
      return;
    }
    for (const name of store.workflows) list.appendChild(railWorkflow(name));
  });
}

function railWorkflow(name) {
  const li = document.createElement("li");
  li.className = "wf";
  li.classList.toggle("wf--selected", name === store.workflow);

  const head = document.createElement("div");
  head.className = "wf-head";
  const caret = document.createElement("button");
  caret.className = "wf-caret";
  caret.textContent = store.expanded.has(name) ? "▾" : "▸";
  caret.title = "fold this workflow's runs";
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    dispatch({ kind: "toggleWorkflow", workflow: name });
  });
  const label = document.createElement("span");
  label.className = "wf-name";
  label.textContent = name;
  const rows = fleetRuns(store, name);
  const count = document.createElement("span");
  count.className = "wf-count";
  count.textContent = String(rows.filter((r) => !r.settled).length);
  head.append(caret, label, count);
  if (store.token === "live") {
    const start = document.createElement("button");
    start.className = "wf-start-btn";
    start.textContent = "start";
    start.title = `start a ${name} run`;
    start.addEventListener("click", (e) => {
      e.stopPropagation();
      void toggleStartForm(name);
    });
    head.appendChild(start);
  }
  head.addEventListener("click", () => void selectWorkflow(name, { push: true }));
  li.appendChild(head);

  if (store.startFormFor === name) li.appendChild(startForm(name));
  if (store.expanded.has(name)) li.appendChild(railRuns(name, rows));
  return li;
}

function railRuns(name, rows) {
  const ul = document.createElement("ul");
  ul.className = "wf-runs";
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no live runs";
    ul.appendChild(li);
    return ul;
  }
  for (const { run, settled } of rows) {
    const li = document.createElement("li");
    li.classList.toggle("settled", settled);
    li.classList.toggle("selected", name === store.workflow && run.runId === store.selectedRunId);
    const id = document.createElement("span");
    id.className = "run-id";
    id.textContent = run.runId.slice(0, 8);
    li.appendChild(id);
    const gates = store.gates.get(run.runId)?.gates.length ?? 0;
    if (gates) {
      const badge = document.createElement("span");
      badge.className = "gate-badge";
      badge.title = `${gates} open gate${gates === 1 ? "" : "s"}`;
      badge.textContent = `⚑${gates}`;
      li.appendChild(badge);
    }
    const chip = document.createElement("span");
    chip.className = `run-status status--${run.status}`;
    chip.textContent = run.status;
    li.appendChild(chip);
    li.addEventListener("click", () => {
      if (name === store.workflow) dispatch({ kind: "selectRun", runId: run.runId });
      else void selectWorkflow(name, { push: true, runId: run.runId });
    });
    ul.appendChild(li);
  }
  return ul;
}

// ---- Start run (ADR-0033) -----------------------------------------------------------------------

async function toggleStartForm(name) {
  if (store.startFormFor === name) return dispatch({ kind: "startForm", workflow: null });
  dispatch({ kind: "startForm", workflow: name });
  if (!inputSchemas.has(name)) {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
    inputSchemas.set(name, res.ok ? ((await res.json()).input ?? null) : null);
    paint(); // the form was painted as "loading" — now the schema is in hand
  }
}

function startForm(name) {
  const wrap = document.createElement("div");
  wrap.className = "start-form";
  if (!inputSchemas.has(name)) {
    wrap.textContent = "loading input schema…";
    return wrap;
  }
  wrap.appendChild(
    schemaForm(inputSchemas.get(name), "start run", async (body) => {
      const res = await gfetch(`/workflows/${encodeURIComponent(name)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res) return "unauthorized — the page dropped to observer";
      if (!res.ok) return (await res.json()).error ?? `HTTP ${res.status}`;
      dispatch({ kind: "startForm", workflow: null });
      // The run ANNOUNCES itself: the feed if this workflow is selected, the next snapshot if not —
      // but a reader who just started a run should not wait 10s to see it in the rail.
      if (name !== store.workflow) void snapshotWorkflow(name);
      return null;
    }),
  );
  return wrap;
}

// ---- The drawer: Attention (gate inbox) + Activity (emit log) -----------------------------------

/** Which tab the reader last chose. View state like the zoom, not belief — the store's `token`
 *  decides whether Attention exists at all. */
let chosenTab = "attention";

function paintDrawer() {
  const unlocked = store.token === "live";
  const tab = unlocked ? chosenTab : "activity"; // tokenless: no Attention tab — today's observer
  $("tab-attention").hidden = !unlocked;
  $("tab-attention").classList.toggle("tab--active", tab === "attention");
  $("tab-activity").classList.toggle("tab--active", tab === "activity");
  $("attention-panel").hidden = tab !== "attention";
  $("activity-panel").hidden = tab !== "activity";
  $("inbox-all").checked = store.inboxAll;
  paintInbox();
  paintActivity();
}

function paintInbox() {
  const cards = visibleGates(store);
  memo($("gate-inbox"), JSON.stringify([store.workflow, store.inboxAll, cards]), (list) => {
    if (!cards.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = store.inboxAll || !store.workflow ? "no gates waiting" : "no gates waiting here";
      list.appendChild(li);
      return;
    }
    for (const { runId, workflow, gates } of cards) {
      for (const view of gates) list.appendChild(gateCard(runId, workflow, view));
    }
  });
}

function gateCard(runId, workflow, view) {
  const li = document.createElement("li");
  li.className = "gate-card";

  const head = document.createElement("div");
  head.className = "gate-head";
  head.title = "show this run";
  const gate = document.createElement("span");
  gate.className = "gate-id";
  gate.textContent = `⚑ ${view.gate}`;
  const who = document.createElement("span");
  who.className = "dim";
  who.textContent = `${workflow} · ${runId.slice(0, 8)}`;
  head.append(gate, who);
  head.addEventListener("click", () => {
    if (workflow === store.workflow) dispatch({ kind: "selectRun", runId });
    else void selectWorkflow(workflow, { push: true, runId });
  });
  li.appendChild(head);

  if (view.meta && Object.keys(view.meta).length) {
    const dl = document.createElement("dl");
    dl.className = "gate-meta";
    for (const [k, v] of Object.entries(view.meta)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = typeof v === "string" ? v : JSON.stringify(v);
      dl.append(dt, dd);
    }
    li.appendChild(dl);
  }

  for (const accepted of view.accepts) {
    const section = document.createElement("div");
    section.className = "gate-event";
    const name = document.createElement("div");
    name.className = "gate-event-name";
    name.textContent = accepted.name;
    if (accepted.description) name.title = accepted.description;
    section.appendChild(name);
    section.appendChild(
      schemaForm(accepted.input, "send", async (body) => {
        const res = await gfetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(view.gate)}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: accepted.name, ...body }),
        });
        if (!res) return "unauthorized — the page dropped to observer";
        if (!res.ok) return (await res.json()).error ?? `HTTP ${res.status}`;
        // Deliberately NO local bookkeeping: the delivery moves the Machine, the move lands a
        // frame, the frame triggers the re-fetch, and the re-fetch empties this card (ADR-0032).
        return null;
      }),
    );
    li.appendChild(section);
  }
  return li;
}

function paintActivity() {
  memo($("emit-log"), JSON.stringify(store.emits), (log) => {
    if (!store.emits.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "no emits yet";
      log.appendChild(li);
      return;
    }
    for (const emitted of store.emits) {
      const li = document.createElement("li");
      li.textContent = emitted.type;
      const who = document.createElement("span");
      who.className = "dim";
      who.textContent = emitted.runId.slice(0, 8);
      li.appendChild(who);
      log.appendChild(li);
    }
  });
}

// ---- Selection: the address, the feed, the diagram ----------------------------------------------

/** The workflow the address names — `/workflows/:name`, or null at `/`. */
function workflowFromPath() {
  const match = /^\/workflows\/([^/]+)\/?$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

let feed = null; // the ONE EventSource — the selection's, closed only by a new selection

/**
 * Move the selection: address, store, feed, diagram, in that order. `push` is a click (writes
 * history) — but only a click that MOVES: re-clicking the selection would otherwise push a
 * duplicate entry and make the next Back press appear to do nothing. Popstate and boot restore
 * without writing. `runId` rides along when a run row or an inbox card was the click —
 * unvalidated, the feed's first frame confirms or moves on.
 */
async function selectWorkflow(name, { push = false, runId = null } = {}) {
  const moved = name !== store.workflow;
  if (push && moved) history.pushState({}, "", name ? `/workflows/${encodeURIComponent(name)}` : "/");
  document.title = name ? `j2 · ${name}` : "j2 · Console";
  dispatch({ kind: "select", workflow: name });
  if (runId) dispatch({ kind: "selectRun", runId });
  if (!moved && shown.doc) return; // re-selecting the selection (a popstate re-fire): nothing to do
  feed?.close();
  feed = null;
  // Forget the old diagram NOW: the new feed's frames start landing before the new doc is in hand,
  // and they must not re-layout (or highlight) the machine the reader just left.
  shown = { doc: null, live: [], key: null, status: null };
  if (!name) {
    showPlaceholder();
    return;
  }
  connectFeed(name);
  await loadMachine(name);
}

function showPlaceholder() {
  $("machine-svg").textContent = "";
  $("root-transitions").textContent = "";
  $("machine-id").textContent = "";
  $("error").hidden = true;
  const ph = $("placeholder");
  ph.hidden = false;
  ph.textContent = "select a workflow from the fleet";
  shown = { doc: null, live: [], key: null, status: null };
  paint();
}

/** The selected workflow's Machine docs, kept across navigations — structure does not change under
 *  a running orchestrator, so going back to a workflow is instant. Misses are NOT cached: a name
 *  can be registered after this page loaded, and re-selecting it should find it. */
const docs = new Map();

async function loadMachine(name) {
  let doc = docs.get(name);
  if (doc === undefined) {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}/machine`);
    doc = res.ok ? await res.json() : null;
    if (doc) docs.set(name, doc);
  }
  if (store.workflow !== name) return; // the reader moved on while the fetch was out
  $("placeholder").hidden = true;
  const err = $("error");
  err.hidden = true;
  err.classList.remove("notice");
  err.textContent = "";
  if (!doc) {
    $("machine-svg").textContent = "";
    $("root-transitions").textContent = "";
    $("machine-id").textContent = "";
    err.hidden = false;
    err.textContent = `no workflow "${name}"`;
    shown = { doc: null, live: [], key: null, status: null };
    return;
  }
  $("machine-id").textContent = `machine: ${doc.id}`;
  // Nothing live yet: every child machine renders once, as a dimmed template. The first status
  // frame of a run with children swaps those for one subgraph per instance.
  shown = { doc, live: [], key: instanceKey([]), status: null };
  await renderMachine(doc, []);
  showOpaqueNotice(doc);
  paint();
}

/**
 * The selection's feed. Opened by `selectWorkflow`, closed only by the next one.
 *
 * `onerror` only reports: EventSource reconnects on its own, and closing here (as this page used
 * to) is what made a single blip permanent. There is nothing to re-sync afterwards — the reattached
 * feed opens with the whole live set, which folds in idempotently.
 *
 * Each run-touching frame ALSO triggers that run's gate re-fetch (ADR-0032): a gate opens with a
 * state entry and closes with its exit, and every entry/exit lands a frame here.
 */
function connectFeed(name) {
  feed = new EventSource(`/workflows/${encodeURIComponent(name)}/events`);
  feed.addEventListener("runs", (e) => {
    const runs = JSON.parse(e.data);
    dispatch({ kind: "runs", runs });
    for (const r of runs) void refreshGates(r.runId, name);
  });
  feed.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    dispatch({ kind: "status", status });
    void refreshGates(status.runId, name);
  });
  feed.addEventListener("gone", (e) => {
    const { runId } = JSON.parse(e.data);
    dispatch({ kind: "gone", runId });
    // The reducer already dropped the card (a gate exists only while its state is entered —
    // ADR-0011); the re-fetch is the same frame-triggered discipline as `runs`/`status`, and its
    // 404 converges on the same empty answer.
    void refreshGates(runId, name);
  });
  feed.addEventListener("emit", (e) => {
    const { runId, type } = JSON.parse(e.data);
    dispatch({ kind: "emit", runId, type });
  });
  feed.onopen = () => dispatch({ kind: "connection", state: "live" });
  feed.onerror = () => dispatch({ kind: "connection", state: "retrying" });
}

// ---- Fleet snapshots ----------------------------------------------------------------------------
// The unselected workflows have no feed — never more than one EventSource. They get REST snapshots
// (`GET /workflows/:name/runs`) on an interval and on tab focus, folded through the same reducer
// (each snapshot also re-triggers its runs' gate re-fetches, so the inbox is fleet-wide).

const SNAPSHOT_MS = 10_000;

async function snapshotWorkflow(name) {
  try {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}/runs`);
    if (!res.ok) return;
    const runs = await res.json();
    dispatch({ kind: "fleet", workflow: name, runs });
    for (const r of runs) void refreshGates(r.runId, name);
  } catch {
    // transient — the next tick tries again
  }
}

async function snapshotFleet() {
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: await res.json() });
  } catch {
    // transient — the next tick tries again
  }
  for (const name of store.workflows) {
    if (name === store.workflow) continue; // the selection's feed is fresher than any snapshot
    await snapshotWorkflow(name);
  }
}

// ---- Boot ---------------------------------------------------------------------------------------

async function boot() {
  $("token").value = token();
  $("token").addEventListener("change", () => setToken($("token").value.trim()));
  $("crumb-root").addEventListener("click", (e) => {
    e.preventDefault();
    void selectWorkflow(null, { push: true });
  });
  $("attention-badge").addEventListener("click", () => {
    chosenTab = "attention";
    paint();
  });
  $("tab-attention").addEventListener("click", () => {
    chosenTab = "attention";
    paint();
  });
  $("tab-activity").addEventListener("click", () => {
    chosenTab = "activity";
    paint();
  });
  $("inbox-all").addEventListener("change", () => dispatch({ kind: "inboxScope", all: $("inbox-all").checked }));
  addEventListener("popstate", () => void selectWorkflow(workflowFromPath(), { push: false }));

  $("zoom-in").addEventListener("click", () => setScale(scale * 1.2));
  $("zoom-out").addEventListener("click", () => setScale(scale / 1.2));
  $("zoom-reset").addEventListener("click", () => setScale(1));
  $("zoom-fit").addEventListener("click", () => {
    fitting = true;
    fitToWidth();
  });
  wireCanvasNavigation();
  addEventListener("resize", () => fitting && fitToWidth());
  addEventListener("focus", () => void snapshotFleet());
  setInterval(() => void snapshotFleet(), SNAPSHOT_MS);

  // The fleet first (the rail names everything), then the token (unlock is async and must not gate
  // observation), then the selection the address carries — deep links work on load.
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: await res.json() });
  } catch {
    // the interval retries; the rail says "no workflows registered" until then
  }
  if (token()) void validateToken();
  await selectWorkflow(workflowFromPath(), { push: false });
  void snapshotFleet();
}

boot().catch((err) => {
  const el = $("error");
  el.hidden = false;
  el.textContent = String(err);
});
