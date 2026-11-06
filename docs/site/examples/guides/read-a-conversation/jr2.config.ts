import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  runs: {
    // Keep each ended run, its conversations and the hook log for 90 days.
    retain: "90d",
    // The size of the Orchestrator's state volume. A larger size needs a StorageClass that allows expansion.
    volume: "20Gi",
  },
});
