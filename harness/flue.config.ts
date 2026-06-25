import { defineConfig } from "@flue/cli/config";

// Build a long-running Node server (`dist/server.mjs`). Source root resolves to
// `<root>/src` (so `src/app.ts` is the entry and Agents live in `src/agents/`).
export default defineConfig({
  target: "node",
});
