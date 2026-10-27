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
import { relativeHref } from "../build/links.ts";
import { headingSlug } from "../build/markdown.ts";
import { DECISIONS_PAGE, GLOSSARY_PAGE } from "../build/reference/glossary.ts";
import type { Sitemap } from "../build/sitemap.ts";
import { withoutRegions } from "../build/vitepress.ts";
import { diagramPlugin } from "./diagram.ts";
import { graphPlugin } from "./graph.ts";
import { navOf, sidebarOf } from "./nav.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
/** Where build/site.ts writes the bundle. */
const BUNDLE = join(SITE, ".vitepress/bundle");
const map = JSON.parse(readFileSync(join(SITE, "sitemap.json"), "utf8")) as Sitemap;
const version = (
  JSON.parse(readFileSync(join(SITE, "../../packages/orchestrator/package.json"), "utf8")) as { version: string }
).version;

/** An ADR's page (`reference/decisions/0001-….md`), with its number. */
const ADR_PAGE = /^reference\/decisions\/(\d{4})-[^/]+\.md$/;

// The token of a fence, with the `src` that VitePress's snippet plugin adds for a `<<<`.
type Token = {
  type: string;
  tag: string;
  info: string;
  content: string;
  children: Token[] | null;
  src?: [string, string];
  attrSet(name: string, value: string): void;
};
type TokenOf = new (type: string, tag: string, nesting: number) => Token;

/** The anchor that the bundle puts before a Glossary term (build/reference/glossary.ts): a
 * paragraph of its own, since `<a>` is inline HTML. */
const TERM_ANCHOR = /^<a id="([^"]+)"><\/a>$/;

/** A Glossary term's paragraph (`**Term**:`, its definition, `_Avoid_: …`) as a `<dl>`: the term,
 * its definition and its Avoid list each on a line of their own, so that a reader can tell them
 * apart. The term takes the id of the anchor paragraph before it. Any other paragraph stays as it
 * is. */
