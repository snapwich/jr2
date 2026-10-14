import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    // The credentials that the cluster uses to clone and push. The token comes from JR2_GIT_TOKEN in .env.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // The model key. jr2 up gives it only to the Custodian of each pod whose Agents use Anthropic.
  secrets: [{ name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY }],
});
