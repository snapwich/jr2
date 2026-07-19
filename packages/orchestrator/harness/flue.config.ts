// The stock Harness image's flue config (ADR-0018). `boot.mjs` runs `flue build --target node`
// against this at pod start, baking the injected src/agents/* into dist/server.mjs.
import { defineConfig } from "@flue/cli/config";

export default defineConfig({
  target: "node",
});
