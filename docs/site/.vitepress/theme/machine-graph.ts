// The graph of an example Machine (../graph.ts, `::: graph`): its states, its transitions, and who
// sends each event, laid out by elk as the Console lays it out. elk is large, so the page loads it
// only when the reader opens the graph. After a set of tabs, the graph is the last tab of that set,
// on the right, and a provider tab shows its code again; the reader's choice of provider stays as
// it was. With no tabs before it, a button opens it.

import { defineComponent, h, onBeforeUnmount, onMounted, ref, type VNode } from "vue";

// The graph, as build/machine-doc.ts prints it.
import type { Graph, GraphNode, GraphSub } from "../../build/machine-doc.ts";

// elk's graph, in and out.
type Point = { x: number; y: number };
type ElkLabel = {
  text: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
};
type ElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: Array<{ startPoint: Point; endPoint: Point; bendPoints?: Point[] }>;
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
type Elk = { layout(graph: ElkNode): Promise<ElkNode> };

// The few DOM members this component uses: the site's tsconfig has no DOM library.
type El = {
  previousElementSibling: El | null;
  firstElementChild: El | null;
  parentElement: El | null;
  insertBefore(child: El, ref: El | null): void;
  classList: {
    add(n: string): void;
    remove(n: string): void;
    toggle(n: string, on: boolean): void;
    contains(n: string): boolean;
  };
  querySelector(selector: string): El | null;
  appendChild(child: El): void;
  addEventListener(type: string, fn: (e: { target: El | null }) => void): void;
  closest(selector: string): El | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
  textContent: string;
  type: string;
  className: string;
};
type Doc_ = {
  createElement(
    tag: string,
  ): El & { getContext(kind: "2d"): { font: string; measureText(t: string): { width: number } } };
  body: El;
};
const dom = () => (globalThis as unknown as { document: Doc_ }).document;
const styleOf = (el: El) =>
  (
    globalThis as unknown as { getComputedStyle(el: El): { fontFamily: string; getPropertyValue(p: string): string } }
  ).getComputedStyle(el);

const PAD = 14;
const TITLE = 20;
const SUB = 24;
const ROW = 16;

/** `subWidth`: the width of the pill of what the state does, as wide as its text. */
type Box = { node?: GraphNode; x: number; y: number; width: number; height: number; frame: boolean; subWidth: number };

async function layout(
  graph: Graph,
): Promise<{ width: number; height: number; boxes: Box[]; edges: ElkEdge[]; quiet: Set<string> }> {
  const { default: ELK } = (await import("elkjs/lib/elk.bundled.js")) as unknown as { default: new () => Elk };
  const canvas = dom().createElement("canvas").getContext("2d");
  const base = styleOf(dom().body).fontFamily;
  const mono = styleOf(dom().body).getPropertyValue("--vp-font-family-mono") || "monospace";
  const measure = (text: string, font: string) => {
    canvas.font = font;
    return Math.ceil(canvas.measureText(text).width);
  };

  const nodes = new Map<string, GraphNode>();
  const edges: ElkEdge[] = [];
  /** The height of a box's head: its title, what it does, and its rows. */
  const headOf = (n: GraphNode) => 10 + TITLE + (n.sub ? SUB : 0) + n.rows.length * ROW;
  const widthOf = (n: GraphNode) =>
    Math.max(
      measure(n.title, `600 14px ${base}`),
      n.sub ? measure(n.sub.text, `500 12px ${base}`) + 16 : 0,
      ...n.rows.map((r) => measure(r, `12px ${mono}`)),
    ) +
    2 * PAD;
  const dot = (frame: string, initial: string | undefined): ElkNode[] => {
    if (!initial) return [];
    edges.push({ id: `${frame}#initial-edge`, sources: [`${frame}#initial`], targets: [initial] });
    return [{ id: `${frame}#initial`, width: 12, height: 12 }];
  };
  const node = (n: GraphNode): ElkNode => {
    nodes.set(n.id, n);
    if (n.children.length === 0) return { id: n.id, width: widthOf(n), height: headOf(n) + 8 };
    return {
      id: n.id,
      children: [...dot(n.id, n.initial), ...n.children.map(node)],
      layoutOptions: {
        "elk.padding": `[top=${headOf(n) + 10},left=16,bottom=16,right=16]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${widthOf(n)},${headOf(n) + 24})`,
      },
    };
  };
  const top = [...dot("root", graph.initial), ...graph.nodes.map(node)];
  // A transition that jr2 or xstate takes, not a party, is drawn quieter than an event.
  const quiet = new Set(graph.edges.flatMap((e, i) => (e.quiet ? [`t${i}`] : [])));
  graph.edges.forEach((e, i) =>
    edges.push({
      id: `t${i}`,
      sources: [e.source],
      targets: [e.target],
      // On its line, so that a reader sees which event moves along which line.
      labels: [
        {
          text: e.label,
          width: measure(e.label, `500 12px ${mono}`) + 14,
          height: 20,
          layoutOptions: { "elk.edgeLabels.inline": "true" },
        },
      ],
    }),
  );

  const laid = await new ELK().layout({
    id: "root",
    children: top,
    edges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.edgeCoords": "ROOT",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "elk.spacing.edgeLabel": "6",
      "elk.edgeLabels.placement": "CENTER",
      "elk.padding": "[top=8,left=8,bottom=8,right=8]",
    },
  });

  const boxes: Box[] = [];
  const walk = (n: ElkNode, dx: number, dy: number) => {
    const x = dx + (n.x ?? 0);
    const y = dy + (n.y ?? 0);
    const g = nodes.get(n.id);
    boxes.push({
      node: g,
      subWidth: g?.sub ? measure(g.sub.text, `500 12px ${base}`) + 16 : 0,
      x,
      y,
      width: n.width ?? 0,
      height: n.height ?? 0,
      frame: !!n.children?.length,
    });
    n.children?.forEach((c) => walk(c, x, y));
  };
  laid.children?.forEach((c) => walk(c, 0, 0));
  return { width: laid.width ?? 0, height: laid.height ?? 0, boxes, edges: laid.edges ?? [], quiet };
}

