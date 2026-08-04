// Per-scenario lifecycle: allocate a fresh isolated instance before each scenario, and guarantee
// teardown after — even on failure — so a crashed step never leaks a server process or temp folder.

import { Before, After, setDefaultTimeout } from "@cucumber/cucumber";
import { E2EWorld } from "./world.ts";

// Cucumber's 5s default is a unit-test budget. Real steps here wait on real infrastructure — a pod
// scheduling and pulling, an orchestrator restoring, a Sandbox being reaped — so the ceiling is
// raised to 2 minutes. Steps still poll and fail with their own pointed message long before this;
// the timeout is only the backstop for a step that hangs outright.
setDefaultTimeout(120_000);

Before({ tags: "not @kind" }, async function (this: E2EWorld): Promise<void> {
  await this.setup();
});

// The kind tier shares one fixed instance (its cluster's repos mount is baked to that path — see
// World.setupKind), so it opts out of the mkdtemp above rather than getting a folder of its own.
Before({ tags: "@kind" }, async function (this: E2EWorld): Promise<void> {
  await this.setupKind();
});

After(async function (this: E2EWorld): Promise<void> {
  await this.cleanup();
});

// The browser tier (@console, ADR-0010 as amended): a REAL Chromium per scenario, driving the
// Console the scenario's own orchestrator serves. playwright is imported dynamically so the
// default profile — which excludes @console exactly like @kind — never touches its runtime (or
// needs its browser binary installed).
Before({ tags: "@console" }, async function (this: E2EWorld): Promise<void> {
  const { chromium } = await import("playwright");
  this.browser = await chromium.launch();
  this.page = await this.browser.newPage();
});

// Registered after the generic After, so (Cucumber runs After hooks in reverse order) the browser
// closes BEFORE the orchestrator it was talking to is stopped — no tab left retrying a dead feed.
After({ tags: "@console" }, async function (this: E2EWorld): Promise<void> {
  await this.page?.close();
  await this.browser?.close();
  this.page = undefined;
  this.browser = undefined;
});
