// Browser-tier steps (@console, ADR-0010 as amended): drive the Console the scenario's own
// orchestrator serves, through the real Chromium the `Before("@console")` hook launched. Black-box
// one band up from the CLI steps: everything here is what a READER sees — rendered boxes, badges,
// buttons, cards — addressed by the page's own stable ids/classes, never by reaching into store.js.
//
// playwright is used in LIBRARY form (no @playwright/test): Cucumber owns the lifecycle and the
// assertions, so the only playwright surface here is Locator waiting — `waitFor` for "it appears",
// plus plain node:assert once it has.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { E2EWorld } from "./world.ts";

/** How long a locator may take to appear. Generous for a first paint (elk layout + SSE attach);
 * every wait fails with the locator's own description long before the step's 120s backstop. */
const APPEAR = 15_000;

function thePage(world: E2EWorld): Page {
  assert.ok(world.page, "the @console Before hook launched a browser page");
  return world.page;
}

/** The rail entry for one workflow — the `li` whose name span says so. */
function railItem(page: Page, workflow: string): Locator {
  return page.locator("li.wf").filter({ has: page.locator(".wf-name", { hasText: workflow }) });
}

// --- navigation ----------------------------------------------------------------------------------

When("I open the Console at {string}", async function (this: E2EWorld, path: string): Promise<void> {
  assert.ok(this.server?.url, "the orchestrator is serving");
  await thePage(this).goto(`${this.server.url}${path}`);
});

// --- the diagram ---------------------------------------------------------------------------------

Then("the diagram shows the state {string}", async function (this: E2EWorld, name: string): Promise<void> {
  const page = thePage(this);
  await page
    .locator("#machine-svg .state-title", { hasText: name })
    .first()
    .waitFor({ state: "attached", timeout: APPEAR });
});

// --- observer vs control (ADR-0032) --------------------------------------------------------------

Then("the Console offers no start button", async function (this: E2EWorld): Promise<void> {
  const page = thePage(this);
  // Wait until the rail has painted at all — an unpainted page proves nothing.
  await page.locator("#workflow-list li").first().waitFor({ state: "attached", timeout: APPEAR });
  assert.equal(await page.locator(".wf-start-btn").count(), 0, "no start button in observer mode");
});

Then("the Console offers no Attention tab", async function (this: E2EWorld): Promise<void> {
  const page = thePage(this);
  assert.ok(await page.locator("#tab-attention").isHidden(), "the Attention tab does not exist for an observer");
  assert.ok(await page.locator("#attention-badge").isHidden(), "nor does the attention badge");
});

When("I enter the Instance token", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.server?.token, "the fixture server was booted with an Instance token");
  const field = thePage(this).locator("#token");
  await field.fill(this.server.token);
  await field.blur(); // commit — the page validates on the change event
});

When("I enter the token {string}", async function (this: E2EWorld, value: string): Promise<void> {
  const field = thePage(this).locator("#token");
  await field.fill(value);
  await field.blur();
});

Then("the token badge reads {string}", async function (this: E2EWorld, state: string): Promise<void> {
  await thePage(this).locator(`#token-state.token-state--${state}`).waitFor({ state: "attached", timeout: APPEAR });
});

Then("the Console offers a start button for {string}", async function (this: E2EWorld, wf: string): Promise<void> {
  await railItem(thePage(this), wf).locator(".wf-start-btn").waitFor({ state: "visible", timeout: APPEAR });
});

// --- start run from the schema form (ADR-0033) ---------------------------------------------------

When("I open the start form for {string}", async function (this: E2EWorld, wf: string): Promise<void> {
  const item = railItem(thePage(this), wf);
  await item.locator(".wf-start-btn").click();
  // The schema arrives async ("loading input schema…" first) — wait for the real form.
  await item.locator(".start-form .schema-form").waitFor({ state: "visible", timeout: APPEAR });
});

