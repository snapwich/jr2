// The docs site (ADR-0072): VitePress renders docs/site's pages and the Reference that docs:build
// generates, at https://snapwich.github.io/jr2/. `pnpm docs:site` runs build/site.ts first, which
// builds the bundle (strict) and puts its Reference in reference/; buildEnd then copies every
// bundle file beside its HTML, so each page is also at `<slug>.md`, and llms.txt is at the root.
// The nav and the sidebar come from sitemap.json; nothing here lists a page.

import { cp, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type MarkdownRenderer } from "vitepress";
import { tabsMarkdownPlugin } from "vitepress-plugin-tabs";
import { headingSlug } from "../build/markdown.ts";
import type { Sitemap } from "../build/sitemap.ts";
import { withoutRegions } from "../build/vitepress.ts";
import { navOf, sidebarOf } from "./nav.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
/** Where build/site.ts writes the bundle. */
const BUNDLE = join(SITE, ".vitepress/bundle");
const map = JSON.parse(readFileSync(join(SITE, "sitemap.json"), "utf8")) as Sitemap;
const version = (
  JSON.parse(readFileSync(join(SITE, "../../packages/orchestrator/package.json"), "utf8")) as { version: string }
).version;

// The token of a fence, with the `src` that VitePress's snippet plugin adds for a `<<<`.
type Token = {
  type: string;
  tag: string;
  info: string;
  content: string;
  children: Token[] | null;
  src?: [string, string];
};

export default defineConfig({
  base: "/jr2/",
  title: "jr2",
  description: "A kit for agentic workflows as xstate Machines, run on Kubernetes.",
  srcExclude: ["README.md", "tutorial/**", "examples/**", "build/**", "test/**"],
  markdown: {
    // The bundle's anchor rule (README "Citations"), so that a link works in both.
    anchor: { slugify: headingSlug },
    // `{.class}` after text is not Markdown; the bundle would show it as text.
    attrs: { disable: true },
    // `> [!NOTE]` is not CommonMark: the site shows it as the bundle does, a blockquote.
    gfmAlerts: false,
    // The bundle's aside labels (build/vitepress.ts ASIDES), so that the site and the bundle agree.
    container: { infoLabel: "Note", tipLabel: "Tip", warningLabel: "Caution", dangerLabel: "Danger" },
    config(md: MarkdownRenderer) {
      // The plugin is typed against a newer @types/markdown-it than VitePress's; the runtime is one.
      md.use(tabsMarkdownPlugin as unknown as Parameters<MarkdownRenderer["use"]>[0]);
      // `:tada:` is not CommonMark: the site shows it as the bundle does, as text.
      md.core.ruler.disable("emoji");
      // Vue compiles a page's HTML, and VitePress gives a fence `v-pre` but not a code span. So
      // `{{ x }}` in a code span would be an interpolation; with `v-pre` it is text, as in the
      // bundle.
      const codeInline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) =>
        codeInline(tokens, idx, options, env, self).replace(/^<code/, "<code v-pre");
      // A page's title is its frontmatter's: the source has no H1, so the site adds it, as the
      // bundle does. A generated page has its H1 already. Before the anchor rule, so that the H1
      // gets its `id`, and the local search indexes the page's title and the text before its
      // first H2 under it.
      md.core.ruler.before("anchor", "jr2-title", (state) => {
        const tokens = state.tokens as unknown as Token[];
        const title = (state.env as { frontmatter?: { title?: string } }).frontmatter?.title;
        if (!title || tokens.some((t) => t.type === "heading_open" && t.tag === "h1")) return;
        const open = new state.Token("heading_open", "h1", 1);
        const inline = new state.Token("inline", "", 0);
        const text = new state.Token("text", "", 0);
        text.content = title;
        inline.content = title;
        inline.children = [text];
        state.tokens.unshift(open, inline, new state.Token("heading_close", "h1", -1));
      });
      // A whole-file `<<<` shows the file without its region markers, as the bundle does.
      // VitePress strips them from a region only. A `mermaid` fence is the theme's
      // MermaidDiagram, which imports mermaid only on a page that has one.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx] as unknown as Token;
        if (t.info.trim() === "mermaid") return `<MermaidDiagram graph="${encodeURIComponent(t.content)}" />\n`;
        if (t.src && !t.src[1]) {
          (env as { includes?: string[] }).includes?.push(t.src[0]);
          t.content = withoutRegions(readFileSync(t.src[0], "utf8").replace(/\r\n/g, "\n"));
          delete t.src;
        }
        return fence(tokens, idx, options, env, self);
      };
    },
  },
  // https://snapwich.github.io/jr2/sitemap.xml, for a search engine.
  sitemap: { hostname: "https://snapwich.github.io/jr2/" },
  themeConfig: {
    nav: navOf(map),
    sidebar: sidebarOf(map),
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/snapwich/jr2" }],
    footer: { message: `The docs of Kit version ${version}. Each page is also at its .md URL.` },
  },
  transformHead({ pageData, siteConfig }) {
    // The 404 page has no bundle file, so it has no .md URL.
    if (pageData.isNotFound || pageData.relativePath === "404.md") return [];
    return [
      ["link", { rel: "alternate", type: "text/markdown", href: `${siteConfig.site.base}${pageData.relativePath}` }],
    ];
  },
  async buildEnd(siteConfig) {
    const files = await readdir(BUNDLE, { recursive: true });
    for (const f of files.filter((f) => f.endsWith(".md") || f === "llms.txt"))
      if (f !== "agents-block.md") await cp(join(BUNDLE, f), join(siteConfig.outDir, f));
  },
  // mermaid's CommonJS dependencies are not hoisted into docs/site by pnpm, so docs:dev would send
  // CommonJS dayjs to the browser. Pre-bundled with mermaid, they resolve. The build is not
  // affected (Rollup converts CommonJS).
  vite: { optimizeDeps: { include: ["mermaid"] } },
});
