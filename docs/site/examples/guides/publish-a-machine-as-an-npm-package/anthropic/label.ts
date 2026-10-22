import { customize } from "@jr2/orchestrator";
import { labeler } from "@you/labeler";

export const machine = customize(labeler, {
  agents: { labeler: { model: "anthropic/claude-haiku-5-5" } },
});
