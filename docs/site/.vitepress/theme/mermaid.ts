// A `mermaid` fence on the site (README "Diagrams"). The config renders each fence as this
// component, with the source URI-encoded in `graph`, so Vue compiles no part of it. The component
// imports mermaid only when it mounts: a page with no diagram loads no mermaid, and the first
// diagram of a visit loads it once. Before it mounts, and with JavaScript off, the reader sees the
// source in a `pre`. It draws again when the reader changes the theme.

import { defineComponent, h, onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

type Mermaid = (typeof import("mermaid"))["default"];

let loaded: Promise<Mermaid> | undefined;
/** mermaid, imported on the first call: one chunk, fetched once, and only by a page that needs it. */
function mermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then((m) => m.default);
  return loaded;
}

let count = 0;

export const MermaidDiagram = defineComponent({
  name: "MermaidDiagram",
  props: { graph: { type: String, required: true } },
  setup(props) {
    const { isDark } = useData();
    const source = decodeURIComponent(props.graph);
    const svg = ref<string>();
    const id = `jr2-mermaid-${++count}`;
    const draw = async () => {
      const m = await mermaid();
      m.initialize({ startOnLoad: false, theme: isDark.value ? "dark" : "default", securityLevel: "strict" });
      svg.value = (await m.render(`${id}-${isDark.value ? "dark" : "light"}`, source)).svg;
    };
    onMounted(draw);
    watch(isDark, draw);
    return () =>
      svg.value === undefined
        ? h("pre", { class: "jr2-mermaid-source" }, source)
        : h("div", { class: "jr2-mermaid", innerHTML: svg.value });
  },
});
