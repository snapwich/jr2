// The site's own config (ADR-0072), socket-free: the markdown renderer VitePress builds from it, and
// the options it sets. Seven fixes are held here: the H1 that the site adds gets its anchor (so the
// local search files each section under its page), a mermaid fence becomes the theme's lazy
// component, a Glossary term is a `<dl>`, an ADR's page says that it is one, a table of flags has
// the class that keeps each flag on one line, a `::: diagram` is drawn from its list, and the site
// writes sitemap.xml.

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

test("a layers diagram draws each item as a band, a part in it as a part, and an arrow item as a link", async () => {
  const html = await render(
    "::: diagram layers The parts\n\n- **You**: start runs\n  - jr2 CLI\n  - **Console**: in a browser\n" +
      "- ↓ a run starts · ↑ a Gate asks\n- **Sandbox**\n  - **Harness**: runs each Turn\n    - coder\n\n:::\n",
  );
  assert.equal(
    html,
    '<figure class="dg dg-layers">' +
      '<section class="dg-band dg-tone-1"><div class="dg-head" data-name="You"><span class="dg-name">You</span>' +
      '<span class="dg-role">start runs</span></div><div class="dg-parts">' +
      '<div class="dg-part" data-name="jr2 CLI"><span class="dg-name">jr2 CLI</span></div>' +
      '<div class="dg-part" data-name="Console"><span class="dg-name">Console</span>' +
      '<span class="dg-role">in a browser</span></div>' +
      "</div></section>" +
      '<div class="dg-link"><span class="dg-link-label">↓ a run starts</span>' +
      '<span class="dg-link-label">↑ a Gate asks</span></div>' +
      '<section class="dg-band dg-tone-last"><div class="dg-head" data-name="Sandbox"><span class="dg-name">Sandbox</span></div>' +
      '<div class="dg-parts"><div class="dg-part dg-group" data-name="Harness"><span class="dg-name">Harness</span>' +
      '<span class="dg-role">runs each Turn</span><div class="dg-parts">' +
      '<div class="dg-part" data-name="coder"><span class="dg-name">coder</span></div></div></div></div></section>' +
      "<figcaption>The parts</figcaption></figure>",
  );
});

test("a part's kind, in brackets after its name, is a badge and a class", async () => {
  const html = await render("::: diagram layers\n\n- **Sandbox**\n  - **coder** (Agent): edits\n\n:::\n");
  assert.ok(
    html.includes(
      '<div class="dg-part dg-kind-agent" data-name="coder"><span class="dg-name">coder ' +
        '<span class="dg-kind">Agent</span></span><span class="dg-role">edits</span></div>',
    ),
    html,
  );
});

test("a → part is a Machine: its states, the one it is in, its final state, its events and its loops", async () => {
  const html = await render(
    "::: diagram layers\n\n- **Orchestrator**\n  - ● → code → **review** → ◉ done\n" +
      "    - review → done: `approved`\n    - review → code: `changes`\n    - done → nowhere: x\n\n:::\n",
  );
  assert.match(html, /<div class="dg-part dg-machine" style="--dg-n: 3; --dg-loops: 1">/);
  assert.match(html, /<span class="dg-state dg-initial" data-name="code">code<\/span>/);
  assert.match(html, /<span class="dg-state dg-now" data-name="review">review<\/span>/);
  assert.match(html, /<span class="dg-state dg-final" data-name="done">done<\/span>/);
  // `approved` labels the arrow from review to done, at the edge of the second cell of three.
  assert.match(html, /<span class="dg-arrow-label" style="left: 66\.67%"><code v-pre>approved<\/code><\/span>/);
  // `changes` is a loop back from the center of review to the center of code.
  assert.match(
    html,
    /<span class="dg-loop dg-loop-back" style="left: 16\.67%; width: 33\.33%; --dg-depth: 0"><span class="dg-loop-label"><code v-pre>changes<\/code>/,
  );
  assert.doesNotMatch(html, /nowhere/, "a transition to a state that is not in the row is not drawn");
});

test("a link whose labels each name two parts is drawn as lines, with its text for a reader with no script", async () => {
  const html = await render(
    "::: diagram layers\n\n- **Sandbox**\n  - Custodian\n- ↓ Custodian → model provider · Custodian → git host\n" +
      "- **Outside**\n  - model provider\n  - git host\n\n:::\n",
  );
  const wires = [
    { from: "Custodian", to: "model provider" },
    { from: "Custodian", to: "git host" },
  ];
  assert.ok(
    html.includes(
      `<div class="dg-link dg-wires"><DiagramWires wires="${encodeURIComponent(JSON.stringify(wires))}" />` +
        '<span class="dg-wires-text">↓ Custodian → model provider · Custodian → git host</span></div>',
    ),
    html,
  );
});

test("a link can hold text and lines: the text stays, a line can have a label, and the lines have a text of their own", async () => {
  const html = await render(
    "::: diagram layers\n\n- **You**\n- ↓ you start a run · ↑ approval → You: a Gate asks you · ↓ You → approval\n" +
      "- **Orchestrator**\n  - ● → **approval** → ◉ done\n\n:::\n",
  );
  const wires = [
    { from: "approval", to: "You", label: "a Gate asks you" },
    { from: "You", to: "approval" },
  ];
  assert.ok(
    html.includes(
      `<div class="dg-link dg-wires"><DiagramWires wires="${encodeURIComponent(JSON.stringify(wires))}" />` +
        '<span class="dg-link-label">↓ you start a run</span>' +
        '<span class="dg-wires-text">↑ approval → You: a Gate asks you · ↓ You → approval</span></div>',
    ),
    html,
  );
});

test("an item that holds bands and a link is a bracket, and each band has its colour in order", async () => {
  const html = await render(
    "::: diagram layers\n\n- **You**\n- **your cluster**: `jr2 up` sets it up\n  - **Orchestrator**\n  - ↓ a Turn\n" +
      "  - **Sandbox**\n- **Outside**\n\n:::\n",
  );
  assert.ok(
    html.includes(
      '<div class="dg-bracket"><div class="dg-bracket-head" data-name="your cluster"><span class="dg-name">your cluster</span>' +
        '<span class="dg-role"><code v-pre>jr2 up</code> sets it up</span></div><div class="dg-bracket-body">' +
        '<section class="dg-band dg-tone-2"><div class="dg-head" data-name="Orchestrator">',
    ),
    html,
  );
  assert.match(html, /<section class="dg-band dg-tone-3"><div class="dg-head" data-name="Sandbox">/);
  assert.match(html, /<\/div><\/div><section class="dg-band dg-tone-last"><div class="dg-head" data-name="Outside">/);
});

test("a steps diagram is its ordered list, with the class that numbers each step", async () => {
  const html = await render("::: diagram steps\n\n1. **One.** Text.\n2. **Two.**\n\n:::\n\nAfter.\n");
  assert.ok(html.startsWith('<figure class="dg dg-steps"><ol class="dg-steps-list">\n<li><strong>One.</strong>'), html);
  assert.match(html, /<\/ol>\n<\/figure><p>After\.<\/p>/);
});

test("a container that is not a diagram layout stays text", async () => {
  assert.equal(
    await render("::: diagram graph\n\n- a\n\n:::\n"),
    "<p>::: diagram graph</p>\n<ul>\n<li>a</li>\n</ul>\n<p>:::</p>\n",
  );
});

test("the site writes sitemap.xml for its base on GitHub Pages", () => {
  assert.equal(config.base, "/jr2/");
  assert.deepEqual(config.sitemap, { hostname: "https://snapwich.github.io/jr2/" });
});
