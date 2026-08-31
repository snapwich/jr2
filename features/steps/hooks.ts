// Per-scenario lifecycle: allocate a fresh isolated instance before each scenario, and guarantee
// teardown after — even on failure — so a crashed step never leaks a server process or temp folder.
// One thing here is suite-scoped rather than per-scenario, and says so: @dist's published kit.

import { Before, After, AfterAll, setDefaultTimeout } from "@cucumber/cucumber";
import { closeInstalledKit, installedKit } from "./dist-kit.ts";
import { E2EWorld } from "./world.ts";

// Cucumber's 5s default is a unit-test budget. Real steps here wait on real infrastructure — a pod
// scheduling and pulling, an orchestrator restoring, a Sandbox being reaped — so the ceiling is
// raised to 2 minutes. Steps still poll and fail with their own pointed message long before this;
// the timeout is only the backstop for a step that hangs outright.
setDefaultTimeout(120_000);

Before({ tags: "not @kind and not @dist" }, async function (this: E2EWorld): Promise<void> {
  await this.setup();
});

// The kind tier shares one fixed instance (its cluster's repos mount is baked to that path — see
// World.setupKind), so it opts out of the mkdtemp above rather than getting a folder of its own.
Before({ tags: "@kind" }, async function (this: E2EWorld): Promise<void> {
  await this.setupKind();
});

// The dist tier (@dist, ADR-0043) opts out of the mkdtemp above for the opposite reason to @kind:
// its instance must be OUTSIDE this checkout — no workspace, no git repo — so it makes its folder in
// the OS temp dir instead. The kit it drives is the suite-wide one: published, installed, and paid
// for by whichever scenario asks first (the timeout covers a publish plus three docker builds).
Before({ tags: "@dist", timeout: 900_000 }, async function (this: E2EWorld): Promise<void> {
  await this.setupDist(await installedKit());
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

// The one SUITE-scoped teardown: the published kit @dist scenarios share. Untagged, because
// Cucumber's global hooks take no tags — and inert unless a @dist scenario actually ran, which is
// what keeps the default profile from ever standing up a registry.
AfterAll({ timeout: 120_000 }, async function (): Promise<void> {
  await closeInstalledKit();
});
