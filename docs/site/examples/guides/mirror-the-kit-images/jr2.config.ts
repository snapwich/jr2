import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // The registry that holds the copy of the Kit images, such as registry.example.com/jr2.
  // When JR2_KIT_REGISTRY is not set, the cluster pulls them from ghcr.io/snapwich.
  kitRegistry: process.env.JR2_KIT_REGISTRY,
});
