import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  secrets: [
    // A model key. Each pod whose Agents use Anthropic claims it, and the Custodian of that pod holds it.
    // It has no hosts, so it goes only to the host that Anthropic's calls go to.
    { name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY },
    // A Held secret for a tool that the Agent runs. A workspace() claims it with secrets: ["TRACKER_TOKEN"].
    // The tool sends it as a bearer. The Custodian puts the value only into requests to this host.
    { name: "TRACKER_TOKEN", value: process.env.TRACKER_TOKEN, hosts: ["api.tracker.example.com"] },
    // An Effect secret. An Effect names it with secret("DEPLOY_TOKEN"), and only its Effector holds the value.
    { name: "DEPLOY_TOKEN", value: process.env.DEPLOY_TOKEN },
  ],
});
