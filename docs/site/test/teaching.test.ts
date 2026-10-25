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
    assert.ok(
      flat.includes("A clean Turn does not start the continued conversation again"),
      `${name} does not say which conversation the Turn after a clean Turn joins`,
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

test("fromPick says when the state of a pick is a child of the Agent's state and when it is a sibling", () => {
  const text = page("reference/authoring-surface/frompick").replace(/\s+/g, " ");
  assert.ok(text.includes("A child state of the Agent's state, as in the first example."), "no child shape");
  assert.ok(text.includes("A sibling state of the Agent's state, as in the second example."), "no sibling shape");
  assert.ok(text.includes('on: { post_note: "posting" },'), "the second example is not the sibling shape");
});

// A child state alone is not sufficient: a route out of the Agent's state after the Effect ends the
// Turn, and no Agent reads the output (held.test). So the route of the first example stays in it.
test("the first fromPick example routes back into the Agent's state after the Effect, so the Agent reads the output", () => {
  const text = page("reference/authoring-surface/frompick").replace(/\s+/g, " ");
  const first = text.split("```").find((block) => block.includes("fromPick(postNote)")) ?? "";
  assert.ok(first.includes('ready: { on: { post_note: "posting", finish: "#done" } },'), "no `ready` in `writing`");
  assert.ok(first.includes('onDone: "ready" }'), "the route after the Effect leaves the Agent's state");
  assert.doesNotMatch(first, /onDone: "#/, "a route after the Effect leaves the Agent's state");
  assert.ok(text.includes("only when the route after the Effect stays in the Agent's state"), "no rule for the route");
});
