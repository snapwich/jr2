import { customize } from "@jr2/orchestrator";
import { labeler } from "@you/labeler";

export const machine = customize(labeler, {
  agents: { labeler: { model: "local/qwen3.6-35b-a3b" } },
});
