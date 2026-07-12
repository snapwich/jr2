// j2 Machine visualizer. Fetches the workflow's serialized Machine (GET /workflows/:name/machine),
// lays it out with elkjs (loaded as a UMD script -> window.ELK), renders it as nested SVG, and
// live-highlights the active states of a selected run via the SSE run feed
// (GET /runs/:id/events — `status` frames carry the xstate state value).

/* global ELK */

const workflow = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop());

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

/** The display rows inside a state box: title, invokes, targetless self-transitions, tags. */
function stateRows(state, selfTransitions) {
  const rows = [];
  for (const inv of state.invoke) rows.push({ text: `⚙ ${inv.src}`, cls: "state-row--invoke" });
  for (const t of selfTransitions) {
    rows.push({ text: `↺ ${t.label}${t.guard ? ` [${t.guard}]` : ""}`, cls: "state-row--self" });
  }
  if (state.tags.length) {
    rows.push({ text: state.tags.map((t) => `#${t}`).join(" "), cls: "state-row--tags" });
  }
  return rows;
}

// ---- Machine doc -> elk input -------------------------------------------------------------------

function buildElkGraph(doc) {
  const meta = new Map(); // elk node id -> { state, rows }
  const edges = [];

  const toElkNode = (state) => {
    const selfT = doc.transitions.filter((t) => t.source === state.id && t.targets.length === 0);
    const rows = stateRows(state, selfT);
    meta.set(state.id, { state, rows });
    const title = state.type === "history" ? `⟲ ${state.key}` : state.key;
    const headerW = Math.max(textW(title) + 28, ...rows.map((r) => textW(r.text) + 28), 76);
    const headerH = 26 + rows.length * ROW_H;

    if (state.states.length === 0) {
      return { id: state.id, width: headerW, height: Math.max(headerH + 10, 40) };
    }
    const children = state.states.map(toElkNode);
    if (state.initial) {
      children.push({ id: `${state.id}::initial`, width: 12, height: 12 });
      edges.push({
        id: `${state.id}::initial-edge`,
        sources: [`${state.id}::initial`],
        targets: [state.initial],
        kind: "initial",
      });
    }
    return {
      id: state.id,
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

  // The root machine node renders as the page itself — its children are the top-level states.
  const rootChildren = doc.root.states.map(toElkNode);
  meta.set(doc.root.id, { state: doc.root, rows: [] });
  if (doc.root.initial) {
    rootChildren.push({ id: `${doc.root.id}::initial`, width: 12, height: 12 });
    edges.push({
      id: `${doc.root.id}::initial-edge`,
      sources: [`${doc.root.id}::initial`],
      targets: [doc.root.initial],
      kind: "initial",
    });
  }

  // Machine-level transitions (source = the root, which has no box of its own) can fire from any
  // state — drawing them as edges would be wrong. They render as a strip above the Machine.
  const rootTransitions = doc.transitions.filter((t) => t.source === doc.root.id);

  doc.transitions.forEach((t, i) => {
    if (t.source === doc.root.id) return;
    t.targets.forEach((target, j) => {
      const label = `${t.label}${t.guard ? ` [${t.guard}]` : ""}`;
      edges.push({
        id: `t${i}.${j}`,
        sources: [t.source],
        targets: [target],
        kind: t.kind,
        labels: [{ text: label, width: textW(label) + 4, height: 14 }],
      });
    });
  });

  return {
    rootTransitions,
    graph: {
      id: "::root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
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
    meta,
  };
}

// ---- Layouted elk graph -> SVG ------------------------------------------------------------------

const stateEls = new Map(); // state id -> <g>

function renderState(node, meta, parent) {
  if (node.id.endsWith("::initial")) {
    const g = svgEl("g", { transform: `translate(${node.x},${node.y})` }, parent);
    svgEl("circle", { class: "initial-dot", cx: 6, cy: 6, r: 5.5 }, g);
    return;
  }
  const { state, rows } = meta.get(node.id);
  const g = svgEl("g", { class: `state state--${state.type}`, transform: `translate(${node.x},${node.y})` }, parent);
  stateEls.set(state.id, g);
  svgEl("rect", { width: node.width, height: node.height, rx: 6 }, g);
  if (state.type === "final") {
    svgEl(
      "rect",
      {
        class: "final-inner",
        x: 3,
        y: 3,
        rx: 4,
        width: node.width - 6,
        height: node.height - 6,
      },
      g,
    );
  }
  const title = svgEl("text", { class: "state-title", x: 12, y: 18 }, g);
  title.textContent = state.type === "history" ? `⟲ ${state.key}` : state.key;
  rows.forEach((row, i) => {
    const t = svgEl("text", { class: `state-row ${row.cls}`, x: 12, y: 18 + (i + 1) * ROW_H }, g);
    t.textContent = row.text;
  });
  for (const child of node.children ?? []) renderState(child, meta, g);
}

function renderEdges(layout, parent) {
  for (const edge of layout.edges ?? []) {
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
let scale = 1;

function applyScale() {
  const svg = $("machine-svg");
  svg.setAttribute("width", layoutSize.width * scale);
  svg.setAttribute("height", layoutSize.height * scale);
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

async function renderMachine(doc) {
  const { graph, meta, rootTransitions } = buildElkGraph(doc);
  renderRootTransitions(doc, rootTransitions);
  const layout = await new ELK().layout(graph);
  const svg = $("machine-svg");
  svg.textContent = "";
  layoutSize = { width: layout.width + 4, height: layout.height + 4 };
  svg.setAttribute("viewBox", `-2 -2 ${layoutSize.width} ${layoutSize.height}`);
  applyScale();
  renderArrowDefs(svg);
  const rootG = svgEl("g", {}, svg);
  stateEls.clear();
  stateEls.set(doc.root.id, rootG);
  for (const child of layout.children ?? []) renderState(child, meta, rootG);
  // INCLUDE_CHILDREN reports every edge's coordinates relative to the root — draw them all here,
  // never inside a state group.
  renderEdges(layout, rootG);
}

// ---- Live runs ----------------------------------------------------------------------------------

/** The ids of the states a run is in, walked from `status.value` by KEY (ids may be custom). */
function activeIds(root, value) {
  const ids = new Set([root.id]);
  const walk = (state, v) => {
    if (v == null) return;
    if (typeof v === "string") {
      const child = state.states.find((s) => s.key === v);
      if (child) ids.add(child.id);
      return;
    }
    for (const [key, sub] of Object.entries(v)) {
      const child = state.states.find((s) => s.key === key);
      if (child) {
        ids.add(child.id);
        walk(child, sub);
      }
    }
  };
  walk(root, value);
  return ids;
}

function highlight(doc, value) {
  const active = activeIds(doc.root, value);
  for (const [id, el] of stateEls) el.classList.toggle("active", active.has(id));
}

let feed; // the one open EventSource
let selectedRunId;

function followRun(doc, run, listItem) {
  feed?.close();
  selectedRunId = run.runId;
  for (const li of $("run-list").children) li.classList.toggle("selected", li === listItem);

  feed = new EventSource(`/runs/${encodeURIComponent(run.runId)}/events`);
  feed.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    highlight(doc, status.value);
    const chip = listItem.querySelector(".run-status");
    chip.textContent = status.status;
    chip.className = `run-status status--${status.status}`;
  });
  feed.addEventListener("emit", (e) => {
    const emitted = JSON.parse(e.data);
    const li = document.createElement("li");
    li.textContent = emitted.type;
    const when = document.createElement("span");
    when.className = "dim";
    when.textContent = new Date().toLocaleTimeString();
    li.appendChild(when);
    $("emit-log").prepend(li);
  });
  feed.onerror = () => feed.close(); // the feed closes itself after the terminal frame
}

async function loadRuns(doc) {
  const runs = (await (await fetch("/runs")).json()).filter((r) => r.workflow === workflow);
  const list = $("run-list");
  list.textContent = "";
  if (!runs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no live runs — start one with `j2 run`";
    list.appendChild(li);
    return;
  }
  for (const run of runs) {
    const li = document.createElement("li");
    const id = document.createElement("span");
    id.className = "run-id";
    id.textContent = run.runId.slice(0, 8);
    const chip = document.createElement("span");
    chip.className = `run-status status--${run.status}`;
    chip.textContent = run.status;
    li.append(id, chip);
    li.addEventListener("click", () => followRun(doc, run, li));
    list.appendChild(li);
    if (run.runId === selectedRunId) li.classList.add("selected");
  }
  if (!selectedRunId) followRun(doc, runs[0], list.firstChild);
}

// ---- Boot ---------------------------------------------------------------------------------------

async function boot() {
  $("workflow-name").textContent = workflow;
  const res = await fetch(`/workflows/${encodeURIComponent(workflow)}/machine`);
  if (!res.ok) {
    const available = await (await fetch("/workflows")).json();
    const err = $("error");
    err.hidden = false;
    err.textContent = `no workflow "${workflow}"`;
    const hint = document.createElement("span");
    hint.className = "dim";
    hint.textContent = available.length ? `available: ${available.join(", ")}` : "no workflows registered";
    err.appendChild(hint);
    $("machine-svg").remove();
    return;
  }
  const doc = await res.json();
  $("machine-id").textContent = `machine: ${doc.id}`;
  document.title = `j2 · ${workflow}`;
  await renderMachine(doc);
  await loadRuns(doc);
  $("refresh-runs").addEventListener("click", () => loadRuns(doc));

  $("zoom-in").addEventListener("click", () => {
    scale = Math.min(scale * 1.2, 4);
    applyScale();
  });
  $("zoom-out").addEventListener("click", () => {
    scale = Math.max(scale / 1.2, 0.25);
    applyScale();
  });
  $("zoom-reset").addEventListener("click", () => {
    scale = 1;
    applyScale();
  });
}

boot().catch((err) => {
  const el = $("error");
  el.hidden = false;
  el.textContent = String(err);
});
