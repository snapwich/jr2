// The default theme, with the components of vitepress-plugin-tabs: `::: tabs key:provider` shares
// the reader's choice of provider across every tab set on every page.

import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { enhanceAppWithTabs } from "vitepress-plugin-tabs/client";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    enhanceAppWithTabs(app);
  },
} satisfies Theme;
