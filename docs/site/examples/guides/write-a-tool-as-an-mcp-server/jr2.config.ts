import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  // A stdio server: a program of the Sandbox Image. The Harness starts it for each conversation.
  mcp: { semver: { command: "node", args: ["/opt/tools/semver-mcp.ts"] } },
});
