// Per-scenario lifecycle: allocate a fresh isolated instance before each scenario, and guarantee
// teardown after — even on failure — so a crashed step never leaks a `j2 dev` process or temp folder.

import { Before, After } from "@cucumber/cucumber";
import { E2EWorld } from "./world.ts";

Before(async function (this: E2EWorld): Promise<void> {
  await this.setup();
});

After(async function (this: E2EWorld): Promise<void> {
  await this.cleanup();
});
