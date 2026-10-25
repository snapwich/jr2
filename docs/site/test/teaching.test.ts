// The docs teach the shapes that work: a pattern that a page shows is one that an Instance user can
// copy into a Machine and get what the page says (ADR-0029, ADR-0057, ADR-0067).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateReference, referenceContext, REPO } from "../build/build.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";

const ctx = referenceContext(REPO, allPages(await readSitemap()));
const { pages } = generateReference(ctx);
const page = (slug: string) => pages.get(slug) ?? assert.fail(`no page ${slug}`);
const source = (slug: string) => readFile(join(REPO, "docs/site", `${slug}.md`), "utf8");

test("a retry loop continues on each Turn, so attempt 2 sees attempt 1", async () => {
  for (const [name, text] of [
    ["agent()", page("reference/authoring-surface/agent")],
    ["Agents and Turns", await source("concepts/agents-and-turns")],
  ] as const) {
    const flat = text.replace(/\s+/g, " ");
    assert.ok(
      flat.includes("A Turn can join only a conversation that an earlier Turn started with `continue: true`."),
      `${name} does not say which conversation a Turn can join`,
    );
    // A spread on `attempts > 0` keeps the first Turn out of the conversation that it continues.
    assert.doesNotMatch(flat, /attempts > 0 \? \{ continue/, `${name} shows a retry loop that loses attempt 1`);
  }
});

test("an ask that a Gate answers has a guard, so the Agent cannot ask with no end", async () => {
  const text = (await source("concepts/gates")).replace(/\s+/g, " ");
  assert.ok(text.includes("To stop this loop, put a guard on the pick."), "Gates does not guard the ask loop");
  assert.ok(text.includes("](the-menu.md#allowed-picks)"), "Gates does not link to the guards of the Allowed picks");
});
