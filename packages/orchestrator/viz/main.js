// j2 Machine visualizer. Fetches the workflow's serialized Machine (GET /workflows/:name/machine),
// lays it out with elkjs (loaded as a UMD script -> window.ELK), renders it as nested SVG, and
// live-highlights the active states of a selected run via the SSE observation feed
// (GET /workflows/:name/runs/:id/events — `status` frames carry the xstate state value).
//
// Every route this page touches is an OPEN one: structure (the Machine) and observation (runs
// projected without context). It holds NO token and must not — the guarded `/runs*` surface carries
// gates, cancel, and every run's context, and this page is served to a browser (ADR-0013).

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

/** The display rows inside a state box: invokes, targetless self-transitions, tags. A child MACHINE
 * renders as a nested subgraph, so its invoke row would only say the same thing twice. */
function stateRows(state, selfTransitions) {
  const nested = new Set(state.children.map((c) => c.src));
  const rows = [];
  for (const inv of state.invoke) {
    if (!nested.has(inv.src)) rows.push({ text: `⚙ ${inv.src}`, cls: "state-row--invoke" });
  }
  for (const t of selfTransitions) {
    rows.push({ text: `↺ ${t.label}${t.guard ? ` [${t.guard}]` : ""}`, cls: "state-row--self" });
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
        const label = `${t.label}${t.guard ? ` [${t.guard}]` : ""}`;
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

  /** A container box: header rows on top, laid-out children below. */
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
    return instances.map((inst) => childMachineNode(cm, `${inst.id}/`, scope, inst));
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
  };
}

// ---- Layouted elk graph -> SVG ------------------------------------------------------------------

const stateEls = new Map(); // elk node id (scope + state id) -> <g>

/** The header + rows shared by a state box and a child-machine subgraph. */
function renderBox(node, title, rows, parent, cls) {
  const g = svgEl("g", { class: cls, transform: `translate(${node.x},${node.y})` }, parent);
  stateEls.set(node.id, g);
  svgEl("rect", { width: node.width, height: node.height, rx: 6 }, g);
  const t = svgEl("text", { class: "state-title", x: 12, y: 18 }, g);
  t.textContent = title;
  rows.forEach((row, i) => {
    const r = svgEl("text", { class: `state-row ${row.cls}`, x: 12, y: 18 + (i + 1) * ROW_H }, g);
    r.textContent = row.text;
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

  // A child machine: its own subgraph, one per live instance (or a dimmed template). Clicking the
  // box folds it — a `maxConcurrent` of 6 is six copies of the same diagram otherwise.
  if (child) {
    const cls = `state child-machine${child.template ? " child-machine--template" : ""}${
      collapsed.has(child.scope) ? " child-machine--collapsed" : ""
    }`;
    const g = renderBox(node, child.label, rows, parent, cls);
    if (child.scope) {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsed.has(child.scope) ? collapsed.delete(child.scope) : collapsed.add(child.scope);
        refresh();
      });
    }
    for (const c of node.children ?? []) renderState(c, meta, g);
    return;
  }

  const title = state.type === "history" ? `⟲ ${state.key}` : state.key;
  const g = renderBox(node, title, rows, parent, `state state--${state.type}`);
  if (state.type === "final") {
    svgEl("rect", { class: "final-inner", x: 3, y: 3, rx: 4, width: node.width - 6, height: node.height - 6 }, g);
  }
  for (const c of node.children ?? []) renderState(c, meta, g);
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

function highlight(doc, status) {
  const active = activeIds(doc, status?.value, "", status?.children ?? []);
  for (const [id, el] of stateEls) el.classList.toggle("active", active.has(id));
}

/** The identity of the live child TREE — which instances of what, not where they are. Layout hangs
 * on this and nothing else, so a transition inside a child is a class toggle, never a re-layout. */
function instanceKey(children) {
  return children.map((c) => `${c.src}#${c.id}(${instanceKey(c.children)})`).join(",");
}

let feed; // the one open EventSource
let selectedRunId;
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

function followRun(doc, run, listItem) {
  feed?.close();
  selectedRunId = run.runId;
  for (const li of $("run-list").children) li.classList.toggle("selected", li === listItem);

  feed = new EventSource(`/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(run.runId)}/events`);
  feed.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    void apply(doc, status);
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

// The OBSERVATION routes, not `/runs*`: this page holds no token, and the run surface is the
// Instance token's (context, gates, cancel). What comes back is already scoped to this workflow
// already context-free, so there is nothing to filter and nothing to redact here.
async function loadRuns(doc) {
  const res = await fetch(`/workflows/${encodeURIComponent(workflow)}/runs`);
  const runs = res.ok ? await res.json() : [];
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
  // Nothing live yet: every child machine renders once, as a dimmed template. The first status
  // frame of a run with children swaps those for one subgraph per instance.
  shown = { doc, live: [], key: instanceKey([]), status: null };
  await renderMachine(doc, []);
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
