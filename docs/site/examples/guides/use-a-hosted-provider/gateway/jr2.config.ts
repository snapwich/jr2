import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    // The credentials that the cluster uses to clone and push. The token comes from JR2_GIT_TOKEN in .env.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // The gateway's key, held under the name that the provider reads. With no hosts, it goes to the host of the
  // gateway below. paths keeps it away from the gateway's other routes.
  secrets: [{ name: "ANTHROPIC_API_KEY", value: process.env.GATEWAY_API_KEY, paths: ["/v1/messages"] }],
  harness: {
    // Each call of an anthropic/<model> Agent goes to the gateway, not to api.anthropic.com.
    catalog: { anthropic: { baseUrl: process.env.GATEWAY_URL ?? "" } },
  },
});