function drawBox(b: Box): VNode {
  const n = b.node;
  if (!n) return h("circle", { class: "mg-initial", cx: b.x + 6, cy: b.y + 6, r: 6 });
  const sub: GraphSub | undefined = n.sub;
  const cls = [
    "mg-state",
    n.final && "mg-final",
    b.frame && "mg-frame",
    n.machine && "mg-machine",
    sub && `mg-${sub.kind}`,
  ];
  const cx = b.x + b.width / 2;
  let y = b.y + 10;
  const parts: VNode[] = [h("rect", { class: "mg-box", x: b.x, y: b.y, width: b.width, height: b.height, rx: 10 })];
  if (n.final)
    parts.push(
      h("rect", { class: "mg-box-inner", x: b.x + 3, y: b.y + 3, width: b.width - 6, height: b.height - 6, rx: 8 }),
    );
  parts.push(h("text", { class: "mg-title", x: cx, y: y + 14, "text-anchor": "middle" }, n.title));
  y += TITLE;
  if (sub) {
    const w = b.subWidth;
    parts.push(
      h("rect", { class: "mg-sub", x: cx - w / 2, y: y + 2, width: w, height: 18, rx: 9 }),
      h("text", { class: "mg-sub-text", x: cx, y: y + 15, "text-anchor": "middle" }, sub.text),
    );
    y += SUB;
  }
  for (const r of n.rows) {
    parts.push(h("text", { class: "mg-row", x: cx, y: y + 12, "text-anchor": "middle" }, r));
    y += ROW;
  }
  return h("g", { class: cls.filter(Boolean).join(" ") }, parts);
}

function drawEdge(e: ElkEdge, quietIds: Set<string>): VNode[] {
  const out: VNode[] = [];
  const quiet = quietIds.has(e.id);
  for (const s of e.sections ?? []) {
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
    out.push(
      h("path", {
        class: `mg-edge${quiet ? " mg-quiet" : ""}`,
        d: pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
        "marker-end": "url(#mg-head)",
      }),
    );
  }
  for (const l of e.labels ?? []) {
    out.push(
      h("g", { class: `mg-label${quiet ? " mg-quiet" : ""}` }, [
        // The pill's colour is soft, so the line under it would show: a rect of the background first.
        h("rect", { class: "mg-label-bg", x: l.x ?? 0, y: l.y ?? 0, width: l.width, height: l.height, rx: 6 }),
        h("rect", { class: "mg-label-pill", x: l.x ?? 0, y: l.y ?? 0, width: l.width, height: l.height, rx: 6 }),
        h("text", { x: (l.x ?? 0) + l.width / 2, y: (l.y ?? 0) + 14, "text-anchor": "middle" }, l.text),
      ]),
    );
  }
  return out;
}

