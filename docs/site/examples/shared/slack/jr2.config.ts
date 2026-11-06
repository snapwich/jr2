import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  // The two tokens. The values come from .env.
  secrets: [
    { name: "SLACK_ACME_TOKEN", value: process.env.SLACK_ACME_TOKEN },
    { name: "SLACK_PARTNER_TOKEN", value: process.env.SLACK_PARTNER_TOKEN },
  ],
  // Two servers of one service, each with its own token. The names are yours.
  mcp: {
    "slack-acme": { url: "https://mcp.slack.example/mcp", secret: "SLACK_ACME_TOKEN" },
    "slack-partner": { url: "https://mcp.slack.example/mcp", secret: "SLACK_PARTNER_TOKEN", timeout: "90s" },
  },
});
