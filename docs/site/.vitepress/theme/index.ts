// The default theme, with the components of vitepress-plugin-tabs: `::: tabs key:provider` shares
// the reader's choice of provider across every tab set on every page. And the lines of a
// `::: diagram` from a part to a part (wires.ts). And the styles of the site's own forms
// (style.css).

import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { enhanceAppWithTabs } from "vitepress-plugin-tabs/client";
import { DiagramWires } from "./wires.ts";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    enhanceAppWithTabs(app);
    app.component("DiagramWires", DiagramWires);
  },
} satisfies Theme;
