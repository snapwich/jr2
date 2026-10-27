// The lines of a diagram from a part to a part, or to a band (../diagram.ts, `↓ From → To`). Only
// the browser knows where a part is, so this component measures them and draws a line from the
// one to the other, down or up, through the link row that holds it: an elbow from a part to a
// part, and a straight line between a part and a band. It draws again when the figure changes size. With no
// script, the link row shows its text instead.

import { defineComponent, h, onBeforeUnmount, onMounted, ref, type VNode } from "vue";
import type { Wire } from "../diagram.ts";

type Line = { d: string; label?: string; x: number; y: number; side: "left" | "right" };
// The few DOM members this component uses: the site's tsconfig has no DOM library, since the rest
// of docs/site runs in Node.
type Rect = { left: number; top: number; bottom: number; width: number; height: number };
type El = {
  getBoundingClientRect(): Rect;
  parentElement: El | null;
  closest(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  dataset: Record<string, string | undefined>;
  classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean };
};
type Observer = { observe(target: El): void; disconnect(): void };
const ResizeObserverOf = () =>
  (globalThis as { ResizeObserver?: new (callback: () => void) => Observer }).ResizeObserver;

export const DiagramWires = defineComponent({
  name: "DiagramWires",
  props: { wires: { type: String, required: true } },
  setup(props) {
    const wires = JSON.parse(decodeURIComponent(props.wires)) as Wire[];
    const anchor = ref<El>();
    const box = ref<{ width: number; height: number }>();
    const lines = ref<Line[]>([]);
    let observer: Observer | undefined;

    const measure = () => {
      const row = anchor.value?.parentElement;
      const figure = row?.closest("figure.dg");
      if (!row || !figure) return;
      const origin = figure.getBoundingClientRect();
      const named = (name: string) =>
        Array.from(figure.querySelectorAll("[data-name]")).find((e) => e.dataset.name === name);
      const gap = row.getBoundingClientRect();
      const drawn: Line[] = [];
      // The head of a band names the band: a line between a part and a band is straight, at the part.
      const end = (name: string) => {
        const e = named(name);
        const band = e?.classList.contains("dg-head") ? e.parentElement : undefined;
        const at = (band ?? e)?.getBoundingClientRect();
        return at && { at, band: !!band, x: at.left + at.width / 2 - origin.left };
      };
      wires.forEach((w, k) => {
        const from = end(w.from);
        const to = end(w.to);
        if (!from || !to || (from.band && to.band)) return;
        // A line and the line back between the same two ends run side by side.
        const back = wires.findIndex((v) => v.from === w.to && v.to === w.from);
        const shift = back < 0 ? 0 : back > k ? -5 : 5;
        const x1 = (from.band ? to.x : from.x) + shift;
        const x2 = (to.band ? from.x : to.x) + shift;
        // A line goes up when its start is under its end.
        const up = from.at.top >= to.at.bottom;
        const y1 = (up ? from.at.top : from.at.bottom) - origin.top;
        const y2 = (up ? to.at.bottom + 2 : to.at.top - 2) - origin.top;
        // Each line turns at its own height in the gap, so that two lines do not run as one.
        const mid = gap.top - origin.top + (gap.height * (k + 1)) / (wires.length + 1);
        // Its label is beside it, at the middle of the gap, as the text labels of a link are: on
        // the outer side of a line that has a line back.
        drawn.push({
          d: `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`,
          label: w.label,
          x: x2,
          y: gap.top - origin.top + gap.height / 2,
          side: shift < 0 ? "left" : "right",
        });
      });
      box.value = { width: origin.width, height: origin.height };
      lines.value = drawn;
      row.classList.toggle("dg-wired", drawn.length === wires.length);
    };

    onMounted(() => {
      const figure = anchor.value?.closest("figure.dg");
      measure();
      const Resize = ResizeObserverOf();
      if (figure && Resize) {
        observer = new Resize(measure);
        observer.observe(figure);
      }
    });
    onBeforeUnmount(() => observer?.disconnect());

    return (): VNode => {
      const b = box.value;
      const svg = b
        ? h("svg", { class: "dg-wire-lines", width: b.width, height: b.height, "aria-hidden": "true" }, [
            h("defs", [
              h(
                "marker",
                {
                  id: "dg-wire-head",
                  viewBox: "0 0 8 8",
                  refX: 6,
                  refY: 4,
                  markerWidth: 8,
                  markerHeight: 8,
                  orient: "auto",
                },
                [h("path", { d: "M 0 0 L 6 4 L 0 8", fill: "none", stroke: "currentColor", "stroke-width": 1.5 })],
              ),
            ]),
            ...lines.value.map((l) => h("path", { d: l.d, "marker-end": "url(#dg-wire-head)" })),
          ])
        : null;
      const labels = b
        ? lines.value
            .filter((l) => l.label)
            .map((l) =>
              h(
                "span",
                { class: `dg-wire-label dg-wire-label-${l.side}`, style: { left: `${l.x}px`, top: `${l.y}px` } },
                l.label,
              ),
            )
        : [];
      return h("span", { ref: anchor, class: "dg-wire-anchor" }, svg ? [svg, ...labels] : []);
    };
  },
});