function glossaryTerms(tokens: Token[], Tok: TokenOf): Token[] {
  const make = (type: string, tag: string, nesting: number, attrs: Record<string, string> = {}) => {
    const t = new Tok(type, tag, nesting);
    for (const [k, v] of Object.entries(attrs)) t.attrSet(k, v);
    return t;
  };
  const html = (content: string) => Object.assign(new Tok("html_inline", "", 0), { content });
  const text = (content: string) => Object.assign(new Tok("text", "", 0), { content });
  /** An inline token of `children`, without empty text or the line breaks at its ends. */
  const inline = (children: Token[]) => {
    const kept = children.filter((t) => !(t.type === "text" && t.content === ""));
    while (kept[0]?.type === "softbreak") kept.shift();
    while (kept.at(-1)?.type === "softbreak") kept.pop();
    return Object.assign(new Tok("inline", "", 0), { children: kept, content: kept.map((c) => c.content).join("") });
  };
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const p = tokens[i]!;
    const c = tokens[i + 1]?.children?.filter((t) => !(t.type === "text" && t.content === ""));
    const isTerm =
      p.type === "paragraph_open" &&
      c?.[0]?.type === "strong_open" &&
      c[2]?.type === "strong_close" &&
      c[3]?.type === "text" &&
      c[3].content.startsWith(":");
    if (!isTerm) {
      out.push(p);
      continue;
    }
    const id = out.at(-3)?.type === "paragraph_open" ? TERM_ANCHOR.exec(out.at(-2)!.content)?.[1] : undefined;
    if (id) out.splice(-3);
    const rest = [text(c[3]!.content.slice(1).trimStart()), ...c.slice(4)];
    const avoid = rest.findIndex(
      (t, k) => t.type === "em_open" && rest[k + 1]?.content === "Avoid" && rest[k + 2]?.type === "em_close",
    );
    const definition = avoid < 0 ? rest : rest.slice(0, avoid);
    const self = id
      ? [html(` <a class="glossary-anchor" href="#${id}" aria-label="Permalink to this term">#</a>`)]
      : [];
    out.push(
      make("dl_open", "dl", 1, { class: "glossary-term" }),
      make("dt_open", "dt", 1, id ? { id } : {}),
      inline([c[1]!, ...self]),
      make("dt_close", "dt", -1),
      make("dd_open", "dd", 1),
      inline(definition),
      make("dd_close", "dd", -1),
    );
    if (avoid >= 0) {
      const words = rest.slice(avoid + 3);
      if (words[0]?.type === "text") words[0] = text(words[0].content.replace(/^:\s*/, ""));
      out.push(
        make("dd_open", "dd", 1, { class: "glossary-avoid" }),
        inline([html('<span class="glossary-avoid-label">Avoid</span> '), ...words]),
        make("dd_close", "dd", -1),
      );
    }
    out.push(make("dl_close", "dl", -1));
    i += 2; // the inline and the paragraph_close
  }
  return out;
}

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
      // `::: diagram <layout>`: the site draws the list that it holds (diagram.ts).
      diagramPlugin(md);
      // `::: graph @/examples/<file>.ts`: the graph of the Machine that the example exports (graph.ts).
      graphPlugin(md);
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
      // The Glossary's terms, each as a `<dl>` (glossaryTerms). The bundle keeps GLOSSARY.md's form.
      md.core.ruler.push("jr2-glossary", (state) => {
        if ((state.env as { relativePath?: string }).relativePath !== GLOSSARY_PAGE) return;
        state.tokens = glossaryTerms(state.tokens as unknown as Token[], state.Token as unknown as TokenOf) as never;
      });
      // An ADR's page opens with its number and what it is, linked to the Decisions page, so that a
      // reader who follows a link straight to it knows that it is an ADR. The bundle's copy is the
      // ADR as it is.
      md.core.ruler.push("jr2-adr", (state) => {
        const page = (state.env as { relativePath?: string }).relativePath ?? "";
        const n = ADR_PAGE.exec(page)?.[1];
        if (!n) return;
        const at = state.tokens.findIndex((t) => t.type === "heading_open" && t.tag === "h1");
        const token = (type: string, tag: string, nesting: -1 | 0 | 1, content = "") =>
          Object.assign(new state.Token(type, tag, nesting), { content });
        const link = token("link_open", "a", 1);
        link.attrSet("href", relativeHref(page, DECISIONS_PAGE));
        const label = token("inline", "", 0, "Architecture decision record");
        label.children = [
          token("html_inline", "", 0, `<span class="adr-number">ADR-${n}</span> `),
          link,
          token("text", "", 0, "Architecture decision record"),
          token("link_close", "a", -1),
        ];
        const open = token("paragraph_open", "p", 1);
        open.attrSet("class", "adr-label");
        state.tokens.splice(Math.max(at, 0), 0, open, label, token("paragraph_close", "p", -1));
      });
      // A table of flags (its first header is "Flag") gets a class, so that the theme keeps each
      // flag on one line: a browser breaks a line after a hyphen, and `--skip-provider-preflight`
      // then wraps at each one. VitePress's table rule prints a fixed tag, so the class goes in here.
      const tableOpen = md.renderer.rules.table_open!;
      md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
        const html = tableOpen(tokens, idx, options, env, self);
        const header = tokens.slice(idx).find((t) => t.type === "inline")?.content;
        return header === "Flag" ? html.replace(/^<table/, '<table class="flag-table"') : html;
      };
      // A whole-file `<<<` shows the file without its region markers, as the bundle does.
      // VitePress strips them from a region only.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx] as unknown as Token;
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
  // An ADR's tab and search title carry its number, as every page cites it: `ADR-0001: …`.
  transformPageData(pageData) {
    const n = ADR_PAGE.exec(pageData.relativePath)?.[1];
    if (n) pageData.title = `ADR-${n}: ${pageData.title}`;
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
});
