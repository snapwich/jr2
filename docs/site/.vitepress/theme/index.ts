// The default theme, with the components of vitepress-plugin-tabs: `::: tabs key:provider` shares
// the reader's choice of provider across every tab set on every page. And the lines of a
// `::: diagram` from a part to a part (wires.ts). And the graph of an example Machine, which loads
// elk only when the reader opens it (machine-graph.ts). And the mark that is Home's title
// (home-mark.ts). And the styles of the site's own forms (style.css).

import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { enhanceAppWithTabs } from "vitepress-plugin-tabs/client";
import { HomeMark } from "./home-mark.ts";
import { MachineGraph } from "./machine-graph.ts";
import { DiagramWires } from "./wires.ts";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    enhanceAppWithTabs(app);
    app.component("DiagramWires", DiagramWires);
    app.component("MachineGraph", MachineGraph);
    app.component("HomeMark", HomeMark);
  },
} satisfies Theme;
