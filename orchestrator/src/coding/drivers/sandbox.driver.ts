// Driver: the create-Sandbox tier of the mock↔real swap, executed against a
// REAL cluster. Same coding template; only `createSandbox`/`cleanupSandbox` are
// swapped to the operator-backed providers (a real `Sandbox` CR reconciled to
// `status.endpoint`, then deleted). Everything else stays mock — no flue.
//
// Prereqs: a cluster + the operator running. From the repo root:
//   just operator-install      # CRDs
//   just operator-run          # controller (foreground; or `make -C operator deploy`)
//   node orchestrator/src/coding/drivers/sandbox.driver.ts
//
// Proves: the bounded-pool → Workspace template stands up and tears down a real
// host-level Sandbox purely by `provide()`-ing different lifecycle providers.

import { createActor } from "xstate";
import { assembleCodingMachine } from "../index.ts";
import { InMemoryWorkSource } from "../testing/mock-work-source.ts";
import { mockCodingProviders, newTracker, type CoderScript, type ReviewerScript } from "../testing/mock-providers.ts";
import { makeRealSandbox, makeRealSandboxCleanup } from "../providers/real-sandbox.ts";

const log = (s: string) => console.log(`\x1b[36m[sandbox-driver]\x1b[0m ${s}`);

async function main() {
  const source = new InMemoryWorkSource([{ id: "demo", tasks: ["t0"] }]);
  const tracker = newTracker();
  const coder: CoderScript = () => [{ emit: "done" }]; // trivial task; the point is the Sandbox lifecycle
  const reviewer: ReviewerScript = () => ({ emit: "approve" });

  const providers = {
    ...mockCodingProviders({ source, tracker, coder, reviewer }),
    createSandbox: makeRealSandbox({ readyTimeoutMs: 90_000 }), // ← real CR
    cleanupSandbox: makeRealSandboxCleanup(),
  };

  log("starting coding Machine with the REAL create-Sandbox provider…");
  const actor = createActor(assembleCodingMachine(providers), { input: { maxConcurrent: 1 } });
  actor.start();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !source.allFeaturesDone()) {
    await new Promise((r) => setTimeout(r, 250));
  }
  actor.stop();

  if (!source.allFeaturesDone()) {
    log("\x1b[31mFAILED\x1b[0m — feature did not complete (is the operator running?)");
    process.exit(1);
  }
  log(
    `real Sandbox created (${tracker.sandboxCreated.join(", ")}) and torn down (${tracker.sandboxCleaned.join(", ")})`,
  );
  log("\x1b[32mOK\x1b[0m — create-Sandbox swap drove the same template end to end.");
  process.exit(0);
}

void main();
