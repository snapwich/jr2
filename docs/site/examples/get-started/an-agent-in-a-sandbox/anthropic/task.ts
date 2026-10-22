import { customize } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

// `task` leaves two parts Open: its Repo Slots and the model of its coder. This file binds the two.
// The file name gives the Workflow its name: task.
export const machine = customize(task, {
  // One Repo Slot, target: your fork, from the release tag of the Kit that you installed.
  // Replace <you> with your GitHub user name. Replace <version> with the Kit version.
  repos: { target: { url: "https://github.com/<you>/jr2.git", ref: "v<version>" } },
  // The model that the coder Agent uses.
  agents: { coder: { model: "anthropic/claude-haiku-5-5" } },
});
