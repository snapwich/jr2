import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // Where jr2 up pushes the images that it builds, such as registry.example.com/team.
  registry: process.env.JR2_REGISTRY,
  // The platforms to build for, such as linux/arm64. When JR2_PLATFORMS is not set, jr2 up reads them from the nodes.
  platforms: process.env.JR2_PLATFORMS?.split(","),
  // The Sandboxes run only on the nodes of the agents pool. Its nodes have the taint pool=agents:NoSchedule.
  sandbox: {
    nodeSelector: { pool: "agents" },
    tolerations: [{ key: "pool", operator: "Equal", value: "agents", effect: "NoSchedule" }],
  },
  // The PriorityClasses of the cluster. jr2 up creates none for a key that you set here.
  priorityClasses: { control: "platform-critical", sandbox: "batch-low" },
});
