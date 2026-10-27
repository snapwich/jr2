// The site's own config (ADR-0072), socket-free: the markdown renderer VitePress builds from it, and
// the options it sets. Six fixes are held here: the H1 that the site adds gets its anchor (so the
// local search files each section under its page), a mermaid fence becomes the theme's lazy
// component, a Glossary term is a `<dl>`, an ADR's page says that it is one, a table of flags has
// the class that keeps each flag on one line, and the site writes sitemap.xml.

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

const glossary = (src: string) =>
  md.render(src, { path: `${site}reference/glossary.md`, relativePath: "reference/glossary.md" });
const TERMS =
  '<a id="jr2-cli"></a>\n\n**jr2 CLI**:\nThe `jr2` binary.\nMore text.\n_Avoid_: cli tool,\nlauncher\n\n' +
  '<a id="writing"></a>\n\n**writing**:\nNo Avoid list.\n';

test("a Glossary term is a <dl>: the term with the anchor's id, its definition, then its Avoid list", async () => {
  const html = await glossary(TERMS);
  assert.ok(
    html.startsWith(
      '<dl class="glossary-term"><dt id="jr2-cli">jr2 CLI <a class="glossary-anchor" href="#jr2-cli"' +
        ' aria-label="Permalink to this term">#</a></dt><dd>The <code v-pre>jr2</code> binary.\nMore text.</dd>' +
        '<dd class="glossary-avoid"><span class="glossary-avoid-label">Avoid</span> cli tool,\nlauncher</dd></dl>',
    ),
    html,
  );
  assert.doesNotMatch(html, /<a id=/, "the anchor paragraph gives way to the term's id");
});

test("a Glossary term with no Avoid list has no Avoid line", async () => {
  const html = await glossary(TERMS);
  assert.match(html, /<dt id="writing">writing .*<\/dt><dd>No Avoid list\.<\/dd><\/dl>/s);
  assert.equal(html.match(/glossary-avoid"/g)?.length, 1);
});

test("only the Glossary page changes: a bold lead elsewhere, or not a term there, stays a paragraph", async () => {
  assert.match(await render(`---\ntitle: T\n---\n\n${TERMS}`), /<p><strong>jr2 CLI<\/strong>:/);
  assert.equal(await glossary("A **bold**: word.\n"), "<p>A <strong>bold</strong>: word.</p>\n");
});

test("an ADR's page opens with its number and a link to the Decisions page, before its H1", async () => {
  const adr = "reference/decisions/0001-operator-owned-generic-sandbox.md";
  const html = await md.render("# Sandboxes\n\nText.\n", { path: `${site}${adr}`, relativePath: adr });
  assert.ok(
    html.startsWith(
      '<p class="adr-label"><span class="adr-number">ADR-0001</span> ' +
        '<a href="./../decisions.html">Architecture decision record</a></p><h1 id="sandboxes"',
    ),
    html,
  );
});

test("the Decisions page and every other page have no ADR label", async () => {
  const decisions = "reference/decisions.md";
  const index = await md.render("Text.\n", { path: `${site}${decisions}`, relativePath: decisions });
  assert.doesNotMatch(index + (await render("# T\n")), /adr-label/);
});

test("an ADR's title carries its number; another page's title stays as it is", () => {
  const adr = { relativePath: "reference/decisions/0066-a-model-tier.md", title: "A tier" };
  const other = { relativePath: "reference/glossary.md", title: "Glossary" };
  for (const p of [adr, other]) config.transformPageData!(p as never, {} as never);
  assert.equal(adr.title, "ADR-0066: A tier");
  assert.equal(other.title, "Glossary");
});

test("a table whose first header is Flag has the flag-table class; another table has none", async () => {
  const html = await render(
    "| Flag | Description |\n| --- | --- |\n| `--skip-provider-preflight` | x |\n\n" +
      "| Variable | Description |\n| --- | --- |\n| `NO_COLOR` | y |\n",
  );
  assert.deepEqual(html.match(/<table[^>]*>/g), ['<table class="flag-table" tabindex="0">', '<table tabindex="0">']);
});

test("the site writes sitemap.xml for its base on GitHub Pages", () => {
  assert.equal(config.base, "/jr2/");
  assert.deepEqual(config.sitemap, { hostname: "https://snapwich.github.io/jr2/" });
});
