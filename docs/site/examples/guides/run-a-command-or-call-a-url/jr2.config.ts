import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  // An Effect secret: secret("hook-token") names it. The value comes from HOOK_TOKEN in .env.
  secrets: [{ name: "hook-token", value: process.env.HOOK_TOKEN }],
});
