// The mark on Home, in place of the title (the `jr2-title` rule in ../config.ts): j, r and 2 as the
// states of a Machine, from public/. Both images are in the page, and the theme's `dark` class
// shows one, as the nav's logo does. The H1 holds the name as text, so each image's alt is empty.

import { defineComponent, h } from "vue";
import { withBase } from "vitepress";

export const HomeMark = defineComponent({
  name: "HomeMark",
  setup() {
    const img = (theme: "light" | "dark") =>
      h("img", { class: `home-mark-${theme}`, src: withBase(`/jr2-mark-${theme}.svg`), alt: "" });
    return () => h("span", { class: "home-mark", "aria-hidden": "true" }, [img("light"), img("dark")]);
  },
});
