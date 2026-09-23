// The first workflow with an Agent in it. A Workflow is only the NAME an Instance registers a
// Machine under (CONTEXT.md), and `task` is a Machine the kit ships (ADR-0054) — one prompt, one
// Workspace, one human says done — so the whole file is the two bindings the package cannot
// honestly make for itself: it does not know the repository, and it cannot pay for a model.
//
// Filename `task.ts` → workflow "task":
//
//   jr2 run task --input '{"prompt":"Add a --version flag to the CLI."}'
//
// `jr2 up` refuses either part unbound and prints exactly the `customize` line that binds it, so
// forgetting one stops the converge instead of starting a run under a model nobody chose.

import { customize } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

export const machine = customize(task, {
  // Slot order is this Machine's convention, not the kit's: the FIRST slot is where the coder
  // works. The url must match an entry in this instance's credentials fence (jr2.config.ts).
  repos: {
    target: { url: "https://github.com/snapwich/richsnapp.com" },
  },
  // The model specifier is `<provider id>/<model>`: `local` is the provider in jr2.config.ts, and
  // everything after the first `/` is handed to llama-server verbatim — it must be exactly what
  // `GET /v1/models` serves.
  agents: {
    coder: { model: "local/qwen3.6-35b-a3b" },
  },
});
