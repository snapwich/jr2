import { customize } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

const model = "anthropic/claude-haiku-5-5";

// `task` leaves two parts Open: its Repo Slots and the model of its coder. Bind the two here.
// The file name gives the Workflow its name: fix-app.
export const machine = customize(task, {
  repos: {
    // The first Repo Slot is the Repo that the coder works in. Its branch starts from `main`.
    app: { url: "https://github.com/<you>/app.git", ref: "main" },
    // The coder can read each Repo Slot after the first. A url alone uses the default branch.
    handbook: "https://github.com/<you>/handbook.git",
  },
  // `{ model }` changes only the model. The coder keeps the instructions of `task`.
  agents: { coder: { model } },
});
