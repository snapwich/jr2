// The site's own config (ADR-0072), socket-free: the markdown renderer VitePress builds from it, and
// the options it sets. Three fixes are held here: the H1 that the site adds gets its anchor (so the
// local search files each section under its page), a mermaid fence becomes the theme's lazy
// component, and the site writes sitemap.xml.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMarkdownRenderer } from "vitepress";
import config from "../.vitepress/config.ts";

const site = new URL("..", import.meta.url).pathname;
const md = await createMarkdownRenderer(site, config.markdown, config.base);
const render = (src: string) => md.render(src, { path: `${site}page.md`, relativePath: "page.md" });

test("a page's H1 comes from its frontmatter, before the anchor rule, so it has an id", async () => {
  const html = await render("---\ntitle: Gates\ndescription: x\n---\n\nIntro text.\n\n## Rules\n\nText.\n");
  assert.match(html, /^<h1 id="gates" tabindex="-1">Gates/);
  assert.match(html, /<h2 id="rules" tabindex="-1">Rules/);
});

test("a page that has an H1 already gets no second one", async () => {
  const html = await render("---\ntitle: Gates\n---\n\n# Reference\n\nText.\n");
  assert.equal(html.match(/<h1/g)?.length, 1);
});

test("a mermaid fence is the MermaidDiagram component, with its source URI-encoded", async () => {
  const graph = "flowchart LR\n  a --> b\n";
  const html = await render(`---\ntitle: T\n---\n\n\`\`\`mermaid\n${graph}\`\`\`\n`);
  assert.ok(html.includes(`<MermaidDiagram graph="${encodeURIComponent(graph)}" />`), html);
  assert.doesNotMatch(html, /<pre/);
});

test("the component imports mermaid only when it mounts, never statically", async () => {
  const src = await readFile(new URL("../.vitepress/theme/mermaid.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^import [^;]*from "mermaid"/m, "a static import would load mermaid on every page");
  assert.match(src, /import\("mermaid"\)/);
  const theme = await readFile(new URL("../.vitepress/theme/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(theme, /from "mermaid"|vitepress-plugin-mermaid/);
});

test("the site writes sitemap.xml for its base on GitHub Pages", () => {
  assert.equal(config.base, "/jr2/");
  assert.deepEqual(config.sitemap, { hostname: "https://snapwich.github.io/jr2/" });
});
