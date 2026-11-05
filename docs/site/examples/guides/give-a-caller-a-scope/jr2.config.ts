import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  callers: {
    tokens: {
      // A CI job: it starts runs of release and follows them, and does nothing else.
      ci: { may: { start: ["release"], read: ["release"] } },
      // A bridge to a chat service: it reads each run and answers the Gates of any Workflow.
      "chat-bridge": { may: { read: "all", answer: "all" } },
    },
  },
});
