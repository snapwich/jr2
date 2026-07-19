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