Then("the start form offers a typed {string} field", async function (this: E2EWorld, key: string): Promise<void> {
  const form = thePage(this).locator(".start-form .schema-form");
  const input = form.locator("label", { hasText: key }).locator("input");
  await input.waitFor({ state: "visible", timeout: APPEAR });
  assert.equal(await input.getAttribute("type"), "text", `"${key}" renders as a typed input`);
  assert.equal(await form.locator("textarea").count(), 0, "a declared schema never falls back to the raw textarea");
});

When(
  "I submit the start form with {string} set to {string}",
  async function (this: E2EWorld, key: string, value: string): Promise<void> {
    const form = thePage(this).locator(".start-form .schema-form");
    await form.locator("label", { hasText: key }).locator("input").fill(value);
    await form.locator("button[type=submit]").click();
  },
);

Then("the rail lists a run of {string}", async function (this: E2EWorld, wf: string): Promise<void> {
  await railItem(thePage(this), wf)
    .locator(".wf-runs li:not(.empty) .run-id")
    .first()
    .waitFor({ state: "attached", timeout: APPEAR });
});

// --- the gate inbox (ADR-0032) -------------------------------------------------------------------

Then("the Attention drawer shows a gate card for {string}", async function (this: E2EWorld, gate: string) {
  await thePage(this)
    .locator("#gate-inbox .gate-card", { hasText: gate })
    .first()
    .waitFor({ state: "visible", timeout: APPEAR });
});

When("I send {string} from the gate card", async function (this: E2EWorld, event: string): Promise<void> {
  await thePage(this)
    .locator("#gate-inbox .gate-card .gate-event", { hasText: event })
    .locator("button[type=submit]")
    .click();
});

Then("the rail shows the run as {string}", async function (this: E2EWorld, status: string): Promise<void> {
  await thePage(this)
    .locator(`#workflow-list .wf-runs .run-status.status--${status}`)
    .first()
    .waitFor({ state: "attached", timeout: APPEAR });
});

Then("the gate inbox reads empty", async function (this: E2EWorld): Promise<void> {
  // The card's leaving IS the assertion: the next re-fetch came back empty (never local bookkeeping).
  await thePage(this).locator("#gate-inbox li.empty").waitFor({ state: "attached", timeout: APPEAR });
});

// --- fold vs select on the diagram ---------------------------------------------------------------

Then("the diagram shows a child-machine subgraph with states inside", async function (this: E2EWorld) {
  const box = thePage(this).locator("#machine-svg .child-machine").first();
  await box.waitFor({ state: "attached", timeout: APPEAR });
  assert.ok((await box.locator("g.state").count()) > 0, "the subgraph renders its inner states");
});

When("I click the child-machine box body", async function (this: E2EWorld): Promise<void> {
  // The box's own TITLE text — always in the header strip, never over an inner state or the fold
  // icon, whatever scale the diagram landed at. (Document order puts the box's title before any
  // child's, so `.first()` is the box's own.)
  await thePage(this).locator("#machine-svg .child-machine .state-title").first().click();
});

Then("the child-machine box is selected and still unfolded", async function (this: E2EWorld): Promise<void> {
  const page = thePage(this);
  const box = page.locator("#machine-svg .child-machine.selected").first();
  await box.waitFor({ state: "attached", timeout: APPEAR });
  assert.ok((await box.locator("g.state").count()) > 0, "a body click never folds — the states are still there");
});

When("I click the child-machine fold icon", async function (this: E2EWorld): Promise<void> {
  await thePage(this).locator("#machine-svg .child-machine .fold-icon").first().click();
});

Then("the child-machine subgraph is folded shut", async function (this: E2EWorld): Promise<void> {
  const page = thePage(this);
  const box = page.locator("#machine-svg .child-machine--collapsed").first();
  await box.waitFor({ state: "attached", timeout: APPEAR });
  assert.equal(await box.locator("g.state").count(), 0, "a folded subgraph hides its inner states");
});