export const MachineGraph = defineComponent({
  name: "MachineGraph",
  props: { doc: { type: String, required: true } },
  setup(props) {
    const doc = JSON.parse(decodeURIComponent(props.doc)) as Graph;
    const root = ref<El>();
    const open = ref(false);
    const inTabs = ref(false);
    const drawn = ref<Awaited<ReturnType<typeof layout>>>();
    const failed = ref("");
    let tabs: El | null = null;
    let tab: El | null = null;
    /** The set of tabs that this component made, around one code block. */
    let made: El | null = null;

    const show = (on: boolean) => {
      open.value = on;
      tabs?.classList.toggle("mg-open", on);
      tab?.setAttribute("aria-selected", String(on));
      if (on && !drawn.value)
        layout(doc).then(
          (d) => (drawn.value = d),
          (e: unknown) => (failed.value = String(e)),
        );
    };

    onMounted(() => {
      const el = root.value!;
      let before = el.previousElementSibling;
      // After one code block: a set of two tabs of its own, Code and Graph, in the look of the
      // provider tabs.
      if (before && !before.classList.contains("plugin-tabs") && /\blanguage-/.test(before.className)) {
        const code = before;
        const set = dom().createElement("div");
        set.className = "plugin-tabs mg-made";
        const head = dom().createElement("div");
        head.className = "plugin-tabs--tab-list";
        head.setAttribute("role", "tablist");
        const label = dom().createElement("button");
        label.type = "button";
        label.className = "plugin-tabs--tab";
        label.setAttribute("aria-selected", "true");
        label.textContent = "Code";
        head.appendChild(label);
        const content = dom().createElement("div");
        content.className = "plugin-tabs--content";
        code.parentElement?.insertBefore(set, code);
        content.appendChild(code);
        set.appendChild(head);
        set.appendChild(content);
        made = set;
        before = set;
      }
      const list = before?.classList.contains("plugin-tabs") ? before.querySelector(".plugin-tabs--tab-list") : null;
      if (!before || !list) return;
      // After a set of tabs: a tab of that set, and the graph in its box. A provider tab shows the
      // code again; the graph tab is never the reader's provider.
      tabs = before;
      inTabs.value = true;
      tab = dom().createElement("button");
      tab.type = "button";
      tab.className = "plugin-tabs--tab mg-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.textContent = "Graph";
      list.appendChild(tab);
      list.addEventListener("click", (e) => show(e.target?.closest(".mg-tab") != null));
      tabs.appendChild(el);
    });
    onBeforeUnmount(() => {
      tab?.remove();
      // Put the code block back where the page had it, so that Vue finds it there.
      const code = made?.querySelector(".plugin-tabs--content")?.firstElementChild;
      if (made && code) made.parentElement?.insertBefore(code, made);
      made?.remove();
    });

    return (): VNode => {
      const d = drawn.value;
      // The transitions of the Machine itself run from each state, so they are a list, not lines.
      const any = doc.any.length
        ? h("p", { class: "mg-any" }, `${doc.title}, in any state: ${doc.any.join(" · ")}`)
        : null;
      // The numbers on the transitions of one event: the order in which xstate tries them.
      const order = doc.ordered
        ? h(
            "p",
            { class: "mg-any" },
            "① ② …: the order in which xstate tries the transitions of one event. else: when none of them applies.",
          )
        : null;
      const graph = d
        ? h("div", { class: "mg-scroll" }, [
            any,
            order,
            h(
              "svg",
              {
                class: "mg-svg",
                style: { maxWidth: `${d.width}px` },
                viewBox: `0 0 ${d.width} ${d.height}`,
                role: "img",
              },
              [
                h("defs", [
                  h(
                    "marker",
                    {
                      id: "mg-head",
                      viewBox: "0 0 8 8",
                      refX: 7,
                      refY: 4,
                      markerWidth: 8,
                      markerHeight: 8,
                      orient: "auto",
                    },
                    [h("path", { d: "M 0 0 L 7 4 L 0 8", fill: "none", stroke: "currentColor", "stroke-width": 1.5 })],
                  ),
                ]),
                ...d.boxes.filter((b) => b.frame).map(drawBox),
                ...d.edges.flatMap((e) => drawEdge(e, d.quiet)),
                ...d.boxes.filter((b) => !b.frame).map(drawBox),
              ],
            ),
          ])
        : h(
            "p",
            { class: "mg-wait" },
            failed.value ? `The graph could not be drawn: ${failed.value}` : "Drawing the graph…",
          );
      return h("div", { ref: root, class: ["mg", open.value && "mg-shown", inTabs.value && "mg-in-tabs"] }, [
        inTabs.value
          ? null
          : h(
              "button",
              { type: "button", class: "mg-toggle", onClick: () => show(!open.value) },
              open.value ? "Hide the graph" : "Show the graph",
            ),
        open.value ? graph : null,
      ]);
    };
  },
});
